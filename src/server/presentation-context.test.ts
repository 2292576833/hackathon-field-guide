import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Actor } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import { createDatabase } from "./database.ts";
import { createFactAdapters } from "./facts.ts";
import { createPresentationProjectContextPort } from "./presentation-context.ts";
import { ProjectsService, PostgresProjectsRepository, createInvitationTokens } from "../modules/projects/index.ts";
import { EventsService, PostgresEventsRepository } from "../modules/events/index.ts";
import { AssessmentService, PostgresAssessmentRepository, PostgresQuestionCatalog } from "../modules/assessments/index.ts";
import { PlanningService, createPostgresPlanningRepository, type PlanningTask, type ProgressUpdate } from "../modules/planning/index.ts";
import { ResourceService, createPostgresResourceRepository } from "../modules/resources/index.ts";
import { GitService, DeliveryService, GitHubHttpAdapter, PostgresGitRepositoryStore, PostgresDraftStore, PostgresDeliveryStore } from "../modules/github/index.ts";

const at = "2026-10-09T02:00:00.000Z";
const manager: Actor = { userId: "context-manager", platformRoles: ["user"] };
const member: Actor = { userId: "context-member", platformRoles: ["user"] };
const stranger: Actor = { userId: "context-stranger", platformRoles: ["admin"] };
function error(code: string) { return (reason: unknown) => reason instanceof DomainError && reason.code === code; }
function selected(snapshot: { projectId: string; revision: number }) { return { projectId: snapshot.projectId, revision: snapshot.revision }; }
async function fixture() {
  const engine = await createDatabase({});
  try {
    await engine.migrate();
    const statements: string[] = [];
    let transactionExecutor: SqlExecutor | undefined;
    const database: DatabasePort = {
      query(statement, parameters) { statements.push(statement); return engine.query(statement, parameters); },
      transaction: work => engine.transaction(async sql => {
        transactionExecutor = sql;
        return work({ query(statement, parameters) { statements.push(statement); return sql.query(statement, parameters); } });
      }),
    };
    for (const actor of [manager, member, stranger]) await database.query("INSERT INTO auth_users(id,email,display_name,timezone,status,platform_roles,email_verified_at,created_at,revision) VALUES($1,$2,$1,'Asia/Shanghai','active',$3,$4,$4,1)",
      [actor.userId, `${actor.userId}@example.test`, actor.platformRoles, at]);
    const clock = { now: () => new Date(at) }, ids = { next: () => randomUUID() };
    const projectRepository = new PostgresProjectsRepository(database);
    const projects = new ProjectsService({ repository: projectRepository, clock, ids, tokens: createInvitationTokens() });
    const eventsRepository = new PostgresEventsRepository(database), assessmentRepository = new PostgresAssessmentRepository(database);
    const planningRepository = createPostgresPlanningRepository(database);
    const events = new EventsService({ repository: eventsRepository, projectAccess: projectRepository, projectWriteAccess: projectRepository, clock, ids });
    let facts: ReturnType<typeof createFactAdapters>;
    const assessments = new AssessmentService({ repository: assessmentRepository, catalog: new PostgresQuestionCatalog(database), projectAccess: projectRepository, assignmentContext: { getSnapshot: (...args) => facts.assignmentContext.getSnapshot(...args) }, clock, ids });
    const resources = new ResourceService({ repository: createPostgresResourceRepository(database), reviews: { async getApprovedReview() { return null; } }, clock, ids, projectAccess: projectRepository, projectSharing: projects });
    const capabilities = { async getCapabilities() { return { saveRepository: false, verifyDelivery: true, recordSubmission: true }; } };
    const git = new GitService({ access: projectRepository, capabilities,
      credentials: { async getUserCredential() { throw new Error("No external credential in isolated test"); } },
      github: new GitHubHttpAdapter(), store: new PostgresGitRepositoryStore(database), drafts: new PostgresDraftStore(database), clock, ids });
    const deliveryStore = new PostgresDeliveryStore(database);
    const delivery = new DeliveryService({ access: projectRepository, capabilities, store: deliveryStore,
      requirements: { assertConfirmed: input => facts.requirements.assertConfirmed(input) }, clock, ids });
    facts = createFactAdapters({ database, projectRepository, projects, eventsRepository, events, assessmentRepository, assessments, resources, planningRepository, git, delivery });
    const planning = new PlanningService({ repository: planningRepository, access: projectRepository, facts: facts.planningFacts, clock, ids });
    const project = await projects.createProject(manager, { name: "展示来源验收空间", timezone: "Asia/Shanghai", goal: "帮助参赛队伍安排任务", minimumDeliverable: "一份可查看的任务板" });
    const invitation = await projects.createProjectInvitation(manager, project.id, { expectedRevision: project.revision });
    await projects.acceptInvitation(member, invitation.token);
    const port = createPresentationProjectContextPort({ database, projects, planning, delivery, clock, planningFacts: facts.planningFacts });
    async function tasks(items: PlanningTask[], progress: ProgressUpdate[] = []) {
      await planningRepository.transaction(project.id, async (state, tx) => {
        const revision = state.revision;
        state.tasks = structuredClone(items); state.tasksRevision += 1;
        state.progressUpdates = structuredClone(progress); state.revision += 1;
        await tx.save(state, revision);
      });
    }
    return { engine, database, statements, projects, planning, project, port, tasks, delivery, deliveryStore,
      async guard(sql: SqlExecutor) { assert.ok(transactionExecutor); await sql.query("SELECT id FROM auth_users WHERE id=$1", [manager.userId]); } };
  } catch (reason) { await engine.close(); throw reason; }
}
function task(projectId: string, id: string, status: PlanningTask["status"] = "todo"): PlanningTask {
  return { id, projectId, title: `任务 ${id}`, priority: "must", kind: "implementation", ownerMembershipId: null, helperEfforts: [],
    deliverable: `成果 ${id}`, acceptanceCriteria: ["可以演示"], reviewerMembershipId: null,
    durationEstimate: { optimisticMinutes: 10, likelyMinutes: 20, pessimisticMinutes: 30, basis: "测试估计" }, remainingEstimate: null,
    dependencyTaskIds: [], deadlineRef: "project-manual-target", requirementRefs: [], resourceRefs: [], splittable: false,
    contextSwitchMinutes: 0, waitMinutes: 0, status, blocker: null, cancellationReason: null,
    acceptance: status === "done" ? { acceptedByUserId: manager.userId, acceptedAt: at, mode: "manager", evidenceRefs: ["private-evidence-not-exported"], note: "private-acceptance-note" } : null,
    revision: 1, updatedAt: at };
}

test("presentation context reads public module facts for active members and excludes private data", async () => {
  const f = await fixture();
  try {
    await f.tasks([task(f.project.id, "finished", "done"), task(f.project.id, "reviewing", "review"), task(f.project.id, "planned")]);
    const first = await f.port.readSnapshot(member, f.project.id);
    assert.equal(first.projectIdea, "帮助参赛队伍安排任务"); assert.equal(first.targetUsers, ""); assert.equal(first.problem, "");
    assert.equal(first.completed.length, 1); assert.ok(first.completed[0].includes("团队检查通过"));
    assert.ok(first.planned.some(item => item.includes("待检查"))); assert.ok(first.planned.some(item => item.includes("最小交付目标")));
    const body = JSON.stringify(first);
    for (const value of [manager.userId, member.userId, "private-evidence-not-exported", "private-acceptance-note", "platformRoles", "membershipId"])
      assert.ok(!body.includes(value));
    assert.equal((await f.database.query("SELECT * FROM ai_execution_jobs")).rowCount, 0);
    assert.equal((await f.database.query("SELECT * FROM navigator_request_budgets")).rowCount, 0);
  } finally { await f.engine.close(); }
});

test("presentation context rejects outsiders, missing actor, disabled account and archived spaces", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.port.readSnapshot(stranger, f.project.id), reason => reason instanceof DomainError && reason.status === 404);
    await assert.rejects(f.port.readSnapshot({ userId: "", platformRoles: [] }, f.project.id), error("UNAUTHENTICATED"));
    await f.database.query("UPDATE auth_users SET status='suspended' WHERE id=$1", [member.userId]);
    await assert.rejects(f.port.readSnapshot(member, f.project.id), error("UNAUTHENTICATED"));
    const current = await f.projects.getProject(manager, f.project.id);
    await f.projects.transitionStage(manager, f.project.id, { expectedRevision: current.project.revision, stage: "archived", reason: "验收归档" });
    await assert.rejects(f.port.readSnapshot(manager, f.project.id), error("PROJECT_ARCHIVED"));
    await assert.rejects(f.database.transaction(sql => f.port.assertCanGenerate(manager, f.project.id, sql)), error("PROJECT_ARCHIVED"));
  } finally { await f.engine.close(); }
});

test("fresh session guard rejects before recording a facts revision", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.port.readSnapshot(manager, f.project.id, async sql => {
      await sql.query("SELECT id FROM auth_users WHERE id=$1", [manager.userId]);
      throw new DomainError("UNAUTHENTICATED", "原登录会话已失效", { status: 401 });
    }), error("UNAUTHENTICATED"));
    assert.equal((await f.database.query("SELECT * FROM presentation_project_context_versions")).rowCount, 0);
    let checks = 0;
    await f.port.readSnapshot(manager, f.project.id, async sql => { checks++; await f.guard(sql); });
    assert.equal(checks, 2);
  } finally { await f.engine.close(); }
});

test("stable facts reuse one persisted integer revision independently of read time and ordering", async () => {
  const f = await fixture();
  try {
    await f.tasks([task(f.project.id, "a"), task(f.project.id, "b")]);
    const first = await f.port.readSnapshot(manager, f.project.id);
    const second = await f.port.readSnapshot(member, f.project.id);
    assert.equal(first.revision, second.revision);
    assert.equal((await f.database.query("SELECT * FROM presentation_project_context_versions")).rowCount, 1);
    await f.database.transaction(sql => f.port.assertCurrent(manager, selected(first), sql));
    const rootIndex = f.statements.findIndex(statement => statement.includes("pg_advisory_xact_lock") && statement.includes("hashtextextended"));
    const shareIndex = f.statements.findIndex(statement => statement.startsWith("LOCK TABLE m06_delivery"));
    assert.ok(rootIndex >= 0 && shareIndex > rootIndex);
    assert.ok(f.statements.some(statement => statement.includes("projects_project") && statement.includes("FOR UPDATE")));
  } finally { await f.engine.close(); }
});

test("task changes alter the composite revision while project revision stays unchanged", async () => {
  const f = await fixture();
  try {
    const pending = task(f.project.id, "task"); await f.tasks([pending]);
    const first = await f.port.readSnapshot(manager, f.project.id);
    const projectRevision = (await f.projects.getProject(manager, f.project.id)).project.revision;
    await f.tasks([{ ...task(f.project.id, "task", "done"), revision: 2 }]);
    assert.equal((await f.projects.getProject(manager, f.project.id)).project.revision, projectRevision);
    await assert.rejects(f.database.transaction(sql => f.port.assertCurrent(manager, selected(first), sql)), error("PROJECT_CONTEXT_CHANGED"));
    const second = await f.port.readSnapshot(manager, f.project.id);
    assert.equal(second.revision, first.revision + 1); assert.equal(first.completed.length, 0); assert.equal(second.completed.length, 1);
    const outdated = await f.database.transaction(async sql => {
      try { await f.port.assertCurrent(manager, selected(first), sql); } catch (reason) { return reason; }
    });
    assert.ok(outdated instanceof DomainError); assert.equal(outdated.latestRevision, second.revision);
    await f.database.transaction(sql => f.port.assertCanGenerate(manager, f.project.id, sql));
  } finally { await f.engine.close(); }
});

test("progress history and delivery facts change the composite revision without promoting saved plans to completion", async () => {
  const f = await fixture();
  try {
    const pending = task(f.project.id, "task"); await f.tasks([pending]);
    const first = await f.port.readSnapshot(manager, f.project.id);
    const progress: ProgressUpdate = { id: "progress", projectId: f.project.id, taskId: pending.id, actorId: manager.userId,
      status: "todo", remainingEstimate: null, blocker: null, evidenceRefs: [], note: "private-progress-note", correctionOf: null,
      correctionReason: null, acceptance: null, createdAt: at };
    await f.tasks([pending], [progress]);
    const second = await f.port.readSnapshot(manager, f.project.id); assert.equal(second.revision, first.revision + 1);
    await f.delivery.recordVerification(manager, f.project.id, { verifiedAt: at, environmentSummary: "本机测试", steps: ["启动"], outcome: "passed", blockers: [], evidenceRefs: ["secret-evidence-url"], repositoryCommitSha: "a".repeat(40) });
    const third = await f.port.readSnapshot(manager, f.project.id);
    assert.equal(third.revision, second.revision + 1); assert.equal(third.completed.length, 0);
    assert.ok(third.evidence.some(item => item.includes("队员自报运行核验"))); assert.ok(third.evidence.some(item => item.includes("不证明当前代码已运行")));
    assert.ok(!JSON.stringify(third).includes("secret-evidence-url")); assert.ok(!JSON.stringify(third).includes("private-progress-note"));
    await assert.rejects(f.database.transaction(sql => f.port.assertCurrent(manager, selected(second), sql)), error("PROJECT_CONTEXT_CHANGED"));
  } finally { await f.engine.close(); }
});

test("latest submission version preserves withdrawn status instead of reviving reported history", async () => {
  const f = await fixture();
  try {
    const record = { id: "submission", projectId: f.project.id, eventId: "event", stageId: "stage", requirementsVersion: "rules:1",
      platformUrl: "https://example.test/submit", submittedAt: at, verificationSource: "user_reported" as const, repositoryCommitSha: null,
      status: "reported" as const, evidenceRefs: ["private-submission-evidence"], recordedBy: manager.userId, recordedAt: at, version: 1 };
    await f.deliveryStore.insertSubmission(record);
    const first = await f.port.readSnapshot(manager, f.project.id);
    assert.ok(first.evidence.some(item => item.includes("队员自报已提交"))); assert.equal(first.completed.length, 0);
    await f.deliveryStore.updateSubmission({ ...record, version: 2, status: "rejected_or_withdrawn" }, 1);
    const second = await f.port.readSnapshot(manager, f.project.id);
    assert.equal(second.revision, first.revision + 1); assert.ok(second.evidence.some(item => item.includes("拒绝或撤回")));
    assert.ok(!second.evidence.some(item => item.includes("自报已提交")));
  } finally { await f.engine.close(); }
});

test("lost membership prevents new generation but a captured snapshot remains an immutable value", async () => {
  const f = await fixture();
  try {
    const first = await f.port.readSnapshot(member, f.project.id), copied = JSON.stringify(first);
    const current = await f.projects.getProject(manager, f.project.id);
    await f.projects.removeProjectMember(manager, f.project.id, member.userId, current.project.revision);
    await assert.rejects(f.database.transaction(sql => f.port.assertCurrent(member, selected(first), sql)), reason => reason instanceof DomainError && reason.status === 404);
    await assert.rejects(f.database.transaction(sql => f.port.assertCanGenerate(member, f.project.id, sql)), reason => reason instanceof DomainError && reason.status === 404);
    assert.equal(JSON.stringify(first), copied);
  } finally { await f.engine.close(); }
});

test("bounded snapshot reports recoverable overflow rather than truncating tasks or project text", async () => {
  const f = await fixture();
  try {
    await f.tasks(Array.from({ length: 13 }, (_value, index) => task(f.project.id, `task-${index}`)));
    await assert.rejects(f.port.readSnapshot(manager, f.project.id), reason => reason instanceof DomainError && reason.code === "PROJECT_SOURCE_INVALID" && reason.recoveryAction === "choose_materials_manually");
    assert.equal((await f.database.query("SELECT * FROM presentation_project_context_versions")).rowCount, 0);
    await f.tasks([]);
    const current = await f.projects.getProject(manager, f.project.id);
    await f.projects.editProject(manager, f.project.id, { expectedRevision: current.project.revision, goal: "长".repeat(2001) });
    await assert.rejects(f.port.readSnapshot(manager, f.project.id), error("PROJECT_SOURCE_INVALID"));
  } finally { await f.engine.close(); }
});

test("concurrent bounded reads register one revision on the same in-memory engine", async () => {
  const f = await fixture();
  try {
    const snapshots = await Promise.all([manager, member, manager].map(actor => f.port.readSnapshot(actor, f.project.id)));
    assert.ok(snapshots.every(item => item.revision === snapshots[0].revision));
    assert.equal((await f.database.query("SELECT * FROM presentation_project_context_versions")).rowCount, 1);
    // PGlite serializes the transaction queue. This verifies one-executor
    // composition but does not replace separate PostgreSQL-client lock tests.
  } finally { await f.engine.close(); }
});
