import Ajv2020 from "ajv/dist/2020.js";
import contract from "../contract/openapi.json";
import type {
  AdapterBackend,
  Capabilities,
  Message,
  Room,
} from "../packages/serve-kit/src/index";

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

export const room: Room = {
  id: "example:room",
  title: "Synthetic room",
  kind: "group",
  unread: 0,
};
export const message: Message = {
  id: "2",
  roomId: room.id,
  sender: "Synthetic sender",
  text: "Synthetic text",
  kind: "text",
  sentAt: "2026-01-01T00:00:00.000Z",
  fromMe: false,
};
export function fakeBackend(): AdapterBackend {
  return {
    listRooms: async () => ({ rooms: [room], complete: true }),
    readMessages: async () => ({ messages: [message], hasEarlier: false }),
    send: async (roomId, text) => ({ ...message, roomId, text, fromMe: true }),
  };
}

const ajv = new Ajv2020({ strict: false });
ajv.addSchema(contract, "contract");

export function schema(name: string) {
  const validate = ajv.getSchema(`contract#/components/schemas/${name}`);
  if (!validate) throw new Error(`No schema ${name} in the contract`);
  return validate;
}
