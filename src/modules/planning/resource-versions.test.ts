import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../shared/errors.ts";
import { parseTaskProposal } from "./parse.ts";
import type { TaskProposal } from "./service.ts";
import type { PlanVersion, PlanningIssue } from "./types.ts";
import { manager, member, setup, taskProposal } from "./testing/fixtures.ts";

type Context = ReturnType<typeof setup>;
const pin = (version: number) => [{ resourceId: "good", version }];
const code = (expected: string) => (error: unknown): boolean => error instanceof DomainError && error.code === expected;
const codes = (plan: PlanVersion): string[] => [...new Set(plan.validation?.issues.map(issue => issue.code) ?? [])];
function hasIssue(issues: readonly PlanningIssue[] | undefined, expected: string): void {
  assert.equal(issues?.some(issue => issue.code === expected), true, `${expected}: ${JSON.stringify(issues)}`);
}
function context(version = 1): Context {
  const c = setup();
  c.facts.approvedResourceIds = ["good"];
  c.facts.resourceContentVersions = { good: version };
  return c;
}
function tasks(c: Context, overrides: Partial<TaskProposal> = {}): TaskProposal[] {
  return c.draft().tasks.map(task => task.id === "t1" ? { ...task, resourceRefs: ["good"], ...overrides } : task);
}
async function create(c: Context, overrides: Partial<TaskProposal> = {}): Promise<PlanVersion> {
  return c.service.createDraft(manager, "p1", c.draft({
    tasks: tasks(c, overrides),
    basePlanVersionId: c.repository.state?.currentPlanVersionId ?? null,
    expectedTasksRevision: c.repository.state?.tasksRevision ?? 0,
  }));
}
async function apply(c: Context, plan: PlanVersion, idempotencyKey: string): Promise<PlanVersion> {
  return c.service.apply(manager, "p1", plan.id, {
    expectedRevision: plan.revision,
    acknowledgedIssueCodes: codes(plan),
    idempotencyKey,
  });
}
async function applied(): Promise<Context> {
  const c = context();
  await apply(c, await create(c), "initial-apply");
  return c;
}

test("a new string resource ID pins the server's reviewed public content version and snapshot", async () => {
  const c = context(7);
  const plan = await create(c);
  assert.deepEqual(plan.tasks.find(task => task.id === "t1")?.resourceRefs, ["good"]);
  assert.deepEqual(plan.tasks.find(task => task.id === "t1")?.resourceContentRefs, pin(7));
  assert.deepEqual(plan.resourceReviewRequiredRefs, [{ taskId: "t1", resourceId: "good", version: 7 }]);
  assert.equal(plan.inputSnapshot.resourceContentVersions?.good, 7);
  assert.deepEqual(c.repository.state?.plans[0], plan);
  assert.equal(c.repository.state?.currentPlanVersionId, null);
});

test("client-supplied resource versions cannot assert review or replace a server pin", async () => {
  const c = context();
  const forged = { ...taskProposal("t1", { resourceRefs: ["good"] }), resourceContentRefs: pin(999) };
  assert.throws(() => parseTaskProposal(forged), code("INVALID_INPUT"));
  await assert.rejects(c.service.createDraft(manager, "p1", c.draft({ tasks: [forged, ...c.draft().tasks.slice(1)] })), code("INVALID_INPUT"));
  assert.equal(c.repository.state, null);
  assert.deepEqual(c.repository.events, []);
});

test("a public version change before draft application rejects the new reference without losing the draft", async () => {
  const c = context();
  const plan = await create(c);
  const before = structuredClone(c.repository.state);
  const eventsBefore = structuredClone(c.repository.events);
  c.facts.resourceContentVersions = { good: 2 };
  await assert.rejects(apply(c, plan, "apply-old-new-reference"), code("RESOURCE_REFS_UNAVAILABLE"));
  assert.deepEqual(c.repository.state, before);
  assert.deepEqual(c.repository.events, eventsBefore);
  assert.deepEqual(c.repository.state?.plans[0]?.tasks[0]?.resourceContentRefs, pin(1));
});

test("publication changing while application waits for the lock is rechecked inside the transaction", async () => {
  const c = context();
  const plan = await create(c);
  const before = structuredClone(c.repository.state);
  c.setLockHook(() => { c.facts.resourceContentVersions = { good: 2 }; });
  await assert.rejects(apply(c, plan, "apply-publication-race"), code("RESOURCE_REFS_UNAVAILABLE"));
  assert.deepEqual(c.repository.state, before);
});

test("title-only editing preserves a pending version 1 pin and cannot bypass required review at apply", async () => {
  const c = context();
  const original = await create(c);
  c.facts.resourceContentVersions = { good: 2 };
  const edited = await c.service.editDraft(manager, "p1", original.id, {
    tasks: tasks(c, { title: "只修改任务名称" }),
    buffers: original.buffers,
    reason: "澄清名称，不更换资源依据",
    expectedRevision: original.revision,
    expectedTasksRevision: 0,
    idempotencyKey: "edit-title",
  });
  assert.deepEqual(edited.tasks[0]?.resourceContentRefs, pin(1));
  assert.deepEqual(edited.resourceReviewRequiredRefs, original.resourceReviewRequiredRefs);
  assert.equal(edited.validation?.staleInputs, true);
  hasIssue(edited.validation?.issues, "RESOURCE_CONTENT_VERSION_CHANGED");
  const view = await c.service.getDiff(manager, "p1", edited.id);
  assert.equal(view.staleInputs, true);
  assert.equal(view.status, "stale");
  const before = structuredClone(c.repository.state);
  await assert.rejects(apply(c, edited, "apply-title-only"), code("RESOURCE_REFS_UNAVAILABLE"));
  assert.deepEqual(c.repository.state, before);
});

test("explicit ID-only refresh pins version 2 and exposes the resource basis change as major", async () => {
  const c = await applied();
  const originalId = c.repository.state!.currentPlanVersionId;
  c.facts.resourceContentVersions = { good: 2 };
  const refreshed = await create(c, { refreshResourceRefs: ["good"] });
  assert.deepEqual(refreshed.tasks[0]?.resourceContentRefs, pin(2));
  assert.deepEqual(refreshed.resourceReviewRequiredRefs, [{ taskId: "t1", resourceId: "good", version: 2 }]);
  const change = refreshed.changes.find(value => value.taskId === "t1" && value.fields.includes("resourceContentRefs"));
  assert.equal(change?.major, true);
  assert.deepEqual(change?.before, { resourceContentRefs: pin(1) });
  assert.deepEqual(change?.after, { resourceContentRefs: pin(2) });
  await apply(c, refreshed, "apply-refreshed");
  assert.deepEqual(c.repository.state!.tasks[0]?.resourceContentRefs, pin(2));
  assert.deepEqual(c.repository.state!.plans.find(plan => plan.id === originalId)?.tasks[0]?.resourceContentRefs, pin(1));
});

test("version 1 applied history is read with a stale risk; a new plan needs explicit acknowledgment to keep it", async () => {
  const c = await applied();
  const originalId = c.repository.state!.currentPlanVersionId;
  const beforeRead = structuredClone(c.repository.state);
  c.facts.resourceContentVersions = { good: 2 };
  const current = await c.service.getCurrent(member, "p1");
  assert.equal(current.staleInputs, true);
  assert.deepEqual(current.tasks[0]?.resourceContentRefs, pin(1));
  hasIssue(current.evaluation?.issues, "RESOURCE_CONTENT_VERSION_CHANGED");
  const diff = await c.service.getDiff(member, "p1", originalId!);
  assert.equal(diff.status, "applied");
  assert.equal(diff.staleInputs, true);
  hasIssue(diff.resourceIssues, "RESOURCE_CONTENT_VERSION_CHANGED");
  assert.deepEqual(c.repository.state, beforeRead);

  const replanned = await create(c, { title: "继续手动工作并复核旧依据" });
  assert.deepEqual(replanned.tasks[0]?.resourceContentRefs, pin(1));
  assert.deepEqual(replanned.resourceReviewRequiredRefs, []);
  assert.equal(replanned.inputSnapshot.resourceContentVersions?.good, 2);
  const beforeApply = structuredClone(c.repository.state);
  await assert.rejects(c.service.apply(manager, "p1", replanned.id, {
    expectedRevision: replanned.revision,
    acknowledgedIssueCodes: codes(replanned).filter(value => value !== "RESOURCE_CONTENT_VERSION_CHANGED"),
    idempotencyKey: "apply-without-resource-ack",
  }), code("UNRESOLVED_CONSTRAINTS"));
  assert.deepEqual(c.repository.state, beforeApply);
  const result = await apply(c, replanned, "apply-retained-history");
  assert.equal(result.acknowledgedIssueCodes.includes("RESOURCE_CONTENT_VERSION_CHANGED"), true);
  assert.deepEqual(c.repository.state!.tasks[0]?.resourceContentRefs, pin(1));
  assert.deepEqual(c.repository.state!.plans.find(plan => plan.id === originalId)?.inputSnapshot.resourceContentVersions, { good: 1 });
});

test("legacy string-only references remain unconfirmed and never get today's version backfilled as history", async () => {
  const c = await applied();
  for (const task of c.repository.state!.tasks) delete task.resourceContentRefs;
  for (const plan of c.repository.state!.plans) {
    for (const task of plan.tasks) delete task.resourceContentRefs;
    delete plan.resourceReviewRequiredRefs;
  }
  c.facts.resourceContentVersions = { good: 2 };
  const beforeRead = structuredClone(c.repository.state);
  const view = await c.service.getCurrent(member, "p1");
  assert.equal(view.tasks[0]?.resourceContentRefs, undefined);
  assert.deepEqual(view.tasks[0]?.resourceRefs, ["good"]);
  assert.equal(view.staleInputs, true);
  hasIssue(view.evaluation?.issues, "RESOURCE_CONTENT_VERSION_UNCONFIRMED");
  assert.deepEqual(c.repository.state, beforeRead);

  const replanned = await create(c);
  assert.equal(replanned.tasks[0]?.resourceContentRefs, undefined);
  assert.deepEqual(replanned.resourceReviewRequiredRefs, []);
  hasIssue(replanned.validation?.issues, "RESOURCE_CONTENT_VERSION_UNCONFIRMED");
  await apply(c, replanned, "apply-legacy-acknowledged");
  assert.equal(c.repository.state!.tasks[0]?.resourceContentRefs, undefined);
});

test("restoring applied version 1 history from a current version 2 plan preserves the old resource basis", async () => {
  const c = await applied();
  const firstId = c.repository.state!.currentPlanVersionId!;
  c.facts.resourceContentVersions = { good: 2 };
  const second = await apply(c, await create(c, { refreshResourceRefs: ["good"] }), "apply-version-two");
  const firstBefore = structuredClone(c.repository.state!.plans.find(plan => plan.id === firstId)!);
  const restored = await c.service.restoreAsDraft(manager, "p1", firstId, {
    basePlanVersionId: second.id,
    expectedTasksRevision: c.repository.state!.tasksRevision,
    reason: "恢复历史方案并复核旧资源依据",
    idempotencyKey: "restore-version-one",
  });
  assert.deepEqual(restored.tasks[0]?.resourceContentRefs, pin(1));
  assert.deepEqual(restored.resourceReviewRequiredRefs, []);
  hasIssue(restored.validation?.issues, "RESOURCE_CONTENT_VERSION_CHANGED");
  assert.equal(restored.changes.some(change => change.taskId === "t1" && change.major && change.fields.includes("resourceContentRefs")), true);
  assert.deepEqual(c.repository.state!.tasks[0]?.resourceContentRefs, pin(2));
  assert.deepEqual(c.repository.state!.plans.find(plan => plan.id === firstId), firstBefore);
  await apply(c, restored, "apply-restored-version-one");
  assert.deepEqual(c.repository.state!.tasks[0]?.resourceContentRefs, pin(1));
  assert.deepEqual(c.repository.state!.plans.find(plan => plan.id === second.id)?.tasks[0]?.resourceContentRefs, pin(2));
});

test("a withdrawn reference removed from current tasks cannot be added back using older applied history", async () => {
  const c = await applied();
  await apply(c, await create(c, { resourceRefs: [] }), "apply-remove-resource");
  c.facts.approvedResourceIds = [];
  c.facts.resourceContentVersions = { good: null };
  const before = structuredClone(c.repository.state);
  const eventsBefore = structuredClone(c.repository.events);
  await assert.rejects(create(c), code("UNAPPROVED_RESOURCE"));
  assert.deepEqual(c.repository.state, before);
  assert.deepEqual(c.repository.events, eventsBefore);
});

test("a cancelled new optional task cannot hide an unknown reference from resource review", async () => {
  const c = context();
  const hidden = taskProposal("cancelled-new", { priority: "optional", requirementRefs: [], resourceRefs: ["unknown"], cancel: true, cancellationReason: "暂不执行" });
  await assert.rejects(c.service.createDraft(manager, "p1", c.draft({ tasks: [...c.draft().tasks, hidden] })), code("UNAPPROVED_RESOURCE"));
  assert.equal(c.repository.state, null);
  assert.deepEqual(c.repository.events, []);
});

test("more than 50 resources are sorted and locked in batches before any version validation in the same transaction", async () => {
  const { PlanningService } = await import("./service.ts");
  const { inputFixture, TestPlanningRepository, NOW, proposals } = await import("./testing/fixtures.ts");
  const repository = new TestPlanningRepository();
  const input = inputFixture();
  const ids = Array.from({ length: 123 }, (_, index) => `resource-${String(index).padStart(3, "0")}`);
  const versions = new Map(ids.map((id, index) => [id, index + 1]));
  input.approvedResourceIds = [...ids].reverse();
  input.resourceContentVersions = Object.fromEntries(versions);
  const proposed = proposals();
  proposed[0]!.resourceRefs = [...ids].reverse();
  proposed[1]!.resourceRefs = [ids[60]!, ids[3]!];
  let transactionSql: unknown;
  let sequence = 0;
  const lockedIds = new Set<string>();
  const trace: { phase: "heads" | "validate"; ids: string[]; sql: unknown }[] = [];
  const service = new PlanningService({
    repository,
    access: { async getMembership(projectId, userId) { return input.members.find(value => value.projectId === projectId && value.userId === userId) ?? null; } },
    facts: {
      async readInput() { return structuredClone(input); },
      async lockVersions(_projectId, sql) { transactionSql = sql; return structuredClone(input); },
    },
    resources: {
      async getDisplayableApprovedIds() { throw new Error("Versioned review must not use the ID-only fallback"); },
      async getReviewedResources(batch, sql) {
        assert.ok(sql);
        assert.equal(sql, transactionSql);
        assert.ok(batch.length > 0 && batch.length <= 50);
        assert.deepEqual(batch, [...batch].sort());
        assert.equal(trace.some(entry => entry.phase === "validate"), false);
        trace.push({ phase: "heads", ids: [...batch], sql });
        for (const id of batch) lockedIds.add(id);
        return batch.map(id => ({ id, version: versions.get(id)! }));
      },
      async validateResourceRefs(refs, sql) {
        assert.ok(sql);
        assert.equal(sql, transactionSql);
        assert.ok(refs.length > 0 && refs.length <= 50);
        assert.deepEqual([...lockedIds].sort(), ids);
        for (const ref of refs) assert.equal(ref.version, versions.get(ref.resourceId));
        trace.push({ phase: "validate", ids: refs.map(ref => ref.resourceId), sql });
        return structuredClone(refs);
      },
    },
    clock: { now() { return new Date(NOW); } },
    ids: { next() { return `batch-${++sequence}`; } },
  });
  const assertBatches = (): void => {
    assert.deepEqual(trace.map(entry => entry.phase), ["heads", "heads", "heads", "validate", "validate", "validate"]);
    for (const phase of ["heads", "validate"] as const) {
      const batches = trace.filter(entry => entry.phase === phase);
      assert.deepEqual(batches.map(batch => batch.ids.length), [50, 50, 23]);
      assert.deepEqual(batches.flatMap(batch => batch.ids), ids);
    }
    assert.equal(new Set(trace.map(entry => entry.sql)).size, 1);
  };
  const plan = await service.createDraft(manager, "p1", setup().draft({ tasks: proposed }));
  assertBatches();
  assert.deepEqual(plan.inputSnapshot.resourceContentVersions, Object.fromEntries(versions));
  assert.equal(plan.tasks[0]?.resourceContentRefs?.length, 123);
  assert.equal(plan.resourceReviewRequiredRefs?.length, 125);
  trace.length = 0;
  lockedIds.clear();
  await service.apply(manager, "p1", plan.id, { expectedRevision: plan.revision, acknowledgedIssueCodes: codes(plan), idempotencyKey: "apply-batch" });
  assertBatches();
  assert.equal(repository.state?.currentPlanVersionId, plan.id);
});

test("restoring unpinned legacy history after the current task removed its ID preserves unknown history at apply", async () => {
  const c = await applied();
  const legacyId = c.repository.state!.currentPlanVersionId!;
  const legacy = c.repository.state!.plans.find(plan => plan.id === legacyId)!;
  for (const task of legacy.tasks) delete task.resourceContentRefs;
  delete legacy.resourceReviewRequiredRefs;
  delete legacy.resourceLegacyRefs;
  await apply(c, await create(c, { resourceRefs: [] }), "apply-remove-before-legacy-restore");
  assert.deepEqual(c.repository.state!.tasks[0]?.resourceRefs, []);
  c.facts.resourceContentVersions = { good: 2 };
  const legacyBefore = structuredClone(c.repository.state!.plans.find(plan => plan.id === legacyId));
  const restored = await c.service.restoreAsDraft(manager, "p1", legacyId, {
    basePlanVersionId: c.repository.state!.currentPlanVersionId,
    expectedTasksRevision: c.repository.state!.tasksRevision,
    reason: "恢复旧依据，保持当时内容版本未知",
    idempotencyKey: "restore-unpinned-history",
  });
  assert.deepEqual(restored.tasks[0]?.resourceRefs, ["good"]);
  assert.equal(restored.tasks[0]?.resourceContentRefs, undefined);
  assert.deepEqual(restored.resourceLegacyRefs, [{ taskId: "t1", resourceId: "good" }]);
  assert.deepEqual(restored.resourceReviewRequiredRefs, []);
  hasIssue(restored.validation?.issues, "RESOURCE_CONTENT_VERSION_UNCONFIRMED");
  const beforeApply = structuredClone(c.repository.state);
  await assert.rejects(c.service.apply(manager, "p1", restored.id, {
    expectedRevision: restored.revision,
    acknowledgedIssueCodes: codes(restored).filter(value => value !== "RESOURCE_CONTENT_VERSION_UNCONFIRMED"),
    idempotencyKey: "legacy-restore-without-ack",
  }), code("UNRESOLVED_CONSTRAINTS"));
  assert.deepEqual(c.repository.state, beforeApply);
  const result = await apply(c, restored, "apply-legacy-restored-with-ack");
  assert.equal(result.tasks[0]?.resourceContentRefs, undefined);
  assert.deepEqual(result.resourceLegacyRefs, [{ taskId: "t1", resourceId: "good" }]);
  assert.deepEqual(c.repository.state!.tasks[0]?.resourceRefs, ["good"]);
  assert.equal(c.repository.state!.tasks[0]?.resourceContentRefs, undefined);
  assert.deepEqual(c.repository.state!.plans.find(plan => plan.id === legacyId), legacyBefore);
});

test("restore idempotency cannot reuse a result for a different source with identical definitions and different pinned versions", async () => {
  const c = await applied();
  const firstId = c.repository.state!.currentPlanVersionId!;
  c.facts.resourceContentVersions = { good: 2 };
  const second = await apply(c, await create(c, { refreshResourceRefs: ["good"] }), "apply-version-two-for-idempotency");
  const first = c.repository.state!.plans.find(plan => plan.id === firstId)!;
  const definition = (plan: PlanVersion) => plan.tasks.map(task => {
    const { resourceContentRefs: _pins, status, remainingEstimate: _remaining, blocker: _blocker, acceptance: _acceptance, revision: _revision, updatedAt: _updated, cancellationReason, ...fields } = task;
    return { ...fields, cancel: status === "cancelled", cancellationReason };
  });
  assert.deepEqual(definition(first), definition(second));
  assert.deepEqual(first.tasks[0]?.resourceContentRefs, pin(1));
  assert.deepEqual(second.tasks[0]?.resourceContentRefs, pin(2));
  const command = {
    basePlanVersionId: second.id,
    expectedTasksRevision: c.repository.state!.tasksRevision,
    reason: "使用相同定义恢复资源依据",
    idempotencyKey: "same-restore-key",
  };
  const restoredFirst = await c.service.restoreAsDraft(manager, "p1", first.id, command);
  assert.deepEqual(await c.service.restoreAsDraft(manager, "p1", first.id, command), restoredFirst);
  assert.deepEqual(restoredFirst.tasks[0]?.resourceContentRefs, pin(1));
  const before = structuredClone(c.repository.state);
  const eventsBefore = structuredClone(c.repository.events);
  await assert.rejects(c.service.restoreAsDraft(manager, "p1", second.id, command), code("IDEMPOTENCY_CONFLICT"));
  assert.deepEqual(c.repository.state, before);
  assert.deepEqual(c.repository.events, eventsBefore);
});
