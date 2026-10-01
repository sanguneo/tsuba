import type {
  Attachment,
  Message,
  Reaction,
  Room,
} from "../../../packages/serve-kit/src/index";

// Structural inputs deliberately keep mtcute out of this pure module.
export interface PeerLike {
  id: number;
  type: "user" | "chat";
  displayName: string;
  chatType?: string;
  isDeleted?: boolean;
  isCreator?: boolean;
  isAdmin?: boolean;
  isBanned?: boolean;
  isMember?: boolean;
  adminRights?: { postMessages?: boolean } | null;
  permissions?: { canSendText: boolean } | null;
  defaultPermissions?: { canSendText: boolean } | null;
}
export interface MediaLike {
  type: string;
  uniqueFileId?: string;
  mimeType?: string;
  fileName?: string | null;
  fileSize?: number | undefined;
  width?: number;
  height?: number;
  duration?: number;
  isAnimation?: boolean;
  ttlSeconds?: number | null;
}
export interface ReactionLike {
  /** A Unicode emoji, or a custom emoji's document id. */
  emoji: unknown;
  isPaid?: boolean;
  count: number;
  /** Set when this account chose it. */
  order: number | null;
}
export interface MessageLike {
  id: number;
  chat: PeerLike;
  sender: PeerLike;
  text: string;
  date: Date;
  isOutgoing: boolean;
  isService?: boolean;
  action?: unknown;
  media?: MediaLike | null;
  raw?: { media?: unknown; action?: unknown };
  editDate?: Date | null;
  replyToMessage?: { id: number | null } | null;
  reactions?: { reactions: readonly ReactionLike[] } | null;
}
export interface DialogLike {
  peer: PeerLike;
  unreadCount: number;
  lastMessage?: MessageLike | null;
}

/** Telegram's own notifications account, which nobody can write to. */
const SERVICE_NOTIFICATIONS = 777000;

/**
 * Whether Telegram lets this account post text in the room, from what the
 * dialog already carries. Broadcast channels take admins with the post right,
 * broadcast groups take admins, and other groups follow the account's own and
 * the room's default restrictions.
 */
export function canSendText(peer: PeerLike): boolean {
  if (peer.type === "user")
    return !peer.isDeleted && peer.id !== SERVICE_NOTIFICATIONS;
  if (peer.isBanned || peer.isMember === false) return false;
  if (peer.isCreator) return true;
  if (peer.chatType === "channel")
    return peer.adminRights?.postMessages === true;
  if (peer.isAdmin) return true;
  if (peer.chatType === "gigagroup") return false;
  return (
    peer.permissions?.canSendText !== false &&
    peer.defaultPermissions?.canSendText !== false
  );
}

export function mapRoom(dialog: DialogLike): Room {
  const last = dialog.lastMessage;
  return {
    id: String(dialog.peer.id),
    title: dialog.peer.displayName,
    kind:
      dialog.peer.type === "user"
        ? "direct"
        : dialog.peer.chatType === "channel"
          ? "channel"
          : "group",
    unread: dialog.unreadCount,
    ...(last
      ? {
          lastActivityAt: last.date.toISOString(),
          lastMessage: {
            text: [...last.text].slice(0, 200).join(""),
            fromMe: last.isOutgoing,
          },
        }
      : {}),
    ...(canSendText(dialog.peer)
      ? {}
      : { features: { "messages.send": false } }),
  };
}

const ATTACHMENT_KINDS: Readonly<Record<string, Attachment["kind"]>> = {
  photo: "image",
  document: "file",
  video: "video",
  audio: "audio",
  voice: "voice",
  sticker: "sticker",
};

/**
 * The file a message carries, or null when it carries none the adapter can
 * hand over. Self-destructing media is left out: it is meant to be seen once,
 * in Telegram, and a cached download would outlive it.
 */
export function mapAttachment(
  roomId: string,
  messageId: string,
  media: MediaLike,
): Attachment | null {
  const kind = ATTACHMENT_KINDS[media.type];
  if (!kind || !media.uniqueFileId || media.ttlSeconds) return null;
  const mimeType = media.type === "photo" ? "image/jpeg" : media.mimeType;
  const positive = (value: number | undefined) =>
    value !== undefined && Number.isSafeInteger(value) && value > 0;
  return {
    id: `${roomId}:${messageId}:${media.uniqueFileId}`,
    kind: kind === "video" && media.isAnimation ? "animation" : kind,
    ...(media.fileName ? { name: media.fileName } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(media.fileSize !== undefined &&
    Number.isSafeInteger(media.fileSize) &&
    media.fileSize >= 0
      ? { size: media.fileSize }
      : {}),
    ...(positive(media.width) && positive(media.height)
      ? { width: media.width, height: media.height }
      : {}),
    ...(media.duration !== undefined && media.duration >= 0
      ? { durationSeconds: media.duration }
      : {}),
  };
}

/** Only reactions with a Unicode emoji: custom and paid ones have no emoji to show or send back. */
export function mapReactions(list: readonly ReactionLike[]): Reaction[] {
  return list.flatMap((reaction) =>
    typeof reaction.emoji === "string" &&
    reaction.emoji &&
    !reaction.isPaid &&
    Number.isSafeInteger(reaction.count) &&
    reaction.count > 0
      ? [
          {
            emoji: reaction.emoji,
            count: reaction.count,
            mine: reaction.order !== null,
          },
        ]
      : [],
  );
}

export type RawPeerLike =
  | { _: "peerUser"; userId: number }
  | { _: "peerChat"; chatId: number }
  | { _: "peerChannel"; channelId: number };

/** The marked id Telegram clients use for a peer, the same string a room's id is. */
export function markedPeerId(peer: RawPeerLike): number {
  if (peer._ === "peerUser") return peer.userId;
  if (peer._ === "peerChat") return -peer.chatId;
  return -1_000_000_000_000 - peer.channelId;
}

export interface RawReactionCountLike {
  reaction: { _: string; emoticon?: string };
  count: number;
  chosenOrder?: number;
}

/** A raw `updateMessageReactions` count in the shape `mapReactions` takes. */
export function rawReaction(raw: RawReactionCountLike): ReactionLike {
  return {
    emoji: raw.reaction._ === "reactionEmoji" ? raw.reaction.emoticon : null,
    isPaid: raw.reaction._ === "reactionPaid",
    count: raw.count,
    order: raw.chosenOrder ?? null,
  };
}

export function mapMessage(message: MessageLike): Message {
  const id = String(message.id);
  const roomId = String(message.chat.id);
  const replyTo = message.replyToMessage?.id;
  const media = message.media ?? null;
  const attachment = media ? mapAttachment(roomId, id, media) : null;
  const reactions = mapReactions(message.reactions?.reactions ?? []);
  return {
    id,
    roomId,
    senderId: String(message.sender.id),
    sender: message.sender.displayName,
    text: message.text,
    kind:
      message.isService || message.action || message.raw?.action
        ? "service"
        : // A link preview rides on a text message; it is not media.
          (media ? media.type !== "webpage" : Boolean(message.raw?.media))
          ? "media"
          : "text",
    sentAt: message.date.toISOString(),
    fromMe: message.isOutgoing,
    ...(message.editDate ? { editedAt: message.editDate.toISOString() } : {}),
    ...(replyTo == null ? {} : { replyTo: String(replyTo) }),
    ...(attachment ? { attachments: [attachment] } : {}),
    ...(reactions.length ? { reactions } : {}),
  };
}
