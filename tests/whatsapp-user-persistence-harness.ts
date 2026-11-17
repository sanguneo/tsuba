import { expect, onTestFinished } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whatsappUserBackend } from "../adapters/whatsapp-user/src/backend";
import { CAPABILITIES } from "../adapters/whatsapp-user/src/capabilities";
import { openWaStore } from "../adapters/whatsapp-user/src/persistence";
import { StoreFileError } from "../adapters/whatsapp-user/src/snapshot";
import { createHandler } from "../packages/serve-kit/src/index";
import { fakeLink } from "./whatsapp-user-fixtures";

export async function setupCache() {
  const dir = await mkdtemp(join(tmpdir(), "tsuba-wa-cache-"));
  const path = join(dir, "store.json");
  const caches: Awaited<ReturnType<typeof openWaStore>>[] = [];
  let failures = 0;
  onTestFinished(async () => {
    for (const cache of caches)
      await cache.flush().catch((error: unknown) => {
        if (!(error instanceof StoreFileError)) throw error;
      });
    await rm(dir, { recursive: true, force: true });
  });
  async function start() {
    const cache = await openWaStore(path, () => failures++);
    caches.push(cache);
    const link = fakeLink();
    const backend = whatsappUserBackend(link, {
      store: cache.store,
      changed: cache.save,
    });
    const { handle } = createHandler({
      token: "synthetic-cache-token",
      capabilities: CAPABILITIES,
      backend,
    });
    async function get(route: string) {
      const response = await handle(
        new Request(`http://synthetic${route}`, {
          headers: { authorization: "Bearer synthetic-cache-token" },
        }),
      );
      expect(response.status).toBe(200);
      return response.json();
    }
    return { cache, link, backend, get };
  }
  return { dir, path, start, failures: () => failures };
}
