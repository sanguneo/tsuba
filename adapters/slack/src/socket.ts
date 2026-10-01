/**
 * Slack's Socket Mode: the app-level token opens a WebSocket over which Slack
 * delivers Events API events, so the adapter needs no public address. Every
 * envelope is acknowledged at once (Slack redelivers after 3 seconds), and
 * Slack's `disconnect` notice, a drop or a failed open reconnects with backoff.
 */
export interface SocketEnvelope {
  envelope_id?: string;
  type?: string;
  payload?: { event?: Record<string, unknown> };
}

export interface SocketModeOptions {
  appToken: string;
  onEvent: (event: Record<string, unknown>) => void;
  fetcher?: typeof fetch;
  connect?: (url: string) => WebSocket;
  onState?: (state: "open" | "closed") => void;
}

/** What one received frame means: the ack to send, and the event inside, if any. */
export function readEnvelope(data: string): {
  ack?: string;
  event?: Record<string, unknown>;
  reconnect: boolean;
} {
  let envelope: SocketEnvelope;
  try {
    envelope = JSON.parse(data) as SocketEnvelope;
  } catch {
    return { reconnect: false };
  }
  return {
    ...(envelope.envelope_id ? { ack: envelope.envelope_id } : {}),
    ...(envelope.type === "events_api" && envelope.payload?.event
      ? { event: envelope.payload.event }
      : {}),
    reconnect: envelope.type === "disconnect",
  };
}

export function socketMode(options: SocketModeOptions): { stop(): void } {
  const fetcher = options.fetcher ?? fetch;
  const connect = options.connect ?? ((url: string) => new WebSocket(url));
  let stopped = false;
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  function later() {
    if (stopped) return;
    failures += 1;
    timer = setTimeout(
      open,
      Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)),
    );
  }

  async function open() {
    if (stopped) return;
    let url: string | undefined;
    try {
      const response = await fetcher(
        "https://slack.com/api/apps.connections.open",
        {
          method: "POST",
          headers: { authorization: `Bearer ${options.appToken}` },
        },
      );
      const answer = (await response.json()) as { ok?: boolean; url?: string };
      url = answer.ok ? answer.url : undefined;
    } catch {
      url = undefined;
    }
    if (!url || stopped) return later();
    const current = connect(url);
    socket = current;
    current.addEventListener("open", () => {
      failures = 0;
      options.onState?.("open");
    });
    current.addEventListener("message", (message) => {
      const frame = readEnvelope(String(message.data));
      if (frame.ack) current.send(JSON.stringify({ envelope_id: frame.ack }));
      if (frame.event) options.onEvent(frame.event);
      if (frame.reconnect) current.close();
    });
    current.addEventListener("close", () => {
      options.onState?.("closed");
      if (socket === current) later();
    });
  }

  void open();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    },
  };
}
