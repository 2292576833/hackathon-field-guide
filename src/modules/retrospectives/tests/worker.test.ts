import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../../shared/errors.ts";
import type { SqlExecutor } from "../../../shared/persistence.ts";
import type { GenerationJob } from "../domain.ts";
import { createRetrospectiveGenerationWorker, PostgresRetrospectiveGenerationQueue } from "../worker.ts";
import type { RetrospectiveGenerationJobMeta, RetrospectiveGenerationQueuePort, RetrospectiveGenerationServicePort, RetrospectiveGenerationServiceResult } from "../worker.ts";
import { alice, content, fixture, hasCode, manualAnswers, ref } from "./fixtures.ts";

const at = "2026-10-08T10:00:00.000Z";
const clock = { now: () => new Date(at) };
function jobMeta(id = "job-1", status: GenerationJob["status"] = "queued"): RetrospectiveGenerationJobMeta {
  return { id, projectId: "p1", actorId: "alice", revision: 1, status, createdAt: at };
}
function serviceJob(id: string, status: GenerationJob["status"], errorCode?: string): RetrospectiveGenerationServiceResult {
  return { id, projectId: "p1", ownerId: "alice", revision: 3, status, createdAt: at, ...(errorCode !== undefined ? { errorCode } : {}) };
}
function ports(queued: readonly RetrospectiveGenerationJobMeta[] = []): { queue: RetrospectiveGenerationQueuePort; service: RetrospectiveGenerationServicePort } {
  return { queue: { async listQueued() { return queued; }, async listExpiredRunning() { return []; } }, service: { async runGeneration(id) { return serviceJob(id, "succeeded"); }, async recoverExpiredGeneration(id) { return serviceJob(id, "failed", "WORKER_EXPIRED"); } } };
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = () => resolve(); });
  return { promise, release };
}

test("PostgreSQL queue parameterizes kinds, status, limits and timestamp and selects metadata only", async () => {
  const calls: { statement: string; parameters: readonly unknown[] }[] = [];
  const database: SqlExecutor = {
    async query<Row>(statement: string, parameters?: readonly unknown[]) {
      calls.push({ statement, parameters: parameters ?? [] });
      const row = { id: "job-1", project_id: "p1", owner_id: "alice", revision: "7", status: calls.length === 1 ? "queued" : "running", created_at: new Date(at), body: { SECRET_BODY: "PRIVATE_CONTENT" } };
      return { rows: [row] as Row[], rowCount: 1 };
    },
  };
  const queue = new PostgresRetrospectiveGenerationQueue(database);
  assert.deepEqual(await queue.listQueued(10), [{ ...jobMeta(), revision: 7 }]);
  assert.deepEqual(await queue.listExpiredRunning({ updatedBefore: "2026-10-08T18:00:00+08:00", limit: 8 }), [{ ...jobMeta("job-1", "running"), revision: 7 }]);
  assert.deepEqual(calls[0].parameters, ["generation_job", "queued", 10]);
  assert.deepEqual(calls[1].parameters, ["generation_job", "running", at, 8]);
  assert.match(calls[0].statement, /FROM m07_documents/);
  assert.match(calls[0].statement, /WHERE kind = \$1 AND body->>'status' = \$2/);
  assert.match(calls[0].statement, /ORDER BY created_at ASC, id COLLATE "C" ASC LIMIT \$3/);
  assert.match(calls[1].statement, /updated_at < \$3::timestamptz/);
  assert.match(calls[1].statement, /ORDER BY updated_at ASC, id COLLATE "C" ASC LIMIT \$4/);
  assert.doesNotMatch(calls.map(call => call.statement).join("\n"), /SELECT \*|FOR UPDATE|SKIP LOCKED|INSERT|DELETE/);
});

test("queue bounds and timezone-bearing cutoff are validated before SQL", async () => {
  let calls = 0;
  const queue = new PostgresRetrospectiveGenerationQueue({ async query<Row>() { calls++; return { rows: [] as Row[], rowCount: 0 }; } });
  for (const count of [0, 101, 1.2, Number.NaN]) await assert.rejects(queue.listQueued(count), hasCode("WORKER_CONFIG_INVALID"));
  await assert.rejects(queue.listExpiredRunning({ updatedBefore: "2026-10-08", limit: 10 }), hasCode("WORKER_CONFIG_INVALID"));
  await assert.rejects(queue.listExpiredRunning({ updatedBefore: "2026-10-08T10:00:00Z'; SELECT private", limit: 10 }), hasCode("WORKER_CONFIG_INVALID"));
  assert.equal(calls, 0);
});

test("PostgreSQL running inventory filters running jobs without an expiry cutoff", async () => {
  const database: SqlExecutor = { async query<Row>(statement: string, parameters?: readonly unknown[]) {
    assert.deepEqual(parameters, ["generation_job", "running", 9]);
    assert.match(statement, /WHERE kind = \$1 AND body->>'status' = \$2/);
    assert.match(statement, /ORDER BY updated_at ASC, id COLLATE "C" ASC LIMIT \$3/);
    assert.doesNotMatch(statement, /updated_at\s*[<>]|timestamptz|SELECT \*/);
    return { rows: [{ id: "running-1", project_id: "p1", owner_id: "alice", revision: 2, status: "running", created_at: at }] as Row[], rowCount: 1 };
  } };
  const queue = new PostgresRetrospectiveGenerationQueue(database);
  assert.deepEqual(await queue.listRunning(9), [{ ...jobMeta("running-1", "running"), revision: 2 }]);
});

test("factory running inventory uses the native port and projects metadata only", async () => {
  const worker = createRetrospectiveGenerationWorker({ ...ports(), clock, queue: {
    async listQueued() { return []; },
    async listRunning(count) { assert.equal(count, 2); return [{ ...jobMeta("running-1", "running"), privateBody: "PRIVATE_CONTENT" }]; },
    async listExpiredRunning() { assert.fail("Native running inventory must not apply an expiry cutoff."); },
  } });
  assert.deepEqual(await worker.listRunning(2), [jobMeta("running-1", "running")]);
});

test("legacy running inventory falls back to the current clock without an expiry grace", async () => {
  const worker = createRetrospectiveGenerationWorker({ ...ports(), clock, queue: {
    async listQueued() { return []; },
    async listExpiredRunning(input) { assert.deepEqual(input, { updatedBefore: at, limit: 4 }); return [jobMeta("legacy-running", "running")]; },
  } });
  assert.deepEqual(await worker.listRunning(4), [jobMeta("legacy-running", "running")]);
});

test("queue storage errors and invalid metadata never expose database/provider text", async () => {
  const failing = new PostgresRetrospectiveGenerationQueue({ async query() { throw new Error("DATABASE_PASSWORD_PRIVATE_BODY"); } });
  await assert.rejects(failing.listQueued(1), error => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, "GENERATION_QUEUE_UNAVAILABLE");
    assert.doesNotMatch(error.message, /PASSWORD|PRIVATE_BODY/);
    return true;
  });
  const invalid = new PostgresRetrospectiveGenerationQueue({ async query<Row>() { return { rows: [{ id: "job-1", project_id: "p1", owner_id: "alice", revision: "9007199254740992", status: "queued", created_at: at }] as Row[], rowCount: 1 }; } });
  await assert.rejects(invalid.listQueued(1), hasCode("QUEUE_DATA_INVALID"));
});

test("coordinator registration methods project safe metadata and preserve controlled error codes", async () => {
  const extra = { ...serviceJob("job-1", "failed", "MODEL_TIMEOUT"), content: "PRIVATE_PROSE", token: "PRIVATE_TOKEN", attempts: 2 };
  const worker = createRetrospectiveGenerationWorker({ ...ports(), clock, service: { async runGeneration() { return extra; }, async recoverExpiredGeneration() { return extra; } } });
  assert.equal(worker.kind, "m07_retrospective");
  assert.deepEqual(await worker.execute("job-1"), { ...jobMeta("job-1", "failed"), revision: 3, errorCode: "MODEL_TIMEOUT" });
  assert.deepEqual(await worker.recover("job-1"), { ...jobMeta("job-1", "failed"), revision: 3, errorCode: "MODEL_TIMEOUT" });
  assert.doesNotMatch(JSON.stringify(await worker.execute("job-1")), /ownerId|attempts|PRIVATE/);
});

test("runOnce recovers first, derives expiry from timeout plus grace and bounds the total batch", async () => {
  const order: string[] = [];
  const worker = createRetrospectiveGenerationWorker({ clock, modelTimeoutMs: 5000, batchSize: 3,
    queue: {
      async listExpiredRunning(input) { assert.deepEqual(input, { updatedBefore: "2026-10-08T09:59:25.000Z", limit: 3 }); order.push("list-expired"); return [jobMeta("old-1", "running"), jobMeta("old-2", "running")]; },
      async listQueued(count) { assert.equal(count, 1); order.push("list-queued"); return [jobMeta("new-1"), jobMeta("new-2")]; },
    },
    service: {
      async recoverExpiredGeneration(id) { order.push(`recover:${id}`); return serviceJob(id, "failed", "WORKER_EXPIRED"); },
      async runGeneration(id) { order.push(`execute:${id}`); return serviceJob(id, "succeeded"); },
    },
  });
  const result = await worker.runOnce();
  assert.deepEqual(order, ["list-expired", "recover:old-1", "recover:old-2", "list-queued", "execute:new-1"]);
  assert.deepEqual({ recovered: result.recovered, succeeded: result.succeeded, failed: result.failed, skipped: result.skipped, aborted: result.aborted }, { recovered: 2, succeeded: 1, failed: 0, skipped: 0, aborted: false });
  assert.equal(result.jobs.length, 3);
});

test("default batch is 10 and invalid batch/timeout configuration is rejected", async () => {
  const defaults = ports();
  defaults.queue.listExpiredRunning = async input => { assert.deepEqual(input, { updatedBefore: "2026-10-08T09:59:10.000Z", limit: 10 }); return []; };
  defaults.queue.listQueued = async count => { assert.equal(count, 10); return []; };
  assert.equal((await createRetrospectiveGenerationWorker({ ...defaults, clock }).runOnce()).jobs.length, 0);
  for (const batchSize of [0, 101, 1.5, Number.NaN]) assert.throws(() => createRetrospectiveGenerationWorker({ ...ports(), clock, batchSize }), hasCode("WORKER_CONFIG_INVALID"));
  for (const modelTimeoutMs of [0, 60_001, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => createRetrospectiveGenerationWorker({ ...ports(), clock, modelTimeoutMs }), hasCode("WORKER_CONFIG_INVALID"));
});

test("one job's exception or failed state does not stop the batch and summaries contain no provider prose", async () => {
  const called: string[] = [];
  const worker = createRetrospectiveGenerationWorker({ ...ports([jobMeta("job-a"), jobMeta("job-b"), jobMeta("job-c")]), clock, service: {
    async recoverExpiredGeneration(id) { return serviceJob(id, "failed", "WORKER_EXPIRED"); },
    async runGeneration(id) {
      called.push(id);
      if (id === "job-a") throw new Error("PROVIDER_RESPONSE_PRIVATE_PROMPT");
      if (id === "job-b") return serviceJob(id, "failed", "private token=123");
      return serviceJob(id, "succeeded");
    },
  } });
  const result = await worker.runOnce();
  assert.deepEqual(called, ["job-a", "job-b", "job-c"]);
  assert.equal(result.failed, 2);
  assert.equal(result.succeeded, 1);
  assert.deepEqual(result.jobs.map(item => item.code), ["GENERATION_WORKER_ERROR", "GENERATION_FAILED", undefined]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROMPT|token=|projectId|actorId|message|stack/);
});

test("VERSION_CONFLICT is skipped without retry and duplicate queue entries are not executed twice", async () => {
  let calls = 0;
  const worker = createRetrospectiveGenerationWorker({ ...ports([jobMeta("job-1"), jobMeta("job-1")]), clock, service: {
    async recoverExpiredGeneration(id) { return serviceJob(id, "failed", "WORKER_EXPIRED"); },
    async runGeneration() { calls++; throw new DomainError("VERSION_CONFLICT", "PRIVATE_CONFLICT_CONTEXT", { status: 409 }); },
  } });
  const result = await worker.runOnce();
  assert.equal(calls, 1);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.jobs.map(item => item.code), ["VERSION_CONFLICT", "DUPLICATE_JOB"]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CONFLICT_CONTEXT/);
});

test("abort drains the current job and starts no new job", async () => {
  const controller = new AbortController(), started = barrier(), finish = barrier();
  const calls: string[] = [];
  const worker = createRetrospectiveGenerationWorker({ ...ports([jobMeta("first"), jobMeta("second")]), clock, service: {
    async recoverExpiredGeneration(id) { return serviceJob(id, "failed", "WORKER_EXPIRED"); },
    async runGeneration(id) { calls.push(id); started.release(); await finish.promise; return serviceJob(id, "succeeded"); },
  } });
  let settled = false;
  const pending = worker.runOnce({ signal: controller.signal }).then(result => { settled = true; return result; });
  await started.promise;
  controller.abort();
  await Promise.resolve();
  assert.equal(settled, false, "Cancellation must drain the active call rather than dropping its result.");
  finish.release();
  const result = await pending;
  assert.deepEqual(calls, ["first"]);
  assert.equal(result.succeeded, 1);
  assert.equal(result.aborted, true);
  assert.equal(result.jobs.length, 1);
});

test("an already-aborted run performs no queue reads", async () => {
  const controller = new AbortController(); controller.abort();
  const worker = createRetrospectiveGenerationWorker({ ...ports(), clock, queue: { async listQueued() { assert.fail("No queue read after abort."); }, async listExpiredRunning() { assert.fail("No recovery read after abort."); } } });
  assert.deepEqual(await worker.runOnce({ signal: controller.signal }), { recovered: 0, succeeded: 0, failed: 0, skipped: 0, aborted: true, jobs: [] });
});

test("two workers racing on one actual service job use CAS to call the simulated model once", async () => {
  let modelCalls = 0;
  const f = fixture({ model: { async generate() { modelCalls++; return { answers: manualAnswers, evidenceRefs: [ref], resourceIds: [], modelVersion: "test-model" }; } } });
  const doc = await f.service.createRetrospective(alice, "p1", { scope: "personal", content });
  const job = await f.service.enqueueGeneration(alice, doc.id, 1);
  const bothListed = barrier(); let listings = 0;
  const queue: RetrospectiveGenerationQueuePort = {
    async listExpiredRunning() { return []; },
    async listQueued() { if (++listings === 2) bothListed.release(); await bothListed.promise; return [{ id: job.id, projectId: job.projectId, actorId: job.ownerId, revision: job.revision, status: job.status, createdAt: job.createdAt }]; },
  };
  const first = createRetrospectiveGenerationWorker({ service: f.service, queue, clock: f.dependencies.clock });
  const second = createRetrospectiveGenerationWorker({ service: f.service, queue, clock: f.dependencies.clock });
  const results = await Promise.all([first.runOnce(), second.runOnce()]);
  assert.equal(modelCalls, 1);
  assert.equal(results.reduce((sum, result) => sum + result.succeeded, 0), 1);
  assert.equal(results.reduce((sum, result) => sum + result.skipped, 0), 1);
  assert.equal(results.flatMap(result => result.jobs).find(item => item.status === "skipped")?.code, "VERSION_CONFLICT");
  assert.equal((await f.repository.get(job.id))?.status, "succeeded");
  assert.equal((await f.repository.get(doc.id))?.status, "review_required");
});

test("expired actual service job is recovered without a model call and manual content is preserved", async () => {
  let modelCalls = 0;
  const now = new Date("2026-10-08T10:01:00Z");
  const f = fixture({ model: { async generate() { modelCalls++; return {}; } } });
  const doc = await f.service.createRetrospective(alice, "p1", { scope: "personal", content });
  const job = await f.service.enqueueGeneration(alice, doc.id, 1);
  const running: GenerationJob = { ...job, revision: 2, status: "running", attempts: 1 };
  await f.repository.replace(running, 1, { id: "claim-audit", type: "GenerationUpdated", aggregateId: job.id, projectId: job.projectId, actorId: job.ownerId, revision: 2, occurredAt: at });
  f.dependencies.clock = { now: () => now };
  const worker = createRetrospectiveGenerationWorker({ service: f.service, clock: f.dependencies.clock, queue: {
    async listExpiredRunning(input) { assert.equal(input.updatedBefore, "2026-10-08T10:00:10.000Z"); return [{ id: job.id, projectId: job.projectId, actorId: job.ownerId, revision: 2, status: "running", createdAt: job.createdAt }]; },
    async listQueued() { return []; },
  } });
  const result = await worker.runOnce();
  assert.equal(result.recovered, 1);
  assert.equal(result.failed, 0);
  assert.equal(modelCalls, 0);
  assert.equal((await f.repository.get(job.id))?.status, "failed");
  const restored = await f.repository.get(doc.id);
  assert.ok(restored?.kind === "retrospective");
  assert.equal(restored.status, "draft");
  assert.deepEqual(restored.content, doc.content);
  assert.equal(restored.activeJobId, undefined);
});
