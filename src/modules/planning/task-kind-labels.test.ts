import assert from "node:assert/strict";
import test from "node:test";
import { planningTaskKindLabels, validatePlan } from "./rules.ts";
import type { PlanningInput, PlanningTask, TaskKind } from "./types.ts";

const now = "2026-10-12T08:00:00.000Z";
const kinds = Object.keys(planningTaskKindLabels) as TaskKind[];
function input(requiredTaskKinds: TaskKind[]): PlanningInput {
  return { projectId: "p1", projectRevision: 1, capturedAt: now, requirementVersionId: null, assignmentVersionId: null, availabilityVersions: { m1: 1 },
    members: [{ membershipId: "m1", projectId: "p1", userId: "u1", role: "manager", status: "active" }],
    availability: [{ membershipId: "m1", version: 1, confirmedAt: now, windows: [{ id: "work", projectId: "p1", membershipId: "m1", startsAt: now, endsAt: "2026-10-12T18:00:00.000Z", sourceTimeZone: "UTC", purpose: "work", version: 1 }] }],
    deadlines: [{ id: "finish", kind: "submission", instantUtc: "2026-10-12T18:00:00.000Z", sourceTimeZone: "UTC", sourceText: "已确认时间", verified: true }],
    requirements: [], approvedResourceIds: [], assumptions: [], requiredTaskKinds };
}
function task(kind: TaskKind, changes: Partial<PlanningTask> = {}): PlanningTask {
  return { id: kind, projectId: "p1", title: planningTaskKindLabels[kind], kind, priority: "must", ownerMembershipId: "m1", helperEfforts: [], deliverable: "可检查成果", acceptanceCriteria: ["按说明能打开"], reviewerMembershipId: null,
    durationEstimate: { optimisticMinutes: 1, likelyMinutes: 2, pessimisticMinutes: 3, basis: "成员试做估算" }, remainingEstimate: null, dependencyTaskIds: [], deadlineRef: "finish", requirementRefs: [], resourceRefs: [], splittable: false,
    contextSwitchMinutes: 0, waitMinutes: 0, status: "todo", blocker: null, cancellationReason: null, acceptance: null, revision: 1, updatedAt: now, ...changes };
}

test("所有缺少的必需类别均以中文说明，并指向使用同一名称的添加按钮", () => {
  const result = validatePlan(input(kinds), [], [{ deadlineId: "finish", reservedMinutes: 0, basis: "明确选择零提交缓冲" }], now);
  const missing = result.issues.filter(issue => issue.code === "REQUIRED_TASK_KIND_MISSING");
  assert.equal(missing.length, kinds.length); assert.equal(result.structuralValid, false);
  for (const kind of kinds) {
    const label = planningTaskKindLabels[kind], issue = missing.find(value => value.message.includes(`「${label}」`))!;
    assert.ok(issue, kind); assert.equal(issue.severity, "error");
    assert.ok(issue.suggestion.includes(`「增加${label}任务」`));
    assert.ok(!issue.message.includes(kind) && !issue.suggestion.includes(kind));
  }
});

test("典型联调、材料和提交准备提示给出可理解的实际动作", () => {
  const result = validatePlan(input(["integration", "material", "submission"]), [], [], now);
  const text = result.issues.filter(issue => issue.code === "REQUIRED_TASK_KIND_MISSING").map(issue => issue.suggestion).join("\n");
  assert.match(text, /把页面和接口连起来试一次/); assert.match(text, /PPT或视频/); assert.match(text, /打包并核对要交的文件/);
});

test("中文化不放松约束：可选或已删减的同类任务仍不能填补必须任务", () => {
  for (const kind of kinds) {
    for (const changes of [{ priority: "optional" as const }, { status: "cancelled" as const, cancellationReason: "仅测试已删减任务" }]) {
      const result = validatePlan(input([kind]), [task(kind, changes)], [], now);
      assert.ok(result.issues.some(issue => issue.code === "REQUIRED_TASK_KIND_MISSING" && issue.severity === "error"));
      assert.equal(result.structuralValid, false);
    }
    assert.ok(!validatePlan(input([kind]), [task(kind)], [], now).issues.some(issue => issue.code === "REQUIRED_TASK_KIND_MISSING"));
  }
});

test("未知用途仍按原错误拒绝，不获得中文名称或伪造通过", () => {
  const result = validatePlan(input(["unsupported" as TaskKind]), [], [], now);
  assert.ok(result.issues.some(issue => issue.code === "INVALID_REQUIRED_TASK_KIND" && issue.severity === "error"));
  assert.equal(result.structuralValid, false);
});
