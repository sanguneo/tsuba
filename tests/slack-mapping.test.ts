import { expect, test } from "bun:test";
import { type SlackCall, slackApi } from "../adapters/slack/src/api";
import { slackBackend } from "../adapters/slack/src/backend";
import { emojiTable } from "../adapters/slack/src/emoji";
import {
  fromSlackText,
  groupDmTitle,
  mapSlackFile,
  mapSlackMessage,
  mapSlackRoom,
  mentionedUsers,
  slackTime,
  threadOnly,
  toSlackText,
} from "../adapters/slack/src/mapping";
import { readEnvelope } from "../adapters/slack/src/socket";
import { AdapterError } from "../packages/serve-kit/src/index";
import { schema } from "./fixtures";
import { bounded, deferred } from "./harness/barriers";

const emoji = emojiTable([
  {
    unified: "1F44D",
    short_names: ["+1", "thumbsup"],
    skin_variations: { "1F3FB": { unified: "1F44D-1F3FB" } },
  },
  { unified: "2764-FE0F", short_names: ["heart"] },
]);
const SELF = "U000000001";
const ROOM = "C0000000001";

test("emoji go both ways, with skin tones and with or without the presentation selector", () => {
  expect(emoji.toUnicode("+1")).toBe("\u{1F44D}");
  expect(emoji.toUnicode("thumbsup::skin-tone-2")).toBe("\u{1F44D}\u{1F3FB}");
  expect(emoji.toUnicode("synthetic-custom")).toBeUndefined();
  expect(emoji.toName("\u{1F44D}")).toBe("+1");
  expect(emoji.toName("\u{1F44D}\u{1F3FB}")).toBe("+1::skin-tone-2");
  expect(emoji.toName("\u2764")).toBe("heart");
  expect(emoji.toName("\u2764\uFE0F")).toBe("heart");
  expect(emoji.toName("\u{1F984}")).toBeUndefined();
});

test("Slack timestamps become RFC 3339; a malformed one becomes nothing", () => {
  expect(slackTime("1700000000.123456")).toBe("2023-11-14T22:13:20.123Z");
  expect(slackTime("not-a-ts")).toBeUndefined();
});

test("mrkdwn reads as plain text and text from saya is escaped", () => {
  const names = {
    user: (id: string) => (id === "U0000000002" ? "Synthetic Two" : undefined),
  };
  expect(mentionedUsers("hi <@U0000000002> and <@W0000000003|x>")).toEqual([
    "U0000000002",
    "W0000000003",
  ]);
  expect(
    fromSlackText(
      "<@U0000000002> see <#C0000000009|general>, <!here>, <https://example.invalid/a|the doc>, <https://example.invalid/b> &amp; 1 &lt; 2",
      names,
    ),
  ).toBe(
    "@Synthetic Two see #general, @here, the doc (https://example.invalid/a), https://example.invalid/b & 1 < 2",
  );
  expect(fromSlackText("<@U0000000099>", names)).toBe("@U0000000099");
  expect(toSlackText("a < b & c > <!channel>")).toBe(
    "a &lt; b &amp; c &gt; &lt;!channel&gt;",
  );
});

test("rooms: DMs are direct, the rest are groups; unknown counts are 0 and a closed DM cannot be written to", () => {
  const dm = mapSlackRoom(
    { id: "D0000000001", is_im: true, user: "U0000000002" },
    "Synthetic Two",
    undefined,
    true,
  );
  expect(schema("Room")(dm)).toBe(true);
  expect(dm).toEqual({
    id: "D0000000001",
    title: "Synthetic Two",
    kind: "direct",
    unread: 0,
  });
  const channel = mapSlackRoom(
    { id: ROOM, name: "general" },
    "#general",
    {
      unread: 3,
      latestTs: "1700000000.000100",
      latestText: "Synthetic",
      latestFromMe: true,
    },
    false,
  );
  expect(schema("Room")(channel)).toBe(true);
  expect(channel).toMatchObject({
    kind: "group",
    unread: 3,
    lastActivityAt: "2023-11-14T22:13:20.000Z",
    lastMessage: { text: "Synthetic", fromMe: true },
    features: { "messages.send": false },
  });
  expect(groupDmTitle("mpdm-synth-a--synth-b--self-1", "self")).toBe(
    "synth-a, synth-b",
  );
});

test("messages: subtypes, threads, files and reactions map to the contract", () => {
  const base = {
    ts: "1700000000.000200",
    user: "U0000000002",
    text: "Synthetic",
  };
  const context = {
    selfId: SELF,
    sender: "Synthetic Two",
    text: "Synthetic",
    emoji,
  };
  const plain = mapSlackMessage(ROOM, base, context);
  expect(schema("Message")(plain)).toBe(true);
  expect(plain).toEqual({
    id: base.ts,
    roomId: ROOM,
    senderId: "U0000000002",
    sender: "Synthetic Two",
    text: "Synthetic",
    kind: "text",
    sentAt: "2023-11-14T22:13:20.000Z",
    fromMe: false,
  });
  expect(
    mapSlackMessage(ROOM, { ...base, subtype: "channel_join" }, context).kind,
  ).toBe("service");
  expect(
    mapSlackMessage(
      ROOM,
      { ...base, subtype: "thread_broadcast", thread_ts: "1700000000.000100" },
      context,
    ),
  ).toMatchObject({ kind: "text", replyTo: "1700000000.000100" });
  expect(threadOnly({ ...base, thread_ts: "1700000000.000100" })).toBe(true);
  expect(threadOnly({ ...base, thread_ts: base.ts })).toBe(false);
  const rich = mapSlackMessage(
    ROOM,
    {
      ...base,
      user: SELF,
      edited: { ts: "1700000001.000000" },
      files: [
        {
          id: "F0000000001",
          name: "picture.png",
          mimetype: "image/png",
          size: 10,
          original_w: 4,
          original_h: 3,
        },
        {
          id: "F0000000002",
          name: "clip.m4a",
          mimetype: "audio/mp4",
          subtype: "slack_audio",
          duration_ms: 2500,
        },
        { id: "F0000000003", mode: "tombstone" },
      ],
      reactions: [
        { name: "+1", count: 2, users: [SELF, "U0000000002"] },
        { name: "synthetic-custom", count: 1, users: [] },
      ],
    },
    context,
  );
  expect(schema("Message")(rich)).toBe(true);
  expect(rich).toMatchObject({
    kind: "media",
    fromMe: true,
    editedAt: "2023-11-14T22:13:21.000Z",
    reactions: [{ emoji: "\u{1F44D}", count: 2, mine: true }],
  });
  expect(rich.attachments).toEqual([
    {
      id: `${ROOM}:${base.ts}:F0000000001`,
      kind: "image",
      name: "picture.png",
      mimeType: "image/png",
      size: 10,
      width: 4,
      height: 3,
    },
    {
      id: `${ROOM}:${base.ts}:F0000000002`,
      kind: "voice",
      name: "clip.m4a",
      mimeType: "audio/mp4",
      durationSeconds: 2.5,
    },
  ]);
  expect(
    mapSlackFile(ROOM, base.ts, { id: "F1", mode: "hidden_by_limit" }),
  ).toBeNull();
});

function fakeFetch(answers: Response[]) {
  const sent: { url: string; headers: Headers; body: string }[] = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    sent.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
    });
    const answer = answers.shift();
    if (!answer) throw new TypeError("network down");
    return answer;
  }) as unknown as typeof fetch;
  return { fetcher, sent };
}

test("the API client keeps the token in the header and maps what Slack says into codes", async () => {
  const token = "synthetic-slack-token";
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });
  const { fetcher, sent } = fakeFetch([
    json({ ok: true, user_id: SELF }),
    json({ ok: false, error: "invalid_auth" }),
    json({ ok: false, error: "ratelimited" }),
    new Response("slow down", { status: 429 }),
    json({ ok: false, error: "channel_not_found" }),
    json({ ok: false, error: "cant_delete_message" }),
    json({ ok: false, error: "already_reacted" }),
    json({ ok: false, error: "synthetic_unknown" }),
    new Response("<html>", { status: 200 }),
  ]);
  const call = slackApi(token, fetcher);
  expect(await call("auth.test")).toEqual({ ok: true, user_id: SELF });
  expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${token}`);
  expect(sent[0]?.body).not.toContain(token);
  expect(sent[0]?.url).not.toContain(token);
  const codeOf = (promise: Promise<unknown>) =>
    promise.then(
      () => "ok",
      (error) => (error instanceof AdapterError ? error.code : "thrown"),
    );
  expect(await codeOf(call("auth.test"))).toBe("REAUTH_REQUIRED");
  expect(await codeOf(call("conversations.history"))).toBe("RATE_LIMITED");
  expect(await codeOf(call("conversations.history"))).toBe("RATE_LIMITED");
  expect(await codeOf(call("conversations.history"))).toBe("NOT_FOUND");
  expect(await codeOf(call("chat.delete"))).toBe("FORBIDDEN");
  expect(
    await codeOf(
      call("reactions.add", {}, { tolerate: new Set(["already_reacted"]) }),
    ),
  ).toBe("ok");
  expect(await codeOf(call("chat.postMessage"))).toBe("INTERNAL");
  expect(await codeOf(call("chat.postMessage"))).toBe("INTERNAL");
  expect(await codeOf(call("chat.postMessage"))).toBe("INTERNAL");
});

function slackFake(
  handlers: Record<string, (params: Record<string, unknown>) => object>,
) {
  const calls: [string, Record<string, unknown>][] = [];
  const call: SlackCall = async (method, params = {}) => {
    calls.push([method, params]);
    const handler = handlers[method];
    if (!handler) throw new AdapterError("INTERNAL", `unexpected ${method}`);
    return handler(params) as never;
  };
  return { call, calls };
}

const quiet = { onEvent: () => () => {} };

test("a reply goes under its message's thread, is broadcast, and is escaped; the stored message comes back", async () => {
  const { call, calls } = slackFake({
    "conversations.history": () => ({
      ok: true,
      messages: [
        {
          ts: "1700000000.000300",
          thread_ts: "1700000000.000100",
          user: "U0000000002",
          subtype: "thread_broadcast",
          text: "x",
        },
      ],
    }),
    "chat.postMessage": (params) => ({
      ok: true,
      ts: "1700000000.000400",
      message: {
        ts: "1700000000.000400",
        user: SELF,
        text: String(params.text),
        thread_ts: params.thread_ts,
      },
    }),
    "users.info": () => ({
      ok: true,
      user: { id: SELF, profile: { display_name: "Me" } },
    }),
  });
  const backend = slackBackend(call, { userId: SELF }, emoji, quiet);
  const sent = await backend.send?.(ROOM, "a <b> & c", {
    replyTo: "1700000000.000300",
  });
  const post = calls.find(([method]) => method === "chat.postMessage")?.[1];
  expect(post).toEqual({
    channel: ROOM,
    text: "a &lt;b&gt; &amp; c",
    thread_ts: "1700000000.000100",
    reply_broadcast: true,
  });
  expect(sent).toMatchObject({
    id: "1700000000.000400",
    text: "a <b> & c",
    fromMe: true,
    replyTo: "1700000000.000100",
  });
  backend.stop();
});

test("reactions become exactly the wanted set, and an emoji Slack has no name for is refused before any call", async () => {
  let reactions = [{ name: "heart", count: 1, users: [SELF] }];
  const { call, calls } = slackFake({
    "conversations.history": () => ({
      ok: true,
      messages: [
        { ts: "1700000000.000500", user: "U0000000002", text: "", reactions },
      ],
    }),
    "reactions.remove": () => {
      reactions = [];
      return { ok: true };
    },
    "reactions.add": (params) => {
      reactions = [{ name: String(params.name), count: 1, users: [SELF] }];
      return { ok: true };
    },
  });
  const backend = slackBackend(call, { userId: SELF }, emoji, quiet);
  expect(
    await backend.react?.(ROOM, "1700000000.000500", ["\u{1F44D}"]),
  ).toEqual([{ emoji: "\u{1F44D}", count: 1, mine: true }]);
  expect(
    calls
      .filter(([method]) => method.startsWith("reactions."))
      .map(([method, params]) => [method, params.name]),
  ).toEqual([
    ["reactions.remove", "heart"],
    ["reactions.add", "+1"],
  ]);
  const before = calls.length;
  await expect(
    backend.react?.(ROOM, "1700000000.000500", ["\u{1F984}"]),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  expect(calls.length).toBe(before);
  backend.stop();
});

test("resuming refuses a cursor whose message is gone, and otherwise returns what came after, oldest first and without thread-only replies", async () => {
  const { call } = slackFake({
    "conversations.history": (params) =>
      params.latest
        ? {
            ok: true,
            messages:
              params.latest === "1700000000.000600"
                ? [{ ts: "1700000000.000600", text: "" }]
                : [],
          }
        : {
            ok: true,
            messages: [
              { ts: "1700000000.000800", user: "U0000000002", text: "b" },
              {
                ts: "1700000000.000750",
                user: "U0000000002",
                text: "t",
                thread_ts: "1700000000.000600",
              },
              { ts: "1700000000.000700", user: "U0000000002", text: "a" },
            ],
          },
    "users.info": () => ({
      ok: true,
      user: { id: "U0000000002", name: "two" },
    }),
  });
  const backend = slackBackend(call, { userId: SELF }, emoji, quiet);
  await expect(
    backend.messagesAfter?.(ROOM, "1700000000.000599"),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  const after = await backend.messagesAfter?.(ROOM, "1700000000.000600");
  expect(after?.map((message) => message.id)).toEqual([
    "1700000000.000700",
    "1700000000.000800",
  ]);
  backend.stop();
});

test("socket frames are acknowledged, events come out, and a disconnect notice asks to reconnect", () => {
  expect(
    readEnvelope(
      JSON.stringify({
        envelope_id: "e1",
        type: "events_api",
        payload: { event: { type: "message" } },
      }),
    ),
  ).toEqual({ ack: "e1", event: { type: "message" }, reconnect: false });
  expect(readEnvelope(JSON.stringify({ type: "hello" }))).toEqual({
    reconnect: false,
  });
  expect(
    readEnvelope(
      JSON.stringify({ type: "disconnect", reason: "refresh_requested" }),
    ),
  ).toEqual({ reconnect: true });
  expect(readEnvelope("not json")).toEqual({ reconnect: false });
});

test("a channel's unread count is what came after last_read from others, and its activity is its newest message", async () => {
  const counted = deferred<void>();
  const { call } = slackFake({
    "users.conversations": () => ({
      ok: true,
      channels: [{ id: ROOM, name: "general" }],
    }),
    "conversations.info": () => ({
      ok: true,
      channel: { last_read: "1700000000.000100" },
    }),
    "conversations.history": (params) => {
      if (params.oldest) {
        counted.resolve();
        return {
          ok: true,
          messages: [
            { ts: "1700000000.000400", user: "U0000000002", text: "b" },
            { ts: "1700000000.000300", user: SELF, text: "mine" },
            {
              ts: "1700000000.000250",
              user: "U0000000002",
              text: "t",
              thread_ts: "1700000000.000100",
            },
            { ts: "1700000000.000200", user: "U0000000003", text: "a" },
          ],
        };
      }
      return {
        ok: true,
        messages: [{ ts: "1700000000.000400", user: "U0000000002", text: "b" }],
      };
    },
  });
  const backend = slackBackend(
    call,
    { userId: SELF },
    emoji,
    quiet,
    fetch,
    "",
    { fillIntervalMs: 0 },
  );
  expect((await backend.listRooms?.())?.rooms[0]).toMatchObject({ unread: 0 });
  await bounded(counted.promise, "unread counted");
  let room:
    | Awaited<
        ReturnType<NonNullable<typeof backend.listRooms>>
      >["rooms"][number]
    | undefined;
  for (let attempt = 0; attempt < 50 && !room?.lastActivityAt; attempt++) {
    await bounded(Promise.resolve(), "next turn");
    room = (await backend.listRooms?.())?.rooms[0];
  }
  expect(room).toMatchObject({
    unread: 2,
    lastActivityAt: "2023-11-14T22:13:20.000Z",
    lastMessage: { text: "b", fromMe: false },
  });
  backend.stop();
});

test("a channel never read counts from its start, without the zero last_read Slack refuses", async () => {
  const counted = deferred<Record<string, unknown>>();
  const { call } = slackFake({
    "users.conversations": () => ({
      ok: true,
      channels: [{ id: ROOM, name: "general" }],
    }),
    "conversations.info": () => ({
      ok: true,
      channel: { last_read: "0000000000.000000" },
    }),
    "conversations.history": (params) => {
      if (params.limit === 100) counted.resolve(params);
      return {
        ok: true,
        messages: [{ ts: "1700000000.000400", user: "U0000000002", text: "b" }],
      };
    },
  });
  const backend = slackBackend(
    call,
    { userId: SELF },
    emoji,
    quiet,
    fetch,
    "",
    { fillIntervalMs: 0 },
  );
  await backend.listRooms?.();
  const params = await bounded(counted.promise, "unread counted");
  expect(params.oldest).toBeUndefined();
  backend.stop();
});
