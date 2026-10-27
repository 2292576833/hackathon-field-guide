import type { Clock } from "../../shared/contracts.ts";
import type { DatabasePort } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DeepSeekHarnessAdapter } from "./deepseek-harness.ts";
import type { SourceJsonModelPort, SourceWorker } from "./source-worker.ts";
import type { ExecutionKind, WorkerRunState } from "./run-domain.ts";
import type { WorkerIdentityPort } from "./run-domain.ts";
import { createHash, timingSafeEqual } from "node:crypto";

/** Backend-only credential comparison. Website Actor or user JSON cannot create this identity. */
export function createConfiguredSourceWorkerIdentity(input: { readonly workerId: string; readonly serviceCredential: string; readonly sourceConfigIds: () => Promise<readonly string[]> }): WorkerIdentityPort {
  if (!input.workerId || !input.serviceCredential) throw new DomainError("SOURCE_WORKER_UNCONFIGURED", "来源服务身份尚未配置。", { status: 503 });
  const expected = createHash("sha256").update(input.serviceCredential).digest();
  return { async authenticate(credential) {
    if (typeof credential !== "string" || !timingSafeEqual(expected, createHash("sha256").update(credential).digest())) return null;
    return { id: input.workerId, kind: "operations_worker", capabilities: ["crawl", "analysis"], sourceConfigIds: [...await input.sourceConfigIds()] };
  } };
}

/** This is the actual pinned DSH runtime, shared with discovery/navigator. */
export function createDshSourceModel(adapter: DeepSeekHarnessAdapter): SourceJsonModelPort {
  return { modelVersion: adapter.identity.modelVersion, promptVersion: adapter.identity.promptVersion,
    async generateJson(input) {
      const output = await adapter.generate({ taskId: input.taskId, purpose: input.task === "source_crawl" ? "event_extraction" : "event_analysis",
        schemaVersion: input.schemaVersion, modelVersion: adapter.identity.modelVersion, promptVersion: adapter.identity.promptVersion,
        systemPrompt: input.prompt, input: input.input, signal: input.signal });
      return { json: output.data, usage: output.usage };
    },
  };
}
export interface SourceRunQueuePort {
  listDueRuns(input: { readonly now: string; readonly kinds: readonly ExecutionKind[]; readonly limit: number }): Promise<readonly string[]>;
}
/** Only the backend control plane receives this database; DSH receives source data alone. */
export function createPostgresSourceRunQueue(database: DatabasePort): SourceRunQueuePort {
  return { async listDueRuns(input) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100 || !input.kinds.length || input.kinds.some(kind => !["crawl", "analysis"].includes(kind))) throw new DomainError("INVALID_SOURCE_QUEUE_CONFIG", "来源任务读取范围无效。");
    const result = await database.query<{ id: string }>("SELECT id FROM operations_execution_runs WHERE status='queued' AND available_at<=$1::timestamptz AND kind=ANY($2::text[]) ORDER BY available_at,created_at,id LIMIT $3", [input.now, input.kinds, input.limit]);
    return result.rows.map(row => row.id);
  } };
}
export interface SourceQueueCycleReport { readonly runs: readonly WorkerRunState[]; readonly errors: readonly { readonly runId: string; readonly code: string }[] }
export function createSourceQueueRunner(deps: { readonly worker: SourceWorker; readonly queue: SourceRunQueuePort; readonly clock: Clock; readonly maxRunsPerCycle?: number; readonly kinds?: readonly ExecutionKind[] }) {
  const limit = deps.maxRunsPerCycle ?? 5; const kinds = deps.kinds ?? ["crawl", "analysis"];
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError("INVALID_SOURCE_QUEUE_CONFIG", "每轮来源任务数需为 1–100。");
  async function runOnce(input: { readonly signal?: AbortSignal } = {}): Promise<SourceQueueCycleReport> {
    const runs: WorkerRunState[] = []; const errors: { runId: string; code: string }[] = [];
    if (input.signal?.aborted) return { runs, errors };
    const ids = await deps.queue.listDueRuns({ now: deps.clock.now().toISOString(), kinds, limit });
    for (const runId of ids) {
      if (input.signal?.aborted) break;
      try { runs.push(await deps.worker.execute(runId, { signal: input.signal })); }
      catch (error) { errors.push({ runId, code: error instanceof DomainError ? error.code : "SOURCE_WORKER_FAILED" }); }
    }
    return { runs, errors };
  }
  return { runOnce,
    async loop(input: { readonly signal: AbortSignal; readonly intervalMs?: number; readonly onCycle?: (report: SourceQueueCycleReport) => void | Promise<void> }) {
      const interval = input.intervalMs ?? 5000;
      if (!Number.isInteger(interval) || interval < 1000 || interval > 60_000) throw new DomainError("INVALID_SOURCE_QUEUE_CONFIG", "来源轮询间隔需为 1–60 秒。");
      while (!input.signal.aborted) {
        await input.onCycle?.(await runOnce({ signal: input.signal }));
        if (input.signal.aborted) break;
        await new Promise<void>(resolve => {
          const stop = () => { clearTimeout(timer); input.signal.removeEventListener("abort", stop); resolve(); };
          const timer = setTimeout(stop, interval); input.signal.addEventListener("abort", stop, { once: true });
          if (input.signal.aborted) stop();
        });
      }
    },
  };
}
