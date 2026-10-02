import { serve } from "@tsuba/serve-kit";
import {
  Client,
  Events,
  GatewayIntentBits,
  Options,
  Partials,
} from "discord.js";
import { discordBackend, warmRecentRooms } from "./backend";
import { CAPABILITIES } from "./capabilities";

/**
 * The Discord adapter: a bot account, never a person's account (automating a
 * user account breaks Discord's terms). Output is counts only; no server,
 * channel or person names are printed.
 *
 *   bun adapters/discord/src/cli.ts check
 *   bun adapters/discord/src/cli.ts serve
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; see docs/discord.md`);
  return value;
}

function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      // Privileged: switch on "Message Content Intent" in the developer portal.
      GatewayIntentBits.MessageContent,
    ],
    // Events about messages from before the adapter started arrive partial.
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    // Never resend a request whose outcome is unknown.
    rest: { retries: 0 },
    // Keep the SDK cache off: it merges removed reactions. The backend holds
    // bounded mapped snapshots and replaces reaction lists instead.
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 0,
    }),
  });
}

async function ready(client: Client): Promise<Client<true>> {
  const signedIn = new Promise<Client<true>>((resolve) =>
    client.once(Events.ClientReady, resolve),
  );
  await client.login(required("TSUBA_DISCORD_TOKEN"));
  return signedIn;
}

async function check(client: Client<true>) {
  const backend = discordBackend(client);
  const rooms = (await backend.listRooms?.())?.rooms ?? [];
  console.log("servers:", client.guilds.cache.size);
  console.log(
    "rooms:",
    rooms.length,
    "read-only:",
    rooms.filter((room) => room.features?.["messages.send"] === false).length,
  );
}

async function serveForever(client: Client<true>) {
  const backend = discordBackend(client);
  // Keep gateway updates flowing into the cache even with no SSE clients.
  const unsubscribe = backend.subscribe?.(() => {});
  const lifetime = new AbortController();
  const server = serve({
    token: process.env.TSUBA_DISCORD_HTTP_TOKEN ?? required("TSUBA_TOKEN"),
    port: Number(process.env.TSUBA_DISCORD_PORT ?? 8792),
    hostname: process.env.TSUBA_HOST ?? "127.0.0.1",
    icon: {
      bytes: new Uint8Array(
        await Bun.file(new URL("../icon.svg", import.meta.url)).arrayBuffer(),
      ),
      type: "image/svg+xml",
    },
    capabilities: CAPABILITIES,
    backend,
  });
  console.log(`tsuba-discord listening on ${server.hostname}:${server.port}`);
  const warming = warmRecentRooms(backend, lifetime.signal).then((count) =>
    console.log("Discord cache prefilled rooms:", count),
  );
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  lifetime.abort();
  unsubscribe?.();
  await server.stop(true);
  await warming;
}

const [command] = process.argv.slice(2);
if (command !== "check" && command !== "serve") {
  console.log("commands: check | serve");
} else {
  const client = createClient();
  try {
    const signedIn = await ready(client);
    if (command === "check") await check(signedIn);
    else await serveForever(signedIn);
  } finally {
    await client.destroy();
  }
}
