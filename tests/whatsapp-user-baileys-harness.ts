import { onTestFinished } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proto } from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys";
import {
  type BaileysEvents,
  type BaileysLike,
  type BaileysOptions,
  openBaileys,
} from "../adapters/whatsapp-user/src/baileys";
import type { WaSocketEvent } from "../adapters/whatsapp-user/src/types";
import { bounded, deferred } from "./harness/barriers";
import { ROOM } from "./whatsapp-user-fixtures";

export async function setup(
  fetchGroups: BaileysLike["groupFetchAllParticipating"] = async () => ({}),
) {
  const authDir = await mkdtemp(join(tmpdir(), "tsuba-wa-"));
  const handlers = new EventEmitter();
  const calls: { jid: string; content: unknown; options: unknown }[] = [];
  const pictures: {
    jid: string;
    type: string | undefined;
    timeout: number | undefined;
  }[] = [];
  let ended = 0;
  const made =
    deferred<Parameters<NonNullable<BaileysOptions["makeSocket"]>>[0]>();
  const socket: BaileysLike = {
    profilePictureUrl: async (jid, type, timeout) => {
      pictures.push({ jid, type, timeout });
      return undefined;
    },
    ev: {
      on(event, listener) {
        handlers.on(event, listener);
      },
    },
    async sendMessage(jid, content, options) {
      calls.push({ jid, content, options });
      return proto.WebMessageInfo.fromObject({
        key: { remoteJid: ROOM, id: "9000", fromMe: true },
        message: { conversation: "sent" },
        messageTimestamp: 1,
      });
    },
    groupFetchAllParticipating: fetchGroups,
    end() {
      ended++;
    },
  };
  const wa = openBaileys({
    authDir,
    makeSocket(given) {
      made.resolve(given);
      return socket;
    },
  });
  onTestFinished(async () => {
    await wa.close();
    await rm(authDir, { recursive: true, force: true });
  });
  const events: WaSocketEvent[] = [];
  wa.onEvent((event) => events.push(event));
  const config = await bounded(made.promise, "socket created");
  function emit<E extends keyof BaileysEvents & string>(
    event: E,
    data: BaileysEvents[E],
  ) {
    handlers.emit(event, data);
  }
  return {
    wa,
    events,
    emit,
    calls,
    pictures,
    authDir,
    config: () => config,
    ended: () => ended,
  };
}
