import { authorized, checkToken } from "./auth";
import {
  type AdapterBackend,
  AdapterError,
  type Cursor,
  errorEnvelope,
  type Message,
} from "./backend";
import {
  type Capabilities,
  capabilityRevision,
  FEATURE_IDS,
} from "./capabilities";
import { CONTRACT_VERSION, RESERVED_FEATURES } from "./contract";
import { failure, ok } from "./envelope";
import { mediaHeaders } from "./media";

export interface AdapterOptions {
  token: string;
  capabilities: Capabilities;
  backend?: AdapterBackend;
  pingIntervalMs?: number;
}

interface Route {
  method: "GET" | "POST";
  auth: boolean;
  answer: (request: Request) => Response | Promise<Response>;
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
    ["attachments.read", "media"],
  ] as const) {
    if (Boolean(features[feature]) !== (typeof backend[method] === "function"))
      throw new Error(
        `${feature} must be declared iff ${method} is implemented`,
      );
  }
  if (
    (features["messages.stream"]?.resume === "cursor") !==
    (typeof backend.messagesAfter === "function")
  )
    throw new Error(
      "Cursor resume must be declared iff messagesAfter is implemented",
    );
  const capabilities = {
    ...options.capabilities,
    revision: capabilityRevision(options.capabilities),
  };
  const streams = new Set<() => void>();
  let sends = 0;
  let sendTail: Promise<void> = Promise.resolve();

  function unsupported(): Response {
    return failure("NOT_SUPPORTED", "This feature is not supported");
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
        const pending: Message[] = [];
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
        streams.add(close);
        request.signal.addEventListener("abort", close, { once: true });
        emit("ready", {
          ok: true,
          resumed: since.length > 0,
          cursor: { ...cursor },
        });
        // Subscribe before fetching history so updates during resume cannot fall in a gap.
        try {
          unsubscribe = backend.subscribe?.((message) => {
            if (closed) return;
            if (resuming) pending.push(message);
            else batch([message]);
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
            batch(
              pending.filter(
                (message) =>
                  !delivered.has(JSON.stringify([message.roomId, message.id])),
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
      answer: async (request) => {
        const feature = features["messages.send"];
        if (!feature) return unsupported();
        // Reserve before reading the body: a full line touches neither body nor backend.
        if (sends >= 4) return failure("RATE_LIMITED", "The send line is full");
        sends++;
        const previous = sendTail;
        let release!: () => void;
        sendTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        try {
          let input: unknown;
          try {
            if (
              request.headers
                .get("content-type")
                ?.split(";")[0]
                ?.trim()
                .toLowerCase() !== "application/json"
            )
              throw new Error();
            input = await request.json();
          } catch {
            throw new AdapterError(
              "INVALID_REQUEST",
              "A JSON body is required",
            );
          }
          if (
            !input ||
            typeof input !== "object" ||
            !("roomId" in input) ||
            typeof input.roomId !== "string" ||
            !input.roomId ||
            !("text" in input) ||
            typeof input.text !== "string" ||
            !input.text ||
            [...input.text].length > feature.maxLength
          )
            throw new AdapterError("INVALID_REQUEST", "Invalid send body");
          await previous;
          const message = await backend.send?.(input.roomId, input.text);
          return ok({ message });
        } finally {
          // Preserve the chain even when an invalid queued body finishes early.
          await previous;
          sends--;
          release();
        }
      },
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
  options: AdapterOptions & { port: number; hostname?: string },
) {
  const handler = createHandler(options);
  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port,
    fetch: handler.handle,
  });
  const stop = server.stop.bind(server);
  server.stop = (closeActiveConnections?: boolean) => {
    handler.stop();
    return stop(closeActiveConnections);
  };
  return server;
}
