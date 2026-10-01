import { expect, test } from "bun:test";
import {
  type MessageLike,
  mapMessage,
  mapRoom,
  type PeerLike,
} from "../adapters/telegram/src/mapping";
import { schema } from "./fixtures";

const user: PeerLike = { type: "user", id: 123, displayName: "Synthetic user" };
const chat: PeerLike = {
  type: "chat",
  id: -100123,
  displayName: "Synthetic chat",
  chatType: "supergroup",
};
const input: MessageLike = {
  id: 7,
  chat,
  sender: user,
  text: "Synthetic text",
  date: new Date("2026-01-01T00:00:00Z"),
  isOutgoing: false,
};

test("rooms preserve marked ids, kinds, unread and absent optional keys", () => {
  for (const [peer, kind] of [
    [user, "direct"],
    [chat, "group"],
    [{ ...chat, chatType: "channel" }, "channel"],
    [{ ...chat, chatType: "community" }, "group"],
  ] as const) {
    const room = mapRoom({ peer, unreadCount: 3, lastMessage: null });
    expect(schema("Room")(room)).toBe(true);
    expect(room).toEqual({
      id: String(peer.id),
      title: peer.displayName,
      kind,
      unread: 3,
    });
  }
});

test("room previews use 200 code points and ISO activity dates", () => {
  const room = mapRoom({
    peer: chat,
    unreadCount: 0,
    lastMessage: { ...input, text: "\u{1F600}".repeat(201), isOutgoing: true },
  });
  expect(schema("Room")(room)).toBe(true);
  expect(room.lastMessage).toEqual({
    text: "\u{1F600}".repeat(200),
    fromMe: true,
  });
  expect(room.lastActivityAt).toBe("2026-01-01T00:00:00.000Z");
});

test("message mapping has string ids, names, ISO dates and no null optionals", () => {
  const message = mapMessage({
    ...input,
    editDate: null,
    replyToMessage: { id: null },
  });
  expect(schema("Message")(message)).toBe(true);
  expect(message).toEqual({
    id: "7",
    roomId: "-100123",
    senderId: "123",
    sender: "Synthetic user",
    text: "Synthetic text",
    kind: "text",
    sentAt: "2026-01-01T00:00:00.000Z",
    fromMe: false,
  });
  const edited = mapMessage({
    ...input,
    sender: chat,
    editDate: new Date("2026-01-02T00:00:00Z"),
    replyToMessage: { id: 6 },
    isOutgoing: true,
  });
  expect(schema("Message")(edited)).toBe(true);
  expect(edited.sender).toBe(chat.displayName);
  expect(edited.editedAt).toBe("2026-01-02T00:00:00.000Z");
  expect(edited.replyTo).toBe("6");
  expect(edited.fromMe).toBe(true);
});

test("service wins over media, including unsupported raw actions and media", () => {
  for (const [extra, kind] of [
    [{ isService: true, media: {} }, "service"],
    [{ action: {} }, "service"],
    [{ raw: { action: {} } }, "service"],
    [{ media: {} }, "media"],
    [{ raw: { media: {} } }, "media"],
    [{ media: null, action: null }, "text"],
  ] as const) {
    const message = mapMessage({ ...input, ...extra, text: "" });
    expect(schema("Message")(message)).toBe(true);
    expect(message.kind).toBe(kind);
  }
});
