import contract from "../../../contract/openapi.json";
import type { FeatureId } from "./capabilities";

export const CONTRACT_VERSION: string = contract.info.version;

const schemas = contract.components.schemas as Record<
  string,
  { "x-reserved"?: boolean }
>;
const features = contract.components.schemas.Features.properties as Record<
  string,
  { $ref: string }
>;

/** Feature ids the contract names but gives no route yet; no adapter may declare them. */
export const RESERVED_FEATURES: ReadonlySet<FeatureId> = new Set(
  Object.entries(features)
    .filter(
      ([, schema]) =>
        schemas[schema.$ref.split("/").pop() ?? ""]?.["x-reserved"] === true,
    )
    .map(([id]) => id as FeatureId),
);
