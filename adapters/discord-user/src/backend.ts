import {
  type AdapterBackend,
  AdapterError,
  type Room,
  type StreamUpdate,
} from "@tsuba/serve-kit";
import {
  type DiscordMessageLike,
  mapDiscordMessage,
  reactionPlan,
} from "../../discord/src/mapping";
import { mapUserChannel, type UserChannelLike } from "./mapping";

const DISCORD_API = "https://discord.com/api/v9";
const DISCORD_GATEWAY = "wss://gateway.discord.gg/?v=9&encoding=json";
const SNOWFLAKE = /^[0-9]{17,20}$/;
const CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const ROOM_LIMIT = 500;
const GUILD_CONCURRENCY = 4;

const FINGERPRINT = {
  os: "Windows",
  browser: "Chrome",
  device: "",
  system_locale: "ko-KR",
  browser_user_agent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  browser_version: "133.0.0.0",
  os_version: "10.0.26200",
  referrer: "",
  referring_domain: "",
  referrer_current: "",
  referring_domain_current: "",
  release_channel: "stable",
  client_build_number: 375492,
  client_event_source: null,
};

export function getDiscordHeaders(userToken: string): Record<string, string> {
  return {
    Authorization: userToken,
    "User-Agent": FINGERPRINT.browser_user_agent,
    "X-Super-Properties": Buffer.from(JSON.stringify(FINGERPRINT)).toString(
      "base64",
    ),
    Accept: "*/*",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    Origin: "https://discord.com",
    Referer: "https://discord.com/channels/@me",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
}

function apiError(error: unknown): AdapterError {
  if (error instanceof AdapterError) return error;
  const status =
    error && typeof error === "object" && "status" in error
      ? error.status
      : undefined;
  switch (status) {
    case 400:
      return new AdapterError(
        "INVALID_REQUEST",
        "Discord refused the request; check the message and its ids",
      );
    case 401:
      return new AdapterError(
        "REAUTH_REQUIRED",
        "Discord no longer accepts this user token; replace it where the adapter runs",
      );
    case 403:
      return new AdapterError(
        "FORBIDDEN",
        "Discord does not let this account do that here; check channel permissions",
      );
    case 404:
      return new AdapterError(
        "NOT_FOUND",
        "No such Discord channel, message or attachment",
      );
    case 429:
      return new AdapterError(
        "RATE_LIMITED",
        "Discord asked the adapter to slow down; try again later",
      );
    default:
      return new AdapterError(
        "INTERNAL",
        "The Discord adapter failed; a write's outcome is unknown",
      );
  }
}
async function discord<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw apiError(error);
  }
}
function malformed(): never {
  throw new AdapterError("INTERNAL", "Discord returned a malformed response");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return malformed();
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  return typeof value === "string" ? value : malformed();
}
function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : malformed();
}
function boolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : malformed();
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : malformed();
}
function id(value: unknown): string {
  const result = string(value);
  return SNOWFLAKE.test(result) ? result : malformed();
}
function nullableString(value: unknown): string | null {
  return value == null ? null : string(value);
}
function date(value: unknown): Date {
  const result = new Date(string(value));
  return Number.isNaN(result.getTime()) ? malformed() : result;
}
function pathRoom(value: string): string {
  if (!SNOWFLAKE.test(value))
    throw new AdapterError("NOT_FOUND", "No such Discord channel");
  return value;
}
function pathMessage(value: string): string {
  if (!SNOWFLAKE.test(value))
    throw new AdapterError("INVALID_REQUEST", "Invalid Discord message id");
  return value;
}
function parseUser(value: unknown) {
  const user = record(value);
  return {
    id: id(user.id),
    username: string(user.username),
    globalName: nullableString(user.global_name),
  };
}
function parseChannel(value: unknown, guildName?: string): UserChannelLike {
  const channel = record(value);
  return {
    id: id(channel.id),
    type: number(channel.type),
    name: nullableString(channel.name),
    guildName: guildName ?? null,
    lastMessageId:
      channel.last_message_id == null ? null : id(channel.last_message_id),
    recipients:
      channel.recipients == null
        ? []
        : array(channel.recipients).map(parseUser),
  };
}
function parseMessage(value: unknown, userId: string): DiscordMessageLike {
  const message = record(value);
  const author = parseUser(message.author);
  const reference =
    message.message_reference == null
      ? undefined
      : record(message.message_reference);
  const member = message.member == null ? undefined : record(message.member);
  return {
    id: id(message.id),
    channelId: id(message.channel_id),
    authorId: author.id,
    authorName:
      nullableString(member?.nick) ?? author.globalName ?? author.username,
    fromMe: author.id === userId,
    content: string(message.content),
    createdAt: date(message.timestamp),
    editedAt:
      message.edited_timestamp == null ? null : date(message.edited_timestamp),
    referenceId:
      reference?.message_id == null ? null : id(reference.message_id),
    type: number(message.type),
    stickers:
      message.sticker_items == null ? 0 : array(message.sticker_items).length,
    attachments: array(message.attachments).map((value) => {
      const attachment = record(value);
      const optionalNumber = (value: unknown) =>
        value == null ? null : number(value);
      return {
        id: id(attachment.id),
        url: string(attachment.url),
        name: string(attachment.filename),
        size: number(attachment.size),
        contentType: nullableString(attachment.content_type),
        width: optionalNumber(attachment.width),
        height: optionalNumber(attachment.height),
        durationSeconds: optionalNumber(attachment.duration_secs),
      };
    }),
    reactions:
      message.reactions == null
        ? []
        : array(message.reactions).map((value) => {
            const reaction = record(value);
            const emoji = record(reaction.emoji);
            return {
              emojiId: emoji.id == null ? null : id(emoji.id),
              emojiName: nullableString(emoji.name),
              count: number(reaction.count),
              me: boolean(reaction.me),
            };
          }),
  };
}
function compareIds(left: { id: string }, right: { id: string }): number {
  const a = BigInt(left.id),
    b = BigInt(right.id);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * User-visible text channels, DMs and group DMs are rooms. We do not derive
 * unread counts from snowflakes: without a synchronized Discord read-state
 * snapshot they would be guesses, so unread is 0. Explicit read marks use
 * Discord's acknowledgement endpoint and propagate its refusals.
 * REST construction/checks never open a Gateway; only active subscriptions do.
 */
export function discordUserBackend(
  userToken: string,
  fetchFn: typeof fetch = fetch,
): AdapterBackend {
  let currentUser: ReturnType<typeof parseUser> | undefined;
  let userRequest: Promise<ReturnType<typeof parseUser>> | undefined;
  const listeners = new Set<(update: StreamUpdate) => void>();
  let socket: WebSocket | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let sequence: number | null = null;

  async function request(
    path: string,
    options: RequestInit = {},
  ): Promise<unknown> {
    return discord(async () => {
      const headers = new Headers(getDiscordHeaders(userToken));
      new Headers(options.headers).forEach((value, name) => {
        headers.set(name, value);
      });
      const response = await fetchFn(`${DISCORD_API}${path}`, {
        ...options,
        headers,
      });
      if (!response.ok) throw apiError({ status: response.status });
      if (response.status === 204) return undefined;
      return await response.json();
    });
  }
  async function getUser() {
    if (currentUser) return currentUser;
    if (!userRequest) userRequest = request("/users/@me").then(parseUser);
    try {
      currentUser = await userRequest;
      return currentUser;
    } finally {
      userRequest = undefined;
    }
  }
  async function message(roomId: string, messageId: string) {
    const user = await getUser();
    return parseMessage(
      await request(`/channels/${roomId}/messages/${messageId}`),
      user.id,
    );
  }
  async function page(roomId: string, params: URLSearchParams) {
    const user = await getUser();
    return array(await request(`/channels/${roomId}/messages?${params}`)).map(
      (value) => parseMessage(value, user.id),
    );
  }
  function emit(update: StreamUpdate) {
    for (const listener of listeners) listener(update);
  }
  function stopGateway() {
    if (heartbeat) clearInterval(heartbeat);
    if (reconnect) clearTimeout(reconnect);
    heartbeat = undefined;
    reconnect = undefined;
    const held = socket;
    socket = undefined;
    if (held) {
      held.onclose = null;
      held.onmessage = null;
      held.close();
    }
  }
  async function dispatch(event: string, value: unknown) {
    const data = record(value);
    if (event === "READY") {
      currentUser = parseUser(data.user);
      return;
    }
    if (event === "MESSAGE_CREATE" || event === "MESSAGE_UPDATE") {
      const user = await getUser();
      // Gateway updates may be partial: fetch the full current message instead.
      const normalized =
        event === "MESSAGE_UPDATE"
          ? await message(id(data.channel_id), id(data.id))
          : parseMessage(data, user.id);
      emit({
        event: event === "MESSAGE_CREATE" ? "message" : "message.edited",
        message: mapDiscordMessage(normalized),
      });
    } else if (event === "MESSAGE_DELETE") {
      emit({
        event: "message.deleted",
        roomId: id(data.channel_id),
        messageIds: [id(data.id)],
      });
    }
  }
  function startGateway() {
    if (!listeners.size || socket) return;
    const ws = new WebSocket(DISCORD_GATEWAY);
    socket = ws;
    let pending = Promise.resolve();
    ws.onmessage = (event) => {
      try {
        const payload = record(JSON.parse(String(event.data)));
        const op = number(payload.op);
        if (payload.s != null) sequence = number(payload.s);
        if (op === 10) {
          const interval = number(record(payload.d).heartbeat_interval);
          if (interval <= 0) malformed();
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ op: 1, d: sequence }));
          }, interval);
          ws.send(
            JSON.stringify({
              op: 2,
              d: {
                token: userToken,
                capabilities: 30717,
                properties: FINGERPRINT,
                presence: {
                  status: "online",
                  since: 0,
                  activities: [],
                  afk: false,
                },
                compress: false,
              },
            }),
          );
        } else if (op === 0) {
          const type = string(payload.t);
          // Serialize dispatches, obtaining identity even if CREATE precedes READY.
          pending = pending
            .then(() => dispatch(type, payload.d))
            .catch(() => {
              // A failed fetch or malformed dispatch cannot be represented as an
              // event. Reconnect rather than continuing with inconsistent state.
              if (socket === ws) ws.close();
            });
        }
      } catch {
        // Invalid Gateway envelopes cannot safely drive state or heartbeats.
        ws.close();
      }
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      socket = undefined;
      if (listeners.size)
        reconnect = setTimeout(() => {
          reconnect = undefined;
          startGateway();
        }, 3000);
    };
  }

  return {
    async listRooms() {
      const user = await getUser();
      const channels = array(await request("/users/@me/channels")).map(
        (value) => parseChannel(value),
      );
      const guilds = array(await request("/users/@me/guilds")).map((value) => {
        const guild = record(value);
        return { id: id(guild.id), name: string(guild.name) };
      });
      let complete = true;
      let next = 0;
      await Promise.all(
        Array.from(
          { length: Math.min(GUILD_CONCURRENCY, guilds.length) },
          async () => {
            for (;;) {
              const guild = guilds[next++];
              if (!guild) return;
              try {
                channels.push(
                  ...array(await request(`/guilds/${guild.id}/channels`)).map(
                    (value) => parseChannel(value, guild.name),
                  ),
                );
              } catch {
                // One unavailable guild must not hide the rooms that did load.
                complete = false;
              }
            }
          },
        ),
      );
      const rooms: Room[] = [];
      next = 0;
      await Promise.all(
        Array.from(
          { length: Math.min(GUILD_CONCURRENCY, channels.length) },
          async () => {
            for (;;) {
              const channel = channels[next++];
              if (!channel) return;
              if (!mapUserChannel(channel)) continue;
              if (channel.lastMessageId) {
                try {
                  const latest = await page(
                    channel.id,
                    new URLSearchParams({ limit: "1" }),
                  );
                  const last = latest[0];
                  if (last)
                    channel.lastMessage = {
                      content: last.content,
                      fromMe: last.authorId === user.id,
                    };
                } catch {
                  // Room identity remains useful when its preview is unavailable.
                  complete = false;
                }
              }
              const mapped = mapUserChannel(channel);
              if (mapped) rooms.push(mapped);
            }
          },
        ),
      );
      rooms.sort(
        (left, right) =>
          (right.lastActivityAt ? Date.parse(right.lastActivityAt) : 0) -
            (left.lastActivityAt ? Date.parse(left.lastActivityAt) : 0) ||
          left.title.localeCompare(right.title, "en"),
      );
      return {
        rooms: rooms.slice(0, ROOM_LIMIT),
        complete: complete && rooms.length <= ROOM_LIMIT,
      };
    },
    async readMessages({ roomId, limit, before }) {
      pathRoom(roomId);
      if (before !== undefined) pathMessage(before);
      const size = Math.min(limit, 100);
      const params = new URLSearchParams({ limit: String(size) });
      if (before !== undefined) params.set("before", before);
      const fetched = (await page(roomId, params)).sort(compareIds);
      const oldest = fetched[0];
      const hasEarlier =
        fetched.length === size && oldest
          ? (
              await page(
                roomId,
                new URLSearchParams({ before: oldest.id, limit: "1" }),
              )
            ).length > 0
          : false;
      return { messages: fetched.map(mapDiscordMessage), hasEarlier };
    },
    async messagesAfter(roomId, afterId) {
      pathRoom(roomId);
      pathMessage(afterId);
      await message(roomId, afterId);
      const result: DiscordMessageLike[] = [];
      let after = afterId;
      for (;;) {
        const fetched = (
          await page(roomId, new URLSearchParams({ after, limit: "100" }))
        ).sort(compareIds);
        result.push(...fetched);
        const last = fetched.at(-1);
        if (!last || fetched.length < 100) return result.map(mapDiscordMessage);
        if (BigInt(last.id) <= BigInt(after)) malformed();
        after = last.id;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      try {
        startGateway();
      } catch (error) {
        listeners.delete(listener);
        throw apiError(error);
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) stopGateway();
      };
    },
    async send(roomId, text, { replyTo }) {
      pathRoom(roomId);
      if (replyTo !== undefined) pathMessage(replyTo);
      const user = await getUser();
      const sent = await request(`/channels/${roomId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: text,
          allowed_mentions: { parse: ["users"], replied_user: true },
          ...(replyTo === undefined
            ? {}
            : {
                message_reference: {
                  message_id: replyTo,
                  fail_if_not_exists: true,
                },
              }),
        }),
      });
      return mapDiscordMessage(parseMessage(sent, user.id));
    },
    async edit(roomId, messageId, text) {
      pathRoom(roomId);
      pathMessage(messageId);
      const user = await getUser();
      const edited = await request(
        `/channels/${roomId}/messages/${messageId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: text,
            allowed_mentions: { parse: ["users"], replied_user: true },
          }),
        },
      );
      return mapDiscordMessage(parseMessage(edited, user.id));
    },
    async deleteMessage(roomId, messageId) {
      pathRoom(roomId);
      pathMessage(messageId);
      await request(`/channels/${roomId}/messages/${messageId}`, {
        method: "DELETE",
      });
    },
    async react(roomId, messageId, emojis) {
      pathRoom(roomId);
      pathMessage(messageId);
      const held = await message(roomId, messageId);
      const mine = held.reactions
        .filter((reaction) => reaction.me && !reaction.emojiId)
        .flatMap((reaction) =>
          reaction.emojiName ? [reaction.emojiName] : [],
        );
      const plan = reactionPlan(mine, emojis);
      const retained = held.reactions.filter(
        (reaction) =>
          !(
            reaction.me &&
            reaction.count <= 1 &&
            !reaction.emojiId &&
            reaction.emojiName &&
            plan.remove.includes(reaction.emojiName)
          ),
      );
      const newDistinct = plan.add.filter(
        (emoji) =>
          !retained.some(
            (reaction) => !reaction.emojiId && reaction.emojiName === emoji,
          ),
      );
      if (retained.length + newDistinct.length > 20)
        throw new AdapterError(
          "FORBIDDEN",
          "Discord already has the maximum number of reaction kinds on this message",
        );
      let changed = false;
      try {
        for (const emoji of plan.remove) {
          await request(
            `/channels/${roomId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
            { method: "DELETE" },
          );
          changed = true;
        }
        for (const emoji of plan.add) {
          await request(
            `/channels/${roomId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
            { method: "PUT" },
          );
          changed = true;
        }
        return (
          mapDiscordMessage(await message(roomId, messageId)).reactions ?? []
        );
      } catch (error) {
        if (changed)
          throw new AdapterError(
            "INTERNAL",
            "Discord's reaction update stopped after a partial change; its outcome is unknown",
          );
        throw apiError(error);
      }
    },
    async markRead(roomId, messageId) {
      pathRoom(roomId);
      pathMessage(messageId);
      await request(`/channels/${roomId}/messages/${messageId}/ack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: null }),
      });
    },
    async media(mediaId, signal) {
      const match = /^([0-9]{17,20}):([0-9]{17,20}):([0-9]{17,20})$/.exec(
        mediaId,
      );
      const roomId = match?.[1],
        messageId = match?.[2],
        attachmentId = match?.[3];
      if (!roomId || !messageId || !attachmentId)
        throw new AdapterError("NOT_FOUND", "No such Discord attachment");
      const held = await message(roomId, messageId);
      const attachment = held.attachments.find(
        (value) => value.id === attachmentId,
      );
      if (!attachment)
        throw new AdapterError("NOT_FOUND", "No such Discord attachment");
      let url: URL;
      try {
        url = new URL(attachment.url);
      } catch {
        throw new AdapterError("NOT_FOUND", "No such Discord attachment");
      }
      if (url.protocol !== "https:" || !CDN_HOSTS.has(url.hostname))
        throw new AdapterError("NOT_FOUND", "No such Discord attachment");
      const response = await discord(() =>
        fetchFn(url, { signal, redirect: "error" }),
      );
      if (!response.ok) throw apiError({ status: response.status });
      if (!response.body)
        throw new AdapterError("NOT_FOUND", "The Discord attachment is gone");
      return {
        body: response.body,
        name: attachment.name,
        ...(attachment.contentType ? { mimeType: attachment.contentType } : {}),
      };
    },
  };
}
