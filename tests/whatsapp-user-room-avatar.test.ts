import { expect, onTestFinished, test } from "bun:test";
import type { PictureFetch } from "../adapters/whatsapp-user/src/avatar-download";
import { whatsappUserBackend } from "../adapters/whatsapp-user/src/backend";
import { CAPABILITIES } from "../adapters/whatsapp-user/src/capabilities";
import {
  createHandler,
  type MessagesAnswer,
} from "../packages/serve-kit/src/index";
import { schema } from "./fixtures";
import { bounded, deferred } from "./harness/barriers";
import { fakeLink, GROUP, ROOM, text } from "./whatsapp-user-fixtures";

const LID = "100000000003@lid";

const headers = { authorization: "Bearer synthetic-avatar-token" };
const jpeg = new Uint8Array([255, 216, 255, 217]);

function setup(
  profilePictureUrl: (jid: string) => Promise<string | undefined> = async () =>
    "https://pps.whatsapp.net/synthetic.jpg",
) {
  const link = Object.assign(fakeLink(), {
    profilePictureUrl,
  });
  let bytes = jpeg;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response(bytes, { headers: { "content-type": "image/jpeg" } }),
  });
  onTestFinished(() => server.stop(true));
  let downloads = 0;
  let now = 0;
  const fetchFn: PictureFetch = async (_url, init) => {
    downloads++;
    return fetch(server.url, init);
  };
  const backend = whatsappUserBackend(link, { fetchFn, now: () => now });
  link.push({ type: "chats", chats: [{ id: ROOM }, { id: GROUP }] });
  const { handle } = createHandler({
    token: "synthetic-avatar-token",
    capabilities: CAPABILITIES,
    backend,
  });
  return {
    link,
    backend,
    handle,
    downloads: () => downloads,
    advance: () => {
      now += 300_001;
    },
    replace: () => {
      bytes = new Uint8Array([255, 216, 255, 218]);
    },
    async rooms() {
      if (!backend.listRooms) throw new Error("Missing listRooms");
      return (await backend.listRooms()).rooms;
    },
    request: (path: string) =>
      handle(new Request(`http://adapter${path}`, { headers })),
  };
}

test("listed direct and group rooms expose opaque picture IDs", async () => {
  const { handle } = setup();
  const response = await handle(
    new Request("http://adapter/rooms", { headers }),
  );
  expect(response.status).toBe(200);
  const answer = await response.json();
  expect(schema("RoomsAnswer")(answer)).toBe(true);
  expect(answer).toMatchObject({
    rooms: [
      { id: ROOM, avatar: expect.stringMatching(/^wa-room-v1-[a-f0-9]{64}$/) },
      { id: GROUP, avatar: expect.stringMatching(/^wa-room-v1-[a-f0-9]{64}$/) },
    ],
  });
  expect(JSON.stringify(answer)).not.toContain("https:");
});

test("a LID room and its incoming messages share the mapped phone picture", async () => {
  const app = setup(async (jid) =>
    jid === ROOM ? "https://pps.whatsapp.net/synthetic.jpg" : undefined,
  );
  app.link.push({
    type: "messages",
    live: false,
    messages: [
      {
        ...text("1", "synthetic"),
        key: { remoteJid: LID, id: "1", senderPn: ROOM },
      },
      {
        ...text("2", "synthetic"),
        key: { remoteJid: LID, id: "2", fromMe: true },
      },
    ],
  });
  const response = await app.request(
    `/messages?roomId=${encodeURIComponent(LID)}`,
  );
  expect(response.status).toBe(200);
  const answer = await response.json();
  expect(schema("MessagesAnswer")(answer)).toBe(true);
  const { messages } = answer as MessagesAnswer;
  const avatar = messages[0]?.senderAvatar;
  expect(avatar).toMatch(/^wa-room-v1-[a-f0-9]{64}$/);
  expect(messages[1]).not.toHaveProperty("senderAvatar");
  expect((await app.rooms()).find((room) => room.id === LID)?.avatar).toBe(
    avatar,
  );
  expect((await app.request(`/media?id=${avatar}`)).status).toBe(200);
});

test("a live group message uses its participant picture, never the room picture", async () => {
  const app = setup(async (jid) =>
    jid === ROOM ? "https://pps.whatsapp.net/synthetic.jpg" : undefined,
  );
  const subscribe = app.backend.subscribe;
  if (!subscribe) throw new Error("Missing stream subscription");
  const avatar = deferred<string | undefined>();
  onTestFinished(
    subscribe((update) => {
      if (update.event === "message")
        avatar.resolve(update.message.senderAvatar);
    }),
  );
  app.link.push({
    type: "messages",
    live: true,
    messages: [
      {
        ...text("1", "synthetic"),
        key: { remoteJid: GROUP, id: "1", participant: LID, senderPn: ROOM },
      },
    ],
  });
  const id = await bounded(avatar.promise, "live participant picture");
  expect(id).toMatch(/^wa-room-v1-[a-f0-9]{64}$/);
  expect((await app.request(`/media?id=${id}`)).status).toBe(200);
});

test("the declaration is exactly what the backend performs", async () => {
  const { request, handle } = setup();
  expect(Object.keys(CAPABILITIES.features).sort()).toEqual([
    "attachments.read",
    "attachments.send",
    "avatars.read",
    "messages.read",
    "messages.reply",
    "messages.send",
    "messages.stream",
    "rooms.list",
  ]);
  expect(CAPABILITIES.account.kind).toBe("user");
  expect(CAPABILITIES.features["messages.send"]).toMatchObject({
    receipt: "accepted",
  });
  for (const [path, body] of [
    ["/edit", { roomId: ROOM, messageId: "1", text: "x" }],
    ["/delete", { roomId: ROOM, messageId: "1" }],
    ["/react", { roomId: ROOM, messageId: "1", emojis: [] }],
    ["/read", { roomId: ROOM, messageId: "1" }],
  ] as const) {
    const response = await handle(
      new Request(`http://adapter${path}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "NOT_SUPPORTED" },
    });
  }
  expect((await request("/capabilities")).status).toBe(200);
});

test.each(["private", "missing", "failure"] as const)(
  "%s pictures are omitted and negative lookups are cached",
  async (kind) => {
    const app = setup();
    let lookups = 0;
    app.link.profilePictureUrl = async () => {
      lookups++;
      if (kind !== "missing")
        throw Object.assign(new Error("synthetic-private-error"), {
          output: { statusCode: kind === "private" ? 403 : 500 },
        });
      return undefined;
    };
    const [first, second] = await Promise.all([app.rooms(), app.rooms()]);
    expect(first.map((room) => room.avatar)).toEqual([undefined, undefined]);
    expect(second).toEqual(first);
    await app.rooms();
    expect(lookups).toBe(2);
    expect(app.downloads()).toBe(0);
    app.advance();
    await app.rooms();
    expect(lookups).toBe(4);
  },
);

test("concurrent room lists deduplicate lookups and downloads until TTL expiry", async () => {
  const app = setup();
  const started = deferred<void>();
  const release = deferred<string>();
  let calls = 0;
  app.link.profilePictureUrl = async () => {
    if (++calls === 2) started.resolve();
    return release.promise;
  };
  const first = app.rooms();
  const second = app.rooms();
  await bounded(started.promise, "picture requests started");
  expect(calls).toBe(2);
  release.resolve("https://pps.whatsapp.net/synthetic.jpg");
  const [left, right] = await Promise.all([first, second]);
  expect(left).toEqual(right);
  await app.rooms();
  expect(app.downloads()).toBe(2);
  app.advance();
  await app.rooms();
  expect(app.downloads()).toBe(4);
});

test("photo byte changes version IDs even when the CDN URL stays the same", async () => {
  const app = setup();
  const before = (await app.rooms())[0]?.avatar;
  app.replace();
  app.advance();
  const after = (await app.rooms())[0]?.avatar;
  expect(typeof before).toBe("string");
  expect(typeof after).toBe("string");
  expect(after).not.toBe(before);
  expect((await app.request(`/media?id=${before}`)).status).toBe(404);
  const media = await app.request(`/media?id=${after}`);
  expect(new Uint8Array(await media.arrayBuffer())).toEqual(
    new Uint8Array([255, 216, 255, 218]),
  );
});

test("media needs authentication and uses serve-kit inert image headers", async () => {
  const app = setup();
  const id = (await app.rooms())[0]?.avatar;
  const denied = await app.handle(new Request(`http://adapter/media?id=${id}`));
  expect(denied.status).toBe(401);
  const media = await app.request(`/media?id=${id}`);
  expect(media.status).toBe(200);
  expect(media.headers.get("content-type")).toBe("image/jpeg");
  expect(media.headers.get("content-security-policy")).toBe(
    "default-src 'none'; sandbox",
  );
  expect(media.headers.get("x-content-type-options")).toBe("nosniff");
  expect(media.headers.get("cache-control")).toBe("private, max-age=86400");
  expect(media.headers.get("content-disposition")).toBe("inline");
  expect(new Uint8Array(await media.arrayBuffer())).toEqual(jpeg);
});

test("malformed expired and arbitrary URL media IDs never trigger HTTP fetches", async () => {
  const app = setup();
  const id = (await app.rooms())[0]?.avatar;
  app.advance();
  for (const value of [
    id,
    "https://127.0.0.1/private",
    "wa-room-v1-xyz",
    `wa-room-v1-${"0".repeat(64)}`,
  ]) {
    const response = await app.request(
      `/media?id=${encodeURIComponent(value ?? "")}`,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("https:");
  }
  expect(app.downloads()).toBe(2);
});

test("the Room schema accepts optional opaque avatar strings and rejects null or empty IDs", () => {
  const validate = schema("Room");
  const room = {
    id: "synthetic",
    title: "Synthetic",
    kind: "direct",
    unread: 0,
  };
  expect(validate(room)).toBe(true);
  expect(validate({ ...room, avatar: "opaque-picture-version" })).toBe(true);
  expect(validate({ ...room, avatar: "" })).toBe(false);
  expect(validate({ ...room, avatar: null })).toBe(false);
});
