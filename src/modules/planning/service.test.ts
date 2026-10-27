import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../shared/errors.ts";
import type { ProgressCommand } from "./service.ts";
import { manager, member, outsider, setup, taskProposal } from "./testing/fixtures.ts";

function code(expected: string) { return (error: unknown) => error instanceof DomainError && error.code === expected; }
const progress = (overrides: Partial<ProgressCommand> = {}): ProgressCommand => ({ expectedRevision: 0, status: "in_progress", remainingEstimate: null, blocker: null, evidenceRefs: [], note: "开始工作", idempotencyKey: "progress1", ...overrides });
async function applied() {
  const context = setup(); const plan = await context.service.createDraft(manager, "p1", context.draft());
  assert.equal(plan.validation?.structuralValid, true, JSON.stringify(plan.validation?.issues));
  const codes = plan.validation?.issues.map(issue => issue.code) ?? [];
  await context.service.apply(manager, "p1", plan.id, { expectedRevision: 0, acknowledgedIssueCodes: codes, idempotencyKey: "apply1" });
  return context;
}

test("project outsiders including platform admin cannot read; member cannot apply", async () => {
  const c = setup();
  await assert.rejects(c.service.getCurrent(outsider, "p1"), code("NOT_FOUND"));
  await assert.rejects(c.service.createDraft(member, "p1", c.draft()), code("FORBIDDEN"));
  const plan = await c.service.createDraft(manager, "p1", c.draft());
  await assert.rejects(c.service.apply(member, "p1", plan.id, { expectedRevision: 0, acknowledgedIssueCodes: [], idempotencyKey: "apply" }), code("FORBIDDEN"));
  assert.equal(c.repository.state?.currentPlanVersionId, null);
});
test("draft remains separate; applying twice is idempotent and preserves old plan", async () => {
  const c = setup(); const command = c.draft();
  const first = await c.service.createDraft(manager, "p1", command);
  assert.deepEqual(await c.service.createDraft(manager, "p1", command), first);
  assert.equal((await c.service.getCurrent(manager, "p1")).plan, null);
  const apply = { expectedRevision: 0, acknowledgedIssueCodes: first.validation?.issues.map(issue => issue.code) ?? [], idempotencyKey: "apply" };
  const result = await c.service.apply(manager, "p1", first.id, apply);
  assert.deepEqual(await c.service.apply(manager, "p1", first.id, apply), result);
  assert.equal(c.repository.events.filter(event => event.type === "PlanApplied").length, 1);
  const next = await c.service.createDraft(manager, "p1", c.draft({ basePlanVersionId: first.id, expectedTasksRevision: 1, tasks: c.draft().tasks.map(task => ({ ...task, title: task.id === "t1" ? "新的范围说明" : task.title })) }));
  assert.equal(next.changes.some(change => change.fields.includes("title")), true);
  await c.service.apply(manager, "p1", next.id, { expectedRevision: 0, acknowledgedIssueCodes: next.validation?.issues.map(issue => issue.code) ?? [], idempotencyKey: "apply2" });
  const history = await c.service.listHistory(manager, "p1");
  assert.equal(history.length, 2); assert.equal(history[0]?.status, "superseded");
  assert.equal(history[0]?.tasks[0]?.title, "t1"); assert.equal(history[1]?.status, "applied");
});
test("same idempotency key with a different draft body is rejected", async () => {
  const c = setup(); const command = c.draft(); await c.service.createDraft(manager, "p1", command);
  await assert.rejects(c.service.createDraft(manager, "p1", { ...command, reason: "不同内容" }), code("IDEMPOTENCY_CONFLICT"));
  assert.equal(c.repository.state?.plans.length, 1);
});
test("progress after draft makes apply conflict and never overwrites new work", async () => {
  const c = await applied(); const old = c.repository.state?.currentPlanVersionId ?? null;
  const draft = await c.service.createDraft(manager, "p1", c.draft({ expectedTasksRevision: 1, basePlanVersionId: old }));
  await c.service.updateProgress(member, "p1", "t1", progress());
  await assert.rejects(c.service.apply(manager, "p1", draft.id, { expectedRevision: 0, acknowledgedIssueCodes: [], idempotencyKey: "later" }), code("VERSION_CONFLICT"));
  assert.equal(c.repository.state?.tasks[0]?.status, "in_progress");
  assert.equal(c.repository.state?.currentPlanVersionId, old);
  assert.equal(c.repository.state?.plans.find(plan => plan.id === draft.id)?.status, "stale");
});
test("external input revision change rejects apply and stale view is explicit", async () => {
  const c = setup(); const plan = await c.service.createDraft(manager, "p1", c.draft());
  c.facts.availabilityVersions.pm2 = 2;
  const view = await c.service.getDiff(manager, "p1", plan.id);
  assert.equal(view.staleInputs, true); assert.equal(view.status, "stale");
  await assert.rejects(c.service.apply(manager, "p1", plan.id, { expectedRevision: 0, acknowledgedIssueCodes: [], idempotencyKey: "apply" }), code("VERSION_CONFLICT"));
  assert.equal(c.repository.state?.currentPlanVersionId, null);
});
test("review, acceptance and append-only corrections preserve evidence", async () => {
  const c = await applied();
  await assert.rejects(c.service.updateProgress(member, "p1", "t1", progress({ status: "done", evidenceRefs: ["commit:1"], note: "自称完成" })), code("INVALID_TRANSITION"));
  const started = await c.service.updateProgress(member, "p1", "t1", progress());
  const review = await c.service.updateProgress(member, "p1", "t1", progress({ expectedRevision: 1, status: "review", evidenceRefs: ["artifact:1"], idempotencyKey: "review", correctionOf: started.id, correctionReason: "补充交付" }));
  await assert.rejects(c.service.updateProgress(member, "p1", "t1", progress({ expectedRevision: 2, status: "done", evidenceRefs: ["artifact:1"], idempotencyKey: "bad_done" })), code("FORBIDDEN"));
  const done = await c.service.updateProgress(manager, "p1", "t1", progress({ expectedRevision: 2, status: "done", evidenceRefs: ["artifact:1"], note: "按核心演示验收通过", idempotencyKey: "done" }));
  assert.equal(done.acceptance?.mode, "manager");
  assert.equal(c.repository.state?.progressUpdates.length, 3);
  assert.equal(review.correctionOf, started.id);
  await assert.rejects(c.service.updateProgress(manager, "p1", "t1", progress({ expectedRevision: 3, idempotencyKey: "reopen" })), code("INVALID_TRANSITION"));
  const snapshot = c.repository.state!;
  await assert.rejects(c.service.createDraft(manager, "p1", c.draft({ expectedTasksRevision: snapshot.tasksRevision, basePlanVersionId: snapshot.currentPlanVersionId, tasks: c.draft().tasks.map(task => task.id === "t1" ? { ...task, cancel: true } : task) })), code("REQUIRED_TASK_CANCELLED"));
});
test("member cannot update another member task and stale writes serialize", async () => {
  const c = await applied();
  await assert.rejects(c.service.updateProgress(member, "p1", "submission", progress()), code("FORBIDDEN"));
  const results = await Promise.allSettled([c.service.updateProgress(member, "p1", "t1", progress()), c.service.updateProgress(member, "p1", "t1", progress({ idempotencyKey: "second" }))]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(c.repository.state?.progressUpdates.length, 1);
});
test("final acceptance cannot bypass unfinished predecessor deliverables", async () => {
  const c = await applied();
  await c.service.updateProgress(member, "p1", "testing", progress({ status: "review", evidenceRefs: ["test-report"], idempotencyKey: "review_testing" }));
  await assert.rejects(c.service.updateProgress(manager, "p1", "testing", progress({ expectedRevision: 1, status: "done", evidenceRefs: ["test-report"], note: "声称通过", idempotencyKey: "done_testing" })), code("DEPENDENCY_NOT_ACCEPTED"));
  assert.equal(c.repository.state!.tasks.find(task => task.id === "testing")?.status, "review");
});
test("infeasible discussion plan requires explicit issue acknowledgment", async () => {
  const c = setup(); const tasks = c.draft().tasks;
  tasks[0] = taskProposal("t1", { durationEstimate: { optimisticMinutes: 700, likelyMinutes: 800, pessimisticMinutes: 1000, basis: "真实剩余工作" } });
  const plan = await c.service.createDraft(manager, "p1", c.draft({ tasks }));
  assert.equal(plan.status, "ready"); assert.equal(plan.validation?.feasibility, "infeasible");
  await assert.rejects(c.service.apply(manager, "p1", plan.id, { expectedRevision: 0, acknowledgedIssueCodes: [], idempotencyKey: "blocked_apply" }), code("UNRESOLVED_CONSTRAINTS"));
  const result = await c.service.apply(manager, "p1", plan.id, { expectedRevision: 0, acknowledgedIssueCodes: plan.validation!.issues.map(issue => issue.code), idempotencyKey: "ack_apply" });
  assert.equal(result.status, "applied"); assert.equal(result.validation?.feasibility, "infeasible");
});
test("new unapproved resource is rejected; no silent reference invention", async () => {
  const c = setup(); const tasks = c.draft().tasks; tasks[0]!.resourceRefs = ["https://invented.invalid/tool"];
  await assert.rejects(c.service.createDraft(manager, "p1", c.draft({ tasks })), code("UNAPPROVED_RESOURCE"));
  assert.equal(c.repository.state, null);
});
test("manual editing revalidates a stale draft, while applied history remains immutable", async () => {
  const c = await applied(); const state = c.repository.state!;
  const draft = await c.service.createDraft(manager, "p1", c.draft({ basePlanVersionId: state.currentPlanVersionId, expectedTasksRevision: state.tasksRevision }));
  await c.service.updateProgress(member, "p1", "t1", progress());
  const stale = c.repository.state!.plans.find(plan => plan.id === draft.id)!;
  const edited = await c.service.editDraft(manager, "p1", draft.id, { tasks: c.draft().tasks, buffers: c.draft().buffers, reason: "依据新进度修正", expectedRevision: stale.revision, expectedTasksRevision: c.repository.state!.tasksRevision, idempotencyKey: "edit" });
  assert.equal(edited.status, "ready"); assert.equal(edited.tasks[0]?.status, "in_progress");
  await assert.rejects(c.service.editDraft(manager, "p1", state.currentPlanVersionId!, { tasks: c.draft().tasks, buffers: c.draft().buffers, reason: "直接改历史", expectedRevision: 1, expectedTasksRevision: 2, idempotencyKey: "badedit" }), code("PLAN_IMMUTABLE"));
});
test("apply re-reads server time after waiting for the transaction lock", async () => {
  const c = setup(); const plan = await c.service.createDraft(manager, "p1", c.draft());
  c.setLockHook(() => c.setNow("2026-10-08T11:00:00Z"));
  await assert.rejects(c.service.apply(manager, "p1", plan.id, { expectedRevision: 0, acknowledgedIssueCodes: [], idempotencyKey: "delayed" }), code("UNRESOLVED_CONSTRAINTS"));
  assert.equal(c.repository.state?.currentPlanVersionId, null);
});
test("restore reopens an explicitly cancelled optional task as a new draft", async () => {
  const c = setup(); const extra = taskProposal("extra", { priority: "optional", requirementRefs: [] });
  const first = await c.service.createDraft(manager, "p1", c.draft({ tasks: [...c.draft().tasks, extra] }));
  await c.service.apply(manager, "p1", first.id, { expectedRevision: 0, acknowledgedIssueCodes: first.validation!.issues.map(issue => issue.code), idempotencyKey: "first" });
  const second = await c.service.createDraft(manager, "p1", c.draft({ tasks: [...c.draft().tasks, { ...extra, cancel: true, cancellationReason: "先保核心" }], basePlanVersionId: first.id, expectedTasksRevision: 1 }));
  await c.service.apply(manager, "p1", second.id, { expectedRevision: 0, acknowledgedIssueCodes: second.validation!.issues.map(issue => issue.code), idempotencyKey: "second" });
  assert.equal(c.repository.state!.tasks.find(task => task.id === "extra")?.status, "cancelled");
  const restored = await c.service.restoreAsDraft(manager, "p1", first.id, { basePlanVersionId: second.id, expectedTasksRevision: 2, reason: "恢复可选范围并重新校验", idempotencyKey: "restore" });
  assert.equal(restored.tasks.find(task => task.id === "extra")?.status, "todo");
  assert.equal(c.repository.state!.tasks.find(task => task.id === "extra")?.status, "cancelled");
  assert.equal(restored.changes.some(change => change.taskId === "extra" && change.fields.includes("status")), true);
});
test("formal deadline change is visible even when task deadlineRef stays identical", async () => {
  const c = await applied(); c.facts.deadlines[0]!.instantUtc = "2026-10-08T09:00:00Z"; c.facts.requirementVersionId = "rv2";
  const draft = await c.service.createDraft(manager, "p1", c.draft({ basePlanVersionId: c.repository.state!.currentPlanVersionId, expectedTasksRevision: 1 }));
  assert.equal(draft.changes.some(change => change.action === "input_changed" && change.fields.includes("deadlines") && change.major), true);
});
test("retired historical resource keeps ID and manual work, while new reuse is rejected", async () => {
  const c = setup(); c.facts.approvedResourceIds = ["good"];
  const tasks = c.draft().tasks; tasks[0]!.resourceRefs = ["good"];
  const plan = await c.service.createDraft(manager, "p1", c.draft({ tasks }));
  await c.service.apply(manager, "p1", plan.id, { expectedRevision: 0, acknowledgedIssueCodes: plan.validation!.issues.map(issue => issue.code), idempotencyKey: "apply" });
  c.facts.approvedResourceIds = [];
  const view = await c.service.getCurrent(manager, "p1");
  assert.deepEqual(view.tasks[0]?.resourceRefs, ["good"]);
  assert.equal(view.evaluation?.structuralValid, true);
  assert.equal(view.evaluation?.issues.some(issue => issue.code === "HISTORICAL_RESOURCE_UNAVAILABLE"), true);
  tasks[1]!.resourceRefs = ["good"];
  await assert.rejects(c.service.createDraft(manager, "p1", c.draft({ tasks, basePlanVersionId: plan.id, expectedTasksRevision: 1 })), code("UNAPPROVED_RESOURCE"));
});
