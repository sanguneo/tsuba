import { expect, test } from "bun:test";
import { AdapterError, type Message } from "@tsuba/serve-kit";
import { bounded, deferred } from "../../../tests/harness/barriers";
import { RecentMessages } from "./recent-messages";

function message(id: number, text = "Synthetic"): Message {
  return {
    id: String(id),
    roomId: "room",
    text,
    sender: "Synthetic",
    sentAt: "2026-10-01T00:00:00Z",
    kind: "text",
    fromMe: false,
  };
}
const page = { messages: [message(1), message(2)], hasEarlier: false };

test("concurrent cold reads share one fetch and return independently sized windows", async () => {
  const cache = new RecentMessages();
  const fetched = deferred<typeof page>();
  let calls = 0;
  const load = () => {
    calls++;
    return fetched.promise;
  };
  const one = cache.read("room", 1, load);
  const two = cache.read("room", 2, load);
  fetched.resolve(page);
  expect(await one).toEqual({ messages: [message(2)], hasEarlier: true });
  expect(await two).toEqual(page);
  expect(calls).toBe(1);
});

test("stale hits return immediately and events win over an in-flight refresh", async () => {
  let now = 0;
  const cache = new RecentMessages({ now: () => now });
  await cache.read("room", 100, async () => page);
  now = 20_000;
  const fetched = deferred<typeof page>();
  const load = () => fetched.promise;
  expect(await bounded(cache.read("room", 100, load), "stale hit")).toEqual(
    page,
  );
  cache.apply({ event: "message.edited", message: message(2, "Edited") });
  cache.apply({ event: "message.deleted", roomId: "room", messageIds: ["1"] });
  cache.apply({ event: "message", message: message(3, "New") });
  expect(await cache.read("room", 100, load)).toEqual({
    messages: [message(2, "Edited"), message(3, "New")],
    hasEarlier: false,
  });
  fetched.resolve(page);
});

test("events during a cold fetch are merged without resurrecting a deleted message", async () => {
  const cache = new RecentMessages();
  const fetched = deferred<typeof page>();
  const read = cache.read("room", 100, () => fetched.promise);
  cache.apply({ event: "message.deleted", roomId: "room", messageIds: ["1"] });
  cache.apply({
    event: "message.edited",
    message: message(1, "Late partial edit"),
  });
  cache.apply({ event: "message", message: message(3) });
  cache.apply({
    event: "reactions.updated",
    roomId: "room",
    messageId: "3",
    reactions: [{ emoji: "x", count: 1, mine: false }],
  });
  fetched.resolve(page);
  expect((await read).messages).toEqual([
    message(2),
    { ...message(3), reactions: [{ emoji: "x", count: 1, mine: false }] },
  ]);
});

test("reaction removal replaces the list instead of merging stale reactions", async () => {
  const cache = new RecentMessages();
  await cache.read("room", 100, async () => ({
    messages: [
      { ...message(1), reactions: [{ emoji: "x", count: 1, mine: true }] },
    ],
    hasEarlier: false,
  }));
  cache.apply({
    event: "reactions.updated",
    roomId: "room",
    messageId: "1",
    reactions: [],
  });
  expect(cache.latest("room")?.reactions).toEqual([]);
});

test("a reaction after a pending edit preserves both changes", async () => {
  const cache = new RecentMessages();
  const fetched = deferred<typeof page>();
  const read = cache.read("room", 100, () => fetched.promise);
  cache.apply({ event: "message.edited", message: message(2, "Edited") });
  cache.apply({
    event: "reactions.updated",
    roomId: "room",
    messageId: "2",
    reactions: [],
  });
  fetched.resolve(page);
  expect((await read).messages[1]).toEqual({
    ...message(2, "Edited"),
    reactions: [],
  });
});

test("new events retain only the newest hundred and preserve older-page truth", async () => {
  const cache = new RecentMessages();
  await cache.read("room", 100, async () => ({
    messages: Array.from({ length: 100 }, (_, i) => message(i + 1)),
    hasEarlier: false,
  }));
  cache.apply({ event: "message", message: message(101) });
  const answer = await cache.read("room", 100, async () => page);
  expect(answer.messages).toHaveLength(100);
  expect(answer.messages[0]?.id).toBe("2");
  expect(answer.messages.at(-1)?.id).toBe("101");
  expect(answer.hasEarlier).toBe(true);
});

test("an empty room is cached and the first event becomes visible", async () => {
  const cache = new RecentMessages();
  const empty = { messages: [], hasEarlier: false };
  await cache.read("room", 100, async () => empty);
  expect(
    await cache.read("room", 100, async () => {
      throw new Error("Unexpected fetch");
    }),
  ).toEqual(empty);
  cache.apply({ event: "message", message: message(1) });
  expect((await cache.read("room", 100, async () => empty)).messages).toEqual([
    message(1),
  ]);
});

test("room and byte budgets evict old values rather than grow without bound", async () => {
  const cache = new RecentMessages({ maxRooms: 2 });
  await cache.read("one", 100, async () => page);
  await cache.read("two", 100, async () => page);
  await cache.read("three", 100, async () => page);
  expect(cache.latest("one")).toBeUndefined();
  const small = new RecentMessages({ maxBytes: 300 });
  await small.read("room", 100, async () => ({
    messages: [message(1, "x".repeat(400))],
    hasEarlier: false,
  }));
  expect(small.latest("room")).toBeUndefined();
});

test("invalidation prevents an old refresh from repopulating a room", async () => {
  const cache = new RecentMessages();
  const fetched = deferred<typeof page>();
  const read = cache.read("room", 100, () => fetched.promise);
  cache.clear();
  fetched.resolve(page);
  await expect(read).rejects.toMatchObject({ code: "BUSY" });
  expect(cache.latest("room")).toBeUndefined();
});

test("failures release the single flight and a later read can recover", async () => {
  const cache = new RecentMessages();
  await expect(
    cache.read("room", 100, async () => {
      throw new AdapterError("RATE_LIMITED", "Synthetic refusal");
    }),
  ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  expect(await cache.read("room", 100, async () => page)).toEqual(page);
});

test("concurrent room misses have a bounded REST work set", async () => {
  const cache = new RecentMessages();
  const fetched = deferred<typeof page>();
  const reads = Array.from({ length: 4 }, (_, i) =>
    cache.read(String(i), 100, () => fetched.promise),
  );
  await expect(
    cache.read("overflow", 100, async () => page),
  ).rejects.toMatchObject({ code: "BUSY" });
  fetched.resolve(page);
  await Promise.all(reads);
  expect(await cache.read("overflow", 100, async () => page)).toEqual(page);
});

test("an event overflow invalidates instead of keeping an unbounded refresh journal", async () => {
  const cache = new RecentMessages();
  const fetched = deferred<typeof page>();
  const read = cache.read("room", 100, () => fetched.promise);
  cache.apply({
    event: "message.deleted",
    roomId: "room",
    messageIds: Array.from({ length: 101 }, (_, i) => String(i)),
  });
  fetched.resolve(page);
  await expect(read).rejects.toMatchObject({ code: "BUSY" });
});

test("cursor suffixes contain only newer messages and deleted cursors are unknown", async () => {
  const cache = new RecentMessages();
  await cache.read("room", 100, async () => page);
  expect(cache.after("room", "1")).toEqual([message(2)]);
  expect(cache.after("room", "2")).toEqual([]);
  cache.apply({ event: "message.deleted", roomId: "room", messageIds: ["1"] });
  expect(cache.after("room", "1")).toBeUndefined();
  cache.clear();
  expect(cache.after("room", "2")).toBeUndefined();
});
