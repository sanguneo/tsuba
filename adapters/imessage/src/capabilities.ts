import type { Capabilities } from "@tsuba/serve-kit";
import adapterPackage from "../package.json";

/**
 * Apple documents no iMessage text limit; the reported practical ceiling is
 * 20,000 characters, past which Messages cuts the remainder (Apple Discussions
 * 253391; Business Insider, 2019-12-19). What Apple does document is the SMS
 * fallback: 160 GSM-7 or 70 UCS-2 code units a segment. 20,000 is a
 * conservative bound the adapter has not measured.
 */
const MAX_TEXT = 20_000;

/** Only what the adapter does end to end: no edits, reactions or files. */
export function capabilities(): Capabilities {
  return {
    provider: { id: "imessage", name: "iMessage" },
    account: { kind: "user" },
    adapter: { name: "tsuba-imessage", version: adapterPackage.version },
    features: {
      "rooms.list": {},
      "messages.read": { paging: "before-id", maxLimit: 100 },
      // `message` is a base event every stream sends, so `events` names none.
      "messages.stream": { resume: "cursor" },
      "messages.send": { maxLength: MAX_TEXT, receipt: "stored" },
    },
  };
}
