import type { ErrorCode } from "./envelope";

export interface Room {
  id: string;
  title: string;
  kind: "direct" | "group" | "channel";
  unread: number;
  lastActivityAt?: string;
  lastMessage?: { text: string; fromMe: boolean };
}

export interface Message {
  id: string;
  roomId: string;
  senderId?: string;
  sender: string;
  text: string;
  kind: "text" | "media" | "service";
  sentAt: string;
  editedAt?: string;
  fromMe: boolean;
  replyTo?: string;
}

export interface RoomsAnswer {
  ok: true;
  rooms: Room[];
  complete: boolean;
}
export interface MessagesAnswer {
  ok: true;
  messages: Message[];
  hasEarlier: boolean;
}
export type Cursor = Record<string, string>;
export interface StreamReady {
  ok: true;
  resumed: boolean;
  cursor: Cursor;
}
export interface StreamMessage {
  ok: true;
  message: Message;
}
export interface StreamCursor {
  ok: true;
  cursor: Cursor;
}
export interface StreamPing {
  ok: true;
}
export interface SendRequest {
  roomId: string;
  text: string;
}
export interface SendAnswer {
  ok: true;
  message: Message;
}
export interface ErrorEnvelope {
  ok: false;
  error: { code: ErrorCode; message: string };
}

export interface ReadMessagesRequest {
  roomId: string;
  limit: number;
  before?: string;
}

/** Optional methods correspond exactly to declared capabilities. */
export interface AdapterBackend {
  listRooms?(): Promise<Omit<RoomsAnswer, "ok">>;
  readMessages?(
    request: ReadMessagesRequest,
  ): Promise<Omit<MessagesAnswer, "ok">>;
  messagesAfter?(roomId: string, afterId: string): Promise<Message[]>;
  subscribe?(listener: (message: Message) => void): () => void;
  send?(roomId: string, text: string): Promise<Message>;
}

/** Only deliberately safe, account-free messages belong in this error. */
export class AdapterError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

export function errorEnvelope(error: unknown): ErrorEnvelope {
  return {
    ok: false,
    error:
      error instanceof AdapterError
        ? { code: error.code, message: error.message }
        : { code: "INTERNAL", message: "The adapter failed" },
  };
}
