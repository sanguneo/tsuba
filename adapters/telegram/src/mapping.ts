import type { Message, Room } from "../../../packages/serve-kit/src/index";

// Structural inputs deliberately keep mtcute out of this pure module.
export interface PeerLike {
  id: number;
  type: "user" | "chat";
  displayName: string;
  chatType?: string;
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
  media?: unknown;
  raw?: { media?: unknown; action?: unknown };
  editDate?: Date | null;
  replyToMessage?: { id: number | null } | null;
}
export interface DialogLike {
  peer: PeerLike;
  unreadCount: number;
  lastMessage?: MessageLike | null;
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
  };
}

export function mapMessage(message: MessageLike): Message {
  const replyTo = message.replyToMessage?.id;
  return {
    id: String(message.id),
    roomId: String(message.chat.id),
    senderId: String(message.sender.id),
    sender: message.sender.displayName,
    text: message.text,
    kind:
      message.isService || message.action || message.raw?.action
        ? "service"
        : message.media || message.raw?.media
          ? "media"
          : "text",
    sentAt: message.date.toISOString(),
    fromMe: message.isOutgoing,
    ...(message.editDate ? { editedAt: message.editDate.toISOString() } : {}),
    ...(replyTo == null ? {} : { replyTo: String(replyTo) }),
  };
}
