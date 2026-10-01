import type { Capabilities } from "@tsuba/serve-kit";
import adapterPackage from "../package.json";

// Discord caps at 2000 UTF-16 units; 1000 code points also fits astral text.
const MAX_TEXT = 1000;

export const CAPABILITIES: Capabilities = {
  provider: { id: "discord-user", name: "Discord-Personal" },
  account: { kind: "user" },
  adapter: { name: "tsuba-discord-user", version: adapterPackage.version },
  features: {
    // Standard server text channels, direct messages and group direct messages.
    "rooms.list": {},
    // Discord returns at most 100 messages per REST page.
    "messages.read": { paging: "before-id", maxLimit: 100 },
    // Gateway updates; reconnect cursors read new messages through REST.
    "messages.stream": {
      resume: "cursor",
      events: ["message.edited", "message.deleted"],
    },
    // REST returns the stored message, not merely a submitted input.
    "messages.send": { maxLength: MAX_TEXT, receipt: "stored" },
    // A missing referenced message refuses the send.
    "messages.reply": {},
    // Own messages have no edit age limit.
    "messages.edit": { maxLength: MAX_TEXT },
    // Discord removes deleted messages for everyone.
    "messages.delete": { forEveryone: true },
    // Only Unicode emoji reactions are represented by the shared contract.
    "reactions.read": {},
    // Replace this account's set; Discord allows 20 distinct kinds per message.
    "reactions.send": { maxPerMessage: 20 },
    // User accounts can acknowledge messages even without an unread count.
    "read.mark": {},
    // Re-read signed URLs and fetch bytes only from Discord's HTTPS CDN.
    "attachments.read": {},
  },
};
