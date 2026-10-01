import contract from "../../../contract/openapi.json";
import type { FeatureId } from "./capabilities";

export const CONTRACT_VERSION: string = contract.info.version;

const schemas = contract.components.schemas as Record<
  string,
  { "x-reserved"?: boolean; "x-requires"?: string[] }
>;
const features = contract.components.schemas.Features.properties as Record<
  string,
  { $ref: string }
>;

/** Events every stream may send, so a `messages.stream` declaration does not list them. */
const BASE_EVENTS = new Set(["ready", "message", "cursor", "ping", "error"]);

const events = contract.paths["/stream"].get["x-sse-events"] as Record<
  string,
  { "x-feature"?: string }
>;

/**
 * Events the contract defines that an adapter sends only when it lists them in
 * `events`, each with the feature that must be declared beside it, if any.
 */
export const OPTIONAL_EVENTS: ReadonlyMap<string, FeatureId | undefined> =
  new Map(
    Object.entries(events)
      .filter(([name]) => !BASE_EVENTS.has(name))
      .map(([name, event]) => [
        name,
        event["x-feature"] as FeatureId | undefined,
      ]),
  );

/** Feature ids the contract names but gives no route yet; no adapter may declare them. */
/** Features declared only beside others (`x-requires`), such as replies beside sending. */
export const FEATURE_REQUIRES: ReadonlyMap<FeatureId, readonly FeatureId[]> =
  new Map(
    Object.entries(features).flatMap(([id, schema]) => {
      const requires =
        schemas[schema.$ref.split("/").pop() ?? ""]?.["x-requires"];
      return requires ? [[id as FeatureId, requires as FeatureId[]]] : [];
    }),
  );

export const RESERVED_FEATURES: ReadonlySet<FeatureId> = new Set(
  Object.entries(features)
    .filter(
      ([, schema]) =>
        schemas[schema.$ref.split("/").pop() ?? ""]?.["x-reserved"] === true,
    )
    .map(([id]) => id as FeatureId),
);
