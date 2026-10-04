import { expect, test } from "bun:test";
import {
  type AdapterBackend,
  AdapterError,
  type Capabilities,
  createHandler,
  type UploadFile,
  type UploadOptions,
} from "../packages/serve-kit/src/index";
import { fakeBackend, message, sample, schema, TOKEN } from "./fixtures";
import { bounded, deferred } from "./harness/barriers";

const bearer = { authorization: `Bearer ${TOKEN}` };
const uploads: Capabilities = {
  ...sample,
  features: {
    ...sample.features,
    "messages.reply": {},
    "attachments.send": {
      maxBytes: 16,
      caption: true,
      captionMaxLength: 8,
      receipt: "stored",
    },
  },
};

interface Sent {
  roomId: string;
  file: UploadFile;
  options: UploadOptions;
}

function uploader(capabilities = uploads, fail?: unknown) {
  const sent: Sent[] = [];
  const backend: AdapterBackend = {
    ...fakeBackend(),
    upload: async (roomId, file, options) => {
      if (fail !== undefined) throw fail;
      sent.push({ roomId, file, options });
      return { ...message, roomId, kind: "media", fromMe: true };
    },
  };
  return {
    sent,
    backend,
    handle: createHandler({ token: TOKEN, capabilities, backend }).handle,
  };
}

function form(parts: Record<string, string | File>): FormData {
  const body = new FormData();
  for (const [name, value] of Object.entries(parts)) body.append(name, value);
  return body;
}

const png = () =>
  new File([new TextEncoder().encode("synthetic")], "a.png", {
    type: "image/png",
  });

function post(body: FormData | string, headers: Record<string, string> = {}) {
  return new Request("http://adapter/upload", {
    method: "POST",
    headers: { ...bearer, ...headers },
    body,
  });
}

async function refused(
  response: Response,
  status = 400,
  code = "INVALID_REQUEST",
) {
  expect(response.status).toBe(status);
  const body = (await response.json()) as {
    error: { code: string; message: string };
  };
  expect(schema("ErrorEnvelope")(body)).toBe(true);
  expect(body.error.code).toBe(code);
  return body;
}

test("a file reaches the backend with its name, type, bytes, caption and reply", async () => {
  const { handle, sent } = uploader();
  const response = await handle(
    post(
      form({
        roomId: "example:room",
        file: png(),
        caption: "hi",
        replyTo: "1",
      }),
    ),
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(schema("SendAnswer")(body)).toBe(true);
  expect(sent).toHaveLength(1);
  const [only] = sent;
  expect(only?.roomId).toBe("example:room");
  expect(only?.file.name).toBe("a.png");
  expect(only?.file.type).toBe("image/png");
  expect(new TextDecoder().decode(only?.file.bytes)).toBe("synthetic");
  expect(only?.options).toEqual({ caption: "hi", replyTo: "1" });
});

test("the name the backend sees is never a path", async () => {
  const { handle, sent } = uploader();
  const file = new File(["x"], "../folder\\b.png", { type: "image/png" });
  await handle(post(form({ roomId: "r", file })));
  expect(sent[0]?.file.name).toBe("b.png");
});

test("every wrong form is refused and sends nothing", async () => {
  const { handle, sent } = uploader();
  const cases: Record<string, () => Request> = {
    json: () =>
      post(JSON.stringify({ roomId: "r" }), {
        "content-type": "application/json",
      }),
    "no file": () => post(form({ roomId: "r" })),
    "file as text": () => post(form({ roomId: "r", file: "not a file" })),
    "empty file": () =>
      post(form({ roomId: "r", file: new File([], "e.png") })),
    "file past maxBytes": () =>
      post(form({ roomId: "r", file: new File(["x".repeat(17)], "big.png") })),
    "unknown part": () => post(form({ roomId: "r", file: png(), text: "hi" })),
    "no room": () => post(form({ file: png() })),
    "caption past its limit": () =>
      post(form({ roomId: "r", file: png(), caption: "123456789" })),
  };
  for (const request of Object.values(cases))
    await refused(await handle(request()));
  const twice = new FormData();
  twice.append("roomId", "r");
  twice.append("roomId", "s");
  twice.append("file", png());
  await refused(await handle(post(twice)));
  expect(sent).toHaveLength(0);
});

test("a caption is refused where the adapter declares none", async () => {
  const { handle, sent } = uploader({
    ...uploads,
    features: {
      ...uploads.features,
      "attachments.send": { maxBytes: 16, caption: false, receipt: "stored" },
    },
  });
  const body = await refused(
    await handle(post(form({ roomId: "r", file: png(), caption: "hi" }))),
  );
  expect(body.error.message).toContain("without captions");
  expect(sent).toHaveLength(0);
});

test("a declared length past the bound is refused before the body is read", async () => {
  const { handle } = uploader();
  let pulled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled = true;
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const response = await handle(
    new Request("http://adapter/upload", {
      method: "POST",
      headers: {
        ...bearer,
        "content-type": "multipart/form-data; boundary=b",
        "content-length": String(1024 * 1024),
      },
      body: stream,
    }),
  );
  const body = await refused(response);
  expect(body.error.message).toContain("larger than 16 bytes");
  expect(pulled).toBe(false);
});

test("a body that runs past the bound without saying so is cut off", async () => {
  const { handle, sent } = uploader();
  const huge = new File([new Uint8Array(70 * 1024)], "huge.bin");
  const body = await refused(
    await handle(post(form({ roomId: "r", file: huge }))),
  );
  expect(body.error.message).toContain("larger than 16 bytes");
  expect(sent).toHaveLength(0);
});

test("a reply without messages.reply is 501 and sends nothing", async () => {
  const features = { ...uploads.features };
  delete features["messages.reply"];
  const { handle, sent } = uploader({ ...uploads, features });
  await refused(
    await handle(post(form({ roomId: "r", file: png(), replyTo: "1" }))),
    501,
    "NOT_SUPPORTED",
  );
  expect(sent).toHaveLength(0);
});

test("the declaration and the backend must agree before anything listens", () => {
  const { backend } = uploader();
  const { upload: _upload, ...withoutUpload } = backend;
  expect(() =>
    createHandler({
      token: TOKEN,
      capabilities: uploads,
      backend: withoutUpload,
    }),
  ).toThrow("attachments.send must be declared iff upload is implemented");
  expect(() =>
    createHandler({ token: TOKEN, capabilities: sample, backend }),
  ).toThrow("attachments.send must be declared iff upload is implemented");
  for (const declared of [
    { maxBytes: 16, caption: true, receipt: "stored" as const },
    {
      maxBytes: 16,
      caption: false,
      captionMaxLength: 8,
      receipt: "stored" as const,
    },
  ])
    expect(() =>
      createHandler({
        token: TOKEN,
        capabilities: {
          ...uploads,
          features: { ...uploads.features, "attachments.send": declared },
        },
        backend,
      }),
    ).toThrow("captionMaxLength iff caption");
});

test("a refusal the messenger states keeps its code, and anything else is INTERNAL", async () => {
  await refused(
    await uploader(uploads, new AdapterError("FORBIDDEN", "Not here")).handle(
      post(form({ roomId: "r", file: png() })),
    ),
    403,
    "FORBIDDEN",
  );
  const body = await refused(
    await uploader(uploads, new Error("synthetic secret detail")).handle(
      post(form({ roomId: "r", file: png() })),
    ),
    500,
    "INTERNAL",
  );
  expect(body.error.message).not.toContain("synthetic secret detail");
});

test("files wait in the one write line texts use", async () => {
  const gate = deferred<void>();
  const { backend } = uploader();
  backend.send = async (roomId, text) => {
    await gate.promise;
    return { ...message, roomId, text, fromMe: true };
  };
  const { handle } = createHandler({
    token: TOKEN,
    capabilities: uploads,
    backend,
  });
  const texts = Array.from({ length: 4 }, () =>
    handle(
      new Request("http://adapter/send", {
        method: "POST",
        headers: { ...bearer, "content-type": "application/json" },
        body: JSON.stringify({ roomId: "r", text: "hi" }),
      }),
    ),
  );
  await refused(
    await handle(post(form({ roomId: "r", file: png() }))),
    429,
    "RATE_LIMITED",
  );
  gate.resolve();
  for (const answer of await bounded(Promise.all(texts), "queued texts"))
    expect(answer.status).toBe(200);
});
