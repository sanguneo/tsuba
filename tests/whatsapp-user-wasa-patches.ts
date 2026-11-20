import { createCipheriv, createHmac, hkdfSync } from "node:crypto";
import { Readable } from "node:stream";
import {
  type BinaryNode,
  decodeSyncdSnapshot,
  encodeSyncdPatch,
  getMediaKeys,
  proto,
} from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys";
import { muse } from "./whatsapp-user-bot-wire-fixtures";

// Synthetic sender independent of Baileys' encoder, which cannot author roots.
// whatsmeow 8b41cfe6d9: WAWebProtobufSyncAction.proto, appstate/keys.go and appstate.go.
export const bot = muse;
export const collection = "regular_high";
const keyData = Buffer.alloc(32, 7);
const keyId = { id: Buffer.from([11]) };
export const keyName = keyId.id.toString("base64");
export const key = async () => ({ keyData });
const cat = Buffer.concat;
const expand = (input: Buffer, info: string, length: number) =>
  Buffer.from(hkdfSync("sha256", input, Buffer.alloc(0), info, length));
const keys = expand(keyData, "WhatsApp Mutation Keys", 160);
const mac = (slot: number, input: Buffer, hash = "sha256") =>
  createHmac(hash, keys.subarray(slot * 32, (slot + 1) * 32))
    .update(input)
    .digest();
const u64 = (value: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(value));
  return b;
};
// All fixture length-delimited fields are shorter than 128 bytes.
const field = (tag: number[], value: Buffer) =>
  cat([Buffer.from([...tag, value.length]), value]);
export const entry = (id: string, epoch: number, status: number) =>
  field(
    [10],
    cat([
      field([10], Buffer.from(id)),
      field([18], Buffer.alloc(32, epoch)),
      Buffer.from([24, epoch, 32, status]),
    ]),
  );
export const first = entry("first", 1, 1);
export const makeUpdate = (
  entries: Buffer,
  version: number,
  remove = false,
) => {
  const index = Buffer.from(JSON.stringify(["wasa_root_secret", bot]));
  const wire = cat([field([10], index), field([18], field([202, 5], entries))]);
  const iv = Buffer.alloc(16, version);
  const cipher = createCipheriv("aes-256-cbc", keys.subarray(32, 64), iv);
  const ciphertext = cat([iv, cipher.update(wire), cipher.final()]);
  const valueMac = mac(
    2,
    cat([Buffer.from([remove ? 2 : 1]), keyId.id, ciphertext, u64(2)]),
    "sha512",
  ).subarray(0, 32);
  const record = {
    index: { blob: mac(0, index) },
    value: { blob: cat([ciphertext, valueMac]) },
    keyId,
  };
  // This fixture has one index: SET replaces its old hash; REMOVE leaves zero.
  const hash = remove
    ? Buffer.alloc(128)
    : expand(valueMac, "WhatsApp Patch Integrity", 128);
  const context = cat([u64(version), Buffer.from(collection)]);
  const snapshotMac = mac(3, cat([hash, context]));
  return {
    snapshot: {
      records: [record],
      mac: snapshotMac,
      keyId,
      version: { version },
    },
    patch: {
      mutations: [{ operation: remove ? 1 : 0, record }],
      snapshotMac,
      patchMac: mac(4, cat([snapshotMac, valueMac, context])),
      keyId,
      version: { version },
    },
  };
};

export const muteEndTime = 1_900_000_000;

export async function mixedPage({
  inactive,
  tampered,
  external,
}: {
  readonly inactive: boolean;
  readonly tampered: boolean;
  readonly external: boolean;
}) {
  const { snapshot, patch } = makeUpdate(
    inactive ? entry("retired", 1, 0) : first,
    1,
  );
  const rootState = await decodeSyncdSnapshot(collection, snapshot, key, 0);
  const publicPatch = await encodeSyncdPatch(
    {
      type: collection,
      index: ["mute", bot],
      syncAction: {
        muteAction: { muted: true, muteEndTimestamp: muteEndTime },
      },
      apiVersion: 2,
      operation: proto.SyncdMutation.SyncdOperation.SET,
    },
    keyName,
    rootState.state,
    key,
  );
  if (tampered) publicPatch.patch.patchMac?.fill(0);
  const nodes = [
    ...(external ? [] : [patch]),
    { ...publicPatch.patch, version: { version: 2 } },
  ].map(
    (value): BinaryNode => ({
      tag: "patch",
      attrs: {},
      content: proto.SyncdPatch.encode(value).finish(),
    }),
  );
  const mediaKey = Buffer.alloc(32, 12);
  const { cipherKey, iv } = await getMediaKeys(mediaKey, "md-app-state");
  const cipher = createCipheriv("aes-256-cbc", cipherKey, iv);
  const bytes = cat([
    cipher.update(proto.SyncdSnapshot.encode(snapshot).finish()),
    cipher.final(),
    Buffer.alloc(10), // The SDK authenticates the decrypted snapshot via LTHash.
  ]);
  if (external)
    nodes.unshift({
      tag: "snapshot",
      attrs: {},
      content: proto.ExternalBlobReference.encode({
        mediaKey,
        directPath: "/synthetic-app-state",
      }).finish(),
    });
  return { nodes, snapshotStream: () => Readable.from([bytes]) };
}
