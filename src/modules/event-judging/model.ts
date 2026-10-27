import type { EntityId, Instant } from "../../shared/contracts.ts";

export interface SubmissionMaterials {
  title: string;
  description: string;
  links: readonly { label: string; url: string }[];
  /** Metadata supplied by the entrant; no upload, download or hash verification is implied. */
  files: readonly { name: string; url: string; sizeBytes: number; sha256: string; mediaType: string }[];
}
export interface SubmissionPreview {
  eventId: EntityId; organizationId: EntityId; teamId: EntityId;
  eventRevision: number; publishedRevision: number; teamRevision: number; previousVersion: number;
  submissionClosesAt: Instant; materials: SubmissionMaterials; materialHash: string;
  warning: string;
}
export interface SubmissionInput {
  teamId: EntityId; materials: SubmissionMaterials;
  expectedEventRevision: number; expectedTeamRevision: number; expectedPreviousVersion: number;
  expectedMaterialHash: string; idempotencyKey: string;
}
export interface IntakeReceipt extends SubmissionPreview {
  id: EntityId; authorUserId: EntityId; version: number; receiptNumber: string; submittedAt: Instant;
  ruleVersion: number; memberUserIds: readonly EntityId[]; inputHash: string; idempotencyKey: string;
  submissionRecordId: EntityId | null;
}
export interface ScoreCriterion { id: string; label: string; weight: number; min: number; max: number }
export interface JudgingConfig {
  title: string; criteria: readonly ScoreCriterion[]; minJudges: number;
  missingPolicy: "block_publication" | "exclude_incomplete";
  tiePolicy: "shared_rank" | "manual_order";
  /** 结果公布后允许提交申诉的天数；不是评分参数，未保存时按 7 天处理。 */
  appealWindowDays?: number;
}
export interface JudgingRound {
  id: EntityId; eventId: EntityId; organizationId: EntityId; revision: number;
  status: "setup" | "open" | "locked" | "published";
  config: JudgingConfig; snapshotIds: readonly EntityId[];
  createdAt: Instant; startedAt: Instant | null; lockedAt: Instant | null;
  lockedSummary: ResultSummary | null; publishedResultId: EntityId | null;
}
export interface JudgeAssignment {
  id: EntityId; eventId: EntityId; organizationId: EntityId; roundId: EntityId; snapshotId: EntityId;
  judgeUserId: EntityId; revision: number; status: "active" | "needs_review" | "recused" | "revoked";
  conflictReasons: readonly string[]; declaration: "unconfirmed" | "clear" | "conflict";
  createdAt: Instant;
}
export interface ManualScore {
  id: EntityId; eventId: EntityId; organizationId: EntityId; assignmentId: EntityId;
  revision: number; state: "draft" | "submitted";
  values: Readonly<Record<string, number>>; feedback: string; updatedAt: Instant;
}
export interface ScoreInput {
  expectedAssignmentRevision: number; expectedScoreRevision: number;
  values: Readonly<Record<string, number>>; feedback: string; correctionReason?: string;
}
export interface ResultRow {
  snapshotId: EntityId; teamId: EntityId; title: string;
  submittedJudgeCount: number; missingJudges: number; total: number | null; rank: number | null;
}
export interface ResultSummary {
  rows: readonly ResultRow[]; missingPolicy: JudgingConfig["missingPolicy"];
  tiePolicy: JudgingConfig["tiePolicy"]; complete: boolean; hasTies: boolean;
}
export interface PublishInput {
  expectedRevision: number; expectedSummaryHash: string;
  visibility: "public" | "participants";
  /** Full order of eligible snapshot IDs, required by manual_order. */
  orderedSnapshotIds?: readonly EntityId[];
  approvedFeedback: readonly { snapshotId: EntityId; text: string; visibility: "team" | "public" }[];
}
export interface PublishedResults {
  id: EntityId; eventId: EntityId; organizationId: EntityId; roundId: EntityId; version: number;
  visibility: "public" | "participants"; publishedAt: Instant; publishedBy: EntityId;
  rows: readonly ResultRow[]; approvedFeedback: PublishInput["approvedFeedback"];
}
export interface ResultProjection {
  status: "waiting_publication" | "published" | "needs_review"; version: number | null; publishedAt: Instant | null;
  /** Generic current-validity signal only; never carries judge identities or conflict reasons. */
  reviewRequired: boolean; reviewNotice: string | null;
  roundId: EntityId | null; roundTitle: string | null;
  rows: readonly { teamId: EntityId; title: string; total: number | null; rank: number | null; feedback: string | null }[];
}
export interface JudgingWorkspace {
  eventId: EntityId; eventTitle: string; organizationName: string; submissionClosesAt: Instant | null;
  rounds: readonly JudgingRound[]; submissions: readonly IntakeReceipt[];
  assignments: readonly JudgeAssignment[]; scores: readonly ManualScore[];
  publicationReviews: readonly (PublicationReview & { roundId: EntityId; publishedResultId: EntityId })[];
}
export interface PublicationReview {
  required: boolean; notice: string | null;
  nextSteps: readonly ("withdraw_results" | "reopen_round" | "review_assignments" | "lock_round" | "preview_results" | "publish_results")[];
}
/**
 * 参赛者对已公布结果的申诉。申诉是**新事实**，但绝不自动改变结果：
 * 分数更正仍必须走既有的撤回 → 重新开放 → 补评 → 重新锁定 → 人工公布链路。
 */
export interface ResultAppeal {
  id: EntityId; eventId: EntityId; organizationId: EntityId;
  roundId: EntityId; publishedResultId: EntityId; resultVersion: number;
  /** 申诉所属队伍与作品快照：同一队伍的成员都能看到这条申诉。 */
  teamId: EntityId; snapshotId: EntityId;
  authorUserId: EntityId; revision: number;
  status: "submitted" | "accepted" | "rejected" | "handled" | "withdrawn";
  reason: string; requestedOutcome: string;
  filedAt: Instant; deadlineAt: Instant;
  resolvedBy: EntityId | null; resolvedAt: Instant | null; decisionNote: string | null;
  idempotencyKey: string;
}
export interface AppealInput {
  roundId: EntityId; reason: string; requestedOutcome?: string; idempotencyKey: string;
}
export interface AppealResolutionInput { expectedRevision: number; decision: "accepted" | "rejected" | "handled"; note: string }
/** 本人所在队伍在当前已公布版本上的申诉窗口状态；供界面判断"还能不能提交"。 */
export interface AppealWindowView {
  roundId: EntityId; roundTitle: string; publishedResultId: EntityId; resultVersion: number;
  publishedAt: Instant; deadlineAt: Instant; snapshotId: EntityId;
  filed: boolean; canFile: boolean; closedReason: string | null;
}
export interface JudgeWorkItem {  assignment: JudgeAssignment; round: JudgeRoundView; score: ManualScore | null;
  /** Authoritative current read projection; assignment alone is not an access grant. */
  accessStatus: "pending_declaration" | "available" | "needs_review" | "recused" | "revoked";
  /** Title only; receipt materials are separately guarded. */
  title: string;
}
export type JudgeRoundView = Pick<JudgingRound, "id" | "eventId" | "revision" | "status" | "config" | "startedAt" | "lockedAt">;
export type JudgeReceiptView = Pick<IntakeReceipt, "id" | "eventId" | "teamId" | "materials" | "materialHash" | "version" | "ruleVersion" | "receiptNumber" | "submittedAt" | "warning">;

/**
 * 规划 34 C①「作品展示」：**唯一新增事实**是"队伍本人对本场作品的公开范围选择"。
 *
 * 三层开关缺一不公开（规划 34 §3.1、宪法 XIII）：
 * 1. 赛事级 `community.workShowcase`（主办方配置，默认 false，关时本模块一律 403）；
 * 2. 队伍级 `scope`（本表，`private` 默认 / `participants` / `public`，由队伍本人选择）；
 * 3. 个人级点评（规划 34 P5/P7，**不在本批**）。
 *
 * 公开投影（`WorkShowcaseEntry`）只含队伍勾选公开的字段；联系人、邮箱、答卷、求助、
 * 住宿、队伍专属反馈与评委身份不在投影函数的输入类型里，因此结构上无法泄露。
 */
export type WorkDisclosureScope = "private" | "participants" | "public";
export type WorkShowcaseFieldKey = "title" | "description" | "links" | "files";
/** 逐项选择：未勾选即不公开；`private` 时不保留任何字段选择。 */
export interface WorkDisclosureFields {
  readonly title: boolean; readonly description: boolean; readonly links: boolean; readonly files: boolean;
}
export interface WorkDisclosure {
  id: EntityId; eventId: EntityId; organizationId: EntityId; teamId: EntityId;
  authorUserId: EntityId; revision: number;
  /** 提交这项选择时该队最新的正式收件回执（只作"当时是哪一版"的证据，不参与当前投影）。 */
  receiptId: EntityId; receiptVersion: number;
  /** `private` 记录"本队明确选择不公开"，不产生任何投影。 */
  scope: WorkDisclosureScope; fields: WorkDisclosureFields;
  status: "active" | "withdrawn";
  updatedAt: Instant; withdrawnAt: Instant | null; idempotencyKey: string;
}
export interface WorkDisclosureInput {
  scope: WorkDisclosureScope; fields?: Partial<WorkDisclosureFields>; idempotencyKey: string;
}
export interface WorkDisclosureWithdrawInput { expectedRevision: number }
/** 只读公开投影：未勾选的字段**整体缺失**（不是空字符串，也不是 null）。 */
export interface WorkShowcaseEntry {
  readonly teamId: EntityId;
  /** 投影所依据的**当前**正式收件回执；留言（P5）挂在作品上，需要它来定位入口。 */
  readonly snapshotId: EntityId;
  readonly scope: "participants" | "public";
  readonly disclosedFields: readonly WorkShowcaseFieldKey[];
  readonly updatedAt: Instant;
  readonly title?: string;
  readonly description?: string;
  readonly links?: readonly { readonly label: string; readonly url: string }[];
  readonly files?: readonly { readonly name: string; readonly url: string; readonly sizeBytes: number; readonly sha256: string; readonly mediaType: string }[];
}
export interface WorkShowcaseList {
  readonly eventId: EntityId;
  readonly showcaseEnabled: true;
  readonly visibleCount: number;
  readonly items: readonly WorkShowcaseEntry[];
  readonly notice: string;
  readonly limitations: readonly string[];
}
/** 主办方侧只读：已披露作品 + 未公开队伍**数量**（不含身份）。 */
export interface OrganizerWorkShowcase extends WorkShowcaseList {
  readonly notDisclosedTeamCount: number;
}
export interface MyWorkDisclosure {
  readonly teamId: EntityId;
  readonly hasFormalReceipt: boolean;
  readonly canSubmit: boolean;
  readonly reason: string | null;
  readonly active: {
    readonly id: EntityId; readonly scope: WorkDisclosureScope; readonly fields: WorkDisclosureFields;
    readonly authorUserId: EntityId; readonly revision: number; readonly updatedAt: Instant;
  } | null;
  readonly history: readonly {
    readonly id: EntityId; readonly scope: WorkDisclosureScope; readonly fields: WorkDisclosureFields;
    readonly status: WorkDisclosure["status"]; readonly authorUserId: EntityId;
    readonly updatedAt: Instant; readonly withdrawnAt: Instant | null; readonly revision: number;
  }[];
  readonly notices: {
    readonly defaultPrivate: string; readonly fieldChoice: string; readonly scope: string;
    readonly withdraw: string; readonly gate: string;
  };
}

/**
 * 规划 34 C②「文字留言」（P5）。与数值互评（P7）**分列**：本批只有纯文字，
 * 没有量纲、没有维度、没有评分字段，也**不读不写**任何互评数据。
 *
 * 留言挂在**队伍级作品展示单位**上（与 P2 的公开投影同口径：一个队伍一件作品），
 * `snapshotId` 只记录"写这条留言时该队最新的正式收件"，作为"当时是哪一版"的证据。
 */
export type WorkCommentStatus = "active" | "hidden";
export interface WorkComment {
  id: EntityId; organizationId: EntityId; eventId: EntityId;
  teamId: EntityId; snapshotId: EntityId;
  authorUserId: EntityId; text: string;
  status: WorkCommentStatus; revision: number; createdAt: Instant;
  hiddenAt: Instant | null; hiddenByUserId: EntityId | null;
  hiddenByRole: "author" | "staff" | null; hiddenReason: string;
  idempotencyKey: string;
}
export interface WorkCommentInput { text: string; idempotencyKey: string }
export interface WorkCommentHideInput { reason?: string }
export interface WorkCommentReportInput { reason?: string }
/** 举报只记录事实：不改留言状态、不改任何结果，本模块不裁决。 */
export interface WorkCommentReport {
  id: EntityId; organizationId: EntityId; eventId: EntityId;
  commentId: EntityId; reporterUserId: EntityId; reason: string; createdAt: Instant;
}
/** 留言视图：**不含作者账号**；隐藏后 `text` 为 `null`（对所有人不再返回内容）。 */
export interface WorkCommentView {
  readonly id: EntityId; readonly teamId: EntityId; readonly createdAt: Instant;
  readonly status: WorkCommentStatus; readonly text: string | null;
  readonly isMine: boolean; readonly canHide: boolean; readonly canReport: boolean;
  readonly reportedCount: number; readonly reportedByViewer: boolean;
  readonly hiddenAt: Instant | null; readonly hiddenBy: "author" | "staff" | null;
}
export interface WorkCommentList {
  readonly eventId: EntityId; readonly snapshotId: EntityId; readonly teamId: EntityId;
  readonly commentsEnabled: true; readonly scope: Exclude<WorkDisclosureScope, "private">;
  readonly commentMaxLength: number; readonly cooldownSeconds: number;
  readonly items: readonly WorkCommentView[]; readonly totalCount: number;
  readonly hiddenCount: number; readonly truncated: boolean;
  readonly notice: string;
  readonly notices: {
    readonly separate: string; readonly notRanked: string; readonly gate: string;
    readonly visibility: string; readonly hide: string; readonly report: string; readonly rate: string;
  };
  readonly limitations: readonly string[];
}
export interface WorkCommentReportReceipt {
  readonly reportId: EntityId; readonly commentId: EntityId; readonly reportedAt: Instant;
  readonly reportedCount: number; readonly alreadyReported: boolean;
}
