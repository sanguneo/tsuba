import { onTestFinished } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addTransactionCapability,
  proto,
  type WASocket,
} from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys";
import {
  type BaileysEvents,
  type BaileysLike,
  type BaileysOptions,
  openBaileys,
} from "../adapters/whatsapp-user/src/baileys";
import type { WaSocketEvent } from "../adapters/whatsapp-user/src/types";
import { bounded, deferred } from "./harness/barriers";
import { ROOM } from "./whatsapp-user-fixtures";

export function fakeAuthState(
  config: Parameters<NonNullable<BaileysOptions["makeSocket"]>>[0],
): WASocket["authState"] {
  if (!config.logger) throw new Error("Missing socket logger");
  return {
    creds: config.auth.creds,
    keys: addTransactionCapability(config.auth.keys, config.logger, {
      maxCommitRetries: 1,
      delayBetweenTriesMs: 0,
    }),
  };
}

export async function setup(
  fetchGroups: BaileysLike["groupFetchAllParticipating"] = async () => ({}),
  refreshMedia: BaileysLike["updateMediaMessage"] = async () => {
    throw new Error("Unexpected media refresh");
  },
  findMessage?: BaileysOptions["findMessage"],
) {
  const authDir = await mkdtemp(join(tmpdir(), "tsuba-wa-"));
  const handlers = new EventEmitter();
  const ws = new EventEmitter();
  const calls: { jid: string; content: unknown; options: unknown }[] = [];
  const pictures: {
    jid: string;
    type: string | undefined;
    timeout: number | undefined;
  }[] = [];
  let ended = 0;
  const made =
    deferred<Parameters<NonNullable<BaileysOptions["makeSocket"]>>[0]>();
  const ending = deferred<void>();
  const socket: BaileysLike = {
    ws,
    get authState() {
      if (!authState) throw new Error("Socket not created");
      return authState;
    },
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
      sent.emit("send", options?.messageId);
      return proto.WebMessageInfo.fromObject({
        key: { remoteJid: ROOM, id: options?.messageId, fromMe: true },
        message: { conversation: "sent" },
        messageTimestamp: 1,
      });
    },
    groupFetchAllParticipating: fetchGroups,
    updateMediaMessage: refreshMedia,
    end() {
      ended++;
      ending.resolve();
    },
  };
  const sent = new EventEmitter();
  let authState: WASocket["authState"] | undefined;
  const wa = openBaileys({
    authDir,
    ...(findMessage ? { findMessage } : {}),
    makeSocket(given) {
      authState = fakeAuthState(given);
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
    ws,
    sent,
    calls,
    pictures,
    authDir,
    authKeys: socket.authState.keys,
    ending: ending.promise,
    config: () => config,
    ended: () => ended,
  };
}
