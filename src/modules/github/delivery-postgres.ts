import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DeliveryStorePort, DeliveryVerification, SubmissionRecord } from "./types.ts";

type VerificationRow = {
  id: string; project_id: string; repository_commit_sha: string | null; verifier_id: string; verified_at: string | Date;
  environment_summary: string; steps: string[]; outcome: DeliveryVerification["outcome"]; blockers: string[];
  evidence_refs: string[]; verification_source: "user_reported"; version: number;
};
type SubmissionRow = {
  id: string; project_id: string; event_id: string; stage_id: string; requirements_version: string; platform_url: string;
  submitted_at: string | Date | null; verification_source: SubmissionRecord["verificationSource"];
  repository_commit_sha: string | null; status: SubmissionRecord["status"]; evidence_refs: string[];
  recorded_by: string; recorded_at: string | Date; version: number;
};

/** Minimal metadata for consumers; private evidence and environment details stay in the facts. */
async function appendFactEvent(sql: SqlExecutor, record: DeliveryVerification | SubmissionRecord): Promise<void> {
  const isVerification = "verifierId" in record;
  const type = isVerification ? "DeliveryValidationRecorded" : "SubmissionRecorded";
  const actorId = isVerification ? record.verifierId : record.recordedBy;
  const details = isVerification
    ? { outcome: record.outcome, verificationSource: record.verificationSource, repositoryCommitSha: record.repositoryCommitSha }
    : { eventId: record.eventId, stageId: record.stageId, requirementsVersion: record.requirementsVersion, status: record.status, verificationSource: record.verificationSource, repositoryCommitSha: record.repositoryCommitSha };
  await sql.query(
    `INSERT INTO m06_delivery_fact_events (id, event_type, aggregate_id, project_id, version, actor_id, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [`${type}:${record.id}:${record.version}`, type, record.id, record.projectId, record.version, actorId, JSON.stringify(details)],
  );
}

function iso(value: string | Date): string { return (value instanceof Date ? value : new Date(value)).toISOString(); }
function verification(row: VerificationRow): DeliveryVerification {
  return {
    id: row.id, projectId: row.project_id, repositoryCommitSha: row.repository_commit_sha,
    verifierId: row.verifier_id, verifiedAt: iso(row.verified_at), environmentSummary: row.environment_summary,
    steps: [...row.steps], outcome: row.outcome, blockers: [...row.blockers], evidenceRefs: [...row.evidence_refs],
    verificationSource: row.verification_source, version: row.version,
  };
}
function submission(row: SubmissionRow): SubmissionRecord {
  return {
    id: row.id, projectId: row.project_id, eventId: row.event_id, stageId: row.stage_id,
    requirementsVersion: row.requirements_version, platformUrl: row.platform_url,
    submittedAt: row.submitted_at === null ? null : iso(row.submitted_at), verificationSource: row.verification_source,
    repositoryCommitSha: row.repository_commit_sha, status: row.status, evidenceRefs: [...row.evidence_refs],
    recordedBy: row.recorded_by, recordedAt: iso(row.recorded_at), version: row.version,
  };
}

async function insertSubmissionVersion(sql: SqlExecutor, record: SubmissionRecord): Promise<void> {
  await sql.query(
    `INSERT INTO m06_submission_versions
     (id, project_id, version, event_id, stage_id, requirements_version, platform_url, submitted_at,
      verification_source, repository_commit_sha, status, evidence_refs, recorded_by, recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [record.id, record.projectId, record.version, record.eventId, record.stageId, record.requirementsVersion,
      record.platformUrl, record.submittedAt, record.verificationSource, record.repositoryCommitSha,
      record.status, record.evidenceRefs, record.recordedBy, record.recordedAt],
  );
}

/** Wire to a real PostgreSQL DatabasePort. No production in-memory implementation is supplied. */
export class PostgresDeliveryStore implements DeliveryStorePort {
  private readonly database: DatabasePort;
  constructor(database: DatabasePort) { this.database = database; }

  async insertVerification(record: DeliveryVerification): Promise<void> {
    await this.database.transaction(async (sql) => {
      await sql.query(
        `INSERT INTO m06_delivery_verifications
         (id, project_id, version, repository_commit_sha, verifier_id, verified_at, environment_summary,
          steps, outcome, blockers, evidence_refs, verification_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [record.id, record.projectId, record.version, record.repositoryCommitSha, record.verifierId, record.verifiedAt,
          record.environmentSummary, record.steps, record.outcome, record.blockers, record.evidenceRefs, record.verificationSource],
      );
      await appendFactEvent(sql, record);
    });
  }

  async listVerifications(projectId: string): Promise<DeliveryVerification[]> {
    const result = await this.database.query<VerificationRow>(
      `SELECT * FROM m06_delivery_verifications WHERE project_id=$1 ORDER BY verified_at DESC, id`, [projectId],
    );
    return result.rows.map(verification);
  }

  async insertSubmission(record: SubmissionRecord): Promise<void> {
    if (record.version !== 1) throw new DomainError("INVALID_DELIVERY_INPUT", "新提交记录版本必须为 1。");
    await this.database.transaction(async (sql) => {
      await sql.query(`INSERT INTO m06_submission_heads (id, project_id, version) VALUES ($1,$2,$3)`, [record.id, record.projectId, record.version]);
      await insertSubmissionVersion(sql, record);
      await appendFactEvent(sql, record);
    });
  }

  async getSubmission(projectId: string, id: string): Promise<SubmissionRecord | null> {
    const result = await this.database.query<SubmissionRow>(
      `SELECT v.* FROM m06_submission_versions v
       JOIN m06_submission_heads h ON h.id=v.id AND h.project_id=v.project_id AND h.version=v.version
       WHERE v.project_id=$1 AND v.id=$2`, [projectId, id],
    );
    return result.rows[0] ? submission(result.rows[0]) : null;
  }

  async updateSubmission(record: SubmissionRecord, expectedVersion: number): Promise<void> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || record.version !== expectedVersion + 1) {
      throw new DomainError("INVALID_DELIVERY_INPUT", "提交版本必须连续递增。");
    }
    await this.database.transaction(async (sql) => {
      const result = await sql.query<{ version: number }>(
        `UPDATE m06_submission_heads SET version=$1 WHERE project_id=$2 AND id=$3 AND version=$4 RETURNING version`,
        [record.version, record.projectId, record.id, expectedVersion],
      );
      if (result.rowCount !== 1) {
        const latest = await sql.query<{ version: number }>(`SELECT version FROM m06_submission_heads WHERE project_id=$1 AND id=$2`, [record.projectId, record.id]);
        if (!latest.rows[0]) throw new DomainError("SUBMISSION_NOT_FOUND", "找不到该项目的提交记录。", { status: 404 });
        throw new DomainError("VERSION_CONFLICT", "提交记录已更新，请查看最新版本。", { status: 409, latestRevision: latest.rows[0].version });
      }
      await insertSubmissionVersion(sql, record);
      await appendFactEvent(sql, record);
    });
  }

  async listSubmissions(projectId: string): Promise<SubmissionRecord[]> {
    const result = await this.database.query<SubmissionRow>(
      `SELECT * FROM m06_submission_versions WHERE project_id=$1 ORDER BY recorded_at DESC, id, version DESC`, [projectId],
    );
    return result.rows.map(submission);
  }
}
