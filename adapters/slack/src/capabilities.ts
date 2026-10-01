import type { Capabilities } from "@tsuba/serve-kit";
import adapterPackage from "../package.json";

// chat.postMessage: "limit the number of characters in the text field to 4,000"; Slack truncates past 40,000.
const MAX_TEXT = 4000;

export const CAPABILITIES: Capabilities = {
  provider: { id: "slack", name: "Slack" },
  account: { kind: "user" },
  adapter: { name: "tsuba-slack", version: adapterPackage.version },
  features: {
    "rooms.list": {},
    // conversations.history allows up to 999; 100 keeps each page cheap.
    "messages.read": { paging: "before-id", maxLimit: 100 },
    "messages.stream": {
      resume: "cursor",
      events: ["message.edited", "message.deleted", "reactions.updated"],
    },
    "messages.send": { maxLength: MAX_TEXT, receipt: "stored" },
    "messages.reply": {},
    // The workspace may set an edit window; Slack refuses past it (403 FORBIDDEN).
    "messages.edit": { maxLength: MAX_TEXT },
    "messages.delete": { forEveryone: true },
    "reactions.read": {},
    "reactions.send": {},
    "read.mark": {},
    "attachments.read": {},
    // users.info supplies profile images; /media serves URL-versioned opaque ids.
    "avatars.read": {},
  },
};
