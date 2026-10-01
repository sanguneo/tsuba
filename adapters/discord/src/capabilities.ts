import type { Capabilities } from "@tsuba/serve-kit";
import adapterPackage from "../package.json";

// Discord's documented limit; the unit (code points or UTF-16) is not yet measured.
const MAX_TEXT = 2000;

export const CAPABILITIES: Capabilities = {
  provider: { id: "discord", name: "Discord" },
  account: { kind: "bot" },
  adapter: { name: "tsuba-discord", version: adapterPackage.version },
  features: {
    "rooms.list": {},
    "messages.read": { paging: "before-id", maxLimit: 100 },
    "messages.stream": {
      resume: "cursor",
      events: ["message.edited", "message.deleted", "reactions.updated"],
    },
    "messages.send": { maxLength: MAX_TEXT, receipt: "stored" },
    "messages.reply": {},
    // Discord sets no age limit on edits.
    "messages.edit": { maxLength: MAX_TEXT },
    // Discord removes a deleted message for everyone.
    "messages.delete": { forEveryone: true },
    "reactions.read": {},
    "reactions.send": {},
    "attachments.read": {},
  },
};
