import type { EntityId, Instant } from "../../shared/contracts.ts";
import type { EventCommunityConfig, EventModuleFlags, EventStaffCapability, HostedEventScope } from "../../shared/organizer-contracts.ts";

export type OrganizationKind = "school" | "company" | "community";
export type OrganizationStatus = "pending" | "approved" | "rejected" | "suspended";
export type EventTemplateKey = "online" | "onsite" | "practice";
/** 认领已发现赛事时的归属核实方式（规划25 第12节）。 */
export const CLAIM_VERIFICATIONS = ["official_domain_mailbox","official_statement","authorized_document","platform_source_page","other"] as const;
export type ClaimVerification = (typeof CLAIM_VERIFICATIONS)[number];
export type ClaimStatus = "pending" | "approved" | "rejected" | "withdrawn";
/** 候选只作提示：matchReason 说明为什么把它列为候选，本身不构成归属或授权。 */
export type ClaimMatchReason = "source_host" | "name_conflict" | "manual_pick";
export interface OrganizerClaimCandidate {
  readonly discoveryId: EntityId; readonly title: string; readonly sourceUrl: string; readonly sourceHost: string;
  readonly analyzedAt: Instant | null; readonly matchReason: ClaimMatchReason;
}
export interface ClaimCandidateInput { readonly discoveryId: EntityId; readonly verification: ClaimVerification;
  readonly evidenceText: string; readonly evidenceUrls: readonly string[]; }
export interface ReviewClaimInput { readonly decision: "approved" | "rejected"; readonly note: string; readonly expectedRevision: number }
/** 待补字段清单（P03）：派生视图，不落完成状态、不落百分比。 */
export const READINESS_FIELDS = ["registrationClosesAt","registrationOpensAt","startsAt","endsAt","timezone","tracks","requiredMaterials","submissionMethod","resultsAt","fee","eligibility","aiPolicy"] as const;
export type ReadinessField = (typeof READINESS_FIELDS)[number];
export type ReadinessState = "known_from_organizer" | "known_from_source" | "missing" | "conflicting";
export interface EventReadinessItem {
  readonly field: ReadinessField;
  readonly state: ReadinessState;
  /** 主办方已确认的值（时间类来自 HostedEvent，其余来自赛事补充资料）；无则为 null。 */
  readonly organizerValue: string | null;
  /** 赛事补充资料的当前版本；PATCH 用它做并发校验。 */
  readonly revision: number;
  /** 抓取到的原文片段（可能为空）；只是线索，不是主办方声明。 */
  readonly sourceEvidence: readonly string[];
  readonly sourceUrl: string | null;
  readonly checkedAt: Instant | null;
  /** 对选手决策的影响程度：1 最需要先补（报名截止）。 */
  readonly priority: 1 | 2 | 3;
}
export interface EventReadinessInput { readonly eventId: EntityId; readonly field: ReadinessField; readonly value: string | null }
/**
 * 赛事补充资料（P03）：只保存 HostedEvent 之外、选手关心的信息。
 * 不替代 HostedEvent 的时间与规则字段；两者冲突时由人决定，不自动覆盖。
 */
export interface EventProfile {
  readonly eventId: EntityId; readonly organizationId: EntityId; readonly revision: number;
  readonly values: Partial<Record<ReadinessField, string>>;
  readonly updatedBy: EntityId; readonly updatedAt: Instant;
}
export interface OrganizerClaimRequest {
  readonly id: EntityId; readonly organizationId: EntityId; readonly discoveryId: EntityId;
  readonly sourceHost: string; readonly requestedBy: EntityId;
  readonly verification: ClaimVerification; readonly evidenceText: string; readonly evidenceUrls: readonly string[];
  readonly status: ClaimStatus; readonly hostedEventId: EntityId | null;
  readonly reviewedBy: EntityId | null; readonly reviewedAt: Instant | null; readonly reviewNote: string | null;
  readonly revision: number; readonly createdAt: Instant; readonly updatedAt: Instant;
}
export interface OrganizationApplication {
  readonly id: EntityId; readonly organizationId: EntityId; readonly applicantUserId: EntityId;
  readonly name: string; readonly kind: OrganizationKind; readonly description: string;
  readonly contactName: string; readonly contactEmail: string; readonly evidenceText: string; readonly evidenceUrls: readonly string[];
  readonly status: OrganizationStatus; readonly revision: number; readonly reviewNote: string | null;
  readonly createdAt: Instant; readonly updatedAt: Instant;
}
export interface Organization {
  readonly id: EntityId; readonly name: string; readonly kind: OrganizationKind; readonly description: string;
  readonly ownerUserId: EntityId; readonly status: OrganizationStatus; readonly revision: number;
  readonly createdAt: Instant; readonly updatedAt: Instant;
}
export interface StaffGrant {
  readonly id: EntityId; readonly organizationId: EntityId; readonly eventId: EntityId | null; readonly userId: EntityId;
  readonly role: "organization_admin" | "staff"; readonly capabilities: readonly EventStaffCapability[];
  readonly status: "active" | "revoked"; readonly revision: number; readonly createdAt: Instant; readonly revokedAt: Instant | null;
}
/**
 * P3 工作人员受限邀请（宪法 XIII「工作人员受限邀请」）。
 *
 * 只存 `token_hash`（sha256 十六进制），原文 token 只在创建响应里返回一次；
 * `status` 只落 `open|claimed|revoked`，`expired` 由 `expiresAt` 在读取时派生
 * （避免"过期状态列"与真实时间漂移成第二份事实）。邀请本身**不是**权限事实：
 * 只有领取时经既有 `writeStaffGrant` 写入的 `StaffGrant` 才被权限判定读取。
 */
export const STAFF_INVITATION_STATUSES = ["open","claimed","revoked","expired"] as const;
export type StaffInvitationStatus = (typeof STAFF_INVITATION_STATUSES)[number];
export const DEFAULT_INVITATION_DAYS = 7;
export const MIN_INVITATION_DAYS = 1;
export const MAX_INVITATION_DAYS = 30;
export interface StaffInvitation {
  readonly id: EntityId;
  readonly organizationId: EntityId;
  /** null 表示本组织全部比赛；非 null 时只对这一场生效。 */
  readonly eventId: EntityId | null;
  readonly role: StaffGrant["role"];
  readonly capabilities: readonly EventStaffCapability[];
  /** 迁移只允许 open/claimed/revoked；expired 是派生状态，不落库。 */
  readonly status: "open" | "claimed" | "revoked";
  /** sha256(token) 十六进制；原文 token 不落库、不进任何视图。 */
  readonly tokenHash: string;
  /** 绑定邮箱（已转小写）或 null（不绑定）。 */
  readonly boundEmail: string | null;
  readonly expiresAt: Instant;
  readonly claimedByUserId: EntityId | null;
  readonly claimedAt: Instant | null;
  readonly createdByUserId: EntityId;
  readonly createdAt: Instant;
  readonly revokedAt: Instant | null;
  readonly revokedByUserId: EntityId | null;
  /** 邀请人写给领取人的备注；列表可见，领取预览不返回。 */
  readonly note: string;
  readonly revision: number;
}
export interface CreateStaffInvitationInput {
  readonly role: StaffGrant["role"];
  readonly capabilities: readonly EventStaffCapability[];
  readonly eventId: EntityId | null;
  readonly expiresInDays: number;
  readonly boundEmail: string | null;
  readonly note: string;
}
export interface HostedEvent extends HostedEventScope {
  readonly templateKey: EventTemplateKey; readonly templateVersion: 1; readonly format: "online" | "onsite";
  readonly summary: string; readonly rules: string; readonly location: string; readonly responsibleUserId: EntityId;
  readonly createdAt: Instant; readonly updatedAt: Instant;
}
export interface PublicCompetition {
  readonly organizationId: EntityId; readonly organizationName: string; readonly eventId: EntityId;
  readonly title: string; readonly status: "published" | "ended" | "archived"; readonly publishedRevision: number;
  readonly organizationStatus: "approved" | "suspended" | "rejected" | "pending";
  readonly availability: "available" | "organization_unavailable";
  readonly timezone: string; readonly startsAt: Instant; readonly endsAt: Instant;
  readonly registrationOpensAt: Instant | null; readonly registrationClosesAt: Instant | null; readonly submissionClosesAt: Instant | null;
  readonly modules: EventModuleFlags; readonly summary: string; readonly rules: string; readonly location: string;
  readonly format: "online" | "onsite"; readonly changeSummary: string; readonly publishedAt: Instant;
}
export interface PublishedEventRevision {
  readonly eventId: EntityId; readonly version: number; readonly sourceRevision: number; readonly snapshot: HostedEvent;
  readonly changeSummary: string; readonly publishedAt: Instant; readonly publishedBy: EntityId;
}
export interface EventTemplate {
  readonly key: EventTemplateKey; readonly version: 1; readonly name: string; readonly description: string;
  readonly format: "online" | "onsite"; readonly timezone: string; readonly modules: EventModuleFlags;
  readonly registration: HostedEventScope["registration"]; readonly teams: HostedEventScope["teams"];
}
export interface CreateApplicationInput {
  readonly name: string; readonly kind: OrganizationKind; readonly description: string; readonly contactName: string;
  readonly contactEmail: string; readonly evidenceText: string; readonly evidenceUrls?: readonly string[];
}
export interface ReviewApplicationInput { readonly expectedRevision: number; readonly decision: "approved" | "rejected" | "suspended"; readonly note: string }
export interface EventConfigurationInput {
  readonly title: string; readonly timezone: string; readonly startsAt: Instant; readonly endsAt: Instant;
  readonly registrationOpensAt: Instant | null; readonly registrationClosesAt: Instant | null; readonly submissionClosesAt: Instant | null;
  readonly modules: EventModuleFlags; readonly registration: HostedEventScope["registration"]; readonly teams: HostedEventScope["teams"];
  /** 赛事级「公开与社区」配置（宪法 XIII）；新建/保存时必填，默认全部关闭。 */
  readonly community: EventCommunityConfig;
  readonly summary: string; readonly rules: string; readonly location: string;
}
export interface CreateEventInput extends EventConfigurationInput { readonly templateKey: EventTemplateKey; readonly expectedOrganizationRevision: number }
export interface UpdateEventInput extends EventConfigurationInput { readonly expectedRevision: number }
export interface GrantStaffInput {
  readonly expectedOrganizationRevision: number; readonly userId: EntityId; readonly eventId: EntityId | null;
  readonly role: StaffGrant["role"]; readonly capabilities: readonly EventStaffCapability[];
}
export interface CompetitionIdentity { readonly event: HostedEvent; readonly capabilities: readonly EventStaffCapability[]; readonly organizationAdmin: boolean }
export interface EventPreview { readonly event: HostedEvent; readonly publicProjection: PublicCompetition; readonly publicationBlockers: readonly string[]; readonly changedFields: readonly string[] }
export interface PublicationChange {
  readonly id: EntityId; readonly eventId: EntityId; readonly organizationId: EntityId; readonly version: number;
  readonly changeSummary: string; readonly createdAt: Instant;
}
/**
 * P4 赛事级模块助手开关（规划34 §2.1 / §5.1；宪法 XIII）。
 *
 * **内部运营项**：即时生效、写既有 `organizer_audit_events`，**不随正式发布版本冻结**——因此
 * 不出现在 `EventConfigurationInput` / `CONFIGURATION_KEYS` / 预览 / 发布 / changedFields / 历史里。
 * `assistantKey` 的取值集合**不在这里**：它由根把 `module-assistants` 注册表经
 * `OrganizerServiceOptions.assistantKeys` 传进来，本模块不保存第二份注册表。
 * 表里没有行的键按**默认全开**（规划34 §5.1「各流程模块助手开关 | 默认全开」）。
 */
export interface EventAssistantSwitch {
  readonly eventId: EntityId;
  readonly organizationId: EntityId;
  readonly assistantKey: string;
  readonly enabled: boolean;
  readonly revision: number;
  readonly updatedByUserId: EntityId;
  readonly updatedAt: Instant;
}
/** 单个助手的当前开关；表里无行即默认 `enabled: true` / `revision: 0`。 */
export interface EventAssistantSwitchView {
  readonly assistantKey: string;
  readonly enabled: boolean;
  readonly revision: number;
}
/** 本场完整开关集：顺序按根传入的 `assistantKeys` 顺序（稳定、可核对）。 */
export interface EventAssistantSwitchesView {
  readonly eventId: EntityId;
  readonly switches: readonly EventAssistantSwitchView[];
}
export interface SetEventAssistantSwitchInput {
  readonly assistantKey: string;
  readonly enabled: boolean;
  /** 首次设置传 0；已存在时必须与当前 revision 一致（否则 409 冲突）。 */
  readonly expectedRevision: number;
}
