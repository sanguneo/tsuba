import {
  type AdapterBackend,
  AdapterError,
  type Message,
  type StreamUpdate,
} from "@tsuba/serve-kit";

const ROOM_ID = "notes";

export function memoBackend(): AdapterBackend {
  const messages: Message[] = [];
  const listeners = new Set<(update: StreamUpdate) => void>();
  let next = 1;

  function room(roomId: string): void {
    if (roomId !== ROOM_ID) throw new AdapterError("NOT_FOUND", "No such room");
  }

  return {
    async listRooms() {
      const last = messages.at(-1);
      return {
        rooms: [
          {
            id: ROOM_ID,
            title: "메모",
            kind: "direct",
            unread: 0,
            ...(last
              ? {
                  lastActivityAt: last.sentAt,
                  lastMessage: { text: last.text, fromMe: last.fromMe },
                }
              : {}),
          },
        ],
        complete: true,
      };
    },

    async readMessages({ roomId, limit, before }) {
      room(roomId);
      const end =
        before === undefined
          ? messages.length
          : messages.findIndex((message) => message.id === before);
      if (end < 0) throw new AdapterError("NOT_FOUND", "No such message");
      const start = Math.max(0, end - limit);
      return { messages: messages.slice(start, end), hasEarlier: start > 0 };
    },

    async messagesAfter(roomId, afterId) {
      room(roomId);
      const index = messages.findIndex((message) => message.id === afterId);
      return index < 0 ? [] : messages.slice(index + 1);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async send(roomId, text) {
      room(roomId);
      const message: Message = {
        id: String(next++),
        roomId,
        sender: "나",
        text,
        kind: "text",
        sentAt: new Date().toISOString(),
        fromMe: true,
      };
      messages.push(message);
      for (const listener of listeners) listener({ event: "message", message });
      return message;
    },
  };
}
