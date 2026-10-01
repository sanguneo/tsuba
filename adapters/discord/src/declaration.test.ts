import { expect, test } from "bun:test";
import { createHandler } from "@tsuba/serve-kit";
import type { Client } from "discord.js";
import { discordBackend } from "./backend";
import { CAPABILITIES } from "./capabilities";

test("serve-kit accepts the Discord declaration with its backend", () => {
  const client = {
    user: { id: "100000000000000001" },
  } as unknown as Client<true>;
  const handler = createHandler({
    token: "synthetic-test-token-0123456789",
    capabilities: CAPABILITIES,
    backend: discordBackend(client),
  });
  expect(handler.routes).toContain("/react");
  expect(CAPABILITIES.account.kind).toBe("bot");
  expect(CAPABILITIES.features["read.mark"]).toBeUndefined();
});
