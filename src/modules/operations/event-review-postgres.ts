import type { DatabasePort, SqlExecutor, SqlResult } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import type { EventReview, EventReviewAudit, EventReviewRepository, EventReviewStatus, EventReviewTransaction } from "./event-review-types.ts";

/** JSONB contains only M08 review metadata; no Event/RuleEvidence/Source content is copied. */
function makeTransaction(sql: SqlExecutor): EventReviewTransaction {
  return {
    query<Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]): Promise<SqlResult<Row>> { return sql.query<Row>(statement, parameters); },
    async getReview(id, lock = true) {
      const result = await sql.query<{ payload: EventReview }>(`SELECT payload FROM operations_event_reviews WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
      return result.rows[0]?.payload ?? null;
    },
    async findByCandidate(candidateId, lock = true) {
      const result = await sql.query<{ payload: EventReview }>(`SELECT payload FROM operations_event_reviews WHERE candidate_id = $1${lock ? " FOR UPDATE" : ""}`, [candidateId]);
      return result.rows[0]?.payload ?? null;
    },
    async insertReview(review) {
      const result = await sql.query("INSERT INTO operations_event_reviews (id, event_id, candidate_id, revision, status, updated_at, payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (candidate_id) DO NOTHING", [review.id, review.eventId, review.candidateId, review.revision, review.status, review.updatedAt, JSON.stringify(review)]);
      if (result.rowCount !== 1) throw new DomainError("VERSION_CONFLICT", "候选已进入审核队列，请重新加载。", { status: 409, recoveryAction: "review_latest_version" });
    },
    async saveReview(review, expectedRevision) {
      const result = await sql.query("UPDATE operations_event_reviews SET revision = $2, status = $3, updated_at = $4, payload = $5::jsonb WHERE id = $1 AND revision = $6", [review.id, review.revision, review.status, review.updatedAt, JSON.stringify(review), expectedRevision]);
      if (result.rowCount !== 1) throw new DomainError("VERSION_CONFLICT", "审核已更新，请重新查看。", { status: 409, recoveryAction: "review_latest_version" });
    },
    async appendAudit(audit: EventReviewAudit) {
      await sql.query("INSERT INTO operations_event_review_audit (id, event_id, review_id, occurred_at, payload) VALUES ($1,$2,$3,$4,$5::jsonb)", [audit.id, audit.eventId, audit.reviewId, audit.occurredAt, JSON.stringify(audit)]);
    },
  };
}

export class PostgresEventReviewRepository implements EventReviewRepository {
  readonly database: DatabasePort;
  constructor(database: DatabasePort) { this.database = database; }
  transaction<T>(work: (tx: EventReviewTransaction) => Promise<T>): Promise<T> {
    return this.database.transaction(sql => work(makeTransaction(sql)));
  }
  async listReviews(status?: EventReviewStatus, limit = 50): Promise<readonly EventReview[]> {
    const result = await this.database.query<{ payload: EventReview }>("SELECT payload FROM operations_event_reviews WHERE ($1::text IS NULL OR status = $1) ORDER BY updated_at DESC, id DESC LIMIT $2", [status ?? null, limit]);
    return result.rows.map(row => row.payload);
  }
}
