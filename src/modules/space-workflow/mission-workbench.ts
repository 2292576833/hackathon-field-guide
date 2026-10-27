import type { CurrentPlanningView, PlanningTask } from "../planning/types.ts";
import { taskResourceGuidance } from "../planning/task-guidance.ts";
import type { MemberAvailability, MyIntentionView, ProjectOfficialTracksView } from "../projects/index.ts";
import type { ReadState, SpaceDetail, SpaceLink, SpaceRules } from "./model.ts";
import { buildSpaceGuideTree } from "./guide-tree.ts";

export interface MissionPreparation {
  rules?: ReadState<SpaceRules>;
  tracks?: ReadState<ProjectOfficialTracksView>;
  intention?: ReadState<MyIntentionView>;
  availability?: ReadState<{ availability: MemberAvailability | null; confirmationRequired: boolean }>;
}
export interface MissionWorkbenchInput {
  detail: SpaceDetail;
  current: CurrentPlanningView | null;
  planningLoading?: boolean;
  planningError?: unknown;
  preparation?: MissionPreparation;
}
export type MissionPlanState = "unknown" | "loading" | "error" | "empty" | "draft" | "needs_review" | "current" | "archived" | "unavailable";
export interface MissionAction extends SpaceLink {
  id: string;
  kind: "prepare" | "check" | "continue" | "start" | "wait" | "view";
  deliverable: string;
  check: string;
  tools: readonly SpaceLink[];
}
export interface MissionWaiting {
  taskId: string;
  title: string;
  href: string;
  problem: string;
  waitingFor: readonly { title: string; owner: string; status: string }[];
}
export interface MissionMemberWork {
  membershipId: string;
  name: string;
  doing: readonly { id: string; title: string; href: string }[];
  reviewing: readonly { id: string; title: string; href: string }[];
  checkedCount: number;
}
export interface MissionWorkbenchView {
  state: MissionPlanState;
  notice: string;
  readonly: boolean;
  solo: boolean;
  primary: MissionAction;
  actions: readonly MissionAction[];
  preparation: readonly MissionAction[];
  waiting: readonly MissionWaiting[];
  members: readonly MissionMemberWork[];
  progress: null | { must: number; checkedMust: number; optional: number; checkedOptional: number; cancelled: number; allMustChecked: boolean; notice: string };
  deadline: null | { instant: string; label: string; basis: string; sourceTimeZone: string; fromSnapshot: boolean };
  lastProgressAt: string | null;
  tasksHref: string;
}

const statusLabels: Record<PlanningTask["status"], string> = { todo: "未开始", in_progress: "正在做", blocked: "遇到问题", review: "待检查", done: "检查记录待核对", cancelled: "已删减" };
/** A status word alone cannot light up a task or unlock a dependency. */
export function missionTaskChecked(task: PlanningTask): boolean {
  const check = task.acceptance;
  return task.status === "done" && Boolean(check && check.acceptedByUserId.trim() && Number.isFinite(Date.parse(check.acceptedAt))
    && ["manager", "reviewer", "self_check"].includes(check.mode) && (check.evidenceRefs.some(value => value.trim()) || check.note.trim()));
}
function preparationAction(id: string, title: string, href: string, purpose: string, deliverable: string, check: string): MissionAction {
  return { id, title, href, purpose, deliverable, check, kind: "prepare", tools: [] };
}

/** Read-only projection of already authorized facts; never persists game progress.
 * An absent read stays unknown, and another project's data is not displayed. */
export function buildMissionWorkbench(input: MissionWorkbenchInput): MissionWorkbenchView {
  const { detail, current } = input, project = detail.project, membership = detail.membership;
  const base = `/app/projects/${encodeURIComponent(project.id)}`, tasksHref = `${base}/plan`;
  const activeMembers = detail.members.filter(member => member.projectId === project.id && member.status === "active");
  const activeIds = new Set(activeMembers.map(member => member.membershipId));
  const authorized = membership.projectId === project.id && membership.status === "active" && activeIds.has(membership.membershipId);
  const readonly = project.stage === "archived";
  const manager = authorized && membership.role === "manager";
  const solo = activeMembers.length <= 1;
  const taskHref = (id: string) => `${tasksHref}#task-${encodeURIComponent(id)}`;
  const memberName = (id: string | null) => {
    const index = activeMembers.findIndex(member => member.membershipId === id);
    if (index < 0) return "负责人待确认";
    const member = activeMembers[index]!;
    return member.membershipId === membership.membershipId ? member.displayName?.trim() ? `${member.displayName.trim()}（我）` : "我" : member.displayName?.trim() || `队友 ${index + 1}`;
  };
  const scopeMatches = Boolean(current?.plan && current.plan.projectId === project.id && current.plan.inputSnapshot.projectId === project.id);
  const readable = authorized && !input.planningLoading && !input.planningError && current !== null && scopeMatches;
  const applied = readable && current!.plan!.status === "applied";
  const goalReady = Boolean(project.goal.trim() && project.minimumDeliverable.trim());
  const prep = input.preparation;
  const tree = buildSpaceGuideTree({ detail, current, planningLoading: input.planningLoading, planningError: input.planningError, rules: prep?.rules, tracks: prep?.tracks });
  const ruleFact = tree.steps.flatMap(step => step.nodes).find(node => node.id === "requirements")!.fact;
  const trackFact = tree.steps.flatMap(step => step.nodes).find(node => node.id === "official-track")!.fact;
  const ruleReview = prep?.rules?.status === "ready" && ruleFact.status !== "recorded";
  const trackReview = prep?.tracks?.status === "ready" && trackFact.status !== "recorded";
  const planReady = Boolean(applied && !current!.inputVersionsChanged && current!.evaluation?.structuralValid && goalReady && !ruleReview && !trackReview);
  const state: MissionPlanState = !authorized ? "unavailable" : readonly ? "archived" : input.planningError ? "error" : input.planningLoading ? "loading" : current === null ? "unknown"
    : !current.plan ? "empty" : !scopeMatches ? "needs_review" : !applied ? "draft" : !planReady ? "needs_review" : "current";
  const notices: Record<MissionPlanState, string> = {
    unavailable: "当前空间身份需要重新核对，不展示任务或成员工作信息。",
    archived: "空间已归档，记录只供回顾。浏览和阶段名称不会改变任务或正式提交结果。",
    unknown: "当前任务尚未读取，不把未知安排当成没有任务。",
    loading: "正在读取当前任务，暂不判断哪些工作可以开始。",
    error: "任务读取失败，当前安排未知。请重新读取后再执行；不能据旧结果判断前置任务已通过。",
    empty: "还没有生效计划。先把目标、本人职责、可投入时间和比赛要求说清楚，再确认任务安排。",
    draft: "已有任务草案，尚未确认生效。可以在团队任务中查看或领取，管理员核对容量与依赖后再确认。",
    needs_review: "空间输入、比赛要求或计划校验需要复核。原成果保留，请到任务进度核对，暂不推荐开始新任务。",
    current: "按当前生效任务与检查记录继续。交出成果先待检查，检查通过才点亮对应任务。",
  };
  const preparation: MissionAction[] = [];
  if (!goalReady) preparation.push(preparationAction("goal", manager ? "先说清楚这次至少做出什么" : "与管理员核对作品目标", `${base}#project-goal`, "用一句话说清用户要完成的核心流程，先缩小范围。", "作品目标和最小成果", "团队能用自己的话说清同一条核心体验，管理员保存后继续。"));
  const intentionRead = prep?.intention;
  const intention = intentionRead?.status === "ready" && intentionRead.value.projectId === project.id && intentionRead.value.membershipRevision === membership.revision && !intentionRead.value.needsConfirmation
    && intentionRead.value.intention?.projectId === project.id && intentionRead.value.intention.userId === membership.userId && intentionRead.value.intention.membershipRevision === membership.revision ? intentionRead.value.intention : null;
  if (!intention?.duties.length) preparation.push(preparationAction("duties", "选择我愿意负责的工作", `${base}/assessment`, intentionRead?.status === "error" ? "本人职责读取失败，请到队友与分工核对。" : "可多选职责；不知道选什么时再让 AI 帮忙，不必先完成整套测评。", "本人愿意承担的职责", "本人保存职责，是否与队友共享由本人选择；意愿不是能力排名。"));
  const availabilityRead = prep?.availability;
  const availability = availabilityRead?.status === "ready" && !availabilityRead.value.confirmationRequired && availabilityRead.value.availability?.projectId === project.id
    && availabilityRead.value.availability.userId === membership.userId && availabilityRead.value.availability.membershipRevision === membership.revision ? availabilityRead.value.availability : null;
  if (!availability || !Number.isFinite(Date.parse(availability.confirmedAt))) preparation.push(preparationAction("time", "确认我能投入的时间", `${base}/team`, availabilityRead?.status === "error" ? "本人时间读取失败，请在队友与分工核对。" : "填写真实工作时间，保留休息和上课等安排；空白不代表全天有空。", "本人可投入的时间窗口", "保存并确认时间；人员或安排变化后重新核对。"));
  if (ruleFact.status !== "recorded" || trackFact.status !== "recorded") preparation.push(preparationAction("rules", "核对本场比赛要求与官方赛道", `${base}/rules`, `${ruleFact.explanation} ${trackFact.explanation}`, "当前比赛要求、官方赛道和各阶段截止", "规则与本空间确认版本相符，主办方未知项需实际核对。"));
  if (!planReady) preparation.push(preparationAction("plan", manager ? "核对并确认任务安排" : "查看安排，与管理员核对分工", tasksHref, notices[state], "有负责人、成果、检查条件、依赖与时间的任务计划", "管理员明确确认生效；任务草案和 AI 建议不会自动成为执行安排。"));
  const tasks = applied ? current!.tasks.filter(task => task.projectId === project.id) : [];
  const live = tasks.filter(task => task.status !== "cancelled");
  const byId = new Map(tasks.map(task => [task.id, task]));
  const scheduled = new Set(planReady ? current!.evaluation!.likely.scheduled.map(item => item.taskId) : []);
  const waitingFor = (task: PlanningTask) => task.dependencyTaskIds.flatMap(id => {
    const prior = byId.get(id);
    return prior && missionTaskChecked(prior) ? [] : [{ title: prior?.title ?? "前置任务缺失", owner: prior ? memberName(prior.ownerMembershipId) : "请管理员核对", status: prior ? statusLabels[prior.status] : "未知" }];
  });
  const own = live.filter(task => task.ownerMembershipId === membership.membershipId);
  const canCheck = (task: PlanningTask) => manager || task.reviewerMembershipId === membership.membershipId || task.ownerMembershipId === membership.membershipId && task.reviewerMembershipId === null;
  const reviews = live.filter(task => task.status === "review");
  const actionable = planReady && !readonly ? live.filter(task => task.status === "review" && canCheck(task) || task.ownerMembershipId === membership.membershipId
    && (task.status === "in_progress" && !waitingFor(task).length || task.status === "todo" && scheduled.has(task.id) && !waitingFor(task).length && activeIds.has(task.ownerMembershipId))) : [];
  const sortOrder = { review: 0, in_progress: 1, todo: 2, blocked: 3, done: 4, cancelled: 5 };
  actionable.sort((a, b) => sortOrder[a.status] - sortOrder[b.status] || a.title.localeCompare(b.title));
  const actions: MissionAction[] = actionable.map(task => ({ id: task.id, title: task.status === "review" ? `检查成果：${task.title}` : task.status === "in_progress" ? `继续：${task.title}` : `开始：${task.title}`,
    href: taskHref(task.id), purpose: task.status === "review" ? `这项成果由${memberName(task.ownerMembershipId)}交出，等你按条件检查。` : task.status === "in_progress" ? "你已标记正在做；继续实际工作，遇到问题及时记录。" : "当前计划已安排工作时间，前置成果已检查通过或无需前置。实际时间变化请先核对。",
    kind: task.status === "review" ? "check" : task.status === "in_progress" ? "continue" : "start", deliverable: task.deliverable, check: task.acceptanceCriteria.join("；") || "检查条件待核对，请联系管理员。", tools: taskResourceGuidance(task.kind, project.id) }));
  const waiting: MissionWaiting[] = own.filter(task => !missionTaskChecked(task) && task.status !== "review" && (!planReady || task.status === "blocked" || waitingFor(task).length > 0 || task.status === "todo" && !scheduled.has(task.id) || task.status === "done")).map(task => ({
    taskId: task.id, title: task.title, href: taskHref(task.id), problem: task.status === "blocked" ? task.blocker?.trim() || "负责人还没有说明遇到的问题，请补充。" : !planReady ? "计划依据需要复核。" : task.status === "done" ? "缺少可核对的检查记录，不视为完成。" : waitingFor(task).length ? "前置成果尚未检查通过。" : current!.evaluation?.likely.issues.find(issue => issue.taskIds.includes(task.id))?.message || "当前还没有安排可执行工作时间，请核对时间与容量。", waitingFor: waitingFor(task) }));
  const checked = live.filter(missionTaskChecked), must = live.filter(task => task.priority === "must"), optional = live.filter(task => task.priority === "optional");
  const progress = applied ? { must: must.length, checkedMust: must.filter(missionTaskChecked).length, optional: optional.length, checkedOptional: optional.filter(missionTaskChecked).length, cancelled: tasks.filter(task => task.status === "cancelled").length,
    allMustChecked: planReady && must.length > 0 && must.every(missionTaskChecked), notice: "点亮依据真实检查记录。全部必做项齐备仍需核对当前版本运行、材料和主办方正式提交；可选与删减任务分开统计。" } : null;
  const members: MissionMemberWork[] = applied ? activeMembers.map(member => ({ membershipId: member.membershipId, name: memberName(member.membershipId),
    doing: live.filter(task => task.ownerMembershipId === member.membershipId && task.status === "in_progress").map(task => ({ id: task.id, title: task.title, href: taskHref(task.id) })),
    reviewing: reviews.filter(task => task.reviewerMembershipId === member.membershipId || member.role === "manager" || task.ownerMembershipId === member.membershipId && task.reviewerMembershipId === null).map(task => ({ id: task.id, title: task.title, href: taskHref(task.id) })),
    checkedCount: checked.filter(task => task.ownerMembershipId === member.membershipId).length })) : [];
  const pendingDeadlineIds = new Set(live.filter(task => !missionTaskChecked(task)).map(task => task.deadlineRef));
  const nextDeadline = applied ? current!.plan!.inputSnapshot.deadlines.filter(deadline => pendingDeadlineIds.has(deadline.id) && Number.isFinite(Date.parse(deadline.instantUtc))).sort((a, b) => Date.parse(a.instantUtc) - Date.parse(b.instantUtc))[0] : undefined;
  const deadline = nextDeadline ? { instant: nextDeadline.instantUtc, label: nextDeadline.verified ? "计划引用的已核对截止" : "计划中的待核对截止", basis: nextDeadline.sourceText, sourceTimeZone: nextDeadline.sourceTimeZone, fromSnapshot: true }
    : project.deadline && Number.isFinite(Date.parse(project.deadline)) ? { instant: project.deadline, label: "团队安排的截止", basis: "来自空间设置，不代表主办方正式截止。", sourceTimeZone: project.timezone, fromSnapshot: false } : null;
  let primary: MissionAction;
  if (!authorized) primary = { ...preparationAction("unavailable", "重新打开我的团队空间", "/app", notices.unavailable, "当前有效的空间身份", "通过当前成员权限读取后继续。"), kind: "view" };
  else if (readonly) primary = { ...preparationAction("archive", "查看复盘与经验", `${base}/retrospective`, notices.archived, "已保存的实际成果和经验", "归档阶段不证明任务或正式提交成功。"), kind: "view" };
  else if (["loading", "error", "unknown"].includes(state)) primary = { ...preparationAction("read", "查看并重新读取任务安排", tasksHref, notices[state], "当前计划与实际检查记录", "重新读取成功后再判断，不据旧结果开始。"), kind: "view" };
  else if (state === "current" && actions[0]) primary = actions[0];
  else if (progress?.allMustChecked) primary = { ...preparationAction("delivery", "必做成果已齐，检查演示与正式提交", `${base}/delivery`, "当前生效计划的必做任务都有检查记录；正式交付仍需单独核对。", "当前可运行的版本、必交材料与提交回执", "保存、运行验证与正式提交分别记录。"), kind: "view" };
  else if (state === "needs_review" && goalReady) primary = preparationAction("review-plan", manager ? "重新核对任务计划" : "核对计划变化，联系管理员", tasksHref, notices[state], "与当前比赛要求、成员和时间相符的计划", "保留已有成果，核对版本、时间容量和依赖后再明确确认。");
  else if (state !== "current") primary = preparation[0] ?? preparationAction("plan", "核对任务计划", tasksHref, notices[state], "可执行计划", "明确确认后继续。");
  else if (waiting[0]) primary = { ...preparationAction("waiting", "说明阻塞，和相关队友核对", waiting[0].href, waiting[0].problem, "具体问题、需要谁提供什么，以及可接手的条件", "前置成果检查通过后再开始；没有独立任务时请管理员拆分可并行工作。"), kind: "wait" };
  else primary = { ...preparationAction("no-task", "查看全队任务，确认我能接手什么", tasksHref, "当前没有与你相关的可执行待办，不把无任务当作已经完成。", "适合本人时间与职责的任务安排", "与管理员核对分工；没有生效任务时从草案领取并等待确认。"), kind: "view" };
  return { state, notice: notices[state], readonly, solo, primary, actions, preparation: authorized ? preparation : [], waiting, members, progress, deadline: authorized ? deadline : null, lastProgressAt: applied ? current!.lastProgressAt : null, tasksHref };
}
