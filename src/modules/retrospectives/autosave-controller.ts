/** Autosaves an editable draft only. Publishing and model generation remain explicit caller actions. */
export type AutosaveStatus = "idle" | "dirty" | "saving" | "saved" | "conflict" | "failed" | "stopped";

export interface AutosaveMutation<Payload> {
  readonly expectedRevision: number;
  readonly mutationId: string;
  readonly content: Payload;
}

export interface AutosaveError {
  readonly message: string;
  readonly code?: string;
  readonly status?: number;
  readonly latestRevision?: number;
}

export interface AutosaveSnapshot<Payload> {
  readonly status: AutosaveStatus;
  /** Current input, including edits made while a request was running or failed. */
  readonly payload: Payload;
  readonly revision: number;
  readonly dirty: boolean;
  readonly enabled: boolean;
  readonly error: AutosaveError | null;
  /** Retained until acknowledged; explicit retry sends this exact mutation again. */
  readonly pending: AutosaveMutation<Payload> | null;
}

export interface AutosaveTimerPort {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AutosaveControllerOptions<Payload> {
  readonly initial: Payload;
  /** Use zero for the first creation, and the server's revision for an existing draft. */
  readonly revision: number;
  readonly save: (mutation: AutosaveMutation<Payload>) => Promise<{ readonly revision: number; readonly content?: Payload }>;
  readonly onChange?: (snapshot: AutosaveSnapshot<Payload>) => void;
  readonly createMutationId?: () => string;
  readonly debounceMs?: number;
  readonly enabled?: boolean;
  readonly timers?: AutosaveTimerPort;
  /** Default payloads must be structured-cloneable. */
  readonly clone?: (payload: Payload) => Payload;
  /** Defaults to structural equality for JSON-compatible draft payloads. */
  readonly equals?: (left: Payload, right: Payload) => boolean;
}

export interface AutosaveConflictResolution<Payload> {
  readonly revision: number;
  readonly content: Payload;
  /** Adopt replaces local input; rebase retains it and schedules a new CAS write. */
  readonly mode: "adopt" | "rebase";
}

export interface AutosaveController<Payload> {
  snapshot(): AutosaveSnapshot<Payload>;
  edit(payload: Payload): void;
  /** Drain current edits when writable; failed/conflicting requests require explicit recovery. */
  flush(): Promise<void>;
  /** Recover the retained mutation before saving edits made after that mutation. */
  retry(): Promise<void>;
  resolveConflict(resolution: AutosaveConflictResolution<Payload>): boolean;
  setEnabled(enabled: boolean): void;
  /** Stops timers and notifications; late responses cannot change the disposed controller. */
  dispose(): void;
}

function equalJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => equalJson(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>, rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length
    && keys.every(key => Object.hasOwn(rightRecord, key) && equalJson(leftRecord[key], rightRecord[key]));
}

function describeError(value: unknown): AutosaveError {
  const raw = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  const nested = raw.error !== null && typeof raw.error === "object" ? raw.error as Record<string, unknown> : raw;
  const message = typeof nested.message === "string" && nested.message ? nested.message : "草稿未保存，请保留输入并重试。";
  const status = typeof raw.status === "number" ? raw.status : nested.status;
  return {
    message,
    ...(typeof nested.code === "string" ? { code: nested.code } : {}),
    ...(typeof status === "number" ? { status } : {}),
    ...(typeof nested.latestRevision === "number" ? { latestRevision: nested.latestRevision } : {}),
  };
}

const defaultTimers: AutosaveTimerPort = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export function createAutosaveController<Payload>(options: AutosaveControllerOptions<Payload>): AutosaveController<Payload> {
  if (!Number.isInteger(options.revision) || options.revision < 0) throw new RangeError("revision must be a non-negative integer");
  const debounceMs = options.debounceMs ?? 800;
  if (!Number.isFinite(debounceMs) || debounceMs < 0) throw new RangeError("debounceMs must be non-negative");
  const clone = options.clone ?? ((payload: Payload) => structuredClone(payload));
  const equals = options.equals ?? equalJson;
  const timers = options.timers ?? defaultTimers;
  const createMutationId = options.createMutationId ?? (() => globalThis.crypto.randomUUID());
  let payload = clone(options.initial), baseline = clone(options.initial), revision = options.revision;
  let status: AutosaveStatus = options.enabled === false ? "stopped" : "idle";
  let enabled = options.enabled !== false, disposed = false, hasSaved = false, editVersion = 0;
  let error: AutosaveError | null = null, blocked: "conflict" | "failed" | null = null;
  let pending: (AutosaveMutation<Payload> & { readonly editVersion: number }) | null = null;
  let active: Promise<void> | null = null, timer: unknown = null;

  const isDirty = () => !equals(payload, baseline);
  const snapshot = (): AutosaveSnapshot<Payload> => ({
    status, payload: clone(payload), revision, dirty: isDirty(), enabled,
    error: error === null ? null : { ...error },
    pending: pending === null ? null : { expectedRevision: pending.expectedRevision, mutationId: pending.mutationId, content: clone(pending.content) },
  });
  const notify = () => {
    // Observer failures must not turn an acknowledged write into an unknown-result retry.
    try { options.onChange?.(snapshot()); } catch { /* State remains available through snapshot(). */ }
  };
  const clearTimer = () => {
    if (timer !== null) { timers.clearTimeout(timer); timer = null; }
  };
  const writable = () => enabled && !disposed && blocked === null;
  const restStatus = (): AutosaveStatus => !enabled ? "stopped" : blocked ?? (isDirty() ? "dirty" : hasSaved ? "saved" : "idle");
  const schedule = () => {
    clearTimer();
    if (!writable() || active !== null || !isDirty()) return;
    timer = timers.setTimeout(() => { timer = null; void saveNext(); }, debounceMs);
  };

  function saveNext(): Promise<void> {
    if (!writable()) return Promise.resolve();
    if (active !== null) return active;
    clearTimer();
    if (pending === null) {
      if (!isDirty()) return Promise.resolve();
      try {
        const mutationId = createMutationId();
        if (typeof mutationId !== "string" || !mutationId.trim()) throw new Error("无法创建草稿保存请求编号。");
        pending = { expectedRevision: revision, mutationId, content: clone(payload), editVersion };
      } catch (failure) {
        error = describeError(failure); blocked = "failed"; status = "failed"; notify();
        return Promise.resolve();
      }
    }
    const mutation = pending;
    // Start on a microtask so active is assigned before a callback can call flush().
    const operation: Promise<void> = Promise.resolve().then(async () => {
      try {
        const result = await options.save({ expectedRevision: mutation.expectedRevision, mutationId: mutation.mutationId, content: clone(mutation.content) });
        if (disposed) return;
        if (!Number.isInteger(result.revision) || result.revision <= mutation.expectedRevision || result.revision <= revision) {
          throw { code: "INVALID_SAVE_REVISION", message: "保存返回的版本无法确认，请读取最新草稿后再处理。", status: 409 };
        }
        const savedContent = clone(result.content === undefined ? mutation.content : result.content);
        revision = result.revision;
        baseline = savedContent;
        // An older response never replaces text typed after its request started.
        if (editVersion === mutation.editVersion) payload = clone(savedContent);
        pending = null; blocked = null; error = null; hasSaved = true;
        status = restStatus(); notify();
      } catch (failure) {
        if (disposed) return;
        error = describeError(failure);
        blocked = error.status === 409 || error.code === "REVISION_CONFLICT" || error.code === "VERSION_CONFLICT"
          || error.code === "DRAFT_CONFLICT" || error.code === "DOCUMENT_CHANGED" ? "conflict" : "failed";
        if (error.status === 403 || error.code === "FORBIDDEN" || error.code === "PROJECT_ARCHIVED") enabled = false;
        status = restStatus(); notify();
      } finally {
        if (active === operation) active = null;
        if (!disposed) schedule();
      }
    });
    active = operation; error = null; status = "saving"; notify();
    return operation;
  }

  async function flush(): Promise<void> {
    clearTimer();
    while (writable()) {
      if (active !== null) await active;
      else if (pending !== null || isDirty()) await saveNext();
      else break;
    }
    clearTimer();
  }

  return {
    snapshot,
    edit(next) {
      if (disposed) return;
      const copied = clone(next);
      if (equals(copied, payload)) return;
      payload = copied; editVersion += 1;
      status = !enabled ? "stopped" : blocked ?? (active !== null ? "saving" : restStatus());
      notify(); schedule();
    },
    flush,
    async retry() {
      if (disposed || !enabled || blocked === "conflict") return;
      if (active !== null) { await active; return; }
      // The API rejects invalid bodies before any write. A corrected body needs a
      // fresh key; a transport/5xx failure may have committed and must replay first.
      if (blocked === "failed" && (error?.status === 422 || error?.status === 413) && pending !== null && !equals(payload, pending.content)) pending = null;
      blocked = null; error = null;
      await saveNext();
      // Resolve the original receipt first, then use its revision for newer edits.
      if (writable()) await flush();
    },
    resolveConflict(resolution) {
      if (disposed || !enabled || active !== null || blocked !== "conflict") return false;
      if (!Number.isInteger(resolution.revision) || resolution.revision < revision) throw new RangeError("latest revision cannot precede the accepted revision");
      if (resolution.mode !== "adopt" && resolution.mode !== "rebase") throw new TypeError("unknown conflict resolution mode");
      const latest = clone(resolution.content);
      revision = resolution.revision; baseline = latest;
      if (resolution.mode === "adopt") { payload = clone(latest); editVersion += 1; }
      pending = null; blocked = null; error = null; hasSaved = true;
      status = restStatus(); notify(); schedule();
      return true;
    },
    setEnabled(next) {
      if (disposed || enabled === next) return;
      enabled = next; clearTimer();
      status = !enabled ? "stopped" : blocked ?? (active !== null ? "saving" : restStatus());
      notify(); schedule();
    },
    dispose() {
      if (disposed) return;
      disposed = true; enabled = false; status = "stopped"; clearTimer();
    },
  };
}
