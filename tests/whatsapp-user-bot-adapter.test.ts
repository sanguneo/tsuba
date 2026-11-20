import { expect, onTestFinished, test } from "bun:test";
import { join } from "node:path";
import {
  DirectBotSendUnavailableError,
  proto,
} from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys";
import { whatsappUserBackend } from "../adapters/whatsapp-user/src/backend";
import { CAPABILITIES } from "../adapters/whatsapp-user/src/capabilities";
import { openWaStore } from "../adapters/whatsapp-user/src/persistence";
import { connectWhatsApp } from "../adapters/whatsapp-user/src/session";
import { createHandler } from "../packages/serve-kit/src/index";
import { bounded, deferred } from "./harness/barriers";
import { setup } from "./whatsapp-user-baileys-harness";
import { SECONDS } from "./whatsapp-user-fixtures";

const BOT = "900010@bot";
const OTHER = "900011@bot";
const TOKEN = "synthetic-direct-bot-adapter";
const UNAVAILABLE = {
  code: "NOT_SUPPORTED",
  message: "WhatsApp direct bot text sending is unavailable; nothing was sent",
};

async function fixture() {
  let lookup: Awaited<ReturnType<typeof openWaStore>> | undefined;
  const sdk = await setup(undefined, undefined, (room, id) =>
    lookup?.store.findOutbound(room, id),
  );
  const storePath = join(sdk.authDir, "bot-store.json");
  const loadStore = () =>
    openWaStore(storePath, () => {
      throw new Error("Synthetic store write failed");
    });
  const cache = await loadStore();
  lookup = cache;
  const link = connectWhatsApp({
    open: () => sdk.wa,
    schedule: () => () => {},
  });
  onTestFinished(() => link.stop());
  const { handle } = createHandler({
    token: TOKEN,
    capabilities: CAPABILITIES,
    backend: whatsappUserBackend(link, {
      store: cache.store,
      changed: cache.save,
    }),
  });
  sdk.emit("connection.update", { connection: "open" });
  sdk.emit("chats.upsert", [{ id: BOT }, { id: OTHER }]);
  await cache.flush();

  return {
    ...sdk,
    fetch(route: string, body?: FormData | Record<string, string>) {
      const headers = new Headers({ authorization: `Bearer ${TOKEN}` });
      if (body && !(body instanceof FormData))
        headers.set("content-type", "application/json");
      return handle(
        new Request(`http://adapter${route}`, {
          headers,
          ...(body && {
            method: "POST",
            body: body instanceof FormData ? body : JSON.stringify(body),
          }),
        }),
      );
    },
    async reopenStore() {
      await cache.flush();
      lookup = await loadStore();
    },
  };
}

test("an eligible bot accepts plain text and its original prompt becomes readable and reloadable", async () => {
  const adapter = await fixture();
  const started = deferred<void>();
  const accepted = deferred<void>();
  const secret = new Uint8Array(32).fill(9);
  const body = "Synthetic bot prompt";
  const id = "accepted-prompt";
  adapter.directBot.canSendDirectBotText = async (jid) => jid === BOT;
  adapter.directBot.sendDirectBotText = async (jid, text) => {
    started.resolve();
    await accepted.promise;
    return proto.WebMessageInfo.create({
      key: { remoteJid: jid, id, fromMe: true },
      message: {
        conversation: text,
        messageContextInfo: { messageSecret: secret },
      },
      messageTimestamp: SECONDS,
      status: proto.WebMessageInfo.Status.SERVER_ACK,
    });
  };

  const rooms = await (await adapter.fetch("/rooms")).json();
  expect(rooms).toMatchObject({
    rooms: [
      {
        id: BOT,
        features: { "messages.reply": false, "attachments.send": false },
      },
      { id: OTHER, features: { "messages.send": false } },
    ],
  });
  expect(rooms).toMatchObject({
    rooms: [
      { features: expect.not.objectContaining({ "messages.send": false }) },
      { id: OTHER },
    ],
  });

  const sending = adapter.fetch("/send", { roomId: BOT, text: body });
  try {
    await bounded(started.promise, "direct bot send started");
    expect(
      await (await adapter.fetch(`/messages?roomId=${BOT}`)).json(),
    ).toMatchObject({
      messages: [],
    });
  } finally {
    accepted.resolve();
  }
  const sent = await sending;
  expect(sent.status).toBe(200);
  expect(await sent.json()).toMatchObject({
    message: {
      id,
      roomId: BOT,
      text: body,
      fromMe: true,
      deliveryStatus: "sent",
    },
  });
  expect(
    await (await adapter.fetch(`/messages?roomId=${BOT}`)).json(),
  ).toMatchObject({
    messages: [{ id, text: body, fromMe: true }],
  });

  await adapter.reopenStore();
  const getMessage = adapter.config().getMessage;
  if (!getMessage) throw new Error("Missing SDK prompt lookup");
  const recovered = await getMessage({ remoteJid: BOT, id, fromMe: true });
  expect(recovered?.messageContextInfo?.messageSecret).toEqual(secret);
  expect(
    await getMessage({ remoteJid: OTHER, id, fromMe: true }),
  ).toBeUndefined();
});

test.each([
  { readiness: false, submit: false, status: 501, error: UNAVAILABLE },
  { readiness: true, submit: true, status: 501, error: UNAVAILABLE },
  { readiness: true, submit: true, status: 500, error: { code: "INTERNAL" } },
] as const)(
  "direct bot errors return $status without writing history (ready=$readiness)",
  async ({ readiness, submit, status, error }) => {
    const adapter = await fixture();
    let sends = 0;
    adapter.directBot.canSendDirectBotText = async () => readiness;
    adapter.directBot.sendDirectBotText = async () => {
      sends++;
      if (status === 501) throw new DirectBotSendUnavailableError();
      throw new Error("synthetic sensitive SDK failure");
    };

    const response = await adapter.fetch("/send", {
      roomId: BOT,
      text: "No history",
    });
    expect(response.status).toBe(status);
    const result = await response.json();
    expect(result).toMatchObject({ ok: false, error });
    expect(JSON.stringify(result)).not.toContain(
      "synthetic sensitive SDK failure",
    );
    expect(sends).toBe(submit ? 1 : 0);
    expect(adapter.calls).toEqual([]);
    expect(
      await (await adapter.fetch(`/messages?roomId=${BOT}`)).json(),
    ).toMatchObject({
      messages: [],
    });
  },
);

test("a text-enabled bot rejects both quoted messages and uploads before sending", async () => {
  const adapter = await fixture();
  let sends = 0;
  adapter.directBot.canSendDirectBotText = async () => true;
  adapter.directBot.sendDirectBotText = async () => {
    sends++;
    throw new Error("Unexpected direct bot send");
  };
  const upload = new FormData();
  upload.set("roomId", BOT);
  upload.set(
    "file",
    new File(["synthetic"], "test.txt", { type: "text/plain" }),
  );

  const responses = await Promise.all([
    adapter.fetch("/send", {
      roomId: BOT,
      text: "No quote",
      replyTo: "previous",
    }),
    adapter.fetch("/upload", upload),
  ]);
  expect(responses.map(({ status }) => status)).toEqual([501, 501]);
  expect(sends).toBe(0);
  expect(adapter.calls).toEqual([]);
});
