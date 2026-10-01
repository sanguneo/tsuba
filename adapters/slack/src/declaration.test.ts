import { expect, test } from "bun:test";
import { createHandler } from "@tsuba/serve-kit";
import type { SlackCall } from "./api";
import { slackBackend } from "./backend";
import { CAPABILITIES } from "./capabilities";
import { emojiTable } from "./emoji";

test("serve-kit accepts the Slack declaration with its backend", () => {
  const call: SlackCall = async () => {
    throw new Error("No Slack in this test");
  };
  const backend = slackBackend(call, { userId: "U000000001" }, emojiTable([]), {
    onEvent: () => () => {},
  });
  const handler = createHandler({
    token: "synthetic-test-token-0123456789",
    capabilities: CAPABILITIES,
    backend,
  });
  expect(handler.routes).toContain("/read");
  expect(CAPABILITIES.account.kind).toBe("user");
  backend.stop();
});
