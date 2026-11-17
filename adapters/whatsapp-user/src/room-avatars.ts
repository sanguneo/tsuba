import { createHash } from "node:crypto";
import { AdapterError, type MediaFile, type Room } from "@tsuba/serve-kit";
import {
  downloadPicture,
  type Picture,
  type PictureFetch,
} from "./avatar-download";

const TTL_MS = 300_000;
const LIMIT = 500;
const CONCURRENCY = 4;

interface Entry {
  readonly expires: number;
  readonly picture: (Picture & { readonly id: string }) | undefined;
}

export interface AvatarOptions {
  readonly fetchFn?: PictureFetch;
  readonly now?: () => number;
}

/** Bounded process-local snapshots, including negative results and in-flight reads. */
export class RoomAvatars {
  private readonly cache = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<Entry | undefined>>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly now: () => number;
  private readonly fetchFn: PictureFetch;

  constructor(
    private readonly lookup: (jid: string) => Promise<string | undefined>,
    options: AvatarOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async rooms(rooms: readonly Room[]): Promise<Room[]> {
    const signal = AbortSignal.timeout(8_000);
    const result: Room[] = [];
    let index = 0;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        for (;;) {
          const at = index++;
          const room = rooms[at];
          if (!room) return;
          const entry = await this.get(room.id, signal);
          result[at] = entry?.picture
            ? { ...room, avatar: entry.picture.id }
            : room;
        }
      }),
    );
    return result;
  }

  media(id: string, signal: AbortSignal): MediaFile {
    signal.throwIfAborted();
    if (/^wa-room-v1-[a-f0-9]{64}$/.test(id)) {
      for (const entry of this.cache.values()) {
        if (entry.expires <= this.now() || entry.picture?.id !== id) continue;
        const picture = entry.picture;
        return {
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(picture.bytes.slice());
              controller.close();
            },
          }),
          mimeType: picture.mimeType,
        };
      }
    }
    throw new AdapterError("NOT_FOUND", "No such WhatsApp picture");
  }

  private get(jid: string, signal: AbortSignal): Promise<Entry | undefined> {
    const cached = this.cache.get(jid);
    if (cached && cached.expires > this.now()) return Promise.resolve(cached);
    const pending = this.pending.get(jid);
    if (pending) return pending;
    if (signal.aborted || this.pending.size >= LIMIT)
      return Promise.resolve(undefined);
    const task = this.load(jid, signal).finally(() => this.pending.delete(jid));
    this.pending.set(jid, task);
    return task;
  }

  private async load(
    jid: string,
    signal: AbortSignal,
  ): Promise<Entry | undefined> {
    if (this.active >= CONCURRENCY)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      if (signal.aborted) return undefined;
      let picture: Entry["picture"];
      try {
        const url = await this.lookup(jid);
        if (url) {
          const value = await downloadPicture(url, signal, this.fetchFn);
          const hash = createHash("sha256")
            .update(value.mimeType)
            .update(value.bytes)
            .digest("hex");
          picture = { ...value, id: `wa-room-v1-${hash}` };
        }
      } catch {
        // Optional SDK/HTTP boundary: omit even private, malformed or failed reads.
        // Never report SDK errors, which can contain account data.
        picture = undefined;
      }
      const entry = { expires: this.now() + TTL_MS, picture };
      this.cache.delete(jid);
      this.cache.set(jid, entry);
      if (this.cache.size > LIMIT) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      return entry;
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
