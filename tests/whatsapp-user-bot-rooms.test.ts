import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  decodeMessageNode,
  proto,
} from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys";
import { whatsappUserBackend } from "../adapters/whatsapp-user/src/backend";
import { CAPABILITIES } from "../adapters/whatsapp-user/src/capabilities";
import { openWaStore } from "../adapters/whatsapp-user/src/persistence";
import { connectWhatsApp } from "../adapters/whatsapp-user/src/session";
import { WaStore } from "../adapters/whatsapp-user/src/store";
import { createHandler } from "../packages/serve-kit/src/index";
import { setup } from "./whatsapp-user-baileys-harness";
import { GROUP, ROOM, SECONDS } from "./whatsapp-user-fixtures";

const BOT = "900001@bot";
const OTHER = "900002@bot";
const SELF = "99001:1@s.whatsapp.net";
const DEVICE = "99001:2@s.whatsapp.net";
const LID = "99002@lid";
const token = "synthetic-adapter-token";

function handler(link: ReturnType<typeof connectWhatsApp>, store: WaStore) {
  return createHandler({
    token,
    capabilities: CAPABILITIES,
    backend: whatsappUserBackend(link, { store }),
  }).handle;
}

async function fixture() {
  let lookup: WaStore | undefined;
  const sdk = await setup(undefined, undefined, (room, id) =>
    lookup?.findOutbound(room, id),
  );
  const link = connectWhatsApp({
    open: () => sdk.wa,
    schedule: () => () => {},
  });
  const store = new WaStore();
  sdk.config().auth.creds.me = { id: SELF, lid: LID };
  lookup = store;
  return {
    ...sdk,
    link,
    store,
    handle: handler(link, store),
    load(next: WaStore) {
      lookup = next;
    },
  };
}

function request(path: string, body?: object) {
  return new Request(`http://adapter${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
}

test("a bot ciphertext stanza lists a read-only room without fabricating history", async () => {
  const { handle, ws, link, config, emit } = await fixture();
  emit("connection.update", { connection: "open" });
  const diagnostics: unknown[] = [];
  link.subscribe((event) => {
    if (event.type === "botDiagnostic") diagnostics.push(event);
  });
  const stanza = {
    tag: "message",
    attrs: { from: BOT, id: "encrypted", t: `${SECONDS}` },
    content: [
      {
        tag: "enc",
        attrs: { type: "msmsg" },
        content: Uint8Array.of(1, 2, 3),
      },
    ],
  };
  ws.emit("CB:message", stanza);
  ws.emit("CB:message", stanza);
  ws.emit("CB:message", {
    ...stanza,
    attrs: { ...stanza.attrs, from: "900001:1@bot" },
  });
  config().onBotCiphertextRoom("invalid@bot");

  expect(await (await handle(request("/rooms"))).json()).toMatchObject({
    rooms: [
      {
        id: BOT,
        title: "Meta AI bot",
        kind: "direct",
        features: {
          "messages.send": false,
          "messages.reply": false,
          "attachments.send": false,
        },
      },
    ],
    complete: false,
  });
  expect(
    await (await handle(request(`/messages?roomId=${BOT}`))).json(),
  ).toMatchObject({ messages: [], hasEarlier: false });
  expect(
    await (
      await handle(request("/send", { roomId: BOT, text: "blocked" }))
    ).json(),
  ).toMatchObject({ ok: false, error: { code: "NOT_SUPPORTED" } });
  const upload = new FormData();
  upload.set("roomId", BOT);
  upload.set(
    "file",
    new File(["synthetic"], "test.txt", { type: "text/plain" }),
  );
  const responses = await Promise.all([
    handle(
      request("/send", { roomId: BOT, text: "blocked", replyTo: "encrypted" }),
    ),
    handle(
      new Request("http://adapter/upload", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: upload,
      }),
    ),
  ]);
  expect(responses.map((response) => response.status)).toEqual([501, 501]);
  config().onBotReceiveDiagnostic({ reason: "missing-secret", room: BOT });
  config().onBotReceiveDiagnostic("missing-secret");
  expect(diagnostics).toEqual([
    { type: "botDiagnostic", reason: "msmsg-seen" },
    { type: "botDiagnostic", reason: "missing-secret" },
  ]);
});

test("decoded bot history keeps its own title and excludes view-once and human alias data after restore", async () => {
  const { emit, link, store } = await fixture();
  emit("messaging-history.set", {
    chats: [{ id: ROOM, name: "Human" }, { id: LID }],
    contacts: [
      { id: BOT, jid: ROOM, lid: LID, verifiedName: "Synthetic Muse" },
    ],
    messages: [
      proto.WebMessageInfo.create({
        key: { remoteJid: BOT, fromMe: false, id: "reply" },
        message: { conversation: "Decoded reply" },
        messageTimestamp: SECONDS,
      }),
      proto.WebMessageInfo.create({
        key: { remoteJid: BOT, fromMe: false, id: "hidden" },
        message: { viewOnceMessageV2: { message: { conversation: "Hidden" } } },
        messageTimestamp: SECONDS + 1,
      }),
    ],
  });
  emit("chats.phoneNumberShare", { lid: LID, jid: OTHER });

  const handle = handler(link, new WaStore(store.snapshot()));
  const rooms = await (await handle(request("/rooms"))).json();
  expect(rooms).toMatchObject({
    rooms: expect.arrayContaining([
      expect.objectContaining({ id: BOT, title: "Synthetic Muse" }),
      expect.objectContaining({ id: ROOM, title: "Human" }),
      expect.objectContaining({ id: LID, title: "99002" }),
    ]),
  });
  expect(
    await (await handle(request(`/messages?roomId=${BOT}`))).json(),
  ).toMatchObject({ messages: [{ id: "reply", text: "Decoded reply" }] });
  expect(
    await (await handle(request(`/messages?roomId=${ROOM}`))).json(),
  ).toMatchObject({ messages: [] });
});

test("only own bot copies are routed away from the SDK's self chat", async () => {
  const { emit, handle, ws } = await fixture();
  const stanza = {
    tag: "message",
    attrs: { from: DEVICE, recipient: BOT, id: "copy", t: `${SECONDS}` },
  };
  const decoded = decodeMessageNode(stanza, SELF, LID).fullMessage;
  ws.emit("CB:message", stanza);
  ws.emit("CB:message", {
    ...stanza,
    attrs: { ...stanza.attrs, from: ROOM, recipient: OTHER, id: "human" },
  });
  emit("messages.upsert", {
    type: "append",
    messages: [
      { ...decoded, message: { conversation: "Own decoded copy" } },
      proto.WebMessageInfo.create({
        key: { remoteJid: GROUP, fromMe: true, id: "group" },
        message: { conversation: "Group text" },
        messageTimestamp: SECONDS + 2,
      }),
    ],
  });

  expect(
    await (await handle(request(`/messages?roomId=${BOT}`))).json(),
  ).toMatchObject({
    messages: [{ id: "copy", fromMe: true, text: "Own decoded copy" }],
  });
  expect(
    await (await handle(request(`/messages?roomId=${DEVICE}`))).json(),
  ).toMatchObject({ messages: [] });
  expect(
    await (await handle(request(`/messages?roomId=${GROUP}`))).json(),
  ).toMatchObject({ messages: [{ id: "group", text: "Group text" }] });
  const rooms = await (await handle(request("/rooms"))).json();
  expect(rooms).toMatchObject({ rooms: [{ id: GROUP }, { id: BOT }] });
});

test("the ciphertext callback alone discovers a room but never creates a message", async () => {
  const { config, handle } = await fixture();
  config().onBotCiphertextRoom(OTHER);
  expect(await (await handle(request("/rooms"))).json()).toMatchObject({
    rooms: [{ id: OTHER, title: "Meta AI bot" }],
  });
  expect(
    await (await handle(request(`/messages?roomId=${OTHER}`))).json(),
  ).toMatchObject({ messages: [] });
});

test("phone prompts retain the original secret for exact outbound lookup after disk reload", async () => {
  const { authDir, config, emit, link, load } = await fixture();
  const path = join(authDir, "store.json");
  const cache = await openWaStore(path, () => {
    throw new Error("cache save failed");
  });
  handler(link, cache.store);
  const messageSecret = new Uint8Array(32).fill(7);
  const prompt = proto.Message.create({
    botInvokeMessage: { message: { conversation: "Private fixture" } },
    messageContextInfo: { messageSecret },
  });
  emit("messages.upsert", {
    type: "notify",
    messages: [
      proto.WebMessageInfo.create({
        key: { remoteJid: LID, id: "prompt", fromMe: true },
        message: {
          deviceSentMessage: { destinationJid: BOT, message: prompt },
        },
        messageTimestamp: SECONDS,
      }),
      proto.WebMessageInfo.create({
        key: { remoteJid: BOT, id: "incoming", fromMe: false },
        message: prompt,
        messageTimestamp: SECONDS,
      }),
    ],
  });
  cache.save();
  await cache.flush();
  const restored = await openWaStore(path, () => {
    throw new Error("cache save failed");
  });
  load(restored.store);
  const get = config().getMessage;
  if (!get) throw new Error("Missing SDK lookup");
  expect(
    await get({ remoteJid: BOT, id: "prompt", fromMe: true }),
  ).toMatchObject({
    botInvokeMessage: { message: { conversation: "Private fixture" } },
    messageContextInfo: { messageSecret },
  });
  expect(
    await Promise.all([
      get({ remoteJid: OTHER, id: "prompt", fromMe: true }),
      get({ remoteJid: LID, id: "prompt", fromMe: true }),
      get({ remoteJid: BOT, id: "prompt", fromMe: false }),
      get({ remoteJid: BOT, id: "prompt" }),
      get({ remoteJid: BOT, id: "incoming", fromMe: true }),
    ]),
  ).toEqual([undefined, undefined, undefined, undefined, undefined]);
  expect(
    await (
      await handler(link, restored.store)(request(`/messages?roomId=${BOT}`))
    ).json(),
  ).toMatchObject({ messages: [] });
});

test("only a WASA-shaped outbound envelope emits a WASA observation, with no visible body", async () => {
  const { config, emit, handle, link } = await fixture();
  const diagnostics: unknown[] = [];
  link.subscribe((event) => {
    if (event.type === "botDiagnostic") diagnostics.push(event);
  });
  config().onBotReceiveDiagnostic("missing-secret");
  const copy = proto.WebMessageInfo.create({
    key: { remoteJid: BOT, id: "wasa", fromMe: true },
    message: {
      secretEncryptedMessage: {
        targetMessageKey: { remoteJid: BOT, id: "root", fromMe: true },
        encIv: new Uint8Array(12),
        encPayload: new Uint8Array(17),
      },
    },
    messageTimestamp: SECONDS,
  });
  emit("messages.upsert", { type: "append", messages: [copy, copy] });
  expect(diagnostics).toEqual([
    { type: "botDiagnostic", reason: "missing-secret" },
    { type: "botDiagnostic", reason: "wasa-envelope" },
  ]);
  expect(await (await handle(request("/rooms"))).json()).toMatchObject({
    rooms: [{ id: BOT }],
  });
  expect(
    await (await handle(request(`/messages?roomId=${BOT}`))).json(),
  ).toMatchObject({ messages: [] });
});
