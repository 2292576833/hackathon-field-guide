import type { Actor, ProjectMembershipAccess } from "../../shared/contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { ShareSourceReference, TaskActivity, VerifiedShareSource } from "./types.ts";

export interface TeamCollaborationAccessPort {
  /** Root verifies current account/session and locks project + active M02 membership using this executor. */
  lockAccess(projectId: string, actor: Actor, transaction: SqlExecutor): Promise<{ membership: ProjectMembershipAccess; readOnly: boolean }>;
  /** Root opens one ambient transaction and locks planning/assessment/project before the feed writer.
   * work MUST reuse that transaction (nested module transactions use savepoints, not a new connection).
   * Reads deliberately do not enter this mutation scope.
   */
  withMutationScope?<T>(projectId: string, actor: Actor, work: () => Promise<T>): Promise<T>;
}
export interface TeamShareSourcePort {
  /** Validate actual saved source owner, kind, project scope, successful provider output and withdrawal.
   * ownerUserId is the recorded author on reads; MUST NOT let the reader choose arbitrary private sources.
   * Return metadata only. Manual has sourceId:null and is fixed as a member note, never AI-labelled.
   * Root protects source rows through commit. Null suppresses shared content without disclosing why.
   */
  verifySource(input: { projectId: string; actor: Actor; ownerUserId: string; source: ShareSourceReference }, transaction: SqlExecutor): Promise<VerifiedShareSource | null>;
  /** Extra current-facts validation for a NEW publication, after a receipt miss and before insert.
   * Called twice before any write; never used for replay, edits, adoption or shared-context reads.
   * Must be read-only and free of model calls. Throw to roll back stale/invalid publication.
   */
  validateNewPublication?(input: { projectId: string; actor: Actor; source: ShareSourceReference }, transaction: SqlExecutor): Promise<void>;
}
export interface TeamTaskActivityPort {
  /** Read current authorized M05 progress with this executor; chronological projection only. */
  readActivities(projectId: string, actor: Actor, transaction: SqlExecutor, limit: number): Promise<readonly TaskActivity[]>;
}
