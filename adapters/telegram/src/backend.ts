import {
  type DeleteMessageUpdate,
  FileLocation,
  InputMedia,
  MtPeerNotFoundError,
  type RawUpdateInfo,
  type TelegramClient,
} from "@mtcute/bun";
import {
  type AdapterBackend,
  AdapterError,
  type Message,
  type StreamUpdate,
} from "@tsuba/serve-kit";
import {
  type MessageLike,
  mapAttachment,
  mapMessage,
  mapReactions,
  mapRoom,
  markedPeerId,
  type RawPeerLike,
  type RawReactionCountLike,
  rawReaction,
  uploadKind,
} from "./mapping";

/** 400-coded refusals that mean "not allowed here" rather than "malformed". */
const FORBIDDEN = [
  "CHANNEL_PRIVATE",
  "USER_BANNED_IN_CHANNEL",
  "CHAT_ADMIN_REQUIRED",
  "CHAT_RESTRICTED",
  "YOU_BLOCKED_USER",
  "USER_IS_BLOCKED",
  "MESSAGE_EDIT_TIME_EXPIRED",
  "REACTION_INVALID",
  "REACTIONS_TOO_MANY",
  "CHAT_SEND_MEDIA_FORBIDDEN",
  "CHAT_SEND_PHOTOS_FORBIDDEN",
  "CHAT_SEND_VIDEOS_FORBIDDEN",
  "CHAT_SEND_DOCS_FORBIDDEN",
  "CHAT_SEND_GIFS_FORBIDDEN",
];
/** 400-coded refusals of the request itself; Telegram changed nothing. */
const INVALID = [
  "MESSAGE_NOT_MODIFIED",
  "MESSAGE_EMPTY",
  "MESSAGE_TOO_LONG",
  "REPLY_MESSAGE_ID_INVALID",
  "REPLY_TO_INVALID",
  "MEDIA_CAPTION_TOO_LONG",
  "MEDIA_EMPTY",
  "PHOTO_INVALID_DIMENSIONS",
  "PHOTO_EXT_INVALID",
  "IMAGE_PROCESS_FAILED",
];
/**
 * Telegram deletions outside channels and supergroups do not say which chat
 * they were in; message ids there are unique per account, so the adapter
 * remembers the room of the ones it has handed out.
 */
const REMEMBERED_ROOMS = 20_000;
const CHANNEL_IDS_BELOW = -1_000_000_000_000;
const MEDIA_ID = /^(-?\d+):(\d+):([A-Za-z0-9_-]+)$/;
// Canonical marked peer id and signed 64-bit Telegram photo id; no attachment overlap.
const AVATAR_ID = /^avatar:(-?[1-9]\d*):(0|-?[1-9]\d*)$/;

function peerId(value: string): number {
  const id = Number(value);
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(id) || id === 0)
    throw new AdapterError("NOT_FOUND", "No such room");
  return id;
}
function messageId(value: string): number {
  const id = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(id) || id < 1)
    throw new AdapterError("INVALID_REQUEST", "Invalid message id");
  return id;
}
async function translated<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const code =
      error && typeof error === "object" && "text" in error
        ? String(error.text)
        : "";
    const status =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "number"
        ? error.code
        : 0;
    if (
      code.startsWith("FLOOD_WAIT") ||
      code.startsWith("FLOOD_PREMIUM_WAIT") ||
      code.startsWith("SLOWMODE_WAIT")
    )
      throw new AdapterError(
        "RATE_LIMITED",
        "Telegram asked the adapter to slow down",
      );
    // Telegram answers 401 once the session is signed out, revoked or expired.
    if (status === 401)
      throw new AdapterError(
        "REAUTH_REQUIRED",
        "Telegram no longer accepts this session; sign in again where the adapter runs",
      );
    if (status === 403 || FORBIDDEN.includes(code))
      throw new AdapterError(
        "FORBIDDEN",
        "Telegram does not let this account do that here",
      );
    if (INVALID.includes(code))
      throw new AdapterError(
        "INVALID_REQUEST",
        "Telegram refused the request as it was",
      );
    if (code === "MESSAGE_ID_INVALID")
      throw new AdapterError("NOT_FOUND", "No such message");
    if (
      error instanceof MtPeerNotFoundError ||
      [
        "PEER_ID_INVALID",
        "CHANNEL_INVALID",
        "CHAT_ID_INVALID",
        "USER_ID_INVALID",
      ].includes(code)
    )
      throw new AdapterError("NOT_FOUND", "No such room");
    throw error;
  }
}

export function telegramBackend(tg: TelegramClient): AdapterBackend {
  const roomOf = new Map<string, string>();
  function remember(roomId: string, messageId: string) {
    if (Number(roomId) <= CHANNEL_IDS_BELOW) return;
    roomOf.delete(messageId);
    roomOf.set(messageId, roomId);
    if (roomOf.size > REMEMBERED_ROOMS)
      roomOf.delete(roomOf.keys().next().value ?? "");
  }
  function mapped(message: MessageLike): Message {
    const result = mapMessage(message);
    remember(result.roomId, result.id);
    return result;
  }
  async function existing(roomId: string, id: string) {
    const [message] = await tg.getMessages(peerId(roomId), [messageId(id)]);
    if (!message) throw new AdapterError("NOT_FOUND", "No such message");
    return message;
  }
  return {
    listRooms: () =>
      translated(async () => {
        const rooms = [];
        for await (const dialog of tg.iterDialogs({
          limit: 501,
          archived: "keep",
        })) {
          if (rooms.length === 500) return { rooms, complete: false };
          rooms.push(mapRoom(dialog));
        }
        return { rooms, complete: true };
      }),
    readMessages: ({ roomId, limit, before }) =>
      translated(async () => {
        const peer = peerId(roomId);
        const page = await tg.getHistory(peer, {
          limit,
          ...(before === undefined
            ? {}
            : { offset: { id: messageId(before), date: 0 } }),
        });
        // Probe before the oldest fetched id rather than relying on total history count,
        // which includes messages newer than a before-id page.
        const oldest = page[page.length - 1];
        const earlier = oldest
          ? await tg.getHistory(peer, {
              limit: 1,
              offset: { id: oldest.id, date: 0 },
            })
          : [];
        return {
          messages: [...page].reverse().map(mapped),
          hasEarlier: earlier.length > 0,
        };
      }),
    messagesAfter: (roomId, afterId) =>
      translated(async () => {
        const peer = peerId(roomId);
        const after = messageId(afterId);
        // Refuse deleted/inaccessible cursors rather than quietly starting from now.
        const anchor = await tg.getMessages(peer, [after]);
        if (!anchor[0])
          throw new AdapterError("NOT_FOUND", "The cursor cannot be honoured");
        const messages: Message[] = [];
        let offset = { id: after + 1, date: 0 };
        while (true) {
          const page = await tg.getHistory(peer, {
            limit: 100,
            minId: after,
            offset,
            reverse: true,
          });
          const newer = page.filter((message) => message.id >= offset.id);
          messages.push(...newer.map(mapped));
          const last = newer[newer.length - 1];
          if (!last || page.length < 100) return messages;
          offset = { id: last.id + 1, date: 0 };
        }
      }),
    subscribe(listener: (update: StreamUpdate) => void) {
      const onNew = (message: MessageLike) =>
        listener({ event: "message", message: mapped(message) });
      const onEdit = (message: MessageLike) =>
        listener({ event: "message.edited", message: mapped(message) });
      const onDelete = (update: DeleteMessageUpdate) => {
        const ids = update.messageIds.map(String);
        if (update.channelId !== null) {
          listener({
            event: "message.deleted",
            roomId: String(update.channelId),
            messageIds: ids,
          });
          return;
        }
        const byRoom = new Map<string, string[]>();
        for (const id of ids) {
          const roomId = roomOf.get(id);
          if (roomId) byRoom.set(roomId, [...(byRoom.get(roomId) ?? []), id]);
        }
        for (const [roomId, messageIds] of byRoom)
          listener({ event: "message.deleted", roomId, messageIds });
      };
      const onRaw = ({ update }: RawUpdateInfo) => {
        if (update._ !== "updateMessageReactions") return;
        listener({
          event: "reactions.updated",
          roomId: String(markedPeerId(update.peer as RawPeerLike)),
          messageId: String(update.msgId),
          reactions: mapReactions(
            (update.reactions.results as RawReactionCountLike[]).map(
              rawReaction,
            ),
          ),
        });
      };
      tg.onNewMessage.add(onNew);
      tg.onEditMessage.add(onEdit);
      tg.onDeleteMessage.add(onDelete);
      tg.onRawUpdate.add(onRaw);
      return () => {
        tg.onNewMessage.remove(onNew);
        tg.onEditMessage.remove(onEdit);
        tg.onDeleteMessage.remove(onDelete);
        tg.onRawUpdate.remove(onRaw);
      };
    },
    send: (roomId, text, { replyTo }) =>
      translated(async () =>
        mapped(
          await tg.sendText(
            peerId(roomId),
            text,
            replyTo === undefined ? {} : { replyTo: messageId(replyTo) },
          ),
        ),
      ),
    upload: (roomId, file, { caption, replyTo }) =>
      translated(async () => {
        const params = { fileName: file.name, fileMime: file.type };
        const kind = uploadKind(file.type, file.bytes.byteLength);
        const media =
          kind === "photo"
            ? InputMedia.photo(file.bytes, params)
            : kind === "video"
              ? InputMedia.video(file.bytes, params)
              : kind === "animation"
                ? InputMedia.animation(file.bytes, params)
                : InputMedia.document(file.bytes, params);
        return mapped(
          await tg.sendMedia(peerId(roomId), media, {
            ...(caption === undefined ? {} : { caption }),
            ...(replyTo === undefined ? {} : { replyTo: messageId(replyTo) }),
          }),
        );
      }),
    edit: (roomId, id, text) =>
      translated(async () =>
        mapped(
          await tg.editMessage({
            chatId: peerId(roomId),
            message: messageId(id),
            text,
            // So that every open stream, not only this answer, sees the edit.
            shouldDispatch: true,
          }),
        ),
      ),
    deleteMessage: (roomId, id) =>
      translated(async () => {
        // Telegram deletes a missing id without complaint; the contract says 404.
        await existing(roomId, id);
        remember(roomId, id);
        await tg.deleteMessagesById(peerId(roomId), [messageId(id)], {
          revoke: true,
          shouldDispatch: true,
        });
      }),
    react: (roomId, id, emojis) =>
      translated(async () => {
        const message = await tg.sendReaction({
          chatId: peerId(roomId),
          message: messageId(id),
          emoji: emojis.length ? emojis : null,
          shouldDispatch: true,
        });
        return mapped(message ?? (await existing(roomId, id))).reactions ?? [];
      }),
    markRead: (roomId, id) =>
      translated(() =>
        tg.readHistory(peerId(roomId), { maxId: messageId(id) }),
      ),
    media: (id, signal) =>
      translated(async () => {
        if (id.startsWith("avatar:")) {
          const missing = new AdapterError("NOT_FOUND", "No such avatar");
          const match = AVATAR_ID.exec(id);
          if (!match || match[0] !== id) throw missing;
          const [, peerText = "", photoText = ""] = match;
          const photoId = BigInt(photoText);
          if (photoId < -(1n << 63n) || photoId >= 1n << 63n) throw missing;
          // Re-resolve for a fresh location; an old id must never serve a new picture.
          const peer = await tg.getPeer(peerId(peerText));
          const photo = peer.photo;
          if (!photo || photo.raw.photoId.toString() !== photoText)
            throw missing;
          return {
            body: tg.downloadAsStream(photo.small, { abortSignal: signal }),
            mimeType: "image/jpeg",
          };
        }
        const missing = new AdapterError("NOT_FOUND", "No such attachment");
        const [, roomId = "", messageIdText = "", unique] =
          MEDIA_ID.exec(id) ?? [];
        if (!unique) throw missing;
        // Fetch the message now so the file reference is fresh and still this message's file.
        const [message] = await tg.getMessages(peerId(roomId), [
          messageId(messageIdText),
        ]);
        const media = message?.media;
        const attachment = media && mapAttachment(roomId, messageIdText, media);
        if (
          !(media instanceof FileLocation) ||
          !attachment ||
          attachment.id !== id
        )
          throw missing;
        return {
          body: tg.downloadAsStream(media, { abortSignal: signal }),
          ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
          ...(attachment.name ? { name: attachment.name } : {}),
        };
      }),
  };
}
