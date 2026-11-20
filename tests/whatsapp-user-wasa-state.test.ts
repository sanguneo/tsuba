import { afterEach, expect, test } from "bun:test";
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
import {
  bot,
  collection,
  entry,
  first,
  key,
  makeUpdate,
} from "./whatsapp-user-wasa-patches";

const lid = "900001@lid";
const cat = Buffer.concat;
const second = entry("second", 2, 1);
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
