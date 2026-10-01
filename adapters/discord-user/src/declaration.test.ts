import { expect, test } from "bun:test";
import { createHandler } from "@tsuba/serve-kit";
import { discordUserBackend } from "./backend";
import { CAPABILITIES } from "./capabilities";

test("serve-kit accepts the personal Discord declaration with its backend", () => {
  const handler = createHandler({
    token: "synthetic-test-token-0123456789",
    capabilities: CAPABILITIES,
    backend: discordUserBackend("synthetic-discord-user-token"),
  });
  expect(handler.routes).toContain("/react");
  expect(handler.routes).toContain("/read");
  expect(CAPABILITIES.account.kind).toBe("user");
});
