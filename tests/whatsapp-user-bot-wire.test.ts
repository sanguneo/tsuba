import { expect, test } from "bun:test";
import { createDecipheriv, hkdfSync } from "node:crypto";
import {
  DirectBotSendUnavailableError,
  proto,
} from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys";
import { wrapMuse } from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys/lib/Utils/wasa-envelope.js";
import {
  ackEvent,
  meta,
  muse,
  ownLid,
  participants,
  rootSecret,
  wire,
} from "./whatsapp-user-bot-wire-fixtures";

test("WASA ciphertext matches the independent fixed vector", async () => {
  // whatsmeow 19d61352 msgsecret.go:48–105, independently encoded protobuf:
  // 0a01789a02291a20 || (03 * 32) || 3a051201706a00. HKDF-SHA256 twice,
  // AAD "prompt\0" + ownLid, Node crypto AES-256-GCM, ciphertext || tag.
  const { secretEncryptedMessage } = await wrapMuse(
    {
      conversation: "x",
      messageContextInfo: {
        messageSecret: Buffer.alloc(32, 3),
        botMetadata: { personaId: "p" },
      },
    },
    { id: "prompt", remoteJid: muse, fromMe: true },
    {
      lid: ownLid,
      root: { id: "root-a", secret: rootSecret },
      encIv: Buffer.alloc(12, 2),
    },
  );
  expect(
    Buffer.from(secretEncryptedMessage.encPayload ?? []).toString("hex"),
  ).toBe(
    "7ddbdac7d3f48b3cc3d759778bfc23618288ce6bbc51474088cab620f18616adec785f951666d98f999cf64b905fb71086d6a4bffa107fbc0da8f394ae7312",
  );
});

test.each([meta, muse])(
  "routes Signal to service %s and a clear DSM to the owner",
  async (jid) => {
    const { socket, activateRoot, captured } = await wire();
    if (jid === muse) await activateRoot();
    expect(await socket.canSendDirectBotText(jid)).toBe(true);
    const sent = await socket.sendDirectBotText(jid, "synthetic");
    const frame = captured.find((n) => n.tag === "message");
    expect(frame?.attrs).toMatchObject({
      to: jid,
      type: "text",
      id: sent.key.id,
    });
    const payloads = participants(frame);
    expect([...payloads.keys()].sort()).toEqual([jid, ownLid].sort());
    const dsm = payloads.get(ownLid)?.deviceSentMessage;
    expect(dsm?.destinationJid).toBe(jid);
    const clear = sent.message;
    const secret = clear?.messageContextInfo?.messageSecret;
    expect(secret).toHaveLength(32);
    expect(clear?.conversation).toBe("synthetic");
    expect(dsm?.message?.messageContextInfo?.messageSecret).toEqual(secret);
    expect(dsm?.message?.conversation).toBe("synthetic");
    expect(sent.key).toMatchObject({ remoteJid: jid, fromMe: true });
    expect(sent.status).toBe(proto.WebMessageInfo.Status.SERVER_ACK);
    const bot = payloads.get(jid);
    if (jid === meta) {
      expect(bot?.conversation).toBe("synthetic");
      expect(bot?.messageContextInfo?.botMetadata?.personaId).toBe(
        "867051314767696$760019659443059",
      );
      expect(bot?.messageContextInfo?.messageSecret).toEqual(secret);
      expect(bot?.secretEncryptedMessage).toBeNull();
    } else {
      const envelope = bot?.secretEncryptedMessage;
      expect(Object.keys(bot ?? {})).toEqual(["secretEncryptedMessage"]);
      expect(envelope?.targetMessageKey).toMatchObject({
        remoteJid: muse,
        fromMe: true,
        id: "root-a",
      });
      const iv = envelope?.encIv;
      const payload = envelope?.encPayload;
      if (!iv || !payload) throw new Error("Missing WASA payload");
      expect(iv).toHaveLength(12);
      const seed = hkdfSync("sha256", rootSecret, "", "Bot Message", 32);
      const key = hkdfSync(
        "sha256",
        Buffer.from(seed),
        "",
        `${sent.key.id}${ownLid}${jid}`,
        32,
      );
      const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), iv);
      decipher.setAAD(Buffer.from(`${sent.key.id}\0${ownLid}`));
      decipher.setAuthTag(payload.subarray(-16));
      const inner = proto.Message.decode(
        Buffer.concat([
          decipher.update(payload.subarray(0, -16)),
          decipher.final(),
        ]),
      );
      expect(inner.conversation).toBe("synthetic");
      expect(inner.messageContextInfo?.messageSecret).toEqual(secret);
      expect(inner.messageContextInfo?.botMetadata?.personaId).toBe(
        "1807055946647697$1",
      );
      expect(
        inner.messageContextInfo?.botMetadata?.capabilityMetadata,
      ).toBeDefined();
    }
  },
);

test("unready bot sends fail before any discovery or write", async () => {
  const { socket, state, captured } = await wire();
  for (const jid of [muse, "900003@bot", "900003@s.whatsapp.net"]) {
    expect(await socket.canSendDirectBotText(jid)).toBe(false);
    await expect(socket.sendDirectBotText(jid, "x")).rejects.toBeInstanceOf(
      DirectBotSendUnavailableError,
    );
  }
  delete state.creds.me?.lid;
  expect(await socket.canSendDirectBotText(meta)).toBe(false);
  await expect(socket.sendDirectBotText(meta, "x")).rejects.toBeInstanceOf(
    DirectBotSendUnavailableError,
  );
  expect(captured).toHaveLength(0);
});

test("a root revoked during device discovery prevents the message write", async () => {
  const { socket, state, captured, activateRoot } = await wire(
    undefined,
    async () => {
      await state.keys.set({
        "app-state-sync-version": { regular_high: null },
      });
    },
  );
  await activateRoot();
  await expect(socket.sendDirectBotText(muse, "x")).rejects.toBeInstanceOf(
    DirectBotSendUnavailableError,
  );
  expect(captured.map((node) => node.tag)).toEqual(["iq"]);
});

test("bot Signal sessions cannot reuse keys cached for identical PN digits", async () => {
  const { socket } = await wire();
  const address = socket.signalRepository.jidToSignalProtocolAddress;
  expect(address(meta)).not.toBe(
    address(meta.replace("@bot", "@s.whatsapp.net")),
  );
});

test.each(["401", "403", "404", "429", "403x"])(
  "preserves only known server refusal statuses: %s",
  async (error) => {
    const { socket } = await wire((ws, message) => {
      ws.emit(ackEvent, { attrs: { id: message.attrs.id, error } });
    });
    await expect(socket.sendDirectBotText(meta, "x")).rejects.toMatchObject({
      message: "WhatsApp returned an error acknowledgement",
      output: { statusCode: error === "403x" ? 500 : Number(error) },
    });
  },
);

test.each(["unrelated", "write error", "disconnect"] as const)(
  "rejects %s without leaking ACK listeners",
  async (mode) => {
    const { socket } = await wire((ws, message) => {
      if (mode === "write error") throw new Error("Synthetic transport failed");
      if (mode === "disconnect") ws.emit("close");
      else
        ws.emit(ackEvent, {
          tag: "ack",
          attrs: { id: `other-${message.attrs.id}` },
        });
    });
    const count = socket.ws.listenerCount(ackEvent);
    await expect(socket.sendDirectBotText(meta, "x")).rejects.toThrow(
      mode === "disconnect"
        ? /closed before acknowledgement/
        : mode === "unrelated"
          ? /timed out/
          : /Synthetic transport failed/,
    );
    expect(socket.ws.listenerCount(ackEvent)).toBe(count);
  },
);
