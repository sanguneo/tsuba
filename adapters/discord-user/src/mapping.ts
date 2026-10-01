import type { Room } from "@tsuba/serve-kit";
import {
  type DiscordMessageLike,
  snowflakeTime,
} from "../../discord/src/mapping";

export {
  type DiscordMessageLike,
  mapDiscordMessage as mapUserMessage,
  reactionPlan,
  snowflakeTime,
} from "../../discord/src/mapping";

export const CHANNEL_TYPE = {
  GUILD_TEXT: 0,
  DM: 1,
  GROUP_DM: 3,
} as const;

export interface UserChannelLike {
  id: string;
  type: number;
  name?: string | null;
  guildName?: string | null;
  lastMessageId?: string | null;
  lastMessage?: Pick<DiscordMessageLike, "content" | "fromMe"> | null;
  recipients?: readonly {
    id: string;
    username: string;
    globalName?: string | null;
  }[];
}

export function mapUserChannel(channel: UserChannelLike): Room | null {
  if (
    channel.type !== CHANNEL_TYPE.GUILD_TEXT &&
    channel.type !== CHANNEL_TYPE.DM &&
    channel.type !== CHANNEL_TYPE.GROUP_DM
  )
    return null;

  let title: string;
  if (channel.type === CHANNEL_TYPE.DM) {
    const recipient = channel.recipients?.[0];
    title = recipient?.globalName ?? recipient?.username ?? "Direct Message";
  } else if (channel.type === CHANNEL_TYPE.GROUP_DM) {
    title =
      channel.name ??
      (channel.recipients?.length
        ? channel.recipients
            .map((recipient) => recipient.globalName ?? recipient.username)
            .join(", ")
        : "unnamed");
  } else {
    title = `${channel.guildName == null ? "" : `${channel.guildName} · `}#${channel.name ?? "channel"}`;
  }

  const lastActivityAt = channel.lastMessageId
    ? snowflakeTime(channel.lastMessageId)
    : undefined;
  return {
    id: channel.id,
    title,
    kind: channel.type === CHANNEL_TYPE.DM ? "direct" : "group",
    // Discord REST does not provide this account's unread marker or count.
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
  };
}
