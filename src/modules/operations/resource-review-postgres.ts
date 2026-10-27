import type { DatabasePort, SqlExecutor, SqlResult } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import type { ResourceReview, ResourceReviewAudit, ResourceReviewRepository, ResourceReviewStatus, ResourceReviewTransaction } from "./resource-review-types.ts";

function conflict(): never {
  throw new DomainError("VERSION_CONFLICT", "资源核验已更新，请重新加载。", { status: 409, recoveryAction: "review_latest_version" });
}
/** Stores M08 metadata and audit only, never M09 content/category/bookmark rows. */
function transaction(sql: SqlExecutor): ResourceReviewTransaction {
  return {
    query<Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]): Promise<SqlResult<Row>> { return sql.query<Row>(statement, parameters); },
    async getReview(id, lock = true) {
      const result = await sql.query<{ payload: ResourceReview }>(`SELECT payload FROM operations_resource_reviews WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
      return result.rows[0]?.payload ?? null;
    },
    async findReview(resourceId, resourceRevision) {
      const result = await sql.query<{ payload: ResourceReview }>("SELECT payload FROM operations_resource_reviews WHERE resource_id = $1 AND resource_revision = $2 FOR UPDATE", [resourceId, resourceRevision]);
      return result.rows[0]?.payload ?? null;
    },
    async insertReview(review) {
      const result = await sql.query("INSERT INTO operations_resource_reviews (id, resource_id, resource_revision, revision, status, updated_at, payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (resource_id, resource_revision) DO NOTHING", [review.id, review.resourceId, review.resourceRevision, review.revision, review.status, review.updatedAt, JSON.stringify(review)]);
      if (result.rowCount !== 1) conflict();
    },
    async saveReview(review, expectedRevision) {
      const result = await sql.query("UPDATE operations_resource_reviews SET revision = $2, status = $3, updated_at = $4, payload = $5::jsonb WHERE id = $1 AND revision = $6 AND resource_id = $7 AND resource_revision = $8", [review.id, review.revision, review.status, review.updatedAt, JSON.stringify(review), expectedRevision, review.resourceId, review.resourceRevision]);
      if (result.rowCount !== 1) conflict();
    },
    async appendAudit(audit) {
      const result = await sql.query("INSERT INTO operations_resource_review_audit (id, resource_id, review_id, actor_id, operation_id, occurred_at, payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (actor_id, operation_id) WHERE operation_id IS NOT NULL DO NOTHING", [audit.id, audit.resourceId, audit.reviewId, audit.actorId, audit.operationId, audit.occurredAt, JSON.stringify(audit)]);
      // A concurrent same-key caller rolls back M09 as well, then may retry.
      if (result.rowCount !== 1) conflict();
    },
    async findWithdrawal(actorId, operationId) {
      const result = await sql.query<{ payload: ResourceReviewAudit }>("SELECT payload FROM operations_resource_review_audit WHERE actor_id = $1 AND operation_id = $2 FOR UPDATE", [actorId, operationId]);
      return result.rows[0]?.payload ?? null;
    },
    async lockWithdrawal(actorId, operationId) {
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [JSON.stringify(["resource-withdraw", actorId, operationId])]);
    },
  };
}
export class PostgresResourceReviewRepository implements ResourceReviewRepository {
  readonly database: DatabasePort;
  constructor(database: DatabasePort) { this.database = database; }
  transaction<T>(work: (tx: ResourceReviewTransaction) => Promise<T>): Promise<T> {
    return this.database.transaction(sql => work(transaction(sql)));
  }
  async listReviews(status?: ResourceReviewStatus, limit = 50): Promise<readonly ResourceReview[]> {
    const result = await this.database.query<{ payload: ResourceReview }>("SELECT payload FROM operations_resource_reviews WHERE ($1::text IS NULL OR status = $1) ORDER BY updated_at DESC, id DESC LIMIT $2", [status ?? null, limit]);
    return result.rows.map(row => row.payload);
  }
}
