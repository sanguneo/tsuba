import type { Capabilities, FeatureParams } from "@tsuba/serve-kit";
import adapterPackage from "../package.json";

// chat.postMessage: "limit the number of characters in the text field to 4,000"; Slack truncates past 40,000.
const MAX_TEXT = 4000;

/**
 * files.getUploadURLExternal takes up to 1 GB, but the adapter holds an upload
 * in memory while it sends it, so 50 MB is its own bound. The caption is the
 * share's initial_comment, a message's text, so it has a message's length.
 */
export const UPLOADS: FeatureParams["attachments.send"] = {
  maxBytes: 50 * 1024 * 1024,
  caption: true,
  captionMaxLength: MAX_TEXT,
  receipt: "stored",
};

/** Slack asks for this user scope to upload; without it files are not declared. */
export const UPLOAD_SCOPE = "files:write";

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

/** The declaration, with files only where the token can upload them. */
export function capabilities(uploads: boolean): Capabilities {
  return uploads
    ? {
        ...CAPABILITIES,
        features: { ...CAPABILITIES.features, "attachments.send": UPLOADS },
      }
    : CAPABILITIES;
}
