import { join, resolve } from "node:path";
import { serve } from "@tsuba/serve-kit";
import qrcode from "qrcode-terminal";
import iconPath from "../icon.svg" with { type: "file" };
import { whatsappUserBackend } from "./backend";
import { openBaileys, prepareSessionDir } from "./baileys";
import { CAPABILITIES } from "./capabilities";
import { linkAccount } from "./login";
import { openWaStore } from "./persistence";
import { connectWhatsApp } from "./session";
import type { WaBotDiagnostic } from "./types";

/**
 * Personal WhatsApp account adapter (an unofficial client; read
 * docs/whatsapp-user.md first). Output is states and counts only: no phone
 * numbers, names, message text, QR contents or session data are printed.
 *
 *   bun adapters/whatsapp-user/src/cli.ts login   # QR code, scanned with the phone
 *   bun adapters/whatsapp-user/src/cli.ts serve
 */

const LOGIN_DEADLINE_MS = 3 * 60_000;
const authDir = resolve("sessions", "whatsapp");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; see docs/whatsapp-user.md`);
  return value;
}

// Everything the session writes, now and later, is readable by this user only.
process.umask(0o077);

const [command] = process.argv.slice(2);

if (command !== "login" && command !== "serve") {
  console.log("commands: login | serve");
} else if (command === "login") {
  await prepareSessionDir(authDir);
  const cache = await openWaStore(join(authDir, "store.json"), () =>
    console.warn("tsuba-whatsapp-user room cache save failed"),
  );
  console.log("On the phone: WhatsApp > Linked devices > Link a device.");
  const result = await linkAccount({
    open: () =>
      openBaileys({
        authDir,
        findMessage: (roomId, id) => cache.store.findOutbound(roomId, id),
      }),
    onQr: (qr) => qrcode.generate(qr, { small: true }),
    signal: AbortSignal.timeout(LOGIN_DEADLINE_MS),
    cache,
    schedule(run, delayMs) {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    },
  });
  await prepareSessionDir(authDir);
  if (result.linked) console.log("linked; start the adapter with: serve");
  else {
    console.log(
      result.reason === "aborted"
        ? "login timed out; run it again"
        : `login failed (status ${result.statusCode ?? "unknown"}); run it again`,
    );
    process.exitCode = 1;
  }
} else {
  if (!(await Bun.file(join(authDir, "creds.json")).exists())) {
    console.log("not linked yet; run login first (docs/whatsapp-user.md)");
    process.exit(1);
  }
  await prepareSessionDir(authDir);
  const cache = await openWaStore(join(authDir, "store.json"), () =>
    console.warn("tsuba-whatsapp-user room cache save failed"),
  );
  const link = connectWhatsApp({
    open: () =>
      openBaileys({
        authDir,
        findMessage: (roomId, id) => cache.store.findOutbound(roomId, id),
      }),
    schedule(run, delayMs) {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    },
  });
  const reportedBotReasons = new Set<WaBotDiagnostic>();
  link.subscribe((event) => {
    if (event.type === "state")
      console.log(`tsuba-whatsapp-user state: ${event.state}`);
    else if (event.type === "groupSyncFailed")
      console.warn("tsuba-whatsapp-user group metadata unavailable");
    else if (event.type === "groupSyncStarted")
      console.log("tsuba-whatsapp-user group metadata fetching");
    else if (event.type === "groupSyncComplete")
      console.log(`tsuba-whatsapp-user group metadata fetched: ${event.count}`);
    else if (
      event.type === "botDiagnostic" &&
      !reportedBotReasons.has(event.reason)
    ) {
      reportedBotReasons.add(event.reason);
      console.warn(`tsuba-whatsapp-user bot history: ${event.reason}`);
    }
  });
  const server = serve({
    token:
      process.env.TSUBA_WHATSAPP_USER_HTTP_TOKEN ?? required("TSUBA_TOKEN"),
    port: Number(process.env.TSUBA_WHATSAPP_USER_PORT ?? 8795),
    // The SDK may wait on the linked device before it can start a media reply.
    idleTimeout: 90,
    hostname: process.env.TSUBA_HOST ?? "127.0.0.1",
    icon: {
      bytes: new Uint8Array(await Bun.file(iconPath).arrayBuffer()),
      type: "image/svg+xml",
    },
    capabilities: CAPABILITIES,
    backend: whatsappUserBackend(link, {
      store: cache.store,
      changed: cache.save,
    }),
  });
  console.log(
    `tsuba-whatsapp-user listening on ${server.hostname}:${server.port}`,
  );
  await new Promise<void>((done) => {
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  try {
    await server.stop(true);
  } finally {
    try {
      await link.stop();
    } finally {
      await cache.flush();
    }
  }
}
