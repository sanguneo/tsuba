import type { StreamUpdate } from "@tsuba/serve-kit";
import { toSeconds } from "./mapping";
import type { WaStore } from "./store";
import type { WaDataEvent } from "./types";

/** Login and serve must apply the same cache mutations; history is never live. */
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
      return [];
    case "chatsDeleted":
      store.deleteChats(event.ids);
      return [];
    case "messages":
      return event.messages.flatMap((raw) => {
        const { remoteJid, id } = raw.key;
        const seen = !!remoteJid && !!id && store.has(remoteJid, id);
        const message = store.put(raw);
        return event.live && message && !seen
          ? [{ event: "message", message } satisfies StreamUpdate]
          : [];
      });
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
