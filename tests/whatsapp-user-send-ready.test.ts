import { expect, onTestFinished, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proto } from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys";
import { whatsappUserBackend } from "../adapters/whatsapp-user/src/backend";
import { openBaileys } from "../adapters/whatsapp-user/src/baileys";
import { CAPABILITIES } from "../adapters/whatsapp-user/src/capabilities";
import { connectWhatsApp } from "../adapters/whatsapp-user/src/session";
import { createHandler } from "../packages/serve-kit/src/index";
import { bounded, deferred } from "./harness/barriers";
import { TARGET_LID } from "./whatsapp-user-send-harness";

test("/send refuses a LID write before calling the SDK when own LID has not arrived", async () => {
  const authDir = await mkdtemp(join(tmpdir(), "tsuba-wa-ready-"));
  const ready = deferred<void>();
  const events = new EventEmitter();
  let sends = 0;
  const link = connectWhatsApp({
    schedule: () => () => {},
    open: () =>
      openBaileys({
        authDir,
        makeSocket() {
          ready.resolve();
          return {
            ev: {
              on(event, handler) {
                events.on(event, handler);
              },
            },
            profilePictureUrl: async () => undefined,
            groupFetchAllParticipating: async () => ({}),
            updateMediaMessage: async () => {
              throw new Error("Unexpected media refresh");
            },
            async sendMessage() {
              sends++;
              return proto.WebMessageInfo.fromObject({
                key: { remoteJid: TARGET_LID, id: "9000", fromMe: true },
                message: { conversation: "synthetic" },
                messageTimestamp: 1,
              });
            },
            end() {},
          };
        },
      }),
  });
  onTestFinished(async () => {
    await link.stop();
    await rm(authDir, { recursive: true, force: true });
  });
  await bounded(ready.promise, "socket configured");
  events.emit("connection.update", { connection: "open" });
  const { handle } = createHandler({
    token: "synthetic-ready-token",
    capabilities: CAPABILITIES,
    backend: whatsappUserBackend(link),
  });
  const response = await handle(
    new Request("http://synthetic/send", {
      method: "POST",
      headers: {
        authorization: "Bearer synthetic-ready-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ roomId: TARGET_LID, text: "synthetic" }),
    }),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: "BUSY" } });
  expect(sends).toBe(0);
});
