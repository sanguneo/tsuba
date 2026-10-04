import { serve } from "@tsuba/serve-kit";
import entries from "emoji-datasource/emoji.json";
import { slackApi, slackScopes } from "./api";
import { slackBackend } from "./backend";
import { capabilities, UPLOAD_SCOPE } from "./capabilities";
import { type EmojiEntry, emojiTable } from "./emoji";
import { socketMode } from "./socket";

/**
 * The Slack adapter: the person's own account through Slack's official user
 * token (xoxp-) and Socket Mode's app-level token (xapp-). Output is counts
 * only; no workspace, channel or person names are printed.
 *
 *   bun adapters/slack/src/cli.ts check
 *   bun adapters/slack/src/cli.ts serve
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; see docs/slack.md`);
  return value;
}

const userToken = required("TSUBA_SLACK_USER_TOKEN");
const call = slackApi(userToken);
const auth = await call<{ user_id?: string; user?: string }>("auth.test");
if (!auth.user_id) throw new Error("Slack did not say whose token this is");
const identity = {
  userId: auth.user_id,
  ...(auth.user ? { handle: auth.user } : {}),
};
const emoji = emojiTable(entries as EmojiEntry[]);
// Files are declared only when Slack granted the token the scope to upload them.
const uploads = (await slackScopes(userToken)).has(UPLOAD_SCOPE);

const listeners = new Set<(event: Record<string, unknown>) => void>();
const live = {
  onEvent(listener: (event: Record<string, unknown>) => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

const [command] = process.argv.slice(2);
if (command === "check") {
  const backend = slackBackend(call, identity, emoji, live, fetch, userToken);
  console.log(
    "uploads:",
    uploads ? "declared" : `not declared (no ${UPLOAD_SCOPE})`,
  );
  const rooms = (await backend.listRooms?.())?.rooms ?? [];
  const direct = rooms.filter((room) => room.kind === "direct").length;
  console.log(
    "rooms:",
    rooms.length,
    "direct:",
    direct,
    "group:",
    rooms.length - direct,
    "read-only:",
    rooms.filter((room) => room.features?.["messages.send"] === false).length,
  );
  backend.stop();
} else if (command === "serve") {
  const socket = socketMode({
    appToken: required("TSUBA_SLACK_APP_TOKEN"),
    onEvent: (event) => {
      for (const listener of listeners) listener(event);
    },
  });
  const backend = slackBackend(call, identity, emoji, live, fetch, userToken, {
    uploads,
  });
  const server = serve({
    token: process.env.TSUBA_SLACK_HTTP_TOKEN ?? required("TSUBA_TOKEN"),
    port: Number(process.env.TSUBA_SLACK_PORT ?? 8793),
    hostname: process.env.TSUBA_HOST ?? "127.0.0.1",
    icon: {
      bytes: new Uint8Array(
        await Bun.file(new URL("../icon.svg", import.meta.url)).arrayBuffer(),
      ),
      type: "image/svg+xml",
    },
    capabilities: capabilities(uploads),
    backend,
  });
  console.log(`tsuba-slack listening on ${server.hostname}:${server.port}`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  socket.stop();
  backend.stop();
  await server.stop(true);
} else {
  console.log("commands: check | serve");
}
