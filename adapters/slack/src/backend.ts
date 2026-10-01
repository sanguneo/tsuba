import { createHash } from "node:crypto";
import {
  type AdapterBackend,
  AdapterError,
  type Message,
  type Reaction,
  type Room,
  type StreamUpdate,
} from "@tsuba/serve-kit";
import { REACTION_NOOPS, type SlackCall, slackError } from "./api";
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
// Slack user-object docs, users.list examples, and slackapi/python-slack-sdk's
// tests/slack_sdk_fixture/rtm.start.json show these profile image hosts.
const AVATAR_HOSTS = new Set([
  "avatars.slack-edge.com",
  "secure.gravatar.com",
  "a.slack-edge.com",
]);
const AVATAR_ID = /^avatar:([UW][A-Z0-9]{6,128}):([a-f0-9]{24})$/;
// users.info is Tier 4; reuse display profiles across pages for ten minutes.
const USER_CACHE_MS = 10 * 60_000;

function avatarUrl(address: unknown): URL | undefined {
  if (typeof address !== "string" || !URL.canParse(address)) return undefined;
  const url = new URL(address);
  return url.protocol === "https:" &&
    AVATAR_HOSTS.has(url.hostname) &&
    !url.username &&
    !url.password &&
    !url.port
    ? url
    : undefined;
}

function avatarHash(address: string): string {
  return createHash("sha256").update(address).digest("hex").slice(0, 24);
}
const ROOM_LIMIT = 500;
/**
 * `conversations.info` and `conversations.history` are Tier 3 (50+ a minute
 * each). A room can take one info and two history calls, so 3 s a room keeps
 * history at 40 a minute and leaves room for reads.
 */
const INFO_INTERVAL_MS = 3000;
/** How long to wait after Slack says to slow down before filling again. */
const RATE_LIMIT_PAUSE_MS = 30_000;
/** Unread messages counted past `last_read`, as many as one page holds. */
const UNREAD_PAGE = 100;

interface SlackUser {
  id: string;
  name?: string;
  deleted?: boolean;
  profile?: { display_name?: string; real_name?: string; image_72?: string };
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
  options: { fillIntervalMs?: number; rateLimitPauseMs?: number } = {},
): AdapterBackend & { stop(): void } {
  const users = new Map<
    string,
    { expires: number; value: Promise<SlackUser> }
  >();
  const info = new Map<string, SlackConversationInfo>();
  const stale = new Set<string>();
  const failed = new Set<string>();
  let known: Conversation[] = [];
  let worker: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function user(id: string, refresh = false): Promise<SlackUser> {
    const held = users.get(id);
    if (!refresh && held && held.expires > Date.now()) return held.value;
    const value = call<{ user?: SlackUser }>("users.info", { user: id }).then(
      (answer) => {
        if (!answer.user || answer.user.id !== id)
          throw new AdapterError("INTERNAL", "Slack answered an invalid user");
        return answer.user;
      },
    );
    users.set(id, { expires: Date.now() + USER_CACHE_MS, value });
    return value.catch((error: unknown) => {
      if (users.get(id)?.value === value) users.delete(id);
      throw error;
    });
  }

  async function displayUser(id: string): Promise<SlackUser | undefined> {
    try {
      return await user(id);
    } catch (error) {
      // A name or picture we cannot read must not hide the message or room.
      // Only mapped Slack failures are optional; programming errors still escape.
      if (error instanceof AdapterError) return undefined;
      throw error;
    }
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
    const found = await Promise.all(unique.map((id) => displayUser(id)));
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
    // An app's message that names its bot user shows that user's picture, as
    // Slack does; a message with only a bot_id has none here (no extra calls).
    const address = message.user
      ? (await displayUser(message.user))?.profile?.image_72
      : undefined;
    const senderAvatar =
      typeof address === "string" && avatarUrl(address) && message.user
        ? `avatar:${message.user}:${avatarHash(address)}`
        : undefined;
    return mapSlackMessage(roomId, message, {
      selfId: identity.userId,
      ...(senderAvatar ? { senderAvatar } : {}),
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
    const next =
      [...stale][0] ??
      known.find((room) => !info.has(room.id) && !failed.has(room.id))?.id;
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
      } catch (error) {
        // Asked to slow down: try this room again after a pause. Any other
        // failure leaves the room unfilled and moves on; it is tried again on
        // its next event or the next pass.
        const limited =
          error instanceof AdapterError && error.code === "RATE_LIMITED";
        if (limited) stale.add(next);
        else failed.add(next);
        if (limited) {
          worker = setTimeout(() => {
            worker = undefined;
            schedule();
          }, options.rateLimitPauseMs ?? RATE_LIMIT_PAUSE_MS);
          return;
        }
      }
      schedule();
    }, options.fillIntervalMs ?? INFO_INTERVAL_MS);
  }

  async function title(
    conversation: Conversation,
  ): Promise<{ title: string; canSend: boolean }> {
    if (conversation.is_im && conversation.user) {
      const other = await displayUser(conversation.user);
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
      failed.delete(room);
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
      failed.clear();
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
      if (id.startsWith("avatar:")) {
        const match = AVATAR_ID.exec(id);
        if (!match || match[0] !== id)
          throw new AdapterError("NOT_FOUND", "No such Slack avatar");
        const userId = match[1] as string;
        // Re-read so a stale opaque id never serves a replacement picture.
        const address = (await user(userId, true)).profile?.image_72;
        const url = avatarUrl(address);
        if (
          !url ||
          typeof address !== "string" ||
          avatarHash(address) !== match[2]
        )
          throw new AdapterError("NOT_FOUND", "No such Slack avatar");
        // Gravatar answers a person who has none with a redirect to Slack's
        // default picture. Follow at most three hops, each one checked again
        // against the allowed hosts; anywhere else is no picture.
        let target = url;
        let response: Response;
        for (let hop = 0; ; hop++) {
          try {
            response = await fetcher(target, { signal, redirect: "manual" });
          } catch {
            throw slackError("avatar_fetch_failed");
          }
          if (response.status < 300 || response.status >= 400) break;
          const location = response.headers.get("location");
          const next =
            location && URL.canParse(location, target.href)
              ? avatarUrl(new URL(location, target).href)
              : undefined;
          await response.body?.cancel();
          if (!next || hop >= 2)
            throw new AdapterError("NOT_FOUND", "No such Slack avatar");
          target = next;
        }
        if (response.status === 429) throw slackError("ratelimited");
        if (response.status === 401) throw slackError("invalid_auth");
        if (response.status === 403) throw slackError("access_denied");
        if (response.status === 404 || response.status === 410)
          throw slackError("file_not_found");
        const mimeType = response.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim();
        if (!response.ok || !response.body || !mimeType?.startsWith("image/"))
          throw slackError("invalid_avatar_response");
        return { body: response.body, mimeType };
      }
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
