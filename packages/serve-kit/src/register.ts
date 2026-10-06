/**
 * Announcing this adapter to saya (saya's docs/register.md, version 1). saya
 * holds one token and no adapter address; an adapter that knows saya's
 * register address and token tells saya where it is and which token to
 * present, and repeats that every interval saya answers with. Registration is
 * opt-in and never a condition of serving: a refusal or an unreachable saya is
 * logged, without either token, and tried again on the next interval.
 */
export interface Registration {
  registerUrl: string;
  registerToken: string;
  id: string;
  url: string;
  token: string;
}

const DEFAULT_INTERVAL_SECONDS = 30;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * `SAYA_REGISTER_URL` and `SAYA_REGISTER_TOKEN` turn it on; `SAYA_ADVERTISE_URL`
 * is where saya reaches this adapter, by default this machine's loopback.
 */
export function registrationFromEnv(
  env: Record<string, string | undefined>,
  adapter: { id: string; port: number; token: string },
): Registration | undefined {
  const registerUrl = env.SAYA_REGISTER_URL;
  const registerToken = env.SAYA_REGISTER_TOKEN;
  if (!registerUrl || !registerToken) return undefined;
  return {
    registerUrl: registerUrl.replace(/\/+$/, ""),
    registerToken,
    id: adapter.id,
    url: env.SAYA_ADVERTISE_URL || `http://127.0.0.1:${adapter.port}`,
    token: adapter.token,
  };
}

export interface RegistrationDeps {
  fetch?: typeof fetch;
  log?: (message: string) => void;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export function startRegistration(
  registration: Registration,
  deps: RegistrationDeps = {},
) {
  const send = deps.fetch ?? fetch;
  const log = deps.log ?? ((message: string) => console.warn(message));
  const setTimer =
    deps.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer =
    deps.clearTimer ??
    ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const endpoint = `${registration.registerUrl}/register`;
  const headers = {
    authorization: `Bearer ${registration.registerToken}`,
    "content-type": "application/json",
  };
  let timer: unknown;
  let stopped = false;
  let reported: string | null | undefined;

  async function beat(): Promise<void> {
    let interval = DEFAULT_INTERVAL_SECONDS;
    let problem: string | undefined;
    try {
      const answer = await send(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "adapter",
          id: registration.id,
          url: registration.url,
          token: registration.token,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = (await answer.json().catch(() => ({}))) as {
        interval?: unknown;
        error?: { code?: unknown };
      };
      if (answer.ok) {
        if (typeof body.interval === "number" && body.interval > 0)
          interval = body.interval;
      } else
        problem =
          `refused with ${answer.status} ${String(body.error?.code ?? "")}`.trim();
    } catch (error) {
      problem = `unreachable (${error instanceof Error ? error.name : "error"})`;
    }
    // Say it once when it changes, not every interval.
    if ((problem ?? null) !== reported) {
      log(
        problem
          ? `saya registration of ${registration.id} ${problem}; retrying every ${interval}s`
          : `registered ${registration.id} with saya as ${registration.url}`,
      );
      reported = problem ?? null;
    }
    if (!stopped) timer = setTimer(() => void beat(), interval * 1000);
  }

  const first = beat();
  return {
    first,
    async stop(): Promise<void> {
      stopped = true;
      clearTimer(timer);
      await first;
      try {
        await send(endpoint, {
          method: "DELETE",
          headers,
          body: JSON.stringify({ kind: "adapter", id: registration.id }),
          signal: AbortSignal.timeout(3000),
        });
      } catch {
        // Leaving quietly is fine: saya forgets it after its ttl.
      }
    },
  };
}
