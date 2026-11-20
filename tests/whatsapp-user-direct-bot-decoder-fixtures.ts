import { mock } from "bun:test";
import {
  type BinaryNode,
  DEFAULT_CONNECTION_CONFIG,
  decryptMessageNode,
  type SignalRepository,
  type SocketConfig,
} from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys";

export const bot = "900001@bot";
const lid = "900002:7@lid";
export const pn = "900003:7@s.whatsapp.net";
export const promptKey = { id: "prompt", remoteJid: bot, fromMe: true };
export const secret = Uint8Array.from({ length: 32 }, (_, i) => i);
export const prompt = {
  conversation: "test",
  messageContextInfo: { messageSecret: secret },
};

// Fixed independent Node crypto vectors: HKDF-SHA256 twice, AES-256-GCM,
// hand-encoded protobuf bytes 0a0568656c6c6f ("hello"), no Signal padding.
export const vector =
  "120c0101010101010101010101011a17b638af92be6ac5efa8a05f3ae6be4b1ebf363f4d87e095";
export const editVector =
  "120c0202020202020202020202021a17dc2fd330301da3680a15c815c1c80e5a78d3730491c6ba";
export const pnVector =
  "120c0303030303030303030303031a17cd1ba430b919a3100a81f2bca14d614ce5b46d32a62991";
export const invalidProto =
  "120c0404040404040404040404041a11e7615895e6a89af78b694b4a8965be1e1d";

function unexpected(): never {
  throw new Error("Unexpected Signal operation");
}
export const repository: SignalRepository = {
  decryptMessage: unexpected,
  decryptGroupMessage: unexpected,
  encryptGroupMessage: unexpected,
  encryptMessage: unexpected,
  processSenderKeyDistributionMessage: unexpected,
  injectE2ESession: unexpected,
  jidToSignalProtocolAddress: unexpected,
};
export const enc = (hex: string): BinaryNode => ({
  tag: "enc",
  attrs: { type: "msmsg", v: "2" },
  content: Buffer.from(hex, "hex"),
});
export const meta = (attrs: BinaryNode["attrs"] = {}): BinaryNode => ({
  tag: "meta",
  attrs: { target_id: "prompt", ...attrs },
});
export function stanza(
  content: BinaryNode[],
  attrs: BinaryNode["attrs"] = {},
): BinaryNode {
  return {
    tag: "message",
    attrs: { from: bot, id: "reply", t: "1", ...attrs },
    content,
  };
}
export async function decode(
  node: BinaryNode,
  getMessage: SocketConfig["getMessage"] = async (key) =>
    key.id === promptKey.id && key.remoteJid === bot && key.fromMe === true
      ? prompt
      : undefined,
  signal = repository,
) {
  const lookup = mock(getMessage);
  const diagnostic = mock((_reason: string) => {});
  const room = mock((_jid: string) => {});
  const received = decryptMessageNode(
    node,
    pn,
    lid,
    signal,
    DEFAULT_CONNECTION_CONFIG.logger,
    {
      getMessage: lookup,
      onBotReceiveDiagnostic: diagnostic,
      onBotCiphertextRoom: room,
    },
  );
  await received.decrypt();
  return { ...received.fullMessage, lookup, diagnostic, room };
}
