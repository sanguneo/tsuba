import { expect, test } from "bun:test";
import { discordUserBackend } from "../adapters/discord-user/src/backend";
import { CAPABILITIES } from "../adapters/discord-user/src/capabilities";
import {
  createHandler,
  type RoomsAnswer,
  type StreamUpdate,
} from "../packages/serve-kit/src/index";
import { bounded, deferred } from "./harness/barriers";

function present<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Missing test value");
  return value;
}

const ROOM = "100000000000000001";
const ID = "100000000000000002";
const USER = "100000000000000003";
const ATTACHMENT = "100000000000000004";
const headers = {
  authorization: "Bearer synthetic-adapter-token",
  "content-type": "application/json",
};
const rawUser = { id: USER, username: "Synthetic" };
function rawMessage(messageId = ID, extra: Record<string, unknown> = {}) {
  return {
    id: messageId,
    channel_id: ROOM,
    author: rawUser,
    content: "Synthetic text",
    timestamp: "2026-01-01T00:00:00.000Z",
    type: 0,
    attachments: [],
    ...extra,
  };
}
function json(value: unknown) {
  return Response.json(value);
}
type Call = { url: URL; options: RequestInit };
function fakeFetch(action: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fake: typeof fetch = Object.assign(
    async (input: string | URL | Request, options: RequestInit = {}) => {
      const call = {
        url: new URL(input instanceof Request ? input.url : input),
        options,
      };
      calls.push(call);
      return action(call);
    },
    { preconnect() {} },
  );
  return { fake, calls };
}
function setup(action: (call: Call) => Response | Promise<Response>) {
  const transport = fakeFetch((call) =>
    call.url.pathname === "/api/v9/users/@me" ? json(rawUser) : action(call),
  );
  const backend = discordUserBackend("synthetic", transport.fake);
  const handler = createHandler({
    token: "synthetic-adapter-token",
    capabilities: CAPABILITIES,
    backend,
  });
  return { ...transport, backend, ...handler };
}
function post(path: string, body: unknown) {
  return new Request(`http://adapter${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
function get(path: string) {
  return new Request(`http://adapter${path}`, { headers });
}
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ ok: false, error: { code } });
}
function reaction(name: string, mine = true, customId: string | null = null) {
  return { emoji: { id: customId, name }, count: 1, me: mine };
}

test("read marks propagate Discord refusals instead of reporting success", async () => {
  const { handle } = setup(() => new Response(null, { status: 429 }));
  await error(
    await handle(post("/read", { roomId: ROOM, messageId: ID })),
    429,
    "RATE_LIMITED",
  );
});

test("real REST status, fetch and malformed JSON failures cross the route boundary safely", async () => {
  for (const [status, expected, code] of [
    [400, 400, "INVALID_REQUEST"],
    [401, 503, "REAUTH_REQUIRED"],
    [403, 403, "FORBIDDEN"],
    [404, 404, "NOT_FOUND"],
    [429, 429, "RATE_LIMITED"],
    [503, 500, "INTERNAL"],
  ] as const) {
    const { handle } = setup(() => new Response(null, { status }));
    await error(await handle(get(`/messages?roomId=${ROOM}`)), expected, code);
  }
  for (const action of [
    () => new Response("{"),
    () => json([{}]),
    () => {
      throw new Error("SYNTHETIC_PRIVATE");
    },
  ]) {
    const { handle } = setup(action);
    const response = await handle(get(`/messages?roomId=${ROOM}`));
    const text = await response.clone().text();
    await error(response, 500, "INTERNAL");
    expect(text).not.toContain("SYNTHETIC_PRIVATE");
  }
  const transport = fakeFetch(() => json({ id: USER }));
  const backend = discordUserBackend("synthetic", transport.fake);
  await expect(present(backend.listRooms)()).rejects.toMatchObject({
    code: "INTERNAL",
  });
});

test("replace the entire Unicode mine set: removals first, additions second, empty clears", async () => {
  let reads = 0;
  const { backend, calls } = setup(({ options }) => {
    if (options.method) return new Response(null, { status: 204 });
    return json(
      rawMessage(ID, {
        reactions:
          reads++ === 0
            ? [
                reaction("👍"),
                reaction("🔥"),
                reaction("custom", true, ATTACHMENT),
              ]
            : [reaction("🎉"), reaction("❤️")],
      }),
    );
  });
  expect(await present(backend.react)(ROOM, ID, ["🎉", "❤️"])).toEqual([
    { emoji: "🎉", count: 1, mine: true },
    { emoji: "❤️", count: 1, mine: true },
  ]);
  expect(
    calls
      .filter(({ options }) => options.method)
      .map(({ url, options }) => [
        options.method,
        decodeURIComponent(present(url.pathname.split("/").at(-2))),
      ]),
  ).toEqual([
    ["DELETE", "👍"],
    ["DELETE", "🔥"],
    ["PUT", "🎉"],
    ["PUT", "❤️"],
  ]);
  calls.length = 0;
  await present(backend.react)(ROOM, ID, []);
  expect(
    calls
      .filter(({ options }) => options.method)
      .map(({ options }) => options.method),
  ).toEqual(["DELETE", "DELETE"]);
});

test("reaction-kind limit is checked before writing, including retained custom kinds", async () => {
  const { backend, calls } = setup(() =>
    json(
      rawMessage(ID, {
        reactions: Array.from({ length: 20 }, (_, index) =>
          reaction(
            `custom${index}`,
            false,
            String(BigInt(ATTACHMENT) + BigInt(index)),
          ),
        ),
      }),
    ),
  );
  await expect(present(backend.react)(ROOM, ID, ["👍"])).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  expect(calls.some(({ options }) => options.method)).toBe(false);
});

test("shared mine reactions still count toward the distinct-kind limit after removal", async () => {
  const { backend, calls } = setup(() =>
    json(
      rawMessage(ID, {
        reactions: [
          { ...reaction("👍"), count: 2 },
          ...Array.from({ length: 19 }, (_, index) =>
            reaction(
              `custom${index}`,
              false,
              String(BigInt(ATTACHMENT) + BigInt(index)),
            ),
          ),
        ],
      }),
    ),
  );
  await expect(present(backend.react)(ROOM, ID, ["🔥"])).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  expect(calls.some(({ options }) => options.method)).toBe(false);
});

test("reaction first-write refusal stays explicit; partial changes and reread failures are unknown", async () => {
  for (const failure of ["first", "second", "reread"] as const) {
    let reads = 0,
      writes = 0;
    const { handle } = setup(({ options }) => {
      if (options.method) {
        writes++;
        if (
          (failure === "first" && writes === 1) ||
          (failure === "second" && writes === 2)
        )
          return new Response(null, { status: 403 });
        return new Response(null, { status: 204 });
      }
      if (++reads === 2 && failure === "reread") return new Response("{");
      return json(rawMessage(ID, { reactions: [reaction("👍")] }));
    });
    const response = await handle(
      post("/react", { roomId: ROOM, messageId: ID, emojis: ["🔥"] }),
    );
    if (failure === "first") await error(response, 403, "FORBIDDEN");
    else {
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        error: { code: "INTERNAL" },
      });
    }
  }
});

test("readMessages probes before the oldest id rather than guessing from a full page", async () => {
  for (const earlier of [false, true]) {
    const { backend, calls } = setup(({ url }) =>
      url.searchParams.has("before")
        ? json(earlier ? [rawMessage("100000000000000000")] : [])
        : json([rawMessage(ID), rawMessage(ROOM)]),
    );
    const result = await present(backend.readMessages)({
      roomId: ROOM,
      limit: 2,
    });
    expect(result.messages.map(({ id }) => id)).toEqual([ROOM, ID]);
    expect(result.hasEarlier).toBe(earlier);
    expect(calls.at(-1)?.url.searchParams.get("before")).toBe(ROOM);
    expect(calls.at(-1)?.url.searchParams.get("limit")).toBe("1");
  }
});

test("messagesAfter verifies the cursor and drains 100-message pages in numeric ascending order", async () => {
  const ids = Array.from({ length: 101 }, (_, index) =>
    String(BigInt(ID) + BigInt(index + 1)),
  );
  const { backend, calls } = setup(({ url }) => {
    if (!url.search) return json(rawMessage());
    return json(
      (url.searchParams.get("after") === ID
        ? ids.slice(0, 100).reverse()
        : ids.slice(100)
      ).map((id) => rawMessage(id)),
    );
  });
  expect(
    (await present(backend.messagesAfter)(ROOM, ID)).map(({ id }) => id),
  ).toEqual(ids);
  expect(calls[1]?.url.pathname).toBe(
    `/api/v9/channels/${ROOM}/messages/${ID}`,
  );
  expect(calls[3]?.url.searchParams.get("after")).toBe(ids[99]);
  const gone = setup(() => new Response(null, { status: 404 }));
  await expect(
    present(gone.backend.messagesAfter)(ROOM, ID),
  ).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(gone.calls.length).toBe(2);
});

test("all path ids reject before fetch, including before, after and reply", async () => {
  const { backend, calls, handle } = setup(() => {
    throw new Error("Must not fetch");
  });
  for (const invoke of [
    () => present(backend.readMessages)({ roomId: "../bad", limit: 1 }),
    () => present(backend.messagesAfter)("bad", ID),
    () => present(backend.send)("bad", "hi", {}),
    () => present(backend.edit)("bad", ID, "hi"),
    () => present(backend.deleteMessage)("bad", ID),
    () => present(backend.react)("bad", ID, []),
    () => present(backend.markRead)("bad", ID),
  ])
    await expect(invoke()).rejects.toMatchObject({ code: "NOT_FOUND" });
  for (const invoke of [
    () =>
      present(backend.readMessages)({
        roomId: ROOM,
        limit: 1,
        before: "../bad",
      }),
    () => present(backend.messagesAfter)(ROOM, "bad"),
    () => present(backend.send)(ROOM, "hi", { replyTo: "bad" }),
    () => present(backend.edit)(ROOM, "bad", "hi"),
    () => present(backend.deleteMessage)(ROOM, "bad"),
    () => present(backend.react)(ROOM, "bad", []),
    () => present(backend.markRead)(ROOM, "bad"),
  ])
    await expect(invoke()).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await error(
    await handle(post("/send", { roomId: ROOM, text: "😀".repeat(1001) })),
    400,
    "INVALID_REQUEST",
  );
  expect(calls).toHaveLength(0);
});

test("send/edit suppress role and everyone mentions, fail missing replies, and accept 1000 codepoints", async () => {
  const { handle, calls } = setup(() => json(rawMessage()));
  expect(
    (
      await handle(
        post("/send", { roomId: ROOM, text: "😀".repeat(1000), replyTo: ID }),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await handle(
        post("/edit", { roomId: ROOM, messageId: ID, text: "Synthetic edit" }),
      )
    ).status,
  ).toBe(200);
  const bodies = calls
    .filter(({ options }) => options.body)
    .map(({ options }) => JSON.parse(String(options.body)));
  expect(bodies[0]).toMatchObject({
    allowed_mentions: { parse: ["users"], replied_user: true },
    message_reference: { message_id: ID, fail_if_not_exists: true },
  });
  expect(bodies[1]).toMatchObject({
    allowed_mentions: { parse: ["users"], replied_user: true },
  });
});

test("media ids are strict and CDN fetches use HTTPS whitelist and redirect:error", async () => {
  const signal = new AbortController().signal;
  for (const url of [
    "http://cdn.discordapp.com/a",
    "https://example.invalid/a",
    "not a URL",
    "https://cdn.discordapp.com.attacker.invalid/a",
  ]) {
    const { backend, calls } = setup(() =>
      json(
        rawMessage(ID, {
          attachments: [
            { id: ATTACHMENT, filename: "synthetic.txt", size: 5, url },
          ],
        }),
      ),
    );
    for (const mediaId of [
      "bad",
      `${ROOM}:${ID}:${ATTACHMENT}:extra`,
      `${ROOM}:${ID}:4`,
    ])
      await expect(
        present(backend.media)(mediaId, signal),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    expect(calls.length).toBe(0);
    await expect(
      present(backend.media)(`${ROOM}:${ID}:${ATTACHMENT}`, signal),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.length).toBe(2);
  }
  const { backend, calls } = setup(({ url }) =>
    url.hostname === "cdn.discordapp.com"
      ? new Response("bytes")
      : json(
          rawMessage(ID, {
            attachments: [
              {
                id: ATTACHMENT,
                filename: "synthetic.txt",
                size: 5,
                url: "https://cdn.discordapp.com/a",
                content_type: "text/plain",
              },
            ],
          }),
        ),
  );
  const media = await present(backend.media)(
    `${ROOM}:${ID}:${ATTACHMENT}`,
    signal,
  );
  expect(await new Response(media.body).text()).toBe("bytes");
  expect(calls.at(-1)?.options).toMatchObject({ signal, redirect: "error" });
  expect(calls.at(-1)?.options.headers).toBeUndefined();
});

test("CDN HTTP and network errors use the central error mapper", async () => {
  for (const failure of [401, 429, "network"] as const) {
    const { backend } = setup(({ url }) => {
      if (url.hostname === "media.discordapp.net") {
        if (failure === "network") throw new Error("Synthetic network failure");
        return new Response(null, { status: failure });
      }
      return json(
        rawMessage(ID, {
          attachments: [
            {
              id: ATTACHMENT,
              filename: "synthetic.txt",
              size: 5,
              url: "https://media.discordapp.net/a",
            },
          ],
        }),
      );
    });
    await expect(
      present(backend.media)(
        `${ROOM}:${ID}:${ATTACHMENT}`,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code:
        failure === 401
          ? "REAUTH_REQUIRED"
          : failure === 429
            ? "RATE_LIMITED"
            : "INTERNAL",
    });
  }
});

test("listRooms keeps successful guilds, marks partials, and fetches 200-codepoint previews", async () => {
  const { handle } = setup(({ url }) => {
    if (url.pathname.endsWith("/users/@me/channels"))
      return json([
        { id: ROOM, type: 1, recipients: [rawUser], last_message_id: ID },
      ]);
    if (url.pathname.endsWith("/users/@me/guilds"))
      return json([
        { id: ID, name: "Synthetic guild" },
        { id: USER, name: "Unavailable guild" },
      ]);
    if (url.pathname.endsWith(`/guilds/${USER}/channels`))
      return new Response(null, { status: 403 });
    if (url.pathname.endsWith(`/guilds/${ID}/channels`))
      return json([{ id: ATTACHMENT, type: 0, name: "synthetic" }]);
    expect(url.searchParams.get("limit")).toBe("1");
    return json([rawMessage(ID, { content: "😀".repeat(201) })]);
  });
  const response = await handle(get("/rooms"));
  expect(response.status).toBe(200);
  const answer = (await response.json()) as RoomsAnswer;
  expect(answer.complete).toBe(false);
  expect(answer.rooms).toHaveLength(2);
  expect(
    answer.rooms.find((room: { id: string }) => room.id === ROOM),
  ).toMatchObject({
    unread: 0,
    lastMessage: { text: "😀".repeat(200), fromMe: true },
  });
});

test("listRooms guild requests have bounded concurrency and cap results at 500", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let active = 0,
    peak = 0,
    requests = 0;
  const { backend } = setup(async ({ url }) => {
    if (url.pathname.endsWith("/users/@me/channels"))
      return json(
        Array.from({ length: 501 }, (_, index) => ({
          id: String(BigInt(ROOM) + BigInt(index)),
          type: 3,
          name: `Synthetic ${index}`,
        })),
      );
    if (url.pathname.endsWith("/users/@me/guilds"))
      return json(
        Array.from({ length: 8 }, (_, index) => ({
          id: String(BigInt(ROOM) + BigInt(index)),
          name: "Synthetic guild",
        })),
      );
    active++;
    requests++;
    peak = Math.max(peak, active);
    if (active === 4) entered.resolve();
    await bounded(release.promise, "release guild fetches");
    active--;
    return json([]);
  });
  const result = present(backend.listRooms)();
  try {
    await bounded(entered.promise, "four guild fetches entered");
    expect(requests).toBe(4);
  } finally {
    release.resolve();
  }
  const answer = await result;
  expect(peak).toBe(4);
  expect(requests).toBe(8);
  expect(answer.rooms).toHaveLength(500);
  expect(answer.complete).toBe(false);
});

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  closedSignal = deferred<void>();
  constructor() {
    FakeSocket.instances.push(this);
  }
  send(_data: string) {}
  close() {
    this.closed = true;
    this.closedSignal.resolve();
    this.onclose?.();
  }
  frame(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}
async function sockets(action: () => Promise<void>) {
  const original = globalThis.WebSocket;
  FakeSocket.instances = [];
  Object.defineProperty(globalThis, "WebSocket", {
    value: FakeSocket,
    configurable: true,
  });
  try {
    await action();
  } finally {
    Object.defineProperty(globalThis, "WebSocket", {
      value: original,
      configurable: true,
    });
  }
}

test("constructor and REST checks never connect; first subscribe starts, last unsubscribe stops", async () => {
  await sockets(async () => {
    const { backend } = setup(({ url }) =>
      url.pathname.endsWith("/messages") ? json([]) : json([]),
    );
    expect(FakeSocket.instances).toHaveLength(0);
    await present(backend.listRooms)();
    expect(FakeSocket.instances).toHaveLength(0);
    const a = present(backend.subscribe)(() => {}),
      b = present(backend.subscribe)(() => {});
    expect(FakeSocket.instances).toHaveLength(1);
    const socket = present(FakeSocket.instances[0]);
    a();
    expect(socket.closed).toBe(false);
    b();
    expect(socket.closed).toBe(true);
    const c = present(backend.subscribe)(() => {});
    expect(FakeSocket.instances).toHaveLength(2);
    c();
  });
});

test("Gateway CREATE before READY obtains identity and partial UPDATE fetches the full message", async () => {
  await sockets(async () => {
    const { backend, calls } = setup(() =>
      json(rawMessage(ID, { content: "Synthetic edit" })),
    );
    const created = deferred<StreamUpdate>(),
      edited = deferred<StreamUpdate>();
    const unsubscribe = present(backend.subscribe)((update) => {
      if (update.event === "message") created.resolve(update);
      if (update.event === "message.edited") edited.resolve(update);
    });
    try {
      const socket = present(FakeSocket.instances[0]);
      socket.frame({ op: 0, t: "MESSAGE_CREATE", d: rawMessage() });
      expect(await bounded(created.promise, "pre-READY message")).toMatchObject(
        { event: "message", message: { id: ID, fromMe: true } },
      );
      socket.frame({ op: 0, t: "READY", d: { user: rawUser } });
      socket.frame({
        op: 0,
        t: "MESSAGE_UPDATE",
        d: { id: ID, channel_id: ROOM },
      });
      expect(
        await bounded(edited.promise, "partial update fetch"),
      ).toMatchObject({
        event: "message.edited",
        message: { text: "Synthetic edit" },
      });
      expect(calls.at(-1)?.url.pathname).toBe(
        `/api/v9/channels/${ROOM}/messages/${ID}`,
      );
    } finally {
      unsubscribe();
    }
  });
});

test("malformed Gateway envelopes and dispatches close instead of emitting unchecked data", async () => {
  await sockets(async () => {
    for (const payload of [
      { op: "bad" },
      { op: 0, t: "MESSAGE_CREATE", d: { id: ID } },
    ]) {
      const { backend } = setup(() => json([]));
      const updates: StreamUpdate[] = [];
      const unsubscribe = present(backend.subscribe)((update) =>
        updates.push(update),
      );
      try {
        const socket = present(FakeSocket.instances.at(-1));
        socket.frame(payload);
        await bounded(socket.closedSignal.promise, "invalid Gateway closes");
        expect(updates).toEqual([]);
      } finally {
        unsubscribe();
      }
    }
  });
});

function upload(parts: Record<string, string | File>) {
  const body = new FormData();
  for (const [name, value] of Object.entries(parts)) body.append(name, value);
  return new Request("http://adapter/upload", {
    method: "POST",
    headers: { authorization: headers.authorization },
    body,
  });
}
const picture = () =>
  new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });

test("an upload is one multipart message with caption, reply and file, answered as stored", async () => {
  const { handle, calls } = setup(({ options }) =>
    options.method === "POST"
      ? json(
          rawMessage(ID, {
            author: rawUser,
            content: "caption",
            attachments: [
              {
                id: ATTACHMENT,
                url: "https://cdn.discordapp.com/attachments/a.png",
                filename: "a.png",
                size: 3,
                content_type: "image/png",
              },
            ],
          }),
        )
      : json(rawMessage()),
  );
  const response = await handle(
    upload({ roomId: ROOM, file: picture(), caption: "caption", replyTo: ID }),
  );
  expect(response.status).toBe(200);
  const answer = (await response.json()) as {
    message: { id: string; fromMe: boolean; attachments?: unknown[] };
  };
  expect(answer.message).toMatchObject({ id: ID, fromMe: true });
  expect(answer.message.attachments).toHaveLength(1);
  const sent = calls.filter(({ options }) => options.method === "POST");
  expect(sent).toHaveLength(1);
  const call = present(sent[0]);
  expect(call.url.pathname).toBe(`/api/v9/channels/${ROOM}/messages`);
  // fetch sets the multipart boundary itself; a fixed content type would break it.
  expect(new Headers(call.options.headers).has("content-type")).toBe(false);
  const form = call.options.body as FormData;
  expect(JSON.parse(String(form.get("payload_json")))).toEqual({
    content: "caption",
    attachments: [{ id: 0, filename: "a.png" }],
    allowed_mentions: { parse: ["users"], replied_user: true },
    message_reference: { message_id: ID, fail_if_not_exists: true },
  });
  const file = form.get("files[0]") as File;
  expect(file.name).toBe("a.png");
  expect(file.type).toBe("image/png");
  expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3]);
});

test("Discord's refusals of a file keep their codes, and anything else is unknown", async () => {
  for (const [status, expected, code] of [
    [413, 400, "INVALID_REQUEST"],
    [403, 403, "FORBIDDEN"],
    [429, 429, "RATE_LIMITED"],
    [502, 500, "INTERNAL"],
  ] as const) {
    const { handle } = setup(() => new Response(null, { status }));
    await error(
      await handle(upload({ roomId: ROOM, file: picture() })),
      expected,
      code,
    );
  }
  const { handle, calls } = setup(() => json(rawMessage()));
  await error(
    await handle(upload({ roomId: "not-a-channel", file: picture() })),
    404,
    "NOT_FOUND",
  );
  expect(calls.some(({ options }) => options.method === "POST")).toBe(false);
});
