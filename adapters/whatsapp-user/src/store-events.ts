import type { StreamUpdate } from "@tsuba/serve-kit";
import { isBotJid, toSeconds } from "./mapping";
import { deliveryStatus } from "./receipts";
import type { WaStore } from "./store";
import type { WaDataEvent } from "./types";

/** Login and serve share mutations; history only streams known receipt advances. */
export function applyStoreEvent(
  store: WaStore,
  event: WaDataEvent,
): StreamUpdate[] {
  switch (event.type) {
    case "chats":
      store.setChats(event.chats);
      return [];
    case "names":
      store.setNames(event.names);
      return [];
    case "groups":
      store.setGroups(event.groups);
      return [];
    case "historySyncComplete":
    case "groupSyncFailed":
    case "groupSyncStarted":
    case "groupSyncComplete":
    case "botDiagnostic":
      return [];
    case "chatsDeleted":
      store.deleteChats(event.ids);
      return [];
    case "messages":
      return event.messages.flatMap<StreamUpdate>((raw) => {
        const { remoteJid, id } = raw.key;
        const seen = !!remoteJid && !!id && store.has(remoteJid, id);
        const folded = raw.message?.editedMessage?.message;
        if (seen && isBotJid(remoteJid) && raw.key.fromMe === false && folded) {
          const message = store.edit(
            raw.key,
            folded,
            toSeconds(raw.messageTimestamp),
          );
          return message ? [{ event: "message.edited", message }] : [];
        }
        const previous = remoteJid && id && store.find(remoteJid, id);
        const receipt = previous ? deliveryStatus(previous) : undefined;
        const message = store.put(raw);
        if (!message) return [];
        if (event.live && !seen)
          return [{ event: "message", message } satisfies StreamUpdate];
        return seen && message.deliveryStatus !== receipt
          ? [{ event: "message.edited", message } satisfies StreamUpdate]
          : [];
      });
    case "receipt": {
      const message = store.receipt(event.key, event.update);
      return message ? [{ event: "message.edited", message }] : [];
    }
    case "edit": {
      const message = store.edit(event.key, event.content, toSeconds(event.at));
      return message ? [{ event: "message.edited", message }] : [];
    }
    case "delete": {
      const byRoom = new Map<string, string[]>();
      for (const { roomId, id } of store.remove(event.keys))
        byRoom.set(roomId, [...(byRoom.get(roomId) ?? []), id]);
      return [...byRoom].map(([roomId, messageIds]) => ({
        event: "message.deleted",
        roomId,
        messageIds,
      }));
    }
  }
}
