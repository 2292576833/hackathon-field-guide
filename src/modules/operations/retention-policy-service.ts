import { createHash } from "node:crypto";
import type { Clock, IdGenerator } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { createRetentionPolicy, evaluateRetention, isRetentionIdentifier, isRetentionInstant, isRetentionReason, isValidRetentionArtifactMetadata,
  isTemporaryRetentionKind, retentionCutoffs, retentionPolicyFingerprint, PERMANENT_RETENTION_KINDS } from "./retention-policy.ts";
import type { RetentionDecision, RetentionInspection, RetentionPolicy, RetentionPolicyOrigin,
  RetentionReason, TemporaryRetentionKind } from "./retention-policy.ts";

export const RETENTION_MAX_PAGE_SIZE = 100;
export interface VerifiedRetentionIdentity {
  readonly id: string;
  readonly kind: "operations_retention_worker";
  readonly capabilities: readonly ("retention_dry_run" | "retention_cleanup")[];
  /** null is an explicitly provisioned all-source service; [] grants no source access. */
  readonly sourceConfigIds: readonly string[] | null;
}
export interface RetentionPosition { readonly createdAt: string; readonly artifactId: string }
export interface RetentionScan {
  readonly sourceConfigId?: string;
  readonly kind?: TemporaryRetentionKind;
  readonly allowedSourceConfigIds: readonly string[] | null;
  readonly createdAtCutoffs: Readonly<Record<TemporaryRetentionKind, string>>;
  readonly asOf: string;
  readonly after: RetentionPosition | null;
  readonly limit: number;
}
export interface RetentionScanPage {
  readonly items: readonly RetentionInspection[];
  readonly hasMore: boolean;
}
export interface TemporaryPayloadClearInput {
  readonly identity: VerifiedRetentionIdentity;
  readonly artifactId: string;
  readonly expectedRevision: number;
  readonly expectedCreatedAt: string;
  readonly kind: TemporaryRetentionKind;
  readonly createdAtCutoff: string;
  readonly clearedAt: string;
}
export type TemporaryPayloadClearResult = { readonly status: "cleared"; readonly revision: number; readonly clearedBytes: number }
  | { readonly status: "kept"; readonly reason: Exclude<RetentionReason, "eligible"> };
export interface RetentionCleanupAudit {
  readonly id: string;
  readonly actorKind: "operations_retention_worker";
  readonly actorId: string;
  readonly action: "temporary_payload_cleared";
  readonly artifactId: string;
  readonly sourceConfigId: string;
  readonly runId: string | null;
  readonly kind: TemporaryRetentionKind;
  readonly beforeRevision: number;
  readonly revision: number;
  readonly clearedBytes: number;
  readonly policyFingerprint: string;
  readonly policyOrigin: RetentionPolicyOrigin;
  readonly occurredAt: string;
}
/**
 * Root SQL adapter contract. All calls use the same database executor/transaction.
 * Service credentials are never persisted or returned. authorize must check current
 * service capability/scope; ordinary website actors cannot acquire this identity.
 *
 * listExpiredTemporaryPage returns METADATA ONLY, keyset ordered (created_at,id
 * COLLATE "C") ascending, <= limit rows, querying only explicitly separable temporary
 * payloads and applying source scope + per-kind cutoff in SQL.
 *
 * lockAndInspectTemporaryArtifact takes the payload guard lock plus run/source
 * protection locks in the root's established order, then rereads revision, adoption,
 * complete durable references, pending/unknown paid requests and active/retriable
 * consumers. Every writer that creates those references/holds must participate in
 * the same guard lock. If that guarantee or complete relationship coverage is absent,
 * return referenceState/modelRequestState/runState="unknown", never guess clear.
 *
 * clearTemporaryPayload is a FINAL conditional CAS/NOT EXISTS check inside this
 * transaction, even following inspection. It checks current scope, kind, revision,
 * immutable creation time, cutoff, unadopted/present state, all references and all
 * pending/unknown holds/active consumers. A race returns kept; it never clears the
 * artifact row itself: keep hash/ID/version and a cleared-at tombstone. It may clear
 * only the isolated body/preview payload. Do not UPDATE/DELETE immutable source
 * receipts, M03 evidence, snapshots, audit/review rows, requests, model/budget ledgers,
 * run fingerprints, dedup markers, attempt numbers or navigation/AI history. No
 * resetting request state, no enqueue/retry/model/network effects.
 *
 * appendCleanupAudit is append-only and atomic with the clear; failure rolls back.
 * External files require a root-designed transactional outbox + versioned guarded
 * erasure protocol; do not unlink a file before this database transaction commits.
 */
export interface RetentionCleanupTransaction {
  authorize(serviceCredential: string): Promise<VerifiedRetentionIdentity | null>;
  listExpiredTemporaryPage(input: RetentionScan): Promise<RetentionScanPage>;
  lockAndInspectTemporaryArtifact(artifactId: string): Promise<RetentionInspection | null>;
  clearTemporaryPayload(input: TemporaryPayloadClearInput): Promise<TemporaryPayloadClearResult>;
  appendCleanupAudit(event: RetentionCleanupAudit): Promise<void>;
}
export interface RetentionCleanupPort {
  transaction<T>(work: (tx: RetentionCleanupTransaction) => Promise<T>): Promise<T>;
}
export interface RetentionPreviewQuery {
  readonly sourceConfigId?: string;
  readonly kind?: TemporaryRetentionKind;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface RetentionPreview {
  readonly mode: "dry_run";
  readonly evaluatedAt: string;
  readonly policyFingerprint: string;
  readonly policy: RetentionPolicy;
  readonly items: readonly RetentionDecision[];
  readonly eligibleBytes: number;
  readonly nextCursor: string | null;
}
export interface RetentionCleanupRequest {
  readonly expectedPolicyFingerprint: string;
  readonly candidates: readonly { readonly artifactId: string; readonly expectedRevision: number }[];
}
export interface RetentionCleanupOutcome {
  readonly artifactId: string;
  readonly status: "cleared" | "kept";
  readonly reason: RetentionReason;
  /** Observed/resulting revision; null when a final guard rejects without attesting the current version. */
  readonly revision: number | null;
  readonly clearedBytes: number;
}
export interface RetentionCleanupReport {
  readonly mode: "cleanup";
  readonly policyFingerprint: string;
  readonly items: readonly RetentionCleanupOutcome[];
  readonly clearedBytes: number;
}
export interface RetentionServiceDependencies {
  readonly cleanup: RetentionCleanupPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly policy?: RetentionPolicy;
}
export interface RetentionService {
  preview(serviceCredential: string, query?: RetentionPreviewQuery): Promise<RetentionPreview>;
  cleanup(serviceCredential: string, request: RetentionCleanupRequest): Promise<RetentionCleanupReport>;
}
const invalid = (): never => { throw new DomainError("INVALID_RETENTION_QUERY", "临时内容查询或游标不正确。"); };
const contractError = (): never => { throw new DomainError("RETENTION_PORT_INVALID", "临时内容适配器未满足安全契约。", { status: 503 }); };
const denied = (): never => { throw new DomainError("RETENTION_SERVICE_FORBIDDEN", "服务身份没有临时内容维护权限。", { status: 403 }); };
function scopeFingerprint(identity: VerifiedRetentionIdentity): string {
  return JSON.stringify([identity.id, identity.kind, [...identity.capabilities].sort(), identity.sourceConfigIds === null ? null : [...identity.sourceConfigIds].sort()]);
}
function assertIdentity(identity: VerifiedRetentionIdentity | null, capability: "retention_dry_run" | "retention_cleanup"): VerifiedRetentionIdentity {
  if (!identity || identity.kind !== "operations_retention_worker" || !isRetentionIdentifier(identity.id)
    || !Array.isArray(identity.capabilities) || !identity.capabilities.includes(capability)
    || (identity.sourceConfigIds !== null && (!Array.isArray(identity.sourceConfigIds) || !identity.sourceConfigIds.every(isRetentionIdentifier)))) denied();
  return identity ?? denied();
}
function assertScope(identity: VerifiedRetentionIdentity, sourceConfigId: string): void {
  if (!isRetentionIdentifier(sourceConfigId) || (identity.sourceConfigIds !== null && !identity.sourceConfigIds.includes(sourceConfigId))) denied();
}
function credential(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) denied();
}
function binding(identity: VerifiedRetentionIdentity, policy: RetentionPolicy, query: RetentionPreviewQuery): string {
  return createHash("sha256").update(JSON.stringify([scopeFingerprint(identity), retentionPolicyFingerprint(policy), query.sourceConfigId ?? null, query.kind ?? null])).digest("hex");
}
interface CursorData { readonly v: 1; readonly binding: string; readonly asOf: string; readonly after: RetentionPosition }
function decodeCursor(encoded: string, expectedBinding: string, now: Date): CursorData {
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(encoded)) invalid();
  try {
    const buffer = Buffer.from(encoded, "base64url");
    if (buffer.toString("base64url") !== encoded) invalid();
    const value = JSON.parse(buffer.toString("utf8")) as CursorData;
    if (!value || value.v !== 1 || value.binding !== expectedBinding || !isRetentionInstant(value.asOf)
      || Date.parse(value.asOf) > now.getTime() || !value.after || !isRetentionInstant(value.after.createdAt)
      || !isRetentionIdentifier(value.after.artifactId) || Date.parse(value.after.createdAt) > Date.parse(value.asOf)) invalid();
    return value;
  } catch { return invalid(); }
}
function comparePosition(left: RetentionPosition, right: RetentionPosition): number {
  return left.createdAt === right.createdAt ? (left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0)
    : left.createdAt < right.createdAt ? -1 : 1;
}
function kept(artifactId: string, reason: RetentionReason, revision: number | null): RetentionCleanupOutcome {
  return { artifactId, status: "kept", reason, revision, clearedBytes: 0 };
}
/** Backend-only factory. Exposes neither an HTTP endpoint nor an automatic destructive scheduler. */
export function createRetentionService(deps: RetentionServiceDependencies): RetentionService {
  const policy = deps.policy ?? createRetentionPolicy();
  // Validate supplied policies using the same rules; never accept a custom permanent-kind exemption.
  if (!policy.rules?.temporary_original_text || !policy.rules?.temporary_preview) {
    throw new DomainError("INVALID_RETENTION_POLICY", "临时内容保留策略不正确。");
  }
  const checked = createRetentionPolicy({ originalTextDays: policy.rules?.temporary_original_text?.keepDays,
    previewDays: policy.rules?.temporary_preview?.keepDays });
  if (policy.version !== checked.version || !["module_default_provisional", "deployment_config"].includes(policy.rules.temporary_original_text.origin)
    || !["module_default_provisional", "deployment_config"].includes(policy.rules.temporary_preview.origin)) {
    throw new DomainError("INVALID_RETENTION_POLICY", "临时内容保留策略不正确。");
  }
  const immutablePolicy: RetentionPolicy = Object.freeze({ version: checked.version, rules: Object.freeze({
    temporary_original_text: Object.freeze({ ...policy.rules.temporary_original_text }),
    temporary_preview: Object.freeze({ ...policy.rules.temporary_preview }),
  }), permanentKinds: checked.permanentKinds });
  const fingerprint = retentionPolicyFingerprint(immutablePolicy);
  return {
    async preview(serviceCredential, query = {}) {
      credential(serviceCredential);
      const limit = query.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > RETENTION_MAX_PAGE_SIZE
        || (query.sourceConfigId !== undefined && !isRetentionIdentifier(query.sourceConfigId))
        || (query.kind !== undefined && !isTemporaryRetentionKind(query.kind))) invalid();
      return deps.cleanup.transaction(async tx => {
        const identity = assertIdentity(await tx.authorize(serviceCredential), "retention_dry_run");
        if (query.sourceConfigId) assertScope(identity, query.sourceConfigId);
        const now = deps.clock.now();
        const cursorBinding = binding(identity, immutablePolicy, query);
        const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor, cursorBinding, now);
        const asOf = cursor?.asOf ?? now.toISOString();
        const scan: RetentionScan = { ...(query.sourceConfigId ? { sourceConfigId: query.sourceConfigId } : {}),
          ...(query.kind ? { kind: query.kind } : {}), allowedSourceConfigIds: identity.sourceConfigIds,
          createdAtCutoffs: retentionCutoffs(immutablePolicy, new Date(asOf)), asOf, after: cursor?.after ?? null, limit };
        const page = await tx.listExpiredTemporaryPage(scan);
        if (!page || !Array.isArray(page.items) || page.items.length > limit || typeof page.hasMore !== "boolean" || (page.hasMore && page.items.length === 0)) contractError();
        let last = scan.after;
        const items: RetentionDecision[] = [];
        for (const inspection of page.items) {
          const artifact = inspection.artifact;
          assertScope(identity, artifact.sourceConfigId);
          if (!isValidRetentionArtifactMetadata(artifact)
            || (!isTemporaryRetentionKind(artifact.kind) && !(PERMANENT_RETENTION_KINDS as readonly string[]).includes(artifact.kind))
            || (query.sourceConfigId && artifact.sourceConfigId !== query.sourceConfigId)
            || (query.kind && artifact.kind !== query.kind)) contractError();
          const position = { createdAt: artifact.createdAt, artifactId: artifact.id };
          if (last && comparePosition(position, last) <= 0) contractError();
          last = position;
          items.push(evaluateRetention(immutablePolicy, inspection, new Date(asOf)));
        }
        const current = assertIdentity(await tx.authorize(serviceCredential), "retention_dry_run");
        if (scopeFingerprint(current) !== scopeFingerprint(identity)) denied();
        const nextCursor = page.hasMore && last ? Buffer.from(JSON.stringify({ v: 1, binding: cursorBinding, asOf, after: last } satisfies CursorData)).toString("base64url") : null;
        const eligibleBytes = items.reduce((sum, item) => sum + (item.action === "clear_temporary_payload" ? item.byteLength : 0), 0);
        if (!Number.isSafeInteger(eligibleBytes)) contractError();
        return { mode: "dry_run", evaluatedAt: asOf, policyFingerprint: fingerprint, policy: immutablePolicy,
          items, eligibleBytes, nextCursor };
      });
    },
    async cleanup(serviceCredential, request) {
      credential(serviceCredential);
      if (!request || request.expectedPolicyFingerprint !== fingerprint) throw new DomainError("RETENTION_POLICY_CHANGED", "保留策略已变化，请重新预演后再清理。", { status: 409 });
      if (!Array.isArray(request.candidates) || request.candidates.length < 1 || request.candidates.length > RETENTION_MAX_PAGE_SIZE
        || request.candidates.some(item => !isRetentionIdentifier(item.artifactId) || !Number.isSafeInteger(item.expectedRevision) || item.expectedRevision < 1)
        || new Set(request.candidates.map(item => item.artifactId)).size !== request.candidates.length) invalid();
      const items: RetentionCleanupOutcome[] = [];
      // One protected transaction per artifact avoids accumulating cross-run locks. An
      // infrastructure failure can follow prior commits: retained tombstones make retries
      // idempotent, while append-audit failure rolls back that artifact's entire clear.
      for (const expected of [...request.candidates].sort((a, b) => a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0)) {
        items.push(await deps.cleanup.transaction(async tx => {
          const identity = assertIdentity(await tx.authorize(serviceCredential), "retention_cleanup");
          const finishKept = async (artifactId: string, reason: RetentionReason, revision: number | null): Promise<RetentionCleanupOutcome> => {
            const current = assertIdentity(await tx.authorize(serviceCredential), "retention_cleanup");
            if (scopeFingerprint(current) !== scopeFingerprint(identity)) denied();
            return kept(artifactId, reason, revision);
          };
          const inspection = await tx.lockAndInspectTemporaryArtifact(expected.artifactId);
          if (!inspection) return finishKept(expected.artifactId, "missing", null);
          const artifact = inspection.artifact;
          if (!isValidRetentionArtifactMetadata(artifact) || artifact.id !== expected.artifactId) contractError();
          assertScope(identity, artifact.sourceConfigId);
          if (artifact.revision !== expected.expectedRevision) return finishKept(artifact.id, "version_changed", artifact.revision);
          const now = deps.clock.now();
          const decision = evaluateRetention(immutablePolicy, inspection, now);
          if (decision.action === "keep" || !isTemporaryRetentionKind(artifact.kind)) return finishKept(artifact.id, decision.reason, artifact.revision);
          const current = assertIdentity(await tx.authorize(serviceCredential), "retention_cleanup");
          if (scopeFingerprint(current) !== scopeFingerprint(identity)) denied();
          const result = await tx.clearTemporaryPayload({ identity: current, artifactId: artifact.id, expectedRevision: artifact.revision,
            expectedCreatedAt: artifact.createdAt, kind: artifact.kind, createdAtCutoff: retentionCutoffs(immutablePolicy, now)[artifact.kind], clearedAt: now.toISOString() });
          if (result.status === "kept") {
            if (!isRetentionReason(result.reason) || result.reason === ("eligible" as RetentionReason)) contractError();
            return finishKept(artifact.id, result.reason, null);
          }
          if (result.status !== "cleared" || result.revision !== artifact.revision + 1 || result.clearedBytes !== artifact.byteLength) contractError();
          await tx.appendCleanupAudit({ id: deps.ids.next(), actorKind: identity.kind, actorId: identity.id, action: "temporary_payload_cleared",
            artifactId: artifact.id, sourceConfigId: artifact.sourceConfigId, runId: artifact.runId, kind: artifact.kind,
            beforeRevision: artifact.revision, revision: result.revision, clearedBytes: result.clearedBytes,
            policyFingerprint: fingerprint, policyOrigin: immutablePolicy.rules[artifact.kind].origin, occurredAt: now.toISOString() });
          const finalIdentity = assertIdentity(await tx.authorize(serviceCredential), "retention_cleanup");
          if (scopeFingerprint(finalIdentity) !== scopeFingerprint(identity)) denied();
          return { artifactId: artifact.id, status: "cleared", reason: "eligible", revision: result.revision, clearedBytes: result.clearedBytes };
        }));
      }
      return { mode: "cleanup", policyFingerprint: fingerprint, items, clearedBytes: items.reduce((sum, item) => sum + item.clearedBytes, 0) };
    },
  };
}
