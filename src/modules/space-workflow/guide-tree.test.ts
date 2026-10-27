import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentPlanningView, PlanningTask } from "../planning/index.ts";
import type { ProjectOfficialTracksView, ProjectStage } from "../projects/index.ts";
import type { LifecycleInput, SpaceDetail, SpaceRules } from "./model.ts";
import { buildSpaceGuideTree } from "./guide-tree.ts";

const at = "2026-10-09T13:00:00.000Z";
const id = "空间/a?b=中文#&";
const base = `/app/projects/${encodeURIComponent(id)}`;

function detail(stage: ProjectStage = "draft", role: "manager" | "member" = "manager"): SpaceDetail {
  const membership = { membershipId: "mine", projectId: id, userId: "reader", role, status: "active" as const, revision: 1, joinedAt: at, leftAt: null };
  return { project: { id, name: "AI 新人参赛", teamId: null, eventId: "initial-unconfirmed-event", createdBy: "reader", goal: "帮助新人整理比赛", minimumDeliverable: "选择一场比赛并保存计划", stage, timezone: "Asia/Shanghai", deadline: "2026-10-12T13:00:00.000Z", deadlineSource: "member_entered", revision: 1, createdAt: at, updatedAt: at }, membership, members: [membership] };
}
function task(taskId = "demo", patch: Partial<PlanningTask> = {}): PlanningTask {
  return { id: taskId, projectId: id, title: `做 ${taskId}`, priority: "must", kind: "implementation", ownerMembershipId: "mine", helperEfforts: [], deliverable: "真实成果", acceptanceCriteria: ["核心流程可试用"], reviewerMembershipId: "checker", durationEstimate: { optimisticMinutes: 10, likelyMinutes: 20, pessimisticMinutes: 30, basis: "团队估算" }, remainingEstimate: null, dependencyTaskIds: [], deadlineRef: "official", requirementRefs: [], resourceRefs: [], splittable: false, contextSwitchMinutes: 0, waitMinutes: 0, status: "todo", blocker: null, cancellationReason: null, acceptance: null, revision: 1, updatedAt: at, ...patch };
}
const check = { acceptedByUserId: "checker", acceptedAt: at, mode: "reviewer" as const, evidenceRefs: ["artifact-ref"], note: "按条件试用通过" };
function planning(tasks = [task()]): CurrentPlanningView {
  return { plan: { id: "plan", projectId: id, basePlanVersionId: null, baseTasksRevision: 1,
    inputSnapshot: { projectId: id, capturedAt: at, projectRevision: 1, requirementVersionId: "event:2:1", assignmentVersionId: "assignment:1", availabilityVersions: { mine: 1 }, members: [], availability: [{ membershipId: "mine", version: 1, confirmedAt: at, windows: [] }], deadlines: [], requirements: [], approvedResourceIds: [], assumptions: [], requiredTaskKinds: [] }, tasks, buffers: [], validation: null, changes: [], status: "applied", reason: "管理员确认", createdBy: "reader", createdAt: at, appliedBy: "reader", appliedAt: at, acknowledgedIssueCodes: [], revision: 1 },
    tasks, tasksRevision: 1, evaluation: null, staleInputs: false, inputVersionsChanged: false, lastProgressAt: null };
}
function rules(): SpaceRules {
  return { confirmation: { projectId: id, eventId: "event", rulesVersion: 2, revision: 1, analysisId: null, confirmedBy: "reader", confirmedAt: at }, rules: { eventId: "event", version: 2, createdAt: at, metadata: { name: "公开赛", organizer: "主办方", format: "unknown", region: "", officialUrl: "https://example.test/official" }, sources: [], evidence: [], facts: [], qualityFlags: ["missing_information"], stages: [], requirements: [], officialTracks: { status: "none", evidenceIds: ["no-tracks"], tracks: [] } } };
}
function tracks(): ProjectOfficialTracksView {
  return { projectId: id, projectRevision: 1, canManage: true, readonly: false, needsReview: false,
    rules: { eventId: "event", rulesVersion: 2, confirmationRevision: 1, latestPublishedRulesVersion: 2, catalog: { status: "none", evidenceIds: ["no-tracks"], tracks: [] }, requirements: [] },
    selection: { projectId: id, eventId: "event", rulesVersion: 2, confirmationRevision: 1, trackId: null, trackName: null, catalogStatus: "none", revision: 1, selectedBy: "reader", selectedAt: at, reason: "主办方没有细分" }, history: [] };
}
function input(stage: ProjectStage = "active"): LifecycleInput { return { detail: detail(stage), current: planning(), rules: { status: "ready", value: rules() }, tracks: { status: "ready", value: tracks() } }; }
function node(value: LifecycleInput, nodeId: string) { return buildSpaceGuideTree(value).steps.flatMap(step => step.nodes).find(item => item.id === nodeId)!; }

test("six ordered branches expose when/action/condition/next and distinguish optional invitation", () => {
  const view = buildSpaceGuideTree(input());
  assert.deepEqual(view.steps.map(step => step.id), ["enter", "rules", "planning", "execution", "submission", "reflection"]);
  assert.equal(view.currentStepId, "execution");
  for (const step of view.steps) {
    assert.ok(step.summary.length > 15 && step.next.length > 15);
    assert.ok(step.nodes.length >= 2);
    for (const item of step.nodes) {
      assert.ok(item.when.length > 10 && item.actions.length >= 2 && item.condition.length > 15 && item.next.length > 15);
      assert.ok(item.links.length >= 1);
      assert.ok(item.fact.label && item.fact.explanation);
    }
  }
  assert.equal(node(input(), "invite").optional, true);
});

test("a new solo space starts with a real goal gap, without requiring teammates or assessment", () => {
  const value = input("draft"); value.detail.project.minimumDeliverable = ""; value.current = null;
  const view = buildSpaceGuideTree(value);
  assert.equal(view.currentStepId, "enter"); assert.equal(view.solo, true);
  assert.equal(view.next.href, `${base}#project-goal`);
  assert.match(node(value, "invite").fact.explanation, /独自继续/);
  assert.match(node(value, "duties-time").links[1]!.purpose, /不是必走步骤/);
});

test("members and archived spaces are never offered an invitation mutation route", () => {
  const manager = input(); assert.equal(node(manager, "invite").links[0]!.href, `${base}#space-invitation`);
  const member = input(); member.detail = detail("active", "member");
  assert.equal(node(member, "invite").links[0]!.href, `${base}/team`);
  assert.match(node(member, "invite").links[0]!.purpose, /不会获得发链接权限/);
  const archived = input("archived"), view = buildSpaceGuideTree(archived);
  assert.equal(view.readonly, true); assert.equal(view.currentStepId, "reflection");
  assert.equal(node(archived, "invite").links[0]!.href, `${base}/team`);
  assert.match(view.notice, /只读/);
  assert.match(node(archived, "reuse-archive").fact.explanation, /不表示整场流程已完成/);
});

test("every project stage preserves unknown external facts rather than creating green completion", () => {
  for (const stage of ["draft", "preparing", "active", "finalizing", "submitted", "retrospective", "archived"] as const) {
    const value = input(stage);
    for (const name of ["registration", "code-runtime", "presentation-materials", "formal-submission", "retrospective"]) {
      const item = node(value, name);
      assert.equal(item.fact.status, "check");
      assert.doesNotMatch(item.fact.label, /已完成|通过|成功/);
    }
    assert.match(node(value, "formal-submission").condition, /submitted.*不能代替正式提交/);
    assert.match(node(value, "code-runtime").fact.explanation, /没有读取.*运行/);
  }
});

test("rules unread/loading/error remain different unknowns even when space says submitted", () => {
  for (const state of [{ status: "unread" }, { status: "loading" }, { status: "error", message: "PRIVATE_PROVIDER_ERROR" }] as const) {
    const value = input("submitted"); value.rules = state;
    const view = buildSpaceGuideTree(value), ruleNode = node(value, "requirements");
    assert.equal(view.currentStepId, "rules");
    assert.equal(ruleNode.fact.status, state.status === "unread" ? "unknown" : state.status);
    assert.doesNotMatch(JSON.stringify(view), /PRIVATE_PROVIDER_ERROR/);
    assert.notEqual(ruleNode.fact.status, "recorded");
    assert.match(ruleNode.fact.explanation, /未知|尚未读取|暂不判断/);
  }
});

test("unconfirmed eventId, rule content mismatch and stale sources never become current confirmed requirements", () => {
  const empty = input(); empty.rules = { status: "ready", value: { confirmation: null, rules: null } };
  assert.equal(node(empty, "requirements").fact.status, "prepare");
  assert.equal(buildSpaceGuideTree(empty).currentStepId, "rules");
  for (const patch of [{ eventId: "other" }, { rulesVersion: 99 }, { projectId: "other-space" }]) {
    const value = input(), mismatched = rules(); Object.assign(mismatched.confirmation!, patch); value.rules = { status: "ready", value: mismatched };
    assert.equal(node(value, "requirements").fact.status, "review");
    assert.equal(buildSpaceGuideTree(value).currentStepId, "rules");
  }
  const stale = input(), staleRules = rules(); staleRules.rules!.qualityFlags = ["source_stale"];
  stale.rules = { status: "ready", value: staleRules };
  assert.equal(node(stale, "requirements").fact.status, "review");
});

test("no track is explicit only with an aligned saved choice; newer or conflicting tracks require review", () => {
  assert.equal(node(input(), "official-track").fact.status, "recorded");
  assert.match(node(input(), "official-track").fact.explanation, /未细分赛道/);
  for (const mutate of [(v: ProjectOfficialTracksView) => { v.selection = null; }, (v: ProjectOfficialTracksView) => { v.needsReview = true; }, (v: ProjectOfficialTracksView) => { v.rules!.latestPublishedRulesVersion = 3; }, (v: ProjectOfficialTracksView) => { v.rules!.catalog.status = "conflict"; }, (v: ProjectOfficialTracksView) => { v.projectId = "another"; }]) {
    const value = input(), track = tracks(); mutate(track); value.tracks = { status: "ready", value: track };
    assert.notEqual(node(value, "official-track").fact.status, "recorded");
    assert.equal(buildSpaceGuideTree(value).currentStepId, "rules");
  }
});

test("failed plan reads do not appear empty or expose stale task titles", () => {
  for (const patch of [{ planningError: new Error("PRIVATE_PLAN_ERROR") }, { planningLoading: true }, { current: null }]) {
    const value = { ...input(), ...patch };
    if (value.current) value.current.tasks[0]!.title = "DO_NOT_SHOW_UNREAD_TASK";
    const view = buildSpaceGuideTree(value);
    assert.equal(view.currentStepId, "planning");
    assert.doesNotMatch(JSON.stringify(view), /DO_NOT_SHOW_UNREAD_TASK|PRIVATE_PLAN_ERROR/);
    assert.notEqual(node(value, "applied-plan").fact.status, "prepare");
    assert.doesNotMatch(node(value, "handoff").fact.explanation, /0 项/);
  }
});

test("draft, wrong-space, changed-version and empty plans cannot unlock execution", () => {
  const draft = input(); draft.current!.plan!.status = "draft";
  assert.equal(buildSpaceGuideTree(draft).currentStepId, "planning"); assert.equal(node(draft, "applied-plan").fact.status, "review");
  const foreign = input(); foreign.current!.plan!.projectId = "other"; foreign.current!.tasks[0]!.title = "PRIVATE_FOREIGN_TITLE";
  assert.equal(buildSpaceGuideTree(foreign).currentStepId, "planning"); assert.doesNotMatch(JSON.stringify(buildSpaceGuideTree(foreign)), /PRIVATE_FOREIGN_TITLE/);
  const changed = input(); changed.current!.inputVersionsChanged = true;
  assert.equal(node(changed, "applied-plan").fact.status, "review"); assert.equal(buildSpaceGuideTree(changed).currentStepId, "planning");
  const oldRules = input(); oldRules.current!.plan!.inputSnapshot.requirementVersionId = "event:1:1";
  assert.equal(buildSpaceGuideTree(oldRules).currentStepId, "planning");
  const empty = input(); empty.current = planning([]);
  assert.equal(buildSpaceGuideTree(empty).currentStepId, "planning");
});

test("only current done tasks with actual valid check records count, cancelled and foreign tasks are excluded", () => {
  const value = input(); value.current = planning([
    task("checked", { status: "done", acceptance: check }),
    task("done-no-check", { status: "done" }),
    task("review-with-old-check", { status: "review", acceptance: check }),
    task("cancelled", { status: "cancelled", acceptance: check }),
    task("empty-check", { status: "done", acceptance: { ...check, note: "", evidenceRefs: [] } }),
    task("foreign", { projectId: "other", title: "PRIVATE_OTHER_TASK", status: "done", acceptance: check }),
  ]);
  assert.match(node(value, "check-unlock").fact.explanation, /4 项未删减任务，1 项有检查通过记录，1 项待检查/);
  assert.equal(buildSpaceGuideTree(value).currentStepId, "execution");
  assert.doesNotMatch(JSON.stringify(buildSpaceGuideTree(value)), /PRIVATE_OTHER_TASK/);
  assert.match(node(value, "check-unlock").condition, /待检查.*缺检查记录.*不能解除等待/);
});

test("all checked tasks suggest submission checks without asserting environment or official success", () => {
  const value = input("draft"); value.current = planning([task("demo", { status: "done", acceptance: check })]);
  const view = buildSpaceGuideTree(value);
  assert.equal(view.currentStepId, "submission"); assert.equal(view.next.href, `${base}/delivery`);
  assert.equal(node(value, "formal-submission").fact.status, "check");
  assert.match(node(value, "start-task").condition, /时间可用/);
  assert.match(node(value, "start-task").actions.join(""), /并行/);
});

test("all routes stay at owned destinations and only supported personal editors carry encoded project context", () => {
  const view = buildSpaceGuideTree(input()), links = view.steps.flatMap(step => step.nodes.flatMap(item => [...item.links, ...item.tools]));
  const contextual = new Set(["/roadshow", "/ppt", "/github"]);
  for (const item of links) {
    assert.ok(item.href.startsWith("/") && !item.href.startsWith("//"));
    const url = new URL(item.href, "https://fixture.test");
    if (contextual.has(url.pathname)) { assert.equal(url.searchParams.get("projectId"), id); assert.equal(url.searchParams.size, 1); }
    else if (url.pathname.startsWith("/app/projects/")) { assert.ok(item.href.startsWith(base)); assert.equal(url.search, ""); }
    else assert.equal(url.search, "");
    assert.ok(item.purpose.length > 15);
  }
  assert.ok(links.some(item => item.href === `${base}/resources`));
  assert.ok(links.some(item => item.href === `${base}#space-invitation`));
  for (const path of ["/roadshow", "/ppt"]) assert.match(links.find(item => new URL(item.href, "https://fixture.test").pathname === path)!.purpose, /本人/);
});

test("tree generation never mutates source task/plan/rule/selection or creates another progress field", () => {
  const value = input(), before = structuredClone(value);
  const first = buildSpaceGuideTree(value), second = buildSpaceGuideTree(value);
  assert.deepEqual(value, before); assert.deepEqual(first, second);
  assert.doesNotMatch(JSON.stringify(first), /completionPercentage|checkedIds|completedAt|isCompleted|progressPercent/);
  assert.match(first.notice, /不会生成任务、收费调用、共享私人资料/);
});
