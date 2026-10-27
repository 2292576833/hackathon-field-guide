import assert from "node:assert/strict";
import test from "node:test";
import type { Actor, ProjectMembershipAccess } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { FixedQuestionCatalog, PILOT_QUESTION_SET, PILOT_RUBRIC } from "./catalog.ts";
import { createAssessmentHttpHandlers } from "./http-handlers.ts";
import { createModelAssessmentScorer } from "./model-scorer.ts";
import type { JsonModelPort } from "./ports.ts";
import { SCORE_MEANING } from "./scoring-rules.ts";
import { AssessmentService } from "./service.ts";
import { MemoryAssessmentRepository } from "./testing/memory-repository.ts";
import type { AssessmentAnswer, AssessmentAttempt, AssignmentContextSnapshot, QuestionSet, RubricVersion, ScoringJob, TeamAssessmentSummary } from "./types.ts";

// Actual module service and HTTP handlers, with memory persistence and a transport stub only.
// No network, authentication provider, real model or PostgreSQL connection is claimed here.
const PROJECT = "runtime-http-project";
const OTHER_PROJECT = "runtime-http-other-project";
const ALICE: Actor = { userId: "runtime-alice", platformRoles: ["user"] };
const MANAGER: Actor = { userId: "runtime-manager", platformRoles: ["admin"] };
const OUTSIDER: Actor = { userId: "runtime-outsider", platformRoles: ["user"] };
const PRIVATE_ANSWER = "PRIVATE_RUNTIME_ANSWER 先交付主操作，再核对预期结果。";
const PRIVATE_REASON = "PRIVATE_RUNTIME_MODEL_REASON 回答给出了检查顺序。";
const PRIVATE_LIMITATION = "PRIVATE_RUNTIME_MODEL_LIMITATION 原始回答仅本人可见。";
const PROMPT_VERSION = "runtime-server-prompt-v4";
const MODEL_VERSION = "runtime-server-transport-response-v3";
const TEST_SET: QuestionSet = { ...structuredClone(PILOT_QUESTION_SET), id: "published-runtime-test-fixture-only", status: "published", limitations: ["发布状态仅为贯通测试，未完成真实题库人审。"] };
type ModelRequest = Parameters<JsonModelPort["completeJSON"]>[0];
type Report = Awaited<ReturnType<AssessmentService["getPrivateReport"]>>;
type OwnAttempts = Awaited<ReturnType<AssessmentService["listOwnAttempts"]>>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function contentFor(request: ModelRequest, value = 2) {
  const input = request.input as { suppliedRubric: RubricVersion; suppliedQuestionSet: QuestionSet; memberSubmission: { answers: readonly AssessmentAnswer[] } };
  return { rubricVersionId: input.suppliedRubric.id, criterionScores: input.suppliedRubric.criteria.map((criterion) => {
    const question = input.suppliedQuestionSet.questions.find((entry) => entry.criterionIds.includes(criterion.id) && input.memberSubmission.answers.some((answer) => answer.questionId === entry.id && answer.text.trim()));
    return { criterionId: criterion.id, state: question ? "scored" : "insufficient_evidence", score: question ? value : null, evidenceRefs: question ? [question.id] : [], reason: PRIVATE_REASON, unverified: ["PRIVATE_RUNTIME_UNVERIFIED 未实际运行作品。"] };
  }), limitations: [PRIVATE_LIMITATION] };
}

function harness(options: { readonly timeoutMs?: number } = {}) {
  const repository = new MemoryAssessmentRepository(); let nextId = 0; let time = Date.parse("2026-10-08T00:00:00.000Z"); let membershipRevision = 1;
  const members = new Map<string, ProjectMembershipAccess>([
    [ALICE.userId, { membershipId: "pm-runtime-alice-v1", projectId: PROJECT, userId: ALICE.userId, role: "member", status: "active" }],
    [MANAGER.userId, { membershipId: "pm-runtime-manager-v1", projectId: PROJECT, userId: MANAGER.userId, role: "manager", status: "active" }],
    [OUTSIDER.userId, { membershipId: "pm-runtime-other-project-v1", projectId: OTHER_PROJECT, userId: OUTSIDER.userId, role: "manager", status: "active" }],
  ]);
  const actors = new Map([ALICE, MANAGER, OUTSIDER].map((actor) => [actor.userId, actor]));
  const calls: { request: ModelRequest; signal: AbortSignal }[] = [];
  let responder: (request: ModelRequest, signal: AbortSignal, call: number) => unknown | Promise<unknown> = (request) => contentFor(request);
  const model: JsonModelPort = { modelVersion: "runtime-configured-model-v1", completeJSON: async (request, signal) => {
    calls.push({ request: structuredClone(request), signal });
    const content = await responder(request, signal, calls.length); time += 500;
    return { content, usage: { inputTokens: 20, outputTokens: 30 }, requestId: `transport-stub-${calls.length}`, modelVersion: MODEL_VERSION };
  } };
  const service = new AssessmentService({
    repository, catalog: new FixedQuestionCatalog({ questionSets: [TEST_SET], rubrics: [PILOT_RUBRIC] }),
    projectAccess: { getMembership: async (projectId, userId) => { const member = members.get(userId); return member?.projectId === projectId ? structuredClone(member) : null; } },
    assignmentContext: { getSnapshot: async (projectId): Promise<AssignmentContextSnapshot> => ({ projectId, stage: "active", readOnly: false, projectRevision: 1, membershipRevision, requirementVersionId: null,
      members: [...members.values()].filter((member) => member.projectId === projectId).map((member) => ({ membershipId: member.membershipId, userId: member.userId, role: member.role, status: member.status, memberAvailabilityVersionId: null })) }) },
    clock: { now: () => new Date(time) }, ids: { next: () => `runtime-entity-${++nextId}` },
    scorer: createModelAssessmentScorer({ model, promptVersion: PROMPT_VERSION }), modelTimeoutMs: options.timeoutMs ?? 1000,
  });
  let requestId = 0;
  const handlers = createAssessmentHttpHandlers({ service,
    // This fixed lookup stands in for a verified session; request JSON never supplies identity.
    resolveActor: async (request) => actors.get(request.headers.get("X-Test-Session") ?? "") ?? null,
    requestIds: { next: () => `runtime-http-request-${++requestId}` },
  });
  return { repository, service, handlers, calls,
    setResponder: (work: typeof responder) => { responder = work; },
    changeMembership: (actor: Actor, patch: Partial<ProjectMembershipAccess>) => { members.set(actor.userId, { ...members.get(actor.userId)!, ...patch }); membershipRevision += 1; },
  };
}

function request(actor: Actor | null, data?: unknown, idempotencyKey?: string): Request {
  return new Request("https://module-fixture.invalid/api/v1/assessments", {
    method: data === undefined ? "GET" : "POST",
    headers: { ...(actor ? { "X-Test-Session": actor.userId } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}

async function data<T>(response: Response, status = 200): Promise<T> {
  const envelope = await response.json() as { data: T; error?: unknown; requestId: string };
  assert.equal(response.status, status, JSON.stringify(envelope)); assert.ok(envelope.requestId); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(Object.hasOwn(envelope, "data")); return envelope.data;
}

async function fails(response: Response, status: number, code: string): Promise<void> {
  const envelope = await response.json() as { error: { code: string }; requestId: string };
  assert.equal(response.status, status); assert.equal(envelope.error.code, code); assert.ok(envelope.requestId);
  assert.equal(response.headers.get("cache-control"), "no-store");
}

async function savedAttempt(fixture: ReturnType<typeof harness>, actor = ALICE): Promise<AssessmentAttempt> {
  const attempt = await data<AssessmentAttempt>(await fixture.handlers.createAttempt(request(actor, { questionSetId: TEST_SET.id }), { projectId: PROJECT }), 201);
  return data<AssessmentAttempt>(await fixture.handlers.saveDraft(request(actor, { expectedRevision: attempt.revision,
    profile: { experience: "PRIVATE_RUNTIME_PROFILE 本人意愿", tools: ["文字工具"], preferredTasks: ["requirements"], memberAvailabilityVersionId: null },
    answers: attempt.questionSetSnapshot.questions.filter((question) => question.required).map((question) => ({ questionId: question.id, text: PRIVATE_ANSWER, evidence: [], aiUsage: "PRIVATE_RUNTIME_AI_USAGE 辅助整理" })),
  }), { attemptId: attempt.id }));
}

async function report(fixture: ReturnType<typeof harness>, attemptId: string): Promise<Report> {
  return data<Report>(await fixture.handlers.privateReport(request(ALICE), { attemptId }));
}

async function completedAttempt(fixture: ReturnType<typeof harness>) {
  const attempt = await savedAttempt(fixture);
  const job = await data<ScoringJob>(await fixture.handlers.submitAttempt(request(ALICE, { expectedRevision: attempt.revision }, "first-submit"), { attemptId: attempt.id }), 202);
  assert.equal(job.status, "queued"); assert.equal(fixture.calls.length, 0);
  assert.equal((await fixture.service.processScoringJob(job.id)).status, "succeeded");
  return { attempt, job, report: await report(fixture, attempt.id) };
}

test("HTTP submit, worker, report, opt-in sharing and reassessment preserve author boundaries and immutable score history", async () => {
  const fixture = harness(); const first = await completedAttempt(fixture);
  const storedScore = first.report.scores[0]!;
  assert.equal(storedScore.modelVersion, MODEL_VERSION); assert.equal(storedScore.promptVersion, PROMPT_VERSION); assert.equal(storedScore.provenance, "model");
  assert.equal(storedScore.status, "published"); assert.equal(first.report.attempt.status, "completed");
  assert.equal(first.report.scoreMeaning, SCORE_MEANING); assert.ok(storedScore.limitations.includes(SCORE_MEANING));
  assert.ok(first.report.dimensionResults.flatMap((entry) => entry.dimensions).every((entry) => !Object.hasOwn(entry, "percentage")));
  assert.deepEqual(await data(await fixture.handlers.summaries(request(MANAGER), { projectId: PROJECT })), []);
  const ownJob = await data<ScoringJob>(await fixture.handlers.job(request(ALICE), { jobId: first.job.id })); assert.equal(ownJob.status, "succeeded");
  await fails(await fixture.handlers.job(request(MANAGER), { jobId: first.job.id }), 404, "NOT_FOUND");
  await fails(await fixture.handlers.privateReport(request(MANAGER), { attemptId: first.attempt.id }), 404, "NOT_FOUND");
  const shared = await data<AssessmentAttempt>(await fixture.handlers.sharing(request(ALICE, { expectedRevision: first.report.attempt.revision, selection: { confirmedTasks: ["requirements"], criterionIds: [PILOT_RUBRIC.criteria[0]!.id] } }), { attemptId: first.attempt.id }));
  const summaries = await data<readonly TeamAssessmentSummary[]>(await fixture.handlers.summaries(request(MANAGER), { projectId: PROJECT }));
  assert.equal(summaries.length, 1); assert.equal(summaries[0]!.criterionScores.length, 1); assert.equal(summaries[0]!.criterionScores[0]!.score, 2);
  for (const privateValue of [PRIVATE_ANSWER, PRIVATE_REASON, PRIVATE_LIMITATION, "PRIVATE_RUNTIME_PROFILE", "PRIVATE_RUNTIME_AI_USAGE", "PRIVATE_RUNTIME_UNVERIFIED"]) assert.ok(!JSON.stringify(summaries).includes(privateValue));
  await fails(await fixture.handlers.summaries(request(OUTSIDER), { projectId: PROJECT }), 403, "FORBIDDEN");
  const entered = deferred<void>(); const release = deferred<unknown>();
  fixture.setResponder(async () => { entered.resolve(); return release.promise; });
  const correctionReason = "PRIVATE_RUNTIME_CORRECTION 请按已有证据复核本项。";
  const reassessment = await data<ScoringJob>(await fixture.handlers.reassess(request(ALICE, { expectedRevision: shared.revision, correctionReason }, "second-assessment"), { attemptId: first.attempt.id }), 202);
  assert.equal(reassessment.status, "queued"); assert.equal(reassessment.runNumber, 2);
  const worker = fixture.service.processScoringJob(reassessment.id); await entered.promise;
  assert.equal((await data<ScoringJob>(await fixture.handlers.job(request(ALICE), { jobId: reassessment.id }))).status, "running");
  const pending = await report(fixture, first.attempt.id); assert.equal(pending.attempt.status, "scoring"); assert.deepEqual(pending.scores, first.report.scores);
  const retry = await data<ScoringJob>(await fixture.handlers.reassess(request(ALICE, { expectedRevision: shared.revision, correctionReason }, "second-assessment"), { attemptId: first.attempt.id }), 202);
  assert.equal(retry.id, reassessment.id); assert.equal(fixture.calls.length, 2);
  const secondCall = fixture.calls[1]!; release.resolve(contentFor(secondCall.request, 3));
  assert.equal((await worker).status, "succeeded");
  const final = await report(fixture, first.attempt.id); assert.equal(final.scores.length, 2);
  assert.deepEqual(final.scores.find((score) => score.id === storedScore.id), storedScore);
  const nextScore = final.scores.find((score) => score.id === final.attempt.latestScoreId)!;
  assert.notEqual(nextScore.id, storedScore.id); assert.equal(nextScore.supersedesScoreId, storedScore.id); assert.equal(nextScore.correctionReason, correctionReason);
  assert.equal(nextScore.criterionScores[0]!.score, 3); assert.equal(nextScore.modelVersion, MODEL_VERSION); assert.equal(nextScore.promptVersion, PROMPT_VERSION);
  assert.deepEqual(final.attempt.answers, first.report.attempt.answers); assert.equal(final.attempt.activeJobId, null);
  const withdrawn = await data<AssessmentAttempt>(await fixture.handlers.sharing(request(ALICE, { expectedRevision: final.attempt.revision, selection: { confirmedTasks: [], criterionIds: [] } }), { attemptId: first.attempt.id }));
  assert.equal(withdrawn.status, "completed"); assert.deepEqual(await data(await fixture.handlers.summaries(request(MANAGER), { projectId: PROJECT })), []);
  assert.equal(fixture.repository.inspect().scores.length, 2); assert.equal(fixture.calls.length, 2);
});

test("HTTP resumable attempts list is author-only and excludes attempts from a replaced membership", async () => {
  const fixture = harness(); const alice = await savedAttempt(fixture); const manager = await savedAttempt(fixture, MANAGER);
  const aliceList = await data<OwnAttempts>(await fixture.handlers.listAttempts(request(ALICE), { projectId: PROJECT }));
  const managerList = await data<OwnAttempts>(await fixture.handlers.listAttempts(request(MANAGER), { projectId: PROJECT }));
  assert.deepEqual(aliceList.map((entry) => entry.id), [alice.id]); assert.deepEqual(managerList.map((entry) => entry.id), [manager.id]);
  for (const hidden of [PRIVATE_ANSWER, "PRIVATE_RUNTIME_PROFILE", "PRIVATE_RUNTIME_AI_USAGE", '"answers"', '"profile"', '"userId"']) assert.ok(!JSON.stringify(aliceList).includes(hidden));
  await fails(await fixture.handlers.listAttempts(request(null), { projectId: PROJECT }), 401, "UNAUTHENTICATED");
  await fails(await fixture.handlers.listAttempts(request(OUTSIDER), { projectId: PROJECT }), 403, "FORBIDDEN");
  const job = await data<ScoringJob>(await fixture.handlers.submitAttempt(request(ALICE, { expectedRevision: alice.revision }, "old-membership-job"), { attemptId: alice.id }), 202);
  fixture.changeMembership(ALICE, { status: "left" });
  await fails(await fixture.handlers.listAttempts(request(ALICE), { projectId: PROJECT }), 403, "FORBIDDEN");
  fixture.changeMembership(ALICE, { status: "active", membershipId: "pm-runtime-alice-v2" });
  assert.deepEqual(await data(await fixture.handlers.listAttempts(request(ALICE), { projectId: PROJECT })), []);
  await fails(await fixture.handlers.privateReport(request(ALICE), { attemptId: alice.id }), 403, "FORBIDDEN");
  await fails(await fixture.handlers.job(request(ALICE), { jobId: job.id }), 403, "FORBIDDEN");
  const replacement = await savedAttempt(fixture);
  assert.deepEqual((await data<OwnAttempts>(await fixture.handlers.listAttempts(request(ALICE), { projectId: PROJECT }))).map((entry) => entry.id), [replacement.id]);
  assert.equal(fixture.calls.length, 0);
});

const invalidModelResults: readonly [string, (request: ModelRequest) => unknown][] = [
  ["model-authored version", (request) => ({ ...contentFor(request), modelVersion: "forged-version" })],
  ["model-authored provenance", (request) => ({ ...contentFor(request), provenance: "model" })],
  ["model percentage", (request) => ({ ...contentFor(request), percentage: 75 })],
  ["forged evidence", (request) => ({ ...contentFor(request), criterionScores: contentFor(request).criterionScores.map((entry, index) => index === 0 ? { ...entry, evidenceRefs: ["foreign-evidence-id"] } : entry) })],
  ["score outside fixed anchors", (request) => ({ ...contentFor(request), criterionScores: contentFor(request).criterionScores.map((entry, index) => index === 0 ? { ...entry, score: 99 } : entry) })],
];
for (const [label, invalid] of invalidModelResults) {
  test(`runtime rejects ${label}, publishes no replacement and preserves prior answers/score`, async () => {
    const fixture = harness(); const first = await completedAttempt(fixture); fixture.setResponder(invalid);
    const job = await data<ScoringJob>(await fixture.handlers.reassess(request(ALICE, { expectedRevision: first.report.attempt.revision, correctionReason: "复核已有证据。" }, "invalid-reassessment"), { attemptId: first.attempt.id }), 202);
    const failed = await fixture.service.processScoringJob(job.id); assert.equal(failed.status, "failed"); assert.equal(failed.failureCode, "INVALID_SCORING_OUTPUT");
    const current = await report(fixture, first.attempt.id); assert.equal(current.attempt.status, "scoring_failed"); assert.equal(current.attempt.activeJobId, null);
    assert.deepEqual(current.scores, first.report.scores); assert.deepEqual(current.attempt.answers, first.report.attempt.answers); assert.equal(current.attempt.latestScoreId, first.report.attempt.latestScoreId);
    assert.equal((await data<ScoringJob>(await fixture.handlers.job(request(ALICE), { jobId: job.id }))).status, "failed");
    assert.equal(fixture.repository.inspect().scores.length, 1); assert.equal(fixture.calls.length, 2);
  });
}

test("runtime model timeout aborts the transport without adapter retry and keeps recoverable answers", async () => {
  const fixture = harness({ timeoutMs: 20 }); fixture.setResponder((_request, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DomainError("MODEL_TIMEOUT", "传输桩收到中止。", { status: 503 })), { once: true });
  }));
  const attempt = await savedAttempt(fixture); const job = await data<ScoringJob>(await fixture.handlers.submitAttempt(request(ALICE, { expectedRevision: attempt.revision }, "timeout-submit"), { attemptId: attempt.id }), 202);
  const failed = await fixture.service.processScoringJob(job.id); assert.equal(failed.status, "failed"); assert.equal(failed.failureCode, "MODEL_TIMEOUT");
  assert.equal(fixture.calls.length, 1); assert.equal(fixture.calls[0]!.signal.aborted, true);
  const current = await report(fixture, attempt.id); assert.deepEqual(current.attempt.answers, attempt.answers); assert.deepEqual(current.scores, []); assert.equal(current.attempt.latestScoreId, null);
});

for (const failureCode of ["AI_BUDGET_EXCEEDED", "AI_TIMEOUT_UNCERTAIN"] as const) {
  test(`runtime preserves safe ${failureCode} category without provider details or transport retry`, async () => {
    const fixture = harness();
    const sensitiveDetail = "PRIVATE_TRANSPORT_PROVIDER_BODY fixture-token=do-not-store private-upstream-answer=do-not-disclose";
    fixture.setResponder(() => { throw new DomainError(failureCode, sensitiveDetail, { status: failureCode === "AI_BUDGET_EXCEEDED" ? 429 : 503, recoveryAction: "PRIVATE_PROVIDER_RECOVERY_DETAIL" }); });
    const attempt = await savedAttempt(fixture);
    const queued = await data<ScoringJob>(await fixture.handlers.submitAttempt(request(ALICE, { expectedRevision: attempt.revision }, `transport-failure-${failureCode}`), { attemptId: attempt.id }), 202);
    assert.equal(queued.status, "queued"); assert.equal(fixture.calls.length, 0);
    const failed = await fixture.service.processScoringJob(queued.id);
    assert.equal(failed.status, "failed"); assert.equal(failed.failureCode, failureCode); assert.equal(failed.resultScoreId, null);
    assert.equal(fixture.calls.length, 1);
    const visibleJob = await data<ScoringJob>(await fixture.handlers.job(request(ALICE), { jobId: queued.id }));
    assert.equal(visibleJob.status, "failed"); assert.equal(visibleJob.failureCode, failureCode);
    const current = await report(fixture, attempt.id);
    assert.equal(current.attempt.status, "scoring_failed"); assert.equal(current.attempt.activeJobId, null); assert.equal(current.attempt.latestScoreId, null);
    assert.deepEqual(current.attempt.answers, attempt.answers); assert.deepEqual(current.scores, []);
    const persisted = fixture.repository.inspect();
    assert.equal(persisted.events.filter((event) => event.type === "AssessmentScoringFailed").at(-1)?.payload.failureCode, failureCode);
    for (const value of [failed, visibleJob, current, persisted]) {
      assert.ok(!JSON.stringify(value).includes(sensitiveDetail));
      assert.ok(!JSON.stringify(value).includes("PRIVATE_PROVIDER_RECOVERY_DETAIL"));
    }
    assert.deepEqual(await fixture.service.processScoringJob(queued.id), failed);
    assert.equal(fixture.calls.length, 1, "terminal job must not redispatch an uncertain or budget-limited request");
  });
}
