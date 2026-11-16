import type { Message, Room } from "@tsuba/serve-kit";
import type {
  WaChat,
  WaContent,
  WaMessageLike,
  WaTime,
  WaWrapper,
} from "./types";

// Individual chats, groups and the newer LID addresses are rooms. Status,
// broadcast lists and channels (newsletters) are not.
const ROOM_JID = /^[0-9A-Za-z._-]+(?::[0-9]+)?@(?:s\.whatsapp\.net|lid|g\.us)$/;
const PREVIEW_CODEPOINTS = 200;
const WRAPPERS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "documentWithCaptionMessage",
  "editedMessage",
] as const;
const MEDIA = [
  "imageMessage",
  "videoMessage",
  "documentMessage",
  "audioMessage",
  "stickerMessage",
] as const;

export function isRoomJid(jid: string): boolean {
  return ROOM_JID.test(jid);
}

export function jidUser(jid: string): string {
  return jid.split("@")[0]?.split(":")[0] ?? jid;
}

export function toSeconds(time: WaTime): number | null {
  const value = typeof time === "object" && time ? time.toNumber() : time;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export function unwrap(
  content: WaContent | null | undefined,
): WaContent | null {
  let current = content ?? null;
  for (let depth = 0; current && depth < 4; depth++) {
    const wrapper: WaWrapper | null | undefined = WRAPPERS.map(
      (name) => current?.[name],
    ).find((value) => value?.message);
    if (!wrapper?.message) return current;
    current = wrapper.message;
  }
  return current;
}

interface Shown {
  text: string;
  kind: "text" | "media";
  replyTo?: string;
}

/** Text and media are shown; reactions, protocol and unknown content are not. */
export function shown(content: WaContent | null | undefined): Shown | null {
  const inner = unwrap(content);
  if (!inner) return null;
  if (typeof inner.conversation === "string")
    return { text: inner.conversation, kind: "text" };
  const extended = inner.extendedTextMessage;
  if (extended && typeof extended.text === "string")
    return {
      text: extended.text,
      kind: "text",
      ...(extended.contextInfo?.stanzaId
        ? { replyTo: extended.contextInfo.stanzaId }
        : {}),
    };
  for (const name of MEDIA) {
    const media = inner[name];
    if (media)
      return {
        text: media.caption ?? "",
        kind: "media",
        ...(media.contextInfo?.stanzaId
          ? { replyTo: media.contextInfo.stanzaId }
          : {}),
      };
  }
  return null;
}

export function mapMessage(
  raw: WaMessageLike,
  editedAt?: number | null,
): Message | null {
  const id = raw.key.id;
  const roomId = raw.key.remoteJid;
  const seconds = toSeconds(raw.messageTimestamp);
  const content = shown(raw.message);
  if (!id || !roomId || !isRoomJid(roomId) || seconds === null || !content)
    return null;
  const fromMe = raw.key.fromMe === true;
  const author = raw.key.participant ?? roomId;
  return {
    id,
    roomId,
    ...(fromMe ? {} : { senderId: author }),
    sender: fromMe ? "Me" : (raw.pushName ?? jidUser(author)),
    text: content.text,
    kind: content.kind,
    sentAt: iso(seconds),
    ...(editedAt ? { editedAt: iso(editedAt) } : {}),
    fromMe,
    ...(content.replyTo ? { replyTo: content.replyTo } : {}),
  };
}

export function mapRoom(
  id: string,
  chat: Pick<WaChat, "name" | "conversationTimestamp" | "unreadCount">,
  newest?: Message,
): Room {
  const seconds = toSeconds(chat.conversationTimestamp);
  const lastActivityAt = newest?.sentAt ?? (seconds ? iso(seconds) : undefined);
  return {
    id,
    title: chat.name ?? jidUser(id),
    kind: id.endsWith("@g.us") ? "group" : "direct",
    unread: Math.max(0, chat.unreadCount ?? 0),
    ...(lastActivityAt ? { lastActivityAt } : {}),
    ...(newest?.text
      ? {
          lastMessage: {
            text: [...newest.text].slice(0, PREVIEW_CODEPOINTS).join(""),
            fromMe: newest.fromMe,
          },
        }
      : {}),
  };
}
