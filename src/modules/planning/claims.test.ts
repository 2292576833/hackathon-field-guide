import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor, SqlResult } from "../../shared/persistence.ts";
import { createPostgresPlanningRepository } from "./postgres.ts";
import { PlanningService } from "./service.ts";
import type { DraftTaskOwnershipCommand } from "./service.ts";
import type { PlanVersion } from "./types.ts";
import { inputFixture, manager, member, membership, NOW, outsider, setup } from "./testing/fixtures.ts";

const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
const ownership = (plan: PlanVersion, taskId = "t1", key = "ownership"): DraftTaskOwnershipCommand => ({
  expectedRevision: plan.revision,
  expectedTaskRevision: plan.tasks.find(task => task.id === taskId)!.revision,
  idempotencyKey: key,
});
async function pool() {
  const context = setup();
  const tasks = context.draft().tasks.map(task => task.id === "t1" ? { ...task, ownerMembershipId: null } : task);
  const plan = await context.service.createDraft(manager, "p1", context.draft({ tasks }));
  return { ...context, plan };
}

test("task-pool GET does not initialize planning state and enforces current membership", async () => {
  const c = setup();
  assert.deepEqual(await c.service.getTaskPool(member, "p1"), { plan: null, tasks: [], inputVersionsChanged: false });
  assert.equal(c.repository.state, null); assert.equal(c.repository.events.length, 0);
  await assert.rejects(c.service.getTaskPool(outsider, "p1"), code("NOT_FOUND"));
});

test("task-pool selects latest editable draft, keeps claimed entries, and never writes", async () => {
  const c = await pool();
  const next = await c.service.createDraft(manager, "p1", c.draft({ tasks: c.draft().tasks, reason: "更新任务说明" }));
  const failed = structuredClone(next); failed.id = "failed"; failed.status = "generation_failed";
  c.repository.state!.plans.push(failed);
  const before = structuredClone(c.repository.state); const events = c.repository.events.length;
  const view = await c.service.getTaskPool(member, "p1");
  assert.equal(view.plan?.id, next.id); assert.equal(view.tasks.length, next.tasks.length);
  assert.equal(view.tasks.find(task => task.id === "t1")?.ownerMembershipId, "pm2");
  assert.equal(view.inputVersionsChanged, false);
  assert.deepEqual(c.repository.state, before); assert.equal(c.repository.events.length, events);
});

test("claim uses authenticated membership, refreshes validation, and does not apply or report progress", async () => {
  const c = await pool();
  assert.equal(c.plan.status, "needs_changes");
  const command = { ...ownership(c.plan), ownerMembershipId: "pm1" };
  const result = await c.service.claimDraftTask(member, "p1", c.plan.id, "t1", command);
  assert.equal(result.tasks[0]?.ownerMembershipId, "pm2");
  assert.equal(result.tasks[0]?.revision, 1); assert.equal(result.revision, 1);
  assert.equal(result.validation?.structuralValid, true); assert.equal(result.status, "ready");
  assert.equal(result.changes.find(change => change.taskId === "t1")?.after !== null, true);
  assert.equal(c.repository.state?.revision, 2); assert.equal(c.repository.state?.tasksRevision, 0);
  assert.equal(c.repository.state?.currentPlanVersionId, null);
  assert.deepEqual(c.repository.state?.tasks, []); assert.deepEqual(c.repository.state?.progressUpdates, []);
  assert.equal(c.repository.events.at(-1)?.type, "PlanDraftGenerated");
});

test("concurrent claims serialize with exactly one owner and one checked edit", async () => {
  const c = await pool(); const before = c.repository.events.length;
  const results = await Promise.allSettled([
    c.service.claimDraftTask(member, "p1", c.plan.id, "t1", ownership(c.plan, "t1", "member-claim")),
    c.service.claimDraftTask(manager, "p1", c.plan.id, "t1", ownership(c.plan, "t1", "manager-claim")),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
  assert.equal(code("VERSION_CONFLICT")(rejected.reason), true);
  assert.equal(c.repository.state?.plans[0]?.tasks[0]?.ownerMembershipId, "pm2");
  assert.equal(c.repository.events.length, before + 1);
});

test("same-key retries return the first result without another save; changed payload conflicts", async () => {
  const c = await pool(); const command = ownership(c.plan);
  const result = await c.service.claimDraftTask(member, "p1", c.plan.id, "t1", command);
  const before = structuredClone(c.repository.state); const events = c.repository.events.length;
  assert.deepEqual(await c.service.claimDraftTask(member, "p1", c.plan.id, "t1", command), result);
  await assert.rejects(c.service.claimDraftTask(member, "p1", c.plan.id, "t1", { ...command, expectedTaskRevision: 1 }), code("IDEMPOTENCY_CONFLICT"));
  assert.deepEqual(c.repository.state, before); assert.equal(c.repository.events.length, events);
});

test("already claimed work cannot be taken by another member even with current revisions", async () => {
  const c = await pool();
  const claimed = await c.service.claimDraftTask(member, "p1", c.plan.id, "t1", ownership(c.plan));
  await assert.rejects(c.service.claimDraftTask(manager, "p1", c.plan.id, "t1", ownership(claimed, "t1", "take")), code("TASK_ALREADY_CLAIMED"));
  assert.equal(c.repository.state?.plans[0]?.tasks[0]?.ownerMembershipId, "pm2");
});

test("release allows only the owner or manager and reopens the pool without deleting a task", async () => {
  const c = await pool();
  const claimed = await c.service.claimDraftTask(manager, "p1", c.plan.id, "t1", ownership(c.plan));
  await assert.rejects(c.service.releaseDraftTask(member, "p1", c.plan.id, "t1", ownership(claimed, "t1", "not-owner")), code("FORBIDDEN"));
  const released = await c.service.releaseDraftTask(manager, "p1", c.plan.id, "t1", ownership(claimed, "t1", "owner-release"));
  assert.equal(released.tasks[0]?.ownerMembershipId, null); assert.equal(released.tasks.length, c.plan.tasks.length);
  assert.equal(released.status, "needs_changes");
  assert.equal(released.validation?.issues.some(issue => issue.code === "TASK_OWNER_INACTIVE"), true);
  const second = await c.service.claimDraftTask(member, "p1", c.plan.id, "t1", ownership(released, "t1", "member-take"));
  const managerRelease = await c.service.releaseDraftTask(manager, "p1", c.plan.id, "t1", ownership(second, "t1", "manager-release"));
  assert.equal(managerRelease.tasks[0]?.ownerMembershipId, null);
  await assert.rejects(c.service.releaseDraftTask(member, "p1", c.plan.id, "t1", ownership(managerRelease, "t1", "already-free")), code("TASK_NOT_CLAIMED"));
});

test("manager can assign or return work; ordinary members cannot transfer a teammate's work", async () => {
  const c = await pool();
  await assert.rejects(c.service.assignDraftTask(member, "p1", c.plan.id, "t1", { ...ownership(c.plan), ownerMembershipId: "pm1" }), code("FORBIDDEN"));
  const assigned = await c.service.assignDraftTask(manager, "p1", c.plan.id, "t1", { ...ownership(c.plan), ownerMembershipId: "pm2" });
  const transferred = await c.service.assignDraftTask(manager, "p1", c.plan.id, "t1", { ...ownership(assigned, "t1", "transfer"), ownerMembershipId: "pm1" });
  assert.equal(transferred.tasks[0]?.ownerMembershipId, "pm1");
  const returned = await c.service.assignDraftTask(manager, "p1", c.plan.id, "t1", { ...ownership(transferred, "t1", "return"), ownerMembershipId: null });
  assert.equal(returned.tasks[0]?.ownerMembershipId, null);
  await assert.rejects(c.service.assignDraftTask(manager, "p1", c.plan.id, "t1", { ...ownership(returned, "t1", "unchanged"), ownerMembershipId: null }), code("TASK_OWNER_UNCHANGED"));
});

test("assignment rejects foreign, departed or malformed identities without touching the draft", async () => {
  const c = await pool(); c.facts.members.push(membership("departed", "pm3"));
  c.facts.members[c.facts.members.length - 1] = { ...c.facts.members.at(-1)!, status: "left" };
  const before = structuredClone(c.repository.state);
  for (const ownerMembershipId of ["foreign", "pm3"]) await assert.rejects(c.service.assignDraftTask(manager, "p1", c.plan.id, "t1", { ...ownership(c.plan, "t1", ownerMembershipId), ownerMembershipId }), code("TASK_OWNER_INACTIVE"));
  await assert.rejects(c.service.assignDraftTask(manager, "p1", c.plan.id, "t1", { ...ownership(c.plan), ownerMembershipId: "" }), code("INVALID_INPUT"));
  assert.deepEqual(c.repository.state, before);
});

test("claiming as an existing helper cannot double count capacity, and duplicate helpers cannot pass", async () => {
  const c = await pool();
  const stored = c.repository.state!.plans[0]!;
  stored.tasks[0]!.helperEfforts = [{ membershipId: "pm2", durationEstimate: stored.tasks[0]!.durationEstimate }];
  await assert.rejects(c.service.claimDraftTask(member, "p1", c.plan.id, "t1", ownership(stored)), code("INVALID_TASK_HELPER"));
  stored.tasks[0]!.helperEfforts.push(structuredClone(stored.tasks[0]!.helperEfforts[0]!));
  await assert.rejects(c.service.assignDraftTask(manager, "p1", c.plan.id, "t1", { ...ownership(stored, "t1", "duplicates"), ownerMembershipId: "pm1" }), code("INVALID_TASK_HELPER"));
  assert.equal(c.repository.state!.plans[0]!.tasks[0]!.ownerMembershipId, null);
});

test("task revisions and plan revisions are both compared before ownership changes", async () => {
  const c = await pool();
  await assert.rejects(c.service.claimDraftTask(member, "p1", c.plan.id, "t1", { ...ownership(c.plan), expectedTaskRevision: 4 }), code("VERSION_CONFLICT"));
  await assert.rejects(c.service.claimDraftTask(member, "p1", c.plan.id, "t1", { ...ownership(c.plan), expectedRevision: 4 }), code("VERSION_CONFLICT"));
  await assert.rejects(c.service.claimDraftTask(member, "p1", c.plan.id, "missing", ownership(c.plan)), code("NOT_FOUND"));
  assert.equal(c.repository.state?.revision, 1);
});

test("source input changes reject a claim and remain visibly stale until manager revalidates", async () => {
  const c = await pool(); c.facts.availabilityVersions.pm2 = 2;
  assert.equal((await c.service.getTaskPool(member, "p1")).inputVersionsChanged, true);
  await assert.rejects(c.service.claimDraftTask(member, "p1", c.plan.id, "t1", ownership(c.plan)), code("TASK_POOL_STALE"));
  assert.equal(c.repository.state?.plans[0]?.tasks[0]?.ownerMembershipId, null);
});

test("a changed applied task baseline cannot be overwritten by a stale pool", async () => {
  const c = setup();
  const original = await c.service.createDraft(manager, "p1", c.draft());
  await c.service.apply(manager, "p1", original.id, { expectedRevision: original.revision, acknowledgedIssueCodes: original.validation!.issues.map(issue => issue.code), idempotencyKey: "apply" });
  const draft = await c.service.createDraft(manager, "p1", c.draft({ expectedTasksRevision: 1, basePlanVersionId: original.id, tasks: c.draft().tasks.map(task => task.id === "t1" ? { ...task, ownerMembershipId: null } : task) }));
  await c.service.updateProgress(member, "p1", "t1", { expectedRevision: 0, status: "in_progress", remainingEstimate: null, blocker: null, evidenceRefs: [], note: "已开始", idempotencyKey: "progress" });
  assert.equal((await c.service.getTaskPool(member, "p1")).inputVersionsChanged, true);
  const storedDraft = c.repository.state!.plans.find(plan => plan.id === draft.id)!;
  await assert.rejects(c.service.claimDraftTask(manager, "p1", draft.id, "t1", ownership(storedDraft)), code("TASK_POOL_STALE"));
  assert.equal(c.repository.state?.tasks[0]?.status, "in_progress");
  assert.equal(c.repository.state?.tasks[0]?.ownerMembershipId, "pm2");
});

test("applied and superseded plans are immutable while an exact successful retry is read only", async () => {
  const c = await pool(); const command = ownership(c.plan);
  const claimed = await c.service.claimDraftTask(member, "p1", c.plan.id, "t1", command);
  await c.service.apply(manager, "p1", c.plan.id, { expectedRevision: claimed.revision, acknowledgedIssueCodes: claimed.validation!.issues.map(issue => issue.code), idempotencyKey: "apply" });
  const current = c.repository.state!.plans[0]!;
  await assert.rejects(c.service.releaseDraftTask(member, "p1", c.plan.id, "t1", ownership(current, "t1", "late-release")), code("PLAN_IMMUTABLE"));
  const before = structuredClone(c.repository.state);
  assert.deepEqual(await c.service.claimDraftTask(member, "p1", c.plan.id, "t1", command), claimed);
  assert.deepEqual(c.repository.state, before);
  c.repository.state!.plans[0]!.status = "superseded";
  await assert.rejects(c.service.assignDraftTask(manager, "p1", c.plan.id, "t1", { ...ownership(current, "t1", "historical"), ownerMembershipId: null }), code("PLAN_IMMUTABLE"));
});

test("started, blocked, submitted, cancelled or accepted draft tasks cannot change ownership", async () => {
  const c = await pool();
  for (const status of ["in_progress", "blocked", "review", "done", "cancelled"] as const) {
    c.repository.state!.plans[0]!.tasks[0]!.status = status;
    await assert.rejects(c.service.assignDraftTask(manager, "p1", c.plan.id, "t1", { ...ownership(c.plan, "t1", status), ownerMembershipId: "pm2" }), code("TASK_OWNERSHIP_LOCKED"));
  }
  const task = c.repository.state!.plans[0]!.tasks[0]!; task.status = "todo";
  task.acceptance = { acceptedByUserId: "manager", acceptedAt: NOW, mode: "manager", evidenceRefs: ["artifact"], note: "历史检查" };
  await assert.rejects(c.service.claimDraftTask(member, "p1", c.plan.id, "t1", ownership(c.plan, "t1", "accepted")), code("TASK_OWNERSHIP_LOCKED"));
  assert.equal(c.repository.state!.plans[0]!.tasks[0]!.ownerMembershipId, null);
});

test("revocation or archive is checked inside the lock, including successful-retry reads", async () => {
  const c = await pool(); const command = ownership(c.plan);
  await c.service.claimDraftTask(member, "p1", c.plan.id, "t1", command);
  c.setLockHook(() => { c.facts.projectArchived = true; });
  await assert.rejects(c.service.claimDraftTask(member, "p1", c.plan.id, "t1", command), code("PROJECT_READ_ONLY"));
  c.facts.projectArchived = false;
  c.setLockHook(() => { c.facts.members = c.facts.members.map(item => item.userId === member.userId ? { ...item, status: "removed" } : item); });
  await assert.rejects(c.service.claimDraftTask(member, "p1", c.plan.id, "t1", command), code("NOT_FOUND"));
});

test("read and final write both recheck membership after asynchronous reads", async () => {
  const readContext = await pool(); const originalRead = readContext.repository.read.bind(readContext.repository);
  readContext.repository.read = async projectId => {
    const state = await originalRead(projectId);
    readContext.facts.members = readContext.facts.members.filter(item => item.userId !== member.userId);
    return state;
  };
  await assert.rejects(readContext.service.getTaskPool(member, "p1"), code("NOT_FOUND"));

  const c = await pool(); let reads = 0;
  const service = new PlanningService({ repository: c.repository,
    access: { async getMembership(projectId, userId) { reads++; if (reads === 3) c.facts.members = c.facts.members.filter(item => item.userId !== member.userId); return c.facts.members.find(item => item.projectId === projectId && item.userId === userId) ?? null; } },
    facts: { async readInput() { return structuredClone(c.facts); }, async lockVersions() { return structuredClone(c.facts); } },
    clock: { now: () => new Date(NOW) }, ids: { next: () => "last-check-event" },
  });
  const before = structuredClone(c.repository.state);
  await assert.rejects(service.claimDraftTask(member, "p1", c.plan.id, "t1", ownership(c.plan)), code("NOT_FOUND"));
  assert.deepEqual(c.repository.state, before);
});

test("manager demotion before save cannot release another member's task", async () => {
  const c = await pool();
  const claimed = await c.service.claimDraftTask(member, "p1", c.plan.id, "t1", ownership(c.plan));
  let reads = 0;
  const service = new PlanningService({ repository: c.repository,
    access: { async getMembership(projectId, userId) { reads++; if (reads === 3) c.facts.members = c.facts.members.map(item => item.userId === manager.userId ? { ...item, role: "member" } : item); return c.facts.members.find(item => item.projectId === projectId && item.userId === userId) ?? null; } },
    facts: { async readInput() { return structuredClone(c.facts); }, async lockVersions() { return structuredClone(c.facts); } },
    clock: { now: () => new Date(NOW) }, ids: { next: () => "demotion-event" },
  });
  const before = structuredClone(c.repository.state);
  await assert.rejects(service.releaseDraftTask(manager, "p1", c.plan.id, "t1", ownership(claimed, "t1", "release-as-manager")), code("FORBIDDEN"));
  assert.deepEqual(c.repository.state, before);
});

test("resource publication changes reject ownership and keep the exact historical pin", async () => {
  const c = setup(); c.facts.approvedResourceIds = ["guide"]; c.facts.resourceContentVersions = { guide: 1 };
  const tasks = c.draft().tasks.map(task => task.id === "t1" ? { ...task, ownerMembershipId: null, resourceRefs: ["guide"] } : task);
  const plan = await c.service.createDraft(manager, "p1", c.draft({ tasks }));
  c.facts.resourceContentVersions.guide = 2;
  assert.equal((await c.service.getTaskPool(member, "p1")).inputVersionsChanged, true);
  await assert.rejects(c.service.claimDraftTask(member, "p1", plan.id, "t1", ownership(plan)), code("TASK_POOL_STALE"));
  assert.deepEqual(c.repository.state!.plans[0]!.tasks[0]!.resourceContentRefs, [{ resourceId: "guide", version: 1 }]);
  assert.equal(c.repository.state!.plans[0]!.tasks[0]!.ownerMembershipId, null);
});

test("claim recalculates real capacity risk; it never promises the plan is feasible", async () => {
  const c = await pool();
  const task = c.repository.state!.plans[0]!.tasks[0]!;
  task.durationEstimate = { optimisticMinutes: 700, likelyMinutes: 800, pessimisticMinutes: 1000, basis: "工作量较大" };
  const claimed = await c.service.claimDraftTask(member, "p1", c.plan.id, "t1", ownership(c.plan));
  assert.equal(claimed.status, "ready"); assert.equal(claimed.validation?.feasibility, "infeasible");
  await assert.rejects(c.service.apply(manager, "p1", c.plan.id, { expectedRevision: claimed.revision, acknowledgedIssueCodes: [], idempotencyKey: "silent-apply" }), code("UNRESOLVED_CONSTRAINTS"));
  assert.equal(c.repository.state?.currentPlanVersionId, null);
});

test("invalid revisions and empty operation keys never write", async () => {
  const c = await pool(); const before = structuredClone(c.repository.state);
  for (const command of [
    { ...ownership(c.plan), expectedRevision: -1 },
    { ...ownership(c.plan), expectedTaskRevision: 0.1 },
    { ...ownership(c.plan), idempotencyKey: "" },
  ]) await assert.rejects(c.service.claimDraftTask(member, "p1", c.plan.id, "t1", command), code("INVALID_INPUT"));
  await assert.rejects(c.service.claimDraftTask(outsider, "p1", c.plan.id, "t1", ownership(c.plan)), code("NOT_FOUND"));
  assert.deepEqual(c.repository.state, before);
});

/** Real isolated JSONB transactions. Never opens the application's persistent directory. */
async function sqlFixture() {
  const engine = new PGlite(); await engine.waitReady;
  await engine.exec(await readFile(new URL("./migrations/001-planning.sql", import.meta.url), "utf8"));
  let failOutbox = false;
  const wrap = (query: PGlite["query"]): SqlExecutor => ({
    async query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<SqlResult<Row>> {
      if (failOutbox && statement.startsWith("INSERT INTO planning_outbox")) { failOutbox = false; throw new Error("Injected outbox failure"); }
      const result = await query<Row>(statement, [...parameters]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  });
  const direct = wrap(engine.query.bind(engine));
  const database: DatabasePort = { query: (statement, parameters) => direct.query(statement, parameters),
    transaction: work => engine.transaction(tx => work(wrap(tx.query.bind(tx)))),
  };
  const input = inputFixture();
  input.memberIntentionRefs = [{ membershipId: "pm1", revision: 1 }, { membershipId: "pm2", revision: 1 }];
  let ids = 0;
  const repository = createPostgresPlanningRepository(database);
  const makeService = () => new PlanningService({ repository,
    access: { async getMembership(projectId, userId) { return input.members.find(item => item.projectId === projectId && item.userId === userId) ?? null; } },
    facts: { async readInput() { return structuredClone(input); }, async lockVersions(_projectId, sql) { await sql.query("SELECT 1 AS locked_fact_probe"); return structuredClone(input); } },
    clock: { now: () => new Date(NOW) }, ids: { next: () => `claim-sql-${++ids}` },
  });
  const service = makeService(); const c = setup();
  const plan = await service.createDraft(manager, "p1", c.draft({ tasks: c.draft().tasks.map(task => task.id === "t1" ? { ...task, ownerMembershipId: null } : task) }));
  return { engine, input, repository, service, makeService, plan, failNextOutbox: () => { failOutbox = true; } };
}

test("real JSONB claim survives object-key ordering and reconnects to the same checked snapshot", async () => {
  const c = await sqlFixture();
  try {
    const stored = (await c.repository.read("p1"))!.plans[0]!;
    assert.notEqual(JSON.stringify(stored.inputSnapshot.memberIntentionRefs), JSON.stringify(c.input.memberIntentionRefs), "JSONB should rearrange keys in this regression fixture");
    const command = ownership(stored);
    const result = await c.service.claimDraftTask(member, "p1", stored.id, "t1", command);
    assert.equal(result.status, "ready");
    assert.deepEqual(await c.makeService().claimDraftTask(member, "p1", stored.id, "t1", command), result);
    assert.equal((await c.repository.read("p1"))!.plans[0]!.tasks[0]!.ownerMembershipId, "pm2");
    const events = await c.engine.query<{ count: string }>("SELECT count(*)::text AS count FROM planning_outbox");
    assert.equal(events.rows[0]?.count, "2");
    const snapshots = await c.engine.query<{ result_json: PlanVersion }>("SELECT result_json FROM planning_idempotency WHERE scope LIKE '%draft_task_claim%' ");
    assert.equal(snapshots.rows[0]?.result_json.tasks[0]?.ownerMembershipId, "pm2");
  } finally { await c.engine.close(); }
});

test("real SQL rollback keeps ownership, revision, outbox and retry marker atomic", async () => {
  const c = await sqlFixture();
  try {
    const before = await c.repository.read("p1"); const command = ownership(c.plan);
    c.failNextOutbox();
    await assert.rejects(c.service.claimDraftTask(member, "p1", c.plan.id, "t1", command), /Injected outbox failure/);
    assert.deepEqual(await c.repository.read("p1"), before);
    const count = await c.engine.query<{ count: string }>("SELECT count(*)::text AS count FROM planning_idempotency WHERE scope LIKE '%draft_task_claim%'");
    assert.equal(count.rows[0]?.count, "0");
    const result = await c.service.claimDraftTask(member, "p1", c.plan.id, "t1", command);
    assert.equal(result.tasks[0]?.ownerMembershipId, "pm2"); assert.equal(result.revision, 1);
  } finally { await c.engine.close(); }
});

test("real SQL concurrent claims have one winner and manager confirmation remains mandatory", async () => {
  const c = await sqlFixture();
  try {
    const results = await Promise.allSettled([
      c.service.claimDraftTask(member, "p1", c.plan.id, "t1", ownership(c.plan, "t1", "first")),
      c.service.claimDraftTask(manager, "p1", c.plan.id, "t1", ownership(c.plan, "t1", "second")),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const state = (await c.repository.read("p1"))!;
    assert.equal(state.currentPlanVersionId, null); assert.deepEqual(state.tasks, []); assert.equal(state.tasksRevision, 0);
    const plan = state.plans[0]!;
    await assert.rejects(c.service.apply(member, "p1", plan.id, { expectedRevision: plan.revision, acknowledgedIssueCodes: [], idempotencyKey: "member-apply" }), code("FORBIDDEN"));
    const applied = await c.service.apply(manager, "p1", plan.id, { expectedRevision: plan.revision, acknowledgedIssueCodes: plan.validation!.issues.map(issue => issue.code), idempotencyKey: "manager-apply" });
    assert.equal(applied.status, "applied");
    assert.deepEqual(await c.service.getTaskPool(member, "p1"), { plan: null, tasks: [], inputVersionsChanged: false });
  } finally { await c.engine.close(); }
});
