import { DomainError } from "../../shared/errors.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { AnalysisRun } from "./model.ts";
import type { EventsService } from "./service.ts";

/** Server-only metadata: no analysis inputs or provider output are returned. */
export interface EventAnalysisRunQueueEntry {
  readonly id: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly revision: number;
  readonly status: "queued" | "running";
  /** The original queuedAt, including when the run is currently running. */
  readonly createdAt: string;
}

export interface EventAnalysisQueuePort {
  listQueuedRunIds(limit: number): Promise<readonly string[]>;
  listRunningRunIds(limit: number): Promise<readonly string[]>;
}

function bounded(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new DomainError("INVALID_CONFIGURATION", `${label}必须是 1 到 ${maximum} 之间的整数。`);
  }
  return value;
}

/** Selection never claims a run; EventsService owns transactional claims/CAS. */
export class PostgresEventAnalysisQueue implements EventAnalysisQueuePort {
  private readonly database: SqlExecutor;

  constructor(database: SqlExecutor) { this.database = database; }

  private async list(status: EventAnalysisRunQueueEntry["status"], limit: number): Promise<readonly EventAnalysisRunQueueEntry[]> {
    bounded(limit, 50, "队列批量数量");
    const ordering = status === "running"
      ? "body->>'startedAt' ASC NULLS FIRST, body->>'queuedAt' ASC, id ASC"
      : "body->>'queuedAt' ASC, id ASC";
    const result = await this.database.query<EventAnalysisRunQueueEntry>(
      `SELECT id, body->>'projectId' AS "projectId", body->>'actorId' AS "actorId", revision,
              body->>'status' AS status, body->>'queuedAt' AS "createdAt"
       FROM m03_analysis_runs
       WHERE body->>'status' = $1
       ORDER BY ${ordering}
       LIMIT $2`,
      [status, limit],
    );
    return result.rows;
  }

  listQueuedAnalysisRuns(limit: number): Promise<readonly EventAnalysisRunQueueEntry[]> {
    return this.list("queued", limit);
  }

  listRunningAnalysisRuns(limit: number): Promise<readonly EventAnalysisRunQueueEntry[]> {
    return this.list("running", limit);
  }

  async listQueuedRunIds(limit: number): Promise<readonly string[]> {
    return (await this.listQueuedAnalysisRuns(limit)).map(run => run.id);
  }

  async listRunningRunIds(limit: number): Promise<readonly string[]> {
    return (await this.listRunningAnalysisRuns(limit)).map(run => run.id);
  }
}

export interface EventAnalysisWorkerDependencies {
  readonly service: Pick<EventsService, "processAnalysisRun" | "recoverExpiredAnalysisRun">;
  readonly queue: EventAnalysisQueuePort;
  /** Bounded separately for the recovery and queued phases; default 10. */
  readonly batchSize?: number;
  /** Maximum outstanding service calls in either phase; default 2. */
  readonly concurrency?: number;
}

export interface EventAnalysisWorkerResult {
  /** Running snapshot entries whose recovery returns a MODEL_TIMEOUT failure. */
  recovered: number;
  /** Number of queued service calls begun, including calls that throw. */
  processed: number;
  succeeded: number;
  /** Failed process results or thrown process calls; recovery errors are in errors. */
  failed: number;
  cancelled: number;
  /** Queued entries not begun after abort, or still queued/running after a claim race. */
  skipped: number;
  errors: { runId: string; code: string }[];
}

export interface EventAnalysisWorker {
  /** Concurrent calls on one instance share the first call's batch and signal. */
  runOnce(signal?: AbortSignal): Promise<EventAnalysisWorkerResult>;
}

function stableCode(code: unknown): string {
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/u.test(code) ? code : "WORKER_FAILED";
}

function errorCode(error: unknown): string {
  return error instanceof DomainError ? stableCode(error.code) : "WORKER_FAILED";
}

/**
 * One bounded batch, intended for an injected scheduler or CLI. It performs no
 * polling, retries, confirmation, publication, or unauthenticated HTTP actions.
 * Aborting stops new service calls; calls already started finish normally.
 */
export function createEventAnalysisWorker(dependencies: EventAnalysisWorkerDependencies): EventAnalysisWorker {
  const batchSize = bounded(dependencies.batchSize ?? 10, 50, "worker 批量数量");
  const concurrency = bounded(dependencies.concurrency ?? 2, 4, "worker 并发数量");
  let active: Promise<EventAnalysisWorkerResult> | undefined;

  async function selected(list: () => Promise<readonly string[]>): Promise<string[]> {
    try {
      // Enforce the bound even if an injected queue ignores its limit. Deduplication
      // also keeps one batch from processing a repeated ID twice.
      return [...new Set((await list()).slice(0, batchSize))];
    } catch (error) {
      throw new DomainError(errorCode(error), "赛事分析队列暂时不可用。", { status: 503 });
    }
  }

  async function each(ids: readonly string[], signal: AbortSignal | undefined, work: (runId: string) => Promise<void>): Promise<number> {
    let next = 0;
    async function consumer(): Promise<void> {
      while (!signal?.aborted && next < ids.length) {
        const runId = ids[next++]!;
        await work(runId);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => consumer()));
    return ids.length - next;
  }

  async function runBatch(signal?: AbortSignal): Promise<EventAnalysisWorkerResult> {
    const result: EventAnalysisWorkerResult = { recovered: 0, processed: 0, succeeded: 0, failed: 0, cancelled: 0, skipped: 0, errors: [] };
    if (signal?.aborted) return result;
    const running = await selected(() => dependencies.queue.listRunningRunIds(batchSize));
    await each(running, signal, async runId => {
      try {
        const run = await dependencies.service.recoverExpiredAnalysisRun(runId);
        if (run.status === "failed" && run.errorCode === "MODEL_TIMEOUT") result.recovered++;
      } catch (error) {
        result.errors.push({ runId, code: errorCode(error) });
      }
    });
    if (signal?.aborted) return result;
    const queued = await selected(() => dependencies.queue.listQueuedRunIds(batchSize));
    const notStarted = await each(queued, signal, async runId => {
      result.processed++;
      let run: AnalysisRun;
      try {
        run = await dependencies.service.processAnalysisRun(runId);
      } catch (error) {
        result.failed++;
        result.errors.push({ runId, code: errorCode(error) });
        return;
      }
      if (run.status === "succeeded") result.succeeded++;
      else if (run.status === "cancelled") result.cancelled++;
      else if (run.status === "failed") {
        result.failed++;
        result.errors.push({ runId, code: stableCode(run.errorCode) });
      } else result.skipped++;
    });
    result.skipped += notStarted;
    return result;
  }

  return {
    runOnce(signal) {
      if (!active) active = runBatch(signal).finally(() => { active = undefined; });
      return active;
    },
  };
}
