import type { Actor, Clock, IdGenerator } from "../../shared/contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";

export interface ResourceClaim {
  readonly state: "known" | "unknown";
  readonly sourceUrl: string | null;
}
/** Transient view supplied by M09. M08 never stores the resource body. */
export interface ResourceReviewSnapshot {
  readonly resourceId: string;
  readonly revision: number;
  readonly contentHash: string;
  /** Last editor of this exact revision, not merely the resource's initial creator. */
  readonly recordedBy: string;
  readonly officialUrl: string;
  readonly publicationStatus: "draft" | "pending_review" | "published" | "needs_recheck" | "withdrawn";
  readonly validationErrors: readonly string[];
  readonly fees: ResourceClaim;
  readonly license: ResourceClaim;
  readonly publishedVersion: number | null;
}

/**
 * readForReview locks the M09 resource row before any M08 review row. M09 must
 * use tx, lock/CAS exact revision+hash, preserve history and write its
 * outbox in this transaction. No network call or independent commit is allowed.
 * Replays of reviewOperationId return the original result; differing input fails.
 * A remote-only adapter is incompatible: use a durable intent/outbox before it.
 */
export interface ResourcePublicationPort {
  readForReview(tx: SqlExecutor, resourceId: string): Promise<ResourceReviewSnapshot | null>;
  publishReviewed(tx: SqlExecutor, input: {
    readonly actor: Actor; readonly resourceId: string; readonly expectedRevision: number;
    readonly expectedContentHash: string; readonly expectedPublishedVersion: number | null;
    readonly reviewOperationId: string; readonly reviewedBy: string; readonly reviewedAt: string;
    readonly reason: string; readonly requestId: string;
  }): Promise<{ readonly resourceId: string; readonly publishedVersion: number }>;
  withdraw(tx: SqlExecutor, input: {
    readonly actor: Actor; readonly resourceId: string; readonly expectedRevision: number;
    readonly expectedPublishedVersion: number; readonly reviewOperationId: string;
    readonly reason: string; readonly at: string; readonly requestId: string;
  }): Promise<{ readonly resourceId: string; readonly publishedVersion: number }>;
}

export interface ResourceVerification {
  readonly link: { readonly status: "available" | "unavailable"; readonly checkedUrl: string };
  readonly fees: { readonly status: "verified" | "unknown"; readonly sourceUrl: string | null };
  readonly license: { readonly status: "verified" | "unknown"; readonly sourceUrl: string | null };
}
export type ResourceReviewStatus = "pending" | "changes_requested" | "approved" | "rejected" | "published";
export interface ResourceReview {
  readonly id: string;
  readonly resourceId: string;
  readonly resourceRevision: number;
  readonly contentHash: string;
  readonly recordedBy: string;
  readonly revision: number;
  readonly status: ResourceReviewStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly verification: ResourceVerification | null;
  readonly reason: string | null;
  readonly publishedVersion: number | null;
  readonly publishedAt: string | null;
}
export interface ResourceReviewAudit {
  readonly id: string;
  readonly actorId: string;
  readonly action: "resource_registered" | "resource_approved" | "resource_changes_requested" | "resource_rejected" | "resource_published" | "resource_withdrawn";
  readonly reviewId: string | null;
  readonly resourceId: string;
  readonly resourceRevision: number;
  readonly recordedBy: string;
  readonly reviewRevision: number | null;
  readonly contentHash: string;
  readonly verification: ResourceVerification | null;
  readonly reviewedBy: string | null;
  readonly selfReviewed: boolean;
  readonly reason: string | null;
  readonly occurredAt: string;
  readonly requestId: string;
  readonly operationId: string | null;
  readonly publishedVersion: number | null;
}
export interface ResourceReviewTransaction extends SqlExecutor {
  /** Nonlocking peek only resolves resourceId; reread with a lock after the resource lock. */
  getReview(id: string, lock?: boolean): Promise<ResourceReview | null>;
  findReview(resourceId: string, resourceRevision: number): Promise<ResourceReview | null>;
  insertReview(review: ResourceReview): Promise<void>;
  saveReview(review: ResourceReview, expectedRevision: number): Promise<void>;
  appendAudit(audit: ResourceReviewAudit): Promise<void>;
  findWithdrawal(actorId: string, operationId: string): Promise<ResourceReviewAudit | null>;
  /** Serialize the actor-scoped idempotency key before any resource lock. */
  lockWithdrawal(actorId: string, operationId: string): Promise<void>;
}
export interface ResourceReviewRepository {
  transaction<T>(work: (tx: ResourceReviewTransaction) => Promise<T>): Promise<T>;
  listReviews(status?: ResourceReviewStatus, limit?: number): Promise<readonly ResourceReview[]>;
}
export interface ResourceReviewDependencies {
  readonly repository: ResourceReviewRepository;
  readonly resources: ResourcePublicationPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}
