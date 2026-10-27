import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentPlanningView, PlanningDeadline, PlanningTask } from "../planning/index.ts";
import type { ProjectOfficialTracksView, ProjectStage } from "../projects/index.ts";
import type { DeliveryVerification, GitOperation, SubmissionRecord } from "../github/index.ts";
import type { ReadState, SpaceDeliverySummary, SpaceDetail, SpaceRules } from "./model.ts";
import { buildSpaceLifecycle, buildSubmissionChecklist, initialSpacePhase, publicHttpLink, repositoryStatus, submissionRecordLabel } from "./service.ts";
import { spacePhaseGuides } from "./catalog.ts";

const at = "2026-10-09T01:00:00.000Z";
const oldCommit = "a".repeat(40);
const currentCommit = "b".repeat(40);
const projectId = "space/with 中文";
const base = `/app/projects/${encodeURIComponent(projectId)}`;

function detail(stage: ProjectStage = "active", role: "manager" | "member" = "manager"): SpaceDetail {
  const membership = { membershipId: "me", projectId, userId: "my-user", role, status: "active" as const, revision: 1, joinedAt: at, leftAt: null };
  return {
    project: { id: projectId, name: "测试空间", teamId: null, eventId: null, createdBy: "my-user", goal: "做出可体验的参赛流程", minimumDeliverable: "登录并保存一条记录", stage, timezone: "Asia/Shanghai", deadline: "2026-10-10T10:00:00.000Z", deadlineSource: "member_entered", revision: 1, createdAt: at, updatedAt: at },
    membership,
    members: [membership],
  };
}

function task(id: string, patch: Partial<PlanningTask> = {}): PlanningTask {
  return { id, projectId, title: `任务 ${id}`, priority: "must", kind: "implementation", ownerMembershipId: "me", helperEfforts: [], deliverable: "可体验的成果", acceptanceCriteria: ["主要流程可用"], reviewerMembershipId: "other", durationEstimate: { optimisticMinutes: 10, likelyMinutes: 20, pessimisticMinutes: 30, basis: "测试估算" }, remainingEstimate: null, dependencyTaskIds: [], deadlineRef: "official", requirementRefs: [], resourceRefs: [], splittable: false, contextSwitchMinutes: 0, waitMinutes: 0, status: "todo", blocker: null, cancellationReason: null, acceptance: null, revision: 1, updatedAt: at, ...patch };
}

function deadline(id = "official", verified = true, instantUtc = "2026-10-11T10:00:00.000Z"): PlanningDeadline {
  return { id, kind: "submission", instantUtc, sourceTimeZone: "Asia/Shanghai", sourceText: verified ? "已确认规则中的截止" : "团队先安排的时间", verified };
}

function planning(tasks: PlanningTask[] = [], deadlines: PlanningDeadline[] = [deadline()]): CurrentPlanningView {
  return {
    plan: { id: "plan-current", projectId, basePlanVersionId: null, baseTasksRevision: 1, inputSnapshot: { projectId, capturedAt: at, projectRevision: 1, requirementVersionId: "event:3:2", assignmentVersionId: "assignment:1", availabilityVersions: {}, members: [], availability: [], deadlines, requirements: [], approvedResourceIds: [], assumptions: [], requiredTaskKinds: [] }, tasks, buffers: [], validation: null, changes: [], status: "applied", reason: "管理员确认", createdBy: "my-user", createdAt: at, appliedBy: "my-user", appliedAt: at, acknowledgedIssueCodes: [], revision: 1 },
    tasks, tasksRevision: 1, evaluation: null, staleInputs: false, inputVersionsChanged: false, lastProgressAt: null,
  };
}

function rules(): SpaceRules {
  return {
    confirmation: { projectId, eventId: "event", rulesVersion: 3, revision: 2, analysisId: null, confirmedBy: "my-user", confirmedAt: at },
    rules: { eventId: "event", version: 3, createdAt: at, metadata: { name: "测试比赛", organizer: "测试主办方", format: "unknown", region: "", officialUrl: "https://event.example/rules" }, sources: [], evidence: [], facts: [], qualityFlags: ["missing_information"], officialTracks: { status: "unknown", evidenceIds: [], tracks: [] },
      stages: [
        { id: "qualifier", stageType: "submission", name: "初轮提交", startsAt: null, endsAt: { rawText: "2026 年 10 月 10 日", timeZone: null, utc: null, dateOnly: true, evidenceIds: [] }, submissionUrl: "https://event.example/qualifier" },
        { id: "final", stageType: "submission", name: "最终提交", startsAt: null, endsAt: { rawText: "2026-10-12 18:00", timeZone: "Asia/Shanghai", utc: "2026-10-12T10:00:00.000Z", dateOnly: false, evidenceIds: ["deadline-evidence"] }, submissionUrl: "https://event.example/final" },
        { id: "pitch", stageType: "pitch", name: "现场展示", startsAt: null, endsAt: null, submissionUrl: null },
        { id: "build", stageType: "development", name: "开发阶段", startsAt: null, endsAt: null, submissionUrl: null },
      ],
      requirements: [
        { id: "description", label: "作品说明", necessity: "required", stageId: null, evidenceIds: [] },
        { id: "demo", label: "演示链接", necessity: "required", stageId: "final", evidenceIds: [] },
        { id: "extra", label: "附加材料待核对", necessity: "unknown", stageId: "qualifier", evidenceIds: [] },
        { id: "slide", label: "自选展示材料", necessity: "optional", stageId: "pitch", evidenceIds: [] },
      ],
    },
  };
}

function tracks(status: "unknown" | "none" | "conflict" | "confirmed" = "unknown"): ProjectOfficialTracksView {
  return { projectId, projectRevision: 1, canManage: true, readonly: false, rules: { eventId: "event", rulesVersion: 3, confirmationRevision: 2, latestPublishedRulesVersion: 3, catalog: { status, evidenceIds: [], tracks: [] }, requirements: [] }, selection: null, needsReview: true, history: [] };
}

function operation(status: GitOperation["status"] = "saved", commitSha: string | null = currentCommit): GitOperation {
  return { id: "save-current", projectId, actorId: "my-user", bindingId: "binding", bindingRevision: 1, target: { repositoryId: 1, owner: "fixture", name: "repository", installationId: 2, appId: 3, defaultBranch: "main" }, idempotencyKey: "fixture-only", inputHash: "fixture-only", manifest: { entries: [], totalBytes: 0, inputHash: "fixture-only", issues: [] }, draftRef: "fixture", expiresAt: at, message: "测试保存", wantsPullRequest: false, branch: "hackathon/version", status, step: status === "saved" ? "done" : "draft", revision: 1, createdAt: at, updatedAt: at, preview: null, treeSha: commitSha ? "c".repeat(40) : null, commitSha, commitMessage: null, pullRequestUrl: null, pullRequestStatus: "not_requested", errorCode: null, leaseUntil: null };
}

function verification(commitSha: string | null = currentCommit, outcome: DeliveryVerification["outcome"] = "passed"): DeliveryVerification {
  return { id: `run-${commitSha?.slice(0, 1) ?? "unversioned"}-${outcome}`, projectId, repositoryCommitSha: commitSha, verifierId: "my-user", verifiedAt: at, environmentSummary: "测试本地环境", steps: ["实际打开主要流程"], outcome, blockers: outcome === "passed" ? [] : ["需继续核对"], evidenceRefs: ["fixture:evidence"], verificationSource: "user_reported", version: 1 };
}

function record(id: string, patch: Partial<SubmissionRecord> = {}): SubmissionRecord {
  return { id, projectId, eventId: "event", stageId: "final", requirementsVersion: "event:3:2", platformUrl: "https://event.example/final", submittedAt: at, verificationSource: "user_reported", repositoryCommitSha: currentCommit, status: "reported", evidenceRefs: ["fixture:receipt"], recordedBy: "my-user", recordedAt: at, version: 1, ...patch };
}

function summary(records: SubmissionRecord[] = [], matching: DeliveryVerification | null = null): SpaceDeliverySummary {
  const saved = operation();
  return { projectId, repository: { status: "saved", latestOperation: saved, latestSavedOperation: saved, mergeStatus: "not_verified", branchVerificationSource: null }, runtime: { status: matching?.outcome ?? "not_verified", currentCommitSha: currentCommit, matchStatus: matching ? "matched" : "no_matching_verification", latestVerification: matching, latestHistoricalVerification: matching, verificationHistory: matching ? [matching] : [] }, submission: { records, platformConfirmationAvailable: false }, requirements: { status: "not_loaded", requirements: null, checklist: null, currentCommitSha: null, branch: { status: "unknown", verificationSource: null, record: null }, materials: [], gaps: [], recoveryAction: "review_confirmed_event_requirements" } };
}

const ready = <T>(value: T): ReadState<T> => ({ status: "ready", value });

test("五阶段按项目安排映射；归档只读优先于目标缺失或当前任务", () => {
  const expected = { draft: "formation", preparing: "preparation", active: "competition", finalizing: "presentation", submitted: "reflection", retrospective: "reflection", archived: "reflection" };
  for (const [stage, phase] of Object.entries(expected)) assert.equal(initialSpacePhase(stage as ProjectStage), phase);
  const archived = detail("archived"); archived.project.goal = "";
  const view = buildSpaceLifecycle({ detail: archived, current: planning([task("pending")]) });
  assert.equal(view.readonly, true);
  assert.equal(view.initialPhase, "reflection");
  assert.equal(view.next.href, `${base}/retrospective`);
  assert.match(view.next.purpose, /归档.*只读/u);
  assert.equal(buildSpaceLifecycle({ detail: detail(), current: null }).readonly, false);
});

test("未读、加载、失败与明确无计划分别显示；失败不能使用残留任务", () => {
  const d = detail();
  const current = planning([task("cached")]);
  const cases = [
    { input: { detail: d, current: null }, status: "unread" },
    { input: { detail: d, current, planningLoading: true }, status: "loading" },
    { input: { detail: d, current, planningLoading: true, planningError: new Error("读取失败") }, status: "error" },
  ];
  for (const { input, status } of cases) {
    const view = buildSpaceLifecycle(input);
    assert.equal(view.planningStatus, status);
    assert.deepEqual(view.relatedTasks, []);
    assert.equal(view.next.href, `${base}/plan`);
    assert.match(view.next.title, /读取/u);
  }
  const empty = planning([task("orphan")]); empty.plan = null;
  const view = buildSpaceLifecycle({ detail: d, current: empty });
  assert.equal(view.planningStatus, "empty");
  assert.deepEqual(view.relatedTasks, []);
  assert.equal(view.next.href, `${base}/assessment`);
  assert.match(view.planningNotice, /一个人也可以/u);
});

test("输入版本变更隔离旧任务与旧截止，并按管理员或成员提供复核动作", () => {
  const current = planning([task("obsolete")]); current.inputVersionsChanged = true;
  for (const role of ["manager", "member"] as const) {
    const view = buildSpaceLifecycle({ detail: detail("active", role), current });
    assert.equal(view.planningStatus, "changed");
    assert.deepEqual(view.relatedTasks, []);
    assert.equal(view.deadline?.fromSnapshot, false);
    assert.equal(view.next.href, `${base}/plan`);
    assert.match(view.next.title, role === "manager" ? /重新核对/u : /联系管理员/u);
  }
});

test("普通进度使staleInputs变化时不误作依据版本变更，仍只提示查看任务条件", () => {
  const current = planning([task("ongoing", { status: "in_progress" })]); current.staleInputs = true;
  const view = buildSpaceLifecycle({ detail: detail(), current });
  assert.equal(view.planningStatus, "current");
  assert.equal(view.relatedTasks[0]?.id, "ongoing");
  assert.match(view.next.purpose, /前置成果.*时间/u);
  assert.doesNotMatch(view.next.purpose, /可以开始|前置已解除/u);
});

test("本人任务、协助与检查使用真实关系；已完成取消和其他成员任务不混入", () => {
  const estimate = task("fixture").durationEstimate;
  const current = planning([
    task("review/中文", { status: "review", ownerMembershipId: "other", reviewerMembershipId: "me" }),
    task("ongoing", { status: "in_progress" }),
    task("help", { status: "blocked", ownerMembershipId: "other", helperEfforts: [{ membershipId: "me", durationEstimate: estimate }], dependencyTaskIds: ["real-predecessor"] }),
    task("later"), task("done", { status: "done" }), task("cancelled", { status: "cancelled" }),
    task("not-mine", { ownerMembershipId: "other", reviewerMembershipId: "other" }),
  ]);
  const view = buildSpaceLifecycle({ detail: detail("active", "member"), current });
  assert.deepEqual(view.relatedTasks.map(item => item.id), ["review/中文", "ongoing", "help"]);
  assert.equal(view.next.href, `${base}/plan#task-${encodeURIComponent("review/中文")}`);
  assert.match(view.next.purpose, /成果和检查依据/u);
  assert.doesNotMatch(view.next.purpose, /检查通过|任务完成/u);
});

test("管理员能查看待检查成果，普通成员没有关联待办时引导核对全队分工", () => {
  const current = planning([task("team-review", { status: "review", ownerMembershipId: "other", reviewerMembershipId: "other" })]);
  const manager = buildSpaceLifecycle({ detail: detail("active", "manager"), current });
  const member = buildSpaceLifecycle({ detail: detail("active", "member"), current });
  assert.equal(manager.relatedTasks[0]?.id, "team-review");
  assert.deepEqual(member.relatedTasks, []);
  assert.match(member.next.title, /全队任务与分工/u);
  assert.match(member.next.purpose, /核对分工/u);
});

test("单人没有固定队伍也能继续；失效成员不算队友；缺目标按角色引导", () => {
  const d = detail("preparing", "member");
  d.members.push({ ...d.membership, membershipId: "left", userId: "left-user", status: "left", leftAt: at });
  const empty = planning(); empty.plan = null;
  let view = buildSpaceLifecycle({ detail: d, current: empty });
  assert.equal(view.solo, true);
  assert.equal(view.next.href, `${base}/assessment`);
  d.members.push({ ...d.membership, membershipId: "active-other", userId: "other-user" });
  assert.equal(buildSpaceLifecycle({ detail: d, current: empty }).solo, false);
  for (const role of ["manager", "member"] as const) {
    const missing = detail("draft", role); missing.project.minimumDeliverable = " ";
    view = buildSpaceLifecycle({ detail: missing, current: empty });
    assert.equal(view.next.href, `${base}#project-goal`);
    assert.match(view.next.title, role === "manager" ? /写清楚/u : /管理员/u);
  }
});

test("整理提交与复盘只提供核对入口，项目阶段不宣称正式提交成功", () => {
  for (const stage of ["finalizing", "submitted", "retrospective"] as const) {
    const view = buildSpaceLifecycle({ detail: detail(stage), current: null });
    assert.equal(view.next.href, `${base}/${stage === "finalizing" ? "delivery" : "retrospective"}`);
    assert.doesNotMatch(view.next.title, /提交成功|平台接受/u);
    if (stage !== "finalizing") assert.match(view.next.purpose, /不是提交成功证明/u);
  }
});

test("官方规则与赛道未确认时只引导核对，不从资源分类或初选eventId造事实", () => {
  const empty = planning(); empty.plan = null;
  const d = detail("draft"); d.project.eventId = "unconfirmed-event";
  const missing = buildSpaceLifecycle({ detail: d, current: empty, rules: ready({ confirmation: null, rules: null }) });
  assert.match(missing.next.title, /确认本场比赛的规则/u);
  for (const status of ["unknown", "conflict", "none", "confirmed"] as const) {
    const value = tracks(status);
    const view = buildSpaceLifecycle({ detail: d, current: empty, tracks: ready(value) });
    assert.match(view.next.title, /重新核对官方赛道与规则/u);
    assert.equal(view.next.href, `${base}/rules`);
    assert.doesNotMatch(view.next.purpose, /已确认|适合.*赛道|符合资格/u);
    assert.equal(value.selection, null);
  }
  for (const state of [{ status: "unread" }, { status: "loading" }, { status: "error", message: "暂不可读" }] as const) {
    const view = buildSpaceLifecycle({ detail: d, current: empty, rules: state, tracks: state });
    assert.doesNotMatch(view.next.purpose, /规则已确认|赛道已确认|报名成功/u);
  }
});

test("最近截止取待办关联的有效计划快照，并与团队手填截止分别说明", () => {
  const current = planning([task("pending"), task("invalid-deadline", { deadlineRef: "bad" }), task("finished", { status: "done", deadlineRef: "past" })], [deadline("bad", true, "invalid"), deadline("past", true, "2026-10-09T00:00:00.000Z"), deadline()]);
  const official = buildSpaceLifecycle({ detail: detail(), current });
  assert.equal(official.deadline?.instant, "2026-10-11T10:00:00.000Z");
  assert.equal(official.deadline?.fromSnapshot, true);
  assert.match(official.deadline?.label ?? "", /计划中已核对的比赛要求/u);
  assert.equal(official.deadline?.basis, "已确认规则中的截止");
  current.plan!.inputSnapshot.deadlines = [deadline("official", false)];
  const provisional = buildSpaceLifecycle({ detail: detail(), current });
  assert.match(provisional.deadline?.label ?? "", /待核对或团队安排/u);
  const team = buildSpaceLifecycle({ detail: detail(), current: null });
  assert.equal(team.deadline?.fromSnapshot, false);
  assert.match(team.deadline?.label ?? "", /团队安排/u);
  assert.match(team.deadline?.basis ?? "", /不代表主办方/u);
  const noDeadline = detail(); noDeadline.project.deadline = null;
  assert.equal(buildSpaceLifecycle({ detail: noDeadline, current: null }).deadline, null);
});

test("准备路径说明用途和私人材料边界，不生成报名/PPT/出行完成事实", () => {
  const guides = spacePhaseGuides(projectId);
  assert.deepEqual(guides.map(guide => guide.id), ["formation", "preparation", "competition", "presentation", "reflection"]);
  assert.match(guides[0]!.caution, /没有报名完成记录/u);
  assert.match(guides[1]!.caution, /没有环境、出行或天气准备完成记录/u);
  assert.match(guides[3]!.caution, /没有 PPT、视频或讲稿已完成记录/u);
  assert.ok(guides.every(guide => [...guide.actions, ...guide.tools].every(link => Boolean(link.purpose) && link.href.startsWith("/"))));
  assert.ok(guides[1]!.tools.some(link => link.href === "/participation" && /本人账号/u.test(link.purpose)));
  assert.ok(guides[3]!.tools.some(link => link.href === `/ppt?projectId=${encodeURIComponent(projectId)}` && /主动分享/u.test(link.purpose)));
});

test("路演与PPT保留编码后的当前空间，仍由本人确认私人资料与主动共享", () => {
  const id = "单人 空间/a?b=#c&d";
  const tools = spacePhaseGuides(id).find(guide => guide.id === "presentation")!.tools;
  for (const path of ["/roadshow", "/ppt"]) {
    const link = tools.find(item => new URL(item.href, "https://fixture.example").pathname === path)!;
    assert.equal(link.href, `${path}?projectId=${encodeURIComponent(id)}`);
    const url = new URL(link.href, "https://fixture.example");
    assert.equal(url.searchParams.get("projectId"), id);
    assert.equal(url.searchParams.size, 1);
    assert.equal(url.hash, "");
    assert.match(link.purpose, /供本人确认/u);
    assert.match(link.purpose, /本人账号/u);
    assert.match(link.purpose, /主动分享/u);
  }
});

test("要求和交付未读、加载或失败不按空记录解释", () => {
  for (const status of ["unread", "loading", "error"] as const) {
    const state = status === "error" ? { status, message: "读取中断" } as const : { status };
    const view = buildSubmissionChecklist(state, state);
    assert.equal(view.rulesStatus, status);
    assert.equal(view.deliveryStatus, status);
    assert.deepEqual(view.stages, []);
    assert.deepEqual(view.history, []);
    assert.equal(view.savedCommit, null);
    assert.doesNotMatch(view.deliveryNotice, /没有提交记录|尚未提交/u);
    assert.doesNotMatch(view.repositoryNotice, /没有可关联的已保存/u);
    if (status === "error") {
      assert.match(view.rulesNotice, /读取失败.*未知/u);
      assert.match(view.runtimeNotice, /读取失败.*未知/u);
      assert.match(view.repositoryNotice, /读取失败.*未知/u);
    }
  }
  assert.equal(buildSubmissionChecklist(ready({ confirmation: null, rules: null }), ready(summary())).rulesStatus, "empty");
});

test("规则confirmation与内容不一致时不归类提交，也不提供推断材料或入口", () => {
  for (const patch of [{ eventId: "different-event" }, { rulesVersion: 99 }]) {
    const mismatch = rules(); mismatch.confirmation = { ...mismatch.confirmation!, ...patch };
    const existing = record("existing");
    const view = buildSubmissionChecklist(ready(mismatch), ready(summary([existing])));
    assert.equal(view.rulesStatus, "mismatch");
    assert.equal(view.rulesVersion, null);
    assert.deepEqual(view.stages, []);
    assert.deepEqual(view.generalRequirements, []);
    assert.deepEqual(view.unclassifiedRecords, [existing]);
  }
});

test("逐阶段保留必交/选交/未知与缺入口；仅日期的截止不被补成精确UTC", () => {
  const value = rules();
  const view = buildSubmissionChecklist(ready(value), ready(summary()));
  assert.deepEqual(view.stages.map(stage => stage.id), ["qualifier", "final", "pitch"]);
  assert.equal(view.rulesVersion, "event:3:2");
  assert.deepEqual(view.generalRequirements, [{ id: "description", title: "作品说明", necessity: "required" }]);
  assert.deepEqual(view.stages[0]!.requirements, [{ id: "extra", title: "附加材料待核对", necessity: "unknown" }]);
  assert.deepEqual(view.stages[1]!.requirements, [{ id: "demo", title: "演示链接", necessity: "required" }]);
  assert.equal(view.stages[2]!.requirements[0]?.necessity, "optional");
  assert.equal(view.stages[2]!.officialUrl, null);
  assert.equal(view.stages[0]!.deadline?.utc, null);
  assert.equal(view.stages[0]!.deadline?.dateOnly, true);
  assert.equal(view.stages[0]!.deadline?.rawText, value.rules!.stages[0]!.endsAt?.rawText);
  assert.ok(view.stages.every(stage => stage.records.length === 0));
});

test("保存版本本身不能推导运行或提交；历史旧commit与nullSHA通过仍未知", () => {
  for (const historicalSha of [oldCommit, null]) {
    const s = summary();
    const historical = verification(historicalSha);
    s.runtime.latestHistoricalVerification = historical;
    s.runtime.verificationHistory = [historical];
    const view = buildSubmissionChecklist(ready(rules()), ready(s));
    assert.equal(view.savedCommit, currentCommit);
    assert.match(view.runtimeNotice, /还没有对应的运行记录/u);
    assert.match(view.runtimeNotice, /旧版本或未填写版本/u);
    assert.equal(view.historicalRuntimeCount, 1);
    assert.ok(view.stages.every(stage => stage.records.length === 0));
  }
});

test("无已保存commit时手动通过只作历史，不认证当前版本，也不回退旧SHA", () => {
  const s = summary([], verification(oldCommit));
  s.repository.latestSavedOperation = operation("saved", null);
  s.runtime.currentCommitSha = null; s.runtime.status = "unknown"; s.runtime.matchStatus = "no_saved_commit"; s.runtime.latestVerification = null;
  const view = buildSubmissionChecklist(ready(rules()), ready(s));
  assert.equal(view.savedCommit, null);
  assert.match(view.runtimeNotice, /没有可关联的已保存版本.*未知/u);
  assert.equal(view.historicalRuntimeCount, 1);
  assert.doesNotMatch(view.runtimeNotice, /当前.*运行通过/u);
});

test("真实空摘要中的null操作与null运行历史是已读取空事实，保持各类结果分离", () => {
  const empty: SpaceDeliverySummary = {
    projectId,
    repository: { status: "not_saved", latestOperation: null, latestSavedOperation: null, mergeStatus: "not_verified", branchVerificationSource: null },
    runtime: { status: "unknown", currentCommitSha: null, matchStatus: "no_saved_commit", latestVerification: null, latestHistoricalVerification: null, verificationHistory: [] },
    submission: { records: [], platformConfirmationAvailable: false },
    requirements: { status: "not_loaded", requirements: null, checklist: null, currentCommitSha: null, branch: { status: "unknown", verificationSource: null, record: null }, materials: [], gaps: [], recoveryAction: "review_confirmed_event_requirements" },
  };
  const view = buildSubmissionChecklist(ready(rules()), ready(empty));
  assert.equal(view.deliveryStatus, "ready");
  assert.equal(view.savedCommit, null);
  assert.match(view.repositoryNotice, /没有可关联的已保存仓库版本/u);
  assert.match(view.runtimeNotice, /当前版本运行结果未知/u);
  assert.equal(view.historicalRuntimeCount, 0);
  assert.ok(view.stages.every(stage => stage.records.length === 0));
});

test("防御错误matched标志：不同SHA或nullSHA的通过不能认证当前保存版本", () => {
  for (const mismatchingSha of [oldCommit, null]) {
    const s = summary([], verification(mismatchingSha));
    const view = buildSubmissionChecklist(ready(rules()), ready(s));
    assert.match(view.runtimeNotice, /还没有对应的运行记录/u);
    assert.doesNotMatch(view.runtimeNotice, /运行通过/u);
  }
});

test("摘要运行SHA与真正已保存操作不一致时，即使matched与通过也不能认证", () => {
  for (const saved of [operation("saved", oldCommit), operation("saved", null), null]) {
    const s = summary([], verification());
    s.repository.latestSavedOperation = saved;
    const view = buildSubmissionChecklist(ready(rules()), ready(s));
    assert.equal(view.savedCommit, saved?.commitSha ?? null);
    assert.match(view.runtimeNotice, /还没有对应的运行记录/u);
    assert.doesNotMatch(view.runtimeNotice, /运行通过/u);
  }
});

for (const outcome of ["passed", "failed", "inconclusive"] as const) {
  test(`同SHA运行${outcome}只显示成员记录，不推导正式提交`, () => {
    const matching = verification(currentCommit.toUpperCase(), outcome);
    const view = buildSubmissionChecklist(ready(rules()), ready(summary([], matching)));
    assert.match(view.runtimeNotice, /成员记录当前已保存版本/u);
    assert.match(view.runtimeNotice, outcome === "passed" ? /运行通过/u : outcome === "failed" ? /运行未通过/u : /运行无法确认/u);
    assert.ok(view.stages.every(stage => stage.records.length === 0));
    assert.match(view.deliveryNotice, /不汇总为整场提交成功/u);
  });
}

test("更晚unknown操作不否定旧保存版本，也不假称已保存最新草稿或合入主分支", () => {
  const s = summary([], verification());
  s.repository.status = "unknown"; s.repository.latestOperation = { ...operation("unknown", oldCommit), id: "new-uncertain" };
  s.runtime.latestHistoricalVerification = verification(oldCommit, "failed");
  s.runtime.verificationHistory.push(s.runtime.latestHistoricalVerification);
  const view = buildSubmissionChecklist(ready(rules()), ready(s));
  assert.equal(view.savedCommit, currentCommit);
  assert.match(view.repositoryNotice, /最近一次操作状态为 结果未知/u);
  assert.match(view.repositoryNotice, /是否合入.*仍待核对/u);
  assert.match(view.runtimeNotice, /当前已保存版本运行通过/u);
  assert.equal(view.historicalRuntimeCount, 2);
  assert.ok(view.stages.every(stage => stage.records.length === 0));
});

test("每记录ID最高version为当前事实；新版撤回覆盖旧reported而保留其他独立记录", () => {
  const old = record("revised", { version: 1 });
  const withdrawn = record("revised", { version: 2, status: "rejected_or_withdrawn", recordedAt: "2026-10-09T02:00:00.000Z" });
  const independent = record("independent");
  const s = summary([withdrawn, independent, old]);
  const view = buildSubmissionChecklist(ready(rules()), ready(s));
  const final = view.stages.find(stage => stage.id === "final")!;
  assert.deepEqual(final.records.map(item => [item.id, item.version, item.status]), [["revised", 2, "rejected_or_withdrawn"], ["independent", 1, "reported"]]);
  assert.match(submissionRecordLabel(final.records[0]!), /拒绝或撤回/u);
  assert.match(view.deliveryNotice, /不汇总为整场提交成功/u);
  assert.equal(view.savedCommit, currentCommit);
  assert.match(view.runtimeNotice, /没有对应的运行记录/u);
});

test("多阶段独立展示：初轮已报告不掩盖最终未提交或展示阶段无记录", () => {
  const qualifier = record("qualifier-report", { stageId: "qualifier", platformUrl: "https://event.example/qualifier" });
  const final = record("final-not-yet", { status: "not_submitted", submittedAt: null, evidenceRefs: [] });
  const view = buildSubmissionChecklist(ready(rules()), ready(summary([qualifier, final], verification())));
  assert.equal(view.stages[0]!.records[0]?.status, "reported");
  assert.equal(view.stages[1]!.records[0]?.status, "not_submitted");
  assert.deepEqual(view.stages[2]!.records, []);
  assert.match(submissionRecordLabel(view.stages[0]!.records[0]!), /成员已报告提交/u);
  assert.match(submissionRecordLabel(view.stages[1]!.records[0]!), /未提交/u);
  assert.match(view.deliveryNotice, /逐个阶段/u);
});

test("旧规则、旧确认revision、旧赛事与已移除阶段归历史，不污染当前阶段", () => {
  const current = record("current");
  const obsolete = [
    record("old-rules", { requirementsVersion: "event:2:2" }),
    record("old-confirmation", { requirementsVersion: "event:3:1" }),
    record("old-event", { eventId: "previous-event", requirementsVersion: "previous-event:3:2" }),
    record("removed-stage", { stageId: "removed" }),
  ];
  const view = buildSubmissionChecklist(ready(rules()), ready(summary([...obsolete, current])));
  assert.deepEqual(view.stages.find(stage => stage.id === "final")!.records, [current]);
  assert.deepEqual(new Set(view.history.map(item => item.id)), new Set(obsolete.map(item => item.id)));
  assert.deepEqual(view.unclassifiedRecords, []);
});

test("没有可核对规则时记录保留为未分类，不能冒造阶段名称或静默删除历史", () => {
  const existing = record("old", { requirementsVersion: "event:1:1" });
  const current = record("same-id", { version: 2, status: "rejected_or_withdrawn" });
  const old = record("same-id", { version: 1 });
  for (const state of [ready<SpaceRules>({ confirmation: null, rules: null }), { status: "error", message: "读取失败" } as const, { status: "loading" } as const]) {
    const view = buildSubmissionChecklist(state, ready(summary([old, existing, current])));
    assert.deepEqual(view.stages, []);
    assert.deepEqual(view.history, []);
    assert.deepEqual(view.unclassifiedRecords.map(item => [item.id, item.version]), [["old", 1], ["same-id", 2]]);
  }
});

test("状态与来源共同决定措辞：user_reported的verified也不能冒充平台核验", () => {
  assert.equal(submissionRecordLabel({ status: "verified", verificationSource: "user_reported" }), "成员已报告提交");
  assert.equal(submissionRecordLabel({ status: "reported", verificationSource: "user_reported" }), "成员已报告提交");
  assert.equal(submissionRecordLabel({ status: "verified", verificationSource: "platform_verified" }), "平台已核验本条提交");
  assert.equal(submissionRecordLabel({ status: "reported", verificationSource: "platform_verified" }), "已报告提交，核验结论待确认");
  for (const source of ["user_reported", "platform_verified"] as const) {
    assert.match(submissionRecordLabel({ status: "not_submitted", verificationSource: source }), /未提交/u);
    assert.match(submissionRecordLabel({ status: "rejected_or_withdrawn", verificationSource: source }), /拒绝或撤回/u);
  }
});

test("外部入口只接受无凭据的绝对HTTP(S)；危险与缺失链接不成为提交入口", () => {
  for (const value of [undefined, null, "", "/submit", "//event.example/submit", "javascript:alert(1)", "data:text/html,<h1>submit</h1>", "file:///tmp/submit", "ftp://event.example/submit", "https://user:secret@event.example/submit", "http://user@event.example/submit", "not a URL"]) assert.equal(publicHttpLink(value), null, String(value));
  assert.equal(publicHttpLink("https://event.example/submit"), "https://event.example/submit");
  assert.equal(publicHttpLink("http://event.example"), "http://event.example/");
  const value = rules(); value.rules!.stages[0]!.submissionUrl = "javascript:alert(1)";
  const view = buildSubmissionChecklist(ready(value), ready(summary()));
  assert.equal(view.stages[0]!.officialUrl, null);
  assert.match(repositoryStatus("unknown"), /结果未知/u);
});

test("纯展示投影不会改写项目阶段、任务、规则或不可变提交事实", () => {
  const d = detail();
  const current = planning([task("z", { status: "todo" }), task("a", { status: "review" })]);
  const r = rules(), s = summary([record("r", { version: 2, status: "rejected_or_withdrawn" }), record("r", { version: 1 })], verification());
  const before = structuredClone({ d, current, r, s });
  buildSpaceLifecycle({ detail: d, current, rules: ready(r), tracks: ready(tracks()) });
  buildSubmissionChecklist(ready(r), ready(s));
  spacePhaseGuides(d.project.id);
  assert.deepEqual({ d, current, r, s }, before);
});
