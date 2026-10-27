import type { Actor, Clock, IdGenerator } from "../../shared/contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";

export const criticalFieldKeys = ["eligibility", "deadlines", "fees", "deliverables", "submission"] as const;
export type CriticalFieldKey = typeof criticalFieldKeys[number];
export interface CandidateCriticalField {
  readonly key: CriticalFieldKey;
  readonly state: "known" | "unknown" | "conflict";
  readonly evidenceIds: readonly string[];
  /** A concise plain-text label from M03, never executable HTML. */
  readonly summary: string;
}

/** M03 owns candidate content, immutable source snapshots, evidence and published rules. */
export interface EventCandidateSnapshot {
  readonly eventId: string;
  readonly candidateId: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly schemaVersion: string;
  readonly createdBy: string;
  readonly lastModifiedBy: string;
  readonly origin: "manual" | "worker";
  readonly validationErrors: readonly string[];
  readonly criticalFields: readonly CandidateCriticalField[];
  readonly currentPublishedVersion: number | null;
  readonly currentPublishedCriticalFields: readonly CandidateCriticalField[] | null;
}

export interface CriticalFieldChange {
  readonly key: CriticalFieldKey;
  readonly before: CandidateCriticalField | null;
  readonly after: CandidateCriticalField;
  readonly change: "added" | "changed" | "unchanged";
}

/** All methods must use this transaction, lock/check exact versions, and never commit independently.
 * getCandidate locks the content aggregate in publication order before M08 locks its review. */
export interface EventCandidatePublicationPort {
  createManualCandidate(tx: SqlExecutor, input: {
    readonly actor: Actor; readonly eventId?: string; readonly content: unknown; readonly requestId: string;
  }): Promise<EventCandidateSnapshot>;
  getCandidate(tx: SqlExecutor, candidateId: string): Promise<EventCandidateSnapshot | null>;
  reviseManualCandidate(tx: SqlExecutor, input: {
    readonly actor: Actor; readonly candidateId: string; readonly expectedRevision: number;
    readonly content: unknown; readonly reason: string; readonly requestId: string;
  }): Promise<EventCandidateSnapshot>;
  publishCandidate(tx: SqlExecutor, input: {
    readonly actor: Actor; readonly candidateId: string; readonly expectedRevision: number;
    readonly expectedContentHash: string; readonly expectedPublishedVersion: number | null;
    readonly reviewId: string; readonly reviewedAt: string; readonly reason: string; readonly requestId: string;
  }): Promise<{ readonly eventId: string; readonly publishedVersion: number }>;
  withdrawEvent(tx: SqlExecutor, input: {
    readonly actor: Actor; readonly eventId: string; readonly expectedPublishedVersion: number;
    readonly reason: string; readonly requestId: string;
  }): Promise<{ readonly eventId: string; readonly publishedVersion: number }>;
}

export type EventReviewStatus = "pending" | "changes_requested" | "approved" | "rejected" | "published";
export interface EventReview {
  readonly id: string;
  readonly eventId: string;
  readonly candidateId: string;
  readonly candidateRevision: number;
  readonly contentHash: string;
  readonly schemaVersion: string;
  readonly revision: number;
  readonly status: EventReviewStatus;
  readonly submittedBy: string;
  readonly lastEditedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly checkedKeys: readonly CriticalFieldKey[];
  readonly acknowledgedUnknownKeys: readonly CriticalFieldKey[];
  readonly reason: string | null;
  readonly publishedVersion: number | null;
  readonly publishedAt: string | null;
}

export interface EventReviewAudit {
  readonly id: string;
  readonly actorId: string;
  readonly action: "candidate_submitted" | "candidate_revised" | "candidate_refreshed" | "candidate_registered" | "changes_requested" | "candidate_approved" | "candidate_rejected" | "event_published" | "event_withdrawn";
  readonly reviewId: string | null;
  readonly eventId: string;
  readonly candidateId: string | null;
  readonly revision: number;
  readonly candidateRevision: number | null;
  readonly contentHash: string | null;
  readonly schemaVersion: string | null;
  readonly checkedKeys: readonly CriticalFieldKey[];
  readonly acknowledgedUnknownKeys: readonly CriticalFieldKey[];
  readonly reason: string | null;
  readonly selfReviewed: boolean;
  readonly occurredAt: string;
  readonly requestId: string;
}

export interface EventReviewTransaction extends SqlExecutor {
  /** Defaults to a locking read; false is only a peek before locking M03 content. */
  getReview(id: string, lock?: boolean): Promise<EventReview | null>;
  findByCandidate(candidateId: string, lock?: boolean): Promise<EventReview | null>;
  insertReview(review: EventReview): Promise<void>;
  saveReview(review: EventReview, expectedRevision: number): Promise<void>;
  appendAudit(audit: EventReviewAudit): Promise<void>;
}
export interface EventReviewRepository {
  transaction<T>(work: (tx: EventReviewTransaction) => Promise<T>): Promise<T>;
  listReviews(status?: EventReviewStatus, limit?: number): Promise<readonly EventReview[]>;
}
export interface EventReviewDependencies {
  readonly repository: EventReviewRepository;
  readonly events: EventCandidatePublicationPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface EventApprovalInput {
  readonly expectedRevision: number;
  readonly expectedCandidateRevision: number;
  readonly checkedKeys: readonly CriticalFieldKey[];
  readonly acknowledgedUnknownKeys: readonly CriticalFieldKey[];
  readonly reason: string;
}
