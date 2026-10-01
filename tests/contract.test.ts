import { expect, test } from "bun:test";
import contract from "../contract/openapi.json";
import {
  CONTRACT_VERSION,
  createHandler,
  type ErrorCode,
  FEATURE_IDS,
  RESERVED_FEATURES,
  STATUS,
} from "../packages/serve-kit/src/index";
import { fakeBackend, sample, TOKEN } from "./fixtures";

test("every documented route is routed, and nothing else is", () => {
  const { routes } = createHandler({
    token: TOKEN,
    capabilities: sample,
    backend: fakeBackend(),
  });
  expect([...routes].sort()).toEqual(Object.keys(contract.paths).sort());
});

test("the feature vocabulary is the one serve-kit declares", () => {
  const declared: string[] = [...FEATURE_IDS];
  expect(declared.sort()).toEqual(
    Object.keys(contract.components.schemas.Features.properties).sort(),
  );
});

test("the error codes are the ones serve-kit can answer", () => {
  expect(Object.keys(STATUS).sort()).toEqual(
    [...contract.components.schemas.ErrorCode.enum].sort(),
  );
});

test("the served contract version is the document's", () => {
  expect(CONTRACT_VERSION).toBe(contract.info.version);
  expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

type Operation = {
  "x-feature"?: string;
  responses: Record<string, { $ref?: string; description?: string }>;
};
const operations = Object.entries(
  contract.paths as Record<string, Record<string, Operation>>,
).flatMap(([path, item]) =>
  Object.values(item).map((operation) => ({ path, operation })),
);

type FeatureSchema = {
  "x-in"?: string;
  "x-requires"?: string[];
  properties?: Record<string, unknown>;
};
const schemas = contract.components.schemas as Record<string, FeatureSchema>;
function featureSchema(id: string): FeatureSchema {
  const features = contract.components.schemas.Features.properties as Record<
    string,
    { $ref: string }
  >;
  return schemas[features[id]?.$ref.split("/").pop() ?? ""] ?? {};
}

test("every route but health and capabilities is gated by one defined feature, and every defined feature gates one route or names the field it rides on", () => {
  const gates = operations.flatMap(({ path, operation }) => {
    const feature = operation["x-feature"];
    expect(feature === undefined).toBe(
      path === "/health" || path === "/capabilities",
    );
    return feature === undefined ? [] : [feature];
  });
  expect(new Set(gates).size).toBe(gates.length);
  const defined = FEATURE_IDS.filter((id) => !RESERVED_FEATURES.has(id));
  const riders = defined.filter((id) => featureSchema(id)["x-in"]);
  for (const id of riders) {
    const [schema = "", field = ""] = (featureSchema(id)["x-in"] ?? "").split(
      ".",
    );
    expect(schemas[schema]?.properties?.[field]).toBeDefined();
  }
  expect([...gates, ...riders].sort()).toEqual([...defined].sort());
});

test("what a feature or an event requires is a defined feature", () => {
  const defined = new Set<string>(
    FEATURE_IDS.filter((id) => !RESERVED_FEATURES.has(id)),
  );
  const required = [
    ...FEATURE_IDS.flatMap((id) => featureSchema(id)["x-requires"] ?? []),
    ...Object.values(
      contract.paths["/stream"].get["x-sse-events"] as Record<
        string,
        { "x-feature"?: string }
      >,
    ).flatMap((event) => event["x-feature"] ?? []),
  ];
  expect(required.length).toBeGreaterThan(0);
  for (const id of required) expect(defined.has(id)).toBe(true);
});

test("every documented error answer names a code whose status is the one it is filed under", () => {
  const responses = contract.components.responses as Record<
    string,
    { description: string }
  >;
  for (const { operation } of operations)
    for (const [status, response] of Object.entries(operation.responses)) {
      if (status === "200") continue;
      const description = response.$ref
        ? responses[response.$ref.split("/").pop() ?? ""]?.description
        : response.description;
      const code = /^`([A-Z_]+)`/.exec(description ?? "")?.[1] as ErrorCode;
      expect(STATUS[code]).toBe(Number(status));
    }
});
