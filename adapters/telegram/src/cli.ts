import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { proxyTransportFromUrl, TelegramClient } from "@mtcute/bun";
import { type Capabilities, serve } from "@tsuba/serve-kit";
import adapterPackage from "../package.json";
import { telegramBackend } from "./backend";

/**
 * The spike from docs/telegram.md: can mtcute on Bun sign a person in, list
 * their conversations and receive an update? Output is counts and kinds only;
 * no names, titles or message text are printed, because this runs against a
 * real account.
 *
 *   bun adapters/telegram/src/cli.ts login
 *   bun adapters/telegram/src/cli.ts spike [seconds-to-wait-for-a-message]
 *   bun adapters/telegram/src/cli.ts measure-length
 *   bun adapters/telegram/src/cli.ts serve
 */

const SESSION = fileURLToPath(
  new URL("../../../sessions/telegram.session", import.meta.url),
);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; see docs/telegram.md`);
  return value;
}

function createClient(): TelegramClient {
  // The session opens the whole account: nothing this process creates is
  // readable by anyone else (found 644 on the VPS before this).
  process.umask(0o077);
  mkdirSync(dirname(SESSION), { recursive: true, mode: 0o700 });
  const proxy = process.env.TSUBA_TELEGRAM_PROXY;
  return new TelegramClient({
    apiId: Number(required("TSUBA_TELEGRAM_API_ID")),
    apiHash: required("TSUBA_TELEGRAM_API_HASH"),
    storage: SESSION,
    updates: { catchUp: true },
    // Do not let mtcute retry uncertain sends or hide FLOOD_WAIT behind a delay.
    network: { middlewares: [] },
    ...(proxy ? { transport: proxyTransportFromUrl(proxy) } : {}),
  });
}

async function login(tg: TelegramClient) {
  await tg.start({
    phone: () => tg.input("Phone number, international format > "),
    code: () => tg.input("Code Telegram sent you > "),
    password: () => tg.input("Two-step verification password > "),
    invalidCodeCallback: (kind) => {
      console.log(`That ${kind} was not accepted; try again.`);
    },
  });
  console.log("Signed in; the session is in sessions/.");
}

async function signedIn(tg: TelegramClient) {
  await tg.start({
    phone: () => {
      throw new Error("Not signed in; run the login command first");
    },
  });
}

async function spike(tg: TelegramClient, waitSeconds: number) {
  await signedIn(tg);
  const kinds = new Map<string, number>();
  for await (const dialog of tg.iterDialogs({ limit: 500 })) {
    const peer = dialog.peer;
    const kind = peer.type === "user" ? "user" : peer.chatType;
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  console.log("dialogs by kind:", Object.fromEntries(kinds));

  console.log(`waiting up to ${waitSeconds}s for one new message...`);
  const received = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => {
      tg.onNewMessage.remove(onMessage);
      resolve("none within the deadline");
    }, waitSeconds * 1000);
    function onMessage(message: { isOutgoing: boolean; text: string }) {
      clearTimeout(timer);
      tg.onNewMessage.remove(onMessage);
      resolve(
        `${message.isOutgoing ? "outgoing" : "incoming"}, ${[...message.text].length} code points`,
      );
    }
    tg.onNewMessage.add(onMessage);
  });
  console.log("update:", received);
}

/**
 * Settles docs/telegram.md's open question about the unit of the 4096 limit on
 * the user (MTProto) path, in the account's own Saved Messages. Every message
 * that goes through is deleted at once.
 */
async function measureLength(tg: TelegramClient) {
  await signedIn(tg);
  const probes: [string, string][] = [
    ["4096 ascii", "a".repeat(4096)],
    ["4097 ascii", "a".repeat(4097)],
    ["4096 emoji (8192 UTF-16 units)", "\u{1F600}".repeat(4096)],
    ["4097 emoji", "\u{1F600}".repeat(4097)],
  ];
  for (const [label, text] of probes) {
    try {
      const sent = await tg.sendText("me", text);
      await tg.deleteMessagesById("me", [sent.id]);
      const kept = [...sent.text].length;
      console.log(label, `-> accepted, stored ${kept} code points (deleted)`);
    } catch (error) {
      console.log(label, "->", String(error).slice(0, 120));
    }
  }
}

// Measured on the user path: 4096 Unicode code points, not UTF-16 units.
const MAX_TEXT = 4096;

/**
 * Declare only the features implemented end to end. The limits that differ by
 * account or change with Telegram's settings are read from Telegram at start:
 * the edit window from `help.getConfig` and the reactions one account may
 * leave on a message from the app config (premium accounts may leave more).
 */
async function capabilities(tg: TelegramClient): Promise<Capabilities> {
  const config = await tg.call({ _: "help.getConfig" });
  const me = await tg.getMe();
  const reactions = await tg.appConfig.getField(
    me.isPremium ? "reactions_user_max_premium" : "reactions_user_max_default",
    1,
  );
  return {
    provider: { id: "telegram", name: "Telegram" },
    account: { kind: "user" },
    adapter: { name: "tsuba-telegram", version: adapterPackage.version },
    features: {
      "rooms.list": {},
      "messages.read": { paging: "before-id", maxLimit: 100 },
      "messages.stream": {
        resume: "cursor",
        events: ["message.edited", "message.deleted", "reactions.updated"],
      },
      "messages.send": { maxLength: MAX_TEXT, receipt: "stored" },
      "messages.reply": {},
      "messages.edit": {
        maxLength: MAX_TEXT,
        maxAgeSeconds: config.editTimeLimit,
      },
      // Own messages, revoked for both sides in private chats.
      "messages.delete": { forEveryone: true },
      "reactions.read": {},
      "reactions.send": { maxPerMessage: reactions },
      "read.mark": {},
      "attachments.read": {},
    },
  };
}

async function serveForever(tg: TelegramClient) {
  await signedIn(tg);
  const server = serve({
    token: required("TSUBA_TOKEN"),
    port: Number(process.env.TSUBA_PORT ?? 8790),
    hostname: process.env.TSUBA_HOST ?? "127.0.0.1",
    capabilities: await capabilities(tg),
    backend: telegramBackend(tg),
  });
  console.log(`tsuba-telegram listening on ${server.hostname}:${server.port}`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await server.stop(true);
}

const [command, argument] = process.argv.slice(2);
const tg = createClient();
try {
  if (command === "login") await login(tg);
  else if (command === "spike") await spike(tg, Number(argument ?? 120));
  else if (command === "measure-length") await measureLength(tg);
  else if (command === "serve") await serveForever(tg);
  else
    console.log("commands: login | spike [seconds] | measure-length | serve");
} finally {
  await tg.destroy();
}
