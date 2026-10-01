import { MtPeerNotFoundError, type TelegramClient } from "@mtcute/bun";
import {
  type AdapterBackend,
  AdapterError,
  type Message,
} from "@tsuba/serve-kit";
import { mapMessage, mapRoom } from "./mapping";

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
    if (
      code.startsWith("FLOOD_WAIT") ||
      code.startsWith("FLOOD_PREMIUM_WAIT") ||
      code.startsWith("SLOWMODE_WAIT")
    )
      throw new AdapterError(
        "RATE_LIMITED",
        "Telegram asked the adapter to slow down",
      );
    if (
      error instanceof MtPeerNotFoundError ||
      [
        "PEER_ID_INVALID",
        "CHANNEL_INVALID",
        "CHANNEL_PRIVATE",
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
  };
}
