/** Explicit read-only endpoints used by multiple mounted space panels. */
export function isSharedRead(path: string): boolean {
  return ["/me", "/system/status"].includes(path) ||
    /^\/projects\/[^/?]+\/(?:rules|official-tracks|my-intention|my-availability|plans\/current)$/.test(path);
}

/** Share only simultaneous reads, never stored account data. Writes invalidate
 * the group so a read started after login/profile changes cannot join an old one. */
export function createInflightReadGroup() {
  const pending = new Map<string, Promise<unknown>>();
  return {
    clear() { pending.clear(); },
    read<T>(key: string, load: () => Promise<T>): Promise<T> {
      const existing = pending.get(key);
      if (existing) return existing as Promise<T>;
      const result = Promise.resolve().then(load);
      pending.set(key, result);
      const release = () => { if (pending.get(key) === result) pending.delete(key); };
      void result.then(release, release);
      return result;
    },
  };
}

/** A caller timing out must not cancel another component's shared read. */
export function waitForRead<T>(read: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return read;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    read.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
