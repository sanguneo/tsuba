import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { bounded, deferred } from "./harness/barriers";
import { setup } from "./whatsapp-user-baileys-harness";

test("socket close drains an already-started Signal transaction before returning", async () => {
  const { wa, authKeys, authDir, ending, ended, emit } = await setup();
  const entered = deferred<void>();
  const release = deferred<void>();
  const transaction = authKeys.transaction(async () => {
    entered.resolve();
    await release.promise;
    await authKeys.set({ session: { synthetic: new Uint8Array([1]) } });
    emit("creds.update", {});
  });
  await bounded(entered.promise, "Signal transaction started");
  let closed = false;
  const closing = wa.close().then(() => {
    closed = true;
  });
  try {
    await bounded(ending, "transport ended");
    // Let the microtasks that would resolve an unblocked close run first.
    await new Promise<void>((done) => setImmediate(done));
    expect(closed).toBe(false);
  } finally {
    release.resolve();
    await bounded(transaction, "Signal transaction committed");
    await bounded(closing, "socket close completed");
  }
  expect(await readdir(authDir)).toEqual(
    expect.arrayContaining(["session-synthetic.json", "creds.json"]),
  );
  await wa.close();
  expect(ended()).toBe(1);
});
