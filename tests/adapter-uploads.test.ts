import { expect, test } from "bun:test";
import { mapDiscordRoom } from "../adapters/discord/src/mapping";
import { type SlackCall, slackScopes } from "../adapters/slack/src/api";
import { slackBackend } from "../adapters/slack/src/backend";
import {
  capabilities,
  UPLOAD_SCOPE,
  UPLOADS,
} from "../adapters/slack/src/capabilities";
import { emojiTable } from "../adapters/slack/src/emoji";
import { MAX_PHOTO_BYTES, uploadKind } from "../adapters/telegram/src/mapping";
import { AdapterError, createHandler } from "../packages/serve-kit/src/index";
import { schema, TOKEN } from "./fixtures";

const SELF = "U000000001";
const ROOM = "C0000000001";
const FILE_ID = "F0000000001";
const emoji = emojiTable([]);
const quiet = { onEvent: () => () => {} };

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

function uploadFake(uploadUrl: string) {
  let looks = 0;
  return slackFake({
    "files.getUploadURLExternal": () => ({
      ok: true,
      upload_url: uploadUrl,
      file_id: FILE_ID,
    }),
    "files.completeUploadExternal": () => ({
      ok: true,
      files: [{ id: FILE_ID }],
    }),
    // Slack shares the file a moment after completing it: the first look is empty.
    "files.info": () => {
      looks++;
      return looks === 1
        ? { ok: true, file: { id: FILE_ID, shares: {} } }
        : {
            ok: true,
            file: {
              id: FILE_ID,
              shares: { public: { [ROOM]: [{ ts: "1700000000.000700" }] } },
            },
          };
    },
    "conversations.history": () => ({
      ok: true,
      messages: [{ ts: "1700000000.000700", user: SELF, text: "a <b>" }],
    }),
    "users.info": (params) => ({
      ok: true,
      user: { id: params.user, profile: { display_name: "Me" } },
    }),
  });
}

function recordingFetch() {
  const posted: { url: string; size: number }[] = [];
  const fetcher = (async (url: string | URL | Request, init: RequestInit) => {
    posted.push({
      url: String(url),
      size: (init.body as Uint8Array).byteLength,
    });
    return new Response("OK");
  }) as unknown as typeof fetch;
  return { posted, fetcher };
}

const synthetic = {
  name: "a.png",
  type: "image/png",
  bytes: new Uint8Array([1, 2, 3]),
};

test("Slack uploads to its own address, shares with the caption, and answers the stored message", async () => {
  const { call, calls } = uploadFake(
    "https://files.slack.com/upload/v1/synthetic",
  );
  const { posted, fetcher } = recordingFetch();
  const backend = slackBackend(
    call,
    { userId: SELF },
    emoji,
    quiet,
    fetcher,
    "",
    {
      uploads: true,
      sharePollMs: 0,
    },
  );
  const sent = await backend.upload?.(ROOM, synthetic, { caption: "a <b>" });
  expect(posted).toEqual([
    { url: "https://files.slack.com/upload/v1/synthetic", size: 3 },
  ]);
  expect(
    calls.find(([method]) => method === "files.completeUploadExternal")?.[1],
  ).toEqual({
    files: JSON.stringify([{ id: FILE_ID, title: "a.png" }]),
    channel_id: ROOM,
    initial_comment: "a &lt;b&gt;",
  });
  expect(calls.filter(([method]) => method === "files.info")).toHaveLength(2);
  expect(sent).toMatchObject({ id: "1700000000.000700", fromMe: true });
  expect(schema("Message")(sent)).toBe(true);
  backend.stop();
});

test("Slack refuses an upload address off Slack's file host and shares nothing", async () => {
  const { call, calls } = uploadFake("https://elsewhere.example/upload");
  const { posted, fetcher } = recordingFetch();
  const backend = slackBackend(
    call,
    { userId: SELF },
    emoji,
    quiet,
    fetcher,
    "",
    {
      uploads: true,
      sharePollMs: 0,
    },
  );
  await expect(backend.upload?.(ROOM, synthetic, {})).rejects.toThrow(
    "Slack gave no usable upload address",
  );
  expect(posted).toEqual([]);
  expect(
    calls.some(([method]) => method === "files.completeUploadExternal"),
  ).toBe(false);
  backend.stop();
});

test("Slack declares files only with files:write, and the declaration and backend agree", async () => {
  const { call } = slackFake({});
  for (const uploads of [true, false]) {
    const backend = slackBackend(
      call,
      { userId: SELF },
      emoji,
      quiet,
      fetch,
      "",
      {
        uploads,
      },
    );
    expect(typeof backend.upload === "function").toBe(uploads);
    const declared = capabilities(uploads);
    expect(declared.features["attachments.send"]).toEqual(
      uploads ? UPLOADS : undefined,
    );
    expect(() =>
      createHandler({ token: TOKEN, capabilities: declared, backend }),
    ).not.toThrow();
    backend.stop();
  }
  const scopes = await slackScopes(
    "synthetic",
    (async () =>
      new Response("{}", {
        headers: { "x-oauth-scopes": "chat:write, files:read,files:write" },
      })) as unknown as typeof fetch,
  );
  expect(scopes.has(UPLOAD_SCOPE)).toBe(true);
  expect(scopes.has("files:read")).toBe(true);
});

test("Telegram shows pictures and MP4 inline, GIFs as animations, and the rest as files", () => {
  expect(uploadKind("image/jpeg", 1)).toBe("photo");
  expect(uploadKind("image/png", MAX_PHOTO_BYTES)).toBe("photo");
  expect(uploadKind("image/png", MAX_PHOTO_BYTES + 1)).toBe("document");
  expect(uploadKind("image/gif", 1)).toBe("animation");
  expect(uploadKind("video/mp4", 1)).toBe("video");
  expect(uploadKind("video/quicktime", 1)).toBe("document");
  expect(uploadKind("application/pdf", 1)).toBe("document");
});

test("a Discord channel without Attach Files narrows only files", () => {
  const channel = {
    id: "123456789012345678",
    type: 0,
    name: "general",
    guildName: "Synthetic server",
    permissions: { view: true, readHistory: true, send: true },
  };
  expect(mapDiscordRoom(channel)?.features).toBeUndefined();
  expect(
    mapDiscordRoom({
      ...channel,
      permissions: { ...channel.permissions, attach: true },
    })?.features,
  ).toBeUndefined();
  expect(
    mapDiscordRoom({
      ...channel,
      permissions: { ...channel.permissions, attach: false },
    })?.features,
  ).toEqual({ "attachments.send": false });
});
