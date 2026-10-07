import type {
  Attachment,
  Message,
  Reaction,
  Room,
} from "../../../packages/serve-kit/src/index";
import type { EmojiTable } from "./emoji";

// Structural inputs keep the network out of this pure module.
export interface SlackConversationLike {
  id: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  /** For a DM, the other person. */
  user?: string;
}

/** What `conversations.info` adds, once the adapter has asked. */
export interface SlackConversationInfo {
  unread?: number;
  latestTs?: string;
  latestText?: string;
  latestFromMe?: boolean;
}

export interface SlackFileLike {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  original_w?: number;
  original_h?: number;
  duration_ms?: number;
  subtype?: string;
  /** `tombstone` (deleted), `hidden_by_limit` (free plan) or `external` carry no bytes here. */
  mode?: string;
}

export interface SlackReactionLike {
  name: string;
  count: number;
  users?: readonly string[];
}

/** The Block Kit blocks a message can carry; only what is drawn is typed. */
export interface SlackBlockLike {
  type?: string;
  text?: { type?: string; text?: string };
  fields?: readonly { text?: string }[];
  elements?: readonly { type?: string; text?: string }[];
  image_url?: string;
  alt_text?: string;
  image_width?: number;
  image_height?: number;
  image_bytes?: number;
}

export interface SlackMessageLike {
  ts: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  subtype?: string;
  thread_ts?: string;
  edited?: { ts: string };
  files?: readonly SlackFileLike[];
  reactions?: readonly SlackReactionLike[];
  blocks?: readonly SlackBlockLike[];
}

/** Raster pictures a block image may be, by the address's extension. */
const BLOCK_IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** A block image's address when it is a plain https one; anything else is not drawn. */
export function blockImageUrl(
  block: SlackBlockLike | undefined,
): URL | undefined {
  const address = block?.type === "image" ? block.image_url : undefined;
  if (typeof address !== "string" || !URL.canParse(address)) return undefined;
  const url = new URL(address);
  return url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port
    ? url
    : undefined;
}

/** A block image's type, from its address; unknown kinds are not offered. */
export function blockImageType(url: URL): string | undefined {
  const extension = url.pathname.split(".").pop()?.toLowerCase() ?? "";
  return BLOCK_IMAGE_TYPES[extension];
}

/**
 * Image blocks (a bot's picture by address) as attachments. Slack measured
 * them when the message was posted, so the size comes from the block.
 */
export function mapBlockImages(
  roomId: string,
  ts: string,
  blocks: readonly SlackBlockLike[],
): Attachment[] {
  const positive = (value: number | undefined) =>
    value !== undefined && Number.isSafeInteger(value) && value > 0;
  return blocks.flatMap((block, index) => {
    const url = blockImageUrl(block);
    const mimeType = url ? blockImageType(url) : undefined;
    if (!url || !mimeType) return [];
    return [
      {
        id: `${roomId}:${ts}:image${index}`,
        kind: "image" as const,
        mimeType,
        ...(block.alt_text ? { name: block.alt_text } : {}),
        ...(positive(block.image_bytes) ? { size: block.image_bytes } : {}),
        ...(positive(block.image_width) && positive(block.image_height)
          ? { width: block.image_width, height: block.image_height }
          : {}),
      },
    ];
  });
}

/**
 * The words of a message's header, section and context blocks that its plain
 * `text` does not already say: a bot's message often keeps its body there.
 */
export function blockLines(
  blocks: readonly SlackBlockLike[],
  text: string,
): string[] {
  const lines: string[] = [];
  const add = (value: string | undefined) => {
    const line = value?.trim();
    if (line && !text.includes(line) && !lines.includes(line)) lines.push(line);
  };
  for (const block of blocks) {
    if (block.type === "header" || block.type === "section")
      add(block.text?.text);
    if (block.type === "section")
      for (const field of block.fields ?? []) add(field.text);
    if (block.type === "context")
      for (const element of block.elements ?? [])
        if (element.type === "mrkdwn" || element.type === "plain_text")
          add(element.text);
  }
  return lines;
}

/** Subtypes that are someone writing; every other subtype is a service notice. */
const CONVERSATION_SUBTYPES = new Set([
  undefined,
  "bot_message",
  "me_message",
  "file_share",
  "thread_broadcast",
]);

/** A Slack timestamp (`1700000000.123456`, seconds and microseconds) as RFC 3339. */
export function slackTime(ts: string): string | undefined {
  const match = /^(\d+)\.(\d{1,6})$/.exec(ts);
  if (!match) return undefined;
  const milliseconds =
    Number(match[1]) * 1000 +
    Math.floor(Number(match[2]?.padEnd(6, "0")) / 1000);
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** People named in `<@U…>` mentions, so their names can be looked up first. */
export function mentionedUsers(text: string): string[] {
  return [...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].flatMap(
    (match) => (match[1] ? [match[1]] : []),
  );
}

/**
 * Slack's mrkdwn as plain text: mentions become `@name`, channel links
 * `#name`, special mentions `@here`, and links their address (with the label
 * when it says something else), and the three escaped characters come back.
 */
export function fromSlackText(
  text: string,
  names: { user(id: string): string | undefined },
): string {
  const replaced = text.replace(/<([^>]*)>/g, (_whole, inner: string) => {
    const [target = "", label] = inner.split("|", 2);
    if (target.startsWith("@"))
      return `@${names.user(target.slice(1)) ?? label ?? target.slice(1)}`;
    if (target.startsWith("#")) return `#${label ?? target.slice(1)}`;
    if (target.startsWith("!subteam^")) return label ?? "@group";
    if (target.startsWith("!date^")) return label ?? "";
    if (target.startsWith("!")) return `@${target.slice(1)}`;
    if (target.startsWith("mailto:")) return label ?? target.slice(7);
    if (
      !label ||
      label === target ||
      label === target.replace(/^https?:\/\//, "")
    )
      return target;
    return `${label} (${target})`;
  });
  return replaced
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** Text from saya as Slack expects it: `&`, `<` and `>` escaped, so nothing is read as markup. */
export function toSlackText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** A group DM's name is `mpdm-alice--bob--carol-1`; its title is the other people. */
export function groupDmTitle(
  name: string,
  selfHandle: string | undefined,
): string {
  const people = name
    .replace(/^mpdm-/, "")
    .replace(/-\d+$/, "")
    .split("--")
    .filter((handle) => handle && handle !== selfHandle);
  return people.join(", ") || name;
}

export function mapSlackRoom(
  conversation: SlackConversationLike,
  title: string,
  info: SlackConversationInfo | undefined,
  canSend: boolean,
): Room {
  const lastActivityAt = info?.latestTs ? slackTime(info.latestTs) : undefined;
  return {
    id: conversation.id,
    title,
    kind: conversation.is_im ? "direct" : "group",
    unread:
      info?.unread !== undefined &&
      Number.isSafeInteger(info.unread) &&
      info.unread >= 0
        ? info.unread
        : 0,
    ...(lastActivityAt ? { lastActivityAt } : {}),
    ...(info?.latestText !== undefined
      ? {
          lastMessage: {
            text: [...info.latestText].slice(0, 200).join(""),
            fromMe: info.latestFromMe ?? false,
          },
        }
      : {}),
    ...(canSend
      ? {}
      : {
          features: {
            "messages.send": false as const,
            "attachments.send": false as const,
          },
        }),
  };
}

function fileKind(file: SlackFileLike): Attachment["kind"] {
  const type = file.mimetype ?? "";
  if (file.subtype === "slack_audio") return "voice";
  if (type === "image/gif") return "animation";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  return "file";
}

export function mapSlackFile(
  roomId: string,
  ts: string,
  file: SlackFileLike,
): Attachment | null {
  if (
    file.mode &&
    file.mode !== "hosted" &&
    file.mode !== "snippet" &&
    file.mode !== "post"
  )
    return null;
  const positive = (value: number | undefined) =>
    value !== undefined && Number.isSafeInteger(value) && value > 0;
  return {
    id: `${roomId}:${ts}:${file.id}`,
    kind: fileKind(file),
    ...((file.name ?? file.title) ? { name: file.name ?? file.title } : {}),
    ...(file.mimetype ? { mimeType: file.mimetype } : {}),
    ...(file.size !== undefined &&
    Number.isSafeInteger(file.size) &&
    file.size >= 0
      ? { size: file.size }
      : {}),
    ...(positive(file.original_w) && positive(file.original_h)
      ? { width: file.original_w, height: file.original_h }
      : {}),
    ...(file.duration_ms !== undefined && file.duration_ms >= 0
      ? { durationSeconds: file.duration_ms / 1000 }
      : {}),
  };
}

export function mapSlackReactions(
  reactions: readonly SlackReactionLike[],
  selfId: string,
  emoji: EmojiTable,
): Reaction[] {
  return reactions.flatMap((reaction) => {
    const unicode = emoji.toUnicode(reaction.name);
    return unicode && Number.isSafeInteger(reaction.count) && reaction.count > 0
      ? [
          {
            emoji: unicode,
            count: reaction.count,
            mine: reaction.users?.includes(selfId) ?? false,
          },
        ]
      : [];
  });
}

/** Whether a history entry is a thread reply that only the thread shows. */
export function threadOnly(message: SlackMessageLike): boolean {
  return (
    message.thread_ts !== undefined &&
    message.thread_ts !== message.ts &&
    message.subtype !== "thread_broadcast"
  );
}

export function mapSlackMessage(
  roomId: string,
  message: SlackMessageLike,
  context: {
    selfId: string;
    sender: string;
    senderAvatar?: string;
    text: string;
    emoji: EmojiTable;
  },
): Message {
  const attachments = [
    ...(message.files ?? []).flatMap((file) => {
      const mapped = mapSlackFile(roomId, message.ts, file);
      return mapped ? [mapped] : [];
    }),
    ...mapBlockImages(roomId, message.ts, message.blocks ?? []),
  ];
  const reactions = mapSlackReactions(
    message.reactions ?? [],
    context.selfId,
    context.emoji,
  );
  const editedAt = message.edited ? slackTime(message.edited.ts) : undefined;
  const senderId = message.user ?? message.bot_id;
  return {
    id: message.ts,
    roomId,
    ...(senderId ? { senderId } : {}),
    sender: context.sender,
    ...(context.senderAvatar ? { senderAvatar: context.senderAvatar } : {}),
    text: context.text,
    kind: !CONVERSATION_SUBTYPES.has(message.subtype)
      ? "service"
      : attachments.length || message.files?.length
        ? "media"
        : "text",
    sentAt: slackTime(message.ts) ?? new Date(0).toISOString(),
    fromMe: message.user === context.selfId,
    ...(editedAt ? { editedAt } : {}),
    ...(message.thread_ts && message.thread_ts !== message.ts
      ? { replyTo: message.thread_ts }
      : {}),
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
