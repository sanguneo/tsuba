import { expect, test } from "bun:test";
import type { TelegramClient } from "@mtcute/bun";
import { createHandler, type StreamUpdate } from "@tsuba/serve-kit";
import { telegramBackend } from "./backend";
import { capabilities } from "./capabilities";
import type { MessageLike } from "./mapping";

const TOKEN = "synthetic-test-token-0123456789";
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
function stub() {
  const small = { synthetic: "small profile photo" };
  const photo = { raw: { photoId: "1234567890123456789" }, small };
  const sender = {
    type: "user",
    id: 123,
    displayName: "Synthetic",
    photo,
  } as const;
  const message: MessageLike = {
    id: 7,
    chat: sender,
    sender,
    text: "Synthetic",
    date: new Date(0),
    isOutgoing: true,
  };
  const listeners = new Set<(message: MessageLike) => void>();
  const emptyEvent = { add() {}, remove() {} };
  const state = {
    photo: photo as typeof photo | null,
    peerFailure: null as unknown,
    downloadFailure: null as unknown,
    peerCalls: [] as number[],
    downloads: [] as unknown[],
    signal: undefined as AbortSignal | undefined,
  };
  const client = {
    call: async () => ({ editTimeLimit: 172800 }),
    getMe: async () => ({ isPremium: false }),
    appConfig: { getField: async () => 1 },
    async getPeer(id: number) {
      state.peerCalls.push(id);
      if (state.peerFailure) throw state.peerFailure;
      return { ...sender, photo: state.photo };
    },
    downloadAsStream(location: unknown, options: { abortSignal: AbortSignal }) {
      state.downloads.push(location);
      state.signal = options.abortSignal;
      if (state.downloadFailure) throw state.downloadFailure;
      if (location !== small) throw new Error("Wrong download location");
      return new Blob([jpeg]).stream();
    },
    getHistory: async (_peer: number, options: { limit: number }) =>
      options.limit === 1 ? [] : [message],
    sendText: async () => message,
    onNewMessage: {
      add: (listener: (message: MessageLike) => void) =>
        listeners.add(listener),
      remove: (listener: (message: MessageLike) => void) =>
        listeners.delete(listener),
    },
    onEditMessage: emptyEvent,
    onDeleteMessage: emptyEvent,
    onRawUpdate: emptyEvent,
  };
  return {
    client: client as unknown as TelegramClient,
    state,
    message,
    listeners,
    small,
  };
}

async function surface() {
  const fake = stub();
  const declaration = await capabilities(fake.client);
  const backend = telegramBackend(fake.client);
  const handler = createHandler({
    token: TOKEN,
    capabilities: declaration,
    backend,
  });
  return { ...fake, declaration, backend, handler };
}

test("Telegram declares avatars and serves small JPEGs through the real media route", async () => {
  const { handler, declaration, state, small } = await surface();
  expect(declaration.features["avatars.read"]).toEqual({});
  expect(declaration.features["attachments.read"]).toEqual({});
  expect(declaration.account.kind).toBe("user");
  const response = await handler.handle(
    new Request("http://synthetic/media?id=avatar:123:1234567890123456789", {
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/jpeg");
  expect(response.headers.get("cache-control")).toContain("private");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(jpeg);
  expect(state.peerCalls).toEqual([123]);
  expect(state.downloads).toEqual([small]);
});

test("avatar parsing refuses malformed ids before resolving a peer", async () => {
  const { backend, state } = await surface();
  for (const id of [
    "avatar:",
    "avatar:0:1",
    "avatar:01:1",
    "avatar:-0:1",
    "avatar:123:01",
    "avatar:123:+1",
    "avatar:123:1:extra",
    "avatar:123:1\n",
    "avatar:9007199254740992:1",
    "avatar:123:9223372036854775808",
    "avatar:123:-9223372036854775809",
    "avatar:123:NaN",
  ]) {
    await expect(
      backend.media?.(id, new AbortController().signal),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  }
  expect(state.peerCalls).toEqual([]);
  expect(state.downloads).toEqual([]);
});

test("avatars re-resolve each request and refuse changed or missing photos", async () => {
  const { backend, state, small } = await surface();
  const signal = new AbortController().signal;
  const id = "avatar:-100123:1234567890123456789";
  await backend.media?.(id, signal);
  expect(state.signal).toBe(signal);
  state.photo = { small, raw: { photoId: "2" } };
  await expect(backend.media?.(id, signal)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  state.photo = null;
  await expect(backend.media?.(id, signal)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(state.peerCalls).toEqual([-100123, -100123, -100123]);
  expect(state.downloads).toHaveLength(1);
});

test("avatar peer and download failures use the existing error mapper", async () => {
  for (const phase of ["peerFailure", "downloadFailure"] as const) {
    for (const [failure, status, code] of [
      [{ code: 401, text: "SESSION_REVOKED" }, 503, "REAUTH_REQUIRED"],
      [{ code: 403, text: "FORBIDDEN" }, 403, "FORBIDDEN"],
      [{ code: 420, text: "FLOOD_WAIT_3" }, 429, "RATE_LIMITED"],
      [{ code: 400, text: "PEER_ID_INVALID" }, 404, "NOT_FOUND"],
      [new Error("Synthetic unknown failure"), 500, "INTERNAL"],
    ] as const) {
      const { handler, state } = await surface();
      state[phase] = failure;
      const response = await handler.handle(
        new Request(
          "http://synthetic/media?id=avatar:123:1234567890123456789",
          {
            headers: { authorization: `Bearer ${TOKEN}` },
          },
        ),
      );
      expect(response.status).toBe(status);
      expect((await response.json()).error.code).toBe(code);
    }
  }
});

test("reads, send answers and stream updates share sender avatar mapping", async () => {
  const { backend, message, listeners } = await surface();
  const avatar = "avatar:123:1234567890123456789";
  const read = await backend.readMessages?.({ roomId: "123", limit: 10 });
  expect(read?.messages[0]?.senderAvatar).toBe(avatar);
  expect((await backend.send?.("123", "Synthetic", {}))?.senderAvatar).toBe(
    avatar,
  );
  const updates: StreamUpdate[] = [];
  const unsubscribe = backend.subscribe?.((update) => updates.push(update));
  for (const listener of listeners) listener(message);
  expect(updates).toMatchObject([
    { event: "message", message: { senderAvatar: avatar } },
  ]);
  unsubscribe?.();
  expect(listeners.size).toBe(0);
});
