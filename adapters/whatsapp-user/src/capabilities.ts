import type { Capabilities } from "@tsuba/serve-kit";
import adapterPackage from "../package.json";

// WhatsApp documents no limit for a personal account's text message, and none
// was measured here. 2048 code points is at most 4096 UTF-16 units, the body
// limit of WhatsApp's own Cloud API, so it stays under any limit seen so far.
const MAX_TEXT = 2048;
// https://faq.whatsapp.com/453914586839706/ — 64 MB video on slower
// connections; the shared multipart implementation buffers the whole upload,
// so apply this adapter ceiling to documents too (WhatsApp itself allows 2 GB).
const MAX_UPLOAD = 64_000_000;

export const CAPABILITIES: Capabilities = {
  provider: { id: "whatsapp-user", name: "WhatsApp" },
  account: { kind: "user" },
  adapter: { name: "tsuba-whatsapp-user", version: adapterPackage.version },
  features: {
    // Message attachments and optional profile pictures share /media.
    "attachments.read": {},
    "attachments.send": {
      maxBytes: MAX_UPLOAD,
      caption: true,
      // Conservative text budget; also applies to document captions.
      captionMaxLength: 1024,
      // Omit types: any MIME type can be sent as a document.
      receipt: "accepted",
    },
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
