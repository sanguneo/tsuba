import { expect, test } from "bun:test";
import contract from "../contract/openapi.json";
import {
  type AdapterBackend,
  AdapterError,
  type Capabilities,
  createHandler,
  type ErrorEnvelope,
  type MediaFile,
  type Message,
  RESERVED_FEATURES,
  type SendAnswer,
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
  const listeners = new Set<(message: Message) => void>();
  let cleanup = deferred<void>();
  return {
    backend: {
      ...fakeBackend(),
      media: async () => file({ mimeType: "image/png" }),
      messagesAfter: async () => [message],
      subscribe(listener: (message: Message) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
          cleanup.resolve();
        };
      },
    } satisfies AdapterBackend,
    listeners,
    emit(value: Message) {
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
    ["/media", "/messages", "/rooms", "/send", "/stream"].sort(),
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
