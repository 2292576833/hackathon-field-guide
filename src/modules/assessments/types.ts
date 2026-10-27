import type { Instant, JobStatus, MembershipStatus, ProjectRole } from "../../shared/contracts.ts";

export type TaskDimension = "requirements" | "design" | "development" | "testing" | "documentation" | "presentation";
export interface RubricCriterion {
  readonly id: string;
  readonly dimension: TaskDimension;
  readonly label: string;
  readonly weight: number;
  readonly maxScore: number;
  readonly anchors: readonly string[];
}
export interface RubricVersion {
  readonly id: string;
  readonly version: number;
  readonly criteria: readonly RubricCriterion[];
  readonly missingEvidencePolicy: "exclude_from_denominator";
  readonly limitations: readonly string[];
}
export interface AssessmentQuestion {
  readonly id: string;
  readonly taskTemplateId: string;
  readonly prompt: string;
  readonly criterionIds: readonly string[];
  readonly required: boolean;
}
export interface QuestionSet {
  readonly id: string;
  readonly version: number;
  readonly rubricVersionId: string;
  readonly status: "draft" | "reviewed" | "published" | "retired";
  readonly difficultyLabel: string;
  readonly allowedTools: readonly string[];
  readonly questions: readonly AssessmentQuestion[];
  readonly maxFollowUps: number;
  readonly limitations: readonly string[];
}
export interface AnswerEvidence {
  readonly id: string;
  readonly kind: "self_report" | "work_sample" | "verification_steps";
  readonly text: string;
  readonly url: string | null;
}
export interface AssessmentAnswer {
  readonly questionId: string;
  readonly text: string;
  readonly evidence: readonly AnswerEvidence[];
  readonly aiUsage: string;
}
export interface FollowUp {
  readonly id: string;
  readonly questionId: string;
  readonly criterionId: string;
  readonly prompt: string;
  readonly answer: string | null;
}
export interface MemberProfile {
  readonly experience: string;
  readonly tools: readonly string[];
  readonly preferredTasks: readonly TaskDimension[];
  readonly memberAvailabilityVersionId: string | null;
}
export type AttemptStatus = "draft" | "in_progress" | "submitted" | "scoring" | "completed" | "scoring_failed" | "cancelled" | "abandoned";
export interface SharingSelection {
  readonly confirmedTasks: readonly TaskDimension[];
  readonly criterionIds: readonly string[];
}
export interface AssessmentAttempt {
  readonly id: string;
  readonly projectId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly questionSetId: string;
  readonly rubricVersionId: string;
  readonly questionSetSnapshot: QuestionSet;
  readonly rubricSnapshot: RubricVersion;
  readonly profile: MemberProfile;
  readonly answers: readonly AssessmentAnswer[];
  readonly followUps: readonly FollowUp[];
  readonly sharing: SharingSelection;
  readonly status: AttemptStatus;
  readonly revision: number;
  readonly latestScoreId: string | null;
  readonly activeJobId: string | null;
  readonly scoringRuns: number;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly submittedAt: Instant | null;
}
export interface CriterionScore {
  readonly criterionId: string;
  readonly state: "scored" | "insufficient_evidence" | "not_applicable";
  readonly score: number | null;
  readonly evidenceRefs: readonly string[];
  readonly reason: string;
  readonly unverified: readonly string[];
}
export interface AssessmentScore {
  readonly id: string;
  readonly attemptId: string;
  readonly rubricVersionId: string;
  readonly criterionScores: readonly CriterionScore[];
  readonly limitations: readonly string[];
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly provenance: "model" | "test_fixture";
  readonly status: "published";
  readonly supersedesScoreId: string | null;
  readonly correctionReason: string | null;
  readonly validatedAt: Instant;
}
export interface DimensionResult {
  readonly dimension: TaskDimension;
  /** Sum of scored criteria's integer anchor points multiplied by their fixed rubric weights. */
  readonly earned: number;
  /** Sum of maximum anchor points using the same scored criteria and weights; unscored items are excluded. */
  readonly possible: number;
  readonly unscoredCriterionIds: readonly string[];
}
export interface ScoringJob {
  readonly id: string;
  readonly attemptId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly inputFingerprint: string;
  readonly status: JobStatus;
  readonly revision: number;
  readonly runNumber: number;
  readonly correctionReason: string | null;
  readonly createdAt: Instant;
  readonly startedAt: Instant | null;
  readonly finishedAt: Instant | null;
  readonly durationMs: number | null;
  readonly failureCode: string | null;
  readonly resultScoreId: string | null;
}
export interface TeamAssessmentSummary {
  readonly attemptId: string;
  readonly membershipId: string;
  readonly revision: number;
  readonly confirmedTasks: readonly TaskDimension[];
  readonly criterionScores: readonly (Pick<CriterionScore, "criterionId" | "state" | "score"> & {
    readonly dimension: TaskDimension;
    readonly label: string;
    readonly maxScore: number;
  })[];
  readonly rubricVersionId: string;
  readonly questionSetId: string;
  readonly provenance: "model" | "test_fixture" | null;
  readonly scoreMeaning: string;
  readonly limitations: readonly string[];
}
export interface ProjectMemberSnapshot {
  readonly membershipId: string;
  readonly userId: string;
  readonly role: ProjectRole;
  readonly status: MembershipStatus;
  readonly memberAvailabilityVersionId: string | null;
  /** M02 confirmed time windows, independent from any private assessment profile. */
  readonly availableMinutes?: number | null;
  /** Only fields explicitly shared by the author. Missing fields are not consent. */
  readonly sharedIntention?: SharedMemberIntentionSnapshot;
}
export interface SharedMemberIntentionSnapshot {
  readonly revision: number;
  readonly membershipRevision: number;
  readonly duties?: readonly (TaskDimension | "coordination" | "other")[];
  readonly experience?: string;
  readonly wantsAiHelp?: boolean;
  readonly helpQuestion?: string;
}
export interface AssignmentOfficialTracksSnapshot {
  readonly eventId: string;
  readonly rulesVersion: number;
  readonly confirmationRevision: number;
  readonly catalogStatus: "unknown" | "none" | "conflict" | "confirmed";
  readonly selectedTrackId: string | null;
  readonly needsReview: boolean;
  readonly tracks: readonly {
    readonly id: string;
    readonly name: string;
    readonly eligibility: { readonly text: string; readonly evidenceIds: readonly string[] } | null;
    readonly scoringFocus: { readonly text: string; readonly evidenceIds: readonly string[] } | null;
    readonly deliverables: readonly { readonly requirementId: string; readonly evidenceIds: readonly string[] }[];
    readonly evidenceIds: readonly string[];
  }[];
  readonly evidenceIds: readonly string[];
}
export interface AssignmentContextSnapshot {
  readonly projectId: string;
  /** Authoritative M02 state; optional only for older stored snapshots/test fixtures. */
  readonly stage?: string;
  readonly readOnly?: boolean;
  readonly projectRevision: number;
  readonly membershipRevision: number;
  readonly requirementVersionId: string | null;
  /** Undefined in legacy snapshots; production composition supplies current M02/M03 facts. */
  readonly officialTracks?: AssignmentOfficialTracksSnapshot | null;
  readonly trackSelectionRevision?: number | null;
  readonly memberIntentionRefs?: readonly { readonly membershipId: string; readonly revision: number }[];
  readonly confirmedRequirements?: readonly { readonly id: string; readonly text: string; readonly evidenceIds: readonly string[] }[];
  readonly members: readonly ProjectMemberSnapshot[];
}
export interface AssignmentInputSnapshot extends AssignmentContextSnapshot {
  readonly sharedSummaryRefs: readonly { readonly attemptId: string; readonly revision: number }[];
}
export interface ProposedAssignment {
  readonly clientTaskId: string;
  readonly title: string;
  readonly priority: "must" | "optional";
  readonly ownerMembershipId: string | null;
  readonly helperMembershipIds: readonly string[];
  readonly deliverable: string;
  readonly acceptanceCriteria: readonly string[];
  readonly dependencyTaskIds: readonly string[];
  readonly proposedDeadlineRef: string | null;
  readonly reason: string;
  readonly evidenceLevel: "self_reported" | "assessed" | "verified" | "missing";
}
export interface AssignmentGap {
  readonly taskArea: string;
  readonly reason: string;
  readonly suggestions: readonly string[];
}
export interface AssignmentChange {
  readonly clientTaskId: string;
  readonly kind: "added" | "modified" | "removed";
  readonly fields: readonly string[];
}
export interface AssignmentVersion {
  readonly id: string;
  readonly projectId: string;
  readonly baseVersionId: string | null;
  readonly inputSnapshot: AssignmentInputSnapshot;
  readonly assignments: readonly ProposedAssignment[];
  readonly gaps: readonly AssignmentGap[];
  readonly assumptions: readonly string[];
  readonly changes: readonly AssignmentChange[];
  readonly validationIssues: readonly string[];
  readonly status: "draft" | "needs_changes" | "ready" | "applied" | "superseded";
  readonly revision: number;
  readonly createdBy: string;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly appliedBy: string | null;
  readonly appliedAt: Instant | null;
}
export interface AssignmentHead {
  readonly projectId: string;
  readonly versionId: string | null;
  readonly revision: number;
}
/** Read-time marker. It never rewrites immutable applied task facts. */
export interface AssignmentVersionView extends AssignmentVersion {
  readonly inputFreshness: "current" | "changed";
  readonly staleReason: string | null;
}
export interface AssessmentEvent {
  readonly eventId: string;
  readonly type: "AssessmentSubmitted" | "AssessmentScoringFailed" | "AssessmentSummaryUpdated" | "AssignmentApplied";
  readonly aggregateId: string;
  readonly projectId: string;
  readonly version: number;
  readonly occurredAt: Instant;
  readonly payload: Readonly<Record<string, string | number | null>>;
}
