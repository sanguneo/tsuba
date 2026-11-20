import { expect, mock, test } from "bun:test";
import {
  type BinaryNode,
  encodeWAMessage,
  proto,
} from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys";
import {
  bot,
  decode,
  editVector,
  enc,
  invalidProto,
  meta,
  pn,
  pnVector,
  prompt,
  promptKey,
  repository,
  secret,
  stanza,
  vector,
} from "./whatsapp-user-direct-bot-decoder-fixtures";

test.each([
  ["no sender", vector, {}, {}],
  ["explicit own device PN", pnVector, { target_sender_jid: pn }, {}],
  ["first", vector, {}, { edit: "first", edit_target_id: "segment" }],
  [
    "inner edit target",
    editVector,
    {},
    { edit: "inner", edit_target_id: "segment" },
  ],
  [
    "last with stanza-ID fallback",
    vector,
    {},
    { edit: "last", edit_target_id: "segment" },
  ],
  [
    "full ignores edit target",
    vector,
    {},
    { edit: "full", edit_target_id: "segment" },
  ],
] as const)(
  "authenticates %s and looks up exactly the own prompt",
  async (_, hex, target, attrs) => {
    const msg = await decode(
      stanza([meta(target), { tag: "bot", attrs }, enc(hex)]),
    );
    expect(msg.message?.conversation).toBe("hello");
    expect(msg.key).toMatchObject({ remoteJid: bot, fromMe: false });
    expect(msg.lookup.mock.calls).toEqual([[promptKey]]);
    expect(msg.diagnostic).not.toHaveBeenCalled();
    expect(msg.room).not.toHaveBeenCalled();
  },
);

test.each([
  [
    "tampered tag",
    [meta(), enc(`${vector.slice(0, -2)}00`)],
    "authentication-failed",
  ],
  [
    "authenticated invalid protobuf",
    [meta(), enc(invalidProto)],
    "invalid-payload",
  ],
  [
    "third-party sender",
    [meta({ target_sender_jid: "7@lid" }), enc(vector)],
    "invalid-target",
  ],
  [
    "PN number in LID namespace",
    [meta({ target_sender_jid: "900003@lid" }), enc(vector)],
    "invalid-target",
  ],
  ["no prompt id", [meta({ target_id: "" }), enc(vector)], "invalid-target"],
  ["duplicate meta", [meta(), meta(), enc(vector)], "invalid-target"],
  [
    "plaintext sibling",
    [
      meta(),
      enc(vector),
      { tag: "plaintext", attrs: {}, content: Uint8Array.of(10, 0) },
    ],
    "unsupported-envelope",
  ],
  [
    "v3",
    [meta(), { ...enc(vector), attrs: { type: "msmsg", v: "3" } }],
    "unsupported-envelope",
  ],
  [
    "unknown protobuf version",
    [meta(), enc(`0d03000000${vector}`)],
    "unsupported-envelope",
  ],
  [
    "unknown edit",
    [meta(), { tag: "bot", attrs: { edit: "other" } }, enc(vector)],
    "unsupported-envelope",
  ],
  ["malformed outer protobuf", [meta(), enc("ff")], "invalid-payload"],
] satisfies [string, BinaryNode[], string][])(
  "rejects %s without exposing data or creating a room",
  async (_, children, reason) => {
    const msg = await decode(stanza(children));
    expect(msg.message).toBeUndefined();
    expect(msg.messageStubType).toBe(proto.WebMessageInfo.StubType.CIPHERTEXT);
    expect(msg.diagnostic.mock.calls).toEqual([[reason]]);
    expect(msg.room).not.toHaveBeenCalled();
    if (reason === "invalid-target" || reason === "unsupported-envelope")
      expect(msg.lookup).not.toHaveBeenCalled();
  },
);

test("no own secret yields only redacted evidence and a private room observation", async () => {
  for (const found of [
    undefined,
    { secretEncryptedMessage: {} },
    { messageContextInfo: { messageSecret: secret.slice(1) } },
  ]) {
    const msg = await decode(stanza([meta(), enc(vector)]), async () => found);
    expect(msg.message).toBeUndefined();
    expect(msg.diagnostic.mock.calls).toEqual([["missing-secret"]]);
    expect(msg.room.mock.calls).toEqual([[bot]]);
  }
});

test("routes only the authenticated matching destination in an own Signal phone copy", async () => {
  const copy = stanza(
    [{ tag: "enc", attrs: { type: "msg" }, content: Uint8Array.of(1) }],
    {
      id: "prompt",
      from: "900003:1@s.whatsapp.net",
      recipient: bot,
    },
  );
  const decryptMessage = mock(async () =>
    encodeWAMessage({
      deviceSentMessage: { destinationJid: bot, message: prompt },
    }),
  );
  const msg = await decode(copy, undefined, { ...repository, decryptMessage });
  expect(msg.key).toMatchObject(promptKey);
  expect(msg.message?.messageContextInfo?.messageSecret).toEqual(secret);
  expect(decryptMessage.mock.calls).toHaveLength(1);
  const mismatch = await decode(copy, undefined, {
    ...repository,
    decryptMessage: async () =>
      encodeWAMessage({
        deviceSentMessage: { destinationJid: "7@bot", message: prompt },
      }),
  });
  expect(mismatch.message).toBeUndefined();
  const clear = await decode({
    ...copy,
    content: [
      {
        tag: "plaintext",
        attrs: {},
        content: proto.Message.encode(prompt).finish(),
      },
    ],
  });
  expect(clear.message).toBeUndefined();
});

test("group, inline, invalid bot and non-own recipient cannot enter a direct bot chat", async () => {
  for (const node of [
    stanza([meta(), enc(vector)], { participant: pn }),
    stanza([meta({ target_chat_jid: "7@g.us" }), enc(vector)]),
    stanza([enc(vector)], { from: "7@g.us", recipient: bot }),
    stanza([enc(vector)], { from: "invalid@bot" }),
    stanza([enc(vector)], { from: "900002@s.whatsapp.net", recipient: bot }),
  ])
    await expect(decode(node)).rejects.toThrow();
});

test("normal direct traffic never enters the bot lookup or evidence path", async () => {
  const human = "7@s.whatsapp.net";
  const msg = await decode(
    stanza(
      [
        {
          tag: "plaintext",
          attrs: {},
          content: proto.Message.encode({ conversation: "ordinary" }).finish(),
        },
      ],
      { from: human },
    ),
  );
  expect(msg.key).toMatchObject({ remoteJid: human, fromMe: false });
  expect(msg.message?.conversation).toBe("ordinary");
  expect(msg.lookup).not.toHaveBeenCalled();
  expect(msg.diagnostic).not.toHaveBeenCalled();
  expect(msg.room).not.toHaveBeenCalled();
});

test("an msmsg outside a direct bot room has no content or bot evidence", async () => {
  for (const attrs of [
    { from: "7@s.whatsapp.net" },
    { from: "8@g.us", participant: bot },
  ] satisfies BinaryNode["attrs"][]) {
    const msg = await decode(stanza([meta(), enc(vector)], { ...attrs }));
    expect(msg.message).toBeUndefined();
    expect(msg.messageStubType).toBe(proto.WebMessageInfo.StubType.CIPHERTEXT);
    expect(msg.lookup).not.toHaveBeenCalled();
    expect(msg.diagnostic).not.toHaveBeenCalled();
    expect(msg.room).not.toHaveBeenCalled();
  }
});
