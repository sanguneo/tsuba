import {
  type AdapterBackend,
  AdapterError,
  type Message,
  type StreamUpdate,
} from "@tsuba/serve-kit";
import {
  isBotJid,
  isRoomJid,
  MESSAGE_MEDIA_PREFIX,
  mediaLocation,
  messageAttachment,
} from "./mapping";
import { type AvatarOptions, RoomAvatars } from "./room-avatars";
import { sendError } from "./send-error";
import type { WaLink } from "./session";
import { WaStore } from "./store";
import { applyStoreEvent } from "./store-events";
import type { WaMessageLike } from "./types";

function roomJid(value: string): string {
  if (!isRoomJid(value))
    throw new AdapterError("NOT_FOUND", "No such WhatsApp chat");
  return value;
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
      event.type !== "groupSyncFailed" &&
      event.type !== "botDiagnostic"
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
        throw new AdapterError("FORBIDDEN", "WhatsApp refused this account");
      case "conflict":
        throw new AdapterError(
          "BUSY",
          "Another WhatsApp Web session took over; restart the adapter to resume",
        );
      case "open":
        return;
      default:
        throw new AdapterError("BUSY", "WhatsApp is not connected yet");
    }
  }

  async function send(
    roomId: string,
    replyTo: string | undefined,
    submit: (quoted?: WaMessageLike) => Promise<WaMessageLike | undefined>,
  ): Promise<Message> {
    requireOpen();
    const quoted =
      replyTo === undefined ? undefined : store.find(roomId, replyTo);
    if (replyTo !== undefined && !quoted)
      throw new AdapterError(
        "NOT_FOUND",
        "Only messages retained by this adapter can be replied to",
      );
    let sent: WaMessageLike | undefined;
    try {
      sent = await submit(quoted);
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
  }

  return {
    async listRooms() {
      requireLogin();
      const rooms = await Promise.all(
        store.rooms().map(async (room) => {
          if (!isBotJid(room.id) || !(await link.canSendDirectBotText(room.id)))
            return room;
          return {
            ...room,
            features: {
              "messages.reply": false,
              "attachments.send": false,
            } as const,
          };
        }),
      );
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
      if (!id.startsWith(MESSAGE_MEDIA_PREFIX))
        return avatars.media(id, signal);
      const location = mediaLocation(id);
      const raw = location && store.find(location.roomId, location.messageId);
      const attachment = raw && messageAttachment(raw);
      if (!raw || attachment?.id !== id)
        throw new AdapterError("NOT_FOUND", "No such WhatsApp attachment");
      requireOpen();
      return {
        body: await link.downloadMedia(raw, signal),
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        ...(attachment.name ? { name: attachment.name } : {}),
      };
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
    send(roomId, text, { replyTo }) {
      roomJid(roomId);
      if (isBotJid(roomId)) {
        if (replyTo !== undefined)
          throw new AdapterError(
            "NOT_SUPPORTED",
            "WhatsApp bot chats do not support replies",
          );
        return send(roomId, undefined, () =>
          link.sendDirectBotText(roomId, text),
        );
      }
      return send(roomId, replyTo, (quoted) => link.send(roomId, text, quoted));
    },
    upload(roomId, file, { caption, replyTo }) {
      roomJid(roomId);
      if (isBotJid(roomId))
        throw new AdapterError(
          "NOT_SUPPORTED",
          "WhatsApp bot chats do not support uploads",
        );
      return send(roomId, replyTo, (quoted) =>
        link.sendMedia(roomId, file, caption, quoted),
      );
    },
  };
}
