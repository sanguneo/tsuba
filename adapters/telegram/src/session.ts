import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the Telegram session lives: `TSUBA_SESSIONS_DIR` when set (a compiled
 * executable has no checkout to keep it in), otherwise `sessions/` at the
 * repository root as before.
 */
export function sessionFile(env: Record<string, string | undefined>): string {
  const dir = env.TSUBA_SESSIONS_DIR;
  return dir
    ? join(dir, "telegram.session")
    : fileURLToPath(
        new URL("../../../sessions/telegram.session", import.meta.url),
      );
}
