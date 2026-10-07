import { createHash } from "node:crypto";
import {
  type AdapterBackend,
  AdapterError,
  type Message,
  type Reaction,
  type Room,
  type StreamUpdate,
  type UploadFile,
  type UploadOptions,
} from "@tsuba/serve-kit";
import { REACTION_NOOPS, type SlackCall, slackError } from "./api";
import type { EmojiTable } from "./emoji";
import {
  blockImageUrl,
  blockLines,
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
import { fetchPublicImage, type Resolve, resolveHost } from "./publicImage";

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
// Where secure.gravatar.com redirects a person without a picture (Photon).
const GRAVATAR_HOPS = new Set(["i0.wp.com", "i1.wp.com", "i2.wp.com"]);
const AVATAR_ID = /^avatar:([UWB][A-Z0-9]{6,128}):([a-f0-9]{24})$/;
const BLOCK_IMAGE_ID = /^([CDG][A-Z0-9]{6,}):(\d+\.\d{1,6}):image(\d{1,3})$/;
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
/**
 * Slack shares an uploaded file after files.completeUploadExternal answers;
 * files.info is asked this often, this many times, for where it was shared.
 */
const SHARE_POLL_MS = 500;
const SHARE_LOOKS = 20;

interface SlackUser {
  id: string;
  name?: string;
  deleted?: boolean;
  profile?: { display_name?: string; real_name?: string; image_72?: string };
  real_name?: string;
}

interface SlackBot {
  id: string;
  name?: string;
  deleted?: boolean;
  icons?: { image_72?: string; image_48?: string };
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
  options: {
    fillIntervalMs?: number;
    rateLimitPauseMs?: number;
    /** Whether the token may upload (files:write); only then is `upload` given. */
    uploads?: boolean;
    sharePollMs?: number;
    /** How a block image's host is resolved before it is fetched; tests answer it. */
    resolve?: Resolve;
  } = {},
): AdapterBackend & { stop(): void } {
  const users = new Map<
    string,
    { expires: number; value: Promise<SlackUser> }
  >();
  const bots = new Map<string, { expires: number; value: Promise<SlackBot> }>();
  const groupTitles = new Map<string, Promise<string>>();
  const resolve = options.resolve ?? resolveHost;
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

  function bot(id: string, refresh = false): Promise<SlackBot> {
    const held = bots.get(id);
    if (!refresh && held && held.expires > Date.now()) return held.value;
    const value = call<{ bot?: SlackBot }>("bots.info", { bot: id }).then(
      (answer) => {
        if (!answer.bot || answer.bot.id !== id)
          throw new AdapterError("INTERNAL", "Slack answered an invalid bot");
        return answer.bot;
      },
    );
    bots.set(id, { expires: Date.now() + USER_CACHE_MS, value });
    return value.catch((error: unknown) => {
      if (bots.get(id)?.value === value) bots.delete(id);
      throw error;
    });
  }

  /** An app's name and picture; like a person's, never a reason to hide the message. */
  async function displayBot(id: string): Promise<SlackBot | undefined> {
    try {
      return await bot(id);
    } catch (error) {
      if (error instanceof AdapterError) return undefined;
      throw error;
    }
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
    // A bot often keeps its body in blocks; their words join the plain text.
    const text = [
      message.text ?? "",
      ...blockLines(message.blocks ?? [], message.text ?? ""),
    ]
      .filter(Boolean)
      .join("\n");
    const known = await names([
      ...mentionedUsers(text),
      ...(message.user ? [message.user] : []),
    ]);
    // An app's message that names its bot user shows that user's picture, as
    // Slack does; one with only a bot_id shows the app's own name and icon.
    const app =
      !message.user && message.bot_id
        ? await displayBot(message.bot_id)
        : undefined;
    const address = message.user
      ? (await displayUser(message.user))?.profile?.image_72
      : app?.icons?.image_72;
    const owner = message.user ?? (app ? message.bot_id : undefined);
    const senderAvatar =
      typeof address === "string" && avatarUrl(address) && owner
        ? `avatar:${owner}:${avatarHash(address)}`
        : undefined;
    return mapSlackMessage(roomId, message, {
      selfId: identity.userId,
      ...(senderAvatar ? { senderAvatar } : {}),
      sender: message.user
        ? (known.get(message.user) ?? message.user)
        : (message.username ?? app?.name ?? "bot"),
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

  /** A group DM by the people's display names, not the handles in its Slack name. */
  function groupTitle(conversation: Conversation): Promise<string> {
    const fallback = groupDmTitle(
      conversation.name ?? conversation.id,
      identity.handle,
    );
    const held = groupTitles.get(conversation.id);
    if (held) return held;
    const value = call<{ members?: string[] }>("conversations.members", {
      channel: conversation.id,
      limit: 20,
    })
      .then(async (answer) => {
        const others = (answer.members ?? []).filter(
          (id) => id !== identity.userId,
        );
        if (!others.length) return fallback;
        const known = await names(others);
        return others.map((id) => known.get(id) ?? id).join(", ");
      })
      .catch((error: unknown) => {
        groupTitles.delete(conversation.id);
        if (error instanceof AdapterError) return fallback;
        throw error;
      });
    groupTitles.set(conversation.id, value);
    return value;
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
      return { title: await groupTitle(conversation), canSend: true };
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

  async function replyAt(
    roomId: string,
    threadTs: string,
    ts: string,
  ): Promise<SlackMessageLike> {
    const answer = await call<HistoryAnswer>("conversations.replies", {
      channel: roomId,
      ts: threadTs,
      oldest: ts,
      inclusive: true,
      limit: 2,
    });
    const found = answer.messages?.find((message) => message.ts === ts);
    if (!found)
      throw new AdapterError("INTERNAL", "Slack did not show the shared file");
    return found;
  }

  /** The message a file was shared in; Slack posts it after the upload completes. */
  async function sharedMessage(
    roomId: string,
    fileId: string,
    threadTs: string | undefined,
  ): Promise<SlackMessageLike> {
    for (let look = 0; look < SHARE_LOOKS; look++) {
      const answer = await call<{
        file?: { shares?: Record<string, Record<string, { ts?: string }[]>> };
      }>("files.info", { file: fileId });
      const shares = answer.file?.shares ?? {};
      const ts = [
        ...(shares.public?.[roomId] ?? []),
        ...(shares.private?.[roomId] ?? []),
      ].find((share) => share.ts)?.ts;
      if (ts)
        return threadTs ? replyAt(roomId, threadTs, ts) : messageAt(roomId, ts);
      await Bun.sleep(options.sharePollMs ?? SHARE_POLL_MS);
    }
    throw new AdapterError(
      "INTERNAL",
      "Slack took the file but did not say where it was shared",
    );
  }

  async function upload(
    roomId: string,
    file: UploadFile,
    { caption, replyTo }: UploadOptions,
  ): Promise<Message> {
    const channel = conversationId(roomId);
    let threadTs: string | undefined;
    if (replyTo !== undefined) {
      const parent = await messageAt(channel, timestamp(replyTo));
      threadTs = parent.thread_ts ?? parent.ts;
    }
    const target = await call<{ upload_url?: string; file_id?: string }>(
      "files.getUploadURLExternal",
      { filename: file.name, length: file.bytes.byteLength },
    );
    // The address is Slack's own and pre-signed; it is used only on Slack's host.
    const address =
      target.upload_url && URL.canParse(target.upload_url)
        ? new URL(target.upload_url)
        : undefined;
    if (
      !target.file_id ||
      !address ||
      address.protocol !== "https:" ||
      !FILE_HOSTS.has(address.hostname)
    )
      throw new AdapterError("INTERNAL", "Slack gave no usable upload address");
    let taken: Response;
    try {
      taken = await fetcher(address, { method: "POST", body: file.bytes });
    } catch {
      throw new AdapterError("INTERNAL", "Slack could not be reached");
    }
    if (!taken.ok)
      throw new AdapterError("INTERNAL", "Slack did not take the file");
    await call("files.completeUploadExternal", {
      files: JSON.stringify([{ id: target.file_id, title: file.name }]),
      channel_id: channel,
      ...(caption === undefined
        ? {}
        : { initial_comment: toSlackText(caption) }),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    return toMessage(
      channel,
      await sharedMessage(channel, target.file_id, threadTs),
    );
  }

  return {
    ...(options.uploads ? { upload } : {}),
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
        const ownerId = match[1] as string;
        // Re-read so a stale opaque id never serves a replacement picture.
        const address = ownerId.startsWith("B")
          ? (await bot(ownerId, true)).icons?.image_72
          : (await user(ownerId, true)).profile?.image_72;
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
          const resolved =
            location && URL.canParse(location, target.href)
              ? new URL(location, target)
              : undefined;
          // Gravatar serves its default through Automattic's image CDN; that
          // host is followed only as Gravatar's own next hop, never as a start.
          const next =
            avatarUrl(resolved?.href) ??
            (target.hostname === "secure.gravatar.com" &&
            resolved?.protocol === "https:" &&
            GRAVATAR_HOPS.has(resolved.hostname) &&
            !resolved.username &&
            !resolved.password &&
            !resolved.port
              ? resolved
              : undefined);
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
      const image = BLOCK_IMAGE_ID.exec(id);
      if (image) {
        const [, roomId = "", ts = "", index = ""] = image;
        // Re-read the message so an id only ever reaches the picture it names.
        const block = (await messageAt(roomId, ts)).blocks?.[Number(index)];
        const url = blockImageUrl(block);
        if (!url) throw new AdapterError("NOT_FOUND", "No such Slack picture");
        // Someone else's address: no Slack token, public hosts only.
        const picture = await fetchPublicImage(url, fetcher, signal, resolve);
        return {
          ...picture,
          ...(block?.alt_text ? { name: block.alt_text } : {}),
        };
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
