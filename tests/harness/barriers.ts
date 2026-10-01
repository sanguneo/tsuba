/**
 * Taken from saya's `tests/harness/barriers.ts`: register the exact signal
 * before the action, and treat timers as deadlines, never as delays.
 */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function bounded<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = deferred<never>();
  const timer = setTimeout(
    () => deadline.reject(new Error(`Timeout: ${label}`)),
    timeoutMs,
  );
  try {
    return await Promise.race([promise, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
}
