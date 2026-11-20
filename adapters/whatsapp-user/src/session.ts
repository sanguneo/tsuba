import type {
  WaLinkEvent,
  WaMessageLike,
  WaSocket,
  WaSocketEvent,
  WaState,
} from "./types";

const LOGGED_OUT = 401;
const FORBIDDEN = 403;
const CONNECTION_REPLACED = 440;
const RESTART_REQUIRED = 515;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

/** Exponential backoff with a ceiling: 1s, 2s, 4s ... 60s, then 60s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
}

export interface WaLink {
  canSendDirectBotText: WaSocket["canSendDirectBotText"];
  sendDirectBotText: WaSocket["sendDirectBotText"];
  profilePictureUrl(jid: string): Promise<string | undefined>;
  downloadMedia: WaSocket["downloadMedia"];
  sendMedia: WaSocket["sendMedia"];
  state(): WaState;
  subscribe(listener: (event: WaLinkEvent) => void): () => void;
  send(
    jid: string,
    text: string,
    quoted?: WaMessageLike,
  ): Promise<WaMessageLike | undefined>;
  stop(): Promise<void>;
}

export interface SessionOptions {
  open(): WaSocket;
  schedule(run: () => void, delayMs: number): () => void;
}

/**
 * Keeps one WhatsApp connection alive. A dropped connection is reopened with
 * backoff. A logout, a taken-over session or a refusal is final: reconnecting
 * would not fix it, and retrying a refused account is how accounts get banned,
 * so the state is reported and the owner decides.
 */
export function connectWhatsApp({ open, schedule }: SessionOptions): WaLink {
  const listeners = new Set<(event: WaLinkEvent) => void>();
  let socket: WaSocket | undefined;
  let state: WaState = "connecting";
  let attempt = 0;
  let cancel: (() => void) | undefined;
  let stopped = false;
  let draining: Promise<void> | undefined;
  let drainFailed = false;

  function emit(event: WaLinkEvent) {
    for (const listener of listeners) listener(event);
  }
  function setState(next: WaState) {
    if (state === next) return;
    state = next;
    emit({ type: "state", state });
  }
  function retire(held: WaSocket) {
    socket = undefined;
    draining = held.close().catch(() => {
      drainFailed = true;
    });
  }
  function finish(next: WaState, held: WaSocket) {
    retire(held);
    setState(next);
  }
  function retry(delay: number, next: WaState) {
    setState(next);
    socket = undefined;
    cancel = schedule(() => {
      if (draining) {
        void draining.then(connect);
      } else connect();
    }, delay);
  }
  function handle(held: WaSocket, event: WaSocketEvent) {
    if (stopped || held !== socket) return;
    switch (event.type) {
      case "open":
        attempt = 0;
        setState("open");
        return;
      case "qr":
        finish("logged-out", held);
        return;
      case "close":
        if (event.statusCode === LOGGED_OUT) finish("logged-out", held);
        else if (event.statusCode === FORBIDDEN) finish("forbidden", held);
        else if (event.statusCode === CONNECTION_REPLACED)
          finish("conflict", held);
        else {
          retire(held);
          if (event.statusCode === RESTART_REQUIRED) retry(0, "connecting");
          else retry(reconnectDelay(attempt++), "reconnecting");
        }
        return;
      default:
        emit(event);
    }
  }
  function connect() {
    cancel = undefined;
    if (stopped) return;
    draining = undefined;
    try {
      const held = open();
      socket = held;
      held.onEvent((event) => handle(held, event));
    } catch {
      retry(reconnectDelay(attempt++), "reconnecting");
    }
  }

  connect();

  return {
    state: () => state,
    async canSendDirectBotText(jid) {
      return state === "open" && socket
        ? socket.canSendDirectBotText(jid)
        : false;
    },
    async sendDirectBotText(jid, text) {
      if (state !== "open" || !socket)
        throw new AdapterError(
          "BUSY",
          "WhatsApp is not connected yet; nothing was sent",
        );
      return socket.sendDirectBotText(jid, text);
    },
    async profilePictureUrl(jid) {
      if (state !== "open" || !socket) return undefined;
      return socket.profilePictureUrl(jid);
    },
    async downloadMedia(message, signal) {
      if (state !== "open" || !socket)
        throw new AdapterError("BUSY", "WhatsApp is not connected yet");
      return socket.downloadMedia(message, signal);
    },
    async sendMedia(jid, file, caption, quoted) {
      if (state !== "open" || !socket)
        throw new AdapterError(
          "BUSY",
          "WhatsApp is not connected yet; nothing was sent",
        );
      return socket.sendMedia(jid, file, caption, quoted);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(jid, text, quoted) {
      if (!socket) throw new Error("not connected");
      return socket.sendText(jid, text, quoted);
    },
    async stop() {
      stopped = true;
      cancel?.();
      const held = socket;
      if (held) retire(held);
      await draining;
      if (drainFailed) throw new Error("WhatsApp auth state save failed");
    },
  };
}

import { AdapterError } from "@tsuba/serve-kit";
