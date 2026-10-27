/**
 * P08 · 选手侧资源与下一步汇总（纯逻辑）。
 *
 * 职责只有一件事：把**已经读到的既有事实**整理成"我能领什么、要做什么"的区块与唯一下一步。
 *
 * 硬约束（规划 33 P08 / 设计 §6.5）：
 * - 无 IO、无 `Date.now()`、无随机：同样输入必须得到同样输出，便于确定性核对；
 * - **不新增任何事实**：本文件不产生发放、领取、核销或完成状态，只把既有记录投影成区块；
 * - `null`/空数组表示"没有这条记录"，调用方 `MUST NOT` 补占位或编造值；
 * - 期限只来自**已发布规则版本**（`publishedRevision` 非空时才有意义）；
 * - 每条都能指回既有路由，便于"每项可回溯"的验收。
 */
import type { AnnouncementView, TicketView } from "./model.ts";

// ---------------------------------------------------------------- 输入

/** 已发布规则版本里的期限；`null` 表示主办方没有这一项，界面留空。 */
export interface SummaryDeadlines {
  readonly registrationOpensAt: string | null;
  readonly registrationClosesAt: string | null;
  readonly submissionClosesAt: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
}

/** 汇总需要的最小赛事上下文；由 communication 服务从**已发布**的赛事事实投影而来。 */
export interface SummaryEventContext {
  readonly eventId: string;
  readonly eventTitle: string;
  readonly organizationName: string;
  readonly timezone: string;
  readonly publishedRevision: number | null;
  readonly modules: { readonly schedule: boolean; readonly accommodation: boolean; readonly mealVouchers: boolean };
  readonly deadlines: SummaryDeadlines;
}

/** 本人报名与队伍：由根通过 Port 读取，本模块不查 event-registration 的表。 */
export interface SummaryOwnRegistration {
  readonly status: "draft" | "pending" | "approved" | "rejected" | "withdrawn";
}

export interface SummaryOwnTeam {
  readonly id: string;
  readonly name: string;
  /** 本人在这支队伍里的身份。 */
  readonly role: "captain" | "member";
  readonly memberCount: number;
  readonly status: "forming" | "locked" | "withdrawn";
  readonly track: string;
}

/** 本人住宿安排（只可能是本人那一条，`MUST NOT` 含他人）。 */
export interface SummaryOwnAccommodation {
  readonly location: string;
  readonly room: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly note: string;
}

/** 本人餐券（只可能是本人那些，`MUST NOT` 含他人）。 */
export interface SummaryOwnVoucher {
  readonly name: string;
  readonly remainingUses: number;
  readonly totalUses: number;
  readonly expiresAt: string;
  readonly state: "available" | "exhausted" | "expired" | "revoked";
}

export interface SummaryOwnScheduleItem {
  readonly id: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly location: string;
}

export interface ParticipantSummaryInput extends SummaryEventContext {
  /** 本人报名；`undefined` 表示根尚未接线该 Port（还没读到），`null` 表示确实没有这条记录。 */
  readonly registration: SummaryOwnRegistration | null | undefined;
  /** 本人队伍；`null` 表示当前没有队伍，`undefined` 表示根尚未接线（两者必须区分）。 */
  readonly team: SummaryOwnTeam | null | undefined;
  /** 只含**已发布**公告；草稿与已撤回不在内。 */
  readonly announcements: readonly AnnouncementView[];
  /** 只含本人可见的行程条目。 */
  readonly scheduleItems: readonly SummaryOwnScheduleItem[];
  readonly accommodation: SummaryOwnAccommodation | null;
  readonly vouchers: readonly SummaryOwnVoucher[];
  /** 只含公开问题与本人自己的求助。 */
  readonly tickets: readonly TicketView[];
}

// ---------------------------------------------------------------- 输出

export type SummaryFieldState = "recorded" | "absent" | "unread";

export interface SummaryDeadlineRow {
  readonly key: "registrationOpensAt" | "registrationClosesAt" | "submissionClosesAt" | "startsAt" | "endsAt";
  readonly label: string;
  readonly at: string;
}

export interface SummaryAnnouncementRow {
  readonly id: string;
  readonly title: string;
  readonly important: boolean;
  readonly publishedAt: string | null;
  readonly dueAt: string | null;
  readonly read: boolean;
  readonly href: string;
}

export interface SummaryScheduleRow extends SummaryOwnScheduleItem {
  readonly href: string;
}

export interface SummaryVoucherRow extends SummaryOwnVoucher {
  readonly href: string;
}

export interface SummaryTicketRow {
  readonly id: string;
  readonly question: string;
  readonly visibility: "public" | "private";
  readonly status: TicketView["status"];
  readonly own: boolean;
  readonly href: string;
}

/**
 * 唯一下一步。`kind: "unread"` 表示**读取状态**而不是完成状态：
 * 事实还没读到就不给建议，也不假装"没有待办"（宪法 X）。
 */
export interface SummaryNextStep {
  readonly kind: "register" | "await_review" | "rejected" | "join_team" | "read_notice" | "open_ticket" | "ready" | "unread";
  readonly title: string;
  readonly why: string;
  readonly href: string;
}

export interface ParticipantSummary {
  /** 溯源：已发布规则版本。`null` 时本汇总不声称任何规则结论。 */
  readonly ruleVersion: number | null;
  readonly organizationName: string;
  readonly eventTitle: string;
  readonly timezone: string;
  readonly deadlines: readonly SummaryDeadlineRow[];
  readonly registration: { readonly state: SummaryFieldState; readonly status: SummaryOwnRegistration["status"] | null; readonly href: string };  readonly team: {
    readonly state: SummaryFieldState;
    readonly name: string | null;
    readonly role: SummaryOwnTeam["role"] | null;
    readonly memberCount: number | null;
    readonly status: SummaryOwnTeam["status"] | null;
    readonly track: string | null;
    readonly href: string;
  };
  readonly announcements: { readonly total: number; readonly unread: number; readonly items: readonly SummaryAnnouncementRow[]; readonly href: string };
  readonly schedule: { readonly state: SummaryFieldState; readonly items: readonly SummaryScheduleRow[]; readonly href: string };
  readonly logistics: {
    readonly accommodationState: SummaryFieldState;
    readonly accommodation: SummaryOwnAccommodation | null;
    readonly vouchers: readonly SummaryVoucherRow[];
    readonly href: string;
  };
  readonly tickets: { readonly total: number; readonly open: number; readonly items: readonly SummaryTicketRow[]; readonly href: string };
  /** 给界面的一句话说明：本汇总只是既有记录的投影。 */
  readonly note: string;
  readonly nextStep: SummaryNextStep;
}

// ---------------------------------------------------------------- 路由（每项可回溯）

const competitionBase = (eventId: string) => `/competitions/${encodeURIComponent(eventId)}`;

/** 既有路由常量：验收要求"每一项都能点回原记录"。 */
export const summaryHrefs = (eventId: string) => ({
  register: `${competitionBase(eventId)}/register`,
  teams: `${competitionBase(eventId)}/teams`,
  help: `${competitionBase(eventId)}/help`,
  schedule: `${competitionBase(eventId)}/schedule`,
  services: `${competitionBase(eventId)}/services`,
  overview: competitionBase(eventId),
  announcements: competitionBase(eventId),
  submit: `${competitionBase(eventId)}/submit`,
});

const DEADLINE_LABELS: ReadonlyArray<readonly [SummaryDeadlineRow["key"], string]> = [
  ["registrationOpensAt", "报名开始"],
  ["registrationClosesAt", "报名截止"],
  ["submissionClosesAt", "作品截止"],
  ["startsAt", "比赛开始"],
  ["endsAt", "比赛结束"],
];

// ---------------------------------------------------------------- 推导

/**
 * 期限行。`MUST` 只输出**有值**的项：没有就是不输出，
 * 既不补占位、也不用别的日期顶替（例如不得用报名截止冒充作品截止）。
 */
export function deadlineRows(deadlines: SummaryDeadlines): SummaryDeadlineRow[] {
  const source: Record<SummaryDeadlineRow["key"], string | null> = {
    registrationOpensAt: deadlines.registrationOpensAt,
    registrationClosesAt: deadlines.registrationClosesAt,
    submissionClosesAt: deadlines.submissionClosesAt,
    startsAt: deadlines.startsAt,
    endsAt: deadlines.endsAt,
  };
  const rows: SummaryDeadlineRow[] = [];
  for (const [key, label] of DEADLINE_LABELS) {
    const at = source[key];
    // 空串与 null 一律视为"没有这一项"，不做任何回退。
    if (typeof at !== "string" || !at.trim()) continue;
    rows.push({ key, label, at });
  }
  return rows;
}

/** 是否算"未读"：仅在已有发布时间时判断；没有发布时间的记录不参与未读计数。 */
function isUnread(item: AnnouncementView): boolean {
  return item.status === "published" && item.publishedAt !== null && item.read === false;
}

/**
 * 唯一下一步。优先级固定，任何输入下都只返回**一条**（宪法 X：首屏一个主要行动）。
 * 没有可读事实时返回 `unread`，`MUST NOT` 伪装成"已完成"或"没有待办"。
 */
export function buildNextStep(input: ParticipantSummaryInput): SummaryNextStep {
  const hrefs = summaryHrefs(input.eventId);

  if (input.registration === undefined) {
    return { kind: "unread", title: "先重新读取你的报名状态", why: "我们现在读不到你在这场比赛的报名记录，所以不好判断下一步；重新读取成功后再看这里。", href: hrefs.register };
  }
  if (input.registration === null) {
    return { kind: "register", title: "本场还没有你的报名记录", why: "这场比赛还没有你名下的报名；如果你想参加，先填报名表并提交。", href: hrefs.register };
  }
  const status = input.registration.status;
  if (status === "draft") {
    return { kind: "register", title: "把报名表填完并提交", why: "你的报名还是草稿；提交后主办方才能看到你的报名。", href: hrefs.register };
  }
  if (status === "pending") {
    return { kind: "await_review", title: "等待主办方审核报名", why: "报名已提交，正在等主办方审核；审核结果会显示在同一页，不需要重复提交。", href: hrefs.register };
  }
  if (status === "rejected") {
    return { kind: "rejected", title: "先看未通过的原因", why: "这场报名没有通过；原因写在报名页，确认后按主办方说明处理。", href: hrefs.register };
  }
  if (status === "withdrawn") {
    return { kind: "register", title: "你已撤回报名，需要重新报名", why: "撤回后不会自动恢复；想继续参赛要重新提交一次。", href: hrefs.register };
  }

  // approved 之后：未读通知 → 无队伍 → 打开中的求助 → 就绪
  if (input.team === undefined) {
    return { kind: "unread", title: "先重新读取你的队伍", why: "你的报名已通过，但我们还没读到你的队伍情况；重新读取后再给下一步。", href: hrefs.teams };
  }
  const unread = input.announcements.filter(isUnread);
  if (unread.length) {
    return { kind: "read_notice", title: `有 ${unread.length} 条官方通知还没看`, why: `最新一条是「${unread[unread.length - 1]!.title}」；官方通知可能包含时间或材料变化，先看完再安排其他事。`, href: hrefs.announcements };
  }
  if (input.team === null) {
    return { kind: "join_team", title: "找一个队伍，或自己建一支", why: "报名已通过，现在还没有队伍；比赛页的组队区可以看公开队伍或自己建队。", href: hrefs.teams };
  }
  const openOwn = input.tickets.filter(ticket => ticket.own && ticket.status !== "closed");
  if (openOwn.length) {
    return { kind: "open_ticket", title: `你还有 ${openOwn.length} 个问题在处理中`, why: "主办方或工作人员可能已经回复；先看当前进度，再决定要不要补充说明。", href: hrefs.help };
  }
  return { kind: "ready", title: "按主办方要求继续准备和交付", why: "报名与队伍都已就绪，通知也读完了；下一步在比赛页按当前材料要求推进。", href: hrefs.submit };
}

/** 组装完整汇总。纯函数：不读库、不写库、不看当前时间。 */
export function buildParticipantSummary(input: ParticipantSummaryInput): ParticipantSummary {
  const hrefs = summaryHrefs(input.eventId);
  const approved = input.registration?.status === "approved";
  const unread = input.announcements.filter(isUnread);
  const openTickets = input.tickets.filter(ticket => ticket.status !== "closed");

  return {
    ruleVersion: input.publishedRevision,
    organizationName: input.organizationName,
    eventTitle: input.eventTitle,
    timezone: input.timezone,
    deadlines: deadlineRows(input.deadlines),
    registration: {
      state: input.registration === undefined ? "unread" : input.registration === null ? "absent" : "recorded",
      status: input.registration?.status ?? null,
      href: hrefs.register,
    },
    team: {
      state: input.team === undefined ? "unread" : input.team === null ? "absent" : "recorded",
      name: input.team?.name ?? null,
      role: input.team?.role ?? null,
      memberCount: input.team?.memberCount ?? null,
      status: input.team?.status ?? null,
      track: input.team?.track ?? null,
      href: hrefs.teams,
    },
    announcements: {
      total: input.announcements.length,
      unread: unread.length,
      items: input.announcements.map(item => ({
        id: item.id,
        title: item.title,
        important: item.important,
        publishedAt: item.publishedAt,
        dueAt: item.dueAt,
        read: !isUnread(item),
        href: hrefs.announcements,
      })),
      href: hrefs.announcements,
    },
    schedule: {
      state: input.modules.schedule ? "recorded" : "absent",
      items: input.scheduleItems.map(item => ({ ...item, href: hrefs.schedule })),
      href: hrefs.schedule,
    },
    logistics: {
      accommodationState: input.modules.accommodation ? (input.accommodation ? "recorded" : "absent") : "absent",
      accommodation: input.accommodation,
      vouchers: input.modules.mealVouchers ? input.vouchers.map(voucher => ({ ...voucher, href: hrefs.services })) : [],
      href: hrefs.services,
    },
    tickets: {
      total: input.tickets.length,
      open: openTickets.length,
      items: input.tickets.map(ticket => ({
        id: ticket.id,
        question: ticket.question,
        visibility: ticket.visibility,
        status: ticket.status,
        own: ticket.own,
        href: hrefs.help,
      })),
      href: hrefs.help,
    },
    note: approved
      ? "这里只是把你在这场比赛里已有的记录汇总到一处，方便一眼看清；每一项都能点回原来的页面，查看详情与操作都在那里。汇总本身不产生任何新的记录或状态。"
      : "你在这场比赛的报名还不是已通过状态，所以这里只显示与你本人相关的记录；完整内容请到对应页面查看。",
    nextStep: buildNextStep(input),
  };
}
