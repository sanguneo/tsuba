import type { openWaStore } from "./persistence";
import type { SessionOptions } from "./session";
import { applyStoreEvent } from "./store-events";
import type { WaSocket } from "./types";

const RESTART_REQUIRED = 515;
const HISTORY_DEADLINE_MS = 60_000;

export type LinkResult =
  | { linked: true }
  | { linked: false; reason: "closed"; statusCode: number | undefined }
  | { linked: false; reason: "aborted" };

/**
 * Links this machine as a WhatsApp device. The owner scans each QR code with the
 * phone (Linked devices); nothing here answers the pairing for them. WhatsApp
 * closes the first connection with 515 right after a scan and expects a new
 * one, which is the only close this reopens. Any other close ends the attempt.
 * Once open, retain the connection until recent history finishes or its own
 * deadline expires. The pairing deadline no longer cuts this collection short.
 * Close the socket and drain the shared room cache before reporting success.
 */
export async function linkAccount({
  open,
  onQr,
  signal,
  cache,
  schedule,
}: {
  open(): WaSocket;
  onQr(qr: string): void;
  signal: AbortSignal;
  cache: Awaited<ReturnType<typeof openWaStore>>;
  schedule: SessionOptions["schedule"];
}): Promise<LinkResult> {
  try {
    for (;;) {
      let opened = false;
      let cancelHistory: (() => void) | undefined;
      const socket = open();
      let cleanup = () => {};
      const outcome = await new Promise<LinkResult | "restart">((resolve) => {
        let finished = false;
        const finish = (result: LinkResult | "restart") => {
          if (finished) return;
          finished = true;
          cleanup();
          resolve(result);
        };
        const abort = () => finish({ linked: false, reason: "aborted" });
        cleanup = () => signal.removeEventListener("abort", abort);
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        socket.onEvent((event) => {
          if (finished) return;
          switch (event.type) {
            case "qr":
              onQr(event.qr);
              break;
            case "open":
              if (opened) break;
              opened = true;
              cleanup();
              cancelHistory = schedule(
                () => finish({ linked: true }),
                HISTORY_DEADLINE_MS,
              );
              break;
            case "close":
              finish(
                event.statusCode === RESTART_REQUIRED
                  ? "restart"
                  : {
                      linked: false,
                      reason: "closed",
                      statusCode: event.statusCode,
                    },
              );
              break;
            case "historySyncComplete":
              // The same synchronous Baileys flush emits contacts and groups
              // after history. Keep intake open until that batch has drained.
              if (opened) queueMicrotask(() => finish({ linked: true }));
              break;
            default:
              applyStoreEvent(cache.store, event);
              cache.save();
          }
        });
      });
      cancelHistory?.();
      await socket.close();
      if (outcome !== "restart" && outcome.linked) cache.save();
      if (outcome !== "restart") return outcome;
    }
  } finally {
    await cache.flush();
  }
}
