import { expect, test } from "bun:test";
import { parseSnapshot } from "../adapters/whatsapp-user/src/snapshot";
import { WaStore } from "../adapters/whatsapp-user/src/store";
import { GROUP, ROOM, SECONDS } from "./whatsapp-user-fixtures";
import { setupNames } from "./whatsapp-user-names-harness";

const LID = "100000000003@lid";
const OTHER_PHONE = "100000000004@s.whatsapp.net";

test("an incoming LID message uses its mapped phone until a contact name arrives", async () => {
  const { ev, rooms } = await setupNames();
  ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: LID, id: "1", senderPn: ROOM },
        message: { conversation: "synthetic" },
        messageTimestamp: SECONDS,
      },
    ],
  });
  expect(await rooms()).toEqual({ [LID]: ROOM.replace("@s.whatsapp.net", "") });
  ev.emit("contacts.upsert", [{ id: ROOM, name: "Saved contact" }]);
  expect(await rooms()).toEqual({ [LID]: "Saved contact" });
});

test("an unsupported incoming message contributes a push name without creating a room", async () => {
  const { ev, rooms } = await setupNames();
  ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: LID, id: "1" },
        message: { reactionMessage: { text: "synthetic" } },
        messageTimestamp: SECONDS,
        pushName: "Synthetic push",
      },
    ],
  });
  expect(await rooms()).toEqual({});
  ev.emit("chats.upsert", [{ id: LID }]);
  expect(await rooms()).toEqual({ [LID]: "Synthetic push" });
});

test("history chats link their phone and LID and retain group titles", async () => {
  const { ev, rooms, store } = await setupNames();
  ev.emit("messaging-history.set", {
    chats: [
      { id: LID, pnJid: ROOM, name: LID.replace("@lid", "") },
      { id: GROUP, name: "History group" },
    ],
    contacts: [{ id: ROOM, verifiedName: "Verified business" }],
    messages: [],
  });
  const titles = {
    [LID]: "Verified business",
    [GROUP]: "History group",
  };
  expect(await rooms()).toEqual(titles);
  const snapshot = parseSnapshot(JSON.stringify(store.snapshot()));
  const restored = await setupNames(new WaStore(snapshot));
  expect(await restored.rooms()).toEqual(titles);
});

test("an own sender phone is ignored and conflicting phones do not become titles", async () => {
  const { ev, rooms } = await setupNames();
  ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: LID, id: "1", fromMe: true, senderPn: ROOM },
        message: { conversation: "synthetic" },
        messageTimestamp: SECONDS,
        pushName: "Synthetic own name",
      },
    ],
  });
  expect(await rooms()).toEqual({ [LID]: LID.replace("@lid", "") });
  ev.emit("chats.phoneNumberShare", { lid: LID, jid: ROOM });
  ev.emit("chats.phoneNumberShare", { lid: LID, jid: OTHER_PHONE });
  expect(await rooms()).toEqual({ [LID]: LID.replace("@lid", "") });
});
