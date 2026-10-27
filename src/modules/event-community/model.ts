import type { EntityId, Instant } from "../../shared/contracts.ts";
import type { EventCommunityRetention } from "../../shared/organizer-contracts.ts";

/**
 * 选手社区 · 连接 + 私信（规划 34 §4 D2/D3、宪法 v1.23.0 原则 XIII「选手社区」）。
 *
 * 边界（写在本文件里，避免后人误用）：
 * 1. **默认关闭**：赛事配置没有开启时，连接与私信一律 403，**不返回空数组**——"没有"和"不可用"必须能区分。
 * 2. **仅同场参赛者**：只允许本场报名**已通过（approved）**的人参与；访客、其他赛事的人、被拒/撤回报名的人都不能参与。
 * 3. **连接是双向同意**：请求 → 对方接受，才形成连接；本模块**没有**单向关注、粉丝、跨赛事社交图谱。
 * 4. **私信只在已接受的连接内**：单条限长、同账号同赛事限频、本人可撤回；屏蔽与举报是硬功能。
 * 5. **不自动暴露联系方式**：本模块的任何投影都不含邮箱/电话，也不替本人补全；是否交换由本人在消息里决定。
 * 6. **消息内容不进入任何模型训练**（宪法 XII）；本模块**不调用任何 AI**。
 * 7. **通知只走既有 `EventNotificationPort`**：不新建第二套通知系统；未注入时只落站内事实并明确说明未发送。
 */

/** 连接状态。只有 accepted 才是"连接"；pending 是"未处理请求"。 */
export type ConnectionStatus = "pending" | "accepted" | "rejected" | "cancelled";

/** 一场比赛里、一对账号之间的一条连接事实。 */
export interface EventConnection {
  id: EntityId;
  organizationId: EntityId;
  eventId: EntityId;
  /** 规范化的账号对键（同一对账号在本场只有这一种键），用于"每对只允许一条待处理或已接受记录"。 */
  pairKey: string;
  requesterUserId: EntityId;
  addresseeUserId: EntityId;
  status: ConnectionStatus;
  revision: number;
  requestedAt: Instant;
  respondedAt: Instant | null;
  decidedByUserId: EntityId | null;
  idempotencyKey: string;
}

export interface ConnectionInput {
  peerUserId: EntityId;
  idempotencyKey: string;
}

export interface ConnectionRespondInput {
  decision: "accept" | "reject";
  expectedRevision: number;
}

export interface ConnectionRevisionInput {
  expectedRevision: number;
}

/** 一条私信。撤回或按保留口径清理后 `content` 为 null，其余最小事实保留可追溯。 */
export interface DirectMessage {
  id: EntityId;
  organizationId: EntityId;
  eventId: EntityId;
  connectionId: EntityId;
  senderUserId: EntityId;
  recipientUserId: EntityId;
  content: string | null;
  status: "active" | "withdrawn" | "purged";
  revision: number;
  createdAt: Instant;
  withdrawnAt: Instant | null;
  purgedAt: Instant | null;
  idempotencyKey: string;
}

export interface DirectMessageInput {
  peerUserId: EntityId;
  content: string;
  idempotencyKey: string;
}

export interface DirectMessageWithdrawInput {
  expectedRevision: number;
}

/** 屏蔽：只在本场生效；本模块不做跨赛事社交图谱（宪法 XIII「明确不做」）。 */
export interface CommunityBlock {
  id: EntityId;
  organizationId: EntityId;
  eventId: EntityId;
  blockerUserId: EntityId;
  blockedUserId: EntityId;
  createdAt: Instant;
}

export const COMMUNITY_REPORT_REASONS = ["harassment", "spam", "contact_touting", "impersonation", "other"] as const;
export type CommunityReportReason = typeof COMMUNITY_REPORT_REASONS[number];

/** 举报快照的一条：只保留最小事实；`content` 仅在举报时刻可见且保留口径不是 purge 时才复制。 */
export interface ReportSnapshotEntry {
  messageId: EntityId;
  senderUserId: EntityId;
  recipientUserId: EntityId;
  createdAt: Instant;
  status: DirectMessage["status"];
  content: string | null;
}

/** 举报只记录事实与最近消息快照，**不自行裁决**（不隐藏、不改状态、不改分数）。 */
export interface CommunityReport {
  id: EntityId;
  organizationId: EntityId;
  eventId: EntityId;
  reporterUserId: EntityId;
  reportedUserId: EntityId;
  connectionId: EntityId | null;
  reason: CommunityReportReason;
  detail: string;
  snapshot: readonly ReportSnapshotEntry[];
  status: "open";
  createdAt: Instant;
  idempotencyKey: string;
}

export interface ReportInput {
  peerUserId: EntityId;
  reason: CommunityReportReason;
  detail?: string;
  connectionId?: EntityId | null;
  idempotencyKey: string;
}

/** 通知投递结果。复用既有端口；`not_sent` 必须被界面如实显示，不能当成成功。 */
export type NoticeDeliveryState = "queued" | "unconfigured" | "not_sent";
export interface NoticeDelivery {
  state: NoticeDeliveryState;
  referenceId: EntityId | null;
  detail: string;
}

export interface CommunityCapabilities {
  directory: boolean;
  connections: boolean;
  directMessages: boolean;
  retention: EventCommunityRetention;
  purgeDays: number | null;
  retentionNotice: string;
}

export interface ConnectionRequestView {
  id: EntityId;
  peerUserId: EntityId;
  requestedAt: Instant;
  revision: number;
}

export interface ConnectionLinkView {
  id: EntityId;
  peerUserId: EntityId;
  connectedAt: Instant;
  revision: number;
  blocked: boolean;
}

export interface BlockView {
  peerUserId: EntityId;
  blockedAt: Instant;
}

export interface CommunityLimits {
  pendingLimit: number;
  pendingRemaining: number;
  rejectCooldownDays: number;
  messageMaxLength: number;
  messageRateMax: number;
  messageRateWindowSeconds: number;
}

export interface CommunityNotices {
  defaultOff: string;
  mutual: string;
  safety: string;
  age: string;
  training: string;
  report: string;
  block: string;
}

/** 选手侧总览：只有本人相关的请求、连接与屏蔽；名单本身复用既有参赛名片（P1），本模块不另建名录。 */
export interface CommunityOverview {
  eventId: EntityId;
  capabilities: CommunityCapabilities;
  incoming: readonly ConnectionRequestView[];
  outgoing: readonly ConnectionRequestView[];
  connections: readonly ConnectionLinkView[];
  blocks: readonly BlockView[];
  limits: CommunityLimits;
  notices: CommunityNotices;
  limitations: readonly string[];
}

export interface DirectMessageView {
  id: EntityId;
  senderUserId: EntityId;
  recipientUserId: EntityId;
  mine: boolean;
  createdAt: Instant;
  status: DirectMessage["status"];
  revision: number;
  content: string | null;
  withdrawn: boolean;
  purged: boolean;
  display: string;
}

/** 一段会话：只有已连接的两人才看得到；保留口径决定旧正文是否还可读。 */
export interface ConversationView {
  eventId: EntityId;
  peerUserId: EntityId;
  connectionId: EntityId;
  connectedAt: Instant;
  messagesEnabled: boolean;
  blocked: boolean;
  canSend: boolean;
  sendBlockedReason: string | null;
  retention: EventCommunityRetention;
  retentionNotice: string;
  messages: readonly DirectMessageView[];
  limits: CommunityLimits & { rateRemaining: number };
  notices: CommunityNotices;
}

export interface ConnectionMutationResult {
  connection: EventConnection;
  notification: NoticeDelivery;
}

export interface ConnectionResponseResult {
  connection: EventConnection;
  notification: NoticeDelivery;
}

export interface BlockResult {
  block: CommunityBlock;
  /** 屏蔽时被自动置为 rejected 的待处理请求条数（双方各算）。 */
  rejectedRequests: number;
}

export interface SendDirectMessageResult {
  message: DirectMessageView;
  notification: NoticeDelivery;
  limits: CommunityLimits & { rateRemaining: number };
}

export interface ReportResult {
  report: CommunityReport;
  notice: string;
}

export interface OrganizerReportView {
  id: EntityId;
  reporterUserId: EntityId;
  reportedUserId: EntityId;
  connectionId: EntityId | null;
  reason: CommunityReportReason;
  reasonLabel: string;
  detail: string;
  snapshot: readonly ReportSnapshotEntry[];
  status: "open";
  createdAt: Instant;
}

/**
 * 主办方侧举报队列：**只含被举报的那条连接在举报时刻的快照**。
 * 主办方没有"读取任意私信"的通道；本视图不含任何未被举报的消息。
 */
export interface OrganizerReportsView {
  eventId: EntityId;
  count: number;
  reports: readonly OrganizerReportView[];
  notice: string;
  limitations: readonly string[];
}

export interface RetentionMaintenanceResult {
  eventId: EntityId;
  retention: EventCommunityRetention;
  purgeDays: number | null;
  state: "purged" | "skipped";
  scanned: number;
  purged: number;
  notice: string;
}
