import { proto } from "@whiskeysockets/baileys";
import { isBotJid, unwrap } from "./mapping";
import type { StoreSnapshot } from "./snapshot";
import type { WaKey, WaMessageLike } from "./types";

const RETAINED_PROMPTS = 500;

/** The original outbound protobuf is never used as a public history entry. */
export class BotPrompts {
  private readonly prompts = new Map<
    string,
    {
      readonly roomId: string;
      readonly id: string;
      readonly message: proto.Message;
    }
  >();

  constructor(rows: StoreSnapshot["botPrompts"] = []) {
    for (const { roomId, id, data } of rows) {
      this.put({
        key: { remoteJid: roomId, id, fromMe: true },
        message: proto.Message.decode(Buffer.from(data, "base64")),
      });
    }
  }

  put(raw: WaMessageLike): void {
    const { remoteJid, id, fromMe } = raw.key;
    const message = raw.message;
    if (
      !isBotJid(remoteJid) ||
      !id ||
      fromMe !== true ||
      raw.key.isViewOnce ||
      message?.messageContextInfo?.messageSecret?.length !== 32 ||
      !unwrap(message)
    )
      return;
    const key = JSON.stringify([remoteJid, id]);
    if (this.prompts.has(key)) return;
    this.prompts.set(key, {
      roomId: remoteJid,
      id,
      message: proto.Message.fromObject(message),
    });
    if (this.prompts.size > RETAINED_PROMPTS) {
      const oldest = this.prompts.keys().next().value;
      if (oldest !== undefined) this.prompts.delete(oldest);
    }
  }

  find(roomId: string, id: string): proto.Message | undefined {
    return this.prompts.get(JSON.stringify([roomId, id]))?.message;
  }

  deleteChat(roomId: string): void {
    for (const [key, prompt] of this.prompts)
      if (prompt.roomId === roomId) this.prompts.delete(key);
  }

  delete({ remoteJid, id, fromMe }: WaKey): void {
    if (remoteJid && id && fromMe !== false)
      this.prompts.delete(JSON.stringify([remoteJid, id]));
  }

  snapshot(): NonNullable<StoreSnapshot["botPrompts"]> {
    return [...this.prompts.values()].map(({ roomId, id, message }) => ({
      roomId,
      id,
      data: Buffer.from(proto.Message.encode(message).finish()).toString(
        "base64",
      ),
    }));
  }
}
