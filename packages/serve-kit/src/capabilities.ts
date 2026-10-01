import { createHash } from "node:crypto";

/**
 * The shared feature vocabulary. An adapter declares the features it can
 * perform end to end, with the limits its messenger enforces; a feature it
 * does not declare is unsupported. The ids and parameters here must match
 * `components.schemas.Features` in `contract/openapi.json` (tests/contract.test.ts).
 */
export interface FeatureParams {
  "rooms.list": Record<string, never>;
  "messages.read": { paging: "none" | "before-id"; maxLimit: number };
  "messages.stream": { resume: "none" | "cursor"; events?: string[] };
  "messages.send": { maxLength: number; receipt: "accepted" | "stored" };
  "messages.reply": Record<string, never>;
  "messages.edit": { maxLength: number; maxAgeSeconds?: number };
  "messages.delete": { forEveryone: boolean };
  "reactions.read": Record<string, never>;
  "reactions.send": { maxPerMessage?: number };
  "read.mark": Record<string, never>;
  "typing.send": Record<string, never>;
  "threads.read": Record<string, never>;
  "attachments.read": Record<string, never>;
  "attachments.send": { maxBytes: number; caption: boolean };
}

export type FeatureId = keyof FeatureParams;

const featureIds: Record<FeatureId, true> = {
  "rooms.list": true,
  "messages.read": true,
  "messages.stream": true,
  "messages.send": true,
  "messages.reply": true,
  "messages.edit": true,
  "messages.delete": true,
  "reactions.read": true,
  "reactions.send": true,
  "read.mark": true,
  "typing.send": true,
  "threads.read": true,
  "attachments.read": true,
  "attachments.send": true,
};

export const FEATURE_IDS = Object.keys(featureIds) as readonly FeatureId[];

/** Provider-specific features live under `x-<provider>.` and are ignored by clients that do not know them. */
export type ExtensionId = `x-${string}.${string}`;

export type Features = { [K in FeatureId]?: FeatureParams[K] } & {
  [K in ExtensionId]?: Record<string, unknown>;
};

/**
 * A room's own features where they differ from the declaration: a value
 * replaces the declared one for that room, and `false` removes it. A room
 * narrows the declaration and never adds to it.
 */
export type RoomFeatures = { [K in FeatureId]?: false | FeatureParams[K] } & {
  [K in ExtensionId]?: false | Record<string, unknown>;
};

export interface Capabilities {
  provider: { id: string; name: string };
  account: { kind: "user" | "bot" | "official" };
  adapter: { name: string; version: string };
  features: Features;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
}

/**
 * An opaque content hash of what the adapter declares, so a client holding an
 * older answer can tell that it changed. Key order does not affect it.
 */
export function capabilityRevision(capabilities: Capabilities): string {
  return createHash("sha256")
    .update(canonical(capabilities))
    .digest("hex")
    .slice(0, 16);
}
