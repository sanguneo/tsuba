import {
  type AdapterBackend,
  AdapterError,
  type Message,
  type Reaction,
  type Room,
  type StreamUpdate,
} from "@tsuba/serve-kit";
import {
  ChannelType,
  type Client,
  type Attachment as DiscordAttachment,
  type Message as DiscordMessage,
  Events,
  type GuildTextBasedChannel,
  type MessageReaction,
  type PartialMessage,
  type PartialMessageReaction,
  PermissionFlagsBits,
  type ReadonlyCollection,
  type Snowflake,
  type TextChannel,
  type User,
} from "discord.js";
import {
  type DiscordMessageLike,
  mapDiscordMessage,
  mapDiscordReaction,
  mapDiscordRoom,
  reactionPlan,
} from "./mapping";

const SNOWFLAKE = /^\d{17,20}$/;
const CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const ROOM_LIMIT = 500;

/**
 * Discord's REST errors, by HTTP status and JSON error code. Every refusal it
 * states maps to a code that says nothing changed; anything else stays
 * INTERNAL, which on a write means the outcome is unknown.
 */
function apiError(error: unknown): AdapterError {
  if (error instanceof AdapterError) return error;
  const value =
    error && typeof error === "object"
      ? (error as { status?: unknown; code?: unknown })
      : {};
  if (value.status === 401)
    return new AdapterError(
      "REAUTH_REQUIRED",
      "Discord no longer accepts this bot token; set a new one where the adapter runs",
    );
  if (value.status === 403 || value.code === 30010)
    return new AdapterError(
      "FORBIDDEN",
      "Discord does not let this bot do that here",
    );
  if (value.status === 404)
    return new AdapterError(
      "NOT_FOUND",
      "No such Discord channel, message or attachment",
    );
  if (value.status === 429)
    return new AdapterError(
      "RATE_LIMITED",
      "Discord asked the adapter to slow down",
    );
  if (value.status === 400)
    return new AdapterError(
      "INVALID_REQUEST",
      "Discord refused the request as it was",
    );
  return new AdapterError("INTERNAL", "The Discord adapter failed");
}

async function discord<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw apiError(error);
  }
}

function isText(channel: unknown): channel is TextChannel {
  return Boolean(
    channel &&
      typeof channel === "object" &&
      "type" in channel &&
      channel.type === ChannelType.GuildText,
  );
}

function permissions(channel: GuildTextBasedChannel, bot: User) {
  const value = channel.permissionsFor(bot);
  return {
    view: value?.has(PermissionFlagsBits.ViewChannel) ?? false,
    readHistory: value?.has(PermissionFlagsBits.ReadMessageHistory) ?? false,
    send: value?.has(PermissionFlagsBits.SendMessages) ?? false,
    react: value?.has(PermissionFlagsBits.AddReactions) ?? false,
  };
}

function readable(channel: unknown, bot: User): channel is TextChannel {
  if (!isText(channel)) return false;
  const value = permissions(channel, bot);
  return value.view && value.readHistory;
}

function mapChannel(channel: TextChannel, bot: User): Room | null {
  const allowed = permissions(channel, bot);
  const cached = channel.lastMessageId
    ? channel.messages.cache.get(channel.lastMessageId)
    : undefined;
  const room = mapDiscordRoom({
    id: channel.id,
    type: channel.type,
    name: channel.name,
    guildName: channel.guild.name,
    ...(channel.lastMessageId ? { lastMessageId: channel.lastMessageId } : {}),
    ...(cached
      ? {
          lastMessage: {
            content: cached.content,
            fromMe: cached.author.id === bot.id,
          },
        }
      : {}),
    permissions: allowed,
  });
  if (!room || allowed.react) return room;
  return {
    ...room,
    features: { ...room.features, "reactions.send": false },
  };
}

function toMessage(message: DiscordMessage, bot: User): Message {
  const input: DiscordMessageLike = {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    authorName:
      message.member?.displayName ??
      message.author.globalName ??
      message.author.username,
    fromMe: message.author.id === bot.id,
    content: message.content,
    createdAt: message.createdAt,
    ...(message.editedAt ? { editedAt: message.editedAt } : {}),
    ...(message.reference?.messageId
      ? { referenceId: message.reference.messageId }
      : {}),
    type: message.type,
    stickers: message.stickers.size,
    attachments: [...message.attachments.values()].map(
      (attachment: DiscordAttachment) => ({
        id: attachment.id,
        url: attachment.url,
        name: attachment.name,
        contentType: attachment.contentType,
        size: attachment.size,
        width: attachment.width,
        height: attachment.height,
        durationSeconds: attachment.duration,
      }),
    ),
    reactions: [...message.reactions.cache.values()].map((reaction) => ({
      emojiId: reaction.emoji.id,
      emojiName: reaction.emoji.name,
      count: reaction.count,
      me: reaction.me,
    })),
  };
  return mapDiscordMessage(input);
}

function reactionsOf(message: DiscordMessage): Reaction[] {
  return [...message.reactions.cache.values()].flatMap((reaction) => {
    const value = mapDiscordReaction({
      emojiId: reaction.emoji.id,
      emojiName: reaction.emoji.name,
      count: reaction.count,
      me: reaction.me,
    });
    return value ? [value] : [];
  });
}

function snowflake(value: string, what: string): Snowflake {
  if (!SNOWFLAKE.test(value))
    throw new AdapterError("INVALID_REQUEST", `Invalid Discord ${what} id`);
  return value;
}

/**
 * A Discord bot account behind the contract. Rooms are the standard text
 * channels of the servers the bot was added to, where it may view channels
 * and read history; announcement and forum channels, threads, voice text
 * chats and direct messages are not rooms. Discord keeps no read state for
 * bots, so unread counts are 0 and read marks are not offered.
 */
export function discordBackend(client: Client<true>): AdapterBackend {
  const bot = client.user;

  async function room(roomId: string): Promise<TextChannel> {
    if (!SNOWFLAKE.test(roomId))
      throw new AdapterError("NOT_FOUND", "No such Discord channel");
    const channel = await discord(() => client.channels.fetch(roomId));
    if (!readable(channel, bot))
      throw new AdapterError("NOT_FOUND", "No such Discord channel");
    return channel;
  }

  function message(channel: TextChannel, id: string) {
    const messageId = snowflake(id, "message");
    // Always ask Discord: the cache can trail a write this adapter just made.
    return discord(() =>
      channel.messages.fetch({ message: messageId, force: true }),
    );
  }

  return {
    async listRooms() {
      const rooms: Room[] = [];
      // The Guilds intent keeps channels, roles and the bot's own member cached.
      for (const guild of client.guilds.cache.values())
        for (const channel of guild.channels.cache.values()) {
          if (!readable(channel, bot)) continue;
          const mapped = mapChannel(channel, bot);
          if (mapped) rooms.push(mapped);
        }
      rooms.sort((left, right) => {
        const a = left.lastActivityAt ? Date.parse(left.lastActivityAt) : 0;
        const b = right.lastActivityAt ? Date.parse(right.lastActivityAt) : 0;
        return b - a || left.title.localeCompare(right.title, "en");
      });
      return {
        rooms: rooms.slice(0, ROOM_LIMIT),
        complete: rooms.length <= ROOM_LIMIT,
      };
    },

    async readMessages({ roomId, limit, before }) {
      const channel = await room(roomId);
      const page = Math.min(limit, 100);
      const fetched = await discord(() =>
        channel.messages.fetch({
          limit: page,
          ...(before === undefined
            ? {}
            : { before: snowflake(before, "message") }),
        }),
      );
      const newestFirst = [...fetched.values()];
      const oldest = newestFirst.at(-1);
      // Probe before the oldest fetched id rather than trusting a full page.
      const hasEarlier =
        newestFirst.length === page && oldest
          ? (
              await discord(() =>
                channel.messages.fetch({ limit: 1, before: oldest.id }),
              )
            ).size > 0
          : false;
      return {
        messages: newestFirst.reverse().map((item) => toMessage(item, bot)),
        hasEarlier,
      };
    },

    async messagesAfter(roomId, afterId) {
      const channel = await room(roomId);
      // Refuse a cursor whose message is gone rather than starting from now.
      await message(channel, afterId);
      const result: Message[] = [];
      let after = afterId;
      for (;;) {
        const page = await discord(() =>
          channel.messages.fetch({ limit: 100, after }),
        );
        const oldestFirst = [...page.values()].sort(
          (left, right) => left.createdTimestamp - right.createdTimestamp,
        );
        result.push(...oldestFirst.map((item) => toMessage(item, bot)));
        const last = oldestFirst.at(-1);
        if (!last || oldestFirst.length < 100) return result;
        after = last.id;
      }
    },

    subscribe(listener: (update: StreamUpdate) => void) {
      const inRoom = (channel: unknown) => readable(channel, bot);
      const onCreate = (created: DiscordMessage) => {
        if (inRoom(created.channel))
          listener({ event: "message", message: toMessage(created, bot) });
      };
      const onUpdate = (
        _before: DiscordMessage | PartialMessage,
        after: DiscordMessage | PartialMessage,
      ) => {
        if (!inRoom(after.channel)) return;
        void (after.partial ? after.fetch() : Promise.resolve(after)).then(
          (full) =>
            listener({
              event: "message.edited",
              message: toMessage(full, bot),
            }),
          () => {
            // A message gone before it could be read again has nothing to show.
          },
        );
      };
      const onDelete = (deleted: DiscordMessage | PartialMessage) => {
        if (inRoom(deleted.channel))
          listener({
            event: "message.deleted",
            roomId: deleted.channelId,
            messageIds: [deleted.id],
          });
      };
      const onBulkDelete = (
        deleted: ReadonlyCollection<Snowflake, DiscordMessage | PartialMessage>,
        channel: GuildTextBasedChannel,
      ) => {
        if (inRoom(channel) && deleted.size)
          listener({
            event: "message.deleted",
            roomId: channel.id,
            messageIds: [...deleted.keys()],
          });
      };
      const onReaction = (
        reaction: MessageReaction | PartialMessageReaction,
      ) => {
        if (!inRoom(reaction.message.channel)) return;
        // Ask again so the counts are Discord's, not a cache built up in pieces.
        void reaction.message.fetch(true).then(
          (full) =>
            listener({
              event: "reactions.updated",
              roomId: full.channelId,
              messageId: full.id,
              reactions: reactionsOf(full),
            }),
          () => {
            // A message gone before it could be read again has nothing to show.
          },
        );
      };
      const onReactionsCleared = (cleared: DiscordMessage | PartialMessage) => {
        if (inRoom(cleared.channel))
          listener({
            event: "reactions.updated",
            roomId: cleared.channelId,
            messageId: cleared.id,
            reactions: [],
          });
      };
      client.on(Events.MessageCreate, onCreate);
      client.on(Events.MessageUpdate, onUpdate);
      client.on(Events.MessageDelete, onDelete);
      client.on(Events.MessageBulkDelete, onBulkDelete);
      client.on(Events.MessageReactionAdd, onReaction);
      client.on(Events.MessageReactionRemove, onReaction);
      client.on(Events.MessageReactionRemoveEmoji, onReaction);
      client.on(Events.MessageReactionRemoveAll, onReactionsCleared);
      return () => {
        client.off(Events.MessageCreate, onCreate);
        client.off(Events.MessageUpdate, onUpdate);
        client.off(Events.MessageDelete, onDelete);
        client.off(Events.MessageBulkDelete, onBulkDelete);
        client.off(Events.MessageReactionAdd, onReaction);
        client.off(Events.MessageReactionRemove, onReaction);
        client.off(Events.MessageReactionRemoveEmoji, onReaction);
        client.off(Events.MessageReactionRemoveAll, onReactionsCleared);
      };
    },

    async send(roomId, text, { replyTo }) {
      const channel = await room(roomId);
      const reference =
        replyTo === undefined ? undefined : snowflake(replyTo, "message");
      const sent = await discord(() =>
        channel.send({
          content: text,
          // Text from saya never pings @everyone, @here or a role.
          allowedMentions: { parse: ["users"], repliedUser: true },
          ...(reference === undefined
            ? {}
            : {
                reply: { messageReference: reference, failIfNotExists: true },
              }),
        }),
      );
      return toMessage(sent, bot);
    },

    async edit(roomId, messageId, text) {
      const channel = await room(roomId);
      const held = await message(channel, messageId);
      if (held.author.id !== bot.id)
        throw new AdapterError(
          "FORBIDDEN",
          "This bot can edit only its own messages",
        );
      const edited = await discord(() =>
        held.edit({
          content: text,
          allowedMentions: { parse: ["users"], repliedUser: true },
        }),
      );
      return toMessage(edited, bot);
    },

    async deleteMessage(roomId, messageId) {
      const channel = await room(roomId);
      const held = await message(channel, messageId);
      await discord(() => held.delete());
    },

    async react(roomId, messageId, emojis) {
      const channel = await room(roomId);
      const held = await message(channel, messageId);
      const mine = [...held.reactions.cache.values()]
        .filter((reaction) => reaction.me && !reaction.emoji.id)
        .flatMap((reaction) =>
          reaction.emoji.name ? [reaction.emoji.name] : [],
        );
      const plan = reactionPlan(mine, emojis);
      const permissions = channel.permissionsFor(bot);
      if (
        plan.add.length &&
        !permissions?.has(PermissionFlagsBits.AddReactions)
      )
        throw new AdapterError(
          "FORBIDDEN",
          "This bot cannot add reactions in this channel",
        );
      const retained = held.reactions.cache.filter(
        (reaction) =>
          !(
            reaction.me &&
            !reaction.emoji.id &&
            reaction.emoji.name &&
            plan.remove.includes(reaction.emoji.name)
          ),
      );
      const newDistinct = plan.add.filter(
        (emoji) =>
          !retained.some(
            (reaction) => !reaction.emoji.id && reaction.emoji.name === emoji,
          ),
      );
      if (retained.size + newDistinct.length > 20)
        throw new AdapterError(
          "FORBIDDEN",
          "Discord already has the maximum number of reaction kinds on this message",
        );
      let changed = false;
      try {
        for (const emoji of plan.remove) {
          await held.reactions.cache.get(emoji)?.users.remove(bot.id);
          changed = true;
        }
        for (const emoji of plan.add) {
          await held.react(emoji);
          changed = true;
        }
      } catch (error) {
        if (changed)
          throw new AdapterError(
            "INTERNAL",
            "Discord's reaction update stopped after a partial change; its outcome is unknown",
          );
        throw apiError(error);
      }
      return reactionsOf(await message(channel, messageId));
    },

    async media(id, signal) {
      const [, roomId = "", messageId = "", attachmentId = ""] =
        /^(\d{17,20}):(\d{17,20}):(\d{17,20})$/.exec(id) ?? [];
      if (!attachmentId)
        throw new AdapterError("NOT_FOUND", "No such Discord attachment");
      // Read the message again: attachment addresses are signed and expire.
      const held = await message(await room(roomId), messageId);
      const attachment = held.attachments.get(attachmentId);
      if (!attachment)
        throw new AdapterError("NOT_FOUND", "No such Discord attachment");
      const url = new URL(attachment.url);
      // The address came from Discord's answer; fetch it only from Discord's CDN.
      if (url.protocol !== "https:" || !CDN_HOSTS.has(url.hostname))
        throw new AdapterError("NOT_FOUND", "No such Discord attachment");
      const response = await discord(() =>
        fetch(url, { signal, redirect: "error" }),
      );
      if (!response.ok || !response.body)
        throw new AdapterError("NOT_FOUND", "The Discord attachment is gone");
      return {
        body: response.body,
        ...(attachment.contentType ? { mimeType: attachment.contentType } : {}),
        name: attachment.name,
      };
    },
  };
}
