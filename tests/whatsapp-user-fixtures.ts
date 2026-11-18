import type { WaLink } from "../adapters/whatsapp-user/src/session";
import type {
  WaLinkEvent,
  WaMessageLike,
  WaSocket,
  WaSocketEvent,
  WaState,
} from "../adapters/whatsapp-user/src/types";

export const ROOM = "100000000001@s.whatsapp.net";
export const GROUP = "100000000002-1700000000@g.us";
export const SECONDS = 1_767_225_600;

export function text(
  id: string,
  body: string,
  extra: Partial<WaMessageLike> = {},
  room = ROOM,
): WaMessageLike {
  return {
    key: { remoteJid: room, id, fromMe: false },
    message: { conversation: body },
    messageTimestamp: SECONDS + Number(id.replace(/\D/g, "") || 0),
    pushName: "Synthetic",
    ...extra,
  };
}

export function fakeLink(initial: WaState = "open") {
  const listeners = new Set<(event: WaLinkEvent) => void>();
  let state = initial;
  const sends: { jid: string; text: string; quoted?: WaMessageLike }[] = [];
  const link: WaLink & {
    push(event: WaLinkEvent): void;
    setState(next: WaState): void;
    sends: typeof sends;
    sendImpl: (jid: string, text: string) => Promise<WaMessageLike | undefined>;
  } = {
    profilePictureUrl: async () => undefined,
    sendMedia: async () => {
      throw new Error("Unexpected upload");
    },
    downloadMedia: async () => {
      throw new Error("Unexpected download");
    },
    sends,
    sendImpl: async (jid) => text("9000", "sent", { key: sentKey(jid) }),
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(jid, body, quoted) {
      sends.push({ jid, text: body, ...(quoted ? { quoted } : {}) });
      return link.sendImpl(jid, body);
    },
    async stop() {},
    push(event) {
      for (const listener of listeners) listener(event);
    },
    setState(next) {
      state = next;
      link.push({ type: "state", state });
    },
  };
  return link;
}

function sentKey(jid: string) {
  return { remoteJid: jid, id: "9000", fromMe: true };
}

export function socketFactory() {
  const sockets: (WaSocket & {
    emit(event: WaSocketEvent): void;
    closed: boolean;
  })[] = [];
  return {
    sockets,
    open() {
      let handler: (event: WaSocketEvent) => void = () => {};
      const socket = {
        profilePictureUrl: async () => undefined,
        closed: false,
        emit: (event: WaSocketEvent) => handler(event),
        onEvent(next: (event: WaSocketEvent) => void) {
          handler = next;
        },
        async sendText() {
          return undefined;
        },
        async sendMedia() {
          throw new Error("Unexpected upload");
        },
        async downloadMedia() {
          throw new Error("Unexpected download");
        },
        async close() {
          socket.closed = true;
        },
      };
      sockets.push(socket);
      return socket;
    },
  };
}
