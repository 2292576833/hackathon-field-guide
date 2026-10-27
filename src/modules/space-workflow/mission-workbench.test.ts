import assert from "node:assert/strict";
import test from "node:test";
import type { Acceptance, CurrentPlanningView, PlanningTask, ValidationResult } from "../planning/types.ts";
import type { MemberAvailability, MyIntentionView, ProjectStage } from "../projects/index.ts";
import type { SpaceDetail } from "./model.ts";
import { buildMissionWorkbench, missionTaskChecked, type MissionWorkbenchInput } from "./mission-workbench.ts";

const at = "2026-10-09T13:00:00.000Z", id = "空间/a?b#中文", base = `/app/projects/${encodeURIComponent(id)}`;
const acceptance: Acceptance = { acceptedByUserId: "checker", acceptedAt: at, mode: "reviewer", evidenceRefs: ["actual-artifact"], note: "按条件检查" };
function detail(stage: ProjectStage = "active", role: "manager" | "member" = "member"): SpaceDetail {
  const membership = { membershipId: "mine", projectId: id, userId: "reader", role, status: "active" as const, revision: 2, joinedAt: at, leftAt: null };
  return { project: { id, name: "AI 新人实践", teamId: null, eventId: null, createdBy: "reader", goal: "帮助新人了解比赛", minimumDeliverable: "选择比赛并查看指南", stage, timezone: "Asia/Shanghai", deadline: "2026-10-12T13:00:00.000Z", deadlineSource: "member_entered", revision: 1, createdAt: at, updatedAt: at }, membership, members: [membership,
    { ...membership, membershipId: "teammate", userId: "checker", role: "member", displayName: "小林" }, { ...membership, membershipId: "manager", userId: "admin", role: "manager", displayName: "小周" }] };
}
function task(taskId = "demo", patch: Partial<PlanningTask> = {}): PlanningTask {
  return { id: taskId, projectId: id, title: `做 ${taskId}`, priority: "must", kind: "implementation", ownerMembershipId: "mine", helperEfforts: [], deliverable: "可检查成果", acceptanceCriteria: ["核心流程可复现"], reviewerMembershipId: "teammate", durationEstimate: { optimisticMinutes: 10, likelyMinutes: 20, pessimisticMinutes: 30, basis: "团队估时" }, remainingEstimate: null, dependencyTaskIds: [], deadlineRef: "submit", requirementRefs: [], resourceRefs: [], splittable: false, contextSwitchMinutes: 0, waitMinutes: 0, status: "todo", blocker: null, cancellationReason: null, acceptance: null, revision: 1, updatedAt: at, ...patch };
}
function current(tasks: PlanningTask[] = [task()], scheduled = tasks.map(value => value.id)): CurrentPlanningView {
  const schedule = { scheduled: scheduled.map(taskId => ({ taskId, startsAt: at, finishesAt: "2026-10-09T13:20:00.000Z", allocations: [] })), issues: [], capacityMinutes: {} };
  const evaluation: ValidationResult = { structuralValid: true, feasibility: "feasible", issues: [], likely: schedule, pessimistic: schedule, checkedAt: at, staleInputs: false };
  return { plan: { id: "plan", projectId: id, basePlanVersionId: null, baseTasksRevision: 1, inputSnapshot: { projectId: id, capturedAt: at, projectRevision: 1, requirementVersionId: null, assignmentVersionId: null, availabilityVersions: {}, members: [], availability: [], deadlines: [], requirements: [], approvedResourceIds: [], assumptions: [], requiredTaskKinds: [] }, tasks, buffers: [], validation: evaluation, changes: [], status: "applied", reason: "管理员确认", createdBy: "admin", createdAt: at, appliedBy: "admin", appliedAt: at, acknowledgedIssueCodes: [], revision: 1 }, tasks, tasksRevision: 1, evaluation, staleInputs: false, inputVersionsChanged: false, lastProgressAt: at };
}
function input(tasks = [task()]): MissionWorkbenchInput { return { detail: detail(), current: current(tasks) }; }
function intention(): MyIntentionView { return { projectId: id, projectRevision: 1, membershipRevision: 2, readonly: false, needsConfirmation: false, intention: { projectId: id, userId: "reader", membershipRevision: 2, revision: 1, duties: ["development"], experience: "本人填写", wantsAiHelp: false, helpQuestion: "", share: { duties: false, experience: false, wantsAiHelp: false, helpQuestion: false }, updatedAt: at } }; }
function availability(): MemberAvailability { return { id: "time", projectId: id, userId: "reader", timezone: "Asia/Shanghai", windows: [], effectiveMinutes: 0, confirmedAt: at, revision: 1, membershipRevision: 2 }; }

test("fresh solo space offers concrete preparation without forced recruiting or assessment", () => {
  const value = input(); value.detail = detail("draft", "manager"); value.detail.members = [value.detail.membership]; value.detail.project.minimumDeliverable = ""; value.current = { ...current(), plan: null, tasks: [] };
  const view = buildMissionWorkbench(value);
  assert.equal(view.state, "empty"); assert.equal(view.solo, true); assert.equal(view.primary.id, "goal"); assert.equal(view.primary.href, `${base}#project-goal`);
  assert.ok(view.primary.deliverable && view.primary.check);
  assert.deepEqual(view.preparation.map(action => action.id), ["goal", "duties", "time", "rules", "plan"]);
  assert.equal(view.progress, null); assert.equal(view.members.length, 0);
});

test("unknown, loading and failed planning do not expose retained tasks as fresh instructions", () => {
  for (const overrides of [{ current: null }, { planningLoading: true }, { planningError: new Error("PRIVATE_PROVIDER_SECRET") }]) {
    const view = buildMissionWorkbench({ ...input(), ...overrides });
    assert.ok(["unknown", "loading", "error"].includes(view.state)); assert.equal(view.actions.length, 0); assert.equal(view.waiting.length, 0); assert.equal(view.members.length, 0); assert.equal(view.progress, null);
    assert.equal(view.primary.kind, "view"); assert.doesNotMatch(JSON.stringify(view), /PRIVATE_PROVIDER_SECRET|做 demo/);
  }
});

test("a draft supports preparation but never presents claimed tasks as executable", () => {
  const value = input(); value.current!.plan!.status = "draft";
  const view = buildMissionWorkbench(value);
  assert.equal(view.state, "draft"); assert.match(view.notice, /草案.*尚未确认生效/); assert.equal(view.actions.length, 0); assert.equal(view.progress, null); assert.equal(view.members.length, 0);
});

test("space and membership mismatches cannot leak another project's task titles or records", () => {
  const value = input([task("PRIVATE_OTHER_PROJECT", { projectId: "different" })]);
  assert.doesNotMatch(JSON.stringify(buildMissionWorkbench(value)), /PRIVATE_OTHER_PROJECT/);
  value.current!.plan!.projectId = "different"; value.current!.tasks = [task("PRIVATE_MISMATCH")];
  assert.doesNotMatch(JSON.stringify(buildMissionWorkbench(value)), /PRIVATE_MISMATCH/);
  const unauthorized = input([task("PRIVATE_REVOKED")]); unauthorized.detail.membership = { ...unauthorized.detail.membership, status: "left" };
  const view = buildMissionWorkbench(unauthorized); assert.equal(view.state, "unavailable"); assert.equal(view.primary.href, "/app"); assert.equal(view.preparation.length, 0); assert.equal(view.deadline, null); assert.doesNotMatch(JSON.stringify(view), /PRIVATE_REVOKED/);
});

test("review duties are suggested only to the appointed checker, manager or permitted self-check owner", () => {
  const tasks = [task("not-my-check", { status: "review" }), task("my-check", { status: "review", ownerMembershipId: "teammate", reviewerMembershipId: "mine" }), task("my-self-check", { status: "review", reviewerMembershipId: null }), task("my-work", { status: "in_progress" })];
  const view = buildMissionWorkbench(input(tasks));
  assert.deepEqual(view.actions.map(action => action.id), ["my-check", "my-self-check", "my-work"]);
  assert.equal(view.primary.kind, "check"); assert.match(view.primary.purpose, /小林.*等你/);
  const managing = input(tasks); managing.detail = detail("active", "manager");
  assert.equal(buildMissionWorkbench(managing).actions.filter(action => action.kind === "check").length, 3);
});

test("blocked dependent work leaves an independent scheduled task available in parallel", () => {
  const tasks = [task("teammate-demo", { ownerMembershipId: "teammate", status: "review" }), task("waiting", { dependencyTaskIds: ["teammate-demo"] }), task("independent", { kind: "material" }), task("problem", { status: "blocked", blocker: "接口不通" })];
  const view = buildMissionWorkbench(input(tasks));
  assert.deepEqual(view.actions.map(action => action.id), ["independent"]); assert.equal(view.primary.id, "independent");
  assert.equal(view.waiting.find(item => item.taskId === "waiting")!.waitingFor[0]!.status, "待检查"); assert.equal(view.waiting.find(item => item.taskId === "waiting")!.waitingFor[0]!.owner, "小林");
  assert.equal(view.waiting.find(item => item.taskId === "problem")!.problem, "接口不通");
  assert.deepEqual(view.primary.tools.map(link => link.href), [`/ppt?projectId=${encodeURIComponent(id)}`, `/roadshow?projectId=${encodeURIComponent(id)}`, "/inspiration"]);
});

test("done words, empty or malformed checks and retained old checks cannot light up or unlock tasks", () => {
  const variations: Partial<PlanningTask>[] = [{ acceptance: null }, { acceptance: { ...acceptance, acceptedAt: "bad" } }, { acceptance: { ...acceptance, acceptedByUserId: " " } }, { acceptance: { ...acceptance, note: " ", evidenceRefs: [" "] } }, { status: "review", acceptance }];
  for (const patch of variations) {
    const prior = task("prior", { status: "done", ...patch });
    assert.equal(missionTaskChecked(prior), false);
    const view = buildMissionWorkbench(input([prior, task("next", { dependencyTaskIds: ["prior"] })]));
    assert.equal(view.actions.some(action => action.id === "next"), false); assert.equal(view.progress!.checkedMust, 0); assert.equal(view.progress!.allMustChecked, false);
  }
});

test("only real checks unlock dependency; optional and cancelled records are kept distinct", () => {
  const tasks = [task("prior", { status: "done", acceptance }), task("next", { dependencyTaskIds: ["prior"] }), task("extra", { priority: "optional", status: "done", acceptance }), task("removed", { status: "cancelled", cancellationReason: "删减" })];
  const value = input(tasks); let view = buildMissionWorkbench(value);
  assert.deepEqual(view.actions.map(action => action.id), ["next"]); assert.equal(view.progress!.must, 2); assert.equal(view.progress!.checkedMust, 1); assert.equal(view.progress!.checkedOptional, 1); assert.equal(view.progress!.cancelled, 1);
  value.current!.tasks[1]!.status = "done"; value.current!.tasks[1]!.acceptance = acceptance; view = buildMissionWorkbench(value);
  assert.equal(view.progress!.allMustChecked, true); assert.equal(view.primary.id, "delivery"); assert.equal(view.primary.href, `${base}/delivery`); assert.match(view.primary.check, /运行验证与正式提交分别/);
});

test("unscheduled and missing-owner tasks do not fabricate a start; missing predecessors stay unknown", () => {
  const tasks = [task("unscheduled"), task("missing-prior", { dependencyTaskIds: ["absent"] }), task("not-owned", { ownerMembershipId: null })];
  const value = input(tasks); value.current = current(tasks, ["missing-prior", "not-owned"]);
  const view = buildMissionWorkbench(value);
  assert.equal(view.actions.length, 0); assert.equal(view.primary.kind, "wait"); assert.match(view.waiting[0]!.problem, /没有安排/);
  assert.equal(view.waiting[1]!.waitingFor[0]!.title, "前置任务缺失"); assert.equal(view.waiting[1]!.waitingFor[0]!.status, "未知");
});

test("input changes suppress actionable suggestions but ordinary progress staleness does not", () => {
  for (const patch of [{ inputVersionsChanged: true }, { evaluation: null }]) {
    const value = input(); Object.assign(value.current!, patch); const view = buildMissionWorkbench(value);
    assert.equal(view.state, "needs_review"); assert.equal(view.actions.length, 0); assert.equal(view.primary.id, "review-plan");
  }
  const value = input(); value.current!.staleInputs = true;
  assert.equal(buildMissionWorkbench(value).primary.id, "demo");
});

test("known missing confirmed rules or stale official selection prevents a false current task suggestion", () => {
  const noRules = input(); noRules.preparation = { rules: { status: "ready", value: { confirmation: null, rules: null } } };
  assert.equal(buildMissionWorkbench(noRules).state, "needs_review"); assert.equal(buildMissionWorkbench(noRules).actions.length, 0);
  const staleTrack = input(); staleTrack.preparation = { tracks: { status: "ready", value: { projectId: id, projectRevision: 1, canManage: false, readonly: false, needsReview: true, rules: null, selection: null, history: [] } } };
  assert.equal(buildMissionWorkbench(staleTrack).state, "needs_review"); assert.equal(buildMissionWorkbench(staleTrack).progress!.allMustChecked, false);
});

test("a private intention/time is only accepted for the current user, project and membership revision", () => {
  const value = input(); value.current = { ...current(), plan: null, tasks: [] };
  value.preparation = { intention: { status: "ready", value: intention() }, availability: { status: "ready", value: { availability: availability(), confirmationRequired: false } } };
  let view = buildMissionWorkbench(value); assert.equal(view.preparation.some(action => action.id === "duties" || action.id === "time"), false);
  const privateIntention = intention(); privateIntention.intention!.userId = "other";
  const privateTime = availability(); privateTime.membershipRevision = 1;
  value.preparation = { intention: { status: "ready", value: privateIntention }, availability: { status: "ready", value: { availability: privateTime, confirmationRequired: false } } };
  view = buildMissionWorkbench(value); assert.equal(view.preparation.some(action => action.id === "duties"), true); assert.equal(view.preparation.some(action => action.id === "time"), true); assert.doesNotMatch(JSON.stringify(view), /本人填写/);
});

test("member activity is grouped from actual tasks, excludes left/other-space members and reflects appointed checks", () => {
  const value = input([task("doing", { ownerMembershipId: "teammate", status: "in_progress" }), task("review", { ownerMembershipId: "mine", status: "review", reviewerMembershipId: "teammate" }), task("checked", { status: "done", acceptance })]);
  value.detail.members.push({ ...value.detail.membership, membershipId: "left", userId: "gone", status: "left" }, { ...value.detail.membership, membershipId: "other", projectId: "other" });
  const view = buildMissionWorkbench(value); assert.equal(view.members.length, 3);
  const teammate = view.members.find(member => member.membershipId === "teammate")!; assert.deepEqual(teammate.doing.map(item => item.id), ["doing"]); assert.deepEqual(teammate.reviewing.map(item => item.id), ["review"]);
  assert.equal(view.members.find(member => member.membershipId === "mine")!.checkedCount, 1);
});

test("archiving keeps actual check history without proposing mutations or asserting formal submission", () => {
  const value = input([task("checked", { status: "done", acceptance }), task("remaining")]); value.detail.project.stage = "archived";
  const view = buildMissionWorkbench(value); assert.equal(view.readonly, true); assert.equal(view.state, "archived"); assert.equal(view.primary.kind, "view"); assert.equal(view.actions.length, 0);
  assert.equal(view.progress!.checkedMust, 1); assert.equal(view.primary.href, `${base}/retrospective`); assert.match(view.notice, /不会改变任务或正式提交/);
});

test("zero required tasks and space stage alone never turn the entire board into completed", () => {
  for (const stage of ["active", "finalizing", "submitted", "retrospective"] as const) {
    const value = input([task("optional", { priority: "optional", status: "done", acceptance })]); value.detail.project.stage = stage;
    const view = buildMissionWorkbench(value); assert.equal(view.progress!.allMustChecked, false); assert.equal(view.primary.id, "no-task"); assert.doesNotMatch(view.primary.title, /成功|已齐/);
  }
});

test("deadline retains actual source and distinguishes team arrangement, and projection does not mutate inputs", () => {
  const value = input(); value.current!.plan!.inputSnapshot.deadlines = [{ id: "submit", kind: "submission", instantUtc: "2026-10-10T13:00:00.000Z", sourceTimeZone: "Asia/Tokyo", sourceText: "主办方提交要求", verified: true }];
  const before = structuredClone(value), view = buildMissionWorkbench(value);
  assert.equal(view.deadline!.fromSnapshot, true); assert.equal(view.deadline!.sourceTimeZone, "Asia/Tokyo"); assert.equal(view.deadline!.basis, "主办方提交要求"); assert.equal(view.primary.href, `${base}/plan#task-demo`); assert.deepEqual(value, before);
  value.current!.plan!.inputSnapshot.deadlines = []; assert.match(buildMissionWorkbench(value).deadline!.basis, /不代表主办方/);
});
