import { DomainError } from "../../shared/errors.ts";
import type { EntityId, Instant } from "../../shared/contracts.ts";
import type {
  ClosureIntakeReceipt, ClosurePublishedResult, ClosureReuseSource, ContactWillingness,
  MyContactWillingness, OrganizerContactWillingness, PostEventSummary, PublishedOutcome,
} from "./model.ts";

/**
 * 赛后闭环的**全部业务判断**（纯函数，无 IO、无 `Date.now()`）。
 *
 * 这一层只做两件事：
 * 1. 把既有事实投影成两侧只读清单（主办方成果与「下一届可复用」、队伍侧对本队历史与既有清单入口）；
 * 2. 固定"联系意愿"的对外表述原文——界面必须逐字使用这些常量，不能在组件里另写一套。
 *
 * 它不做：评分、排名、能力评价、成果预测、影响力分、完成状态。
 */

export function invalid(message: string): never { throw new DomainError("CLOSURE_INVALID_INPUT", message); }

export function text(value: unknown, label: string, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) invalid(`${label}格式不正确或过长。`);
  return value.trim();
}

export function contactWillingnessTeamId(value: unknown): string { return text(value, "队伍", 160); }
export function contactWillingnessIdempotencyKey(value: unknown): string { return text(value, "重试标识", 120); }
export function contactWillingnessId(value: unknown): string { return text(value, "联系意愿记录", 160); }

/** 选择必须是明确的布尔值；不接受"随便""默认"这类未选择状态。 */
export function contactWillingnessChoice(value: unknown): boolean {
  if (typeof value !== "boolean") invalid("请明确选择是否愿意被联系。");
  return value;
}

export function contactWillingnessRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid("预期版本必须是正整数。");
  return value;
}

/** 界面必须**逐字**展示的同意口径（规划 33 决策点 5、分项 P09 第 4 节）。 */
export const contactWillingnessConsentNotice =
  "选择「愿意被联系」只表示同意主办方就本队成果与本队联系；这不代表获奖、投资、录用或孵化机会，主办方也没有承诺任何结果。是否联系、何时联系由主办方自行决定。";

export const contactWillingnessPrivacyNotice =
  "默认不公开。只有本队成员主动提交后，本场主办方才能在赛后成果区看到本队「愿意被联系」；选择「不愿意」与一直未选择一样，主办方侧都看不到，也不会显示数量。";

export const contactWillingnessWithdrawNotice =
  "你可以随时撤回这条选择；撤回后主办方侧不再显示，撤回之后仍可重新提交。只有提交人本人可以撤回。";

export const postEventSummaryNotice =
  "本页只汇总这场比赛里已经产生的记录：正式收件、已公布结果、已确认复盘与既有配置。它不预测成果、不比较队伍优劣、也不产生新的状态。";

export const postEventSummaryLimitations: readonly string[] = [
  "只列已公布或已批准的内容；未公布、已撤回或需要复核的作品不在这里出现。",
  "「下一届可复用」每一项都指回既有记录，本站不复制出第二份配置事实。",
  "「愿意被联系」是队伍本人主动选择的新事实；主办方只能看到主动选择愿意的队伍，看不到未选择或选择不愿意的队伍。",
  "不撮合交易，不承诺投资、录用或孵化，也不把成绩或名次当作能力评价。",
  "不读取未提交草稿、私人测评或私人 AI 记忆；其他队伍的私人内容一律不出现。",
];

/** 主办方只看到"主动选择愿意"的队伍；不暴露提交人账号，也不报告未选择的数量。 */
export function organizerContactWillingness(records: readonly ContactWillingness[]): readonly OrganizerContactWillingness[] {
  return records
    .filter(record => record.status === "active" && record.willing)
    .map(record => ({ teamId: record.teamId, chosenAt: record.submittedAt }))
    .sort((left, right) => (left.teamId < right.teamId ? -1 : left.teamId > right.teamId ? 1 : 0));
}

/** 本队当前有效的一条；没有或已撤回返回 null。 */
export function activeWillingness(records: readonly ContactWillingness[], teamId: EntityId): ContactWillingness | null {
  return records.find(record => record.teamId === teamId && record.status === "active") ?? null;
}

/**
 * 队伍侧视图：只含本队自己的记录（即使调用方误传入其他队伍数据，这里也会过滤掉），
 * 并指回**既有** `my-checklists` 赛后清单与既有 M07 复盘入口，不另做一份。
 */
export function myContactWillingnessView(input: {
  eventId: EntityId; teamId: EntityId; memberCount: number; projectId: EntityId | null;
  records: readonly ContactWillingness[];
}): MyContactWillingness {
  const own = input.records
    .filter(record => record.teamId === input.teamId)
    // 提交时间倒序；同一时刻（服务器时钟精度内）按 id 倒序，保证顺序确定且最新一条在前。
    .sort((left, right) => (left.submittedAt > right.submittedAt ? -1 : left.submittedAt < right.submittedAt ? 1 : left.id > right.id ? -1 : left.id < right.id ? 1 : 0));
  const active = own.find(record => record.status === "active") ?? null;
  return {
    teamId: input.teamId,
    memberCount: input.memberCount,
    active: active ? { id: active.id, willing: active.willing, authorUserId: active.authorUserId, submittedAt: active.submittedAt, revision: active.revision } : null,
    history: own.map(record => ({ id: record.id, willing: record.willing, status: record.status, authorUserId: record.authorUserId, submittedAt: record.submittedAt, withdrawnAt: record.withdrawnAt })),
    consentNotice: contactWillingnessConsentNotice,
    privacyNotice: contactWillingnessPrivacyNotice,
    withdrawNotice: contactWillingnessWithdrawNotice,
    reuse: {
      myChecklistsHref: `/competitions/${encodeURIComponent(input.eventId)}/my-checklists?teamId=${encodeURIComponent(input.teamId)}`,
      retrospectiveHref: input.projectId ? `/projects/${encodeURIComponent(input.projectId)}/retrospectives` : null,
      linkedProjectId: input.projectId,
      notice: "本队成果、已批准反馈与本人复盘沿用既有赛后清单与复盘入口，本模块不另做一份清单；这里只新增「是否愿意被联系」这一项选择。",
    },
  };
}

function publishedOutcome(result: ClosurePublishedResult): PublishedOutcome {
  // 需复核时来源方须清空 rows；这里再防御一次，保证失效旧分不会经由本模块泄露。
  const rows = result.reviewRequired ? [] : result.rows;
  return {
    roundId: result.roundId,
    roundTitle: result.roundTitle,
    version: result.version,
    visibility: result.visibility,
    publishedAt: result.publishedAt,
    reviewRequired: result.reviewRequired,
    workCount: result.rows.length,
    approvedFeedbackCount: result.reviewRequired ? 0 : rows.reduce((sum, row) => sum + (Number.isFinite(row.approvedFeedbackCount) ? row.approvedFeedbackCount : 0), 0),
    works: rows.map(row => ({ teamId: row.teamId, title: row.title })),
  };
}

/** 只保留已公布/已批准且确实指回既有记录（`href` 非空）的复用来源。 */
export function reuseSourcesOf(sources: readonly ClosureReuseSource[]): readonly ClosureReuseSource[] {
  const seen = new Set<string>();
  const kept: ClosureReuseSource[] = [];
  for (const source of sources) {
    if (source.state !== "published" && source.state !== "approved") continue;
    if (!source.href || !source.href.trim() || !source.label || !source.label.trim()) continue;
    if (seen.has(source.id)) continue;
    seen.add(source.id);
    kept.push({ id: source.id, kind: source.kind, label: source.label.trim(), detail: source.detail.trim(), href: source.href.trim(), state: source.state });
  }
  return kept.sort((left, right) => (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : left.id < right.id ? -1 : 1));
}

/** 主办方侧赛后闭环视图。全部输入都是既有事实或来源端口给出的只读投影。 */
export function postEventSummary(input: {
  event: PostEventSummary["event"];
  receipts: readonly ClosureIntakeReceipt[];
  published: readonly ClosurePublishedResult[];
  reuse: readonly ClosureReuseSource[];
  retrospectives: PostEventSummary["outcomes"]["retrospectives"];
  willingness: readonly ContactWillingness[];
}): PostEventSummary {
  const times = input.receipts.map(receipt => receipt.submittedAt).sort();
  const latestSubmittedAt: Instant | null = times.length ? times[times.length - 1]! : null;
  const published = [...input.published]
    .sort((left, right) => (right.version - left.version) || (left.id < right.id ? -1 : 1))
    .map(publishedOutcome);
  return {
    event: input.event,
    outcomes: {
      intake: { count: input.receipts.length, latestSubmittedAt },
      published,
      retrospectives: input.retrospectives,
    },
    reuse: reuseSourcesOf(input.reuse),
    contactWillingness: organizerContactWillingness(input.willingness),
    existingQueues: [
      { id: "judging_appeals", label: "评审申诉处理队列", href: `/organizer/events/${encodeURIComponent(input.event.eventId)}/judging/appeals`, note: "申诉仍由既有队列人工处理；本页只新增联系意愿，不新增第二套审批。" },
      { id: "judging_config", label: "评审结果与公布", href: `/organizer/events/${encodeURIComponent(input.event.eventId)}/judging/config`, note: "分数、名次与公布仍以既有评审轮为准，本模块不改结果。" },
      { id: "registration_review", label: "报名审核", href: `/organizer/events/${encodeURIComponent(input.event.eventId)}/registrations`, note: "赛后如需联系队伍，先确认报名与队伍事实，避免联系到已退出的人。" },
    ],
    notice: postEventSummaryNotice,
    limitations: postEventSummaryLimitations,
  };
}
