import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createHandler } from "@tsuba/serve-kit";
import { type Client, Collection } from "discord.js";
import { bounded, deferred } from "../../../tests/harness/barriers";
import { discordBackend } from "./backend";
import { CAPABILITIES } from "./capabilities";

const ROOM = "100000000000000001";
const USER = "100000000000000002";
const GUILD = "100000000000000003";
const MESSAGE = "100000000000000004";
const ATTACHMENT = "100000000000000005";
const HASH = "0123456789abcdef0123456789abcdef";
const NEXT_HASH = "abcdef0123456789abcdef0123456789";
const headers = { authorization: "Bearer synthetic-test-token-0123456789" };

function setup(
  action: (url: URL, options: RequestInit) => Response | Promise<Response>,
  userAvatar: string | null = HASH,
  guildAvatar: string | null = null,
) {
  const rawMessage = {
    id: MESSAGE,
    channelId: ROOM,
    guildId: GUILD,
    author: { id: USER, username: "Synthetic", avatar: userAvatar },
    member: { displayName: "Synthetic member", avatar: guildAvatar },
    content: "Synthetic message",
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    type: 0,
    stickers: new Collection(),
    attachments: new Collection([
      [
        ATTACHMENT,
        {
          id: ATTACHMENT,
          url: "https://cdn.discordapp.com/attachments/synthetic/file.png",
          name: "file.png",
          contentType: "image/png",
          size: 3,
        },
      ],
    ]),
    reactions: { cache: new Collection() },
  };
  const channel = {
    type: 0,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async (options: { message?: string }) =>
        options.message ? rawMessage : new Collection([[MESSAGE, rawMessage]]),
    },
  };
  Object.defineProperty(rawMessage, "channel", { get: () => channel });
  const events = new EventEmitter();
  const client = Object.assign(events, {
    user: { id: "100000000000000006" },
    channels: { fetch: async () => channel },
  }) as unknown as Client<true>;
  const calls: { url: URL; options: RequestInit }[] = [];
  const fetchMedia: typeof fetch = Object.assign(
    async (input: string | URL | Request, options: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : input);
      calls.push({ url, options });
      return action(url, options);
    },
    { preconnect() {} },
  );
  const backend = discordBackend(client, fetchMedia);
  const handler = createHandler({
    token: "synthetic-test-token-0123456789",
    capabilities: CAPABILITIES,
    backend,
  });
  const get = (path: string) =>
    handler.handle(new Request(`http://adapter${path}`, { headers }));
  const update = async () => {
    const edited = deferred<void>();
    const unsubscribe = backend.subscribe?.((event) => {
      if (event.event === "message.edited") edited.resolve();
    });
    try {
      events.emit("messageUpdate", rawMessage, rawMessage);
      await bounded(edited.promise, "avatar update");
    } finally {
      unsubscribe?.();
    }
  };
  return { get, calls, rawMessage, update };
}

function media(id: string) {
  return `/media?id=${encodeURIComponent(id)}`;
}

const picture = () => new Response(new Uint8Array([1, 2, 3]));

test("message avatars prefer the guild picture, fall back to user, omit defaults and change with the hash", async () => {
  for (const [user, guild, expected] of [
    [HASH, NEXT_HASH, `avatar:${GUILD}:${USER}:${NEXT_HASH}`],
    [HASH, null, `avatar:${USER}:${HASH}`],
    [null, HASH, `avatar:${GUILD}:${USER}:${HASH}`],
    [null, null, undefined],
  ] as const) {
    const { get, rawMessage, update } = setup(picture, user, guild);
    const response = await get(`/messages?roomId=${ROOM}&limit=2`);
    expect(response.status).toBe(200);
    const answer = await response.json();
    const mapped = answer.messages[0];
    if (expected === undefined)
      expect(mapped).not.toHaveProperty("senderAvatar");
    else expect(mapped.senderAvatar).toBe(expected);
    rawMessage.member.avatar = NEXT_HASH;
    await update();
    const changed = await (
      await get(`/messages?roomId=${ROOM}&limit=2`)
    ).json();
    expect(changed.messages[0].senderAvatar).toBe(
      `avatar:${GUILD}:${USER}:${NEXT_HASH}`,
    );
  }
});

test("avatar ids round-trip through /media as fixed-origin 64px PNG, including animated hashes", async () => {
  const { get, calls } = setup(picture);
  for (const [id, path] of [
    [`avatar:${USER}:${HASH}`, `/avatars/${USER}/${HASH}.png`],
    [
      `avatar:${GUILD}:${USER}:a_${HASH}`,
      `/guilds/${GUILD}/users/${USER}/avatars/a_${HASH}.png`,
    ],
  ] as const) {
    const response = await get(media(id));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    const call = calls.at(-1);
    expect(call?.url.href).toBe(`https://cdn.discordapp.com${path}?size=64`);
    expect(call?.options.redirect).toBe("error");
    expect(call?.options.signal).toBeInstanceOf(AbortSignal);
  }
  const attachment = await get(media(`${ROOM}:${MESSAGE}:${ATTACHMENT}`));
  expect(attachment.status).toBe(200);
  expect(calls.at(-1)?.url.pathname).toBe("/attachments/synthetic/file.png");
});

test("invalid avatar ids never fetch and cannot be interpreted as attachment ids or URLs", async () => {
  const { get, calls } = setup(picture);
  for (const id of [
    `avatar:1:${HASH}`,
    `avatar:bad:${USER}:${HASH}`,
    `avatar:${USER}:${HASH.toUpperCase()}`,
    `avatar:${USER}:${HASH.slice(1)}`,
    `avatar:${USER}:${HASH}0`,
    `avatar:${USER}:${HASH}/../x`,
    `avatar:${USER}:${HASH}?size=4096`,
    `avatar:${USER}:${HASH}:extra`,
    `avatar:${ROOM}:${MESSAGE}:${ATTACHMENT}`,
    "avatar:https://example.invalid/avatar.png",
  ]) {
    const response = await get(media(id));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  }
  expect(calls).toHaveLength(0);
});

test("avatar CDN refusals and transport errors use the Discord error wrapper", async () => {
  for (const [status, expectedStatus, code] of [
    [400, 400, "INVALID_REQUEST"],
    [401, 503, "REAUTH_REQUIRED"],
    [403, 403, "FORBIDDEN"],
    [404, 404, "NOT_FOUND"],
    [429, 429, "RATE_LIMITED"],
    [503, 500, "INTERNAL"],
  ] as const) {
    const { get } = setup(() => new Response(null, { status }));
    const response = await get(media(`avatar:${USER}:${HASH}`));
    expect(response.status).toBe(expectedStatus);
    expect(await response.json()).toMatchObject({ error: { code } });
  }
  const { get } = setup(() => {
    throw new TypeError("Synthetic redirect/network failure");
  });
  const response = await get(media(`avatar:${USER}:${HASH}`));
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: { code: "INTERNAL" } });
});
