import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { OwnerRetrospectiveIdentity, OwnerRetrospectivePort } from "./edit-drafts.ts";
import { identifier, revision } from "./validation.ts";

/** Identity-only M07 projection. No document body or project evidence is read. */
export class PostgresOwnerRetrospectivePort implements OwnerRetrospectivePort {
  private readonly database: SqlExecutor;
  constructor(database: SqlExecutor) { this.database = database; }
  async readIdentity(input: { actor: Actor; projectId: string; documentId: string }, transaction?: SqlExecutor): Promise<OwnerRetrospectiveIdentity | null> {
    const ownerId = identifier(input.actor.userId), projectId = identifier(input.projectId), id = identifier(input.documentId);
    const result = await (transaction ?? this.database).query<{ id: string; project_id: string; owner_id: string; revision: number | string }>(
      `SELECT id, project_id, owner_id, revision FROM m07_documents
       WHERE id = $1 AND owner_id = $2 AND project_id = $3 AND kind = 'retrospective'${transaction ? " FOR UPDATE" : ""}`,
      [id, ownerId, projectId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (result.rows.length !== 1 || row.id !== id || row.owner_id !== ownerId || row.project_id !== projectId) throw new DomainError("FINAL_FACTS_INVALID", "复盘身份投影归属不一致。", { status: 503 });
    return { id, ownerId, projectId, revision: revision(Number(row.revision)) };
  }
}
