import test from "node:test";
import assert from "node:assert/strict";
import { createAutosaveController } from "../autosave-controller.ts";
import type { AutosaveMutation, AutosaveSnapshot, AutosaveTimerPort } from "../autosave-controller.ts";

interface Payload { readonly text: string }
interface Saved { readonly revision: number; readonly content?: Payload }

function deferred<Value>() {
  let resolve!: (value: Value) => void, reject!: (error: unknown) => void;
  const promise = new Promise<Value>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function fakeTimers() {
  let now = 0, nextId = 0;
  const jobs = new Map<number, { due: number; callback: () => void }>();
  const port: AutosaveTimerPort = {
    setTimeout(callback, delayMs) { const id = ++nextId; jobs.set(id, { due: now + delayMs, callback }); return id; },
    clearTimeout(handle) { jobs.delete(handle as number); },
  };
  return {
    port,
    advance(ms: number) {
      const end = now + ms;
      while (true) {
        const next = [...jobs.entries()].filter(([, job]) => job.due <= end).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (!next) break;
        now = next[1].due; jobs.delete(next[0]); next[1].callback();
      }
      now = end;
    },
    size: () => jobs.size,
  };
}

const settle = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };

function fixture() {
  const timers = fakeTimers(), requests: AutosaveMutation<Payload>[] = [], responses: ReturnType<typeof deferred<Saved>>[] = [], states: AutosaveSnapshot<Payload>[] = [];
  let key = 0;
  const controller = createAutosaveController({
    initial: { text: "initial" }, revision: 0, timers: timers.port,
    createMutationId: () => `mutation-${++key}`,
    save(mutation) { requests.push(mutation); const response = deferred<Saved>(); responses.push(response); return response.promise; },
    onChange: snapshot => states.push(snapshot),
  });
  return { controller, timers, requests, responses, states };
}

test("debounce saves only the latest input and accepts normalized content when no further edit occurred", async () => {
  const f = fixture();
  assert.equal(f.controller.snapshot().status, "idle");
  f.controller.edit({ text: "first" });
  f.timers.advance(799); await settle();
  assert.equal(f.requests.length, 0);
  f.controller.edit({ text: "latest" });
  f.timers.advance(799); await settle();
  assert.equal(f.requests.length, 0);
  f.timers.advance(1); await settle();
  assert.deepEqual(f.requests, [{ expectedRevision: 0, mutationId: "mutation-1", content: { text: "latest" } }]);
  assert.equal(f.controller.snapshot().status, "saving");
  f.responses[0].resolve({ revision: 1, content: { text: "normalized latest" } }); await settle();
  assert.deepEqual(f.controller.snapshot(), { status: "saved", payload: { text: "normalized latest" }, revision: 1, dirty: false, enabled: true, error: null, pending: null });
  f.timers.advance(10_000); await settle();
  assert.equal(f.requests.length, 1);
});

test("in-flight edits retain input and serialized requests use the newly acknowledged revision", async () => {
  const f = fixture();
  f.controller.edit({ text: "request one" });
  f.timers.advance(800); await settle();
  f.controller.edit({ text: "typed while saving" });
  f.timers.advance(5_000); await settle();
  assert.equal(f.requests.length, 1);
  f.responses[0].resolve({ revision: 1, content: { text: "server normalized old input" } }); await settle();
  assert.equal(f.controller.snapshot().payload.text, "typed while saving");
  assert.equal(f.controller.snapshot().status, "dirty");
  f.timers.advance(800); await settle();
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[1], { expectedRevision: 1, mutationId: "mutation-2", content: { text: "typed while saving" } });
  f.responses[1].resolve({ revision: 2 }); await settle();
  assert.equal(f.controller.snapshot().revision, 2);
  assert.equal(f.controller.snapshot().status, "saved");
});

test("concurrent flush calls drain edits without overlapping or duplicating a write", async () => {
  const f = fixture();
  f.controller.edit({ text: "one" });
  const flushOne = f.controller.flush(), flushTwo = f.controller.flush(); await settle();
  assert.equal(f.requests.length, 1);
  f.controller.edit({ text: "two" });
  f.responses[0].resolve({ revision: 1 }); await settle();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].expectedRevision, 1);
  f.responses[1].resolve({ revision: 2 });
  await Promise.all([flushOne, flushTwo]);
  assert.equal(f.requests.length, 2);
  assert.equal(f.timers.size(), 0);
  assert.equal(f.controller.snapshot().status, "saved");
});

test("CAS conflict retains input and requires an explicit latest-content adoption or rebase", async () => {
  const f = fixture();
  f.controller.edit({ text: "mine" });
  const first = f.controller.flush(); await settle();
  f.responses[0].reject({ status: 409, code: "REVISION_CONFLICT", message: "另一标签已保存", latestRevision: 5 }); await first;
  assert.equal(f.controller.snapshot().status, "conflict");
  assert.equal(f.controller.snapshot().payload.text, "mine");
  assert.equal(f.controller.snapshot().error?.latestRevision, 5);
  f.controller.edit({ text: "my further edit" });
  f.timers.advance(10_000); await f.controller.flush(); await f.controller.retry();
  assert.equal(f.requests.length, 1);
  assert.equal(f.controller.snapshot().status, "conflict");
  assert.equal(f.controller.resolveConflict({ revision: 5, content: { text: "other tab" }, mode: "rebase" }), true);
  assert.equal(f.controller.snapshot().payload.text, "my further edit");
  f.timers.advance(800); await settle();
  assert.deepEqual(f.requests[1], { expectedRevision: 5, mutationId: "mutation-2", content: { text: "my further edit" } });
  f.responses[1].reject({ status: 409, code: "REVISION_CONFLICT", message: "再次变更" }); await settle();
  assert.equal(f.controller.resolveConflict({ revision: 6, content: { text: "latest on server" }, mode: "adopt" }), true);
  assert.equal(f.controller.snapshot().payload.text, "latest on server");
  assert.equal(f.controller.snapshot().dirty, false);
  f.timers.advance(10_000); await settle();
  assert.equal(f.requests.length, 2);
});

test("unknown transport failure replays the exact pending key and content before newer edits", async () => {
  const f = fixture();
  f.controller.edit({ text: "unknown request" });
  const first = f.controller.flush(); await settle();
  f.responses[0].reject(new Error("网络中断，结果未知")); await first;
  assert.equal(f.controller.snapshot().status, "failed");
  const pending = f.controller.snapshot().pending;
  f.controller.edit({ text: "new text after failure" });
  f.timers.advance(20_000); await f.controller.flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.controller.snapshot().payload.text, "new text after failure");
  const retry = f.controller.retry(); await settle();
  assert.deepEqual(f.requests[1], pending);
  assert.equal(f.requests.length, 2);
  f.responses[1].resolve({ revision: 1, content: { text: "original accepted receipt" } }); await settle();
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.requests[2], { expectedRevision: 1, mutationId: "mutation-2", content: { text: "new text after failure" } });
  assert.equal(f.controller.snapshot().payload.text, "new text after failure");
  f.responses[2].resolve({ revision: 2 }); await retry;
  assert.equal(f.controller.snapshot().status, "saved");
});

test("non-conflict 4xx failures do not retry automatically, and an explicit retry retains its key", async () => {
  const f = fixture();
  f.controller.edit({ text: "keep invalid input" });
  const first = f.controller.flush(); await settle();
  f.responses[0].reject({ status: 422, error: { code: "INVALID_CONTENT", message: "请检查输入" } }); await first;
  assert.equal(f.controller.snapshot().error?.code, "INVALID_CONTENT");
  assert.equal(f.controller.snapshot().error?.status, 422);
  f.timers.advance(20_000); await f.controller.flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.controller.snapshot().payload.text, "keep invalid input");
  const retry = f.controller.retry(); await settle();
  assert.deepEqual(f.requests[1], f.requests[0]);
  f.responses[1].reject({ status: 422, code: "INVALID_CONTENT", message: "仍需检查" }); await retry;
  assert.equal(f.controller.snapshot().status, "failed");
});

for (const rejectedStatus of [422, 413]) test(`explicit retry uses a new key for corrected input after known body rejection ${rejectedStatus}`, async () => {
  const f = fixture();
  f.controller.edit({ text: "invalid input" });
  const first = f.controller.flush(); await settle();
  f.responses[0].reject({ status: rejectedStatus, code: "INVALID_INPUT", message: "输入过长" }); await first;
  f.controller.edit({ text: "corrected input" });
  f.timers.advance(10_000); await f.controller.flush();
  assert.equal(f.requests.length, 1);
  const retry = f.controller.retry(); await settle();
  assert.deepEqual(f.requests[1], { expectedRevision: 0, mutationId: "mutation-2", content: { text: "corrected input" } });
  f.responses[1].resolve({ revision: 1 }); await retry;
  assert.equal(f.controller.snapshot().status, "saved");
});

test("DOCUMENT_CHANGED without an HTTP status still requires explicit conflict recovery", async () => {
  const f = fixture();
  f.controller.edit({ text: "draft based on old document" });
  const first = f.controller.flush(); await settle();
  f.responses[0].reject({ code: "DOCUMENT_CHANGED", message: "正式复盘已变更" }); await first;
  assert.equal(f.controller.snapshot().status, "conflict");
  await f.controller.retry(); f.timers.advance(10_000); await settle();
  assert.equal(f.requests.length, 1);
});

for (const failure of [{ status: 403, code: "FORBIDDEN", message: "已不在团队" }, { code: "FORBIDDEN", message: "当前成员权限已撤回" }, { status: 409, code: "PROJECT_ARCHIVED", message: "项目已归档" }]) {
  test(`${failure.code} stops writes while retaining draft input and its recovery mutation`, async () => {
    const f = fixture();
    f.controller.edit({ text: "my private input" });
    const first = f.controller.flush(); await settle();
    f.responses[0].reject(failure); await first;
    assert.equal(f.controller.snapshot().status, "stopped");
    assert.equal(f.controller.snapshot().enabled, false);
    assert.equal(f.controller.snapshot().payload.text, "my private input");
    assert.equal(f.controller.snapshot().pending?.mutationId, "mutation-1");
    f.controller.edit({ text: "still available for personal handling" });
    f.timers.advance(20_000); await f.controller.flush(); await f.controller.retry();
    assert.equal(f.requests.length, 1);
    assert.equal(f.controller.snapshot().payload.text, "still available for personal handling");
  });
}

test("disabling during an in-flight write accepts its receipt but stops subsequent edits from writing", async () => {
  const f = fixture();
  f.controller.edit({ text: "in flight" });
  const first = f.controller.flush(); await settle();
  f.controller.setEnabled(false);
  f.controller.edit({ text: "retained after disable" });
  f.responses[0].resolve({ revision: 1 }); await first;
  assert.equal(f.controller.snapshot().status, "stopped");
  assert.equal(f.controller.snapshot().revision, 1);
  assert.equal(f.controller.snapshot().payload.text, "retained after disable");
  f.timers.advance(10_000); await f.controller.flush();
  assert.equal(f.requests.length, 1);
  f.controller.setEnabled(true);
  f.timers.advance(800); await settle();
  assert.equal(f.requests[1].expectedRevision, 1);
  f.responses[1].resolve({ revision: 2 }); await settle();
  assert.equal(f.controller.snapshot().status, "saved");
});

test("dispose cancels debounce and ignores late responses and notifications", async () => {
  const f = fixture();
  f.controller.edit({ text: "in flight" });
  const first = f.controller.flush(); await settle();
  f.controller.dispose();
  const stateCount = f.states.length;
  f.responses[0].resolve({ revision: 1, content: { text: "late server content" } }); await first;
  assert.equal(f.states.length, stateCount);
  assert.equal(f.controller.snapshot().revision, 0);
  assert.equal(f.controller.snapshot().payload.text, "in flight");
  assert.equal(f.controller.snapshot().status, "stopped");
  f.controller.edit({ text: "ignored" });
  await f.controller.retry(); await f.controller.flush();
  f.timers.advance(10_000); await settle();
  assert.equal(f.requests.length, 1);
  const timerOnly = fixture();
  timerOnly.controller.edit({ text: "never written" }); timerOnly.controller.dispose();
  timerOnly.timers.advance(10_000); await settle();
  assert.equal(timerOnly.requests.length, 0);
});

test("snapshots and transport arguments cannot mutate retained input or idempotency content", async () => {
  const f = fixture();
  const input = { text: "preserved" };
  f.controller.edit(input); input.text = "outside mutation";
  const first = f.controller.flush(); await settle();
  (f.requests[0].content as { text: string }).text = "transport mutation";
  const snapshot = f.controller.snapshot();
  (snapshot.payload as { text: string }).text = "snapshot mutation";
  (snapshot.pending!.content as { text: string }).text = "pending mutation";
  assert.equal(f.controller.snapshot().payload.text, "preserved");
  f.responses[0].reject(new Error("unknown")); await first;
  const retry = f.controller.retry(); await settle();
  assert.equal(f.requests[1].content.text, "preserved");
  f.responses[1].resolve({ revision: 1 }); await retry;
  assert.equal(f.controller.snapshot().payload.text, "preserved");
});

test("an unchanged or regressing response cannot be accepted as a saved CAS revision", async () => {
  const f = fixture();
  f.controller.edit({ text: "my draft" });
  const first = f.controller.flush(); await settle();
  f.responses[0].resolve({ revision: 0 }); await first;
  assert.equal(f.controller.snapshot().status, "conflict");
  assert.equal(f.controller.snapshot().error?.code, "INVALID_SAVE_REVISION");
  assert.equal(f.controller.snapshot().revision, 0);
  assert.equal(f.controller.snapshot().payload.text, "my draft");
  assert.equal(f.controller.snapshot().pending?.mutationId, "mutation-1");
});

test("JSON field ordering and unchanged input do not create unnecessary writes", async () => {
  const timers = fakeTimers(); let calls = 0;
  const controller = createAutosaveController({ initial: { requestedScope: "personal", content: { text: "same", count: 1 } }, revision: 3, timers: timers.port,
    save: async () => { calls += 1; return { revision: 4 }; } });
  controller.edit({ content: { count: 1, text: "same" }, requestedScope: "personal" });
  timers.advance(10_000); await controller.flush();
  assert.equal(calls, 0);
  assert.equal(controller.snapshot().status, "idle");
});
