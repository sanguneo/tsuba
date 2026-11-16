import { expect, test } from "bun:test";
import { createHandler } from "@tsuba/serve-kit";
import { whatsappUserBackend } from "./backend";
import { CAPABILITIES } from "./capabilities";
import { connectWhatsApp } from "./session";

test("serve-kit accepts the personal WhatsApp declaration with its backend", () => {
  const link = connectWhatsApp({
    open: () => ({
      onEvent() {},
      sendText: async () => undefined,
      close: async () => {},
    }),
    schedule: () => () => {},
  });
  const handler = createHandler({
    token: "synthetic-test-token-0123456789",
    capabilities: CAPABILITIES,
    backend: whatsappUserBackend(link),
  });
  expect(handler.routes).toContain("/send");
  expect(CAPABILITIES.account.kind).toBe("user");
});
