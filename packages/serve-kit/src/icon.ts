import { createHash } from "node:crypto";

export interface ProviderIcon {
  bytes: Uint8Array;
  type: "image/svg+xml" | "image/png" | "image/webp";
}

/** Icons are adapter-owned, static images, not arbitrary messenger media. */
export function prepareIcon(input: ProviderIcon) {
  if (input.bytes.byteLength > 64 * 1024)
    throw new Error("Provider icon exceeds 64 KiB");
  if (!["image/svg+xml", "image/png", "image/webp"].includes(input.type))
    throw new Error("Unsupported provider icon type");
  const bytes = new Uint8Array(input.bytes);
  if (input.type === "image/svg+xml") {
    const svg = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // Refuse indirection as well as active content: entities, CSS escapes and
    // comments can hide references; animation can rewrite a safe href later.
    if (
      /<!|<\?|&|\\|\/\*/.test(svg) ||
      /<(?:[\w.-]+:)?(?:script|foreignObject|animate\w*|set|discard)\b/i.test(
        svg,
      ) ||
      /\s(?:[\w.-]+:)?on[\w.-]*\s*=/i.test(svg) ||
      /\sxml:base\s*=/i.test(svg) ||
      /@import\b/i.test(svg)
    )
      throw new Error("Unsafe provider SVG");
    for (const match of svg.matchAll(
      /\s(?:[\w.-]+:)?href\s*=\s*(["'])(.*?)\1/gis,
    ))
      if (!/^#[^\s]+$/.test(match[2] ?? ""))
        throw new Error(
          "Provider SVG references must be same-document fragments",
        );
    const withoutLocalUrls = svg.replace(
      /\burl\s*\(\s*(["']?)#[^\s"'()]+\1\s*\)/gi,
      "",
    );
    if (/\burl\s*\(/i.test(withoutLocalUrls))
      throw new Error(
        "Provider SVG references must be same-document fragments",
      );
  }
  return {
    bytes,
    type: input.type,
    version: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
  };
}
