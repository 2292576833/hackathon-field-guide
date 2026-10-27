import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { AssessmentRepository, AssessmentTransaction, QuestionCatalogPort, SharedSummaryReference } from "./ports.ts";
import type { AssessmentAttempt, AssessmentEvent, AssessmentScore, AssignmentHead, AssignmentVersion, QuestionSet, RubricVersion, ScoringJob } from "./types.ts";

interface DataRow { readonly data: unknown }
interface RevisionRow { readonly revision: number }
interface HeadRow { readonly project_id: string; readonly version_id: string | null; readonly revision: number }

/** pg normally decodes JSONB; small SQL adapters may return JSON text instead. */
function decode<T>(row: DataRow): T {
  try {
    const value: unknown = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid aggregate");
    return value as T;
  } catch {
    throw new DomainError("PERSISTENCE_INVALID_DATA", "保存的数据暂时无法读取，请联系项目支持。", { status: 500 });
  }
}

function checkRevision(revision: number, expectedRevision: number | null): void {
  if (!Number.isSafeInteger(revision) || revision < 1 ||
    (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) ||
    revision !== (expectedRevision === null ? 1 : expectedRevision + 1)) {
    throw new DomainError("INVALID_REVISION", "修订号必须从 1 开始，并逐次增加。", { status: 422 });
  }
}

function conflict(latestRevision?: number): never {
  throw new DomainError("VERSION_CONFLICT", "这份资料已有更新，请查看最新版本后重试。", {
    status: 409,
    recoveryAction: "review_latest_version",
    ...(latestRevision === undefined ? {} : { latestRevision }),
  });
}

/** All statements use the injected transaction connection, including the outbox. */
export class PostgresAssessmentRepository implements AssessmentRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) { this.database = database; }

  transaction<T>(work: (transaction: AssessmentTransaction) => Promise<T>): Promise<T> {
    return this.database.transaction((sql) => work(new PostgresAssessmentTransaction(sql)));
  }
}

/** Trusted persistence adapter. The service checks author/project permissions before returning any aggregate. */
export class PostgresAssessmentTransaction implements AssessmentTransaction {
  readonly sql: SqlExecutor;

  constructor(sql: SqlExecutor) { this.sql = sql; }

  async getAttempt(id: string): Promise<AssessmentAttempt | null> {
    const result = await this.sql.query<DataRow>("SELECT data FROM assessments_attempts WHERE id = $1 FOR UPDATE", [id]);
    return result.rows[0] ? decode<AssessmentAttempt>(result.rows[0]) : null;
  }

  async listAttempts(projectId: string): Promise<readonly AssessmentAttempt[]> {
    // A shared lock holds consent stable while a short assignment transaction validates its inputs.
    const result = await this.sql.query<DataRow>("SELECT data FROM assessments_attempts WHERE project_id = $1 ORDER BY id FOR SHARE", [projectId]);
    return result.rows.map((row) => decode<AssessmentAttempt>(row));
  }

  async listSharedSummaryRefs(projectId: string): Promise<readonly SharedSummaryReference[]> {
    const result = await this.sql.query<{ id: string; user_id: string; membership_id: string; revision: number }>(`
      SELECT id,user_id,membership_id,revision FROM assessments_attempts
      WHERE project_id=$1 AND (COALESCE(jsonb_array_length(data->'sharing'->'confirmedTasks'),0)>0
        OR COALESCE(jsonb_array_length(data->'sharing'->'criterionIds'),0)>0)
      ORDER BY id FOR SHARE`, [projectId]);
    return result.rows.map(row => ({ attemptId: row.id, userId: row.user_id, membershipId: row.membership_id, revision: row.revision }));
  }

  async listOwnAttempts(projectId: string, userId: string, membershipId: string): Promise<readonly AssessmentAttempt[]> {
    const result = await this.sql.query<DataRow>("SELECT data FROM assessments_attempts WHERE project_id = $1 AND user_id = $2 AND membership_id = $3 ORDER BY created_at DESC, id DESC FOR SHARE", [projectId, userId, membershipId]);
    return result.rows.map((row) => decode<AssessmentAttempt>(row));
  }

  async saveAttempt(attempt: AssessmentAttempt, expectedRevision: number | null): Promise<void> {
    checkRevision(attempt.revision, expectedRevision);
    const parameters = [attempt.id, attempt.projectId, attempt.membershipId, attempt.userId,
      attempt.questionSetId, attempt.rubricVersionId, attempt.status, attempt.revision,
      attempt.latestScoreId, attempt.activeJobId, attempt.createdAt, attempt.updatedAt, JSON.stringify(attempt)];
    const result = expectedRevision === null
      ? await this.sql.query<RevisionRow>(`
        INSERT INTO assessments_attempts
          (id, project_id, membership_id, user_id, question_set_id, rubric_version_id, status, revision,
           latest_score_id, active_job_id, created_at, updated_at, data)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
        ON CONFLICT DO NOTHING RETURNING revision`, parameters)
      : await this.sql.query<RevisionRow>(`
        UPDATE assessments_attempts SET status = $7, revision = $8, latest_score_id = $9,
          active_job_id = $10, updated_at = $12, data = $13::jsonb
        WHERE id = $1 AND project_id = $2 AND membership_id = $3 AND user_id = $4
          AND question_set_id = $5 AND rubric_version_id = $6 AND created_at = $11 AND revision = $14
        RETURNING revision`, [...parameters, expectedRevision]);
    if (result.rowCount === 0) {
      const latest = await this.sql.query<RevisionRow>("SELECT revision FROM assessments_attempts WHERE id = $1", [attempt.id]);
      conflict(latest.rows[0]?.revision);
    }
  }

  async getScores(attemptId: string): Promise<readonly AssessmentScore[]> {
    const result = await this.sql.query<DataRow>("SELECT data FROM assessments_scores WHERE attempt_id = $1 ORDER BY validated_at, id", [attemptId]);
    return result.rows.map((row) => decode<AssessmentScore>(row));
  }

  async insertScore(score: AssessmentScore): Promise<void> {
    const result = await this.sql.query(`
      INSERT INTO assessments_scores (id, attempt_id, rubric_version_id, supersedes_score_id, validated_at, data)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT DO NOTHING RETURNING id`,
    [score.id, score.attemptId, score.rubricVersionId, score.supersedesScoreId, score.validatedAt, JSON.stringify(score)]);
    if (result.rowCount === 0) {
      throw new DomainError("SCORE_ALREADY_EXISTS", "评分记录已存在，纠错需要建立新评分版本。", { status: 409 });
    }
  }

  async getJob(id: string): Promise<ScoringJob | null> {
    const result = await this.sql.query<DataRow>("SELECT data FROM assessments_scoring_jobs WHERE id = $1 FOR UPDATE", [id]);
    return result.rows[0] ? decode<ScoringJob>(result.rows[0]) : null;
  }

  async findJob(attemptId: string, userId: string, idempotencyKey: string): Promise<ScoringJob | null> {
    const result = await this.sql.query<DataRow>(`
      SELECT data FROM assessments_scoring_jobs
      WHERE attempt_id = $1 AND user_id = $2 AND idempotency_key = $3 FOR UPDATE`, [attemptId, userId, idempotencyKey]);
    return result.rows[0] ? decode<ScoringJob>(result.rows[0]) : null;
  }

  async saveJob(job: ScoringJob, expectedRevision: number | null): Promise<void> {
    checkRevision(job.revision, expectedRevision);
    const parameters = [job.id, job.attemptId, job.projectId, job.userId, job.idempotencyKey,
      job.inputFingerprint, job.status, job.revision, job.runNumber, job.createdAt, job.resultScoreId, JSON.stringify(job)];
    const result = expectedRevision === null
      ? await this.sql.query<RevisionRow>(`
        INSERT INTO assessments_scoring_jobs
          (id, attempt_id, project_id, user_id, idempotency_key, input_fingerprint, status, revision,
           run_number, created_at, result_score_id, data)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
        ON CONFLICT DO NOTHING RETURNING revision`, parameters)
      : await this.sql.query<RevisionRow>(`
        UPDATE assessments_scoring_jobs SET status = $7, revision = $8, result_score_id = $11, data = $12::jsonb
        WHERE id = $1 AND attempt_id = $2 AND project_id = $3 AND user_id = $4
          AND idempotency_key = $5 AND input_fingerprint = $6 AND run_number = $9
          AND created_at = $10 AND revision = $13 RETURNING revision`, [...parameters, expectedRevision]);
    if (result.rowCount === 0) {
      const latest = await this.sql.query<RevisionRow>(`
        SELECT revision FROM assessments_scoring_jobs WHERE id = $1
          OR (attempt_id = $2 AND user_id = $3 AND idempotency_key = $4)
        ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END LIMIT 1`, [job.id, job.attemptId, job.userId, job.idempotencyKey]);
      conflict(latest.rows[0]?.revision);
    }
  }

  async getAssignment(id: string): Promise<AssignmentVersion | null> {
    const result = await this.sql.query<DataRow>("SELECT data FROM assessments_assignment_versions WHERE id = $1 FOR UPDATE", [id]);
    return result.rows[0] ? decode<AssignmentVersion>(result.rows[0]) : null;
  }

  async saveAssignment(version: AssignmentVersion, expectedRevision: number | null): Promise<void> {
    checkRevision(version.revision, expectedRevision);
    const parameters = [version.id, version.projectId, version.baseVersionId, version.status,
      version.revision, version.createdBy, version.createdAt, version.updatedAt, JSON.stringify(version)];
    const result = expectedRevision === null
      ? await this.sql.query<RevisionRow>(`
        INSERT INTO assessments_assignment_versions (id, project_id, base_version_id, status, revision, created_by, created_at, updated_at, data)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        ON CONFLICT DO NOTHING RETURNING revision`, parameters)
      : await this.sql.query<RevisionRow>(`
        UPDATE assessments_assignment_versions SET status = $4, revision = $5, updated_at = $8, data = $9::jsonb
        WHERE id = $1 AND project_id = $2 AND base_version_id IS NOT DISTINCT FROM $3
          AND created_by = $6 AND created_at = $7 AND revision = $10 RETURNING revision`, [...parameters, expectedRevision]);
    if (result.rowCount === 0) {
      const latest = await this.sql.query<RevisionRow>("SELECT revision FROM assessments_assignment_versions WHERE id = $1", [version.id]);
      conflict(latest.rows[0]?.revision);
    }
  }

  async getHead(projectId: string, initialize = true): Promise<AssignmentHead> {
    // Acquire this before context/member locks, attempt shared locks, and assignment version locks.
    if (initialize) await this.sql.query(`
      INSERT INTO assessments_assignment_heads (project_id, version_id, revision)
      VALUES ($1, NULL, 0) ON CONFLICT (project_id) DO NOTHING`, [projectId]);
    const result = await this.sql.query<HeadRow>(`
      SELECT project_id, version_id, revision FROM assessments_assignment_heads WHERE project_id = $1 FOR UPDATE`, [projectId]);
    const row = result.rows[0];
    if (!row && !initialize) return { projectId, versionId: null, revision: 0 };
    if (!row) throw new DomainError("PERSISTENCE_INVALID_DATA", "当前分工版本暂时无法读取。", { status: 500 });
    return { projectId: row.project_id, versionId: row.version_id, revision: row.revision };
  }

  async saveHead(head: AssignmentHead, expectedRevision: number): Promise<void> {
    checkRevision(head.revision, expectedRevision);
    const result = await this.sql.query<RevisionRow>(`
      UPDATE assessments_assignment_heads SET version_id = $2, revision = $3
      WHERE project_id = $1 AND revision = $4 RETURNING revision`, [head.projectId, head.versionId, head.revision, expectedRevision]);
    if (result.rowCount === 0) {
      const latest = await this.sql.query<RevisionRow>("SELECT revision FROM assessments_assignment_heads WHERE project_id = $1", [head.projectId]);
      conflict(latest.rows[0]?.revision);
    }
  }

  async appendEvent(event: AssessmentEvent): Promise<void> {
    await this.sql.query(`
      INSERT INTO assessments_outbox (event_id, type, aggregate_id, project_id, version, occurred_at, payload)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [event.eventId, event.type, event.aggregateId, event.projectId, event.version, event.occurredAt, JSON.stringify(event.payload)]);
  }
}

/** Catalog maintenance is deliberately separate. Published content is append-only; retiring changes only status. */
export class PostgresQuestionCatalog implements QuestionCatalogPort {
  private readonly sql: SqlExecutor;

  constructor(sql: SqlExecutor) { this.sql = sql; }

  async getQuestionSet(id: string, transaction?: SqlExecutor): Promise<QuestionSet | null> {
    const result = await (transaction ?? this.sql).query<DataRow & { readonly status: QuestionSet["status"] }>(
      `SELECT data, status FROM assessments_question_sets WHERE id = $1${transaction ? " FOR SHARE" : ""}`, [id]);
    const row = result.rows[0];
    return row ? { ...decode<QuestionSet>(row), status: row.status } : null;
  }

  async getRubric(id: string, transaction?: SqlExecutor): Promise<RubricVersion | null> {
    const result = await (transaction ?? this.sql).query<DataRow>(`SELECT data FROM assessments_rubrics WHERE id = $1${transaction ? " FOR SHARE" : ""}`, [id]);
    return result.rows[0] ? decode<RubricVersion>(result.rows[0]) : null;
  }
}
