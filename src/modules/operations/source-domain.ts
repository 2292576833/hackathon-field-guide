import type { Actor, Instant } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { normalizeNetworkPolicy, normalizeSourceUrl, assertAllowedSourceUrl } from "./network-policy.ts";
import type { NetworkPolicy } from "./network-policy.ts";

export type SourceStatus = "proposed" | "verifying" | "enabled" | "rejected" | "paused" | "degraded";
export interface SourceVerification {
  readonly verifiedBy: string;
  readonly verifiedAt: Instant;
  readonly termsUrl: string;
  readonly allowedUses: readonly string[];
  readonly minimumRetainedFields: readonly string[];
  readonly notes: string;
}
export interface SourceHealth {
  readonly nextEligibleAt: Instant | null;
  readonly lastSuccessAt: Instant | null;
  readonly lastFailureAt: Instant | null;
  readonly consecutiveFailures: number;
}
export interface SourceConfig {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly ownerUserId: string;
  readonly type: "official_event" | "official_rules";
  readonly acquisitionMethod: "restricted_http" | "isolated_adapter";
  readonly credentialPolicy: "none";
  readonly sampleUrl: string;
  readonly networkPolicy: NetworkPolicy;
  readonly minimumIntervalSeconds: number;
  readonly status: SourceStatus;
  readonly verification: SourceVerification | null;
  readonly health: SourceHealth;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}
export interface SourceDraft {
  readonly name: string;
  readonly ownerUserId: string;
  readonly type: SourceConfig["type"];
  readonly acquisitionMethod: SourceConfig["acquisitionMethod"];
  readonly sampleUrl: string;
  readonly networkPolicy: NetworkPolicy;
  readonly minimumIntervalSeconds?: number;
}
export interface ExecutionAudit {
  readonly id: string;
  readonly actorKind: "user" | "worker";
  readonly actorId: string;
  readonly action: string;
  readonly entityId: string;
  readonly revision: number;
  readonly reason: string;
  readonly occurredAt: Instant;
}

export function requireOperationsReader(actor: Actor): void {
  if (!actor.platformRoles.some((role) => role === "reviewer" || role === "admin")) throw new DomainError("OPERATIONS_FORBIDDEN", "需要公开内容运营权限。", { status: 403 });
}
export function requireOperationsAdmin(actor: Actor): void {
  if (!actor.platformRoles.includes("admin")) throw new DomainError("SOURCE_ADMIN_REQUIRED", "来源与任务配置需要管理员权限。", { status: 403 });
}
export function requireText(value: string, field: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new DomainError("INVALID_OPERATIONS_INPUT", `${field}缺失或格式不正确。`);
  return value.trim();
}
export function assertExpectedRevision(actual: number, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected !== actual) throw new DomainError("VERSION_CONFLICT", "记录已更新，请查看最新版本后再操作。", { status: 409, recoveryAction: "review_latest_version", latestRevision: actual });
}
export function normalizeSourceDraft(input: SourceDraft): Required<SourceDraft> {
  const minimumIntervalSeconds = input.minimumIntervalSeconds ?? 86_400;
  if (!Number.isInteger(minimumIntervalSeconds) || minimumIntervalSeconds < 300 || minimumIntervalSeconds > 2_592_000 ||
      !["official_event", "official_rules"].includes(input.type) || !["restricted_http", "isolated_adapter"].includes(input.acquisitionMethod)) throw new DomainError("INVALID_SOURCE_CONFIG", "来源类型、获取方式或频率不正确。");
  const networkPolicy = normalizeNetworkPolicy(input.networkPolicy);
  const sampleUrl = assertAllowedSourceUrl(input.sampleUrl, networkPolicy);
  return { name: requireText(input.name, "来源名称", 120), ownerUserId: requireText(input.ownerUserId, "来源负责人", 120), type: input.type, acquisitionMethod: input.acquisitionMethod, sampleUrl, networkPolicy, minimumIntervalSeconds };
}
export function normalizeVerification(input: Omit<SourceVerification, "verifiedAt" | "verifiedBy">, actor: Actor, now: Instant): SourceVerification {
  if (!Array.isArray(input.allowedUses) || !input.allowedUses.length || input.allowedUses.length > 20 || !Array.isArray(input.minimumRetainedFields) || !input.minimumRetainedFields.length || input.minimumRetainedFields.length > 30) throw new DomainError("SOURCE_VERIFICATION_REQUIRED", "启用前需记录允许用途与最少保留字段。");
  return { verifiedBy: actor.userId, verifiedAt: now, termsUrl: normalizeSourceUrl(input.termsUrl), allowedUses: input.allowedUses.map((text) => requireText(text, "允许用途", 200)), minimumRetainedFields: input.minimumRetainedFields.map((text) => requireText(text, "保留字段", 100)), notes: requireText(input.notes, "验证说明", 1000) };
}
export const sourceTransitions: Readonly<Record<SourceStatus, readonly SourceStatus[]>> = {
  proposed: ["verifying", "rejected"], verifying: ["enabled", "rejected", "paused"],
  enabled: ["paused", "degraded", "verifying"], rejected: ["verifying"],
  paused: ["enabled", "verifying", "rejected"], degraded: ["enabled", "paused", "verifying"],
};
