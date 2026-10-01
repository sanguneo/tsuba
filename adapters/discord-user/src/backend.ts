import {
  AdapterError,
  type MediaFile,
  type Message,
  type Reaction,
  type Room,
  type StreamUpdate,
} from "@tsuba/serve-kit";
import {
  mapUserChannel,
  mapUserMessage,
  type RawDiscordChannel,
  type RawDiscordMessage,
} from "./mapping";

const DISCORD_API = "https://discord.com/api/v9";
const DISCORD_GATEWAY = "wss://gateway.discord.gg/?v=9&encoding=json";

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

function getSuperProperties(): string {
  return Buffer.from(JSON.stringify(FINGERPRINT)).toString("base64");
}

export function getDiscordHeaders(userToken: string): Record<string, string> {
  return {
    Authorization: userToken,
    "User-Agent": FINGERPRINT.browser_user_agent,
    "X-Super-Properties": getSuperProperties(),
    Accept: "*/*",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    Origin: "https://discord.com",
    Referer: "https://discord.com/channels/@me",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
}

export function discordUserBackend(
  userToken: string,
  fetchFn: typeof fetch = fetch,
) {
  let currentUser: {
    id: string;
    username: string;
    global_name?: string | null;
  } | null = null;
  const guildNames = new Map<string, string>();
  const streamListeners = new Set<(update: StreamUpdate) => void>();
  let gatewayWs: WebSocket | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let lastSeq: number | null = null;
  let isClosed = false;

  async function request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const headers = {
      ...getDiscordHeaders(userToken),
      ...(options.headers as Record<string, string>),
    };
    const res = await fetchFn(`${DISCORD_API}${path}`, {
      ...options,
      headers,
    });

    if (res.status === 401) {
      throw new AdapterError(
        "REAUTH_REQUIRED",
        "Discord user token expired or invalid",
      );
    }
    if (res.status === 403) {
      throw new AdapterError("FORBIDDEN", "Forbidden by Discord");
    }
    if (res.status === 404) {
      throw new AdapterError("NOT_FOUND", "Resource not found on Discord");
    }
    if (res.status === 429) {
      throw new AdapterError("RATE_LIMITED", "Discord rate limited");
    }
    if (!res.ok) {
      throw new AdapterError("INTERNAL", `Discord HTTP error ${res.status}`);
    }

    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  async function getCurrentUser() {
    if (!currentUser) {
      currentUser = await request<{
        id: string;
        username: string;
        global_name?: string | null;
      }>("/users/@me");
    }
    return currentUser;
  }

  function startGateway() {
    if (isClosed || gatewayWs) return;

    try {
      const ws = new WebSocket(DISCORD_GATEWAY);
      gatewayWs = ws;

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data.toString());
          const { op, d, s, t } = payload;
          if (s != null) lastSeq = s;

          if (op === 10) {
            const interval = d.heartbeat_interval;
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            heartbeatInterval = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ op: 1, d: lastSeq }));
              }
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
                  client_state: {
                    guild_versions: {},
                    highest_last_message_id: "0",
                    read_state_version: 0,
                    user_guild_settings_version: -1,
                    user_settings_version: -1,
                  },
                },
              }),
            );
          } else if (op === 0) {
            handleGatewayDispatch(t, d);
          }
        } catch {}
      };

      ws.onclose = () => {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = null;
        gatewayWs = null;
        if (!isClosed) {
          setTimeout(startGateway, 3000);
        }
      };
    } catch {
      if (!isClosed) {
        setTimeout(startGateway, 5000);
      }
    }
  }

  function handleGatewayDispatch(event: string, data: Record<string, unknown>) {
    if (event === "READY") {
      const readyUser = data.user as
        | { id: string; username: string; global_name?: string | null }
        | undefined;
      if (readyUser) currentUser = readyUser;
      if (Array.isArray(data.guilds)) {
        for (const g of data.guilds) {
          if (g && typeof g === "object" && "id" in g && "name" in g) {
            guildNames.set(String(g.id), String(g.name));
          }
        }
      }
    } else if (event === "MESSAGE_CREATE") {
      if (currentUser) {
        const msg = mapUserMessage(
          data as unknown as RawDiscordMessage,
          currentUser.id,
        );
        for (const listener of streamListeners) {
          listener({ event: "message", message: msg });
        }
      }
    } else if (event === "MESSAGE_UPDATE") {
      if (currentUser && data.id && data.channel_id && data.author) {
        const msg = mapUserMessage(
          data as unknown as RawDiscordMessage,
          currentUser.id,
        );
        for (const listener of streamListeners) {
          listener({ event: "message.edited", message: msg });
        }
      }
    } else if (event === "MESSAGE_DELETE") {
      if (data.id && data.channel_id) {
        for (const listener of streamListeners) {
          listener({
            event: "message.deleted",
            roomId: String(data.channel_id),
            messageIds: [String(data.id)],
          });
        }
      }
    }
  }

  startGateway();

  return {
    async listRooms(): Promise<{ rooms: Room[]; complete: boolean }> {
      await getCurrentUser();
      const dmChannels = await request<RawDiscordChannel[]>(
        "/users/@me/channels",
      );

      const rooms: Room[] = [];
      for (const dm of dmChannels) {
        const mapped = mapUserChannel(dm, undefined, 0);
        if (mapped) rooms.push(mapped);
      }

      const guilds =
        await request<Array<{ id: string; name: string }>>("/users/@me/guilds");
      for (const guild of guilds) {
        guildNames.set(guild.id, guild.name);
        try {
          const channels = await request<RawDiscordChannel[]>(
            `/guilds/${guild.id}/channels`,
          );
          for (const ch of channels) {
            const mapped = mapUserChannel(ch, guild.name, 0);
            if (mapped) rooms.push(mapped);
          }
        } catch {}
      }

      rooms.sort((left, right) => {
        const a = left.lastActivityAt ? Date.parse(left.lastActivityAt) : 0;
        const b = right.lastActivityAt ? Date.parse(right.lastActivityAt) : 0;
        return b - a || left.title.localeCompare(right.title, "ko-KR");
      });

      return { rooms: rooms.slice(0, 500), complete: rooms.length <= 500 };
    },

    async readMessages(query: {
      roomId: string;
      limit?: number;
      before?: string;
    }): Promise<{ messages: Message[]; hasEarlier: boolean }> {
      const user = await getCurrentUser();
      const limit = Math.min(query.limit ?? 50, 100);
      const params = new URLSearchParams({ limit: String(limit) });
      if (query.before) params.set("before", query.before);

      const rawMessages = await request<RawDiscordMessage[]>(
        `/channels/${query.roomId}/messages?${params}`,
      );
      const messages: Message[] = rawMessages
        .reverse()
        .map((m) => mapUserMessage(m, user.id));

      return {
        messages,
        hasEarlier: rawMessages.length === limit,
      };
    },

    async messagesAfter(roomId: string, afterId: string): Promise<Message[]> {
      const user = await getCurrentUser();
      const rawMessages = await request<RawDiscordMessage[]>(
        `/channels/${roomId}/messages?after=${afterId}&limit=100`,
      );
      return rawMessages
        .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? 1 : -1))
        .map((m) => mapUserMessage(m, user.id));
    },

    subscribe(listener: (update: StreamUpdate) => void): () => void {
      streamListeners.add(listener);
      return () => {
        streamListeners.delete(listener);
      };
    },

    async send(
      roomId: string,
      text: string,
      options?: { replyTo?: string },
    ): Promise<Message> {
      const user = await getCurrentUser();
      const body: Record<string, unknown> = { content: text };
      if (options?.replyTo) {
        body.message_reference = { message_id: options.replyTo };
      }

      const sent = await request<RawDiscordMessage>(
        `/channels/${roomId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );

      return mapUserMessage(sent, user.id);
    },

    async edit(
      roomId: string,
      messageId: string,
      text: string,
    ): Promise<Message> {
      const user = await getCurrentUser();
      const edited = await request<RawDiscordMessage>(
        `/channels/${roomId}/messages/${messageId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: text }),
        },
      );
      return mapUserMessage(edited, user.id);
    },

    async deleteMessage(roomId: string, messageId: string): Promise<void> {
      await request<void>(`/channels/${roomId}/messages/${messageId}`, {
        method: "DELETE",
      });
    },

    async react(
      roomId: string,
      messageId: string,
      emojis: string[],
    ): Promise<Reaction[]> {
      const user = await getCurrentUser();
      if (emojis[0]) {
        const emoji = encodeURIComponent(emojis[0]);
        await request<void>(
          `/channels/${roomId}/messages/${messageId}/reactions/${emoji}/@me`,
          {
            method: "PUT",
          },
        );
      }
      const raw = await request<RawDiscordMessage>(
        `/channels/${roomId}/messages/${messageId}`,
      );
      const mapped = mapUserMessage(raw, user.id);
      return mapped.reactions ?? [];
    },

    async markRead(roomId: string, messageId: string): Promise<void> {
      await request<void>(`/channels/${roomId}/messages/${messageId}/ack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: null }),
      }).catch(() => {});
    },

    async media(id: string, signal: AbortSignal): Promise<MediaFile> {
      const parts = id.split(":");
      const channelId = parts[0];
      const messageId = parts[1];
      const attachmentId = parts[2];
      if (!channelId || !messageId || !attachmentId) {
        throw new AdapterError("NOT_FOUND", "Malformed media id");
      }

      const msg = await request<RawDiscordMessage>(
        `/channels/${channelId}/messages/${messageId}`,
      );
      const att = msg.attachments?.find((a) => a.id === attachmentId);
      if (!att) {
        throw new AdapterError("NOT_FOUND", "Attachment not found");
      }

      const res = await fetchFn(att.url, { signal });
      if (!res.ok || !res.body) {
        throw new AdapterError(
          "NOT_FOUND",
          "Failed to fetch attachment from CDN",
        );
      }

      return {
        body: res.body as ReadableStream<Uint8Array>,
        ...(att.content_type ? { mimeType: att.content_type } : {}),
        name: att.filename,
      };
    },

    stop() {
      isClosed = true;
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (gatewayWs) {
        try {
          gatewayWs.close();
        } catch {}
      }
    },
  };
}
