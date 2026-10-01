import { expect, test } from "bun:test";
import { getDiscordHeaders } from "../adapters/discord-user/src/backend";
import { CAPABILITIES } from "../adapters/discord-user/src/capabilities";
import {
  CHANNEL_TYPE,
  mapUserChannel,
  mapUserMessage,
  snowflakeTime,
} from "../adapters/discord-user/src/mapping";

test("snowflakeTime converts Discord snowflake to ISO date string", () => {
  const ts = snowflakeTime("175928847299117063");
  expect(ts).toBe("2016-04-30T11:18:25.796Z");
  expect(snowflakeTime("invalid")).toBeUndefined();
});

test("mapUserChannel maps DMs, Group DMs and Guild Text channels properly", () => {
  const dm = mapUserChannel({
    id: "1001",
    type: CHANNEL_TYPE.DM,
    recipients: [{ id: "2001", username: "alice", global_name: "Alice" }],
    last_message_id: "175928847299117063",
  });
  expect(dm).toEqual({
    id: "1001",
    title: "Alice",
    kind: "direct",
    unread: 0,
    lastActivityAt: "2016-04-30T11:18:25.796Z",
  });

  const guildText = mapUserChannel(
    {
      id: "1002",
      type: CHANNEL_TYPE.GUILD_TEXT,
      name: "general",
      guild_id: "3001",
    },
    "My Server",
  );
  expect(guildText?.title).toBe("My Server · #general");
  expect(guildText?.kind).toBe("group");

  const voice = mapUserChannel({
    id: "1003",
    type: CHANNEL_TYPE.GUILD_VOICE,
    name: "voice",
  });
  expect(voice).toBeNull();
});

test("mapUserMessage maps regular messages, attachments and reactions", () => {
  const msg = mapUserMessage(
    {
      id: "5001",
      channel_id: "1001",
      author: { id: "2001", username: "alice", global_name: "Alice" },
      content: "Hello world!",
      timestamp: "2026-10-01T00:00:00.000Z",
      type: 0,
      attachments: [
        {
          id: "att1",
          filename: "test.png",
          size: 1024,
          url: "https://cdn.discordapp.com/attachments/1001/att1/test.png",
          proxy_url:
            "https://media.discordapp.net/attachments/1001/att1/test.png",
          content_type: "image/png",
          width: 100,
          height: 100,
        },
      ],
      reactions: [
        { emoji: { name: "👍" }, count: 2, me: true },
        { emoji: { id: "custom1", name: "custom" }, count: 1, me: false },
      ],
    },
    "self_user_id",
  );

  expect(msg.id).toBe("5001");
  expect(msg.roomId).toBe("1001");
  expect(msg.sender).toBe("Alice");
  expect(msg.fromMe).toBe(false);
  expect(msg.kind).toBe("media");
  expect(msg.attachments).toHaveLength(1);
  expect(msg.attachments?.[0]?.kind).toBe("image");
  expect(msg.reactions).toEqual([{ emoji: "👍", count: 2, mine: true }]);
});

test("getDiscordHeaders includes X-Super-Properties, User-Agent, Authorization", () => {
  const headers = getDiscordHeaders("test_token_123");
  expect(headers.Authorization).toBe("test_token_123");
  expect(headers["X-Super-Properties"]).toBeDefined();
  expect(headers["User-Agent"]).toContain("Chrome");
});

test("CAPABILITIES declares account.kind as user", () => {
  expect(CAPABILITIES.account.kind).toBe("user");
  expect(CAPABILITIES.provider.id).toBe("discord-user");
  expect(CAPABILITIES.features["read.mark"]).toBeDefined();
});
