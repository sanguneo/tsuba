import { chmod, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { AdapterError } from "@tsuba/serve-kit";
import makeWASocket, {
  type BaileysEventMap,
  Browsers,
  downloadMediaMessage,
  proto,
  useMultiFileAuthState,
  type WAMessage,
  WAMessageStubType,
} from "@whiskeysockets/baileys";
import { unwrap } from "./mapping";
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
  updateMediaMessage: ReturnType<typeof makeWASocket>["updateMediaMessage"];
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

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("response" in error))
    return statusCode(error);
  const { response } = error;
  return response &&
    typeof response === "object" &&
    "status" in response &&
    typeof response.status === "number"
    ? response.status
    : statusCode(error);
}

function validMediaLocation(message: WAMessage): boolean {
  const content = message.message;
  const media =
    content?.imageMessage ??
    content?.videoMessage ??
    content?.documentMessage ??
    content?.audioMessage ??
    content?.stickerMessage;
  // The SDK concatenates directPath onto its CDN origin. Require a rooted
  // path and disallow HTTP redirects on the download.
  return Boolean(
    media?.url?.startsWith("https://mmg.whatsapp.net/") ||
      media?.directPath?.startsWith("/"),
  );
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
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
  // SDK re-upload has no abort argument. Share its pending request and retain
  // the refreshed URL for this raw message until the store replaces/evicts it.
  const refreshed = new WeakMap<object, Promise<WAMessage>>();

  const ready = (async () => {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const socket = makeSocket({
      auth: state,
      logger: SILENT_LOGGER,
      markOnlineOnConnect: false,
      // Desktop companion requests history; Ubuntu retains WEB_BROWSER in
      // 6.7.24, avoiding the WIN32/DARWIN rejection in upstream #2677/#2880.
      browser: Browsers.ubuntu("Desktop"),
      syncFullHistory: true,
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
        history.syncType === proto.HistorySync.HistorySyncType.FULL &&
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
    return { socket, creds: state.creds };
  })();
  ready.catch(() => emit({ type: "close", statusCode: undefined }));

  const send: BaileysLike["sendMessage"] = async (jid, content, options) => {
    const { socket, creds } = await ready;
    if (jid.endsWith("@lid") && !creds.me?.lid)
      throw new AdapterError(
        "BUSY",
        "WhatsApp has not supplied this device's LID yet; nothing was sent",
      );
    return socket.sendMessage(jid, content, options);
  };

  return {
    async profilePictureUrl(jid) {
      const { socket } = await ready;
      // 6.7.24 forwards timeoutMs to query/waitForMessage; no AbortSignal API.
      return socket.profilePictureUrl(jid, "preview", 3_000);
    },
    onEvent(next) {
      handler = next;
    },
    sendText(jid, text, quoted) {
      return send(jid, { text }, quoted && { quoted: quoted as WAMessage });
    },
    sendMedia(jid, file, caption, quoted) {
      const bytes = Buffer.from(
        file.bytes.buffer,
        file.bytes.byteOffset,
        file.bytes.byteLength,
      );
      const mimetype =
        file.type.split(";")[0]?.trim().toLowerCase() ||
        "application/octet-stream";
      const metadata = {
        mimetype,
        ...(caption === undefined ? {} : { caption }),
      };
      // Inline only common formats. Keep larger pictures as original documents
      // instead of assuming the recipient's client can display them inline.
      const content =
        bytes.length <= 16_000_000 &&
        /^(image\/jpeg|image\/png)$/.test(mimetype)
          ? { ...metadata, image: bytes }
          : mimetype === "video/mp4"
            ? { ...metadata, video: bytes }
            : { ...metadata, document: bytes, fileName: file.name };
      return send(jid, content, quoted && { quoted: quoted as WAMessage });
    },
    async downloadMedia(raw, signal) {
      const { socket } = await ready;
      const inner = unwrap(raw.message);
      if (!inner)
        throw new AdapterError("NOT_FOUND", "No such WhatsApp attachment");
      const message: WAMessage = {
        key: raw.key,
        message: proto.Message.fromObject(inner),
      };
      if (!validMediaLocation(message))
        throw new AdapterError("NOT_FOUND", "No valid WhatsApp media location");
      const transfer = new AbortController();
      const downloadSignal = AbortSignal.any([
        signal,
        transfer.signal,
        AbortSignal.timeout(120_000),
      ]);
      try {
        const prior = refreshed.get(raw);
        const stream = await downloadMediaMessage(
          prior ? await abortable(prior, downloadSignal) : message,
          "stream",
          {
            options: {
              signal: downloadSignal,
              timeout: 8_000,
              maxRedirects: 0,
            },
          },
          {
            logger: SILENT_LOGGER,
            reuploadRequest: (expired) => {
              downloadSignal.throwIfAborted();
              const cached = refreshed.get(raw);
              if (cached && cached !== prior)
                return abortable(cached, downloadSignal);
              const pending = socket
                .updateMediaMessage(expired)
                .then((updated) => {
                  if (!validMediaLocation(updated))
                    throw new AdapterError(
                      "NOT_FOUND",
                      "No valid WhatsApp media location",
                    );
                  return updated;
                })
                .catch((error: unknown) => {
                  refreshed.delete(raw);
                  throw error;
                });
              refreshed.set(raw, pending);
              return abortable(pending, downloadSignal);
            },
          },
        );
        const chunks = stream[Symbol.asyncIterator]();
        return new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              try {
                const { value, done } = await abortable(
                  chunks.next(),
                  downloadSignal,
                );
                if (done) controller.close();
                else if (value instanceof Uint8Array) controller.enqueue(value);
                else
                  controller.error(new Error("Invalid WhatsApp media chunk"));
              } catch {
                stream.destroy();
                controller.error(
                  new Error("WhatsApp media stream interrupted"),
                );
              }
            },
            cancel() {
              // Abort Axios itself; destroying the Transform alone can leave
              // its underlying HTTP connection open.
              transfer.abort();
              stream.destroy();
            },
          },
          { highWaterMark: 0 },
        );
      } catch (error) {
        if (error instanceof AdapterError) throw error;
        switch (httpStatus(error)) {
          case 404:
          case 410:
            throw new AdapterError(
              "NOT_FOUND",
              "The WhatsApp attachment is no longer available",
            );
          default:
            throw new AdapterError(
              "INTERNAL",
              "WhatsApp media download failed",
            );
        }
      }
    },
    async close() {
      handler = () => {};
      const held = await ready.catch(() => undefined);
      held?.socket.end(undefined);
      await saving;
    },
  };
}

function contactNames(contacts: Partial<WaContact>[]): WaContact[] {
  return contacts.flatMap(({ id, ...rest }) => (id ? [{ id, ...rest }] : []));
}
