import { expect, onTestFinished } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whatsappUserBackend } from "../adapters/whatsapp-user/src/backend";
import {
  type BaileysEvents,
  openBaileys,
} from "../adapters/whatsapp-user/src/baileys";
import { CAPABILITIES } from "../adapters/whatsapp-user/src/capabilities";
import { connectWhatsApp } from "../adapters/whatsapp-user/src/session";
import { createHandler } from "../packages/serve-kit/src/index";
import { bounded, deferred } from "./harness/barriers";

export async function setupNames() {
  const authDir = await mkdtemp(join(tmpdir(), "tsuba-wa-names-"));
  const emitter = new EventEmitter();
  const ev = {
    on<E extends keyof BaileysEvents>(
      event: E,
      listener: (data: BaileysEvents[E]) => void,
    ) {
      emitter.on(event, listener);
    },
    emit<E extends keyof BaileysEvents>(event: E, data: BaileysEvents[E]) {
      emitter.emit(event, data);
    },
  };
  const made = deferred<void>();
  const fetched = deferred<void>();
  const groups =
    deferred<Record<string, BaileysEvents["groups.upsert"][number]>>();
  const link = connectWhatsApp({
    open: () =>
      openBaileys({
        authDir,
        makeSocket() {
          made.resolve();
          return {
            profilePictureUrl: async () => undefined,
            ev,
            sendMessage: async () => undefined,
            groupFetchAllParticipating() {
              fetched.resolve();
              // Baileys 6.7.24 emits groups.update before resolving this call.
              return groups.promise.then((value) => {
                ev.emit("groups.update", Object.values(value));
                return value;
              });
            },
            end() {},
          };
        },
      }),
    schedule: () => () => {},
  });
  onTestFinished(async () => {
    await link.stop();
    await rm(authDir, { recursive: true, force: true });
  });
  const { handle } = createHandler({
    token: "synthetic-names-token",
    capabilities: CAPABILITIES,
    backend: whatsappUserBackend(link),
  });
  await bounded(made.promise, "synthetic socket ready");
  async function rooms() {
    const response = await handle(
      new Request("http://synthetic/rooms", {
        headers: { authorization: "Bearer synthetic-names-token" },
      }),
    );
    expect(response.status).toBe(200);
    const answer = await response.json();
    if (
      !answer ||
      typeof answer !== "object" ||
      !("rooms" in answer) ||
      !Array.isArray(answer.rooms)
    )
      throw new Error("Missing rooms array");
    const titles: Record<string, string> = {};
    for (const room of answer.rooms) {
      if (
        !room ||
        typeof room !== "object" ||
        !("id" in room) ||
        !("title" in room) ||
        typeof room.id !== "string" ||
        typeof room.title !== "string"
      )
        throw new Error("Missing room id or title");
      titles[room.id] = room.title;
    }
    return titles;
  }
  return { ev, link, groups, fetched, rooms };
}
