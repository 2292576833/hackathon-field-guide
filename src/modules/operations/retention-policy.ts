import { DomainError } from "../../shared/errors.ts";

export const TEMPORARY_RETENTION_KINDS = ["temporary_original_text", "temporary_preview"] as const;
export type TemporaryRetentionKind = typeof TEMPORARY_RETENTION_KINDS[number];
export const PERMANENT_RETENTION_KINDS = [
  "formal_rule_evidence", "immutable_project_snapshot", "review_record", "model_unknown_hold",
  "budget_ledger", "navigation_history", "immutable_ingestion_receipt",
] as const;
export type PermanentRetentionKind = typeof PERMANENT_RETENTION_KINDS[number];
export type RetentionArtifactKind = TemporaryRetentionKind | PermanentRetentionKind;
export type RetentionPolicyOrigin = "module_default_provisional" | "deployment_config";
export interface RetentionRule {
  readonly keepDays: number;
  /** Engineering default, not an assertion that production retention was approved. */
  readonly origin: RetentionPolicyOrigin;
}
export interface RetentionPolicy {
  readonly version: "temporary-retention-v1";
  readonly rules: Readonly<Record<TemporaryRetentionKind, RetentionRule>>;
  readonly permanentKinds: readonly PermanentRetentionKind[];
}
export interface RetentionPolicyConfiguration {
  readonly originalTextDays?: number;
  readonly previewDays?: number;
}
const DAY_MS = 86_400_000;
function rule(configured: number | undefined, fallback: number): RetentionRule {
  const keepDays = configured ?? fallback;
  if (!Number.isSafeInteger(keepDays) || keepDays < 1 || keepDays > 3650) {
    throw new DomainError("INVALID_RETENTION_POLICY", "临时内容保留天数须为 1 至 3650 的整数。");
  }
  return Object.freeze({ keepDays, origin: configured === undefined ? "module_default_provisional" : "deployment_config" });
}
/** Only isolated temporary payloads are eligible; durable evidence and history never expire here. */
export function createRetentionPolicy(config: RetentionPolicyConfiguration = {}): RetentionPolicy {
  return Object.freeze({ version: "temporary-retention-v1", rules: Object.freeze({
    temporary_original_text: rule(config.originalTextDays, 30), temporary_preview: rule(config.previewDays, 7),
  }), permanentKinds: Object.freeze([...PERMANENT_RETENTION_KINDS]) });
}
export function retentionPolicyFingerprint(policy: RetentionPolicy): string {
  return `${policy.version}:${policy.rules.temporary_original_text.keepDays}:${policy.rules.temporary_original_text.origin}:${policy.rules.temporary_preview.keepDays}:${policy.rules.temporary_preview.origin}`;
}
export function isTemporaryRetentionKind(kind: unknown): kind is TemporaryRetentionKind {
  return typeof kind === "string" && (TEMPORARY_RETENTION_KINDS as readonly string[]).includes(kind);
}
export function retentionCutoffs(policy: RetentionPolicy, at: Date): Readonly<Record<TemporaryRetentionKind, string>> {
  if (!Number.isFinite(at.getTime())) throw new DomainError("INVALID_RETENTION_TIME", "清理时间不正确。");
  return {
    temporary_original_text: new Date(at.getTime() - policy.rules.temporary_original_text.keepDays * DAY_MS).toISOString(),
    temporary_preview: new Date(at.getTime() - policy.rules.temporary_preview.keepDays * DAY_MS).toISOString(),
  };
}

/** Metadata projection only. Never attach body, preview text, URL, tokens, or private notes. */
export interface RetentionArtifact {
  readonly id: string;
  readonly sourceConfigId: string;
  readonly runId: string | null;
  readonly kind: RetentionArtifactKind;
  readonly revision: number;
  /** Original immutable creation time, not the most recent inspection/update time. */
  readonly createdAt: string;
  readonly byteLength: number;
  readonly adoptionState: "unadopted" | "adopted" | "unknown";
  readonly payloadState: "present" | "cleared" | "unknown";
}
export interface RetentionInspection {
  readonly artifact: RetentionArtifact;
  /** Includes candidate, formal evidence, project snapshots and other durable consumers. */
  readonly referenceState: "unreferenced" | "referenced" | "unknown";
  /** Any unknown, pending or unaccounted paid request is protected. */
  readonly modelRequestState: "clear" | "unknown_hold" | "unknown";
  /** Queued/retriable/in-progress users of the payload are active, not just leased runs. */
  readonly runState: "terminal" | "active" | "unknown";
}
export const RETENTION_REASONS = ["eligible", "permanent_record", "invalid_metadata", "not_expired",
  "already_cleared", "payload_unknown", "adopted", "adoption_unknown", "referenced", "references_unknown",
  "unknown_model_hold", "model_hold_unknown", "run_active", "run_state_unknown", "version_changed", "missing", "guard_changed"] as const;
export type RetentionReason = typeof RETENTION_REASONS[number];
export function isRetentionReason(value: unknown): value is RetentionReason {
  return typeof value === "string" && (RETENTION_REASONS as readonly string[]).includes(value);
}
export interface RetentionDecision {
  readonly artifactId: string;
  readonly sourceConfigId: string;
  readonly runId: string | null;
  readonly kind: RetentionArtifactKind;
  readonly revision: number;
  readonly createdAt: string;
  readonly byteLength: number;
  readonly expiresAt: string | null;
  readonly policyOrigin: RetentionPolicyOrigin | null;
  readonly action: "keep" | "clear_temporary_payload";
  readonly reason: RetentionReason;
}
export function isRetentionIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
}
export function isRetentionInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export function isValidRetentionArtifactMetadata(artifact: RetentionArtifact): boolean {
  return !!artifact && isRetentionIdentifier(artifact.id) && isRetentionIdentifier(artifact.sourceConfigId)
    && (artifact.runId === null || isRetentionIdentifier(artifact.runId))
    && Number.isSafeInteger(artifact.revision) && artifact.revision > 0
    && isRetentionInstant(artifact.createdAt) && Number.isSafeInteger(artifact.byteLength) && artifact.byteLength >= 0;
}
/** Fail closed whenever provenance, usage, relation coverage or hold state is incomplete. */
export function evaluateRetention(policy: RetentionPolicy, inspection: RetentionInspection, at: Date): RetentionDecision {
  const artifact = inspection.artifact;
  const temporary = isTemporaryRetentionKind(artifact.kind);
  const selected = temporary ? policy.rules[artifact.kind] : null;
  const expiryTime = selected && isRetentionInstant(artifact.createdAt)
    ? Date.parse(artifact.createdAt) + selected.keepDays * DAY_MS : null;
  const expiresAt = expiryTime !== null && Number.isFinite(expiryTime) && expiryTime <= 8.64e15
    ? new Date(expiryTime).toISOString() : null;
  let reason: RetentionReason = "eligible";
  if (!temporary) reason = "permanent_record";
  else if (!isValidRetentionArtifactMetadata(artifact) || !expiresAt || !Number.isFinite(at.getTime())) reason = "invalid_metadata";
  else if (artifact.payloadState === "cleared") reason = "already_cleared";
  else if (artifact.payloadState !== "present") reason = "payload_unknown";
  else if (artifact.adoptionState === "adopted") reason = "adopted";
  else if (artifact.adoptionState !== "unadopted") reason = "adoption_unknown";
  else if (inspection.referenceState === "referenced") reason = "referenced";
  else if (inspection.referenceState !== "unreferenced") reason = "references_unknown";
  else if (inspection.modelRequestState === "unknown_hold") reason = "unknown_model_hold";
  else if (inspection.modelRequestState !== "clear") reason = "model_hold_unknown";
  else if (inspection.runState === "active") reason = "run_active";
  else if (inspection.runState !== "terminal") reason = "run_state_unknown";
  else if (Date.parse(expiresAt) > at.getTime()) reason = "not_expired";
  return { artifactId: artifact.id, sourceConfigId: artifact.sourceConfigId, runId: artifact.runId,
    kind: artifact.kind, revision: artifact.revision, createdAt: artifact.createdAt, byteLength: artifact.byteLength,
    expiresAt, policyOrigin: selected?.origin ?? null, action: reason === "eligible" ? "clear_temporary_payload" : "keep", reason };
}
