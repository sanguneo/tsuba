import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { GROUP, ROOM } from "./whatsapp-user-fixtures";
import { setupCache } from "./whatsapp-user-persistence-harness";

test("restored rooms retain metadata but refresh process-local pictures only after connection opens", async () => {
  const app = await setupCache();
  let bytes = new Uint8Array([255, 216, 255, 217]);
  const options = {
    fetchFn: async () =>
      new Response(bytes, { headers: { "content-type": "image/jpeg" } }),
  };
  const url = "https://pps.whatsapp.net/synthetic.jpg";
  const first = await app.start(options);
  first.link.profilePictureUrl = async () => url;
  first.link.push({ type: "chats", chats: [{ id: ROOM }, { id: GROUP }] });
  first.link.push({
    type: "names",
    names: [{ id: ROOM, name: "Synthetic Direct" }],
  });
  first.link.push({
    type: "groups",
    groups: [{ id: GROUP, subject: "Synthetic Group" }],
  });
  const before = await first.backend.listRooms?.();
  assert(before);
  const oldId = before.rooms[0]?.avatar;
  assert(oldId);
  expect(oldId).toMatch(/^wa-room-v1-[a-f0-9]{64}$/);
  await first.cache.flush();
  const saved = await readFile(app.path, "utf8");
  expect(JSON.parse(saved)).toEqual(first.cache.store.snapshot());
  expect(saved).not.toContain(oldId);
  expect(saved).not.toContain(url);

  const restarted = await app.start(options);
  restarted.link.setState("connecting");
  let lookups = 0;
  restarted.link.profilePictureUrl = async () => {
    lookups++;
    return restarted.link.state() === "open" ? url : undefined;
  };
  const offline = await restarted.backend.listRooms?.();
  assert(offline);
  expect(offline.rooms).toEqual(first.cache.store.rooms());
  expect(offline.rooms.map((room) => room.title).sort()).toEqual([
    "Synthetic Direct",
    "Synthetic Group",
  ]);
  expect(lookups).toBe(0);
  await expect(
    restarted.backend.media?.(oldId, new AbortController().signal),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });

  bytes = new Uint8Array([255, 216, 255, 218]);
  restarted.link.setState("open");
  const after = await restarted.backend.listRooms?.();
  assert(after);
  expect(lookups).toBe(2);
  expect(after.rooms.every((room) => room.avatar !== undefined)).toBe(true);
  expect(after.rooms[0]?.avatar).not.toBe(oldId);
  expect(restarted.cache.store.snapshot()).toEqual(JSON.parse(saved));
  expect(app.failures()).toBe(0);
});
