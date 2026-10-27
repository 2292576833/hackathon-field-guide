/**
 * P07 · 数据看板下钻（纯函数）
 *
 * 依据：规划 33 第 5 节第 3 期、分项 P07、宪法 v1.22.0 原则 II（事实可追溯、不编造）、
 * X（不新增入口、undefined 不等于 0）、XII（不做不透明评分与预测）。
 *
 * 纪律（本文件是硬约束的落点）：
 *  - **纯函数**：无 IO、无 Date.now()、无随机；所有"现在"由调用方以 readAt 传入。
 *  - **只看既有事实**：输入就是各模块已读到的行（报名分页/计数、正式队伍、收件回执、
 *    评审进度、后勤与行程）。这里只做**筛选与聚合**，不新增查询、不加表、不落库。
 *  - **数字逐一相等**：状态计数直接用 registrationCounts() 的原样输出；本轮评审数字直接用
 *    progress() 的原样输出；筛选结果只数本次读取到的行，并写明"本页"。
 *  - **undefined（未读取）与 0 严格区分**：未读取的指标 value === undefined，界面显示"未提供"，
 *    MUST NOT 显示为 0；无数据不补占位、不补零。
 *  - **禁止**：预测、成功率、"影响力/ROI"、跨赛事优劣排名、给队伍或评委打综合分。
 *    面板内不按分数排序；排序只用计数、时间或标识。
 */
import type { EntityId, Instant } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { EventModuleFlags, EventRegistrationStatus, EventStaffCapability } from "../../shared/organizer-contracts.ts";

export const DASHBOARD_PANELS = ["registration", "teams", "intake", "judging", "logistics"] as const;
export type DashboardPanelKey = (typeof DASHBOARD_PANELS)[number];
export const DASHBOARD_PANEL_LABELS: Readonly<Record<DashboardPanelKey, string>> = {
  registration: "报名", teams: "队伍", intake: "收件", judging: "评审", logistics: "后勤",
};
/** 面板可见性：具备其中之一即可见（后勤可由行程或现场两类权限分别读取）。 */
export const DASHBOARD_PANEL_CAPABILITIES: Readonly<Record<DashboardPanelKey, readonly EventStaffCapability[]>> = {
  registration: ["registration_manage"], teams: ["teams_manage"], intake: ["judging_manage"],
  judging: ["judging_manage"], logistics: ["schedule_manage", "logistics_manage"],
};
/** 看板依赖的既有事实键；unread 用它标注"未读取"的原因。 */
export const DASHBOARD_FACTS = ["registrationCounts", "registrations", "teams", "judgingWorkspace", "judgingProgress", "accommodation", "vouchers", "scheduleDraft"] as const;
export type DashboardFactKey = (typeof DASHBOARD_FACTS)[number];
export const DEFAULT_DASHBOARD_LIMIT = 50;
export const MAX_DASHBOARD_LIMIT = 100;
const REGISTRATION_STATUSES: readonly EventRegistrationStatus[] = ["draft", "pending", "approved", "rejected", "withdrawn"];
export const REGISTRATION_STATUS_LABELS: Readonly<Record<EventRegistrationStatus, string>> = {
  draft: "草稿", pending: "待审核", approved: "已通过", rejected: "已驳回", withdrawn: "已撤回",
};
const TEAM_STATUS_LABELS = { forming: "组队中", locked: "已锁定", withdrawn: "已撤回" } as const;
const ROUND_STATUS_LABELS = { setup: "未开始", open: "进行中", locked: "已锁定", published: "已公布" } as const;
const VOUCHER_STATE_LABELS = { available: "可使用", exhausted: "已用完", expired: "已过期", revoked: "已撤销" } as const;
const AUDIENCE_LABELS = { all: "全部人员", participants: "参赛者", users: "指定人员" } as const;

// ---- 既有事实的结构化只读投影（与来源模块的对象结构兼容，由根 Port 直接透传） ----

export interface DashboardPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
export interface DashboardRegistrationCounts {
  readonly counts: Readonly<Record<EventRegistrationStatus, number>>;
  readonly pending: number;
  readonly reserved: number;
}
export interface DashboardRegistrationRow {
  readonly id: EntityId;
  readonly userId: EntityId;
  readonly status: EventRegistrationStatus;
  readonly submittedAt: Instant | null;
  readonly createdAt: Instant;
}
export interface DashboardTeamRow {
  readonly id: EntityId;
  readonly name: string;
  readonly track: string;
  readonly status: "forming" | "locked" | "withdrawn";
  readonly memberUserIds: readonly EntityId[];
  readonly eligible: boolean;
  readonly projectId: EntityId | null;
  readonly createdAt: Instant;
}
export interface DashboardSubmissionMaterials {
  readonly title: string;
  readonly links: readonly unknown[];
  readonly files: readonly unknown[];
}
export interface DashboardJudgingReceipt {
  readonly id: EntityId;
  readonly teamId: EntityId;
  readonly version: number;
  readonly submittedAt: Instant;
  readonly materials: DashboardSubmissionMaterials;
}
export interface DashboardJudgingRound {
  readonly id: EntityId;
  readonly status: "setup" | "open" | "locked" | "published";
  readonly snapshotIds: readonly EntityId[];
  readonly publishedResultId: EntityId | null;
  readonly config: { readonly minJudges: number };
}
export interface DashboardJudgingWorkspace {
  readonly rounds: readonly DashboardJudgingRound[];
  readonly submissions: readonly DashboardJudgingReceipt[];
}
export interface DashboardProgressRow {
  readonly snapshotId: EntityId;
  readonly title: string;
  readonly submittedCount: number;
  readonly requiredJudges: number;
  readonly stillNeeds: number;
  readonly complete: boolean;
}
export interface DashboardJudgeProgressRow {
  readonly judgeUserId: EntityId;
  readonly submittedCount: number;
  readonly assignedCount: number;
  readonly outstanding: number;
  readonly excludedCount: number;
}
export interface DashboardJudgingProgress {
  readonly roundId: EntityId;
  readonly status: "empty" | "in_progress" | "complete";
  readonly snapshotCount: number;
  readonly requiredJudges: number;
  readonly incompleteSnapshots: number;
  readonly submittedTotal: number;
  readonly assignedTotal: number;
  readonly rows: readonly DashboardProgressRow[];
  readonly judges: readonly DashboardJudgeProgressRow[];
  /** 既有 progress() 的口径说明；可选，缺失时使用本模块的默认说明。 */
  readonly notice?: string;
}
export interface DashboardAccommodationRow {
  readonly userId: EntityId;
  readonly location: string;
  readonly room: string;
  readonly checkIn: Instant;
  readonly checkOut: Instant;
}
export interface DashboardVoucherRow {
  readonly id: EntityId;
  readonly userId: EntityId;
  readonly name: string;
  readonly totalUses: number;
  readonly remainingUses: number;
  readonly state: "available" | "exhausted" | "expired" | "revoked";
  readonly revokedAt: Instant | null;
}
export interface DashboardScheduleItem {
  readonly title: string;
  readonly startsAt: Instant;
  readonly endsAt: Instant;
  readonly location: string;
  readonly audience: "all" | "participants" | "users";
  readonly userIds: readonly EntityId[];
}
export interface DashboardScheduleDraft {
  readonly revision: number;
  readonly publishedRevision: number | null;
  readonly items: readonly DashboardScheduleItem[];
}

// ---- 输入与输出 ----

export interface DashboardFilter {
  readonly panel?: DashboardPanelKey;
  readonly status?: EventRegistrationStatus;
  readonly track?: string;
  readonly from?: Instant;
  readonly to?: Instant;
  readonly roundId?: EntityId;
  readonly cursor?: string;
  readonly limit?: number;
}
export interface DashboardInput {
  readonly eventId: EntityId;
  readonly eventTitle: string;
  /** 统计范围：本看板固定为本场。 */
  readonly scope: string;
  /** 数据时间：由服务用注入 Clock 生成的本次读取时刻。 */
  readonly readAt: Instant;
  readonly modules: EventModuleFlags;
  readonly registrationCounts?: DashboardRegistrationCounts;
  readonly registrations?: DashboardPage<DashboardRegistrationRow>;
  readonly teams?: DashboardPage<DashboardTeamRow>;
  readonly judgingWorkspace?: DashboardJudgingWorkspace;
  readonly judgingProgress?: DashboardJudgingProgress;
  readonly accommodation?: readonly DashboardAccommodationRow[];
  readonly vouchers?: readonly DashboardVoucherRow[];
  readonly scheduleDraft?: DashboardScheduleDraft;
  /** 未读取原因（按事实键）；只用于说明，不影响 0/undefined 的区分。 */
  readonly unread?: Readonly<Partial<Record<DashboardFactKey, string>>>;
}
export interface DashboardMetric {
  readonly key: string;
  readonly label: string;
  /** undefined = 未读取；MUST NOT 当作 0。 */
  readonly value: number | undefined;
  readonly definition: string;
  readonly scope: string;
  readonly readAt: Instant;
}
export interface DashboardCell {
  readonly label: string;
  readonly value: string | number | null;
}
export interface DashboardRow {
  readonly id: EntityId;
  readonly cells: readonly DashboardCell[];
}
export interface DashboardSection {
  readonly key: string;
  readonly label: string;
  readonly definition: string;
  readonly rows: readonly DashboardRow[];
  readonly nextCursor: string | null;
}
export interface DashboardBreakdown {
  readonly key: string;
  readonly label: string;
  readonly definition: string;
  readonly scope: string;
  readonly readAt: Instant;
  readonly groups: readonly { readonly label: string; readonly value: number | undefined }[];
}
export interface DashboardPanel {
  readonly panel: DashboardPanelKey;
  readonly label: string;
  readonly available: boolean;
  readonly definitions: readonly string[];
  readonly notAvailableReasons: readonly string[];
  readonly scope: string;
  readonly readAt: Instant;
  readonly metrics: readonly DashboardMetric[];
  readonly breakdowns: readonly DashboardBreakdown[];
  readonly sections: readonly DashboardSection[];
}
export interface DashboardView {
  readonly eventId: EntityId;
  readonly eventTitle: string;
  readonly scope: string;
  readonly readAt: Instant;
  readonly filter: DashboardFilter;
  readonly panels: readonly DashboardPanel[];
}

// ---- 纯辅助 ----

function invalid(message: string): never {
  throw new DomainError("DASHBOARD_FILTER_INVALID", message, { status: 422, recoveryAction: "刷新看板后重试；无效的筛选条件不会被应用。" });
}
function metric(key: string, label: string, value: number | undefined, definition: string, scope: string, readAt: Instant): DashboardMetric {
  return { key, label, value, definition, scope, readAt };
}
function unreadReason(input: DashboardInput, fact: DashboardFactKey, fallback: string): string {
  const reason = input.unread?.[fact];
  return typeof reason === "string" && reason ? reason : fallback;
}
function disabledNotice(input: DashboardInput, module: keyof EventModuleFlags, label: string): string | null {
  return input.modules[module] ? null : "本场当前未启用" + label + "模块；以下为该模块既有记录，未读取的项显示为未提供，不补占位。";
}
function trackByUser(page?: DashboardPage<DashboardTeamRow>): ReadonlyMap<EntityId, string> {
  const map = new Map<EntityId, string>();
  for (const team of page?.items ?? []) {
    if (team.status === "withdrawn" || !team.track) continue;
    for (const userId of team.memberUserIds) if (!map.has(userId)) map.set(userId, team.track);
  }
  return map;
}
function latestReceipts(workspace?: DashboardJudgingWorkspace): ReadonlyMap<EntityId, DashboardJudgingReceipt> {
  const map = new Map<EntityId, DashboardJudgingReceipt>();
  for (const receipt of workspace?.submissions ?? []) {
    const current = map.get(receipt.teamId);
    if (!current || receipt.version > current.version) map.set(receipt.teamId, receipt);
  }
  return map;
}
function within(value: Instant | null, from?: Instant, to?: Instant): boolean {
  if (from !== undefined && (value === null || value < from)) return false;
  if (to !== undefined && (value === null || value > to)) return false;
  return true;
}
function countBy<T>(items: readonly T[], key: (item: T) => string): readonly { readonly label: string; readonly value: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts.entries()].map(([label, value]) => ({ label, value }));
}
function cell(label: string, value: string | number | null): DashboardCell { return { label, value }; }

// ---- 面板构建 ----

export function registrationPanel(input: DashboardInput, filter: DashboardFilter = {}): DashboardPanel {
  const counts = input.registrationCounts, page = input.registrations, scope = input.scope, readAt = input.readAt;
  const reasons: string[] = [];
  if (!counts) reasons.push(unreadReason(input, "registrationCounts", "报名计数未读取。"));
  if (!page) reasons.push(unreadReason(input, "registrations", "报名分页未读取。"));
  const trackMap = trackByUser(input.teams);
  const trackBlocked = filter.track !== undefined && input.teams === undefined;
  if (trackBlocked) reasons.push("按赛道筛选需要同时读取本场正式队伍；当前未读取队伍，该筛选条件未应用。");
  const notice = disabledNotice(input, "registration", "报名");
  if (notice) reasons.push(notice);
  const matched = (page?.items ?? []).filter(row => (filter.status === undefined || row.status === filter.status)
    && within(row.submittedAt, filter.from, filter.to)
    && (filter.track === undefined || trackMap.get(row.userId) === filter.track));
  const visible: readonly DashboardRegistrationRow[] = trackBlocked ? [] : matched;
  const rows: readonly DashboardRow[] = visible.map(row => ({
    id: row.id,
    cells: [
      cell("报名编号", row.id),
      cell("状态", REGISTRATION_STATUS_LABELS[row.status]),
      cell("提交时间", row.submittedAt),
      cell("赛道（队伍）", trackMap.get(row.userId) ?? null),
    ],
  }));
  return {
    panel: "registration", label: DASHBOARD_PANEL_LABELS.registration,
    available: Boolean(counts ?? page) && !trackBlocked, definitions: [
      "统计范围：本场已提交报名（不含只有本人可见的私人草稿）。",
      "状态计数直接取既有 registrationCounts() 的口径；筛选结果只数本次读取到的报名记录（本页）。",
      "赛道来自报名者当前所属的正式队伍（已撤回队伍不计）；无队伍或未读取队伍时显示为未提供。",
      "数据时间：" + readAt + "。",
    ], notAvailableReasons: reasons, scope, readAt,
    metrics: [
      metric("pending", "待审核", counts?.pending, "等待主办方审核的本场报名条数。", scope, readAt),
      metric("approved", "已通过", counts?.counts.approved, "已通过审核的本场报名条数。", scope, readAt),
      metric("rejected", "已驳回", counts?.counts.rejected, "已驳回的本场报名条数。", scope, readAt),
      metric("withdrawn", "已撤回", counts?.counts.withdrawn, "本人已撤回的本场报名条数。", scope, readAt),
      metric("reserved", "已占名额", counts?.reserved, "占用报名名额的条数（待审核 + 已通过）。", scope, readAt),
      metric("matched", "筛选结果", trackBlocked || !page ? undefined : matched.length, "本次读取的报名记录中符合当前筛选条件的条数（本页）。", scope, readAt),
      metric("read", "已读取", page?.items.length, "本次读取的报名记录条数（本页）。", scope, readAt),
    ], breakdowns: [], sections: [{
      key: "registrations", label: "报名记录（本页）",
      definition: "按提交时间倒序、同时间按报名编号升序；赛道为报名者当前所属队伍的方向。",
      rows, nextCursor: page?.nextCursor ?? null,
    }],
  };
}

export function teamPanel(input: DashboardInput, filter: DashboardFilter = {}): DashboardPanel {
  const page = input.teams, scope = input.scope, readAt = input.readAt;
  const reasons: string[] = [];
  if (!page) reasons.push(unreadReason(input, "teams", "正式队伍未读取。"));
  const notice = disabledNotice(input, "teams", "队伍");
  if (notice) reasons.push(notice);
  const latest = latestReceipts(input.judgingWorkspace);
  const hasWorkspace = input.judgingWorkspace !== undefined;
  if (!hasWorkspace) reasons.push(unreadReason(input, "judgingWorkspace", "收件回执未读取；是否已收件显示为未提供。"));
  const teams = (page?.items ?? []).filter(team => (filter.status === undefined || team.status === filter.status)
    && (filter.track === undefined || team.track === filter.track));
  const sizeGroups = countBy(teams, team => String(team.memberUserIds.length)).map(group => ({ label: group.label + " 人", value: group.value }))
    .sort((a, b) => Number.parseInt(a.label, 10) - Number.parseInt(b.label, 10));
  const trackGroups = countBy(teams, team => team.track || "未填写").map(group => ({ label: group.label, value: group.value }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  const intakeLabel = (team: DashboardTeamRow): string | null => hasWorkspace ? (latest.has(team.id) ? "已收件" : "未收件") : null;
  const sorted = [...teams].sort((a, b) => b.memberUserIds.length - a.memberUserIds.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rows: readonly DashboardRow[] = sorted.map(team => ({
    id: team.id,
    cells: [
      cell("队伍名称", team.name),
      cell("参赛方向", team.track || null),
      cell("状态", TEAM_STATUS_LABELS[team.status]),
      cell("人数", team.memberUserIds.length),
      cell("是否已收件", intakeLabel(team)),
      cell("关联空间", team.projectId ? "已关联" : "未关联"),
    ],
  }));
  return {
    panel: "teams", label: DASHBOARD_PANEL_LABELS.teams, available: Boolean(page), definitions: [
      "统计范围：本场正式队伍（含组队中、已锁定、已撤回；按当前读取到的一页）。",
      "人数来自队伍当前成员集合；材料齐全度只看是否已有正式收件回执，不做质量评价。",
      "关联空间状态只看队伍是否已关联团队空间，不读取空间内部内容。",
      "数据时间：" + readAt + "。",
    ], notAvailableReasons: reasons, scope, readAt,
    metrics: [
      metric("teams", "已读取队伍", page?.items.length, "本次读取到的一页正式队伍条数。", scope, readAt),
      metric("matched", "筛选结果", page ? teams.length : undefined, "本次读取的队伍中符合当前筛选条件的条数。", scope, readAt),
      metric("eligible", "成员齐备", page ? teams.filter(team => team.eligible).length : undefined, "既有 eligible 判定为真的队伍数（人数在区间内且成员报名均已通过）。", scope, readAt),
      metric("locked", "已锁定", page ? teams.filter(team => team.status === "locked").length : undefined, "名单已锁定的队伍数。", scope, readAt),
      metric("members", "队员合计", page ? teams.reduce((sum, team) => sum + team.memberUserIds.length, 0) : undefined, "本次读取到的队伍当前成员数合计（同一人如在两队会分别计入）。", scope, readAt),
      metric("withIntake", "已收件队伍", hasWorkspace ? teams.filter(team => latest.has(team.id)).length : undefined, "已有至少一版正式收件回执的队伍数。", scope, readAt),
      metric("withProject", "已关联空间", page ? teams.filter(team => team.projectId !== null).length : undefined, "已关联团队空间的队伍数。", scope, readAt),
    ], breakdowns: [
      { key: "teamSize", label: "人数分布", definition: "按队伍当前成员数分组（本页筛选结果）。", scope, readAt, groups: page ? sizeGroups : [] },
      { key: "teamTrack", label: "赛道分布", definition: "按队伍填写的参赛方向分组；未填写单列（本页筛选结果）。", scope, readAt, groups: page ? trackGroups : [] },
    ], sections: [{
      key: "teams", label: "正式队伍（本页）",
      definition: "按成员数倒序、同数按队伍编号升序；是否已收件与关联空间仅为事实标注。",
      rows, nextCursor: page?.nextCursor ?? null,
    }],
  };
}

export function intakePanel(input: DashboardInput, filter: DashboardFilter = {}): DashboardPanel {
  const workspace = input.judgingWorkspace, page = input.teams, scope = input.scope, readAt = input.readAt;
  const reasons: string[] = [];
  if (!workspace) reasons.push(unreadReason(input, "judgingWorkspace", "收件回执未读取。"));
  if (!page) reasons.push(unreadReason(input, "teams", "正式队伍未读取；未交件只能按已有回执判断，无法列出未交队伍。"));
  const notice = disabledNotice(input, "judging", "评审/收件");
  if (notice) reasons.push(notice);
  const trackMap = trackByUser(page);
  const latestAll = [...latestReceipts(workspace).values()];
  const latest = latestAll
    .filter(receipt => within(receipt.submittedAt, filter.from, filter.to)
      && (filter.track === undefined || trackMap.get(receipt.teamId) === filter.track))
    .sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : a.submittedAt > b.submittedAt ? -1 : a.id < b.id ? -1 : 1));
  const thin = latest.filter(receipt => receipt.materials.links.length === 0 && receipt.materials.files.length === 0);
  const teamName = new Map((page?.items ?? []).map(team => [team.id, team.name]));
  const missingTeams = (page?.items ?? []).filter(team => team.status !== "withdrawn" && !latestReceipts(workspace).has(team.id))
    .filter(team => filter.track === undefined || team.track === filter.track);
  const receiptRows: readonly DashboardRow[] = latest.map(receipt => ({
    id: receipt.id,
    cells: [
      cell("作品名称", receipt.materials.title || null),
      cell("队伍", teamName.get(receipt.teamId) ?? receipt.teamId),
      cell("版本", receipt.version),
      cell("提交时间", receipt.submittedAt),
      cell("链接数", receipt.materials.links.length),
      cell("文件数", receipt.materials.files.length),
      cell("材料", receipt.materials.links.length === 0 && receipt.materials.files.length === 0 ? "仅有名称" : "含链接或文件"),
    ],
  }));
  const missingRows: readonly DashboardRow[] = missingTeams.map(team => ({
    id: team.id,
    cells: [cell("队伍名称", team.name), cell("参赛方向", team.track || null), cell("状态", TEAM_STATUS_LABELS[team.status])],
  }));
  return {
    panel: "intake", label: DASHBOARD_PANEL_LABELS.intake, available: Boolean(workspace), definitions: [
      "统计范围：本场正式收件回执（每队取版本号最新的一版；未交件按当前队伍集合判断）。",
      "材料过薄是显式事实：最新一版既没有链接也没有文件；不是质量评分，也不对结果作推断。",
      "数据时间：" + readAt + "。",
    ], notAvailableReasons: reasons, scope, readAt,
    metrics: [
      metric("submittedTeams", "已交件队伍", workspace ? latestReceipts(workspace).size : undefined, "至少有一版正式收件回执的队伍数（口径与既有收件一致）。", scope, readAt),
      metric("receipts", "回执版本数", workspace?.submissions.length, "本场所有正式收件回执版本条数（含历史版本）。", scope, readAt),
      metric("notSubmitted", "未交件队伍", page ? missingTeams.length : undefined, "当前读取到的队伍（不含已撤回）中没有正式收件回执的队伍数。", scope, readAt),
      metric("thin", "仅有名称的收件", workspace ? thin.length : undefined, "最新一版收件既没有链接也没有文件的件数（材料过薄的显式事实）。", scope, readAt),
      metric("matched", "筛选结果", workspace ? latest.length : undefined, "最新一版收件中符合当前筛选条件的件数。", scope, readAt),
    ], breakdowns: [], sections: [
      {
        key: "receipts", label: "最新收件（本页）",
        definition: "每队最新一版，按提交时间倒序、同时间按回执编号升序；只标注链接/文件数量。",
        rows: receiptRows, nextCursor: null,
      },
      {
        key: "missing", label: "未交件队伍（本次读取范围）",
        definition: page ? "当前读取到的队伍中没有正式收件回执的（不含已撤回）。" : "正式队伍未读取，无法列出。",
        rows: page ? missingRows : [], nextCursor: page?.nextCursor ?? null,
      },
    ],
  };
}

export function judgingPanel(input: DashboardInput, filter: DashboardFilter = {}): DashboardPanel {
  const workspace = input.judgingWorkspace, scope = input.scope, readAt = input.readAt;
  const reasons: string[] = [];
  if (!workspace) reasons.push(unreadReason(input, "judgingWorkspace", "评审轮次与收件未读取。"));
  const notice = disabledNotice(input, "judging", "评审");
  if (notice) reasons.push(notice);
  const rounds = workspace?.rounds ?? [];
  const selected = workspace ? (filter.roundId ? rounds.find(round => round.id === filter.roundId) : rounds[rounds.length - 1]) : undefined;
  if (workspace && !selected) reasons.push(filter.roundId ? "所选评审轮次不存在。" : "本场还没有评审轮次，暂无可显示的本轮进度。");
  const progress = selected && input.judgingProgress?.roundId === selected.id ? input.judgingProgress : undefined;
  if (workspace && selected && !progress) reasons.push(unreadReason(input, "judgingProgress", "本轮评审进度未读取。"));
  const roundScope = selected ? "本场 · 选中轮次（" + selected.id + "）" : scope;
  const statusGroups = (["setup", "open", "locked", "published"] as const).map(status => ({
    label: ROUND_STATUS_LABELS[status], value: workspace ? rounds.filter(round => round.status === status).length : undefined,
  }));
  const snapshotRows: readonly DashboardRow[] = (progress?.rows ?? []).map(row => ({
    id: row.snapshotId,
    cells: [
      cell("作品", row.title || null),
      cell("已提交/最少", row.submittedCount + " / " + row.requiredJudges),
      cell("还差", row.stillNeeds),
    ],
  }));
  const judgeRows: readonly DashboardRow[] = (progress?.judges ?? []).map(judge => ({
    id: judge.judgeUserId,
    cells: [
      cell("评委账号", judge.judgeUserId),
      cell("已提交", judge.submittedCount),
      cell("应评", judge.assignedCount),
      cell("还差", judge.outstanding),
      cell("已排除", judge.excludedCount),
    ],
  }));
  return {
    panel: "judging", label: DASHBOARD_PANEL_LABELS.judging, available: Boolean(workspace), definitions: [
      "统计范围：本场评审轮次；本轮数字直接取既有 progress() 的口径（与 aggregate()/calibration() 同一套有效判定）。",
      "只报已有/还差，不出百分比、进度条、完成度或落后；未提交不等于不负责。",
      "数据时间：" + readAt + "。",
    ], notAvailableReasons: reasons, scope, readAt,
    metrics: [
      metric("rounds", "评审轮次", workspace ? rounds.length : undefined, "本场已建立的评审轮次总数。", scope, readAt),
      metric("publishedRounds", "已公布轮次", workspace ? rounds.filter(round => round.publishedResultId !== null).length : undefined, "已产生已公布结果的轮次数（不展示分数与名次）。", scope, readAt),
      metric("snapshots", "本轮冻结作品", progress?.snapshotCount, "本轮冻结名单上的作品件数。", roundScope, readAt),
      metric("incomplete", "尚未收齐作品", progress?.incompleteSnapshots, "本轮尚未收齐最少评委数的作品件数。", roundScope, readAt),
      metric("submitted", "已提交有效评分", progress?.submittedTotal, "本轮已正式提交且计入汇总的评分条数合计。", roundScope, readAt),
      metric("assigned", "有效指派", progress?.assignedTotal, "本轮已排定且计入分母的指派数合计（排除回避/待核查/已撤销）。", roundScope, readAt),
      metric("required", "本轮最少评委", progress?.requiredJudges, "本轮配置的最少评委数。", roundScope, readAt),
    ], breakdowns: [
      { key: "roundStatus", label: "轮次状态分布", definition: "按既有轮次状态分组：未开始 / 进行中 / 已锁定 / 已公布。", scope, readAt, groups: statusGroups },
    ], sections: [
      {
        key: "snapshots", label: "作品进度", definition: progress?.notice ?? "尚无本轮进度可显示。",
        rows: snapshotRows, nextCursor: null,
      },
      {
        key: "judges", label: "评委进度", definition: "本轮排定过指派的评委；按还差数降序，同数按账号标识升序。只统计既有指派与已提交评分。",
        rows: judgeRows, nextCursor: null,
      },
    ],
  };
}

export function logisticsPanel(input: DashboardInput, filter: DashboardFilter = {}): DashboardPanel {
  const accommodation = input.accommodation, vouchers = input.vouchers, schedule = input.scheduleDraft, page = input.registrations;
  const scope = input.scope, readAt = input.readAt;
  const reasons: string[] = [];
  if (!accommodation) reasons.push(unreadReason(input, "accommodation", "住宿分配未读取（需要 logistics_manage）。"));
  if (!vouchers) reasons.push(unreadReason(input, "vouchers", "餐券未读取（需要 logistics_manage）。"));
  if (!schedule) reasons.push(unreadReason(input, "scheduleDraft", "行程草稿未读取（需要 schedule_manage）。"));
  const accommodationNotice = disabledNotice(input, "accommodation", "住宿");
  if (accommodationNotice) reasons.push(accommodationNotice);
  const voucherNotice = disabledNotice(input, "mealVouchers", "餐券");
  if (voucherNotice) reasons.push(voucherNotice);
  const scheduleNotice = disabledNotice(input, "schedule", "行程");
  if (scheduleNotice) reasons.push(scheduleNotice);
  const approved = page?.items.filter(row => row.status === "approved");
  if (!page) reasons.push(unreadReason(input, "registrations", "未读取已通过报名，无法计算未分配住宿与行程覆盖。"));
  const assigned = new Set((accommodation ?? []).map(row => row.userId));
  const hasEveryone = (schedule?.items ?? []).some(item => item.audience === "all" || item.audience === "participants");
  const explicit = new Set((schedule?.items ?? []).flatMap(item => item.userIds));
  const covered = approved && schedule ? (hasEveryone ? approved.length : approved.filter(row => explicit.has(row.userId)).length) : undefined;
  const activeVouchers = (vouchers ?? []).filter(voucher => voucher.revokedAt === null);
  const voucherGroups = (["available", "exhausted", "expired", "revoked"] as const).map(state => ({
    label: VOUCHER_STATE_LABELS[state], value: vouchers ? vouchers.filter(voucher => voucher.state === state).length : undefined,
  }));
  const unassigned = accommodation && approved ? approved.filter(row => !assigned.has(row.userId)) : undefined;
  const accommodationRows: readonly DashboardRow[] = [...(accommodation ?? [])]
    .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
    .map(row => ({
      id: row.userId,
      cells: [cell("账号编号", row.userId), cell("地点", row.location || null), cell("房间", row.room || null), cell("入住", row.checkIn), cell("离店", row.checkOut)],
    }));
  const unassignedRows: readonly DashboardRow[] = (unassigned ?? []).map(row => ({ id: row.userId, cells: [cell("账号编号", row.userId)] }));
  const voucherRows: readonly DashboardRow[] = [...(vouchers ?? [])].map(voucher => ({
    id: voucher.id,
    cells: [
      cell("账号编号", voucher.userId), cell("券名", voucher.name || null), cell("总次数", voucher.totalUses),
      cell("剩余", voucher.remainingUses), cell("状态", VOUCHER_STATE_LABELS[voucher.state]),
    ],
  }));
  const scheduleRows: readonly DashboardRow[] = (schedule?.items ?? []).map((item, index) => ({
    id: "schedule-" + index,
    cells: [
      cell("行程", item.title || null), cell("适用范围", AUDIENCE_LABELS[item.audience]), cell("开始", item.startsAt),
      cell("结束", item.endsAt), cell("地点", item.location || null), cell("指定人数", item.userIds.length),
    ],
  }));
  return {
    panel: "logistics", label: DASHBOARD_PANEL_LABELS.logistics,
    available: Boolean(accommodation ?? vouchers ?? schedule), definitions: [
      "统计范围：本场住宿分配、餐券与行程草稿；全部为既有记录，不新增发放或核销事实。",
      "未分配住宿以已通过报名为分母；行程覆盖按行程适用范围（全部/参赛者/指定人员）与已通过报名取交集。",
      "数据时间：" + readAt + "。",
    ], notAvailableReasons: reasons, scope, readAt,
    metrics: [
      metric("accommodationAssigned", "已分配住宿", accommodation?.length, "已有住宿分配记录的人数。", scope, readAt),
      metric("accommodationUnassigned", "未分配住宿", unassigned?.length, "已通过报名者中当前没有住宿分配记录的人数（本次读取范围内）。", scope, readAt),
      metric("vouchersIssued", "已发餐券", vouchers ? activeVouchers.length : undefined, "未撤销的餐券张数（含已用完与已过期）。", scope, readAt),
      metric("voucherRedemptions", "已核销次数", vouchers ? activeVouchers.reduce((sum, voucher) => sum + Math.max(0, voucher.totalUses - voucher.remainingUses), 0) : undefined, "未撤销餐券已使用的次数合计（总次数 - 剩余次数）。", scope, readAt),
      metric("vouchersExhausted", "已用完餐券", vouchers ? vouchers.filter(voucher => voucher.state === "exhausted").length : undefined, "剩余次数为 0 的餐券张数。", scope, readAt),
      metric("vouchersRevoked", "已撤销餐券", vouchers ? vouchers.filter(voucher => voucher.state === "revoked").length : undefined, "已被撤销的餐券张数。", scope, readAt),
      metric("scheduleItems", "行程条数", schedule?.items.length, "行程草稿中的条目数。", scope, readAt),
      metric("scheduleCovered", "行程覆盖人数", covered, "行程覆盖的已通过报名者人数：存在面向全部/参赛者的行程时覆盖全部已通过报名者，否则只计显式指定且已通过报名的人员。", scope, readAt),
    ], breakdowns: [
      { key: "voucherState", label: "餐券状态分布", definition: "按餐券当前状态分组：可使用 / 已用完 / 已过期 / 已撤销。", scope, readAt, groups: voucherGroups },
    ], sections: [
      {
        key: "accommodation", label: "住宿分配（本次读取范围）",
        definition: "按账号标识升序；只列已有的分配记录，不补齐、不代填。",
        rows: accommodationRows, nextCursor: null,
      },
      {
        key: "unassigned", label: "未分配住宿（本次读取范围）",
        definition: unassigned ? "已通过报名者中没有住宿分配记录的人员。" : "需要同时读取已通过报名与住宿分配；当前未读取完整，无法列出。",
        rows: unassignedRows, nextCursor: page?.nextCursor ?? null,
      },
      {
        key: "vouchers", label: "餐券（本次读取范围）",
        definition: "按发放顺序列出既有餐券；剩余与状态为当前记录值。",
        rows: voucherRows, nextCursor: null,
      },
      {
        key: "schedule", label: "行程草稿（本次读取范围）",
        definition: "列出行程草稿条目与适用范围；不发布、不通知、不改变任何行程事实。",
        rows: scheduleRows, nextCursor: null,
      },
    ],
  };
}

// ---- 组装与筛选条件解析 ----

export function buildDashboard(input: DashboardInput, filter: DashboardFilter = {}, permitted?: readonly DashboardPanelKey[]): DashboardView {
  const builders: Readonly<Record<DashboardPanelKey, () => DashboardPanel>> = {
    registration: () => registrationPanel(input, filter),
    teams: () => teamPanel(input, filter),
    intake: () => intakePanel(input, filter),
    judging: () => judgingPanel(input, filter),
    logistics: () => logisticsPanel(input, filter),
  };
  const allowed = filter.panel ? [filter.panel] : (permitted ?? DASHBOARD_PANELS);
  const keys = allowed.filter(key => !permitted || permitted.includes(key));
  return {
    eventId: input.eventId, eventTitle: input.eventTitle, scope: input.scope, readAt: input.readAt,
    filter: { ...filter, limit: filter.limit ?? DEFAULT_DASHBOARD_LIMIT },
    panels: keys.map(key => builders[key]()),
  };
}

function textQuery(value: string | undefined, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maximum) invalid(label + "过长，最多 " + maximum + " 个字符。");
  return trimmed;
}
function instantQuery(value: string | undefined, label: string): Instant | undefined {
  const trimmed = textQuery(value, label, 64);
  if (trimmed === undefined) return undefined;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) invalid(label + "不是有效时间，请使用带时区的 ISO 8601。");
  return new Date(parsed).toISOString();
}
function limitQuery(value: string | undefined): number {
  if (value === undefined || !value.trim()) return DEFAULT_DASHBOARD_LIMIT;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) invalid("limit 必须是正整数。");
  return Math.min(parsed, MAX_DASHBOARD_LIMIT);
}
/** 把 HTTP 查询串解析为看板筛选条件；非法值抛出 422，不静默忽略。 */
export function parseDashboardFilter(query: Readonly<Record<string, string | undefined>>): DashboardFilter {
  const panelRaw = textQuery(query.panel, "panel", 40);
  const panel = panelRaw === undefined ? undefined : (DASHBOARD_PANELS as readonly string[]).includes(panelRaw) ? panelRaw as DashboardPanelKey : invalid("未知看板面板：" + panelRaw + "。");
  const statusRaw = textQuery(query.status, "status", 40);
  const status = statusRaw === undefined ? undefined : REGISTRATION_STATUSES.includes(statusRaw as EventRegistrationStatus) ? statusRaw as EventRegistrationStatus : invalid("未知报名状态：" + statusRaw + "。");
  const from = instantQuery(query.from, "from");
  const to = instantQuery(query.to, "to");
  if (from !== undefined && to !== undefined && from > to) invalid("from 不能晚于 to。");
  const track = textQuery(query.track, "track", 100);
  const roundId = textQuery(query.roundId, "roundId", 200);
  const cursor = textQuery(query.cursor, "cursor", 500);
  return {
    ...(panel === undefined ? {} : { panel }),
    ...(status === undefined ? {} : { status }),
    ...(track === undefined ? {} : { track }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(roundId === undefined ? {} : { roundId }),
    ...(cursor === undefined ? {} : { cursor }),
    limit: limitQuery(query.limit),
  };
}
