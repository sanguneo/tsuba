import { serve } from "@tsuba/serve-kit";
import iconPath from "../icon.svg" with { type: "file" };
import { memoBackend } from "./backend";
import { CAPABILITIES } from "./capabilities";

const token = process.env.TSUBA_MEMO_HTTP_TOKEN ?? process.env.TSUBA_TOKEN;
if (!token) throw new Error("TSUBA_MEMO_HTTP_TOKEN or TSUBA_TOKEN is not set");

const server = serve({
  token,
  port: Number(process.env.TSUBA_MEMO_PORT ?? 8799),
  hostname: process.env.TSUBA_HOST ?? "127.0.0.1",
  icon: {
    bytes: new Uint8Array(await Bun.file(iconPath).arrayBuffer()),
    type: "image/svg+xml",
  },
  capabilities: CAPABILITIES,
  backend: memoBackend(),
});
console.log(`tsuba-memo listening on ${server.hostname}:${server.port}`);

await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
await server.stop(true);
