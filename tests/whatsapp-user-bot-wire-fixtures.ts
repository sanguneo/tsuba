import { onTestFinished, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BinaryNode,
  DEFAULT_CONNECTION_CONFIG,
  decodeBinaryNode,
  getBinaryNodeChild,
  getBinaryNodeChildren,
  makeWASocket,
  newLTHashState,
  proto,
  unpadRandomMax16,
  useMultiFileAuthState,
} from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys";
import { WebSocketClient } from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys/lib/Socket/Client/websocket.js";

// Public service identifiers from whatsmeow types/jid.go; all account data is synthetic.
export const muse = "1807055946647697@bot";
export const meta = "867051314767696@bot";
export const ownLid = "900001@lid";
export const ackEvent = "CB:ack,class:message";
export const rootSecret = Buffer.alloc(32, 1);

type Peer = (ws: WebSocketClient, message: BinaryNode) => void;
export const accepted: Peer = (ws, node) => {
  ws.emit(ackEvent, {
    tag: "ack",
    attrs: { class: "message", id: node.attrs.id },
  });
};

export async function wire(
  peer: Peer = accepted,
  onDiscovery?: () => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "wa-wire-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const { state } = await useMultiFileAuthState(dir);
  state.creds.me = {
    id: "900002:1@s.whatsapp.net",
    lid: "900001:1@lid",
    name: "test",
  };
  const captured: BinaryNode[] = [];
  let intro = true;
  const connect = spyOn(
    WebSocketClient.prototype,
    "connect",
  ).mockImplementation(async function (this: WebSocketClient) {
    Object.defineProperty(this, "isOpen", { value: true });
  });
  onTestFinished(() => connect.mockRestore());
  const write = spyOn(WebSocketClient.prototype, "send").mockImplementation(
    function (this: WebSocketClient, frame, callback) {
      // No handshake, therefore Noise's frame carries the encoded binary node.
      const payload = Buffer.from(frame).subarray((intro ? 4 : 0) + 3);
      intro = false;
      void decodeBinaryNode(payload)
        .then(async (node) => {
          captured.push(node);
          if (node.tag === "iq" && node.attrs.xmlns === "usync") {
            await onDiscovery?.();
            this.emit(`TAG:${node.attrs.id}`, {
              tag: "iq",
              attrs: { type: "result" },
            });
          } else if (node.tag === "message") {
            peer(this, node);
          } else {
            throw new Error("Unexpected fixture frame");
          }
          callback?.();
        })
        .catch((err: Error) => callback?.(err));
      return true;
    },
  );
  onTestFinished(() => write.mockRestore());

  const logger = DEFAULT_CONNECTION_CONFIG.logger.child({});
  logger.level = "silent";
  const socket = makeWASocket({
    auth: state,
    logger,
    defaultQueryTimeoutMs: 150,
    makeSignalRepository(auth) {
      return {
        ...DEFAULT_CONNECTION_CONFIG.makeSignalRepository(auth),
        // Preserve the exact bytes handed to Signal so the test can inspect them.
        encryptMessage: async ({ data }) => ({ type: "msg", ciphertext: data }),
      };
    },
  });
  onTestFinished(() => socket.end(undefined));
  const address = socket.signalRepository.jidToSignalProtocolAddress;
  await state.keys.set({
    session: Object.fromEntries(
      [muse, meta, ownLid].map((jid) => [address(jid), Buffer.of(1)]),
    ),
  });
  async function activateRoot() {
    const active = {
      ...newLTHashState(),
      wasaOwner: ownLid,
      wasaRoots: { [muse]: { id: "root-a", secret: rootSecret } },
    };
    await state.keys.set({
      "app-state-sync-version": { regular_high: active },
    });
  }
  return { socket, state, captured, activateRoot };
}

export function participants(node: BinaryNode | undefined) {
  if (!node) throw new Error("No outbound message");
  const result = new Map<string, proto.Message>();
  for (const to of getBinaryNodeChildren(
    getBinaryNodeChild(node, "participants"),
    "to",
  )) {
    const enc = getBinaryNodeChild(to, "enc");
    const bytes = enc?.content;
    if (
      !to.attrs.jid ||
      enc?.attrs.type !== "msg" ||
      !(bytes instanceof Uint8Array)
    )
      throw new Error("Expected a Signal participant");
    result.set(to.attrs.jid, proto.Message.decode(unpadRandomMax16(bytes)));
  }
  return result;
}
