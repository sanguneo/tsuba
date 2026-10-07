import { describe, expect, test } from "bun:test";
import { slackApi } from "../adapters/slack/src/api";
import { slackBackend } from "../adapters/slack/src/backend";
import { emojiTable } from "../adapters/slack/src/emoji";
import { blockLines, mapBlockImages } from "../adapters/slack/src/mapping";
import { privateAddress } from "../adapters/slack/src/publicImage";
import { schema } from "./fixtures";

const ROOM = "C000000001";
const TS = "1700000000.000001";
const PICTURE = "https://pictures.example.test/synthetic/menu.png?v=1";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

const BOT_MESSAGE = {
  ts: TS,
  type: "message",
  subtype: "bot_message",
  bot_id: "B000000001",
  text: "Synthetic header",
  blocks: [
    { type: "header", text: { type: "plain_text", text: "Synthetic header" } },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: "Synthetic context line" }],
    },
    {
      type: "image",
      image_url: PICTURE,
      alt_text: "Synthetic picture",
      image_width: 640,
      image_height: 480,
      image_bytes: 1234,
    },
    { type: "image", image_url: "http://pictures.example.test/plain.png" },
  ],
};

function fixture(
  options: {
    resolve?: (host: string) => Promise<string[]>;
    picture?: (url: string) => Response;
  } = {},
) {
  const sent: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    sent.push({ url, init });
    if (url === "https://slack.com/api/conversations.history")
      return json({ ok: true, messages: [BOT_MESSAGE] });
    if (url === "https://slack.com/api/bots.info")
      return json({
        ok: true,
        bot: { id: "B000000001", name: "Synthetic app" },
      });
    if (url === "https://slack.com/api/users.conversations")
      return json({
        ok: true,
        channels: [
          {
            id: "G000000001",
            is_mpim: true,
            name: "mpdm-self--handle-one--handle-two-1",
          },
        ],
      });
    if (url === "https://slack.com/api/conversations.members")
      return json({
        ok: true,
        members: ["U000000001", "U000000002", "U000000003"],
      });
    if (url === "https://slack.com/api/users.info") {
      const id = new URLSearchParams(String(init?.body)).get("user");
      return json({
        ok: true,
        user: { id, profile: { display_name: `Synthetic ${id?.slice(-1)}` } },
      });
    }
    if (url.startsWith("https://slack.com/api/"))
      return json({ ok: false, error: "unknown_method" });
    return (
      options.picture?.(url) ??
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      })
    );
  }) as typeof fetch;
  const backend = slackBackend(
    slackApi("synthetic-slack-secret", fetcher),
    { userId: "U000000001", handle: "self" },
    emojiTable([]),
    { onEvent: () => () => {} },
    fetcher,
    "synthetic-slack-secret",
    { resolve: options.resolve ?? (async () => ["93.184.216.34"]) },
  );
  const { readMessages, media, listRooms } = backend;
  if (!readMessages || !media || !listRooms)
    throw new Error("Slack methods are missing");
  return {
    backend,
    sent,
    read: () => readMessages({ roomId: ROOM, limit: 10 }),
    media: (id: string) => media(id, new AbortController().signal),
    listRooms: () => listRooms(),
  };
}

describe("Slack blocks", () => {
  test("block words the text does not already say are added once", () => {
    expect(blockLines(BOT_MESSAGE.blocks, BOT_MESSAGE.text)).toEqual([
      "Synthetic context line",
    ]);
    expect(blockLines(BOT_MESSAGE.blocks, "")).toEqual([
      "Synthetic header",
      "Synthetic context line",
    ]);
  });

  test("an https image block is a picture; anything else is not offered", () => {
    expect(mapBlockImages(ROOM, TS, BOT_MESSAGE.blocks)).toEqual([
      {
        id: `${ROOM}:${TS}:image2`,
        kind: "image",
        mimeType: "image/png",
        name: "Synthetic picture",
        size: 1234,
        width: 640,
        height: 480,
      },
    ]);
  });

  test("a bot's message carries its app name, its block words and its picture", async () => {
    const f = fixture();
    try {
      const [message] = (await f.read()).messages;
      expect(schema("Message")(message)).toBe(true);
      expect(message?.sender).toBe("Synthetic app");
      expect(message?.text).toBe("Synthetic header\nSynthetic context line");
      expect(message?.kind).toBe("media");
      expect(message?.attachments?.map((item) => item.id)).toEqual([
        `${ROOM}:${TS}:image2`,
      ]);
    } finally {
      f.backend.stop();
    }
  });

  test("the picture is fetched from its public host without the Slack token", async () => {
    const f = fixture();
    try {
      const picture = await f.media(`${ROOM}:${TS}:image2`);
      expect(picture.mimeType).toBe("image/png");
      expect(picture.name).toBe("Synthetic picture");
      expect([
        ...new Uint8Array(await new Response(picture.body).arrayBuffer()),
      ]).toEqual([1, 2, 3]);
      const download = f.sent.find((call) => call.url === PICTURE);
      expect(download?.init?.redirect).toBe("manual");
      expect(
        new Headers(download?.init?.headers).get("authorization"),
      ).toBeNull();
      expect(JSON.stringify(download)).not.toContain("synthetic-slack-secret");
    } finally {
      f.backend.stop();
    }
  });

  for (const [label, options] of [
    [
      "a host resolving to a private address",
      { resolve: async () => ["10.0.0.5"] },
    ],
    [
      "a host resolving to loopback among public ones",
      { resolve: async () => ["93.184.216.34", "127.0.0.1"] },
    ],
    [
      "a host that does not resolve",
      {
        resolve: async () => {
          throw new Error("ENOTFOUND");
        },
      },
    ],
    [
      "a redirect to a private literal",
      {
        picture: (url: string) =>
          url === PICTURE
            ? new Response(null, {
                status: 302,
                headers: { location: "https://192.168.0.1/menu.png" },
              })
            : new Response(new Uint8Array([9]), {
                headers: { "content-type": "image/png" },
              }),
      },
    ],
    [
      "an answer that is not a raster picture",
      {
        picture: () =>
          new Response("<svg/>", {
            headers: { "content-type": "image/svg+xml" },
          }),
      },
    ],
    [
      "a refusal",
      { picture: () => new Response("synthetic refusal", { status: 403 }) },
    ],
  ] as const) {
    test(`${label} is no picture`, async () => {
      const f = fixture(options);
      try {
        await expect(f.media(`${ROOM}:${TS}:image2`)).rejects.toMatchObject({
          code: "NOT_FOUND",
        });
        expect(
          f.sent.some((call) => call.url === "https://192.168.0.1/menu.png"),
        ).toBe(false);
      } finally {
        f.backend.stop();
      }
    });
  }

  test("an http image block and a block that is not an image are not fetched", async () => {
    const f = fixture();
    try {
      for (const id of [`${ROOM}:${TS}:image3`, `${ROOM}:${TS}:image0`])
        await expect(f.media(id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(
        f.sent.some((call) => !call.url.startsWith("https://slack.com/api/")),
      ).toBe(false);
    } finally {
      f.backend.stop();
    }
  });

  test("private and reserved addresses are recognised", () => {
    for (const address of [
      "10.1.2.3",
      "127.0.0.1",
      "169.254.1.1",
      "172.20.0.1",
      "192.168.1.1",
      "100.100.1.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "not-an-address",
    ])
      expect(privateAddress(address)).toBe(true);
    for (const address of ["93.184.216.34", "2606:4700::1111"])
      expect(privateAddress(address)).toBe(false);
  });
});

describe("Slack group DMs", () => {
  test("are titled by the other people's display names", async () => {
    const f = fixture();
    try {
      const { rooms } = await f.listRooms();
      expect(rooms.map((room) => room.title)).toEqual([
        "Synthetic 2, Synthetic 3",
      ]);
    } finally {
      f.backend.stop();
    }
  });
});
