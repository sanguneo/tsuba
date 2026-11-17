import {
  type AdapterBackend,
  AdapterError,
  type StreamUpdate,
} from "@tsuba/serve-kit";
import { isRoomJid, toSeconds } from "./mapping";
import type { WaLink } from "./session";
import { WaStore } from "./store";
import type { WaDataEvent } from "./types";

function roomJid(value: string): string {
  if (!isRoomJid(value))
    throw new AdapterError("NOT_FOUND", "No such WhatsApp chat");
  return value;
}

function statusCode(error: unknown): number | undefined {
  const output =
    error && typeof error === "object" && "output" in error
      ? error.output
      : undefined;
  const code =
    output && typeof output === "object" && "statusCode" in output
      ? output.statusCode
      : undefined;
  return typeof code === "number" ? code : undefined;
}

function sendError(error: unknown): AdapterError {
  if (error instanceof AdapterError) return error;
  switch (statusCode(error)) {
    case 401:
      return new AdapterError(
        "REAUTH_REQUIRED",
        "WhatsApp no longer accepts this linked device; run login again",
      );
    case 403:
      return new AdapterError(
        "FORBIDDEN",
        "WhatsApp does not let this account do that",
      );
    case 429:
      return new AdapterError(
        "RATE_LIMITED",
        "WhatsApp asked the adapter to slow down; try again later",
      );
    default:
      return new AdapterError(
        "INTERNAL",
        "The WhatsApp adapter failed; a write's outcome is unknown",
      );
  }
}

/**
 * Rooms and messages are what the connection has pushed, including its saved
 * cache (`WaStore`). `complete` is therefore always false:
 * WhatsApp never says it has sent everything. Reads are refused only once the
 * device is logged out; a send also needs an open connection and never retries.
 */
export function whatsappUserBackend(
  link: WaLink,
  {
    store = new WaStore(),
    changed = () => {},
  }: { store?: WaStore; changed?: () => void } = {},
): AdapterBackend {
  const listeners = new Set<(update: StreamUpdate) => void>();
  const emit = (update: StreamUpdate) => {
    for (const listener of listeners) listener(update);
  };

  function apply(event: WaDataEvent) {
    switch (event.type) {
      case "chats":
        store.setChats(event.chats);
        return;
      case "names":
        store.setNames(event.names);
        return;
      case "groups":
        store.setGroups(event.groups);
        return;
      case "groupSyncFailed":
      case "groupSyncStarted":
      case "groupSyncComplete":
        return;
      case "chatsDeleted":
        store.deleteChats(event.ids);
        return;
      case "messages":
        for (const raw of event.messages) {
          const { remoteJid, id } = raw.key;
          const seen = !!remoteJid && !!id && store.has(remoteJid, id);
          const message = store.put(raw);
          if (event.live && message && !seen)
            emit({ event: "message", message });
        }
        return;
      case "edit": {
        const message = store.edit(
          event.key,
          event.content,
          toSeconds(event.at),
        );
        if (message) emit({ event: "message.edited", message });
        return;
      }
      case "delete": {
        const byRoom = new Map<string, string[]>();
        for (const { roomId, id } of store.remove(event.keys))
          byRoom.set(roomId, [...(byRoom.get(roomId) ?? []), id]);
        for (const [roomId, messageIds] of byRoom)
          emit({ event: "message.deleted", roomId, messageIds });
      }
    }
  }
  link.subscribe((event) => {
    if (
      event.type !== "state" &&
      event.type !== "groupSyncStarted" &&
      event.type !== "groupSyncComplete" &&
      event.type !== "groupSyncFailed"
    ) {
      apply(event);
      changed();
    }
  });

  function requireLogin() {
    if (link.state() === "logged-out")
      throw new AdapterError(
        "REAUTH_REQUIRED",
        "WhatsApp is not linked or was logged out; run login where the adapter runs",
      );
  }
  function requireOpen() {
    requireLogin();
    switch (link.state()) {
      case "forbidden":
        throw new AdapterError(
          "FORBIDDEN",
          "WhatsApp refused this account; nothing was sent",
        );
      case "conflict":
        throw new AdapterError(
          "BUSY",
          "Another WhatsApp Web session took over; restart the adapter to resume",
        );
      case "open":
        return;
      default:
        throw new AdapterError(
          "BUSY",
          "WhatsApp is not connected yet; nothing was sent",
        );
    }
  }

  return {
    async listRooms() {
      requireLogin();
      return { rooms: store.rooms(), complete: false };
    },
    async readMessages({ roomId, limit, before }) {
      requireLogin();
      roomJid(roomId);
      if (before !== undefined && !store.has(roomId, before))
        throw new AdapterError(
          "NOT_FOUND",
          "That message is not in this adapter's memory",
        );
      return store.page(roomId, Math.min(limit, 100), before);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async send(roomId, text, { replyTo }) {
      roomJid(roomId);
      requireOpen();
      const quoted =
        replyTo === undefined ? undefined : store.find(roomId, replyTo);
      if (replyTo !== undefined && !quoted)
        throw new AdapterError(
          "NOT_FOUND",
          "Only messages retained by this adapter can be replied to",
        );
      let sent: Awaited<ReturnType<WaLink["send"]>>;
      try {
        sent = await link.send(roomId, text, quoted);
      } catch (error) {
        throw sendError(error);
      }
      const message = sent && store.put(sent);
      if (!message)
        throw new AdapterError(
          "INTERNAL",
          "WhatsApp did not describe the sent message; its outcome is unknown",
        );
      changed();
      return message;
    },
  };
}
