import type { Capabilities } from "@tsuba/serve-kit";
import adapterPackage from "../package.json";

// Discord caps at 2000 UTF-16 units; 1000 code points stays below that for astral text too.
const MAX_TEXT = 1000;
// Discord's upload limit for a server without boosts is 10 MiB; boosted
// servers allow more, but the default is what every channel is known to take.
const MAX_UPLOAD = 10 * 1024 * 1024;

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
    "attachments.send": {
      maxBytes: MAX_UPLOAD,
      caption: true,
      captionMaxLength: MAX_TEXT,
      receipt: "stored",
    },
    "messages.reply": {},
    // Discord sets no age limit on edits.
    "messages.edit": { maxLength: MAX_TEXT },
    // Discord removes a deleted message for everyone.
    "messages.delete": { forEveryone: true },
    "reactions.read": {},
    "reactions.send": { maxPerMessage: 20 },
    "attachments.read": {},
    // Custom guild/user avatar hashes identify pictures served through /media.
    "avatars.read": {},
  },
};
