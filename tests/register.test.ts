import { afterEach, expect, test } from "bun:test";
import {
  registrationFromEnv,
  serve,
  startRegistration,
} from "../packages/serve-kit/src/index";
import { fakeBackend, sample, TOKEN } from "./fixtures";

const SAYA_TOKEN = "synthetic-saya-register-token-0123456789";

type Seen = { method: string; auth: string | null; body: unknown };

const servers: { stop: (force?: boolean) => unknown }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** A saya register listener that answers like the real one, including its refusals. */
function fakeSaya(
  answer: (seen: Seen) => Response = () =>
    Response.json({ interval: 30, ttl: 90 }),
) {
  const seen: Seen[] = [];
  let arrived = () => {};
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const entry = {
        method: request.method,
        auth: request.headers.get("authorization"),
        body: await request.json(),
      };
      seen.push(entry);
      arrived();
      return answer(entry);
    },
  });
  servers.push(server);
  return {
    url: `http://127.0.0.1:${server.port}`,
    seen,
    next: () =>
      new Promise<void>((resolve, reject) => {
        arrived = resolve;
        setTimeout(() => reject(new Error("no request within 5s")), 5000);
      }),
  };
}

function manualTimer() {
  const pending: { run: () => void; ms: number }[] = [];
  return {
    pending,
    setTimer: (run: () => void, ms: number) => {
      const entry = { run, ms };
      pending.push(entry);
      return entry;
    },
    clearTimer: (timer: unknown) => {
      const index = pending.indexOf(timer as (typeof pending)[number]);
      if (index >= 0) pending.splice(index, 1);
    },
  };
}

test("registration is off unless saya's address and token are both given", () => {
  const adapter = { id: "telegram", port: 8790, token: TOKEN };
  expect(registrationFromEnv({}, adapter)).toBeUndefined();
  expect(
    registrationFromEnv(
      { SAYA_REGISTER_URL: "http://127.0.0.1:8798" },
      adapter,
    ),
  ).toBeUndefined();
  expect(
    registrationFromEnv(
      {
        SAYA_REGISTER_URL: "http://127.0.0.1:8798/",
        SAYA_REGISTER_TOKEN: SAYA_TOKEN,
      },
      adapter,
    ),
  ).toEqual({
    registerUrl: "http://127.0.0.1:8798",
    registerToken: SAYA_TOKEN,
    id: "telegram",
    url: "http://127.0.0.1:8790",
    token: TOKEN,
  });
  expect(
    registrationFromEnv(
      {
        SAYA_REGISTER_URL: "https://saya.example.ts.net:8798",
        SAYA_REGISTER_TOKEN: SAYA_TOKEN,
        SAYA_ADVERTISE_URL: "https://pc.example.ts.net:8790",
      },
      adapter,
    )?.url,
  ).toBe("https://pc.example.ts.net:8790");
});

test("it announces itself with saya's token, repeats at saya's interval, and says goodbye", async () => {
  const saya = fakeSaya();
  const timer = manualTimer();
  const logs: string[] = [];
  const arrived = saya.next();
  const registration = startRegistration(
    {
      registerUrl: saya.url,
      registerToken: SAYA_TOKEN,
      id: "telegram",
      url: "http://127.0.0.1:8790",
      token: TOKEN,
    },
    { ...timer, log: (message) => logs.push(message) },
  );
  await arrived;
  await registration.first;
  expect(saya.seen[0]).toEqual({
    method: "POST",
    auth: `Bearer ${SAYA_TOKEN}`,
    body: {
      kind: "adapter",
      id: "telegram",
      url: "http://127.0.0.1:8790",
      token: TOKEN,
    },
  });
  expect(timer.pending.map(({ ms }) => ms)).toEqual([30_000]);

  const again = saya.next();
  timer.pending.shift()?.run();
  await again;
  expect(saya.seen).toHaveLength(2);

  const goodbye = saya.next();
  await registration.stop();
  await goodbye;
  expect(saya.seen.at(-1)).toEqual({
    method: "DELETE",
    auth: `Bearer ${SAYA_TOKEN}`,
    body: { kind: "adapter", id: "telegram" },
  });
  expect(logs).toEqual([
    "registered telegram with saya as http://127.0.0.1:8790",
  ]);
});

test("a refusal or an unreachable saya is logged once, without a token, and retried", async () => {
  const saya = fakeSaya(() =>
    Response.json(
      {
        error: {
          code: "UNAUTHORIZED",
          message: "A valid bearer token is required",
        },
      },
      { status: 401 },
    ),
  );
  const timer = manualTimer();
  const logs: string[] = [];
  const registration = startRegistration(
    {
      registerUrl: saya.url,
      registerToken: SAYA_TOKEN,
      id: "slack",
      url: "http://127.0.0.1:8793",
      token: TOKEN,
    },
    { ...timer, log: (message) => logs.push(message) },
  );
  await registration.first;
  const again = saya.next();
  timer.pending.shift()?.run();
  await again;
  expect(logs).toEqual([
    "saya registration of slack refused with 401 UNAUTHORIZED; retrying every 30s",
  ]);

  const closed = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const deadUrl = `http://127.0.0.1:${closed.port}`;
  closed.stop(true);
  const deadLogs: string[] = [];
  const dead = startRegistration(
    {
      registerUrl: deadUrl,
      registerToken: SAYA_TOKEN,
      id: "slack",
      url: "http://127.0.0.1:8793",
      token: TOKEN,
    },
    { ...manualTimer(), log: (message) => deadLogs.push(message) },
  );
  await dead.first;
  expect(deadLogs).toHaveLength(1);
  expect(deadLogs[0]).toStartWith("saya registration of slack unreachable");
  for (const line of [...logs, ...deadLogs]) {
    expect(line).not.toContain(SAYA_TOKEN);
    expect(line).not.toContain(TOKEN);
  }
  await registration.stop();
  await dead.stop();
});

test("serve() registers under its provider id and port, and leaves on stop", async () => {
  const saya = fakeSaya();
  const arrived = saya.next();
  const server = serve({
    token: TOKEN,
    port: 0,
    capabilities: sample,
    backend: fakeBackend(),
    register: {
      registerUrl: saya.url,
      registerToken: SAYA_TOKEN,
      id: sample.provider.id,
      url: "http://127.0.0.1:1",
      token: TOKEN,
    },
  });
  await arrived;
  expect(saya.seen[0]?.body).toMatchObject({ id: sample.provider.id });
  const goodbye = saya.next();
  await server.stop(true);
  await goodbye;
  expect(saya.seen.at(-1)?.method).toBe("DELETE");
});
