import { expect, onTestFinished, test } from "bun:test";
import { createCipheriv } from "node:crypto";
import { once } from "node:events";
import { realpath } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { getMediaKeys } from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys";
import type { BaileysLike } from "../adapters/whatsapp-user/src/baileys";
import { bounded, deferred } from "./harness/barriers";
import { setup } from "./whatsapp-user-baileys-harness";
import { text } from "./whatsapp-user-fixtures";

const KEY = new Uint8Array(32);
const BYTES = Buffer.from(
  "synthetic document fixture with several blocks of plaintext",
);

function message(path: string) {
  return text("synthetic-1", "", {
    message: { documentMessage: { mediaKey: KEY, directPath: path } },
  });
}

// Drive the pinned SDK and its real HTTP transport, changing only the outbound
// destination so production CDN filtering and real credentials are untouched.
async function loopback(
  respond: (response: ServerResponse, path: string, encrypted: Buffer) => void,
  refresh?: BaileysLike["updateMediaMessage"],
) {
  const { cipherKey, iv } = await getMediaKeys(KEY, "document");
  const cipher = createCipheriv("aes-256-cbc", cipherKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(BYTES),
    cipher.final(),
    Buffer.alloc(10),
  ]);
  const server = createServer((request, response) =>
    respond(response, request.url ?? "", encrypted),
  );
  onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening", { signal: AbortSignal.timeout(1000) });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test port");

  const sdk = await realpath(
    new URL(
      "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys/lib",
      import.meta.url,
    ),
  );
  const axiosPath = await Bun.resolve("axios", sdk);
  const { default: axios } = await import(axiosPath);
  const original = axios.defaults.adapter;
  const http = axios.getAdapter("http");
  axios.defaults.adapter = (config: { url: string }) =>
    http({
      ...config,
      url: `http://127.0.0.1:${address.port}${new URL(config.url).pathname}`,
      proxy: false,
    });
  onTestFinished(() => {
    axios.defaults.adapter = original;
  });
  return setup(undefined, refresh);
}

test("a CDN disconnect rejects the pending decrypted read", async () => {
  const incoming = deferred<ServerResponse>();
  const { wa } = await loopback((response, _path, bytes) => {
    response.writeHead(200);
    response.write(bytes.subarray(0, 32));
    incoming.resolve(response);
  });
  const caller = new AbortController();
  onTestFinished(() => caller.abort());
  const reader = (
    await wa.downloadMedia(message("/partial"), caller.signal)
  ).getReader();
  expect((await reader.read()).value?.byteLength).toBeGreaterThan(0);

  const pending = reader.read().then(
    () => "resolved",
    () => "rejected",
  );
  (await incoming.promise).destroy();
  expect(
    await bounded(pending, "decryption read fails after CDN disconnect", 1000),
  ).toBe("rejected");
});

test("cancelling the decrypted reader closes the CDN transfer", async () => {
  const closed = deferred<void>();
  const { wa } = await loopback((response, _path, bytes) => {
    response.once("close", () => closed.resolve());
    response.writeHead(200);
    response.write(bytes.subarray(0, 32));
  });
  const caller = new AbortController();
  onTestFinished(() => caller.abort());
  const reader = (
    await wa.downloadMedia(message("/partial"), caller.signal)
  ).getReader();
  expect((await reader.read()).value?.byteLength).toBeGreaterThan(0);

  await reader.cancel();
  await bounded(closed.promise, "CDN transfer closed after cancellation", 1000);
});

test("expired CDN media is retried at the linked device's refreshed location", async () => {
  const { wa } = await loopback(
    (response, path, encrypted) => {
      if (path === "/fresh") response.end(encrypted);
      else response.writeHead(410).end();
    },
    async (expired) => ({
      ...expired,
      message: {
        documentMessage: { directPath: "/fresh", mediaKey: KEY, url: null },
      },
    }),
  );

  const stream = await wa.downloadMedia(
    message("/expired"),
    AbortSignal.timeout(3000),
  );
  expect(Buffer.from(await new Response(stream).arrayBuffer())).toEqual(BYTES);
});
