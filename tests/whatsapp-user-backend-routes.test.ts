import { expect, test } from "bun:test";
import { whatsappUserBackend } from "../adapters/whatsapp-user/src/backend";
import { CAPABILITIES } from "../adapters/whatsapp-user/src/capabilities";
import {
  createHandler,
  type MessagesAnswer,
  type RoomsAnswer,
  type StreamUpdate,
} from "../packages/serve-kit/src/index";
import { fakeLink, GROUP, ROOM, SECONDS, text } from "./whatsapp-user-fixtures";

const headers = {
  authorization: "Bearer synthetic-adapter-token",
  "content-type": "application/json",
};

function setup(state: Parameters<typeof fakeLink>[0] = "open") {
  const link = fakeLink(state);
  const backend = whatsappUserBackend(link);
  const handler = createHandler({
    token: "synthetic-adapter-token",
    capabilities: CAPABILITIES,
    backend,
  });
  return { link, backend, ...handler };
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
function present<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Missing test value");
  return value;
}

test("rooms list what the connection pushed and never claim to be complete", async () => {
  const { handle, link } = setup();
  link.push({
    type: "chats",
    chats: [
      { id: ROOM, name: "Synthetic chat", conversationTimestamp: SECONDS },
      { id: GROUP, name: "Group", conversationTimestamp: SECONDS + 9 },
    ],
  });
  link.push({ type: "messages", messages: [text("1", "hi")], live: false });
  const response = await handle(get("/rooms"));
  expect(response.status).toBe(200);
  const answer = (await response.json()) as RoomsAnswer;
  expect(answer.complete).toBe(false);
  expect(answer.rooms.map(({ id }) => id)).toEqual([GROUP, ROOM]);
  expect(answer.rooms[1]).toMatchObject({
    title: "Synthetic chat",
    lastMessage: { text: "hi", fromMe: false },
  });
});

test("messages page backwards from a held id, refuse an unknown cursor and bad rooms", async () => {
  const { handle, link } = setup();
  link.push({
    type: "messages",
    messages: ["1", "2", "3"].map((id) => text(id, `m${id}`)),
    live: false,
  });
  const page = (await (
    await handle(get(`/messages?roomId=${ROOM}&limit=2`))
  ).json()) as MessagesAnswer;
  expect(page.messages.map(({ id }) => id)).toEqual(["2", "3"]);
  expect(page.hasEarlier).toBe(true);
  const older = (await (
    await handle(get(`/messages?roomId=${ROOM}&limit=2&before=2`))
  ).json()) as MessagesAnswer;
  expect(older.messages.map(({ id }) => id)).toEqual(["1"]);
  await error(
    await handle(get(`/messages?roomId=${ROOM}&before=404`)),
    404,
    "NOT_FOUND",
  );
  await error(
    await handle(get("/messages?roomId=status%40broadcast")),
    404,
    "NOT_FOUND",
  );
});

test("a live message streams once; history, duplicates and own-send echoes do not", () => {
  const { backend, link } = setup();
  const updates: StreamUpdate[] = [];
  const stop = present(backend.subscribe)((update) => updates.push(update));
  link.push({ type: "messages", messages: [text("1", "old")], live: false });
  link.push({ type: "messages", messages: [text("2", "new")], live: true });
  link.push({ type: "messages", messages: [text("2", "new")], live: true });
  expect(updates.map((update) => update.event)).toEqual(["message"]);
  stop();
  link.push({ type: "messages", messages: [text("3", "x")], live: true });
  expect(updates).toHaveLength(1);
});

test("edits and deletes of held messages stream; unknown ones are silent", () => {
  const { backend, link } = setup();
  const updates: StreamUpdate[] = [];
  present(backend.subscribe)((update) => updates.push(update));
  link.push({
    type: "messages",
    messages: [text("1", "a"), text("2", "b")],
    live: false,
  });
  const key = { remoteJid: ROOM, id: "1" };
  link.push({
    type: "edit",
    key,
    content: { conversation: "a2" },
    at: SECONDS,
  });
  link.push({
    type: "edit",
    key: { remoteJid: ROOM, id: "404" },
    content: { conversation: "x" },
    at: SECONDS,
  });
  link.push({
    type: "delete",
    keys: [key, { remoteJid: ROOM, id: "2" }, { remoteJid: ROOM, id: "404" }],
  });
  expect(updates).toEqual([
    {
      event: "message.edited",
      message: expect.objectContaining({ id: "1", text: "a2" }),
    },
    { event: "message.deleted", roomId: ROOM, messageIds: ["1", "2"] },
  ]);
});

test("send answers with the accepted message and keeps it readable", async () => {
  const { handle, link } = setup();
  const response = await handle(post("/send", { roomId: ROOM, text: "hello" }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    message: { id: "9000", fromMe: true, roomId: ROOM },
  });
  expect(link.sends).toEqual([{ jid: ROOM, text: "hello" }]);
  const page = (await (
    await handle(get(`/messages?roomId=${ROOM}`))
  ).json()) as MessagesAnswer;
  expect(page.messages.map(({ id }) => id)).toEqual(["9000"]);
});

test("a reply quotes the held message and refuses one it has not seen", async () => {
  const { handle, link } = setup();
  link.push({ type: "messages", messages: [text("1", "q")], live: false });
  expect(
    (await handle(post("/send", { roomId: ROOM, text: "re", replyTo: "1" })))
      .status,
  ).toBe(200);
  expect(link.sends[0]?.quoted?.key.id).toBe("1");
  await error(
    await handle(post("/send", { roomId: ROOM, text: "re", replyTo: "404" })),
    404,
    "NOT_FOUND",
  );
  expect(link.sends).toHaveLength(1);
});

test("send is bounded at 2048 code points and refuses non-chat rooms before sending", async () => {
  const { handle, link } = setup();
  expect(
    (await handle(post("/send", { roomId: ROOM, text: "😀".repeat(2048) })))
      .status,
  ).toBe(200);
  await error(
    await handle(post("/send", { roomId: ROOM, text: "😀".repeat(2049) })),
    400,
    "INVALID_REQUEST",
  );
  await error(
    await handle(post("/send", { roomId: "status@broadcast", text: "x" })),
    404,
    "NOT_FOUND",
  );
  expect(link.sends).toHaveLength(1);
});

test("a send needs an open connection and says nothing was sent otherwise", async () => {
  for (const [state, status, code] of [
    ["connecting", 503, "BUSY"],
    ["reconnecting", 503, "BUSY"],
    ["conflict", 503, "BUSY"],
    ["forbidden", 403, "FORBIDDEN"],
    ["logged-out", 503, "REAUTH_REQUIRED"],
  ] as const) {
    const { handle, link } = setup(state);
    await error(
      await handle(post("/send", { roomId: ROOM, text: "x" })),
      status,
      code,
    );
    expect(link.sends).toHaveLength(0);
  }
});

test("logged out refuses reads too, while a dropped connection still serves memory", async () => {
  const { handle, link } = setup();
  link.push({ type: "chats", chats: [{ id: ROOM, name: "Synthetic" }] });
  link.setState("reconnecting");
  expect((await handle(get("/rooms"))).status).toBe(200);
  link.setState("logged-out");
  await error(await handle(get("/rooms")), 503, "REAUTH_REQUIRED");
  await error(
    await handle(get(`/messages?roomId=${ROOM}`)),
    503,
    "REAUTH_REQUIRED",
  );
});

test("WhatsApp refusals keep their codes and any other failure is unknown and not retried", async () => {
  for (const [statusCode, status, code] of [
    [401, 503, "REAUTH_REQUIRED"],
    [403, 403, "FORBIDDEN"],
    [429, 429, "RATE_LIMITED"],
    [428, 500, "INTERNAL"],
    [undefined, 500, "INTERNAL"],
  ] as const) {
    const { handle, link } = setup();
    link.sendImpl = async () => {
      throw Object.assign(new Error("SYNTHETIC_PRIVATE"), {
        output: { statusCode },
      });
    };
    const response = await handle(post("/send", { roomId: ROOM, text: "x" }));
    expect(await response.clone().text()).not.toContain("SYNTHETIC_PRIVATE");
    await error(response, status, code);
    expect(link.sends).toHaveLength(1);
  }
});

test("a send WhatsApp does not describe is reported as unknown, not as success", async () => {
  const { handle, link } = setup();
  link.sendImpl = async () => undefined;
  await error(
    await handle(post("/send", { roomId: ROOM, text: "x" })),
    500,
    "INTERNAL",
  );
});
