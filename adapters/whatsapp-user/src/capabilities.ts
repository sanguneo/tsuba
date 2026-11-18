import type { Capabilities } from "@tsuba/serve-kit";
import adapterPackage from "../package.json";

// WhatsApp documents no limit for a personal account's text message, and none
// was measured here. 2048 code points is at most 4096 UTF-16 units, the body
// limit of WhatsApp's own Cloud API, so it stays under any limit seen so far.
const MAX_TEXT = 2048;

export const CAPABILITIES: Capabilities = {
  provider: { id: "whatsapp-user", name: "WhatsApp" },
  account: { kind: "user" },
  adapter: { name: "tsuba-whatsapp-user", version: adapterPackage.version },
  features: {
    // Optional profile pictures; no message attachments.
    "attachments.read": {},
    "avatars.read": {},
    // Chats WhatsApp pushed since this process started (see complete:false).
    "rooms.list": {},
    // Served from memory; WhatsApp has no call for a room's older history.
    "messages.read": { paging: "before-id", maxLimit: 100 },
    // Live pushes only: a dropped connection has no cursor to resume from.
    "messages.stream": {
      resume: "none",
      events: ["message.edited", "message.deleted"],
    },
    // The server accepted the message; delivery is not confirmed.
    "messages.send": { maxLength: MAX_TEXT, receipt: "accepted" },
    // Quotes a message this process has seen; an unseen one refuses the send.
    "messages.reply": {},
  },
};
