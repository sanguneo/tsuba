import { serve } from "@tsuba/serve-kit";
import { discordUserBackend } from "./backend";
import { CAPABILITIES } from "./capabilities";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; see docs/discord-user.md`);
  return value;
}

const userToken = required("TSUBA_DISCORD_USER_TOKEN");
const backend = discordUserBackend(userToken);

const [command] = process.argv.slice(2);

if (command === "check") {
  const res = await backend.listRooms();
  console.log("rooms:", res.rooms.length);
  backend.stop();
} else if (command === "serve") {
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
  backend.stop();
  await server.stop(true);
} else {
  console.log("commands: check | serve");
  backend.stop();
}
