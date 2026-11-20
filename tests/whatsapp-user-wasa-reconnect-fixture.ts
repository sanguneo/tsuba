import { expect, jest, onTestFinished, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BinaryNode,
  decodeBinaryNode,
  getBinaryNodeChild,
  makeWASocket,
  newLTHashState,
  useMultiFileAuthState,
  type WASocket,
} from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys";
import { WebSocketClient } from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys/lib/Socket/Client/websocket.js";
import { whatsappUserBackend } from "../adapters/whatsapp-user/src/backend";
import { openBaileys } from "../adapters/whatsapp-user/src/baileys";
import { CAPABILITIES } from "../adapters/whatsapp-user/src/capabilities";
import { connectWhatsApp } from "../adapters/whatsapp-user/src/session";
import { createHandler } from "../packages/serve-kit/src/index";
import { bounded, deferred } from "./harness/barriers";
import { ownLid } from "./whatsapp-user-bot-wire-fixtures";
import {
  bot,
  collection,
  key,
  keyName,
  mixedPage,
} from "./whatsapp-user-wasa-patches";

const token = "synthetic-wasa-reconnect-token";
export type Mode =
  | "active"
  | "snapshot"
  | "inactive"
  | "fresh"
  | "stale"
  | "no-key"
  | "more"
  | "absent"
  | "empty"
  | "refused"
  | "tampered";

export async function reconnect(mode: Mode) {
  const dir = await mkdtemp(join(tmpdir(), "wa-wasa-reconnect-"));
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  state.creds.me = { id: "900001:1@s.whatsapp.net", lid: ownLid, name: "test" };
  state.creds.myAppStateKeyId = keyName;
  await saveCreds();
  if (mode !== "no-key")
    await state.keys.set({ "app-state-sync-key": { [keyName]: await key() } });
  await state.keys.set({
    "app-state-sync-version": {
      regular_low: { ...newLTHashState(), version: 6 },
      ...(mode === "fresh" || mode === "stale"
        ? {
            [collection]: {
              ...newLTHashState(),
              version: 1,
              wasaOwner: mode === "stale" ? "900099@lid" : ownLid,
              wasaRoots:
                mode === "stale"
                  ? { [bot]: { id: "old", secret: Buffer.alloc(32, 2) } }
                  : {},
            },
          }
        : {}),
    },
  });

  const page = await mixedPage({
    inactive: mode === "inactive",
    tampered: mode === "tampered",
    external: mode === "snapshot" || mode === "tampered",
  });

  const requests: BinaryNode[] = [];
  const notificationAck = deferred<void>();
  const connect = spyOn(
    WebSocketClient.prototype,
    "connect",
  ).mockImplementation(async function (this: WebSocketClient) {
    Object.defineProperty(this, "isOpen", { value: true });
  });
  let intro = true;
  const send = spyOn(WebSocketClient.prototype, "send").mockImplementation(
    function (this: WebSocketClient, frame, callback) {
      const payload = Buffer.from(frame).subarray((intro ? 4 : 0) + 3);
      intro = false;
      void decodeBinaryNode(payload)
        .then((node) => {
          if (node.tag === "iq" && node.attrs.xmlns === "w:sync:app:state") {
            requests.push(node);
            const firstQuery = requests.length === 1;
            const request = getBinaryNodeChild(
              getBinaryNodeChild(node, "sync"),
              "collection",
            );
            this.emit(`TAG:${node.attrs.id}`, {
              tag: "iq",
              attrs: { type: "result" },
              content: [
                mode === "refused"
                  ? {
                      tag: "error",
                      attrs: { code: "503", text: "Synthetic refusal" },
                    }
                  : {
                      tag: "sync",
                      attrs: {},
                      content:
                        mode === "absent"
                          ? []
                          : [
                              {
                                tag: "collection",
                                attrs: {
                                  name: collection,
                                  has_more_patches: String(
                                    firstQuery && mode === "more",
                                  ),
                                },
                                content:
                                  !firstQuery ||
                                  mode === "empty" ||
                                  request?.attrs.version !== "0"
                                    ? []
                                    : page.nodes,
                              },
                            ],
                    },
              ],
            });
          } else if (
            node.tag === "ack" &&
            node.attrs.id === "synthetic-notification"
          )
            notificationAck.resolve();
          callback?.();
        })
        .catch((error: Error) => callback?.(error));
      return true;
    },
  );
  const made = deferred<WASocket>();
  const link = connectWhatsApp({
    open: () =>
      openBaileys({
        authDir: dir,
        makeSocket(config) {
          const socket = makeWASocket({
            ...config,
            fireInitQueries: false,
            defaultQueryTimeoutMs: 200,
            options: {
              adapter: async (request) => {
                if (!request.url?.endsWith("/synthetic-app-state"))
                  throw new Error("Unexpected synthetic blob request");
                return {
                  config: request,
                  data: page.snapshotStream(),
                  status: 200,
                  statusText: "OK",
                  headers: {},
                };
              },
            },
          });
          socket.groupFetchAllParticipating = async () => ({});
          socket.profilePictureUrl = async () => undefined;
          made.resolve(socket);
          return socket;
        },
      }),
    schedule: () => () => {},
  });
  const { handle } = createHandler({
    token,
    capabilities: CAPABILITIES,
    backend: whatsappUserBackend(link),
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  onTestFinished(async () => {
    server.stop(true);
    try {
      await link.stop();
    } finally {
      send.mockRestore();
      connect.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
  const socket = await bounded(made.promise, "real SDK socket created");
  const muteUpdates: number[] = [];
  socket.ev.on("chats.update", (updates) => {
    for (const update of updates)
      if (update.id === bot && update.muteEndTime)
        muteUpdates.push(Number(update.muteEndTime));
  });
  socket.ev.emit("connection.update", { connection: "open" });
  socket.ev.emit("chats.upsert", [{ id: bot }]);

  return {
    requests,
    muteUpdates,
    async notifyCollection() {
      socket.ws.emit("CB:notification", {
        tag: "notification",
        attrs: {
          id: "synthetic-notification",
          type: "server_sync",
          from: "s.whatsapp.net",
        },
        content: [{ tag: "collection", attrs: { name: collection } }],
      });
      await bounded(notificationAck.promise, "server_sync acknowledged");
    },
    async features() {
      const response = await fetch(new URL("/rooms", server.url), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000),
      });
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("rooms" in body))
        throw new Error("Missing room list");
      const { rooms } = body;
      if (!Array.isArray(rooms)) throw new Error("Invalid room list");
      expect(rooms).toHaveLength(1);
      const room: unknown = rooms[0];
      if (!room || typeof room !== "object" || !("features" in room))
        throw new Error("Missing bot room features");
      const { features } = room;
      if (!features || typeof features !== "object")
        throw new Error("Invalid bot room features");
      return features;
    },
    async finishOfflineWindow() {
      // Advance only the SDK's history wait; keep real I/O and query deadlines.
      const update = { receivedPendingNotifications: true };
      jest.useFakeTimers();
      try {
        socket.ev.emit("connection.update", update);
        jest.advanceTimersByTime(20_000);
        socket.ev.emit("connection.update", update);
      } finally {
        jest.useRealTimers();
      }
      await bounded(
        socket.processingMutex.mutex(async () => {}),
        "offline bootstrap settled",
      );
    },
  };
}
