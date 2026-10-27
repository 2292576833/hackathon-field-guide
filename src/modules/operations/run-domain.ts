import type { Instant } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { SourceConfig } from "./source-domain.ts";

export type ExecutionKind = "crawl" | "analysis";
export type ExecutionStatus = "queued" | "running" | "review_ready" | "succeeded" | "failed" | "cancelled";
export type ExecutionStep = "queued" | "fetching" | "normalizing" | "extracting" | "validating" | "complete";
export type FailureCategory = "timeout" | "network_error" | "rate_limited" | "provider_unavailable" | "worker_lost" | "access_denied" | "invalid_input" | "parse_error" | "schema_invalid" | "source_changed";
export interface ExecutionFailure {
  readonly category: FailureCategory;
  readonly occurredAt: Instant;
  readonly attempt: number;
  readonly retryable: boolean;
}
export interface ExecutionLease {
  readonly workerId: string;
  readonly token: string;
  readonly expiresAt: Instant;
  readonly deadlineAt: Instant;
}
export interface ExecutionHistory {
  readonly step: ExecutionStep;
  readonly attempt: number;
  readonly occurredAt: Instant;
}
export interface CrawlOutput {
  readonly resultRef: string;
  readonly inputHash: string;
  readonly eventSourceIds: readonly string[];
  readonly candidateRefs: readonly string[];
  readonly unchanged: boolean;
}
export interface AnalysisOutput {
  readonly resultRef: string;
  readonly outputRef: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostMicros: number;
  readonly currency: "USD" | "CNY";
}
export interface RunBase {
  readonly id: string;
  readonly kind: ExecutionKind;
  readonly sourceConfigId: string;
  readonly revision: number;
  readonly status: ExecutionStatus;
  readonly step: ExecutionStep;
  readonly requestedBy: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly retryOf: string | null;
  readonly trigger: "manual" | "scheduled";
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly availableAt: Instant;
  readonly lastAttemptAt: Instant | null;
  readonly lease: ExecutionLease | null;
  readonly failures: readonly ExecutionFailure[];
  readonly history: readonly ExecutionHistory[];
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly finishedAt: Instant | null;
}
export interface CrawlRun extends RunBase {
  readonly kind: "crawl";
  readonly sourceSnapshot: SourceConfig;
  readonly targetUrl: string;
  readonly adapterVersion: string;
  readonly output: CrawlOutput | null;
}
export interface AnalysisRun extends RunBase {
  readonly kind: "analysis";
  readonly crawlRunId: string;
  readonly inputHash: string;
  readonly candidateRefs: readonly string[];
  readonly schemaVersion: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly output: AnalysisOutput | null;
}
export type ExecutionRun = CrawlRun | AnalysisRun;
export interface VerifiedWorkerIdentity {
  readonly id: string;
  readonly kind: "operations_worker";
  readonly capabilities: readonly ExecutionKind[];
  readonly sourceConfigIds: readonly string[];
}
/** Implemented by M01/service-auth integration. Credentials never enter task records. */
export interface WorkerIdentityPort {
  authenticate(serviceCredential: string): Promise<VerifiedWorkerIdentity | null>;
}
/** These methods load immutable candidate references owned by M03 and authoritatively
 * check schema, provenance, run/source association and content hash. Returning merely
 * the worker's submitted claims does not satisfy this contract. No publication here. */
export interface CandidateValidationPort {
  validateCrawl(input: { readonly runId: string; readonly sourceConfigId: string; readonly sourceRevision: number; readonly targetUrl: string; readonly resultRef: string }): Promise<CrawlOutput>;
  validateAnalysis(input: { readonly runId: string; readonly crawlRunId: string; readonly inputHash: string; readonly schemaVersion: string; readonly modelVersion: string; readonly promptVersion: string; readonly resultRef: string }): Promise<AnalysisOutput>;
}
export interface ApprovedSourceSnapshot {
  readonly id: string;
  readonly revision: number;
  readonly type: SourceConfig["type"];
  readonly acquisitionMethod: SourceConfig["acquisitionMethod"];
  readonly credentialPolicy: "none";
  readonly networkPolicy: SourceConfig["networkPolicy"];
  readonly minimumIntervalSeconds: number;
}
export interface WorkerRunState {
  readonly id: string;
  readonly kind: ExecutionKind;
  readonly revision: number;
  readonly status: ExecutionStatus;
  readonly step: ExecutionStep;
  readonly attempt: number;
  readonly availableAt: Instant;
  readonly leaseExpiresAt: Instant | null;
  readonly deadlineAt: Instant | null;
  readonly finishedAt: Instant | null;
}
export interface ApprovedWorkerTask {
  readonly runId: string;
  readonly kind: ExecutionKind;
  readonly revision: number;
  readonly attempt: number;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Instant;
  readonly deadlineAt: Instant;
  readonly source: ApprovedSourceSnapshot;
  readonly crawl?: { readonly targetUrl: string; readonly adapterVersion: string };
  readonly analysis?: { readonly crawlRunId: string; readonly inputHash: string; readonly candidateRefs: readonly string[]; readonly schemaVersion: string; readonly modelVersion: string; readonly promptVersion: string };
}
export function approvedSourceSnapshot(source: SourceConfig): ApprovedSourceSnapshot {
  return { id: source.id, revision: source.revision, type: source.type, acquisitionMethod: source.acquisitionMethod, credentialPolicy: "none", networkPolicy: source.networkPolicy, minimumIntervalSeconds: source.minimumIntervalSeconds };
}
export function workerRunState(run: ExecutionRun): WorkerRunState {
  return { id: run.id, kind: run.kind, revision: run.revision, status: run.status, step: run.step, attempt: run.attempt, availableAt: run.availableAt, leaseExpiresAt: run.lease?.expiresAt ?? null, deadlineAt: run.lease?.deadlineAt ?? null, finishedAt: run.finishedAt };
}

const retryCategories: readonly FailureCategory[] = ["timeout", "network_error", "rate_limited", "provider_unavailable", "worker_lost"];
const allCategories: readonly FailureCategory[] = [...retryCategories, "access_denied", "invalid_input", "parse_error", "schema_invalid", "source_changed"];
export function isRetryableFailure(category: FailureCategory): boolean {
  if (!allCategories.includes(category)) throw new DomainError("INVALID_FAILURE_CATEGORY", "任务错误类别不正确。");
  return retryCategories.includes(category);
}
export function assertWorkerScope(worker: VerifiedWorkerIdentity, run: ExecutionRun): void {
  if (worker.kind !== "operations_worker" || !worker.capabilities.includes(run.kind) || !worker.sourceConfigIds.includes(run.sourceConfigId)) throw new DomainError("WORKER_SCOPE_DENIED", "服务身份没有此任务的执行权限。", { status: 403 });
}
export function assertRunLease(run: ExecutionRun, worker: VerifiedWorkerIdentity, token: string, now: Date): void {
  assertWorkerScope(worker, run);
  if (run.status !== "running" || !run.lease || run.lease.workerId !== worker.id || run.lease.token !== token || Date.parse(run.lease.expiresAt) <= now.getTime() || Date.parse(run.lease.deadlineAt) <= now.getTime()) throw new DomainError("WORKER_LEASE_LOST", "任务租约已失效，请重新读取任务状态。", { status: 409 });
}
export function redactRun(run: ExecutionRun): ExecutionRun {
  return run.lease ? { ...run, lease: { ...run.lease, token: "[redacted]" } } : run;
}
export function retryRun(run: ExecutionRun, category: FailureCategory, now: Date, minimumIntervalSeconds: number, retryAfterSeconds = 0): ExecutionRun {
  const retryable = isRetryableFailure(category);
  if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 0 || retryAfterSeconds > 86_400) throw new DomainError("INVALID_RETRY_DELAY", "重试等待时间不正确。");
  const retry = retryable && run.attempt < run.maxAttempts;
  const lastStart = run.lastAttemptAt ? Date.parse(run.lastAttemptAt) : now.getTime();
  const backoffSeconds = Math.min(900, 30 * 2 ** Math.max(0, run.attempt - 1));
  const availableAt = new Date(Math.max(now.getTime() + Math.max(backoffSeconds, retryAfterSeconds) * 1000, lastStart + minimumIntervalSeconds * 1000)).toISOString();
  return { ...run, revision: run.revision + 1, status: retry ? "queued" : "failed", step: retry ? "queued" : run.step, availableAt, lease: null, failures: [...run.failures, { category, occurredAt: now.toISOString(), attempt: run.attempt, retryable }], updatedAt: now.toISOString(), finishedAt: retry ? null : now.toISOString() };
}
