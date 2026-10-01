import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { slackApi } from "../adapters/slack/src/api";
import { slackBackend } from "../adapters/slack/src/backend";
import { CAPABILITIES } from "../adapters/slack/src/capabilities";
import { emojiTable } from "../adapters/slack/src/emoji";
import {
  createHandler,
  type StreamUpdate,
} from "../packages/serve-kit/src/index";
import { schema, TOKEN } from "./fixtures";
import { bounded, deferred } from "./harness/barriers";

const USER = "U000000002";
const ROOM = "C000000001";
const ADDRESS = "https://avatars.slack-edge.com/synthetic/avatar-72.png";
const idFor = (address: string) =>
  `avatar:${USER}:${createHash("sha256").update(address).digest("hex").slice(0, 24)}`;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

function fixture(text = "Synthetic") {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  let address: unknown = ADDRESS;
  let userAnswer: (() => Response) | undefined;
  let mediaAnswer = (_url: string) =>
    new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/png" },
    });
  const sent: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    sent.push({ url, init });
    if (url === "https://slack.com/api/users.info")
      return userAnswer
        ? userAnswer()
        : json({
            ok: true,
            user: {
              id: USER,
              profile: { display_name: "Synthetic sender", image_72: address },
            },
          });
    if (url === "https://slack.com/api/users.conversations")
      return json({
        ok: true,
        channels: [{ id: "D000000001", is_im: true, user: USER }],
      });
    if (url === "https://slack.com/api/conversations.history")
      return json({
        ok: true,
        messages: [
          { ts: "1700000000.000001", user: USER, text },
          { ts: "1700000000.000002", user: USER, text: "Synthetic two" },
          {
            ts: "1700000000.000003",
            bot_id: "B000000001",
            username: "Synthetic bot",
            text: "Synthetic bot",
          },
          {
            ts: "1699999999.000001",
            user: USER,
            bot_id: "B000000002",
            text: "Synthetic app",
          },
        ],
      });
    return mediaAnswer(url);
  }) as typeof fetch;
  const backend = slackBackend(
    slackApi("synthetic-slack-secret", fetcher),
    { userId: "U000000001" },
    emojiTable([]),
    {
      onEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    fetcher,
    "synthetic-slack-secret",
  );
  const { readMessages, media } = backend;
  if (!readMessages || !media) throw new Error("Slack methods are missing");
  return {
    backend,
    sent,
    emit(event: Record<string, unknown>) {
      for (const listener of listeners) listener(event);
    },
    setAddress(value: unknown) {
      address = value;
    },
    setUserAnswer(value: () => Response) {
      userAnswer = value;
    },
    setMediaAnswer(value: (url: string) => Response) {
      mediaAnswer = value;
    },
    read: () => readMessages({ roomId: ROOM, limit: 10 }),
    media: (id = idFor(ADDRESS)) => media(id, new AbortController().signal),
  };
}

test("Slack sender avatars share the name lookup, are opaque and URL-versioned; only a bare bot_id has none", async () => {
  const f = fixture();
  try {
    const result = await f.read();
    const messages = result.messages.filter(
      (message) => message.senderId === USER,
    );
    // Two from the person, one from an app posting as its bot user.
    expect(messages).toHaveLength(3);
    for (const message of messages) {
      expect(schema("Message")(message)).toBe(true);
      expect(message.senderAvatar).toBe(idFor(ADDRESS));
      expect(message.senderAvatar?.length).toBeLessThanOrEqual(512);
      expect(message.senderAvatar).not.toContain("https");
    }
    expect(
      result.messages.find((message) => message.senderId === "B000000001")
        ?.senderAvatar,
    ).toBeUndefined();
    expect(
      f.sent.filter((call) => call.url.endsWith("users.info")),
    ).toHaveLength(1);
    f.setAddress("https://avatars.slack-edge.com/synthetic/new-avatar.png");
    await expect(f.media()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      f.sent.filter((call) => !call.url.startsWith("https://slack.com/api/")),
    ).toHaveLength(0);
    expect(
      (await f.read()).messages.find((message) => message.senderId === USER)
        ?.senderAvatar,
    ).toBe(idFor("https://avatars.slack-edge.com/synthetic/new-avatar.png"));
  } finally {
    f.backend.stop();
  }
});

for (const host of [
  "avatars.slack-edge.com",
  "secure.gravatar.com",
  "a.slack-edge.com",
]) {
  test(`Slack avatar media allows ${host} without leaking the Slack token`, async () => {
    const f = fixture();
    const address = `https://${host}/synthetic/avatar.png`;
    f.setAddress(address);
    try {
      const media = await f.media(idFor(address));
      expect(media.mimeType).toBe("image/png");
      expect([
        ...new Uint8Array(await new Response(media.body).arrayBuffer()),
      ]).toEqual([1, 2, 3]);
      const download = f.sent.find((call) => call.url === address);
      expect(download?.init?.redirect).toBe("manual");
      expect(
        new Headers(download?.init?.headers).get("authorization"),
      ).toBeNull();
      expect(JSON.stringify(download)).not.toContain("synthetic-slack-secret");
      expect(new Headers(f.sent[0]?.init?.headers).get("authorization")).toBe(
        "Bearer synthetic-slack-secret",
      );
    } finally {
      f.backend.stop();
    }
  });
}

test("Slack avatar media follows Gravatar's redirect to Slack's default picture, and nowhere else", async () => {
  const gravatar = "https://secure.gravatar.com/avatar/synthetic.jpg";
  const fallback = "https://a.slack-edge.com/synthetic/default.png";
  const photon = "https://i0.wp.com/a.slack-edge.com/synthetic/default.png";
  for (const [location, expected] of [
    [fallback, "served"],
    [photon, "served"],
    ["/avatar/synthetic-next.jpg", "loops"],
    ["https://example.invalid/synthetic.png", "NOT_FOUND"],
    ["http://a.slack-edge.com/synthetic/default.png", "NOT_FOUND"],
  ] as const) {
    const f = fixture();
    f.setAddress(gravatar);
    f.setMediaAnswer((url) =>
      url === fallback || url === photon
        ? new Response(new Uint8Array([4, 5, 6]), {
            headers: { "content-type": "image/png" },
          })
        : new Response(null, { status: 302, headers: { location } }),
    );
    try {
      if (expected === "served") {
        const media = await f.media(idFor(gravatar));
        expect([
          ...new Uint8Array(await new Response(media.body).arrayBuffer()),
        ]).toEqual([4, 5, 6]);
      } else {
        // A relative redirect stays on Gravatar and keeps redirecting: three hops, then none.
        await expect(f.media(idFor(gravatar))).rejects.toMatchObject({
          code: "NOT_FOUND",
        });
      }
      const downloads = f.sent.filter(
        (call) => !call.url.startsWith("https://slack.com/api/"),
      );
      expect(downloads.every((call) => call.init?.redirect === "manual")).toBe(
        true,
      );
      expect(
        downloads.some(
          (call) =>
            !/^https:\/\/(secure\.gravatar\.com|a\.slack-edge\.com|i0\.wp\.com)\//.test(
              call.url,
            ),
        ),
      ).toBe(false);
      if (expected === "loops") expect(downloads).toHaveLength(3);
    } finally {
      f.backend.stop();
    }
  }
  // The image CDN is only Gravatar's next hop: reached from anywhere else it is refused.
  const f = fixture();
  f.setAddress(fallback);
  f.setMediaAnswer((url) =>
    url === photon
      ? new Response(new Uint8Array([7]), {
          headers: { "content-type": "image/png" },
        })
      : new Response(null, { status: 302, headers: { location: photon } }),
  );
  try {
    await expect(f.media(idFor(fallback))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(f.sent.some((call) => call.url === photon)).toBe(false);
  } finally {
    f.backend.stop();
  }
});

for (const address of [
  undefined,
  72,
  "not a URL",
  "http://avatars.slack-edge.com/synthetic.png",
  "https://example.invalid/synthetic.png",
  "https://avatars.slack-edge.com.example.invalid/synthetic.png",
  "https://avatars.slack-edge.com:444/synthetic.png",
  "https://synthetic:password@avatars.slack-edge.com/synthetic.png",
]) {
  test(`Slack omits and refuses an unservable avatar: ${String(address)}`, async () => {
    const f = fixture();
    f.setAddress(address);
    try {
      expect(
        (await f.read()).messages.every(
          (message) => message.senderAvatar === undefined,
        ),
      ).toBe(true);
      await expect(
        f.media(typeof address === "string" ? idFor(address) : idFor(ADDRESS)),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(
        f.sent.every((call) => call.url.startsWith("https://slack.com/api/")),
      ).toBe(true);
    } finally {
      f.backend.stop();
    }
  });
}

test("Slack avatar ids are strictly parsed before any API or download call", async () => {
  const f = fixture();
  try {
    for (const id of [
      "avatar:",
      `avatar:${USER}:abc`,
      `${idFor(ADDRESS)}:extra`,
      `avatar:../${USER}:${"a".repeat(24)}`,
      idFor(ADDRESS).replace(USER, "B000000001"),
      `avatar:${USER}:${"A".repeat(24)}`,
      `${idFor(ADDRESS)}\n`,
    ])
      await expect(f.media(id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.sent).toHaveLength(0);
  } finally {
    f.backend.stop();
  }
});

for (const [status, code] of [
  [401, "REAUTH_REQUIRED"],
  [403, "FORBIDDEN"],
  [404, "NOT_FOUND"],
  [410, "NOT_FOUND"],
  [429, "RATE_LIMITED"],
  [503, "INTERNAL"],
  // A redirect with nowhere allowed to go is no picture, not an unknown outcome.
  [302, "NOT_FOUND"],
] as const) {
  test(`Slack avatar HTTP ${status} maps to ${code}`, async () => {
    const f = fixture();
    f.setMediaAnswer(() => new Response("synthetic refusal", { status }));
    try {
      await expect(f.media()).rejects.toMatchObject({ code });
    } finally {
      f.backend.stop();
    }
  });
}

for (const [answer, code] of [
  [() => json({ ok: false, error: "invalid_auth" }, 401), "REAUTH_REQUIRED"],
  [() => new Response("synthetic slowdown", { status: 429 }), "RATE_LIMITED"],
  [() => new Response("not JSON"), "INTERNAL"],
  [() => json({ ok: true, user: "malformed" }), "INTERNAL"],
  [() => json({ ok: true }), "INTERNAL"],
] as const) {
  test(`Slack avatar user lookup propagates ${code} without silent fallback`, async () => {
    const f = fixture();
    f.setUserAnswer(answer);
    try {
      await expect(f.media()).rejects.toMatchObject({ code });
      const result = await f.read();
      for (const message of result.messages.filter(
        (message) => message.senderId === USER,
      )) {
        expect(message.sender).toBe(USER);
        expect(message.senderAvatar).toBeUndefined();
      }
      expect(
        f.sent.every((call) => call.url.startsWith("https://slack.com/api/")),
      ).toBe(true);
    } finally {
      f.backend.stop();
    }
  });
}

for (const answer of [
  () =>
    new Response("<html>synthetic</html>", {
      headers: { "content-type": "text/html" },
    }),
  () => new Response(null),
  () => {
    throw new TypeError("synthetic redirect or network failure");
  },
]) {
  test("Slack avatar malformed media and fetch failures are INTERNAL", async () => {
    const f = fixture();
    f.setMediaAnswer(answer);
    try {
      await expect(f.media()).rejects.toMatchObject({ code: "INTERNAL" });
    } finally {
      f.backend.stop();
    }
  });
}

for (const [answer, code] of [
  [() => new Response("synthetic slowdown", { status: 429 }), "RATE_LIMITED"],
  [() => json({ ok: false, error: "user_not_found" }), "NOT_FOUND"],
] as const) {
  test(`Slack ${code} profile failures preserve messages, stream events and DM rooms`, async () => {
    const text = "Synthetic <@W000000003>";
    const f = fixture(text);
    f.setUserAnswer(answer);
    const streamed = deferred<StreamUpdate>();
    const unsubscribe = f.backend.subscribe?.((update) =>
      streamed.resolve(update),
    );
    try {
      const result = await f.read();
      expect(result.messages).toHaveLength(4);
      for (const message of result.messages.filter(
        (message) => message.senderId === USER,
      )) {
        expect(message.sender).toBe(USER);
        expect(message.senderAvatar).toBeUndefined();
      }
      expect(
        result.messages.find((message) => message.id === "1700000000.000001")
          ?.text,
      ).toBe("Synthetic @W000000003");
      const rooms = await f.backend.listRooms?.();
      expect(rooms?.rooms).toEqual([
        { id: "D000000001", kind: "direct", title: USER, unread: 0 },
      ]);
      f.emit({
        type: "message",
        channel: ROOM,
        ts: "1700000000.000004",
        user: USER,
        text,
      });
      const update = await bounded(
        streamed.promise,
        "Slack message with unreadable profile",
      );
      expect(update).toMatchObject({
        event: "message",
        message: { sender: USER, text: "Synthetic @W000000003" },
      });
      if (update.event !== "message")
        throw new Error("Expected a message update");
      expect(update.message.senderAvatar).toBeUndefined();
      await expect(f.media()).rejects.toMatchObject({ code });
    } finally {
      unsubscribe?.();
      f.backend.stop();
    }
  });
}

test("Slack display lookups do not swallow programming errors", async () => {
  const failure = new TypeError("synthetic programming failure");
  const backend = slackBackend(
    async (method) => {
      if (method === "users.info") throw failure;
      if (method === "users.conversations")
        return {
          channels: [{ id: "D000000001", is_im: true, user: USER }],
        } as never;
      if (method === "conversations.history")
        return {
          messages: [
            { ts: "1700000000.000001", user: USER, text: "Synthetic" },
          ],
        } as never;
      throw new Error(`Unexpected synthetic method: ${method}`);
    },
    { userId: "U000000001" },
    emojiTable([]),
    { onEvent: () => () => {} },
  );
  try {
    await expect(
      backend.readMessages?.({ roomId: ROOM, limit: 10 }),
    ).rejects.toBe(failure);
    await expect(backend.listRooms?.()).rejects.toBe(failure);
  } finally {
    backend.stop();
  }
});

test("Slack avatars work through the real HTTP handler with private cache and capability declaration", async () => {
  const f = fixture();
  const handler = createHandler({
    token: TOKEN,
    capabilities: CAPABILITIES,
    backend: f.backend,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: handler.handle,
  });
  try {
    const caps = await fetch(new URL("/capabilities", server.url), {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(JSON.stringify(await caps.json())).toContain('"avatars.read":{}');
    const result = await f.read();
    const avatar = result.messages.find(
      (message) => message.senderId === USER,
    )?.senderAvatar;
    if (!avatar) throw new Error("Slack sender avatar is missing");
    const response = await fetch(
      new URL(`/media?id=${encodeURIComponent(avatar)}`, server.url),
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("private");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
      1, 2, 3,
    ]);
  } finally {
    server.stop(true);
    handler.stop();
    f.backend.stop();
  }
});
