import type { Capabilities } from "@tsuba/serve-kit";
import adapterPackage from "../package.json";

const MAX_TEXT = 2000;

export const CAPABILITIES: Capabilities = {
  provider: { id: "discord-user", name: "Discord" },
  account: { kind: "user" },
  adapter: { name: "tsuba-discord-user", version: adapterPackage.version },
  features: {
    "rooms.list": {},
    "messages.read": { paging: "before-id", maxLimit: 100 },
    "messages.stream": {
      resume: "cursor",
      events: ["message.edited", "message.deleted"],
    },
    "messages.send": { maxLength: MAX_TEXT, receipt: "stored" },
    "messages.reply": {},
    "messages.edit": { maxLength: MAX_TEXT },
    "messages.delete": { forEveryone: true },
    "reactions.read": {},
    "reactions.send": {},
    "read.mark": {},
    "attachments.read": {},
  },
};
