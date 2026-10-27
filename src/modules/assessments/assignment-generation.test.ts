import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import test, { after, before, beforeEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor, ProjectAccessPort } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { AssignmentGenerationService, createAssignmentGenerationHttpHandlers, createAssignmentGenerationRegistration } from "./assignment-generation.ts";
import { PostgresAssessmentRepository, PostgresQuestionCatalog } from "./postgres.ts";
import { createModelAssignmentSuggestions } from "./model-assignment.ts";
import type { AssignmentContextPort, JsonModelPort } from "./ports.ts";
import { AssessmentService } from "./service.ts";
import type { AssessmentAttempt, AssessmentScore, AssignmentContextSnapshot, ProposedAssignment, QuestionSet, RubricVersion, TeamAssessmentSummary } from "./types.ts";

// Actual embedded PostgreSQL, repository, domain service, model adapter and HTTP
// handlers. The model transport and identity/session providers are explicit test
// fixtures; no remote PostgreSQL, model or authentication integration is claimed.
const PROJECT = "generation-project";
const OTHER_PROJECT = "generation-other-project";
const MANAGER: Actor = { userId: "generation-manager", platformRoles: ["user"] };
const OTHER_MANAGER: Actor = { userId: "generation-other-manager", platformRoles: ["user"] };
const ALICE: Actor = { userId: "generation-alice", platformRoles: ["user"] };
const BOB: Actor = { userId: "generation-bob", platformRoles: ["user"] };
const OUTSIDER: Actor = { userId: "generation-outsider", platformRoles: ["admin"] };
const NOW = "2026-10-08T12:00:00.000Z";
const TARGETS = ["可演示最小页面", "项目说明"];
const PRIVATE_TOKENS = ["PRIVATE_RAW_ANSWER", "PRIVATE_MODEL_REASON", "PRIVATE_EVIDENCE", "PRIVATE_AI_USAGE", "PRIVATE_PROFILE", "PRIVATE_SCORE_LIMITATION"];
const RUBRIC: RubricVersion = {
  id: "assignment-test-rubric", version: 1, missingEvidencePolicy: "exclude_from_denominator", limitations: ["仅本次任务量规，测试夹具"],
  criteria: [
    { id: "shared-criterion", dimension: "requirements", label: "范围检查", weight: 1, maxScore: 3, anchors: ["缺少说明", "基本说明", "检查步骤", "说明边界"] },
    { id: "unshared-criterion", dimension: "development", label: "排错检查", weight: 1, maxScore: 3, anchors: ["缺少说明", "基本说明", "检查步骤", "说明边界"] },
  ],
};
const SET: QuestionSet = {
  id: "assignment-test-question-set", version: 1, rubricVersionId: RUBRIC.id, status: "published",
  difficultyLabel: "测试夹具，不代表真实题库审核", allowedTools: [], maxFollowUps: 1, limitations: ["未校准，不能生成统一能力榜"],
  questions: [{ id: "assignment-test-question", taskTemplateId: "fixture", prompt: "说明最小范围和检查方法", criterionIds: RUBRIC.criteria.map((criterion) => criterion.id), required: true }],
};

function errorCode(code: string) {
  return (error: unknown): boolean => { assert.ok(error instanceof DomainError); assert.equal(error.code, code); return true; };
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function task(patch: Partial<ProposedAssignment> = {}): ProposedAssignment {
  return {
    clientTaskId: "deliver-minimum", title: "完成最小页面", priority: "must", ownerMembershipId: "pm-alice", helperMembershipIds: ["pm-bob"],
    deliverable: "可以执行主要操作的页面", acceptanceCriteria: ["主操作可以完成，失败状态有说明"], dependencyTaskIds: [], proposedDeadlineRef: null,
    reason: "按本人意愿安排，期限由时间规划校验。", evidenceLevel: "self_reported", ...patch,
  };
}
function draft(assignments: readonly ProposedAssignment[] = [task()]) {
  return { assignments, gaps: [], assumptions: ["时间容量仍需校验；未测评成员可以手动安排。"] };
}

interface QueryTrace { readonly transactionId: number | null; readonly statement: string; readonly parameters: readonly unknown[] }
let engine: PGlite;
let database: DatabasePort;
let transactionSerial = 0;
let entitySerial = 0;
const active = new AsyncLocalStorage<{ sql: SqlExecutor; id: number }>();
const trace: QueryTrace[] = [];

/** Serialize independent PGlite transactions, reject nested checkouts, and require
 * all work inside a transaction to use its injected SQL executor. Provider calls
 * happen after commit and do not occupy this one test connection.
 */
function serializedDatabase(): DatabasePort {
  let tail: Promise<unknown> = Promise.resolve();
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }
  return {
    async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      assert.equal(active.getStore(), undefined, "transaction work must use the supplied SQL connection");
      return serialize(async () => {
        trace.push({ transactionId: null, statement, parameters });
        const result = await engine.query(statement, [...parameters]);
        return { rows: result.rows as Row[], rowCount: result.affectedRows ?? result.rows.length };
      });
    },
    transaction<T>(work: (sql: SqlExecutor) => Promise<T>): Promise<T> {
      assert.equal(active.getStore(), undefined, "no nested pool checkout/transaction is permitted");
      return serialize(() => engine.transaction(async (transaction) => {
        const id = ++transactionSerial;
        const sql: SqlExecutor = { async query<Row>(statement: string, parameters: readonly unknown[] = []) {
          assert.equal(active.getStore()?.sql, sql, "callback SQL must belong to this transaction");
          trace.push({ transactionId: id, statement, parameters });
          const result = await transaction.query(statement, [...parameters]);
          return { rows: result.rows as Row[], rowCount: result.affectedRows ?? result.rows.length };
        } };
        return active.run({ sql, id }, () => work(sql));
      }));
    },
  };
}

function context(projectId = PROJECT): AssignmentContextSnapshot {
  const members = projectId === PROJECT ? [
    { membershipId: "pm-manager", userId: MANAGER.userId, role: "manager" as const, status: "active" as const, memberAvailabilityVersionId: "availability-manager-v1" },
    { membershipId: "pm-other-manager", userId: OTHER_MANAGER.userId, role: "manager" as const, status: "active" as const, memberAvailabilityVersionId: null },
    { membershipId: "pm-alice", userId: ALICE.userId, role: "member" as const, status: "active" as const, memberAvailabilityVersionId: "availability-alice-v1" },
    { membershipId: "pm-bob", userId: BOB.userId, role: "member" as const, status: "active" as const, memberAvailabilityVersionId: null },
  ] : [{ membershipId: "pm-outsider", userId: OUTSIDER.userId, role: "manager" as const, status: "active" as const, memberAvailabilityVersionId: null }];
  return { projectId, stage: "active", readOnly: false, projectRevision: 1, membershipRevision: 1, requirementVersionId: "requirements-v1", members };
}

before(async () => {
  engine = new PGlite(); await engine.waitReady;
  await engine.exec(await readFile(new URL("./sql/001-assessments.sql", import.meta.url), "utf8"));
  await engine.exec(await readFile(new URL("./sql/004-assessment-assignment-jobs.sql", import.meta.url), "utf8"));
  await engine.exec("CREATE TABLE assessments_test_context (project_id text PRIMARY KEY, data jsonb NOT NULL)");
  await engine.query("INSERT INTO assessments_rubrics (id,version,data) VALUES ($1,$2,$3::jsonb)", [RUBRIC.id, RUBRIC.version, JSON.stringify(RUBRIC)]);
  await engine.query("INSERT INTO assessments_question_sets (id,version,rubric_version_id,status,data) VALUES ($1,$2,$3,$4,$5::jsonb)", [SET.id, SET.version, RUBRIC.id, SET.status, JSON.stringify(SET)]);
  database = serializedDatabase();
});
beforeEach(async () => {
  await engine.exec("TRUNCATE assessments_attempts, assessments_assignment_versions, assessments_assignment_heads, assessments_assignment_jobs, assessments_outbox, assessments_test_context CASCADE");
  for (const projectId of [PROJECT, OTHER_PROJECT]) await database.query("INSERT INTO assessments_test_context (project_id,data) VALUES ($1,$2::jsonb)", [projectId, JSON.stringify(context(projectId))]);
  trace.length = 0;
});
after(async () => { await engine?.close(); });

type ModelRequest = Parameters<JsonModelPort["completeJSON"]>[0];
type GenerationView = Awaited<ReturnType<AssignmentGenerationService["getJob"]>>;
function harness(options: { readonly timeoutMs?: number; readonly withoutModel?: boolean } = {}) {
  const repository = new PostgresAssessmentRepository(database);
  const modelCalls: { request: ModelRequest; signal: AbortSignal }[] = [];
  let now = Date.parse(NOW);
  let responder: (request: ModelRequest, signal: AbortSignal) => unknown | Promise<unknown> = () => draft();
  const ids = { next: () => `generation-entity-${++entitySerial}` };
  const clock = { now: () => new Date(now) };
  const projectAccess: ProjectAccessPort = {
    async getMembership(projectId, userId) {
      const result = await database.query<{ data: AssignmentContextSnapshot }>("SELECT data FROM assessments_test_context WHERE project_id=$1", [projectId]);
      const member = result.rows[0]?.data.members.find((entry) => entry.userId === userId);
      return member ? { ...member, projectId } : null;
    },
  };
  const assignmentContext: AssignmentContextPort = {
    async getSnapshot(projectId, sql) {
      assert.ok(sql, "authoritative inputs require the existing service transaction");
      assert.equal(sql, active.getStore()?.sql);
      const result = await sql.query<{ data: AssignmentContextSnapshot }>("SELECT data FROM assessments_test_context WHERE project_id=$1 FOR SHARE", [projectId]);
      assert.ok(result.rows[0]);
      return result.rows[0].data;
    },
  };
  const model: JsonModelPort = {
    modelVersion: "explicit-json-transport-test-fixture",
    async completeJSON(request, signal) {
      modelCalls.push({ request: structuredClone(request), signal });
      const content = await responder(request, signal);
      return { content, usage: { inputTokens: 20, outputTokens: 30 }, modelVersion: "fixture-response-v1", requestId: "fixture-only" };
    },
  };
  const service = new AssessmentService({ repository, catalog: new PostgresQuestionCatalog(database), projectAccess, assignmentContext, clock, ids,
    modelTimeoutMs: options.timeoutMs ?? 2000, ...(options.withoutModel ? {} : { suggestions: createModelAssignmentSuggestions({ model }) }) });
  const generationOptions = { database, assessments: service, projectAccess, assignmentContext, clock, ids, modelTimeoutMs: options.timeoutMs ?? 2000 };
  const generation = new AssignmentGenerationService(generationOptions);
  const actors = new Map([MANAGER, OTHER_MANAGER, ALICE, BOB, OUTSIDER].map((actor) => [actor.userId, actor]));
  const handlers = createAssignmentGenerationHttpHandlers({ service: generation, resolveActor: async (request) => actors.get(request.headers.get("X-Test-Session") ?? "") ?? null, requestIds: ids });
  return {
    repository, service, generation, generationOptions, modelCalls, handlers,
    setResponder: (work: typeof responder) => { responder = work; },
    advance: (milliseconds: number) => { now += milliseconds; },
    async changeContext(change: (previous: AssignmentContextSnapshot) => AssignmentContextSnapshot, projectId = PROJECT) {
      await database.transaction(async (sql) => {
        const previous = await sql.query<{ data: AssignmentContextSnapshot }>("SELECT data FROM assessments_test_context WHERE project_id=$1 FOR UPDATE", [projectId]);
        await sql.query("UPDATE assessments_test_context SET data=$2::jsonb WHERE project_id=$1", [projectId, JSON.stringify(change(previous.rows[0]!.data))]);
      });
    },
  };
}
type Harness = ReturnType<typeof harness>;

async function sharedAttempt(fixture: Harness, actor = ALICE, shared = true): Promise<AssessmentAttempt> {
  const created = await fixture.service.createAttempt(actor, PROJECT, SET.id);
  const answered = await fixture.service.saveDraft(actor, created.id, created.revision, {
    profile: { experience: "PRIVATE_PROFILE", tools: ["写作工具"], preferredTasks: ["requirements"], memberAvailabilityVersionId: null },
    answers: [{ questionId: SET.questions[0]!.id, text: "PRIVATE_RAW_ANSWER", aiUsage: "PRIVATE_AI_USAGE", evidence: [{ id: `evidence-${actor.userId}`, kind: "self_report", text: "PRIVATE_EVIDENCE", url: null }] }],
  });
  const score: AssessmentScore = {
    id: `score-${answered.id}`, attemptId: answered.id, rubricVersionId: RUBRIC.id,
    criterionScores: RUBRIC.criteria.map((criterion) => ({ criterionId: criterion.id, state: "scored", score: 2, evidenceRefs: [SET.questions[0]!.id], reason: "PRIVATE_MODEL_REASON", unverified: ["PRIVATE_EVIDENCE"] })),
    limitations: ["PRIVATE_SCORE_LIMITATION"], modelVersion: "explicit-score-storage-fixture", promptVersion: "fixture", provenance: "test_fixture", status: "published",
    supersedesScoreId: null, correctionReason: null, validatedAt: NOW,
  };
  const completed = { ...answered, status: "completed" as const, revision: answered.revision + 1, latestScoreId: score.id };
  await fixture.repository.transaction(async (tx) => { await tx.insertScore(score); await tx.saveAttempt(completed, answered.revision); });
  return shared ? fixture.service.setSharing(actor, completed.id, completed.revision, { confirmedTasks: ["requirements"], criterionIds: ["shared-criterion"] }) : completed;
}
async function draftCount(): Promise<number> {
  return Number((await database.query<{ count: number }>("SELECT count(*)::integer AS count FROM assessments_assignment_versions")).rows[0]!.count);
}
async function jobCount(): Promise<number> {
  return Number((await database.query<{ count: number }>("SELECT count(*)::integer AS count FROM assessments_assignment_jobs")).rows[0]!.count);
}
async function persistedJob(id: string): Promise<Record<string, unknown>> {
  return (await database.query<{ data: Record<string, unknown> }>("SELECT data FROM assessments_assignment_jobs WHERE id=$1", [id])).rows[0]!.data;
}
function assertPrivateAbsent(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const token of PRIVATE_TOKENS) assert.equal(serialized.includes(token), false, token);
}

test("actual SQL queue persists idempotency across service instances and concurrent duplicate requests", async () => {
  const fixture = harness(); const attempt = await sharedAttempt(fixture);
  const [first, duplicate] = await Promise.all([
    fixture.generation.queue(MANAGER, PROJECT, TARGETS, "persistent-key"), fixture.generation.queue(MANAGER, PROJECT, TARGETS, "persistent-key"),
  ]);
  assert.equal(first.id, duplicate.id); assert.equal(first.status, "queued"); assert.equal(await jobCount(), 1);
  const restartedService = new AssignmentGenerationService(fixture.generationOptions);
  assert.equal((await restartedService.queue(MANAGER, PROJECT, TARGETS, "persistent-key")).id, first.id);
  assert.equal((await restartedService.getJob(MANAGER, first.id)).id, first.id);
  assert.equal(fixture.modelCalls.length, 0);
  await assert.rejects(fixture.generation.queue(MANAGER, PROJECT, ["另一交付物"], "persistent-key"), errorCode("IDEMPOTENCY_CONFLICT"));
  const stored = await persistedJob(first.id);
  assert.deepEqual(stored.targetDeliverables, TARGETS);
  assert.deepEqual((stored.inputSnapshot as { sharedSummaryRefs: unknown }).sharedSummaryRefs, [{ attemptId: attempt.id, revision: attempt.revision }]);
  assertPrivateAbsent(stored); assertPrivateAbsent(first);
  const registration = createAssignmentGenerationRegistration(restartedService);
  assert.equal(registration.kind, "assignment_suggestion");
  const listed = await registration.listQueued(10);
  assert.equal(listed.length, 1); assert.equal(listed[0]!.actorId, MANAGER.userId);
  assert.equal(Object.hasOwn(listed[0]!, "inputSnapshot"), false);
});

test("two workers claim once; job success and reviewable draft commit on one SQL transaction", async () => {
  const fixture = harness();
  const entered = deferred<void>(); const output = deferred<unknown>();
  fixture.setResponder(async () => { entered.resolve(); return output.promise; });
  const queued = await fixture.generation.queue(MANAGER, PROJECT, TARGETS, "claim-once");
  const worker = fixture.generation.execute(queued.id); await entered.promise;
  assert.equal((await fixture.generation.execute(queued.id)).status, "running");
  assert.equal(fixture.modelCalls.length, 1);
  output.resolve(draft());
  const completed = await worker;
  assert.equal(completed.status, "succeeded"); assert.equal(completed.revision, 3); assert.equal(await draftCount(), 1);
  assert.equal((await fixture.generation.execute(queued.id)).status, "succeeded"); assert.equal(fixture.modelCalls.length, 1);
  const insert = trace.find((entry) => /INSERT INTO assessments_assignment_versions/.test(entry.statement));
  const jobSuccess = trace.find((entry) => /UPDATE assessments_assignment_jobs/.test(entry.statement) && entry.parameters[1] === "succeeded");
  assert.ok(insert?.transactionId); assert.equal(insert.transactionId, jobSuccess?.transactionId);
  const version = await fixture.service.getAssignment(MANAGER, completed.assignmentVersionId!);
  assert.equal(version.status, "draft"); assert.equal(version.appliedAt, null); assert.equal(version.appliedBy, null);
  assert.equal((await fixture.service.getAppliedAssignment(MANAGER, PROJECT)).head.versionId, null);
  await assert.rejects(fixture.service.applyAssignment(MANAGER, version.id, version.revision), errorCode("ASSIGNMENT_NOT_READY"));
  const ready = await fixture.service.validateAssignment(MANAGER, version.id, version.revision);
  assert.equal(ready.status, "ready");
  const applied = await fixture.service.applyAssignment(MANAGER, ready.id, ready.revision);
  assert.equal(applied.status, "applied"); assert.equal(applied.assignments[0]!.ownerMembershipId, "pm-alice");
  assert.equal((await fixture.service.getAppliedAssignment(MANAGER, PROJECT)).head.versionId, applied.id);
});

test("model sees only selected summaries; raw answers, reasons, unshared score and unshared member report stay private", async () => {
  const fixture = harness(); const selected = await sharedAttempt(fixture); const unshared = await sharedAttempt(fixture, BOB, false);
  fixture.setResponder(() => draft([task({ evidenceLevel: "assessed" })]));
  const queued = await fixture.generation.queue(MANAGER, PROJECT, TARGETS, "privacy");
  const result = await fixture.generation.execute(queued.id);
  assert.equal(result.status, "succeeded");
  const request = fixture.modelCalls[0]!.request;
  const input = request.input as { context: AssignmentContextSnapshot; summaries: readonly TeamAssessmentSummary[]; targetDeliverables: readonly string[] };
  assert.equal(input.summaries.length, 1); assert.equal(input.summaries[0]!.attemptId, selected.id);
  assert.deepEqual(input.summaries[0]!.criterionScores.map((item) => item.criterionId), ["shared-criterion"]);
  assert.equal(input.summaries.some((item) => item.attemptId === unshared.id), false);
  assert.deepEqual(input.targetDeliverables, TARGETS); assertPrivateAbsent(request.input);
  assert.equal(Object.hasOwn(input.summaries[0]!, "answers"), false); assert.equal(Object.hasOwn(input.summaries[0]!, "evidenceRefs"), false);
  assertPrivateAbsent(await persistedJob(queued.id)); assertPrivateAbsent(await fixture.generation.getJob(MANAGER, queued.id));
  await assert.rejects(fixture.service.getPrivateReport(MANAGER, selected.id), errorCode("NOT_FOUND"));
});

test("withdrawn shared intention text is not persisted in queue/public historical assignment snapshots", async () => {
  const fixture = harness();
  await fixture.changeContext((previous) => ({ ...previous, memberIntentionRefs: [{ membershipId: "pm-alice", revision: 1 }],
    members: previous.members.map((member) => member.userId === ALICE.userId ? { ...member, sharedIntention: {
      revision: 1, membershipRevision: 1, duties: ["documentation", "design"], experience: "WITHDRAWABLE_EXPERIENCE", helpQuestion: "WITHDRAWABLE_HELP_QUESTION",
    } } : member) }));
  const job = await fixture.generation.queue(MANAGER, PROJECT, TARGETS, "withdraw-intention");
  const result = await fixture.generation.execute(job.id); assert.equal(result.status, "succeeded");
  assert.ok(JSON.stringify(fixture.modelCalls[0]!.request.input).includes("WITHDRAWABLE_EXPERIENCE"), "actual dispatch may use currently opted-in input");
  const draft = await fixture.service.getAssignment(MANAGER, result.assignmentVersionId!);
  const ready = await fixture.service.validateAssignment(MANAGER, draft.id, draft.revision); await fixture.service.applyAssignment(MANAGER, ready.id, ready.revision);
  await fixture.changeContext((previous) => ({ ...previous, memberIntentionRefs: [{ membershipId: "pm-alice", revision: 2 }],
    members: previous.members.map((member) => member.userId === ALICE.userId ? { ...member, sharedIntention: { revision: 2, membershipRevision: 1 } } : member) }));
  const history = await fixture.service.getAssignment(BOB, draft.id); const applied = await fixture.service.getAppliedAssignment(BOB, PROJECT);
  assert.equal(history.inputFreshness, "changed"); assert.equal(applied.version!.inputFreshness, "changed");
  for (const object of [history, applied, await persistedJob(job.id)]) {
    const serialized = JSON.stringify(object);
    assert.equal(serialized.includes("WITHDRAWABLE_EXPERIENCE"), false); assert.equal(serialized.includes("WITHDRAWABLE_HELP_QUESTION"), false);
  }
});

test("initial unknown or no-track catalog allows generic manual assignment; changed selected track requires review", async () => {
  const fixture = harness();
  for (const catalogStatus of ["unknown", "none"] as const) {
    await fixture.changeContext((previous) => ({ ...previous, trackSelectionRevision: null, officialTracks: {
      eventId: "event-test", rulesVersion: 1, confirmationRevision: 1, catalogStatus, selectedTrackId: null, needsReview: true, tracks: [], evidenceIds: [],
    } }));
    const current = await fixture.service.getAppliedAssignment(MANAGER, PROJECT);
    const created = await fixture.service.createAssignment(MANAGER, PROJECT, current.head.versionId, draft());
    assert.equal(created.status, "draft"); assert.ok(created.assumptions.some((text) => text.includes("通用准备")));
    const ready = await fixture.service.validateAssignment(MANAGER, created.id, created.revision);
    assert.equal((await fixture.service.applyAssignment(MANAGER, ready.id, ready.revision)).status, "applied");
  }
  await fixture.changeContext((previous) => ({ ...previous, trackSelectionRevision: 2, officialTracks: {
    eventId: "event-test", rulesVersion: 2, confirmationRevision: 2, catalogStatus: "confirmed", selectedTrackId: "old-choice", needsReview: true, tracks: [], evidenceIds: [],
  } }));
  const current = await fixture.service.getAppliedAssignment(MANAGER, PROJECT);
  const staleTrack = await fixture.service.createAssignment(MANAGER, PROJECT, current.head.versionId, draft());
  assert.equal(staleTrack.status, "needs_changes"); await assert.rejects(fixture.service.validateAssignment(MANAGER, staleTrack.id, staleTrack.revision), errorCode("ASSIGNMENT_NEEDS_CHANGES"));
});

const changes = [
  { name: "official track selection change", code: "ASSIGNMENT_INPUT_CHANGED", async apply(fixture: Harness, _attempt: AssessmentAttempt) {
    await fixture.changeContext((previous) => ({ ...previous, trackSelectionRevision: 2 }));
  } },
  { name: "shared intention revision change", code: "ASSIGNMENT_INPUT_CHANGED", async apply(fixture: Harness, _attempt: AssessmentAttempt) {
    await fixture.changeContext((previous) => ({ ...previous, memberIntentionRefs: [{ membershipId: "pm-alice", revision: 2 }],
      members: previous.members.map((member) => member.userId === ALICE.userId ? { ...member, sharedIntention: { revision: 2, membershipRevision: 1, duties: ["design", "documentation"] } } : member) }));
  } },
  { name: "requirements change", code: "ASSIGNMENT_INPUT_CHANGED", async apply(fixture: Harness, _attempt: AssessmentAttempt) {
    await fixture.changeContext((previous) => ({ ...previous, requirementVersionId: "requirements-v2" }));
  } },
  { name: "member availability change", code: "ASSIGNMENT_INPUT_CHANGED", async apply(fixture: Harness, _attempt: AssessmentAttempt) {
    await fixture.changeContext((previous) => ({ ...previous,
      members: previous.members.map((member) => member.userId === ALICE.userId ? { ...member, memberAvailabilityVersionId: "availability-alice-v2" } : member) }));
  } },
  { name: "sharing withdrawal", code: "ASSIGNMENT_INPUT_CHANGED", async apply(fixture: Harness, attempt: AssessmentAttempt) {
    await fixture.service.setSharing(ALICE, attempt.id, attempt.revision, { confirmedTasks: [], criterionIds: [] });
  } },
  { name: "project archive", code: "PROJECT_READ_ONLY", async apply(fixture: Harness, _attempt: AssessmentAttempt) {
    await fixture.changeContext((previous) => ({ ...previous, stage: "archived", readOnly: true, projectRevision: previous.projectRevision + 1 }));
  } },
];
for (const change of changes) for (const phase of ["queued", "running"] as const) {
  test(`${phase} ${change.name} fails without saving an assignment draft`, async () => {
    const fixture = harness(); const attempt = await sharedAttempt(fixture);
    const entered = deferred<void>(); const output = deferred<unknown>();
    fixture.setResponder(async () => { entered.resolve(); return output.promise; });
    const queued = await fixture.generation.queue(MANAGER, PROJECT, TARGETS, `change-${phase}`);
    let running: ReturnType<AssignmentGenerationService["execute"]> | undefined;
    if (phase === "running") { running = fixture.generation.execute(queued.id); await entered.promise; }
    await change.apply(fixture, attempt);
    output.resolve(draft());
    const result = await (running ?? fixture.generation.execute(queued.id));
    assert.equal(result.status, "failed"); assert.equal(result.failureCode, change.code); assert.equal(result.assignmentVersionId, null);
    assert.equal(fixture.modelCalls.length, phase === "queued" ? 0 : 1);
    assert.equal(await draftCount(), 0); assert.equal((await persistedJob(queued.id)).status, "failed");
    assert.equal((await fixture.generation.getJob(MANAGER, queued.id)).status, "failed");
  });
}

test("applying a different baseline while queued or running rejects obsolete generation", async () => {
  const fixture = harness();
  const queued = await fixture.generation.queue(MANAGER, PROJECT, TARGETS, "old-base");
  const manual = await fixture.service.createAssignment(MANAGER, PROJECT, null, draft());
  const ready = await fixture.service.validateAssignment(MANAGER, manual.id, manual.revision);
  await fixture.service.applyAssignment(MANAGER, ready.id, ready.revision);
  assert.equal((await fixture.generation.execute(queued.id)).failureCode, "ASSIGNMENT_BASE_CHANGED");
  assert.equal(fixture.modelCalls.length, 0); assert.equal(await draftCount(), 1);
  const entered = deferred<void>(); const output = deferred<unknown>();
  fixture.setResponder(async () => { entered.resolve(); return output.promise; });
  const next = await fixture.generation.queue(MANAGER, PROJECT, TARGETS, "running-base");
  const worker = fixture.generation.execute(next.id); await entered.promise;
  const replacement = await fixture.service.createAssignment(MANAGER, PROJECT, ready.id, draft([task({ title: "更新交付范围" })]));
  const replacementReady = await fixture.service.validateAssignment(MANAGER, replacement.id, replacement.revision);
  await fixture.service.applyAssignment(MANAGER, replacementReady.id, replacementReady.revision);
  output.resolve(draft());
  assert.equal((await worker).failureCode, "ASSIGNMENT_BASE_CHANGED"); assert.equal(await draftCount(), 2);
});

test("expired recovery does not dispatch again; a late model result rolls back the draft and cannot revive the job", async () => {
  const fixture = harness({ timeoutMs: 2000 });
  const entered = deferred<void>(); const output = deferred<unknown>();
  fixture.setResponder(async () => { entered.resolve(); return output.promise; });
  const queued = await fixture.generation.queue(MANAGER, PROJECT, TARGETS, "interrupted");
  const worker = fixture.generation.execute(queued.id); await entered.promise;
  fixture.advance(32000);
  assert.equal((await fixture.generation.recover(queued.id)).status, "running", "exact boundary is still leased");
  assert.deepEqual(await fixture.generation.listRecoverable(10), []);
  fixture.advance(1);
  assert.equal((await fixture.generation.listRecoverable(10))[0]!.id, queued.id);
  const recovered = await fixture.generation.recover(queued.id);
  assert.equal(recovered.status, "failed"); assert.equal(recovered.failureCode, "WORKER_INTERRUPTED");
  output.resolve(draft());
  const late = await worker;
  assert.equal(late.status, "failed"); assert.equal(late.failureCode, "WORKER_INTERRUPTED"); assert.equal(late.revision, recovered.revision);
  assert.equal(await draftCount(), 0); assert.equal(fixture.modelCalls.length, 1);
  assert.equal((await fixture.generation.execute(queued.id)).failureCode, "WORKER_INTERRUPTED"); assert.equal(fixture.modelCalls.length, 1);
  assert.equal((await persistedJob(queued.id)).assignmentVersionId, null);
  assert.ok(trace.some((entry) => /INSERT INTO assessments_assignment_versions/.test(entry.statement)), "the late draft must reach the transaction and then be rolled back atomically");
});

test("model timeout aborts transport; late resolution cannot persist a draft", async () => {
  const fixture = harness({ timeoutMs: 10 }); const output = deferred<unknown>();
  fixture.setResponder(() => output.promise);
  const queued = await fixture.generation.queue(MANAGER, PROJECT, TARGETS, "model-timeout");
  const result = await fixture.generation.execute(queued.id);
  assert.equal(result.failureCode, "MODEL_TIMEOUT"); assert.equal(fixture.modelCalls[0]!.signal.aborted, true);
  output.resolve(draft()); await Promise.resolve();
  assert.equal(await draftCount(), 0); assert.equal((await fixture.generation.getJob(MANAGER, queued.id)).status, "failed");
});

test("malformed, forged-member and unverified model outputs fail without saving drafts", async () => {
  const fixture = harness();
  const invalidOutputs = [
    { output: { ...draft(), applied: true }, code: "INVALID_INPUT" },
    { output: draft([task({ ownerMembershipId: "foreign-membership" })]), code: "INVALID_INPUT" },
    { output: draft([task({ evidenceLevel: "verified" })]), code: "UNVERIFIED_EVIDENCE" },
    { output: draft([task({ evidenceLevel: "assessed" })]), code: "INVALID_INPUT" },
    { output: draft([task({ dependencyTaskIds: ["unknown-task"] })]), code: "INVALID_INPUT" },
    { output: { assignments: [Object.assign(task(), { age: 15 })], gaps: [], assumptions: [] }, code: "INVALID_INPUT" },
  ];
  for (const [index, invalid] of invalidOutputs.entries()) {
    fixture.setResponder(() => invalid.output);
    const queued = await fixture.generation.queue(MANAGER, PROJECT, TARGETS, `malformed-${index}`);
    const result = await fixture.generation.execute(queued.id);
    assert.equal(result.status, "failed"); assert.equal(result.failureCode, invalid.code); assert.equal(result.assignmentVersionId, null);
    assert.equal(await draftCount(), 0);
  }
});

test("unconfigured model rejects new queue writes; existing durable jobs can fail safely after configuration is removed", async () => {
  const fixture = harness({ withoutModel: true });
  await assert.rejects(fixture.generation.queue(MANAGER, PROJECT, TARGETS, "no-model"), errorCode("MODEL_UNAVAILABLE"));
  assert.equal(await jobCount(), 0); assert.equal(await draftCount(), 0);
  const saved = await sharedAttempt(fixture);
  assert.equal((await fixture.service.getPrivateReport(ALICE, saved.id)).attempt.answers[0]!.text, "PRIVATE_RAW_ANSWER");
  assert.equal((await fixture.service.createAssignment(MANAGER, PROJECT, null, draft())).status, "draft");
  const configured = harness();
  const queued = await configured.generation.queue(MANAGER, PROJECT, TARGETS, "queued-before-removal");
  const failed = await fixture.generation.execute(queued.id);
  assert.equal(failed.status, "failed"); assert.equal(failed.failureCode, "MODEL_UNAVAILABLE");
  assert.equal(configured.modelCalls.length + fixture.modelCalls.length, 0);
  assert.equal(await draftCount(), 1, "only the explicit manual draft remains");
});

test("job polling is private to its owner and checks their original current membership", async () => {
  const fixture = harness(); const queued = await fixture.generation.queue(MANAGER, PROJECT, TARGETS, "owner-private");
  for (const actor of [OTHER_MANAGER, ALICE, OUTSIDER]) await assert.rejects(fixture.generation.getJob(actor, queued.id), errorCode("NOT_FOUND"));
  await assert.rejects(fixture.generation.queue(ALICE, PROJECT, TARGETS, "member-spoof"), errorCode("FORBIDDEN"));
  await assert.rejects(fixture.generation.queue(OUTSIDER, PROJECT, TARGETS, "platform-admin-spoof"), errorCode("FORBIDDEN"));
  await fixture.changeContext((previous) => ({ ...previous, membershipRevision: previous.membershipRevision + 1,
    members: previous.members.map((member) => member.userId === MANAGER.userId ? { ...member, membershipId: "replacement-manager-membership" } : member) }));
  await assert.rejects(fixture.generation.getJob(MANAGER, queued.id), errorCode("FORBIDDEN"));
  assert.equal((await fixture.generation.execute(queued.id)).failureCode, "FORBIDDEN");
  assert.equal(fixture.modelCalls.length, 0); assert.equal(await draftCount(), 0);
});

for (const loss of ["removed", "demoted"] as const) test(`running manager ${loss} prevents the late draft commit`, async () => {
  const fixture = harness(); const entered = deferred<void>(); const output = deferred<unknown>();
  fixture.setResponder(async () => { entered.resolve(); return output.promise; });
  const queued = await fixture.generation.queue(MANAGER, PROJECT, TARGETS, "lost-manager");
  const worker = fixture.generation.execute(queued.id); await entered.promise;
  await fixture.changeContext((previous) => ({ ...previous, membershipRevision: previous.membershipRevision + 1,
    members: previous.members.map((member) => member.userId === MANAGER.userId ? (loss === "removed" ? { ...member, status: "removed" } : { ...member, role: "member" }) : member) }));
  output.resolve(draft());
  assert.equal((await worker).failureCode, "FORBIDDEN"); assert.equal(await draftCount(), 0);
  if (loss === "removed") await assert.rejects(fixture.generation.getJob(MANAGER, queued.id), errorCode("FORBIDDEN"));
  else assert.equal((await fixture.generation.getJob(MANAGER, queued.id)).status, "failed", "active original author can still poll their own prior job");
});

function request(actor: Actor | null, input?: unknown, idempotencyKey?: string): Request {
  return new Request("https://assignment-test.invalid/api/v1/projects/generation/assignment-generation", {
    method: input === undefined ? "GET" : "POST",
    headers: { ...(actor ? { "X-Test-Session": actor.userId } : {}), ...(input === undefined ? {} : { "Content-Type": "application/json" }), ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}
async function responseData<T>(response: Response, status: number): Promise<T> {
  const envelope = await response.json() as { data: T; requestId: string };
  assert.equal(response.status, status, JSON.stringify(envelope)); assert.ok(envelope.requestId);
  assert.equal(response.headers.get("Cache-Control"), "no-store"); return envelope.data;
}
async function responseError(response: Response, status: number, code: string): Promise<void> {
  const envelope = await response.json() as { error: { code: string }; requestId: string };
  assert.equal(response.status, status, JSON.stringify(envelope)); assert.equal(envelope.error.code, code); assert.ok(envelope.requestId);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
}

test("HTTP queues with 202, polls safe metadata, and rejects body identity/status/result spoofing", async () => {
  const fixture = harness(); await sharedAttempt(fixture);
  const queued = await responseData<GenerationView>(await fixture.handlers.queue(request(MANAGER, { targetDeliverables: TARGETS }, "http-key"), { projectId: PROJECT }), 202);
  assert.equal(queued.status, "queued"); assert.equal(queued.assignmentVersionId, null); assert.equal(fixture.modelCalls.length, 0);
  const poll = await responseData<GenerationView>(await fixture.handlers.job(request(MANAGER), { jobId: queued.id }), 200);
  assert.equal(poll.id, queued.id); assertPrivateAbsent(poll);
  for (const key of ["inputSnapshot", "inputFingerprint", "targetDeliverables", "idempotencyKey"]) assert.equal(Object.hasOwn(poll, key), false);
  for (const [index, forged] of [
    { userId: OTHER_MANAGER.userId }, { actorId: MANAGER.userId }, { projectId: OTHER_PROJECT }, { role: "manager" },
    { status: "succeeded" }, { assignmentVersionId: "foreign-draft" }, { inputSnapshot: {} },
  ].entries()) await responseError(await fixture.handlers.queue(request(MANAGER, { targetDeliverables: TARGETS, ...forged }, `spoof-${index}`), { projectId: PROJECT }), 422, "INVALID_INPUT");
  await responseError(await fixture.handlers.queue(request(null, { targetDeliverables: TARGETS }, "anonymous"), { projectId: PROJECT }), 401, "UNAUTHENTICATED");
  await responseError(await fixture.handlers.queue(request(ALICE, { targetDeliverables: TARGETS }, "member"), { projectId: PROJECT }), 403, "FORBIDDEN");
  await responseError(await fixture.handlers.job(request(OTHER_MANAGER), { jobId: queued.id }), 404, "NOT_FOUND");
  assert.equal(await jobCount(), 1);
  await fixture.generation.execute(queued.id);
  const complete = await responseData<GenerationView>(await fixture.handlers.job(request(MANAGER), { jobId: queued.id }), 200);
  assert.equal(complete.status, "succeeded"); assert.ok(complete.assignmentVersionId); assertPrivateAbsent(complete);
  assert.equal((await fixture.service.getAssignment(MANAGER, complete.assignmentVersionId!)).status, "draft");
});
