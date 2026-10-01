/**
 * Slack names reactions by shortcode (`+1`, `heart::skin-tone-2`), from the
 * same table emoji-datasource publishes. The contract carries Unicode, so the
 * adapter maps both ways; a custom workspace emoji has no Unicode and is left
 * out of `reactions`.
 */
export interface EmojiEntry {
  unified: string;
  short_names: readonly string[];
  skin_variations?: Readonly<Record<string, { unified: string }>>;
}

const SKIN_TONES: Readonly<Record<string, string>> = {
  "skin-tone-2": "1F3FB",
  "skin-tone-3": "1F3FC",
  "skin-tone-4": "1F3FD",
  "skin-tone-5": "1F3FE",
  "skin-tone-6": "1F3FF",
};
const VARIATION_SELECTOR = /\uFE0F/g;

function fromUnified(unified: string): string {
  return String.fromCodePoint(
    ...unified.split("-").map((part) => Number.parseInt(part, 16)),
  );
}

/** The same emoji with and without the emoji presentation selector compare equal. */
function key(emoji: string): string {
  return emoji.replace(VARIATION_SELECTOR, "");
}

export interface EmojiTable {
  /** A Slack reaction name to Unicode, or undefined for a custom emoji. */
  toUnicode(name: string): string | undefined;
  /** Unicode to the Slack reaction name, or undefined when Slack has none. */
  toName(emoji: string): string | undefined;
}

export function emojiTable(entries: readonly EmojiEntry[]): EmojiTable {
  const byName = new Map<string, EmojiEntry>();
  const byUnicode = new Map<string, string>();
  for (const entry of entries) {
    const first = entry.short_names[0];
    if (!first) continue;
    for (const name of entry.short_names) byName.set(name, entry);
    byUnicode.set(key(fromUnified(entry.unified)), first);
    for (const [tone, variation] of Object.entries(
      entry.skin_variations ?? {},
    )) {
      const toneName = Object.entries(SKIN_TONES).find(
        ([, code]) => code === tone,
      )?.[0];
      if (toneName)
        byUnicode.set(
          key(fromUnified(variation.unified)),
          `${first}::${toneName}`,
        );
    }
  }
  return {
    toUnicode(name) {
      const [base = "", tone] = name.split("::");
      const entry = byName.get(base);
      if (!entry) return undefined;
      const code = tone ? SKIN_TONES[tone] : undefined;
      const variation = code ? entry.skin_variations?.[code] : undefined;
      return fromUnified(variation?.unified ?? entry.unified);
    },
    toName(emoji) {
      return byUnicode.get(key(emoji));
    },
  };
}
