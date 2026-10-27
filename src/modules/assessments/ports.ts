import type { SqlExecutor } from "../../shared/persistence.ts";
import type { AssessmentAttempt, AssessmentEvent, AssessmentScore, AssignmentContextSnapshot, AssignmentHead, AssignmentVersion, QuestionSet, RubricVersion, ScoringJob } from "./types.ts";

export interface QuestionCatalogPort {
  getQuestionSet(id: string, transaction?: SqlExecutor): Promise<QuestionSet | null>;
  getRubric(id: string, transaction?: SqlExecutor): Promise<RubricVersion | null>;
}
/** Consent/version metadata only; no answers, profile, evidence or scores. */
export interface SharedSummaryReference {
  readonly attemptId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly revision: number;
}
/** All mutations are atomic CAS. A null expected revision means insert only. */
export interface AssessmentTransaction {
  readonly sql?: SqlExecutor;
  getAttempt(id: string): Promise<AssessmentAttempt | null>;
  listAttempts(projectId: string): Promise<readonly AssessmentAttempt[]>;
  listSharedSummaryRefs(projectId: string): Promise<readonly SharedSummaryReference[]>;
  listOwnAttempts(projectId: string, userId: string, membershipId: string): Promise<readonly AssessmentAttempt[]>;
  saveAttempt(attempt: AssessmentAttempt, expectedRevision: number | null): Promise<void>;
  getScores(attemptId: string): Promise<readonly AssessmentScore[]>;
  insertScore(score: AssessmentScore): Promise<void>;
  getJob(id: string): Promise<ScoringJob | null>;
  findJob(attemptId: string, userId: string, idempotencyKey: string): Promise<ScoringJob | null>;
  saveJob(job: ScoringJob, expectedRevision: number | null): Promise<void>;
  getAssignment(id: string): Promise<AssignmentVersion | null>;
  saveAssignment(version: AssignmentVersion, expectedRevision: number | null): Promise<void>;
  /** Pass false for history reads so an empty archived project gets no new head row. */
  getHead(projectId: string, initialize?: boolean): Promise<AssignmentHead>;
  saveHead(head: AssignmentHead, expectedRevision: number): Promise<void>;
  appendEvent(event: AssessmentEvent): Promise<void>;
}
export interface AssessmentRepository {
  transaction<T>(work: (transaction: AssessmentTransaction) => Promise<T>): Promise<T>;
}
/** With a SQL executor, lock M02/M03 authoritative inputs until this transaction commits.
 * It must include current project stage/readOnly, member roles/status and availability revisions,
 * official track selection/requirements and current opt-in intention revisions/fields.
 * Production composition must provide state even though old snapshots/fixtures may omit it.
 * No private answers.
 */
export interface AssignmentContextPort {
  getSnapshot(projectId: string, transaction?: SqlExecutor): Promise<AssignmentContextSnapshot>;
}
/** Called by a trusted worker. The adapter receives only the attempt author's private data. */
export interface AssessmentScorerPort {
  readonly provenance: "model" | "test_fixture";
  score(input: { readonly attempt: AssessmentAttempt; readonly correctionReason: string | null }, signal: AbortSignal): Promise<unknown>;
}
/** Structural contract implemented by the root's budgeted, authenticated transport.
 * The module never reads credentials, performs network retries or imports server internals.
 */
export interface JsonModelPort {
  readonly modelVersion: string;
  completeJSON(input: {
    readonly systemPrompt: string;
    readonly input: unknown;
    readonly promptVersion: string;
    readonly outputExample?: unknown;
    readonly maxOutputTokens?: number;
  }, signal: AbortSignal): Promise<{
    readonly content: unknown;
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
    readonly requestId: string | null;
    readonly modelVersion: string;
  }>;
}
export interface AssignmentSuggestionPort {
  suggest(input: {
    readonly context: AssignmentContextSnapshot;
    readonly summaries: readonly import("./types.ts").TeamAssessmentSummary[];
    readonly targetDeliverables: readonly string[];
  }, signal: AbortSignal): Promise<unknown>;
}
