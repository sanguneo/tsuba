import { expect, test } from "bun:test";
import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BaileysEvents,
  type BaileysLike,
  openBaileys,
  prepareSessionDir,
} from "../adapters/whatsapp-user/src/baileys";
import type { WaSocketEvent } from "../adapters/whatsapp-user/src/types";
import { bounded, deferred } from "./harness/barriers";
import { ROOM, text } from "./whatsapp-user-fixtures";

async function setup() {
  const authDir = await mkdtemp(join(tmpdir(), "tsuba-wa-"));
  const handlers = new Map<string, ((data: never) => void)[]>();
  const calls: { jid: string; content: unknown; options: unknown }[] = [];
  let config: Record<string, unknown> = {};
  let ended = 0;
  const made = deferred<void>();
  const socket: BaileysLike = {
    ev: {
      on(event, listener) {
        handlers.set(event, [...(handlers.get(event) ?? []), listener]);
      },
    },
    sendMessage: (async (jid: string, content: unknown, options: unknown) => {
      calls.push({ jid, content, options });
      return text("9000", "sent");
    }) as BaileysLike["sendMessage"],
    end() {
      ended++;
    },
  };
  const wa = openBaileys({
    authDir,
    makeSocket(given) {
      config = given as unknown as Record<string, unknown>;
      made.resolve();
      return socket;
    },
  });
  const events: WaSocketEvent[] = [];
  wa.onEvent((event) => events.push(event));
  await bounded(made.promise, "socket created");
  function emit<E extends keyof BaileysEvents & string>(
    event: E,
    data: BaileysEvents[E],
  ) {
    for (const handler of handlers.get(event) ?? []) handler(data as never);
  }
  return {
    wa,
    events,
    emit,
    calls,
    authDir,
    config: () => config,
    ended: () => ended,
  };
}

test("the connection is opened without presence, history harvesting or library logging", async () => {
  const { config } = await setup();
  expect(config()).toMatchObject({
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });
  const logger = config().logger as { level: string; info(): void };
  expect(logger.level).toBe("silent");
  expect(logger.info()).toBeUndefined();
});

test("connection updates become qr, open and close with the Boom status code", async () => {
  const { events, emit } = await setup();
  emit("connection.update", { qr: "synthetic-qr" });
  emit("connection.update", { connection: "open" });
  emit("connection.update", {
    connection: "close",
    lastDisconnect: {
      error: Object.assign(new Error("synthetic"), {
        output: { statusCode: 401 },
      }),
      date: new Date(0),
    },
  });
  emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: new Error("no status"), date: new Date(0) },
  });
  expect(events).toEqual([
    { type: "qr", qr: "synthetic-qr" },
    { type: "open" },
    { type: "close", statusCode: 401 },
    { type: "close", statusCode: undefined },
  ]);
});

test("history, chats, contacts and live messages are translated; only notify is live", async () => {
  const { events, emit } = await setup();
  emit("messaging-history.set", {
    chats: [{ id: ROOM, conversationTimestamp: 1 }],
    contacts: [
      { id: ROOM, notify: "Pushed name" },
      { id: "100000000009@s.whatsapp.net" },
    ],
    messages: [text("1", "old")] as never,
  });
  emit("chats.update", [{ id: ROOM, unreadCount: 3 }, { unreadCount: 1 }]);
  emit("chats.delete", [ROOM]);
  emit("messages.upsert", {
    messages: [text("2", "now")] as never,
    type: "notify",
  });
  emit("messages.upsert", {
    messages: [text("3", "synced")] as never,
    type: "append",
  });
  expect(events.map((event) => event.type)).toEqual([
    "chats",
    "names",
    "messages",
    "chats",
    "chatsDeleted",
    "messages",
    "messages",
  ]);
  expect(events[1]).toEqual({
    type: "names",
    names: [{ id: ROOM, name: "Pushed name" }],
  });
  expect(events[2]).toMatchObject({ live: false });
  expect(events[3]).toMatchObject({ chats: [{ id: ROOM, unreadCount: 3 }] });
  expect(events[5]).toMatchObject({ live: true });
  expect(events[6]).toMatchObject({ live: false });
});

test("edits and revokes become edit and delete events; other updates are ignored", async () => {
  const { events, emit } = await setup();
  const key = { remoteJid: ROOM, id: "1" };
  emit("messages.update", [
    {
      key,
      update: {
        message: { editedMessage: { message: { conversation: "after" } } },
        messageTimestamp: 5,
      },
    },
    { key, update: { messageStubType: 1, message: null } },
    { key, update: { status: 3 } },
  ]);
  emit("messages.delete", { keys: [key] });
  emit("messages.delete", { jid: ROOM, all: true });
  expect(events).toEqual([
    { type: "edit", key, content: { conversation: "after" }, at: 5 },
    { type: "delete", keys: [key] },
    { type: "delete", keys: [key] },
  ]);
});

test("sendText sends plain text, quotes the held message, and returns the sent one", async () => {
  const { wa, calls } = await setup();
  const quoted = text("1", "q");
  const sent = await wa.sendText(ROOM, "hello", quoted);
  expect(sent?.key.id).toBe("9000");
  await wa.sendText(ROOM, "again");
  expect(calls).toEqual([
    { jid: ROOM, content: { text: "hello" }, options: { quoted } },
    { jid: ROOM, content: { text: "again" }, options: undefined },
  ]);
});

test("credential updates are saved and close waits for them, then ends the socket", async () => {
  const { wa, emit, authDir, ended } = await setup();
  emit("creds.update", {});
  await wa.close();
  expect(ended()).toBe(1);
  expect(await readdir(authDir)).toContain("creds.json");
});

test("the session directory is 700 and everything in it 600", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "tsuba-wa-")), "whatsapp");
  await prepareSessionDir(dir);
  await writeFile(join(dir, "creds.json"), "{}", { mode: 0o644 });
  await prepareSessionDir(dir);
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  expect((await stat(join(dir, "creds.json"))).mode & 0o777).toBe(0o600);
});
