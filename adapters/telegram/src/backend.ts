import {
  FileLocation,
  MtPeerNotFoundError,
  type TelegramClient,
} from "@mtcute/bun";
import {
  type AdapterBackend,
  AdapterError,
  type Message,
} from "@tsuba/serve-kit";
import { mapAttachment, mapMessage, mapRoom } from "./mapping";

/** 400-coded refusals that mean "not allowed here" rather than "malformed". */
const FORBIDDEN = [
  "CHANNEL_PRIVATE",
  "USER_BANNED_IN_CHANNEL",
  "CHAT_ADMIN_REQUIRED",
  "CHAT_RESTRICTED",
  "YOU_BLOCKED_USER",
  "USER_IS_BLOCKED",
];
const MEDIA_ID = /^(-?\d+):(\d+):([A-Za-z0-9_-]+)$/;

function peerId(value: string): number {
  const id = Number(value);
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(id) || id === 0)
    throw new AdapterError("NOT_FOUND", "No such room");
  return id;
}
function messageId(value: string): number {
  const id = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(id) || id < 1)
    throw new AdapterError("INVALID_REQUEST", "Invalid message id");
  return id;
}
async function translated<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const code =
      error && typeof error === "object" && "text" in error
        ? String(error.text)
        : "";
    const status =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "number"
        ? error.code
        : 0;
    if (
      code.startsWith("FLOOD_WAIT") ||
      code.startsWith("FLOOD_PREMIUM_WAIT") ||
      code.startsWith("SLOWMODE_WAIT")
    )
      throw new AdapterError(
        "RATE_LIMITED",
        "Telegram asked the adapter to slow down",
      );
    // Telegram answers 401 once the session is signed out, revoked or expired.
    if (status === 401)
      throw new AdapterError(
        "REAUTH_REQUIRED",
        "Telegram no longer accepts this session; sign in again where the adapter runs",
      );
    if (status === 403 || FORBIDDEN.includes(code))
      throw new AdapterError(
        "FORBIDDEN",
        "Telegram does not let this account do that here",
      );
    if (
      error instanceof MtPeerNotFoundError ||
      [
        "PEER_ID_INVALID",
        "CHANNEL_INVALID",
        "CHAT_ID_INVALID",
        "USER_ID_INVALID",
      ].includes(code)
    )
      throw new AdapterError("NOT_FOUND", "No such room");
    throw error;
  }
}

export function telegramBackend(tg: TelegramClient): AdapterBackend {
  return {
    listRooms: () =>
      translated(async () => {
        const rooms = [];
        for await (const dialog of tg.iterDialogs({
          limit: 501,
          archived: "keep",
        })) {
          if (rooms.length === 500) return { rooms, complete: false };
          rooms.push(mapRoom(dialog));
        }
        return { rooms, complete: true };
      }),
    readMessages: ({ roomId, limit, before }) =>
      translated(async () => {
        const peer = peerId(roomId);
        const page = await tg.getHistory(peer, {
          limit,
          ...(before === undefined
            ? {}
            : { offset: { id: messageId(before), date: 0 } }),
        });
        // Probe before the oldest fetched id rather than relying on total history count,
        // which includes messages newer than a before-id page.
        const oldest = page[page.length - 1];
        const earlier = oldest
          ? await tg.getHistory(peer, {
              limit: 1,
              offset: { id: oldest.id, date: 0 },
            })
          : [];
        return {
          messages: [...page].reverse().map(mapMessage),
          hasEarlier: earlier.length > 0,
        };
      }),
    messagesAfter: (roomId, afterId) =>
      translated(async () => {
        const peer = peerId(roomId);
        const after = messageId(afterId);
        // Refuse deleted/inaccessible cursors rather than quietly starting from now.
        const anchor = await tg.getMessages(peer, [after]);
        if (!anchor[0])
          throw new AdapterError("NOT_FOUND", "The cursor cannot be honoured");
        const messages: Message[] = [];
        let offset = { id: after + 1, date: 0 };
        while (true) {
          const page = await tg.getHistory(peer, {
            limit: 100,
            minId: after,
            offset,
            reverse: true,
          });
          const newer = page.filter((message) => message.id >= offset.id);
          messages.push(...newer.map(mapMessage));
          const last = newer[newer.length - 1];
          if (!last || page.length < 100) return messages;
          offset = { id: last.id + 1, date: 0 };
        }
      }),
    subscribe(listener) {
      const onMessage = (message: Parameters<typeof mapMessage>[0]) =>
        listener(mapMessage(message));
      tg.onNewMessage.add(onMessage);
      return () => tg.onNewMessage.remove(onMessage);
    },
    send: (roomId, text) =>
      translated(async () =>
        mapMessage(await tg.sendText(peerId(roomId), text)),
      ),
    media: (id, signal) =>
      translated(async () => {
        const missing = new AdapterError("NOT_FOUND", "No such attachment");
        const [, roomId = "", messageIdText = "", unique] =
          MEDIA_ID.exec(id) ?? [];
        if (!unique) throw missing;
        // Fetch the message now so the file reference is fresh and still this message's file.
        const [message] = await tg.getMessages(peerId(roomId), [
          messageId(messageIdText),
        ]);
        const media = message?.media;
        const attachment = media && mapAttachment(roomId, messageIdText, media);
        if (
          !(media instanceof FileLocation) ||
          !attachment ||
          attachment.id !== id
        )
          throw missing;
        return {
          body: tg.downloadAsStream(media, { abortSignal: signal }),
          ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
          ...(attachment.name ? { name: attachment.name } : {}),
        };
      }),
  };
}
