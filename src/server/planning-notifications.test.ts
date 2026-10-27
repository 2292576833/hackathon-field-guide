import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Actor } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import { assertPublishable, validateRuleVersion } from "../modules/events/index.ts";
import type { PlanningInput, ProgressCommand, TaskProposal } from "../modules/planning/index.ts";
import { createApplication } from "./application.ts";
import { createDatabase } from "./database.ts";
import { createPlanningNotifications, type PlanningNotificationsRootDependencies } from "./planning-notifications.ts";

const alice: Actor = { userId: "notification-alice", platformRoles: ["user"] };
const bob: Actor = { userId: "notification-bob", platformRoles: ["user"] };
const carol: Actor = { userId: "notification-carol", platformRoles: ["user"] };
const dan: Actor = { userId: "notification-dan", platformRoles: ["user"] };
const outsiders: Actor = { userId: "notification-outsider", platformRoles: ["user"] };
const started = Date.parse("2026-10-10T08:00:00.000Z");

async function fixture() {
  // Real root migrations and services, isolated PGlite with no localPath/env,
  // network, model, running worker, or actual mail transport invocation.
  const database = await createDatabase({});
  let app: Awaited<ReturnType<typeof createApplication>>;
  try { app = await createApplication({ mode: "local", origin: "http://localhost:3000", codePepper: "notifications-isolated-pepper-not-a-secret", emailFrom: "test@example.test" }, database); }
  catch (error) { await database.close(); throw error; }
  let time = started;
  app.clock.now = () => new Date(time);
  for (const actor of [alice, bob, carol, dan, outsiders]) {
    await database.query("INSERT INTO auth_users(id,email,display_name,timezone,platform_roles,email_verified_at,created_at) VALUES($1,$2,$1,'UTC',$3,$4,$4)", [actor.userId, `${actor.userId}@example.test`, actor.platformRoles, new Date(time).toISOString()]);
  }
  const trace: { statement: string; executor: SqlExecutor | null }[] = [];
  const instrumented: DatabasePort = {
    async query<Row>(statement: string, parameters?: readonly unknown[]) { trace.push({ statement, executor: null }); return database.query<Row>(statement, parameters); },
    async transaction(work) { return database.transaction(sql => {
      const wrapper: SqlExecutor = { async query<Row>(statement: string, parameters?: readonly unknown[]) { trace.push({ statement, executor: wrapper }); return sql.query<Row>(statement, parameters); } };
      return work(wrapper);
    }); },
  };
  const options: PlanningNotificationsRootDependencies = { database: instrumented, planning: app.planning, projects: app.projects,
    readInput: (id, now, actor, sql) => app.facts.readInputForNotifications(id, now, actor, sql), resources: app.resources, clock: app.clock, ids: app.ids };
  const notifications = createPlanningNotifications(options);

  async function project(memberActors: readonly Actor[] = []) {
    const created = await app.projects.createProject(alice, { name: "真实任务提醒练习", goal: "做一个可以演示的原型", timezone: "UTC" });
    for (const member of memberActors) {
      const detail = await app.projects.getProject(alice, created.id);
      const invitation = await app.projects.createProjectInvitation(alice, created.id, { expectedRevision: detail.project.revision, role: "member", maxUses: 1, expiresAt: new Date(started + 86_400_000).toISOString() });
      await app.projects.acceptInvitation(member, invitation.token);
    }
    return created;
  }
  async function plan(memberActors: readonly Actor[] = [], workOwner: Actor = alice) {
    const created = await project(memberActors);
    const detail = await app.projects.getProject(workOwner, created.id);
    await app.projects.updateMyAvailability(workOwner, created.id, { expectedRevision: 0, timezone: "UTC", windows: [{ id: "work", startsAt: new Date(started + 3_600_000).toISOString(), endsAt: new Date(started + 5 * 3_600_000).toISOString(), effectiveMinutes: 240 }] });
    const eventId = randomUUID(), deadline = new Date(started + 96 * 3_600_000).toISOString();
    const rules = validateRuleVersion({ eventId, version: 1, createdAt: new Date(started).toISOString(),
      metadata: { name: "提醒集成测试赛事", organizer: "测试组织者", format: "online", region: "online", officialUrl: "https://event.example.test/rules" },
      sources: [{ id: "source", eventId, version: 1, sourceConfigId: null, url: "https://event.example.test/rules", kind: "official", contentHash: "a".repeat(64), fetchedAt: new Date(started).toISOString(), trustScope: "official_rules", status: "available" }],
      evidence: [{ id: "deadline", eventId, version: 1, sourceId: "source", fieldKey: "stages.submission.endsAt", excerpt: deadline, locator: "#deadline", rawDateText: deadline, verifiedBy: "fixture-reviewer", verifiedAt: new Date(started).toISOString(), conflictsWith: [] }],
      facts: ["eligibility", "fees", "team_size", "ai_policy"].map(key => ({ key, statement: "测试保留未知项", status: "unknown", evidenceIds: [] })),
      stages: [{ id: "submission", stageType: "submission", name: "作品提交", startsAt: null, endsAt: { rawText: deadline, timeZone: "UTC", utc: deadline, dateOnly: false, evidenceIds: ["deadline"] }, submissionUrl: "https://event.example.test/submit" }], requirements: [], qualityFlags: ["missing_information"],
    });
    assertPublishable(rules);
    await app.eventsRepository.transaction(async tx => { await tx.saveEvent({ id: eventId, revision: 1, publicationStatus: "published", candidateVersion: 1, publishedVersion: 1, lastVerifiedAt: new Date(started).toISOString() }, 0); await tx.insertRules(rules); });
    await app.events.confirmProjectRules(alice, created.id, eventId, 1, 0);
    const input = await app.facts.planningFacts.readInput(created.id, app.clock.now().toISOString(), alice);
    const tasks: TaskProposal[] = ["implementation" as const, ...input.requiredTaskKinds].map((kind, index) => ({
      id: `task-${index}`, projectId: created.id, title: `${kind}任务`, priority: "must", kind, ownerMembershipId: detail.membership.membershipId,
      helperEfforts: [], deliverable: "可以复现的成果", acceptanceCriteria: ["核心操作可运行"], reviewerMembershipId: null,
      durationEstimate: { optimisticMinutes: 5, likelyMinutes: 10, pessimisticMinutes: 15, basis: "本人估算" }, dependencyTaskIds: index ? [`task-${index - 1}`] : [],
      deadlineRef: "submission", requirementRefs: [], resourceRefs: [], splittable: false, contextSwitchMinutes: 0, waitMinutes: 0,
    }));
    const draft = await app.planning.createDraft(alice, created.id, { tasks, buffers: [{ deadlineId: "submission", reservedMinutes: 20, basis: "预留提交缓冲" }], reason: "第一次手动计划", expectedTasksRevision: 0, basePlanVersionId: null, idempotencyKey: randomUUID() });
    assert.equal(draft.status, "ready", JSON.stringify(draft.validation?.issues));
    const applied = await app.planning.apply(alice, created.id, draft.id, { expectedRevision: draft.revision, acknowledgedIssueCodes: [...new Set(draft.validation!.issues.map(issue => issue.code))], idempotencyKey: randomUUID() });
    return { project: created, plan: applied, input, eventId, rules };
  }
  async function progress(id: string, status: ProgressCommand["status"], taskId = "task-0") {
    const current = await app.planning.getCurrent(alice, id), task = current.tasks.find(item => item.id === taskId)!;
    return app.planning.updateProgress(alice, id, taskId, { expectedRevision: task.revision, status, remainingEstimate: null, blocker: status === "blocked" ? "环境还需要队友协助" : null,
      evidenceRefs: status === "done" ? ["https://event.example.test/evidence"] : [], note: "真实服务记录的成果和进度", idempotencyKey: randomUUID() });
  }
  return { app, database, trace, options, notifications, project, plan, progress, setTime: (next: number) => { time = next; } };
}

test("own reads use planning/head/project/account lock order without initializing missing heads or plan state", async () => {
  const f = await fixture();
  try {
    const p = await f.project();
    assert.deepEqual(await f.notifications.service.listOwn(alice, { projectId: p.id }), []);
    await f.options.database.transaction(async sql => {
      await f.notifications.projects.lockProject(p.id, sql);
      await f.notifications.projects.lockProject(p.id, sql);
    });
    assert.equal((await f.database.query("SELECT * FROM assessments_assignment_heads")).rowCount, 0);
    assert.equal((await f.database.query("SELECT * FROM planning_states")).rowCount, 0);
    assert.equal((await f.database.query("SELECT * FROM planning_outbox")).rowCount, 0);
    assert.equal((await f.database.query("SELECT * FROM ai_execution_jobs")).rowCount, 0);
    const advisory = f.trace.findIndex(entry => /pg_advisory_xact_lock/.test(entry.statement));
    const head = f.trace.findIndex(entry => /assessments_assignment_heads.+FOR UPDATE/.test(entry.statement));
    const projectLock = f.trace.findIndex(entry => /projects_project WHERE.+FOR UPDATE/.test(entry.statement));
    const accounts = f.trace.findIndex(entry => /FOR SHARE OF m,u/.test(entry.statement));
    assert.ok(advisory >= 0 && head > advisory && projectLock > head && accounts > projectLock);
    assert.equal(f.trace.filter(entry => /assessments_assignment_heads.+FOR UPDATE/.test(entry.statement)).length, 1, "a final recheck cannot lock a previously missing head after the project");
    assert.ok(!f.trace.some(entry => /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?(?:assessments_assignment_heads|planning_states)/i.test(entry.statement)));
  } finally { await f.database.close(); }
});

test("real review progress produces verified-member receipts once, mark-read stays personal and unknown AI holds are untouched", async () => {
  const f = await fixture();
  try {
    const p = await f.plan([bob, carol, dan]);
    // Current M01 schema requires a verified timestamp for every persisted
    // account. Exercise its real disabled/deletion-pending states instead.
    await f.database.query("UPDATE auth_users SET status='deletion_pending' WHERE id=$1", [carol.userId]);
    await f.database.query("UPDATE auth_users SET status='suspended' WHERE id=$1", [dan.userId]);
    await f.progress(p.project.id, "review");
    const beforePlan = await f.app.planningRepository.read(p.project.id);
    await f.database.query("INSERT INTO ai_execution_jobs(id,kind,module_job_id,source_revision,project_id,actor_id,status,attempts,external_state,created_at,updated_at) VALUES('unknown-hold','personal_artifact','unknown-hold',1,$1,$2,'unknown',1,'unknown',$3,$3)", [p.project.id, alice.userId, new Date(started).toISOString()]);
    await f.database.query("INSERT INTO ai_usage_attempts(id,execution_id,project_id,actor_id,period,model_version,prompt_version,status,cost_configured,input_rate_micro_usd_per_million,output_rate_micro_usd_per_million,reserved_micro_usd,external_state,created_at) VALUES('hold-attempt','unknown-hold',$1,$2,'2026-10-10','fixture','fixture','reserved',true,1,1,1000,'unknown',$3)", [p.project.id, alice.userId, new Date(started).toISOString()]);
    const beforeHold = [(await f.database.query("SELECT * FROM ai_execution_jobs")).rows, (await f.database.query("SELECT * FROM ai_usage_attempts")).rows];
    f.trace.length = 0;
    const run = await f.notifications.worker.runOnce({ limit: 2 });
    assert.equal(run.modelRequests, 0); assert.deepEqual(run.errors, []);
    const notices = await f.notifications.service.listOwn(alice), bobNotices = await f.notifications.service.listOwn(bob);
    const review = notices.find(item => item.cause === "deliverable_review")!;
    assert.ok(review); assert.equal(review.taskId, "task-0"); assert.equal(review.status, "active");
    assert.ok(notices.some(item => item.cause === "owner_changed"), "the current eligible account set is part of ownership risk, even while M02 preserves membership history");
    assert.equal(bobNotices.find(item => item.id === review.id)?.readAt, null);
    assert.deepEqual(await f.notifications.service.listOwn(carol), []);
    assert.deepEqual(await f.notifications.service.listOwn(dan), []);
    assert.deepEqual(await f.notifications.service.listOwn(outsiders), []);
    assert.equal((await f.database.query("SELECT * FROM planning_notification_recipients WHERE notification_id=$1", [review.id])).rowCount, 2);
    const marked = await f.notifications.service.markRead(alice, review.id, { expectedRevision: review.revision });
    assert.ok(marked.readAt);
    assert.equal((await f.notifications.service.listOwn(bob)).find(item => item.id === review.id)?.readAt, null);
    await assert.rejects(f.notifications.service.dismissResolved(alice, review.id, { expectedRevision: marked.revision }), (error: unknown) => error instanceof DomainError && error.code === "RISK_STILL_ACTIVE");
    f.setTime(started + 60_000);
    const repeated = await f.notifications.worker.runOnce({ limit: 2 });
    assert.equal(repeated.projects.reduce((sum, item) => sum + item.created, 0), 0);
    assert.deepEqual(await f.app.planningRepository.read(p.project.id), beforePlan, "notification reads never alter task acceptance, status or history");
    assert.deepEqual([(await f.database.query("SELECT * FROM ai_execution_jobs")).rows, (await f.database.query("SELECT * FROM ai_usage_attempts")).rows], beforeHold);
    assert.equal((await f.database.query("SELECT * FROM planning_notification_consumptions")).rowCount, (await f.database.query("SELECT * FROM planning_outbox")).rowCount);
    assert.equal((await f.database.query("SELECT * FROM planning_outbox WHERE published_at IS NOT NULL")).rowCount, 0, "other outbox consumers keep their own cursor");
    const order = f.trace.filter(entry => /assessments_assignment_heads.+FOR UPDATE|projects_project WHERE.+FOR UPDATE|FOR SHARE OF m,u/.test(entry.statement));
    const headIndex = order.findIndex(entry => /assessments_assignment_heads/.test(entry.statement));
    assert.ok(headIndex >= 0 && /projects_project WHERE/.test(order[headIndex + 1]!.statement));
  } finally { await f.database.close(); }
});

test("clock-only capacity risk reconciles without outbox, reuses one revision through resolve and reopen", async () => {
  const f = await fixture();
  try {
    const p = await f.plan();
    await f.notifications.worker.runOnce({ limit: 1 });
    assert.ok(!(await f.notifications.service.listOwn(alice)).some(item => item.cause === "deadline_risk"));
    const outbox = (await f.database.query("SELECT * FROM planning_outbox ORDER BY event_id")).rows;
    f.setTime(started + 4 * 3_600_000 + 59 * 60_000);
    const riskRun = await f.notifications.worker.runOnce({ limit: 1 });
    assert.equal(riskRun.errors.length, 0);
    const risk = (await f.notifications.service.listOwn(alice)).find(item => item.cause === "deadline_risk")!;
    assert.ok(risk); assert.equal(risk.status, "active");
    f.setTime(started + 4 * 3_600_000 + 59 * 60_000 + 1000);
    await f.notifications.worker.runOnce({ limit: 1 });
    assert.equal((await f.database.query("SELECT * FROM planning_notifications WHERE cause='deadline_risk'")).rowCount, 1, "capture time and continuously shrinking minutes are not a cause revision");
    f.setTime(started + 60_000);
    await f.notifications.worker.runOnce({ limit: 1 });
    assert.equal((await f.notifications.service.listOwn(alice)).find(item => item.id === risk.id)?.status, "resolved");
    f.setTime(started + 4 * 3_600_000 + 59 * 60_000);
    await f.notifications.worker.runOnce({ limit: 1 });
    assert.equal((await f.notifications.service.listOwn(alice)).find(item => item.id === risk.id)?.status, "active");
    assert.equal((await f.database.query("SELECT * FROM planning_notifications WHERE cause='deadline_risk'")).rowCount, 1);
    assert.deepEqual((await f.database.query("SELECT * FROM planning_outbox ORDER BY event_id")).rows, outbox);
    assert.equal((await f.app.planningRepository.read(p.project.id))?.plans.find(item => item.id === p.plan.id)?.status, "applied");
  } finally { await f.database.close(); }
});

test("actual M02 goal/window changes and M03 confirmation changes produce current input notices without plan generation", async () => {
  const f = await fixture();
  try {
    const p = await f.plan();
    await f.notifications.worker.runOnce({ limit: 1 });
    const detail = await f.app.projects.getProject(alice, p.project.id);
    await f.app.projects.editProject(alice, p.project.id, { expectedRevision: detail.project.revision, goal: "缩小为一个完整核心操作" });
    await f.notifications.worker.runOnce({ limit: 1 });
    assert.ok((await f.notifications.service.listOwn(alice)).some(item => item.cause === "input_changed"));
    await f.app.projects.updateMyAvailability(alice, p.project.id, { expectedRevision: 1, timezone: "UTC", windows: [{ id: "work", startsAt: new Date(started + 3_600_000).toISOString(), endsAt: new Date(started + 4 * 3_600_000).toISOString(), effectiveMinutes: 180 }] });
    await f.notifications.worker.runOnce({ limit: 1 });
    assert.ok((await f.notifications.service.listOwn(alice)).some(item => item.cause === "availability_changed"));
    const currentEvent = await f.app.eventsRepository.getEvent(p.eventId);
    const rules2 = validateRuleVersion({ ...p.rules, version: 2, sources: p.rules.sources.map(source => ({ ...source, version: 2 })), evidence: p.rules.evidence.map(evidence => ({ ...evidence, version: 2 })) });
    await f.app.eventsRepository.transaction(async tx => { await tx.saveEvent({ ...currentEvent!, revision: currentEvent!.revision + 1, candidateVersion: 2, publishedVersion: 2 }, currentEvent!.revision); await tx.insertRules(rules2); });
    const confirmation = await f.app.eventsRepository.getConfirmation(p.project.id);
    await f.app.events.confirmProjectRules(alice, p.project.id, p.eventId, 2, confirmation!.revision);
    await f.notifications.worker.runOnce({ limit: 1 });
    assert.ok((await f.notifications.service.listOwn(alice)).some(item => item.cause === "rules_changed"));
    assert.equal((await f.app.planningRepository.read(p.project.id))?.plans.length, 1);
    assert.equal((await f.database.query("SELECT * FROM ai_execution_jobs")).rowCount, 0);
  } finally { await f.database.close(); }
});

test("revocation during snapshot rolls back receipts/consumption and performs no late M04 head lock", async () => {
  const f = await fixture();
  try {
    const p = await f.plan([bob]); await f.progress(p.project.id, "blocked");
    const inputExecutors: SqlExecutor[] = [];
    const guarded = createPlanningNotifications({ ...f.options, async readInput(id, now, actor, sql) {
      inputExecutors.push(sql);
      const input = await f.options.readInput(id, now, actor, sql);
      // A same-transaction mutation exercises the final guard deterministically.
      // PGlite does not claim connected PostgreSQL multi-session concurrency.
      await sql.query("UPDATE auth_users SET status='suspended' WHERE id=$1", [bob.userId]);
      return input;
    } });
    f.trace.length = 0;
    await assert.rejects(guarded.service.reconcileProject(p.project.id), (error: unknown) => error instanceof DomainError && error.code === "NOTIFICATION_INPUT_CHANGED");
    assert.equal((await f.database.query("SELECT * FROM planning_notifications")).rowCount, 0);
    assert.equal((await f.database.query("SELECT * FROM planning_notification_recipients")).rowCount, 0);
    assert.equal((await f.database.query("SELECT * FROM planning_notification_consumptions")).rowCount, 0);
    assert.equal((await f.database.query<{ status: string }>("SELECT status FROM auth_users WHERE id=$1", [bob.userId])).rows[0]?.status, "active");
    const lockedHeads = f.trace.filter(entry => /assessments_assignment_heads.+FOR UPDATE/.test(entry.statement));
    assert.equal(lockedHeads.length, 1);
    assert.equal(inputExecutors.length, 1);
    const headRead = f.trace.find(entry => /SELECT version_id FROM assessments_assignment_heads/.test(entry.statement));
    const accountChange = f.trace.find(entry => /UPDATE auth_users SET status/.test(entry.statement));
    // M05 wraps the same executor to reject use after transaction closure.
    // Both protected heads and actual fact reads reach the same underlying one.
    assert.equal(headRead?.executor, lockedHeads[0]?.executor);
    assert.equal(accountChange?.executor, lockedHeads[0]?.executor);
    await assert.rejects(inputExecutors[0]!.query("SELECT 1"), (error: unknown) => error instanceof DomainError && error.code === "NOTIFICATION_TRANSACTION_CLOSED");
    assert.equal((await f.database.query("SELECT * FROM assessments_assignment_heads")).rowCount, 0);
    assert.ok(f.trace.some(entry => /SELECT version_id FROM assessments_assignment_heads/.test(entry.statement) && !/FOR UPDATE/.test(entry.statement)), "notification input uses the ordinary head projection on that executor");
    await f.notifications.service.reconcileProject(p.project.id);
    assert.ok((await f.notifications.service.listOwn(bob)).some(item => item.cause === "task_blocked"));
  } finally { await f.database.close(); }
});

test("leaving and rejoining cannot revive old receipts; archived projects retain read-only history without new reminders", async () => {
  const f = await fixture();
  try {
    const p = await f.plan([bob]); await f.progress(p.project.id, "blocked");
    await f.notifications.worker.runOnce({ limit: 1 });
    const old = (await f.notifications.service.listOwn(bob)).find(item => item.cause === "task_blocked")!;
    const detail = await f.app.projects.getProject(bob, p.project.id);
    await f.app.projects.leaveProject(bob, p.project.id, detail.project.revision);
    await f.notifications.worker.runOnce({ limit: 1 });
    assert.deepEqual(await f.notifications.service.listOwn(bob), []);
    const latest = await f.app.projects.getProject(alice, p.project.id);
    const invitation = await f.app.projects.createProjectInvitation(alice, p.project.id, { expectedRevision: latest.project.revision, role: "member", maxUses: 1, expiresAt: new Date(started + 86_400_000).toISOString() });
    await f.app.projects.acceptInvitation(bob, invitation.token);
    await f.notifications.worker.runOnce({ limit: 1 });
    assert.ok(!(await f.notifications.service.listOwn(bob)).some(item => item.id === old.id));
    await assert.rejects(f.notifications.service.markRead(bob, old.id, { expectedRevision: old.revision }), (error: unknown) => error instanceof DomainError && error.code === "NOT_FOUND");
    const beforeArchive = (await f.database.query("SELECT * FROM planning_notifications")).rowCount;
    const before = await f.app.projects.getProject(alice, p.project.id);
    await f.app.projects.transitionStage(alice, p.project.id, { expectedRevision: before.project.revision, stage: "archived", reason: "保留比赛记录" });
    const state = await f.app.planningRepository.read(p.project.id);
    await f.notifications.worker.runOnce({ limit: 1 });
    assert.equal((await f.database.query("SELECT * FROM planning_notifications")).rowCount, beforeArchive);
    assert.ok((await f.notifications.service.listOwn(alice)).every(item => item.status === "archived"));
    assert.deepEqual(await f.app.planningRepository.read(p.project.id), state);
  } finally { await f.database.close(); }
});

test("automatic periodic selection is bounded and fair with a failing pending project, and cancellation does no work", async () => {
  const f = await fixture();
  try {
    const projects = [];
    for (let index = 0; index < 6; index++) projects.push((await f.plan()).project);
    const sorted = projects.map(project => project.id).sort();
    const allPages: string[] = [];
    let after: string | undefined;
    do {
      const page = await f.notifications.selectProjectIds({ limit: 2, afterProjectId: after });
      if (!page.length) break;
      assert.ok(page.length <= 2); allPages.push(...page); after = page.at(-1);
    } while (true);
    assert.deepEqual(allPages, sorted);
    const fault = sorted[0]!;
    const worker = createPlanningNotifications({ ...f.options, async readInput(id, now, actor, sql) { if (id === fault) throw new Error("simulated private provider text must not appear in report"); return f.options.readInput(id, now, actor, sql); } }).worker;
    const visited = new Set<string>();
    for (let index = 0; index < 12 && visited.size < sorted.length; index++) {
      const report = await worker.runOnce({ limit: 2 });
      assert.ok(report.projects.length + report.errors.length <= 2); assert.equal(report.modelRequests, 0);
      for (const item of [...report.projects, ...report.errors]) visited.add(item.projectId);
      for (const error of report.errors) assert.equal(error.code, "NOTIFICATION_CHECK_FAILED");
    }
    assert.deepEqual([...visited].sort(), sorted, "a failed outbox event cannot monopolize the periodic cursor");
    const controller = new AbortController(); controller.abort(); f.trace.length = 0;
    assert.deepEqual(await worker.runOnce({ limit: 2, signal: controller.signal }), { projects: [], errors: [], modelRequests: 0 });
    assert.equal(f.trace.length, 0);
    await assert.rejects(worker.runOnce({ limit: 201 }), (error: unknown) => error instanceof DomainError && error.code === "INVALID_INPUT");
  } finally { await f.database.close(); }
});

test("a suspended work owner creates a stable actionable risk while preserved M02/M05 records stay unchanged", async () => {
  const f = await fixture();
  try {
    const p = await f.plan([bob], bob);
    await f.notifications.worker.runOnce({ limit: 1 });
    const before = await f.app.planningRepository.read(p.project.id);
    await f.database.query("UPDATE auth_users SET status='suspended' WHERE id=$1", [bob.userId]);
    await f.notifications.worker.runOnce({ limit: 1 });
    const risk = (await f.notifications.service.listOwn(alice)).find(item => item.cause === "owner_changed")!;
    assert.ok(risk); assert.equal(risk.requiresAction, true);
    assert.deepEqual(await f.notifications.service.listOwn(bob), []);
    f.setTime(started + 60_000);
    await f.notifications.worker.runOnce({ limit: 1 });
    const repeated = (await f.notifications.service.listOwn(alice)).filter(item => item.cause === "owner_changed" && item.status === "active");
    assert.equal(repeated.length, 1); assert.equal(repeated[0]?.id, risk.id); assert.equal(repeated[0]?.sourceRevision, risk.sourceRevision);
    assert.deepEqual(await f.app.planningRepository.read(p.project.id), before);
    assert.equal((await f.app.projects.getProject(alice, p.project.id)).members.find(member => member.userId === bob.userId)?.status, "active", "a notification never rewrites preserved membership history");
    await f.database.query("UPDATE auth_users SET status='active' WHERE id=$1", [bob.userId]);
    await f.notifications.worker.runOnce({ limit: 1 });
    assert.equal((await f.notifications.service.listOwn(alice)).find(item => item.id === risk.id)?.status, "resolved");
    assert.equal((await f.database.query("SELECT * FROM planning_notifications WHERE cause='owner_changed'")).rowCount, 1);
  } finally { await f.database.close(); }
});
