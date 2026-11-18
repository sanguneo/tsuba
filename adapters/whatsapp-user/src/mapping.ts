import type { Attachment, Message, Room } from "@tsuba/serve-kit";
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
  "documentWithCaptionMessage",
  "editedMessage",
] as const;
const MEDIA = {
  imageMessage: "image",
  videoMessage: "video",
  documentMessage: "file",
  audioMessage: "audio",
  stickerMessage: "sticker",
} as const;
const MEDIA_TYPES = [
  "imageMessage",
  "videoMessage",
  "documentMessage",
  "audioMessage",
  "stickerMessage",
] as const;
export const MESSAGE_MEDIA_PREFIX = "message:";

export function mediaLocation(
  id: string,
): { roomId: string; messageId: string } | null {
  const encoded = id.slice(MESSAGE_MEDIA_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const [roomId, messageId, ...extra] = Buffer.from(encoded, "base64url")
    .toString("utf8")
    .split("\0");
  return roomId && isRoomJid(roomId) && messageId && !extra.length
    ? { roomId, messageId }
    : null;
}

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
    // The adapter cannot honor WhatsApp's one-time display semantics.
    if (
      current.viewOnceMessage ||
      current.viewOnceMessageV2 ||
      current.viewOnceMessageV2Extension
    )
      return null;
    const wrapper: WaWrapper | null | undefined = WRAPPERS.map(
      (name) => current?.[name],
    ).find((value) => value?.message);
    if (!wrapper?.message) return current;
    current = wrapper.message;
  }
  return null;
}

interface Shown {
  text: string;
  kind: "text" | "media";
  replyTo?: string;
  attachment?: Omit<Attachment, "id">;
}

export function messageAttachment(
  raw: WaMessageLike,
  attachment = shown(raw.message)?.attachment,
): Attachment | undefined {
  const { remoteJid, id } = raw.key;
  if (!attachment || !remoteJid || !id) return undefined;
  const location = Buffer.from(`${remoteJid}\0${id}`).toString("base64url");
  return { ...attachment, id: `${MESSAGE_MEDIA_PREFIX}${location}` };
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
  for (const name of MEDIA_TYPES) {
    const media = inner[name];
    if (media && !media.viewOnce) {
      const size = toSeconds(media.fileLength);
      const kind = media.ptt
        ? "voice"
        : media.gifPlayback
          ? "animation"
          : MEDIA[name];
      const mimeType = media.mimetype?.split(";")[0]?.trim().toLowerCase();
      return {
        text: media.caption ?? "",
        kind: "media",
        ...(media.contextInfo?.stanzaId
          ? { replyTo: media.contextInfo.stanzaId }
          : {}),
        ...(media.mediaKey?.length && (media.url || media.directPath)
          ? {
              attachment: {
                kind,
                ...(mimeType ? { mimeType } : {}),
                ...(media.fileName ? { name: media.fileName } : {}),
                ...(size && Number.isSafeInteger(size) ? { size } : {}),
                ...(media.width && media.width > 0
                  ? { width: media.width }
                  : {}),
                ...(media.height && media.height > 0
                  ? { height: media.height }
                  : {}),
                ...(media.seconds && media.seconds > 0
                  ? { durationSeconds: media.seconds }
                  : {}),
              },
            }
          : {}),
      };
    }
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
  const attachment =
    content.attachment && messageAttachment(raw, content.attachment);
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
    ...(attachment ? { attachments: [attachment] } : {}),
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
