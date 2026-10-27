import test from "node:test";
import assert from "node:assert/strict";
import { buildTaskGuidance, dependencyGuidance, taskResourceGuidance } from "./task-guidance.ts";
import type { Acceptance, CurrentPlanningView, PlanningIssue, PlanningTask, TaskKind, ValidationResult } from "./types.ts";

const now = "2026-10-09T01:00:00.000Z";
const acceptance: Acceptance = { acceptedByUserId: "reviewer", acceptedAt: now, mode: "reviewer", evidenceRefs: ["artifact"], note: "按条件检查通过" };
const options = { activeMembershipIds: ["mine", "teammate"], membershipId: "mine" };

function task(id: string, changes: Partial<PlanningTask> = {}): PlanningTask {
  return {
    id, projectId: "space", title: `任务 ${id}`, priority: "must", kind: "implementation", ownerMembershipId: "mine", helperEfforts: [], deliverable: "可检查的成果", acceptanceCriteria: ["可以复现"], reviewerMembershipId: "teammate",
    durationEstimate: { optimisticMinutes: 10, likelyMinutes: 20, pessimisticMinutes: 30, basis: "成员估算" }, remainingEstimate: null, dependencyTaskIds: [], deadlineRef: "deadline", requirementRefs: [], resourceRefs: [], splittable: false, contextSwitchMinutes: 0, waitMinutes: 0,
    status: "todo", blocker: null, cancellationReason: null, acceptance: null, revision: 1, updatedAt: now, ...changes,
  };
}

function evaluation(scheduledIds: string[], issues: PlanningIssue[] = []): ValidationResult {
  const schedule = { scheduled: scheduledIds.map(taskId => ({ taskId, startsAt: now, finishesAt: "2026-10-09T01:20:00.000Z", allocations: [] })), issues, capacityMinutes: {} };
  return { structuralValid: true, feasibility: "feasible", issues, likely: schedule, pessimistic: { scheduled: [], issues: [], capacityMinutes: {} }, checkedAt: now, staleInputs: false };
}

function current(tasks: PlanningTask[], scheduledIds = tasks.map(value => value.id), changes: Partial<CurrentPlanningView> = {}): CurrentPlanningView {
  const validation = evaluation(scheduledIds);
  return {
    plan: {
      id: "plan", projectId: "space", basePlanVersionId: null, baseTasksRevision: 0,
      inputSnapshot: { projectId: "space", capturedAt: now, projectRevision: 1, requirementVersionId: "requirements", assignmentVersionId: "assignment", availabilityVersions: {}, members: [], availability: [], deadlines: [], requirements: [], approvedResourceIds: [], assumptions: [], requiredTaskKinds: [] },
      tasks, buffers: [], validation, changes: [], status: "applied", reason: "团队确认", createdBy: "manager", createdAt: now, appliedBy: "manager", appliedAt: now, acknowledgedIssueCodes: [], revision: 1,
    },
    tasks, tasksRevision: 1, evaluation: validation, staleInputs: false, inputVersionsChanged: false, lastProgressAt: null, ...changes,
  };
}

test("missing plan or snapshot never suggests a task can start", () => {
  assert.deepEqual(buildTaskGuidance(null, options), { planReady: false, items: [], readyTasks: [] });
  const result = buildTaskGuidance(current([task("existing")], ["existing"], { plan: null }), options);
  assert.equal(result.planReady, false);
  assert.equal(result.items[0]?.group, "waiting");
  assert.equal(result.readyTasks.length, 0);
});

test("an unscheduled todo explains its real scheduling issue or the missing time", () => {
  const tasks = [task("no-capacity"), task("no-time"), task("ready")];
  const issue: PlanningIssue = { code: "CAPACITY", severity: "error", message: "录制缺少连续工作时间", taskIds: ["no-capacity"], suggestion: "请核对时间" };
  const result = buildTaskGuidance(current(tasks, [], { evaluation: evaluation(["ready"], [issue]) }), options);
  assert.equal(result.items[0]?.group, "waiting");
  assert.deepEqual(result.items[0]?.needs, [issue.message]);
  assert.equal(result.items[1]?.group, "waiting");
  assert.match(result.items[1]?.needs[0] ?? "", /不能安排.*工作时间/);
  assert.deepEqual(result.readyTasks.map(value => value.id), ["ready"]);
});

test("ready suggestions require current ownership, active membership, schedule and completed prerequisites", () => {
  const tasks = [
    task("checked", { status: "done", acceptance }), task("mine", { dependencyTaskIds: ["checked"] }),
    task("teammate", { ownerMembershipId: "teammate", helperEfforts: [{ membershipId: "mine", durationEstimate: { optimisticMinutes: 5, likelyMinutes: 5, pessimisticMinutes: 5, basis: "协助" } }] }),
    task("departed", { ownerMembershipId: "gone" }), task("unassigned", { ownerMembershipId: null }), task("doing", { status: "in_progress" }), task("review", { status: "review" }), task("blocked", { status: "blocked", blocker: "接口未提供" }),
    task("waiting", { dependencyTaskIds: ["review"] }), task("cancelled", { status: "cancelled", cancellationReason: "团队删减" }),
  ];
  const result = buildTaskGuidance(current(tasks), options);
  assert.deepEqual(result.readyTasks.map(value => value.id), ["mine"]);
  assert.equal(result.items.find(value => value.task.id === "teammate")?.group, "ready");
  assert.equal(result.items.some(value => value.task.id === "cancelled"), false);
  assert.equal(result.items.find(value => value.task.id === "waiting")?.waitingFor[0]?.id, "review");
});

test("unmet dependency guidance preserves each real status and never treats a completion report as a check", () => {
  const predecessors = [
    task("todo"), task("doing", { status: "in_progress" }), task("blocked", { status: "blocked", blocker: "等接口" }), task("review", { status: "review" }), task("done", { status: "done" }),
    task("cancelled", { status: "cancelled", cancellationReason: "范围调整" }), task("checked", { status: "done", acceptance }),
  ];
  const dependent = task("dependent", { dependencyTaskIds: [...predecessors.map(value => value.id), "missing"] });
  const result = dependencyGuidance(dependent, predecessors);
  assert.deepEqual(result.map(value => value.id), ["todo", "doing", "blocked", "review", "done", "cancelled", "missing"]);
  assert.deepEqual(result.map(value => value.status), ["todo", "in_progress", "blocked", "review", "done", "cancelled", null]);
  assert.deepEqual(result.map(value => value.statusLabel), ["未开始", "正在做", "遇到阻塞", "待检查", "已报完成", "已删减", "前置任务缺失"]);
  assert.match(result.find(value => value.id === "review")?.checkLabel ?? "", /待检查.*尚未通过/);
  assert.match(result.find(value => value.id === "done")?.checkLabel ?? "", /缺少检查记录/);
  assert.match(result.find(value => value.id === "cancelled")?.checkLabel ?? "", /已删减.*不能/);
  assert.deepEqual(result.at(-1), { id: "missing", title: "未找到的前置任务", ownerMembershipId: null, missing: true, status: null, statusLabel: "前置任务缺失", checkLabel: "检查状态未知，请管理员核对依赖。" });
  predecessors[3]!.status = "done";
  predecessors[3]!.acceptance = acceptance;
  assert.equal(dependencyGuidance(dependent, predecessors).some(value => value.id === "review"), false);
});

test("a retained acceptance on an unfinished predecessor does not unlock its dependent", () => {
  const predecessor = task("reopened", { status: "review", acceptance });
  const dependent = task("dependent", { dependencyTaskIds: [predecessor.id] });
  assert.match(dependencyGuidance(dependent, [predecessor])[0]?.checkLabel ?? "", /保留检查记录.*不满足前置条件/);
  assert.equal(buildTaskGuidance(current([predecessor, dependent]), options).readyTasks.length, 0);
});

test("invalid plan inputs or validation suppress readiness while ordinary progress staleness does not", () => {
  const tasks = [task("ready")];
  for (const changes of [{ inputVersionsChanged: true }, { evaluation: null }, { evaluation: { ...evaluation(["ready"]), structuralValid: false } }]) {
    const result = buildTaskGuidance(current(tasks, ["ready"], changes), options);
    assert.equal(result.planReady, false);
    assert.equal(result.readyTasks.length, 0);
  }
  const progressOnly = buildTaskGuidance(current(tasks, ["ready"], { staleInputs: true }), options);
  assert.equal(progressOnly.planReady, true);
  assert.deepEqual(progressOnly.readyTasks.map(value => value.id), ["ready"]);
});

test("infeasibility elsewhere does not erase an independent scheduled legal task", () => {
  const tasks = [task("blocked", { status: "blocked", blocker: "接口未提供" }), task("independent")];
  const result = buildTaskGuidance(current(tasks, ["independent"], { evaluation: { ...evaluation(["independent"]), feasibility: "infeasible" } }), options);
  assert.equal(result.planReady, true);
  assert.deepEqual(result.readyTasks.map(value => value.id), ["independent"]);
});

test("no legal parallel task produces no fabricated preparation suggestion", () => {
  const tasks = [task("review", { status: "review" }), task("waiting", { dependencyTaskIds: ["review"] }), task("unscheduled"), task("other-owner", { ownerMembershipId: "teammate" })];
  const result = buildTaskGuidance(current(tasks, ["review", "waiting", "other-owner"]), options);
  assert.deepEqual(result.readyTasks, []);
});

test("task resource guidance uses finite existing routes and explains relevant purposes", () => {
  const expected: Record<TaskKind, string[]> = {
    implementation: ["/app/projects/space/delivery", "/resources"], debugging: ["/app/projects/space/delivery", "/resources"], integration: ["/app/projects/space/delivery", "/resources"], testing: ["/app/projects/space/delivery", "/resources"],
    material: ["/ppt?projectId=space", "/roadshow?projectId=space", "/inspiration"], learning: ["/resources", "/skills"], submission: ["/app/projects/space/delivery"], handoff: ["/app/projects/space/resources", "/app/projects/space/delivery"],
  };
  for (const kind of Object.keys(expected) as TaskKind[]) {
    const result = taskResourceGuidance(kind, "space");
    assert.deepEqual(result.map(value => value.href), expected[kind]);
    assert.ok(result.every(value => value.title.length > 0 && value.purpose.length > 0));
  }
  assert.match(taskResourceGuidance("implementation", "space")[0]!.purpose, /保存.*运行.*正式提交分别记录/);
  assert.ok(taskResourceGuidance("material", "space").slice(0, 2).every(value => /本人.*主动确认.*分享/.test(value.purpose)));
  assert.match(taskResourceGuidance("learning", "space")[1]!.purpose, /复制命令.*安装.*实际试做分别确认/);
  assert.match(taskResourceGuidance("submission", "space")[0]!.purpose, /不代表已正式提交/);
});

test("project routes encode the entire supplied ID and private entry queries preserve it", () => {
  const projectId = "空间 /?&projectId=other#fragment";
  const encoded = encodeURIComponent(projectId);
  assert.equal(taskResourceGuidance("implementation", projectId)[0]!.href, `/app/projects/${encoded}/delivery`);
  assert.equal(taskResourceGuidance("handoff", projectId)[0]!.href, `/app/projects/${encoded}/resources`);
  for (const entry of taskResourceGuidance("material", projectId).slice(0, 2)) {
    const url = new URL(entry.href, "https://fixture.invalid");
    assert.equal(url.searchParams.get("projectId"), projectId);
    assert.equal([...url.searchParams].length, 1);
    assert.equal(url.hash, "");
  }
});

test("guidance only reads the supplied snapshot and does not mutate task or plan facts", () => {
  const tasks = [task("review", { status: "review" }), task("waiting", { dependencyTaskIds: ["review"] }), task("ready")];
  const snapshot = current(tasks);
  const before = structuredClone(snapshot);
  buildTaskGuidance(snapshot, options);
  dependencyGuidance(tasks[1]!, tasks);
  for (const value of tasks) taskResourceGuidance(value.kind, value.projectId);
  assert.deepEqual(snapshot, before);
});
