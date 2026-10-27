import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type {
  PlanningGenerationJob, PlanningGenerationJobSummary, PlanningGenerationRepository,
  PlanningGenerationStatus, PlanningGenerationTransaction,
} from "./generation-types.ts";

interface JobRow {
  id: string;
  project_id: string;
  actor_id: string;
  membership_id: string;
  idempotency_key: string;
  command_fingerprint: string;
  status: string;
  revision: number | string;
  attempts: number | string;
  job_json: string;
}
interface SummaryRow {
  id: string;
  project_id: string;
  actor_id: string;
  revision: number | string;
  status: string;
  created_at: string;
}

const statuses: readonly PlanningGenerationStatus[] = ["queued", "running", "succeeded", "failed", "cancelled"];
const columns = "id, project_id, actor_id, membership_id, idempotency_key, command_fingerprint, status, revision, attempts, body::text AS job_json";
const summaryColumns = "id, project_id, actor_id, revision, status, body->>'createdAt' AS created_at";

function invalidPersistence(): DomainError {
  return new DomainError("PLANNING_GENERATION_PERSISTENCE_INVALID", "已保存的计划生成任务无法读取，请联系项目维护人员。", { status: 500 });
}
function conflict(): DomainError {
  return new DomainError("VERSION_CONFLICT", "生成任务已被更新，请重新查看任务状态。", { status: 409, recoveryAction: "review_latest_version" });
}
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const integer = (value: unknown, minimum: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const timestamp = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));
const nullableText = (value: unknown): boolean => value === null || text(value);
const nullableTimestamp = (value: unknown): boolean => value === null || timestamp(value);

function validJob(value: unknown): value is PlanningGenerationJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const job = value as PlanningGenerationJob;
  const snapshot = job.snapshot;
  if (!text(job.id) || !text(job.projectId) || !text(job.actorId) || !text(job.membershipId)
    || !text(job.idempotencyKey) || !text(job.commandFingerprint) || !statuses.includes(job.status)
    || !integer(job.revision, 1) || !integer(job.attempts, 0) || !timestamp(job.createdAt)
    || !nullableTimestamp(job.startedAt) || !nullableTimestamp(job.finishedAt) || !nullableTimestamp(job.leaseExpiresAt)
    || !(job.durationMs === null || integer(job.durationMs, 0)) || !nullableText(job.errorCode)
    || !nullableText(job.resultPlanId) || !text(job.modelVersion) || !text(job.promptVersion)
    || !nullableText(job.providerRequestId)
    || !(job.usage === null || (job.usage && integer(job.usage.inputTokens, 0) && integer(job.usage.outputTokens, 0)))
    || !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
    || !snapshot.input || typeof snapshot.input !== "object" || snapshot.input.projectId !== job.projectId
    || !Array.isArray(snapshot.tasks) || snapshot.tasks.some(task => !task || task.projectId !== job.projectId)
    || !integer(snapshot.tasksRevision, 0) || !nullableText(snapshot.basePlanVersionId)
    || !Array.isArray(snapshot.resourceContentRefs) || !Array.isArray(snapshot.buffers)
    || !text(snapshot.goal) || typeof snapshot.instructions !== "string") return false;
  if ((job.status === "running") !== (job.leaseExpiresAt !== null)) return false;
  if (job.status === "running" && (job.startedAt === null || job.finishedAt !== null || job.attempts === 0)) return false;
  if ((job.status === "queued" || job.status === "running") !== (job.finishedAt === null)) return false;
  if ((job.status === "succeeded") !== (job.resultPlanId !== null)) return false;
  if (job.status === "failed" && job.errorCode === null) return false;
  return true;
}

function encodeJob(job: PlanningGenerationJob): string {
  try {
    if (!validJob(job)) throw new Error("Invalid job");
    const encoded = JSON.stringify(job);
    if (!validJob(JSON.parse(encoded))) throw new Error("Invalid serialized job");
    return encoded;
  } catch {
    throw new DomainError("PLANNING_GENERATION_SERIALIZATION_INVALID", "计划生成任务无法保存，请检查输入。", { status: 422 });
  }
}

function decodeJob(row: JobRow): PlanningGenerationJob {
  let job: unknown;
  try { job = JSON.parse(row.job_json); } catch { throw invalidPersistence(); }
  if (!validJob(job) || job.id !== row.id || job.projectId !== row.project_id || job.actorId !== row.actor_id
    || job.membershipId !== row.membership_id || job.idempotencyKey !== row.idempotency_key
    || job.commandFingerprint !== row.command_fingerprint || job.status !== row.status
    || job.revision !== Number(row.revision) || job.attempts !== Number(row.attempts)) throw invalidPersistence();
  return job;
}

function decodeSummary(row: SummaryRow): PlanningGenerationJobSummary {
  const revision = Number(row.revision);
  if (!text(row.id) || !text(row.project_id) || !text(row.actor_id) || !integer(revision, 1)
    || !statuses.includes(row.status as PlanningGenerationStatus) || !timestamp(row.created_at)) throw invalidPersistence();
  return { id: row.id, projectId: row.project_id, actorId: row.actor_id, revision,
    status: row.status as PlanningGenerationStatus, createdAt: row.created_at };
}

function checkLimit(limit: number): void {
  if (!integer(limit, 1) || limit > 100) throw new DomainError("INVALID_LIMIT", "每次读取的生成任务数量需为 1–100。", { status: 422 });
}

/** Durable task storage only. The service owns leases, retries and state transitions. */
export function createPostgresPlanningGenerationRepository(database: DatabasePort): PlanningGenerationRepository {
  return {
    async read(jobId) {
      const result = await database.query<JobRow>(`SELECT ${columns} FROM planning_generation_jobs WHERE id = $1`, [jobId]);
      if (result.rows.length === 0) return null;
      const job = decodeJob(result.rows[0]!);
      if (job.id !== jobId) throw invalidPersistence();
      return job;
    },
    async listForProject(projectId, limit) {
      checkLimit(limit);
      const result = await database.query<JobRow>(
        `SELECT ${columns} FROM planning_generation_jobs WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [projectId, limit],
      );
      return result.rows.map(row => {
        const job = decodeJob(row);
        if (job.projectId !== projectId) throw invalidPersistence();
        return job;
      });
    },
    async listQueued(limit) {
      checkLimit(limit);
      const result = await database.query<SummaryRow>(
        `SELECT ${summaryColumns} FROM planning_generation_jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT $1`, [limit],
      );
      return result.rows.map(row => {
        const summary = decodeSummary(row);
        if (summary.status !== "queued") throw invalidPersistence();
        return summary;
      });
    },
    async listRunning(limit) {
      checkLimit(limit);
      const result = await database.query<SummaryRow>(
        `SELECT ${summaryColumns} FROM planning_generation_jobs WHERE status = 'running' ORDER BY lease_expires_at, created_at, id LIMIT $1`, [limit],
      );
      return result.rows.map(row => {
        const summary = decodeSummary(row);
        if (summary.status !== "running") throw invalidPersistence();
        return summary;
      });
    },
    async transaction(projectId, work) {
      return database.transaction(async executor => {
        // Matches PlanningRepository so nested writes can use the root's same executor.
        await executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`planning:${projectId}`]);
        let active = true;
        const sql: SqlExecutor = {
          async query(statement, parameters) {
            if (!active) throw new DomainError("PLANNING_GENERATION_TRANSACTION_CLOSED", "生成任务操作已结束，请重新发起操作。", { status: 409 });
            return executor.query(statement, parameters);
          },
        };
        const transaction: PlanningGenerationTransaction = {
          sql,
          async get(jobId) {
            const result = await sql.query<JobRow>(
              `SELECT ${columns} FROM planning_generation_jobs WHERE project_id = $1 AND id = $2 FOR UPDATE`, [projectId, jobId],
            );
            if (result.rows.length === 0) return null;
            const job = decodeJob(result.rows[0]!);
            if (job.projectId !== projectId || job.id !== jobId) throw invalidPersistence();
            return job;
          },
          async findRequest(actorId, idempotencyKey) {
            const result = await sql.query<JobRow>(
              `SELECT ${columns} FROM planning_generation_jobs WHERE project_id = $1 AND actor_id = $2 AND idempotency_key = $3 FOR UPDATE`,
              [projectId, actorId, idempotencyKey],
            );
            if (result.rows.length === 0) return null;
            const job = decodeJob(result.rows[0]!);
            if (job.projectId !== projectId || job.actorId !== actorId || job.idempotencyKey !== idempotencyKey) throw invalidPersistence();
            return job;
          },
          async save(job, expectedRevision) {
            if (job.projectId !== projectId) throw new DomainError("PROJECT_MISMATCH", "生成任务不属于本项目。", { status: 422 });
            if (!(expectedRevision === null || integer(expectedRevision, 1)) || !integer(job.revision, 1)
              || job.revision !== (expectedRevision === null ? 1 : expectedRevision + 1)) {
              throw new DomainError("INVALID_REVISION", "保存生成任务时必须递增一个版本。", { status: 422 });
            }
            const encoded = encodeJob(job);
            const saved = expectedRevision === null
              ? await sql.query(
                "INSERT INTO planning_generation_jobs (id, project_id, actor_id, membership_id, idempotency_key, command_fingerprint, status, revision, attempts, created_at, lease_expires_at, body) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz, $12::jsonb) ON CONFLICT DO NOTHING RETURNING revision",
                [job.id, projectId, job.actorId, job.membershipId, job.idempotencyKey, job.commandFingerprint, job.status,
                  job.revision, job.attempts, job.createdAt, job.leaseExpiresAt, encoded],
              )
              : await sql.query(
                // Immutable request columns also stop an update changing its idempotency scope.
                "UPDATE planning_generation_jobs SET status = $3, revision = $4, attempts = $5, lease_expires_at = $6::timestamptz, body = $7::jsonb WHERE id = $1 AND project_id = $2 AND revision = $8 AND actor_id = $9 AND membership_id = $10 AND idempotency_key = $11 AND command_fingerprint = $12 AND created_at = $13::timestamptz AND body->'snapshot' = $14::jsonb RETURNING revision",
                [job.id, projectId, job.status, job.revision, job.attempts, job.leaseExpiresAt, encoded, expectedRevision,
                  job.actorId, job.membershipId, job.idempotencyKey, job.commandFingerprint, job.createdAt, JSON.stringify(job.snapshot)],
              );
            if (saved.rowCount !== 1) throw conflict();
          },
        };
        try { return await work(transaction); } finally { active = false; }
      });
    },
  };
}
