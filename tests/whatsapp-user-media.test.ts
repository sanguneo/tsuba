import { expect, onTestFinished, test } from "bun:test";
import { whatsappUserBackend } from "../adapters/whatsapp-user/src/backend";
import { CAPABILITIES } from "../adapters/whatsapp-user/src/capabilities";
import type { WaContent } from "../adapters/whatsapp-user/src/types";
import { serve } from "../packages/serve-kit/src";
import type { MessagesAnswer } from "../packages/serve-kit/src/backend";
import { setup } from "./whatsapp-user-baileys-harness";
import { fakeLink, GROUP, ROOM, text } from "./whatsapp-user-fixtures";

const TOKEN = "synthetic-test-token-0123456789";
const META = { directPath: "/fixture", mediaKey: new Uint8Array(32) };

function httpFixture() {
  const link = fakeLink();
  const server = serve({
    port: 0,
    register: false,
    token: TOKEN,
    capabilities: CAPABILITIES,
    backend: whatsappUserBackend(link),
  });
  onTestFinished(() => server.stop(true));
  const request = (path: string, body?: FormData) =>
    fetch(new URL(path, server.url), {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(3_000),
      ...(body ? { method: "POST", body } : {}),
    });
  return { link, request };
}

const fixtures: readonly [WaContent, string, string, string][] = [
  [
    { imageMessage: { ...META, mimetype: "image/jpeg", caption: "photo" } },
    "image",
    "image/jpeg",
    "photo",
  ],
  [
    { videoMessage: { ...META, mimetype: "video/mp4", caption: "clip" } },
    "video",
    "video/mp4",
    "clip",
  ],
  [
    {
      audioMessage: { ...META, mimetype: "audio/ogg; codecs=opus", ptt: true },
    },
    "voice",
    "audio/ogg",
    "",
  ],
  [
    { stickerMessage: { ...META, mimetype: "image/webp" } },
    "sticker",
    "image/webp",
    "",
  ],
  [
    {
      documentWithCaptionMessage: {
        message: {
          documentMessage: {
            ...META,
            mimetype: "application/pdf",
            fileName: "example.pdf",
            caption: "document",
          },
        },
      },
    },
    "file",
    "application/pdf",
    "document",
  ],
];

test("retained media in HTTP history carries a usable attachment id and preserves captions", async () => {
  const { link, request } = httpFixture();
  link.downloadMedia = async (raw) =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`synthetic bytes for ${raw.key.id}`),
        );
        controller.close();
      },
    });
  link.push({
    type: "messages",
    live: true,
    messages: [
      ...fixtures.map(([message], i) => text(`media-${i}`, "", { message })),
      text("private-6", "", {
        message: {
          ephemeralMessage: {
            message: {
              viewOnceMessageV2: { message: fixtures[0]?.[0] ?? null },
            },
          },
        },
      }),
      text("media-0", "", { message: fixtures[2]?.[0] ?? null }, GROUP),
    ],
  });
  const history = await request(`/messages?roomId=${encodeURIComponent(ROOM)}`);
  expect(history.status).toBe(200);
  const { messages } = (await history.json()) as MessagesAnswer;
  expect(messages).toHaveLength(fixtures.length);
  for (const [i, [, kind, mimeType, caption]] of fixtures.entries()) {
    const message = messages.find(
      (entry: { id: string }) => entry.id === `media-${i}`,
    );
    expect(message).toMatchObject({
      kind: "media",
      text: caption,
      attachments: [{ kind, mimeType }],
    });
    const id = message?.attachments?.[0]?.id;
    if (!id) throw new Error("Expected an attachment id");
    const response = await request(`/media?${new URLSearchParams({ id })}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    if (kind === "file")
      expect(response.headers.get("content-disposition")).toContain(
        "example.pdf",
      );
    expect(await response.text()).toBe(`synthetic bytes for media-${i}`);
  }
  const groupHistory = await request(
    `/messages?roomId=${encodeURIComponent(GROUP)}`,
  );
  const group = ((await groupHistory.json()) as MessagesAnswer).messages[0];
  expect(group?.attachments?.[0]?.id).toBeDefined();
  expect(group?.attachments?.[0]?.id).not.toBe(
    messages.find((entry) => entry.id === "media-0")?.attachments?.[0]?.id,
  );
});

test("a deleted message's former HTTP attachment id returns 404", async () => {
  const { link, request } = httpFixture();
  const raw = text("media-1", "", { message: fixtures[1]?.[0] ?? null });
  link.push({ type: "messages", messages: [raw], live: false });
  const history = await request(`/messages?roomId=${encodeURIComponent(ROOM)}`);
  const id = ((await history.json()) as MessagesAnswer).messages[0]
    ?.attachments?.[0]?.id;
  if (!id) throw new Error("Expected an attachment id");
  link.push({ type: "delete", keys: [raw.key] });
  const response = await request(`/media?${new URLSearchParams({ id })}`);
  expect(response.status).toBe(404);
});

test("multipart upload sends a named file with its caption and the same-room quote", async () => {
  const { link, request } = httpFixture();
  const quote = text("quoted", "earlier message");
  link.push({ type: "messages", live: false, messages: [quote] });
  link.sendMedia = async (jid, file, caption, quoted) =>
    text("media-3", "", {
      key: { remoteJid: jid, id: "media-3", fromMe: true },
      message: {
        documentMessage: {
          ...META,
          fileLength: file.bytes.byteLength,
          mimetype: file.type,
          fileName: file.name,
          caption:
            new TextDecoder().decode(file.bytes) === "synthetic"
              ? (caption ?? null)
              : "wrong bytes",
          contextInfo: { stanzaId: quoted?.key.id ?? null },
        },
      },
    });
  const form = new FormData();
  form.set("roomId", ROOM);
  form.set("replyTo", "quoted");
  form.set("caption", "caption");
  form.set(
    "file",
    new File(["synthetic"], "sample.pdf", { type: "application/pdf" }),
  );
  const response = await request("/upload", form);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    message: {
      roomId: ROOM,
      text: "caption",
      fromMe: true,
      replyTo: "quoted",
      attachments: [
        {
          kind: "file",
          mimeType: "application/pdf",
          name: "sample.pdf",
          size: 9,
        },
      ],
    },
  });
});

test("multipart upload cannot quote a message from another room", async () => {
  const { link, request } = httpFixture();
  link.push({
    type: "messages",
    live: false,
    messages: [text("quoted", "other room", {}, GROUP)],
  });
  const form = new FormData();
  form.set("roomId", ROOM);
  form.set("replyTo", "quoted");
  form.set(
    "file",
    new File(["synthetic"], "sample.pdf", { type: "application/pdf" }),
  );
  const response = await request("/upload", form);
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
});

test.each([
  ["image/jpeg", "image"],
  ["video/mp4", "video"],
  ["application/pdf", "document"],
  ["video/webm", "document"],
] as const)(
  "Baileys upload routes %s to %s with its caption and quote",
  async (type, field) => {
    const { wa, calls } = await setup();
    const quoted = text("quoted", "earlier");
    await wa.sendMedia(
      ROOM,
      { type, name: "sample", bytes: Uint8Array.of(1, 2) },
      "caption",
      quoted,
    );
    expect(calls).toEqual([
      {
        jid: ROOM,
        content: {
          [field]: Buffer.from([1, 2]),
          mimetype: type,
          caption: "caption",
          ...(field === "document" ? { fileName: "sample" } : {}),
        },
        options: { quoted },
      },
    ]);
  },
);
