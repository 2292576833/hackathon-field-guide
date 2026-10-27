import type { Actor, JobStatus, PageResult, ProjectMembershipAccess } from "../../shared/contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { EventRuleVersion, RuleChange } from "./domain.ts";

export type PublicationStatus = "draft" | "pending_review" | "published" | "archived";
export interface EventRecord {
  id: string;
  revision: number;
  publicationStatus: PublicationStatus;
  candidateVersion: number;
  publishedVersion: number | null;
  lastVerifiedAt: string | null;
}
export interface PublicEvent {
  event: EventRecord;
  rules: EventRuleVersion;
}
export interface EventFilter {
  query?: string;
  format?: "online" | "offline" | "hybrid" | "unknown";
  region?: string;
  beginnerEligibility?: "verified" | "unknown";
  phase?: "registration" | "active" | "awaiting_submission" | "ended" | "unknown";
  cursor?: string;
  limit?: number;
}
export interface ProjectRuleConfirmation {
  projectId: string;
  eventId: string;
  rulesVersion: number;
  revision: number;
  analysisId: string | null;
  confirmedBy: string;
  confirmedAt: string;
}
/** Saved comparison returned by GET /api/v1/projects/:id/rules/changes. */
export interface ProjectRuleChanges {
  confirmation: ProjectRuleConfirmation | null;
  latestVersion: number | null;
  changes: RuleChange[];
  needsConfirmation: boolean;
  publicationUnavailable?: boolean;
}
export interface AnalysisFact { statement: string; evidenceIds: string[] }
export interface AnalysisSuggestion { text: string; evidenceIds: string[]; backgroundKeys: string[] }
export interface AnalysisContent {
  facts: AnalysisFact[];
  suggestions: AnalysisSuggestion[];
  unknowns: { field: string; question: string }[];
  checklist: { requirementId: string; action: string }[];
}
export interface AnalysisInput {
  projectId: string;
  eventId: string;
  rulesVersion: number;
  backgroundVersion: number;
  background: Record<string, string>;
}
export interface EventAnalysis {
  id: string;
  projectId: string;
  eventId: string;
  rulesVersion: number;
  backgroundVersion: number;
  inputHash: string;
  input: AnalysisInput;
  content: AnalysisContent | null;
  status: "draft" | "confirmed" | "superseded";
  origin: "manual" | "model";
  modelVersion: string | null;
  promptVersion: string | null;
  revision: number;
  createdBy: string;
  createdAt: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
}
export interface AnalysisRun {
  id: string;
  analysisId: string;
  projectId: string;
  actorId: string;
  idempotencyKey: string;
  inputHash: string;
  status: JobStatus;
  attempts: number;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  providerRequestId?: string | null;
  revision: number;
}
export interface EventCorrection {
  id: string;
  eventId: string;
  rulesVersion: number;
  field: string;
  explanation: string;
  sourceUrl: string | null;
  submittedBy: string;
  submittedAt: string;
  status: "submitted" | "reviewed" | "resolved" | "dismissed";
}
export interface EventsAudit {
  id: string;
  type: "EventPublished" | "EventRulesChanged" | "ProjectRequirementsConfirmed" | "EventCorrectionSubmitted";
  aggregateId: string;
  projectId: string | null;
  version: number;
  actorId: string;
  occurredAt: string;
  /** Exact rule snapshot carried by the outbox, independent of aggregate revision. */
  rulesEventId: string;
  rulesVersion: number;
}
/** M02 adapter locks active membership in the same transaction as a private mutation. */
export interface ProjectWriteAccessPort {
  getMembershipForUpdate(executor: SqlExecutor | undefined, projectId: string, userId: string): Promise<ProjectMembershipAccess | null>;
}
/** M02 exposes its current team-background revision; never infer it from a report. */
export interface ProjectBackgroundVersionPort {
  getCurrentBackgroundVersion(projectId: string): Promise<number | null>;
}
export interface AnalysisModelPort {
  readonly modelVersion: string;
  readonly promptVersion: string;
  generate(input: { rules: EventRuleVersion; background: Record<string, string> }, signal: AbortSignal): Promise<{
    content: unknown;
    usage?: { inputTokens: number; outputTokens: number };
    providerRequestId?: string | null;
    modelVersion?: string;
  }>;
}
export interface EventsUnitOfWork {
  readonly executor?: SqlExecutor;
  getEvent(id: string): Promise<EventRecord | null>;
  saveEvent(event: EventRecord, expectedRevision: number): Promise<void>;
  getRules(eventId: string, version: number): Promise<EventRuleVersion | null>;
  insertRules(rules: EventRuleVersion): Promise<void>;
  getConfirmation(projectId: string): Promise<ProjectRuleConfirmation | null>;
  saveConfirmation(value: ProjectRuleConfirmation, expectedRevision: number): Promise<void>;
  getAnalysis(id: string): Promise<EventAnalysis | null>;
  saveAnalysis(value: EventAnalysis, expectedRevision: number): Promise<void>;
  getRun(id: string): Promise<AnalysisRun | null>;
  findRun(projectId: string, actorId: string, key: string): Promise<AnalysisRun | null>;
  saveRun(value: AnalysisRun, expectedRevision: number): Promise<void>;
  insertCorrection(value: EventCorrection): Promise<void>;
  appendAudit(value: EventsAudit): Promise<void>;
}
export interface EventsRepository extends EventsUnitOfWork {
  transaction<T>(work: (transaction: EventsUnitOfWork) => Promise<T>): Promise<T>;
  listPublished(filter: EventFilter, now: Date): Promise<PageResult<PublicEvent>>;
  /** Server worker discovery only; ordinary HTTP handlers must not expose it. */
  listAnalysisRuns?(status: "queued" | "running", limit: number): Promise<readonly AnalysisRun[]>;
}
export type EventsActor = Actor;
