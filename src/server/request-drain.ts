/** One gate per web process, shared by Next instrumentation and route bundles. */
export function createRequestDrain() {
  let stopping = false;
  const pending = new Set<Promise<void>>();
  return {
    get stopping() { return stopping; },
    async run<T>(work: () => Promise<T>): Promise<T> {
      if (stopping) throw new Error("SERVER_STOPPING");
      let release!: () => void;
      const completed = new Promise<void>(resolve => { release = resolve; });
      pending.add(completed);
      try { return await work(); }
      finally { pending.delete(completed); release(); }
    },
    async stop() { stopping = true; await Promise.all([...pending]); },
  };
}
const processState = globalThis as typeof globalThis & { fieldGuideRequestDrain?: ReturnType<typeof createRequestDrain> };
export const webRequestDrain = processState.fieldGuideRequestDrain ??= createRequestDrain();

/** Reject new work, finish accepted requests and workers, then close storage. */
export async function drainAndClose(input: {
  requests: Pick<ReturnType<typeof createRequestDrain>, "stop">;
  workers?: { stop(): Promise<void> };
  close(): Promise<void>;
}) {
  await Promise.all([input.requests.stop(), input.workers?.stop()]);
  await input.close();
}
