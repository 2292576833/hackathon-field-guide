import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "./database.ts";
import { createApplication, type Application } from "./application.ts";
import { dispatch } from "./router.ts";
import type { Project, ProjectMember } from "../modules/projects/index.ts";
import type { AssignmentVersion } from "../modules/assessments/index.ts";
import { assertPublishable, validateRuleVersion, type ProjectRuleConfirmation } from "../modules/events/index.ts";
import type { DraftCommand, PlanningInput, PlanVersion, PlanningTask, ProgressUpdate, TaskProposal } from "../modules/planning/index.ts";
import type { DeliveryVerification, RecordSubmissionInput, SubmissionRecord } from "../modules/github/index.ts";
import type { Retrospective } from "../modules/retrospectives/index.ts";

const origin = "http://localhost:3000";
async function fixture() {
  // No localPath: every test uses an independent, real in-memory PGlite database.
  const database = await createDatabase({});
  const app = await createApplication({ mode: "local", origin, codePepper: "guards-tests-only-pepper-at-least-32bytes", emailFrom: "test@localhost.invalid" }, database);
  return { app, database };
}
async function request<T>(app: Application, path: string, method = "GET", body?: unknown, cookie?: string, expectedStatus = 200) {
  const headers = new Headers({ origin, "content-type": "application/json" });
  if (cookie) headers.set("cookie", cookie);
  const response = await dispatch(app, new Request(`${origin}/api/v1/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), path.split("/"));
  const envelope = await response.json() as { data: T; error?: { code: string; message: string } };
  // Do not include request bodies: verification codes and cookies must never enter diagnostics.
  assert.equal(response.status, expectedStatus, `${method} ${path}: ${envelope.error?.code ?? "unexpected status"} ${envelope.error?.message ?? ""}`);
  return { data: envelope.data, error: envelope.error, response };
}
async function login(app: Application) {
  const email = "guards-manager@example.test";
  const challenge = (await request<{ challengeId: string }>(app, "auth/login-challenges", "POST", { email })).data;
  const mail = await app.database.query<{ body: string }>("SELECT body FROM development_mailbox WHERE recipient=$1 ORDER BY created_at DESC LIMIT 1", [email]);
  const code = mail.rows[0]?.body.match(/\b\d{8}\b/)?.[0];
  assert.ok(code, "development email transport supplied the verification challenge");
  const verified = await request(app, "auth/login-challenges/verify", "POST", { challengeId: challenge.challengeId, code });
  const cookie = verified.response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie, "the real login endpoint issued a session cookie");
  return cookie;
}
async function seedPublishedEvent(app: Application, now: number) {
  // Explicit M03 owned-store fixture; this is not an M08 publication workflow test.
  // Its valid official snapshot is stored through the real repository and SQL constraints.
  const eventId = "application-guards-event";
  const createdAt = new Date(now).toISOString();
  const deadline = new Date(now + 96 * 60 * 60_000).toISOString();
  const rules = validateRuleVersion({
    eventId, version: 1, createdAt,
    metadata: { name: "集成回归赛事夹具", organizer: "测试组织者", format: "online", region: "online", officialUrl: "https://event.example.test/rules" },
    sources: [{ id: "official-source", eventId, version: 1, sourceConfigId: null, url: "https://event.example.test/rules", kind: "official", contentHash: "a".repeat(64), fetchedAt: createdAt, trustScope: "official_rules", status: "available" }],
    evidence: [
      { id: "deadline-evidence", eventId, version: 1, sourceId: "official-source", fieldKey: "stages.submission.endsAt", excerpt: `提交截止 ${deadline}`, locator: "#deadline", rawDateText: deadline, verifiedBy: "fixture-reviewer", verifiedAt: createdAt, conflictsWith: [] },
      { id: "material-evidence", eventId, version: 1, sourceId: "official-source", fieldKey: "requirements.repository", excerpt: "必须提供作品仓库", locator: "#materials", rawDateText: null, verifiedBy: "fixture-reviewer", verifiedAt: createdAt, conflictsWith: [] },
    ],
    facts: ["eligibility", "fees", "team_size", "ai_policy"].map(key => ({ key, statement: "测试夹具保留未知项", status: "unknown", evidenceIds: [] })),
    stages: [{ id: "submission", stageType: "submission", name: "作品提交", startsAt: null, endsAt: { rawText: deadline, timeZone: "UTC", utc: deadline, dateOnly: false, evidenceIds: ["deadline-evidence"] }, submissionUrl: "https://event.example.test/submit" }],
    requirements: [{ id: "repository", label: "作品仓库", necessity: "required", stageId: "submission", evidenceIds: ["material-evidence"] }],
    qualityFlags: ["missing_information"],
  });
  assertPublishable(rules);
  await app.eventsRepository.transaction(async unit => {
    await unit.saveEvent({ id: eventId, revision: 1, publicationStatus: "published", candidateVersion: 1, publishedVersion: 1, lastVerifiedAt: createdAt }, 0);
    await unit.insertRules(rules);
  });
  return eventId;
}
const retrospectiveContent = {
  answers: { goalAndOutcome: "完成最小作品", blockerAndResponse: "收缩范围", helpfulPractice: "先明确交付物", scopeReduction: "移除附加功能", nextChange: "提前验证环境" }, evidenceRefs: [], tools: [],
};
const verificationInput = () => ({ verifiedAt: new Date(Date.now() - 1000).toISOString(), environmentSummary: "本地浏览器", steps: ["打开作品并完成核心操作"], outcome: "passed", blockers: [], evidenceRefs: ["https://event.example.test/run-evidence"] });
function submissionInput(eventId: string, requirementsVersion: string): RecordSubmissionInput {
  return { eventId, stageId: "submission", requirementsVersion, platformUrl: "https://event.example.test/submit", submittedAt: new Date(Date.now() - 1000).toISOString(), status: "reported", evidenceRefs: ["https://event.example.test/submission-evidence"] };
}
async function preparedProject(app: Application, cookie: string) {
  const now = Date.now();
  const eventId = await seedPublishedEvent(app, now);
  const project = (await request<Project>(app, "projects", "POST", { name: "跨模块权限回归", goal: "完成一个可交付作品", minimumDeliverable: "能够完成主要流程", timezone: "UTC", deadline: new Date(now + 72 * 60 * 60_000).toISOString() }, cookie, 201)).data;
  const detail = (await request<{ project: Project; membership: ProjectMember }>(app, `projects/${project.id}`, "GET", undefined, cookie)).data;
  await request(app, `projects/${project.id}/my-availability`, "PUT", { expectedRevision: 0, timezone: "UTC", windows: [{ id: "work-window", startsAt: new Date(now + 60 * 60_000).toISOString(), endsAt: new Date(now + 5 * 60 * 60_000).toISOString(), effectiveMinutes: 240 }] }, cookie);
  const confirmation = (await request<ProjectRuleConfirmation>(app, `projects/${project.id}/rules/confirm`, "POST", { eventId, rulesVersion: 1, expectedRevision: 0 }, cookie)).data;
  const facts = (await request<PlanningInput>(app, `projects/${project.id}/planning-input`, "GET", undefined, cookie)).data;
  assert.equal(facts.requirementVersionId, `${eventId}:1:${confirmation.revision}`);
  assert.equal(facts.deadlines.find(item => item.id === "submission")?.verified, true);
  const tasks: TaskProposal[] = ["implementation" as const, ...facts.requiredTaskKinds].map((kind, index) => ({
    id: `guard-task-${index}`, projectId: project.id, title: `${kind}工作`, priority: "must", kind, ownerMembershipId: detail.membership.membershipId, helperEfforts: [],
    deliverable: "可复现的交付物", acceptanceCriteria: ["可以按照步骤复现"], reviewerMembershipId: null,
    durationEstimate: { optimisticMinutes: 5, likelyMinutes: 10, pessimisticMinutes: 15, basis: "本人估时" },
    dependencyTaskIds: index === 0 ? [] : [`guard-task-${index - 1}`], deadlineRef: "submission", requirementRefs: index === 0 ? ["repository"] : [], resourceRefs: [], splittable: false, contextSwitchMinutes: 0, waitMinutes: 0,
  }));
  const command: DraftCommand = { tasks, buffers: facts.deadlines.map(item => ({ deadlineId: item.id, reservedMinutes: 20, basis: "预留提交时间" })), reason: "首次人工计划", expectedTasksRevision: 0, basePlanVersionId: null, idempotencyKey: "initial-plan" };
  const plan = (await request<PlanVersion>(app, `projects/${project.id}/plan-versions`, "POST", command, cookie, 201)).data;
  assert.equal(plan.status, "ready", JSON.stringify(plan.validation?.issues));
  const applied = (await request<PlanVersion>(app, `projects/${project.id}/plan-versions/${plan.id}/apply`, "POST", { expectedRevision: plan.revision, acknowledgedIssueCodes: [...new Set(plan.validation!.issues.map(item => item.code))], idempotencyKey: "initial-plan-apply" }, cookie)).data;
  assert.equal(applied.status, "applied");
  return { project, eventId, confirmation, facts, command, plan: applied, membership: detail.membership };
}
async function storedSnapshot(app: Application, projectId: string) {
  // Compare persisted histories, heads and transactional outboxes after denied writes.
  const results = await Promise.all([
    app.eventsRepository.getConfirmation(projectId),
    app.database.query("SELECT project_id,version_id,revision FROM assessments_assignment_heads WHERE project_id=$1", [projectId]),
    app.database.query("SELECT id,revision,status FROM assessments_assignment_versions WHERE project_id=$1 ORDER BY id", [projectId]),
    app.planningRepository.read(projectId),
    app.database.query("SELECT id,version FROM m06_delivery_verifications WHERE project_id=$1 ORDER BY id,version", [projectId]),
    app.database.query("SELECT id,version FROM m06_submission_heads WHERE project_id=$1 ORDER BY id", [projectId]),
    app.database.query("SELECT id,version,status FROM m06_submission_versions WHERE project_id=$1 ORDER BY id,version", [projectId]),
    app.database.query("SELECT id,revision FROM m07_documents WHERE project_id=$1 ORDER BY id", [projectId]),
    app.database.query("SELECT id FROM m06_delivery_fact_events WHERE project_id=$1 ORDER BY id", [projectId]),
  ]);
  return results.map(result => result && "rows" in result ? result.rows : result);
}

test("archived project rejects M03-M07 mutations through real HTTP while histories remain readable", async () => {
  const { app, database } = await fixture();
  try {
    const cookie = await login(app);
    const prepared = await preparedProject(app, cookie);
    const { project, eventId, confirmation, command, membership } = prepared;
    const assignmentCommand = { baseVersionId: null, draft: { assignments: [{ clientTaskId: "manual-work", title: "最小作品", priority: "must", ownerMembershipId: membership.membershipId, helperMembershipIds: [], deliverable: "可运行作品", acceptanceCriteria: ["可复现主要流程"], dependencyTaskIds: [], proposedDeadlineRef: "submission", reason: "本人确认", evidenceLevel: "self_reported" }], gaps: [], assumptions: ["人工分工"] } };
    const assignment = (await request<AssignmentVersion>(app, `projects/${project.id}/assignment-versions`, "POST", assignmentCommand, cookie, 201)).data;
    let current = (await request<{ tasks: PlanningTask[]; tasksRevision: number }>(app, `projects/${project.id}/plans/current`, "GET", undefined, cookie)).data;
    let task = current.tasks[0]!;
    const progress = (await request<ProgressUpdate>(app, `projects/${project.id}/tasks/${task.id}/progress`, "POST", { expectedRevision: task.revision, status: "in_progress", remainingEstimate: null, blocker: null, evidenceRefs: [], note: "归档前开工", idempotencyKey: "before-archive-progress" }, cookie, 201)).data;
    const verification = (await request<DeliveryVerification>(app, `projects/${project.id}/delivery-verifications`, "POST", verificationInput(), cookie, 201)).data;
    const submitted = (await request<SubmissionRecord>(app, `projects/${project.id}/submission-records`, "POST", submissionInput(eventId, prepared.facts.requirementVersionId!), cookie, 201)).data;
    const retrospective = (await request<Retrospective>(app, `projects/${project.id}/retrospectives`, "POST", { scope: "personal", content: retrospectiveContent }, cookie, 201)).data;
    const confirmed = (await request<Retrospective>(app, `retrospectives/${retrospective.id}/confirm`, "POST", { expectedRevision: retrospective.revision }, cookie)).data;
    assert.equal(confirmed.status, "confirmed");
    const detail = (await request<{ project: Project }>(app, `projects/${project.id}`, "GET", undefined, cookie)).data;
    const archived = (await request<Project>(app, `projects/${project.id}/stage`, "POST", { expectedRevision: detail.project.revision, stage: "archived", reason: "归档回归" }, cookie)).data;
    assert.equal(archived.stage, "archived");
    const snapshot = await storedSnapshot(app, project.id);
    const rulesRejection = await request(app, `projects/${project.id}/rules/confirm`, "POST", { eventId, rulesVersion: 1, expectedRevision: confirmation.revision }, cookie, 409);
    assert.equal(rulesRejection.error?.code, "PROJECT_READ_ONLY");
    const assignmentRejection = await request(app, `projects/${project.id}/assignment-versions`, "POST", assignmentCommand, cookie, 409);
    assert.equal(assignmentRejection.error?.code, "PROJECT_READ_ONLY");
    current = (await request<{ tasks: PlanningTask[]; tasksRevision: number }>(app, `projects/${project.id}/plans/current`, "GET", undefined, cookie)).data;
    task = current.tasks.find(item => item.id === task.id)!;
    const planRejection = await request(app, `projects/${project.id}/plan-versions`, "POST", { ...command, expectedTasksRevision: current.tasksRevision, basePlanVersionId: prepared.plan.id, idempotencyKey: "after-archive-plan" }, cookie, 409);
    assert.equal(planRejection.error?.code, "PROJECT_READ_ONLY");
    const progressRejection = await request(app, `projects/${project.id}/tasks/${task.id}/progress`, "POST", { expectedRevision: task.revision, status: "blocked", remainingEstimate: null, blocker: "归档后不能变更", evidenceRefs: [], note: "归档后更新", idempotencyKey: "after-archive-progress" }, cookie, 409);
    assert.equal(progressRejection.error?.code, "PROJECT_READ_ONLY");
    for (const [path, method, body] of [
      [`projects/${project.id}/delivery-verifications`, "POST", verificationInput()],
      [`projects/${project.id}/submission-records`, "POST", submissionInput(eventId, prepared.facts.requirementVersionId!)],
      [`projects/${project.id}/submission-records/${submitted.id}`, "PATCH", { ...submissionInput(eventId, prepared.facts.requirementVersionId!), expectedVersion: submitted.version, status: "rejected_or_withdrawn", submittedAt: null }],
    ] as const) {
      const rejection = await request(app, path, method, body, cookie, 403);
      assert.equal(rejection.error?.code, "DELIVERY_CAPABILITY_DENIED");
    }
    const retrospectiveRejection = await request(app, `projects/${project.id}/retrospectives`, "POST", { scope: "personal", content: retrospectiveContent }, cookie, 409);
    assert.equal(retrospectiveRejection.error?.code, "PROJECT_ARCHIVED");
    assert.deepEqual(await storedSnapshot(app, project.id), snapshot, "denied mutations must not alter persisted histories, heads or delivery outbox");
    const historicalRules = (await request<{ confirmation: ProjectRuleConfirmation }>(app, `projects/${project.id}/rules`, "GET", undefined, cookie)).data;
    assert.equal(historicalRules.confirmation.revision, confirmation.revision);
    assert.equal((await request<AssignmentVersion>(app, `assignment-versions/${assignment.id}`, "GET", undefined, cookie)).data.id, assignment.id);
    assert.equal((await request<PlanVersion[]>(app, `projects/${project.id}/plan-versions`, "GET", undefined, cookie)).data[0]?.id, prepared.plan.id);
    assert.equal((await request<ProgressUpdate[]>(app, `projects/${project.id}/progress`, "GET", undefined, cookie)).data[0]?.id, progress.id);
    assert.equal((await request<DeliveryVerification[]>(app, `projects/${project.id}/delivery-verifications`, "GET", undefined, cookie)).data[0]?.id, verification.id);
    assert.equal((await request<SubmissionRecord[]>(app, `projects/${project.id}/submission-records`, "GET", undefined, cookie)).data[0]?.id, submitted.id);
    const historicalRetrospective = (await request<{ id: string; document: Retrospective | null }>(app, `retrospectives/${retrospective.id}`, "GET", undefined, cookie)).data;
    assert.equal(historicalRetrospective.document?.id, retrospective.id);
    assert.equal(historicalRetrospective.document?.status, "confirmed");
  } finally { await database.close(); }
});

test("M02 submitted stage uses the latest M06 version, so withdrawn reported history cannot satisfy it", async () => {
  const { app, database } = await fixture();
  try {
    const cookie = await login(app);
    const { project, eventId, facts } = await preparedProject(app, cookie);
    let current = (await request<{ project: Project }>(app, `projects/${project.id}`, "GET", undefined, cookie)).data.project;
    for (const stage of ["preparing", "active", "finalizing"] as const) current = (await request<Project>(app, `projects/${project.id}/stage`, "POST", { expectedRevision: current.revision, stage, reason: "提交阶段回归" }, cookie)).data;
    const input = submissionInput(eventId, facts.requirementVersionId!);
    const reported = (await request<SubmissionRecord>(app, `projects/${project.id}/submission-records`, "POST", input, cookie, 201)).data;
    const withdrawn = (await request<SubmissionRecord>(app, `projects/${project.id}/submission-records/${reported.id}`, "PATCH", { ...input, expectedVersion: reported.version, status: "rejected_or_withdrawn", submittedAt: null, evidenceRefs: ["https://event.example.test/withdrawal-evidence"] }, cookie)).data;
    assert.equal(withdrawn.id, reported.id);
    assert.equal(withdrawn.version, reported.version + 1);
    const history = (await request<SubmissionRecord[]>(app, `projects/${project.id}/submission-records`, "GET", undefined, cookie)).data.filter(record => record.id === reported.id).sort((left, right) => left.version - right.version);
    assert.deepEqual(history.map(record => [record.version, record.status]), [[1, "reported"], [2, "rejected_or_withdrawn"]]);
    const blocked = await request(app, `projects/${project.id}/stage`, "POST", { expectedRevision: current.revision, stage: "submitted", reason: "旧自报记录不能替代当前状态" }, cookie, 422);
    assert.equal(blocked.error?.code, "SUBMISSION_RECORD_REQUIRED");
    const after = (await request<{ project: Project }>(app, `projects/${project.id}`, "GET", undefined, cookie)).data.project;
    assert.equal(after.stage, "finalizing");
    assert.equal(after.revision, current.revision);
    // Positive control: a new reported version of the same record enables the same transition.
    const restored = (await request<SubmissionRecord>(app, `projects/${project.id}/submission-records/${reported.id}`, "PATCH", { ...submissionInput(eventId, facts.requirementVersionId!), expectedVersion: withdrawn.version }, cookie)).data;
    assert.equal(restored.version, 3);
    const completed = (await request<Project>(app, `projects/${project.id}/stage`, "POST", { expectedRevision: after.revision, stage: "submitted", reason: "当前自报提交状态已恢复" }, cookie)).data;
    assert.equal(completed.stage, "submitted");
  } finally { await database.close(); }
});

test("M06 requires the exact current M03 confirmation version, stage and official platform through HTTP", async () => {
  const { app, database } = await fixture();
  try {
    const cookie = await login(app);
    const { project, eventId, confirmation, facts } = await preparedProject(app, cookie);
    const input = submissionInput(eventId, facts.requirementVersionId!);
    const before = await storedSnapshot(app, project.id);
    for (const [overrides, status, code] of [
      [{ requirementsVersion: "1" }, 409, "REQUIREMENTS_NOT_CONFIRMED"],
      [{ requirementsVersion: `${eventId}:1:999` }, 409, "REQUIREMENTS_NOT_CONFIRMED"],
      [{ eventId: "another-event" }, 409, "REQUIREMENTS_NOT_CONFIRMED"],
      [{ stageId: "another-stage" }, 422, "SUBMISSION_STAGE_UNCONFIRMED"],
      [{ platformUrl: "https://untrusted.example.test/submit" }, 422, "SUBMISSION_PLATFORM_MISMATCH"],
    ] as const) {
      const blocked = await request(app, `projects/${project.id}/submission-records`, "POST", { ...input, ...overrides }, cookie, status);
      assert.equal(blocked.error?.code, code);
    }
    assert.deepEqual(await storedSnapshot(app, project.id), before, "invalid confirmed-rule references create no facts or outbox events");
    const record = (await request<SubmissionRecord>(app, `projects/${project.id}/submission-records`, "POST", input, cookie, 201)).data;
    // Reconfirming the same rules changes the confirmation revision, not the rules version.
    const next = (await request<ProjectRuleConfirmation>(app, `projects/${project.id}/rules/confirm`, "POST", { eventId, rulesVersion: 1, expectedRevision: confirmation.revision }, cookie)).data;
    assert.equal(next.rulesVersion, confirmation.rulesVersion);
    assert.equal(next.revision, confirmation.revision + 1);
    const beforeStale = await storedSnapshot(app, project.id);
    const staleCreate = await request(app, `projects/${project.id}/submission-records`, "POST", input, cookie, 409);
    assert.equal(staleCreate.error?.code, "REQUIREMENTS_NOT_CONFIRMED");
    const staleUpdate = await request(app, `projects/${project.id}/submission-records/${record.id}`, "PATCH", { ...input, expectedVersion: record.version }, cookie, 409);
    assert.equal(staleUpdate.error?.code, "REQUIREMENTS_NOT_CONFIRMED");
    assert.deepEqual(await storedSnapshot(app, project.id), beforeStale, "stale create/update cannot change submission history or heads");
    const fresh = (await request<PlanningInput>(app, `projects/${project.id}/planning-input`, "GET", undefined, cookie)).data;
    assert.equal(fresh.requirementVersionId, `${eventId}:1:${next.revision}`);
    const updated = (await request<SubmissionRecord>(app, `projects/${project.id}/submission-records/${record.id}`, "PATCH", { ...submissionInput(eventId, fresh.requirementVersionId!), expectedVersion: record.version }, cookie)).data;
    assert.equal(updated.requirementsVersion, fresh.requirementVersionId);
    assert.equal(updated.version, record.version + 1);
  } finally { await database.close(); }
});
