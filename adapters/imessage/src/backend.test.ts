import { expect, test } from "bun:test";
import { createHandler } from "@tsuba/serve-kit";
import { type ImsgRun, type ImsgRunner, imessageBackend } from "./backend";
import { capabilities } from "./capabilities";

const TOKEN = "synthetic-test-token-0123456789";
const BEARER = { authorization: `Bearer ${TOKEN}` };

const CHATS = [
  {
    id: 1,
    name: "+10000000009",
    display_name: "",
    identifier: "iMessage;-;+10000000009",
    is_group: false,
    unread_count: 0,
    last_message_at: "2024-01-01T00:00:00.000Z",
    participants: ["+10000000009"],
  },
  {
    id: 2,
    name: "",
    display_name: "Synthetic Group",
    identifier: "iMessage;+;chat000",
    is_group: true,
    unread_count: 3,
    last_message_at: "2024-01-02T03:04:05.678Z",
    participants: ["+10000000001", "+10000000002"],
  },
];

const MESSAGES = [
  {
    id: 30,
    chat_id: 1,
    sender: "+10000000009",
    is_from_me: false,
    text: "synthetic three",
    created_at: "2024-01-01T00:00:30.000Z",
  },
  {
    id: 29,
    chat_id: 1,
    sender: "",
    is_from_me: true,
    text: "synthetic two",
    created_at: "2024-01-01T00:00:20.000Z",
  },
  {
    id: 28,
    chat_id: 1,
    sender: "+10000000009",
    is_from_me: false,
    text: "synthetic one",
    created_at: "2024-01-01T00:00:10.000Z",
  },
  {
    id: 27,
    chat_id: 1,
    sender: "+10000000009",
    is_from_me: false,
    text: "synthetic zero",
    created_at: "2024-01-01T00:00:05.000Z",
  },
  {
    id: 26,
    chat_id: 1,
    sender: "+10000000009",
    is_from_me: false,
    text: "synthetic minus",
    created_at: "2024-01-01T00:00:01.000Z",
  },
];

function lines(rows: unknown[]): ImsgRun {
  return {
    stdout: rows.map((row) => JSON.stringify(row)).join("\n"),
    stderr: "",
    exitCode: 0,
  };
}

function scripted(...answers: ImsgRun[]) {
  const calls: string[][] = [];
  let index = 0;
  const runner: ImsgRunner = async (args) => {
    calls.push(args);
    const answer = answers[index++];
    if (!answer)
      throw new Error("The fake imsg was called more often than scripted");
    return answer;
  };
  return { runner, calls };
}

function surface(runner: ImsgRunner) {
  return createHandler({
    token: TOKEN,
    capabilities: capabilities(),
    backend: imessageBackend(runner),
  });
}

function rooms(handler: ReturnType<typeof surface>) {
  return handler.handle(
    new Request("http://synthetic/rooms", { headers: BEARER }),
  );
}

function messages(handler: ReturnType<typeof surface>, query: string) {
  return handler.handle(
    new Request(`http://synthetic/messages?${query}`, { headers: BEARER }),
  );
}

function send(
  handler: ReturnType<typeof surface>,
  body: Record<string, string>,
) {
  return handler.handle(
    new Request("http://synthetic/send", {
      method: "POST",
      headers: { ...BEARER, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

test("declares rooms, reads and sends, and nothing it cannot do", () => {
  const declared = capabilities();
  expect(declared.provider).toEqual({ id: "imessage", name: "iMessage" });
  expect(declared.account.kind).toBe("user");
  expect(Object.keys(declared.features).sort()).toEqual([
    "messages.read",
    "messages.send",
    "rooms.list",
  ]);
  expect(declared.features["messages.read"]).toEqual({
    paging: "before-id",
    maxLimit: 100,
  });
  expect(declared.features["messages.send"]).toEqual({
    maxLength: 20_000,
    receipt: "stored",
  });
});

test("rooms come from imsg chats, newest first, capped with a probe row", async () => {
  const { runner, calls } = scripted(lines(CHATS));
  const response = await rooms(surface(runner));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.rooms.map((room: { id: string }) => room.id)).toEqual(["2", "1"]);
  expect(body.rooms[0]).toMatchObject({
    title: "Synthetic Group",
    kind: "group",
    unread: 3,
    lastActivityAt: "2024-01-02T03:04:05.678Z",
  });
  expect(body.rooms[1]).toMatchObject({
    title: "+10000000009",
    kind: "direct",
    unread: 0,
  });
  expect(body.complete).toBe(true);
  expect(calls).toEqual([["chats", "--limit", "251", "--json"]]);
});

test("reads answer oldest first and map both directions", async () => {
  const { runner, calls } = scripted(lines(MESSAGES.slice(0, 3)));
  const response = await messages(surface(runner), "roomId=1&limit=2");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.messages.map((item: { id: string }) => item.id)).toEqual([
    "29",
    "30",
  ]);
  expect(body.hasEarlier).toBe(true);
  expect(body.messages[0]).toMatchObject({
    roomId: "1",
    sender: "me",
    senderId: "me",
    fromMe: true,
    kind: "text",
    sentAt: "2024-01-01T00:00:20.000Z",
  });
  expect(body.messages[1]).toMatchObject({
    sender: "+10000000009",
    senderId: "+10000000009",
    fromMe: false,
  });
  expect(calls).toEqual([
    ["history", "--chat-id", "1", "--limit", "3", "--json"],
  ]);
});

test("a before-id page walks back with --end until enough older rows are in hand", async () => {
  const { runner, calls } = scripted(
    lines(MESSAGES.slice(0, 3)),
    lines(MESSAGES.slice(2)),
  );
  const handler = surface(runner);
  const response = await messages(handler, "roomId=1&limit=2&before=30");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.messages.map((item: { id: string }) => item.id)).toEqual([
    "28",
    "29",
  ]);
  expect(body.hasEarlier).toBe(true);
  expect(calls).toEqual([
    ["history", "--chat-id", "1", "--limit", "3", "--json"],
    [
      "history",
      "--chat-id",
      "1",
      "--limit",
      "3",
      "--end",
      "2024-01-01T00:00:10.000Z",
      "--json",
    ],
  ]);
});

test("a room with fewer rows than asked for has nothing earlier", async () => {
  const { runner } = scripted(lines([MESSAGES[2]]));
  const body = await (
    await messages(surface(runner), "roomId=1&limit=2")
  ).json();
  expect(body.messages.map((item: { id: string }) => item.id)).toEqual(["28"]);
  expect(body.hasEarlier).toBe(false);
});

test("a confirmed send answers the row imsg stored", async () => {
  const { runner, calls } = scripted(
    lines([{ status: "sent" }]),
    lines([MESSAGES[1]]),
  );
  const response = await send(surface(runner), {
    roomId: "1",
    text: "synthetic two",
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.message).toMatchObject({
    id: "29",
    roomId: "1",
    sender: "me",
    senderId: "me",
    text: "synthetic two",
    kind: "text",
    fromMe: true,
  });
  expect(calls[0]).toEqual([
    "send",
    "--chat-id",
    "1",
    "--text",
    "synthetic two",
    "--json",
  ]);
});

test("a denied Messages database is a re-auth failure, not an unknown one", async () => {
  const refusals = [
    { stdout: "", stderr: "authorization denied (code: 23)\n", exitCode: 1 },
    {
      stdout:
        "unable to open database file (code: 14)\n\nPermission Error: Cannot access Messages database\n",
      stderr: "",
      exitCode: 1,
    },
  ];
  for (const refusal of refusals) {
    const response = await rooms(surface(scripted(refusal).runner));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("REAUTH_REQUIRED");
  }
});

test("missing Automation for a send is a re-auth failure too", async () => {
  const { runner } = scripted({
    stdout: "not authorized to send Apple events\n",
    stderr: "",
    exitCode: 1,
  });
  const response = await send(surface(runner), {
    roomId: "1",
    text: "synthetic",
  });
  expect(response.status).toBe(503);
  expect((await response.json()).error.code).toBe("REAUTH_REQUIRED");
});

test("a chat imsg does not know is NOT_FOUND", async () => {
  const { runner } = scripted({
    stdout: "Invalid chat target: Unknown chat id 99999999\n",
    stderr: "",
    exitCode: 1,
  });
  const response = await send(surface(runner), {
    roomId: "1",
    text: "synthetic",
  });
  expect(response.status).toBe(404);
  expect((await response.json()).error.code).toBe("NOT_FOUND");
});

test("a send imsg cannot confirm is INTERNAL and is never retried", async () => {
  const { runner, calls } = scripted({
    stdout: "may_have_completed\n",
    stderr: "",
    exitCode: 1,
  });
  const response = await send(surface(runner), {
    roomId: "1",
    text: "synthetic",
  });
  expect(response.status).toBe(500);
  expect((await response.json()).error.code).toBe("INTERNAL");
  expect(calls).toHaveLength(1);
});

test("an answer the adapter cannot read is INTERNAL", async () => {
  const unreadable = [
    { stdout: "not json at all\n", stderr: "", exitCode: 0 },
    { stdout: "[1,2,3]\n", stderr: "", exitCode: 0 },
  ];
  for (const answer of unreadable) {
    const response = await rooms(surface(scripted(answer).runner));
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("INTERNAL");
  }
});

test("a send imsg did not mark sent is INTERNAL", async () => {
  const { runner } = scripted(lines([{ status: "queued" }]));
  const response = await send(surface(runner), {
    roomId: "1",
    text: "synthetic",
  });
  expect(response.status).toBe(500);
  expect((await response.json()).error.code).toBe("INTERNAL");
});

test("ids that are not rowids are refused before imsg runs", async () => {
  const { runner, calls } = scripted();
  const handler = surface(runner);
  expect((await messages(handler, "roomId=synthetic")).status).toBe(404);
  expect((await messages(handler, "roomId=1&before=synthetic")).status).toBe(
    400,
  );
  expect((await send(handler, { roomId: "0", text: "synthetic" })).status).toBe(
    404,
  );
  expect(calls).toEqual([]);
});
