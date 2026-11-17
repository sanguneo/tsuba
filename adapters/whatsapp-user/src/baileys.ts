import { chmod, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import makeWASocket, {
  type BaileysEventMap,
  proto,
  useMultiFileAuthState,
  type WAMessage,
  WAMessageStubType,
} from "@whiskeysockets/baileys";
import type { WaContact, WaGroup, WaSocket, WaSocketEvent } from "./types";

export type BaileysEvents = BaileysEventMap;
type SocketConfig = Parameters<typeof makeWASocket>[0];

/** The part of a Baileys socket this adapter uses; a test can stand in for it. */
export interface BaileysLike {
  profilePictureUrl: ReturnType<typeof makeWASocket>["profilePictureUrl"];
  ev: {
    on<E extends keyof BaileysEventMap>(
      event: E,
      listener: (data: BaileysEventMap[E]) => void,
    ): void;
  };
  sendMessage: ReturnType<typeof makeWASocket>["sendMessage"];
  groupFetchAllParticipating: ReturnType<
    typeof makeWASocket
  >["groupFetchAllParticipating"];
  end(error: Error | undefined): void;
}

export interface BaileysOptions {
  authDir: string;
  makeSocket?: (config: SocketConfig) => BaileysLike;
}

const SILENT_LOGGER: NonNullable<SocketConfig["logger"]> = {
  level: "silent",
  child: () => SILENT_LOGGER,
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** The session holds the account's keys: directory 700, files 600. */
export async function prepareSessionDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  for (const name of await readdir(dir)) await chmod(join(dir, name), 0o600);
}

function statusCode(error: unknown): number | undefined {
  const output =
    error && typeof error === "object" && "output" in error
      ? error.output
      : undefined;
  const code =
    output && typeof output === "object" && "statusCode" in output
      ? output.statusCode
      : undefined;
  return typeof code === "number" ? code : undefined;
}

/**
 * Opens one WhatsApp Web connection on the saved session and reports it as
 * `WaSocketEvent`s. Nothing here logs: the library's logger is silenced because
 * its records carry numbers, names and message bodies.
 */
export function openBaileys({
  authDir,
  makeSocket = makeWASocket,
}: BaileysOptions): WaSocket {
  let handler: (event: WaSocketEvent) => void = () => {};
  let saving: Promise<void> = Promise.resolve();
  const emit = (event: WaSocketEvent) => handler(event);

  const ready = (async () => {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const socket = makeSocket({
      auth: state,
      logger: SILENT_LOGGER,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    socket.ev.on("creds.update", () => {
      saving = saving.then(saveCreds);
    });
    socket.ev.on("connection.update", (update) => {
      if (update.qr) emit({ type: "qr", qr: update.qr });
      if (update.connection === "open") {
        emit({ type: "open" });
        emit({ type: "groupSyncStarted" });
        // Baileys 6.7.24 can buffer groups.update and discard a later update
        // for the same id. Apply this query's result directly before its count.
        // Keep a failed optional read separate from the connection state, and
        // report only a safe signal: SDK errors can contain account data.
        void socket
          .groupFetchAllParticipating()
          .then((groups) => {
            emit({ type: "groups", groups: Object.values(groups) });
            emit({
              type: "groupSyncComplete",
              count: Object.keys(groups).length,
            });
          })
          .catch(() => emit({ type: "groupSyncFailed" }));
      }
      if (update.connection === "close")
        emit({
          type: "close",
          statusCode: statusCode(update.lastDisconnect?.error),
        });
    });
    socket.ev.on("messaging-history.set", (history) => {
      emit({ type: "chats", chats: history.chats });
      emit({ type: "names", names: contactNames(history.contacts) });
      emit({ type: "messages", messages: history.messages, live: false });
      // isLatest marks the first processed history, not the final chunk.
      if (
        history.syncType === proto.HistorySync.HistorySyncType.RECENT &&
        history.progress === 100
      )
        emit({ type: "historySyncComplete" });
    });
    socket.ev.on("chats.upsert", (chats) => emit({ type: "chats", chats }));
    socket.ev.on("chats.update", (updates) =>
      emit({
        type: "chats",
        chats: updates.flatMap(({ id, ...rest }) =>
          id ? [{ id, ...rest }] : [],
        ),
      }),
    );
    socket.ev.on("chats.delete", (ids) => emit({ type: "chatsDeleted", ids }));
    socket.ev.on("contacts.upsert", (contacts) =>
      emit({ type: "names", names: contactNames(contacts) }),
    );
    socket.ev.on("contacts.update", (contacts) =>
      emit({ type: "names", names: contactNames(contacts) }),
    );
    socket.ev.on("chats.phoneNumberShare", ({ lid, jid }) =>
      emit({ type: "names", names: [{ id: lid, jid }] }),
    );
    const groups = (updates: Partial<WaGroup>[]) =>
      emit({
        type: "groups",
        groups: updates.flatMap(({ id, ...rest }) =>
          id ? [{ id, ...rest }] : [],
        ),
      });
    socket.ev.on("groups.upsert", groups);
    socket.ev.on("groups.update", groups);
    socket.ev.on("messages.upsert", ({ messages, type }) =>
      emit({ type: "messages", messages, live: type === "notify" }),
    );
    socket.ev.on("messages.update", (updates) => {
      for (const { key, update } of updates) {
        const edited = update.message?.editedMessage?.message;
        if (edited)
          emit({
            type: "edit",
            key,
            content: edited,
            at: update.messageTimestamp,
          });
        else if (update.messageStubType === WAMessageStubType.REVOKE)
          emit({ type: "delete", keys: [key] });
      }
    });
    socket.ev.on("messages.delete", (deletion) => {
      if ("keys" in deletion) emit({ type: "delete", keys: deletion.keys });
    });
    return socket;
  })();
  ready.catch(() => emit({ type: "close", statusCode: undefined }));

  return {
    async profilePictureUrl(jid) {
      const socket = await ready;
      // 6.7.24 forwards timeoutMs to query/waitForMessage; no AbortSignal API.
      return socket.profilePictureUrl(jid, "preview", 3_000);
    },
    onEvent(next) {
      handler = next;
    },
    async sendText(jid, text, quoted) {
      const socket = await ready;
      return socket.sendMessage(
        jid,
        { text },
        // The store only holds messages that Baileys itself delivered.
        quoted ? { quoted: quoted as WAMessage } : undefined,
      );
    },
    async close() {
      handler = () => {};
      const socket = await ready.catch(() => undefined);
      socket?.end(undefined);
      await saving;
    },
  };
}

function contactNames(contacts: Partial<WaContact>[]): WaContact[] {
  return contacts.flatMap(({ id, ...rest }) => (id ? [{ id, ...rest }] : []));
}
