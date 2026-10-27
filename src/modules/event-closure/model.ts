import type { EntityId, Instant } from "../../shared/contracts.ts";
import type { HostedEventStatus } from "../../shared/organizer-contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";

/**
 * 赛后闭环（规划 33 第 5 节第 6 期 / 分项 P09，缺口 N6）。
 *
 * 边界（写在本文件里，避免后人误用）：
 * 1. **唯一新增事实**是队伍「是否愿意被联系」。默认不公开，一队一条，仅本队当前成员可提交/撤回，
 *    撤回后可重提，同一重试标识幂等。除此之外本模块**不写入任何事实**。
 * 2. 主办方侧成果清单与「下一届可复用」、队伍侧对既有赛后清单的指回，**全部是只读派生**：
 *    只列已公布/已批准内容，每一项都指回既有记录（见 `EventClosureSourcePort`）。
 * 3. **明确不做**（分项 P09 第 6 节）：撮合交易、投资/录用/孵化承诺、把成绩当能力评价、
 *    读取未提交草稿或私人测评或私人 AI 记忆、新增完成状态/影响力分/成果转化率、
 *    第二套发布入口或第二个成果页面。本模块不建第二套发布或状态。
 * 4. 本模块不导入其他模块的私有文件、不直接写其他模块的存储；跨模块读取一律通过注入的
 *    `EventClosureSourcePort`（由主会话按 root 现有事实实现）。
 */

/** 唯一新增事实：队伍的联系意愿。 */
export interface ContactWillingness {
  id: EntityId;
  organizationId: EntityId;
  eventId: EntityId;
  teamId: EntityId;
  /** 提交这条选择的队伍成员本人；只有本人可以撤回（沿用 event-judging 申诉口径）。 */
  authorUserId: EntityId;
  /** 本队明确选择：true = 同意主办方就本队成果与本队联系；false = 明确不愿意。两者都默认不公开。 */
  willing: boolean;
  status: "active" | "withdrawn";
  revision: number;
  submittedAt: Instant;
  withdrawnAt: Instant | null;
  idempotencyKey: string;
}

export interface ContactWillingnessInput {
  teamId: EntityId;
  willing: boolean;
  idempotencyKey: string;
}

export interface ContactWillingnessWithdrawInput {
  expectedRevision: number;
}

/** 主办方侧可见的一条联系意愿：只暴露队伍标识与选择时间，不暴露提交人账号。 */
export interface OrganizerContactWillingness {
  teamId: EntityId;
  chosenAt: Instant;
}

/** 队伍侧本人可见的联系意愿视图（含本队历史；不包含其他队伍任何内容）。 */
export interface MyContactWillingness {
  teamId: EntityId;
  memberCount: number;
  /** 本队当前有效的一条；撤回后为 null。 */
  active: { id: EntityId; willing: boolean; authorUserId: EntityId; submittedAt: Instant; revision: number } | null;
  /** 本队自己的历史记录（含已撤回），按提交时间倒序；仅本队成员可见。 */
  history: readonly { id: EntityId; willing: boolean; status: ContactWillingness["status"]; authorUserId: EntityId; submittedAt: Instant; withdrawnAt: Instant | null }[];
  /** 界面必须原文展示的同意口径与隐私说明。 */
  consentNotice: string;
  privacyNotice: string;
  withdrawNotice: string;
  /** 复用既有赛后清单的入口，不另做一份。 */
  reuse: {
    myChecklistsHref: string;
    retrospectiveHref: string | null;
    linkedProjectId: EntityId | null;
    notice: string;
  };
}

/** 本场正式收件的最小只读投影（成员双重校验与成果计数用）。 */
export interface ClosureIntakeReceipt {
  id: EntityId;
  teamId: EntityId;
  version: number;
  receiptNumber: string;
  ruleVersion: number;
  eventRevision: number;
  submittedAt: Instant;
  memberUserIds: readonly EntityId[];
}

/** 一件已公布作品的最小只读投影；`reviewRequired` 为真时来源方必须已清空 `rows`。 */
export interface ClosurePublishedRow {
  teamId: EntityId;
  title: string;
  total: number | null;
  rank: number | null;
  approvedFeedbackCount: number;
}

export interface ClosurePublishedResult {
  id: EntityId;
  roundId: EntityId;
  roundTitle: string;
  version: number;
  visibility: "public" | "participants";
  publishedAt: Instant;
  reviewRequired: boolean;
  rows: readonly ClosurePublishedRow[];
}

/** 既有记录的复用来源：每一项都必须指回一条既有记录（`href` 不得为空）。 */
export type ClosureReuseKind =
  | "judging_baseline" | "schedule" | "registration_form" | "notification_template" | "branding" | "published_revision";

export interface ClosureReuseSource {
  id: string;
  kind: ClosureReuseKind;
  label: string;
  detail: string;
  /** 指向既有记录的路径（既有 API 或既有页面）；由来源方给出，不由本模块编造。 */
  href: string;
  /**
   * 来源记录当前状态。派生视图**只列 published / approved**；draft / unpublished 会被丢弃，
   * 因此"只列已公布或已批准内容"由数据本身保证，而不是靠文案。
   */
  state: "published" | "approved" | "draft" | "unpublished";
}

export interface ClosureRetrospectiveCount {
  projectId: EntityId;
  confirmedCount: number;
}

/**
 * 只读来源端口。由主会话按 root 现有的 organizer / event-registration / event-judging / M07 事实实现，
 * 与本模块共用同一个 `SqlExecutor`（同一事务，不另开连接）。
 *
 * 安全约定：
 * - `publishedResults` 只返回主办方**已发布过**的投影；`reviewRequired` 的作品必须 `rows: []`。
 * - `confirmedRetrospectiveCounts` 只统计**已确认**的复盘条目，**不得**读取未提交草稿正文。
 * - `reuseSources` 只返回确实存在的既有记录；没有记录就不要返回这一项，**不要补占位**。
 */
export interface EventClosureSourcePort {
  intakeReceipts(sql: SqlExecutor, eventId: EntityId): Promise<readonly ClosureIntakeReceipt[]>;
  publishedResults(sql: SqlExecutor, eventId: EntityId): Promise<readonly ClosurePublishedResult[]>;
  reuseSources(sql: SqlExecutor, eventId: EntityId): Promise<readonly ClosureReuseSource[]>;
  /** 未接入 M07 时可以不提供：视图会显示"未读取"，而不是 0。 */
  confirmedRetrospectiveCounts?(sql: SqlExecutor, eventId: EntityId, projectIds: readonly EntityId[]): Promise<readonly ClosureRetrospectiveCount[]>;
}

/** 主办方侧一条已公布结果（只报数量与版本；`reviewRequired` 时不列任何作品）。 */
export interface PublishedOutcome {
  roundId: EntityId;
  roundTitle: string;
  version: number;
  visibility: "public" | "participants";
  publishedAt: Instant;
  reviewRequired: boolean;
  workCount: number;
  approvedFeedbackCount: number;
  works: readonly { teamId: EntityId; title: string }[];
}

/** 主办方侧赛后闭环视图：只读派生 + 唯一新增事实（联系意愿）的公开投影。 */
export interface PostEventSummary {
  event: {
    eventId: EntityId; organizationId: EntityId; title: string; status: HostedEventStatus;
    timezone: string; startsAt: Instant; endsAt: Instant; submissionClosesAt: Instant | null; afterEvent: boolean;
  };
  outcomes: {
    intake: { count: number; latestSubmittedAt: Instant | null };
    published: readonly PublishedOutcome[];
    retrospectives: { confirmedCount: number | null; linkedProjectCount: number; state: "read" | "unread"; notice: string | null };
  };
  reuse: readonly ClosureReuseSource[];
  contactWillingness: readonly OrganizerContactWillingness[];
  existingQueues: readonly { id: string; label: string; href: string; note: string }[];
  notice: string;
  limitations: readonly string[];
}
