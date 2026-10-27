import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import type { Actor, Clock, ProjectAccessPort } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { SqlExecutor, SqlResult } from "../../shared/persistence.ts";
import type { EventRuleVersion } from "./domain.ts";
import type { AnalysisContent, AnalysisRun, EventAnalysis, ProjectWriteAccessPort } from "./model.ts";
import { EventsService } from "./service.ts";
import { MemoryEventsRepository } from "./testing/memory-repository.ts";
import { createEventAnalysisWorker, PostgresEventAnalysisQueue } from "./worker.ts";
import type { EventAnalysisQueuePort, EventAnalysisRunQueueEntry } from "./worker.ts";

const queuedAt = "2026-10-08T04:00:00.000Z";

function run(id: string, status: AnalysisRun["status"] = "succeeded", overrides: Partial<AnalysisRun> = {}): AnalysisRun {
  return {
    id, analysisId: `analysis-${id}`, projectId: "project", actorId: "manager",
    idempotencyKey: id, inputHash: "fixture-hash", status, attempts: 1,
    queuedAt, startedAt: queuedAt, finishedAt: queuedAt, errorCode: null,
    usage: null, revision: 1, ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function queue(queued: readonly string[] = [], running: readonly string[] = []): EventAnalysisQueuePort {
  return { listQueuedRunIds: async () => queued, listRunningRunIds: async () => running };
}

function service(overrides: Partial<Pick<EventsService, "processAnalysisRun" | "recoverExpiredAnalysisRun">> = {}) {
  return {
    processAnalysisRun: async (id: string) => run(id),
    recoverExpiredAnalysisRun: async (id: string) => run(id, "running"),
    ...overrides,
  };
}

function isDomainCode(code: string) {
  return (error: unknown) => error instanceof DomainError && error.code === code;
}

class RecordingExecutor implements SqlExecutor {
  readonly calls: { statement: string; parameters: readonly unknown[] }[] = [];
  rows: readonly EventAnalysisRunQueueEntry[] = [];

  async query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.calls.push({ statement, parameters });
    return { rows: this.rows as readonly unknown[] as readonly Row[], rowCount: this.rows.length };
  }
}

test("PostgreSQL queue binds limits/statuses and exposes only ledger metadata", async () => {
  const database = new RecordingExecutor();
  const value: EventAnalysisRunQueueEntry = { id: "run-1", projectId: "project", actorId: "manager", revision: 3, status: "queued", createdAt: queuedAt };
  database.rows = [value];
  const postgres = new PostgresEventAnalysisQueue(database);
  assert.deepEqual(await postgres.listQueuedAnalysisRuns(7), [value]);
  assert.deepEqual(database.calls[0]!.parameters, ["queued", 7]);
  assert.match(database.calls[0]!.statement, /WHERE body->>'status' = \$1/);
  assert.match(database.calls[0]!.statement, /ORDER BY body->>'queuedAt' ASC, id ASC\s+LIMIT \$2/);
  assert.match(database.calls[0]!.statement, /body->>'queuedAt' AS "createdAt"/);
  assert.doesNotMatch(database.calls[0]!.statement, /SELECT body\b|inputHash|idempotencyKey|analysisId/);
  assert.deepEqual(await postgres.listQueuedRunIds(11), ["run-1"]);
  database.rows = [{ ...value, status: "running" }];
  assert.deepEqual(await postgres.listRunningAnalysisRuns(4), [{ ...value, status: "running" }]);
  assert.deepEqual(database.calls[2]!.parameters, ["running", 4]);
  assert.match(database.calls[2]!.statement, /ORDER BY body->>'startedAt' ASC NULLS FIRST, body->>'queuedAt' ASC, id ASC/);
  assert.deepEqual(await postgres.listRunningRunIds(1), ["run-1"]);
});

test("PostgreSQL queue rejects out-of-range or injected limits before SQL", async () => {
  const database = new RecordingExecutor();
  const postgres = new PostgresEventAnalysisQueue(database);
  for (const value of [0, -1, 51, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1; DROP TABLE m03_analysis_runs"] as number[]) {
    await assert.rejects(postgres.listQueuedRunIds(value), isDomainCode("INVALID_CONFIGURATION"));
    await assert.rejects(postgres.listRunningAnalysisRuns(value), isDomainCode("INVALID_CONFIGURATION"));
  }
  assert.equal(database.calls.length, 0);
});

test("actual PostgreSQL engine selects bounded queued/running IDs with stable ordering", async () => {
  const engine = new PGlite();
  const database: SqlExecutor = {
    async query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<SqlResult<Row>> {
      const result = await engine.query<Row>(statement, [...parameters]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  try {
    // SQL execution fixture for queue selection; the production table has further
    // FK/check constraints supplied by the module migrations.
    await engine.exec("CREATE TABLE m03_analysis_runs (id text PRIMARY KEY, revision integer NOT NULL, body jsonb NOT NULL)");
    const values = [
      run("queue-b", "queued", { queuedAt: "2026-10-08T04:00:00.000Z" }),
      run("queue-a", "queued", { queuedAt: "2026-10-08T04:00:00.000Z" }),
      run("queue-c", "queued", { queuedAt: "2026-10-08T05:00:00.000Z" }),
      run("running-new", "running", { startedAt: "2026-10-08T05:00:00.000Z" }),
      run("running-old", "running", { startedAt: "2026-10-08T03:00:00.000Z" }),
      run("running-missing-start", "running", { startedAt: null }),
      run("completed", "succeeded"),
    ];
    for (const value of values) await database.query("INSERT INTO m03_analysis_runs(id, revision, body) VALUES ($1, $2, $3::jsonb)", [value.id, value.revision, JSON.stringify(value)]);
    const postgres = new PostgresEventAnalysisQueue(database);
    assert.deepEqual(await postgres.listQueuedRunIds(2), ["queue-a", "queue-b"]);
    assert.deepEqual(await postgres.listRunningRunIds(50), ["running-missing-start", "running-old", "running-new"]);
    assert.deepEqual(await postgres.listQueuedAnalysisRuns(1), [{ id: "queue-a", projectId: "project", actorId: "manager", revision: 1, status: "queued", createdAt: queuedAt }]);
  } finally { await engine.close(); }
});

test("worker configuration has bounded integral batches and concurrency", () => {
  for (const batchSize of [0, -1, 51, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createEventAnalysisWorker({ service: service(), queue: queue(), batchSize }), isDomainCode("INVALID_CONFIGURATION"));
  }
  for (const concurrency of [0, -1, 5, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createEventAnalysisWorker({ service: service(), queue: queue(), concurrency }), isDomainCode("INVALID_CONFIGURATION"));
  }
  assert.doesNotThrow(() => createEventAnalysisWorker({ service: service(), queue: queue(), batchSize: 1, concurrency: 1 }));
  assert.doesNotThrow(() => createEventAnalysisWorker({ service: service(), queue: queue(), batchSize: 50, concurrency: 4 }));
});

test("default batch bounds a queue ignoring its limit and runs at most two calls", async () => {
  const release = deferred<void>();
  const twoStarted = deferred<void>();
  const limits: number[] = [];
  const ids = Array.from({ length: 30 }, (_, index) => `run-${index}`);
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const worker = createEventAnalysisWorker({
    queue: {
      listRunningRunIds: async limit => { limits.push(limit); return []; },
      listQueuedRunIds: async limit => { limits.push(limit); return ids; },
    },
    service: service({ processAnalysisRun: async id => {
      calls++;
      active++;
      maximum = Math.max(maximum, active);
      if (calls === 2) twoStarted.resolve();
      await release.promise;
      active--;
      return run(id);
    } }),
  });
  const pending = worker.runOnce();
  await twoStarted.promise;
  assert.equal(calls, 2);
  assert.equal(active, 2);
  release.resolve();
  const result = await pending;
  assert.deepEqual(limits, [10, 10]);
  assert.equal(calls, 10);
  assert.equal(maximum, 2);
  assert.equal(result.processed, 10);
  assert.equal(result.succeeded, 10);
});

test("recovery finishes before queued processing and uses the configured concurrency bound", async () => {
  const recoverRelease = deferred<void>();
  const recoverStarted = deferred<void>();
  const processRelease = deferred<void>();
  const processStarted = deferred<void>();
  const ids = Array.from({ length: 6 }, (_, index) => `run-${index}`);
  let active = 0;
  let maximum = 0;
  let recoveredCalls = 0;
  let processCalls = 0;
  const worker = createEventAnalysisWorker({ batchSize: 6, concurrency: 4, queue: {
    listRunningRunIds: async () => ids,
    listQueuedRunIds: async () => { assert.equal(recoveredCalls, 6); assert.equal(active, 0); return ids; },
  }, service: service({
    recoverExpiredAnalysisRun: async id => {
      active++; recoveredCalls++; maximum = Math.max(maximum, active);
      if (recoveredCalls === 4) recoverStarted.resolve();
      await recoverRelease.promise;
      active--;
      return run(id, "running");
    },
    processAnalysisRun: async id => {
      active++; processCalls++; maximum = Math.max(maximum, active);
      if (processCalls === 4) processStarted.resolve();
      await processRelease.promise;
      active--;
      return run(id);
    },
  }) });
  const pending = worker.runOnce();
  await recoverStarted.promise;
  assert.equal(active, 4);
  assert.equal(processCalls, 0);
  recoverRelease.resolve();
  await processStarted.promise;
  assert.equal(active, 4);
  processRelease.resolve();
  assert.equal((await pending).succeeded, 6);
  assert.equal(maximum, 4);
});

test("worker isolates one-run failures, counts terminal outcomes, and keeps errors private", async () => {
  const result = await createEventAnalysisWorker({ batchSize: 10, concurrency: 1,
    queue: queue(["success", "failed", "cancelled", "owned-elsewhere", "throw-domain", "throw-provider"], ["expired", "active", "recovery-error"]),
    service: service({
      recoverExpiredAnalysisRun: async id => {
        if (id === "recovery-error") throw new DomainError("VERSION_CONFLICT", "private recovery input");
        return run(id, id === "expired" ? "failed" : "running", { errorCode: id === "expired" ? "MODEL_TIMEOUT" : null });
      },
      processAnalysisRun: async id => {
        if (id === "throw-domain") throw new DomainError("MODEL_UNAVAILABLE", "secret model config");
        if (id === "throw-provider") throw new Error("api key / raw provider response / private project");
        if (id === "failed") return run(id, "failed", { errorCode: "INVALID_ANALYSIS" });
        return run(id, id === "cancelled" ? "cancelled" : id === "owned-elsewhere" ? "running" : "succeeded");
      },
    }),
  }).runOnce();
  assert.deepEqual(result, { recovered: 1, processed: 6, succeeded: 1, failed: 3, cancelled: 1, skipped: 1, errors: [
    { runId: "recovery-error", code: "VERSION_CONFLICT" },
    { runId: "failed", code: "INVALID_ANALYSIS" },
    { runId: "throw-domain", code: "MODEL_UNAVAILABLE" },
    { runId: "throw-provider", code: "WORKER_FAILED" },
  ] });
  assert.doesNotMatch(JSON.stringify(result), /secret|private|api key|raw provider/);
});

test("invalid error-code strings cannot enter worker error summaries", async () => {
  const result = await createEventAnalysisWorker({ queue: queue(["bad-domain", "bad-result"]), service: service({
    processAnalysisRun: async id => {
      if (id === "bad-domain") throw new DomainError("provider: secret response", "private payload");
      return run(id, "failed", { errorCode: "a secret response" });
    },
  }) }).runOnce();
  assert.deepEqual(result.errors, [{ runId: "bad-domain", code: "WORKER_FAILED" }, { runId: "bad-result", code: "WORKER_FAILED" }]);
});

test("same-instance reentry shares the pending batch and releases it for the next run", async () => {
  const begun = deferred<void>();
  const release = deferred<void>();
  let queuedQueries = 0;
  let calls = 0;
  const worker = createEventAnalysisWorker({ queue: {
    listRunningRunIds: async () => [],
    listQueuedRunIds: async () => { queuedQueries++; return ["run-1"]; },
  }, service: service({ processAnalysisRun: async id => { calls++; begun.resolve(); await release.promise; return run(id); } }) });
  const first = worker.runOnce();
  await begun.promise;
  const secondSignal = new AbortController();
  secondSignal.abort();
  const second = worker.runOnce(secondSignal.signal);
  assert.equal(first, second);
  assert.equal(calls, 1);
  assert.equal(queuedQueries, 1);
  release.resolve();
  assert.equal((await first).succeeded, 1);
  assert.equal(await second, await first);
  assert.equal((await worker.runOnce()).succeeded, 1);
  assert.equal(queuedQueries, 2);
  assert.equal(calls, 2);
});

test("pre-aborted workers do not select or start tasks", async () => {
  const controller = new AbortController();
  controller.abort();
  const unavailable = async () => { assert.fail("must not reach the queue/service"); };
  const result = await createEventAnalysisWorker({
    queue: { listQueuedRunIds: unavailable, listRunningRunIds: unavailable },
    service: service({ processAnalysisRun: unavailable, recoverExpiredAnalysisRun: unavailable }),
  }).runOnce(controller.signal);
  assert.deepEqual(result, { recovered: 0, processed: 0, succeeded: 0, failed: 0, cancelled: 0, skipped: 0, errors: [] });
});

test("abort during recovery selection starts no recovery and never selects queued work", async () => {
  const controller = new AbortController();
  const selection = deferred<readonly string[]>();
  const worker = createEventAnalysisWorker({ queue: {
    listRunningRunIds: () => selection.promise,
    listQueuedRunIds: async () => { assert.fail("queued selection must not begin"); },
  }, service: service({ recoverExpiredAnalysisRun: async () => { assert.fail("recovery must not begin"); } }) });
  const pending = worker.runOnce(controller.signal);
  controller.abort();
  selection.resolve(["running-1"]);
  assert.equal((await pending).processed, 0);
});

test("abort stops new queued calls while already-started successful calls finish", async () => {
  const controller = new AbortController();
  const begun = deferred<void>();
  const release = deferred<void>();
  const calls: string[] = [];
  const worker = createEventAnalysisWorker({ batchSize: 5, concurrency: 2,
    queue: queue(["run-1", "run-2", "run-3", "run-4", "run-5"]),
    service: service({ processAnalysisRun: async id => {
      calls.push(id);
      if (calls.length === 2) begun.resolve();
      await release.promise;
      return run(id);
    } }),
  });
  const pending = worker.runOnce(controller.signal);
  await begun.promise;
  controller.abort();
  release.resolve();
  const result = await pending;
  assert.deepEqual(calls, ["run-1", "run-2"]);
  assert.equal(result.processed, 2);
  assert.equal(result.succeeded, 2);
  assert.equal(result.cancelled, 0);
  assert.equal(result.skipped, 3);
});

test("abort after queued selection skips selected entries without calling the service", async () => {
  const controller = new AbortController();
  const selected = deferred<readonly string[]>();
  const selecting = deferred<void>();
  const worker = createEventAnalysisWorker({ queue: {
    listRunningRunIds: async () => [],
    listQueuedRunIds: () => { selecting.resolve(); return selected.promise; },
  }, service: service({ processAnalysisRun: async () => { assert.fail("processing must not begin"); } }) });
  const pending = worker.runOnce(controller.signal);
  await selecting.promise;
  controller.abort();
  selected.resolve(["run-1", "run-2"]);
  const result = await pending;
  assert.equal(result.processed, 0);
  assert.equal(result.skipped, 2);
  assert.equal(result.cancelled, 0);
});

test("abort during active recovery awaits it and does not start another recovery or queue phase", async () => {
  const controller = new AbortController();
  const begun = deferred<void>();
  const release = deferred<void>();
  const calls: string[] = [];
  const worker = createEventAnalysisWorker({ concurrency: 1, queue: {
    listRunningRunIds: async () => ["running-1", "running-2"],
    listQueuedRunIds: async () => { assert.fail("queued phase must not start after abort"); },
  }, service: service({ recoverExpiredAnalysisRun: async id => {
    calls.push(id);
    begun.resolve();
    await release.promise;
    return run(id, "failed", { errorCode: "MODEL_TIMEOUT" });
  } }) });
  const pending = worker.runOnce(controller.signal);
  await begun.promise;
  controller.abort();
  release.resolve();
  const result = await pending;
  assert.deepEqual(calls, ["running-1"]);
  assert.equal(result.recovered, 1);
  assert.equal(result.processed, 0);
});

test("a repeated ID in one selection is invoked once and failed results are not retried", async () => {
  const calls: string[] = [];
  const result = await createEventAnalysisWorker({ queue: queue(["run-1", "run-1", "run-2"]), service: service({
    processAnalysisRun: async id => { calls.push(id); return run(id, "failed", { errorCode: "MODEL_FAILED" }); },
  }) }).runOnce();
  assert.deepEqual(calls, ["run-1", "run-2"]);
  assert.equal(result.processed, 2);
  assert.equal(result.failed, 2);
});

test("queue-selection exceptions are sanitized and failed batches permit the next call", async () => {
  let calls = 0;
  const worker = createEventAnalysisWorker({ queue: {
    listRunningRunIds: async () => { if (++calls === 1) throw new Error("password and database connection details"); return []; },
    listQueuedRunIds: async () => [],
  }, service: service() });
  await assert.rejects(worker.runOnce(), (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, "WORKER_FAILED");
    assert.doesNotMatch(error.message, /password|connection details/);
    return true;
  });
  assert.equal((await worker.runOnce()).processed, 0);
});

/** Actual service behavior is exercised through the unchanged in-memory fixture. */
async function serviceFixture() {
  const repository = new MemoryEventsRepository();
  const actor: Actor = { userId: "manager", platformRoles: ["user"] };
  const membership = { membershipId: "membership", projectId: "project", userId: actor.userId, role: "manager" as const, status: "active" as const };
  const access: ProjectAccessPort & ProjectWriteAccessPort = {
    getMembership: async () => membership,
    getMembershipForUpdate: async () => membership,
  };
  let instant = Date.parse(queuedAt);
  const clock: Clock = { now: () => new Date(instant) };
  const rules: EventRuleVersion = {
    eventId: "event", version: 1, createdAt: queuedAt,
    metadata: { name: "Queue fixture", organizer: "Fixture", format: "online", region: "Fixture", officialUrl: "https://example.test/rules" },
    sources: [], evidence: [], facts: [], stages: [], requirements: [], qualityFlags: ["missing_information"],
  };
  const content: AnalysisContent = { facts: [], suggestions: [], checklist: [], unknowns: ["eligibility", "fees", "team_size", "ai_policy"].map(field => ({ field, question: `请确认 ${field}。` })) };
  const analysis: EventAnalysis = {
    id: "analysis-run-1", projectId: "project", eventId: "event", rulesVersion: 1, backgroundVersion: 1,
    inputHash: "fixture-hash", input: { projectId: "project", eventId: "event", rulesVersion: 1, backgroundVersion: 1, background: {} },
    content: null, status: "draft", origin: "model", modelVersion: "fixture", promptVersion: "fixture",
    revision: 1, createdBy: actor.userId, createdAt: queuedAt, confirmedBy: null, confirmedAt: null,
  };
  await repository.transaction(async transaction => {
    await transaction.insertRules(rules);
    await transaction.saveAnalysis(analysis, 0);
    await transaction.saveRun(run("run-1", "queued", { attempts: 0, startedAt: null, finishedAt: null }), 0);
  });
  const started = deferred<void>();
  const finish = deferred<{ content: AnalysisContent }>();
  let modelCalls = 0;
  const actualService = new EventsService({ repository, projectAccess: access, projectWriteAccess: access, clock, ids: { next: () => "unused-id" },
    model: { modelVersion: "fixture", promptVersion: "fixture", generate: async () => { modelCalls++; started.resolve(); return finish.promise; } }, modelTimeoutMs: 1000,
  });
  const actualQueue: EventAnalysisQueuePort = {
    listRunningRunIds: async limit => repository.inspect().runs.filter(value => value.status === "running").slice(0, limit).map(value => value.id),
    listQueuedRunIds: async limit => repository.inspect().runs.filter(value => value.status === "queued").slice(0, limit).map(value => value.id),
  };
  return { repository, actor, service: actualService, queue: actualQueue, started: started.promise, finish: () => finish.resolve({ content }), advance: (milliseconds: number) => { instant += milliseconds; }, modelCalls: () => modelCalls };
}

test("real service cancellation during a worker call discards late model output", async () => {
  const fixture = await serviceFixture();
  const worker = createEventAnalysisWorker(fixture);
  const pending = worker.runOnce();
  await fixture.started;
  await fixture.service.cancelAnalysis(fixture.actor, "project", "run-1");
  fixture.finish();
  const result = await pending;
  assert.equal(result.cancelled, 1);
  assert.equal(result.succeeded, 0);
  assert.equal(fixture.repository.inspect().analyses[0]!.content, null);
  assert.equal(fixture.repository.inspect().analyses[0]!.status, "draft");
  assert.equal(fixture.repository.inspect().confirmations.length, 0);
});

test("separate workers rely on real service claims and never generate twice", async () => {
  const fixture = await serviceFixture();
  const first = createEventAnalysisWorker(fixture).runOnce();
  await fixture.started;
  // Simulate a stale queued selection from a second process, after its peer claimed.
  const second = await createEventAnalysisWorker({ service: fixture.service, queue: queue(["run-1"]) }).runOnce();
  assert.equal(second.skipped, 1);
  assert.equal(fixture.modelCalls(), 1);
  fixture.finish();
  assert.equal((await first).succeeded, 1);
  assert.equal(fixture.modelCalls(), 1);
});

test("real-service expired recovery prevents stale completion and automatic replay", async () => {
  const fixture = await serviceFixture();
  const first = createEventAnalysisWorker(fixture).runOnce();
  await fixture.started;
  const fresh = await createEventAnalysisWorker(fixture).runOnce();
  assert.equal(fresh.recovered, 0);
  assert.equal(fresh.processed, 0);
  fixture.advance(6001);
  const recovery = await createEventAnalysisWorker(fixture).runOnce();
  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.processed, 0);
  assert.equal(fixture.modelCalls(), 1);
  fixture.finish();
  assert.equal((await first).failed, 1);
  const stored = fixture.repository.inspect();
  assert.equal(stored.runs[0]!.status, "failed");
  assert.equal(stored.runs[0]!.errorCode, "MODEL_TIMEOUT");
  assert.equal(stored.analyses[0]!.content, null);
  assert.equal(stored.analyses[0]!.status, "draft");
  assert.equal(stored.confirmations.length, 0);
});
