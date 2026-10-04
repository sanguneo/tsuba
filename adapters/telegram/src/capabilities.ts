import type { TelegramClient } from "@mtcute/bun";
import type { Capabilities } from "@tsuba/serve-kit";
import adapterPackage from "../package.json";

// Measured on the user path: 4096 Unicode code points, not UTF-16 units.
const MAX_TEXT = 4096;
// Telegram takes up to 2 GB from a user, but the adapter holds an upload in
// memory while it sends it, so 50 MB is the adapter's own bound.
const MAX_UPLOAD = 50 * 1024 * 1024;

/**
 * Declare only the features implemented end to end. The limits that differ by
 * account or change with Telegram's settings are read from Telegram at start:
 * the edit window from `help.getConfig` and the reactions one account may
 * leave on a message from the app config (premium accounts may leave more).
 */
export async function capabilities(tg: TelegramClient): Promise<Capabilities> {
  const config = await tg.call({ _: "help.getConfig" });
  const me = await tg.getMe();
  const reactions = await tg.appConfig.getField(
    me.isPremium ? "reactions_user_max_premium" : "reactions_user_max_default",
    1,
  );
  // 1024 for most accounts and 4096 for premium ones, read from the app config.
  const caption = await tg.appConfig.getField(
    me.isPremium
      ? "caption_length_limit_premium"
      : "caption_length_limit_default",
    1024,
  );
  return {
    provider: { id: "telegram", name: "Telegram" },
    account: { kind: "user" },
    adapter: { name: "tsuba-telegram", version: adapterPackage.version },
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
        captionMaxLength: caption,
        receipt: "stored",
      },
      "messages.reply": {},
      "messages.edit": {
        maxLength: MAX_TEXT,
        maxAgeSeconds: config.editTimeLimit,
      },
      // Own messages, revoked for both sides in private chats.
      "messages.delete": { forEveryone: true },
      "reactions.read": {},
      "reactions.send": { maxPerMessage: reactions },
      "read.mark": {},
      "attachments.read": {},
      // Current sender profile photos are versioned and downloaded through /media.
      "avatars.read": {},
    },
  };
}
