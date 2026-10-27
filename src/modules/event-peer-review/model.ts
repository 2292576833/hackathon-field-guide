import type { EntityId, Instant } from "../../shared/contracts.ts";
import type { EventCommunityScale } from "../../shared/organizer-contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";

/**
 * 选手数值互评（规划 34 P7 / 宪法 v1.23.0 原则 XIII「作品公开与点评」）。
 *
 * 边界（写在本文件里，避免后人误用）：
 * 1. **独立模块**：本模块与 src/modules/event-judging/ 完全分离，不导入它的聚合、导出或私有文件。
 *    因此结构上**不存在**任何通往 aggregate() / results / results-export / 名次的写路径，
 *    也天然没有评委侧入口（评分期评委不可见）。
 * 2. 互评是**另一类事实**：分列存储在本模块自己的 epr_ 表里，MUST NOT 并入正式汇总、名次、公布或对外导出。
 * 3. 三层门禁缺一即 403（不是空数组）：赛事 workShowcase + 赛事 peerReview + 队伍本人选择公开。
 * 4. 量纲（1-5 / 0-10 / yes-no）与维度**由主办方配置**且与评委维度分开定义；不在冻结维度里的键一律拒绝。
 * 5. 去自评：正式收件成员快照里的人不能评本队作品。
 * 6. 参与率低于主办方门槛时只返回「样本不足/未达门槛」与门槛值本身，不显示任何平均分或统计。
 * 7. 评分者身份**不对参赛者展示**：对参赛者只返回按作品汇总的各维度平均与份数，以及匿名的逐条分值。
 */

/** 互评量纲取自共享契约 EVENT_COMMUNITY_SCALES，本模块不自定义第二套。 */
export type PeerReviewScale = EventCommunityScale;
/** 可被点评的作品范围：队伍本人选择的公开范围去掉 private 之后的两档。 */
export type PeerReviewScope = "participants" | "public";
/** 一条互评记录的状态：active 是当前有效；withdrawn 是本人撤回；superseded 是被本人新的版本取代。 */
export type PeerReviewStatus = "active" | "withdrawn" | "superseded";

export interface PeerReviewDimension { readonly id: string; readonly label: string }
export interface PeerReviewValue { readonly dimensionId: string; readonly value: number }

/** 一条互评记录（epr_peer_reviews 的一行）。分值是冻结的：改写只会产生新的 active 行。 */
export interface PeerReview {
  id: EntityId;
  organizationId: EntityId;
  eventId: EntityId;
  /** 正式收件回执 id（作品版本）；互评挂在具体版本上，重新交件后旧版本互评不跟随。 */
  snapshotId: EntityId;
  /** 被点评作品所属队伍。 */
  teamId: EntityId;
  reviewerUserId: EntityId;
  scale: PeerReviewScale;
  /** 提交时冻结的维度定义；主办方以后改维度不会改写历史记录。 */
  dimensions: readonly PeerReviewDimension[];
  values: readonly PeerReviewValue[];
  status: PeerReviewStatus;
  revision: number;
  createdAt: Instant;
  updatedAt: Instant;
  withdrawnAt: Instant | null;
  supersededAt: Instant | null;
  idempotencyKey: string;
}

/** 提交/更新我的互评：每个冻结维度一个整数。 */
export interface PeerReviewInput {
  values: Readonly<Record<string, number>>;
  /** 修改已有互评时必须给出当前版本号；不给则 409（不是猜一个版本）。 */
  expectedRevision?: number;
  idempotencyKey: string;
}

export interface PeerReviewWithdrawInput { expectedRevision: number }
export interface PeerReviewReportInput { reason?: string }

/** 举报事实：只记录谁、何时举报了哪条互评以及举报时刻的分值快照；不做任何裁决。 */
export interface PeerReviewReport {
  id: EntityId;
  organizationId: EntityId;
  eventId: EntityId;
  reviewId: EntityId;
  snapshotId: EntityId;
  teamId: EntityId;
  reporterUserId: EntityId;
  reason: string;
  /** 举报时刻这条互评的分值快照；不含评分者身份。 */
  values: readonly PeerReviewValue[];
  scale: PeerReviewScale;
  createdAt: Instant;
}

/*
 * 既有事实的最小只读投影。由 root 用**同一个 SqlExecutor** 从 event-judging 的正式收件与公开披露事实转发；
 * 本模块不导入 event-judging，也不直接读它的表。
 */
export interface PeerReviewWork {
  readonly id: EntityId;
  readonly teamId: EntityId;
  readonly version: number;
  readonly submittedAt: Instant;
  /** 正式收件时的队伍成员快照（去自评依据）。 */
  readonly memberUserIds: readonly EntityId[];
}

export interface PeerReviewDisclosure {
  readonly teamId: EntityId;
  readonly scope: "private" | "participants" | "public";
  readonly status: "active" | "withdrawn";
}

export interface EventPeerReviewSourcePort {
  /** 本场全部正式收件（含历史版本）；用于把 snapshotId 定位到队伍与成员快照，并判断是否当前展示版本。 */
  intakeWorks(sql: SqlExecutor, eventId: EntityId): Promise<readonly PeerReviewWork[]>;
  /** 本场全部公开披露记录（含已撤回历史）；由本模块按队伍取 active 的那条。 */
  workDisclosures(sql: SqlExecutor, eventId: EntityId): Promise<readonly PeerReviewDisclosure[]>;
  /** 本场报名**已通过**的账号；长度就是参与率门槛的分母，成员资格也用它。 */
  approvedParticipantIds(sql: SqlExecutor, eventId: EntityId): Promise<readonly EntityId[]>;
}

export interface PeerReviewGateFailure { readonly code: string; readonly message: string; readonly status: number }

export interface PeerReviewThreshold {
  readonly code: "PEER_REVIEW_SUMMARY_READY" | "PEER_REVIEW_THRESHOLD_NOT_MET";
  readonly met: boolean;
  /** 主办方设置的门槛值本身；未达门槛时只返回它，不返回参与率、人数或任何平均分。 */
  readonly requiredRate: number;
  readonly message: string;
  /** 以下三项只在 met 时给出（达标是展示汇总的前提）。 */
  readonly passRate?: number;
  readonly submittedReviewerCount?: number;
  readonly approvedParticipantCount?: number;
}

export interface MyPeerReview {
  readonly id: EntityId;
  readonly values: readonly PeerReviewValue[];
  readonly revision: number;
  readonly updatedAt: Instant;
}

/** 匿名逐条分值：只有 reviewId 与分值，没有评分者身份，也不按分值排序（避免形成变相排名）。 */
export interface AnonymousPeerReview { readonly reviewId: EntityId; readonly values: readonly PeerReviewValue[] }

export interface WorkPeerReviewDimensionSummary {
  readonly id: string;
  readonly label: string;
  /** 该维度在**本作品**上的平均分；没有任何评分时为 null（不是 0）。 */
  readonly average: number | null;
  readonly count: number;
}

/** 按作品汇总：只有各维度平均与份数、匿名逐条分值；绝不含人名、名次或百分比排名。 */
export interface WorkPeerReviewSummary {
  readonly state: "met";
  readonly reviewCount: number;
  readonly dimensions: readonly WorkPeerReviewDimensionSummary[];
  readonly anonymousReviews: readonly AnonymousPeerReview[];
  readonly requiredRate: number;
  readonly passRate: number;
  readonly submittedReviewerCount: number;
  readonly approvedParticipantCount: number;
}

export interface PeerReviewNotices {
  readonly separate: string;
  readonly notRanked: string;
  readonly gate: string;
  readonly anonymous: string;
  readonly selfReview: string;
  readonly threshold: string;
  readonly governance: string;
  readonly scale: string;
}

export interface WorkPeerReviewView {
  readonly eventId: EntityId;
  readonly snapshotId: EntityId;
  readonly teamId: EntityId;
  readonly scope: PeerReviewScope;
  readonly enabled: true;
  readonly scale: PeerReviewScale;
  readonly dimensions: readonly PeerReviewDimension[];
  readonly valueRange: { readonly min: number; readonly max: number };
  readonly myReview: MyPeerReview | null;
  readonly canReview: boolean;
  readonly canReviewReason: string | null;
  readonly threshold: PeerReviewThreshold;
  readonly summary: WorkPeerReviewSummary | null;
  readonly notices: PeerReviewNotices;
  readonly limitations: readonly string[];
}

/** 撤回回执：撤回只返回最小事实，不依赖作品此刻是否仍然公开（撤回自己的数据不该被门禁挡住）。 */
export interface PeerReviewWithdrawResult {
  readonly reviewId: EntityId;
  readonly snapshotId: EntityId;
  readonly revision: number;
  readonly withdrawnAt: Instant;
}

export interface PeerReviewReportReceipt {
  readonly reportId: EntityId;
  readonly reviewId: EntityId;
  readonly reportedAt: Instant;
  readonly reportedCount: number;
  readonly alreadyReported: boolean;
}
