import assert from "node:assert/strict";
import test from "node:test";
import { editableFromPlanTask, importAssignmentTasks, planningDefinition } from "../components/assignment-plan.ts";
import type { ProposedAssignment } from "../modules/assessments/types.ts";
import type { PlanningDeadline, PlanningTask } from "../modules/planning/types.ts";

const deadline: PlanningDeadline = { id: "submit", kind: "submission", instantUtc: "2026-10-10T12:00:00Z", sourceTimeZone: "Asia/Shanghai", sourceText: "团队已填截止", verified: false };
function assignment(clientTaskId: string, changes: Partial<ProposedAssignment> = {}): ProposedAssignment {
  return { clientTaskId, title: clientTaskId, priority: "must", ownerMembershipId: "owner", helperMembershipIds: [], deliverable: "可演示的作品", acceptanceCriteria: ["完成核心操作"], dependencyTaskIds: [], proposedDeadlineRef: null, reason: "本人确认承担", evidenceLevel: "self_reported", ...changes };
}
function planTask(): PlanningTask {
  return { id: "existing", projectId: "p", title: "已完成成果", kind: "implementation", priority: "must", ownerMembershipId: "owner", helperEfforts: [{ membershipId: "helper", durationEstimate: { optimisticMinutes: 5, likelyMinutes: 10, pessimisticMinutes: 20, basis: "协助者确认" } }], deliverable: "实际作品", acceptanceCriteria: ["已经运行"], reviewerMembershipId: "reviewer", durationEstimate: { optimisticMinutes: 30, likelyMinutes: 60, pessimisticMinutes: 90, basis: "试做估算" }, remainingEstimate: null, dependencyTaskIds: ["prior"], deadlineRef: "submit", requirementRefs: ["requirement"], resourceRefs: ["resource"], resourceContentRefs: [{ resourceId: "resource", version: 2 }], splittable: true, contextSwitchMinutes: 4, waitMinutes: 7, status: "done", blocker: null, cancellationReason: null, acceptance: { acceptedByUserId: "user", acceptedAt: "2026-10-09T00:00:00Z", mode: "manager", evidenceRefs: ["real-evidence"], note: "确认运行" }, revision: 3, updatedAt: "2026-10-09T00:00:00Z" };
}

test("confirmed assignments retain multiple dependencies, owners and independent helpers without inventing estimates", () => {
  const input = { status: "applied" as const, assignments: [assignment("one"), assignment("two"), assignment("three", { helperMembershipIds: ["helper-a", "helper-b"], dependencyTaskIds: ["one", "two"], acceptanceCriteria: ["能运行", "可演示"] })] };
  const snapshot = structuredClone(input);
  const result = importAssignmentTasks(input, [], [deadline]);
  assert.deepEqual(result.tasks.map(task => task.id), ["one", "two", "three"]);
  assert.deepEqual(result.tasks[2]!.dependencies, ["one", "two"]);
  assert.deepEqual(result.tasks[2]!.helpers.map(helper => helper.membershipId), ["helper-a", "helper-b"]);
  assert.equal(result.tasks[2]!.criteria, "能运行\n可演示");
  for (const task of result.tasks) {
    assert.equal(task.kind, ""); assert.equal(task.optimistic, ""); assert.equal(task.likely, ""); assert.equal(task.pessimistic, ""); assert.equal(task.basis, "");
    assert.ok(task.helpers.every(helper => helper.likely === "" && helper.basis === ""));
  }
  assert.deepEqual(input, snapshot);
});
test("reimport never duplicates existing or pending IDs and retains references to existing completed tasks", () => {
  const assignments = [assignment("completed"), assignment("new", { dependencyTaskIds: ["completed"] })];
  const first = importAssignmentTasks({ status: "applied", assignments }, ["completed"], [deadline]);
  assert.equal(first.skipped, 1); assert.deepEqual(first.tasks.map(task => task.id), ["new"]);
  assert.deepEqual(first.tasks[0]!.dependencies, ["completed"]);
  const repeated = importAssignmentTasks({ status: "applied", assignments }, ["completed", ...first.tasks.map(task => task.id)], [deadline]);
  assert.equal(repeated.tasks.length, 0); assert.equal(repeated.skipped, 2);
});
test("draft assignments cannot be imported and ambiguous or unknown deadline references require a selection", () => {
  assert.throws(() => importAssignmentTasks({ status: "ready", assignments: [assignment("a")] }, [], [deadline]), /已确认/);
  const multiple = [deadline, { ...deadline, id: "video" }];
  assert.equal(importAssignmentTasks({ status: "applied", assignments: [assignment("a", { proposedDeadlineRef: "missing" })] }, [], multiple).tasks[0]!.deadlineRef, "");
  assert.equal(importAssignmentTasks({ status: "applied", assignments: [assignment("a", { proposedDeadlineRef: "video" })] }, [], multiple).tasks[0]!.deadlineRef, "video");
  assert.equal(importAssignmentTasks({ status: "applied", assignments: [assignment("a", { ownerMembershipId: null })] }, [], []).tasks[0]!.owner, "");
});
test("continuing a saved plan preserves helper estimates and advanced definitions without changing completed facts", () => {
  const original = planTask(); const snapshot = structuredClone(original);
  const editable = editableFromPlanTask(original);
  assert.deepEqual(editable.helpers, [{ membershipId: "helper", optimistic: "5", likely: "10", pessimistic: "20", basis: "协助者确认" }]);
  assert.deepEqual(editable.sourceDefinition, original);
  editable.sourceDefinition!.title = "页面中调整";
  assert.deepEqual(original, snapshot);
  const transported = planningDefinition(original);
  assert.equal(transported.waitMinutes, 7); assert.equal(transported.contextSwitchMinutes, 4); assert.equal(transported.splittable, true);
  assert.deepEqual(transported.resourceRefs, ["resource"]);
  assert.ok(!("acceptance" in transported)); assert.ok(!("status" in transported)); assert.ok(!("resourceContentRefs" in transported));
});
