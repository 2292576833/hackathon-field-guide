import type { ProjectStage } from "../projects/index.ts";
import type { SubmissionRecord } from "../github/index.ts";
import type { LifecycleInput, LifecycleView, ReadState, SpaceDeliverySummary, SpacePhase, SpaceRules, SubmissionView } from "./model.ts";

export function initialSpacePhase(stage: ProjectStage): SpacePhase {
  return ({ draft: "formation", preparing: "preparation", active: "competition", finalizing: "presentation", submitted: "reflection", retrospective: "reflection", archived: "reflection" } as const)[stage];
}

export function buildSpaceLifecycle(input: LifecycleInput): LifecycleView {
  const { detail, current } = input;
  const project = detail.project, base = `/app/projects/${encodeURIComponent(project.id)}`;
  const readonly = project.stage === "archived";
  const canManage = detail.membership.role === "manager";
  const planningStatus: LifecycleView["planningStatus"] = input.planningError ? "error" : input.planningLoading ? "loading" : current === null ? "unread" : !current.plan ? "empty" : current.inputVersionsChanged ? "changed" : "current";
  const planningNotice = {
    error: "任务计划读取失败，当前安排未知。请到任务进度重新读取，不能按空计划处理。",
    loading: "正在读取任务计划，暂不判断当前任务条件。",
    unread: "任务计划尚未读取，暂不判断是否已有生效计划。",
    empty: "还没有生效计划。一个人也可以先选职责、填写时间，再确认任务安排。",
    changed: "空间资料或比赛要求、分工、可用时间有更新，请重新核对计划。",
    current: "下一步依据当前生效计划；任务能否开始仍需查看实际时间与前置检查。",
  }[planningStatus];
  const related = planningStatus === "current" ? current!.tasks.filter(task => task.status !== "cancelled" && task.status !== "done" &&
    (task.ownerMembershipId === detail.membership.membershipId || task.helperEfforts.some(helper => helper.membershipId === detail.membership.membershipId) ||
      task.status === "review" && (canManage || task.reviewerMembershipId === detail.membership.membershipId))) : [];
  const statusOrder = { review: 0, in_progress: 1, blocked: 2, todo: 3, done: 4, cancelled: 5 };
  related.sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || a.title.localeCompare(b.title));
  let next = { title: "核对比赛要求", href: `${base}/rules`, purpose: "核对资格、官方赛道、必交材料和截止，再确定这次的安排。" };
  if (readonly) next = { title: "查看已保存的复盘与经验", href: `${base}/retrospective`, purpose: "空间已归档，工作记录只读；查看真实成果和后续可复用的经验。" };
  else if (!project.goal.trim() || !project.minimumDeliverable.trim()) next = { title: canManage ? "写清楚这次要做出什么" : "与管理员核对作品目标", href: `${base}#project-goal`, purpose: "作品目标或最小成果还未写清。先确定一个能实际体验的流程。" };
  else if (project.stage === "finalizing") next = { title: "检查当前作品并核对提交", href: `${base}/delivery`, purpose: "分别核对保存版本、当前版本运行和每个提交阶段的真实记录。" };
  else if (["submitted", "retrospective"].includes(project.stage)) next = { title: "核对交付记录并整理经验", href: `${base}/retrospective`, purpose: "空间阶段不是提交成功证明。复盘仍需核对代码、运行和各阶段记录。" };
  else if (planningStatus === "error" || planningStatus === "unread" || planningStatus === "loading") next = { title: "读取当前任务安排", href: `${base}/plan`, purpose: planningNotice };
  else if (planningStatus === "changed") next = { title: canManage ? "重新核对任务计划" : "查看计划变更并联系管理员", href: `${base}/plan`, purpose: planningNotice };
  else if (input.tracks?.status === "ready" && input.tracks.value.needsReview) next = { title: "重新核对官方赛道与规则", href: `${base}/rules`, purpose: "官方赛道或规则选择需要复核，旧选择和计划仍保留。" };
  else if (project.stage === "active" && planningStatus === "current") next = related.length ?
    { title: `查看任务：${related[0]!.title}`, href: `${base}/plan#task-${encodeURIComponent(related[0]!.id)}`, purpose: related[0]!.status === "review" ? "先查看成果和检查依据，再在任务页按当前权限处理。" : "查看这项任务的前置成果、时间与主要动作，再继续实际工作。" } :
    { title: "查看全队任务与分工", href: `${base}/plan`, purpose: "当前计划暂时没有与你有关的待办；查看全队安排并与管理员核对分工。" };
  else if (input.rules?.status === "ready" && !input.rules.value.confirmation) next = { title: "确认本场比赛的规则", href: `${base}/rules`, purpose: "当前空间还没有已确认规则版本；团队手填时间不等同于官方截止。" };
  else if (planningStatus === "empty") next = { title: "选择职责，再确认任务计划", href: `${base}/assessment`, purpose: "可以自选职责，也可使用 AI 建议。分工与计划仍需在原操作页确认。" };
  else if (project.stage === "preparing") next = { title: "查看已确认的任务安排", href: `${base}/plan`, purpose: "按本人的可用时间准备环境和最小成果；需要时再使用 GitHub 和技能。" };
  const pendingIds = new Set(planningStatus === "current" ? current!.tasks.filter(task => !["done", "cancelled"].includes(task.status)).map(task => task.deadlineRef) : []);
  const deadline = planningStatus === "current" ? current!.plan!.inputSnapshot.deadlines.filter(value => pendingIds.has(value.id) && Number.isFinite(Date.parse(value.instantUtc))).sort((a, b) => Date.parse(a.instantUtc) - Date.parse(b.instantUtc))[0] : undefined;
  return {
    initialPhase: initialSpacePhase(project.stage), readonly, solo: detail.members.filter(member => member.status === "active").length <= 1,
    goal: project.goal, minimumDeliverable: project.minimumDeliverable, planningStatus, planningNotice, next,
    relatedTasks: related.slice(0, 3).map(task => ({ id: task.id, title: task.title, status: task.status, href: `${base}/plan#task-${encodeURIComponent(task.id)}` })),
    deadline: deadline ? { instant: deadline.instantUtc, label: deadline.verified ? "计划中已核对的比赛要求截止" : "计划中的待核对或团队安排截止", basis: deadline.sourceText, fromSnapshot: true } :
      project.deadline ? { instant: project.deadline, label: "团队安排的截止", basis: "来自空间设置，不代表主办方正式截止。", fromSnapshot: false } : null,
  };
}

export function publicHttpLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function submissionRecordLabel(record: Pick<SubmissionRecord, "status" | "verificationSource">): string {
  if (record.status === "not_submitted") return record.verificationSource === "user_reported" ? "成员记录为未提交" : "平台记录为未提交";
  if (record.status === "rejected_or_withdrawn") return record.verificationSource === "user_reported" ? "成员记录为拒绝或撤回" : "平台记录为拒绝或撤回";
  if (record.status === "verified" && record.verificationSource === "platform_verified") return "平台已核验本条提交";
  if (record.verificationSource === "user_reported") return "成员已报告提交";
  return "已报告提交，核验结论待确认";
}
function recordHeads(records: readonly SubmissionRecord[]): SubmissionRecord[] {
  const heads = new Map<string, SubmissionRecord>();
  for (const record of records) if (!heads.has(record.id) || heads.get(record.id)!.version < record.version) heads.set(record.id, record);
  return [...heads.values()].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.id.localeCompare(b.id));
}

export function buildSubmissionChecklist(rules: ReadState<SpaceRules>, delivery: ReadState<SpaceDeliverySummary>): SubmissionView {
  const confirmed = rules.status === "ready" ? rules.value : null;
  const matches = Boolean(confirmed?.confirmation && confirmed.rules && confirmed.confirmation.eventId === confirmed.rules.eventId && confirmed.confirmation.rulesVersion === confirmed.rules.version);
  const rulesStatus: SubmissionView["rulesStatus"] = rules.status !== "ready" ? rules.status : !confirmed?.confirmation || !confirmed.rules ? "empty" : matches ? "ready" : "mismatch";
  const currentRules = matches ? confirmed!.rules! : null;
  const version = matches ? `${confirmed!.confirmation!.eventId}:${confirmed!.confirmation!.rulesVersion}:${confirmed!.confirmation!.revision}` : null;
  const summary = delivery.status === "ready" ? delivery.value : null;
  const heads = recordHeads(summary?.submission.records ?? []);
  const stages = currentRules?.stages.filter(stage => stage.stageType === "submission" || stage.stageType === "pitch" || Boolean(stage.submissionUrl)) ?? [];
  const currentStageIds = new Set(stages.map(stage => stage.id));
  const history = currentRules ? heads.filter(record => record.eventId !== currentRules.eventId || record.requirementsVersion !== version || !currentStageIds.has(record.stageId)) : [];
  const runtime = summary?.runtime;
  const currentVerification = runtime?.latestVerification;
  const shaMatches = Boolean(runtime?.currentCommitSha && summary?.repository.latestSavedOperation?.commitSha?.toLowerCase() === runtime.currentCommitSha.toLowerCase() && runtime.matchStatus === "matched" && currentVerification?.repositoryCommitSha?.toLowerCase() === runtime.currentCommitSha.toLowerCase());
  let runtimeNotice = "运行记录尚未读取，当前版本结果未知。";
  if (summary) runtimeNotice = !runtime?.currentCommitSha ? "没有可关联的已保存版本，当前版本运行结果未知。已有手动运行记录仍可在详情查看。" : !shaMatches ? "当前已保存版本还没有对应的运行记录；旧版本或未填写版本的结果不能代替。" :
    currentVerification!.outcome === "passed" ? "成员记录当前已保存版本运行通过，请查看实际环境、步骤和证据。" :
    currentVerification!.outcome === "failed" ? "成员记录当前已保存版本运行未通过，请查看问题与证据。" : "成员记录当前已保存版本运行无法确认，请补充实际检查依据。";
  if (delivery.status === "error") runtimeNotice = "运行记录读取失败，当前结果未知。";
  const repositoryNotice = !summary ? "保存记录尚未读取，当前结果未知。" : summary.repository.latestSavedOperation?.commitSha ?
    `已保存过仓库版本；最近一次操作状态为 ${repositoryStatus(summary.repository.status)}。是否合入指定分支、公开或满足规则仍待核对。` : "没有可关联的已保存仓库版本。可以按比赛要求手动保存，GitHub 不是使用空间的前置条件。";
  return {
    rulesStatus, rulesVersion: version,
    rulesNotice: rulesStatus === "error" ? "比赛要求读取失败，材料和官方入口未知。" : rulesStatus === "loading" ? "正在读取已确认的比赛要求。" : rulesStatus === "unread" ? "比赛要求尚未读取。" : rulesStatus === "empty" ? "还没有完整的已确认规则，请先核对本场要求、阶段与官方入口。" : rulesStatus === "mismatch" ? "规则与确认版本未对齐，请重新读取后核对，暂不把记录归入当前阶段。" : `按已确认的规则版本 ${currentRules!.version} 核对；是否有更新仍需到比赛要求查看。`,
    stages: stages.map(stage => ({ id: stage.id, title: stage.name, officialUrl: publicHttpLink(stage.submissionUrl), deadline: stage.endsAt,
      requirements: currentRules!.requirements.filter(item => item.stageId === stage.id).map(item => ({ id: item.id, title: item.label, necessity: item.necessity })),
      records: heads.filter(record => record.eventId === currentRules!.eventId && record.requirementsVersion === version && record.stageId === stage.id),
    })),
    generalRequirements: currentRules?.requirements.filter(item => item.stageId === null).map(item => ({ id: item.id, title: item.label, necessity: item.necessity })) ?? [],
    deliveryStatus: delivery.status,
    deliveryNotice: delivery.status === "error" ? "交付记录读取失败，当前结果未知" : delivery.status === "loading" ? "正在读取保存、运行与各阶段提交记录。" : delivery.status === "unread" ? "交付记录尚未读取，不能判断是否有记录。" : "逐个阶段核对以下记录。成员自报、未提交、拒绝或撤回以及历史记录均保留，不汇总为整场提交成功。",
    repositoryNotice: delivery.status === "error" ? "保存记录读取失败，当前结果未知。" : repositoryNotice,
    savedCommit: summary?.repository.latestSavedOperation?.commitSha ?? null,
    runtimeNotice, historicalRuntimeCount: summary?.runtime.verificationHistory.length ?? 0,
    history, unclassifiedRecords: currentRules ? [] : heads,
  };
}
export function repositoryStatus(status: SpaceDeliverySummary["repository"]["status"]): string {
  return ({ not_saved: "尚无保存操作", draft: "草稿", ready_for_preview: "待预览", saving: "保存中", saved: "已保存", blocked: "受阻", failed: "失败", unknown: "结果未知" } as const)[status];
}
