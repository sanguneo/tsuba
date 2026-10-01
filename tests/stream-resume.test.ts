import { expect, test } from "bun:test";
import {
  type AdapterBackend,
  type Capabilities,
  createHandler,
  type Message,
} from "../packages/serve-kit/src/index";
import { message, sample, schema, TOKEN } from "./fixtures";
import { bounded, deferred } from "./harness/barriers";

const bearer = { authorization: `Bearer ${TOKEN}` };
const capabilities: Capabilities = {
  ...sample,
  features: { "messages.stream": { resume: "cursor" } },
};

async function frames(response: Response) {
  const text = await bounded(response.text(), "finished SSE response");
  return parseFrames(text);
}
function parseFrames(text: string) {
  return text
    .trim()
    .split("\n\n")
    .map((frame) => {
      const [event, data] = frame.split("\n");
      if (!event || !data) throw new Error("Malformed SSE frame");
      const name = event.slice(7);
      const payload = JSON.parse(data.slice(6));
      const schemas: Record<string, string> = {
        ready: "StreamReady",
        message: "StreamMessage",
        cursor: "StreamCursor",
        error: "ErrorEnvelope",
      };
      const type = schemas[name];
      if (!type) throw new Error("Unexpected SSE event");
      expect(schema(type)(payload)).toBe(true);
      return { name, payload };
    });
}

test("repeated since covers every room, with one cursor after the complete resumed batch", async () => {
  const first: Message = { ...message, id: "2", roomId: "provider:room" };
  const second: Message = { ...first, id: "3" };
  const calls: [string, string][] = [];
  const backend: AdapterBackend = {
    subscribe: () => () => {},
    messagesAfter: async (roomId, id) => {
      calls.push([roomId, id]);
      if (roomId === "empty") return [];
      return [first, second];
    },
  };
  const handler = createHandler({ token: TOKEN, capabilities, backend });
  const response = await handler.handle(
    new Request("http://adapter/stream?since=provider:room:1&since=empty:4", {
      headers: bearer,
    }),
  );
  if (!response.body) throw new Error("Missing SSE body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("event: cursor\n") || !text.endsWith("\n\n")) {
      const chunk = await bounded(reader.read(), "resume cursor published");
      if (chunk.done) throw new Error("Stream ended before cursor");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel();
    handler.stop();
  }
  const result = parseFrames(text);
  expect(calls).toEqual([
    ["provider:room", "1"],
    ["empty", "4"],
  ]);
  expect(result.map((frame) => frame.name)).toEqual([
    "ready",
    "message",
    "message",
    "cursor",
  ]);
  expect(result.at(-1)?.payload.cursor).toEqual({
    "provider:room": "3",
    empty: "4",
  });
});

test("canceling the response body releases the stream subscription", async () => {
  const cleaned = deferred<void>();
  const backend: AdapterBackend = {
    subscribe: () => () => cleaned.resolve(),
    messagesAfter: async () => [],
  };
  const handler = createHandler({ token: TOKEN, capabilities, backend });
  try {
    const response = await handler.handle(
      new Request("http://adapter/stream", { headers: bearer }),
    );
    if (!response.body) throw new Error("Missing SSE body");
    await bounded(response.body.cancel(), "cancel response body");
    await bounded(cleaned.promise, "cancel cleanup");
  } finally {
    handler.stop();
  }
});

test("abort during resume unsubscribes and does not publish late history", async () => {
  const entered = deferred<void>();
  const history = deferred<Message[]>();
  const cleaned = deferred<void>();
  const backend: AdapterBackend = {
    subscribe: () => () => cleaned.resolve(),
    messagesAfter: async () => {
      entered.resolve();
      return bounded(history.promise, "history release");
    },
  };
  const handler = createHandler({ token: TOKEN, capabilities, backend });
  const abort = new AbortController();
  try {
    const response = await handler.handle(
      new Request("http://adapter/stream?since=room:1", {
        headers: bearer,
        signal: abort.signal,
      }),
    );
    await bounded(entered.promise, "resume started");
    const body = frames(response);
    abort.abort();
    await bounded(cleaned.promise, "abort cleanup");
    history.resolve([message]);
    expect((await body).map((frame) => frame.name)).toEqual(["ready"]);
  } finally {
    history.resolve([]);
    handler.stop();
  }
});
