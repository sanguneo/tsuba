import { join, resolve } from "node:path";
import { serve } from "@tsuba/serve-kit";
import qrcode from "qrcode-terminal";
import iconPath from "../icon.svg" with { type: "file" };
import { whatsappUserBackend } from "./backend";
import { openBaileys, prepareSessionDir } from "./baileys";
import { CAPABILITIES } from "./capabilities";
import { linkAccount } from "./login";
import { connectWhatsApp } from "./session";

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
  console.log("On the phone: WhatsApp > Linked devices > Link a device.");
  const result = await linkAccount({
    open: () => openBaileys({ authDir }),
    onQr: (qr) => qrcode.generate(qr, { small: true }),
    signal: AbortSignal.timeout(LOGIN_DEADLINE_MS),
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
  const link = connectWhatsApp({
    open: () => openBaileys({ authDir }),
    schedule(run, delayMs) {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    },
  });
  link.subscribe((event) => {
    if (event.type === "state")
      console.log(`tsuba-whatsapp-user state: ${event.state}`);
    else if (event.type === "groupSyncFailed")
      console.warn("tsuba-whatsapp-user group metadata unavailable");
  });
  const server = serve({
    token:
      process.env.TSUBA_WHATSAPP_USER_HTTP_TOKEN ?? required("TSUBA_TOKEN"),
    port: Number(process.env.TSUBA_WHATSAPP_USER_PORT ?? 8795),
    hostname: process.env.TSUBA_HOST ?? "127.0.0.1",
    icon: {
      bytes: new Uint8Array(await Bun.file(iconPath).arrayBuffer()),
      type: "image/svg+xml",
    },
    capabilities: CAPABILITIES,
    backend: whatsappUserBackend(link),
  });
  console.log(
    `tsuba-whatsapp-user listening on ${server.hostname}:${server.port}`,
  );
  await new Promise<void>((done) => {
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  await server.stop(true);
  await link.stop();
}
