import type { Actor, Clock } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../shared/errors.ts";
import { createOperationsObservabilityService } from "../modules/operations/observability-service.ts";
import { createPostgresOperationsObservabilityQueryPort } from "../modules/operations/observability-postgres.ts";
import { createOperationsObservabilityHandlers } from "../modules/operations/observability-handlers.ts";
import type { SourceObservabilityInput, SourceRuntimeObservation } from "../modules/operations/observability-types.ts";
import type { AiBudgetPolicy } from "./ai-jobs.ts";

/** Root resolves an actual website session; never construct this from request JSON. */
export interface OperationsAdminPrincipal {
  readonly actor: Actor;
  readonly guard: (sql: SqlExecutor) => Promise<void>;
}
export async function assertOperationsAdmin(principal: OperationsAdminPrincipal, sql: SqlExecutor): Promise<void> {
  if (!principal?.actor?.platformRoles.includes("admin") || typeof principal.guard !== "function") {
    throw new DomainError("FORBIDDEN", "此查询需要当前有效的管理员登录。", { status: 403 });
  }
  // Lock order matches root identity: account -> request session.
  const current = await sql.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL AND 'admin'=ANY(platform_roles) FOR SHARE", [principal.actor.userId]);
  if (!current.rowCount) throw new DomainError("FORBIDDEN", "管理员权限已经变化，请重新登录。", { status: 403 });
  await principal.guard(sql);
}

const runtimeSql = `WITH scoped_jobs AS (
  SELECT * FROM ai_execution_jobs WHERE kind='source' AND project_id=$1
), historical_usage AS (
  SELECT u.* FROM ai_usage_attempts u JOIN scoped_jobs j ON j.id=u.execution_id WHERE u.project_id=$1
), daily_usage AS (
  SELECT count(*) FILTER(WHERE NOT cost_configured OR status='reserved' OR
    (status='settled' AND external_state IN ('unknown','response_received') AND NOT usage_verified))::text AS incomplete
  FROM historical_usage WHERE period=$2::date
), unknown_jobs AS (
  SELECT count(*)::text AS count FROM scoped_jobs j
  WHERE j.status='unknown' OR j.external_state='unknown' OR
    (j.status='running' AND j.lease_until<=$3::timestamptz) OR
    EXISTS(SELECT 1 FROM historical_usage u WHERE u.execution_id=j.id AND u.external_state='unknown')
)
SELECT (SELECT jsonb_build_object('status',status,'lastSeenAt',last_seen_at)
  FROM backend_worker_heartbeats WHERE kind='source'
  ORDER BY (status<>'stopped' AND last_seen_at >= $3::timestamptz-interval '120 seconds') DESC,last_seen_at DESC,worker_id DESC LIMIT 1) AS worker,
  COALESCE((SELECT calls FROM ai_budget_buckets WHERE project_id=$1 AND period=$2::date),0) AS calls,
  COALESCE((SELECT reserved_micro_usd::text FROM ai_budget_buckets WHERE project_id=$1 AND period=$2::date),'0') AS reserved,
  COALESCE((SELECT charged_micro_usd::text FROM ai_budget_buckets WHERE project_id=$1 AND period=$2::date),'0') AS charged,
  (SELECT count(*)::text FROM historical_usage WHERE status='reserved') AS pending,
  (SELECT count FROM unknown_jobs) AS unknown,
  (SELECT incomplete FROM daily_usage) AS incomplete`;
const number = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new DomainError("OBSERVABILITY_DATA_INVALID", "后台摘要暂时不可用。", { status: 503 });
  return parsed;
};
const micros = (value: unknown): string => {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new DomainError("OBSERVABILITY_DATA_INVALID", "后台费用摘要暂时不可用。", { status: 503 });
  return BigInt(value).toString();
};

/** Read-only composition: no ledger initialization, network, enqueue or recovery. */
export function createOperationsObservability(deps: {
  readonly database: DatabasePort;
  readonly clock: Clock;
  readonly cursorSecret: string;
  readonly sourceModelConfigured: boolean;
  readonly sourceBudget?: AiBudgetPolicy;
  readonly resolvePrincipal: (request: Request) => Promise<OperationsAdminPrincipal | null>;
  readonly requestId: (request: Request) => string;
}) {
  // Validate server-only cursor configuration immediately, even before a request.
  const repository = createPostgresOperationsObservabilityQueryPort(deps.database);
  const serviceFor = (principal: OperationsAdminPrincipal) => createOperationsObservabilityService({
    repository, clock: deps.clock, cursorSecret: deps.cursorSecret,
    authorization: { assertCurrentAdmin: async (actor, sql) => {
      if (actor.userId !== principal.actor.userId) throw new DomainError("FORBIDDEN", "管理员身份不匹配。", { status: 403 });
      await assertOperationsAdmin(principal, sql);
    } },
    runtime: { async readSourceRuntime({ sourceId, observedAt }, sql): Promise<SourceRuntimeObservation> {
      const day = observedAt.slice(0, 10);
      const row = (await sql.query<{worker: null | {status: string; lastSeenAt: string}; calls: number; reserved: string; charged: string; pending: string; unknown: string; incomplete: string}>(runtimeSql, [`source:${sourceId}`, day, observedAt])).rows[0];
      if (!row) throw new DomainError("OBSERVABILITY_DATA_INVALID", "后台摘要暂时不可用。", { status: 503 });
      const calls = number(row.calls), pending = number(row.pending), unknown = number(row.unknown);
      const reserved = micros(row.reserved), charged = micros(row.charged);
      const policy = deps.sourceBudget;
      const limited = policy && (calls >= policy.dailyProjectCallLimit || policy.dailyProjectBudgetMicroUsd !== undefined && BigInt(reserved) + BigInt(charged) >= BigInt(policy.dailyProjectBudgetMicroUsd));
      let worker: SourceRuntimeObservation["worker"] = { scope: "all_sources", status: "not_started", lastSeenAt: null };
      if (row.worker) {
        const lastSeenAt = new Date(row.worker.lastSeenAt).toISOString();
        const state = row.worker.status;
        if (!["idle", "running", "failed", "stopped"].includes(state)) throw new DomainError("OBSERVABILITY_DATA_INVALID", "后台心跳摘要暂时不可用。", { status: 503 });
        worker = { scope: "all_sources", status: state !== "stopped" && Date.parse(observedAt) - Date.parse(lastSeenAt) > 120_000 ? "stale" : state as "idle" | "running" | "failed" | "stopped", lastSeenAt };
      }
      return { measuredAt: observedAt, worker, model: {
        quotaDay: day, quotaTimezone: "UTC", calls, pendingReservations: pending, unknownRequests: unknown,
        completeCostMicroUsd: !deps.sourceModelConfigured || !policy || policy.inputMicroUsdPerMillion === undefined || policy.outputMicroUsdPerMillion === undefined || number(row.incomplete) > 0 || pending > 0 || unknown > 0 ? null : charged,
        reservedMicroUsd: deps.sourceModelConfigured && policy?.inputMicroUsdPerMillion !== undefined && policy.outputMicroUsdPerMillion !== undefined ? reserved : null,
        admission: unknown > 0 ? "unknown_request" : !deps.sourceModelConfigured || !policy ? "not_configured" : limited ? "limited" : pending > 0 ? "unknown_request" : "allowed",
      } };
    } },
  });
  // These closures never execute until source() or its authenticated GET handler.
  if (Buffer.byteLength(deps.cursorSecret) < 32 || Buffer.byteLength(deps.cursorSecret) > 4096) throw new DomainError("OBSERVABILITY_CONFIG_INVALID", "管理员查询游标签名未配置。", { status: 503 });
  return {
    service: { async source(principal: OperationsAdminPrincipal, input: SourceObservabilityInput) {
      return serviceFor(principal).source(principal.actor, input);
    } },
    handlers: { source: (sourceId: string) => async (request: Request): Promise<Response> => {
      const requestId = deps.requestId(request);
      try {
        const principal = await deps.resolvePrincipal(request);
        if (!principal) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
        return await createOperationsObservabilityHandlers({ service: serviceFor(principal), resolveActor: async () => principal.actor, requestId: () => requestId }).source(sourceId)(request);
      } catch (error) {
        return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers: { "Cache-Control": "no-store, private", Vary: "Cookie, Authorization" } });
      }
    } },
  };
}
