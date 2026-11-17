import { expect, test } from "bun:test";
import { linkAccount } from "../adapters/whatsapp-user/src/login";
import { bounded } from "./harness/barriers";
import { GROUP, ROOM, socketFactory, text } from "./whatsapp-user-fixtures";
import { setupCache } from "./whatsapp-user-persistence-harness";

test("login retains history after open and a fresh store serves its rooms and names", async () => {
  const { start } = await setupCache();
  const { cache } = await start();
  const factory = socketFactory();
  const result = linkAccount({
    open: factory.open,
    onQr() {},
    signal: new AbortController().signal,
    cache,
    schedule: () => () => {},
  });
  const socket = factory.sockets[0];
  if (!socket) throw new Error("synthetic socket missing");
  socket.emit({ type: "open" });
  await Promise.resolve();
  expect(socket.closed).toBe(false);
  socket.emit({ type: "chats", chats: [{ id: ROOM }, { id: GROUP }] });
  socket.emit({ type: "names", names: [{ id: ROOM, name: "Saved friend" }] });
  socket.emit({
    type: "groups",
    groups: [{ id: GROUP, subject: "Synthetic group" }],
  });
  socket.emit({
    type: "messages",
    messages: [text("1", "history")],
    live: false,
  });
  socket.emit({ type: "historySyncComplete" });
  expect(await bounded(result, "history saved")).toEqual({ linked: true });
  expect(socket.closed).toBe(true);
  const restored = await start();
  expect(await restored.get("/rooms")).toMatchObject({
    rooms: [
      { id: ROOM, title: "Saved friend" },
      { id: GROUP, title: "Synthetic group" },
    ],
  });
  expect(
    await restored.get(`/messages?roomId=${ROOM}&limit=100`),
  ).toMatchObject({ messages: [{ text: "history" }] });
});

for (const partial of [false, true]) {
  test(`login saves ${partial ? "partial" : "empty"} history at its post-open deadline`, async () => {
    const { start } = await setupCache();
    const { cache } = await start();
    const factory = socketFactory();
    const controller = new AbortController();
    const timers: { run: () => void; delay: number; cancelled: boolean }[] = [];
    const result = linkAccount({
      open: factory.open,
      onQr() {},
      signal: controller.signal,
      cache,
      schedule(run, delay) {
        const timer = { run, delay, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    });
    const socket = factory.sockets[0];
    if (!socket) throw new Error("synthetic socket missing");
    expect(timers).toHaveLength(0);
    socket.emit({ type: "open" });
    socket.emit({ type: "open" });
    controller.abort();
    if (partial) {
      socket.emit({
        type: "chats",
        chats: [{ id: ROOM, name: "Partial friend" }],
      });
    }
    expect(socket.closed).toBe(false);
    expect(timers.map(({ delay }) => delay)).toEqual([60_000]);
    timers[0]?.run();
    expect(await bounded(result, "history deadline")).toEqual({ linked: true });
    socket.emit({ type: "chats", chats: [{ id: GROUP }] });
    expect(timers[0]?.cancelled).toBe(true);
    const restored = await start();
    expect(
      restored.cache.store.rooms().map(({ id, title }) => ({ id, title })),
    ).toEqual(partial ? [{ id: ROOM, title: "Partial friend" }] : []);
  });
}
