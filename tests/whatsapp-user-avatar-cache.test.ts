import { expect, test } from "bun:test";
import { RoomAvatars } from "../adapters/whatsapp-user/src/room-avatars";
import type { Room } from "../packages/serve-kit/src/index";
import { bounded, deferred } from "./harness/barriers";

function rooms(count: number): Room[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${i}@s.whatsapp.net`,
    title: "Synthetic",
    kind: "direct",
    unread: 0,
  }));
}

const fetchFn = async () =>
  new Response(new Uint8Array([255, 216, 255, 217]), {
    headers: { "content-type": "image/jpeg" },
  });

test("parallel lists never exceed four SDK and download jobs globally", async () => {
  const started = deferred<void>();
  const release = deferred<void>();
  let active = 0;
  let peak = 0;
  let calls = 0;
  const avatars = new RoomAvatars(
    async () => {
      calls++;
      peak = Math.max(peak, ++active);
      if (active === 4) started.resolve();
      await release.promise;
      active--;
      return "https://pps.whatsapp.net/image";
    },
    { fetchFn },
  );
  const first = avatars.rooms(rooms(8));
  const second = avatars.rooms(
    rooms(8).map((room) => ({ ...room, id: `other-${room.id}` })),
  );
  await bounded(started.promise, "four lookup slots occupied");
  expect(calls).toBe(4);
  release.resolve();
  const results = await Promise.all([first, second]);
  expect(peak).toBe(4);
  expect(calls).toBe(16);
  expect(results.flat().filter((room) => room.avatar)).toHaveLength(16);
});

test("the snapshot cache evicts beyond 500 rooms without accepting evicted IDs", async () => {
  let counter = 0;
  const avatars = new RoomAvatars(
    async () => "https://pps.whatsapp.net/image",
    {
      fetchFn: async () =>
        new Response(
          new Uint8Array([
            255,
            216,
            255,
            counter++ % 256,
            Math.floor(counter / 256),
          ]),
          {
            headers: { "content-type": "image/jpeg" },
          },
        ),
    },
  );
  const result = await avatars.rooms(rooms(501));
  const oldest = result[0]?.avatar;
  const latest = result[500]?.avatar;
  if (!oldest || !latest) throw new Error("Missing picture IDs");
  expect(() => avatars.media(oldest, new AbortController().signal)).toThrow();
  expect(avatars.media(latest, new AbortController().signal).mimeType).toBe(
    "image/jpeg",
  );
});

test("refreshing an unchanged photo retains its ID across CDN URL rotations", async () => {
  let now = 0;
  let version = 0;
  const avatars = new RoomAvatars(
    async () => `https://pps.whatsapp.net/${version++}`,
    {
      fetchFn,
      now: () => now,
    },
  );
  const first = await avatars.rooms(rooms(1));
  now = 300_001;
  const second = await avatars.rooms(rooms(1));
  expect(second[0]?.avatar).toBe(first[0]?.avatar);
  expect(version).toBe(2);
});

test("overlapping room lists bound outstanding distinct lookups to 500", async () => {
  const release = deferred<void>();
  let calls = 0;
  const avatars = new RoomAvatars(
    async () => {
      calls++;
      await release.promise;
      return undefined;
    },
    { fetchFn },
  );
  const jobs = Array.from({ length: 126 }, (_, batch) =>
    avatars.rooms(
      rooms(4).map((room) => ({
        ...room,
        id: `${batch}-${room.id}`,
      })),
    ),
  );
  release.resolve();
  await Promise.all(jobs);
  expect(calls).toBe(500);
});
