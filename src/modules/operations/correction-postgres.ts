import type { DatabasePort, SqlExecutor, SqlResult } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import type { Correction, CorrectionOriginal, CorrectionRepository, CorrectionStatus, CorrectionTransaction } from "./correction-types.ts";

type State = Omit<Correction, "original" | "submittedBy">;
interface Row { readonly owner_id: string; readonly original: CorrectionOriginal; readonly state: State }
function fromRow(row: Row): Correction { return { ...row.state, submittedBy: row.owner_id, original: row.original }; }
function state(record: Correction): State {
  const { original: _original, submittedBy: _submittedBy, ...current } = record;
  return current;
}
function transaction(sql: SqlExecutor): CorrectionTransaction {
  return {
    query<RowType = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]): Promise<SqlResult<RowType>> { return sql.query<RowType>(statement, parameters); },
    async getCorrection(id) {
      const result = await sql.query<Row>("SELECT owner_id, original, state FROM operations_corrections WHERE id = $1 FOR UPDATE", [id]);
      return result.rows[0] ? fromRow(result.rows[0]) : null;
    },
    async insertCorrection(record) {
      await sql.query("INSERT INTO operations_corrections (id, owner_id, revision, status, updated_at, original, state) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)", [record.id, record.submittedBy, record.revision, record.status, record.updatedAt, JSON.stringify(record.original), JSON.stringify(state(record))]);
    },
    async saveCorrection(record, expectedRevision) {
      // Original submission/owner are never part of an UPDATE assignment.
      const result = await sql.query("UPDATE operations_corrections SET revision = $2, status = $3, updated_at = $4, state = $5::jsonb WHERE id = $1 AND revision = $6 AND owner_id = $7", [record.id, record.revision, record.status, record.updatedAt, JSON.stringify(state(record)), expectedRevision, record.submittedBy]);
      if (result.rowCount !== 1) throw new DomainError("VERSION_CONFLICT", "纠错状态已更新，请重新查看。", { status: 409, recoveryAction: "review_latest_version" });
    },
    async appendTransition(transition) {
      await sql.query("INSERT INTO operations_correction_transitions (id, correction_id, revision, actor_id, occurred_at, payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [transition.id, transition.correctionId, transition.revision, transition.actorId, transition.occurredAt, JSON.stringify(transition)]);
    },
  };
}
/** Original and owner columns are immutable; transitions are append-only facts. */
export class PostgresCorrectionRepository implements CorrectionRepository {
  readonly database: DatabasePort;
  constructor(database: DatabasePort) { this.database = database; }
  transaction<T>(work: (tx: CorrectionTransaction) => Promise<T>): Promise<T> {
    return this.database.transaction(sql => work(transaction(sql)));
  }
  async listOwn(userId: string, limit: number): Promise<readonly Correction[]> {
    const result = await this.database.query<Row>("SELECT owner_id, original, state FROM operations_corrections WHERE owner_id = $1 ORDER BY updated_at DESC, id DESC LIMIT $2", [userId, limit]);
    return result.rows.map(fromRow);
  }
  async listQueue(status?: CorrectionStatus, limit = 50): Promise<readonly Correction[]> {
    const result = await this.database.query<Row>("SELECT owner_id, original, state FROM operations_corrections WHERE ($1::text IS NULL OR status = $1) ORDER BY updated_at ASC, id ASC LIMIT $2", [status ?? null, limit]);
    return result.rows.map(fromRow);
  }
}
