import {
  type AdapterBackend,
  AdapterError,
  type Message,
  type Reaction,
  type Room,
  type StreamUpdate,
} from "@tsuba/serve-kit";
import { REACTION_NOOPS, type SlackCall } from "./api";
import type { EmojiTable } from "./emoji";
import {
  fromSlackText,
  groupDmTitle,
  mapSlackMessage,
  mapSlackReactions,
  mapSlackRoom,
  mentionedUsers,
  reactionPlan,
  type SlackConversationInfo,
  type SlackConversationLike,
  type SlackFileLike,
  type SlackMessageLike,
  threadOnly,
  toSlackText,
} from "./mapping";

const CONVERSATION = /^[CDG][A-Z0-9]{6,}$/;
const TS = /^\d+\.\d{1,6}$/;
const FILE_HOSTS = new Set(["files.slack.com"]);
const ROOM_LIMIT = 500;
/**
 * `conversations.info` and `conversations.history` are Tier 3 (50+ a minute
 * each). A room can take one info and two history calls, so 3 s a room keeps
 * history at 40 a minute and leaves room for reads.
 */
const INFO_INTERVAL_MS = 3000;
/** Unread messages counted past `last_read`, as many as one page holds. */
const UNREAD_PAGE = 100;

interface SlackUser {
  id: string;
  name?: string;
  deleted?: boolean;
  profile?: { display_name?: string; real_name?: string };
  real_name?: string;
}

interface Conversation extends SlackConversationLike {
  is_archived?: boolean;
}

interface SlackFile extends SlackFileLike {
  url_private?: string;
  url_private_download?: string;
}

interface HistoryAnswer {
  messages?: SlackMessageLike[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

function conversationId(value: string): string {
  if (!CONVERSATION.test(value))
    throw new AdapterError("NOT_FOUND", "No such Slack conversation");
  return value;
}

function timestamp(value: string): string {
  if (!TS.test(value))
    throw new AdapterError("INVALID_REQUEST", "Invalid Slack message id");
  return value;
}

export interface SlackIdentity {
  userId: string;
  handle?: string;
}

/**
 * The person's own Slack account behind the contract, through the official
 * user token. Rooms are the channels, private channels, DMs and group DMs the
 * person is in. Thread replies live in their thread, which is not a room;
 * a reply sent from here is broadcast to the conversation so it stays visible.
 */
export function slackBackend(
  call: SlackCall,
  identity: SlackIdentity,
  emoji: EmojiTable,
  live: {
    onEvent(listener: (event: Record<string, unknown>) => void): () => void;
  },
  fetcher: typeof fetch = fetch,
  userToken = "",
  options: { fillIntervalMs?: number } = {},
): AdapterBackend & { stop(): void } {
  const users = new Map<string, Promise<SlackUser | undefined>>();
  const info = new Map<string, SlackConversationInfo>();
  const stale = new Set<string>();
  let known: Conversation[] = [];
  let worker: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function user(id: string): Promise<SlackUser | undefined> {
    let held = users.get(id);
    if (!held) {
      held = call<{ user?: SlackUser }>("users.info", { user: id }).then(
        (answer) => answer.user,
        () => undefined,
      );
      users.set(id, held);
    }
    return held;
  }

  function nameOf(found: SlackUser | undefined, fallback: string): string {
    return (
      found?.profile?.display_name ||
      found?.profile?.real_name ||
      found?.real_name ||
      found?.name ||
      fallback
    );
  }

  async function names(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    const found = await Promise.all(unique.map((id) => user(id)));
    return new Map(unique.map((id, index) => [id, nameOf(found[index], id)]));
  }

  async function toMessage(
    roomId: string,
    message: SlackMessageLike,
  ): Promise<Message> {
    const text = message.text ?? "";
    const known = await names([
      ...mentionedUsers(text),
      ...(message.user ? [message.user] : []),
    ]);
    return mapSlackMessage(roomId, message, {
      selfId: identity.userId,
      sender: message.user
        ? (known.get(message.user) ?? message.user)
        : (message.username ?? "bot"),
      text: fromSlackText(text, { user: (id) => known.get(id) }),
      emoji,
    });
  }

  async function messageAt(
    roomId: string,
    ts: string,
  ): Promise<SlackMessageLike> {
    const answer = await call<HistoryAnswer>("conversations.history", {
      channel: roomId,
      latest: ts,
      inclusive: true,
      limit: 1,
    });
    const found = answer.messages?.[0];
    if (!found || found.ts !== ts)
      throw new AdapterError("NOT_FOUND", "No such Slack message");
    return found;
  }

  // Fill unread counts and latest activity a room at a time, under Slack's rate.
  function schedule() {
    if (stopped || worker) return;
    const next = [...stale][0] ?? known.find((room) => !info.has(room.id))?.id;
    if (!next) return;
    worker = setTimeout(async () => {
      worker = undefined;
      stale.delete(next);
      try {
        const answer = await call<{
          channel?: {
            unread_count_display?: number;
            last_read?: string;
            latest?: SlackMessageLike;
          };
        }>("conversations.info", { channel: next });
        const channel = answer.channel;
        // Slack gives the count and the newest message for DMs only; for the
        // rest, read the newest message and count what came after last_read.
        let latest = channel?.latest;
        if (!latest?.ts) {
          const newest = await call<HistoryAnswer>("conversations.history", {
            channel: next,
            limit: 1,
          });
          latest = newest.messages?.[0];
        }
        let unread = channel?.unread_count_display;
        if (unread === undefined && channel?.last_read && latest?.ts) {
          const after =
            Number(latest.ts) > Number(channel.last_read)
              ? await call<HistoryAnswer>("conversations.history", {
                  channel: next,
                  // A room never read has last_read 0000000000.000000, which Slack
                  // refuses as `oldest` (invalid_ts_oldest): count from the start.
                  ...(/^0+\.0+$/.test(channel.last_read)
                    ? {}
                    : { oldest: channel.last_read, inclusive: false }),
                  limit: UNREAD_PAGE,
                })
              : { messages: [] };
          unread = (after.messages ?? []).filter(
            (item) => item.user !== identity.userId && !threadOnly(item),
          ).length;
        }
        const text = latest?.text ?? "";
        const resolved = await names(mentionedUsers(text));
        info.set(next, {
          ...(unread !== undefined ? { unread } : {}),
          ...(latest?.ts ? { latestTs: latest.ts } : {}),
          ...(latest?.ts
            ? {
                latestText: fromSlackText(text, {
                  user: (id) => resolved.get(id),
                }),
                latestFromMe: latest.user === identity.userId,
              }
            : {}),
        });
      } catch {
        info.set(next, info.get(next) ?? {});
      }
      schedule();
    }, options.fillIntervalMs ?? INFO_INTERVAL_MS);
  }

  async function title(
    conversation: Conversation,
  ): Promise<{ title: string; canSend: boolean }> {
    if (conversation.is_im && conversation.user) {
      const other = await user(conversation.user);
      return {
        title: nameOf(other, conversation.user),
        canSend: !other?.deleted,
      };
    }
    if (conversation.is_mpim)
      return {
        title: groupDmTitle(
          conversation.name ?? conversation.id,
          identity.handle,
        ),
        canSend: true,
      };
    return { title: `#${conversation.name ?? conversation.id}`, canSend: true };
  }

  const stopLive = live.onEvent((event) => {
    const channel =
      typeof event.channel === "string" ? event.channel : undefined;
    const item = event.item as { channel?: string } | undefined;
    const room = channel ?? item?.channel;
    if (room) {
      stale.add(room);
      schedule();
    }
  });

  return {
    stop() {
      stopped = true;
      clearTimeout(worker);
      stopLive();
    },

    async listRooms() {
      const found: Conversation[] = [];
      let cursor: string | undefined;
      do {
        const page = await call<{
          channels?: Conversation[];
          response_metadata?: { next_cursor?: string };
        }>("users.conversations", {
          types: "public_channel,private_channel,mpim,im",
          exclude_archived: true,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        found.push(
          ...(page.channels ?? []).filter((room) => !room.is_archived),
        );
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor && found.length <= ROOM_LIMIT);
      known = found;
      schedule();
      const rooms: Room[] = await Promise.all(
        found.slice(0, ROOM_LIMIT).map(async (conversation) => {
          const named = await title(conversation);
          return mapSlackRoom(
            conversation,
            named.title,
            info.get(conversation.id),
            named.canSend,
          );
        }),
      );
      rooms.sort((left, right) => {
        const a = left.lastActivityAt ? Date.parse(left.lastActivityAt) : 0;
        const b = right.lastActivityAt ? Date.parse(right.lastActivityAt) : 0;
        return b - a || left.title.localeCompare(right.title, "en");
      });
      return { rooms, complete: found.length <= ROOM_LIMIT };
    },

    async readMessages({ roomId, limit, before }) {
      const answer = await call<HistoryAnswer>("conversations.history", {
        channel: conversationId(roomId),
        limit,
        ...(before === undefined
          ? {}
          : { latest: timestamp(before), inclusive: false }),
      });
      const newestFirst = (answer.messages ?? []).filter(
        (item) => !threadOnly(item),
      );
      return {
        messages: await Promise.all(
          newestFirst.reverse().map((item) => toMessage(roomId, item)),
        ),
        hasEarlier: answer.has_more === true,
      };
    },

    async messagesAfter(roomId, afterId) {
      const channel = conversationId(roomId);
      // Refuse a cursor whose message is gone rather than starting from now.
      await messageAt(channel, timestamp(afterId));
      const collected: SlackMessageLike[] = [];
      let cursor: string | undefined;
      do {
        const page = await call<HistoryAnswer>("conversations.history", {
          channel,
          oldest: afterId,
          inclusive: false,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        collected.push(...(page.messages ?? []));
        cursor = page.has_more
          ? page.response_metadata?.next_cursor || undefined
          : undefined;
      } while (cursor);
      const oldestFirst = collected
        .filter((item) => !threadOnly(item))
        .sort((left, right) => Number(left.ts) - Number(right.ts));
      return Promise.all(oldestFirst.map((item) => toMessage(channel, item)));
    },

    subscribe(listener: (update: StreamUpdate) => void) {
      return live.onEvent((event) => {
        void (async () => {
          if (event.type === "message") {
            const channel = event.channel;
            if (typeof channel !== "string") return;
            const subtype = event.subtype;
            if (subtype === "message_deleted") {
              if (typeof event.deleted_ts === "string")
                listener({
                  event: "message.deleted",
                  roomId: channel,
                  messageIds: [event.deleted_ts],
                });
              return;
            }
            if (subtype === "message_changed") {
              const changed = event.message as SlackMessageLike | undefined;
              if (changed && !threadOnly(changed))
                listener({
                  event: "message.edited",
                  message: await toMessage(channel, changed),
                });
              return;
            }
            const message = event as unknown as SlackMessageLike;
            if (!threadOnly(message))
              listener({
                event: "message",
                message: await toMessage(channel, message),
              });
            return;
          }
          if (
            event.type === "reaction_added" ||
            event.type === "reaction_removed"
          ) {
            const item = event.item as
              | { type?: string; channel?: string; ts?: string }
              | undefined;
            if (item?.type !== "message" || !item.channel || !item.ts) return;
            // Ask again so the counts are Slack's, not a sum of events.
            const message = await messageAt(item.channel, item.ts);
            listener({
              event: "reactions.updated",
              roomId: item.channel,
              messageId: item.ts,
              reactions: mapSlackReactions(
                message.reactions ?? [],
                identity.userId,
                emoji,
              ),
            });
          }
        })().catch(() => {
          // A message gone before it could be read again has nothing to show.
        });
      });
    },

    async send(roomId, text, { replyTo }) {
      const channel = conversationId(roomId);
      let threadTs: string | undefined;
      if (replyTo !== undefined) {
        // A reply goes under the thread its message belongs to.
        const parent = await messageAt(channel, timestamp(replyTo));
        threadTs = parent.thread_ts ?? parent.ts;
      }
      const answer = await call<{ ts?: string; message?: SlackMessageLike }>(
        "chat.postMessage",
        {
          channel,
          text: toSlackText(text),
          ...(threadTs ? { thread_ts: threadTs, reply_broadcast: true } : {}),
        },
      );
      if (!answer.message || !answer.ts)
        throw new AdapterError(
          "INTERNAL",
          "Slack did not return the stored message",
        );
      return toMessage(channel, { ...answer.message, ts: answer.ts });
    },

    async edit(roomId, messageId, text) {
      const channel = conversationId(roomId);
      const ts = timestamp(messageId);
      await call("chat.update", { channel, ts, text: toSlackText(text) });
      return toMessage(channel, await messageAt(channel, ts));
    },

    async deleteMessage(roomId, messageId) {
      await call("chat.delete", {
        channel: conversationId(roomId),
        ts: timestamp(messageId),
      });
    },

    async react(roomId, messageId, emojis): Promise<Reaction[]> {
      const channel = conversationId(roomId);
      const ts = timestamp(messageId);
      const wanted = emojis.map((value) => {
        const name = emoji.toName(value);
        if (!name)
          throw new AdapterError(
            "INVALID_REQUEST",
            "Slack has no reaction for that emoji",
          );
        return name;
      });
      const current = await messageAt(channel, ts);
      const mine = (current.reactions ?? [])
        .filter((reaction) => reaction.users?.includes(identity.userId))
        .map((reaction) => reaction.name);
      const plan = reactionPlan(mine, wanted);
      for (const name of plan.remove)
        await call(
          "reactions.remove",
          { channel, timestamp: ts, name },
          { tolerate: REACTION_NOOPS },
        );
      for (const name of plan.add)
        await call(
          "reactions.add",
          { channel, timestamp: ts, name },
          { tolerate: REACTION_NOOPS },
        );
      const after = await messageAt(channel, ts);
      return mapSlackReactions(after.reactions ?? [], identity.userId, emoji);
    },

    async markRead(roomId, messageId) {
      const channel = conversationId(roomId);
      await call("conversations.mark", { channel, ts: timestamp(messageId) });
      info.set(channel, { ...info.get(channel), unread: 0 });
    },

    async media(id, signal) {
      const [, roomId = "", ts = "", fileId = ""] =
        /^([CDG][A-Z0-9]{6,}):(\d+\.\d{1,6}):(F[A-Z0-9]+)$/.exec(id) ?? [];
      if (!fileId) throw new AdapterError("NOT_FOUND", "No such Slack file");
      const message = await messageAt(roomId, ts);
      const file = (message.files as readonly SlackFile[] | undefined)?.find(
        (item) => item.id === fileId,
      );
      const address = file?.url_private_download ?? file?.url_private;
      if (!address) throw new AdapterError("NOT_FOUND", "No such Slack file");
      const url = new URL(address);
      // The token goes only to Slack's own file host.
      if (url.protocol !== "https:" || !FILE_HOSTS.has(url.hostname))
        throw new AdapterError("NOT_FOUND", "No such Slack file");
      let response: Response;
      try {
        response = await fetcher(url, {
          signal,
          headers: { authorization: `Bearer ${userToken}` },
          redirect: "manual",
        });
      } catch {
        throw new AdapterError("INTERNAL", "Slack could not be reached");
      }
      if (!response.ok || !response.body)
        throw new AdapterError("NOT_FOUND", "The Slack file is gone");
      return {
        body: response.body,
        ...(file?.mimetype ? { mimeType: file.mimetype } : {}),
        ...((file?.name ?? file?.title)
          ? { name: file?.name ?? file?.title }
          : {}),
      };
    },
  };
}
