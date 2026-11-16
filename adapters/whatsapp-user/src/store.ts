import type { Message, Room } from "@tsuba/serve-kit";
import { isRoomJid, mapMessage, mapRoom, shown, toSeconds } from "./mapping";
import type { WaChat, WaContent, WaKey, WaMessageLike } from "./types";

const MESSAGES_PER_ROOM = 200;
const ROOM_LIMIT = 500;

interface Entry {
  raw: WaMessageLike;
  editedAt: number | null;
}

/**
 * What this process has seen since it started: the chats and messages WhatsApp
 * pushed while syncing and while connected. Memory only; nothing is written to
 * disk, because WhatsApp offers no call that fetches a room's older history.
 */
export class WaStore {
  private readonly chats = new Map<string, Omit<WaChat, "id">>();
  private readonly names = new Map<string, string>();
  private readonly messages = new Map<string, Map<string, Entry>>();

  setChats(chats: WaChat[]): void {
    for (const { id, ...rest } of chats) {
      if (!isRoomJid(id)) continue;
      const known = this.chats.get(id);
      const merged = { ...known };
      for (const [key, value] of Object.entries(rest))
        if (value != null) Object.assign(merged, { [key]: value });
      this.chats.set(id, merged);
    }
  }

  setNames(names: { id: string; name: string }[]): void {
    for (const { id, name } of names) if (name) this.names.set(id, name);
  }

  deleteChats(ids: string[]): void {
    for (const id of ids) {
      this.chats.delete(id);
      this.messages.delete(id);
    }
  }

  put(raw: WaMessageLike): Message | null {
    const mapped = mapMessage(raw);
    const roomId = raw.key.remoteJid;
    const id = raw.key.id;
    if (!mapped || !roomId || !id) return null;
    const room = this.messages.get(roomId) ?? new Map<string, Entry>();
    this.messages.set(roomId, room);
    room.set(id, { raw, editedAt: room.get(id)?.editedAt ?? null });
    if (room.size > MESSAGES_PER_ROOM) {
      const oldest = this.sorted(roomId)[0];
      if (oldest?.raw.key.id) room.delete(oldest.raw.key.id);
    }
    return mapped;
  }

  edit(key: WaKey, content: WaContent, at: number | null): Message | null {
    const entry = this.entry(key);
    if (!entry || !shown(content)) return null;
    entry.raw = { ...entry.raw, message: content };
    entry.editedAt = at;
    return mapMessage(entry.raw, at);
  }

  remove(keys: WaKey[]): { roomId: string; id: string }[] {
    const removed: { roomId: string; id: string }[] = [];
    for (const { remoteJid, id } of keys) {
      if (remoteJid && id && this.messages.get(remoteJid)?.delete(id))
        removed.push({ roomId: remoteJid, id });
    }
    return removed;
  }

  find(roomId: string, id: string): WaMessageLike | undefined {
    return this.messages.get(roomId)?.get(id)?.raw;
  }

  rooms(): Room[] {
    const ids = new Set([...this.chats.keys(), ...this.messages.keys()]);
    const rooms = [...ids].map((id) => {
      const chat = this.chats.get(id) ?? {};
      const newest = this.page(id, 1).messages[0];
      return mapRoom(
        id,
        { ...chat, name: chat.name ?? this.names.get(id) ?? null },
        newest,
      );
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
      messages: all
        .slice(start, end)
        .flatMap((entry) => mapMessage(entry.raw, entry.editedAt) ?? []),
      hasEarlier: start > 0,
    };
  }

  has(roomId: string, id: string): boolean {
    return this.messages.get(roomId)?.has(id) ?? false;
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
