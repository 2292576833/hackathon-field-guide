import { DomainError } from "../../shared/errors.ts";
import type { EntityId, Instant } from "../../shared/contracts.ts";
import {
  DEFAULT_EVENT_COMMUNITY, EVENT_COMMUNITY_RETENTIONS, eventCommunity,
  type EventCommunityConfig, type EventCommunityRetention, type EventRegistrationStatus, type HostedEventStatus,
} from "../../shared/organizer-contracts.ts";
import {
  COMMUNITY_REPORT_REASONS,
  type CommunityLimits, type CommunityNotices, type CommunityReportReason,
  type ConnectionStatus, type ConversationView, type DirectMessage, type DirectMessageView,
  type EventConnection, type ReportSnapshotEntry,
} from "./model.ts";

/**
 * 选手社区（连接 + 私信）的**全部业务判断**（纯函数，无 IO、无 `Date.now()`）。
 *
 * 这一层只做三件事：
 * 1. 把赛事配置读成可判定的开关（缺字段按"关闭"，不默认开启）；
 * 2. 固定可被断言的门禁顺序与阈值（请求上限/冷却/限长/限频/保留口径）；
 * 3. 固定界面必须逐字展示的安全口径（双向同意、屏蔽举报、不暴露联系方式、不做年龄核验、不进模型训练）。
 *
 * 它不做：单向关注、跨赛事社交图谱、访客参与、自动补全联系方式、AI 裁决、自动隐藏被举报内容。
 */

export function invalid(message: string): never { throw new DomainError("COMMUNITY_INVALID_INPUT", message); }

/* ---------- 阈值（配置结构里没有的项，用模块常量；已在交付文档 NEEDS_INTERFACE 登记） ---------- */

/** 同账号同赛事同时处于 pending 的连接请求上限（规划 34 §4.1 D2 建议 20）。 */
export const CONNECTION_PENDING_LIMIT = 20;
/** 被拒绝后同一对账号在本场重新发起请求的冷却期（规划 34 §4.1 D2 建议 30 天）。 */
export const CONNECTION_REJECT_COOLDOWN_DAYS = 30;
/** 单条私信长度上限（正文按字符计，trim 之后）。 */
export const DIRECT_MESSAGE_MAX_LENGTH = 1000;
/** 同账号同赛事限频：窗口内最多可发条数。 */
export const DIRECT_MESSAGE_RATE_LIMIT = 20;
export const DIRECT_MESSAGE_RATE_WINDOW_MS = 10 * 60 * 1000;
/** 举报快照最多复制最近多少条（更早的不复制，避免把整段对话搬进举报记录）。 */
export const REPORT_SNAPSHOT_LIMIT = 10;

const DAY_MS = 86_400_000;

/* ---------- 配置读取 ---------- */

/**
 * 读取赛事社区配置。**旧文档缺字段时按全关处理**：
 * 先按 `eventCommunity(scope)` 处理整块缺失，再对逐字段缺失（历史 JSONB、手工写入）做一次保守归一。
 */
export function resolveCommunityConfig(scope: { readonly community?: EventCommunityConfig } | null | undefined): EventCommunityConfig {
  const base = DEFAULT_EVENT_COMMUNITY;
  const raw = eventCommunity(scope) as Partial<EventCommunityConfig> | null | undefined;
  const retention: EventCommunityRetention =
    typeof raw?.directMessageRetention === "string" && (EVENT_COMMUNITY_RETENTIONS as readonly string[]).includes(raw.directMessageRetention)
      ? raw.directMessageRetention : base.directMessageRetention;
  return {
    workShowcase: raw?.workShowcase === true,
    peerFeedback: raw?.peerFeedback === true,
    peerReview: raw?.peerReview === true,
    peerReviewScale: raw?.peerReviewScale ?? base.peerReviewScale,
    peerReviewDimensions: Array.isArray(raw?.peerReviewDimensions) ? raw.peerReviewDimensions : [],
    peerReviewPassRate: typeof raw?.peerReviewPassRate === "number" && Number.isFinite(raw.peerReviewPassRate) ? raw.peerReviewPassRate : base.peerReviewPassRate,
    commentMaxLength: typeof raw?.commentMaxLength === "number" && Number.isSafeInteger(raw.commentMaxLength) && raw.commentMaxLength > 0 ? raw.commentMaxLength : base.commentMaxLength,
    participantDirectory: raw?.participantDirectory === true,
    connections: raw?.connections === true,
    directMessages: raw?.directMessages === true,
    directMessageRetention: retention,
    directMessagePurgeDays: typeof raw?.directMessagePurgeDays === "number" && Number.isSafeInteger(raw.directMessagePurgeDays) && raw.directMessagePurgeDays > 0 ? raw.directMessagePurgeDays : null,
  };
}

/** 有效清理天数：只有 retention=purge 且天数为正整数才生效；否则**不清理**（不猜一个默认天数）。 */
export function purgeDaysOf(config: EventCommunityConfig): number | null {
  return config.directMessageRetention === "purge" && typeof config.directMessagePurgeDays === "number"
    && Number.isSafeInteger(config.directMessagePurgeDays) && config.directMessagePurgeDays > 0
    ? config.directMessagePurgeDays : null;
}

/* ---------- 门禁（顺序固定，逐层区分 403 原因） ---------- */

export type CommunityNeed = "connections" | "directMessages";

export interface CommunityGateInput {
  readonly status: HostedEventStatus;
  readonly config: EventCommunityConfig;
  readonly registrationStatus: EventRegistrationStatus | null;
}

export type CommunityGateResult = { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string; readonly status: number };

export function communityGate(input: CommunityGateInput, need: CommunityNeed): CommunityGateResult {
  if (!input.config.connections) {
    return { ok: false, code: "COMMUNITY_DISABLED", message: "本场主办方没有开启选手社区；连接与私信都不可用，也不会返回任何空列表冒充可用。", status: 403 };
  }
  if (need === "directMessages" && !input.config.directMessages) {
    return { ok: false, code: "COMMUNITY_DIRECT_MESSAGES_DISABLED", message: "本场主办方没有开启私信；连接仍然可用，但现在不能发送消息。", status: 403 };
  }
  if (input.status === "draft") {
    return { ok: false, code: "COMMUNITY_EVENT_NOT_OPEN", message: "这场比赛还没有正式发布，选手社区暂不可用。", status: 403 };
  }
  if (input.registrationStatus !== "approved") {
    return { ok: false, code: "COMMUNITY_PARTICIPANT_REQUIRED", message: "选手社区只对本场报名已通过的参赛者开放；不接受访客或非本场参赛者。", status: 403 };
  }
  return { ok: true };
}

/* ---------- 输入校验 ---------- */

export function communityText(value: unknown, label: string, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) invalid(`${label}格式不正确或过长。`);
  return value.trim();
}

export function communityUserId(value: unknown, label = "账号"): string { return communityText(value, label, 160); }
export function communityRecordId(value: unknown, label: string): string { return communityText(value, label, 160); }
export function idempotencyKey(value: unknown): string { return communityText(value, "重试标识", 120); }

export function connectionDecision(value: unknown): "accept" | "reject" {
  if (value !== "accept" && value !== "reject") invalid("请明确选择接受或拒绝这条连接请求。");
  return value;
}

export function expectedRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid("预期版本必须是正整数。");
  return value;
}

export function messageContent(value: unknown, max = DIRECT_MESSAGE_MAX_LENGTH): string {
  if (typeof value !== "string") invalid("请填写消息内容。");
  const trimmed = value.trim();
  if (!trimmed) invalid("消息内容不能为空。");
  if (trimmed.length > max) invalid(`单条消息最多 ${max} 个字符，请缩短后继续。`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(trimmed)) invalid("消息内容包含不支持的控制字符。");
  return trimmed;
}

export function reportReason(value: unknown): CommunityReportReason {
  if (typeof value !== "string" || !(COMMUNITY_REPORT_REASONS as readonly string[]).includes(value)) invalid("请选择举报原因。");
  return value as CommunityReportReason;
}

export function reportDetail(value: unknown): string { return communityText(value, "举报说明", 1000, true); }

export const reportReasonLabels: Readonly<Record<CommunityReportReason, string>> = {
  harassment: "骚扰或人身攻击",
  spam: "垃圾信息或刷屏",
  contact_touting: "索取或兜售联系方式",
  impersonation: "冒充他人",
  other: "其他",
};

/* ---------- 派生：账号对 / 冷却 / 上限 / 限频 / 可见性 ---------- */

/** 同一对账号在本场只有一个键；`\u001f` 是单元分隔符，不会出现在正常 ID 里。 */
export function communityPairKey(left: EntityId, right: EntityId): string {
  return left < right ? `${left}\u001f${right}` : `${right}\u001f${left}`;
}

export function rejectionCooldownUntil(rejectedAt: Instant | null, days = CONNECTION_REJECT_COOLDOWN_DAYS): string | null {
  if (!rejectedAt) return null;
  const at = Date.parse(rejectedAt);
  if (!Number.isFinite(at)) return null;
  return new Date(at + days * DAY_MS).toISOString();
}

export function inRejectionCooldown(rejectedAt: Instant | null, nowMs: number, days = CONNECTION_REJECT_COOLDOWN_DAYS): boolean {
  const until = rejectionCooldownUntil(rejectedAt, days);
  return until !== null && Date.parse(until) > nowMs;
}

export function pendingRequestsFor(connections: readonly EventConnection[], userId: EntityId): readonly EventConnection[] {
  return connections.filter(connection => connection.status === "pending"
    && (connection.requesterUserId === userId || connection.addresseeUserId === userId));
}

export function rateLimited(used: number, limit = DIRECT_MESSAGE_RATE_LIMIT): boolean { return used >= limit; }
export function rateRemaining(used: number, limit = DIRECT_MESSAGE_RATE_LIMIT): number { return Math.max(0, limit - used); }

export type MessageVisibilityReason = "visible" | "withdrawn" | "purged";
export interface MessageVisibility { readonly content: string | null; readonly reason: MessageVisibilityReason }

/** 撤回与到期清理都在读取时生效：即使后台维护还没跑，过期正文也不会被返回。 */
export function messageVisibility(
  message: Pick<DirectMessage, "content" | "status" | "createdAt">,
  config: EventCommunityConfig,
  nowMs: number,
): MessageVisibility {
  if (message.status === "withdrawn") return { content: null, reason: "withdrawn" };
  if (message.status === "purged") return { content: null, reason: "purged" };
  const days = purgeDaysOf(config);
  if (days !== null) {
    const at = Date.parse(message.createdAt);
    if (Number.isFinite(at) && nowMs - at > days * DAY_MS) return { content: null, reason: "purged" };
  }
  return { content: message.content, reason: "visible" };
}

export function directMessageView(message: DirectMessage, viewerUserId: EntityId, config: EventCommunityConfig, nowMs: number): DirectMessageView {
  const visibility = messageVisibility(message, config, nowMs);
  const mine = message.senderUserId === viewerUserId;
  const display = visibility.reason === "withdrawn"
    ? (mine ? "你撤回了一条消息。" : "对方撤回了一条消息。")
    : visibility.reason === "purged"
      ? "内容已按本场保留口径清理，仅保留可追溯的最小事实。"
      : (visibility.content ?? "");
  return {
    id: message.id, senderUserId: message.senderUserId, recipientUserId: message.recipientUserId, mine,
    createdAt: message.createdAt, status: message.status, revision: message.revision,
    content: visibility.content, withdrawn: visibility.reason === "withdrawn", purged: visibility.reason === "purged", display,
  };
}

/**
 * 举报快照：只复制**最近 N 条**的最小事实。
 * 保留口径为 purge 时**不复制任何正文**（清理口径不能被举报记录绕过）；撤回/已清理的消息也只留事实。
 */
export function reportSnapshot(
  messages: readonly DirectMessage[],
  config: EventCommunityConfig,
  nowMs: number,
  limit = REPORT_SNAPSHOT_LIMIT,
): readonly ReportSnapshotEntry[] {
  const ordered = [...messages].sort((left, right) =>
    left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return ordered.slice(Math.max(0, ordered.length - limit)).map(message => {
    const visibility = messageVisibility(message, config, nowMs);
    const content = config.directMessageRetention !== "purge" && visibility.reason === "visible" ? visibility.content : null;
    return { messageId: message.id, senderUserId: message.senderUserId, recipientUserId: message.recipientUserId, createdAt: message.createdAt, status: message.status, content };
  });
}

export function communityLimits(pendingUsed: number, rateUsed: number): CommunityLimits & { rateRemaining: number } {
  return {
    pendingLimit: CONNECTION_PENDING_LIMIT,
    pendingRemaining: Math.max(0, CONNECTION_PENDING_LIMIT - pendingUsed),
    rejectCooldownDays: CONNECTION_REJECT_COOLDOWN_DAYS,
    messageMaxLength: DIRECT_MESSAGE_MAX_LENGTH,
    messageRateMax: DIRECT_MESSAGE_RATE_LIMIT,
    messageRateWindowSeconds: Math.round(DIRECT_MESSAGE_RATE_WINDOW_MS / 1000),
    rateRemaining: rateRemaining(rateUsed),
  };
}

export function conversationView(input: {
  readonly eventId: EntityId;
  readonly connection: EventConnection;
  readonly peerUserId: EntityId;
  readonly viewerUserId: EntityId;
  readonly config: EventCommunityConfig;
  readonly messages: readonly DirectMessage[];
  readonly blocked: boolean;
  readonly nowMs: number;
  readonly rateUsed: number;
}): ConversationView {
  const messagesEnabled = input.config.directMessages;
  const canSend = messagesEnabled && !input.blocked;
  return {
    eventId: input.eventId,
    peerUserId: input.peerUserId,
    connectionId: input.connection.id,
    connectedAt: input.connection.respondedAt ?? input.connection.requestedAt,
    messagesEnabled,
    blocked: input.blocked,
    canSend,
    sendBlockedReason: canSend ? null
      : input.blocked ? blockSilenceReason
        : "本场主办方没有开启私信；既有消息按保留口径只读，现在不能发送新消息。",
    retention: input.config.directMessageRetention,
    retentionNotice: retentionNotice(input.config),
    messages: input.messages.map(message => directMessageView(message, input.viewerUserId, input.config, input.nowMs)),
    limits: communityLimits(0, input.rateUsed),
    notices: communityNotices(),
  };
}

function connectionSorted<T extends { id: string }>(rows: readonly T[]): readonly T[] {
  return [...rows].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** 待处理请求：只给本人相关的那一侧。 */
export function incomingRequests(connections: readonly EventConnection[], userId: EntityId) {
  return connectionSorted(connections.filter(connection => connection.status === "pending" && connection.addresseeUserId === userId))
    .map(connection => ({ id: connection.id, peerUserId: connection.requesterUserId, requestedAt: connection.requestedAt, revision: connection.revision }));
}

export function outgoingRequests(connections: readonly EventConnection[], userId: EntityId) {
  return connectionSorted(connections.filter(connection => connection.status === "pending" && connection.requesterUserId === userId))
    .map(connection => ({ id: connection.id, peerUserId: connection.addresseeUserId, requestedAt: connection.requestedAt, revision: connection.revision }));
}

export function acceptedConnections(connections: readonly EventConnection[], userId: EntityId) {
  return connectionSorted(connections.filter(connection => connection.status === "accepted"
    && (connection.requesterUserId === userId || connection.addresseeUserId === userId)))
    .map(connection => ({
      id: connection.id,
      peerUserId: connection.requesterUserId === userId ? connection.addresseeUserId : connection.requesterUserId,
      connectedAt: connection.respondedAt ?? connection.requestedAt,
      revision: connection.revision,
      blocked: false,
    }));
}

export function connectionStatusLabel(status: ConnectionStatus): string {
  return status === "pending" ? "等待回应" : status === "accepted" ? "已连接" : status === "rejected" ? "已拒绝" : "已取消";
}

/* ---------- 界面必须逐字展示的安全口径 ---------- */

export const communityDefaultOffNotice =
  "本场主办方没有开启选手社区。连接与私信都不可用：接口会明确返回 403，而不是一个空列表。";

export const connectionMutualNotice =
  "连接必须双方同意：你先发起「想认识」，对方接受后才形成连接。我们不提供服务方定义的单向关注，也没有粉丝、关注列表或跨赛事社交图谱。";

export const directMessageSafetyNotice =
  "私信只在双方已接受的连接内可用。你可以随时屏蔽或举报对方；举报只记录事实与最近消息快照，交平台与主办方按既有权限处理。";

export const noAutoContactNotice =
  "平台不会补全、代办或公开你的邮箱、电话等联系方式；是否交换联系方式由你们在消息里自行决定。";

export const ageVerificationNotice =
  "平台不声称提供年龄核验或未成年人保护；因此私信默认关闭，需要你本人在每场比赛中自行开启。";

export const trainingBoundaryNotice =
  "消息内容不会进入任何模型训练（宪法 XII）；本功能不调用任何 AI，也不会用聊天内容生成推荐或评分。";

export const reportNotice =
  "举报只记录事实与最近消息快照，交平台与主办方按既有权限处理；本模块不自行裁决，不自动隐藏内容，也不改任何评分、名次或报名状态。";

export const blockNotice =
  "屏蔽后对方不能向你发起连接，也不能给你发消息；屏蔽只在本场生效，本模块不做跨赛事社交图谱，解除屏蔽也不会撤销已记录的事实。";

export const blockSilenceReason = "你们之间存在屏蔽，不能互相发消息。";

export const communityLimitations: readonly string[] = [
  "只对本场报名已通过的参赛者开放；访客、非本场参赛者和报名未通过的人一律 403。",
  "连接与屏蔽只在本场生效，不跨赛事、不跨机构；本模块不做跨赛事社交图谱。",
  "本场参赛名录复用既有参赛名片（P1 只读投影），本模块不另建第二份名录或资料。",
  "平台不补全或公开邮箱、电话，也不声称提供年龄核验或未成年人保护。",
  "消息内容不进入任何模型训练，本模块不调用任何 AI。",
  "通知只走既有通知写入路径；未注入时只记录站内事实，并明确说明通知未发送。",
];

export function retentionNotice(config: EventCommunityConfig): string {
  if (config.directMessageRetention === "keep") {
    return "本场保留口径：保留可读。主办方关闭能力后不再产生新数据，既有连接与消息仍可读。";
  }
  if (config.directMessageRetention === "purge") {
    const days = purgeDaysOf(config);
    return days === null
      ? "本场保留口径登记为到期清理，但没有设置有效天数，因此暂不清理任何消息正文；只有设置了 1 天以上的整数才会按天清理。"
      : `本场保留口径：到期清理（${days} 天）。超过 ${days} 天的消息正文会被清理，只保留可追溯的最小事实（谁、何时、哪条连接、消息状态），清理后双方都看不到正文。`;
  }
  return "本场保留口径：冻结只读（默认）。主办方关闭能力后不再产生新数据，既有连接与消息保持只读，不会被自动清理。";
}

export function communityNotices(): CommunityNotices {
  return {
    defaultOff: communityDefaultOffNotice,
    mutual: connectionMutualNotice,
    safety: `${directMessageSafetyNotice}${noAutoContactNotice}`,
    age: ageVerificationNotice,
    training: trainingBoundaryNotice,
    report: reportNotice,
    block: blockNotice,
  };
}

export function communityCapabilities(config: EventCommunityConfig) {
  return {
    directory: config.participantDirectory,
    connections: config.connections,
    directMessages: config.directMessages,
    retention: config.directMessageRetention,
    purgeDays: purgeDaysOf(config),
    retentionNotice: retentionNotice(config),
  };
}

export const organizerReportsNotice =
  "本页只列出被举报的连接在举报时刻的快照与最小事实；主办方没有读取任意私信的通道，本模块不自行裁决，也不改任何评分、名次或报名状态。";

export const organizerReportsLimitations: readonly string[] = [
  "只含被举报的那条连接在举报时刻复制的最近消息；未被举报的对话不会出现在这里。",
  "举报状态恒为 open：处理发生在既有平台/主办方流程里，本模块不记录裁决结果、不新增审批状态。",
  "保留口径为「到期清理」时不复制任何正文，只保留消息最小事实。",
];
