import { expect, test } from "bun:test";
import contract from "../contract/openapi.json";
import {
  CONTRACT_VERSION,
  createHandler,
  FEATURE_IDS,
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
});
