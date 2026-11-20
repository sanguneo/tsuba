import { expect, mock, test } from "bun:test";
import { createCipheriv, hkdfSync } from "node:crypto";
import {
  type BaileysEventMap,
  type BinaryNode,
  DEFAULT_CONNECTION_CONFIG,
  decryptMessageNode,
  initAuthCreds,
  makeEventBuffer,
  proto,
} from "@whiskeysockets/baileys";
import processMessage from "@whiskeysockets/baileys/lib/Utils/process-message.js";
import {
  bot,
  meta,
  pn,
  prompt,
  repository,
  secret,
  stanza,
} from "../../../tests/whatsapp-user-direct-bot-decoder-fixtures.ts";

function varint(value: number): Buffer {
  const bytes = [];
  for (let rest = value; ; rest >>>= 7) {
    if (rest < 128) return Buffer.from([...bytes, rest]);
    bytes.push((rest & 127) | 128);
  }
}

function field(tag: number, value: Buffer | string): Buffer {
  const data = Buffer.from(value);
  return Buffer.concat([varint((tag << 3) | 2), varint(data.length), data]);
}

const data = (...texts: string[]) =>
  Buffer.from(
    texts
      .map((text) =>
        JSON.stringify({ sections: [{ view_model: { primitive: { text } } }] }),
      )
      .join("\n"),
  );
const originalData = data("Synthetic draft", "초안");
const editedData = data("Synthetic revision", "수정");
const rich = (data: Buffer) => field(97, field(3, field(1, data)));

function protocolEdit(
  replacement: Buffer,
  key = field(3, "reply"),
  type = 14,
): Buffer {
  // Message.protocolMessage (12), ProtocolMessage.key (1), type (2),
  // editedMessage (14), timestampMs (15). Encode independently of WAProto.
  return field(
    12,
    Buffer.concat([
      field(1, key),
      Buffer.from([0x10, type]),
      field(14, replacement),
      Buffer.from([0x78, ...varint(2500)]),
    ]),
  );
}

const receiver = "900002@lid";
const device = receiver.replace("@", ":7@");
const logger = DEFAULT_CONNECTION_CONFIG.logger;

async function receive(
  message: Buffer,
  encryptedId: string,
  children: readonly BinaryNode[] = [],
  stanzaId = encryptedId,
) {
  const derive = (input: ArrayBuffer | Uint8Array, info: string) =>
    hkdfSync("sha256", input, Buffer.alloc(0), info, 32);
  const key = derive(
    derive(secret, "Bot Message"),
    `${encryptedId}${receiver}${bot}`,
  );
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), iv);
  cipher.setAAD(Buffer.from(`${encryptedId}\0${bot}`));
  const payload = Buffer.concat([
    cipher.update(message),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const node = stanza(
    [
      meta(),
      ...children,
      {
        tag: "enc",
        attrs: { type: "msmsg", v: "2" },
        content: Buffer.concat([field(2, iv), field(3, payload)]),
      },
    ],
    { id: stanzaId },
  );
  const diagnostic = mock((_reason: string) => {});
  const ingress = decryptMessageNode(node, pn, device, repository, logger, {
    getMessage: async () => prompt,
    onBotReceiveDiagnostic: diagnostic,
  });
  const outcome = await ingress.decrypt();
  return { received: ingress.fullMessage, outcome, diagnostic };
}

const editMetadata: BinaryNode = {
  tag: "bot",
  attrs: { edit: "last", edit_target_id: "reply" },
};

test("authenticated original rich response preserves unified response wire bytes", async () => {
  const { received } = await receive(rich(originalData), "reply");
  expect(received.key).toMatchObject({
    id: "reply",
    remoteJid: bot,
    fromMe: false,
  });
  expect(received.message?.richResponseMessage?.unifiedResponse?.data).toEqual(
    originalData,
  );
});

test.each([undefined, false, true])(
  "authenticated rich edit emits decoded bytes under the original message key (protocol fromMe: %s)",
  async (fromMe) => {
    const key =
      fromMe === undefined
        ? field(3, "reply")
        : Buffer.concat([
            field(1, fromMe ? receiver : bot),
            Buffer.from([0x10, Number(fromMe)]),
            field(3, "reply"),
          ]);
    const { received } = await receive(
      protocolEdit(rich(editedData), key),
      "reply",
      [editMetadata],
      "edit",
    );
    const edits: BaileysEventMap["messages.update"] = [];
    const ev = makeEventBuffer(logger);
    ev.on("messages.update", (updates) => edits.push(...updates));
    await processMessage(received, {
      shouldProcessHistoryMsg: false,
      ev,
      creds: { ...initAuthCreds(), me: { id: pn, lid: device } },
      keyStore: {
        get: () => ({}),
        set: () => {},
        isInTransaction: () => false,
        transaction: (exec) => exec(),
      },
      options: {},
    });
    expect(edits).toHaveLength(1);
    expect(edits[0]?.key).toMatchObject({
      id: "reply",
      remoteJid: bot,
      fromMe: false,
    });
    expect(edits[0]?.update.messageTimestamp).toBe(2);
    expect(
      edits[0]?.update.message?.editedMessage?.message?.richResponseMessage
        ?.unifiedResponse?.data,
    ).toEqual(editedData);
  },
);

test.each([
  [
    "another protocol action",
    protocolEdit(rich(editedData), field(3, "reply"), 0),
  ],
  ["a missing original ID", protocolEdit(rich(editedData), Buffer.alloc(0))],
  [
    "a mismatched original ID",
    protocolEdit(rich(editedData), field(3, "mismatch")),
  ],
  [
    "a cross-chat protocol key",
    protocolEdit(
      rich(editedData),
      Buffer.concat([field(1, "900004@bot"), field(3, "reply")]),
    ),
  ],
  ["a non-rich replacement", protocolEdit(field(1, "synthetic"))],
  ["empty unified data", protocolEdit(rich(Buffer.alloc(0)))],
  [
    "a protocol edit mixed with ordinary content",
    Buffer.concat([protocolEdit(rich(editedData)), field(1, "synthetic")]),
  ],
] as const)("authenticated bot ingress rejects %s", async (_reason, frame) => {
  const { received } = await receive(frame, "reply", [editMetadata], "edit");
  expect(received.message).toBeUndefined();
  expect(received.messageStubType).toBe(
    proto.WebMessageInfo.StubType.CIPHERTEXT,
  );
  expect(received.messageStubParameters).toEqual(["unsupported-envelope"]);
});

test.each([undefined, 35])(
  "authenticated metadata-only operation is silently skipped (protocol type: %s)",
  async (type) => {
    // ProtocolMessage.aiMetadataOperation (31) wraps hatchMetadataSync (1).
    const operation = field(31, field(1, Buffer.alloc(0)));
    const protocol =
      type === undefined
        ? operation
        : Buffer.concat([Buffer.from([0x10, type]), operation]);
    const { received, outcome, diagnostic } = await receive(
      field(12, protocol),
      "metadata",
    );
    expect(outcome).toBe("ignored-metadata");
    expect(received.message).toBeUndefined();
    expect(received.messageStubType).not.toBe(
      proto.WebMessageInfo.StubType.CIPHERTEXT,
    );
    expect(diagnostic).not.toHaveBeenCalled();
  },
);
