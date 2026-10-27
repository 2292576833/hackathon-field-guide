import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Transaction } from "@electric-sql/pglite";
import type { Actor, Clock, ProjectAccessPort, ProjectMembershipAccess } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor, SqlResult } from "../../shared/persistence.ts";
import { createEventAnalysisModelAdapter, EVENT_ANALYSIS_PROMPT_VERSION } from "./ai-adapter.ts";
import type { EventAnalysisJsonModelPort } from "./ai-adapter.ts";
import type { EventRuleVersion } from "./domain.ts";
import type { AnalysisContent, AnalysisInput, AnalysisRun, EventAnalysis, ProjectWriteAccessPort } from "./model.ts";
import { PostgresEventsRepository } from "./postgres.ts";
import { EventsService } from "./service.ts";
import { createEventAnalysisWorker, PostgresEventAnalysisQueue } from "./worker.ts";
import type { EventAnalysisQueuePort } from "./worker.ts";

/**
 * Real SQL integration: both module migrations run on the installed PostgreSQL
 * engine. Only the provider and M02 access ports are test doubles. PGlite has one
 * connection, so this wrapper serializes SQL/transactions explicitly. These
 * tests do not establish multi-connection server PostgreSQL concurrency safety.
 */
function sqlExecutor(connection: Pick<Transaction, "query">): SqlExecutor {
  return {
    async query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<SqlResult<Row>> {
      const result = await connection.query<Row>(statement, [...parameters]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
}

class PGliteTestDatabase implements DatabasePort {
  private readonly engine: PGlite;
  private pending: Promise<void> = Promise.resolve();

  constructor(engine: PGlite) { this.engine = engine; }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(work);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<SqlResult<Row>> {
    return this.serial(() => sqlExecutor(this.engine).query<Row>(statement, parameters));
  }

  transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    return this.serial(() => this.engine.transaction(transaction => work(sqlExecutor(transaction))));
  }
}

const checkedAt = "2026-10-08T04:00:00.000Z";
const reviewer: Actor = { userId: "test-reviewer", platformRoles: ["reviewer"] };
const manager: Actor = { userId: "test-manager", platformRoles: ["user"] };
const member: Actor = { userId: "test-member", platformRoles: ["user"] };
const projectId = "sql-test-project";
const eventId = "sql-test-event";
type ModelRequest = Parameters<EventAnalysisJsonModelPort["completeJSON"]>[0];
type ModelResult = Awaited<ReturnType<EventAnalysisJsonModelPort["completeJSON"]>>;

class TestClock implements Clock {
  private instant = Date.parse(checkedAt);
  now(): Date { return new Date(this.instant); }
  advance(milliseconds: number): void { this.instant += milliseconds; }
}

function ruleSnapshot(): EventRuleVersion {
  const deadline = "2026-10-20 20:00 Asia/Shanghai";
  return {
    eventId, version: 1, createdAt: checkedAt,
    metadata: { name: "SQL 集成测试赛事", organizer: "测试主办方", format: "online", region: "测试地区", officialUrl: "https://example.test/official-rules" },
    sources: [{ id: "test-official-snapshot", eventId, version: 1, sourceConfigId: null, url: "https://example.test/official-rules", kind: "official", contentHash: "test-fixture-content-hash", fetchedAt: checkedAt, trustScope: "official_rules", status: "available" }],
    evidence: [
      { id: "test-evidence-demo", eventId, version: 1, sourceId: "test-official-snapshot", fieldKey: "requirement.demo", excerpt: "提交演示材料。", locator: "测试规则/必交材料", rawDateText: null, verifiedBy: reviewer.userId, verifiedAt: checkedAt, conflictsWith: [] },
      { id: "test-evidence-deadline", eventId, version: 1, sourceId: "test-official-snapshot", fieldKey: "submission.endsAt", excerpt: `提交截止 ${deadline}。`, locator: "测试规则/截止时间", rawDateText: deadline, verifiedBy: reviewer.userId, verifiedAt: checkedAt, conflictsWith: [] },
    ],
    facts: ["eligibility", "fees", "team_size", "ai_policy"].map(key => ({ key, statement: `${key} 尚未确认。`, status: "unknown", evidenceIds: [] })),
    stages: [{ id: "test-submission", stageType: "submission", name: "作品提交", startsAt: null, endsAt: { rawText: deadline, timeZone: "Asia/Shanghai", utc: "2026-10-20T12:00:00.000Z", dateOnly: false, evidenceIds: ["test-evidence-deadline"] }, submissionUrl: "https://example.test/submit" }],
    requirements: [{ id: "test-demo", label: "演示材料", necessity: "required", stageId: "test-submission", evidenceIds: ["test-evidence-demo"] }],
    qualityFlags: ["missing_information"],
  };
}

function analysisInput(): AnalysisInput {
  return { projectId, eventId, rulesVersion: 1, backgroundVersion: 1, background: { goal: "完成最小可交演示", experience: "第一次参赛" } };
}

function validContent(): AnalysisContent {
  return {
    facts: [{ statement: "官方测试规则列明必交演示材料。", evidenceIds: ["test-evidence-demo"] }],
    suggestions: [{ text: "围绕最小演示整理材料。", evidenceIds: ["test-evidence-demo"], backgroundKeys: ["goal"] }],
    unknowns: ["eligibility", "fees", "team_size", "ai_policy"].map(field => ({ field, question: `请向主办方确认 ${field}。` })),
    checklist: [{ requirementId: "test-demo", action: "准备并核对演示材料。" }],
  };
}

function modelResult(content: unknown = validContent()): ModelResult {
  return { content, usage: { inputTokens: 123, outputTokens: 45 }, requestId: "test-provider-request-1", modelVersion: "test-provider-actual-version" };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function isCode(code: string) {
  return (error: unknown): boolean => error instanceof DomainError && error.code === code;
}

async function fixture(context: TestContext, generate: EventAnalysisJsonModelPort["completeJSON"] = async () => modelResult()) {
  const engine = new PGlite();
  context.after(async () => { await engine.close(); });
  for (const filename of ["001-events.sql", "002-analysis-worker-indexes.sql"]) {
    await engine.exec(await readFile(new URL(`./migrations/${filename}`, import.meta.url), "utf8"));
  }
  const database = new PGliteTestDatabase(engine);
  const repository = new PostgresEventsRepository(database);
  const clock = new TestClock();
  const access: ProjectAccessPort & ProjectWriteAccessPort = {
    async getMembership(requestedProjectId, userId): Promise<ProjectMembershipAccess | null> {
      if (requestedProjectId !== projectId || ![manager.userId, member.userId].includes(userId)) return null;
      return { membershipId: `test-membership-${userId}`, projectId, userId, role: userId === manager.userId ? "manager" : "member", status: "active" };
    },
    getMembershipForUpdate(executor, requestedProjectId, userId) {
      assert.ok(executor, "private mutation receives its SQL transaction executor");
      return this.getMembership(requestedProjectId, userId);
    },
  };
  const requests: ModelRequest[] = [];
  const model: EventAnalysisJsonModelPort = {
    modelVersion: "test-provider-configured-version",
    async completeJSON(request, signal) {
      requests.push(structuredClone(request));
      return generate(request, signal);
    },
  };
  let sequence = 0;
  const service = new EventsService({ repository, projectAccess: access, projectWriteAccess: access, projectBackgroundVersion: { getCurrentBackgroundVersion: async () => 1 }, clock, ids: { next: () => `test-generated-${++sequence}` }, model: createEventAnalysisModelAdapter({ model }), modelTimeoutMs: 5_000 });
  const queue = new PostgresEventAnalysisQueue(database);
  const candidate = await service.createCandidate(reviewer, ruleSnapshot(), 0);
  const reviewing = await service.requestReview(reviewer, eventId, candidate.revision);
  await service.publishCandidate(reviewer, eventId, reviewing.revision);
  return { database, repository, clock, service, queue, requests };
}

async function persistedRun(database: DatabasePort, id: string): Promise<AnalysisRun> {
  const result = await database.query<{ body: AnalysisRun; revision: number; storageType: string }>("SELECT body, revision, pg_typeof(body)::text AS \"storageType\" FROM m03_analysis_runs WHERE id = $1", [id]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.storageType, "jsonb");
  assert.equal(result.rows[0]!.revision, result.rows[0]!.body.revision);
  return result.rows[0]!.body;
}

async function confirmationCount(database: DatabasePort): Promise<number> {
  return (await database.query<{ count: number }>("SELECT count(*)::integer AS count FROM m03_project_rules")).rows[0]!.count;
}

test("real SQL publish/queue/worker persists validated provider metadata and leaves analysis draft", async context => {
  const value = await fixture(context);
  const publicEvent = await value.service.getEvent(eventId);
  assert.equal(publicEvent.event.publicationStatus, "published");
  assert.equal(publicEvent.rules.sources[0]!.url, "https://example.test/official-rules");
  assert.equal((await value.service.listEvents()).items.length, 1);

  const queued = await value.service.queueAnalysis(manager, analysisInput(), "test-idempotency-success");
  assert.equal(queued.status, "queued");
  assert.equal(queued.attempts, 0);
  assert.deepEqual(await value.service.queueAnalysis(manager, analysisInput(), "test-idempotency-success"), queued);
  assert.deepEqual(await persistedRun(value.database, queued.id), queued);
  const rows = await value.database.query<{ body: EventAnalysis; storageType: string }>("SELECT body, pg_typeof(body)::text AS \"storageType\" FROM m03_event_analyses WHERE id = $1", [queued.analysisId]);
  assert.equal(rows.rows[0]!.storageType, "jsonb");
  assert.deepEqual(rows.rows[0]!.body.input, analysisInput());
  assert.equal(rows.rows[0]!.body.content, null);
  assert.equal(value.requests.length, 0);

  const metadata = [{ id: queued.id, projectId, actorId: manager.userId, revision: 1, status: "queued", createdAt: checkedAt }];
  assert.deepEqual(await value.queue.listQueuedAnalysisRuns(10), metadata);
  assert.deepEqual(await value.service.listQueuedAnalysisRuns(10), metadata);
  assert.deepEqual(Object.keys(metadata[0]!).sort(), ["actorId", "createdAt", "id", "projectId", "revision", "status"]);

  const result = await createEventAnalysisWorker({ service: value.service, queue: value.queue }).runOnce();
  assert.deepEqual(result, { recovered: 0, processed: 1, succeeded: 1, failed: 0, cancelled: 0, skipped: 0, errors: [] });
  assert.equal(value.requests.length, 1);
  assert.equal(value.requests[0]!.promptVersion, EVENT_ANALYSIS_PROMPT_VERSION);
  const payload = value.requests[0]!.input as { dataTrust: string; allowedEvidenceIds: string[]; unresolvedCriticalFields: string[]; outputSchema: Record<string, unknown> };
  assert.equal(payload.dataTrust, "untrusted_external_data");
  assert.deepEqual(payload.allowedEvidenceIds, ["test-evidence-demo", "test-evidence-deadline"]);
  assert.deepEqual(payload.unresolvedCriticalFields, ["eligibility", "fees", "team_size", "ai_policy"]);
  assert.equal(payload.outputSchema.additionalProperties, false);

  const completed = await persistedRun(value.database, queued.id);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.revision, 3);
  assert.equal(completed.attempts, 1);
  assert.equal(completed.providerRequestId, "test-provider-request-1");
  assert.deepEqual(completed.usage, { inputTokens: 123, outputTokens: 45 });
  // Reconstruct the repository to prove results are loaded from SQL, not cache.
  const stored = await new PostgresEventsRepository(value.database).getAnalysis(queued.analysisId);
  assert.equal(stored?.status, "draft");
  assert.equal(stored?.modelVersion, "test-provider-actual-version");
  assert.equal(stored?.promptVersion, EVENT_ANALYSIS_PROMPT_VERSION);
  assert.deepEqual(stored?.content, validContent());
  assert.equal(stored?.confirmedBy, null);
  assert.equal(stored?.confirmedAt, null);
  assert.equal(await confirmationCount(value.database), 0);
  assert.deepEqual(await value.queue.listQueuedAnalysisRuns(10), []);
  assert.deepEqual(await value.service.listQueuedAnalysisRuns(10), []);
  assert.equal((await createEventAnalysisWorker({ service: value.service, queue: value.queue }).runOnce()).processed, 0);
  assert.equal(value.requests.length, 1);
  assert.equal((await value.database.query<{ count: number }>("SELECT count(*)::integer AS count FROM m03_analysis_runs")).rows[0]!.count, 1);
});

test("two worker snapshots of one persisted run produce one provider call on serialized PGlite", async context => {
  const began = deferred<void>();
  const finish = deferred<ModelResult>();
  const value = await fixture(context, async () => { began.resolve(); return finish.promise; });
  const queued = await value.service.queueAnalysis(manager, analysisInput(), "test-idempotency-race");
  const bothSelected = deferred<void>();
  let selections = 0;
  const sharedSnapshotQueue: EventAnalysisQueuePort = {
    listRunningRunIds: limit => value.queue.listRunningRunIds(limit),
    async listQueuedRunIds(limit) {
      const ids = await value.queue.listQueuedRunIds(limit);
      assert.deepEqual(ids, [queued.id]);
      if (++selections === 2) bothSelected.resolve();
      await bothSelected.promise;
      return ids;
    },
  };
  const first = createEventAnalysisWorker({ service: value.service, queue: sharedSnapshotQueue }).runOnce();
  const second = createEventAnalysisWorker({ service: value.service, queue: sharedSnapshotQueue }).runOnce();
  try {
    await began.promise;
    const peerResult = await Promise.race([first, second]);
    assert.equal(selections, 2);
    assert.equal(peerResult.processed, 1);
    assert.equal(peerResult.skipped, 1);
    assert.equal(value.requests.length, 1);
    assert.equal((await persistedRun(value.database, queued.id)).status, "running");
  } finally { finish.resolve(modelResult()); }
  const results = await Promise.all([first, second]);
  assert.equal(results.reduce((count, result) => count + result.succeeded, 0), 1);
  assert.equal(results.reduce((count, result) => count + result.skipped, 0), 1);
  assert.equal(value.requests.length, 1);
  assert.equal((await persistedRun(value.database, queued.id)).attempts, 1);
  assert.equal((await persistedRun(value.database, queued.id)).status, "succeeded");
  assert.equal(await confirmationCount(value.database), 0);
});

test("nonexistent evidence fails in real SQL without confirmable content and permits explicit manual confirmation", async context => {
  const invalid = validContent();
  invalid.facts[0]!.evidenceIds = ["invented-evidence-id"];
  const value = await fixture(context, async () => modelResult(invalid));
  const queued = await value.service.queueAnalysis(manager, analysisInput(), "test-idempotency-invalid");
  const result = await createEventAnalysisWorker({ service: value.service, queue: value.queue }).runOnce();
  assert.equal(result.failed, 1);
  assert.deepEqual(result.errors, [{ runId: queued.id, code: "INVALID_ANALYSIS" }]);
  const failed = await persistedRun(value.database, queued.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "INVALID_ANALYSIS");
  assert.equal(failed.attempts, 1);
  assert.equal((await value.repository.getAnalysis(queued.analysisId))?.content, null);
  assert.equal((await value.repository.getAnalysis(queued.analysisId))?.status, "draft");
  await assert.rejects(value.service.confirmProjectRules(manager, projectId, eventId, 1, 0, queued.analysisId), isCode("NOT_FOUND"));
  assert.equal(await confirmationCount(value.database), 0);

  const manual = await value.service.saveManualAnalysis(manager, analysisInput(), validContent());
  assert.equal(manual.origin, "manual");
  assert.equal(manual.status, "draft");
  assert.equal(manual.modelVersion, null);
  await assert.rejects(value.service.confirmProjectRules(member, projectId, eventId, 1, 0, manual.id), isCode("PROJECT_MANAGER_REQUIRED"));
  assert.equal(await confirmationCount(value.database), 0);
  const confirmation = await value.service.confirmProjectRules(manager, projectId, eventId, 1, 0, manual.id);
  assert.equal(confirmation.analysisId, manual.id);
  assert.equal(confirmation.confirmedBy, manager.userId);
  const stored = await new PostgresEventsRepository(value.database).getAnalysis(manual.id);
  assert.equal(stored?.status, "confirmed");
  assert.equal(stored?.confirmedBy, manager.userId);
  assert.equal(await confirmationCount(value.database), 1);
  assert.equal(value.requests.length, 1);
  const outbox = await value.database.query<{ type: string }>("SELECT type FROM m03_events_outbox ORDER BY occurred_at, id");
  assert.deepEqual(outbox.rows.map(row => row.type), ["EventPublished", "ProjectRequirementsConfirmed"]);
});

test("NETWORK_UNKNOWN persists failure, blocks same-run retry and never automatically replays", async context => {
  const value = await fixture(context, async () => { throw new DomainError("NETWORK_UNKNOWN", "测试传输结果未知。", { status: 503 }); });
  const queued = await value.service.queueAnalysis(manager, analysisInput(), "test-idempotency-network");
  const worker = createEventAnalysisWorker({ service: value.service, queue: value.queue });
  const result = await worker.runOnce();
  assert.equal(result.failed, 1);
  assert.deepEqual(result.errors, [{ runId: queued.id, code: "NETWORK_UNKNOWN" }]);
  const failed = await persistedRun(value.database, queued.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "NETWORK_UNKNOWN");
  assert.equal(failed.attempts, 1);
  assert.equal(failed.usage, null);
  assert.equal((await value.repository.getAnalysis(queued.analysisId))?.content, null);
  await assert.rejects(value.service.retryAnalysis(manager, projectId, queued.id), isCode("RETRY_NOT_ALLOWED"));
  assert.deepEqual(await value.service.queueAnalysis(manager, analysisInput(), "test-idempotency-network"), failed);
  assert.equal((await value.service.processAnalysisRun(queued.id)).status, "failed");
  assert.equal((await value.service.recoverExpiredAnalysisRun(queued.id)).errorCode, "NETWORK_UNKNOWN");
  assert.equal((await worker.runOnce()).processed, 0);
  assert.equal(value.requests.length, 1);
  assert.deepEqual(await value.service.listQueuedAnalysisRuns(10), []);
  assert.equal(await confirmationCount(value.database), 0);

  // A different user-supplied key is an explicit new request, not worker replay.
  const explicitlyRequested = await value.service.queueAnalysis(manager, analysisInput(), "test-explicit-new-request");
  assert.notEqual(explicitlyRequested.id, queued.id);
  assert.equal(explicitlyRequested.status, "queued");
  assert.equal(value.requests.length, 1);
});

test("expired persisted run recovery rejects stale completion without replay or automatic confirmation", async context => {
  const began = deferred<void>();
  const finish = deferred<ModelResult>();
  const value = await fixture(context, async () => { began.resolve(); return finish.promise; });
  const queued = await value.service.queueAnalysis(manager, analysisInput(), "test-idempotency-expired");
  const first = createEventAnalysisWorker({ service: value.service, queue: value.queue }).runOnce();
  try {
    await began.promise;
    assert.equal((await value.service.listRunningAnalysisRuns(10))[0]!.id, queued.id);
    value.clock.advance(10_001);
    const recovery = await createEventAnalysisWorker({ service: value.service, queue: value.queue }).runOnce();
    assert.equal(recovery.recovered, 1);
    assert.equal(recovery.processed, 0);
    assert.equal((await persistedRun(value.database, queued.id)).errorCode, "MODEL_TIMEOUT");
    assert.equal(value.requests.length, 1);
  } finally { finish.resolve(modelResult()); }
  assert.equal((await first).failed, 1);
  assert.equal((await persistedRun(value.database, queued.id)).status, "failed");
  assert.equal((await value.repository.getAnalysis(queued.analysisId))?.content, null);
  assert.equal((await value.repository.getAnalysis(queued.analysisId))?.status, "draft");
  assert.equal(await confirmationCount(value.database), 0);
  assert.deepEqual(await value.queue.listRunningAnalysisRuns(10), []);
  assert.deepEqual(await value.queue.listQueuedAnalysisRuns(10), []);
  assert.equal((await createEventAnalysisWorker({ service: value.service, queue: value.queue }).runOnce()).processed, 0);
  assert.equal(value.requests.length, 1);
});
