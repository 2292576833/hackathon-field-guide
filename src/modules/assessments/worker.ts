import type { Clock, JobStatus } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort } from "../../shared/persistence.ts";
import type { AssessmentService } from "./service.ts";
import type { ScoringJob } from "./types.ts";
import { MODEL_TRANSPORT_FAILURE_CODES } from "./model-failures.ts";

/** Trusted scheduler metadata only. No answers, evidence, correction text or full jobs. */
export interface AssessmentScoringQueueItem {
  readonly id: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly revision: number;
  readonly status: JobStatus;
  readonly createdAt: string;
}

export interface ScoringQueuePort {
  listQueued(limit: number): Promise<readonly AssessmentScoringQueueItem[]>;
  listExpiredRunning(limit: number, before: string): Promise<readonly AssessmentScoringQueueItem[]>;
}

export type AssessmentScoringServicePort = Pick<AssessmentService, "processScoringJob" | "recoverExpiredScoringJob">;

interface QueueRow {
  readonly id: string;
  readonly project_id: string;
  readonly user_id: string;
  readonly revision: number;
  readonly status: JobStatus;
  readonly created_at: string | Date;
}

function integer(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new DomainError("INVALID_WORKER_CONFIGURATION", `${label}必须是 1 至 ${maximum} 的整数。`);
  }
  return value;
}

function instant(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new DomainError("PERSISTENCE_INVALID_DATA", "评分任务的时间记录无效。", { status: 500 });
  return date.toISOString();
}

function metadata(row: QueueRow): AssessmentScoringQueueItem {
  if (typeof row.id !== "string" || typeof row.project_id !== "string" || typeof row.user_id !== "string" ||
    !Number.isSafeInteger(row.revision) || row.revision < 1 || !["queued", "running", "succeeded", "failed", "cancelled"].includes(row.status)) {
    throw new DomainError("PERSISTENCE_INVALID_DATA", "评分任务的执行记录无效。", { status: 500 });
  }
  return { id: row.id, projectId: row.project_id, actorId: row.user_id, revision: row.revision, status: row.status, createdAt: instant(row.created_at) };
}

/** A read-only, bounded scan. Existing service transactions perform the exclusive CAS claim.
 * Scanning must finish before execution so no SQL lock is held during a provider call.
 */
export class PostgresScoringQueue implements ScoringQueuePort {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) { this.database = database; }

  async listQueued(limit: number): Promise<readonly AssessmentScoringQueueItem[]> {
    integer(limit, "批次大小", 100);
    const result = await this.database.query<QueueRow>(`
      SELECT id, project_id, user_id, revision, status, created_at
      FROM assessments_scoring_jobs WHERE status = 'queued'
      ORDER BY created_at, id LIMIT $1`, [limit]);
    return result.rows.map(metadata);
  }

  async listExpiredRunning(limit: number, before: string): Promise<readonly AssessmentScoringQueueItem[]> {
    integer(limit, "恢复批次大小", 100);
    if (typeof before !== "string" || !before.includes("T") || !/(?:Z|[+-]\d{2}:\d{2})$/.test(before) || !Number.isFinite(Date.parse(before))) {
      throw new DomainError("INVALID_WORKER_CONFIGURATION", "恢复截止时间需要包含时区的 ISO 日期。" );
    }
    const result = await this.database.query<QueueRow>(`
      SELECT id, project_id, user_id, revision, status, created_at
      FROM assessments_scoring_jobs
      WHERE status = 'running' AND created_at < $1::timestamptz
        AND data ->> 'startedAt' IS NOT NULL
        AND (data ->> 'startedAt')::timestamptz < $1::timestamptz
      ORDER BY created_at, id LIMIT $2`, [instant(before), limit]);
    return result.rows.map(metadata);
  }
}

const SAFE_FAILURE_CODES = new Set([
  "MODEL_UNAVAILABLE", "TEST_SCORER_DISABLED", "MODEL_TIMEOUT", "INVALID_SCORING_OUTPUT", "INVALID_QUESTION_CATALOG",
  "FORBIDDEN", "JOB_STALE", "PROJECT_READ_ONLY", "WORKER_INTERRUPTED", "MODEL_FAILED", "NOT_FOUND", "VERSION_CONFLICT",
  ...MODEL_TRANSPORT_FAILURE_CODES,
]);

function safeCode(code: unknown): string {
  return typeof code === "string" && SAFE_FAILURE_CODES.has(code) ? code : "WORKER_FAILED";
}

export interface AssessmentScoringExecution extends AssessmentScoringQueueItem {
  readonly failureCode: string | null;
}

function execution(job: ScoringJob): AssessmentScoringExecution {
  return {
    id: job.id, projectId: job.projectId, actorId: job.userId, revision: job.revision, status: job.status, createdAt: job.createdAt,
    failureCode: job.failureCode === null ? null : safeCode(job.failureCode),
  };
}

export interface AssessmentScoringRegistration {
  readonly kind: "assessment_scoring";
  listQueued(limit: number): Promise<readonly AssessmentScoringQueueItem[]>;
  listRecoverable(limit: number): Promise<readonly AssessmentScoringQueueItem[]>;
  execute(jobId: string): Promise<AssessmentScoringExecution>;
  recover(jobId: string): Promise<AssessmentScoringExecution>;
}

export interface AssessmentScoringRegistrationOptions {
  readonly queue: ScoringQueuePort;
  readonly service: AssessmentScoringServicePort;
  readonly clock: Clock;
  /** Must match AssessmentService.modelTimeoutMs; the service also checks expiry before recovery. */
  readonly modelTimeoutMs?: number;
}

/** Register only inside a trusted server scheduler. This is not a browser/user worker route. */
export function createAssessmentScoringRegistration(options: AssessmentScoringRegistrationOptions): AssessmentScoringRegistration {
  const timeoutMs = integer(options.modelTimeoutMs ?? 20000, "模型超时毫秒数", 120000);
  return {
    kind: "assessment_scoring",
    listQueued: (limit) => options.queue.listQueued(limit),
    listRecoverable: (limit) => {
      const now = options.clock.now();
      if (!Number.isFinite(now.getTime())) throw new DomainError("INVALID_WORKER_CONFIGURATION", "执行时钟无效。" );
      return options.queue.listExpiredRunning(limit, new Date(now.getTime() - timeoutMs - 30000).toISOString());
    },
    execute: async (jobId) => execution(await options.service.processScoringJob(jobId)),
    recover: async (jobId) => execution(await options.service.recoverExpiredScoringJob(jobId)),
  };
}

export interface AssessmentScoringWorkerOptions extends AssessmentScoringRegistrationOptions {
  readonly batchSize?: number;
  readonly concurrency?: number;
}

export interface AssessmentScoringWorkerResult {
  readonly scanned: number;
  readonly results: readonly {
    readonly jobId: string;
    readonly action: "execute" | "recover";
    readonly status: JobStatus | "error";
    readonly errorCode: string | null;
  }[];
}

/** One bounded pass. Root owns scheduling, shutdown and provider budgets. Overlapping
 * passes are safe because the service claims queued jobs exactly once. Expired runs
 * close with a recoverable failure; they are never dispatched to the model again.
 */
export function createAssessmentScoringWorker(options: AssessmentScoringWorkerOptions): { runOnce(): Promise<AssessmentScoringWorkerResult> } {
  const batchSize = integer(options.batchSize ?? 10, "批次大小", 100);
  const concurrency = integer(options.concurrency ?? 1, "并发数", Math.min(batchSize, 8));
  const registration = createAssessmentScoringRegistration(options);
  return {
    async runOnce(): Promise<AssessmentScoringWorkerResult> {
      const candidates: { readonly item: AssessmentScoringQueueItem; readonly action: "execute" | "recover" }[] = [];
      try {
        const seen = new Set<string>();
        for (const item of (await registration.listRecoverable(batchSize)).slice(0, batchSize)) {
          if (!seen.has(item.id)) { seen.add(item.id); candidates.push({ item, action: "recover" }); }
        }
        const remaining = batchSize - candidates.length;
        if (remaining > 0) for (const item of (await registration.listQueued(remaining)).slice(0, remaining)) {
          if (!seen.has(item.id)) { seen.add(item.id); candidates.push({ item, action: "execute" }); }
        }
      } catch {
        throw new DomainError("SCORING_QUEUE_UNAVAILABLE", "评分队列暂时无法读取，已保存的任务会在下一次检查时继续处理。", { status: 503 });
      }
      const results: AssessmentScoringWorkerResult["results"][number][] = new Array(candidates.length);
      let cursor = 0;
      async function process(): Promise<void> {
        while (cursor < candidates.length) {
          const index = cursor++;
          const candidate = candidates[index]!;
          try {
            const result = await registration[candidate.action](candidate.item.id);
            results[index] = { jobId: candidate.item.id, action: candidate.action, status: result.status, errorCode: result.failureCode };
          } catch (error) {
            results[index] = {
              jobId: candidate.item.id, action: candidate.action, status: "error",
              errorCode: error instanceof DomainError ? safeCode(error.code) : "WORKER_FAILED",
            };
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => process()));
      return { scanned: candidates.length, results };
    },
  };
}
