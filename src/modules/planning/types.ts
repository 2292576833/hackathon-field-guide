import type { ProjectMembershipAccess } from "../../shared/contracts.ts";
import type { TaskSkillReference } from "../skills/index.ts";
import type { PlanningGenerationProvenance } from "./generation-types.ts";

/** Child windows of M02 MemberAvailability; this module never stores a second collection. */
export interface AvailabilityWindow {
  id: string;
  projectId: string;
  membershipId: string;
  startsAt: string;
  endsAt: string;
  sourceTimeZone: string;
  purpose: "work" | "rest" | "occupied";
  version: number;
}
export interface MemberAvailabilityInput {
  membershipId: string;
  version: number;
  confirmedAt: string | null;
  windows: AvailabilityWindow[];
}
export interface DurationEstimate {
  optimisticMinutes: number;
  likelyMinutes: number;
  pessimisticMinutes: number;
  basis: string;
}
export type TaskStatus = "todo" | "in_progress" | "blocked" | "review" | "done" | "cancelled";
export type TaskKind = "implementation" | "learning" | "debugging" | "handoff" | "integration" | "testing" | "material" | "submission";
export interface Acceptance {
  acceptedByUserId: string;
  acceptedAt: string;
  mode: "reviewer" | "manager" | "self_check";
  evidenceRefs: string[];
  note: string;
}
/** M09 public content version, filled and checked by the server. Never a review assertion from JSON. */
export interface PlanningResourceRef { resourceId: string; version: number }
export interface PlanningTask {
  id: string;
  projectId: string;
  title: string;
  priority: "must" | "optional";
  kind: TaskKind;
  ownerMembershipId: string | null;
  helperEfforts: { membershipId: string; durationEstimate: DurationEstimate }[];
  deliverable: string;
  acceptanceCriteria: string[];
  reviewerMembershipId: string | null;
  durationEstimate: DurationEstimate;
  remainingEstimate: DurationEstimate | null;
  dependencyTaskIds: string[];
  deadlineRef: string;
  requirementRefs: string[];
  resourceRefs: string[];
  /** Optional only for legacy records. IDs remain the compatible UI input; these pin the actual basis. */
  resourceContentRefs?: PlanningResourceRef[];
  /** Optional for legacy tasks. Fixed M10 versions; learning is part of durationEstimate. */
  skillRefs?: TaskSkillReference[];
  splittable: boolean;
  /** Minutes of work reserved whenever split work resumes in a later window. */
  contextSwitchMinutes: number;
  /** Elapsed external waiting after work; never counted as human capacity. */
  waitMinutes: number;
  status: TaskStatus;
  blocker: string | null;
  cancellationReason: string | null;
  acceptance: Acceptance | null;
  revision: number;
  updatedAt: string;
}
export interface PlanningDeadline {
  id: string;
  kind: "registration" | "submission" | "video" | "demo" | "supplement" | "other";
  instantUtc: string;
  sourceTimeZone: string;
  sourceText: string;
  verified: boolean;
}
export interface PlanningRequirement {
  id: string;
  deadlineRef: string;
  description: string;
  mandatory: boolean;
}
export interface BufferPolicy {
  deadlineId: string;
  reservedMinutes: number;
  basis: string;
}
export interface InputVersions {
  projectRevision: number;
  /** Server projection of locked project/member planning facts, excluding navigation stage.
   * Legacy adapters and stored snapshots omit it and retain revision comparison. */
  projectFactsVersion?: string;
  requirementVersionId: string | null;
  assignmentVersionId: string | null;
  /** M02 project selection and each intention revision, including withdrawn sharing. */
  trackSelectionRevision?: number | null;
  memberIntentionRefs?: { membershipId: string; revision: number }[];
  availabilityVersions: Record<string, number>;
  /** Current public content heads for resources in this snapshot; null means unavailable. */
  resourceContentVersions?: Record<string, number | null>;
  /** Optional for old adapters. Supply both from the final locked M02 snapshot when applicable. */
  projectArchived?: boolean;
  projectReadOnly?: boolean;
}
export interface PlanningInput extends InputVersions {
  projectId: string;
  capturedAt: string;
  members: ProjectMembershipAccess[];
  availability: MemberAvailabilityInput[];
  deadlines: PlanningDeadline[];
  requirements: PlanningRequirement[];
  approvedResourceIds: string[];
  assumptions: string[];
  /** Explicit per-project policy; absent phases remain unknown, never assumed free. */
  requiredTaskKinds: TaskKind[];
}
export interface TimeSegment { startsAt: string; endsAt: string }
export interface ScheduledTask {
  taskId: string;
  startsAt: string;
  finishesAt: string;
  allocations: { membershipId: string; segments: TimeSegment[]; workMinutes: number; overheadMinutes: number }[];
}
export interface PlanningIssue {
  code: string;
  severity: "error" | "unknown" | "risk";
  message: string;
  taskIds: string[];
  membershipId?: string;
  deadlineId?: string;
  chain?: string[];
  missingMinutes?: number;
  resourceIds?: string[];
  referenceVersion?: number;
  currentVersion?: number | null;
  suggestion: string;
}
export type Feasibility = "unknown" | "feasible" | "at_risk" | "infeasible";
export interface ScheduleResult {
  scheduled: ScheduledTask[];
  issues: PlanningIssue[];
  capacityMinutes: Record<string, number>;
}
export interface ValidationResult {
  structuralValid: boolean;
  feasibility: Feasibility;
  issues: PlanningIssue[];
  likely: ScheduleResult;
  pessimistic: ScheduleResult;
  checkedAt: string;
  staleInputs: boolean;
}
export interface PlanChange {
  taskId: string | null;
  action: "added" | "removed" | "changed" | "buffer_changed" | "input_changed";
  fields: string[];
  before: unknown;
  after: unknown;
  major: boolean;
  impact: string;
}
export type PlanStatus = "draft" | "validating" | "ready" | "needs_changes" | "applied" | "superseded" | "stale" | "generation_failed";
export interface PlanVersion {
  id: string;
  projectId: string;
  basePlanVersionId: string | null;
  baseTasksRevision: number;
  inputSnapshot: PlanningInput;
  tasks: PlanningTask[];
  buffers: BufferPolicy[];
  validation: ValidationResult | null;
  changes: PlanChange[];
  status: PlanStatus;
  reason: string;
  createdBy: string;
  createdAt: string;
  appliedBy: string | null;
  appliedAt: string | null;
  acknowledgedIssueCodes: string[];
  revision: number;
  /** Server-only provenance: newly selected/refreshed references must still match at apply. */
  resourceReviewRequiredRefs?: (PlanningResourceRef & { taskId: string })[];
  /** Proven legacy IDs from a trusted source, retained without inventing a historical version. */
  resourceLegacyRefs?: { taskId: string; resourceId: string }[];
  /** Generated suggestions remain manual-confirmation drafts; metadata is server supplied. */
  generation?: PlanningGenerationProvenance;
}
export interface ProgressUpdate {
  id: string;
  projectId: string;
  taskId: string;
  actorId: string;
  status: TaskStatus;
  remainingEstimate: DurationEstimate | null;
  blocker: string | null;
  evidenceRefs: string[];
  note: string;
  correctionOf: string | null;
  correctionReason: string | null;
  acceptance: Acceptance | null;
  createdAt: string;
  /** Append-only manager correction; prior acceptance is preserved in this history. */
  acceptanceCorrection?: {
    previousAcceptance: Acceptance;
    impactedTasks: { taskId: string; previousStatus: TaskStatus; previousAcceptance: Acceptance | null; status: TaskStatus }[];
  };
  /** A member's saved request; it changes no task status or acceptance fact. */
  correctionRequest?: { acceptanceProgressId: string; acceptance: Acceptance };
}
export interface CurrentPlanningView {
  plan: PlanVersion | null;
  tasks: PlanningTask[];
  tasksRevision: number;
  evaluation: ValidationResult | null;
  staleInputs: boolean;
  /** Unlike staleInputs, ordinary progress updates alone do not change input versions. */
  inputVersionsChanged: boolean;
  lastProgressAt: string | null;
}
export interface PlanningState {
  projectId: string;
  currentPlanVersionId: string | null;
  tasksRevision: number;
  tasks: PlanningTask[];
  plans: PlanVersion[];
  progressUpdates: ProgressUpdate[];
  revision: number;
}
export interface PlanningEvent {
  id: string;
  type: "PlanDraftGenerated" | "PlanApplied" | "ProgressUpdated" | "PlanRiskDetected";
  projectId: string;
  aggregateId: string;
  revision: number;
  occurredAt: string;
}
