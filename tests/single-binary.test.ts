import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionFile } from "../adapters/telegram/src/session";
import { TOKEN } from "./fixtures";
import { bounded } from "./harness/barriers";

const ENTRY = fileURLToPath(new URL("../bin/tsuba.ts", import.meta.url));

function childEnv(extra: Record<string, string>) {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("TSUBA_") || key.startsWith("SAYA_")) delete env[key];
  }
  return { ...env, ...extra };
}

function run(args: string[], extra: Record<string, string> = {}) {
  // A temporary working directory keeps the checkout's .env out of the child.
  return Bun.spawn([process.execPath, ENTRY, ...args], {
    cwd: tmpdir(),
    env: childEnv(extra),
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function listeningAddress(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let seen = "";
  for await (const chunk of stream) {
    seen += decoder.decode(chunk, { stream: true });
    const match = seen.match(/listening on (\S+):(\d+)/);
    if (match) return `${match[1]}:${match[2]}`;
  }
  throw new Error(`exited before listening: ${seen}`);
}

test("without a known adapter it prints usage and exits 2", async () => {
  for (const args of [[], ["whatsapp", "serve"]]) {
    const child = run(args);
    expect(await bounded(child.exited, "usage exit")).toBe(2);
    expect(await new Response(child.stdout).text()).toContain(
      "usage: tsuba <telegram|discord|slack|discord-user|imessage> <command>",
    );
  }
});

test("an adapter serves through the single entry, with its icon", async () => {
  const child = run(["discord-user", "serve"], {
    TSUBA_DISCORD_USER_TOKEN: "synthetic-user-token",
    TSUBA_DISCORD_USER_HTTP_TOKEN: TOKEN,
    TSUBA_DISCORD_USER_PORT: "0",
  });
  try {
    const address = await bounded(
      listeningAddress(child.stdout),
      "listening line",
      20_000,
    );
    expect((await fetch(`http://${address}/health`)).status).toBe(200);
    const bearer = { authorization: `Bearer ${TOKEN}` };
    const capabilities = await fetch(`http://${address}/capabilities`, {
      headers: bearer,
    });
    expect(capabilities.status).toBe(200);
    const icon = await fetch(`http://${address}/icon`, { headers: bearer });
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect((await icon.text()).startsWith("<svg")).toBe(true);
  } finally {
    child.kill();
    await bounded(child.exited, "adapter exit");
  }
});

test("the Telegram session follows TSUBA_SESSIONS_DIR", () => {
  const dir = join(tmpdir(), "tsuba-sessions");
  expect(sessionFile({ TSUBA_SESSIONS_DIR: dir })).toBe(
    join(dir, "telegram.session"),
  );
  expect(sessionFile({})).toBe(
    fileURLToPath(new URL("../sessions/telegram.session", import.meta.url)),
  );
});
