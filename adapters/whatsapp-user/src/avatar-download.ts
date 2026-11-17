import { AdapterError } from "@tsuba/serve-kit";

const MAX_BYTES = 256 * 1024;

export type PictureFetch = (url: URL, init: RequestInit) => Promise<Response>;

export interface Picture {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mimeType: string;
}

/** A preview is snapshotted before publishing its content-addressed media id. */
export async function downloadPicture(
  value: string,
  signal: AbortSignal,
  fetchFn: PictureFetch = fetch,
): Promise<Picture> {
  signal.throwIfAborted();
  const url = new URL(value);
  // Only WhatsApp picture CDNs; this input comes from the SDK, never the client.
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(
      url.hostname === "pps.whatsapp.net" ||
      /^[a-z0-9-]+\.pps\.whatsapp\.net$/.test(url.hostname) ||
      url.hostname === "pps.whatsapp.com"
    )
  )
    throw new AdapterError("NOT_FOUND", "No such WhatsApp picture");
  const response = await fetchFn(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    redirect: "error",
    credentials: "omit",
  });
  const type = response.headers.get("content-type")?.split(";")[0]?.trim();
  if (
    !response.ok ||
    !response.body ||
    (type !== "image/jpeg" && type !== "image/png" && type !== "image/webp") ||
    Number(response.headers.get("content-length") ?? 0) > MAX_BYTES
  ) {
    await response.body?.cancel();
    throw new AdapterError("NOT_FOUND", "WhatsApp picture unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > MAX_BYTES)
        throw new AdapterError("NOT_FOUND", "WhatsApp picture unavailable");
      chunks.push(chunk);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Reject executable or mislabeled content without decoding attacker pixels.
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.subarray(0, 8).join() === "137,80,78,71,13,10,26,10";
  const webp =
    new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP";
  if (
    !(
      (type === "image/jpeg" && jpeg) ||
      (type === "image/png" && png) ||
      (type === "image/webp" && webp)
    )
  )
    throw new AdapterError("NOT_FOUND", "WhatsApp picture unavailable");
  return { bytes, mimeType: type };
}
