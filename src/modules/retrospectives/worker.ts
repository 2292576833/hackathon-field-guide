import type { Clock } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { GenerationJob } from "./domain.ts";

export interface RetrospectiveGenerationJobMeta {
  id: string;
  projectId: string;
  actorId: string;
  revision: number;
  status: GenerationJob["status"];
  createdAt: string;
  errorCode?: string;
}
export interface RetrospectiveGenerationQueuePort {
  listQueued(limit: number): Promise<readonly RetrospectiveGenerationJobMeta[]>;
  /** Full running inventory for the coordinator's lease recovery. */
  listRunning?(limit: number): Promise<readonly RetrospectiveGenerationJobMeta[]>;
  listExpiredRunning(input: { updatedBefore: string; limit: number }): Promise<readonly RetrospectiveGenerationJobMeta[]>;
}
export type RetrospectiveGenerationServiceResult = Pick<GenerationJob, "id" | "projectId" | "ownerId" | "revision" | "status" | "createdAt" | "errorCode">;
export interface RetrospectiveGenerationServicePort {
  runGeneration(jobId: string): Promise<RetrospectiveGenerationServiceResult>;
  recoverExpiredGeneration(jobId: string): Promise<RetrospectiveGenerationServiceResult>;
}
export interface RetrospectiveGenerationWorkerOptions {
  service: RetrospectiveGenerationServicePort;
  queue: RetrospectiveGenerationQueuePort;
  clock: Clock;
  /** Must match the service timeout. Recovery adds the service's 30-second grace. */
  modelTimeoutMs?: number;
  /** Maximum total jobs across recovery and generation per run. */
  batchSize?: number;
}
export interface RetrospectiveGenerationWorkerJobResult {
  jobId: string;
  phase: "recovery" | "generation";
  status: "recovered" | "succeeded" | "failed" | "skipped";
  code?: string;
}
export interface RetrospectiveGenerationWorkerRunResult {
  recovered: number;
  succeeded: number;
  failed: number;
  skipped: number;
  aborted: boolean;
  jobs: RetrospectiveGenerationWorkerJobResult[];
}

function code(value: unknown, fallback: string): string { return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : fallback; }
function validId(value: unknown): value is string { return typeof value === "string" && Boolean(value.trim()) && value.length <= 200 && !/[\u0000-\u001f]/.test(value); }
function limit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new DomainError("WORKER_CONFIG_INVALID", "整理批次数量需为 1 至 100。", { status: 503 });
}
function iso(value: string | Date): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new DomainError("QUEUE_DATA_INVALID", "整理队列记录需要有效时间。", { status: 503 });
  return date.toISOString();
}
function meta(value: RetrospectiveGenerationJobMeta): RetrospectiveGenerationJobMeta {
  if (!validId(value.id) || !validId(value.projectId) || !validId(value.actorId) || !Number.isSafeInteger(value.revision) || value.revision < 1 || !["queued", "running", "succeeded", "failed"].includes(value.status)) throw new DomainError("QUEUE_DATA_INVALID", "整理队列记录无效。", { status: 503 });
  return { id: value.id, projectId: value.projectId, actorId: value.actorId, revision: value.revision, status: value.status, createdAt: iso(value.createdAt), ...(value.errorCode !== undefined ? { errorCode: code(value.errorCode, "GENERATION_FAILED") } : {}) };
}
function controlled(error: unknown, fallback: string): DomainError {
  return new DomainError(code(error instanceof DomainError ? error.code : undefined, fallback), "整理任务暂未完成，请查看已保存的任务状态。", { status: error instanceof DomainError && error.status >= 400 && error.status <= 599 ? error.status : 503 });
}

interface QueueRow { id: string; project_id: string; owner_id: string; revision: number | string; status: GenerationJob["status"]; created_at: string | Date }
/** Reads the persistent M07 queue. Job CAS, final fact checks and budgets stay in the service. */
export class PostgresRetrospectiveGenerationQueue implements RetrospectiveGenerationQueuePort {
  private readonly database: SqlExecutor;
  constructor(database: SqlExecutor) { this.database = database; }
  private rows(rows: readonly QueueRow[], expected: "queued" | "running"): RetrospectiveGenerationJobMeta[] {
    return rows.map(row => {
      if (row.status !== expected) throw new DomainError("QUEUE_DATA_INVALID", "整理队列状态不一致。", { status: 503 });
      return meta({ id: row.id, projectId: row.project_id, actorId: row.owner_id, revision: Number(row.revision), status: row.status, createdAt: iso(row.created_at) });
    });
  }
  async listQueued(batchLimit: number): Promise<readonly RetrospectiveGenerationJobMeta[]> {
    limit(batchLimit);
    try {
      const result = await this.database.query<QueueRow>(
        `SELECT id, project_id, owner_id, revision, body->>'status' AS status, created_at FROM m07_documents
         WHERE kind = $1 AND body->>'status' = $2 ORDER BY created_at ASC, id COLLATE "C" ASC LIMIT $3`,
        ["generation_job", "queued", batchLimit],
      );
      return this.rows(result.rows, "queued");
    } catch (error) { throw controlled(error, "GENERATION_QUEUE_UNAVAILABLE"); }
  }
  async listRunning(batchLimit: number): Promise<readonly RetrospectiveGenerationJobMeta[]> {
    limit(batchLimit);
    try {
      const result = await this.database.query<QueueRow>(
        `SELECT id, project_id, owner_id, revision, body->>'status' AS status, created_at FROM m07_documents
         WHERE kind = $1 AND body->>'status' = $2 ORDER BY updated_at ASC, id COLLATE "C" ASC LIMIT $3`,
        ["generation_job", "running", batchLimit],
      );
      return this.rows(result.rows, "running");
    } catch (error) { throw controlled(error, "GENERATION_QUEUE_UNAVAILABLE"); }
  }
  async listExpiredRunning(input: { updatedBefore: string; limit: number }): Promise<readonly RetrospectiveGenerationJobMeta[]> {
    limit(input.limit);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.updatedBefore)) throw new DomainError("WORKER_CONFIG_INVALID", "恢复任务需要带时区的截止时间。", { status: 503 });
    const updatedBefore = iso(input.updatedBefore);
    try {
      const result = await this.database.query<QueueRow>(
        `SELECT id, project_id, owner_id, revision, body->>'status' AS status, created_at FROM m07_documents
         WHERE kind = $1 AND body->>'status' = $2 AND updated_at < $3::timestamptz
         ORDER BY updated_at ASC, id COLLATE "C" ASC LIMIT $4`,
        ["generation_job", "running", updatedBefore, input.limit],
      );
      return this.rows(result.rows, "running");
    } catch (error) { throw controlled(error, "GENERATION_QUEUE_UNAVAILABLE"); }
  }
}

/** Scheduling is owned by the coordinator. This adapter creates no timers or network calls. */
export function createRetrospectiveGenerationWorker(options: RetrospectiveGenerationWorkerOptions) {
  const batchSize = options.batchSize ?? 10, timeout = options.modelTimeoutMs ?? 20_000;
  limit(batchSize);
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 60_000) throw new DomainError("WORKER_CONFIG_INVALID", "整理超时需为 1 至 60000 毫秒。", { status: 503 });
  const listQueued = async (batchLimit: number) => {
    limit(batchLimit);
    try { return (await options.queue.listQueued(batchLimit)).slice(0, batchLimit).map(meta); }
    catch (error) { throw controlled(error, "GENERATION_QUEUE_UNAVAILABLE"); }
  };
  const listExpiredRunning = async (input: { updatedBefore: string; limit: number }) => {
    limit(input.limit);
    try { return (await options.queue.listExpiredRunning(input)).slice(0, input.limit).map(meta); }
    catch (error) { throw controlled(error, "GENERATION_QUEUE_UNAVAILABLE"); }
  };
  const listRunning = async (batchLimit: number) => {
    limit(batchLimit);
    try {
      if (options.queue.listRunning) return (await options.queue.listRunning(batchLimit)).slice(0, batchLimit).map(meta);
      // Legacy queue adapters expose only expiry reads. This fallback inventories
      // running records updated before now; future/equal-now records await a later poll.
      return await listExpiredRunning({ updatedBefore: options.clock.now().toISOString(), limit: batchLimit });
    } catch (error) { throw controlled(error, "GENERATION_QUEUE_UNAVAILABLE"); }
  };
  const invoke = async (jobId: string, recover: boolean): Promise<RetrospectiveGenerationJobMeta> => {
    if (!validId(jobId)) throw new DomainError("INVALID_INPUT", "请提供有效的整理任务标识。");
    try {
      const job = await (recover ? options.service.recoverExpiredGeneration(jobId) : options.service.runGeneration(jobId));
      if (job.id !== jobId) throw new DomainError("QUEUE_DATA_INVALID", "整理结果与任务标识不一致。", { status: 503 });
      return meta({ id: job.id, projectId: job.projectId, actorId: job.ownerId, revision: job.revision, status: job.status, createdAt: job.createdAt, ...(job.errorCode !== undefined ? { errorCode: job.errorCode } : {}) });
    } catch (error) { throw controlled(error, "GENERATION_WORKER_ERROR"); }
  };
  const execute = (jobId: string) => invoke(jobId, false);
  const recover = (jobId: string) => invoke(jobId, true);

  return {
    kind: "m07_retrospective" as const,
    listQueued,
    listRunning,
    execute,
    recover,
    listExpiredRunning,
    async runOnce(input: { signal?: AbortSignal } = {}): Promise<RetrospectiveGenerationWorkerRunResult> {
      const result: RetrospectiveGenerationWorkerRunResult = { recovered: 0, succeeded: 0, failed: 0, skipped: 0, aborted: false, jobs: [] };
      const seen = new Set<string>();
      const process = async (job: RetrospectiveGenerationJobMeta, phase: "recovery" | "generation") => {
        let outcome: RetrospectiveGenerationWorkerJobResult;
        if (seen.has(job.id)) outcome = { jobId: job.id, phase, status: "skipped", code: "DUPLICATE_JOB" };
        else {
          seen.add(job.id);
          try {
            const state = await (phase === "recovery" ? recover(job.id) : execute(job.id));
            if (phase === "recovery") outcome = state.status === "failed" && state.errorCode === "WORKER_EXPIRED" ? { jobId: job.id, phase, status: "recovered", code: "WORKER_EXPIRED" } : { jobId: job.id, phase, status: "skipped", code: "RECOVERY_NOT_APPLIED" };
            else if (state.status === "succeeded") outcome = { jobId: job.id, phase, status: "succeeded" };
            else if (state.status === "failed") outcome = { jobId: job.id, phase, status: "failed", code: state.errorCode ?? "GENERATION_FAILED" };
            else outcome = { jobId: job.id, phase, status: "skipped", code: "JOB_NOT_QUEUED" };
          } catch (error) {
            const errorCode = code(error instanceof DomainError ? error.code : undefined, "GENERATION_WORKER_ERROR");
            outcome = { jobId: job.id, phase, status: errorCode === "VERSION_CONFLICT" ? "skipped" : "failed", code: errorCode };
          }
        }
        result.jobs.push(outcome); result[outcome.status]++;
      };
      if (!input.signal?.aborted) {
        const now = options.clock.now().getTime();
        if (!Number.isFinite(now)) throw new DomainError("WORKER_CONFIG_INVALID", "整理任务需要有效的当前时间。", { status: 503 });
        const expired = await listExpiredRunning({ updatedBefore: new Date(now - timeout - 30_000).toISOString(), limit: batchSize });
        for (const job of expired) { if (input.signal?.aborted) break; await process(job, "recovery"); }
        const remaining = batchSize - result.jobs.length;
        if (!input.signal?.aborted && remaining > 0) {
          const queued = await listQueued(remaining);
          for (const job of queued) { if (input.signal?.aborted) break; await process(job, "generation"); }
        }
      }
      result.aborted = input.signal?.aborted ?? false;
      return result;
    },
  };
}
