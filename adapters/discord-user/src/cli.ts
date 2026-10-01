import { serve } from "@tsuba/serve-kit";
import { discordUserBackend } from "./backend";
import { CAPABILITIES } from "./capabilities";

/**
 * Personal Discord account adapter. Output is counts only: no server, channel
 * or person names, message contents, or tokens are printed.
 *
 *   bun adapters/discord-user/src/cli.ts check
 *   bun adapters/discord-user/src/cli.ts serve
 *
 * check uses REST only; the Gateway starts when serve subscribes.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; see docs/discord-user.md`);
  return value;
}

const [command] = process.argv.slice(2);

if (command !== "check" && command !== "serve") {
  console.log("commands: check | serve");
} else if (command === "check") {
  const backend = discordUserBackend(required("TSUBA_DISCORD_USER_TOKEN"));
  const res = await backend.listRooms?.();
  console.log("rooms:", res?.rooms.length ?? 0);
} else {
  const backend = discordUserBackend(required("TSUBA_DISCORD_USER_TOKEN"));
  const server = serve({
    token: process.env.TSUBA_DISCORD_USER_HTTP_TOKEN ?? required("TSUBA_TOKEN"),
    port: Number(process.env.TSUBA_DISCORD_USER_PORT ?? 8794),
    hostname: process.env.TSUBA_HOST ?? "127.0.0.1",
    capabilities: CAPABILITIES,
    backend,
  });
  console.log(
    `tsuba-discord-user listening on ${server.hostname}:${server.port}`,
  );
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await server.stop(true);
}
