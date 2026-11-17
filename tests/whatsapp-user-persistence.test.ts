import { expect, test } from "bun:test";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { StoreFileError } from "../adapters/whatsapp-user/src/snapshot";
import { GROUP, ROOM, SECONDS, text } from "./whatsapp-user-fixtures";
import { setupCache as setup } from "./whatsapp-user-persistence-harness";

test("room names survive restarting without another history sync", async () => {
  const { start } = await setup();
  const first = await start();
  const lid = "100000000003@lid";
  const pushed = "100000000004@s.whatsapp.net";
  const notified = "100000000005@s.whatsapp.net";
  first.link.push({
    type: "chats",
    chats: [
      {
        id: ROOM,
        name: "Stale chat",
        unreadCount: 7,
        conversationTimestamp: { toNumber: () => SECONDS },
      },
      { id: lid },
      { id: GROUP, name: "Stale group" },
      { id: notified },
    ],
  });
  first.link.push({
    type: "names",
    names: [
      { id: ROOM, name: "Synthetic saved", lid },
      { id: notified, notify: "Synthetic notify" },
    ],
  });
  first.link.push({
    type: "groups",
    groups: [{ id: GROUP, subject: "Synthetic subject" }],
  });
  first.link.push({
    type: "messages",
    messages: [
      text(
        "1",
        "synthetic preview",
        { messageTimestamp: { toNumber: () => SECONDS + 1 } },
        pushed,
      ),
      text(
        "2",
        "deleted preview",
        {
          messageTimestamp: SECONDS + 1,
          pushName: "Latest deleted",
        },
        pushed,
      ),
    ],
    live: false,
  });
  first.link.push({ type: "delete", keys: [{ remoteJid: pushed, id: "2" }] });
  const before = await first.get("/rooms");
  await first.cache.flush();

  const restarted = await start();
  expect(await restarted.get("/rooms")).toEqual(before);
  expect(
    restarted.cache.store
      .rooms()
      .map(({ title }) => title)
      .sort(),
  ).toEqual([
    "Latest deleted",
    "Synthetic notify",
    "Synthetic saved",
    "Synthetic saved",
    "Synthetic subject",
  ]);
  restarted.link.push({
    type: "names",
    names: [{ id: ROOM, name: "Renamed saved" }],
  });
  expect(
    restarted.cache.store.rooms().find(({ id }) => id === lid)?.title,
  ).toBe("Renamed saved");
});

test("recent messages retain edits, reply metadata and protobuf bytes after restarting", async () => {
  const { start } = await setup();
  const first = await start();
  const media = {
    ...text("1", "unused"),
    message: {
      imageMessage: {
        caption: "Synthetic caption",
        contextInfo: { stanzaId: "synthetic-quote" },
        mediaKey: new Uint8Array([1, 2, 3]),
        fileLength: 12,
      },
    },
  };
  first.link.push({
    type: "messages",
    messages: [media, text("2", "before")],
    live: true,
  });
  first.link.push({
    type: "edit",
    key: { remoteJid: ROOM, id: "2" },
    content: { conversation: "after" },
    at: SECONDS + 3,
  });
  const before = await first.get(`/messages?roomId=${ROOM}&limit=100`);
  await first.cache.flush();
  const restarted = await start();
  expect(await restarted.get(`/messages?roomId=${ROOM}&limit=100`)).toEqual(
    before,
  );
  if (!restarted.backend.send) throw new Error("Missing send");
  await restarted.backend.send(ROOM, "synthetic reply", { replyTo: "1" });
  const quoted = restarted.link.sends[0]?.quoted;
  if (!quoted) throw new Error("Missing restored quote");
  const image = quoted.message?.imageMessage;
  const length = image && "fileLength" in image ? image.fileLength : undefined;
  const key = image && "mediaKey" in image ? image.mediaKey : undefined;
  expect(String(length)).toBe("12");
  expect(key instanceof Uint8Array ? [...key] : undefined).toEqual([1, 2, 3]);
});

test("a room discovered only by messages survives restarting after its last message is deleted", async () => {
  const { start } = await setup();
  const first = await start();
  first.link.push({
    type: "messages",
    messages: [text("1", "synthetic")],
    live: true,
  });
  first.link.push({ type: "delete", keys: [{ remoteJid: ROOM, id: "1" }] });
  const before = await first.get("/rooms");
  expect(first.cache.store.rooms().map(({ id }) => id)).toEqual([ROOM]);
  await first.cache.flush();
  const restarted = await start();
  expect(await restarted.get("/rooms")).toEqual(before);
});

test("only the latest fifty retained messages per room are saved, including deletions and sends", async () => {
  const { start } = await setup();
  const first = await start();
  first.link.push({
    type: "messages",
    messages: Array.from({ length: 60 }, (_, i) =>
      text(String(i + 1), "synthetic"),
    ),
    live: false,
  });
  first.link.push({ type: "delete", keys: [{ remoteJid: ROOM, id: "59" }] });
  first.link.push({
    type: "groups",
    groups: [{ id: GROUP, subject: "Deleted room" }],
  });
  first.link.push({ type: "chatsDeleted", ids: [GROUP] });
  if (!first.backend.send) throw new Error("Missing send");
  await first.backend.send(ROOM, "synthetic send", {});
  await first.cache.flush();
  const restarted = await start();
  expect(
    restarted.cache.store.page(ROOM, 100).messages.map(({ id }) => id),
  ).toEqual([
    ...Array.from({ length: 48 }, (_, i) => String(i + 11)),
    "60",
    "9000",
  ]);
  expect(restarted.cache.store.rooms().map(({ id }) => id)).toEqual([ROOM]);
});

test("successive atomic replacements keep mode 600 and leave no temporary files", async () => {
  const { dir, path, start } = await setup();
  const first = await start();
  first.link.push({ type: "chats", chats: [{ id: ROOM, name: "First" }] });
  await first.cache.flush();
  const old = await readFile(path, "utf8");
  const held = await open(path, "r");
  try {
    first.link.push({ type: "chats", chats: [{ id: ROOM, name: "Second" }] });
    await first.cache.flush();
    expect(await held.readFile("utf8")).toBe(old);
  } finally {
    await held.close();
  }
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readdir(dir)).toEqual(["store.json"]);
  expect(await readFile(path, "utf8")).not.toBe(old);
  expect((await start()).cache.store.rooms()[0]?.title).toBe("Second");
});

test("a failed replacement reports no file payload, cleans up and allows later saves", async () => {
  const { dir, path, start, failures } = await setup();
  const first = await start();
  first.link.push({
    type: "chats",
    chats: [{ id: ROOM, name: "Before failure" }],
  });
  await first.cache.flush();
  const old = await readFile(path, "utf8");
  await rename(path, join(dir, "previous.json"));
  await mkdir(path);
  first.link.push({
    type: "chats",
    chats: [{ id: ROOM, name: "After failure" }],
  });
  await expect(first.cache.flush()).rejects.toBeInstanceOf(StoreFileError);
  expect(failures()).toBe(1);
  expect(await readFile(join(dir, "previous.json"), "utf8")).toBe(old);
  expect((await readdir(dir)).sort()).toEqual(["previous.json", "store.json"]);
  await rm(path, { recursive: true });
  first.cache.save();
  await first.cache.flush();
  expect((await start()).cache.store.rooms()[0]?.title).toBe("After failure");
});

test.each([
  "{SYNTHETIC_PRIVATE",
  '{"version":2}',
  '{"version":1,"chats":[null]}',
])(
  "an invalid existing cache refuses startup without overwriting its bytes: %s",
  async (data) => {
    const { path, start } = await setup();
    await writeFile(path, data, { mode: 0o600 });
    await expect(start()).rejects.toThrow(
      "WhatsApp room cache could not be read or saved",
    );
    expect(await readFile(path, "utf8")).toBe(data);
  },
);
