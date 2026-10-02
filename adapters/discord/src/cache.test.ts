import { expect, test } from "bun:test";
import {
  Client,
  ClientUser,
  Collection,
  Events,
  Guild,
  Message,
  PermissionsBitField,
  TextChannel,
} from "discord.js";
import { bounded, deferred } from "../../../tests/harness/barriers";
import { discordBackend, warmRecentRooms } from "./backend";

const ROOM = "100000000000000001";
const BOT = "100000000000000002";
const GUILD = "100000000000000003";

function fixture() {
  const client = new Client<true>({ intents: [] });
  const user: unknown = Reflect.construct(ClientUser, [
    client,
    {
      id: BOT,
      username: "Synthetic",
      discriminator: "0000",
      avatar: null,
    },
  ]);
  if (!(user instanceof ClientUser)) throw new Error("Invalid fixture user");
  client.user = user;
  const guild: unknown = Reflect.construct(Guild, [
    client,
    { id: GUILD, name: "Synthetic guild" },
  ]);
  if (!(guild instanceof Guild)) throw new Error("Invalid fixture guild");
  client.guilds.cache.set(GUILD, guild);
  const channel: unknown = Reflect.construct(TextChannel, [
    guild,
    { id: ROOM, name: "synthetic", type: 0 },
    client,
  ]);
  if (!(channel instanceof TextChannel))
    throw new Error("Invalid fixture channel");
  client.channels.cache.set(ROOM, channel);
  channel.permissionsFor = () =>
    new PermissionsBitField(PermissionsBitField.All);
  client.channels.fetch = async () => channel;
  const raw: unknown = Reflect.construct(Message, [
    client,
    {
      id: "100000000000000004",
      channel_id: ROOM,
      guild_id: GUILD,
      author: {
        id: BOT,
        username: "Synthetic",
        discriminator: "0000",
        avatar: null,
      },
      content: "Synthetic message",
      timestamp: "2026-10-01T00:00:00.000Z",
      type: 0,
      attachments: [],
      embeds: [],
      mentions: [],
    },
  ]);
  if (!(raw instanceof Message)) throw new Error("Invalid fixture message");
  if (!raw.inGuild()) throw new Error("Fixture message must belong to a guild");
  const page = new Collection([[raw.id, raw]]);
  return { client, channel, page, raw };
}

test("a warm room answers while the next Discord read is still pending", async () => {
  const { client, channel, page } = fixture();
  Object.defineProperty(channel.messages, "fetch", {
    configurable: true,
    value: async () => page,
  });
  const backend = discordBackend(client);
  const first = await backend.readMessages?.({ roomId: ROOM, limit: 40 });
  const network = deferred<typeof page>();
  Object.defineProperty(channel.messages, "fetch", {
    configurable: true,
    value: () => network.promise,
  });
  try {
    const next = await bounded(
      Promise.resolve(backend.readMessages?.({ roomId: ROOM, limit: 40 })),
      "warm room must not wait for Discord",
      500,
    );
    expect(next).toEqual(first);
  } finally {
    network.resolve(page);
    await client.destroy();
  }
});

test("gateway edits and deletes update the warm window", async () => {
  const { client, channel, page, raw } = fixture();
  Object.defineProperty(channel.messages, "fetch", { value: async () => page });
  const backend = discordBackend(client);
  const edited = deferred<void>();
  const unsubscribe = backend.subscribe?.((update) => {
    if (update.event === "message.edited") edited.resolve();
  });
  try {
    await backend.readMessages?.({ roomId: ROOM, limit: 40 });
    raw.content = "Edited synthetic message";
    client.emit(Events.MessageUpdate, raw, raw);
    await bounded(edited.promise, "edit notification");
    expect(
      (await backend.readMessages?.({ roomId: ROOM, limit: 40 }))?.messages[0]
        ?.text,
    ).toBe("Edited synthetic message");
    client.emit(Events.MessageDelete, raw);
    expect(
      (await backend.readMessages?.({ roomId: ROOM, limit: 40 }))?.messages,
    ).toEqual([]);
  } finally {
    unsubscribe?.();
    await client.destroy();
  }
});

test("a cached room still checks current read permissions", async () => {
  const { client, channel, page } = fixture();
  Object.defineProperty(channel.messages, "fetch", { value: async () => page });
  const backend = discordBackend(client);
  try {
    await backend.readMessages?.({ roomId: ROOM, limit: 40 });
    channel.permissionsFor = () => new PermissionsBitField();
    await expect(
      backend.readMessages?.({ roomId: ROOM, limit: 40 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  } finally {
    await client.destroy();
  }
});

test("older-page reads bypass and do not replace the cached latest window", async () => {
  const { client, channel, page } = fixture();
  Object.defineProperty(channel.messages, "fetch", {
    configurable: true,
    value: async () => page,
  });
  const backend = discordBackend(client);
  try {
    const first = await backend.readMessages?.({ roomId: ROOM, limit: 40 });
    Object.defineProperty(channel.messages, "fetch", {
      value: async () => new Collection(),
    });
    expect(
      (
        await backend.readMessages?.({
          roomId: ROOM,
          limit: 40,
          before: "100000000000000004",
        })
      )?.messages,
    ).toEqual([]);
    expect(await backend.readMessages?.({ roomId: ROOM, limit: 40 })).toEqual(
      first,
    );
  } finally {
    await client.destroy();
  }
});

test("gateway resume invalidates snapshots that may have missed edits", async () => {
  const { client, channel, page } = fixture();
  Object.defineProperty(channel.messages, "fetch", {
    configurable: true,
    value: async () => page,
  });
  const backend = discordBackend(client);
  const unsubscribe = backend.subscribe?.(() => {});
  try {
    await backend.readMessages?.({ roomId: ROOM, limit: 40 });
    Object.defineProperty(channel.messages, "fetch", {
      value: async () => new Collection(),
    });
    client.emit(Events.ShardResume, 0, 0);
    expect(
      (await backend.readMessages?.({ roomId: ROOM, limit: 40 }))?.messages,
    ).toEqual([]);
  } finally {
    unsubscribe?.();
    await client.destroy();
  }
});

test("a stream resumes from a known cached cursor without another REST read", async () => {
  const { client, channel, page, raw } = fixture();
  Object.defineProperty(channel.messages, "fetch", {
    configurable: true,
    value: async () => page,
  });
  const backend = discordBackend(client);
  try {
    await backend.readMessages?.({ roomId: ROOM, limit: 40 });
    Object.defineProperty(channel.messages, "fetch", {
      value: async () => {
        throw new Error("Unexpected REST read for a known cursor");
      },
    });
    expect(await backend.messagesAfter?.(ROOM, raw.id)).toEqual([]);
  } finally {
    await client.destroy();
  }
});

test("prefill reads recent rooms serially and stops when its lifetime ends", async () => {
  const lifetime = new AbortController();
  const first = deferred<{ messages: []; hasEarlier: false }>();
  const started = deferred<void>();
  const visited: string[] = [];
  const warming = warmRecentRooms(
    {
      listRooms: async () => ({
        rooms: Array.from({ length: 6 }, (_, i) => ({
          id: String(i),
          title: "Synthetic",
          kind: "group",
          unread: 0,
        })),
        complete: true,
      }),
      readMessages: async ({ roomId }) => {
        visited.push(roomId);
        started.resolve();
        return first.promise;
      },
    },
    lifetime.signal,
  );
  await bounded(started.promise, "first prefill");
  expect(visited).toEqual(["0"]);
  lifetime.abort();
  first.resolve({ messages: [], hasEarlier: false });
  expect(await warming).toBe(1);
  expect(visited).toEqual(["0"]);
});

test("prefill respects its startup request budget rather than loading every room", async () => {
  const visited: string[] = [];
  const result = await warmRecentRooms(
    {
      listRooms: async () => ({
        rooms: Array.from({ length: 10 }, (_, i) => ({
          id: String(i),
          title: "Synthetic",
          kind: "group",
          unread: 0,
        })),
        complete: true,
      }),
      readMessages: async ({ roomId }) => {
        visited.push(roomId);
        return { messages: [], hasEarlier: false };
      },
    },
    new AbortController().signal,
  );
  expect(visited).toEqual(["0", "1", "2", "3"]);
  expect(result).toBe(4);
});
