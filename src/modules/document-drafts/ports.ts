import type { Actor, Clock } from "../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { DocumentDraft, DocumentDraftCollection, DraftPublication, DraftPublicationOutcome } from "./model.ts";

/** Root resolves this from the current request, never from client JSON. */
export type DocumentDraftSessionGuard = (sql: SqlExecutor) => Promise<void>;

export interface DocumentDraftAuthorizationPort {
  /**
   * In this transaction, lock/recheck active account, current request session,
   * project and active membership. write=true also rejects archived projects.
   * The adapter must invoke guard(sql); no foreign tables are read by this module.
   */
  authorize(sql: SqlExecutor, actor: Actor, projectId: string, write: boolean, guard: DocumentDraftSessionGuard): Promise<void>;
}
export interface DocumentDraftDependencies extends DocumentDraftAuthorizationPort {
  readonly database: DatabasePort;
  readonly clock: Clock;
  readonly writer: DocumentDraftWriterPort;
  /** Default: only DomainError is known rolled back; all other failures remain unknown. */
  readonly classifyFailure?: (reason: unknown) => "known_failed" | "unknown";
}
export interface DocumentDraftWriterPort {
  /**
   * Root injects the actual spaceDocuments.create/update in this same transaction
   * (reuse sql/ambient executor; do not open another connection or make HTTP calls).
   * Source body/title/revision is exclusively the stored immutable publication.
   */
  write(sql: SqlExecutor, actor: Actor, projectId: string, input: {
    readonly documentId: string | null;
    readonly title: string;
    readonly body: string;
    readonly expectedRevision: number | null;
  }, guard: DocumentDraftSessionGuard): Promise<{ readonly id: string; readonly revision: number }>;
}
export interface DocumentDraftService {
  list(actor: Actor, projectId: string, guard: DocumentDraftSessionGuard): Promise<DocumentDraftCollection>;
  get(actor: Actor, projectId: string, documentId: string | null, guard: DocumentDraftSessionGuard): Promise<DocumentDraft>;
  save(actor: Actor, projectId: string, documentId: string | null, input: unknown, guard: DocumentDraftSessionGuard): Promise<DocumentDraft>;
  remove(actor: Actor, projectId: string, documentId: string | null, input: unknown, guard: DocumentDraftSessionGuard): Promise<DocumentDraft>;
  publish(actor: Actor, projectId: string, documentId: string | null, input: unknown, guard: DocumentDraftSessionGuard): Promise<DraftPublicationOutcome>;
  getPublication(actor: Actor, projectId: string, attemptId: string, guard: DocumentDraftSessionGuard): Promise<DraftPublication | null>;
}
