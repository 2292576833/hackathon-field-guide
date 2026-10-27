import { createHash, randomBytes } from "node:crypto";
import type { EntityId, Instant } from "../../shared/contracts.ts";
import type { EventStaffCapability } from "../../shared/organizer-contracts.ts";
import type { StaffGrant, StaffInvitation, StaffInvitationStatus } from "./model.ts";

/**
 * P3 工作人员受限邀请的纯逻辑（无 IO、无 DB、无队列）。
 *
 * 安全边界（宪法 XIII）：
 * - 只保存 `sha256(token)`；原文 token 只由 `mintInvitationToken()` 产出一次。
 * - 视图由**显式字段**构造，绝不展开 `StaffInvitation`（它带 `tokenHash`）。
 * - 状态机 `open → claimed | revoked | expired`：`expired` 由 `expiresAt` 派生，
 *   不落库、不依赖后台任务，因此不存在"过期列没来得及改"的第二份事实。
 */
const TOKEN_BYTES = 32;
/** 32 字节随机数的 base64url 形态固定为 43 个 [A-Za-z0-9_-] 字符。 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DAY_MS = 86_400_000;

/** 只在创建时调用一次；调用方 MUST NOT 记录或回传除创建响应以外的副本。 */
export function mintInvitationToken(): string { return randomBytes(TOKEN_BYTES).toString("base64url"); }
/** 路由里的 token 先按格式筛掉，避免任意长字符串进入哈希路径；不合法一律按"未找到"处理。 */
export function isInvitationToken(value: unknown): value is string { return typeof value === "string" && TOKEN_PATTERN.test(value); }
/** 与库内 `token_hash` 相同的算法：sha256 十六进制小写。 */
export function hashInvitationToken(token: string): string { return createHash("sha256").update(token, "utf8").digest("hex"); }
export function invitationExpiresAt(now: Instant, days: number): Instant { return new Date(Date.parse(now) + days * DAY_MS).toISOString(); }
/** `expired` 只在 `open` 且已到期时成立；已领取/已撤销永远保持各自结论（保留领取人与时间）。 */
export function invitationStatus(invitation: Pick<StaffInvitation, "status" | "expiresAt">, now: Instant): StaffInvitationStatus {
  if (invitation.status !== "open") return invitation.status;
  return Date.parse(invitation.expiresAt) <= Date.parse(now) ? "expired" : "open";
}
export function invitationIsClaimable(invitation: Pick<StaffInvitation, "status" | "expiresAt">, now: Instant): boolean {
  return invitationStatus(invitation, now) === "open";
}
/** 只用于向持链接者展示"绑定邮箱长什么样"，不构成对绑定邮箱的验证。 */
export function maskEmail(email: string): string {
  const separator = email.lastIndexOf("@");
  if (separator <= 0 || separator === email.length - 1) return "***";
  const local = email.slice(0, separator), domain = email.slice(separator + 1);
  return `${local.slice(0, 1)}${"*".repeat(Math.max(2, Math.min(6, local.length)))}@${domain}`;
}

/** 机构管理员视图（列表与创建响应）：包含"谁、何时、领取了哪些能力"，**不含** token 与 tokenHash。 */
export interface StaffInvitationView {
  readonly id: EntityId; readonly organizationId: EntityId; readonly organizationName: string;
  readonly eventId: EntityId | null; readonly eventTitle: string | null;
  readonly role: StaffGrant["role"]; readonly capabilities: readonly EventStaffCapability[];
  readonly status: StaffInvitationStatus; readonly expiresAt: Instant;
  readonly emailBound: boolean; readonly boundEmailMasked: string | null;
  readonly claimedByUserId: EntityId | null; readonly claimedAt: Instant | null;
  readonly createdByUserId: EntityId; readonly createdAt: Instant;
  readonly revokedAt: Instant | null; readonly revokedByUserId: EntityId | null;
  readonly note: string; readonly revision: number; readonly claimable: boolean;
}
/** 领取页预览：只描述"这家机构 / 这场比赛 / 这些能力 / 这个角色 / 有效期"，不泄露邀请人标识与备注。 */
export interface StaffInvitationPreview {
  readonly organizationName: string; readonly eventTitle: string | null;
  readonly role: StaffGrant["role"]; readonly capabilities: readonly EventStaffCapability[];
  readonly status: StaffInvitationStatus; readonly expiresAt: Instant;
  readonly emailBound: boolean; readonly boundEmailMasked: string | null;
  readonly claimable: boolean;
}
export interface InvitationViewContext { readonly now: Instant; readonly organizationName: string; readonly eventTitle: string | null }
export interface CreateStaffInvitationResult { readonly invitation: StaffInvitationView; readonly token: string }
export interface ClaimStaffInvitationResult { readonly invitation: StaffInvitationPreview; readonly grant: StaffGrant }

function maskedBoundEmail(invitation: StaffInvitation): string | null { return invitation.boundEmail ? maskEmail(invitation.boundEmail) : null; }

/** 显式构造，绝不 `{...invitation}`：tokenHash 因而无法随视图泄露。 */
export function toInvitationView(invitation: StaffInvitation, context: InvitationViewContext): StaffInvitationView {
  return {
    id: invitation.id, organizationId: invitation.organizationId, organizationName: context.organizationName,
    eventId: invitation.eventId, eventTitle: context.eventTitle,
    role: invitation.role, capabilities: [...invitation.capabilities],
    status: invitationStatus(invitation, context.now), expiresAt: invitation.expiresAt,
    emailBound: invitation.boundEmail !== null, boundEmailMasked: maskedBoundEmail(invitation),
    claimedByUserId: invitation.claimedByUserId, claimedAt: invitation.claimedAt,
    createdByUserId: invitation.createdByUserId, createdAt: invitation.createdAt,
    revokedAt: invitation.revokedAt, revokedByUserId: invitation.revokedByUserId,
    note: invitation.note, revision: invitation.revision, claimable: invitationIsClaimable(invitation, context.now),
  };
}
export function toInvitationPreview(invitation: StaffInvitation, context: InvitationViewContext): StaffInvitationPreview {
  return {
    organizationName: context.organizationName, eventTitle: context.eventTitle,
    role: invitation.role, capabilities: [...invitation.capabilities],
    status: invitationStatus(invitation, context.now), expiresAt: invitation.expiresAt,
    emailBound: invitation.boundEmail !== null, boundEmailMasked: maskedBoundEmail(invitation),
    claimable: invitationIsClaimable(invitation, context.now),
  };
}
/** 供测试与界面复核的固定名单：这些字段 MUST NOT 出现在任何邀请响应里。 */
export const INVITATION_SECRET_FIELDS = ["token","tokenHash"] as const;
