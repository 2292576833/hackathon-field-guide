import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test, { after, before, beforeEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Clock } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { PostgresAssessmentRepository } from "./postgres.ts";
import type { AssessmentAttempt, QuestionSet, RubricVersion, ScoringJob } from "./types.ts";
import { createAssessmentScoringRegistration, createAssessmentScoringWorker, PostgresScoringQueue } from "./worker.ts";
import type { AssessmentScoringServicePort, ScoringQueuePort } from "./worker.ts";

const NOW = "2026-10-08T12:00:00.000Z";
const clock: Clock = { now: () => new Date(NOW) };
const timeoutMs = 1000;
const at = (milliseconds: number) => new Date(Date.parse(NOW) + milliseconds).toISOString();
const rubric: RubricVersion = {
  id: "worker-fixture-rubric", version: 1, missingEvidencePolicy: "exclude_from_denominator", limitations: ["仅用于持久队列测试"],
  criteria: [{ id: "criterion", dimension: "testing", label: "验证", weight: 1, maxScore: 1, anchors: ["尚无证据", "说明步骤"] }],
};
const set: QuestionSet = {
  id: "worker-fixture-questions", version: 1, rubricVersionId: rubric.id, status: "published", difficultyLabel: "仅测试夹具",
  questions: [{ id: "question", taskTemplateId: "fixture", prompt: "仅测试存储", criterionIds: ["criterion"], required: true }],
  allowedTools: [], maxFollowUps: 0, limitations: ["没有真实模型接入"],
};

interface RecordedQuery { readonly statement: string; readonly parameters: readonly unknown[] }
function port(engine: PGlite, recorded: RecordedQuery[] = []): DatabasePort {
  function executor(query: (statement: string, parameters: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>): SqlExecutor {
    return { async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      recorded.push({ statement, parameters });
      const result = await query(statement, [...parameters]);
      return { rows: result.rows as Row[], rowCount: result.affectedRows ?? result.rows.length };
    } };
  }
  return {
    ...executor((statement, parameters) => engine.query(statement, parameters)),
    transaction: (work) => engine.transaction((transaction) => work(executor((statement, parameters) => transaction.query(statement, parameters)))),
  };
}

async function setup(engine: PGlite): Promise<void> {
  await engine.waitReady;
  await engine.exec(await readFile(new URL("./sql/001-assessments.sql", import.meta.url), "utf8"));
  await engine.exec(await readFile(new URL("./sql/002-assessment-runtime.sql", import.meta.url), "utf8"));
  await engine.query("INSERT INTO assessments_rubrics (id,version,data) VALUES ($1,$2,$3::jsonb)", [rubric.id, rubric.version, JSON.stringify(rubric)]);
  await engine.query("INSERT INTO assessments_question_sets (id,version,rubric_version_id,status,data) VALUES ($1,$2,$3,$4,$5::jsonb)", [set.id, set.version, rubric.id, set.status, JSON.stringify(set)]);
}

function fixtureJob(id: string, status: ScoringJob["status"] = "queued", options: { createdAt?: string; startedAt?: string | null } = {}): ScoringJob {
  return {
    id, projectId: `project-${id}`, attemptId: `attempt-${id}`, userId: `author-${id}`, idempotencyKey: `key-${id}`,
    inputFingerprint: `fingerprint-${id}`, status, revision: 1, runNumber: 1, correctionReason: "PRIVATE_CORRECTION_TEXT",
    createdAt: options.createdAt ?? at(-120000), startedAt: options.startedAt ?? (status === "running" ? at(-50000) : null),
    finishedAt: null, durationMs: null, failureCode: null, resultScoreId: null,
  };
}

async function insertJob(database: DatabasePort, job: ScoringJob): Promise<void> {
  const attempt: AssessmentAttempt = {
    id: job.attemptId, projectId: job.projectId, membershipId: `membership-${job.id}`, userId: job.userId,
    questionSetId: set.id, rubricVersionId: rubric.id, questionSetSnapshot: set, rubricSnapshot: rubric,
    profile: { experience: "PRIVATE_EXPERIENCE", tools: [], preferredTasks: [], memberAvailabilityVersionId: null },
    answers: [{ questionId: "question", text: "PRIVATE_RAW_ANSWER", aiUsage: "PRIVATE_AI_USAGE", evidence: [] }],
    followUps: [], sharing: { confirmedTasks: [], criterionIds: [] }, status: job.status === "running" ? "scoring" : "submitted",
    revision: 1, latestScoreId: null, activeJobId: job.id, scoringRuns: 1, createdAt: job.createdAt, updatedAt: job.createdAt, submittedAt: job.createdAt,
  };
  await new PostgresAssessmentRepository(database).transaction(async (tx) => {
    await tx.saveAttempt(attempt, null);
    await tx.saveJob(job, null);
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

/** Service stub only. SQL rows and CAS claims are real embedded PostgreSQL, but no
 * real scoring/provider call occurs. Existing AssessmentService owns domain checks.
 */
class DurableServiceStub implements AssessmentScoringServicePort {
  readonly repository: PostgresAssessmentRepository;
  modelRequests = 0;
  recoveries = 0;
  readonly onClaim: (() => Promise<void>) | undefined;

  constructor(database: DatabasePort, onClaim?: () => Promise<void>) {
    this.repository = new PostgresAssessmentRepository(database);
    this.onClaim = onClaim;
  }

  async processScoringJob(id: string): Promise<ScoringJob> {
    const claim = await this.repository.transaction(async (tx) => {
      const job = await tx.getJob(id);
      if (!job) throw new DomainError("NOT_FOUND", "测试任务不存在。", { status: 404 });
      if (job.status !== "queued") return { claimed: false, job };
      const next = { ...job, status: "running" as const, revision: job.revision + 1, startedAt: NOW };
      await tx.saveJob(next, job.revision);
      return { claimed: true, job: next };
    });
    if (!claim.claimed) return claim.job;
    this.modelRequests += 1;
    await this.onClaim?.();
    // Tests explicitly fail rather than manufacture a validated model score.
    return this.finish(id, "MODEL_UNAVAILABLE");
  }

  async recoverExpiredScoringJob(id: string): Promise<ScoringJob> {
    const job = await this.repository.transaction((tx) => tx.getJob(id));
    if (!job) throw new DomainError("NOT_FOUND", "测试任务不存在。", { status: 404 });
    if (job.status !== "running" || Date.parse(NOW) - Date.parse(job.startedAt!) <= timeoutMs + 30000) return job;
    this.recoveries += 1;
    return this.finish(id, "WORKER_INTERRUPTED");
  }

  private finish(id: string, failureCode: string): Promise<ScoringJob> {
    return this.repository.transaction(async (tx) => {
      const job = (await tx.getJob(id))!;
      if (job.status !== "running") return job;
      const next = { ...job, status: "failed" as const, revision: job.revision + 1, failureCode, finishedAt: NOW, durationMs: Math.max(0, Date.parse(NOW) - Date.parse(job.startedAt!)) };
      await tx.saveJob(next, job.revision);
      return next;
    });
  }
}

let engine: PGlite;
let database: DatabasePort;
let queue: PostgresScoringQueue;
const recorded: RecordedQuery[] = [];
before(async () => { engine = new PGlite(); await setup(engine); database = port(engine, recorded); queue = new PostgresScoringQueue(database); });
beforeEach(async () => { await engine.exec("TRUNCATE assessments_attempts CASCADE"); recorded.length = 0; });
after(async () => { await engine?.close(); });

test("PGlite queue scans only ordered, bounded metadata; exact expiry boundary is not recovered", async () => {
  for (const job of [
    fixtureJob("queued-b", "queued", { createdAt: at(-10000) }), fixtureJob("queued-a", "queued", { createdAt: at(-10000) }),
    fixtureJob("queued-old", "queued", { createdAt: at(-20000) }),
    fixtureJob("expired", "running", { startedAt: at(-31001) }),
    fixtureJob("boundary", "running", { startedAt: at(-31000) }), fixtureJob("fresh", "running", { startedAt: at(-500) }),
    fixtureJob("terminal", "failed"),
  ]) await insertJob(database, job);
  recorded.length = 0;
  const queued = await queue.listQueued(2);
  assert.deepEqual(queued.map((job) => job.id), ["queued-old", "queued-a"]);
  const expired = await queue.listExpiredRunning(10, at(-31000));
  assert.deepEqual(expired.map((job) => job.id), ["expired"]);
  assert.deepEqual(Object.keys(queued[0]!).sort(), ["actorId", "createdAt", "id", "projectId", "revision", "status"]);
  assert.equal(queued[0]!.actorId, "author-queued-old");
  assert.equal(queued[0]!.createdAt, at(-20000));
  for (const query of recorded) {
    assert.match(query.statement, /SELECT id, project_id, user_id, revision, status, created_at/);
    assert.equal(/SELECT\s+(?:\*|data)/i.test(query.statement), false);
    assert.equal(/JOIN\s+assessments_attempts/i.test(query.statement), false);
    assert.equal(/FOR UPDATE|FOR SHARE/i.test(query.statement), false);
  }
  assert.deepEqual(recorded[0]!.parameters, [2]);
  assert.deepEqual(recorded[1]!.parameters, [at(-31000), 10]);
  for (const privateToken of ["PRIVATE_RAW_ANSWER", "PRIVATE_CORRECTION_TEXT", "PRIVATE_AI_USAGE", "PRIVATE_EXPERIENCE"]) {
    assert.equal(JSON.stringify({ queued, expired }).includes(privateToken), false);
  }
});

test("registration exposes exact root contract and sanitizes returned execution metadata", async () => {
  await insertJob(database, fixtureJob("registered"));
  const service = new DurableServiceStub(database);
  const registration = createAssessmentScoringRegistration({ queue, service, clock, modelTimeoutMs: timeoutMs });
  assert.equal(registration.kind, "assessment_scoring");
  assert.equal((await registration.listQueued(1))[0]!.id, "registered");
  assert.deepEqual(await registration.listRecoverable(1), []);
  const executed = await registration.execute("registered");
  assert.equal(executed.status, "failed");
  assert.equal(executed.failureCode, "MODEL_UNAVAILABLE");
  assert.equal(service.modelRequests, 1);
  assert.equal(JSON.stringify(executed).includes("PRIVATE_CORRECTION_TEXT"), false);
  assert.equal(Object.hasOwn(executed, "idempotencyKey"), false);
  assert.equal(Object.hasOwn(executed, "inputFingerprint"), false);
  assert.equal((await registration.recover("registered")).status, "failed");
});

test("runOnce bounds total recovery plus execution batch and leaves remaining tasks durably queued", async () => {
  for (const id of ["a", "b", "c", "d"]) await insertJob(database, fixtureJob(id));
  for (const id of ["expired-a", "expired-b"]) await insertJob(database, fixtureJob(id, "running"));
  await insertJob(database, fixtureJob("running-fresh", "running", { startedAt: at(-1000) }));
  const service = new DurableServiceStub(database);
  const worker = createAssessmentScoringWorker({ queue, service, clock, modelTimeoutMs: timeoutMs, batchSize: 3, concurrency: 2 });
  const first = await worker.runOnce();
  assert.equal(first.scanned, 3);
  assert.deepEqual(first.results.map((result) => result.action), ["recover", "recover", "execute"]);
  assert.equal(service.recoveries, 2);
  assert.equal(service.modelRequests, 1);
  assert.deepEqual((await queue.listQueued(10)).map((job) => job.id), ["b", "c", "d"]);
  assert.equal((await service.repository.transaction((tx) => tx.getJob("running-fresh")))!.status, "running");
  const second = await worker.runOnce();
  assert.equal(second.scanned, 3);
  assert.equal(service.modelRequests, 4);
  assert.deepEqual(await queue.listQueued(10), []);
  assert.deepEqual(await worker.runOnce(), { scanned: 0, results: [] });
});

test("two overlapping real SQL scans replay a candidate but CAS claims a model request once", async () => {
  await insertJob(database, fixtureJob("concurrent"));
  const bothScanned = deferred<void>();
  let scans = 0;
  const replayQueue: ScoringQueuePort = {
    listExpiredRunning: (limit, before) => queue.listExpiredRunning(limit, before),
    async listQueued(limit) {
      const snapshot = await queue.listQueued(limit);
      if (++scans === 2) bothScanned.resolve();
      await bothScanned.promise;
      return snapshot;
    },
  };
  const claimed = deferred<void>();
  const finish = deferred<void>();
  const service = new DurableServiceStub(database, async () => { claimed.resolve(); await finish.promise; });
  const options = { queue: replayQueue, service, clock, modelTimeoutMs: timeoutMs, batchSize: 1 };
  const first = createAssessmentScoringWorker(options).runOnce();
  const second = createAssessmentScoringWorker(options).runOnce();
  await claimed.promise;
  const replay = await Promise.race([first, second]);
  assert.equal(replay.results[0]!.status, "running");
  assert.equal(service.modelRequests, 1);
  finish.resolve();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((result) => result.results[0]!.status).sort(), ["failed", "running"]);
  assert.equal(service.modelRequests, 1);
  assert.equal((await service.repository.transaction((tx) => tx.getJob("concurrent")))!.revision, 3);
});

test("expired running recovery is persisted and never dispatches a second model request", async () => {
  await insertJob(database, fixtureJob("crashed", "running"));
  const service = new DurableServiceStub(database);
  const worker = createAssessmentScoringWorker({ queue, service, clock, modelTimeoutMs: timeoutMs });
  const result = await worker.runOnce();
  assert.deepEqual(result.results, [{ jobId: "crashed", action: "recover", status: "failed", errorCode: "WORKER_INTERRUPTED" }]);
  assert.equal(service.modelRequests, 0);
  assert.equal(service.recoveries, 1);
  assert.deepEqual(await worker.runOnce(), { scanned: 0, results: [] });
  const job = (await service.repository.transaction((tx) => tx.getJob("crashed")))!;
  assert.equal(job.failureCode, "WORKER_INTERRUPTED");
  assert.equal(job.finishedAt, NOW);
});

test("one failed execution does not stop the bounded batch or expose internal/private error details", async () => {
  await insertJob(database, fixtureJob("a-poison"));
  await insertJob(database, fixtureJob("b-normal"));
  const stub = new DurableServiceStub(database);
  const service: AssessmentScoringServicePort = {
    async processScoringJob(id) {
      if (id === "a-poison") throw new DomainError("PRIVATE_PROVIDER_SECRET", "PRIVATE_RAW_ANSWER provider stack and API key");
      return stub.processScoringJob(id);
    },
    recoverExpiredScoringJob: (id) => stub.recoverExpiredScoringJob(id),
  };
  const result = await createAssessmentScoringWorker({ queue, service, clock, modelTimeoutMs: timeoutMs, batchSize: 2 }).runOnce();
  assert.deepEqual(result.results.map((item) => [item.jobId, item.status, item.errorCode]), [
    ["a-poison", "error", "WORKER_FAILED"], ["b-normal", "failed", "MODEL_UNAVAILABLE"],
  ]);
  assert.equal(JSON.stringify(result).includes("PRIVATE_"), false);
  assert.deepEqual((await queue.listQueued(10)).map((job) => job.id), ["a-poison"]);
});

test("queue failures produce a safe retryable diagnostic before any model execution", async () => {
  const service = new DurableServiceStub(database);
  const broken: ScoringQueuePort = {
    listQueued: () => Promise.reject(new Error("PRIVATE_DATABASE_PASSWORD")),
    listExpiredRunning: () => Promise.reject(new Error("PRIVATE_DATABASE_PASSWORD")),
  };
  await assert.rejects(createAssessmentScoringWorker({ queue: broken, service, clock }).runOnce(), (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, "SCORING_QUEUE_UNAVAILABLE");
    assert.equal(error.status, 503);
    assert.equal(error.message.includes("PRIVATE_DATABASE_PASSWORD"), false);
    return true;
  });
  assert.equal(service.modelRequests, 0);
});

test("invalid bounds and timestamps are rejected before scanning SQL", async () => {
  recorded.length = 0;
  await assert.rejects(queue.listQueued(0), { code: "INVALID_WORKER_CONFIGURATION" });
  await assert.rejects(queue.listQueued(101), { code: "INVALID_WORKER_CONFIGURATION" });
  await assert.rejects(queue.listExpiredRunning(1, "2026-10-08T12:00:00'; DROP TABLE assessments_scoring_jobs; --"), { code: "INVALID_WORKER_CONFIGURATION" });
  assert.throws(() => createAssessmentScoringWorker({ queue, service: new DurableServiceStub(database), clock, batchSize: 1, concurrency: 2 }), { code: "INVALID_WORKER_CONFIGURATION" });
  assert.equal(recorded.length, 0);
});

test("an actual disk PGlite queue survives close/reopen and remains scannable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "m04-worker-"));
  let disk: PGlite | undefined;
  try {
    disk = new PGlite(directory);
    await setup(disk);
    await insertJob(port(disk), fixtureJob("after-restart"));
    await disk.close();
    disk = new PGlite(directory);
    await disk.waitReady;
    const restartedQueue = new PostgresScoringQueue(port(disk));
    assert.equal((await restartedQueue.listQueued(1))[0]!.id, "after-restart");
    assert.equal((await restartedQueue.listQueued(1))[0]!.status, "queued");
  } finally {
    await disk?.close();
    // Verify this is the exact disposable test directory before recursive removal.
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("m04-worker-"));
    await rm(directory, { recursive: true, force: true });
  }
});
