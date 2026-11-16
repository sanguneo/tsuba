import type { WaSocket } from "./types";

const RESTART_REQUIRED = 515;

export type LinkResult =
  | { linked: true }
  | { linked: false; reason: "closed"; statusCode: number | undefined }
  | { linked: false; reason: "aborted" };

/**
 * Links this machine as a WhatsApp device. The owner scans each QR code with the
 * phone (Linked devices); nothing here answers the pairing for them. WhatsApp
 * closes the first connection with 515 right after a scan and expects a new
 * one, which is the only close this reopens. Any other close ends the attempt.
 */
export async function linkAccount({
  open,
  onQr,
  signal,
}: {
  open(): WaSocket;
  onQr(qr: string): void;
  signal: AbortSignal;
}): Promise<LinkResult> {
  for (;;) {
    const socket = open();
    const outcome = await new Promise<LinkResult | "restart">((resolve) => {
      const abort = () => resolve({ linked: false, reason: "aborted" });
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      socket.onEvent((event) => {
        if (event.type === "qr") onQr(event.qr);
        else if (event.type === "open") resolve({ linked: true });
        else if (event.type === "close")
          resolve(
            event.statusCode === RESTART_REQUIRED
              ? "restart"
              : {
                  linked: false,
                  reason: "closed",
                  statusCode: event.statusCode,
                },
          );
      });
    });
    await socket.close();
    if (outcome !== "restart") return outcome;
  }
}
