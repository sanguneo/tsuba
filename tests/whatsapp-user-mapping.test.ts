import { expect, test } from "bun:test";
import {
  isRoomJid,
  mapMessage,
  mapRoom,
  toSeconds,
} from "../adapters/whatsapp-user/src/mapping";
import { WaStore } from "../adapters/whatsapp-user/src/store";
import { GROUP, ROOM, SECONDS, text } from "./whatsapp-user-fixtures";

test("only chats, groups and LID addresses are rooms", () => {
  for (const jid of [ROOM, GROUP, "100000000003@lid"])
    expect(isRoomJid(jid)).toBe(true);
  for (const jid of [
    "status@broadcast",
    "100000000004@newsletter",
    "100000000005@broadcast",
    "../etc@s.whatsapp.net",
    "",
  ])
    expect(isRoomJid(jid)).toBe(false);
});

test("text, replies, wrapped text and captioned media map to messages", () => {
  expect(mapMessage(text("1", "hello"))).toEqual({
    id: "1",
    roomId: ROOM,
    senderId: ROOM,
    sender: "Synthetic",
    text: "hello",
    kind: "text",
    sentAt: new Date((SECONDS + 1) * 1000).toISOString(),
    fromMe: false,
  });
  const reply = mapMessage(
    text("2", "", {
      message: {
        extendedTextMessage: { text: "re", contextInfo: { stanzaId: "1" } },
      },
    }),
  );
  expect(reply).toMatchObject({ text: "re", replyTo: "1" });
  const wrapped = mapMessage(
    text("3", "", {
      message: {
        ephemeralMessage: { message: { conversation: "disappearing" } },
      },
    }),
  );
  expect(wrapped?.text).toBe("disappearing");
  const media = mapMessage(
    text("4", "", { message: { imageMessage: { caption: "caption" } } }),
  );
  expect(media).toMatchObject({ kind: "media", text: "caption" });
  expect(media?.attachments).toBeUndefined();
});

test("own messages carry no sender id, group senders are the participant", () => {
  const mine = mapMessage(
    text("5", "mine", { key: { remoteJid: ROOM, id: "5", fromMe: true } }),
  );
  expect(mine).toMatchObject({ fromMe: true, sender: "Me" });
  expect(mine?.senderId).toBeUndefined();
  const member = mapMessage(
    text(
      "6",
      "hi",
      {
        key: {
          remoteJid: GROUP,
          id: "6",
          participant: "100000000009@s.whatsapp.net",
        },
        pushName: null,
      },
      GROUP,
    ),
  );
  expect(member).toMatchObject({
    senderId: "100000000009@s.whatsapp.net",
    sender: "100000000009",
  });
});

test("reactions, protocol messages, unknown content and unusable keys are not messages", () => {
  for (const message of [
    { reactionMessage: {} },
    { protocolMessage: {} },
    { unknownKind: {} } as never,
    null,
  ])
    expect(mapMessage(text("7", "x", { message: message }))).toBeNull();
  expect(mapMessage(text("8", "x", { messageTimestamp: null }))).toBeNull();
  expect(mapMessage(text("9", "x", { key: { id: "9" } }))).toBeNull();
  expect(
    mapMessage(
      text("10", "x", { key: { remoteJid: "status@broadcast", id: "10" } }),
    ),
  ).toBeNull();
});

test("Long timestamps are read through toNumber and bad ones refused", () => {
  expect(toSeconds({ toNumber: () => SECONDS })).toBe(SECONDS);
  expect(toSeconds(0)).toBeNull();
  expect(toSeconds(Number.NaN)).toBeNull();
  expect(toSeconds(undefined)).toBeNull();
});

test("a room takes its title from the chat name, never invents unread, and previews 200 code points", () => {
  const newest = mapMessage(text("1", "😀".repeat(201)));
  expect(
    mapRoom(
      ROOM,
      { name: "Synthetic chat", unreadCount: -1 },
      newest ?? undefined,
    ),
  ).toMatchObject({
    title: "Synthetic chat",
    kind: "direct",
    unread: 0,
    lastMessage: { text: "😀".repeat(200), fromMe: false },
  });
  expect(mapRoom(GROUP, {})).toMatchObject({
    kind: "group",
    title: GROUP.split("@")[0],
  });
});

test("the store pages before an id, oldest first, and says when earlier ones remain", () => {
  const store = new WaStore();
  for (const id of ["1", "2", "3", "4"]) store.put(text(id, `m${id}`));
  const newest = store.page(ROOM, 2);
  expect(newest.messages.map(({ id }) => id)).toEqual(["3", "4"]);
  expect(newest.hasEarlier).toBe(true);
  const older = store.page(ROOM, 2, "3");
  expect(older.messages.map(({ id }) => id)).toEqual(["1", "2"]);
  expect(older.hasEarlier).toBe(false);
  expect(store.has(ROOM, "3")).toBe(true);
  expect(store.has(ROOM, "99")).toBe(false);
});

test("the store keeps the newest 200 messages of a room", () => {
  const store = new WaStore();
  for (let index = 1; index <= 205; index++)
    store.put(text(String(index), "m"));
  const all = store.page(ROOM, 500);
  expect(all.messages).toHaveLength(200);
  expect(all.messages[0]?.id).toBe("6");
});

test("edits replace the text and stamp editedAt; deletes drop only what was held", () => {
  const store = new WaStore();
  store.put(text("1", "before"));
  const edited = store.edit(
    { remoteJid: ROOM, id: "1" },
    { conversation: "after" },
    SECONDS + 60,
  );
  expect(edited).toMatchObject({
    text: "after",
    editedAt: new Date((SECONDS + 60) * 1000).toISOString(),
  });
  expect(store.page(ROOM, 5).messages[0]?.text).toBe("after");
  expect(
    store.edit({ remoteJid: ROOM, id: "404" }, { conversation: "x" }, null),
  ).toBeNull();
  expect(
    store.remove([
      { remoteJid: ROOM, id: "1" },
      { remoteJid: ROOM, id: "404" },
    ]),
  ).toEqual([{ roomId: ROOM, id: "1" }]);
  expect(store.has(ROOM, "1")).toBe(false);
});

test("rooms merge chat updates, borrow contact names, sort by activity and skip non-rooms", () => {
  const store = new WaStore();
  store.setChats([
    { id: ROOM, conversationTimestamp: SECONDS, unreadCount: 2 },
    { id: GROUP, name: "Group", conversationTimestamp: SECONDS + 100 },
    { id: "status@broadcast" },
  ]);
  store.setChats([{ id: ROOM, unreadCount: null, name: null }]);
  store.setNames([{ id: ROOM, name: "Synthetic contact" }]);
  const rooms = store.rooms();
  expect(rooms.map(({ id }) => id)).toEqual([GROUP, ROOM]);
  expect(rooms[1]).toMatchObject({ title: "Synthetic contact", unread: 2 });
  store.deleteChats([GROUP]);
  expect(store.rooms().map(({ id }) => id)).toEqual([ROOM]);
});
