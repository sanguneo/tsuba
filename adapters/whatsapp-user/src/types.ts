/**
 * The slice of WhatsApp's message model this adapter reads. Every field is a
 * structural subset of Baileys' protobuf types, so a Baileys `WAMessage` is
 * accepted as is and tests can build messages without importing Baileys.
 */
export interface WaKey {
  remoteJid?: string | null;
  fromMe?: boolean | null;
  id?: string | null;
  participant?: string | null;
  senderPn?: string;
  senderLid?: string;
}

export interface WaContextInfo {
  stanzaId?: string | null;
}

export interface WaCaptioned {
  caption?: string | null;
  contextInfo?: WaContextInfo | null;
}

export interface WaMedia extends WaCaptioned {
  readonly mimetype?: string | null;
  readonly fileName?: string | null;
  readonly fileLength?: WaTime;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly seconds?: number | null;
  readonly ptt?: boolean | null;
  readonly gifPlayback?: boolean | null;
  readonly viewOnce?: boolean | null;
  readonly url?: string | null;
  readonly directPath?: string | null;
  readonly mediaKey?: Uint8Array | null;
}

export interface WaWrapper {
  message?: WaContent | null;
}

export interface WaContent {
  conversation?: string | null;
  extendedTextMessage?: {
    text?: string | null;
    contextInfo?: WaContextInfo | null;
  } | null;
  imageMessage?: WaMedia | null;
  videoMessage?: WaMedia | null;
  documentMessage?: WaMedia | null;
  audioMessage?: WaMedia | null;
  stickerMessage?: WaMedia | null;
  ephemeralMessage?: WaWrapper | null;
  viewOnceMessage?: WaWrapper | null;
  viewOnceMessageV2?: WaWrapper | null;
  viewOnceMessageV2Extension?: WaWrapper | null;
  documentWithCaptionMessage?: WaWrapper | null;
  editedMessage?: WaWrapper | null;
  protocolMessage?: unknown;
  reactionMessage?: unknown;
}

/** Baileys hands timestamps over as a number or a `Long`. */
export type WaTime = number | { toNumber(): number } | null | undefined;

export interface WaReceipt {
  userJid: string;
  receiptTimestamp?: WaTime;
  readTimestamp?: WaTime;
  playedTimestamp?: WaTime;
}

export interface WaMessageLike {
  key: WaKey;
  message?: WaContent | null;
  messageTimestamp?: WaTime;
  pushName?: string | null;
  verifiedBizName?: string | null;
  status?: number | null;
  userReceipt?: WaReceipt[] | null;
}

export interface WaChat {
  id: string;
  name?: string | null;
  displayName?: string | null;
  pnJid?: string | null;
  lidJid?: string | null;
  conversationTimestamp?: WaTime;
  unreadCount?: number | null;
}

/** Preserve saved names, public names and the phone/LID identity separately. */
export interface WaContact {
  readonly id: string;
  readonly name?: string | null;
  readonly notify?: string | null;
  readonly verifiedName?: string | null;
  readonly lid?: string;
  readonly jid?: string;
}

export interface WaGroup {
  readonly id: string;
  readonly subject?: string;
}

/** What the socket reports about the chat and message state. */
export type WaDataEvent =
  | { type: "chats"; chats: WaChat[] }
  /** The final FULL chunk reached 100%; not a claim of full account history. */
  | { type: "historySyncComplete" }
  | { type: "names"; names: WaContact[] }
  | { type: "groups"; groups: WaGroup[] }
  | { type: "groupSyncStarted" }
  | { type: "groupSyncComplete"; count: number }
  /** Optional group metadata failed; no account data or SDK error is exposed. */
  | { type: "groupSyncFailed" }
  | { type: "chatsDeleted"; ids: string[] }
  /** `live` is a message that arrived while connected; history is not streamed. */
  | { type: "messages"; messages: WaMessageLike[]; live: boolean }
  | {
      type: "receipt";
      key: WaKey;
      update: Pick<WaMessageLike, "status" | "userReceipt">;
    }
  | { type: "edit"; key: WaKey; content: WaContent; at: WaTime }
  | { type: "delete"; keys: WaKey[] };

export type WaSocketEvent =
  | WaDataEvent
  | { type: "qr"; qr: string }
  | { type: "open" }
  | { type: "close"; statusCode: number | undefined };

/** One WhatsApp Web connection. Closed means closed: reconnecting opens a new one. */
export interface WaSocket {
  profilePictureUrl(jid: string): Promise<string | undefined>;
  onEvent(handler: (event: WaSocketEvent) => void): void;
  sendText(
    jid: string,
    text: string,
    quoted?: WaMessageLike,
  ): Promise<WaMessageLike | undefined>;
  sendMedia(
    jid: string,
    file: UploadFile,
    caption?: string,
    quoted?: WaMessageLike,
  ): Promise<WaMessageLike | undefined>;
  downloadMedia(
    message: WaMessageLike,
    signal: AbortSignal,
  ): Promise<MediaFile["body"]>;
  close(): Promise<void>;
}

/** `connecting`, `reconnecting` and `open` recover; the rest need the owner. */
export type WaState =
  | "connecting"
  | "open"
  | "reconnecting"
  | "logged-out"
  | "conflict"
  | "forbidden";

export type WaLinkEvent = WaDataEvent | { type: "state"; state: WaState };

import type { MediaFile, UploadFile } from "@tsuba/serve-kit";
