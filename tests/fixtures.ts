import Ajv2020 from "ajv/dist/2020.js";
import contract from "../contract/openapi.json";
import type { Capabilities } from "../packages/serve-kit/src/index";

export const TOKEN = "synthetic-test-token-0123456789";

export const sample: Capabilities = {
  provider: { id: "example", name: "Example" },
  account: { kind: "user" },
  adapter: { name: "tsuba-test", version: "0.0.0" },
  features: {
    "rooms.list": {},
    "messages.read": { paging: "before-id", maxLimit: 100 },
    "messages.send": { maxLength: 4096, receipt: "stored" },
    "x-example.pins": {},
  },
};

const ajv = new Ajv2020({ strict: false });
ajv.addSchema(contract, "contract");

export function schema(name: string) {
  const validate = ajv.getSchema(`contract#/components/schemas/${name}`);
  if (!validate) throw new Error(`No schema ${name} in the contract`);
  return validate;
}
