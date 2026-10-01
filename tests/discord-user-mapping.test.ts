import { expect, test } from "bun:test";
import {
  CHANNEL_TYPE,
  type DiscordMessageLike,
  mapUserChannel,
  mapUserMessage,
} from "../adapters/discord-user/src/mapping";
import { schema } from "./fixtures";

const message: DiscordMessageLike = {
  id: "5001",
  channelId: "1001",
  authorId: "2001",
  authorName: "Synthetic person",
  fromMe: true,
  content: "Synthetic text",
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  type: 0,
  stickers: 0,
  attachments: [],
  reactions: [],
};

test("normalized direct channels use recipient names and snowflake activity", () => {
  const room = mapUserChannel({
    id: "1001",
    type: CHANNEL_TYPE.DM,
    recipients: [
      { id: "2001", username: "synthetic", globalName: "Synthetic" },
    ],
    lastMessageId: "175928847299117063",
  });
  expect(room).toEqual({
    id: "1001",
    title: "Synthetic",
    kind: "direct",
    unread: 0,
    lastActivityAt: "2016-04-30T11:18:25.796Z",
  });
  expect(schema("Room")(room)).toBe(true);
  expect(
    mapUserChannel({
      id: "1001",
      type: CHANNEL_TYPE.DM,
      recipients: [{ id: "2001", username: "synthetic", globalName: null }],
    })?.title,
  ).toBe("synthetic");
  expect(mapUserChannel({ id: "1001", type: CHANNEL_TYPE.DM })?.title).toBe(
    "Direct Message",
  );
});

test("normalized group direct channels use an explicit name or recipient names", () => {
  const channel = {
    id: "1002",
    type: CHANNEL_TYPE.GROUP_DM,
    recipients: [
      { id: "2001", username: "synthetic-a", globalName: "Synthetic A" },
      { id: "2002", username: "synthetic-b", globalName: null },
    ],
  };
  expect(mapUserChannel(channel)).toEqual({
    id: "1002",
    title: "Synthetic A, synthetic-b",
    kind: "group",
    unread: 0,
  });
  expect(mapUserChannel({ ...channel, name: "Synthetic group" })?.title).toBe(
    "Synthetic group",
  );
  expect(mapUserChannel({ ...channel, recipients: [] })?.title).toBe("unnamed");
});

test("normalized guild channels use guild names and reject unsupported types", () => {
  const channel = {
    id: "1003",
    type: CHANNEL_TYPE.GUILD_TEXT,
    name: "general",
  };
  expect(mapUserChannel({ ...channel, guildName: "Synthetic server" })).toEqual(
    {
      id: "1003",
      title: "Synthetic server · #general",
      kind: "group",
      unread: 0,
    },
  );
  expect(mapUserChannel(channel)?.title).toBe("#general");
  expect(mapUserChannel({ ...channel, name: null })?.title).toBe("#channel");
  for (const type of [2, 4, 5, 10, 11, 12, 13, 14, 15, 16])
    expect(mapUserChannel({ ...channel, type })).toBeNull();
});

test("empty normalized names are preserved rather than replaced by fallbacks", () => {
  expect(
    mapUserChannel({
      id: "1001",
      type: CHANNEL_TYPE.DM,
      recipients: [{ id: "2001", username: "synthetic", globalName: "" }],
    })?.title,
  ).toBe("");
  expect(
    mapUserChannel({ id: "1002", type: CHANNEL_TYPE.GROUP_DM, name: "" })
      ?.title,
  ).toBe("");
  expect(
    mapUserChannel({
      id: "1003",
      type: CHANNEL_TYPE.GUILD_TEXT,
      name: "",
      guildName: "",
    })?.title,
  ).toBe(" · #");
});

test("user room previews are limited to 200 code points and preserve direction", () => {
  const room = mapUserChannel({
    id: "1001",
    type: CHANNEL_TYPE.DM,
    lastMessageId: "invalid",
    lastMessage: { content: "😀".repeat(201), fromMe: true },
  });
  expect(room?.lastMessage).toEqual({ text: "😀".repeat(200), fromMe: true });
  expect(room).not.toHaveProperty("lastActivityAt");
  expect(room?.unread).toBe(0);
  expect(schema("Room")(room)).toBe(true);
  expect(
    mapUserChannel({
      id: "1001",
      type: CHANNEL_TYPE.DM,
      lastMessage: { content: "", fromMe: false },
    })?.lastMessage,
  ).toEqual({ text: "", fromMe: false });
});

test("user messages reuse the shared normalized mapping and its metadata checks", () => {
  const mapped = mapUserMessage({
    ...message,
    editedAt: new Date("2026-10-01T00:01:00.000Z"),
    referenceId: "5000",
    attachments: [
      {
        id: "att1",
        url: "https://cdn.discordapp.com/attachments/synthetic/loop.gif",
        name: "loop.gif",
        size: -1,
        width: Infinity,
        height: 100,
        durationSeconds: -1,
      },
    ],
    reactions: [
      { emojiName: "👍", count: 2, me: true },
      { emojiName: "👍", count: 0, me: false },
      { emojiName: "custom", emojiId: "custom1", count: 1, me: false },
    ],
  });
  expect(mapped).toMatchObject({
    id: message.id,
    roomId: message.channelId,
    sender: message.authorName,
    fromMe: true,
    kind: "media",
    editedAt: "2026-10-01T00:01:00.000Z",
    replyTo: "5000",
    attachments: [
      { id: "1001:5001:att1", kind: "animation", name: "loop.gif" },
    ],
    reactions: [{ emoji: "👍", count: 2, mine: true }],
  });
  expect(mapped.attachments?.[0]).not.toHaveProperty("size");
  expect(mapped.attachments?.[0]).not.toHaveProperty("width");
  expect(mapped.attachments?.[0]).not.toHaveProperty("height");
  expect(mapped.attachments?.[0]).not.toHaveProperty("durationSeconds");
  expect(schema("Message")(mapped)).toBe(true);
});
