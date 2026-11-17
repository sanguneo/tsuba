import { expect, test } from "bun:test";
import type { BaileysEvents } from "../adapters/whatsapp-user/src/baileys";
import { bounded, deferred } from "./harness/barriers";
import { GROUP, ROOM, SECONDS } from "./whatsapp-user-fixtures";
import { setupNames as setup } from "./whatsapp-user-names-harness";

const LID = "100000000003@lid";
type Groups = Record<string, BaileysEvents["groups.upsert"][number]>;

function group(subject: string): Groups[string] {
  return {
    id: GROUP,
    subject,
    addressingMode: "pn",
    owner: undefined,
    participants: [],
  };
}

function pushed(
  id: string,
  extra: Partial<BaileysEvents["messages.upsert"]["messages"][number]>,
): BaileysEvents["messages.upsert"]["messages"][number] {
  return {
    key: { remoteJid: LID, id, fromMe: false },
    message: { conversation: "synthetic" },
    messageTimestamp: SECONDS + Number(id),
    ...extra,
  };
}

test("opening the connection fetches participating group subjects for /rooms", async () => {
  const { ev, link, groups, fetched, rooms } = await setup();
  const loaded = deferred<void>();
  link.subscribe((event) => {
    if (event.type === "groups") loaded.resolve();
  });
  ev.emit("connection.update", { connection: "open" });
  await bounded(fetched.promise, "participating groups fetched");
  groups.resolve({ [GROUP]: group("Synthetic participants") });
  await bounded(loaded.promise, "group names applied");
  expect(await rooms()).toEqual({ [GROUP]: "Synthetic participants" });
});

test("group subjects survive partial metadata and stale chat names; later renames win", async () => {
  const { ev, rooms } = await setup();
  ev.emit("groups.upsert", [group("Synthetic group")]);
  ev.emit("groups.update", [
    { id: GROUP, announce: true },
    { subject: "No id" },
  ]);
  ev.emit("chats.upsert", [{ id: GROUP, name: "Stale history" }]);
  expect(await rooms()).toEqual({ [GROUP]: "Synthetic group" });
  ev.emit("groups.update", [{ id: GROUP, subject: "Renamed group" }]);
  expect(await rooms()).toEqual({ [GROUP]: "Renamed group" });
});

test.each(["contacts-first", "aliases-first"] as const)(
  "saved contact names resolve both LID and phone rooms with %s",
  async (order) => {
    const { ev, rooms } = await setup();
    ev.emit("chats.upsert", [
      { id: ROOM, name: "Old chat label" },
      { id: LID },
    ]);
    const contacts = () =>
      ev.emit("contacts.upsert", [{ id: ROOM, name: "Saved contact" }]);
    const aliases = () => ev.emit("contacts.update", [{ id: LID, jid: ROOM }]);
    if (order === "contacts-first") {
      contacts();
      aliases();
    } else {
      aliases();
      contacts();
    }
    ev.emit("contacts.update", [{ id: LID, notify: "Public notify" }]);
    expect(await rooms()).toEqual({
      [ROOM]: "Saved contact",
      [LID]: "Saved contact",
    });
  },
);

test("history contact aliases and phone-number shares retain names across partial updates", async () => {
  const { ev, rooms } = await setup();
  ev.emit("messaging-history.set", {
    chats: [{ id: LID }],
    contacts: [{ id: ROOM, lid: LID, notify: "History notify" }],
    messages: [],
  });
  ev.emit("contacts.update", [
    { id: ROOM, imgUrl: "changed" },
    { notify: "No id" },
  ]);
  expect(await rooms()).toEqual({ [LID]: "History notify" });
  const otherLid = "100000000004@lid";
  ev.emit("chats.upsert", [{ id: otherLid }]);
  ev.emit("chats.phoneNumberShare", { lid: otherLid, jid: ROOM });
  expect(await rooms()).toEqual({
    [LID]: "History notify",
    [otherLid]: "History notify",
  });
});

test("incoming pushName fills a direct title, preferring newer messages over late history", async () => {
  const { ev, rooms } = await setup();
  ev.emit("messages.upsert", {
    messages: [pushed("2", { pushName: "Latest push" })],
    type: "notify",
  });
  ev.emit("messages.upsert", {
    messages: [pushed("1", { pushName: "Older history" })],
    type: "append",
  });
  ev.emit("chats.upsert", [{ id: ROOM }]);
  ev.emit("chats.phoneNumberShare", { lid: LID, jid: ROOM });
  expect(await rooms()).toEqual({
    [ROOM]: "Latest push",
    [LID]: "Latest push",
  });
});

test("pushName never replaces a saved contact, explicit chat title or group subject", async () => {
  const { ev, rooms } = await setup();
  ev.emit("chats.upsert", [{ id: ROOM, name: "Explicit chat" }]);
  ev.emit("messages.upsert", {
    messages: [
      pushed("1", {
        key: { remoteJid: ROOM, id: "1" },
        pushName: "Remote push",
      }),
      pushed("2", {
        key: { remoteJid: LID, id: "2", fromMe: true },
        pushName: "Own name",
      }),
      pushed("3", {
        key: { remoteJid: GROUP, id: "3" },
        pushName: "Group participant",
      }),
    ],
    type: "notify",
  });
  expect(await rooms()).toEqual({
    [ROOM]: "Explicit chat",
    [LID]: "100000000003",
    [GROUP]: "100000000002-1700000000",
  });
  ev.emit("contacts.upsert", [
    { id: ROOM, name: "Saved contact", notify: "Notify" },
  ]);
  ev.emit("groups.update", [{ id: GROUP, subject: "Group subject" }]);
  expect(await rooms()).toEqual({
    [ROOM]: "Saved contact",
    [LID]: "100000000003",
    [GROUP]: "Group subject",
  });
});

test("a failed group lookup reports only a safe state and keeps serving later group updates", async () => {
  const { ev, link, fetched, groups, rooms } = await setup();
  const failed = deferred<void>();
  link.subscribe((event) => {
    if (event.type === "groupSyncFailed") {
      expect(event).toEqual({ type: "groupSyncFailed" });
      failed.resolve();
    }
  });
  ev.emit("connection.update", { connection: "open" });
  await bounded(fetched.promise, "participating groups fetched");
  groups.reject(new Error("SYNTHETIC_PRIVATE_GROUP_DATA"));
  await bounded(failed.promise, "group sync failure reported");
  ev.emit("groups.update", [{ id: GROUP, subject: "Recovered subject" }]);
  expect(link.state()).toBe("open");
  expect(await rooms()).toEqual({ [GROUP]: "Recovered subject" });
});

test.each([0, 1])(
  "a successful group lookup reports its count (%i), including a genuinely empty result",
  async (count) => {
    const { ev, link, fetched, groups, rooms } = await setup();
    const complete = deferred<number>();
    const started = deferred<void>();
    link.subscribe((event) => {
      if (event.type === "groupSyncStarted") started.resolve();
      if (event.type === "groupSyncComplete") {
        expect(event).toEqual({ type: "groupSyncComplete", count });
        complete.resolve(event.count);
      }
      if (event.type === "groupSyncFailed")
        throw new Error("Successful lookup reported failure");
    });
    ev.emit("connection.update", { connection: "open" });
    await bounded(started.promise, "group fetch started");
    await bounded(fetched.promise, "group fetch called");
    groups.resolve(count ? { [GROUP]: group("Synthetic subject") } : {});
    expect(await bounded(complete.promise, "group count reported")).toBe(count);
    expect(await rooms()).toEqual(
      count ? { [GROUP]: "Synthetic subject" } : {},
    );
  },
);
