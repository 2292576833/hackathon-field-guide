import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Actor, ProjectMembershipAccess } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor, SqlResult } from "../../shared/persistence.ts";
import { createPostgresPlanningNotificationRepository } from "./notification-postgres.ts";
import { derivePlanningNotificationFacts } from "./notification-facts.ts";
import { PlanningNotificationService, createPlanningNotificationWorker, planningNotificationHref } from "./notifications.ts";
import type { PlanningNotificationFact, PlanningNotificationProject, PlanningNotificationTransaction } from "./notification-types.ts";
import { inputFixture, taskProposal } from "./testing/fixtures.ts";
import type { CurrentPlanningView, PlanVersion, PlanningTask } from "./types.ts";

const manager: Actor = { userId: "u1", platformRoles: ["user"] };
const member: Actor = { userId: "u2", platformRoles: ["user"] };
const outsider: Actor = { userId: "u3", platformRoles: ["admin"] };
const now = "2026-10-10T08:00:00.000Z";
const code = (name: string) => (error: unknown) => error instanceof DomainError && error.code === name;
function membership(userId: string, membershipId: string, role: "manager" | "member" = "member"): ProjectMembershipAccess { return { userId, membershipId, projectId: "p1", role, status: "active" }; }

async function context() {
  const engine = new PGlite(); await engine.waitReady;
  await engine.exec(await readFile(new URL("./migrations/001-planning.sql", import.meta.url), "utf8"));
  await engine.exec(await readFile(new URL("./migrations/003-planning-notifications.sql", import.meta.url), "utf8"));
  const executor = (query: PGlite["query"]): SqlExecutor => ({ async query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<SqlResult<Row>> { const result = await query<Row>(statement, [...parameters]); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }; } });
  const database: DatabasePort = { ...executor(engine.query.bind(engine)), transaction: work => engine.transaction(tx => work(executor(tx.query.bind(tx)))) };
  await database.query("INSERT INTO planning_states(project_id,revision,state_json) VALUES ('p1',0,$1::jsonb)", [JSON.stringify({ projectId: "p1", revision: 0, tasksRevision: 0, currentPlanVersionId: null, tasks: [], plans: [], progressUpdates: [] })]);
  const project: PlanningNotificationProject = { projectId: "p1", archived: false, members: [membership("u1", "m1", "manager"), membership("u2", "m2")] };
  const facts: PlanningNotificationFact[] = [{ cause: "task_blocked", sourceRevision: "task:1:rev:2", taskId: "t1", label: "核心流程" }];
  let ids = 0, locks = 0, snapshotCalls = 0;
  let afterLock: ((count: number) => void) | undefined;
  const service = new PlanningNotificationService({ repository: createPostgresPlanningNotificationRepository(database), clock: { now: () => new Date(now) }, ids: { next: () => `notification-${++ids}` },
    projects: { async lockProject() { afterLock?.(++locks); return structuredClone(project); } },
    snapshots: { async readSnapshot() { snapshotCalls++; return { facts: structuredClone(facts) }; } } });
  async function event(id: string, type = "PlanRiskDetected") {
    const value = { id, projectId: "p1", aggregateId: "t1", revision: 2, occurredAt: now, type };
    await database.query("INSERT INTO planning_outbox(event_id,event_type,project_id,aggregate_id,revision,occurred_at,event_json) VALUES ($1,$2,'p1','t1',2,$3,$4::jsonb)", [id, type, now, JSON.stringify(value)]);
  }
  async function count(table: "planning_notifications" | "planning_notification_recipients" | "planning_notification_consumptions") { const result = await database.query<{ total: string }>(`SELECT count(*)::text AS total FROM ${table}`); return Number(result.rows[0]!.total); }
  return { engine, database, service, project, facts, event, count, getSnapshotCalls: () => snapshotCalls, resetLocks: (action?: (count: number) => void) => { locks = 0; afterLock = action; } };
}

test("persisted events merge by project/cause/source revision and preserve other outbox consumers", async t => {
  const c = await context(); t.after(() => c.engine.close());
  await c.event("event-1"); await c.event("event-2", "ProgressUpdated");
  c.facts.push({ ...c.facts[0]! });
  assert.deepEqual(await c.service.reconcileProject("p1"), { events: 2, created: 1, recipients: 2, resolved: 0 });
  assert.deepEqual(await c.service.reconcileProject("p1"), { events: 0, created: 0, recipients: 0, resolved: 0 });
  assert.equal(await c.count("planning_notifications"), 1);
  assert.equal(await c.count("planning_notification_consumptions"), 2);
  const outbox = await c.database.query<{ published_at: unknown }>("SELECT published_at FROM planning_outbox");
  assert.ok(outbox.rows.every(row => row.published_at === null));
  const owned = await c.service.listOwn(manager); assert.equal(owned.length, 1); assert.equal(owned[0]!.status, "active");
  assert.equal(owned[0]!.href, "/app/projects/p1/plan");
  assert.equal((await c.service.listOwn(member)).length, 1); assert.deepEqual(await c.service.listOwn(outsider), []);
});

test("concurrent workers claim once, and a genuine new source revision creates a new merged reminder", async t => {
  const c = await context(); t.after(() => c.engine.close()); await c.event("event-1");
  const worker = createPlanningNotificationWorker(c.service);
  const results = await Promise.all([worker.runOnce({ projectIds: ["p1"] }), worker.runOnce({ projectIds: ["p1"] })]);
  assert.equal(results.flatMap(value => value.projects).reduce((sum, value) => sum + value.events, 0), 1);
  assert.equal(await c.count("planning_notifications"), 1); assert.equal(await c.count("planning_notification_recipients"), 2);
  assert.ok(results.every(value => value.modelRequests === 0));
  c.facts[0]!.sourceRevision = "task:1:rev:3";
  assert.deepEqual(await c.service.reconcileProject("p1"), { events: 0, created: 1, recipients: 2, resolved: 1 });
  assert.deepEqual((await c.service.listOwn(manager)).map(value => value.status).sort(), ["active", "resolved"]);
});

test("final membership/archive changes roll back notification insertion and event consumption together", async t => {
  const c = await context(); t.after(() => c.engine.close()); await c.event("event-1");
  c.resetLocks(count => { if (count === 2) c.project.archived = true; });
  await assert.rejects(c.service.reconcileProject("p1"), code("NOTIFICATION_INPUT_CHANGED"));
  assert.equal(await c.count("planning_notifications"), 0); assert.equal(await c.count("planning_notification_recipients"), 0); assert.equal(await c.count("planning_notification_consumptions"), 0);
  c.project.archived = false; c.resetLocks();
  assert.equal((await c.service.reconcileProject("p1")).events, 1);
});

test("current permission filters reads before dispatch; removed/rejoined identities cannot recover revoked receipts", async t => {
  const c = await context(); t.after(() => c.engine.close()); await c.service.reconcileProject("p1");
  const id = (await c.service.listOwn(member))[0]!.id;
  c.project.members = [membership("u1", "m1", "manager")];
  assert.deepEqual(await c.service.listOwn(member), []);
  await assert.rejects(c.service.markRead(member, id, { expectedRevision: 1 }), code("NOT_FOUND"));
  await c.service.reconcileProject("p1");
  c.project.members = [...c.project.members, membership("u2", "new-membership")]; await c.service.reconcileProject("p1");
  assert.deepEqual(await c.service.listOwn(member), []);
  await assert.rejects(c.service.markRead(outsider, id, { expectedRevision: 1 }), code("NOT_FOUND"));
});

test("read/CAS and resolved dismissal change only personal receipts, never planning facts", async t => {
  const c = await context(); t.after(() => c.engine.close()); await c.service.reconcileProject("p1");
  const before = await c.database.query("SELECT state_json,revision FROM planning_states");
  const item = (await c.service.listOwn(manager))[0]!;
  const read = await c.service.markRead(manager, item.id, { expectedRevision: 1 }); assert.equal(read.revision, 2); assert.equal(read.readAt, now); assert.equal(read.status, "active");
  assert.equal((await c.service.markRead(manager, item.id, { expectedRevision: 2 })).revision, 2);
  await assert.rejects(c.service.markRead(manager, item.id, { expectedRevision: 1 }), code("VERSION_CONFLICT"));
  await assert.rejects(c.service.dismissResolved(manager, item.id, { expectedRevision: 2 }), code("RISK_STILL_ACTIVE"));
  assert.equal((await c.service.listOwn(member))[0]!.readAt, null);
  c.facts.length = 0;
  const dismissed = await c.service.dismissResolved(manager, item.id, { expectedRevision: 2 }); assert.equal(dismissed.status, "resolved"); assert.equal(dismissed.revision, 3);
  assert.deepEqual(await c.service.listOwn(manager), []); assert.equal((await c.service.listOwn(member))[0]!.status, "resolved");
  assert.deepEqual(await c.database.query("SELECT state_json,revision FROM planning_states"), before);
});

test("concurrent read acknowledgement uses one winning personal revision and GET never reads risk snapshots", async t => {
  const c = await context(); t.after(() => c.engine.close()); await c.service.reconcileProject("p1");
  const snapshotCalls = c.getSnapshotCalls(); const item = (await c.service.listOwn(manager))[0]!;
  assert.equal(c.getSnapshotCalls(), snapshotCalls);
  const results = await Promise.allSettled([c.service.markRead(manager, item.id, { expectedRevision: 1 }), c.service.markRead(manager, item.id, { expectedRevision: 1 })]);
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
  const failed = results.find(value => value.status === "rejected") as PromiseRejectedResult;
  assert.ok(code("VERSION_CONFLICT")(failed.reason)); assert.equal(c.getSnapshotCalls(), snapshotCalls);
});

test("archived projects preserve read-only history, stop dispatch and permit hiding personal archived reminders", async t => {
  const c = await context(); t.after(() => c.engine.close()); await c.service.reconcileProject("p1"); const item = (await c.service.listOwn(manager))[0]!;
  c.project.archived = true; c.facts.push({ cause: "rules_changed", sourceRevision: "new-rules" }); await c.event("archived-event");
  assert.equal((await c.service.reconcileProject("p1")).created, 0); assert.equal((await c.service.listOwn(manager))[0]!.status, "archived");
  await c.service.dismissResolved(manager, item.id, { expectedRevision: 1 }); assert.deepEqual(await c.service.listOwn(manager), []);
  c.project.archived = false; c.facts.splice(1); await c.service.reconcileProject("p1");
  const restored = (await c.service.listOwn(manager))[0]!; assert.equal(restored.id, item.id); assert.equal(restored.readAt, null); assert.equal(restored.status, "active"); assert.equal(restored.revision, 3);
});

test("a resolved risk reappearing with the same cause version reuses its record and revives only unrevoked receipts", async t => {
  const c = await context(); t.after(() => c.engine.close()); await c.service.reconcileProject("p1");
  const fact = structuredClone(c.facts[0]!); const item = (await c.service.listOwn(manager))[0]!;
  c.facts.length = 0; await c.service.dismissResolved(manager, item.id, { expectedRevision: 1 });
  c.project.members = [membership("u1", "m1", "manager")]; await c.service.reconcileProject("p1");
  c.facts.push(fact); c.project.members = [...c.project.members, membership("u2", "new-member")];
  await c.service.reconcileProject("p1");
  assert.equal(await c.count("planning_notifications"), 1); const revived = (await c.service.listOwn(manager))[0]!;
  assert.equal(revived.id, item.id); assert.equal(revived.status, "active"); assert.equal(revived.readAt, null); assert.equal(revived.revision, 3);
  assert.deepEqual(await c.service.listOwn(member), []);
  await c.service.reconcileProject("p1"); assert.equal((await c.service.listOwn(manager))[0]!.revision, 3);
});

test("an already-applied arrangement update can be acknowledged personally without pretending to resolve another person's risk", async t => {
  const c = await context(); t.after(() => c.engine.close()); c.facts[0] = { cause: "owner_changed", sourceRevision: "applied-owners-2", requiresAction: false };
  await c.service.reconcileProject("p1"); const item = (await c.service.listOwn(manager))[0]!;
  assert.equal(item.requiresAction, false); await c.service.dismissResolved(manager, item.id, { expectedRevision: 1 });
  await c.service.reconcileProject("p1"); assert.deepEqual(await c.service.listOwn(manager), []); assert.equal((await c.service.listOwn(member))[0]!.readAt, null);
});

test("worker failures stay local and project selection rotates between pending events and clock checks", async () => {
  const visited: string[] = [];
  const service = { async pendingProjectIds() { return ["broken", "pending"]; }, async reconcileProject(projectId: string) { visited.push(projectId); if (projectId === "broken") throw new Error("private provider payload"); return { events: 1, created: 0, recipients: 0, resolved: 0 }; } } as unknown as PlanningNotificationService;
  const worker = createPlanningNotificationWorker(service);
  const first = await worker.runOnce({ projectIds: ["clock1", "clock2"], limit: 2 }); const second = await worker.runOnce({ projectIds: ["clock1", "clock2"], limit: 2 });
  assert.deepEqual(first.errors, [{ projectId: "broken", code: "NOTIFICATION_CHECK_FAILED" }]); assert.deepEqual(second.errors, []);
  assert.deepEqual(new Set(visited), new Set(["broken", "pending", "clock1", "clock2"]));
});

test("keyset worker passes a full failed pending page to reach later events, including a batch of one", async () => {
  const visited: string[] = [];
  const pending = ["a-broken", "b-broken", "c-success"];
  const service = { async pendingProjectIds(count: number, after?: string) { return pending.filter(id => after === undefined || id > after).slice(0, count); }, async reconcileProject(projectId: string) { visited.push(projectId); if (projectId !== "c-success") throw new Error("broken snapshot"); return { events: 1, created: 0, recipients: 0, resolved: 0 }; } } as unknown as PlanningNotificationService;
  const worker = createPlanningNotificationWorker(service);
  await worker.runOnce({ limit: 2 }); const next = await worker.runOnce({ limit: 2 });
  assert.ok(next.projects.some(value => value.projectId === "c-success")); assert.deepEqual(new Set(visited), new Set(pending));
  visited.length = 0; const single = createPlanningNotificationWorker(service);
  for (let round = 0; round < 6; round++) await single.runOnce({ projectIds: ["clock1", "clock2"], limit: 1 });
  assert.ok(visited.includes("c-success")); assert.ok(visited.includes("clock1")); assert.ok(visited.includes("clock2"));
});

test("project filtering and permission-aware keyset scanning do not let unrelated or revoked references hide valid reminders", async t => {
  const c = await context(); t.after(() => c.engine.close()); await c.service.reconcileProject("p1");
  // 205 newer inaccessible records force a second page for the legitimate p1 notification.
  await c.database.query("INSERT INTO planning_notifications(id,project_id,cause,source_revision,created_at,updated_at,resolved_at,body) SELECT 'hidden-'||x,'removed-project','task_blocked','hidden-'||x,$1,$1,NULL,'{}'::jsonb FROM generate_series(1,205) x", ["2026-10-11T08:00:00Z"]);
  await c.database.query("INSERT INTO planning_notification_recipients(notification_id,user_id,membership_id,revision) SELECT id,'u1','old-member',1 FROM planning_notifications WHERE project_id='removed-project'");
  // The Port is scoped; absent/inaccessible projects return null.
  const service = new PlanningNotificationService({ repository: createPostgresPlanningNotificationRepository(c.database), clock: { now: () => new Date(now) }, ids: { next: () => "unused" }, projects: { async lockProject(projectId) { return projectId === "p1" ? structuredClone(c.project) : null; } }, snapshots: { async readSnapshot() { return { facts: c.facts }; } } });
  assert.equal((await service.listOwn(manager, { limit: 1 }))[0]!.projectId, "p1");
  assert.equal((await service.listOwn(manager, { projectId: "p1", limit: 1 })).length, 1);
  assert.deepEqual(await service.listOwn(manager, { projectId: "removed-project", limit: 1 }), []);
});

test("malformed deterministic snapshots cannot commit or consume an event", async t => {
  const c = await context(); t.after(() => c.engine.close()); await c.event("event-1"); c.facts[0]!.cause = "made_up" as PlanningNotificationFact["cause"];
  await assert.rejects(c.service.reconcileProject("p1"), code("NOTIFICATION_SNAPSHOT_INVALID"));
  assert.equal(await c.count("planning_notification_consumptions"), 0);
  assert.equal(planningNotificationHref("p1?next=https://outside.test", "rules_changed"), "/app/projects/p1%3Fnext%3Dhttps%3A%2F%2Foutside.test/rules");
});

test("wrong-project ports and retained transaction executors cannot read or publish after their allowed scope", async t => {
  const c = await context(); t.after(() => c.engine.close()); await c.event("event-1");
  c.project.projectId = "other-project";
  await assert.rejects(c.service.reconcileProject("p1"), code("NOTIFICATION_PROJECT_INVALID")); assert.equal(await c.count("planning_notification_consumptions"), 0);
  const repository = createPostgresPlanningNotificationRepository(c.database); let retained: PlanningNotificationTransaction | undefined;
  await repository.transaction("p1", async tx => { retained = tx; });
  await assert.rejects(retained!.list(), code("NOTIFICATION_TRANSACTION_CLOSED"));
  await assert.rejects(retained!.sql.query("SELECT 1"), code("NOTIFICATION_TRANSACTION_CLOSED"));
});

test("derivation is stable across clocks/JSON object order and separates genuine changes", () => {
  const facts = inputFixture(); const work: PlanningTask = { ...taskProposal(), id: "t1", status: "review", remainingEstimate: null, blocker: null, cancellationReason: null, acceptance: null, revision: 1, updatedAt: now };
  const plan = { id: "plan1", inputSnapshot: structuredClone(facts), tasks: [structuredClone(work)] } as PlanVersion;
  const current: CurrentPlanningView = { plan, tasks: [work], tasksRevision: 1, evaluation: null, staleInputs: false, inputVersionsChanged: false, lastProgressAt: null };
  const first = derivePlanningNotificationFacts({ current, input: facts });
  facts.capturedAt = "2026-10-11T00:00:00Z"; facts.availabilityVersions = Object.fromEntries(Object.entries(facts.availabilityVersions).reverse());
  assert.deepEqual(derivePlanningNotificationFacts({ current, input: facts }), first);
  work.revision++; assert.notEqual(derivePlanningNotificationFacts({ current, input: facts }).facts[0]!.sourceRevision, first.facts[0]!.sourceRevision);
  facts.requirementVersionId = "new-rule-version"; facts.availabilityVersions.pm1 = 99; current.inputVersionsChanged = true;
  assert.deepEqual(derivePlanningNotificationFacts({ current, input: facts }).facts.map(fact => fact.cause).sort(), ["availability_changed", "deliverable_review", "rules_changed"]);
});

test("historical ownership changes are informational for active work and stop triggering when work is done", () => {
  const facts = inputFixture(); const work: PlanningTask = { ...taskProposal(), id: "t1", status: "todo", remainingEstimate: null, blocker: null, cancellationReason: null, acceptance: null, revision: 1, updatedAt: now };
  const plan = { id: "plan1", inputSnapshot: structuredClone(facts), tasks: [work], changes: [{ taskId: "t1", action: "changed", fields: ["ownerMembershipId"], before: "pm1", after: "pm2", major: true, impact: "负责人调整" }] } as PlanVersion;
  const current: CurrentPlanningView = { plan, tasks: [work], tasksRevision: 1, evaluation: null, staleInputs: false, inputVersionsChanged: false, lastProgressAt: null };
  assert.equal(derivePlanningNotificationFacts({ current, input: facts }).facts[0]!.requiresAction, false);
  work.status = "done"; assert.deepEqual(derivePlanningNotificationFacts({ current, input: facts }).facts, []);
});

test("completing one task does not resend another task's unchanged historical owner update", () => {
  const facts = inputFixture(); const work: PlanningTask = { ...taskProposal(), id: "t1", status: "todo", remainingEstimate: null, blocker: null, cancellationReason: null, acceptance: null, revision: 1, updatedAt: now };
  const other = { ...work, id: "t2" };
  const plan = { id: "plan1", inputSnapshot: structuredClone(facts), tasks: [work, other], changes: [work, other].map(task => ({ taskId: task.id, action: "changed", fields: ["ownerMembershipId"], before: "pm1", after: "pm2", major: true, impact: "负责人调整" })) } as PlanVersion;
  const current: CurrentPlanningView = { plan, tasks: [work, other], tasksRevision: 1, evaluation: null, staleInputs: false, inputVersionsChanged: false, lastProgressAt: null };
  const first = derivePlanningNotificationFacts({ current, input: facts }).facts[0]!;
  work.status = "done"; work.revision++;
  assert.equal(derivePlanningNotificationFacts({ current, input: facts }).facts[0]!.sourceRevision, first.sourceRevision);
});
