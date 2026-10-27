import type { PlanChange, PlanningInput, PlanningTask } from "./types.ts";

export interface PlanDifferenceRow { label: string; before: string; after: string }
export interface PlanDifferenceGroup { title: string; impact: string; major: boolean; rows: PlanDifferenceRow[] }
export interface PlanDifferenceContext {
  beforeInput?: PlanningInput;
  afterInput: PlanningInput;
  beforeTasks?: readonly PlanningTask[];
  afterTasks: readonly PlanningTask[];
  memberNames?: Readonly<Record<string, string>>;
  /** Defaults to Beijing time; it is never described as the user's timezone. */
  timeZone?: string;
}

const labels: Record<string, string> = {
  title: "任务名称", priority: "必做或可删减", kind: "任务用途", ownerMembershipId: "负责人", helperEfforts: "协助成员与工时",
  deliverable: "交付成果", acceptanceCriteria: "验收条件", reviewerMembershipId: "检查成果的人", durationEstimate: "预计工时", remainingEstimate: "剩余工时",
  dependencyTaskIds: "前置任务", deadlineRef: "截止点", requirementRefs: "覆盖的赛事要求", resourceRefs: "参考资源", resourceContentRefs: "参考资源版本",
  skillRefs: "技能与赛道包版本", reference: "固定技能版本", skillVersion: "技能版本", skillPurpose: "用途", learningMinutes: "学习与接入分钟", environment: "使用环境", agentId: "AI 工具", clientVersion: "客户端版本", os: "系统", contentHash: "固定内容标识", versionId: "版本编号", revision: "审核依据版本",
  splittable: "能否分段工作", contextSwitchMinutes: "恢复工作所需时间", waitMinutes: "外部等待时间", status: "任务状态", cancellationReason: "删减理由",
  buffers: "提交缓冲", deadlines: "截止依据", requirements: "赛事要求", members: "当前成员", availability: "成员可用时间",
  projectRevision: "项目版本", projectFactsVersion: "项目依据版本", requirementVersionId: "赛事规则版本", assignmentVersionId: "分工版本",
  trackSelectionRevision: "赛道选择版本", memberIntentionRefs: "成员意愿版本", availabilityVersions: "可用时间版本", resourceContentVersions: "资源公开版本",
  projectArchived: "空间归档状态", projectReadOnly: "空间只读状态", assumptions: "计划假设", requiredTaskKinds: "必须安排的任务用途", schedule: "计算的工作安排",
  feasibility: "可行性", issues: "待解决问题", reservedMinutes: "预留分钟", basis: "依据", optimisticMinutes: "乐观分钟", likelyMinutes: "常规分钟", pessimisticMinutes: "保守分钟",
  instantUtc: "截止时间", startsAt: "开始时间", endsAt: "结束时间", finishesAt: "预计完成时间", sourceTimeZone: "来源时区", sourceText: "来源原文", verified: "来源已核验",
  description: "要求说明", mandatory: "是否必交", role: "空间角色", confirmedAt: "确认时间", purpose: "时间用途", version: "版本", userId: "成员账号",
};
const names: Record<string, string> = {
  must: "必须完成", optional: "可删减", implementation: "功能开发", learning: "学习与配置", debugging: "调试", handoff: "交接", integration: "集成", testing: "测试", material: "文档与视频", submission: "正式提交准备",
  todo: "待开始", in_progress: "进行中", blocked: "被阻塞", review: "成果待检查", done: "已验收", cancelled: "已删减", active: "有效", removed: "已离开", manager: "管理员", member: "成员",
  unknown: "尚不能确认", feasible: "按当前输入可安排", at_risk: "有延期风险", infeasible: "当前范围排不下", work: "可工作", rest: "休息", occupied: "另有安排",
  registration: "报名", video: "视频", demo: "演示", supplement: "补交", other: "其他",
};
const taskFields = ["title", "priority", "kind", "ownerMembershipId", "helperEfforts", "deliverable", "acceptanceCriteria", "reviewerMembershipId", "durationEstimate", "dependencyTaskIds", "deadlineRef", "requirementRefs", "resourceRefs", "resourceContentRefs", "skillRefs", "splittable", "contextSwitchMinutes", "waitMinutes", "status", "cancellationReason"];

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(record) : []; }
function stable(value: unknown): string { return JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === "object" && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry) ?? "undefined"; }
function zone(value?: string): string { try { new Intl.DateTimeFormat("zh-CN", { timeZone: value || "Asia/Shanghai" }); return value || "Asia/Shanghai"; } catch { return "Asia/Shanghai"; } }
export function planDifferenceTimeZoneLabel(value?: string): string { const resolved = zone(value); return resolved === "Asia/Shanghai" ? "北京时间（Asia/Shanghai）" : `展示时区：${resolved}`; }
function date(value: string, timeZone?: string): string {
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? `待核对：${value}` : new Intl.DateTimeFormat("zh-CN", { timeZone: zone(timeZone), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant);
}
function member(id: unknown, context: PlanDifferenceContext): string { return typeof id === "string" ? context.memberNames?.[id] ?? `待核对成员（${id}）` : "未分配"; }
function text(field: string, value: unknown, input: PlanningInput | undefined, tasks: readonly PlanningTask[], context: PlanDifferenceContext): string {
  if (value === undefined) return "未记录";
  if (value === null) return "未设置";
  if (["ownerMembershipId", "reviewerMembershipId", "membershipId"].includes(field)) return member(value, context);
  if (["instantUtc", "startsAt", "endsAt", "finishesAt", "confirmedAt"].includes(field) && typeof value === "string") return date(value, context.timeZone);
  if (field === "deadlineRef" || field === "deadlineId") {
    const found = input?.deadlines.find(deadline => deadline.id === value);
    return found ? `${names[found.kind] ?? found.kind} · ${date(found.instantUtc, context.timeZone)}\n来源时区：${found.sourceTimeZone} · ${found.verified ? "已核验" : "待核验"}\n${found.sourceText}` : `待核对截止点（${String(value)}）`;
  }
  if (field === "dependencyTaskIds" && Array.isArray(value)) return value.map(id => tasks.find(task => task.id === id)?.title ?? `待核对任务（${String(id)}）`).join("\n") || "无前置任务";
  if (field === "requirementRefs" && Array.isArray(value)) return value.map(id => { const item = input?.requirements.find(requirement => requirement.id === id); return item ? `${item.mandatory ? "必交" : "选交"}：${item.description}` : `待核对要求（${String(id)}）`; }).join("\n") || "未关联要求";
  if (field === "issues" && Array.isArray(value)) return value.map(item => { const issue = record(item); return `${String(issue.message ?? "待核对问题")}\n${String(issue.suggestion ?? "")}`; }).join("\n\n") || "无待解决问题";
  if (field === "resourceContentRefs" && Array.isArray(value)) return value.map(item => { const ref = record(item); return `${String(ref.resourceId)} · 版本 ${String(ref.version)}`; }).join("\n") || "无";
  if (field === "skillRefs" && Array.isArray(value)) return value.map(item => { const selection = record(item), ref = record(selection.reference); return `${ref.kind === "bundle" ? "赛道包" : "技能"} ${String(ref.id)} · 版本 ${String(ref.version)}\n用途：${String(selection.purpose)}\n学习与接入：${String(selection.learningMinutes)} 分钟（计入任务估时）\n${text("environment", selection.environment, input, tasks, context)}`; }).join("\n\n") || "无";
  if (field === "memberIntentionRefs" && Array.isArray(value)) return value.map(item => { const ref = record(item); return `${member(ref.membershipId, context)} · 版本 ${String(ref.revision)}`; }).join("\n") || "无";
  if (field === "availabilityVersions") return Object.entries(record(value)).map(([id, version]) => `${member(id, context)} · 版本 ${String(version)}`).join("\n") || "无";
  if (Array.isArray(value)) return value.map(entry => typeof entry === "string" ? field === "requiredTaskKinds" ? names[entry] ?? entry : entry : String(entry)).join("\n") || "无";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "object") return Object.entries(record(value)).map(([key, entry]) => `${labels[key] ?? key}：${text(key, entry, input, tasks, context)}`).join("\n") || "未记录";
  if (typeof value === "number" && ["contextSwitchMinutes", "waitMinutes"].includes(field)) return `${value} 分钟`;
  return ["priority", "kind", "status", "role", "purpose", "feasibility"].includes(field) ? names[String(value)] ?? String(value) : String(value);
}

/** Presents only persisted differences; no client guesses about new progress or feasibility. */
export function presentPlanChanges(changes: readonly PlanChange[], context: PlanDifferenceContext): PlanDifferenceGroup[] {
  return changes.map(change => {
    const rows: PlanDifferenceRow[] = [];
    const add = (label: string, field: string, before: unknown, after: unknown) => {
      if (stable(before) === stable(after)) return;
      rows.push({ label, before: text(field, before, context.beforeInput, context.beforeTasks ?? [], context), after: text(field, after, context.afterInput, context.afterTasks, context) });
    };
    const keyed = (label: string, before: unknown, after: unknown, key: string, fields: string[], title: (value: Record<string, unknown>) => string) => {
      const old = new Map(array(before).map(item => [String(item[key]), item]));
      const next = new Map(array(after).map(item => [String(item[key]), item]));
      for (const id of new Set([...old.keys(), ...next.keys()])) {
        const a = old.get(id), b = next.get(id), heading = `${label} · ${title(b ?? a ?? {})}`;
        for (const field of fields) add(`${heading} · ${labels[field] ?? field}`, field, a?.[field], b?.[field]);
      }
    };
    const expand = (field: string, before: unknown, after: unknown) => {
      const label = labels[field] ?? field;
      if (field === "durationEstimate" || field === "remainingEstimate") {
        for (const child of ["optimisticMinutes", "likelyMinutes", "pessimisticMinutes", "basis"]) add(`${label} · ${labels[child]}`, child, record(before)[child], record(after)[child]);
      } else if (field === "helperEfforts") {
        const old = new Map(array(before).map(item => [String(item.membershipId), item]));
        const next = new Map(array(after).map(item => [String(item.membershipId), item]));
        for (const id of new Set([...old.keys(), ...next.keys()])) {
          if (!old.has(id) || !next.has(id)) add(`${label} · ${member(id, context)}`, "membershipId", old.has(id) ? id : undefined, next.has(id) ? id : undefined);
          for (const child of ["optimisticMinutes", "likelyMinutes", "pessimisticMinutes", "basis"]) add(`${label} · ${member(id, context)} · ${labels[child]}`, child, record(old.get(id)?.durationEstimate)[child], record(next.get(id)?.durationEstimate)[child]);
        }
      } else if (field === "skillRefs") {
        const selections = (value: unknown) => array(value).map(item => { const ref = record(item.reference); return { ...item, selectionId: `${String(ref.kind)}:${String(ref.id)}`, skillVersion: ref.version, versionId: ref.versionId, contentHash: ref.contentHash, revision: ref.revision, skillPurpose: item.purpose }; });
        keyed(label, selections(before), selections(after), "selectionId", ["skillVersion", "versionId", "contentHash", "revision", "skillPurpose", "learningMinutes", "environment"], item => String(item.selectionId));
      } else if (field === "deadlines") keyed(label, before, after, "id", ["kind", "instantUtc", "sourceTimeZone", "sourceText", "verified"], item => String(item.id));
      else if (field === "requirements") keyed(label, before, after, "id", ["description", "mandatory", "deadlineRef"], item => String(item.description ?? item.id));
      else if (field === "members") keyed(label, before, after, "membershipId", ["role", "status"], item => member(item.membershipId, context));
      else if (field === "buffers") keyed(label, before, after, "deadlineId", ["reservedMinutes", "basis"], item => String(item.deadlineId));
      else if (field === "availability") {
        keyed(label, before, after, "membershipId", ["version", "confirmedAt"], item => member(item.membershipId, context));
        const windows = (value: unknown) => array(value).flatMap(item => array(item.windows).map(window => ({ ...window, key: `${String(item.membershipId)}:${String(window.id)}`, membershipId: item.membershipId })));
        keyed(label, windows(before), windows(after), "key", ["startsAt", "endsAt", "sourceTimeZone", "purpose", "version"], item => `${member(item.membershipId, context)} · 时间段 ${String(item.id)}`);
      } else if (field === "schedule") {
        for (const child of ["startsAt", "finishesAt"]) add(`${label} · ${labels[child]}`, child, record(before)[child], record(after)[child]);
        const allocations = (value: unknown) => array(record(value).allocations).map(item => `${member(item.membershipId, context)}：${String(item.workMinutes)} 分钟工作，${String(item.overheadMinutes)} 分钟恢复工作\n${array(item.segments).map(segment => `${date(String(segment.startsAt), context.timeZone)} → ${date(String(segment.endsAt), context.timeZone)}`).join("\n")}`);
        add(`${label} · 各成员工作段`, "allocations", allocations(before), allocations(after));
      } else add(label, field, before, after);
    };
    if (change.action === "buffer_changed") expand("buffers", change.before, change.after);
    else if (change.action === "input_changed") for (const field of change.fields) expand(field, change.before, change.after);
    else for (const field of change.action === "added" || change.action === "removed" ? taskFields : change.fields) expand(field, field === "schedule" ? change.before : record(change.before)[field], field === "schedule" ? change.after : record(change.after)[field]);
    const task = context.afterTasks.find(item => item.id === change.taskId) ?? context.beforeTasks?.find(item => item.id === change.taskId);
    const action = change.action === "added" ? "新增" : change.action === "removed" ? "移除" : "调整";
    return { title: change.taskId ? `${action}：${task?.title ?? record(change.after).title ?? record(change.before).title ?? change.taskId}` : change.action === "input_changed" ? "计划依据变化" : change.action === "buffer_changed" ? "提交缓冲变化" : "校验结果变化", impact: change.impact, major: change.major, rows };
  }).filter(group => group.rows.length > 0);
}
