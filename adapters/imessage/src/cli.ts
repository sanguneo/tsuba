import { serve } from "@tsuba/serve-kit";
import iconPath from "../icon.svg" with { type: "file" };
import { imessageBackend } from "./backend";
import { capabilities } from "./capabilities";

/**
 * The Mac's own Messages account, read and sent through the third-party `imsg`
 * CLI, which needs Full Disk Access (docs/imessage.md). Output is counts only:
 * no chat titles, handles or message text are printed, because this runs
 * against a real account.
 *
 *   bun adapters/imessage/src/cli.ts check
 *   bun adapters/imessage/src/cli.ts serve
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; see docs/imessage.md`);
  return value;
}

const [command] = process.argv.slice(2);

if (command === "check") {
  const rooms = (await imessageBackend().listRooms?.())?.rooms ?? [];
  console.log("rooms:", rooms.length);
} else if (command === "serve") {
  const server = serve({
    token: process.env.TSUBA_IMESSAGE_HTTP_TOKEN ?? required("TSUBA_TOKEN"),
    port: Number(process.env.TSUBA_IMESSAGE_PORT ?? 8795),
    hostname: process.env.TSUBA_HOST ?? "127.0.0.1",
    icon: {
      bytes: new Uint8Array(await Bun.file(iconPath).arrayBuffer()),
      type: "image/svg+xml",
    },
    capabilities: capabilities(),
    backend: imessageBackend(),
  });
  console.log(`tsuba-imessage listening on ${server.hostname}:${server.port}`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await server.stop(true);
} else {
  console.log("commands: check | serve");
}
