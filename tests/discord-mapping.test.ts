import { expect, test } from "bun:test";
import {
  type DiscordChannelLike,
  type DiscordMessageLike,
  mapDiscordAttachment,
  mapDiscordMessage,
  mapDiscordReaction,
  mapDiscordRoom,
  reactionPlan,
  snowflakeTime,
} from "../adapters/discord/src/mapping";
import { schema } from "./fixtures";

const channel: DiscordChannelLike = {
  id: "123456789012345678",
  type: 0,
  name: "general",
  guildName: "Synthetic server",
  lastMessageId: "175928847299117063",
  permissions: { view: true, readHistory: true, send: true },
};

const message: DiscordMessageLike = {
  id: "1479684169011234567",
  channelId: channel.id,
  authorId: "123",
  authorName: "Synthetic person",
  fromMe: false,
  content: "Synthetic text",
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  type: 0,
  stickers: 0,
  attachments: [],
  reactions: [],
};

test("only visible, readable standard guild text channels become rooms", () => {
  expect(mapDiscordRoom(channel)).toEqual({
    id: channel.id,
    title: "Synthetic server · #general",
    kind: "group",
    unread: 0,
    lastActivityAt: "2016-04-30T11:18:25.796Z",
  });
  for (const candidate of [
    { ...channel, type: 1 },
    { ...channel, type: 3 },
    { ...channel, type: 5 },
    { ...channel, type: 11 },
    { ...channel, type: 15 },
    { ...channel, type: 2 },
    { ...channel, permissions: { ...channel.permissions, view: false } },
    {
      ...channel,
      permissions: { ...channel.permissions, readHistory: false },
    },
  ])
    expect(mapDiscordRoom(candidate)).toBeNull();
  expect(
    mapDiscordRoom({
      ...channel,
      permissions: { ...channel.permissions, send: false },
    })?.features,
  ).toEqual({ "messages.send": false, "attachments.send": false });
});

test("a thread of a standard text channel is a room titled under its channel", () => {
  const thread = {
    ...channel,
    name: "synthetic thread",
    parentName: "general",
  };
  for (const type of [11, 12])
    expect(mapDiscordRoom({ ...thread, type })?.title).toBe(
      "Synthetic server · #general › synthetic thread",
    );
  expect(mapDiscordRoom({ ...thread, type: 10 })).toBeNull();
  expect(
    mapDiscordRoom({
      ...thread,
      type: 11,
      permissions: { ...thread.permissions, send: false },
    })?.features,
  ).toEqual({ "messages.send": false, "attachments.send": false });
});

test("a room's sidebar place goes out under x-discord.place and still fits the contract", () => {
  const place = {
    guild: { id: "111111111111111111", name: "Synthetic server" },
    category: { id: "222222222222222222", name: "Talk", position: 3 },
    channel: { id: channel.id, name: "general", position: 1 },
    thread: { id: "333333333333333333", name: "synthetic thread" },
  };
  const room = mapDiscordRoom({
    ...channel,
    id: place.thread.id,
    type: 11,
    name: place.thread.name,
    parentName: "general",
    place,
  });
  expect(room).toHaveProperty(["x-discord.place"], place);
  expect(schema("Room")(room)).toBe(true);
  expect(mapDiscordRoom(channel)).not.toHaveProperty("x-discord.place");
});

test("a snowflake carries its time, as Discord documents; a malformed one carries none", () => {
  expect(snowflakeTime("175928847299117063")).toBe("2016-04-30T11:18:25.796Z");
  expect(snowflakeTime("not-a-snowflake")).toBeUndefined();
});

test("Discord attachments have opaque channel/message/attachment ids and safe optional metadata", () => {
  const image = mapDiscordAttachment(channel.id, message.id, {
    id: "987654321012345678",
    url: "https://cdn.discordapp.com/attachments/x.png",
    name: "picture.png",
    contentType: "image/png",
    size: 512,
    width: 640,
    height: 480,
  });
  expect(image).toEqual({
    id: `${channel.id}:${message.id}:987654321012345678`,
    kind: "image",
    name: "picture.png",
    mimeType: "image/png",
    size: 512,
    width: 640,
    height: 480,
  });
  expect(schema("Attachment")(image)).toBe(true);
  expect(
    mapDiscordAttachment(channel.id, message.id, {
      id: "f",
      url: "https://cdn.discordapp.com/attachments/f",
      name: "loop.gif",
      contentType: "image/gif",
      size: 0,
      width: null,
      height: 0,
    }),
  ).toEqual({
    id: `${channel.id}:${message.id}:f`,
    kind: "animation",
    name: "loop.gif",
    mimeType: "image/gif",
    size: 0,
  });
});

test("Unicode reactions are mapped; custom emoji and invalid counts are absent", () => {
  expect(
    mapDiscordReaction({
      emojiName: "👍",
      emojiId: null,
      count: 4,
      me: true,
    }),
  ).toEqual({ emoji: "👍", count: 4, mine: true });
  expect(
    mapDiscordReaction({
      emojiName: "party",
      emojiId: "987654321",
      count: 2,
      me: false,
    }),
  ).toBeUndefined();
  expect(
    mapDiscordReaction({
      emojiName: "👍",
      count: 0,
      me: false,
    }),
  ).toBeUndefined();
});

test("message conversion preserves string ids, reply, edits, attachments and reactions", () => {
  const value = mapDiscordMessage({
    ...message,
    fromMe: true,
    editedAt: new Date("2026-10-01T00:01:00.000Z"),
    referenceId: "1479684169011234555",
    attachments: [
      {
        id: "987654321012345678",
        url: "https://cdn.discordapp.com/attachments/x.png",
        name: "picture.png",
        contentType: "image/png",
        size: 512,
      },
    ],
    reactions: [{ emojiName: "🔥", emojiId: null, count: 2, me: true }],
  });
  expect(schema("Message")(value)).toBe(true);
  expect(value).toMatchObject({
    id: message.id,
    roomId: channel.id,
    kind: "media",
    fromMe: true,
    replyTo: "1479684169011234555",
    reactions: [{ emoji: "🔥", count: 2, mine: true }],
  });
});

test("senderAvatar is emitted only when the adapter supplies an opaque avatar id", () => {
  expect(mapDiscordMessage(message)).not.toHaveProperty("senderAvatar");
  const avatarId = "avatar:100000000000000003:0123456789abcdef0123456789abcdef";
  const mapped = mapDiscordMessage({ ...message, avatarId });
  expect(mapped.senderAvatar).toBe(avatarId);
  expect(schema("Message")(mapped)).toBe(true);
});

test("replies and command answers are conversation; joins, pins and the like are service, even with a file", () => {
  for (const type of [0, 19, 20, 23])
    expect(mapDiscordMessage({ ...message, type }).kind).toBe("text");
  for (const type of [6, 7, 8, 18])
    expect(
      mapDiscordMessage({
        ...message,
        type,
        attachments: [
          {
            id: "f",
            url: "https://cdn.discordapp.com/attachments/f",
            name: "file.bin",
            size: 1,
          },
        ],
      }).kind,
    ).toBe("service");
});

test("a sticker alone is media; a voice message's recording is a voice attachment with its length", () => {
  expect(mapDiscordMessage({ ...message, content: "", stickers: 1 }).kind).toBe(
    "media",
  );
  const voice = mapDiscordAttachment(channel.id, message.id, {
    id: "987654321012345679",
    url: "https://cdn.discordapp.com/attachments/voice-message.ogg",
    name: "voice-message.ogg",
    contentType: "audio/ogg",
    size: 2048,
    durationSeconds: 4.5,
  });
  expect(schema("Attachment")(voice)).toBe(true);
  expect(voice).toMatchObject({ kind: "voice", durationSeconds: 4.5 });
  expect(
    mapDiscordAttachment(channel.id, message.id, {
      id: "987654321012345680",
      url: "https://cdn.discordapp.com/attachments/song.mp3",
      name: "song.mp3",
      contentType: "audio/mpeg",
      size: 4096,
    }).kind,
  ).toBe("audio");
});

test("setting reactions removes the ones no longer wanted before adding new ones", () => {
  expect(reactionPlan(["A", "B"], ["B", "C"])).toEqual({
    remove: ["A"],
    add: ["C"],
  });
  expect(reactionPlan(["A"], [])).toEqual({ remove: ["A"], add: [] });
  expect(reactionPlan([], ["A"])).toEqual({ remove: [], add: ["A"] });
  expect(reactionPlan(["A"], ["A"])).toEqual({ remove: [], add: [] });
});
