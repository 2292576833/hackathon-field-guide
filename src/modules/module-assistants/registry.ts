import { ALL_MODULE_ASSISTANT_KEYS, MODULE_ASSISTANT_KEYS, type ModuleAssistantKey, type ModuleAssistantRegistryEntry } from "./model.ts";

/**
 * 计划 34 §2.1 的 7 项助手注册表。每条声明：
 * - key / 标签；
 * - 所需既有 EventStaffCapability（与 competition-workspace.tsx 的 section -> capability 映射逐字一致）；
 * - 可读的既有事实键（只读，不跨赛事、不读他人私人材料）；
 * - 允许的产出类型（只有草稿/清单/摘要/去重提示）；
 * - 挂载的既有工作台 sectionPath（{eventId} 由 ui.ts 替换，绝不新增导航入口）。
 */
export const MODULE_ASSISTANT_REGISTRY: readonly ModuleAssistantRegistryEntry[] = Object.freeze([
  Object.freeze({
    key: "overview" as const,
    label: "本场概览 / 比赛设置",
    audience: "staff" as const,
    requiredCapability: "event_manage" as const,
    readableFactKeys: Object.freeze(["readiness", "publishBlockers", "rulesVersion", "versionChanges", "status", "startsAt", "endsAt"]),
    allowedOutputs: Object.freeze(["summary", "checklist", "draft"] as const),
    sectionPath: "/organizers/workspace/{eventId}/settings",
    readsDescription: "本场发布就绪、发布阻塞项、正式规则版本与变化回执。",
  }),
  Object.freeze({
    key: "registration" as const,
    label: "报名管理",
    audience: "staff" as const,
    requiredCapability: "registration_manage" as const,
    readableFactKeys: Object.freeze(["pendingReviewCount", "approvedCount", "rejectedCount", "withdrawnCount", "draftCount", "formVersion", "capacity", "registrationWindow", "pendingRows"]),
    allowedOutputs: Object.freeze(["summary", "checklist", "draft", "dedup_hint"] as const),
    sectionPath: "/organizers/workspace/{eventId}/registration",
    readsDescription: "本场报名计数与分页、报名表版本与报名时间窗。",
  }),
  Object.freeze({
    key: "teams" as const,
    label: "队伍管理",
    audience: "staff" as const,
    requiredCapability: "teams_manage" as const,
    readableFactKeys: Object.freeze(["confirmedTeamCount", "formingTeamCount", "withdrawnTeamCount", "teamSizeRules", "eligibilityIssues", "proposedGrouping"]),
    allowedOutputs: Object.freeze(["summary", "checklist", "draft"] as const),
    sectionPath: "/organizers/workspace/{eventId}/teams",
    readsDescription: "本场正式名单、组队状态、名额规则与资格待核对项。",
  }),
  Object.freeze({
    key: "communication" as const,
    label: "通知与答疑",
    audience: "staff" as const,
    requiredCapability: "communication_manage" as const,
    readableFactKeys: Object.freeze(["announcementCount", "publishedFaqCount", "openTicketCount", "recentQuestions", "templateCount", "draftAnnouncements"]),
    allowedOutputs: Object.freeze(["draft", "summary", "dedup_hint"] as const),
    sectionPath: "/organizers/workspace/{eventId}/communication",
    readsDescription: "本场公告、公开 FAQ 与私人求助工单的只读摘要。",
  }),
  Object.freeze({
    key: "schedule" as const,
    label: "行程管理",
    audience: "staff" as const,
    requiredCapability: "schedule_manage" as const,
    readableFactKeys: Object.freeze(["draftSessionCount", "publishedSessionCount", "sessions", "timeConflicts", "timezone"]),
    allowedOutputs: Object.freeze(["summary", "checklist", "draft"] as const),
    sectionPath: "/organizers/workspace/{eventId}/schedule",
    readsDescription: "本场行程草稿、已发布行程与同人时间重叠。",
  }),
  Object.freeze({
    key: "services" as const,
    label: "现场服务",
    audience: "staff" as const,
    requiredCapability: "logistics_manage" as const,
    readableFactKeys: Object.freeze(["accommodationAssignedCount", "accommodationUnassignedCount", "mealVoucherIssuedCount", "icebreakingGroupCount", "unassignedPeople"]),
    allowedOutputs: Object.freeze(["checklist", "summary", "draft"] as const),
    sectionPath: "/organizers/workspace/{eventId}/services",
    readsDescription: "本场住宿分配、餐券与破冰分组的只读计数与未分配清单。",
  }),
  Object.freeze({
    key: "judging" as const,
    label: "收件与评审",
    audience: "staff" as const,
    requiredCapability: "judging_manage" as const,
    // 不含任何选手私人点评、互评或留言键：评分期间评审侧 MUST NOT 返回这类内容（宪法 XIII）。
    readableFactKeys: Object.freeze(["receiptCount", "roundStatus", "assignmentCount", "progress", "calibration", "integrity", "fairness", "disclosureGate"]),
    allowedOutputs: Object.freeze(["summary", "checklist", "draft"] as const),
    sectionPath: "/organizers/workspace/{eventId}/judging",
    readsDescription: "本场正式收件回执、轮次冻结、指派与进度，以及只读的校准/自检/公平规则包。",
  }),
  Object.freeze({
    key: "enroll" as const,
    label: "报名向导",
    audience: "participant" as const,
    requiredParticipant: "approved" as const,
    readableFactKeys: Object.freeze(["registrationStatus", "registrationWindow", "formVersion", "formFieldLabels", "deadlineAt"]),
    allowedOutputs: Object.freeze(["checklist", "summary", "draft"] as const),
    sectionPath: "/competitions/{eventId}/register",
    readsDescription: "我的报名状态、报名时间窗、报名表版本与字段清单（只读）。",
  }),
  Object.freeze({
    key: "teamup" as const,
    label: "组队顾问",
    audience: "participant" as const,
    requiredParticipant: "approved" as const,
    readableFactKeys: Object.freeze(["myRoles", "mySkills", "openTeamCount", "myTeamStatus", "hallCandidateCount", "gaps"]),
    allowedOutputs: Object.freeze(["summary", "checklist", "draft"] as const),
    sectionPath: "/competitions/{eventId}/team-hall",
    readsDescription: "我的角色与技能、本场开放队伍、组队大厅候选人数与缺口（只读，不含他人简历全文）。",
  }),
  Object.freeze({
    key: "submit" as const,
    label: "提交检查",
    audience: "participant" as const,
    requiredParticipant: "approved" as const,
    readableFactKeys: Object.freeze(["requiredMaterials", "myMaterialStatus", "submissionWindow", "previousVersion", "missingItems"]),
    allowedOutputs: Object.freeze(["checklist", "summary", "draft"] as const),
    sectionPath: "/competitions/{eventId}/submit",
    readsDescription: "本场要求的提交材料、我的材料完整性、提交时间窗与上次版本（只读）。",
  }),
  Object.freeze({
    key: "results" as const,
    label: "结果解释",
    audience: "participant" as const,
    requiredParticipant: "approved" as const,
    readableFactKeys: Object.freeze(["publishedRevision", "resultStatus", "scoringDimensions", "appealWindow", "myAppealStatus"]),
    allowedOutputs: Object.freeze(["summary", "draft"] as const),
    sectionPath: "/competitions/{eventId}/results",
    readsDescription: "已公布结果的版本、评分维度、申诉窗口与我自己的申诉状态（只读）。",
  }),
  Object.freeze({
    key: "retro" as const,
    label: "复盘引导",
    audience: "participant" as const,
    requiredParticipant: "approved" as const,
    readableFactKeys: Object.freeze(["mySubmissionVersions", "myTeamName", "myRegistrationFacts", "publishedResult"]),
    allowedOutputs: Object.freeze(["summary", "checklist", "draft"] as const),
    sectionPath: "/app/projects/{projectId}/retrospective",
    readsDescription: "我的提交版本、队伍信息、报名事实与已公布结果（只读）。",
  }),
  Object.freeze({
    key: "plan" as const,
    label: "计划助手",
    audience: "participant" as const,
    requiredParticipant: "approved" as const,
    readableFactKeys: Object.freeze(["currentPlanVersion", "taskCount", "openTaskCount", "overdueTaskCount", "myOpenTasks", "dependencies"]),
    allowedOutputs: Object.freeze(["checklist", "summary", "draft"] as const),
    sectionPath: "/app/projects/{projectId}/plan",
    readsDescription: "本项目当前计划版本、任务数量、未完成任务、逾期任务、我的待办与依赖（只读）。",
  }),
  Object.freeze({
    key: "resources" as const,
    label: "资料助手",
    audience: "participant" as const,
    requiredParticipant: "approved" as const,
    readableFactKeys: Object.freeze(["myFavorites", "projectSharedResources", "approvedResourceCount", "recentlyShared"]),
    allowedOutputs: Object.freeze(["summary", "checklist", "draft"] as const),
    sectionPath: "/app/projects/{projectId}/resources",
    readsDescription: "我的收藏、本项目共享的资料、已审核资源数量与最近共享（只读）。",
  }),
] satisfies readonly ModuleAssistantRegistryEntry[]);

export function isModuleAssistantKey(value: unknown): value is ModuleAssistantKey {
  return typeof value === "string" && (ALL_MODULE_ASSISTANT_KEYS as readonly string[]).includes(value);
}

export function moduleAssistant(key: ModuleAssistantKey): ModuleAssistantRegistryEntry {
  const entry = MODULE_ASSISTANT_REGISTRY.find(item => item.key === key);
  /* istanbul ignore next -- 注册表与 MODULE_ASSISTANT_KEYS 由模块测试保证一一对应 */
  if (!entry) throw new Error(`MODULE_ASSISTANT_REGISTRY_MISSING:${key}`);
  return entry;
}

export function moduleAssistantCatalog(): readonly ModuleAssistantRegistryEntry[] {
  return MODULE_ASSISTANT_REGISTRY;
}
