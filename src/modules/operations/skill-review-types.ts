import type { Actor, Clock, IdGenerator } from "../../shared/contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { SkillCandidateEvidence, SkillPublicationPort, SkillPublicationTarget, SkillReviewSnapshot } from "../skills/publication-types.ts";

export interface SkillReviewVerification {
  readonly licenseChecked: true;
  readonly behaviorChecked: true;
  /** Every tool without platform task evidence must be explicitly acknowledged. This never upgrades evidence. */
  readonly acknowledgedCompatibility: readonly SkillCandidateEvidence["compatibility"][number]["agentId"][];
}
export type SkillReviewStatus = "pending" | "changes_requested" | "approved" | "rejected" | "published";
export interface SkillReview extends SkillPublicationTarget {
  readonly reviewId: string;
  readonly candidateRevision: number;
  readonly contentHash: string;
  readonly manifestHash: string;
  readonly recordedBy: string;
  readonly evidence: SkillCandidateEvidence;
  readonly revision: number;
  readonly status: SkillReviewStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly reason: string | null;
  readonly verification: SkillReviewVerification | null;
  readonly publicationRevision: number | null;
  readonly publishedAt: string | null;
}
export interface SkillReviewExpectation {
  readonly expectedCandidateRevision: number;
  readonly expectedContentHash: string;
  readonly expectedManifestHash: string;
}
export interface SkillReviewAudit extends SkillPublicationTarget {
  readonly auditId: string;
  readonly action: "skill_registered" | "skill_approved" | "skill_changes_requested" | "skill_rejected" | "skill_published" | "skill_withdrawn";
  readonly reviewId: string | null;
  readonly actorId: string;
  readonly candidateRevision: number;
  readonly contentHash: string;
  readonly manifestHash: string;
  readonly recordedBy: string;
  readonly evidence: SkillCandidateEvidence;
  readonly reviewedBy: string | null;
  readonly selfReviewed: boolean;
  readonly reviewRevision: number | null;
  readonly verification: SkillReviewVerification | null;
  readonly reason: string | null;
  readonly occurredAt: string;
  readonly requestId: string;
  readonly operationId: string | null;
  readonly resultRevision: number | null;
}
export interface SkillReviewTransaction extends SqlExecutor {
  listReviews(status?: SkillReviewStatus, limit?: number): Promise<readonly SkillReview[]>;
  /** Nonlocking peek resolves only target; always reread after the M10 candidate lock. */
  getReview(reviewId: string, lock?: boolean): Promise<SkillReview | null>;
  findReview(target: SkillPublicationTarget, candidateRevision: number): Promise<SkillReview | null>;
  insertReview(review: SkillReview): Promise<void>;
  saveReview(review: SkillReview, expectedRevision: number): Promise<void>;
  appendAudit(audit: SkillReviewAudit): Promise<void>;
  /** Actor-scoped operation key precedes candidate and review row locks. */
  lockWithdrawal(actorId: string, operationId: string): Promise<void>;
  findWithdrawal(actorId: string, operationId: string): Promise<SkillReviewAudit | null>;
}
export interface SkillReviewRepository {
  transaction<T>(work: (tx: SkillReviewTransaction) => Promise<T>): Promise<T>;
  listReviews(status?: SkillReviewStatus, limit?: number): Promise<readonly SkillReview[]>;
}
export interface SkillReviewDependencies {
  readonly repository: SkillReviewRepository;
  readonly skills: SkillPublicationPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Site composition may recheck session/account/roles inside this same SQL transaction. */
  readonly assertActorCurrent?: (tx: SqlExecutor, actor: Actor, requestId: string) => Promise<void>;
}
export interface SkillReviewDetail { readonly review: SkillReview; readonly candidate: SkillReviewSnapshot }
