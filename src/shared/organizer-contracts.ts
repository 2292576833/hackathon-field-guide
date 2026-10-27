/** Organizer/event contracts owned by the coordinating session. */
import type { Actor, EntityId, Instant } from "./contracts.ts";
import type { SqlExecutor } from "./persistence.ts";

export const EVENT_MODULES = ["registration", "teams", "icebreaking", "judging", "schedule", "accommodation", "mealVouchers"] as const;
export type EventModuleKey = typeof EVENT_MODULES[number];
export type EventModuleFlags = Readonly<Record<EventModuleKey, boolean>>;
export const EVENT_STAFF_CAPABILITIES = ["event_manage", "registration_manage", "teams_manage", "communication_manage", "schedule_manage", "logistics_manage", "judging_manage"] as const;
export type EventStaffCapability = typeof EVENT_STAFF_CAPABILITIES[number];
export type HostedEventStatus = "draft" | "published" | "ended" | "archived";

/** 赛事级「公开与社区」配置（宪法 XIII）：与 `EventModuleFlags` 分开，默认全部关闭，随正式发布版本冻结。 */
export const EVENT_COMMUNITY_SCALES = ["1-5", "0-10", "yes-no"] as const;
export type EventCommunityScale = typeof EVENT_COMMUNITY_SCALES[number];
export const EVENT_COMMUNITY_RETENTIONS = ["keep", "freeze", "purge"] as const;
export type EventCommunityRetention = typeof EVENT_COMMUNITY_RETENTIONS[number];
export interface EventCommunityDimension { readonly id: string; readonly label: string }
export interface EventCommunityConfig {
  readonly workShowcase: boolean;
  readonly peerFeedback: boolean;
  readonly peerReview: boolean;
  readonly peerReviewScale: EventCommunityScale;
  readonly peerReviewDimensions: readonly EventCommunityDimension[];
  readonly peerReviewPassRate: number;
  readonly commentMaxLength: number;
  readonly participantDirectory: boolean;
  readonly connections: boolean;
  readonly directMessages: boolean;
  readonly directMessageRetention: EventCommunityRetention;
  readonly directMessagePurgeDays: number | null;
}
export const DEFAULT_EVENT_COMMUNITY: EventCommunityConfig = {
  workShowcase: false, peerFeedback: false, peerReview: false,
  peerReviewScale: "1-5", peerReviewDimensions: [], peerReviewPassRate: 0.3, commentMaxLength: 500,
  participantDirectory: false, connections: false, directMessages: false,
  directMessageRetention: "freeze", directMessagePurgeDays: null,
};
/** 读取赛事社区配置：旧文档没有该字段时按「全部关闭」处理，不报错、不默认开启。 */
export function eventCommunity(scope: { readonly community?: EventCommunityConfig } | null | undefined): EventCommunityConfig {
  return scope?.community ?? DEFAULT_EVENT_COMMUNITY;
}


/** Root supplies a current-account/session check; never construct from request JSON. */
export type OrganizerSessionGuard = (sql: SqlExecutor) => Promise<void>;
export interface OrganizerPrincipal {
  readonly actor: Actor;
  readonly guard: OrganizerSessionGuard;
}

export interface HostedEventScope {
  readonly organizationId: EntityId;
  readonly organizationName: string;
  readonly eventId: EntityId;
  readonly title: string;
  readonly status: HostedEventStatus;
  readonly revision: number;
  readonly publishedRevision: number | null;
  readonly timezone: string;
  readonly startsAt: Instant;
  readonly endsAt: Instant;
  readonly registrationOpensAt: Instant | null;
  readonly registrationClosesAt: Instant | null;
  readonly submissionClosesAt: Instant | null;
  readonly modules: EventModuleFlags;
  readonly registration: { readonly reviewRequired: boolean; readonly capacity: number | null };
  readonly teams: { readonly mode: "free" | "assigned" | "mixed"; readonly minSize: number; readonly maxSize: number; readonly locksAt: Instant | null };
  /** Explicit M03 mapping; never inferred from matching titles. */
  readonly linkedEventId: EntityId | null;
  /** 赛事级「公开与社区」配置（宪法 XIII）。旧文档缺该字段时按全关处理，用 `eventCommunity()` 读取。 */
  readonly community?: EventCommunityConfig;
}

export interface HostedEventAccessPort {
  getEvent(sql: SqlExecutor, eventId: EntityId, options?: { readonly forUpdate?: boolean }): Promise<HostedEventScope | null>;
  requireStaff(sql: SqlExecutor, actor: Actor, eventId: EntityId, capability: EventStaffCapability): Promise<HostedEventScope>;
}
export type EventRegistrationStatus = "draft" | "pending" | "approved" | "rejected" | "withdrawn";
export interface EventRegistrationSnapshot {
  readonly id: EntityId;
  readonly eventId: EntityId;
  readonly userId: EntityId;
  readonly status: EventRegistrationStatus;
  readonly revision: number;
}
export interface EventRosterTeamSnapshot {
  readonly id: EntityId;
  readonly eventId: EntityId;
  readonly organizationId: EntityId;
  readonly captainUserId: EntityId;
  readonly memberUserIds: readonly EntityId[];
  readonly revision: number;
  readonly status: "forming" | "locked" | "withdrawn";
  readonly projectId: EntityId | null;
  /** Derived from current accepted members' approved registrations. */
  readonly eligible: boolean;
}
export interface EventParticipationPort {
  getRegistration(sql: SqlExecutor, eventId: EntityId, userId: EntityId): Promise<EventRegistrationSnapshot | null>;
  getTeam(sql: SqlExecutor, eventId: EntityId, teamId: EntityId): Promise<EventRosterTeamSnapshot | null>;
}
export interface EventProjectLinkPort {
  confirmLink(sql: SqlExecutor, principal: OrganizerPrincipal, input: {
    readonly eventId: EntityId; readonly teamId: EntityId; readonly projectId: EntityId; readonly expectedProjectRevision: number;
  }): Promise<void>;
}
export interface VerifiedEventSubmissionPort {
  recordReceipt(sql: SqlExecutor, principal: OrganizerPrincipal, receipt: {
    readonly id: EntityId; readonly eventId: EntityId; readonly linkedEventId: EntityId;
    readonly teamId: EntityId; readonly projectId: EntityId; readonly stageId: EntityId;
    /** Full M03 confirmation key: eventId:rulesVersion:confirmationRevision. */
    readonly requirementsVersion: string; readonly submittedAt: Instant;
    readonly materialHash: string; readonly receiptUrl: string; readonly repositoryCommitSha: string | null;
  }): Promise<{ readonly submissionRecordId: EntityId }>;
}
export interface EventJudgeConflictPort {
  inspect(sql: SqlExecutor, input: { readonly eventId: EntityId; readonly teamId: EntityId; readonly judgeUserId: EntityId }): Promise<{
    readonly status: "clear" | "conflict" | "needs_review"; readonly reasons: readonly string[];
  }>;
}
export interface EventNotificationPort {
  enqueue(sql: SqlExecutor, input: {
    readonly eventId: EntityId; readonly announcementId: EntityId; readonly revision: number; readonly recipientUserIds: readonly EntityId[];
    /**
     * 通知来源类别；缺省按 `announcement`（既有公告路径，行为不变）。
     * 社区（连接/私信）复用**同一个** outbox 与同一套发信状态机，不建第二套通知。
     */
    readonly kind?: "announcement" | "selection" | "community";
    /** 触发这次通知的账号；仅 `community` 需要（outbox 的 `published_by`）。 */
    readonly actorUserId?: EntityId;
  }): Promise<{ readonly state: "queued" | "unconfigured"; readonly referenceId: EntityId | null }>;
}
