import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { Actor } from "../../shared/contracts.ts";
import type { FixedSkillReference, ReviewedSkillOption } from "../skills/index.ts";
import type { InputVersions, PlanningEvent, PlanningInput, PlanningResourceRef, PlanningState } from "./types.ts";

/** M02/M03/M04 composition supplies facts, never AI output or caller-provided identities. */
export interface PlanningFactsPort {
  readInput(projectId: string, now: string, actor: Actor): Promise<PlanningInput>;
  /** Re-read and protect version facts for the entire application transaction. */
  lockVersions(projectId: string, transaction: SqlExecutor, actor: Actor): Promise<InputVersions>;
}
export interface PlanningResourcePort {
  /** When executor is provided, protect publication rows until the planning write commits. */
  getDisplayableApprovedIds(ids: readonly string[], transaction?: SqlExecutor): Promise<readonly string[]>;
  /** M09 getReviewedResources: return current public content, never working-draft revision. */
  getReviewedResources?(ids: readonly string[], transaction?: SqlExecutor): Promise<readonly { id: string; version: number }[]>;
  /** M09 semantics: every ref must exactly match the currently displayable approved public version. */
  validateResourceRefs?(refs: readonly PlanningResourceRef[], transaction?: SqlExecutor): Promise<readonly PlanningResourceRef[]>;
}
/** Root binds M10 lookup to this planning executor, protecting publication rows until commit. */
export interface PlanningReviewedSkillsPort {
  /** Validate the exact published version/hash/revision and required bundle members; never resolve latest. */
  get(reference: FixedSkillReference, transaction: SqlExecutor): Promise<ReviewedSkillOption>;
}
export interface PlanningTransaction {
  readonly sql: SqlExecutor;
  /** Scoped by project + actor + action; payload fingerprint must match on retries. */
  getIdempotent<T>(scope: string, key: string, fingerprint: string): Promise<T | null>;
  putIdempotent(scope: string, key: string, fingerprint: string, result: unknown): Promise<void>;
  save(state: PlanningState, expectedRevision: number): Promise<void>;
  emit(event: PlanningEvent): Promise<void>;
}
export interface PlanningRepository {
  read(projectId: string): Promise<PlanningState | null>;
  /** Serializes writers of one project, including first-use initialization. */
  transaction<T>(projectId: string, work: (state: PlanningState, transaction: PlanningTransaction) => Promise<T>): Promise<T>;
}
export interface PostgresPlanningDependencies { database: DatabasePort }
