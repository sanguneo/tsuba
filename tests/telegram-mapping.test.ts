import { expect, test } from "bun:test";
import {
  canSendText,
  type MediaLike,
  type MessageLike,
  mapAttachment,
  mapMessage,
  mapReactions,
  mapRoom,
  markedPeerId,
  type PeerLike,
  rawReaction,
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
  const admin = { isAdmin: true, adminRights: { postMessages: true } };
  for (const [peer, kind] of [
    [user, "direct"],
    [chat, "group"],
    [{ ...chat, chatType: "channel", ...admin }, "channel"],
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

test("a room the account cannot post in narrows messages.send to false", () => {
  const channel: PeerLike = { ...chat, chatType: "channel" };
  const allowed = { canSendText: true };
  const denied = { canSendText: false };
  for (const [peer, expected] of [
    [user, true],
    [{ ...user, isDeleted: true }, false],
    [{ ...user, id: 777000 }, false],
    [chat, true],
    [{ ...chat, isMember: false }, false],
    [{ ...chat, isBanned: true }, false],
    [{ ...chat, defaultPermissions: denied }, false],
    [{ ...chat, permissions: denied, defaultPermissions: allowed }, false],
    [{ ...chat, isAdmin: true, defaultPermissions: denied }, true],
    [channel, false],
    [{ ...channel, isAdmin: true, adminRights: {} }, false],
    [{ ...channel, isAdmin: true, adminRights: { postMessages: true } }, true],
    [{ ...channel, isCreator: true }, true],
    [{ ...chat, chatType: "gigagroup" }, false],
    [{ ...chat, chatType: "gigagroup", isAdmin: true }, true],
  ] as const) {
    expect(canSendText(peer)).toBe(expected);
    const room = mapRoom({ peer, unreadCount: 0 });
    expect(schema("Room")(room)).toBe(true);
    expect(room.features).toEqual(
      expected ? undefined : { "messages.send": false },
    );
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

test("album members keep separate messages with the same decimal group id", () => {
  for (const decimal of ["1234567890123456789", "-1234567890123456789", "0"]) {
    const groupedId = { toString: () => decimal };
    const messages = [7, 8].map((id) =>
      mapMessage({ ...input, id, groupedId, media: { type: "photo" } }),
    );
    expect(messages.map((message) => message.id)).toEqual(["7", "8"]);
    for (const message of messages) {
      expect(schema("Message")(message)).toBe(true);
      expect(message.groupId).toBe(decimal);
      expect(message.senderId).toBe("123");
    }
  }
  for (const extra of [{}, { groupedId: null }]) {
    const message = mapMessage({ ...input, ...extra });
    expect(schema("Message")(message)).toBe(true);
    expect("groupId" in message).toBe(false);
  }
});

test("sender avatars name the user or chat and change with the profile photo", () => {
  for (const sender of [user, chat]) {
    for (const photoId of ["1234567890123456789", "-1234567890123456789"]) {
      const message = mapMessage({
        ...input,
        sender: { ...sender, photo: { raw: { photoId } } },
      });
      expect(schema("Message")(message)).toBe(true);
      expect(message.senderAvatar).toBe(`avatar:${sender.id}:${photoId}`);
    }
    expect(mapMessage({ ...input, sender }).senderAvatar).toBeUndefined();
    expect(
      mapMessage({ ...input, sender: { ...sender, photo: null } }).senderAvatar,
    ).toBeUndefined();
  }
});

test("service wins over media, including unsupported raw actions and media", () => {
  for (const [extra, kind] of [
    [{ isService: true, media: { type: "photo" } }, "service"],
    [{ action: {} }, "service"],
    [{ raw: { action: {} } }, "service"],
    [{ media: { type: "poll" } }, "media"],
    [{ raw: { media: {} } }, "media"],
    [{ media: { type: "webpage" } }, "text"],
    [{ media: null, action: null }, "text"],
  ] as const) {
    const message = mapMessage({ ...input, ...extra, text: "" });
    expect(schema("Message")(message)).toBe(true);
    expect(message.kind).toBe(kind);
  }
});

test("files become attachments with ids that name the room, message and file", () => {
  const photo: MediaLike = {
    type: "photo",
    uniqueFileId: "AQADsynthetic",
    width: 1280,
    height: 720,
    fileSize: 81_920,
  };
  const message = mapMessage({ ...input, text: "", media: photo });
  expect(schema("Message")(message)).toBe(true);
  expect(message.kind).toBe("media");
  expect(message.attachments).toEqual([
    {
      id: "-100123:7:AQADsynthetic",
      kind: "image",
      mimeType: "image/jpeg",
      size: 81_920,
      width: 1280,
      height: 720,
    },
  ]);
  for (const [media, expected] of [
    [
      {
        type: "document",
        uniqueFileId: "f",
        mimeType: "application/pdf",
        fileName: "Synthetic.pdf",
        fileSize: 0,
      },
      {
        kind: "file",
        name: "Synthetic.pdf",
        mimeType: "application/pdf",
        size: 0,
      },
    ],
    [
      {
        type: "video",
        uniqueFileId: "f",
        mimeType: "video/mp4",
        isAnimation: true,
        width: 320,
        height: 240,
        duration: 2,
      },
      {
        kind: "animation",
        mimeType: "video/mp4",
        width: 320,
        height: 240,
        durationSeconds: 2,
      },
    ],
    [
      {
        type: "voice",
        uniqueFileId: "f",
        mimeType: "audio/ogg",
        duration: 3,
        fileName: null,
      },
      { kind: "voice", mimeType: "audio/ogg", durationSeconds: 3 },
    ],
    [
      {
        type: "sticker",
        uniqueFileId: "f",
        mimeType: "image/webp",
        width: 0,
        height: 512,
      },
      { kind: "sticker", mimeType: "image/webp" },
    ],
  ] as const) {
    const attachment = mapAttachment("r", "1", media);
    expect(attachment).toEqual({ id: "r:1:f", ...expected });
    expect(schema("Attachment")(attachment)).toBe(true);
  }
});

test("no attachment for self-destructing media, link previews or unknown media", () => {
  for (const media of [
    { type: "photo", uniqueFileId: "f", ttlSeconds: 10 },
    { type: "voice", uniqueFileId: "f", ttlSeconds: 2147483647 },
    { type: "webpage" },
    { type: "poll" },
    { type: "document" },
  ] as const) {
    expect(mapAttachment("r", "1", media)).toBeNull();
    const message = mapMessage({ ...input, media });
    expect(schema("Message")(message)).toBe(true);
    expect(message.attachments).toBeUndefined();
  }
});

test("reactions keep Unicode emoji with counts and this account's choice, and leave out custom, paid and empty ones", () => {
  const message = mapMessage({
    ...input,
    reactions: {
      reactions: [
        { emoji: "\u{1F44D}", count: 3, order: 0 },
        { emoji: "\u{1F525}", count: 1, order: null },
        { emoji: { low: 1, high: 2 }, count: 2, order: null },
        { emoji: "\u{2B50}", isPaid: true, count: 5, order: null },
        { emoji: "\u{1F622}", count: 0, order: null },
      ],
    },
  });
  expect(schema("Message")(message)).toBe(true);
  expect(message.reactions).toEqual([
    { emoji: "\u{1F44D}", count: 3, mine: true },
    { emoji: "\u{1F525}", count: 1, mine: false },
  ]);
  expect(
    "reactions" in mapMessage({ ...input, reactions: { reactions: [] } }),
  ).toBe(false);
  expect("reactions" in mapMessage({ ...input, reactions: null })).toBe(false);
});

test("raw reaction updates name their room by the marked id and their emoji as parsed ones do", () => {
  expect(markedPeerId({ _: "peerUser", userId: 123 })).toBe(123);
  expect(markedPeerId({ _: "peerChat", chatId: 456 })).toBe(-456);
  expect(markedPeerId({ _: "peerChannel", channelId: 789 })).toBe(
    -1000000000789,
  );
  expect(
    mapReactions([
      rawReaction({
        reaction: { _: "reactionEmoji", emoticon: "\u{1F44D}" },
        count: 2,
        chosenOrder: 1,
      }),
      rawReaction({ reaction: { _: "reactionCustomEmoji" }, count: 1 }),
      rawReaction({ reaction: { _: "reactionPaid" }, count: 4 }),
    ]),
  ).toEqual([{ emoji: "\u{1F44D}", count: 2, mine: true }]);
});
