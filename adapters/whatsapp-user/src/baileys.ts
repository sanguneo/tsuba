import { chmod, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { AdapterError } from "@tsuba/serve-kit";
import makeWASocket, {
  type BaileysEventMap,
  Browsers,
  downloadMediaMessage,
  generateMessageIDV2,
  proto,
  useMultiFileAuthState,
  type WAMessage,
  WAMessageStubType,
} from "@whiskeysockets/baileys";
import { unwrap } from "./mapping";
import type {
  WaContact,
  WaGroup,
  WaMessageLike,
  WaSocket,
  WaSocketEvent,
} from "./types";

export type BaileysEvents = BaileysEventMap;
type SocketConfig = Parameters<typeof makeWASocket>[0];

/** The part of a Baileys socket this adapter uses; a test can stand in for it. */
export interface BaileysLike {
  authState: Pick<ReturnType<typeof makeWASocket>["authState"], "keys">;
  ws: {
    on(
      event: string,
      listener: (node: { attrs: Record<string, string> }) => void,
    ): void;
    off(
      event: string,
      listener: (node: { attrs: Record<string, string> }) => void,
    ): void;
  };
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
  findMessage?: (
    roomId: string,
    messageId: string,
  ) => WaMessageLike | undefined;
  makeSocket?: (config: SocketConfig) => BaileysLike;
}

const MESSAGE_ACK_EVENT = "CB:ack,class:message";
const MESSAGE_ACK_TIMEOUT_MS = 10_000;

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
  findMessage,
  makeSocket = makeWASocket,
}: BaileysOptions): WaSocket {
  let handler: (event: WaSocketEvent) => void = () => {};
  let saving: Promise<void> = Promise.resolve();
  let close: Promise<void> | undefined;
  let authWriteFailed = false;
  const disconnected = new AbortController();
  const pendingAuth = new Set<Promise<unknown>>();
  function trackAuth<T>(work: Promise<T>): Promise<T> {
    pendingAuth.add(work);
    void work.then(
      () => pendingAuth.delete(work),
      () => pendingAuth.delete(work),
    );
    return work;
  }
  const emit = (event: WaSocketEvent) => handler(event);
  // SDK re-upload has no abort argument. Share its pending request and retain
  // the refreshed URL for this raw message until the store replaces/evicts it.
  const refreshed = new WeakMap<object, Promise<WAMessage>>();

  const ready = (async () => {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const setKeys = state.keys.set.bind(state.keys);
    state.keys.set = (data) =>
      trackAuth(
        Promise.resolve(setKeys(data)).catch(() => {
          authWriteFailed = true;
          throw new Error("WhatsApp Signal key save failed");
        }),
      );
    const socket = makeSocket({
      auth: state,
      logger: SILENT_LOGGER,
      markOnlineOnConnect: false,
      // Desktop companion requests history; Ubuntu retains WEB_BROWSER in
      // 6.7.24, avoiding the WIN32/DARWIN rejection in upstream #2677/#2880.
      browser: Browsers.ubuntu("Desktop"),
      syncFullHistory: true,
      generateHighQualityLinkPreview: false,
      // Only answer a WhatsApp retry for the exact retained outgoing message.
      // Do not retry a send that timed out at the adapter's HTTP boundary.
      async getMessage({ remoteJid, id, fromMe }) {
        if (!fromMe || !remoteJid || !id) return undefined;
        const raw = findMessage?.(remoteJid, id);
        return raw?.key.fromMe && raw.message
          ? proto.Message.fromObject(raw.message)
          : undefined;
      },
    });
    // The SDK buffers key changes inside Signal transactions. Waiting only for
    // writes that have reached set() can miss a transaction still decrypting.
    const keys = socket.authState.keys;
    const transaction = keys.transaction.bind(keys);
    keys.transaction = (work) => trackAuth(transaction(work));
    socket.ev.on("creds.update", () => {
      saving = trackAuth(
        saving.then(saveCreds).catch(() => {
          authWriteFailed = true;
        }),
      );
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
      if (update.connection === "close") {
        disconnected.abort();
        emit({
          type: "close",
          statusCode: statusCode(update.lastDisconnect?.error),
        });
      }
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
        if (
          key.fromMe !== false &&
          (update.status != null || update.userReceipt?.length)
        )
          emit({
            type: "receipt",
            key,
            update: {
              ...(update.status != null ? { status: update.status } : {}),
              ...(update.userReceipt
                ? { userReceipt: update.userReceipt }
                : {}),
            },
          });
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
    socket.ev.on("message-receipt.update", (updates) => {
      for (const { key, receipt } of updates)
        if (key.fromMe !== false)
          emit({ type: "receipt", key, update: { userReceipt: [receipt] } });
    });
    socket.ev.on("messages.delete", (deletion) => {
      if ("keys" in deletion) emit({ type: "delete", keys: deletion.keys });
    });
    return { socket, creds: state.creds };
  })();
  ready.catch(() => emit({ type: "close", statusCode: undefined }));

  const send = async (
    jid: string,
    content: Parameters<BaileysLike["sendMessage"]>[1],
    options: Parameters<BaileysLike["sendMessage"]>[2],
  ): Promise<WaMessageLike | undefined> => {
    const { socket, creds } = await ready;
    if (jid.endsWith("@lid") && !creds.me?.lid)
      throw new AdapterError(
        "BUSY",
        "WhatsApp has not supplied this device's LID yet; nothing was sent",
      );
    // sendMessage resolves after the local WebSocket write. Match the server's
    // message ACK by id; attach before relay so a fast ACK cannot be missed.
    const messageId = generateMessageIDV2(creds.me?.id);
    let complete = (_accepted: boolean) => {};
    const ack = new Promise<boolean>((resolve) => {
      complete = resolve;
    });
    const onAck = (node: { attrs: Record<string, string> }) => {
      if (node.attrs.id === messageId) complete(!node.attrs.error);
    };
    socket.ws.on(MESSAGE_ACK_EVENT, onAck);
    try {
      const sent = await socket.sendMessage(jid, content, {
        ...options,
        messageId,
      });
      if (!sent) return undefined;
      const deadline = AbortSignal.any([
        disconnected.signal,
        AbortSignal.timeout(MESSAGE_ACK_TIMEOUT_MS),
      ]);
      const accepted = await abortable(ack, deadline).catch(
        (error: unknown) => {
          if (deadline.aborted && error === deadline.reason)
            throw new AdapterError(
              "INTERNAL",
              "WhatsApp server acknowledgement was not confirmed",
            );
          throw error;
        },
      );
      if (!accepted)
        throw new AdapterError(
          "INTERNAL",
          "WhatsApp returned an error acknowledgement",
        );
      const status = proto.WebMessageInfo.Status.SERVER_ACK;
      emit({ type: "receipt", key: sent.key, update: { status } });
      return (sent.status ?? 0) < status ? { ...sent, status } : sent;
    } finally {
      socket.ws.off(MESSAGE_ACK_EVENT, onAck);
    }
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
    close() {
      close ??= (async () => {
        handler = () => {};
        disconnected.abort();
        const held = await ready.catch(() => undefined);
        held?.socket.end(undefined);
        while (pendingAuth.size) await Promise.allSettled(pendingAuth);
        if (authWriteFailed) throw new Error("WhatsApp auth state save failed");
      })();
      return close;
    },
  };
}

function contactNames(contacts: Partial<WaContact>[]): WaContact[] {
  return contacts.flatMap(({ id, ...rest }) => (id ? [{ id, ...rest }] : []));
}
