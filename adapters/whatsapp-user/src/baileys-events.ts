import {
  type Contact,
  proto,
  type WAMessage,
  WAMessageStubType,
} from "@whiskeysockets/baileys";
import type { BaileysLike } from "./baileys";
import { observeBotMessages } from "./bot-events";
import { isBotJid, toSeconds, unwrap } from "./mapping";
import { richResponseText } from "./rich-response";
import type {
  WaContact,
  WaContent,
  WaGroup,
  WaMessageLike,
  WaSocketEvent,
} from "./types";

export function bindDataEvents(
  socket: BaileysLike,
  identity: () => Contact | undefined,
  emit: (event: WaSocketEvent) => void,
): () => void {
  const bot = observeBotMessages(emit, identity);
  let reportedMalformed = false;
  function displayRich(
    content: WaContent | null | undefined,
  ): WaContent | null {
    const rich = unwrap(content)?.richResponseMessage;
    if (!rich) return content ?? null;
    const result = richResponseText(rich);
    if (result === "malformed") {
      if (!reportedMalformed) {
        reportedMalformed = true;
        emit({ type: "botDiagnostic", reason: "malformed-rich-response" });
      }
      return null;
    }
    return result && { conversation: result.text };
  }
  function messages(raw: readonly WAMessage[], live: boolean): void {
    let batch: WaMessageLike[] = [];
    for (const message of bot.decoded(raw)) {
      const { key } = message;
      if (!isBotJid(key.remoteJid) || key.fromMe !== false) {
        batch.push(message);
        continue;
      }
      if (key.participant) continue;
      const protocol = message.message?.protocolMessage;
      if (protocol) {
        const { editedMessage, timestampMs } = protocol;
        const id = protocol.key?.id;
        if (
          protocol.type !== proto.Message.ProtocolMessage.Type.MESSAGE_EDIT ||
          !id ||
          !unwrap(editedMessage)?.richResponseMessage
        )
          continue;
        const content = displayRich(editedMessage);
        if (!content) continue;
        // The protocol key contributes only the target ID. Room and sender
        // come from the decoded envelope, as in Baileys' messages.update.
        if (batch.length) {
          emit({ type: "messages", messages: batch, live });
          batch = [];
        }
        const ms = toSeconds(timestampMs);
        emit({
          type: "edit",
          key: { ...key, id },
          content,
          at: ms ? Math.floor(ms / 1000) : message.messageTimestamp,
        });
        continue;
      }
      // Baileys may fold messages.update into a buffered target upsert.
      const content = displayRich(message.message);
      if (content === message.message) {
        batch.push(message);
        continue;
      }
      if (content)
        batch.push({
          ...message,
          message: message.message?.editedMessage?.message
            ? { editedMessage: { message: content } }
            : content,
        });
    }
    emit({ type: "messages", messages: batch, live });
  }
  socket.ws.on("CB:message", bot.observe);
  socket.ev.on("messaging-history.set", (history) => {
    emit({ type: "chats", chats: history.chats });
    emit({ type: "names", names: contactNames(history.contacts) });
    messages(history.messages, false);
    // isLatest marks the first processed history, not the final chunk.
    if (
      history.syncType === proto.HistorySync.HistorySyncType.FULL &&
      history.progress === 100
    )
      emit({ type: "historySyncComplete" });
  });
  socket.ev.on("chats.upsert", (chats) => emit({ type: "chats", chats }));
  socket.ev.on("chats.update", (updates) =>
    emit({
      type: "chats",
      chats: updates.flatMap(({ id, ...rest }) =>
        id ? [{ id, ...rest }] : [],
      ),
    }),
  );
  socket.ev.on("chats.delete", (ids) => emit({ type: "chatsDeleted", ids }));
  socket.ev.on("contacts.upsert", (contacts) =>
    emit({ type: "names", names: contactNames(contacts) }),
  );
  socket.ev.on("contacts.update", (contacts) =>
    emit({ type: "names", names: contactNames(contacts) }),
  );
  socket.ev.on("chats.phoneNumberShare", ({ lid, jid }) =>
    emit({ type: "names", names: [{ id: lid, jid }] }),
  );
  const groups = (updates: Partial<WaGroup>[]) =>
    emit({
      type: "groups",
      groups: updates.flatMap(({ id, ...rest }) =>
        id ? [{ id, ...rest }] : [],
      ),
    });
  socket.ev.on("groups.upsert", groups);
  socket.ev.on("groups.update", groups);
  socket.ev.on("messages.upsert", ({ messages: raw, type }) =>
    messages(raw, type === "notify"),
  );
  socket.ev.on("messages.update", (updates) => {
    for (const { key, update } of updates) {
      if (
        key.fromMe !== false &&
        (update.status != null || update.userReceipt?.length)
      )
        emit({
          type: "receipt",
          key,
          update: {
            ...(update.status != null ? { status: update.status } : {}),
            ...(update.userReceipt ? { userReceipt: update.userReceipt } : {}),
          },
        });
      const edited = update.message?.editedMessage?.message;
      if (edited) {
        const content =
          isBotJid(key.remoteJid) && key.fromMe === false
            ? displayRich(edited)
            : edited;
        if (content)
          emit({
            type: "edit",
            key,
            content,
            at: update.messageTimestamp,
          });
      } else if (update.messageStubType === WAMessageStubType.REVOKE)
        emit({ type: "delete", keys: [key] });
    }
  });
  socket.ev.on("message-receipt.update", (updates) => {
    for (const { key, receipt } of updates)
      if (key.fromMe !== false)
        emit({ type: "receipt", key, update: { userReceipt: [receipt] } });
  });
  socket.ev.on("messages.delete", (deletion) => {
    if ("keys" in deletion) emit({ type: "delete", keys: deletion.keys });
  });
  return () => socket.ws.off("CB:message", bot.observe);
}

function contactNames(contacts: Partial<WaContact>[]): WaContact[] {
  return contacts.flatMap(({ id, ...rest }) => (id ? [{ id, ...rest }] : []));
}
