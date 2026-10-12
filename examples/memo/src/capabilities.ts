import type { Capabilities } from "@tsuba/serve-kit";
import adapterPackage from "../package.json";

export const CAPABILITIES: Capabilities = {
  provider: { id: "memo", name: "Memo" },
  account: { kind: "user" },
  adapter: { name: "tsuba-memo", version: adapterPackage.version },
  features: {
    "rooms.list": {},
    "messages.read": { paging: "before-id", maxLimit: 100 },
    "messages.stream": { resume: "cursor" },
    "messages.send": { maxLength: 2000, receipt: "stored" },
  },
};
