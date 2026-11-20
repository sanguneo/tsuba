import type { WaContent } from "./types";

const utf8 = new TextDecoder("utf-8", { fatal: true });

export function richResponseText(
  rich: NonNullable<WaContent["richResponseMessage"]>,
): { readonly text: string } | "malformed" | null {
  const data = rich.unifiedResponse?.data;
  if (!data?.length) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(utf8.decode(data));
  } catch {
    return "malformed";
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    !("sections" in payload) ||
    !Array.isArray(payload.sections)
  )
    return null;
  const texts: string[] = [];
  const sections: readonly unknown[] = payload.sections;
  for (const section of sections) {
    if (!section || typeof section !== "object" || !("view_model" in section))
      continue;
    const model = section.view_model;
    if (!model || typeof model !== "object" || !("primitive" in model))
      continue;
    const primitive = model.primitive;
    if (!primitive || typeof primitive !== "object" || !("text" in primitive))
      continue;
    if (typeof primitive.text === "string" && primitive.text.trim())
      texts.push(primitive.text);
  }
  return texts.length ? { text: texts.join("\n") } : null;
}
