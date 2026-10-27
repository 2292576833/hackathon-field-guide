import type { Actor, Clock, IdGenerator, ProjectAccessPort, ProjectMembershipAccess } from "../../shared/contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { SkillUsage } from "./skill-usage.ts";

export type Scope = "personal" | "project";
export type EvidenceKind = "rule" | "plan" | "task" | "assignment" | "git_save" | "delivery_verification" | "submission" | "project_resource";
export interface EvidenceRef { kind: EvidenceKind; id: string; revision: number }
export interface EvidenceState {
  ref: EvidenceRef;
  projectId: string;
  state: "available" | "withdrawn" | "unavailable" | "outdated";
  projectShareable: boolean;
  /** Already filtered for the requested audience. No private source body. */
  title?: string;
}
export interface EvidenceAccessPort {
  resolve(actor: Actor, projectId: string, refs: readonly EvidenceRef[], audience: Scope): Promise<readonly EvidenceState[]>;
}
export interface ProjectStatePort { isArchived(projectId: string): Promise<boolean> }
export interface ReviewedResourcePort { isReviewed(resourceId: string): Promise<boolean> }

export type FinalWriteOperation = "retrospective.create" | "retrospective.update" | "retrospective.confirm" | "experience.create" | "experience.update" | "experience.confirm" | "experience.reuse" | "generation.enqueue" | "generation.complete";
export interface FinalEvidenceRequest { projectId: string; audience: Scope; refs: readonly EvidenceRef[] }
export interface FinalFactsLockRequest {
  actor: Actor;
  operation: FinalWriteOperation;
  /** Sorted, unique IDs; includes both source and target projects for reuse. */
  projectIds: readonly string[];
  evidence: readonly FinalEvidenceRequest[];
  resourceIds: readonly string[];
}
export interface FinalFactsSnapshot {
  projects: readonly { projectId: string; membership: ProjectMembershipAccess | null; archived: boolean }[];
  evidence: readonly { projectId: string; audience: Scope; states: readonly EvidenceState[] }[];
  reviewedResourceIds: readonly string[];
}
export interface FinalFactsLockPort {
  /** Use exactly the supplied SQL transaction. Lock all project membership/archive
   * mutation roots, evidence current sharing/revocation pointers and resource
   * publication roots in deterministic order; keep locks until caller commit.
   * Return fresh facts read through that executor, never cache/pool snapshots.
   * Missing/withdrawn facts are represented in the snapshot, not approved by default.
   * No nested transaction, network/model call, or M07 document write is allowed. */
  lock(request: FinalFactsLockRequest, transaction: SqlExecutor): Promise<FinalFactsSnapshot>;
}

export const answerKeys = ["goalAndOutcome", "blockerAndResponse", "helpfulPractice", "scopeReduction", "nextChange"] as const;
export type Answers = Record<typeof answerKeys[number], string>;
export interface ToolExperience {
  resourceId?: string;
  originalUrl?: string;
  usedFor: string;
  limitations: string;
  costAtUse: string;
  verifiedAt?: string;
  source: "member_record";
}
export interface RetrospectiveContent {
  answers: Answers;
  evidenceRefs: EvidenceRef[];
  tools: ToolExperience[];
  /** Member-reported historical use, never installation/compatibility evidence. */
  skillUsage?: SkillUsage[];
}
interface BaseDocument {
  id: string;
  projectId: string;
  ownerId: string;
  scope: Scope;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface GeneratedDraft {
  answers: Answers;
  evidenceRefs: EvidenceRef[];
  resourceIds: string[];
  modelVersion: string;
  promptVersion: "m07-v1";
}
export interface Retrospective extends BaseDocument {
  kind: "retrospective";
  status: "draft" | "generating" | "review_required" | "confirmed";
  content: RetrospectiveContent;
  generatedDraft?: GeneratedDraft;
  confirmedBy?: string;
  confirmedAt?: string;
  activeJobId?: string;
}
export interface ExperienceContent {
  title: string;
  scenario: string;
  advice: string[];
  conditions: string;
  limitations: string;
  evidenceRefs: EvidenceRef[];
  tools: ToolExperience[];
  skillUsage?: SkillUsage[];
}
export interface ExperienceCard extends BaseDocument {
  kind: "experience_card";
  status: "draft" | "confirmed" | "outdated" | "archived";
  content: ExperienceContent;
  sourceRetrospective?: { id: string; revision: number };
  confirmedBy?: string;
  confirmedAt?: string;
}
export const reusableFields = ["title", "scenario", "advice", "conditions", "limitations", "tools", "skillUsage"] as const;
export type ReusableField = typeof reusableFields[number];
export interface ReuseDraft extends BaseDocument {
  kind: "reuse_draft";
  scope: "personal";
  status: "draft";
  sourceCardId: string;
  sourceRevision: number;
  selectedFields: ReusableField[];
  /** No source body is persisted; every read rechecks source visibility. */
}
export interface GenerationInput {
  retrospectiveId: string;
  inputRevision: number;
  scope: Scope;
  answers: Answers;
  evidence: EvidenceState[];
  tools: ToolExperience[];
  reviewedResourceIds: string[];
  promptVersion: "m07-v1";
}
export interface GenerationJob extends BaseDocument {
  kind: "generation_job";
  retrospectiveId: string;
  inputRevision: number;
  status: "queued" | "running" | "succeeded" | "failed";
  attempts: number;
  errorCode?: string;
  finishedAt?: string;
}
export interface RetrospectiveModelPort {
  /** Must obey the instruction: organize supplied facts only; unknown is 无法确认;
   * no member ranking, traits, ability guarantees, or invented URLs/evidence. */
  generate(input: GenerationInput, signal: AbortSignal): Promise<unknown>;
}
export interface GenerationBudgetPort {
  /** Worker-side atomic, idempotent admission by jobId, outside fact locks.
   * Enforce configured capacity; the root transport ledger owns actual call costs.
   * enqueueGeneration only checks this port is configured, not a reservation. */
  reserve(input: { jobId: string; projectId: string; actorId: string; occurredAt: string }): Promise<void>;
}
export type Document = Retrospective | ExperienceCard | ReuseDraft | GenerationJob;
export interface AuditEvent {
  id: string;
  type: "RetrospectiveConfirmed" | "ExperienceCardConfirmed" | "ExperienceCardVisibilityChanged" | "ExperienceReused" | "DocumentEdited" | "PersonalDocumentDeleted" | "GenerationUpdated";
  aggregateId: string;
  projectId: string;
  actorId: string;
  revision: number;
  occurredAt: string;
}
export interface DocumentTransaction {
  /** PostgreSQL exposes its active executor; optional for existing test fixtures. */
  readonly sql?: SqlExecutor;
  get(id: string): Promise<Document | null>;
  getVersion(id: string, revision: number): Promise<Document | null>;
  insert(document: Document, event: AuditEvent): Promise<void>;
  /** Compare-and-swap, snapshot and audit are committed together. */
  replace(document: Document, expectedRevision: number, event: AuditEvent): Promise<void>;
  deletePersonal(id: string, ownerId: string, expectedRevision: number, event: AuditEvent): Promise<void>;
}
export interface RetrospectiveRepository extends DocumentTransaction {
  /** Project results still receive a current membership check in the service. */
  list(input: { ownerId: string; projectId?: string; kind: Document["kind"]; limit: number; afterId?: string; personalOnly?: boolean }): Promise<Document[]>;
  transaction<T>(work: (transaction: DocumentTransaction) => Promise<T>): Promise<T>;
}

/** These are projections of M06-owned facts, never M07 write models. */
export interface DeliveryFacts {
  saves: { id: string; projectId: string; revision: number; status: "draft" | "ready_for_preview" | "saving" | "saved" | "blocked" | "failed" | "unknown"; repositoryUrl: string; branch: string; commitSha: string | null; recordedAt: string }[];
  verifications: { id: string; projectId: string; version: number; outcome: "passed" | "failed" | "inconclusive"; verificationSource: "user_reported"; verifiedAt: string; environmentSummary: string; steps: string[]; blockers: string[]; evidenceRefs: string[]; repositoryCommitSha: string | null; verifierId: string }[];
  submissions: { id: string; projectId: string; version: number; eventId: string; stageId: string; requirementsVersion: string; status: "not_submitted" | "reported" | "verified" | "rejected_or_withdrawn"; verificationSource: "user_reported" | "platform_verified"; submittedAt: string | null; platformUrl: string; evidenceRefs: string[]; repositoryCommitSha: string | null; recordedBy: string; recordedAt: string }[];
  materials: { id: string; label: string; status: "missing" | "prepared" | "unknown" }[];
}
export interface DeliveryFactsPort { read(actor: Actor, projectId: string): Promise<DeliveryFacts> }
export interface DeliverySummary {
  repository: { label: string; records: DeliveryFacts["saves"] };
  execution: { label: string; records: DeliveryFacts["verifications"] };
  submission: { label: string; records: (DeliveryFacts["submissions"][number] & { sourceLabel: "队员记录" | "平台核验" })[] };
  materials: DeliveryFacts["materials"];
}
export interface Dependencies {
  repository: RetrospectiveRepository;
  access: ProjectAccessPort;
  projects: ProjectStatePort;
  evidence: EvidenceAccessPort;
  resources: ReviewedResourcePort;
  /** Required for writes when the repository transaction exposes a SQL executor. */
  finalFactsLock?: FinalFactsLockPort;
  delivery?: DeliveryFactsPort;
  model?: RetrospectiveModelPort;
  generationBudget?: GenerationBudgetPort;
  clock: Clock;
  ids: IdGenerator;
  /** A bounded worker call; no automatic retry. Default 20 seconds. */
  modelTimeoutMs?: number;
}
