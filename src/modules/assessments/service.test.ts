import assert from "node:assert/strict";
import test from "node:test";
import type { Actor, ProjectMembershipAccess } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { FixedQuestionCatalog, PILOT_QUESTION_SET, PILOT_RUBRIC } from "./catalog.ts";
import type { AssessmentScorerPort, AssignmentSuggestionPort } from "./ports.ts";
import { AssessmentService } from "./service.ts";
import type { AssessmentAnswer, AssessmentAttempt, AssignmentContextSnapshot, ProposedAssignment, QuestionSet } from "./types.ts";
import { MemoryAssessmentRepository } from "./testing/memory-repository.ts";

const PROJECT = "project-test-fixture";
const ALICE: Actor = { userId: "alice", platformRoles: ["user"] };
const MANAGER: Actor = { userId: "manager", platformRoles: ["user"] };
const ADMIN: Actor = { userId: "admin", platformRoles: ["admin"] };
// Same-team captain fixture intentionally has no ProjectMembership for this project.
const TEAM_CAPTAIN: Actor = { userId: "same-team-captain", platformRoles: ["user"] };
const TEST_SET: QuestionSet = {
  ...structuredClone(PILOT_QUESTION_SET), id: "published-test-fixture-only", status: "published",
  limitations: [...PILOT_QUESTION_SET.limitations, "仅用于单元测试；不代表题库审核通过。"],
};
const PRIVATE_ANSWER = "PRIVATE_RAW_ANSWER 先核对最小交付物，再验证主要操作。";
const PRIVATE_REASON = "PRIVATE_MODEL_REASON 本次回答给出了明确检查步骤。";

function errorCode(code: string) {
  return (error: unknown): boolean => { assert.ok(error instanceof DomainError); assert.equal(error.code, code); return true; };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function answers(attempt: AssessmentAttempt, all = false): readonly AssessmentAnswer[] {
  return attempt.questionSetSnapshot.questions.filter((question) => all || question.required).map((question) => ({
    questionId: question.id, text: PRIVATE_ANSWER, evidence: [], aiUsage: "PRIVATE_AI_USAGE 仅辅助整理文字，步骤由本人确认。",
  }));
}

function validScoringOutput(attempt: AssessmentAttempt) {
  return {
    rubricVersionId: attempt.rubricVersionId,
    criterionScores: attempt.rubricSnapshot.criteria.map((criterion) => {
      const question = attempt.questionSetSnapshot.questions.find((entry) => entry.criterionIds.includes(criterion.id) && attempt.answers.some((answer) => answer.questionId === entry.id && answer.text.trim()));
      return {
        criterionId: criterion.id,
        state: question ? "scored" : "insufficient_evidence",
        score: question ? 2 : null,
        evidenceRefs: question ? [question.id] : [],
        reason: PRIVATE_REASON,
        unverified: ["PRIVATE_UNVERIFIED 外部作品未进行真实运行验证。"],
      };
    }),
    limitations: ["TEST FIXTURE SCORE：仅本次量规下的回答证据。"],
    modelVersion: "test-fixture-v1", promptVersion: "test-fixture-prompt-v1",
  };
}

function task(ownerMembershipId: string | null = "membership-alice", patch: Partial<ProposedAssignment> = {}): ProposedAssignment {
  return {
    clientTaskId: "task-home", title: "实现最小首页", priority: "must", ownerMembershipId,
    helperMembershipIds: [], deliverable: "可访问并完成主要操作的首页", acceptanceCriteria: ["主操作可完成，失败状态有文字"],
    dependencyTaskIds: [], proposedDeadlineRef: null, reason: "按本人意愿手动安排，未要求完成测评。", evidenceLevel: "self_reported", ...patch,
  };
}

function draft(assignments: readonly ProposedAssignment[] = [task()]) {
  return { assignments, gaps: [], assumptions: ["任务期限仍待时间规划校验。"] };
}

function harness(configuration: {
  readonly score?: AssessmentScorerPort["score"];
  readonly withoutScorer?: boolean;
  readonly allowTestFixtureScorer?: boolean;
  readonly suggestions?: AssignmentSuggestionPort;
  readonly timeoutMs?: number;
  readonly maxScoringRuns?: number;
  readonly catalog?: FixedQuestionCatalog;
  readonly enforceNoNestedPoolCheckout?: boolean;
} = {}) {
  const repository = new MemoryAssessmentRepository();
  const memberships = new Map<string, ProjectMembershipAccess>([
    ["alice", { membershipId: "membership-alice", projectId: PROJECT, userId: "alice", role: "member", status: "active" }],
    ["manager", { membershipId: "membership-manager", projectId: PROJECT, userId: "manager", role: "manager", status: "active" }],
    ["admin", { membershipId: "membership-admin", projectId: PROJECT, userId: "admin", role: "member", status: "active" }],
  ]);
  let context: AssignmentContextSnapshot = {
    projectId: PROJECT, projectRevision: 1, membershipRevision: 1, requirementVersionId: "requirements-v1",
    members: [...memberships.values()].map((member) => ({ ...member, memberAvailabilityVersionId: `${member.membershipId}-availability-v1` })),
  };
  let id = 0;
  let transactionDepth = 0;
  let nextMembershipCheck: (() => void) | undefined;
  let now = new Date("2026-10-08T01:00:00.000Z");
  const calls: { attempt: AssessmentAttempt; correctionReason: string | null }[] = [];
  const scorer: AssessmentScorerPort = {
    provenance: "test_fixture",
    score: async (input, signal) => { calls.push(structuredClone(input)); return configuration.score ? configuration.score(input, signal) : validScoringOutput(input.attempt); },
  };
  const service = new AssessmentService({
    repository: {
      transaction: (work) => repository.transaction(async (tx) => {
        transactionDepth += 1;
        try { return await work(tx); } finally { transactionDepth -= 1; }
      }),
    },
    catalog: configuration.catalog ?? new FixedQuestionCatalog({ questionSets: [TEST_SET], rubrics: [PILOT_RUBRIC] }),
    projectAccess: { getMembership: async (projectId, userId) => {
      if (configuration.enforceNoNestedPoolCheckout) assert.equal(transactionDepth, 0, "ProjectAccess must not acquire a second connection while an assessment transaction holds the only connection");
      const result = projectId === PROJECT ? structuredClone(memberships.get(userId) ?? null) : null;
      const hook = nextMembershipCheck; nextMembershipCheck = undefined; hook?.();
      return result;
    } },
    assignmentContext: { getSnapshot: async () => {
      if (configuration.enforceNoNestedPoolCheckout) assert.equal(transactionDepth, 1, "authoritative member context must be inspected inside the assessment transaction");
      return structuredClone(context);
    } },
    clock: { now: () => new Date(now) }, ids: { next: () => `fixture-${String(++id).padStart(4, "0")}` },
    ...(configuration.withoutScorer ? {} : { scorer }),
    ...(configuration.suggestions ? { suggestions: configuration.suggestions } : {}),
    allowTestFixtureScorer: configuration.allowTestFixtureScorer ?? true,
    modelTimeoutMs: configuration.timeoutMs ?? 1000, maxScoringRuns: configuration.maxScoringRuns ?? 3,
  });
  return {
    service, repository, calls,
    advanceTime(ms: number) { now = new Date(now.getTime() + ms); },
    setMember(userId: string, patch: Partial<ProjectMembershipAccess>) {
      const previous = memberships.get(userId); assert.ok(previous);
      memberships.set(userId, { ...previous, ...patch });
      context = { ...context, membershipRevision: context.membershipRevision + 1, members: context.members.map((member) => member.userId === userId ? { ...member, ...patch } : member) };
    },
    changeAvailability(userId: string) {
      context = { ...context, members: context.members.map((member) => member.userId === userId ? { ...member, memberAvailabilityVersionId: `${member.membershipId}-availability-v2` } : member) };
    },
    changeRequirements() { context = { ...context, requirementVersionId: "requirements-v2" }; },
    changeProjectState(patch: { readonly stage?: string; readonly readOnly?: boolean }) {
      context = { ...context, ...patch, projectRevision: context.projectRevision + 1 };
    },
    readOnly(value = true) { context = { ...context, readOnly: value, projectRevision: context.projectRevision + 1 }; },
    afterNextMembershipCheck(hook: () => void) { nextMembershipCheck = hook; },
  };
}

async function savedAttempt(fixture: ReturnType<typeof harness>, all = false) {
  const attempt = await fixture.service.createAttempt(ALICE, PROJECT, TEST_SET.id);
  return fixture.service.saveDraft(ALICE, attempt.id, attempt.revision, { answers: answers(attempt, all) });
}

async function completedAttempt(fixture: ReturnType<typeof harness>, all = false) {
  const attempt = await savedAttempt(fixture, all);
  const job = await fixture.service.submitAttempt(ALICE, attempt.id, attempt.revision, "submit-fixture");
  assert.equal((await fixture.service.processScoringJob(job.id)).status, "succeeded");
  return (await fixture.service.getPrivateReport(ALICE, attempt.id)).attempt;
}

test("the transaction fixture isolates reads and writes, rolls back outbox and state, and starts assignment heads at zero", async () => {
  const fixture = harness();
  const attempt = await savedAttempt(fixture);
  assert.deepEqual(await fixture.repository.transaction((tx) => tx.getHead(PROJECT)), { projectId: PROJECT, versionId: null, revision: 0 });
  await fixture.repository.transaction(async (tx) => {
    const read = await tx.getAttempt(attempt.id); assert.ok(read);
    (read.profile.tools as string[]).push("uncommitted mutation");
  });
  assert.deepEqual((await fixture.service.getPrivateReport(ALICE, attempt.id)).attempt.profile.tools, []);
  const before = fixture.repository.inspect();
  await assert.rejects(fixture.repository.transaction(async (tx) => {
    await tx.saveAttempt({ ...attempt, revision: attempt.revision + 1, status: "cancelled" }, attempt.revision);
    await tx.saveHead({ projectId: PROJECT, versionId: "uncommitted", revision: 1 }, 0);
    await tx.appendEvent({ eventId: "uncommitted", aggregateId: attempt.id, projectId: PROJECT, type: "AssessmentSubmitted", version: 3, occurredAt: attempt.updatedAt, payload: {} });
    throw new Error("force rollback");
  }), /force rollback/);
  assert.deepEqual(fixture.repository.inspect(), before);
  await assert.rejects(fixture.repository.transaction((tx) => tx.saveAttempt(attempt, null)), errorCode("INVALID_REVISION"));
  await assert.rejects(fixture.repository.transaction((tx) => tx.saveAttempt({ ...attempt, revision: 1 }, null)), errorCode("VERSION_CONFLICT"));
  await assert.rejects(fixture.repository.transaction((tx) => tx.saveAttempt({ ...attempt, revision: 2 }, 1)), errorCode("VERSION_CONFLICT"));
  const returned = await fixture.repository.transaction((tx) => tx.getAttempt(attempt.id)); assert.ok(returned);
  (returned.answers as AssessmentAnswer[]).length = 0;
  assert.equal((await fixture.service.getPrivateReport(ALICE, attempt.id)).attempt.answers.length, 1);
});

test("draft pilot content cannot create an attempt; published fixture preserves its own catalog snapshot", async () => {
  const unpublished = harness({ catalog: new FixedQuestionCatalog({ questionSets: [PILOT_QUESTION_SET], rubrics: [PILOT_RUBRIC] }) });
  await assert.rejects(unpublished.service.createAttempt(ALICE, PROJECT, PILOT_QUESTION_SET.id), errorCode("QUESTION_SET_UNAVAILABLE"));
  assert.equal(PILOT_QUESTION_SET.status, "draft");
  const fixture = harness();
  const attempt = await fixture.service.createAttempt(ALICE, PROJECT, TEST_SET.id);
  assert.equal(attempt.questionSetSnapshot.status, "published");
  assert.deepEqual(attempt.sharing, { confirmedTasks: [], criterionIds: [] });
  assert.equal(attempt.questionSetSnapshot.limitations.at(-1), "仅用于单元测试；不代表题库审核通过。");
});

test("raw answers and jobs stay author-only even for the project manager and platform administrator", async () => {
  const fixture = harness();
  const attempt = await savedAttempt(fixture);
  const job = await fixture.service.submitAttempt(ALICE, attempt.id, attempt.revision, "private-job");
  for (const actor of [MANAGER, ADMIN]) {
    await assert.rejects(fixture.service.getPrivateReport(actor, attempt.id), errorCode("NOT_FOUND"));
    await assert.rejects(fixture.service.saveDraft(actor, attempt.id, attempt.revision, {}), errorCode("NOT_FOUND"));
    await assert.rejects(fixture.service.setSharing(actor, attempt.id, attempt.revision, { confirmedTasks: ["development"], criterionIds: [] }), errorCode("NOT_FOUND"));
    await assert.rejects(fixture.service.getJob(actor, job.id), errorCode("NOT_FOUND"));
  }
  assert.equal((await fixture.service.getPrivateReport(ALICE, attempt.id)).attempt.answers[0]?.text, PRIVATE_ANSWER);
});

test("same-team captain without project membership and departed or replaced memberships are rejected", async () => {
  const fixture = harness();
  await assert.rejects(fixture.service.createAttempt(TEAM_CAPTAIN, PROJECT, TEST_SET.id), errorCode("FORBIDDEN"));
  await assert.rejects(fixture.service.createAssignment(TEAM_CAPTAIN, PROJECT, null, draft()), errorCode("FORBIDDEN"));
  const attempt = await savedAttempt(fixture);
  fixture.setMember("alice", { status: "left" });
  await assert.rejects(fixture.service.getPrivateReport(ALICE, attempt.id), errorCode("FORBIDDEN"));
  await assert.rejects(fixture.service.getTeamSummaries(ALICE, PROJECT), errorCode("FORBIDDEN"));
  fixture.setMember("alice", { status: "active", membershipId: "new-membership-alice" });
  await assert.rejects(fixture.service.getPrivateReport(ALICE, attempt.id), errorCode("FORBIDDEN"));
});

test("draft saves use CAS; required answers and unsupported age fields cannot be submitted", async () => {
  const fixture = harness();
  const attempt = await fixture.service.createAttempt(ALICE, PROJECT, TEST_SET.id);
  await assert.rejects(fixture.service.submitAttempt(ALICE, attempt.id, attempt.revision, "empty"), errorCode("INVALID_INPUT"));
  const profile = { experience: "本人自述", tools: [], preferredTasks: [], memberAvailabilityVersionId: null };
  await assert.rejects(fixture.service.saveDraft(ALICE, attempt.id, attempt.revision, { profile: { ...profile, age: 16 } }), errorCode("INVALID_INPUT"));
  await assert.rejects(fixture.service.saveDraft(ALICE, attempt.id, attempt.revision, { age: 16 }), errorCode("INVALID_INPUT"));
  const results = await Promise.allSettled([
    fixture.service.saveDraft(ALICE, attempt.id, attempt.revision, { answers: answers(attempt) }),
    fixture.service.saveDraft(ALICE, attempt.id, attempt.revision, { profile }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected"); assert.ok(rejected && rejected.status === "rejected");
  assert.ok(errorCode("VERSION_CONFLICT")(rejected.reason));
  const latest = (await fixture.service.getPrivateReport(ALICE, attempt.id)).attempt;
  assert.equal(latest.revision, attempt.revision + 1);
  assert.deepEqual(latest.answers, answers(attempt));
});

test("follow-ups bind existing criteria, reject duplicates, cap at three, and must be answered before submit", async () => {
  const fixture = harness();
  let attempt = await savedAttempt(fixture);
  await assert.rejects(fixture.service.addFollowUp(ALICE, attempt.id, attempt.revision, "unknown-question", PILOT_RUBRIC.criteria[0]!.id), errorCode("INVALID_INPUT"));
  await assert.rejects(fixture.service.addFollowUp(ALICE, attempt.id, attempt.revision, TEST_SET.questions[0]!.id, PILOT_RUBRIC.criteria[1]!.id), errorCode("INVALID_INPUT"));
  for (const question of TEST_SET.questions.slice(0, TEST_SET.maxFollowUps)) {
    attempt = await fixture.service.addFollowUp(ALICE, attempt.id, attempt.revision, question.id, question.criterionIds[0]!);
    if (attempt.followUps.length === 1) {
      await assert.rejects(fixture.service.addFollowUp(ALICE, attempt.id, attempt.revision, question.id, question.criterionIds[0]!), errorCode("INVALID_INPUT"));
    }
  }
  await assert.rejects(fixture.service.addFollowUp(ALICE, attempt.id, attempt.revision, TEST_SET.questions[3]!.id, TEST_SET.questions[3]!.criterionIds[0]!), errorCode("FOLLOW_UP_LIMIT"));
  await assert.rejects(fixture.service.submitAttempt(ALICE, attempt.id, attempt.revision, "missing-followup"), errorCode("INVALID_INPUT"));
  await assert.rejects(fixture.service.saveDraft(ALICE, attempt.id, attempt.revision, { followUpAnswers: [{ id: "unknown", answer: "回答" }] }), errorCode("INVALID_INPUT"));
  attempt = await fixture.service.saveDraft(ALICE, attempt.id, attempt.revision, { followUpAnswers: attempt.followUps.map((entry) => ({ id: entry.id, answer: "已补充操作、预期结果与未验证边界。" })) });
  assert.equal((await fixture.service.submitAttempt(ALICE, attempt.id, attempt.revision, "complete-followup")).status, "queued");
});

test("repeated submit keys and overlapping worker executions call the model only once", async () => {
  const entered = deferred<void>(); const output = deferred<unknown>();
  const fixture = harness({ score: async () => { entered.resolve(); return output.promise; } });
  const attempt = await savedAttempt(fixture);
  const jobs = await Promise.all([
    fixture.service.submitAttempt(ALICE, attempt.id, attempt.revision, "same-key"),
    fixture.service.submitAttempt(ALICE, attempt.id, attempt.revision, "same-key"),
  ]);
  assert.equal(jobs[0]!.id, jobs[1]!.id);
  assert.equal(fixture.repository.inspect().jobs.length, 1);
  assert.equal(fixture.repository.inspect().events.filter((event) => event.type === "AssessmentSubmitted").length, 1);
  const firstWorker = fixture.service.processScoringJob(jobs[0]!.id);
  await entered.promise;
  assert.equal((await fixture.service.processScoringJob(jobs[0]!.id)).status, "running");
  output.resolve(validScoringOutput(attempt));
  assert.equal((await firstWorker).status, "succeeded");
  assert.equal((await fixture.service.processScoringJob(jobs[0]!.id)).status, "succeeded");
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.repository.inspect().scores.length, 1);
  assert.equal((await fixture.service.submitAttempt(ALICE, attempt.id, attempt.revision, "same-key")).id, jobs[0]!.id);
  await assert.rejects(fixture.service.saveDraft(ALICE, attempt.id, (await fixture.service.getPrivateReport(ALICE, attempt.id)).attempt.revision, { answers: [] }), errorCode("ATTEMPT_LOCKED"));
});

test("invalid model output fails without publishing or losing answers and emits a sanitized failure fact", async () => {
  const fixture = harness({ score: async ({ attempt }) => ({ ...validScoringOutput(attempt), criterionScores: [] }) });
  const attempt = await savedAttempt(fixture);
  const job = await fixture.service.submitAttempt(ALICE, attempt.id, attempt.revision, "invalid-score");
  const failed = await fixture.service.processScoringJob(job.id);
  assert.equal(failed.status, "failed"); assert.equal(failed.failureCode, "INVALID_SCORING_OUTPUT");
  const report = await fixture.service.getPrivateReport(ALICE, attempt.id);
  assert.equal(report.attempt.status, "scoring_failed"); assert.deepEqual(report.attempt.answers, attempt.answers);
  assert.equal(report.scores.length, 0); assert.equal(report.attempt.latestScoreId, null); assert.equal(report.attempt.activeJobId, null);
  assert.deepEqual(fixture.repository.inspect().events.filter((event) => event.type === "AssessmentScoringFailed").map((event) => event.payload.failureCode), ["INVALID_SCORING_OUTPUT"]);
  assert.equal(JSON.stringify(failed).includes(PRIVATE_ANSWER), false);
});

test("missing models and disabled scorer fixtures fail explicitly while unassessed members still receive manual assignments", async () => {
  for (const options of [{ withoutScorer: true }, { allowTestFixtureScorer: false }]) {
    const fixture = harness(options);
    const attempt = await savedAttempt(fixture);
    await assert.rejects(fixture.service.submitAttempt(ALICE, attempt.id, attempt.revision, "unavailable-model"), errorCode("withoutScorer" in options ? "MODEL_UNAVAILABLE" : "TEST_SCORER_DISABLED"));
    assert.equal(fixture.repository.inspect().jobs.length, 0);
    assert.deepEqual((await fixture.service.getPrivateReport(ALICE, attempt.id)).attempt, attempt);
    assert.equal(fixture.calls.length, 0);
    const manual = await fixture.service.createAssignment(MANAGER, PROJECT, null, draft([task("membership-admin")]));
    const ready = await fixture.service.validateAssignment(MANAGER, manual.id, manual.revision);
    assert.equal((await fixture.service.applyAssignment(MANAGER, ready.id, ready.revision)).status, "applied");
    assert.equal(fixture.repository.inspect().attempts.some((entry) => entry.userId === "admin"), false);
    await assert.rejects(fixture.service.suggestAssignment(MANAGER, PROJECT, ["首页"]), errorCode("MODEL_UNAVAILABLE"));
  }
});

test("sharing is empty by default, selective and revocable, and never includes private answers, reasons or unverified text", async () => {
  const fixture = harness(); let attempt = await completedAttempt(fixture, true);
  assert.deepEqual(await fixture.service.getTeamSummaries(MANAGER, PROJECT), []);
  attempt = await fixture.service.setSharing(ALICE, attempt.id, attempt.revision, { confirmedTasks: ["requirements"], criterionIds: [PILOT_RUBRIC.criteria[0]!.id] });
  const summaries = await fixture.service.getTeamSummaries(MANAGER, PROJECT);
  assert.equal(summaries.length, 1); assert.deepEqual(summaries[0]!.confirmedTasks, ["requirements"]);
  const criterion = PILOT_RUBRIC.criteria[0]!;
  assert.deepEqual(summaries[0]!.criterionScores, [{ criterionId: criterion.id, state: "scored", score: 2, dimension: criterion.dimension, label: criterion.label, maxScore: criterion.maxScore }]);
  assert.equal(summaries[0]!.provenance, "test_fixture");
  assert.ok(summaries[0]!.scoreMeaning.includes("不换算能力百分比"));
  const serialized = JSON.stringify(summaries);
  for (const token of ["PRIVATE_RAW_ANSWER", "PRIVATE_AI_USAGE", "PRIVATE_MODEL_REASON", "PRIVATE_UNVERIFIED", "answers", "evidenceRefs", "reason", "profile"]) assert.equal(serialized.includes(token), false, token);
  await fixture.service.setSharing(ALICE, attempt.id, attempt.revision, { confirmedTasks: [], criterionIds: [] });
  assert.deepEqual(await fixture.service.getTeamSummaries(MANAGER, PROJECT), []);
  assert.equal((await fixture.service.getPrivateReport(ALICE, attempt.id)).scores.length, 1);
});

test("assessed assignment evidence requires the author's currently shared scored criterion", async () => {
  const fixture = harness(); let attempt = await completedAttempt(fixture);
  await assert.rejects(fixture.service.createAssignment(MANAGER, PROJECT, null, draft([task("membership-alice", { evidenceLevel: "assessed" })])), errorCode("INVALID_INPUT"));
  attempt = await fixture.service.setSharing(ALICE, attempt.id, attempt.revision, { confirmedTasks: [], criterionIds: [PILOT_RUBRIC.criteria[1]!.id] });
  await assert.rejects(fixture.service.createAssignment(MANAGER, PROJECT, null, draft([task("membership-alice", { evidenceLevel: "assessed" })])), errorCode("INVALID_INPUT"));
  await fixture.service.setSharing(ALICE, attempt.id, attempt.revision, { confirmedTasks: [], criterionIds: [PILOT_RUBRIC.criteria[0]!.id] });
  assert.equal((await fixture.service.createAssignment(MANAGER, PROJECT, null, draft([task("membership-alice", { evidenceLevel: "assessed" })]))).status, "draft");
  await assert.rejects(fixture.service.createAssignment(MANAGER, PROJECT, null, draft([task("membership-alice", { evidenceLevel: "verified" })])), errorCode("UNVERIFIED_EVIDENCE"));
});

test("assignment creation, edit, validation and apply require active project manager permissions and a separate ready state", async () => {
  const fixture = harness();
  for (const actor of [ALICE, ADMIN, TEAM_CAPTAIN]) await assert.rejects(fixture.service.createAssignment(actor, PROJECT, null, draft()), errorCode("FORBIDDEN"));
  const version = await fixture.service.createAssignment(MANAGER, PROJECT, null, draft());
  for (const actor of [ALICE, ADMIN]) {
    await assert.rejects(fixture.service.editAssignment(actor, version.id, version.revision, draft()), errorCode("FORBIDDEN"));
    await assert.rejects(fixture.service.validateAssignment(actor, version.id, version.revision), errorCode("FORBIDDEN"));
    await assert.rejects(fixture.service.applyAssignment(actor, version.id, version.revision), errorCode("FORBIDDEN"));
  }
  await assert.rejects(fixture.service.applyAssignment(MANAGER, version.id, version.revision), errorCode("ASSIGNMENT_NOT_READY"));
  const ready = await fixture.service.validateAssignment(MANAGER, version.id, version.revision);
  assert.equal(ready.status, "ready"); assert.equal(ready.appliedAt, null);
  const applied = await fixture.service.applyAssignment(MANAGER, ready.id, ready.revision);
  assert.equal(applied.status, "applied"); assert.equal(applied.appliedBy, MANAGER.userId);
  assert.equal((await fixture.service.getAppliedAssignment(ALICE, PROJECT)).head.versionId, applied.id);
  await assert.rejects(fixture.service.editAssignment(MANAGER, applied.id, applied.revision, draft()), errorCode("ASSIGNMENT_IMMUTABLE"));
});

test("unassigned drafts remain needs_changes, missing owners and invalid dependencies cannot become ready", async () => {
  const fixture = harness();
  const version = await fixture.service.createAssignment(MANAGER, PROJECT, null, draft([task(null)]));
  assert.equal(version.status, "needs_changes"); assert.equal(version.validationIssues.length, 1);
  await assert.rejects(fixture.service.validateAssignment(MANAGER, version.id, version.revision), errorCode("ASSIGNMENT_NEEDS_CHANGES"));
  await assert.rejects(fixture.service.createAssignment(MANAGER, PROJECT, null, draft([task("alice")])), errorCode("INVALID_INPUT"));
  await assert.rejects(fixture.service.createAssignment(MANAGER, PROJECT, null, draft([task("membership-alice", { dependencyTaskIds: ["missing"] })])), errorCode("INVALID_INPUT"));
  await assert.rejects(fixture.service.createAssignment(MANAGER, PROJECT, null, draft([
    task("membership-alice", { clientTaskId: "a", dependencyTaskIds: ["b"] }), task("membership-admin", { clientTaskId: "b", dependencyTaskIds: ["a"] }),
  ])), errorCode("INVALID_INPUT"));
  await assert.rejects(fixture.service.createAssignment(MANAGER, PROJECT, null, { ...draft(), age: 16 }), errorCode("INVALID_INPUT"));
  const edited = await fixture.service.editAssignment(MANAGER, version.id, version.revision, draft());
  assert.equal(edited.status, "draft"); assert.deepEqual(edited.validationIssues, []);
});

test("competing edits preserve the winning draft and reject the stale editor with latestRevision", async () => {
  const fixture = harness();
  const version = await fixture.service.createAssignment(MANAGER, PROJECT, null, draft());
  const results = await Promise.allSettled([
    fixture.service.editAssignment(MANAGER, version.id, version.revision, draft([task("membership-alice", { title: "第一个编辑" })])),
    fixture.service.editAssignment(MANAGER, version.id, version.revision, draft([task("membership-admin", { title: "过期编辑" })])),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected"); assert.ok(rejected && rejected.status === "rejected");
  assert.ok(errorCode("VERSION_CONFLICT")(rejected.reason)); assert.equal(rejected.reason.latestRevision, 2);
  const latest = await fixture.service.getAssignment(MANAGER, version.id);
  assert.equal(latest.assignments[0]!.title, "第一个编辑"); assert.equal(latest.revision, 2);
});

for (const change of ["departure", "availability", "requirements", "sharing"] as const) {
  test(`a ready assignment cannot be applied after ${change} changes its input snapshot`, async () => {
    const fixture = harness(); let attempt = await completedAttempt(fixture);
    attempt = await fixture.service.setSharing(ALICE, attempt.id, attempt.revision, { confirmedTasks: ["requirements"], criterionIds: [PILOT_RUBRIC.criteria[0]!.id] });
    const version = await fixture.service.createAssignment(MANAGER, PROJECT, null, draft());
    const ready = await fixture.service.validateAssignment(MANAGER, version.id, version.revision);
    if (change === "departure") fixture.setMember("alice", { status: "left" });
    else if (change === "availability") fixture.changeAvailability("alice");
    else if (change === "requirements") fixture.changeRequirements();
    else await fixture.service.setSharing(ALICE, attempt.id, attempt.revision, { confirmedTasks: [], criterionIds: [] });
    await assert.rejects(fixture.service.applyAssignment(MANAGER, ready.id, ready.revision), errorCode("ASSIGNMENT_INPUT_CHANGED"));
    const unchangedHistory = await fixture.service.getAssignment(MANAGER, ready.id);
    assert.equal(unchangedHistory.status, "ready");
    assert.equal(unchangedHistory.inputFreshness, "changed");
    assert.ok(unchangedHistory.staleReason);
    assert.equal((await fixture.service.getAppliedAssignment(MANAGER, PROJECT)).head.versionId, null);
    assert.equal(fixture.repository.inspect().events.filter((event) => event.type === "AssignmentApplied").length, 0);
  });
}

test("two ready drafts on one baseline can apply only once; successor application retains versions and outbox facts", async () => {
  const fixture = harness();
  const a = await fixture.service.createAssignment(MANAGER, PROJECT, null, draft());
  const b = await fixture.service.createAssignment(MANAGER, PROJECT, null, draft([task("membership-admin")]));
  const readyA = await fixture.service.validateAssignment(MANAGER, a.id, a.revision);
  const readyB = await fixture.service.validateAssignment(MANAGER, b.id, b.revision);
  const results = await Promise.allSettled([
    fixture.service.applyAssignment(MANAGER, readyA.id, readyA.revision),
    fixture.service.applyAssignment(MANAGER, readyB.id, readyB.revision),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected"); assert.ok(rejected && rejected.status === "rejected");
  assert.ok(errorCode("ASSIGNMENT_BASE_CHANGED")(rejected.reason));
  const applied = await fixture.service.getAppliedAssignment(MANAGER, PROJECT); assert.ok(applied.version);
  assert.equal(applied.head.revision, 1); assert.equal(applied.version.id, a.id);
  assert.equal((await fixture.service.getAssignment(MANAGER, b.id)).status, "ready");
  const successor = await fixture.service.createAssignment(MANAGER, PROJECT, applied.version.id, draft([task("membership-admin", { title: "调整负责人" })]));
  assert.equal(successor.changes[0]?.kind, "modified");
  const readySuccessor = await fixture.service.validateAssignment(MANAGER, successor.id, successor.revision);
  const next = await fixture.service.applyAssignment(MANAGER, readySuccessor.id, readySuccessor.revision);
  assert.equal((await fixture.service.getAssignment(MANAGER, a.id)).status, "superseded");
  assert.equal((await fixture.service.getAppliedAssignment(MANAGER, PROJECT)).head.revision, 2);
  const events = fixture.repository.inspect().events.filter((event) => event.type === "AssignmentApplied");
  assert.equal(events.length, 2); assert.equal(events[1]?.payload.previousAssignmentVersionId, a.id); assert.equal(events[1]?.payload.assignmentVersionId, next.id);
});

test("reassessment appends an immutable score with lineage, and failed corrections retain the previous usable score", async () => {
  let run = 0;
  const fixture = harness({ score: async ({ attempt }) => { run += 1; return run < 3 ? validScoringOutput(attempt) : { providerError: "PRIVATE_PROVIDER_ERROR" }; } });
  let attempt = await completedAttempt(fixture);
  const original = (await fixture.service.getPrivateReport(ALICE, attempt.id)).scores[0]!;
  assert.ok(original.limitations.includes(TEST_SET.limitations.at(-1)!));
  assert.ok(original.limitations.some((limitation) => limitation.includes("不表示真实能力百分比")));
  const reassess = await fixture.service.requestReassessment(ALICE, attempt.id, attempt.revision, "reassess-v2", "请重新核对证据引用。");
  assert.equal((await fixture.service.processScoringJob(reassess.id)).status, "succeeded");
  let report = await fixture.service.getPrivateReport(ALICE, attempt.id);
  assert.equal(report.scores.length, 2); assert.deepEqual(report.scores[0], original);
  assert.equal(report.scores[1]!.supersedesScoreId, original.id); assert.equal(report.scores[1]!.correctionReason, "请重新核对证据引用。");
  assert.equal(report.scores[1]!.provenance, "test_fixture");
  attempt = report.attempt;
  const correction = await fixture.service.requestReassessment(ALICE, attempt.id, attempt.revision, "reassess-v3", "仍需人工复查。");
  assert.equal((await fixture.service.processScoringJob(correction.id)).status, "failed");
  report = await fixture.service.getPrivateReport(ALICE, attempt.id);
  assert.equal(report.attempt.status, "scoring_failed"); assert.equal(report.scores.length, 2);
  assert.equal(report.attempt.latestScoreId, report.scores[1]!.id); assert.deepEqual(report.attempt.answers, attempt.answers);
  assert.equal(JSON.stringify(await fixture.service.getJob(ALICE, correction.id)).includes("PRIVATE_PROVIDER_ERROR"), false);
  await assert.rejects(fixture.service.requestReassessment(ALICE, attempt.id, report.attempt.revision, "reassess-v4", "超过允许次数。"), errorCode("SCORING_RETRY_LIMIT"));
  await assert.rejects(fixture.service.requestReassessment(ALICE, attempt.id, report.attempt.revision, "reassess-v2", "同一幂等键的新理由。"), errorCode("IDEMPOTENCY_CONFLICT"));
});

test("model timeout aborts the adapter, preserves input, and cannot publish a late result", async () => {
  const late = deferred<unknown>(); let signalSeen: AbortSignal | undefined;
  const fixture = harness({ timeoutMs: 10, score: async (_input, signal) => { signalSeen = signal; return late.promise; } });
  const attempt = await savedAttempt(fixture);
  const job = await fixture.service.submitAttempt(ALICE, attempt.id, attempt.revision, "timeout");
  const failed = await fixture.service.processScoringJob(job.id);
  assert.equal(failed.failureCode, "MODEL_TIMEOUT"); assert.equal(signalSeen?.aborted, true);
  late.resolve(validScoringOutput(attempt));
  await Promise.resolve();
  const report = await fixture.service.getPrivateReport(ALICE, attempt.id);
  assert.equal(report.attempt.status, "scoring_failed"); assert.deepEqual(report.attempt.answers, attempt.answers); assert.equal(report.scores.length, 0);
  assert.equal((await fixture.service.processScoringJob(job.id)).status, "failed"); assert.equal(fixture.calls.length, 1);
});

test("worker crash recovery expires a running lease without a second model call", async () => {
  const entered = deferred<void>(); const output = deferred<unknown>();
  const fixture = harness({ timeoutMs: 1000, score: async () => { entered.resolve(); return output.promise; } });
  const attempt = await savedAttempt(fixture);
  const job = await fixture.service.submitAttempt(ALICE, attempt.id, attempt.revision, "crash-recovery");
  const worker = fixture.service.processScoringJob(job.id); await entered.promise;
  assert.equal((await fixture.service.recoverExpiredScoringJob(job.id)).status, "running");
  fixture.advanceTime(31001);
  assert.equal((await fixture.service.recoverExpiredScoringJob(job.id)).failureCode, "WORKER_INTERRUPTED");
  output.resolve(validScoringOutput(attempt));
  assert.equal((await worker).status, "failed"); assert.equal(fixture.calls.length, 1); assert.equal(fixture.repository.inspect().scores.length, 0);
});

test("assignment suggestion models receive only explicit summaries and stale generation cannot create a draft", async () => {
  const entered = deferred<void>(); const output = deferred<unknown>();
  let received: unknown;
  const fixture = harness({ suggestions: { suggest: async (input) => { received = structuredClone(input); entered.resolve(); return output.promise; } } });
  let attempt = await completedAttempt(fixture);
  attempt = await fixture.service.setSharing(ALICE, attempt.id, attempt.revision, { confirmedTasks: ["requirements"], criterionIds: [PILOT_RUBRIC.criteria[0]!.id] });
  const generation = fixture.service.suggestAssignment(MANAGER, PROJECT, ["最小首页"]); await entered.promise;
  const serialized = JSON.stringify(received);
  for (const token of ["PRIVATE_RAW_ANSWER", "PRIVATE_MODEL_REASON", "PRIVATE_AI_USAGE", "answers", "evidenceRefs"]) assert.equal(serialized.includes(token), false, token);
  await fixture.service.setSharing(ALICE, attempt.id, attempt.revision, { confirmedTasks: [], criterionIds: [] });
  output.resolve(draft());
  await assert.rejects(generation, errorCode("ASSIGNMENT_INPUT_CHANGED"));
  assert.equal(fixture.repository.inspect().assignments.length, 0);
});

test("a queued scoring job becomes failed when its author departs or their original membership is replaced", async () => {
  for (const replacement of [false, true]) {
    const fixture = harness();
    const attempt = await savedAttempt(fixture);
    const job = await fixture.service.submitAttempt(ALICE, attempt.id, attempt.revision, "queued-departure");
    fixture.setMember("alice", replacement ? { membershipId: "replacement-alice" } : { status: "left" });
    const failed = await fixture.service.processScoringJob(job.id);
    assert.equal(failed.status, "failed"); assert.equal(failed.failureCode, "FORBIDDEN");
    assert.equal(fixture.calls.length, 0); assert.equal(fixture.repository.inspect().scores.length, 0);
    const stored = fixture.repository.inspect().attempts.find((entry) => entry.id === attempt.id)!;
    assert.equal(stored.status, "scoring_failed"); assert.deepEqual(stored.answers, attempt.answers);
    assert.equal(fixture.repository.inspect().events.filter((event) => event.type === "AssessmentScoringFailed").length, 1);
  }
});

test("profile availability references must be the author's current authoritative collection", async () => {
  const fixture = harness(); let attempt = await savedAttempt(fixture);
  const profile = { experience: "本人意愿", tools: [], preferredTasks: [], memberAvailabilityVersionId: "membership-alice-availability-v1" };
  attempt = await fixture.service.saveDraft(ALICE, attempt.id, attempt.revision, { profile });
  fixture.changeAvailability("alice");
  await assert.rejects(fixture.service.saveDraft(ALICE, attempt.id, attempt.revision, { profile }), errorCode("INVALID_INPUT"));
  const saved = await fixture.service.saveDraft(ALICE, attempt.id, attempt.revision, { profile: { ...profile, memberAvailabilityVersionId: "membership-alice-availability-v2" } });
  assert.equal(saved.profile.memberAvailabilityVersionId, "membership-alice-availability-v2");
});

test("a model result cannot publish after the author's active membership changes during scoring", async () => {
  for (const replacement of [false, true]) {
    const entered = deferred<void>(); const output = deferred<unknown>();
    const fixture = harness({ score: async () => { entered.resolve(); return output.promise; } });
    const attempt = await savedAttempt(fixture);
    const job = await fixture.service.submitAttempt(ALICE, attempt.id, attempt.revision, "mid-score-departure");
    const worker = fixture.service.processScoringJob(job.id); await entered.promise;
    fixture.setMember("alice", replacement ? { membershipId: "replacement-alice" } : { status: "removed" });
    output.resolve(validScoringOutput(attempt));
    const failed = await worker;
    assert.equal(failed.status, "failed"); assert.equal(failed.failureCode, "FORBIDDEN");
    assert.equal(fixture.calls.length, 1); assert.equal(fixture.repository.inspect().scores.length, 0);
    assert.equal(fixture.repository.inspect().attempts[0]!.latestScoreId, null);
    assert.deepEqual(fixture.repository.inspect().attempts[0]!.answers, attempt.answers);
  }
});

test("author and assignment workflows work without nested pool acquisition while retaining transaction-bound permission checks", async () => {
  const fixture = harness({ enforceNoNestedPoolCheckout: true });
  const attempt = await savedAttempt(fixture);
  const job = await fixture.service.submitAttempt(ALICE, attempt.id, attempt.revision, "single-connection-pool");
  assert.equal((await fixture.service.getJob(ALICE, job.id)).status, "queued");
  assert.equal((await fixture.service.processScoringJob(job.id)).status, "succeeded");
  assert.equal((await fixture.service.getPrivateReport(ALICE, attempt.id)).scores.length, 1);
  assert.deepEqual(await fixture.service.getTeamSummaries(MANAGER, PROJECT), []);
  const version = await fixture.service.createAssignment(MANAGER, PROJECT, null, draft());
  const edited = await fixture.service.editAssignment(MANAGER, version.id, version.revision, draft([task("membership-admin")]));
  const ready = await fixture.service.validateAssignment(MANAGER, edited.id, edited.revision);
  assert.equal((await fixture.service.applyAssignment(MANAGER, ready.id, ready.revision)).status, "applied");
  assert.equal((await fixture.service.getAssignment(MANAGER, ready.id)).inputFreshness, "current");
  assert.equal((await fixture.service.getAppliedAssignment(MANAGER, PROJECT)).version?.id, version.id);
});

function projectReadOnly(error: unknown): boolean {
  assert.ok(error instanceof DomainError);
  assert.equal(error.code, "PROJECT_READ_ONLY"); assert.equal(error.status, 409);
  return true;
}

async function writableProjectFixture() {
  let suggestionCalls = 0;
  const fixture = harness({ suggestions: { suggest: async () => { suggestionCalls += 1; return draft(); } } });
  let completed = await completedAttempt(fixture);
  completed = await fixture.service.setSharing(ALICE, completed.id, completed.revision, { confirmedTasks: ["requirements"], criterionIds: [PILOT_RUBRIC.criteria[0]!.id] });
  const saved = await savedAttempt(fixture);
  const baseDraft = await fixture.service.createAssignment(MANAGER, PROJECT, null, draft());
  const baseReady = await fixture.service.validateAssignment(MANAGER, baseDraft.id, baseDraft.revision);
  const applied = await fixture.service.applyAssignment(MANAGER, baseReady.id, baseReady.revision);
  const editable = await fixture.service.createAssignment(MANAGER, PROJECT, applied.id, draft());
  const pending = await fixture.service.createAssignment(MANAGER, PROJECT, applied.id, draft([task("membership-admin")]));
  const ready = await fixture.service.validateAssignment(MANAGER, pending.id, pending.revision);
  const writes: readonly [string, () => Promise<unknown>][] = [
    ["createAttempt", () => fixture.service.createAttempt(ALICE, PROJECT, TEST_SET.id)],
    ["saveDraft", () => fixture.service.saveDraft(ALICE, saved.id, saved.revision, { answers: answers(saved) })],
    ["addFollowUp", () => fixture.service.addFollowUp(ALICE, saved.id, saved.revision, TEST_SET.questions[0]!.id, PILOT_RUBRIC.criteria[0]!.id)],
    ["cancelAttempt", () => fixture.service.cancelAttempt(ALICE, saved.id, saved.revision)],
    ["setSharing", () => fixture.service.setSharing(ALICE, completed.id, completed.revision, { confirmedTasks: [], criterionIds: [] })],
    ["submitAttempt", () => fixture.service.submitAttempt(ALICE, saved.id, saved.revision, "read-only-submit")],
    ["requestReassessment", () => fixture.service.requestReassessment(ALICE, completed.id, completed.revision, "read-only-reassess", "重新检查证据。")],
    ["createAssignment", () => fixture.service.createAssignment(MANAGER, PROJECT, applied.id, draft())],
    ["editAssignment", () => fixture.service.editAssignment(MANAGER, editable.id, editable.revision, draft([task("membership-admin")]))],
    ["validateAssignment", () => fixture.service.validateAssignment(MANAGER, editable.id, editable.revision)],
    ["applyAssignment", () => fixture.service.applyAssignment(MANAGER, ready.id, ready.revision)],
    ["suggestAssignment", () => fixture.service.suggestAssignment(MANAGER, PROJECT, ["最小首页"])],
  ];
  return { fixture, completed, saved, applied, editable, ready, writes, suggestionCalls: () => suggestionCalls };
}

for (const restriction of ["archived", "readOnly"] as const) {
  test(`${restriction} projects reject every assessment and assignment write but preserve historical reads`, async () => {
    const prepared = await writableProjectFixture(); const { fixture } = prepared;
    const privateBefore = await fixture.service.getPrivateReport(ALICE, prepared.completed.id);
    const job = fixture.repository.inspect().jobs.find((entry) => entry.attemptId === prepared.completed.id)!;
    const summariesBefore = await fixture.service.getTeamSummaries(MANAGER, PROJECT);
    if (restriction === "archived") fixture.changeProjectState({ stage: "archived" }); else fixture.readOnly();
    const before = fixture.repository.inspect();
    for (const [name, operation] of prepared.writes) {
      await assert.rejects(operation(), projectReadOnly, name);
      assert.deepEqual(fixture.repository.inspect(), before, `${name} must not alter persisted data`);
    }
    assert.equal(prepared.suggestionCalls(), 0);
    const privateAfter = await fixture.service.getPrivateReport(ALICE, prepared.completed.id);
    assert.deepEqual(privateAfter.attempt, privateBefore.attempt); assert.deepEqual(privateAfter.scores, privateBefore.scores);
    assert.deepEqual(await fixture.service.getJob(ALICE, job.id), job);
    assert.deepEqual(await fixture.service.getTeamSummaries(MANAGER, PROJECT), summariesBefore);
    const history = await fixture.service.getAssignment(MANAGER, prepared.applied.id);
    assert.equal(history.status, "applied"); assert.deepEqual(history.assignments, prepared.applied.assignments);
    const current = await fixture.service.getAppliedAssignment(MANAGER, PROJECT);
    assert.equal(current.version?.id, prepared.applied.id); assert.equal(current.head.revision, 1);
    assert.deepEqual(fixture.repository.inspect(), before, "historical reads must not rewrite aggregates");
  });

  test(`${restriction} queued jobs terminate without dispatching a model or publishing a score`, async () => {
    const fixture = harness(); const attempt = await savedAttempt(fixture);
    const job = await fixture.service.submitAttempt(ALICE, attempt.id, attempt.revision, "archive-queued-job");
    if (restriction === "archived") fixture.changeProjectState({ stage: "archived" }); else fixture.readOnly();
    const result = await fixture.service.processScoringJob(job.id);
    assert.equal(result.status, "failed"); assert.equal(result.failureCode, "PROJECT_READ_ONLY");
    assert.equal(fixture.calls.length, 0); assert.equal(fixture.repository.inspect().scores.length, 0);
    const report = await fixture.service.getPrivateReport(ALICE, attempt.id);
    assert.deepEqual(report.attempt.answers, attempt.answers); assert.equal(report.attempt.latestScoreId, null);
    assert.equal(report.attempt.activeJobId, null); assert.equal(report.attempt.status, "scoring_failed");
    assert.equal((await fixture.service.getJob(ALICE, job.id)).status, "failed");
  });

  test(`${restriction} while a model runs prevents publication and preserves the previous score history`, async () => {
    const entered = deferred<void>(); const output = deferred<unknown>(); let runs = 0;
    const fixture = harness({ score: async ({ attempt }) => {
      runs += 1;
      if (runs === 1) return validScoringOutput(attempt);
      entered.resolve(); return output.promise;
    } });
    const attempt = await completedAttempt(fixture);
    const original = await fixture.service.getPrivateReport(ALICE, attempt.id);
    const job = await fixture.service.requestReassessment(ALICE, attempt.id, attempt.revision, "archive-running-job", "重新检查本次证据。");
    const worker = fixture.service.processScoringJob(job.id); await entered.promise;
    if (restriction === "archived") fixture.changeProjectState({ stage: "archived" }); else fixture.readOnly();
    output.resolve(validScoringOutput(attempt));
    const result = await worker;
    assert.equal(result.status, "failed"); assert.equal(result.failureCode, "PROJECT_READ_ONLY"); assert.equal(fixture.calls.length, 2);
    const report = await fixture.service.getPrivateReport(ALICE, attempt.id);
    assert.deepEqual(report.attempt.answers, original.attempt.answers); assert.deepEqual(report.scores, original.scores);
    assert.equal(report.attempt.latestScoreId, original.attempt.latestScoreId); assert.equal(report.attempt.activeJobId, null);
    assert.equal(report.attempt.status, "scoring_failed");
    assert.equal(fixture.repository.inspect().events.filter((event) => event.type === "AssessmentScoringFailed").at(-1)?.payload.failureCode, "PROJECT_READ_ONLY");
  });
}

test("archival after the external permission check is still rejected by each write's transaction-bound snapshot", async () => {
  const prepared = await writableProjectFixture(); const { fixture } = prepared;
  for (const [name, operation] of prepared.writes) {
    fixture.changeProjectState({ stage: "active", readOnly: false });
    const before = fixture.repository.inspect();
    fixture.afterNextMembershipCheck(() => fixture.changeProjectState({ stage: "archived" }));
    await assert.rejects(operation(), projectReadOnly, name);
    assert.deepEqual(fixture.repository.inspect(), before, `${name} must recheck the authoritative project state before writing`);
  }
  assert.equal(prepared.suggestionCalls(), 0);
});

test("reading a read-only project without assignments does not initialize a head", async () => {
  for (const state of [{ stage: "archived" }, { readOnly: true }]) {
    const fixture = harness(); fixture.changeProjectState(state);
    const before = fixture.repository.inspect();
    assert.deepEqual(await fixture.service.getAppliedAssignment(MANAGER, PROJECT), { head: { projectId: PROJECT, versionId: null, revision: 0 }, version: null });
    assert.deepEqual(fixture.repository.inspect(), before);
  }
});

test("archiving during assignment generation rejects the late draft without rewriting history", async () => {
  const entered = deferred<void>(); const output = deferred<unknown>();
  const fixture = harness({ suggestions: { suggest: async () => { entered.resolve(); return output.promise; } } });
  const generation = fixture.service.suggestAssignment(MANAGER, PROJECT, ["最小首页"]);
  await entered.promise;
  fixture.changeProjectState({ stage: "archived" });
  const before = fixture.repository.inspect();
  output.resolve(draft());
  await assert.rejects(generation, projectReadOnly);
  assert.deepEqual(fixture.repository.inspect(), before);
});
