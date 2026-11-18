import { expect, onTestFinished, test } from "bun:test";
import { proto } from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys";
import { makeEventBuffer } from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys/lib/Utils/event-buffer";
import { CAPABILITIES } from "../adapters/whatsapp-user/src/capabilities";
import { mapMessage } from "../adapters/whatsapp-user/src/mapping";
import { parseSnapshot } from "../adapters/whatsapp-user/src/snapshot";
import { WaStore } from "../adapters/whatsapp-user/src/store";
import { applyStoreEvent } from "../adapters/whatsapp-user/src/store-events";
import type { WaMessageLike } from "../adapters/whatsapp-user/src/types";
import { createHandler } from "../packages/serve-kit/src/index";
import { schema } from "./fixtures";
import { bounded } from "./harness/barriers";
import { setup as setupSocket } from "./whatsapp-user-baileys-harness";
import { GROUP, ROOM, SECONDS, text } from "./whatsapp-user-fixtures";
import { setupCache } from "./whatsapp-user-persistence-harness";

const key = { remoteJid: ROOM, id: "1", fromMe: true };
const outgoing = (extra: Partial<WaMessageLike> = {}) =>
  text("1", "Synthetic outbound", { key, ...extra });

test.each([
  [undefined, undefined],
  [0, undefined],
  [1, undefined],
  [2, "sent"],
  [3, "delivered"],
  [4, "read"],
  [5, "read"],
  [99, undefined],
] as const)("only confirmed SDK status %s maps to %s", (status, expected) => {
  const evidence = status === undefined ? {} : { status };
  expect(mapMessage(outgoing(evidence))?.deliveryStatus).toBe(expected);
  expect(
    mapMessage(text("1", "Incoming", evidence))?.deliveryStatus,
  ).toBeUndefined();
});

test("group receipts mean any observed recipient, with positive read or played timestamps", () => {
  for (const timestamp of ["readTimestamp", "playedTimestamp"] as const) {
    const mapped = mapMessage(
      outgoing({
        key: { ...key, remoteJid: GROUP },
        userReceipt: [
          { userJid: ROOM, receiptTimestamp: SECONDS },
          {
            userJid: "100000000003@s.whatsapp.net",
            [timestamp]: { toNumber: () => SECONDS },
          },
        ],
      }),
    );
    expect(mapped?.deliveryStatus).toBe("read");
    expect(mapped).not.toHaveProperty("userReceipt");
  }
  expect(
    mapMessage(
      outgoing({
        userReceipt: [
          { userJid: ROOM, receiptTimestamp: SECONDS, readTimestamp: 0 },
        ],
      }),
    )?.deliveryStatus,
  ).toBe("delivered");
  expect(
    mapMessage(
      outgoing({
        userReceipt: [
          { userJid: ROOM, readTimestamp: Number.NaN, playedTimestamp: -1 },
        ],
      }),
    )?.deliveryStatus,
  ).toBeUndefined();
});

test("early receipts survive restart and merge monotonically without duplicate upserts", () => {
  const store = new WaStore();
  expect(
    applyStoreEvent(store, { type: "receipt", key, update: { status: 4 } }),
  ).toEqual([]);
  const restored = new WaStore(parseSnapshot(JSON.stringify(store.snapshot())));
  expect(
    applyStoreEvent(restored, {
      type: "messages",
      messages: [outgoing({ status: 1 })],
      live: true,
    }),
  ).toMatchObject([{ event: "message", message: { deliveryStatus: "read" } }]);
  for (const status of [4, 2, 3, 1])
    expect(
      applyStoreEvent(restored, { type: "receipt", key, update: { status } }),
    ).toEqual([]);
  expect(
    applyStoreEvent(restored, {
      type: "messages",
      messages: [outgoing({ status: 2 })],
      live: false,
    }),
  ).toEqual([]);
  expect(restored.page(ROOM, 10).messages[0]?.deliveryStatus).toBe("read");
});

test("receipts do not mark incoming messages or another room and deletion clears early evidence", () => {
  const store = new WaStore();
  store.put(text("1", "Incoming"));
  expect(store.receipt(key, { status: 4 })).toBeNull();
  const groupKey = { ...key, remoteJid: GROUP };
  store.receipt(groupKey, { status: 4 });
  store.remove([groupKey]);
  expect(
    store.put(outgoing({ key: groupKey }))?.deliveryStatus,
  ).toBeUndefined();
  expect(store.page(ROOM, 10).messages[0]?.deliveryStatus).toBeUndefined();
  expect(store.receipt({ remoteJid: ROOM, id: "1" }, { status: 4 })).toBeNull();
  expect(
    store.receipt({ remoteJid: GROUP, id: "3" }, { status: 4 }),
  ).toBeNull();
  store.put(outgoing({ key: groupKey }));
  expect(
    store.receipt({ remoteJid: GROUP, id: "1" }, { status: 3 }),
  ).toMatchObject({ fromMe: true, deliveryStatus: "delivered" });
});

test("socket receipts and buffered history reach HTTP SSE and survive disk restart", async () => {
  const { start } = await setupCache();
  const first = await start();
  const socket = await setupSocket();
  socket.wa.onEvent((event) => {
    if (event.type !== "qr" && event.type !== "open" && event.type !== "close")
      first.link.push(event);
  });
  const handler = createHandler({
    token: "synthetic-receipt-token",
    capabilities: CAPABILITIES,
    backend: first.backend,
  });
  onTestFinished(() => handler.stop());
  const response = await handler.handle(
    new Request("http://synthetic/stream", {
      headers: { authorization: "Bearer synthetic-receipt-token" },
    }),
  );
  expect(response.status).toBe(200);
  if (!response.body) throw new Error("Missing receipt SSE body");
  const reader = response.body.getReader();
  onTestFinished(() => reader.cancel());
  const decoder = new TextDecoder();
  let received = "";
  async function through(
    expectedEvent: "message" | "message.edited",
    id: string,
  ) {
    const messages = [];
    for (;;) {
      const end = received.indexOf("\n\n");
      if (end < 0) {
        const chunk = await bounded(reader.read(), "receipt SSE event");
        if (chunk.done) throw new Error("Receipt stream ended early");
        received += decoder.decode(chunk.value, { stream: true });
        continue;
      }
      const [event, data] = received.slice(0, end).split("\n");
      received = received.slice(end + 2);
      if (!event || !data) throw new Error("Malformed receipt frame");
      const name = event.slice(7);
      if (name !== "message" && name !== "message.edited") continue;
      const payload = JSON.parse(data.slice(6));
      expect(schema("StreamMessage")(payload)).toBe(true);
      messages.push({ event: name, ...payload.message });
      if (name === expectedEvent && payload.message.id === id) return messages;
    }
  }
  const history = (messages: WaMessageLike[]) =>
    socket.emit("messaging-history.set", {
      chats: [],
      contacts: [],
      messages: messages.map((raw) => proto.WebMessageInfo.fromObject(raw)),
    });

  history([outgoing({ status: 1 })]);
  socket.emit("messages.upsert", {
    type: "notify",
    messages: [proto.WebMessageInfo.fromObject(text("2", "Live barrier"))],
  });
  expect((await through("message", "2")).map((message) => message.id)).toEqual([
    "2",
  ]);

  socket.emit("messages.update", [{ key, update: { status: 2 } }]);
  expect(await through("message.edited", "1")).toMatchObject([
    {
      event: "message.edited",
      id: "1",
      text: "Synthetic outbound",
      deliveryStatus: "sent",
    },
  ]);
  socket.emit("message-receipt.update", [
    {
      key,
      receipt: { userJid: ROOM, receiptTimestamp: SECONDS },
    },
  ]);
  expect(await through("message.edited", "1")).toMatchObject([
    { event: "message.edited", id: "1", deliveryStatus: "delivered" },
  ]);

  // The SDK can absorb messages.update into history, leaving no separate receipt event.
  const logger = socket.config().logger;
  if (!logger) throw new Error("Missing socket logger");
  const buffer = makeEventBuffer(logger);
  buffer.on("messaging-history.set", (data) =>
    socket.emit("messaging-history.set", data),
  );
  buffer.on("messages.update", (data) => socket.emit("messages.update", data));
  buffer.buffer();
  buffer.emit("messaging-history.set", {
    chats: [],
    contacts: [],
    messages: [proto.WebMessageInfo.fromObject(outgoing({ status: 2 }))],
  });
  buffer.emit("messages.update", [{ key, update: { status: 4 } }]);
  buffer.flush();
  expect(await through("message.edited", "1")).toMatchObject([
    { event: "message.edited", id: "1", deliveryStatus: "read" },
  ]);

  const groupKey = { ...key, remoteJid: GROUP, id: "3" };
  history([
    text(
      "3",
      "Synthetic group",
      {
        key: groupKey,
        userReceipt: [{ userJid: ROOM, readTimestamp: SECONDS }],
      },
      GROUP,
    ),
  ]);
  socket.emit("messages.update", [{ key, update: { status: 2 } }]);
  socket.emit("message-receipt.update", [
    { key, receipt: { userJid: ROOM, readTimestamp: SECONDS } },
  ]);
  history([outgoing({ status: 1 })]);
  socket.emit("messages.upsert", {
    type: "notify",
    messages: [proto.WebMessageInfo.fromObject(text("4", "Final barrier"))],
  });
  expect((await through("message", "4")).map((message) => message.id)).toEqual([
    "4",
  ]);
  await first.cache.flush();
  const restarted = await start();
  expect(await restarted.get(`/messages?roomId=${ROOM}`)).toMatchObject({
    messages: [{ id: "1", deliveryStatus: "read" }, { id: "2" }, { id: "4" }],
  });
  expect(await restarted.get(`/messages?roomId=${GROUP}`)).toMatchObject({
    messages: [{ id: "3", deliveryStatus: "read" }],
  });
});
