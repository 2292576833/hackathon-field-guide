import type { EventEmitter } from "node:events";

/** Cancel work before Next handles the same signal. Next still owns HTTP draining
 * and process exit; a forced termination retains durable unknown-request holds. */
export function bindWebWorkerCancellation(workers: { stop(): Promise<void> }, signals: Pick<EventEmitter, "prependOnceListener" | "removeListener"> = process) {
  let stopping = false;
  const cancel = () => {
    if (stopping) return;
    stopping = true;
    void workers.stop().catch(() => { console.error("[backend] Worker cancellation failed during shutdown."); });
  };
  signals.prependOnceListener("SIGINT", cancel);
  signals.prependOnceListener("SIGTERM", cancel);
  return () => { signals.removeListener("SIGINT", cancel); signals.removeListener("SIGTERM", cancel); };
}
