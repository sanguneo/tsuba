import {
  type BinaryNode,
  getBinaryNodeChild,
  jidNormalizedUser,
  proto,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { isBotJid, toSeconds } from "./mapping";
import type { WaSocketEvent } from "./types";

const RECENT_COPIES = 500;

/**
 * Fallback for unpatched Baileys 6.7.24, which drops msmsg before upsert
 * and drops the bot recipient on own-device copies. Content comes from SDK events.
 */
export function observeBotMessages(
  emit: (event: WaSocketEvent) => void,
  identity: () => { readonly id: string; readonly lid?: string } | undefined,
) {
  const copies = new Map<string, string>();
  let sawMsmsg = false;
  let sawWasa = false;
  function ownAddress(jid: string | null | undefined): string | undefined {
    if (!jid || !/^\d+(?::\d+)?@(?:s\.whatsapp\.net|lid)$/.test(jid))
      return undefined;
    const address = jidNormalizedUser(jid);
    const me = identity();
    return address === jidNormalizedUser(me?.id) ||
      address === jidNormalizedUser(me?.lid)
      ? address
      : undefined;
  }
  return {
    observe(node: BinaryNode): void {
      if (node.tag !== "message") return;
      const { from, recipient, participant, id, t } = node.attrs;
      if (
        !id ||
        participant !== undefined ||
        node.attrs.target_chat_jid !== undefined ||
        (Array.isArray(node.content) &&
          node.content.some(
            (child) => child.attrs.target_chat_jid !== undefined,
          ))
      )
        return;
      const self = ownAddress(from);
      const outgoing = self && isBotJid(recipient);
      const room =
        recipient === undefined && isBotJid(from)
          ? from
          : outgoing
            ? recipient
            : undefined;
      if (!room) return;
      const at = toSeconds(Number(t));
      if (outgoing && self && at) {
        const key = JSON.stringify([self, id, at]);
        const known = copies.get(key);
        // An ambiguous id must never move content to either recipient.
        copies.set(key, known === undefined || known === room ? room : "");
        if (copies.size > RECENT_COPIES) {
          const oldest = copies.keys().next().value;
          if (oldest !== undefined) copies.delete(oldest);
        }
      }
      emit({
        type: "chats",
        chats: [{ id: room, conversationTimestamp: at }],
      });
      if (
        getBinaryNodeChild(node, "enc")?.attrs.type === "msmsg" &&
        !sawMsmsg
      ) {
        sawMsmsg = true;
        emit({ type: "botDiagnostic", reason: "msmsg-seen" });
      }
    },
    decoded(messages: readonly WAMessage[]): WAMessage[] {
      return messages.flatMap((raw) => {
        const { id, remoteJid, fromMe, participant, isViewOnce } = raw.key;
        const wrapper = raw.message?.deviceSentMessage;
        const self = fromMe === true && !participant && ownAddress(remoteJid);
        const at = toSeconds(raw.messageTimestamp);
        const correlated =
          self && id && at
            ? copies.get(JSON.stringify([self, id, at]))
            : undefined;
        const destination = wrapper?.destinationJid;
        if (correlated === "") return [];
        const room = isBotJid(remoteJid)
          ? remoteJid
          : correlated ||
            (self && isBotJid(destination) ? destination : undefined);
        if (!room) return [raw];
        // Device wrappers can also appear in history, which bypasses the
        // receive decoder. Never unwrap a conflicting destination.
        if (
          isViewOnce ||
          (wrapper && (fromMe !== true || destination !== room)) ||
          raw.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT
        )
          return [];
        const inner = wrapper ? wrapper.message : raw.message;
        const outerContext = wrapper
          ? raw.message?.messageContextInfo
          : undefined;
        const message =
          inner &&
          outerContext?.messageSecret?.length &&
          !inner.messageContextInfo?.messageSecret?.length
            ? {
                ...inner,
                messageContextInfo: {
                  ...outerContext,
                  ...inner.messageContextInfo,
                  messageSecret: outerContext.messageSecret,
                },
              }
            : inner;
        // The WASA prompt form carries an opaque SecretEncryptedMessage with
        // no edit type and a self-owned root reference in the same bot room.
        const envelope = message?.secretEncryptedMessage;
        if (envelope) {
          if (
            !sawWasa &&
            fromMe === true &&
            !envelope.secretEncType &&
            envelope.targetMessageKey?.remoteJid === room &&
            envelope.targetMessageKey.fromMe === true &&
            envelope.targetMessageKey.id &&
            envelope.encIv?.length === 12 &&
            (envelope.encPayload?.length ?? 0) > 16
          ) {
            sawWasa = true;
            emit({ type: "botDiagnostic", reason: "wasa-envelope" });
          }
          emit({
            type: "chats",
            chats: [{ id: room, conversationTimestamp: at }],
          });
          return [];
        }
        return [
          {
            ...raw,
            key: { ...raw.key, remoteJid: room },
            ...(message !== undefined && { message }),
          },
        ];
      });
    },
  };
}
