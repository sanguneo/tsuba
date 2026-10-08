import {
  type AdapterBackend,
  AdapterError,
  type ErrorCode,
  type Message,
  type ReadMessagesRequest,
  type Room,
  type StreamUpdate,
} from "@tsuba/serve-kit";

/** Homebrew's prefix on Apple Silicon; an Intel install is under /usr/local. */
const IMSG = process.env.TSUBA_IMESSAGE_BIN ?? "/opt/homebrew/bin/imsg";
/** The contract caps `messages.read.maxLimit` here, and imsg pages by count. */
const MAX_LIMIT = 100;
/** Chats answered in one list; one more is asked for to prove none were left. */
const ROOM_LIMIT = 250;
/** How far back a just-sent message is looked for; imsg verified it landed. */
const READ_BACK = 10;
/** A dead watcher is restarted after this long, doubling up to half a minute. */
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 30_000;

export interface ImsgRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** One `imsg` invocation; the tests pass a fake so no real Messages data is read. */
export type ImsgRunner = (args: string[]) => Promise<ImsgRun>;

interface ImsgChat {
  id: number;
  name?: string;
  display_name?: string;
  identifier?: string;
  is_group?: boolean;
  unread_count?: number;
  last_message_at?: string;
  participants?: string[];
}

interface ImsgMessage {
  id: number;
  chat_id: number;
  sender?: string;
  is_from_me?: boolean;
  text?: string;
  created_at?: string;
}

async function spawn(args: string[]): Promise<ImsgRun> {
  const child = Bun.spawn([IMSG, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/** One long-lived `imsg watch`: its NDJSON lines as they arrive, and how it ends. */
export interface ImsgWatcher {
  onLine(listener: (line: string) => void): void;
  /** Settles with the exit code when the watcher process ends. */
  exited: Promise<number>;
  stop(): void;
}

/** One `imsg watch` invocation; the tests pass a fake so no real Messages data is read. */
export type ImsgWatchSpawner = (args: string[]) => ImsgWatcher;

function spawnWatcher(args: string[]): ImsgWatcher {
  const child = Bun.spawn([IMSG, ...args], { stdout: "pipe", stderr: "pipe" });
  const listeners: ((line: string) => void)[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    const reader = child.stdout.getReader();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let end = buffered.indexOf("\n");
      while (end >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        for (const listener of listeners) listener(line);
        end = buffered.indexOf("\n");
      }
    }
  })();
  // imsg writes its human output to stderr; drained so a full pipe cannot block it.
  void new Response(child.stderr).text();
  return {
    onLine(listener) {
      listeners.push(listener);
    },
    exited: child.exited,
    stop() {
      child.kill();
    },
  };
}

/**
 * The refusals `imsg` states, as a sentence with a nonzero exit (mostly on
 * stdout; the SQLite one on stderr). Full Disk Access and Automation are grants
 * a person gives the process that runs the adapter, and neither failure changed
 * anything, so both answer REAUTH_REQUIRED, the code whose remedy is a person
 * acting where the adapter runs. A chat imsg does not know is NOT_FOUND.
 * Anything not named here stays INTERNAL, the only code meaning "unknown".
 */
const REFUSALS: readonly [RegExp, ErrorCode, string][] = [
  [
    /authorization denied|cannot access messages database|unable to open database file|permission error/i,
    "REAUTH_REQUIRED",
    "imsg cannot read the Messages database; grant Full Disk Access to the process that runs the adapter",
  ],
  [
    /not authorized to send apple events/i,
    "REAUTH_REQUIRED",
    "imsg cannot drive Messages; grant Automation permission for Messages to the process that runs the adapter",
  ],
  [/unknown chat id|invalid chat target/i, "NOT_FOUND", "No such chat"],
];

/**
 * A send imsg could not confirm: the message may have arrived, so it is never
 * retried and its outcome is unknown, which is what INTERNAL alone means.
 */
const UNCERTAIN = /may_have_completed|still_in_flight/i;

function refused(text: string): AdapterError {
  for (const [pattern, code, message] of REFUSALS)
    if (pattern.test(text)) return new AdapterError(code, message);
  return new AdapterError("INTERNAL", "imsg failed");
}

/**
 * One `imsg watch` line as a row. A line the adapter cannot read is dropped
 * rather than raised: serve-kit's only error event ends the stream, so raising
 * one unreadable line would trade a live stream for a detail nobody can act on.
 */
function watched(line: string): ImsgMessage | undefined {
  if (!line.trim()) return undefined;
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
  const { id, chat_id } = row as { id?: unknown; chat_id?: unknown };
  if (typeof id !== "number" || typeof chat_id !== "number") return undefined;
  return row as ImsgMessage;
}

/** `imsg --json` writes one object per line, never one document. */
function jsonLines<T>(output: string): T[] {
  const rows: T[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      row = undefined;
    }
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new AdapterError(
        "INTERNAL",
        "imsg answered something the adapter could not read",
      );
    rows.push(row as T);
  }
  return rows;
}

/** A chat rowid, the id `imsg` routes by. */
function chatId(value: string): number {
  const id = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(id))
    throw new AdapterError("NOT_FOUND", "No such chat");
  return id;
}

function messageId(value: string): number {
  const id = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(id))
    throw new AdapterError("INVALID_REQUEST", "Invalid message id");
  return id;
}

function room(row: ImsgChat): Room {
  const named = row.display_name?.trim() || row.name?.trim();
  const participants = (row.participants ?? []).filter((handle) => handle);
  const activity = row.last_message_at;
  return {
    id: String(row.id),
    title: named || participants.join(", ") || row.identifier || String(row.id),
    kind: row.is_group ? "group" : "direct",
    unread: row.unread_count ?? 0,
    ...(activity ? { lastActivityAt: activity } : {}),
  };
}

function message(row: ImsgMessage): Message {
  const fromMe = row.is_from_me === true;
  const handle = row.sender ?? "";
  return {
    id: String(row.id),
    roomId: String(row.chat_id),
    ...(fromMe ? { senderId: "me" } : handle ? { senderId: handle } : {}),
    sender: fromMe ? "me" : handle,
    text: row.text ?? "",
    kind: "text",
    sentAt: row.created_at ?? "",
    fromMe,
  };
}

function byNewest(left: Room, right: Room): number {
  const a = left.lastActivityAt ? Date.parse(left.lastActivityAt) : 0;
  const b = right.lastActivityAt ? Date.parse(right.lastActivityAt) : 0;
  return b - a;
}

/**
 * The Mac's own Messages account behind the contract, through the third-party
 * `imsg` CLI: it reads `~/Library/Messages/chat.db` and sends through
 * Messages.app, and the first of those needs Full Disk Access (docs/imessage.md).
 * Rooms are the conversations in that database, direct and group alike. The
 * stream is `imsg watch` on the same file, so it sees what this Mac's Messages
 * receives and nothing a different device received. There is no iMessage SDK,
 * so nothing else is reachable: no edits, reactions or files, and imsg's own
 * commands for those need SIP off or are unbuilt.
 */
export function imessageBackend(
  runner: ImsgRunner = spawn,
  watcher: ImsgWatchSpawner = spawnWatcher,
): AdapterBackend {
  async function imsg(args: string[]): Promise<ImsgRun> {
    const result = await runner(args);
    if (result.exitCode === 0) return result;
    const stated = `${result.stdout}\n${result.stderr}`;
    if (UNCERTAIN.test(stated))
      throw new AdapterError(
        "INTERNAL",
        "imsg could not confirm the send; its outcome is unknown, so it was not retried",
      );
    throw refused(stated);
  }

  /** Newest first, at most `limit` rows, all no newer than `end` when given. */
  async function history(
    chat: number,
    limit: number,
    end?: string,
  ): Promise<ImsgMessage[]> {
    const answer = await imsg([
      "history",
      "--chat-id",
      String(chat),
      "--limit",
      String(limit),
      ...(end === undefined ? [] : ["--end", end]),
      "--json",
    ]);
    return jsonLines<ImsgMessage>(answer.stdout);
  }

  return {
    async listRooms() {
      const answer = await imsg([
        "chats",
        "--limit",
        String(ROOM_LIMIT + 1),
        "--json",
      ]);
      const rows = jsonLines<ImsgChat>(answer.stdout);
      const rooms = rows.slice(0, ROOM_LIMIT).map(room);
      rooms.sort(byNewest);
      return { rooms, complete: rows.length <= ROOM_LIMIT };
    },

    async readMessages({ roomId, limit, before }: ReadMessagesRequest) {
      const chat = chatId(roomId);
      const wanted = before === undefined ? undefined : messageId(before);
      // One row more than asked for: the extra one proves an older one exists.
      const want = Math.min(limit, MAX_LIMIT) + 1;
      const seen: ImsgMessage[] = [];
      const known = new Set<string>();
      let end: string | undefined;
      // imsg pages by timestamp, not by id, so a before-id page walks back from
      // the newest row until enough rows older than that id are in hand.
      while (seen.length <= limit) {
        const batch = await history(chat, want, end);
        if (!batch.length) break;
        let fresh = 0;
        for (const row of batch) {
          const key = String(row.id);
          if (known.has(key)) continue;
          known.add(key);
          fresh++;
          if (wanted === undefined || row.id < wanted) seen.push(row);
        }
        const oldest = batch[batch.length - 1];
        if (batch.length < want || fresh === 0 || !oldest?.created_at) break;
        end = oldest.created_at;
      }
      return {
        messages: seen.slice(0, limit).reverse().map(message),
        hasEarlier: seen.length > limit,
      };
    },

    async messagesAfter(roomId, afterId) {
      const chat = chatId(roomId);
      const after = messageId(afterId);
      const newer: ImsgMessage[] = [];
      const known = new Set<string>();
      let end: string | undefined;
      // imsg pages by timestamp, not by id, so walk back from the newest row
      // until a row at or below the cursor proves everything newer is in hand.
      while (true) {
        const batch = await history(chat, MAX_LIMIT, end);
        if (!batch.length) break;
        let reached = false;
        for (const row of batch) {
          const key = String(row.id);
          if (known.has(key)) continue;
          known.add(key);
          if (row.id > after) newer.push(row);
          else reached = true;
        }
        const oldest = batch[batch.length - 1];
        if (reached || batch.length < MAX_LIMIT || !oldest?.created_at) break;
        end = oldest.created_at;
      }
      newer.sort((left, right) => left.id - right.id);
      return newer.map(message);
    },

    subscribe(listener: (update: StreamUpdate) => void) {
      let stopped = false;
      let failures = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let live: ImsgWatcher | undefined;
      let cursor: number | undefined;
      const read = (line: string) => {
        const row = watched(line);
        if (!row) return;
        failures = 0;
        if (cursor === undefined || row.id > cursor) cursor = row.id;
        listener({ event: "message", message: message(row) });
      };
      function later() {
        if (stopped) return;
        failures += 1;
        timer = setTimeout(
          open,
          Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(failures, 5)),
        );
      }
      function open() {
        if (stopped) return;
        let child: ImsgWatcher;
        try {
          child = watcher([
            "watch",
            "--json",
            ...(cursor === undefined ? [] : ["--since-rowid", String(cursor)]),
          ]);
        } catch {
          return later();
        }
        live = child;
        child.onLine(read);
        // imsg watch exits with the database it reads; a restart resumes strictly
        // after the last row handed over, so the stream outlives one exit intact.
        void child.exited.then(() => {
          if (stopped || live !== child) return;
          later();
        });
      }
      open();
      return () => {
        stopped = true;
        clearTimeout(timer);
        live?.stop();
        live = undefined;
      };
    },

    async send(roomId, text) {
      const chat = chatId(roomId);
      const answer = await imsg([
        "send",
        "--chat-id",
        String(chat),
        "--text",
        text,
        "--json",
      ]);
      const [status] = jsonLines<{ status?: string }>(answer.stdout);
      if (status?.status !== "sent")
        throw new AdapterError("INTERNAL", "imsg did not confirm the send");
      // imsg waits for the outgoing row before it exits 0, so the message is
      // stored; reading it back answers with the id the client will page on.
      const recent = await history(chat, READ_BACK);
      const stored = recent.find(
        (row) => row.is_from_me === true && row.text === text,
      );
      if (!stored)
        throw new AdapterError(
          "INTERNAL",
          "imsg sent the message, but its stored row could not be read back",
        );
      return message(stored);
    },
  };
}
