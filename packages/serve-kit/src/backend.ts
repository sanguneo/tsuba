import type { RoomFeatures } from "./capabilities";
import type { ErrorCode } from "./envelope";

export interface Room {
  id: string;
  title: string;
  kind: "direct" | "group" | "channel";
  unread: number;
  lastActivityAt?: string;
  lastMessage?: { text: string; fromMe: boolean };
  features?: RoomFeatures;
}

export interface Attachment {
  id: string;
  kind:
    | "file"
    | "image"
    | "video"
    | "audio"
    | "voice"
    | "sticker"
    | "animation";
  name?: string;
  mimeType?: string;
  size?: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

export interface Reaction {
  emoji: string;
  count: number;
  mine: boolean;
}

export interface Message {
  id: string;
  roomId: string;
  senderId?: string;
  sender: string;
  /** A `/media` id for the sender's picture; only with `avatars.read`. */
  senderAvatar?: string;
  text: string;
  kind: "text" | "media" | "service";
  sentAt: string;
  editedAt?: string;
  fromMe: boolean;
  replyTo?: string;
  /** Shared by the messages of one album; each stays its own message. */
  groupId?: string;
  attachments?: Attachment[];
  reactions?: Reaction[];
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

/** A file's bytes as the messenger hands them over; `GET /media` decides the headers. */
export interface MediaFile {
  body: ReadableStream<Uint8Array>;
  mimeType?: string;
  name?: string;
}

/**
 * What a backend reports to the stream. `message` is a new message; the others
 * are sent only when the declaration lists them in `messages.stream.events`.
 */
export type StreamUpdate =
  | { event: "message"; message: Message }
  | { event: "message.edited"; message: Message }
  | { event: "message.deleted"; roomId: string; messageIds: string[] }
  | {
      event: "reactions.updated";
      roomId: string;
      messageId: string;
      reactions: Reaction[];
    };

export interface SendOptions {
  /** Present only when the adapter declares `messages.reply`. */
  replyTo?: string;
}

/** One file as the client sent it, read whole and no larger than the declared `maxBytes`. */
export interface UploadFile {
  name: string;
  type: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface UploadOptions extends SendOptions {
  /** Present only when the declaration says `caption: true`. */
  caption?: string;
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
  subscribe?(listener: (update: StreamUpdate) => void): () => void;
  send?(roomId: string, text: string, options: SendOptions): Promise<Message>;
  upload?(
    roomId: string,
    file: UploadFile,
    options: UploadOptions,
  ): Promise<Message>;
  edit?(roomId: string, messageId: string, text: string): Promise<Message>;
  deleteMessage?(roomId: string, messageId: string): Promise<void>;
  /** Sets this account's reactions on the message to exactly `emojis`. */
  react?(
    roomId: string,
    messageId: string,
    emojis: string[],
  ): Promise<Reaction[]>;
  markRead?(roomId: string, messageId: string): Promise<void>;
  media?(id: string, signal: AbortSignal): Promise<MediaFile>;
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
