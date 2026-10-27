import type { SqlExecutor } from "../../shared/persistence.ts";
import type { SuggestionReceipt, TeamSuggestion } from "./types.ts";

export interface SuggestionAudit {
  id: string; projectId: string; suggestionId: string; actorUserId: string;
  action: "published" | "edited" | "withdrawn" | "adopted";
  revision: number; occurredAt: string;
}
export interface TeamCollaborationTransaction {
  readonly sql: SqlExecutor;
  get(id: string): Promise<TeamSuggestion | null>;
  list(limit: number): Promise<TeamSuggestion[]>;
  insert(suggestion: TeamSuggestion, audit: SuggestionAudit): Promise<void>;
  replace(suggestion: TeamSuggestion, expectedRevision: number, audit: SuggestionAudit): Promise<void>;
  getReceipt(scope: string, key: string, fingerprint: string): Promise<SuggestionReceipt | null>;
  putReceipt(scope: string, key: string, fingerprint: string, receipt: SuggestionReceipt): Promise<void>;
}
export interface TeamCollaborationRepository {
  /** Serializes first-use and updates per project; thrown errors roll back all writes. */
  transaction<T>(projectId: string, work: (transaction: TeamCollaborationTransaction) => Promise<T>): Promise<T>;
  /** Read-only work: do not acquire the feed writer lock before root's M02/context locks.
   * Services never insert/replace in this callback; root access/source locks protect the snapshot.
   */
  readTransaction?<T>(projectId: string, work: (transaction: TeamCollaborationTransaction) => Promise<T>): Promise<T>;
}
