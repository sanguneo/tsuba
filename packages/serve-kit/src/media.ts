/**
 * A file somebody else sent is opened at the client's own origin, so `GET
 * /media` never lets it run there: the sandbox and `nosniff` always, the
 * file's own type only when browsers draw or play it without running anything,
 * and everything else as a download.
 */
const INLINE = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "audio/mpeg",
  "audio/ogg",
  "audio/mp4",
  "audio/aac",
  "audio/webm",
  "audio/wav",
  "audio/flac",
]);

function disposition(kind: "inline" | "attachment", name: string | undefined) {
  if (!name) return kind;
  // Printable ASCII without the quote and backslash, so the header cannot be split or escaped.
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function mediaHeaders(file: {
  mimeType?: string | undefined;
  name?: string | undefined;
}): Record<string, string> {
  const type = file.mimeType?.split(";")[0]?.trim().toLowerCase();
  const inline = type !== undefined && INLINE.has(type);
  return {
    "content-type": inline ? type : "application/octet-stream",
    "content-disposition": disposition(
      inline ? "inline" : "attachment",
      file.name,
    ),
    "content-security-policy": "default-src 'none'; sandbox",
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=86400",
  };
}
