import { expect, test } from "bun:test";
import contract from "../contract/openapi.json";
import {
  type Capabilities,
  capabilityRevision,
  createHandler,
  serve,
  TokenError,
} from "../packages/serve-kit/src/index";
import { sample, schema, TOKEN } from "./fixtures";

const { handle } = createHandler({ token: TOKEN, capabilities: sample });
const bearer = { authorization: `Bearer ${TOKEN}` };

async function call(path: string, init: RequestInit = {}) {
  const response = await handle(new Request(`http://adapter${path}`, init));
  const text = await response.text();
  expect(text).not.toContain(TOKEN);
  return { response, body: JSON.parse(text) };
}

test("/health answers without a token", async () => {
  const { response, body } = await call("/health");
  expect(response.status).toBe(200);
  expect(schema("Health")(body)).toBe(true);
});

test("/capabilities refuses a missing, wrong or malformed token", async () => {
  for (const headers of [
    {},
    { authorization: `Bearer ${"x".repeat(TOKEN.length)}` },
    { authorization: TOKEN },
    { authorization: `Bearer  ${TOKEN}` },
  ]) {
    const { response, body } = await call("/capabilities", { headers });
    expect(response.status).toBe(401);
    expect(schema("ErrorEnvelope")(body)).toBe(true);
    expect(body.error.code).toBe("UNAUTHORIZED");
  }
});

test("an unknown route is refused like a protected one, then not found", async () => {
  expect((await call("/rooms")).response.status).toBe(401);
  const { response, body } = await call("/rooms", { headers: bearer });
  expect(response.status).toBe(404);
  expect(body.error.code).toBe("NOT_FOUND");
});

test("a wrong method is 405 and names the allowed one", async () => {
  const { response, body } = await call("/capabilities", {
    method: "POST",
    headers: bearer,
  });
  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("GET");
  expect(schema("ErrorEnvelope")(body)).toBe(true);
});

test("/capabilities answers the declaration in the contract's shape", async () => {
  const { response, body } = await call("/capabilities", { headers: bearer });
  expect(response.status).toBe(200);
  expect(schema("Capabilities")(body)).toBe(true);
  expect(body.contract.version).toBe(contract.info.version);
  expect(body.features).toEqual(sample.features);
  expect(body.revision).toBe(capabilityRevision(sample));
});

test("the contract rejects a declaration that breaks its own rules", () => {
  const validate = schema("Capabilities");
  const answer = (features: unknown) => ({
    ok: true,
    contract: { version: "0.1.0" },
    revision: "0123456789abcdef",
    ...sample,
    features,
  });
  expect(validate(answer(sample.features))).toBe(true);
  expect(validate(answer({ "messages.send": { maxLength: 0 } }))).toBe(false);
  expect(validate(answer({ "messages.read": { paging: "before-id" } }))).toBe(
    false,
  );
  expect(validate(answer({ "x-example.pins": "yes" }))).toBe(false);
});

test("the revision ignores key order and follows content", () => {
  const reordered: Capabilities = {
    features: {
      "messages.send": { receipt: "stored", maxLength: 4096 },
      "x-example.pins": {},
      "messages.read": { maxLimit: 100, paging: "before-id" },
      "rooms.list": {},
    },
    adapter: sample.adapter,
    account: sample.account,
    provider: sample.provider,
  };
  expect(capabilityRevision(reordered)).toBe(capabilityRevision(sample));
  const changed: Capabilities = {
    ...sample,
    features: {
      ...sample.features,
      "messages.read": { paging: "before-id", maxLimit: 50 },
    },
  };
  expect(capabilityRevision(changed)).not.toBe(capabilityRevision(sample));
});

test("a weak token is refused before anything listens", () => {
  for (const token of ["short", "contains a space inside it"])
    expect(() => createHandler({ token, capabilities: sample })).toThrow(
      TokenError,
    );
});

test("serves over real HTTP on loopback by default", async () => {
  const server = serve({ token: TOKEN, capabilities: sample, port: 0 });
  try {
    expect(server.hostname).toBe("127.0.0.1");
    const response = await fetch(new URL("/capabilities", server.url), {
      headers: bearer,
    });
    expect(response.status).toBe(200);
    expect(schema("Capabilities")(await response.json())).toBe(true);
  } finally {
    await server.stop(true);
  }
});
