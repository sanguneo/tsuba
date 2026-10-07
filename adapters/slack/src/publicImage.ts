import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AdapterError } from "@tsuba/serve-kit";

/**
 * Fetching a picture by an address someone else wrote (a bot's image block).
 * The fetch runs from the user's own machine, so the address must name a
 * public host: https on the default port, no credentials, every address it
 * resolves to outside loopback, private, link-local, CGNAT and multicast
 * ranges, re-checked on each redirect hop. Only raster pictures come back,
 * and no more bytes than MAX_BYTES.
 */
const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_HOPS = 3;
export const MAX_BYTES = 20 * 1024 * 1024;

export type Resolve = (hostname: string) => Promise<string[]>;

export const resolveHost: Resolve = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map(
    (entry) => entry.address,
  );

function v4Private(address: string): boolean {
  const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Whether an IP literal is anywhere a public fetch must not reach. */
export function privateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return v4Private(address);
  if (kind !== 6) return true;
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return v4Private(mapped[1]);
  return (
    lower === "::" ||
    lower === "::1" ||
    /^f[cd]/.test(lower) ||
    /^fe[89ab]/.test(lower) ||
    /^ff/.test(lower) ||
    lower.startsWith("::ffff:")
  );
}

function plainHttps(url: URL): boolean {
  return (
    url.protocol === "https:" && !url.username && !url.password && !url.port
  );
}

async function publicHost(url: URL, resolve: Resolve): Promise<boolean> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return !privateAddress(host);
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    return false;
  }
  return addresses.length > 0 && !addresses.some(privateAddress);
}

function capped(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > MAX_BYTES)
          controller.error(new Error("picture larger than allowed"));
        else controller.enqueue(chunk);
      },
    }),
  );
}

export async function fetchPublicImage(
  start: URL,
  fetcher: typeof fetch,
  signal: AbortSignal,
  resolve: Resolve = resolveHost,
): Promise<{ body: ReadableStream<Uint8Array>; mimeType: string }> {
  let target = start;
  for (let hop = 0; ; hop++) {
    if (!plainHttps(target) || !(await publicHost(target, resolve)))
      throw new AdapterError("NOT_FOUND", "No such picture");
    let response: Response;
    try {
      response = await fetcher(target, { signal, redirect: "manual" });
    } catch {
      throw new AdapterError("INTERNAL", "The picture could not be reached");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (
        !location ||
        hop >= MAX_HOPS - 1 ||
        !URL.canParse(location, target.href)
      )
        throw new AdapterError("NOT_FOUND", "No such picture");
      target = new URL(location, target);
      continue;
    }
    const mimeType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    const length = Number(response.headers.get("content-length") ?? "0");
    if (
      !response.ok ||
      !response.body ||
      !mimeType ||
      !RASTER.has(mimeType) ||
      length > MAX_BYTES
    ) {
      await response.body?.cancel();
      throw new AdapterError("NOT_FOUND", "No such picture");
    }
    return { body: capped(response.body), mimeType };
  }
}
