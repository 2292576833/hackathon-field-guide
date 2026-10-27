import type { Actor, Clock, PageResult } from "../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";

export const auditStreams = ["execution", "event_review", "resource_review", "correction", "discovery_control"] as const;
export type AuditStream = typeof auditStreams[number];
export const auditActions = [
  "SourceProposed", "SourceConfigRevised", "SourceVerifying", "SourceEnabled", "SourceRejected", "SourcePaused", "SourceDegraded",
  "CrawlRunQueued", "AnalysisInputReused", "AnalysisRunQueued", "RunCancelled", "RunLeaseReclaimed", "RunSourceInvalidated", "RunClaimed", "RunLeaseRenewed", "RunStepAdvanced", "RunRetryScheduled", "RunFailed", "CrawlCandidateReady", "AnalysisValidated",
  "candidate_submitted", "candidate_revised", "candidate_refreshed", "candidate_registered", "changes_requested", "candidate_approved", "candidate_rejected", "event_published", "event_withdrawn",
  "resource_registered", "resource_approved", "resource_changes_requested", "resource_rejected", "resource_published", "resource_withdrawn",
  "correction_triaging", "correction_confirmed", "correction_needs_more_info", "correction_dismissed", "correction_resolved", "discovery_paused", "discovery_resumed", "unrecognized",
] as const;
export type AuditAction = typeof auditActions[number];
export const auditObjectKinds = ["source", "run", "event", "resource", "correction", "scheduler"] as const;
export type AuditObjectKind = typeof auditObjectKinds[number];

/** Metadata only. Never add payload/reason/body, email, IP, URL, session or credentials here. */
export interface AdminAuditEntry {
  readonly id: string;
  readonly stream: AuditStream;
  readonly actorKind: "user" | "worker";
  readonly actorId: string;
  readonly action: AuditAction;
  readonly objectKind: AuditObjectKind;
  readonly objectId: string;
  /** Version of the audited aggregate; content version may be a different number. */
  readonly revision: number;
  readonly contentVersion: number | null;
  readonly occurredAt: string;
}
export interface AuditQueryInput {
  readonly actorId?: string;
  readonly action?: AuditAction;
  readonly objectKind?: AuditObjectKind;
  readonly objectId?: string;
  readonly revision?: number;
  readonly stream?: AuditStream;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface AuditQueryFilters {
  readonly actorId: string | null;
  readonly action: AuditAction | null;
  readonly objectKind: AuditObjectKind | null;
  readonly objectId: string | null;
  readonly revision: number | null;
  readonly stream: AuditStream | null;
  readonly from: string;
  readonly to: string;
}
export interface AuditQueryBoundary { readonly occurredAt: string; readonly id: string; }
export interface AuditQueryPort {
  /** Exact metadata projection, DESC (occurredAt,id), strictly before boundary, LIMIT fetchLimit.
   * Same tx; parameterized SQL; no private module tables or unrestricted JSON selection. */
  readPage(tx: SqlExecutor, filters: AuditQueryFilters, boundary: AuditQueryBoundary | null, fetchLimit: number): Promise<readonly AdminAuditEntry[]>;
}
export interface AuditAuthorizationPort {
  /** Root verifies active account, live requesting session, current admin role using this tx.
   * Lock auth/role facts in its established order; actor's cached roles are insufficient. */
  assertCurrentAdmin(tx: SqlExecutor, actor: Actor): Promise<void>;
}
export interface AuditQueryPage extends PageResult<AdminAuditEntry> {
  readonly window: { readonly from: string; readonly to: string };
}
export interface AuditQueryDependencies {
  readonly database: DatabasePort;
  readonly query: AuditQueryPort;
  readonly authorization: AuditAuthorizationPort;
  readonly clock: Clock;
  /** Server-only key of at least 32 bytes; never included in UI props or responses. */
  readonly cursorSecret: Uint8Array;
}
