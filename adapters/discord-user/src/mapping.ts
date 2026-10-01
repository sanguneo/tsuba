import type { Attachment, Message, Reaction, Room } from "@tsuba/serve-kit";

export const CHANNEL_TYPE = {
  GUILD_TEXT: 0,
  DM: 1,
  GUILD_VOICE: 2,
  GROUP_DM: 3,
  GUILD_CATEGORY: 4,
  GUILD_ANNOUNCEMENT: 5,
  ANNOUNCEMENT_THREAD: 10,
  PUBLIC_THREAD: 11,
  PRIVATE_THREAD: 12,
  GUILD_STAGE_VOICE: 13,
  GUILD_DIRECTORY: 14,
  GUILD_FORUM: 15,
  GUILD_MEDIA: 16,
} as const;

export interface RawDiscordChannel {
  id: string;
  type: number;
  name?: string | null;
  guild_id?: string;
  last_message_id?: string | null;
  recipients?: Array<{
    id: string;
    username: string;
    global_name?: string | null;
  }>;
  parent_id?: string | null;
}

export interface RawDiscordMessage {
  id: string;
  channel_id: string;
  author: {
    id: string;
    username: string;
    global_name?: string | null;
    bot?: boolean;
  };
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  type: number;
  message_reference?: {
    message_id?: string;
    channel_id?: string;
  };
  attachments?: Array<{
    id: string;
    filename: string;
    size: number;
    url: string;
    proxy_url: string;
    content_type?: string;
    width?: number | null;
    height?: number | null;
    duration_secs?: number | null;
  }>;
  reactions?: Array<{
    emoji: {
      id?: string | null;
      name?: string | null;
    };
    count: number;
    me: boolean;
  }>;
}

export function snowflakeTime(id: string): string | undefined {
  try {
    const snowflake = BigInt(id);
    const ms = Number((snowflake >> 22n) + 1420070400000n);
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  } catch {
    return undefined;
  }
}

export function mapUserChannel(
  channel: RawDiscordChannel,
  guildName?: string,
  unreadCount = 0,
): Room | null {
  if (
    channel.type !== CHANNEL_TYPE.GUILD_TEXT &&
    channel.type !== CHANNEL_TYPE.DM &&
    channel.type !== CHANNEL_TYPE.GROUP_DM
  ) {
    return null;
  }

  let title = channel.name ?? "unnamed";
  let kind: Room["kind"] = "group";

  if (channel.type === CHANNEL_TYPE.DM) {
    kind = "direct";
    const recipient = channel.recipients?.[0];
    title = recipient?.global_name || recipient?.username || "Direct Message";
  } else if (channel.type === CHANNEL_TYPE.GROUP_DM) {
    kind = "group";
    if (!channel.name && channel.recipients?.length) {
      title = channel.recipients
        .map((r) => r.global_name || r.username)
        .join(", ");
    }
  } else if (guildName) {
    title = `${guildName} · #${channel.name || "channel"}`;
  } else {
    title = `#${channel.name || "channel"}`;
  }

  const lastActivityAt = channel.last_message_id
    ? snowflakeTime(channel.last_message_id)
    : undefined;

  return {
    id: channel.id,
    title,
    kind,
    unread: unreadCount,
    ...(lastActivityAt ? { lastActivityAt } : {}),
  };
}

const CONVERSATION_TYPES = new Set([0, 19, 20, 23]);

function mapAttachment(
  channelId: string,
  messageId: string,
  raw: NonNullable<RawDiscordMessage["attachments"]>[number],
): Attachment {
  let kind: Attachment["kind"] = "file";
  const ct = raw.content_type || "";
  if (raw.duration_secs != null && ct.startsWith("audio/")) {
    kind = "voice";
  } else if (ct.startsWith("image/gif")) {
    kind = "animation";
  } else if (ct.startsWith("image/")) {
    kind = "image";
  } else if (ct.startsWith("video/")) {
    kind = "video";
  } else if (ct.startsWith("audio/")) {
    kind = "audio";
  }

  return {
    id: `${channelId}:${messageId}:${raw.id}`,
    kind,
    name: raw.filename,
    ...(raw.content_type ? { mimeType: raw.content_type } : {}),
    size: raw.size,
    ...(raw.width && raw.height
      ? { width: raw.width, height: raw.height }
      : {}),
    ...(raw.duration_secs != null
      ? { durationSeconds: raw.duration_secs }
      : {}),
  };
}

export function mapUserMessage(
  msg: RawDiscordMessage,
  currentUserId: string,
): Message {
  const isFromMe = msg.author.id === currentUserId;
  const isService = !CONVERSATION_TYPES.has(msg.type);

  const attachments: Attachment[] = (msg.attachments || []).map((att) =>
    mapAttachment(msg.channel_id, msg.id, att),
  );

  const reactions: Reaction[] = (msg.reactions || []).flatMap((r) => {
    if (!r.emoji.id && r.emoji.name) {
      return [
        {
          emoji: r.emoji.name,
          count: r.count,
          mine: r.me,
        },
      ];
    }
    return [];
  });

  return {
    id: msg.id,
    roomId: msg.channel_id,
    senderId: msg.author.id,
    sender: msg.author.global_name || msg.author.username,
    text: msg.content,
    kind: isService ? "service" : attachments.length ? "media" : "text",
    sentAt: new Date(msg.timestamp).toISOString(),
    fromMe: isFromMe,
    ...(msg.edited_timestamp
      ? { editedAt: new Date(msg.edited_timestamp).toISOString() }
      : {}),
    ...(msg.message_reference?.message_id
      ? { replyTo: msg.message_reference.message_id }
      : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(reactions.length ? { reactions } : {}),
  };
}
