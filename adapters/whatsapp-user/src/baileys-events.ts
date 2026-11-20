import {
  type Contact,
  proto,
  WAMessageStubType,
} from "@whiskeysockets/baileys";
import type { BaileysLike } from "./baileys";
import { observeBotMessages } from "./bot-events";
import type { WaContact, WaGroup, WaSocketEvent } from "./types";

export function bindDataEvents(
  socket: BaileysLike,
  identity: () => Contact | undefined,
  emit: (event: WaSocketEvent) => void,
): () => void {
  const bot = observeBotMessages(emit, identity);
  socket.ws.on("CB:message", bot.observe);
  socket.ev.on("messaging-history.set", (history) => {
    emit({ type: "chats", chats: history.chats });
    emit({ type: "names", names: contactNames(history.contacts) });
    emit({
      type: "messages",
      messages: bot.decoded(history.messages),
      live: false,
    });
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
  socket.ev.on("messages.upsert", ({ messages, type }) =>
    emit({
      type: "messages",
      messages: bot.decoded(messages),
      live: type === "notify",
    }),
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
      if (edited)
        emit({
          type: "edit",
          key,
          content: edited,
          at: update.messageTimestamp,
        });
      else if (update.messageStubType === WAMessageStubType.REVOKE)
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
