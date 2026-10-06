import { authorized, checkToken } from "./auth";
import {
  type AdapterBackend,
  AdapterError,
  type Cursor,
  errorEnvelope,
  type Message,
  type StreamUpdate,
} from "./backend";
import {
  type Capabilities,
  capabilityRevision,
  FEATURE_IDS,
  type FeatureId,
  type Features,
} from "./capabilities";
import {
  CONTRACT_VERSION,
  FEATURE_REQUIRES,
  OPTIONAL_EVENTS,
  RESERVED_FEATURES,
} from "./contract";
import { failure, ok } from "./envelope";
import { type ProviderIcon, prepareIcon } from "./icon";
import { mediaHeaders } from "./media";
import {
  type Registration,
  registrationFromEnv,
  startRegistration,
} from "./register";

export interface AdapterOptions {
  token: string;
  capabilities: Capabilities;
  backend?: AdapterBackend;
  icon?: ProviderIcon;
  pingIntervalMs?: number;
}

interface Route {
  method: "GET" | "POST";
  auth: boolean;
  answer: (request: Request) => Response | Promise<Response>;
}

type Body = Record<string, unknown>;

async function jsonBody(request: Request): Promise<Body> {
  const type = request.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  const input: unknown =
    type === "application/json"
      ? await request.json().catch(() => undefined)
      : undefined;
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new AdapterError("INVALID_REQUEST", "A JSON object body is required");
  return input as Body;
}

/** What the parts around the file may add to an upload's body. */
const UPLOAD_OVERHEAD = 64 * 1024;
const UPLOAD_FIELDS = new Set(["roomId", "file", "caption", "replyTo"]);

function tooLarge(maxBytes: number): AdapterError {
  return new AdapterError(
    "INVALID_REQUEST",
    `The file is larger than ${maxBytes} bytes`,
  );
}

/**
 * An upload's form, read no further than `maxBytes` plus its parts' overhead.
 * A declared length past that is refused unread; a body that runs past it
 * without saying so is cut off at the bound, so nothing is held unbounded.
 */
async function formBody(request: Request, maxBytes: number): Promise<Body> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";")[0]?.trim().toLowerCase() !== "multipart/form-data")
    throw new AdapterError(
      "INVALID_REQUEST",
      "A multipart/form-data body is required",
    );
  const limit = maxBytes + UPLOAD_OVERHEAD;
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) throw tooLarge(maxBytes);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const whole = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    whole.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const form = await new Response(whole, {
    headers: { "content-type": contentType },
  })
    .formData()
    .catch(() => undefined);
  if (!form)
    throw new AdapterError("INVALID_REQUEST", "The form could not be read");
  const body: Body = {};
  for (const [name, value] of form.entries()) {
    if (!UPLOAD_FIELDS.has(name))
      throw new AdapterError(
        "INVALID_REQUEST",
        "The form has a part the contract does not name",
      );
    if (Object.hasOwn(body, name))
      throw new AdapterError("INVALID_REQUEST", `${name} was given twice`);
    body[name] = value;
  }
  return body;
}

/** The last segment of a client's file name, never empty and never a path. */
function fileName(name: string): string {
  const base = name.split(/[\\/]/).pop()?.trim() ?? "";
  return [...(base || "file")].slice(0, 255).join("");
}

function idField(body: Body, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || !value)
    throw new AdapterError(
      "INVALID_REQUEST",
      `${name} must be a non-empty string`,
    );
  return value;
}

function textField(body: Body, maxLength: number): string {
  const { text } = body;
  if (typeof text !== "string" || !text || [...text].length > maxLength)
    throw new AdapterError(
      "INVALID_REQUEST",
      `text must be 1 to ${maxLength} code points`,
    );
  return text;
}

function emojisField(body: Body, max: number | undefined): string[] {
  const { emojis } = body;
  if (
    !Array.isArray(emojis) ||
    emojis.some(
      (emoji) => typeof emoji !== "string" || !emoji || emoji.length > 64,
    ) ||
    new Set(emojis).size !== emojis.length ||
    emojis.length > (max ?? Number.POSITIVE_INFINITY)
  )
    throw new AdapterError(
      "INVALID_REQUEST",
      "emojis must be distinct emoji, no more than maxPerMessage",
    );
  return emojis as string[];
}

export function createHandler(options: AdapterOptions) {
  const token = checkToken(options.token);
  const backend = options.backend ?? {};
  const features = options.capabilities.features;
  for (const id of FEATURE_IDS) {
    if (features[id] && RESERVED_FEATURES.has(id))
      throw new Error(
        `${id} is reserved: contract ${CONTRACT_VERSION} has no route for it`,
      );
  }
  for (const [feature, method] of [
    ["rooms.list", "listRooms"],
    ["messages.read", "readMessages"],
    ["messages.stream", "subscribe"],
    ["messages.send", "send"],
    ["attachments.send", "upload"],
    ["messages.edit", "edit"],
    ["messages.delete", "deleteMessage"],
    ["reactions.send", "react"],
    ["read.mark", "markRead"],
    ["attachments.read", "media"],
  ] as const) {
    if (Boolean(features[feature]) !== (typeof backend[method] === "function"))
      throw new Error(
        `${feature} must be declared iff ${method} is implemented`,
      );
  }
  const upload = features["attachments.send"];
  if (upload && upload.caption !== (upload.captionMaxLength !== undefined))
    throw new Error(
      "attachments.send declares captionMaxLength iff caption is true",
    );
  for (const [feature, needs] of FEATURE_REQUIRES) {
    for (const need of needs)
      if (features[feature] && !features[need])
        throw new Error(`${feature} is declared only beside ${need}`);
  }
  for (const event of features["messages.stream"]?.events ?? []) {
    const extension = /^x-[a-z][a-z0-9-]*\./.test(event);
    if (!OPTIONAL_EVENTS.has(event) && !extension)
      throw new Error(`messages.stream cannot declare the event ${event}`);
    const need = OPTIONAL_EVENTS.get(event);
    if (need && !features[need])
      throw new Error(`${event} is declared only beside ${need}`);
  }
  if (
    (features["messages.stream"]?.resume === "cursor") !==
    (typeof backend.messagesAfter === "function")
  )
    throw new Error(
      "Cursor resume must be declared iff messagesAfter is implemented",
    );
  const icon = options.icon ? prepareIcon(options.icon) : undefined;
  const provider = { ...options.capabilities.provider };
  delete provider.icon;
  if (icon) provider.icon = icon.version;
  const declaration: Capabilities = {
    ...options.capabilities,
    provider,
  };
  const capabilities = {
    ...declaration,
    revision: capabilityRevision(declaration),
  };
  const streams = new Set<() => void>();
  let writes = 0;
  let writeTail: Promise<void> = Promise.resolve();

  function unsupported(): Response {
    return failure("NOT_SUPPORTED", "This feature is not supported");
  }

  /**
   * The adapter's one write line. A place is taken before the body is read, so
   * a full line touches neither body nor backend; `prepare` validates, and the
   * write it returns runs only after the one before it has finished.
   */
  function write<K extends FeatureId>(
    id: K,
    prepare: (
      body: Body,
      feature: NonNullable<Features[K]>,
    ) => () => Promise<Response>,
    read: (
      request: Request,
      feature: NonNullable<Features[K]>,
    ) => Promise<Body> = jsonBody,
  ): (request: Request) => Promise<Response> {
    return async (request) => {
      const feature = features[id];
      if (!feature) return unsupported();
      if (writes >= 4) return failure("RATE_LIMITED", "The write line is full");
      writes++;
      const previous = writeTail;
      let release!: () => void;
      writeTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        const declared = feature as NonNullable<Features[K]>;
        const perform = prepare(await read(request, declared), declared);
        await previous;
        return await perform();
      } finally {
        // Preserve the chain even when an invalid queued body finishes early.
        await previous;
        writes--;
        release();
      }
    };
  }

  function stream(request: Request): Response {
    const feature = features["messages.stream"];
    if (!feature) return unsupported();
    const cursor: Cursor = Object.create(null);
    const since = new URL(request.url).searchParams.getAll("since");
    if (since.length && feature.resume !== "cursor")
      throw new AdapterError(
        "INVALID_REQUEST",
        "Cursor resume is not supported",
      );
    for (const item of since) {
      const split = item.lastIndexOf(":");
      if (split <= 0 || split === item.length - 1)
        throw new AdapterError("INVALID_REQUEST", "Malformed since cursor");
      const room = item.slice(0, split);
      if (Object.hasOwn(cursor, room))
        throw new AdapterError("INVALID_REQUEST", "Duplicate room cursor");
      cursor[room] = item.slice(split + 1);
    }
    if (streams.size >= 8)
      return failure("BUSY", "The stream limit has been reached");
    let close = () => {};
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let resuming = true;
        let unsubscribe: (() => void) | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const pending: StreamUpdate[] = [];
        const declared = new Set(feature.events ?? []);
        const encoder = new TextEncoder();
        function quietTimer() {
          clearTimeout(timer);
          if (!closed)
            timer = setTimeout(
              () => emit("ping", { ok: true }),
              options.pingIntervalMs ?? 25_000,
            );
        }
        function emit(event: string, payload: unknown) {
          if (closed) return;
          controller.enqueue(
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
            ),
          );
          quietTimer();
        }
        close = () => {
          if (closed) return;
          closed = true;
          clearTimeout(timer);
          request.signal.removeEventListener("abort", close);
          streams.delete(close);
          unsubscribe?.();
          if (!cancelled) controller.close();
        };
        function batch(
          messages: Message[],
          covered: Cursor = Object.create(null),
          publishCursor = true,
        ) {
          for (const message of messages) {
            emit("message", { ok: true, message });
            cursor[message.roomId] = message.id;
            covered[message.roomId] = message.id;
          }
          if (publishCursor && Object.keys(covered).length)
            emit("cursor", { ok: true, cursor: covered });
        }
        // Consecutive messages share one cursor; an undeclared event is dropped.
        function deliver(updates: StreamUpdate[]) {
          let run: Message[] = [];
          for (const update of updates) {
            if (update.event === "message") {
              run.push(update.message);
              continue;
            }
            if (!declared.has(update.event)) continue;
            batch(run);
            run = [];
            const { event, ...payload } = update;
            emit(event, { ok: true, ...payload });
          }
          batch(run);
        }
        streams.add(close);
        request.signal.addEventListener("abort", close, { once: true });
        emit("ready", {
          ok: true,
          resumed: since.length > 0,
          cursor: { ...cursor },
        });
        // Subscribe before fetching history so updates during resume cannot fall in a gap.
        try {
          unsubscribe = backend.subscribe?.((update) => {
            if (closed) return;
            if (resuming) pending.push(update);
            else deliver([update]);
          });
          if (closed) unsubscribe?.();
        } catch (error) {
          emit("error", errorEnvelope(error));
          close();
          return;
        }
        if (request.signal.aborted) {
          close();
          return;
        }
        void (async () => {
          try {
            const delivered = new Set<string>();
            const covered: Cursor = Object.create(null);
            for (const [roomId, afterId] of Object.entries(cursor)) {
              const messages =
                (await backend.messagesAfter?.(roomId, afterId)) ?? [];
              if (closed) return;
              for (const message of messages)
                delivered.add(JSON.stringify([message.roomId, message.id]));
              batch(messages, covered, false);
              covered[roomId] = cursor[roomId] ?? afterId;
            }
            // One resume cursor after all rooms, including rooms with no new messages.
            if (Object.keys(covered).length)
              emit("cursor", { ok: true, cursor: covered });
            resuming = false;
            deliver(
              pending.filter(
                (update) =>
                  update.event !== "message" ||
                  !delivered.has(
                    JSON.stringify([update.message.roomId, update.message.id]),
                  ),
              ),
            );
          } catch (error) {
            emit("error", errorEnvelope(error));
            close();
          }
        })();
      },
      cancel() {
        cancelled = true;
        close();
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  }

  const routes: Readonly<Record<string, Route>> = {
    "/health": { method: "GET", auth: false, answer: () => ok({}) },
    "/capabilities": {
      method: "GET",
      auth: true,
      answer: () =>
        ok({ contract: { version: CONTRACT_VERSION }, ...capabilities }),
    },
    "/icon": {
      method: "GET",
      auth: true,
      answer: () =>
        icon
          ? new Response(icon.bytes, {
              headers: {
                "content-type": icon.type,
                "content-security-policy": "default-src 'none'; sandbox",
                "x-content-type-options": "nosniff",
                "cache-control": "private, max-age=86400",
              },
            })
          : failure("NOT_FOUND", "This provider has no icon"),
    },
    "/rooms": {
      method: "GET",
      auth: true,
      answer: async () => {
        if (!features["rooms.list"]) return unsupported();
        const answer = await backend.listRooms?.();
        for (const room of answer?.rooms ?? [])
          for (const id of Object.keys(room.features ?? {}))
            if (!Object.hasOwn(features, id))
              throw new Error(`A room cannot add the undeclared feature ${id}`);
        return ok({ ...answer });
      },
    },
    "/messages": {
      method: "GET",
      auth: true,
      answer: async (request) => {
        const feature = features["messages.read"];
        if (!feature) return unsupported();
        const query = new URL(request.url).searchParams;
        const roomId = query.get("roomId");
        const rawLimit = query.get("limit");
        const limit =
          rawLimit === null ? Math.min(50, feature.maxLimit) : Number(rawLimit);
        const before = query.get("before");
        if (
          !roomId ||
          (rawLimit !== null && !/^\d+$/.test(rawLimit)) ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > feature.maxLimit ||
          (before !== null && (!before || feature.paging !== "before-id"))
        )
          throw new AdapterError("INVALID_REQUEST", "Invalid message query");
        return ok({
          ...(await backend.readMessages?.({
            roomId,
            limit,
            ...(before === null ? {} : { before }),
          })),
        });
      },
    },
    "/media": {
      method: "GET",
      auth: true,
      answer: async (request) => {
        if (!features["attachments.read"] || !backend.media)
          return unsupported();
        const id = new URL(request.url).searchParams.get("id");
        if (!id || id.length > 512)
          throw new AdapterError("INVALID_REQUEST", "Invalid media id");
        const file = await backend.media(id, request.signal);
        return new Response(file.body, { headers: mediaHeaders(file) });
      },
    },
    "/stream": { method: "GET", auth: true, answer: stream },
    "/send": {
      method: "POST",
      auth: true,
      answer: write("messages.send", (body, feature) => {
        const roomId = idField(body, "roomId");
        const text = textField(body, feature.maxLength);
        const replyTo =
          body.replyTo === undefined ? undefined : idField(body, "replyTo");
        if (replyTo !== undefined && !features["messages.reply"])
          throw new AdapterError("NOT_SUPPORTED", "Replies are not supported");
        return async () =>
          ok({
            message: await backend.send?.(
              roomId,
              text,
              replyTo === undefined ? {} : { replyTo },
            ),
          });
      }),
    },
    "/upload": {
      method: "POST",
      auth: true,
      answer: write(
        "attachments.send",
        (body, feature) => {
          const roomId = idField(body, "roomId");
          const { file } = body;
          if (!(file instanceof File))
            throw new AdapterError("INVALID_REQUEST", "file must be one file");
          if (file.size < 1 || file.size > feature.maxBytes)
            throw new AdapterError(
              "INVALID_REQUEST",
              `file must be 1 to ${feature.maxBytes} bytes`,
            );
          const type = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
          if (feature.types && !feature.types.includes(type))
            throw new AdapterError(
              "INVALID_REQUEST",
              `file must be ${feature.types.join(", ")}`,
            );
          let caption: string | undefined;
          if (body.caption !== undefined) {
            const max = feature.caption ? (feature.captionMaxLength ?? 0) : 0;
            caption = body.caption as string;
            if (
              typeof caption !== "string" ||
              !caption ||
              [...caption].length > max
            )
              throw new AdapterError(
                "INVALID_REQUEST",
                feature.caption
                  ? `caption must be 1 to ${max} code points`
                  : "This adapter sends files without captions",
              );
          }
          const replyTo =
            body.replyTo === undefined ? undefined : idField(body, "replyTo");
          if (replyTo !== undefined && !features["messages.reply"])
            throw new AdapterError(
              "NOT_SUPPORTED",
              "Replies are not supported",
            );
          return async () =>
            ok({
              message: await backend.upload?.(
                roomId,
                {
                  name: fileName(file.name),
                  type: file.type || "application/octet-stream",
                  bytes: new Uint8Array(await file.arrayBuffer()),
                },
                {
                  ...(caption === undefined ? {} : { caption }),
                  ...(replyTo === undefined ? {} : { replyTo }),
                },
              ),
            });
        },
        (request, feature) => formBody(request, feature.maxBytes),
      ),
    },
    "/edit": {
      method: "POST",
      auth: true,
      answer: write("messages.edit", (body, feature) => {
        const roomId = idField(body, "roomId");
        const messageId = idField(body, "messageId");
        const text = textField(body, feature.maxLength);
        return async () =>
          ok({ message: await backend.edit?.(roomId, messageId, text) });
      }),
    },
    "/delete": {
      method: "POST",
      auth: true,
      answer: write("messages.delete", (body) => {
        const roomId = idField(body, "roomId");
        const messageId = idField(body, "messageId");
        return async () => {
          await backend.deleteMessage?.(roomId, messageId);
          return ok({});
        };
      }),
    },
    "/react": {
      method: "POST",
      auth: true,
      answer: write("reactions.send", (body, feature) => {
        const roomId = idField(body, "roomId");
        const messageId = idField(body, "messageId");
        const emojis = emojisField(body, feature.maxPerMessage);
        return async () =>
          ok({
            reactions: (await backend.react?.(roomId, messageId, emojis)) ?? [],
          });
      }),
    },
    "/read": {
      method: "POST",
      auth: true,
      answer: write("read.mark", (body) => {
        const roomId = idField(body, "roomId");
        const messageId = idField(body, "messageId");
        return async () => {
          await backend.markRead?.(roomId, messageId);
          return ok({});
        };
      }),
    },
  };

  async function handle(request: Request): Promise<Response> {
    const route = routes[new URL(request.url).pathname];
    if (route?.auth !== false && !authorized(request, token))
      return failure("UNAUTHORIZED", "A valid bearer token is required");
    if (!route) return failure("NOT_FOUND", "No such route");
    if (request.method !== route.method)
      return failure("METHOD_NOT_ALLOWED", `Use ${route.method}`, {
        allow: route.method,
      });
    try {
      return await route.answer(request);
    } catch (error) {
      const envelope = errorEnvelope(error);
      return failure(envelope.error.code, envelope.error.message);
    }
  }
  return {
    handle,
    routes: Object.keys(routes),
    stop: () => {
      for (const close of streams) close();
    },
  };
}

export function serve(
  options: AdapterOptions & {
    port: number;
    hostname?: string;
    /** Bun's idle limit for ordinary requests, in seconds (Bun's default is 10). */
    idleTimeout?: number;
    /**
     * Registration with saya; by default from SAYA_REGISTER_URL and
     * SAYA_REGISTER_TOKEN (register.ts), `false` to never register.
     */
    register?: Registration | false;
  },
) {
  const handler = createHandler(options);
  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port,
    ...(options.idleTimeout === undefined
      ? {}
      : { idleTimeout: options.idleTimeout }),
    fetch(request, server) {
      // A quiet stream is idle between pings; Bun would close it at its idle
      // limit, ending the stream without the contract's `error` event.
      if (new URL(request.url).pathname === "/stream")
        server.timeout(request, 0);
      return handler.handle(request);
    },
  });
  const registration =
    options.register === false
      ? undefined
      : (options.register ??
        registrationFromEnv(process.env, {
          id: options.capabilities.provider.id,
          port: server.port ?? options.port,
          token: options.token,
        }));
  const registered = registration ? startRegistration(registration) : undefined;
  const stop = server.stop.bind(server);
  server.stop = async (closeActiveConnections?: boolean) => {
    handler.stop();
    await registered?.stop();
    return stop(closeActiveConnections);
  };
  return server;
}
