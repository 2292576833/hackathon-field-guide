import type { DatabasePort, SqlExecutor, SqlResult } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import type { SkillReview, SkillReviewAudit, SkillReviewRepository, SkillReviewStatus, SkillReviewTransaction } from "./skill-review-types.ts";

function conflict(): never { throw new DomainError("VERSION_CONFLICT", "技能审核已更新，请重新读取最新版本。", { status: 409, recoveryAction: "review_latest_version" }); }
function transaction(sql: SqlExecutor): SkillReviewTransaction {
  return {
    query<Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]): Promise<SqlResult<Row>> { return sql.query<Row>(statement, parameters); },
    async listReviews(status, limit = 50) {
      const result = await sql.query<{ payload: SkillReview }>("SELECT payload FROM operations_skill_reviews WHERE ($1::text IS NULL OR status=$1) ORDER BY updated_at DESC,review_id DESC LIMIT $2", [status ?? null, limit]);
      return result.rows.map(row => row.payload);
    },
    async getReview(reviewId, lock = true) {
      const result = await sql.query<{ payload: SkillReview }>(`SELECT payload FROM operations_skill_reviews WHERE review_id = $1${lock ? " FOR UPDATE" : ""}`, [reviewId]);
      return result.rows[0]?.payload ?? null;
    },
    async findReview(target, candidateRevision) {
      const result = await sql.query<{ payload: SkillReview }>("SELECT payload FROM operations_skill_reviews WHERE target_kind = $1 AND target_id = $2 AND version_id = $3 AND candidate_revision = $4 FOR UPDATE", [target.kind, target.id, target.versionId, candidateRevision]);
      return result.rows[0]?.payload ?? null;
    },
    async insertReview(review) {
      const result = await sql.query("INSERT INTO operations_skill_reviews (review_id,target_kind,target_id,version_id,candidate_revision,content_hash,manifest_hash,revision,status,updated_at,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT (target_kind,target_id,version_id,candidate_revision) DO NOTHING", [review.reviewId, review.kind, review.id, review.versionId, review.candidateRevision, review.contentHash, review.manifestHash, review.revision, review.status, review.updatedAt, JSON.stringify(review)]);
      if (result.rowCount !== 1) conflict();
    },
    async saveReview(review, expectedRevision) {
      const result = await sql.query("UPDATE operations_skill_reviews SET revision=$2,status=$3,updated_at=$4,payload=$5::jsonb WHERE review_id=$1 AND revision=$6 AND target_kind=$7 AND target_id=$8 AND version_id=$9 AND candidate_revision=$10 AND content_hash=$11 AND manifest_hash=$12", [review.reviewId, review.revision, review.status, review.updatedAt, JSON.stringify(review), expectedRevision, review.kind, review.id, review.versionId, review.candidateRevision, review.contentHash, review.manifestHash]);
      if (result.rowCount !== 1) conflict();
    },
    async appendAudit(audit) {
      const result = await sql.query("INSERT INTO operations_skill_review_audit (audit_id,target_kind,target_id,version_id,review_id,actor_id,operation_id,occurred_at,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT (actor_id,operation_id) WHERE operation_id IS NOT NULL DO NOTHING", [audit.auditId, audit.kind, audit.id, audit.versionId, audit.reviewId, audit.actorId, audit.operationId, audit.occurredAt, JSON.stringify(audit)]);
      if (result.rowCount !== 1) conflict();
    },
    async lockWithdrawal(actorId, operationId) {
      await sql.query("INSERT INTO operations_skill_withdrawal_keys (actor_id,operation_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [actorId, operationId]);
      await sql.query("SELECT actor_id FROM operations_skill_withdrawal_keys WHERE actor_id=$1 AND operation_id=$2 FOR UPDATE", [actorId, operationId]);
    },
    async findWithdrawal(actorId, operationId) {
      const result = await sql.query<{ payload: SkillReviewAudit }>("SELECT payload FROM operations_skill_review_audit WHERE actor_id=$1 AND operation_id=$2 FOR UPDATE", [actorId, operationId]);
      return result.rows[0]?.payload ?? null;
    },
  };
}
/** Only M08 review metadata/audit is stored; M10 content is accessed via the injected transaction port. */
export class PostgresSkillReviewRepository implements SkillReviewRepository {
  readonly database: DatabasePort;
  constructor(database: DatabasePort) { this.database = database; }
  transaction<T>(work: (tx: SkillReviewTransaction) => Promise<T>): Promise<T> { return this.database.transaction(sql => work(transaction(sql))); }
  async listReviews(status?: SkillReviewStatus, limit = 50): Promise<readonly SkillReview[]> {
    const result = await this.database.query<{ payload: SkillReview }>("SELECT payload FROM operations_skill_reviews WHERE ($1::text IS NULL OR status=$1) ORDER BY updated_at DESC,review_id DESC LIMIT $2", [status ?? null, limit]);
    return result.rows.map(row => row.payload);
  }
}
export function createPostgresSkillReviewRepository(database: DatabasePort): SkillReviewRepository { return new PostgresSkillReviewRepository(database); }
