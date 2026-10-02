import {
  AdapterError,
  type Message,
  type MessagesAnswer,
  type StreamUpdate,
} from "@tsuba/serve-kit";

type Page = Omit<MessagesAnswer, "ok">;
type Change =
  | Extract<StreamUpdate, { event: "message" | "message.edited" }>
  | Extract<StreamUpdate, { event: "reactions.updated" }>
  | null;

/** Mutable room state. Pending refreshes keep a bounded event overlay. */
interface Entry {
  page: Page | undefined;
  pending: Promise<Page> | undefined;
  changes: Map<string, Change>;
  attemptedAt: number;
  bytes: number;
}

function changed(page: Page, id: string, change: Change): Page {
  const existing = page.messages.find((message) => message.id === id);
  if (change === null)
    return {
      ...page,
      messages: page.messages.filter((message) => message.id !== id),
    };
  if (change.event === "reactions.updated") {
    return {
      ...page,
      messages: page.messages.map((message) =>
        message.id === id
          ? { ...message, reactions: change.reactions }
          : message,
      ),
    };
  }
  if (change.event === "message.edited" && !existing) return page;
  if (existing?.editedAt && (change.message.editedAt ?? "") < existing.editedAt)
    return page;
  const messages = page.messages.filter((message) => message.id !== id);
  messages.push(change.message);
  messages.sort((a, b) =>
    BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0,
  );
  return {
    messages: messages.slice(-100),
    hasEarlier: page.hasEarlier || messages.length > 100,
  };
}

/**
 * Mapped values, not discord.js Message objects: replacement drops removed
 * reactions. Limits cover rooms, serialized payload/overlays and REST jobs.
 */
export class RecentMessages {
  private readonly entries = new Map<string, Entry>();
  private active = 0;
  private readonly now: () => number;
  private readonly maxRooms: number;
  private readonly maxBytes: number;
  private readonly refreshMs: number;

  constructor(
    options: {
      now?: () => number;
      maxRooms?: number;
      maxBytes?: number;
      refreshMs?: number;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maxRooms = options.maxRooms ?? 64;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    this.refreshMs = options.refreshMs ?? 15_000;
  }

  clear() {
    this.entries.clear();
  }

  delete(roomId: string) {
    this.entries.delete(roomId);
  }

  latest(roomId: string): Message | undefined {
    return this.entries.get(roomId)?.page?.messages.at(-1);
  }

  after(roomId: string, id: string): Message[] | undefined {
    const messages = this.entries.get(roomId)?.page?.messages;
    const index = messages?.findIndex((message) => message.id === id) ?? -1;
    return index < 0 ? undefined : messages?.slice(index + 1);
  }

  private budget(roomId: string, entry: Entry) {
    entry.bytes = Buffer.byteLength(
      JSON.stringify([entry.page, [...entry.changes]]),
    );
    let bytes = [...this.entries.values()].reduce(
      (sum, value) => sum + value.bytes,
      0,
    );
    while (this.entries.size > this.maxRooms || bytes > this.maxBytes) {
      const victim =
        [...this.entries].find(
          ([id, value]) => id !== roomId && !value.pending,
        ) ?? ([roomId, entry] as const);
      this.entries.delete(victim[0]);
      bytes -= victim[1].bytes;
    }
  }

  apply(update: StreamUpdate) {
    const roomId = "message" in update ? update.message.roomId : update.roomId;
    const entry = this.entries.get(roomId);
    if (!entry) return; // An event alone is not a complete recent window.
    const changes: [string, Change][] =
      update.event === "message.deleted"
        ? update.messageIds.map((id) => [id, null])
        : [
            [
              "message" in update ? update.message.id : update.messageId,
              update,
            ],
          ];
    for (const [id, change] of changes) {
      // A delayed partial edit/reaction fetch cannot resurrect a deleted id.
      if (change !== null && entry.changes.get(id) === null) continue;
      if (entry.page) entry.page = changed(entry.page, id, change);
      if (entry.pending) {
        const previous = entry.changes.get(id);
        // Keep a create when a reaction/edit follows it before the initial read.
        if (
          (previous?.event === "message" ||
            previous?.event === "message.edited") &&
          change !== null
        ) {
          const merged = changed(
            { messages: [previous.message], hasEarlier: false },
            id,
            change,
          );
          const message = merged.messages[0];
          if (message)
            entry.changes.set(id, { event: previous.event, message });
        } else entry.changes.set(id, change);
        if (entry.changes.size > 100) {
          this.delete(roomId);
          return;
        }
      }
    }
    this.budget(roomId, entry);
  }

  async read(
    roomId: string,
    limit: number,
    load: () => Promise<Page>,
  ): Promise<Page> {
    let entry = this.entries.get(roomId);
    if (!entry) {
      entry = {
        page: undefined,
        pending: undefined,
        changes: new Map(),
        attemptedAt: 0,
        bytes: 0,
      };
      this.entries.set(roomId, entry);
      this.budget(roomId, entry);
    } else {
      this.entries.delete(roomId);
      this.entries.set(roomId, entry);
    }
    const cached = entry.page;
    if (cached) {
      if (!entry.pending && this.now() - entry.attemptedAt >= this.refreshMs) {
        void this.refresh(roomId, entry, load).catch((error: unknown) => {
          const code = error instanceof AdapterError ? error.code : "INTERNAL";
          if (
            code === "FORBIDDEN" ||
            code === "NOT_FOUND" ||
            code === "REAUTH_REQUIRED"
          )
            this.delete(roomId);
          console.warn(`Discord cache refresh failed: ${code}`);
        });
      }
      return {
        messages: cached.messages.slice(-limit),
        hasEarlier: cached.hasEarlier || cached.messages.length > limit,
      };
    }
    const page = await (entry.pending ?? this.refresh(roomId, entry, load));
    return {
      messages: page.messages.slice(-limit),
      hasEarlier: page.hasEarlier || page.messages.length > limit,
    };
  }

  private refresh(
    roomId: string,
    entry: Entry,
    load: () => Promise<Page>,
  ): Promise<Page> {
    entry.attemptedAt = this.now();
    if (this.active >= 4)
      return Promise.reject(new AdapterError("BUSY", "Discord reads are busy"));
    this.active++;
    entry.pending = (async () => {
      try {
        let page = await load();
        if (this.entries.get(roomId) !== entry)
          throw new AdapterError("BUSY", "Discord room changed during refresh");
        for (const [id, change] of entry.changes)
          page = changed(page, id, change);
        entry.page = {
          messages: page.messages.slice(-100),
          hasEarlier: page.hasEarlier || page.messages.length > 100,
        };
        entry.changes.clear();
        this.budget(roomId, entry);
        return entry.page;
      } finally {
        this.active--;
        entry.pending = undefined;
        entry.changes.clear();
        if (!entry.page && this.entries.get(roomId) === entry)
          this.delete(roomId);
      }
    })();
    return entry.pending;
  }
}
