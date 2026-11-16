import { expect, test } from "bun:test";
import { linkAccount } from "../adapters/whatsapp-user/src/login";
import {
  connectWhatsApp,
  reconnectDelay,
} from "../adapters/whatsapp-user/src/session";
import type { WaState } from "../adapters/whatsapp-user/src/types";
import { socketFactory, text } from "./whatsapp-user-fixtures";

function setup() {
  const factory = socketFactory();
  const scheduled: { run: () => void; delay: number; cancelled: boolean }[] =
    [];
  const link = connectWhatsApp({
    open: factory.open,
    schedule(run, delay) {
      const entry = { run, delay, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  });
  const states: WaState[] = [];
  link.subscribe((event) => {
    if (event.type === "state") states.push(event.state);
  });
  const current = () => {
    const socket = factory.sockets.at(-1);
    if (!socket) throw new Error("no socket");
    return socket;
  };
  return { ...factory, scheduled, link, states, current };
}

test("backoff doubles from one second and stops at a minute", () => {
  expect([0, 1, 2, 5, 6, 7, 30].map(reconnectDelay)).toEqual([
    1_000, 2_000, 4_000, 32_000, 60_000, 60_000, 60_000,
  ]);
});

test("a dropped connection is reopened with growing delays until one opens", () => {
  const { current, scheduled, sockets, states, link } = setup();
  expect(link.state()).toBe("connecting");
  current().emit({ type: "close", statusCode: 428 });
  expect(link.state()).toBe("reconnecting");
  expect(scheduled.map(({ delay }) => delay)).toEqual([1_000]);
  scheduled[0]?.run();
  expect(sockets).toHaveLength(2);
  current().emit({ type: "close", statusCode: 408 });
  expect(scheduled.map(({ delay }) => delay)).toEqual([1_000, 2_000]);
  scheduled[1]?.run();
  current().emit({ type: "open" });
  expect(link.state()).toBe("open");
  current().emit({ type: "close", statusCode: 428 });
  expect(scheduled.at(-1)?.delay).toBe(1_000);
  expect(states).toEqual(["reconnecting", "open", "reconnecting"]);
});

test("restart-required reopens at once without counting as a failure", () => {
  const { current, scheduled, link } = setup();
  current().emit({ type: "close", statusCode: 515 });
  expect(link.state()).toBe("connecting");
  expect(scheduled.map(({ delay }) => delay)).toEqual([0]);
  scheduled[0]?.run();
  current().emit({ type: "close", statusCode: 428 });
  expect(scheduled.at(-1)?.delay).toBe(1_000);
});

test("logout, takeover and refusal are final: no reconnect, state only", () => {
  for (const [code, state] of [
    [401, "logged-out"],
    [440, "conflict"],
    [403, "forbidden"],
  ] as const) {
    const { current, scheduled, link, sockets } = setup();
    const held = current();
    held.emit({ type: "close", statusCode: code });
    expect(link.state()).toBe(state);
    expect(held.closed).toBe(true);
    expect(scheduled).toHaveLength(0);
    expect(sockets).toHaveLength(1);
  }
});

test("a QR code on a running adapter means it was never linked: final, nothing shown", () => {
  const { current, scheduled, link } = setup();
  const events: string[] = [];
  link.subscribe((event) => events.push(event.type));
  current().emit({ type: "qr", qr: "synthetic-qr" });
  expect(link.state()).toBe("logged-out");
  expect(scheduled).toHaveLength(0);
  expect(events).toEqual(["state"]);
});

test("data events pass through; a replaced socket's late events are ignored", () => {
  const { current, scheduled, link } = setup();
  const seen: string[] = [];
  link.subscribe((event) => {
    if (event.type === "messages") seen.push(event.messages[0]?.key.id ?? "");
  });
  const first = current();
  first.emit({ type: "messages", messages: [text("1", "a")], live: true });
  first.emit({ type: "close", statusCode: 428 });
  scheduled[0]?.run();
  first.emit({ type: "messages", messages: [text("2", "late")], live: true });
  current().emit({ type: "messages", messages: [text("3", "b")], live: true });
  expect(seen).toEqual(["1", "3"]);
});

test("an open that throws is retried with backoff, and stop cancels the pending retry", async () => {
  const scheduled: { delay: number; cancelled: boolean; run: () => void }[] =
    [];
  let attempts = 0;
  const link = connectWhatsApp({
    open() {
      attempts++;
      throw new Error("synthetic");
    },
    schedule(run, delay) {
      const entry = { delay, cancelled: false, run };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  });
  expect(link.state()).toBe("reconnecting");
  scheduled[0]?.run();
  expect(attempts).toBe(2);
  expect(scheduled.map(({ delay }) => delay)).toEqual([1_000, 2_000]);
  await link.stop();
  expect(scheduled[1]?.cancelled).toBe(true);
});

test("login shows every QR code, reopens once after the scan and reports linked", async () => {
  const factory = socketFactory();
  const codes: string[] = [];
  const result = linkAccount({
    open: factory.open,
    onQr: (qr) => codes.push(qr),
    signal: new AbortController().signal,
  });
  const first = factory.sockets[0];
  first?.emit({ type: "qr", qr: "qr-1" });
  first?.emit({ type: "qr", qr: "qr-2" });
  first?.emit({ type: "close", statusCode: 515 });
  await Promise.resolve();
  await Promise.resolve();
  const second = factory.sockets[1];
  second?.emit({ type: "open" });
  expect(await result).toEqual({ linked: true });
  expect(codes).toEqual(["qr-1", "qr-2"]);
  expect(factory.sockets.every(({ closed }) => closed)).toBe(true);
});

test("login ends on any other close and on abort", async () => {
  const closed = socketFactory();
  const failure = linkAccount({
    open: closed.open,
    onQr() {},
    signal: new AbortController().signal,
  });
  closed.sockets[0]?.emit({ type: "close", statusCode: 408 });
  expect(await failure).toEqual({
    linked: false,
    reason: "closed",
    statusCode: 408,
  });
  const aborting = socketFactory();
  const controller = new AbortController();
  const aborted = linkAccount({
    open: aborting.open,
    onQr() {},
    signal: controller.signal,
  });
  controller.abort();
  expect(await aborted).toEqual({ linked: false, reason: "aborted" });
  expect(aborting.sockets[0]?.closed).toBe(true);
});
