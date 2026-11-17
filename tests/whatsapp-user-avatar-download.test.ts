import { expect, onTestFinished, test } from "bun:test";
import {
  downloadPicture,
  type PictureFetch,
} from "../adapters/whatsapp-user/src/avatar-download";
import { bounded, deferred } from "./harness/barriers";

const jpeg = new Uint8Array([255, 216, 255, 217]);
const oversized = new Uint8Array(256 * 1024 + 1);
oversized.set(jpeg);
const signal = () => new AbortController().signal;

test.each([
  "http://pps.whatsapp.net/image",
  "https://127.0.0.1/image",
  "https://pps.whatsapp.net.evil.invalid/image",
  "https://evil.invalid/image",
  "https://user:pass@pps.whatsapp.net/image",
  "https://pps.whatsapp.net:444/image",
  "file:///private/image",
  "malformed",
  "https://pps.whatsapp.net./image",
])("untrusted CDN address %s never reaches HTTP", async (url) => {
  let calls = 0;
  const fetchFn: PictureFetch = async () => {
    calls++;
    return new Response(jpeg, { headers: { "content-type": "image/jpeg" } });
  };
  await expect(downloadPicture(url, signal(), fetchFn)).rejects.toThrow();
  expect(calls).toBe(0);
});

test.each([
  "https://pps.whatsapp.net/image",
  "https://mmg.pps.whatsapp.net/image",
  "https://pps.whatsapp.com/image",
])("trusted CDN address %s serves bounded image bytes", async (url) => {
  const picture = await downloadPicture(
    url,
    signal(),
    async () =>
      new Response(jpeg, { headers: { "content-type": "image/jpeg" } }),
  );
  expect(picture.bytes).toEqual(jpeg);
  expect(picture.mimeType).toBe("image/jpeg");
});

test("CDN redirects are rejected before a second local HTTP request", async () => {
  let targetRequests = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      if (new URL(request.url).pathname === "/redirect")
        return Response.redirect(new URL("/target", request.url).href, 302);
      targetRequests++;
      return new Response(jpeg);
    },
  });
  onTestFinished(() => server.stop(true));
  await expect(
    downloadPicture("https://pps.whatsapp.net/image", signal(), (_url, init) =>
      fetch(new URL("/redirect", server.url), init),
    ),
  ).rejects.toThrow();
  expect(targetRequests).toBe(0);
});

test.each([
  {
    name: "HTML",
    type: "text/html",
    body: new TextEncoder().encode("<script>bad</script>"),
    status: 200,
  },
  {
    name: "SVG",
    type: "image/svg+xml",
    body: new TextEncoder().encode("<svg/>"),
    status: 200,
  },
  {
    name: "bad signature",
    type: "image/jpeg",
    body: new TextEncoder().encode("<script>bad</script>"),
    status: 200,
  },
  { name: "not found", type: "image/jpeg", body: jpeg, status: 404 },
  {
    name: "too large",
    type: "image/jpeg",
    body: oversized,
    status: 200,
  },
])(
  "rejects failed oversized or mislabeled images: $name",
  async ({ type, body, status }) => {
    await expect(
      downloadPicture(
        "https://pps.whatsapp.net/image",
        signal(),
        async () =>
          new Response(body, { status, headers: { "content-type": type } }),
      ),
    ).rejects.toThrow();
  },
);

test("oversized declared lengths cancel before reading any bytes", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    downloadPicture(
      "https://pps.whatsapp.net/image",
      signal(),
      async () =>
        new Response(body, {
          headers: {
            "content-type": "image/jpeg",
            "content-length": String(256 * 1024 + 1),
          },
        }),
    ),
  ).rejects.toThrow();
  expect(cancelled).toBe(true);
});

test.each([
  { name: "PNG", type: "image/png", bytes: [137, 80, 78, 71, 13, 10, 26, 10] },
  {
    name: "WebP",
    type: "image/webp",
    bytes: [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80],
  },
])(
  "accepts $name previews matching their image signatures",
  async ({ type, bytes }) => {
    const picture = await downloadPicture(
      "https://pps.whatsapp.net/image",
      signal(),
      async () =>
        new Response(new Uint8Array(bytes), {
          headers: { "content-type": type },
        }),
    );
    expect(picture.mimeType).toBe(type);
    expect(picture.bytes).toEqual(new Uint8Array(bytes));
  },
);

test("streamed images enforce the byte limit and cancel their source", async () => {
  let cancelled = false;
  let chunks = 0;
  const chunk = new Uint8Array(128 * 1024);
  chunk.set(jpeg);
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (chunks++ < 3) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  await expect(
    downloadPicture(
      "https://pps.whatsapp.net/image",
      signal(),
      async () =>
        new Response(body, { headers: { "content-type": "image/jpeg" } }),
    ),
  ).rejects.toThrow();
  expect(cancelled).toBe(true);
});

test("download cancellation reaches the HTTP boundary without exposing its error", async () => {
  const controller = new AbortController();
  const started = deferred<void>();
  const fetchFn: PictureFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason),
        { once: true },
      );
      started.resolve();
    });
  const work = downloadPicture(
    "https://pps.whatsapp.net/image",
    controller.signal,
    fetchFn,
  );
  await bounded(started.promise, "HTTP request started");
  controller.abort();
  await expect(work).rejects.toThrow();
});

test("an unresponsive HTTP boundary is aborted by the download deadline", async () => {
  const fetchFn: PictureFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason),
        { once: true },
      );
    });
  const failure = await downloadPicture(
    "https://pps.whatsapp.net/image",
    signal(),
    fetchFn,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toMatchObject({ name: "TimeoutError" });
}, 10_000);
