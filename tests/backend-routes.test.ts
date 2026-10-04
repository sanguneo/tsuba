import { expect, test } from "bun:test";
import contract from "../contract/openapi.json";
import {
  type AdapterBackend,
  AdapterError,
  type Capabilities,
  createHandler,
  type ErrorEnvelope,
  type FeatureId,
  type MediaFile,
  type Message,
  RESERVED_FEATURES,
  type SendAnswer,
  type StreamUpdate,
  serve,
} from "../packages/serve-kit/src/index";
import { fakeBackend, message, room, sample, schema, TOKEN } from "./fixtures";
import { bounded, deferred } from "./harness/barriers";

const bearer = { authorization: `Bearer ${TOKEN}` };
const jsonHeaders = { ...bearer, "content-type": "application/json" };
const full: Capabilities = {
  ...sample,
  features: {
    ...sample.features,
    "messages.stream": { resume: "cursor" },
    "attachments.read": {},
  },
};
const bytes = new TextEncoder().encode("synthetic bytes");
function file(extra: Omit<MediaFile, "body"> = {}): MediaFile {
  return { body: new Blob([bytes]).stream(), ...extra };
}

function liveBackend() {
  const listeners = new Set<(update: StreamUpdate) => void>();
  let cleanup = deferred<void>();
  return {
    backend: {
      ...fakeBackend(),
      media: async () => file({ mimeType: "image/png" }),
      messagesAfter: async () => [message],
      subscribe(listener: (update: StreamUpdate) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
          cleanup.resolve();
        };
      },
    } satisfies AdapterBackend,
    listeners,
    emit(value: Message) {
      for (const listener of listeners)
        listener({ event: "message", message: value });
    },
    update(value: StreamUpdate) {
      for (const listener of listeners) listener(value);
    },
    cleanupSignal() {
      cleanup = deferred<void>();
      return cleanup.promise;
    },
  };
}

async function answer<T = unknown>(
  response: Response,
  name: string,
  status = 200,
): Promise<T> {
  expect(response.status).toBe(status);
  const body = await response.json();
  expect(schema(name)(body)).toBe(true);
  return body as T;
}
async function error(
  response: Response,
  status: number,
  code: ErrorEnvelope["error"]["code"],
) {
  const body = await answer<ErrorEnvelope>(response, "ErrorEnvelope", status);
  expect(body.error.code).toBe(code);
  return body;
}
function present<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Missing test value");
  return value;
}
function events(response: Response) {
  const reader = present(response.body).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(expected: string) {
      while (!buffer.includes("\n\n")) {
        const chunk = await bounded(reader.read(), `SSE ${expected}`);
        if (chunk.done) throw new Error(`Stream ended before ${expected}`);
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      const index = buffer.indexOf("\n\n");
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const [event, data] = frame.split("\n");
      expect(event).toBe(`event: ${expected}`);
      const body = JSON.parse(present(data).slice(6));
      const names: Record<string, string> = {
        ready: "StreamReady",
        message: "StreamMessage",
        cursor: "StreamCursor",
        ping: "StreamPing",
        error: "ErrorEnvelope",
        "message.edited": "StreamMessage",
        "message.deleted": "StreamMessagesDeleted",
        "reactions.updated": "StreamReactionsUpdated",
      };
      expect(schema(present(names[expected]))(body)).toBe(true);
      return body;
    },
    async end() {
      expect((await bounded(reader.read(), "stream end")).done).toBe(true);
    },
  };
}

test("all JSON success routes over real HTTP", async () => {
  const live = liveBackend();
  const server = serve({
    token: TOKEN,
    capabilities: full,
    backend: live.backend,
    port: 0,
  });
  try {
    for (const [path, name] of [
      ["/health", "Health"],
      ["/capabilities", "Capabilities"],
      ["/rooms", "RoomsAnswer"],
      ["/messages?roomId=example%3Aroom&before=3&limit=2", "MessagesAnswer"],
    ] as const)
      await answer(
        await fetch(new URL(path, server.url), { headers: bearer }),
        name,
      );
    const sent = await answer<SendAnswer>(
      await fetch(new URL("/send", server.url), {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ roomId: room.id, text: "Synthetic send" }),
      }),
      "SendAnswer",
    );
    expect(sent.message.text).toBe("Synthetic send");
  } finally {
    await server.stop(true);
  }
});

test("auth precedes unsupported and unknown routes; every absent feature is 501", async () => {
  const server = serve({
    token: TOKEN,
    capabilities: { ...sample, features: {} },
    port: 0,
  });
  const gated = Object.entries(contract.paths).flatMap(([path, item]) =>
    Object.entries(item).flatMap(([method, operation]) =>
      "x-feature" in operation ? [{ path, method: method.toUpperCase() }] : [],
    ),
  );
  expect(gated.map(({ path }) => path).sort()).toEqual(
    [
      "/media",
      "/messages",
      "/rooms",
      "/send",
      "/upload",
      "/stream",
      "/edit",
      "/delete",
      "/react",
      "/read",
    ].sort(),
  );
  try {
    for (const { path, method } of [
      ...gated,
      { path: "/unknown", method: "GET" },
    ]) {
      await error(
        await fetch(new URL(path, server.url), { method }),
        401,
        "UNAUTHORIZED",
      );
      await error(
        await fetch(new URL(path, server.url), { method, headers: bearer }),
        path === "/unknown" ? 404 : 501,
        path === "/unknown" ? "NOT_FOUND" : "NOT_SUPPORTED",
      );
    }
  } finally {
    await server.stop(true);
  }
});

test("message and send boundary validation and clamped default", async () => {
  const requests: unknown[] = [];
  const backend = fakeBackend();
  backend.readMessages = async (request) => {
    requests.push(request);
    return { messages: [], hasEarlier: false };
  };
  const capabilities: Capabilities = {
    ...sample,
    features: {
      ...sample.features,
      "messages.read": { paging: "none", maxLimit: 3 },
      "messages.send": { maxLength: 2, receipt: "stored" },
    },
  };
  const server = serve({ token: TOKEN, capabilities, backend, port: 0 });
  try {
    for (const query of [
      "",
      "?roomId=",
      "?roomId=r&limit=0",
      "?roomId=r&limit=4",
      "?roomId=r&limit=1.5",
      "?roomId=r&limit=abc",
      "?roomId=r&limit=",
      "?roomId=r&limit=1e0",
      "?roomId=r&before=1",
    ])
      await error(
        await fetch(new URL(`/messages${query}`, server.url), {
          headers: bearer,
        }),
        400,
        "INVALID_REQUEST",
      );
    await answer(
      await fetch(new URL("/messages?roomId=r", server.url), {
        headers: bearer,
      }),
      "MessagesAnswer",
    );
    expect(requests).toEqual([{ roomId: "r", limit: 3 }]);
    for (const body of [
      "{",
      "null",
      "[]",
      "{}",
      '{"roomId":"r","text":""}',
      '{"roomId":"","text":"a"}',
      '{"roomId":"r","text":1}',
      JSON.stringify({ roomId: "r", text: "\u{1F600}".repeat(3) }),
    ])
      await error(
        await fetch(new URL("/send", server.url), {
          method: "POST",
          headers: jsonHeaders,
          body,
        }),
        400,
        "INVALID_REQUEST",
      );
    await error(
      await fetch(new URL("/send", server.url), {
        method: "POST",
        headers: bearer,
        body: "{}",
      }),
      400,
      "INVALID_REQUEST",
    );
    await answer(
      await fetch(new URL("/send", server.url), {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ roomId: "r", text: "\u{1F600}".repeat(2) }),
      }),
      "SendAnswer",
    );
  } finally {
    await server.stop(true);
  }
});

test("before-id rejects empty ids and forwards valid queries", async () => {
  let observed: unknown;
  const backend = fakeBackend();
  backend.readMessages = async (request) => {
    observed = request;
    return { messages: [message], hasEarlier: true };
  };
  const { handle } = createHandler({
    token: TOKEN,
    capabilities: sample,
    backend,
  });
  await error(
    await handle(
      new Request("http://adapter/messages?roomId=r&before=", {
        headers: bearer,
      }),
    ),
    400,
    "INVALID_REQUEST",
  );
  await answer(
    await handle(
      new Request("http://adapter/messages?roomId=r&before=9", {
        headers: bearer,
      }),
    ),
    "MessagesAnswer",
  );
  expect(observed).toEqual({ roomId: "r", limit: 50, before: "9" });
});

test("backend errors map to status without leaking unexpected messages", async () => {
  const backend = fakeBackend();
  const server = serve({
    token: TOKEN,
    capabilities: sample,
    backend,
    port: 0,
  });
  try {
    for (const [code, status] of [
      ["RATE_LIMITED", 429],
      ["NOT_FOUND", 404],
      ["BUSY", 503],
      ["FORBIDDEN", 403],
      ["REAUTH_REQUIRED", 503],
    ] as const) {
      backend.readMessages = async () => {
        throw new AdapterError(code, "Synthetic safe error");
      };
      await error(
        await fetch(new URL("/messages?roomId=r", server.url), {
          headers: bearer,
        }),
        status,
        code,
      );
    }
    backend.send = async () => {
      throw new AdapterError("RATE_LIMITED", "Synthetic safe error");
    };
    await error(
      await fetch(new URL("/send", server.url), {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ roomId: "r", text: "a" }),
      }),
      429,
      "RATE_LIMITED",
    );
    backend.listRooms = async () => {
      throw new Error("SYNTHETIC_PRIVATE_ACCOUNT_DATA");
    };
    const body = await error(
      await fetch(new URL("/rooms", server.url), { headers: bearer }),
      500,
      "INTERNAL",
    );
    expect(JSON.stringify(body)).not.toContain(
      "SYNTHETIC_PRIVATE_ACCOUNT_DATA",
    );
  } finally {
    await server.stop(true);
  }
});

test("four admitted sends stay serialized; fifth touches neither body nor backend", async () => {
  const gates = Array.from({ length: 4 }, () => deferred<void>());
  const entered = Array.from({ length: 4 }, () => deferred<void>());
  let calls = 0;
  let active = 0;
  const backend = fakeBackend();
  backend.send = async (roomId, text) => {
    const index = calls++;
    expect(++active).toBe(1);
    present(entered[index]).resolve();
    await bounded(present(gates[index]).promise, "send release");
    active--;
    return { ...message, roomId, text };
  };
  const { handle } = createHandler({
    token: TOKEN,
    capabilities: sample,
    backend,
  });
  const waiting: Promise<Response>[] = [];
  for (let index = 0; index < 4; index++) {
    const bodyRead = deferred<void>();
    const request = new Request("http://adapter/send", {
      method: "POST",
      headers: jsonHeaders,
    });
    Object.defineProperty(request, "json", {
      value: async () => {
        bodyRead.resolve();
        return { roomId: "r", text: String(index) };
      },
    });
    waiting.push(handle(request));
    await bounded(bodyRead.promise, "send admitted");
  }
  await bounded(present(entered[0]).promise, "first send entered");
  const fifth = new Request("http://adapter/send", {
    method: "POST",
    headers: jsonHeaders,
  });
  Object.defineProperty(fifth, "json", {
    value: async () => {
      throw new Error("The refused request body was touched");
    },
  });
  await error(
    await bounded(handle(fifth), "fifth refused"),
    429,
    "RATE_LIMITED",
  );
  expect(calls).toBe(1);
  for (let index = 0; index < 4; index++) {
    await bounded(present(entered[index]).promise, "serialized send entered");
    present(gates[index]).resolve();
    await answer(
      await bounded(present(waiting[index]), "send finished"),
      "SendAnswer",
    );
  }
  expect(calls).toBe(4);
});

test("startup rejects each declaration/implementation mismatch", () => {
  for (const [feature, method] of [
    ["rooms.list", "listRooms"],
    ["messages.read", "readMessages"],
    ["messages.send", "send"],
    ["messages.stream", "subscribe"],
    ["attachments.read", "media"],
  ] as const) {
    const live = liveBackend();
    const missing = { ...live.backend } as AdapterBackend;
    delete missing[method];
    expect(() =>
      createHandler({ token: TOKEN, capabilities: full, backend: missing }),
    ).toThrow();
    const undeclared: Capabilities = {
      ...full,
      features: { ...full.features },
    };
    delete undeclared.features[feature];
    expect(() =>
      createHandler({
        token: TOKEN,
        capabilities: undeclared,
        backend: live.backend,
      }),
    ).toThrow();
  }
  const live = liveBackend();
  const { messagesAfter: _after, ...withoutResume } = live.backend;
  expect(() =>
    createHandler({ token: TOKEN, capabilities: full, backend: withoutResume }),
  ).toThrow();
  expect(() =>
    createHandler({
      token: TOKEN,
      capabilities: {
        ...full,
        features: { ...full.features, "messages.stream": { resume: "none" } },
      },
      backend: live.backend,
    }),
  ).toThrow();
});

test("SSE ready, resumed batch, cursor, live message, cursor, then disconnect cleanup", async () => {
  const live = liveBackend();
  const server = serve({
    token: TOKEN,
    capabilities: full,
    backend: live.backend,
    port: 0,
  });
  const abort = new AbortController();
  try {
    const response = await fetch(
      new URL("/stream?since=example:room:1", server.url),
      { headers: bearer, signal: abort.signal },
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const sse = events(response);
    expect(await sse.next("ready")).toEqual({
      ok: true,
      resumed: true,
      cursor: { [room.id]: "1" },
    });
    expect((await sse.next("message")).message).toEqual(message);
    expect((await sse.next("cursor")).cursor).toEqual({ [room.id]: "2" });
    const signal = sse.next("message");
    live.emit({ ...message, id: "3" });
    expect((await signal).message.id).toBe("3");
    expect((await sse.next("cursor")).cursor).toEqual({ [room.id]: "3" });
    const cleaned = live.cleanupSignal();
    abort.abort();
    await bounded(cleaned, "disconnect cleanup");
    expect(live.listeners.size).toBe(0);
  } finally {
    abort.abort();
    await server.stop(true);
  }
});

test("stream validates since and refuses resume when unsupported", async () => {
  const live = liveBackend();
  const { handle, stop } = createHandler({
    token: TOKEN,
    capabilities: full,
    backend: live.backend,
  });
  try {
    for (const since of ["broken", ":1", "room:", "", "room:1&since=room:2"])
      await error(
        await handle(
          new Request(`http://adapter/stream?since=${since}`, {
            headers: bearer,
          }),
        ),
        400,
        "INVALID_REQUEST",
      );
    const { messagesAfter: _resume, ...backend } = live.backend;
    const none = createHandler({
      token: TOKEN,
      capabilities: {
        ...full,
        features: { ...full.features, "messages.stream": { resume: "none" } },
      },
      backend,
    });
    await error(
      await none.handle(
        new Request("http://adapter/stream?since=room:1", { headers: bearer }),
      ),
      400,
      "INVALID_REQUEST",
    );
  } finally {
    stop();
  }
});

test("resume failure emits a single safe error then ends and unsubscribes", async () => {
  for (const thrown of [
    new AdapterError("NOT_FOUND", "Synthetic missing cursor"),
    new Error("SYNTHETIC_PRIVATE_ACCOUNT_DATA"),
  ]) {
    const live = liveBackend();
    live.backend.messagesAfter = async () => {
      throw thrown;
    };
    const server = serve({
      token: TOKEN,
      capabilities: full,
      backend: live.backend,
      port: 0,
    });
    try {
      const sse = events(
        await fetch(new URL("/stream?since=room:1", server.url), {
          headers: bearer,
        }),
      );
      await sse.next("ready");
      const body = await sse.next("error");
      expect(body.error.code).toBe(
        thrown instanceof AdapterError ? "NOT_FOUND" : "INTERNAL",
      );
      expect(JSON.stringify(body)).not.toContain(
        "SYNTHETIC_PRIVATE_ACCOUNT_DATA",
      );
      await sse.end();
      expect(live.listeners.size).toBe(0);
    } finally {
      await server.stop(true);
    }
  }
});

test("eight streams allowed, ninth busy; server stop cleans every subscription", async () => {
  const live = liveBackend();
  const server = serve({
    token: TOKEN,
    capabilities: full,
    backend: live.backend,
    port: 0,
  });
  try {
    for (let index = 0; index < 8; index++) {
      const sse = events(
        await fetch(new URL("/stream", server.url), { headers: bearer }),
      );
      const ready = await sse.next("ready");
      expect(ready.resumed).toBe(false);
      expect(ready.cursor).toEqual({});
    }
    expect(live.listeners.size).toBe(8);
    await error(
      await fetch(new URL("/stream", server.url), { headers: bearer }),
      503,
      "BUSY",
    );
  } finally {
    await server.stop(true);
  }
  expect(live.listeners.size).toBe(0);
});

test("quiet stream pings using injectable interval", async () => {
  const live = liveBackend();
  const server = serve({
    token: TOKEN,
    capabilities: full,
    backend: live.backend,
    port: 0,
    pingIntervalMs: 1,
  });
  try {
    const sse = events(
      await fetch(new URL("/stream", server.url), { headers: bearer }),
    );
    await sse.next("ready");
    await sse.next("ping");
  } finally {
    await server.stop(true);
  }
});

test("a quiet stream outlives the server's idle limit and gets its ping", async () => {
  const live = liveBackend();
  const server = serve({
    token: TOKEN,
    capabilities: full,
    backend: live.backend,
    port: 0,
    // Bun's idle timer ticks every 4 s, so idleTimeout 1 closes an idle
    // connection at about 4 s; the ping comes after that.
    idleTimeout: 1,
    pingIntervalMs: 6_000,
  });
  try {
    const sse = events(
      await fetch(new URL("/stream", server.url), { headers: bearer }),
    );
    await sse.next("ready");
    await sse.next("ping");
  } finally {
    await server.stop(true);
  }
}, 15_000);

test("live updates during resume are buffered and overlapping history is deduplicated", async () => {
  const live = liveBackend();
  const entered = deferred<void>();
  const history = deferred<Message[]>();
  live.backend.messagesAfter = async () => {
    entered.resolve();
    return history.promise;
  };
  const server = serve({
    token: TOKEN,
    capabilities: full,
    backend: live.backend,
    port: 0,
  });
  try {
    const sse = events(
      await fetch(new URL("/stream?since=example:room:1", server.url), {
        headers: bearer,
      }),
    );
    await sse.next("ready");
    await bounded(entered.promise, "resume entered");
    live.emit(message);
    live.emit({ ...message, id: "3" });
    const first = sse.next("message");
    history.resolve([message]);
    expect((await first).message.id).toBe("2");
    await sse.next("cursor");
    expect((await sse.next("message")).message.id).toBe("3");
    expect((await sse.next("cursor")).cursor).toEqual({ [room.id]: "3" });
  } finally {
    history.resolve([]);
    await server.stop(true);
  }
});

test("media streams the bytes with headers that never let them run at the client's origin", async () => {
  const seen: { id: string; aborted: boolean }[] = [];
  const live = liveBackend();
  const server = serve({
    token: TOKEN,
    capabilities: full,
    backend: {
      ...live.backend,
      async media(id, signal) {
        seen.push({ id, aborted: signal.aborted });
        if (id === "png")
          return file({ mimeType: "image/png", name: "사진 1.png" });
        if (id === "html")
          return file({
            mimeType: "text/html; charset=utf-8",
            name: 'x"\\\r\n.html',
          });
        if (id === "svg") return file({ mimeType: "image/svg+xml" });
        throw new AdapterError("NOT_FOUND", "No such attachment");
      },
    },
    port: 0,
  });
  try {
    const get = (id: string) =>
      fetch(new URL(`/media?id=${encodeURIComponent(id)}`, server.url), {
        headers: bearer,
      });
    const png = await get("png");
    expect(png.status).toBe(200);
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(bytes);
    expect(Object.fromEntries(png.headers)).toMatchObject({
      "content-type": "image/png",
      "content-disposition":
        "inline; filename=\"__ 1.png\"; filename*=UTF-8''%EC%82%AC%EC%A7%84%201.png",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=86400",
    });
    for (const id of ["html", "svg"]) {
      const response = await get(id);
      await response.arrayBuffer();
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(response.headers.get("content-disposition")).toStartWith(
        "attachment",
      );
      expect(response.headers.get("content-security-policy")).toBe(
        "default-src 'none'; sandbox",
      );
    }
    expect((await get("html")).headers.get("content-disposition")).toBe(
      "attachment; filename=\"x____.html\"; filename*=UTF-8''x%22%5C%0D%0A.html",
    );
    await error(await get("gone"), 404, "NOT_FOUND");
    for (const query of ["", "?id=", `?id=${"a".repeat(513)}`])
      await error(
        await fetch(new URL(`/media${query}`, server.url), { headers: bearer }),
        400,
        "INVALID_REQUEST",
      );
    expect(seen.map(({ id }) => id)).toEqual([
      "png",
      "html",
      "svg",
      "html",
      "gone",
    ]);
    expect(seen.every(({ aborted }) => !aborted)).toBe(true);
  } finally {
    await server.stop(true);
  }
});

test("a reserved feature cannot be declared", () => {
  expect(RESERVED_FEATURES.size).toBeGreaterThan(0);
  for (const id of RESERVED_FEATURES)
    expect(() =>
      createHandler({
        token: TOKEN,
        capabilities: { ...sample, features: { ...sample.features, [id]: {} } },
        backend: fakeBackend(),
      }),
    ).toThrow("reserved");
});

test("a room's features narrow the declaration and never add to it", async () => {
  const backend = fakeBackend();
  const { handle } = createHandler({
    token: TOKEN,
    capabilities: sample,
    backend,
  });
  const rooms = () =>
    handle(new Request("http://adapter/rooms", { headers: bearer }));
  backend.listRooms = async () => ({
    rooms: [
      { ...room, features: { "messages.send": false } },
      {
        ...room,
        id: "narrowed",
        features: { "messages.read": { paging: "none", maxLimit: 10 } },
      },
    ],
    complete: true,
  });
  await answer(await rooms(), "RoomsAnswer");
  backend.listRooms = async () => ({
    rooms: [{ ...room, features: { "messages.stream": false } }],
    complete: true,
  });
  await error(await rooms(), 500, "INTERNAL");
});

function writer() {
  const calls: unknown[][] = [];
  const backend: AdapterBackend = {
    ...fakeBackend(),
    send: async (roomId, text, options) => {
      calls.push(["send", roomId, text, options]);
      return { ...message, roomId, text, fromMe: true, ...options };
    },
    edit: async (roomId, messageId, text) => {
      calls.push(["edit", roomId, messageId, text]);
      return {
        ...message,
        id: messageId,
        roomId,
        text,
        fromMe: true,
        editedAt: "2026-01-01T00:01:00.000Z",
      };
    },
    deleteMessage: async (roomId, messageId) => {
      calls.push(["delete", roomId, messageId]);
    },
    react: async (roomId, messageId, emojis) => {
      calls.push(["react", roomId, messageId, emojis]);
      return emojis.map((emoji) => ({ emoji, count: 1, mine: true }));
    },
    markRead: async (roomId, messageId) => {
      calls.push(["read", roomId, messageId]);
    },
  };
  return { backend, calls };
}
const writes: Capabilities = {
  ...sample,
  features: {
    ...sample.features,
    "messages.send": { maxLength: 4, receipt: "stored" },
    "messages.reply": {},
    "messages.edit": { maxLength: 4, maxAgeSeconds: 60 },
    "messages.delete": { forEveryone: true },
    "reactions.read": {},
    "reactions.send": { maxPerMessage: 1 },
    "read.mark": {},
  },
};
function post(path: string, body: unknown) {
  return new Request(`http://adapter${path}`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
}
function without(
  capabilities: Capabilities,
  ...ids: FeatureId[]
): Capabilities {
  const features = { ...capabilities.features };
  for (const id of ids) delete features[id];
  return { ...capabilities, features };
}

test("a reply, an edit, a delete, reactions and a read mark answer in the contract's shape and reach the backend once each", async () => {
  const { backend, calls } = writer();
  const { handle } = createHandler({
    token: TOKEN,
    capabilities: writes,
    backend,
  });
  const sent = await answer<SendAnswer>(
    await handle(post("/send", { roomId: "r", text: "hi", replyTo: "2" })),
    "SendAnswer",
  );
  expect(sent.message.replyTo).toBe("2");
  await answer(
    await handle(post("/edit", { roomId: "r", messageId: "2", text: "new" })),
    "EditAnswer",
  );
  await answer(
    await handle(post("/delete", { roomId: "r", messageId: "2" })),
    "Done",
  );
  const reacted = await answer<{ reactions: unknown[] }>(
    await handle(
      post("/react", { roomId: "r", messageId: "2", emojis: ["\u{1F44D}"] }),
    ),
    "ReactAnswer",
  );
  expect(reacted.reactions).toEqual([
    { emoji: "\u{1F44D}", count: 1, mine: true },
  ]);
  await answer(
    await handle(post("/react", { roomId: "r", messageId: "2", emojis: [] })),
    "ReactAnswer",
  );
  await answer(
    await handle(post("/read", { roomId: "r", messageId: "2" })),
    "Done",
  );
  expect(calls).toEqual([
    ["send", "r", "hi", { replyTo: "2" }],
    ["edit", "r", "2", "new"],
    ["delete", "r", "2"],
    ["react", "r", "2", ["\u{1F44D}"]],
    ["react", "r", "2", []],
    ["read", "r", "2"],
  ]);
});

test("a write outside its declared limits is refused before the backend, and a reply needs messages.reply", async () => {
  const { backend, calls } = writer();
  const { handle } = createHandler({
    token: TOKEN,
    capabilities: writes,
    backend,
  });
  for (const [path, body] of [
    ["/edit", { roomId: "r", messageId: "2", text: "12345" }],
    ["/edit", { roomId: "r", text: "a" }],
    ["/edit", { roomId: "r", messageId: "", text: "a" }],
    ["/delete", { roomId: "r" }],
    [
      "/react",
      { roomId: "r", messageId: "2", emojis: ["\u{1F44D}", "\u{1F525}"] },
    ],
    [
      "/react",
      { roomId: "r", messageId: "2", emojis: ["\u{1F44D}", "\u{1F44D}"] },
    ],
    ["/react", { roomId: "r", messageId: "2", emojis: [""] }],
    ["/react", { roomId: "r", messageId: "2", emojis: "\u{1F44D}" }],
    ["/read", { roomId: "r", messageId: 2 }],
    ["/send", { roomId: "r", text: "hi", replyTo: "" }],
  ] as const)
    await error(await handle(post(path, body)), 400, "INVALID_REQUEST");
  const plain = createHandler({
    token: TOKEN,
    capabilities: without(writes, "messages.reply"),
    backend,
  });
  await error(
    await plain.handle(
      post("/send", { roomId: "r", text: "hi", replyTo: "2" }),
    ),
    501,
    "NOT_SUPPORTED",
  );
  expect(calls).toEqual([]);
});

test("every write shares one line: four admitted across routes run one at a time, and the next is refused untouched", async () => {
  const { backend } = writer();
  const gates = Array.from({ length: 4 }, () => deferred<void>());
  const entered = Array.from({ length: 4 }, () => deferred<void>());
  let calls = 0;
  let active = 0;
  async function held() {
    const index = calls++;
    expect(++active).toBe(1);
    present(entered[index]).resolve();
    await bounded(present(gates[index]).promise, "write release");
    active--;
  }
  backend.send = async (roomId, text) => {
    await held();
    return { ...message, roomId, text };
  };
  backend.edit = async (roomId, messageId, text) => {
    await held();
    return { ...message, id: messageId, roomId, text };
  };
  backend.deleteMessage = held;
  backend.markRead = held;
  const { handle } = createHandler({
    token: TOKEN,
    capabilities: writes,
    backend,
  });
  const waiting = [
    handle(post("/send", { roomId: "r", text: "a" })),
    handle(post("/edit", { roomId: "r", messageId: "2", text: "b" })),
    handle(post("/delete", { roomId: "r", messageId: "2" })),
    handle(post("/read", { roomId: "r", messageId: "2" })),
  ];
  const fifth = new Request("http://adapter/react", {
    method: "POST",
    headers: jsonHeaders,
  });
  Object.defineProperty(fifth, "json", {
    value: async () => {
      throw new Error("The refused request body was touched");
    },
  });
  await error(
    await bounded(handle(fifth), "fifth refused"),
    429,
    "RATE_LIMITED",
  );
  for (let index = 0; index < 4; index++) {
    await bounded(present(entered[index]).promise, "serialized write entered");
    present(gates[index]).resolve();
  }
  for (const [index, name] of [
    "SendAnswer",
    "EditAnswer",
    "Done",
    "Done",
  ].entries())
    await answer(
      await bounded(present(waiting[index]), "write finished"),
      name,
    );
  expect(calls).toBe(4);
});

test("startup refuses a write without its method, a feature without the one it requires, and an event it cannot send", () => {
  const { backend } = writer();
  for (const method of [
    "edit",
    "deleteMessage",
    "react",
    "markRead",
  ] as const) {
    const missing = { ...backend };
    delete missing[method];
    expect(() =>
      createHandler({ token: TOKEN, capabilities: writes, backend: missing }),
    ).toThrow(/must be declared iff/);
  }
  const { send: _send, ...unsending } = backend;
  expect(() =>
    createHandler({
      token: TOKEN,
      capabilities: without(writes, "messages.send"),
      backend: unsending,
    }),
  ).toThrow(/messages.reply is declared only beside messages.send/);
  expect(() =>
    createHandler({
      token: TOKEN,
      capabilities: without(writes, "reactions.read"),
      backend,
    }),
  ).toThrow(/reactions.send is declared only beside reactions.read/);
  const { messagesAfter: _after, ...streaming } = liveBackend().backend;
  const streamWith = (
    events: string[],
    extra: Capabilities["features"] = {},
  ) => ({
    ...full,
    features: {
      ...full.features,
      ...extra,
      "messages.stream": { resume: "none" as const, events },
    },
  });
  expect(() =>
    createHandler({
      token: TOKEN,
      capabilities: streamWith(["typing"]),
      backend: streaming,
    }),
  ).toThrow(/cannot declare the event typing/);
  expect(() =>
    createHandler({
      token: TOKEN,
      capabilities: streamWith(["reactions.updated"]),
      backend: streaming,
    }),
  ).toThrow(/reactions.updated is declared only beside reactions.read/);
  expect(() =>
    createHandler({
      token: TOKEN,
      capabilities: streamWith(["reactions.updated", "x-example.pinned"], {
        "reactions.read": {},
      }),
      backend: streaming,
    }),
  ).not.toThrow();
});

test("the stream sends declared events in order among messages, moves the cursor only for new messages, and drops undeclared events", async () => {
  const live = liveBackend();
  const capabilities: Capabilities = {
    ...full,
    features: {
      ...full.features,
      "messages.stream": {
        resume: "cursor",
        events: ["message.edited", "message.deleted"],
      },
    },
  };
  const server = serve({
    token: TOKEN,
    capabilities,
    backend: live.backend,
    port: 0,
  });
  try {
    const sse = events(
      await fetch(new URL("/stream", server.url), { headers: bearer }),
    );
    await sse.next("ready");
    const first = sse.next("message");
    live.emit({ ...message, id: "3" });
    expect((await first).message.id).toBe("3");
    expect((await sse.next("cursor")).cursor).toEqual({ [room.id]: "3" });
    const edited: Message = {
      ...message,
      id: "3",
      text: "Synthetic edit",
      editedAt: "2026-01-01T00:01:00.000Z",
    };
    const edit = sse.next("message.edited");
    live.update({
      event: "reactions.updated",
      roomId: room.id,
      messageId: "3",
      reactions: [],
    });
    live.update({ event: "message.edited", message: edited });
    live.update({
      event: "message.deleted",
      roomId: room.id,
      messageIds: ["3"],
    });
    expect((await edit).message).toEqual(edited);
    expect(await sse.next("message.deleted")).toEqual({
      ok: true,
      roomId: room.id,
      messageIds: ["3"],
    });
    const next = sse.next("message");
    live.emit({ ...message, id: "4" });
    expect((await next).message.id).toBe("4");
    expect((await sse.next("cursor")).cursor).toEqual({ [room.id]: "4" });
  } finally {
    await server.stop(true);
  }
});
