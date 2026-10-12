import { expect, test } from "bun:test";
import { createHandler } from "@tsuba/serve-kit";
import { memoBackend } from "./backend";
import { CAPABILITIES } from "./capabilities";

const TOKEN = "synthetic-test-token-0123456789";

test("serve-kit accepts the declaration with its backend", () => {
  const handler = createHandler({
    token: TOKEN,
    capabilities: CAPABILITIES,
    backend: memoBackend(),
  });
  expect(handler.routes).toContain("/send");
});

test("a sent message is read back, oldest first", async () => {
  const backend = memoBackend();
  await backend.send?.("notes", "하나", {});
  await backend.send?.("notes", "둘", {});
  const page = await backend.readMessages?.({ roomId: "notes", limit: 1 });
  expect(page?.messages.map((message) => message.text)).toEqual(["둘"]);
  expect(page?.hasEarlier).toBe(true);
  await expect(backend.send?.("elsewhere", "x", {})).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});
