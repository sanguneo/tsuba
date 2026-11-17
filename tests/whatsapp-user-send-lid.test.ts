import { expect, test } from "bun:test";
import {
  getBinaryNodeChild,
  getBinaryNodeChildren,
  proto,
  unpadRandomMax16,
} from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys";
import {
  SELF_LID,
  setupSdkSend,
  TARGET_LID,
} from "./whatsapp-user-send-harness";

test.each([SELF_LID, "800000000001:7@lid"])(
  "a LID send with own identity %s produces decryptable ciphertext for the intended peer",
  async (ownLid) => {
    const { socket, stanzas, peers, queryJids } = await setupSdkSend(ownLid);
    const sent = await socket.sendMessage(TARGET_LID, { text: "synthetic" });
    expect(sent?.key.remoteJid).toBe(TARGET_LID);
    expect(queryJids.sort()).toEqual([SELF_LID, TARGET_LID].sort());
    expect(stanzas).toHaveLength(1);
    const stanza = stanzas[0];
    expect(stanza?.attrs.to).toBe(TARGET_LID);
    const participants = getBinaryNodeChildren(
      getBinaryNodeChild(stanza, "participants"),
      "to",
    );
    expect(participants.map(({ attrs }) => attrs.jid).sort()).toEqual(
      [SELF_LID, TARGET_LID].sort(),
    );
    const encrypted = getBinaryNodeChild(
      participants.find(({ attrs }) => attrs.jid === TARGET_LID),
      "enc",
    );
    const peer = peers.get(TARGET_LID);
    if (!peer || !(encrypted?.content instanceof Uint8Array))
      throw new Error("Missing encrypted recipient payload");
    expect(encrypted.attrs.type).toBe("pkmsg");
    const plaintext = await peer.decryptMessage({
      jid: SELF_LID,
      type: "pkmsg",
      ciphertext: encrypted.content,
    });
    expect(
      proto.Message.decode(unpadRandomMax16(plaintext)).extendedTextMessage
        ?.text,
    ).toBe("synthetic");
  },
);
