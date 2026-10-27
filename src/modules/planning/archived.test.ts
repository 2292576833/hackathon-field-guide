import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../shared/errors.ts";
import type { ProgressCommand } from "./service.ts";
import { manager, member, setup } from "./testing/fixtures.ts";

const readOnly = (error: unknown): boolean => error instanceof DomainError && error.code === "PROJECT_READ_ONLY" && error.status === 409;
const progress = (idempotencyKey: string): ProgressCommand => ({ expectedRevision: 0, status: "in_progress", remainingEstimate: null, blocker: null, evidenceRefs: [], note: "开始核心工作", idempotencyKey });

async function applied() {
  const context = setup();
  const plan = await context.service.createDraft(manager, "p1", context.draft());
  assert.equal(plan.validation?.structuralValid, true);
  await context.service.apply(manager, "p1", plan.id, {
    expectedRevision: plan.revision,
    acknowledgedIssueCodes: plan.validation?.issues.map(issue => issue.code) ?? [],
    idempotencyKey: "apply-initial",
  });
  return context;
}

for (const flag of ["projectArchived", "projectReadOnly"] as const) {
  test(`${flag}: creating a draft is rejected without initializing planning state`, async () => {
    const c = setup();
    c.facts[flag] = true;
    await assert.rejects(c.service.createDraft(manager, "p1", c.draft()), readOnly);
    assert.equal(c.repository.state, null);
    assert.deepEqual(c.repository.events, []);
  });

  test(`${flag}: applying a draft checks the final locked facts and preserves the unapplied draft`, async () => {
    const c = setup();
    const plan = await c.service.createDraft(manager, "p1", c.draft());
    const before = structuredClone(c.repository.state);
    const eventsBefore = structuredClone(c.repository.events);
    c.setLockHook(() => { c.facts[flag] = true; });

    await assert.rejects(c.service.apply(manager, "p1", plan.id, {
      expectedRevision: plan.revision,
      acknowledgedIssueCodes: plan.validation?.issues.map(issue => issue.code) ?? [],
      idempotencyKey: "apply-after-lock",
    }), readOnly);
    assert.deepEqual(c.repository.state, before);
    assert.deepEqual(c.repository.events, eventsBefore);
    assert.equal(c.repository.state?.currentPlanVersionId, null);
    assert.equal(c.repository.state?.plans[0]?.appliedAt, null);
  });

  test(`${flag}: editing and progress updates are rejected while current plan and history remain readable`, async () => {
    const c = await applied();
    const currentId = c.repository.state!.currentPlanVersionId;
    const plan = await c.service.createDraft(manager, "p1", c.draft({
      basePlanVersionId: currentId,
      expectedTasksRevision: c.repository.state!.tasksRevision,
    }));
    const before = structuredClone(c.repository.state);
    const eventsBefore = structuredClone(c.repository.events);
    c.facts[flag] = true;

    await assert.rejects(c.service.editDraft(manager, "p1", plan.id, {
      tasks: c.draft().tasks,
      buffers: c.draft().buffers,
      reason: "调整归档项目的范围",
      expectedRevision: plan.revision,
      expectedTasksRevision: before!.tasksRevision,
      idempotencyKey: "edit-readonly",
    }), readOnly);
    await assert.rejects(c.service.updateProgress(member, "p1", "t1", progress("progress-readonly")), readOnly);
    assert.deepEqual(c.repository.state, before);
    assert.deepEqual(c.repository.events, eventsBefore);

    const view = await c.service.getCurrent(member, "p1");
    assert.equal(view.plan?.id, currentId);
    assert.deepEqual(view.tasks, before!.tasks);
    assert.deepEqual(await c.service.listHistory(member, "p1"), before!.plans);
    assert.deepEqual(c.repository.state, before);
  });
}

test("a project archived while editing a draft retains the prior applied plan and draft revision", async () => {
  const c = await applied();
  const plan = await c.service.createDraft(manager, "p1", c.draft({
    basePlanVersionId: c.repository.state!.currentPlanVersionId,
    expectedTasksRevision: c.repository.state!.tasksRevision,
  }));
  const before = structuredClone(c.repository.state);
  const eventsBefore = structuredClone(c.repository.events);
  c.setLockHook(() => { c.facts.projectArchived = true; });
  await assert.rejects(c.service.editDraft(manager, "p1", plan.id, {
    tasks: c.draft().tasks,
    buffers: c.draft().buffers,
    reason: "等待锁后编辑",
    expectedRevision: plan.revision,
    expectedTasksRevision: before!.tasksRevision,
    idempotencyKey: "edit-after-archive",
  }), readOnly);
  assert.deepEqual(c.repository.state, before);
  assert.deepEqual(c.repository.events, eventsBefore);
});

test("a project archived while updating progress cannot append progress or stale existing plans", async () => {
  const c = await applied();
  const before = structuredClone(c.repository.state);
  const eventsBefore = structuredClone(c.repository.events);
  c.setLockHook(() => { c.facts.projectArchived = true; });
  await assert.rejects(c.service.updateProgress(member, "p1", "t1", progress("progress-after-archive")), readOnly);
  assert.deepEqual(c.repository.state, before);
  assert.deepEqual(c.repository.events, eventsBefore);
});

test("a manager downgraded during the final input lock cannot apply a draft or alter the current plan", async () => {
  const c = await applied();
  const plan = await c.service.createDraft(manager, "p1", c.draft({
    basePlanVersionId: c.repository.state!.currentPlanVersionId,
    expectedTasksRevision: c.repository.state!.tasksRevision,
  }));
  const before = structuredClone(c.repository.state);
  const eventsBefore = structuredClone(c.repository.events);
  c.setLockHook(() => {
    c.facts.members = c.facts.members.map(membership => membership.userId === manager.userId ? { ...membership, role: "member" } : membership);
  });
  await assert.rejects(c.service.apply(manager, "p1", plan.id, {
    expectedRevision: plan.revision,
    acknowledgedIssueCodes: plan.validation?.issues.map(issue => issue.code) ?? [],
    idempotencyKey: "apply-after-manager-downgrade",
  }), (error: unknown) => error instanceof DomainError && error.code === "FORBIDDEN" && error.status === 403);
  assert.deepEqual(c.repository.state, before);
  assert.deepEqual(c.repository.events, eventsBefore);
});
