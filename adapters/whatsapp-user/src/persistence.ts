import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseSnapshot, StoreFileError } from "./snapshot";
import { WaStore } from "./store";

/** Restore before connecting; serialize writes and drain them during shutdown. */
export async function openWaStore(path: string, onError: () => void) {
  let store: WaStore;
  try {
    store = new WaStore(parseSnapshot(await readFile(path, "utf8")));
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw new StoreFileError();
    store = new WaStore();
  }
  let pending = Promise.resolve();
  let dirty = false;
  let writing = false;
  let failed = false;

  function save(): void {
    dirty = true;
    if (writing) return;
    writing = true;
    pending = Promise.resolve().then(async () => {
      try {
        while (dirty) {
          dirty = false;
          const temp = join(dirname(path), `.store-${crypto.randomUUID()}.tmp`);
          try {
            const file = await open(temp, "wx", 0o600);
            try {
              await file.writeFile(JSON.stringify(store.snapshot()), "utf8");
              await file.sync();
            } finally {
              await file.close();
            }
            await rename(temp, path);
            failed = false;
          } finally {
            await rm(temp, { force: true });
          }
        }
      } catch {
        // File-system errors can contain account-local paths. Report no payload.
        failed = true;
        onError();
      } finally {
        writing = false;
      }
    });
  }

  return {
    store,
    save,
    async flush(): Promise<void> {
      await pending;
      if (failed) throw new StoreFileError();
    },
  };
}
