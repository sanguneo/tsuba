import {
  type AdapterBackend,
  AdapterError,
  type StreamUpdate,
} from "@tsuba/serve-kit";
import { isRoomJid } from "./mapping";
import { type AvatarOptions, RoomAvatars } from "./room-avatars";
import type { WaLink } from "./session";
import { WaStore } from "./store";
import { applyStoreEvent } from "./store-events";

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
    case 404:
      return new AdapterError(
        "NOT_FOUND",
        "WhatsApp could not find the recipient or its encryption keys",
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
    ...avatarOptions
  }: { store?: WaStore; changed?: () => void } & AvatarOptions = {},
): AdapterBackend {
  const avatars = new RoomAvatars(
    (jid) => link.profilePictureUrl(jid),
    avatarOptions,
  );
  const pictureJids = (jid: string) => store.pictureJids(jid);
  const listeners = new Set<(update: StreamUpdate) => void>();
  let stream = Promise.resolve();
  link.subscribe((event) => {
    if (
      event.type !== "state" &&
      event.type !== "historySyncComplete" &&
      event.type !== "groupSyncStarted" &&
      event.type !== "groupSyncComplete" &&
      event.type !== "groupSyncFailed"
    ) {
      const updates = applyStoreEvent(store, event);
      if (updates.length && listeners.size) {
        const recipients = [...listeners];
        // Resolve pictures in parallel with earlier updates without reordering edits or deletes.
        const ready = Promise.all(
          updates.map(async (update) => {
            if (
              (update.event === "message" ||
                update.event === "message.edited") &&
              link.state() === "open"
            ) {
              const [message] = await avatars.messages(
                [update.message],
                pictureJids,
              );
              if (message) return { ...update, message };
            }
            return update;
          }),
        );
        stream = Promise.all([stream, ready]).then(([, ordered]) => {
          for (const update of ordered)
            for (const listener of recipients)
              if (listeners.has(listener)) listener(update);
        });
      }
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
      const rooms = store.rooms();
      return {
        rooms:
          link.state() === "open"
            ? await avatars.rooms(rooms, pictureJids)
            : rooms,
        complete: false,
      };
    },
    async media(id, signal) {
      requireLogin();
      return avatars.media(id, signal);
    },
    async readMessages({ roomId, limit, before }) {
      requireLogin();
      roomJid(roomId);
      if (before !== undefined && !store.has(roomId, before))
        throw new AdapterError(
          "NOT_FOUND",
          "That message is not in this adapter's memory",
        );
      const page = store.page(roomId, Math.min(limit, 100), before);
      return link.state() === "open"
        ? {
            ...page,
            messages: await avatars.messages(page.messages, pictureJids),
          }
        : page;
    },
    subscribe(listener) {
      const deliver = (update: StreamUpdate) => listener(update);
      listeners.add(deliver);
      return () => {
        listeners.delete(deliver);
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
