import type {
  AvailabilityWindow, BufferPolicy, DurationEstimate, PlanningInput, PlanningIssue,
  PlanningTask, ScheduleResult, ScheduledTask, TaskKind, TimeSegment, ValidationResult,
} from "./types.ts";
import { hasResourceReviewRisk, reviewResourceContentRefs, validatePinnedResourceRefs } from "./resource-refs.ts";

const MINUTE = 60_000;
export const planningTaskKindLabels: Record<TaskKind, string> = {
  implementation: "功能开发", learning: "学习与配置", debugging: "调试", handoff: "交接",
  integration: "集成", testing: "测试", material: "文档与视频", submission: "正式提交准备",
};
const taskKindExamples: Record<TaskKind, string> = {
  implementation: "做出能体验的核心功能", learning: "试用工具并准备运行环境", debugging: "复现并修正具体问题", handoff: "写清成果位置与接手方法",
  integration: "把页面和接口连起来试一次", testing: "按检查条件试用主要流程", material: "准备演示说明、PPT或视频", submission: "打包并核对要交的文件",
};
const kinds = new Set(["implementation", "learning", "debugging", "handoff", "integration", "testing", "material", "submission"]);
const statuses = new Set(["todo", "in_progress", "blocked", "review", "done", "cancelled"]);
type Interval = { start: number; end: number };
type InstantResult = { value: number | null; code?: string; severity?: "error" | "unknown"; message?: string };
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const finiteMinutes = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(value * MINUTE);
const iso = (value: number): string => new Date(value).toISOString();

function issue(code: string, severity: PlanningIssue["severity"], message: string, taskIds: string[] = [], extra: Partial<PlanningIssue> = {}): PlanningIssue {
  return { code, severity, message, taskIds, suggestion: "补充或修正对应输入后重新校验。", ...extra };
}

/** Strict RFC3339: a bare date/local clock is never converted with host timezone. */
function instant(value: unknown, timeZone?: unknown): InstantResult {
  if (!nonempty(value)) return { value: null, code: "TIME_UNCONFIRMED", severity: "unknown", message: "时间缺失，需要确认精确时间和时区。" };
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return { value: null, code: "TIME_AMBIGUOUS", severity: "unknown", message: "时间必须包含日期、时分秒和 Z 或明确 UTC 偏移，不能推测模糊时间。" };
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, offset] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHour = offset === "Z" ? 0 : Number(offset.slice(1, 3));
  const offsetMinute = offset === "Z" ? 0 : Number(offset.slice(4, 6));
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > (days[month - 1] ?? 0) || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59 || offset === "-00:00") {
    return { value: null, code: "INVALID_TIME", severity: "error", message: "时间包含无效日期、时刻或未知 UTC 偏移。" };
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return { value: null, code: "INVALID_TIME", severity: "error", message: "时间不在支持的日期范围。" };
  if (timeZone !== undefined) {
    if (!nonempty(timeZone)) return { value: null, code: "TIME_ZONE_UNCONFIRMED", severity: "unknown", message: "必须保存来源 IANA 时区。" };
    if (/^[+-]/.test(timeZone)) return { value: null, code: "INVALID_TIME_ZONE", severity: "error", message: "来源时区必须为 IANA 名称，不能只保存数字偏移。" };
    let formatter: Intl.DateTimeFormat;
    try {
      formatter = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    } catch {
      return { value: null, code: "INVALID_TIME_ZONE", severity: "error", message: `无法识别来源时区 ${timeZone}。` };
    }
    // Z is a canonical UTC instant plus a separately retained source timezone.
    // Offset-bearing local input must round-trip through its IANA zone, including DST.
    if (offset !== "Z") {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
      if (Number(parts.year) !== year || Number(parts.month) !== month || Number(parts.day) !== day || Number(parts.hour) !== hour || Number(parts.minute) !== minute || Number(parts.second) !== second) {
        return { value: null, code: "TIME_ZONE_OFFSET_CONFLICT", severity: "error", message: `时间的 UTC 偏移与来源时区 ${timeZone} 不一致，需明确确认。` };
      }
    }
  }
  void fraction;
  return { value: timestamp };
}

function merge(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter(i => i.end > i.start).map(i => ({ ...i })).sort((a, b) => a.start - b.start || a.end - b.end);
  const result: Interval[] = [];
  for (const interval of sorted) {
    const previous = result[result.length - 1];
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else result.push(interval);
  }
  return result;
}

function subtract(windows: Interval[], exclusions: Interval[]): Interval[] {
  const blocked = merge(exclusions);
  const result: Interval[] = [];
  for (const window of windows) {
    let start = window.start;
    for (const block of blocked) {
      if (block.end <= start) continue;
      if (block.start >= window.end) break;
      if (block.start > start) result.push({ start, end: Math.min(block.start, window.end) });
      start = Math.max(start, block.end);
      if (start >= window.end) break;
    }
    if (start < window.end) result.push({ start, end: window.end });
  }
  return result;
}

function windowIntervals(projectId: string, membershipId: string, windows: readonly AvailabilityWindow[]): { work: Interval[]; exclusions: Interval[]; issues: PlanningIssue[] } {
  const issues: PlanningIssue[] = [];
  const work: Interval[] = [], exclusions: Interval[] = [];
  const ids = new Set<string>();
  if (!Array.isArray(windows)) return { work, exclusions, issues: [issue("INVALID_AVAILABILITY_WINDOWS", "error", "可用时间子窗口必须是数组。", [], { membershipId })] };
  for (const window of windows) {
    if (!record(window)) { issues.push(issue("INVALID_AVAILABILITY_WINDOW", "error", "子窗口结构无效。", [], { membershipId })); continue; }
    if (!nonempty(window.id) || ids.has(window.id)) issues.push(issue("INVALID_WINDOW_ID", "error", "子窗口 ID 缺失或重复。", [], { membershipId }));
    else ids.add(window.id);
    if (window.projectId !== projectId || window.membershipId !== membershipId) issues.push(issue("WINDOW_SCOPE_MISMATCH", "error", "子窗口必须属于同一项目和项目成员。", [], { membershipId }));
    if (!integer(window.version)) issues.push(issue("INVALID_WINDOW_VERSION", "error", "子窗口版本无效。", [], { membershipId }));
    if (typeof window.purpose !== "string" || !["work", "rest", "occupied"].includes(window.purpose)) issues.push(issue("INVALID_WINDOW_PURPOSE", "error", "子窗口用途必须是工作、休息或已占用。", [], { membershipId }));
    const start = instant(window.startsAt, window.sourceTimeZone ?? "");
    const end = instant(window.endsAt, window.sourceTimeZone ?? "");
    for (const parsed of [start, end]) if (parsed.value === null) issues.push(issue(parsed.code!, parsed.severity!, parsed.message!, [], { membershipId }));
    if (start.value === null || end.value === null) continue;
    if (end.value <= start.value) { issues.push(issue("INVALID_WINDOW_RANGE", "error", "子窗口结束必须晚于开始。", [], { membershipId })); continue; }
    if (window.projectId !== projectId || window.membershipId !== membershipId) continue;
    if (window.purpose === "work") work.push({ start: start.value, end: end.value });
    else if (window.purpose === "rest" || window.purpose === "occupied") exclusions.push({ start: start.value, end: end.value });
  }
  return { work: merge(work), exclusions: merge(exclusions), issues };
}

export function validateAvailabilityWindows(projectId: string, membershipId: string, windows: readonly AvailabilityWindow[]): PlanningIssue[] {
  return windowIntervals(projectId, membershipId, windows).issues;
}

/** Pure derived windows: never writes M02's versioned availability collection. */
export function normalizeAvailabilityWindows(projectId: string, membershipId: string, windows: readonly AvailabilityWindow[], now: Date | string): { windows: TimeSegment[]; issues: PlanningIssue[]; capacityMinutes: number } {
  const parsed = windowIntervals(projectId, membershipId, windows);
  const current = now instanceof Date ? now.getTime() : instant(now).value;
  if (current === null || !Number.isFinite(current)) return { windows: [], issues: [...parsed.issues, issue("INVALID_NOW", "error", "服务端当前时间无效。")], capacityMinutes: 0 };
  const effective = subtract(parsed.work, parsed.exclusions).map(i => ({ start: Math.max(i.start, current), end: i.end })).filter(i => i.end > i.start);
  return { windows: effective.map(i => ({ startsAt: iso(i.start), endsAt: iso(i.end) })), issues: parsed.issues, capacityMinutes: effective.reduce((sum, i) => sum + (i.end - i.start) / MINUTE, 0) };
}

export function validateDurationEstimate(estimate: DurationEstimate | null | undefined, taskId?: string): PlanningIssue[] {
  const taskIds = taskId ? [taskId] : [];
  if (!record(estimate) || !finiteMinutes(estimate.optimisticMinutes) || !finiteMinutes(estimate.likelyMinutes) || !finiteMinutes(estimate.pessimisticMinutes) || estimate.optimisticMinutes > estimate.likelyMinutes || estimate.likelyMinutes > estimate.pessimisticMinutes) {
    return [issue("INVALID_DURATION_ESTIMATE", "error", "工作估时须满足 0 ≤ 乐观 ≤ 常用 ≤ 悲观，且各项为有限非负分钟数。", taskIds)];
  }
  return nonempty(estimate.basis) ? [] : [issue("LOW_BASIS_ESTIMATE", "risk", "估时缺少依据，应先试做并校正。", taskIds)];
}

type DeadlineData = { at: number; verified: boolean };
type AllocationAttempt = { segments: Interval[]; workMinutes: number; overheadMinutes: number; finish: number; missingMinutes: number; success: boolean };

function allocate(windows: Interval[], release: number, cutoff: number, workMinutes: number, splittable: boolean, contextSwitchMinutes: number): AllocationAttempt {
  const usable = windows.map(i => ({ start: Math.max(i.start, release), end: Math.min(i.end, cutoff) })).filter(i => i.end > i.start);
  if (workMinutes === 0) return { segments: [], workMinutes, overheadMinutes: 0, finish: release, missingMinutes: 0, success: release <= cutoff };
  if (!splittable) {
    const contiguous = usable.find(i => i.end - i.start >= workMinutes * MINUTE);
    const largest = usable.reduce((size, i) => Math.max(size, (i.end - i.start) / MINUTE), 0);
    return contiguous ? { segments: [{ start: contiguous.start, end: contiguous.start + workMinutes * MINUTE }], workMinutes, overheadMinutes: 0, finish: contiguous.start + workMinutes * MINUTE, missingMinutes: 0, success: true }
      : { segments: [], workMinutes, overheadMinutes: 0, finish: release, missingMinutes: Math.max(0, workMinutes - largest), success: false };
  }
  let remaining = workMinutes, overheadMinutes = 0;
  const segments: Interval[] = [];
  for (const window of usable) {
    const overhead = segments.length ? contextSwitchMinutes : 0;
    const capacity = (window.end - window.start) / MINUTE;
    if (capacity <= overhead) continue;
    const amount = Math.min(remaining, capacity - overhead);
    segments.push({ start: window.start, end: window.start + (amount + overhead) * MINUTE });
    remaining -= amount;
    overheadMinutes += overhead;
    if (remaining <= 0) break;
  }
  return { segments, workMinutes: workMinutes - remaining, overheadMinutes, finish: segments[segments.length - 1]?.end ?? release, missingMinutes: Math.max(0, remaining), success: remaining <= 0 };
}

function dependencyCycle(tasks: PlanningTask[], byId: Map<string, PlanningTask>): string[] | null {
  const state = new Map<string, number>();
  const path: string[] = [];
  function visit(id: string): string[] | null {
    if (state.get(id) === 1) return [...path.slice(path.indexOf(id)), id];
    if (state.get(id) === 2) return null;
    state.set(id, 1); path.push(id);
    for (const dependency of byId.get(id)?.dependencyTaskIds ?? []) {
      if (!byId.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    path.pop(); state.set(id, 2); return null;
  }
  for (const task of tasks) { const cycle = visit(task.id); if (cycle) return cycle; }
  return null;
}

/** Stable greedy heuristic, never a proof that an unscheduled plan has no possible solution. */
function schedule(tasks: PlanningTask[], deadlines: Map<string, DeadlineData>, buffers: Map<string, number>, capacity: Map<string, Interval[]>, now: number, scenario: "likelyMinutes" | "pessimisticMinutes"): ScheduleResult {
  const issues: PlanningIssue[] = [], scheduled: ScheduledTask[] = [];
  const byId = new Map(tasks.map(task => [task.id, task]));
  const available = new Map([...capacity].map(([id, windows]) => [id, windows.map(i => ({ ...i }))]));
  const capacityMinutes = Object.fromEntries([...capacity].map(([id, windows]) => [id, windows.reduce((sum, i) => sum + (i.end - i.start) / MINUTE, 0)]));
  const completed = new Map<string, number>();
  const failed = new Set<string>();
  const reservations = [...buffers].flatMap(([id, minutes]) => deadlines.has(id) && minutes > 0 ? [{ id, start: deadlines.get(id)!.at - minutes * MINUTE, end: deadlines.get(id)!.at }] : []);
  const deadlineOf = (task: PlanningTask): number => deadlines.get(task.deadlineRef)?.at ?? now;
  const cutoffOf = (task: PlanningTask): number => deadlineOf(task) - (task.kind === "submission" ? 0 : (buffers.get(task.deadlineRef) ?? 0) * MINUTE);
  const required = new Set<string>();
  function require(id: string): void { if (required.has(id)) return; required.add(id); for (const dependency of byId.get(id)?.dependencyTaskIds ?? []) require(dependency); }
  for (const task of tasks) if (task.priority === "must" && task.status !== "cancelled") require(task.id);
  const inheritedCutoff = new Map(tasks.map(task => [task.id, cutoffOf(task)]));
  function propagate(id: string, cutoff: number, visited: Set<string>): void {
    if (visited.has(id)) return;
    visited.add(id);
    inheritedCutoff.set(id, Math.min(inheritedCutoff.get(id) ?? cutoff, cutoff));
    for (const dependency of byId.get(id)?.dependencyTaskIds ?? []) propagate(dependency, cutoff, visited);
  }
  for (const task of tasks) if (required.has(task.id)) propagate(task.id, cutoffOf(task), new Set());
  for (const task of tasks) {
    if (task.status === "done") completed.set(task.id, Date.parse(task.acceptance!.acceptedAt));
    else if (task.status === "cancelled") failed.add(task.id);
  }
  const pending = tasks.filter(task => task.status !== "done" && task.status !== "cancelled");
  while (pending.length) {
    const ready = pending.filter(task => task.dependencyTaskIds.every(id => completed.has(id) || failed.has(id)));
    if (!ready.length) break;
    ready.sort((a, b) => Number(required.has(b.id)) - Number(required.has(a.id)) || (inheritedCutoff.get(a.id)! - inheritedCutoff.get(b.id)!) || a.id.localeCompare(b.id, "en"));
    const task = ready[0]!;
    pending.splice(pending.indexOf(task), 1);
    const severity = required.has(task.id) ? "error" : "risk";
    const dependencyFailed = task.dependencyTaskIds.filter(id => failed.has(id));
    if (dependencyFailed.length || task.status === "blocked") {
      failed.add(task.id);
      issues.push(issue(dependencyFailed.length ? "DEPENDENCY_UNSCHEDULED" : "BLOCKED_TASK", severity, dependencyFailed.length ? "前置任务尚不能完成，后续任务不能视为可执行。" : `任务仍被阻塞：${task.blocker ?? "原因待补充"}`, [task.id], { chain: [...dependencyFailed, task.id], suggestion: "先解除阻塞或调整已确认的依赖、范围和分工。" }));
      continue;
    }
    const release = Math.max(now, ...task.dependencyTaskIds.map(id => completed.get(id)!));
    const cutoff = Math.min(cutoffOf(task), inheritedCutoff.get(task.id)!);
    const workCutoff = cutoff - task.waitMinutes * MINUTE;
    const excluded = reservations.filter(buffer => !(task.kind === "submission" && task.deadlineRef === buffer.id));
    const efforts = [{ membershipId: task.ownerMembershipId!, estimate: task.remainingEstimate ?? task.durationEstimate }, ...task.helperEfforts.map(helper => ({ membershipId: helper.membershipId, estimate: helper.durationEstimate }))];
    const attempts = efforts.map(effort => ({ membershipId: effort.membershipId, attempt: allocate(subtract(available.get(effort.membershipId) ?? [], excluded), release, workCutoff, effort.estimate[scenario], task.splittable, task.contextSwitchMinutes) }));
    const failure = attempts.find(item => !item.attempt.success);
    if (failure) {
      failed.add(task.id);
      const originalCutoff = Math.min(deadlineOf(task), inheritedCutoff.get(task.id)! === cutoffOf(task) ? deadlineOf(task) : inheritedCutoff.get(task.id)!);
      const relaxed = allocate(available.get(failure.membershipId) ?? [], release, originalCutoff - task.waitMinutes * MINUTE, efforts.find(effort => effort.membershipId === failure.membershipId)!.estimate[scenario], task.splittable, task.contextSwitchMinutes);
      const consumesBuffer = relaxed.success && reservations.some(buffer => relaxed.segments.some(segment => segment.start < buffer.end && buffer.start < segment.end));
      issues.push(issue(consumesBuffer ? "BUFFER_CAPACITY_EXCEEDED" : task.splittable ? "CAPACITY_EXCEEDED" : "CONTIGUOUS_CAPACITY_EXCEEDED", severity, consumesBuffer ? "任务只有占用保留提交缓冲才可能排入当前估时场景。" : task.splittable ? "当前有效窗口无法容纳任务的剩余工作和恢复成本。" : "不可拆任务缺少足够长的连续有效工作窗口。", [task.id], { membershipId: failure.membershipId, deadlineId: task.deadlineRef, missingMinutes: failure.attempt.missingMinutes, suggestion: required.has(task.id) ? "先删减不影响必交项的范围、补充协助或确认可用时间；本贪心排程未找到可执行方案。" : "可考虑取消这个可选任务并保留原因。" }));
      continue;
    }
    const allocations = attempts.map(({ membershipId, attempt }) => {
      available.set(membershipId, subtract(available.get(membershipId) ?? [], attempt.segments));
      return { membershipId, segments: attempt.segments.map(segment => ({ startsAt: iso(segment.start), endsAt: iso(segment.end) })), workMinutes: attempt.workMinutes, overheadMinutes: attempt.overheadMinutes };
    });
    const finish = Math.max(release, ...attempts.map(item => item.attempt.finish)) + task.waitMinutes * MINUTE;
    completed.set(task.id, finish);
    const starts = attempts.flatMap(item => item.attempt.segments.map(segment => segment.start));
    scheduled.push({ taskId: task.id, startsAt: iso(starts.length ? Math.min(...starts) : release), finishesAt: iso(finish), allocations });
  }
  return { scheduled, issues, capacityMinutes };
}

export function validatePlan(input: PlanningInput, tasks: readonly PlanningTask[], policies: readonly BufferPolicy[], now: Date | string): ValidationResult {
  const issues: PlanningIssue[] = [];
  const current = now instanceof Date ? now.getTime() : instant(now).value;
  const checkedAt = current !== null && Number.isFinite(current) ? iso(current) : "";
  const empty = (): ScheduleResult => ({ scheduled: [], issues: [], capacityMinutes: {} });
  const invalidResult = (): ValidationResult => ({ structuralValid: false, feasibility: "infeasible", issues, likely: empty(), pessimistic: empty(), checkedAt, staleInputs: false });
  if (current === null || !Number.isFinite(current)) { issues.push(issue("INVALID_NOW", "error", "服务端当前时间无效。")); return invalidResult(); }
  if (!record(input)) { issues.push(issue("INVALID_PLANNING_INPUT", "error", "计划输入结构无效。")); return invalidResult(); }
  if (!Array.isArray(tasks) || !Array.isArray(policies)) { issues.push(issue("INVALID_PLAN_COLLECTION", "error", "任务与缓冲策略必须为数组。")); return invalidResult(); }
  const array = <T>(value: unknown, name: string): T[] => {
    if (Array.isArray(value)) return value as T[];
    issues.push(issue("INPUT_UNCONFIRMED", value === undefined || value === null ? "unknown" : "error", `${name}尚未提供明确的数组输入。`)); return [];
  };
  const members = array<PlanningInput["members"][number]>(input.members, "当前成员");
  const availability = array<PlanningInput["availability"][number]>(input.availability, "成员可用时间");
  const inputDeadlines = array<PlanningInput["deadlines"][number]>(input.deadlines, "截止点");
  const requirements = array<PlanningInput["requirements"][number]>(input.requirements, "必交要求");
  const resources = array<string>(input.approvedResourceIds, "已审核资源 ID");
  const requiredKinds = array<string>(input.requiredTaskKinds, "必需任务阶段");
  const assumptions = array<string>(input.assumptions, "假设清单");
  if (!nonempty(input.projectId) || !integer(input.projectRevision)) issues.push(issue("INVALID_PROJECT_BASELINE", "error", "项目 ID 或项目版本无效。"));
  const captured = instant(input.capturedAt);
  if (captured.value === null) issues.push(issue(captured.code!, captured.severity!, `输入快照：${captured.message!}`));
  else if (captured.value > current) issues.push(issue("FUTURE_INPUT_SNAPSHOT", "error", "输入快照时间不能晚于服务端当前时间。"));
  if (!nonempty(input.requirementVersionId)) issues.push(issue("REQUIREMENTS_VERSION_UNCONFIRMED", "unknown", "赛事要求版本未确认。"));
  if (assumptions.some(item => !nonempty(item))) issues.push(issue("INVALID_ASSUMPTION", "error", "假设内容必须为非空文字。"));
  else if (assumptions.length) issues.push(issue("UNCONFIRMED_ASSUMPTIONS", "unknown", "计划仍含未确认假设，不能声称已经核验可行。"));
  if (resources.some(id => !nonempty(id)) || new Set(resources).size !== resources.length) issues.push(issue("INVALID_APPROVED_RESOURCE_IDS", "error", "已审核资源 ID 必须非空且不重复。"));
  const memberMap = new Map<string, PlanningInput["members"][number]>();
  for (const member of members) {
    if (!record(member) || !nonempty(member.membershipId) || member.projectId !== input.projectId || !["active", "left", "removed"].includes(member.status) || !["manager", "member"].includes(member.role) || !nonempty(member.userId) || memberMap.has(member.membershipId)) {
      issues.push(issue("INVALID_PROJECT_MEMBERSHIP", "error", "成员必须为同项目的有效且唯一项目成员关系。")); continue;
    }
    memberMap.set(member.membershipId, member);
  }
  const deadlines = new Map<string, DeadlineData>();
  for (const deadline of inputDeadlines) {
    if (!record(deadline) || !nonempty(deadline.id)) { issues.push(issue("INVALID_DEADLINE", "error", "截止点 ID 或结构无效。")); continue; }
    if (deadlines.has(deadline.id)) issues.push(issue("DUPLICATE_DEADLINE", "error", "截止点 ID 重复。", [], { deadlineId: deadline.id }));
    const parsed = instant(deadline.instantUtc, deadline.sourceTimeZone ?? "");
    if (parsed.value === null) { issues.push(issue(parsed.code!, parsed.severity!, parsed.message!, [], { deadlineId: deadline.id })); continue; }
    if (!nonempty(deadline.sourceText)) issues.push(issue("DEADLINE_SOURCE_UNCONFIRMED", "unknown", "截止点缺少来源原文。", [], { deadlineId: deadline.id }));
    if (deadline.verified !== true) issues.push(issue("DEADLINE_UNVERIFIED", "unknown", "截止点未经确认。", [], { deadlineId: deadline.id }));
    deadlines.set(deadline.id, { at: parsed.value, verified: deadline.verified === true });
  }
  if (!inputDeadlines.length) issues.push(issue("DEADLINES_UNCONFIRMED", "unknown", "没有确认任何截止点。"));
  const buffers = new Map<string, number>();
  for (const buffer of policies) {
    if (!record(buffer) || !nonempty(buffer.deadlineId) || !finiteMinutes(buffer.reservedMinutes) || !nonempty(buffer.basis)) { issues.push(issue("INVALID_BUFFER_POLICY", "error", "缓冲需要有效截止点、有限非负分钟数和依据。")); continue; }
    if (buffers.has(buffer.deadlineId)) issues.push(issue("DUPLICATE_BUFFER_POLICY", "error", "同一截止点有重复缓冲策略。", [], { deadlineId: buffer.deadlineId }));
    if (!inputDeadlines.some(deadline => record(deadline) && deadline.id === buffer.deadlineId)) issues.push(issue("BUFFER_DEADLINE_UNKNOWN", "error", "缓冲引用未知截止点。", [], { deadlineId: buffer.deadlineId }));
    buffers.set(buffer.deadlineId, buffer.reservedMinutes);
  }
  for (const deadline of deadlines.keys()) if (!buffers.has(deadline)) issues.push(issue("BUFFER_UNCONFIRMED", "unknown", "截止点的提交缓冲尚未明确确认，零缓冲也需显式填写。", [], { deadlineId: deadline }));
  const capacity = new Map<string, Interval[]>();
  let staleInputs = false;
  const availabilityIds = new Set<string>();
  const versions = record(input.availabilityVersions) ? input.availabilityVersions : {};
  if (!record(input.availabilityVersions)) issues.push(issue("AVAILABILITY_VERSIONS_UNCONFIRMED", "unknown", "缺少可用时间集合版本快照。"));
  for (const collection of availability) {
    if (!record(collection) || !nonempty(collection.membershipId)) { issues.push(issue("INVALID_AVAILABILITY", "error", "成员可用时间集合结构无效。")); continue; }
    const id = collection.membershipId;
    if (!memberMap.has(id) || memberMap.get(id)?.status !== "active") issues.push(issue("AVAILABILITY_MEMBERSHIP_INVALID", "error", "可用时间集合只能用于本项目当前活跃成员。", [], { membershipId: id }));
    if (availabilityIds.has(id)) issues.push(issue("DUPLICATE_AVAILABILITY", "error", "成员只能有一份可用时间集合事实。", [], { membershipId: id }));
    availabilityIds.add(id);
    if (!integer(collection.version)) issues.push(issue("INVALID_AVAILABILITY_VERSION", "error", "可用时间集合版本无效。", [], { membershipId: id }));
    if (versions[id] !== collection.version) { staleInputs = true; issues.push(issue("STALE_AVAILABILITY_VERSION", "unknown", "可用时间集合版本与输入快照不一致。", [], { membershipId: id })); }
    const confirmed = instant(collection.confirmedAt);
    if (confirmed.value === null) issues.push(issue("AVAILABILITY_UNCONFIRMED", "unknown", "成员尚未确认可用时间集合。", [], { membershipId: id }));
    else if (confirmed.value > current) issues.push(issue("FUTURE_AVAILABILITY_CONFIRMATION", "error", "成员可用时间确认不能来自未来。", [], { membershipId: id }));
    const normalized = normalizeAvailabilityWindows(input.projectId, id, collection.windows, new Date(current));
    issues.push(...normalized.issues);
    if (Array.isArray(collection.windows) && collection.windows.some(window => record(window) && window.version !== collection.version)) {
      staleInputs = true;
      issues.push(issue("STALE_AVAILABILITY_WINDOW_VERSION", "unknown", "子窗口版本与其唯一可用时间集合版本不一致。", [], { membershipId: id }));
    }
    capacity.set(id, normalized.windows.map(window => ({ start: Date.parse(window.startsAt), end: Date.parse(window.endsAt) })));
  }
  for (const id of Object.keys(versions)) if (!availabilityIds.has(id)) { staleInputs = true; issues.push(issue("STALE_AVAILABILITY_VERSION", "unknown", "输入快照引用不存在的可用时间集合。", [], { membershipId: id })); }
  const safeTasks: PlanningTask[] = [];
  const byId = new Map<string, PlanningTask>();
  for (const original of tasks) {
    if (!record(original) || !nonempty(original.id)) { issues.push(issue("INVALID_TASK", "error", "任务 ID 或结构无效。")); continue; }
    const id = original.id;
    const taskArray = (value: unknown, label: string): string[] => {
      if (Array.isArray(value) && value.every(nonempty) && new Set(value).size === value.length) return value;
      issues.push(issue("INVALID_TASK_REFERENCES", "error", `${label}必须为非空且不重复的 ID 数组。`, [id])); return [];
    };
    const task = { ...original, dependencyTaskIds: taskArray(original.dependencyTaskIds, "前置任务"), requirementRefs: taskArray(original.requirementRefs, "规则引用"), resourceRefs: taskArray(original.resourceRefs, "资源引用"), helperEfforts: Array.isArray(original.helperEfforts) ? original.helperEfforts.filter(record) : [] } as PlanningTask;
    if (!Array.isArray(original.helperEfforts) || original.helperEfforts.some(helper => !record(helper))) issues.push(issue("INVALID_HELPER_EFFORTS", "error", "协助工作结构无效。", [id]));
    if (byId.has(id)) issues.push(issue("DUPLICATE_TASK", "error", "任务 ID 重复。", [id]));
    byId.set(id, task); safeTasks.push(task);
    issues.push(...validatePinnedResourceRefs(task));
    if (task.projectId !== input.projectId) issues.push(issue("TASK_SCOPE_MISMATCH", "error", "任务必须属于计划项目。", [id]));
    if (!nonempty(task.title) || !nonempty(task.deliverable) || !Array.isArray(task.acceptanceCriteria) || !task.acceptanceCriteria.length || task.acceptanceCriteria.some(item => !nonempty(item))) issues.push(issue("TASK_DELIVERABLE_UNVERIFIABLE", "error", "任务需有标题、明确交付物和非空验收条件。", [id]));
    if (!["must", "optional"].includes(task.priority) || !kinds.has(task.kind) || !statuses.has(task.status)) issues.push(issue("INVALID_TASK_CLASSIFICATION", "error", "任务优先级、用途或状态无效。", [id]));
    if (!integer(task.revision)) issues.push(issue("INVALID_TASK_REVISION", "error", "任务版本无效。", [id]));
    const updated = instant(task.updatedAt);
    if (updated.value === null) issues.push(issue(updated.code!, updated.severity!, `任务更新时间：${updated.message!}`, [id]));
    else if (updated.value > current) issues.push(issue("FUTURE_TASK_UPDATE", "error", "任务更新时间不能来自未来。", [id]));
    issues.push(...validateDurationEstimate(task.durationEstimate, id));
    if (task.remainingEstimate !== null) issues.push(...validateDurationEstimate(task.remainingEstimate, id));
    if (task.status === "in_progress" || task.status === "review" || task.status === "blocked") if (task.remainingEstimate === null) issues.push(issue("REMAINING_ESTIMATE_UNCONFIRMED", "unknown", "已开始任务尚未确认剩余工作估时。", [id]));
    if (typeof task.splittable !== "boolean" || !finiteMinutes(task.contextSwitchMinutes) || !finiteMinutes(task.waitMinutes)) issues.push(issue("INVALID_WORK_POLICY", "error", "可拆标志、上下文恢复成本和外部等待时间必须明确且有效。", [id]));
    if (task.splittable && task.contextSwitchMinutes === 0 && task.status !== "done" && task.status !== "cancelled") issues.push(issue("ZERO_CONTEXT_RECOVERY", "risk", "可拆任务未预留上下文恢复工作，需确认零成本依据。", [id]));
    if (task.status !== "done" && task.status !== "cancelled") {
      if (!nonempty(task.ownerMembershipId) || memberMap.get(task.ownerMembershipId)?.status !== "active") issues.push(issue("TASK_OWNER_INACTIVE", "error", "未完成任务需要当前活跃项目成员负责。", [id]));
      else if (!capacity.has(task.ownerMembershipId)) issues.push(issue("AVAILABILITY_MISSING", "unknown", "任务负责人未提供可用时间集合。", [id], { membershipId: task.ownerMembershipId }));
    }
    if (task.reviewerMembershipId !== null && memberMap.get(task.reviewerMembershipId)?.status !== "active" && task.status !== "done") issues.push(issue("TASK_REVIEWER_INACTIVE", "error", "验收人需要当前活跃项目成员身份。", [id]));
    const helperIds = new Set<string>();
    for (const helper of task.helperEfforts) {
      if (!nonempty(helper.membershipId) || helperIds.has(helper.membershipId) || helper.membershipId === task.ownerMembershipId) issues.push(issue("INVALID_TASK_HELPER", "error", "协助者必须为独立且唯一的项目成员。", [id]));
      helperIds.add(helper.membershipId);
      if (task.status !== "done" && task.status !== "cancelled" && memberMap.get(helper.membershipId)?.status !== "active") issues.push(issue("TASK_HELPER_INACTIVE", "error", "协助者需要当前活跃项目成员身份。", [id]));
      else if (task.status !== "done" && task.status !== "cancelled" && !capacity.has(helper.membershipId)) issues.push(issue("AVAILABILITY_MISSING", "unknown", "协助者未提供可用时间集合。", [id], { membershipId: helper.membershipId }));
      issues.push(...validateDurationEstimate(helper.durationEstimate, id));
    }
    if (!nonempty(task.deadlineRef) || !inputDeadlines.some(deadline => record(deadline) && deadline.id === task.deadlineRef)) issues.push(issue("TASK_DEADLINE_UNKNOWN", "error", "任务必须引用真实输入截止点。", [id]));
    else if (deadlines.has(task.deadlineRef) && deadlines.get(task.deadlineRef)!.at <= current && task.status !== "done" && task.status !== "cancelled") issues.push(issue("DEADLINE_PASSED", "risk", "未完成任务的截止点已到，需确认参赛安排。", [id], { deadlineId: task.deadlineRef }));
    for (const resource of task.resourceRefs) if (!resources.includes(resource)) issues.push(issue("RESOURCE_NOT_APPROVED", "error", "任务只能引用输入中当前已审核可用的资源 ID。", [id]));
    if (task.status === "cancelled") {
      if (task.priority === "must") issues.push(issue("MUST_TASK_CANCELLED", "error", "不能通过取消必须任务隐藏必交约束。", [id]));
      if (!nonempty(task.cancellationReason)) issues.push(issue("CANCELLATION_REASON_REQUIRED", "error", "取消可选任务需保留理由。", [id]));
      if (task.acceptance !== null) issues.push(issue("ACCEPTED_TASK_CANCELLED", "error", "已验收成果不能被取消草案抹除。", [id]));
    }
    if (task.status === "blocked" && !nonempty(task.blocker)) issues.push(issue("BLOCKER_REQUIRED", "error", "阻塞任务需注明具体原因。", [id]));
    if (task.status === "done") {
      const accepted = record(task.acceptance) ? instant(task.acceptance.acceptedAt) : { value: null };
      if (!record(task.acceptance) || !nonempty(task.acceptance.acceptedByUserId) || !["reviewer", "manager", "self_check"].includes(task.acceptance.mode) || !Array.isArray(task.acceptance.evidenceRefs) || task.acceptance.evidenceRefs.some(ref => !nonempty(ref)) || (!task.acceptance.evidenceRefs.length && !nonempty(task.acceptance.note)) || accepted.value === null || accepted.value > current) issues.push(issue("DONE_ACCEPTANCE_REQUIRED", "error", "完成任务需要已发生的明确验收记录与证据或自检说明。", [id]));
      else if (deadlines.has(task.deadlineRef) && accepted.value > deadlines.get(task.deadlineRef)!.at) issues.push(issue("DONE_AFTER_DEADLINE", "risk", "已验收成果晚于对应截止点，保留成果并确认赛事影响。", [id], { deadlineId: task.deadlineRef }));
    } else if (task.status !== "cancelled" && task.acceptance !== null) issues.push(issue("ACCEPTANCE_STATUS_CONFLICT", "error", "已验收成果与未完成状态冲突，应通过有理由的进度修正处理。", [id]));
  }
  const requirementMap = new Map<string, PlanningInput["requirements"][number]>();
  for (const requirement of requirements) {
    if (!record(requirement) || !nonempty(requirement.id) || !nonempty(requirement.description) || typeof requirement.mandatory !== "boolean" || !inputDeadlines.some(deadline => record(deadline) && deadline.id === requirement.deadlineRef) || requirementMap.has(requirement.id)) { issues.push(issue("INVALID_REQUIREMENT", "error", "要求必须包含唯一 ID、描述、必交标志和真实截止点。")); continue; }
    requirementMap.set(requirement.id, requirement);
    const references = safeTasks.filter(task => task.requirementRefs.includes(requirement.id) && task.status !== "cancelled");
    if (requirement.mandatory && !references.some(task => task.priority === "must" && task.deadlineRef === requirement.deadlineRef)) issues.push(issue("MANDATORY_REQUIREMENT_UNCOVERED", "error", "每项必交要求需要同截止点的必须任务覆盖。", references.map(task => task.id), { deadlineId: requirement.deadlineRef }));
    if (requirement.mandatory && references.some(task => task.priority !== "must")) issues.push(issue("MANDATORY_REQUIREMENT_OPTIONAL", "error", "赛事必交要求不能被标为可选。", references.filter(task => task.priority !== "must").map(task => task.id)));
  }
  for (const task of safeTasks) {
    for (const requirement of task.requirementRefs) if (!requirementMap.has(requirement)) issues.push(issue("TASK_REQUIREMENT_UNKNOWN", "error", "任务引用未知赛事要求。", [task.id]));
    for (const id of task.dependencyTaskIds) {
      const dependency = byId.get(id);
      if (!dependency) issues.push(issue("DEPENDENCY_DANGLING", "error", "任务依赖引用不存在的任务。", [task.id], { chain: [id, task.id] }));
      else if (dependency.projectId !== task.projectId) issues.push(issue("DEPENDENCY_SCOPE_MISMATCH", "error", "依赖双方必须属于同一项目。", [id, task.id]));
      else if (task.status !== "cancelled" && dependency.status === "cancelled") issues.push(issue("DEPENDENCY_CANCELLED", "error", "未取消任务不能依赖已经取消的任务。", [id, task.id], { chain: [id, task.id] }));
      else if (task.status === "done" && dependency.status !== "done") issues.push(issue("DONE_DEPENDENCY_UNACCEPTED", "error", "已完成任务的前置成果尚未验收。", [id, task.id]));
      else if (task.status === "done" && dependency.status === "done" && record(task.acceptance) && record(dependency.acceptance) && Date.parse(dependency.acceptance.acceptedAt) > Date.parse(task.acceptance.acceptedAt)) issues.push(issue("DONE_DEPENDENCY_TIME_CONFLICT", "error", "前置成果的验收晚于后续任务验收，需核对实际依赖和完成记录。", [id, task.id]));
    }
  }
  for (const kind of requiredKinds) {
    if (!kinds.has(kind)) issues.push(issue("INVALID_REQUIRED_TASK_KIND", "error", "必需阶段引用未知任务用途。"));
    else if (!safeTasks.some(task => task.kind === kind && task.priority === "must" && task.status !== "cancelled")) {
      const label = planningTaskKindLabels[kind as TaskKind];
      issues.push(issue("REQUIRED_TASK_KIND_MISSING", "error", `计划缺少「${label}」必须任务。`, [], {
        suggestion: `请用「增加${label}任务」补齐必做工作，例如${taskKindExamples[kind as TaskKind]}，再核对负责人、时间与检查条件。`,
      }));
    }
  }
  const cycle = dependencyCycle(safeTasks, byId);
  if (cycle) issues.push(issue("DEPENDENCY_CYCLE", "error", "任务依赖成环，不能作为执行计划。", [...new Set(cycle)], { chain: cycle, suggestion: "删除或调整循环链中的依赖，再重新校验。" }));
  issues.push(...reviewResourceContentRefs(safeTasks, input));
  staleInputs ||= hasResourceReviewRisk(issues);
  const structuralValid = !issues.some(item => item.severity === "error");
  // Invalid structures and unresolved dates must not reach arithmetic or a scheduler.
  const canSchedule = structuralValid && safeTasks.every(task => deadlines.has(task.deadlineRef));
  const likely = canSchedule ? schedule(safeTasks, deadlines, buffers, capacity, current, "likelyMinutes") : empty();
  const pessimistic = canSchedule ? schedule(safeTasks, deadlines, buffers, capacity, current, "pessimisticMinutes") : empty();
  const combined = [...issues, ...likely.issues, ...pessimistic.issues.map(item => ({ ...item, code: `PESSIMISTIC_${item.code}`, severity: item.severity === "error" ? "risk" as const : item.severity }))];
  const feasibility = !structuralValid ? "infeasible" : issues.some(item => item.severity === "unknown") ? "unknown" : likely.issues.some(item => item.severity === "error") ? "infeasible" : combined.some(item => item.severity === "risk") ? "at_risk" : "feasible";
  return { structuralValid, feasibility, issues: combined, likely, pessimistic, checkedAt, staleInputs };
}
