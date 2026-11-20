import type { Message, Room } from "@tsuba/serve-kit";
import { proto } from "@whiskeysockets/baileys";
import { BotPrompts } from "./bot-prompts";
import {
  isBotJid,
  isRoomJid,
  jidUser,
  mapMessage,
  mapRoom,
  personalJid,
  shown,
  toSeconds,
} from "./mapping";
import { confirmedStatus } from "./receipts";
import type { StoreSnapshot } from "./snapshot";
import type {
  WaChat,
  WaContact,
  WaContent,
  WaGroup,
  WaKey,
  WaMessageLike,
} from "./types";

const MESSAGES_PER_ROOM = 200;
const SAVED_MESSAGES_PER_ROOM = 50;
const ROOM_LIMIT = 500;

interface Entry {
  raw: WaMessageLike;
  editedAt: number | null;
}

function phoneJid(jid: string): boolean {
  return /^\d+@s\.whatsapp\.net$/.test(jid);
}

/**
 * What WhatsApp has pushed while syncing and connected, including the saved
 * cache from earlier runs. WhatsApp cannot fetch a room's older history.
 */
export class WaStore {
  private readonly botPrompts: BotPrompts;
  private readonly chats = new Map<string, Omit<WaChat, "id">>();
  private readonly names = new Map<
    string,
    {
      name: string | undefined;
      notify: string | undefined;
      verifiedName: string | undefined;
    }
  >();
  private readonly aliases = new Map<string, Set<string>>();
  private readonly pushNames = new Map<string, { name: string; at: number }>();
  private readonly subjects = new Map<string, string>();
  private readonly messages = new Map<string, Map<string, Entry>>();
  // Receipts may precede the message or a send's resolution. Bound the cache.
  private readonly pendingReceipts = new Map<
    string,
    { key: WaKey; status: number }
  >();

  constructor(snapshot?: StoreSnapshot) {
    this.botPrompts = new BotPrompts(snapshot?.botPrompts);
    if (!snapshot) return;
    for (const { key, status } of snapshot.receipts ?? [])
      this.receipt(key, { status });
    this.setChats(
      snapshot.chats.map(({ id, name, at, unread }) => ({
        id,
        name,
        conversationTimestamp: at,
        unreadCount: unread,
      })),
    );
    for (const { id, linked } of snapshot.aliases)
      if (personalJid(id))
        this.aliases.set(id, new Set(linked.filter(personalJid)));
    this.setGroups(snapshot.subjects);
    for (const { data, editedAt } of snapshot.messages) {
      const raw = proto.WebMessageInfo.decode(Buffer.from(data, "base64"));
      this.put(raw);
      const entry = this.entry(raw.key);
      if (entry) entry.editedAt = editedAt;
    }
    this.setNames(snapshot.names);
    for (const { id, name, at } of snapshot.pushNames)
      this.setPushName(id, name, at);
  }

  snapshot(): StoreSnapshot {
    const botPrompts = this.botPrompts.snapshot();
    return {
      version: 1,
      ...(botPrompts.length > 0 && { botPrompts }),
      receipts: [...this.pendingReceipts.values()],
      chats: [...this.chats].map(([id, chat]) => ({
        id,
        name: chat.name ?? null,
        at: toSeconds(chat.conversationTimestamp),
        unread: chat.unreadCount ?? null,
      })),
      names: [...this.names].map(([id, contact]) => ({
        id,
        name: contact.name ?? null,
        notify: contact.notify ?? null,
        ...(contact.verifiedName && { verifiedName: contact.verifiedName }),
      })),
      aliases: [...this.aliases].map(([id, linked]) => ({
        id,
        linked: [...linked],
      })),
      pushNames: [...this.pushNames].map(([id, pushed]) => ({ id, ...pushed })),
      subjects: [...this.subjects].map(([id, subject]) => ({ id, subject })),
      messages: [...this.messages.keys()].flatMap((id) =>
        this.sorted(id)
          .slice(-SAVED_MESSAGES_PER_ROOM)
          .map(({ raw, editedAt }) => ({
            data: Buffer.from(
              proto.WebMessageInfo.encode(
                proto.WebMessageInfo.fromObject({
                  ...raw,
                  messageTimestamp: toSeconds(raw.messageTimestamp),
                }),
              ).finish(),
            ).toString("base64"),
            editedAt,
          })),
      ),
    };
  }

  setChats(chats: WaChat[]): void {
    for (const { id, pnJid, lidJid, displayName, name, ...rest } of chats) {
      if (!isRoomJid(id)) continue;
      if (personalJid(id)) this.linkAliases([id, pnJid, lidJid]);
      const known = this.chats.get(id);
      const merged = { ...known };
      for (const [key, value] of Object.entries({
        ...rest,
        name: name?.trim() || displayName?.trim(),
      }))
        if (value != null) Object.assign(merged, { [key]: value });
      this.chats.set(id, merged);
    }
  }

  setNames(names: WaContact[]): void {
    for (const contact of names) {
      const id = isBotJid(contact.id) ? contact.id : personalJid(contact.id);
      if (!id) continue;
      if (!isBotJid(id)) this.linkAliases([id, contact.lid, contact.jid]);
      const known = this.names.get(id);
      this.names.set(id, {
        name: contact.name?.trim() || known?.name,
        notify: contact.notify?.trim() || known?.notify,
        verifiedName: contact.verifiedName?.trim() || known?.verifiedName,
      });
    }
  }

  setGroups(groups: WaGroup[]): void {
    for (const { id, subject } of groups) {
      if (!isRoomJid(id) || !id.endsWith("@g.us")) continue;
      this.setChats([{ id }]);
      if (subject) this.subjects.set(id, subject);
    }
  }

  deleteChats(ids: string[]): void {
    for (const id of ids) {
      this.botPrompts.deleteChat(id);
      this.chats.delete(id);
      this.messages.delete(id);
      for (const [receiptId, receipt] of this.pendingReceipts)
        if (receipt.key.remoteJid === id)
          this.pendingReceipts.delete(receiptId);
      this.subjects.delete(id);
    }
  }

  put(raw: WaMessageLike): Message | null {
    const roomId = raw.key.remoteJid;
    const id = raw.key.id;
    if (isBotJid(roomId)) {
      this.setChats([{ id: roomId }]);
      this.botPrompts.put(raw);
      if (raw.key.fromMe === false) {
        this.setPushName(roomId, raw.pushName, toSeconds(raw.messageTimestamp));
        if (raw.verifiedBizName?.trim())
          this.setNames([{ id: roomId, verifiedName: raw.verifiedBizName }]);
      }
    } else if (roomId && isRoomJid(roomId) && !raw.key.fromMe) {
      const direct = personalJid(roomId);
      // These Baileys key fields describe the sender, not the recipient.
      const sender = direct ?? personalJid(raw.key.participant ?? "");
      if (sender) {
        this.linkAliases([sender, raw.key.senderPn, raw.key.senderLid]);
        this.setPushName(sender, raw.pushName, toSeconds(raw.messageTimestamp));
        if (raw.verifiedBizName?.trim())
          this.setNames([{ id: sender, verifiedName: raw.verifiedBizName }]);
      }
    }
    const mapped = mapMessage(raw);
    if (!mapped || !roomId || !id) return null;
    this.setChats([{ id: roomId }]);
    const room = this.messages.get(roomId) ?? new Map<string, Entry>();
    this.messages.set(roomId, room);
    const known = room.get(id);
    const receiptId = JSON.stringify([roomId, id]);
    const pending = this.pendingReceipts.get(receiptId);
    const status = raw.key.fromMe
      ? Math.max(
          confirmedStatus(raw),
          known ? confirmedStatus(known.raw) : 0,
          pending?.status ?? 0,
        )
      : 0;
    this.pendingReceipts.delete(receiptId);
    const merged = {
      ...raw,
      ...(status ? { status } : {}),
    };
    room.set(id, { raw: merged, editedAt: known?.editedAt ?? null });
    if (room.size > MESSAGES_PER_ROOM) {
      const oldest = this.sorted(roomId)[0];
      if (oldest?.raw.key.id) room.delete(oldest.raw.key.id);
    }
    const message = mapMessage(merged, known?.editedAt);
    return message && this.withSenderName(message);
  }

  receipt(
    key: WaKey,
    update: Pick<WaMessageLike, "status" | "userReceipt">,
  ): Message | null {
    const { remoteJid, id } = key;
    if (!remoteJid || !id || !isRoomJid(remoteJid) || key.fromMe === false)
      return null;
    const status = confirmedStatus(update);
    if (!status) return null;
    const entry = this.entry(key);
    if (!entry) {
      if (key.fromMe !== true) return null;
      const receiptId = JSON.stringify([remoteJid, id]);
      const previous = this.pendingReceipts.get(receiptId)?.status ?? 0;
      this.pendingReceipts.set(receiptId, {
        key: { remoteJid, id, fromMe: true },
        status: Math.max(previous, status),
      });
      if (this.pendingReceipts.size > MESSAGES_PER_ROOM) {
        const oldest = this.pendingReceipts.keys().next().value;
        if (oldest) this.pendingReceipts.delete(oldest);
      }
      return null;
    }
    if (!entry.raw.key.fromMe || status <= confirmedStatus(entry.raw))
      return null;
    entry.raw = { ...entry.raw, status };
    const message = mapMessage(entry.raw, entry.editedAt);
    return message && this.withSenderName(message);
  }

  edit(key: WaKey, content: WaContent, at: number | null): Message | null {
    const entry = this.entry(key);
    if (!entry || !shown(content)) return null;
    entry.raw = { ...entry.raw, message: content };
    entry.editedAt = at;
    const mapped = mapMessage(entry.raw, at);
    return mapped && this.withSenderName(mapped);
  }

  remove(keys: WaKey[]): { roomId: string; id: string }[] {
    const removed: { roomId: string; id: string }[] = [];
    for (const key of keys) {
      const { remoteJid, id } = key;
      this.botPrompts.delete(key);
      this.pendingReceipts.delete(JSON.stringify([remoteJid, id]));
      if (remoteJid && id && this.messages.get(remoteJid)?.delete(id))
        removed.push({ roomId: remoteJid, id });
    }
    return removed;
  }

  find(roomId: string, id: string): WaMessageLike | undefined {
    return this.messages.get(roomId)?.get(id)?.raw;
  }

  findOutbound(roomId: string, id: string): WaMessageLike | undefined {
    if (!isBotJid(roomId)) return this.find(roomId, id);
    const message = this.botPrompts.find(roomId, id);
    return message
      ? { key: { remoteJid: roomId, id, fromMe: true }, message }
      : undefined;
  }

  rooms(): Room[] {
    const ids = new Set([...this.chats.keys(), ...this.messages.keys()]);
    const rooms = [...ids].map((id) => {
      const chat = this.chats.get(id) ?? {};
      const newest = this.page(id, 1).messages[0];
      const name = id.endsWith("@g.us")
        ? this.subjects.get(id) || chat.name
        : isBotJid(id)
          ? this.botName(id, chat.name)
          : this.personalName(id, chat.name);
      return mapRoom(id, { ...chat, name: name ?? null }, newest);
    });
    rooms.sort(
      (left, right) =>
        (right.lastActivityAt ? Date.parse(right.lastActivityAt) : 0) -
          (left.lastActivityAt ? Date.parse(left.lastActivityAt) : 0) ||
        left.title.localeCompare(right.title, "en"),
    );
    return rooms.slice(0, ROOM_LIMIT);
  }

  /** The newest `limit` messages before `before`, oldest first; check `has` first for a cursor. */
  page(
    roomId: string,
    limit: number,
    before?: string,
  ): { messages: Message[]; hasEarlier: boolean } {
    const all = this.sorted(roomId);
    const end =
      before === undefined
        ? all.length
        : all.findIndex((entry) => entry.raw.key.id === before);
    if (end < 0) return { messages: [], hasEarlier: false };
    const start = Math.max(0, end - limit);
    return {
      messages: all.slice(start, end).flatMap((entry) => {
        const mapped = mapMessage(entry.raw, entry.editedAt);
        return mapped ? [this.withSenderName(mapped)] : [];
      }),
      hasEarlier: start > 0,
    };
  }

  has(roomId: string, id: string): boolean {
    return this.messages.get(roomId)?.has(id) ?? false;
  }

  /** Try the observed address first; only use a uniquely linked phone as fallback. */
  pictureJids(jid: string): string[] {
    if (!isRoomJid(jid) || isBotJid(jid)) return [];
    const id = personalJid(jid) ?? jid;
    const phones = [...(this.aliases.get(id) ?? [])].filter(phoneJid);
    const phone = phones.length === 1 ? phones[0] : undefined;
    return phone && phone !== id ? [id, phone] : [id];
  }

  private botName(id: string, chatName?: string | null): string | undefined {
    const contact = this.names.get(id);
    return (
      [
        chatName,
        contact?.name,
        contact?.verifiedName,
        this.pushNames.get(id)?.name,
        contact?.notify,
      ].find((name) => name && name !== id && name !== jidUser(id)) ?? undefined
    );
  }

  private personalName(
    jid: string,
    chatName?: string | null,
  ): string | undefined {
    const id = personalJid(jid);
    if (!id) return undefined;
    const linked = [...(this.aliases.get(id) ?? [id])];
    const phones = linked.filter(phoneJid);
    const phone = phones.length === 1 ? phones[0] : undefined;
    const aliases = phones.length > 1 ? [id] : linked;
    const contacts = aliases.flatMap((alias) => this.names.get(alias) ?? []);
    const label = (value?: string | null) =>
      value?.trim() &&
      !aliases.some((alias) => value === alias || value === jidUser(alias));
    const pushed = aliases
      .flatMap((alias) => this.pushNames.get(alias) ?? [])
      .filter(({ name }) => label(name))
      .sort((left, right) => right.at - left.at)[0]?.name;
    return (
      contacts.find((contact) => label(contact.name))?.name ||
      (label(chatName) ? chatName : undefined) ||
      pushed ||
      contacts.find((contact) => label(contact.notify))?.notify ||
      contacts.find((contact) => label(contact.verifiedName))?.verifiedName ||
      (phone ? jidUser(phone) : undefined)
    );
  }

  private withSenderName(message: Message): Message {
    if (!message.senderId) return message;
    const chat = personalJid(message.roomId)
      ? this.chats.get(message.roomId)
      : undefined;
    const sender = isBotJid(message.senderId)
      ? this.botName(message.senderId, this.chats.get(message.senderId)?.name)
      : this.personalName(message.senderId, chat?.name);
    return sender ? { ...message, sender } : message;
  }

  private linkAliases(values: (string | null | undefined)[]): void {
    const ids = new Set(
      values.flatMap((value) => (value ? (personalJid(value) ?? []) : [])),
    );
    if (ids.size < 2) return;
    const linked = new Set(
      [...ids].flatMap((alias) => [...(this.aliases.get(alias) ?? [alias])]),
    );
    for (const alias of linked) this.aliases.set(alias, linked);
  }

  private setPushName(
    id: string,
    name: string | null | undefined,
    timestamp: number | null,
  ): void {
    const at = timestamp ?? 0;
    const title = name?.trim();
    if (title && at >= (this.pushNames.get(id)?.at ?? 0))
      this.pushNames.set(id, { name: title, at });
  }

  private entry(key: WaKey): Entry | undefined {
    return key.remoteJid && key.id
      ? this.messages.get(key.remoteJid)?.get(key.id)
      : undefined;
  }

  private sorted(roomId: string): Entry[] {
    return [...(this.messages.get(roomId)?.values() ?? [])].sort(
      (left, right) =>
        (toSeconds(left.raw.messageTimestamp) ?? 0) -
        (toSeconds(right.raw.messageTimestamp) ?? 0),
    );
  }
}
