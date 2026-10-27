import { randomUUID } from "node:crypto";
import type { Clock, IdGenerator } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import type { ExecutionRun } from "../modules/operations/run-domain.ts";
import type { SourceConfig } from "../modules/operations/source-domain.ts";
import type { SourceJsonModelPort, SourceModelUsage } from "../modules/operations/source-worker.ts";
import { AiProviderError, createBudgetedModel, withAiExecutionContext, type AiExecutionContext, type AiTokenUsage, type JsonModelPort } from "./ai.ts";
import type { PostgresAiLedger } from "./ai-jobs.ts";

type SourceRequest = Parameters<SourceJsonModelPort["generateJson"]>[0];
interface RunRow { data: ExecutionRun; source_config_id: string; revision: number; status: string; lease_expires_at: string | Date | null }
interface SourceRow { data: SourceConfig; revision: number; status: string }
interface Admission extends AiExecutionContext {
  runId: string; attempt: number; sourceId: string; sourceRevision: number;
  runLeaseToken: string; workerId: string; deadlineAt: string;
}
function fail(code: string, status = 409): never { throw new DomainError(code, "来源任务、权限或执行租约已经变化，请核对最新任务状态。", { status }); }
const safeCode = (error: unknown): string => error instanceof DomainError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "SOURCE_MODEL_UNCERTAIN";
function active(signal: AbortSignal, state: "not_sent" | "unknown" = "not_sent"): void {
  if (signal.aborted) throw new AiProviderError("AI_SOURCE_CANCELLED", state);
}
function checkedTokens(usage: SourceModelUsage | undefined): AiTokenUsage | null {
  return usage && [usage.inputTokens, usage.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000)
    ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : null;
}
function snapshot(request: SourceRequest, maxInputBytes: number): SourceRequest {
  if (!request || typeof request.taskId !== "string" || !request.taskId.trim() || request.taskId.length > 200 || /[\u0000-\u001f]/.test(request.taskId) || !["source_crawl", "source_analysis"].includes(request.task) || typeof request.prompt !== "string" || !request.prompt.trim() || typeof request.schemaVersion !== "string" || !/^[A-Za-z0-9_.:/-]{1,160}$/.test(request.schemaVersion) || !request.signal || typeof request.signal.addEventListener !== "function") throw new AiProviderError("AI_INPUT_INVALID", "not_sent");
  let serialized: string;
  try { serialized = JSON.stringify(request.input); }
  catch { throw new AiProviderError("AI_INPUT_INVALID", "not_sent"); }
  if (serialized === undefined || !request.input || typeof request.input !== "object" || Array.isArray(request.input)) throw new AiProviderError("AI_INPUT_INVALID", "not_sent");
  if (Buffer.byteLength(serialized) + Buffer.byteLength(request.prompt) > maxInputBytes) throw new AiProviderError("AI_INPUT_TOO_LARGE", "not_sent");
  const input: unknown = JSON.parse(serialized);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AiProviderError("AI_INPUT_INVALID", "not_sent");
  return { ...request, input: input as Readonly<Record<string, unknown>> };
}

/** Root control-plane wrapper. Neither credentials nor this database are passed to
 * the isolated source executor. One attempt is a durable, non-retryable AI call.
 * Lock order matches M08 control and ingestion: run -> source -> user -> execution.
 * Heartbeats may advance run revision/expiry; attempt/token/deadline stay fixed. */
export function createBudgetedSourceModel(options: {
  database: DatabasePort; clock: Clock; ids: IdGenerator; model: SourceJsonModelPort;
  ledger: PostgresAiLedger; maxInputBytes: number; maxOutputTokens: number;
}): SourceJsonModelPort {
  const { database, clock, ids, model, ledger, maxInputBytes, maxOutputTokens } = options;
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1 || maxInputBytes > 2 * 1024 * 1024 || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 65_536 || !model?.generateJson || !model.modelVersion?.trim() || !/^[A-Za-z0-9_.:/-]{1,160}$/.test(model.promptVersion)) throw new DomainError("AI_CONFIG_INVALID", "来源模型预算配置无效。", { status: 503 });

  async function fresh(sql: SqlExecutor, request: SourceRequest, admission?: Admission): Promise<{ run: ExecutionRun; source: SourceRow }> {
    active(request.signal);
    const rows = await sql.query<RunRow>("SELECT data,source_config_id,revision,status,lease_expires_at FROM operations_execution_runs WHERE id=$1 FOR NO KEY UPDATE", [request.taskId]);
    const row = rows.rows[0], run = row?.data;
    if (!row || !run || run.id !== request.taskId || run.kind !== (request.task === "source_crawl" ? "crawl" : "analysis") || run.status !== "running" || row.status !== "running" || run.step !== "extracting" || run.sourceConfigId !== row.source_config_id || !Number.isSafeInteger(run.attempt) || run.attempt < 1 || !run.lease?.token || !run.lease.workerId) fail("WORKER_LEASE_LOST");
    const now = clock.now().getTime();
    if (!Number.isFinite(Date.parse(run.lease.expiresAt)) || !Number.isFinite(Date.parse(run.lease.deadlineAt)) || Date.parse(run.lease.expiresAt) <= now || Date.parse(run.lease.deadlineAt) <= now || !row.lease_expires_at || new Date(row.lease_expires_at).getTime() !== Date.parse(run.lease.expiresAt)) fail("WORKER_LEASE_LOST");
    const sources = await sql.query<SourceRow>("SELECT data,revision,status FROM operations_source_configs WHERE id=$1 FOR UPDATE", [run.sourceConfigId]);
    const source = sources.rows[0];
    if (!source || source.status !== "enabled" || source.data.status !== "enabled" || !source.data.verification || source.data.credentialPolicy !== "none" || source.data.revision !== source.revision || source.data.id !== run.sourceConfigId) fail("SOURCE_CONFIG_CHANGED");
    const users = await sql.query<{ status: string; platform_roles: string[]; email_verified_at: string | Date | null }>("SELECT status,platform_roles,email_verified_at FROM auth_users WHERE id=$1 FOR NO KEY UPDATE", [run.requestedBy]);
    const user = users.rows[0];
    if (!user || user.status !== "active" || !user.email_verified_at || !user.platform_roles.includes("admin")) fail("SOURCE_REQUESTER_FORBIDDEN", 403);
    if (run.kind === "crawl" && run.sourceSnapshot.revision !== source.revision) fail("SOURCE_CONFIG_CHANGED");
    if (run.kind === "analysis" && (run.schemaVersion !== request.schemaVersion || run.modelVersion !== model.modelVersion || run.promptVersion !== model.promptVersion)) fail("SOURCE_MODEL_VERSION_MISMATCH");
    if (admission && (run.requestedBy !== admission.actorId || run.sourceConfigId !== admission.sourceId || run.attempt !== admission.attempt || run.lease.token !== admission.runLeaseToken || run.lease.workerId !== admission.workerId || run.lease.deadlineAt !== admission.deadlineAt || source.revision !== admission.sourceRevision)) fail("WORKER_LEASE_LOST");
    if (admission) {
      const current = await sql.query("SELECT id FROM ai_execution_jobs WHERE id=$1 AND kind='source' AND module_job_id=$2 AND source_revision=$3 AND project_id=$4 AND actor_id=$5 AND status='running' AND lease_token=$6 AND lease_until=$7::timestamptz AND lease_until>$8::timestamptz FOR UPDATE", [admission.executionId, admission.runId, admission.attempt, admission.projectId, admission.actorId, admission.leaseToken, admission.deadlineAt, clock.now().toISOString()]);
      if (current.rowCount !== 1) throw new AiProviderError("AI_LEASE_LOST", "not_sent");
    }
    // Locks on source/requester can wait beyond the short heartbeat lease.
    // Evaluate expiry again after all facts have been locked, before any send/CAS.
    const checkedAt = clock.now().getTime();
    if (Date.parse(run.lease.expiresAt) <= checkedAt || Date.parse(run.lease.deadlineAt) <= checkedAt) fail("WORKER_LEASE_LOST");
    active(request.signal);
    return { run, source };
  }

  return { modelVersion: model.modelVersion, promptVersion: model.promptVersion, async generateJson(original) {
    const request = snapshot(original, maxInputBytes);
    active(request.signal);
    const admission = await database.transaction(async sql => {
      const { run, source } = await fresh(sql, request);
      // Reclaiming a crashed worker may advance its attempt without resolving the
      // previous paid request. Only an explicit new run can authorize another send.
      const prior = await sql.query("SELECT execution.id FROM ai_execution_jobs execution WHERE execution.kind='source' AND execution.module_job_id=$1 AND execution.source_revision<$2 AND (execution.status IN ('running','unknown') OR execution.external_state='unknown' OR EXISTS(SELECT 1 FROM ai_usage_attempts usage WHERE usage.execution_id=execution.id AND usage.status='reserved')) FOR UPDATE OF execution", [run.id, run.attempt]);
      if (prior.rowCount > 0) throw new AiProviderError("SOURCE_PRIOR_RESULT_UNCERTAIN", "not_sent");
      const context: Admission = { executionId: ids.next(), leaseToken: randomUUID(), projectId: `source:${source.data.id}`, actorId: run.requestedBy, runId: run.id, attempt: run.attempt, sourceId: source.data.id, sourceRevision: source.revision, runLeaseToken: run.lease!.token, workerId: run.lease!.workerId, deadlineAt: run.lease!.deadlineAt };
      const at = clock.now().toISOString();
      const inserted = await sql.query("INSERT INTO ai_execution_jobs(id,kind,module_job_id,source_revision,project_id,actor_id,status,attempts,lease_owner,lease_token,lease_until,created_at,updated_at) VALUES($1,'source',$2,$3,$4,$5,'running',1,'source-inline',$6,$7::timestamptz,$8::timestamptz,$8::timestamptz) ON CONFLICT(kind,module_job_id,source_revision) DO NOTHING RETURNING id", [context.executionId, run.id, run.attempt, context.projectId, run.requestedBy, context.leaseToken, context.deadlineAt, at]);
      if (inserted.rowCount !== 1) throw new AiProviderError("AI_SOURCE_ALREADY_DISPATCHED", "not_sent");
      return context;
    });
    let received = false, dispatched = false;
    let output: Awaited<ReturnType<SourceJsonModelPort["generateJson"]>> | undefined;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.signal.addEventListener("abort", cancel, { once: true });
    if (request.signal.aborted) cancel();
    const remaining = Math.max(0, Date.parse(admission.deadlineAt) - clock.now().getTime());
    const timer = setTimeout(cancel, remaining);
    const guardedRequest = { ...request, signal: controller.signal };
    const raw: JsonModelPort = { modelVersion: model.modelVersion, async completeJSON(_input, signal) {
      // Admission and budget settlement are separate short transactions. Recheck
      // current source/account/run after reservation and immediately before send.
      try { await database.transaction(sql => fresh(sql, guardedRequest, admission)); }
      catch (error) { throw error instanceof AiProviderError ? error : new AiProviderError(safeCode(error), "not_sent"); }
      active(signal);
      let onAbort = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new AiProviderError("AI_SOURCE_CANCELLED", dispatched ? "unknown" : "not_sent"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      try {
        active(signal);
        dispatched = true;
        const result = await Promise.race([model.generateJson(guardedRequest), aborted]);
        received = true;
        const usage = checkedTokens(result?.usage);
        let serialized: string | undefined;
        try { serialized = JSON.stringify(result?.json); } catch { /* Reject circular/non-JSON output. */ }
        if (!usage || !result.usage || result.usage.currency !== "USD" || !Number.isSafeInteger(result.usage.estimatedCostMicros) || result.usage.estimatedCostMicros < 0 || usage.outputTokens > maxOutputTokens) throw new AiProviderError("SOURCE_MODEL_USAGE_INVALID", "unknown", { usage });
        if (serialized === undefined || Buffer.byteLength(serialized) > Math.min(2 * 1024 * 1024, maxOutputTokens * 32 + 4096)) throw new AiProviderError("AI_SOURCE_OUTPUT_INVALID", "unknown", { usage });
        output = { json: result.json, usage: { ...result.usage } };
        return { content: result.json, usage, requestId: null, modelVersion: model.modelVersion };
      } catch (error) {
        // Source providers have no reliable no-send/error metadata contract.
        // Every exception after invoking generateJson is uncertain and terminal.
        if (!dispatched) throw error;
        throw new AiProviderError(safeCode(error), "unknown", { usage: error instanceof AiProviderError ? error.usage : null });
      } finally { signal.removeEventListener("abort", onAbort); }
    } };
    const budgeted = createBudgetedModel({ model: raw, ledger, maxInputBytes, maxOutputTokens, maxAttempts: 1, clock: () => clock.now() });
    try {
      await withAiExecutionContext(admission, () => budgeted.completeJSON({ systemPrompt: request.prompt, input: request.input, promptVersion: model.promptVersion, maxOutputTokens }, controller.signal));
      await database.transaction(async sql => {
        await fresh(sql, guardedRequest, admission);
        const at = clock.now().toISOString();
        const completed = await sql.query("UPDATE ai_execution_jobs SET status='succeeded',external_state='response_received',error_code=NULL,lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=$3::timestamptz WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>$3::timestamptz AND EXISTS(SELECT 1 FROM operations_execution_runs WHERE id=$4 AND status='running' AND lease_expires_at>$3::timestamptz AND (data->'lease'->>'deadlineAt')::timestamptz>$3::timestamptz) RETURNING id", [admission.executionId, admission.leaseToken, at, admission.runId]);
        if (completed.rowCount !== 1) throw new AiProviderError("AI_LEASE_LOST", "response_received");
      });
      return output!;
    } catch (error) {
      let unresolved = false;
      try { unresolved = (await database.query("SELECT id FROM ai_usage_attempts WHERE execution_id=$1 AND status='reserved' LIMIT 1", [admission.executionId])).rowCount > 0; }
      catch { unresolved = true; }
      try { await ledger.recoverReservations(admission.executionId, clock.now().toISOString()); }
      catch { unresolved = true; }
      const unknown = unresolved || (error instanceof AiProviderError && (error.externalState === "unknown" || error.code === "AI_LEASE_LOST"));
      try {
        await database.query("UPDATE ai_execution_jobs SET status=$3,external_state=$4,error_code=$5,lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=$6::timestamptz WHERE id=$1 AND lease_token=$2 AND status='running'", [admission.executionId, admission.leaseToken, unknown ? "unknown" : "failed", unknown ? "unknown" : received ? "response_received" : "not_sent", safeCode(error), clock.now().toISOString()]);
      } catch { /* Persisted lease + reservation remain recoverable by the watchdog. */ }
      throw error;
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", cancel);
    }
  } };
}
