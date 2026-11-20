import { afterEach, expect, test } from "bun:test";
import { createCipheriv, createHmac, hkdfSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodePatches,
  decodeSyncdSnapshot,
  type LTHashState,
  useMultiFileAuthState,
} from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys";
import { getWasaRoot } from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys/lib/Utils/wasa-state.js";

// Synthetic sender, independent of Baileys' encoder (which cannot author root actions).
// whatsmeow 8b41cfe6d9: proto/waSyncAction/WAWebProtobufSyncAction.proto,
// appstate/keys.go and appstate.go (IndexWasaRootSecretAction).
const bot = "900002@bot";
const lid = "900001@lid";
const collection = "regular_high";
const keyData = Buffer.alloc(32, 7);
const keyId = { id: Buffer.from([11]) };
const key = async () => ({ keyData });
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
const entry = (id: string, epoch: number, status: number) =>
  field(
    [10],
    cat([
      field([10], Buffer.from(id)),
      field([18], Buffer.alloc(32, epoch)),
      Buffer.from([24, epoch, 32, status]),
    ]),
  );
const first = entry("first", 1, 1);
const second = entry("second", 2, 1);
const makeUpdate = (entries: Buffer, version: number, remove = false) => {
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
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((p) => rm(p, { recursive: true })));
});
const account = async (owner = lid) => {
  const folder = await mkdtemp(join(tmpdir(), "wasa-fixture-"));
  folders.push(folder);
  const { state } = await useMultiFileAuthState(folder);
  state.creds.me = { id: "900001@s.whatsapp.net", lid: owner };
  return state;
};
const snapshot = (fixture = makeUpdate(first, 1).snapshot, floor?: number) =>
  decodeSyncdSnapshot(collection, fixture, key, floor, false);
const patch = (
  state: LTHashState,
  fixture: ReturnType<typeof makeUpdate>["patch"],
) =>
  decodePatches(
    collection,
    [fixture],
    state,
    key,
    {},
    undefined,
    undefined,
    false,
  );

test("authenticated roots rotate privately and REMOVE revokes even with active bytes in the value", async () => {
  const auth = await account();
  const persist = (state: LTHashState) =>
    auth.keys.set({
      "app-state-sync-version": { [collection]: { ...state, wasaOwner: lid } },
    });
  const original = await snapshot();
  await persist(original.state);
  expect(original.mutationMap).toEqual({});
  expect(await getWasaRoot(auth, bot)).toEqual({
    id: "first",
    secret: Buffer.alloc(32, 1),
  });
  const rotated = await patch(
    original.state,
    makeUpdate(cat([second, first]), 2).patch,
  );
  await persist(rotated.state);
  expect(await getWasaRoot(auth, bot)).toEqual({
    id: "second",
    secret: Buffer.alloc(32, 2),
  });
  expect(await getWasaRoot(auth, "900003@bot")).toBeUndefined();
  expect(await getWasaRoot(await account(), bot)).toBeUndefined();
  const other = await account("900004@lid");
  expect(await getWasaRoot({ ...other, keys: auth.keys }, bot)).toBeUndefined();
  const removed = await patch(rotated.state, makeUpdate(second, 3, true).patch);
  await persist(removed.state);
  expect(await getWasaRoot(auth, bot)).toBeUndefined();
});

test("inactive or ambiguously active replacement cannot retain a former root", async () => {
  const { state } = await snapshot();
  for (const invalid of [
    entry("retired", 3, 0),
    cat([entry("x", 2, 1), second]),
  ]) {
    expect(
      (await patch(state, makeUpdate(invalid, 2).patch)).state.wasaRoots,
    ).toEqual({});
  }
});

test("an intermediate page is not ready even with a valid active root", async () => {
  const auth = await account();
  const { state } = await snapshot();
  await auth.keys.set({
    "app-state-sync-version": {
      [collection]: { ...state, wasaOwner: lid, wasaPending: true },
    },
  });
  expect(await getWasaRoot(auth, bot)).toBeUndefined();
});

test("disabled general MAC option cannot authorize a tampered snapshot or patch", async () => {
  const { snapshot: forged } = makeUpdate(first, 1);
  forged.mac.fill(0);
  await expect(snapshot(forged)).rejects.toThrow("LTHash");
  const { state } = await snapshot();
  const { patch: forgedPatch } = makeUpdate(second, 2);
  forgedPatch.patchMac.fill(0);
  await expect(patch(state, forgedPatch)).rejects.toThrow("patch mac");
  expect(state.wasaRoots?.[bot]?.id).toBe("first");
});

test("does not roll back on an older snapshot or replay a patch", async () => {
  await expect(snapshot(makeUpdate(first, 1).snapshot, 2)).rejects.toThrow(
    "Stale",
  );
  const { state } = await snapshot();
  await expect(patch(state, makeUpdate(first, 1).patch)).rejects.toThrow(
    "Non-consecutive",
  );
});
