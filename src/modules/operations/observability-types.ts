import type { Actor, Clock } from "../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { ExecutionKind, ExecutionStatus, ExecutionStep, FailureCategory } from "./run-domain.ts";
import type { SourceStatus } from "./source-domain.ts";

export const OBSERVABILITY_MAX_WINDOW_MS = 31 * 86_400_000;
export const OBSERVABILITY_MAX_PAGE_SIZE = 100;
export const OBSERVABILITY_FAILURE_CATEGORIES: readonly FailureCategory[] = ["timeout", "network_error", "rate_limited", "provider_unavailable", "worker_lost", "access_denied", "invalid_input", "parse_error", "schema_invalid", "source_changed"];
export type ObservabilityFailureCategory = FailureCategory | "unknown";

export interface SourceObservabilityInput {
  readonly sourceId: string;
  readonly since?: string;
  readonly until?: string;
  readonly kind?: ExecutionKind;
  readonly status?: ExecutionStatus;
  readonly failureCategory?: FailureCategory;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface SourceObservabilityQuery {
  readonly sourceId: string;
  /** Half-open creation-time window. Service normalizes all timestamps to UTC
   * with six fractional digits. A cursor keeps these bounds unchanged. */
  readonly since: string;
  readonly until: string;
  readonly kind: ExecutionKind | null;
  readonly status: ExecutionStatus | null;
  readonly failureCategory: FailureCategory | null;
  readonly limit: number;
  readonly before: { readonly createdAt: string; readonly id: string } | null;
}
/** Explicit safe projection: no source URLs, owner/actor IDs, lease tokens, logs,
 * prompts, request bodies, model output or content references enter this port. */
export interface ObservabilityRunRecord {
  readonly id: string;
  readonly revision: number;
  readonly kind: ExecutionKind;
  readonly status: ExecutionStatus;
  readonly step: ExecutionStep;
  readonly attempt: number;
  readonly createdAt: string;
  readonly availableAt: string;
  readonly firstStartedAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly finishedAt: string | null;
  readonly latestFailure: { readonly category: string; readonly occurredAt: string; readonly attempt: number } | null;
}
export interface SourceObservabilityRecord {
  readonly source: {
    readonly id: string;
    readonly revision: number;
    readonly status: SourceStatus;
    readonly nextEligibleAt: string | null;
    readonly lastSuccessAt: string | null;
    readonly lastFailureAt: string | null;
    /** Authoritative source health columns: crawl failures, across all time. */
    readonly consecutiveCrawlFailures: number;
  };
  readonly runs: readonly ObservabilityRunRecord[];
  readonly counts: readonly { readonly status: ExecutionStatus; readonly count: string }[];
  readonly failures: readonly { readonly category: string; readonly count: string }[];
}
export interface OperationsObservabilityQueryPort {
  readonly database: Pick<DatabasePort, "transaction">;
  /** Read all operations projections in one SQL snapshot; return at most limit+1 runs. */
  read(sql: SqlExecutor, query: SourceObservabilityQuery): Promise<SourceObservabilityRecord | null>;
}
export interface OperationsObservabilityAuthorizationPort {
  /** Root must validate the CURRENT active account, admin role and request session
   * on this executor, retaining account/session locks until transaction end.
   * A cached Actor role alone does not satisfy this contract. */
  assertCurrentAdmin(actor: Actor, sql: SqlExecutor): Promise<void>;
}
export interface SourceRuntimeObservation {
  readonly measuredAt: string;
  readonly worker: null | {
    /** Existing source-worker heartbeat is global; label it accordingly. */
    readonly scope: "all_sources" | "source";
    readonly status: "not_started" | "idle" | "running" | "failed" | "stopped" | "stale";
    readonly lastSeenAt: string | null;
  };
  readonly model: null | {
    readonly quotaDay: string;
    readonly quotaTimezone: "UTC";
    readonly calls: number;
    readonly pendingReservations: number;
    readonly unknownRequests: number;
    /** Null means pricing/settlement is incomplete, never free. */
    readonly completeCostMicroUsd: string | null;
    readonly reservedMicroUsd: string | null;
    readonly admission: "allowed" | "limited" | "unknown_request" | "not_configured";
  };
}
export interface OperationsObservabilityRuntimePort {
  /** Root reads existing heartbeat/AI ledgers for exactly this source. Must not
   * initialize a ledger, refresh a source, enqueue work or clear unknown holds. */
  readSourceRuntime(input: { readonly sourceId: string; readonly observedAt: string }, sql: SqlExecutor): Promise<SourceRuntimeObservation | null>;
}
export interface ObservabilityRun extends Omit<ObservabilityRunRecord, "latestFailure"> {
  readonly latestFailure: null | { readonly category: ObservabilityFailureCategory; readonly code: string; readonly occurredAt: string; readonly attempt: number };
  /** First recorded start minus creation; a queued run has null actual wait. */
  readonly initialQueueWaitMs: number | null;
  readonly queuedAgeMs: number | null;
  readonly eligibleQueueWaitMs: number | null;
  readonly latestAttemptDurationMs: number | null;
  readonly durationBasis: "finished" | "latest_failure" | "running_elapsed" | "unavailable";
}
export interface SourceObservabilityReport {
  readonly observedAt: string;
  readonly window: { readonly since: string; readonly until: string; readonly basis: "run_created_at" };
  readonly source: SourceObservabilityRecord["source"];
  /** Counts cover the full filtered window, not merely the current page. */
  readonly counts: readonly { readonly status: ExecutionStatus; readonly count: string }[];
  /** Number of runs by their latest failure, including runs later recovered. */
  readonly failures: readonly { readonly category: ObservabilityFailureCategory; readonly code: string; readonly count: string }[];
  readonly runs: readonly ObservabilityRun[];
  readonly nextCursor: string | null;
  readonly runtime: SourceRuntimeObservation | null;
}
export interface OperationsObservabilityDependencies {
  readonly repository: OperationsObservabilityQueryPort;
  readonly authorization: OperationsObservabilityAuthorizationPort;
  readonly clock: Clock;
  /** Server-only random material; at least 32 bytes, shared across app replicas. */
  readonly cursorSecret: string;
  readonly runtime?: OperationsObservabilityRuntimePort;
}
