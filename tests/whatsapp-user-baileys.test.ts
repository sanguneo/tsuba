import { expect, test } from "bun:test";
import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proto } from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys";
import {
  type BaileysLike,
  prepareSessionDir,
} from "../adapters/whatsapp-user/src/baileys";
import { WaStore } from "../adapters/whatsapp-user/src/store";
import { applyStoreEvent } from "../adapters/whatsapp-user/src/store-events";
import { bounded, deferred } from "./harness/barriers";
import { setup } from "./whatsapp-user-baileys-harness";
import { GROUP, ROOM, text } from "./whatsapp-user-fixtures";

test("the connection requests history without presence or library logging", async () => {
  const { config } = await setup();
  expect(config()).toMatchObject({
    markOnlineOnConnect: false,
    syncFullHistory: true,
    generateHighQualityLinkPreview: false,
  });
  const logger = config().logger;
  expect(logger?.level).toBe("silent");
  expect(logger?.info({})).toBeUndefined();
});

test("room picture lookup uses the SDK preview query with a three second deadline", async () => {
  const { wa, pictures } = await setup();
  await wa.profilePictureUrl(ROOM);
  await wa.profilePictureUrl("100000000002-1700000000@g.us");
  expect(pictures).toEqual([
    { jid: ROOM, type: "preview", timeout: 3_000 },
    { jid: "100000000002-1700000000@g.us", type: "preview", timeout: 3_000 },
  ]);
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
    { type: "groupSyncStarted" },
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
    names: [
      { id: ROOM, notify: "Pushed name" },
      { id: "100000000009@s.whatsapp.net" },
    ],
  });
  expect(events[2]).toMatchObject({ live: false });
  expect(events[3]).toMatchObject({ chats: [{ id: ROOM, unreadCount: 3 }] });
  expect(events[5]).toMatchObject({ live: true });
  expect(events[6]).toMatchObject({ live: false });
});

test("only the final FULL chunk signals history completion, after its data", async () => {
  const { events, emit } = await setup();
  // Wire syncType values: INITIAL_BOOTSTRAP=0, FULL=2, RECENT=3, ON_DEMAND=6.
  for (const [syncType, progress] of [
    [0, 100],
    [3, 100],
    [6, 100],
    [2, 50],
    [2, 100],
  ] as const)
    emit("messaging-history.set", {
      chats: [],
      contacts: [],
      messages: [],
      isLatest: true,
      syncType,
      progress,
    });
  expect(events.filter(({ type }) => type === "historySyncComplete")).toEqual([
    { type: "historySyncComplete" },
  ]);
  expect(events.slice(-4).map(({ type }) => type)).toEqual([
    "chats",
    "names",
    "messages",
    "historySyncComplete",
  ]);
});

test("queried groups arrive before the count even when groups.update is buffered", async () => {
  const fetched =
    deferred<Awaited<ReturnType<BaileysLike["groupFetchAllParticipating"]>>>();
  const { wa, events, emit } = await setup(() => fetched.promise);
  const complete = deferred<void>();
  wa.onEvent((event) => {
    events.push(event);
    if (event.type === "groupSyncComplete") complete.resolve();
  });
  emit("connection.update", { connection: "open" });
  fetched.resolve({
    [GROUP]: {
      id: GROUP,
      subject: "Fetched group",
      addressingMode: "pn",
      owner: undefined,
      participants: [],
    },
  });
  await bounded(complete.promise, "group query");
  expect(events.slice(-2)).toMatchObject([
    { type: "groups", groups: [{ id: GROUP, subject: "Fetched group" }] },
    { type: "groupSyncComplete", count: 1 },
  ]);
});

test("edits and revokes retain their keys; incoming receipt updates are ignored", async () => {
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
    { key: { ...key, fromMe: false }, update: { status: 3 } },
  ]);
  emit("messages.delete", { keys: [key] });
  emit("messages.delete", { jid: ROOM, all: true });
  expect(events).toEqual([
    { type: "edit", key, content: { conversation: "after" }, at: 5 },
    { type: "delete", keys: [key] },
    { type: "delete", keys: [key] },
  ]);
});

const BOT_ROOM = "900001@bot";
const OTHER_BOT_ROOM = "900002@bot";
const botKey = { remoteJid: BOT_ROOM, id: "bot-reply", fromMe: false };

function richResponse(...texts: string[]): proto.IMessage {
  return {
    richResponseMessage: {
      unifiedResponse: {
        data: Buffer.from(
          JSON.stringify({
            sections: [
              { view_model: { primitive: { text: 42 } } },
              ...texts.map((text) => ({ view_model: { primitive: { text } } })),
              { view_model: {} },
            ],
          }),
        ),
      },
    },
  };
}

test.each(["protocol", "update", "both", "folded"] as const)(
  "a rich reply and %s edit keep the target ID through store and restore",
  async (shape) => {
    const { wa, emit } = await setup();
    const store = new WaStore();
    const updates: ReturnType<typeof applyStoreEvent> = [];
    wa.onEvent((event) => {
      if (event.type === "messages" || event.type === "edit")
        updates.push(...applyStoreEvent(store, event));
    });
    const upsert = (key: typeof botKey, message: proto.IMessage, at: number) =>
      emit("messages.upsert", {
        type: "notify",
        messages: [{ key, message, messageTimestamp: at }],
      });
    upsert(botKey, richResponse("First", " ", "Second"), 10);
    const editedMessage = richResponse("Edited");
    if (shape === "protocol" || shape === "both")
      upsert(
        { ...botKey, id: "edit-stanza" },
        {
          protocolMessage: {
            type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
            // Target address and direction are from the peer's perspective.
            key: { fromMe: true, id: botKey.id },
            editedMessage,
            timestampMs: 12_500,
          },
        },
        13,
      );
    if (shape === "update" || shape === "both")
      emit("messages.update", [
        {
          key: botKey,
          update: {
            message: { editedMessage: { message: editedMessage } },
            messageTimestamp: 12,
          },
        },
      ]);
    if (shape === "folded")
      upsert(botKey, { editedMessage: { message: editedMessage } }, 12);
    expect(updates).toMatchObject([
      {
        event: "message",
        message: { id: botKey.id, senderId: BOT_ROOM, text: "First\nSecond" },
      },
      { event: "message.edited", message: { id: botKey.id, text: "Edited" } },
    ]);
    expect(
      new WaStore(store.snapshot()).page(BOT_ROOM, 10).messages,
    ).toMatchObject([
      {
        id: botKey.id,
        text: "Edited",
        sentAt: "1970-01-01T00:00:10.000Z",
        editedAt: "1970-01-01T00:00:12.000Z",
      },
    ]);
    expect(store.page(OTHER_BOT_ROOM, 10).messages).toEqual([]);
  },
);

test("rich edits cannot target an outgoing message or leave their enclosing room", async () => {
  const { wa, emit } = await setup();
  const store = new WaStore();
  wa.onEvent((event) => {
    if (event.type === "messages" || event.type === "edit")
      applyStoreEvent(store, event);
  });
  const promptKey = { ...botKey, id: "prompt", fromMe: true };
  const editedMessage = richResponse("Not permitted");
  emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: promptKey,
        message: { conversation: "Prompt" },
        messageTimestamp: 10,
      },
      { key: botKey, message: { conversation: "Reply" }, messageTimestamp: 10 },
      {
        key: { ...botKey, remoteJid: OTHER_BOT_ROOM, id: "edit-stanza" },
        message: {
          protocolMessage: {
            type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
            key: botKey,
            editedMessage,
          },
        },
        messageTimestamp: 11,
      },
    ],
  });
  emit("messages.update", [
    {
      key: { ...promptKey, fromMe: false },
      update: { message: { editedMessage: { message: editedMessage } } },
    },
    {
      key: { ...botKey, participant: OTHER_BOT_ROOM },
      update: { message: { editedMessage: { message: editedMessage } } },
    },
  ]);
  expect(store.page(BOT_ROOM, 10).messages.map(({ text }) => text)).toEqual([
    "Prompt",
    "Reply",
  ]);
  expect(store.page(OTHER_BOT_ROOM, 10).messages).toEqual([]);
});

test("textless bot frames are silent and malformed rich JSON reports only a fixed reason", async () => {
  const { wa, emit } = await setup();
  const store = new WaStore();
  const diagnostics: unknown[] = [];
  wa.onEvent((event) => {
    if (event.type === "messages" || event.type === "edit")
      applyStoreEvent(store, event);
    if (event.type === "botDiagnostic") diagnostics.push(event);
  });
  const malformed = {
    richResponseMessage: {
      unifiedResponse: { data: Buffer.from("{invalid synthetic payload") },
    },
  };
  emit("messages.upsert", {
    type: "notify",
    messages: [
      { key: botKey, message: { conversation: "Keep" }, messageTimestamp: 10 },
      ...[
        richResponse(" "),
        // AI_METADATA_OPERATION (35) is newer than the pinned enum.
        { protocolMessage: { type: 35, aiMetadataOperation: {} } },
        malformed,
      ].map((message, index) => ({
        key: { ...botKey, id: `frame-${index}` },
        message,
        messageTimestamp: 11,
      })),
    ],
  });
  emit("messages.update", [
    {
      key: botKey,
      update: { message: { editedMessage: { message: malformed } } },
    },
  ]);
  expect(diagnostics).toEqual([
    { type: "botDiagnostic", reason: "malformed-rich-response" },
  ]);
  expect(store.page(BOT_ROOM, 10).messages.map(({ text }) => text)).toEqual([
    "Keep",
  ]);
});

test("sendText sends plain text, quotes the held message, and returns the sent one", async () => {
  const { wa, calls, ws, sent: relay } = await setup();
  relay.on("send", (id: string) =>
    ws.emit("CB:ack,class:message", { attrs: { id } }),
  );
  const quoted = text("1", "q");
  const sent = await wa.sendText(ROOM, "hello", quoted);
  expect(sent?.key.id).toBeTruthy();
  expect(sent?.status).toBe(2);
  await wa.sendText(ROOM, "again");
  expect(calls).toEqual([
    {
      jid: ROOM,
      content: { text: "hello" },
      options: { quoted, messageId: sent?.key.id },
    },
    {
      jid: ROOM,
      content: { text: "again" },
      options: { messageId: expect.any(String) },
    },
  ]);
});

test("a local relay or unrelated ACK cannot succeed; a matching error ACK returns unknown without resending", async () => {
  const { wa, ws, sent, calls } = await setup();
  const relayed = deferred<string>();
  sent.once("send", (id: string) => relayed.resolve(id));
  const outcome = wa.sendText(ROOM, "synthetic").then(
    () => "accepted",
    (error: unknown) => error,
  );
  const id = await bounded(relayed.promise, "local relay");
  ws.emit("CB:ack,class:message", { attrs: { id: "unrelated" } });
  const pending = Symbol("pending");
  expect(await Promise.race([outcome, Promise.resolve(pending)])).toBe(pending);
  ws.emit("CB:ack,class:message", { attrs: { id, error: "synthetic" } });
  expect(await bounded(outcome, "negative ACK outcome")).toMatchObject({
    code: "INTERNAL",
  });
  expect(calls).toHaveLength(1);
  expect(ws.listenerCount("CB:ack,class:message")).toBe(0);
});

test("disconnect after media relay without ACK leaves the outcome unknown", async () => {
  const { wa, sent, calls, emit, ws } = await setup();
  const relayed = deferred<void>();
  sent.once("send", () => relayed.resolve());
  const outcome = wa
    .sendMedia(ROOM, {
      name: "synthetic.png",
      type: "image/png",
      bytes: new Uint8Array([1, 2]),
    })
    .then(
      () => "accepted",
      (error: unknown) => error,
    );
  await bounded(relayed.promise, "local media relay");
  emit("connection.update", { connection: "close" });
  expect(await bounded(outcome, "disconnect outcome")).toMatchObject({
    code: "INTERNAL",
  });
  expect(calls).toHaveLength(1);
  expect(ws.listenerCount("CB:ack,class:message")).toBe(0);
});

test("the SDK can recover the exact retained outgoing message on recipient retry", async () => {
  const { config } = await setup(undefined, undefined, (room, id) =>
    room === ROOM && id === "out"
      ? text(id, "synthetic outgoing", {
          key: { remoteJid: room, id, fromMe: true },
        })
      : room === ROOM && id === "in"
        ? text(id, "synthetic incoming")
        : undefined,
  );
  const get = config().getMessage;
  expect(
    await get?.({ remoteJid: ROOM, id: "out", fromMe: true }),
  ).toMatchObject({ conversation: "synthetic outgoing" });
  expect(
    await get?.({ remoteJid: GROUP, id: "out", fromMe: true }),
  ).toBeUndefined();
  expect(
    await get?.({ remoteJid: ROOM, id: "in", fromMe: true }),
  ).toBeUndefined();
  expect(
    await get?.({ remoteJid: ROOM, id: "out", fromMe: false }),
  ).toBeUndefined();
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
