import type {
  Attachment,
  Message,
  Reaction,
  Room,
} from "../../../packages/serve-kit/src/index";

export interface DiscordPermissions {
  view: boolean;
  readHistory: boolean;
  send: boolean;
}

export interface DiscordChannelLike {
  id: string;
  type: number;
  name: string;
  guildName: string;
  lastMessageId?: string | null;
  lastMessage?: Pick<DiscordMessageLike, "content" | "fromMe"> | null;
  permissions: DiscordPermissions;
}

export interface DiscordAttachmentLike {
  id: string;
  url: string;
  name: string;
  contentType?: string | null;
  size: number;
  width?: number | null;
  height?: number | null;
  /** Set on a voice message's recording, in seconds. */
  durationSeconds?: number | null;
}

export interface DiscordReactionLike {
  emojiId?: string | null;
  emojiName?: string | null;
  count: number;
  me: boolean;
}

export interface DiscordMessageLike {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  fromMe: boolean;
  content: string;
  createdAt: Date;
  editedAt?: Date | null;
  referenceId?: string | null;
  /** Discord's message type number. */
  type: number;
  stickers: number;
  attachments: readonly DiscordAttachmentLike[];
  reactions: readonly DiscordReactionLike[];
}

const DISCORD_EPOCH = 1_420_070_400_000n;
const GUILD_TEXT = 0;
/** Default, reply, and the replies to slash and context-menu commands: what people write. */
const CONVERSATION_TYPES = new Set([0, 19, 20, 23]);

export function snowflakeTime(id: string): string | undefined {
  if (!/^\d+$/.test(id)) return undefined;
  const milliseconds = Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
  if (!Number.isSafeInteger(milliseconds)) return undefined;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function mapDiscordRoom(channel: DiscordChannelLike): Room | null {
  if (
    channel.type !== GUILD_TEXT ||
    !channel.permissions.view ||
    !channel.permissions.readHistory
  )
    return null;

  const lastActivityAt = channel.lastMessageId
    ? snowflakeTime(channel.lastMessageId)
    : undefined;
  return {
    id: channel.id,
    title: `${channel.guildName} · #${channel.name}`,
    kind: "group",
    // Discord bots have no per-user unread marker or count.
    unread: 0,
    ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
    ...(channel.lastMessage
      ? {
          lastMessage: {
            text: [...channel.lastMessage.content].slice(0, 200).join(""),
            fromMe: channel.lastMessage.fromMe,
          },
        }
      : {}),
    ...(!channel.permissions.send
      ? { features: { "messages.send": false as const } }
      : {}),
  };
}

function attachmentKind(
  type: string | null | undefined,
  name: string,
  durationSeconds: number | null | undefined,
): Attachment["kind"] {
  if (durationSeconds != null && type?.startsWith("audio/")) return "voice";
  if (type?.startsWith("image/gif") || name.toLowerCase().endsWith(".gif"))
    return "animation";
  if (type?.startsWith("image/")) return "image";
  if (type?.startsWith("video/")) return "video";
  if (type?.startsWith("audio/")) return "audio";
  return "file";
}

export function mapDiscordAttachment(
  channelId: string,
  messageId: string,
  attachment: DiscordAttachmentLike,
): Attachment {
  const { width, height } = attachment;
  const dimensions =
    Number.isSafeInteger(width) &&
    (width ?? 0) > 0 &&
    Number.isSafeInteger(height) &&
    (height ?? 0) > 0
      ? { width: width as number, height: height as number }
      : {};
  return {
    id: `${channelId}:${messageId}:${attachment.id}`,
    kind: attachmentKind(
      attachment.contentType,
      attachment.name,
      attachment.durationSeconds,
    ),
    name: attachment.name,
    ...(attachment.contentType ? { mimeType: attachment.contentType } : {}),
    ...(Number.isSafeInteger(attachment.size) && attachment.size >= 0
      ? { size: attachment.size }
      : {}),
    ...dimensions,
    ...(attachment.durationSeconds != null &&
    Number.isFinite(attachment.durationSeconds) &&
    attachment.durationSeconds >= 0
      ? { durationSeconds: attachment.durationSeconds }
      : {}),
  };
}

export function mapDiscordReaction(
  reaction: DiscordReactionLike,
): Reaction | undefined {
  if (
    reaction.emojiId ||
    !reaction.emojiName ||
    !Number.isSafeInteger(reaction.count) ||
    reaction.count < 1
  )
    return undefined;
  return {
    emoji: reaction.emojiName,
    count: reaction.count,
    mine: reaction.me,
  };
}

export function mapDiscordMessage(message: DiscordMessageLike): Message {
  const reactions = message.reactions.flatMap((reaction) => {
    const mapped = mapDiscordReaction(reaction);
    return mapped ? [mapped] : [];
  });
  const attachments = message.attachments.map((attachment) =>
    mapDiscordAttachment(message.channelId, message.id, attachment),
  );
  return {
    id: message.id,
    roomId: message.channelId,
    senderId: message.authorId,
    sender: message.authorName,
    text: message.content,
    kind: !CONVERSATION_TYPES.has(message.type)
      ? "service"
      : attachments.length || message.stickers
        ? "media"
        : "text",
    sentAt: message.createdAt.toISOString(),
    fromMe: message.fromMe,
    ...(message.editedAt ? { editedAt: message.editedAt.toISOString() } : {}),
    ...(message.referenceId ? { replyTo: message.referenceId } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(reactions.length ? { reactions } : {}),
  };
}

/**
 * What to add and remove so this account's reactions become exactly
 * `wanted`, given the ones it has now. Removals go first so a messenger limit
 * on reactions per message is not hit on the way.
 */
export function reactionPlan(
  mine: readonly string[],
  wanted: readonly string[],
): { remove: string[]; add: string[] } {
  return {
    remove: mine.filter((emoji) => !wanted.includes(emoji)),
    add: wanted.filter((emoji) => !mine.includes(emoji)),
  };
}
