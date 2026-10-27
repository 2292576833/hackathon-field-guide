import { randomUUID } from "node:crypto";
import { DomainError } from "../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import type { EventsService } from "../modules/events/index.ts";
import type { AssessmentService, AssignmentGenerationService, RoleHelpService } from "../modules/assessments/index.ts";
import type { PlanningGenerationService } from "../modules/planning/index.ts";
import type { RetrospectiveService, GenerationBudgetPort } from "../modules/retrospectives/index.ts";
import { AiProviderError, withAiExecutionContext, type AiBudgetLedgerPort, type AiExecutionContext, type AiExternalState, type AiTokenUsage } from "./ai.ts";

/** Coordinator copies this into the next root migration; runtime never creates tables. */
export const AI_SCHEMA_SQL = `
CREATE TABLE ai_execution_jobs (
 id text PRIMARY KEY, kind text NOT NULL, module_job_id text NOT NULL, source_revision integer NOT NULL CHECK(source_revision>0),
 project_id text NOT NULL, actor_id text NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled','unknown')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), lease_owner text, lease_token text, lease_until timestamptz,
 error_code text CHECK(error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 external_state text NOT NULL DEFAULT 'not_sent' CHECK(external_state IN ('not_sent','rejected','response_received','unknown')),
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 UNIQUE(kind,module_job_id,source_revision),
 CHECK((status='running' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR
       (status<>'running' AND lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX ai_execution_queue ON ai_execution_jobs(status,created_at,id);
CREATE TABLE ai_budget_buckets (
 project_id text NOT NULL, period date NOT NULL,
 calls integer NOT NULL DEFAULT 0 CHECK(calls>=0), reserved_micro_usd bigint NOT NULL DEFAULT 0 CHECK(reserved_micro_usd>=0),
 charged_micro_usd bigint NOT NULL DEFAULT 0 CHECK(charged_micro_usd>=0), PRIMARY KEY(project_id,period)
);
CREATE TABLE ai_usage_attempts (
 id text PRIMARY KEY, execution_id text NOT NULL REFERENCES ai_execution_jobs(id), project_id text NOT NULL, actor_id text NOT NULL,
 period date NOT NULL, model_version text NOT NULL, prompt_version text NOT NULL,
 status text NOT NULL CHECK(status IN ('reserved','settled')),
 cost_configured boolean NOT NULL, input_rate_micro_usd_per_million bigint, output_rate_micro_usd_per_million bigint,
 reserved_micro_usd bigint, charged_micro_usd bigint, input_tokens bigint, output_tokens bigint,
 usage_verified boolean NOT NULL DEFAULT false,
 external_state text NOT NULL CHECK(external_state IN ('not_sent','rejected','response_received','unknown')),
 request_id text, error_code text CHECK(error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 created_at timestamptz NOT NULL, settled_at timestamptz,
 CHECK(input_tokens IS NULL OR input_tokens>=0), CHECK(output_tokens IS NULL OR output_tokens>=0),
 CHECK((cost_configured AND input_rate_micro_usd_per_million>=0 AND output_rate_micro_usd_per_million>=0 AND reserved_micro_usd>=0) OR
       (NOT cost_configured AND input_rate_micro_usd_per_million IS NULL AND output_rate_micro_usd_per_million IS NULL AND reserved_micro_usd IS NULL AND charged_micro_usd IS NULL)),
 CHECK((status='reserved' AND settled_at IS NULL) OR (status='settled' AND settled_at IS NOT NULL))
);
CREATE INDEX ai_usage_execution ON ai_usage_attempts(execution_id,created_at,id);
CREATE TABLE ai_generation_admissions (
 job_id text PRIMARY KEY, project_id text NOT NULL, actor_id text NOT NULL, admitted_at timestamptz NOT NULL
);
`;

export interface AiBudgetPolicy {
  dailyProjectCallLimit: number;
  dailyProjectBudgetMicroUsd?: number;
  inputMicroUsdPerMillion?: number;
  outputMicroUsdPerMillion?: number;
}
function integer(value: number, minimum: number, maximum = 1_000_000_000_000): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new DomainError("AI_CONFIG_INVALID", "AI 执行或预算配置无效。", { status: 503 });
}
function safeCode(value: unknown, fallback = "AI_EXECUTION_FAILED"): string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : fallback;
}
function identity(value: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\u0000-\u001f]/.test(value)) throw new DomainError("AI_INPUT_INVALID", "AI 任务标识无效。", { status: 422 });
}
function period(at: string): string {
  const time = new Date(at);
  if (!Number.isFinite(time.getTime()) || time.toISOString() !== at) throw new DomainError("AI_INPUT_INVALID", "AI 任务时间无效。", { status: 422 });
  return at.slice(0, 10);
}
function cost(tokens: AiTokenUsage, inputRate: number, outputRate: number): number {
  integer(tokens.inputTokens, 0, 1_000_000_000); integer(tokens.outputTokens, 0, 1_000_000_000);
  const total = (BigInt(tokens.inputTokens) * BigInt(inputRate) + BigInt(tokens.outputTokens) * BigInt(outputRate) + 999_999n) / 1_000_000n;
  const result = Number(total);
  if (!Number.isSafeInteger(result)) throw new DomainError("AI_COST_INVALID", "AI 费用记录超过允许范围。", { status: 503 });
  return result;
}
interface Bucket { calls: number; reserved_micro_usd: string | number; charged_micro_usd: string | number }
interface Attempt {
  id: string; execution_id: string; project_id: string; period: string | Date; status: "reserved" | "settled";
  reserved_micro_usd: string | number | null; input_rate_micro_usd_per_million: string | number | null;
  output_rate_micro_usd_per_million: string | number | null; cost_configured: boolean;
  charged_micro_usd: string | number | null; usage_verified: boolean;
}
/** Every provider attempt is counted, including explicit rejection and uncertain completion. */
export class PostgresAiLedger implements AiBudgetLedgerPort {
  private readonly database: DatabasePort;
  readonly policy: AiBudgetPolicy;
  readonly costConfigured: boolean;
  constructor(database: DatabasePort, policy: AiBudgetPolicy) {
    integer(policy.dailyProjectCallLimit, 1, 100_000);
    const priced = policy.inputMicroUsdPerMillion !== undefined && policy.outputMicroUsdPerMillion !== undefined;
    if ((policy.inputMicroUsdPerMillion === undefined) !== (policy.outputMicroUsdPerMillion === undefined) || (policy.dailyProjectBudgetMicroUsd !== undefined && !priced)) throw new DomainError("AI_CONFIG_INVALID", "金额预算需要同时配置输入和输出费率；未配置费率时只限制调用数和 token。", { status: 503 });
    if (priced) { integer(policy.inputMicroUsdPerMillion!, 0); integer(policy.outputMicroUsdPerMillion!, 0); }
    if (policy.dailyProjectBudgetMicroUsd !== undefined) integer(policy.dailyProjectBudgetMicroUsd, 1);
    this.database = database; this.policy = Object.freeze({ ...policy }); this.costConfigured = priced;
  }
  private async bucket(sql: SqlExecutor, projectId: string, day: string): Promise<Bucket> {
    await sql.query("INSERT INTO ai_budget_buckets(project_id,period) VALUES($1,$2::date) ON CONFLICT DO NOTHING", [projectId, day]);
    const result = await sql.query<Bucket>("SELECT calls,reserved_micro_usd,charged_micro_usd FROM ai_budget_buckets WHERE project_id=$1 AND period=$2::date FOR UPDATE", [projectId, day]);
    return result.rows[0]!;
  }
  private assertBucket(bucket: Bucket, required: number): void {
    if (bucket.calls >= this.policy.dailyProjectCallLimit || (this.policy.dailyProjectBudgetMicroUsd !== undefined && Number(bucket.reserved_micro_usd) + Number(bucket.charged_micro_usd) + required > this.policy.dailyProjectBudgetMicroUsd)) throw new AiProviderError("AI_BUDGET_EXCEEDED", "not_sent");
  }
  async reserve(input: Parameters<AiBudgetLedgerPort["reserve"]>[0]): Promise<void> {
    for (const value of [input.id, input.executionId, input.leaseToken, input.projectId, input.actorId, input.modelVersion, input.promptVersion]) identity(value);
    integer(input.inputTokenUpperBound, 1, 3_000_000); integer(input.maxOutputTokens, 1, 65_536);
    const day = period(input.occurredAt);
    const reserved = this.costConfigured ? cost({ inputTokens: input.inputTokenUpperBound, outputTokens: input.maxOutputTokens }, this.policy.inputMicroUsdPerMillion!, this.policy.outputMicroUsdPerMillion!) : null;
    await this.database.transaction(async sql => {
      const active = await sql.query("SELECT id FROM ai_execution_jobs WHERE id=$1 AND project_id=$2 AND actor_id=$3 AND status='running' AND lease_token=$4 AND lease_until>$5::timestamptz FOR UPDATE", [input.executionId, input.projectId, input.actorId, input.leaseToken, input.occurredAt]);
      if (!active.rows.length) throw new AiProviderError("AI_LEASE_LOST", "not_sent");
      const existing = await sql.query<{ execution_id: string }>("SELECT execution_id FROM ai_usage_attempts WHERE id=$1", [input.id]);
      if (existing.rows.length) {
        if (existing.rows[0]!.execution_id !== input.executionId) throw new DomainError("IDEMPOTENCY_CONFLICT", "AI 预算键已经用于另一任务。", { status: 409 });
        return;
      }
      const bucket = await this.bucket(sql, input.projectId, day);
      this.assertBucket(bucket, reserved ?? 0);
      await sql.query("UPDATE ai_budget_buckets SET calls=calls+1,reserved_micro_usd=reserved_micro_usd+$3 WHERE project_id=$1 AND period=$2::date", [input.projectId, day, reserved ?? 0]);
      await sql.query(`INSERT INTO ai_usage_attempts(id,execution_id,project_id,actor_id,period,model_version,prompt_version,status,cost_configured,input_rate_micro_usd_per_million,output_rate_micro_usd_per_million,reserved_micro_usd,external_state,created_at)
        VALUES($1,$2,$3,$4,$5::date,$6,$7,'reserved',$8,$9,$10,$11,'not_sent',$12::timestamptz)`, [input.id, input.executionId, input.projectId, input.actorId, day, input.modelVersion, input.promptVersion, this.costConfigured, this.policy.inputMicroUsdPerMillion ?? null, this.policy.outputMicroUsdPerMillion ?? null, reserved, input.occurredAt]);
    });
  }
  async settle(input: Parameters<AiBudgetLedgerPort["settle"]>[0]): Promise<void> {
    identity(input.id); period(input.occurredAt);
    if (!["not_sent", "rejected", "response_received", "unknown"].includes(input.externalState)) throw new DomainError("AI_INPUT_INVALID", "AI 外部结果状态无效。");
    await this.database.transaction(async sql => {
      const result = await sql.query<Attempt>("SELECT * FROM ai_usage_attempts WHERE id=$1 FOR UPDATE", [input.id]);
      const row = result.rows[0];
      if (!row) throw new DomainError("AI_RESERVATION_NOT_FOUND", "AI 预算记录不存在。", { status: 404 });
      // A late response may supply previously unknown billable usage. Refine cost once;
      // the execution lease fence still prevents returning its generated content.
      if (row.status === "settled" && (row.usage_verified || input.usage === null)) return;
      const reserved = Number(row.reserved_micro_usd ?? 0);
      const charged = row.cost_configured ? (input.usage ? cost(input.usage, Number(row.input_rate_micro_usd_per_million), Number(row.output_rate_micro_usd_per_million)) : ["not_sent", "rejected"].includes(input.externalState) ? 0 : reserved) : null;
      const day = typeof row.period === "string" ? row.period.slice(0, 10) : row.period.toISOString().slice(0, 10);
      await this.bucket(sql, row.project_id, day);
      await sql.query("UPDATE ai_budget_buckets SET reserved_micro_usd=reserved_micro_usd-$3,charged_micro_usd=charged_micro_usd+$4 WHERE project_id=$1 AND period=$2::date", [row.project_id, day, row.status === "reserved" ? reserved : 0, (charged ?? 0) - (row.status === "settled" ? Number(row.charged_micro_usd ?? 0) : 0)]);
      await sql.query(`UPDATE ai_usage_attempts SET status='settled',charged_micro_usd=$2,input_tokens=$3,output_tokens=$4,usage_verified=$5,external_state=$6,request_id=$7,error_code=$8,settled_at=$9::timestamptz WHERE id=$1`, [input.id, charged, input.usage?.inputTokens ?? null, input.usage?.outputTokens ?? null, input.usage !== null, input.externalState, input.requestId, input.errorCode === null ? null : safeCode(input.errorCode), input.occurredAt]);
    });
  }
  async assertActive(context: AiExecutionContext, occurredAt: string): Promise<void> {
    period(occurredAt);
    const active = await this.database.query("SELECT id FROM ai_execution_jobs WHERE id=$1 AND project_id=$2 AND actor_id=$3 AND lease_token=$4 AND status='running' AND lease_until>$5::timestamptz", [context.executionId, context.projectId, context.actorId, context.leaseToken, occurredAt]);
    if (!active.rows.length) throw new AiProviderError("AI_LEASE_LOST", "not_sent");
  }
  /** Queue admission is idempotent and checks capacity; actual requests alone consume it. */
  generationBudget(): GenerationBudgetPort {
    return { reserve: input => this.database.transaction(async sql => {
      for (const value of [input.jobId, input.projectId, input.actorId]) identity(value);
      const old = await sql.query<{ project_id: string; actor_id: string }>("SELECT project_id,actor_id FROM ai_generation_admissions WHERE job_id=$1", [input.jobId]);
      if (old.rows.length) {
        if (old.rows[0]!.project_id !== input.projectId || old.rows[0]!.actor_id !== input.actorId) throw new DomainError("IDEMPOTENCY_CONFLICT", "整理预算键已用于另一任务。", { status: 409 });
        return;
      }
      this.assertBucket(await this.bucket(sql, input.projectId, period(input.occurredAt)), 0);
      await sql.query("INSERT INTO ai_generation_admissions(job_id,project_id,actor_id,admitted_at) VALUES($1,$2,$3,$4::timestamptz)", [input.jobId, input.projectId, input.actorId, input.occurredAt]);
    }) };
  }
  async recoverReservations(executionId: string, occurredAt: string): Promise<void> {
    const result = await this.database.query<{ id: string }>("SELECT id FROM ai_usage_attempts WHERE execution_id=$1 AND status='reserved' ORDER BY id", [executionId]);
    for (const row of result.rows) await this.settle({ id: row.id, externalState: "unknown", usage: null, requestId: null, errorCode: "AI_WORKER_EXPIRED_UNCERTAIN", occurredAt });
  }
}

export interface AiModuleJobRef { id: string; projectId: string; actorId: string; revision: number; createdAt: string; status: string }
export interface AiModuleResult { status: string; errorCode?: string | null; failureCode?: string | null }
export interface AiModuleHandler {
  kind: string;
  listQueued(limit: number): Promise<readonly AiModuleJobRef[]>;
  listRunning?(limit: number): Promise<readonly AiModuleJobRef[]>;
  listRecoverable?(limit: number): Promise<readonly AiModuleJobRef[]>;
  execute(id: string): Promise<AiModuleResult>;
  recover(id: string): Promise<AiModuleResult>;
}
interface ExecutionRow {
  id: string; kind: string; module_job_id: string; source_revision: number; project_id: string; actor_id: string;
  status: string; attempts: number; lease_token: string | null; lease_owner: string | null; lease_until: string | Date | null;
}
export function createStandardAiHandlers(input: {
  database: DatabasePort;
  events: Pick<EventsService, "processAnalysisRun" | "recoverExpiredAnalysisRun">;
  assessments: Pick<AssessmentService, "processScoringJob" | "recoverExpiredScoringJob">;
  retrospectives: Pick<RetrospectiveService, "runGeneration" | "recoverExpiredGeneration">;
  assignments?: Pick<AssignmentGenerationService, "execute" | "recover">;
  planningGeneration?: Pick<PlanningGenerationService, "processGenerationJob" | "recoverExpiredGenerationJob">;
  roleHelp?: Pick<RoleHelpService, "execute" | "recover">;
}): AiModuleHandler[] {
  const list = async (kind: "events" | "assessments" | "retrospectives" | "assignments" | "planning" | "roleHelp", status: string, limit: number): Promise<AiModuleJobRef[]> => {
    integer(limit, 1, 100);
    const queries = {
      events: "SELECT d.id,d.body->>'projectId' AS project_id,d.body->>'actorId' AS actor_id,d.revision,d.body->>'queuedAt' AS created_at,d.body->>'status' AS status FROM m03_analysis_runs d WHERE d.body->>'status'=$1 AND ($1<>'queued' OR NOT EXISTS(SELECT 1 FROM ai_execution_jobs e WHERE e.kind='m03_analysis' AND e.module_job_id=d.id AND e.source_revision=d.revision)) ORDER BY d.body->>'queuedAt',d.id LIMIT $2",
      assessments: "SELECT d.id,d.project_id,d.user_id AS actor_id,d.revision,d.created_at,d.status FROM assessments_scoring_jobs d WHERE d.status=$1 AND ($1<>'queued' OR NOT EXISTS(SELECT 1 FROM ai_execution_jobs e WHERE e.kind='m04_scoring' AND e.module_job_id=d.id AND e.source_revision=d.revision)) ORDER BY d.created_at,d.id LIMIT $2",
      retrospectives: "SELECT d.id,d.project_id,d.owner_id AS actor_id,d.revision,d.created_at,d.body->>'status' AS status FROM m07_documents d WHERE d.kind='generation_job' AND d.body->>'status'=$1 AND ($1<>'queued' OR NOT EXISTS(SELECT 1 FROM ai_execution_jobs e WHERE e.kind='m07_retrospective' AND e.module_job_id=d.id AND e.source_revision=d.revision)) ORDER BY d.created_at,d.id LIMIT $2",
      assignments: "SELECT d.id,d.project_id,d.user_id AS actor_id,d.revision,d.created_at,d.status FROM assessments_assignment_jobs d WHERE d.status=$1 AND ($1<>'queued' OR NOT EXISTS(SELECT 1 FROM ai_execution_jobs e WHERE e.kind='assignment_suggestion' AND e.module_job_id=d.id AND e.source_revision=d.revision)) ORDER BY d.created_at,d.id LIMIT $2",
      planning: "SELECT d.id,d.project_id,d.actor_id,d.revision,d.created_at,d.status FROM planning_generation_jobs d WHERE d.status=$1 AND ($1<>'queued' OR NOT EXISTS(SELECT 1 FROM ai_execution_jobs e WHERE e.kind='m05_planning' AND e.module_job_id=d.id AND e.source_revision=d.revision)) ORDER BY d.created_at,d.id LIMIT $2",
      roleHelp: "SELECT d.id,d.project_id,d.user_id AS actor_id,d.revision,d.created_at,d.status FROM assessments_role_help_jobs d WHERE d.status=$1 AND ($1<>'queued' OR NOT EXISTS(SELECT 1 FROM ai_execution_jobs e WHERE e.kind='m04_role_help' AND e.module_job_id=d.id AND e.source_revision=d.revision)) ORDER BY d.created_at,d.id LIMIT $2",
    };
    const rows = await input.database.query<{ id: string; project_id: string; actor_id: string; revision: number; created_at: string | Date; status: string }>(queries[kind], [status, limit]);
    return rows.rows.map(row => ({ id: row.id, projectId: row.project_id, actorId: row.actor_id, revision: Number(row.revision), createdAt: new Date(row.created_at).toISOString(), status: row.status }));
  };
  const handlers: AiModuleHandler[] = [
    { kind: "m03_analysis", listQueued: limit => list("events", "queued", limit), listRunning: limit => list("events", "running", limit), execute: id => input.events.processAnalysisRun(id), recover: id => input.events.recoverExpiredAnalysisRun(id) },
    { kind: "m04_scoring", listQueued: limit => list("assessments", "queued", limit), listRunning: limit => list("assessments", "running", limit), execute: id => input.assessments.processScoringJob(id), recover: id => input.assessments.recoverExpiredScoringJob(id) },
    { kind: "m07_retrospective", listQueued: limit => list("retrospectives", "queued", limit), listRunning: limit => list("retrospectives", "running", limit), execute: id => input.retrospectives.runGeneration(id), recover: id => input.retrospectives.recoverExpiredGeneration(id) },
  ];
  if (input.assignments) handlers.push({ kind: "assignment_suggestion", listQueued: limit => list("assignments", "queued", limit), listRunning: limit => list("assignments", "running", limit), execute: id => input.assignments!.execute(id), recover: id => input.assignments!.recover(id) });
  if (input.planningGeneration) handlers.push({ kind: "m05_planning", listQueued: limit => list("planning", "queued", limit), listRunning: limit => list("planning", "running", limit), execute: id => input.planningGeneration!.processGenerationJob(id), recover: id => input.planningGeneration!.recoverExpiredGenerationJob(id) });
  if (input.roleHelp) handlers.push({kind:"m04_role_help", listQueued:limit=>list("roleHelp","queued",limit), listRunning:limit=>list("roleHelp","running",limit), execute:id=>input.roleHelp!.execute(id), recover:id=>input.roleHelp!.recover(id)});
  return handlers;
}
export interface AiWorkerOptions {
  database: DatabasePort;
  ledger: PostgresAiLedger;
  handlers: readonly AiModuleHandler[];
  workerId?: string;
  leaseMs?: number;
  batchSize?: number;
  clock?: () => Date;
  /** Fresh application-owned account check, without coupling this worker to auth SQL. */
  assertActor?: (actorId: string) => Promise<void>;
}
export function createAiWorker(options: AiWorkerOptions) {
  const handlers = new Map<string, AiModuleHandler>();
  for (const handler of options.handlers) {
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(handler.kind) || handlers.has(handler.kind)) throw new DomainError("AI_CONFIG_INVALID", "AI 任务类型重复或无效。", { status: 503 });
    handlers.set(handler.kind, handler);
  }
  const workerId = options.workerId ?? randomUUID(); identity(workerId);
  const leaseMs = options.leaseMs ?? 120_000; integer(leaseMs, 1000, 600_000);
  const batchSize = options.batchSize ?? 20; integer(batchSize, 1, 100);
  const clock = options.clock ?? (() => new Date());
  const now = () => clock().toISOString();
  async function discover(): Promise<number> {
    let discovered = 0;
    for (const handler of handlers.values()) {
      for (const job of await handler.listQueued(batchSize)) {
        for (const value of [job.id, job.projectId, job.actorId]) identity(value);
        integer(job.revision, 1, 2_147_483_647); period(job.createdAt);
        if (job.status !== "queued") continue;
        const at = now();
        const result = await options.database.query(`INSERT INTO ai_execution_jobs(id,kind,module_job_id,source_revision,project_id,actor_id,status,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,'queued',$7::timestamptz,$8::timestamptz) ON CONFLICT(kind,module_job_id,source_revision) DO NOTHING`, [randomUUID(), handler.kind, job.id, job.revision, job.projectId, job.actorId, job.createdAt, at]);
        discovered += result.rowCount;
      }
    }
    return discovered;
  }
  async function recoverExpired(): Promise<number> {
    const at = now();
    const expired = await options.database.transaction(async sql => {
      const rows = await sql.query<ExecutionRow>("SELECT * FROM ai_execution_jobs WHERE status='running' AND lease_until<=$1::timestamptz ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2", [at, batchSize]);
      for (const row of rows.rows) await sql.query("UPDATE ai_execution_jobs SET status='unknown',error_code='AI_WORKER_EXPIRED_UNCERTAIN',external_state='unknown',lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=$2::timestamptz WHERE id=$1", [row.id, at]);
      return rows.rows;
    });
    for (const row of expired) { await options.ledger.recoverReservations(row.id, at); await handlers.get(row.kind)?.recover(row.module_job_id); }
    // An inline execution or a previous cleanup may already be terminal while a
    // reservation remains open. Retrying accounting is safe; never replay the model.
    const orphaned = await options.database.query<{ execution_id: string }>("SELECT DISTINCT a.execution_id FROM ai_usage_attempts a JOIN ai_execution_jobs e ON e.id=a.execution_id WHERE a.status='reserved' AND e.status<>'running' ORDER BY a.execution_id LIMIT $1", [batchSize]);
    for (const row of orphaned.rows) await options.ledger.recoverReservations(row.execution_id, at);
    // Also recover domain jobs left running before central discovery or after an old deployment.
    for (const handler of handlers.values()) {
      const list = handler.listRunning ?? handler.listRecoverable;
      for (const job of await list?.call(handler, batchSize) ?? []) await handler.recover(job.id);
    }
    return expired.length;
  }
  async function claim(): Promise<ExecutionRow | null> {
    return options.database.transaction(async sql => {
      const result = await sql.query<ExecutionRow>("SELECT * FROM ai_execution_jobs WHERE status='queued' AND kind=ANY($1::text[]) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1", [[...handlers.keys()]]);
      const row = result.rows[0];
      if (!row) return null;
      const at = now(), token = randomUUID();
      await sql.query("UPDATE ai_execution_jobs SET status='running',attempts=attempts+1,lease_owner=$2,lease_token=$3,lease_until=$4::timestamptz,updated_at=$5::timestamptz WHERE id=$1", [row.id, workerId, token, new Date(Date.parse(at) + leaseMs).toISOString(), at]);
      return { ...row, status: "running", attempts: row.attempts + 1, lease_owner: workerId, lease_token: token };
    });
  }
  async function runOnce(): Promise<{ processed: boolean; executionId?: string; status?: string; errorCode?: string | null }> {
    await recoverExpired(); await discover();
    const job = await claim();
    if (!job) return { processed: false };
    let status = "failed", errorCode: string | null = null;
    try {
      try { await options.assertActor?.(job.actor_id); }
      catch { throw new AiProviderError("AI_ACTOR_UNAVAILABLE", "not_sent"); }
      const result = await withAiExecutionContext({ executionId: job.id, leaseToken: job.lease_token!, projectId: job.project_id, actorId: job.actor_id }, () => handlers.get(job.kind)!.execute(job.module_job_id));
      try { await options.assertActor?.(job.actor_id); }
      catch { throw new AiProviderError("AI_ACTOR_REVOKED", "unknown"); }
      status = ["succeeded", "failed", "cancelled"].includes(result.status) ? result.status : "unknown";
      errorCode = result.errorCode || result.failureCode ? safeCode(result.errorCode ?? result.failureCode) : status === "unknown" ? "AI_MODULE_RESULT_UNCERTAIN" : null;
    } catch (error) {
      errorCode = error instanceof DomainError ? safeCode(error.code) : "AI_EXECUTION_FAILED";
      if (error instanceof AiProviderError && error.externalState === "unknown") status = "unknown";
    }
    const attempts = await options.database.query<{ external_state: AiExternalState; status: string }>("SELECT external_state,status FROM ai_usage_attempts WHERE execution_id=$1 ORDER BY created_at DESC,id DESC", [job.id]);
    const last = attempts.rows[0];
    if (attempts.rows.some(item => item.external_state === "unknown" || item.status === "reserved")) { status = "unknown"; errorCode = "AI_PROVIDER_UNCERTAIN"; }
    const externalState = status === "unknown" ? "unknown" : last?.external_state ?? "not_sent";
    const completed = await options.database.transaction(async sql => {
      // Read the clock after acquiring the row lock: a lock wait cannot make a
      // precomputed completion timestamp falsely validate an expired lease.
      await sql.query("SELECT id FROM ai_execution_jobs WHERE id=$1 FOR UPDATE", [job.id]);
      return sql.query("UPDATE ai_execution_jobs SET status=$2,error_code=$3,external_state=$4,lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=$5::timestamptz WHERE id=$1 AND status='running' AND lease_token=$6 AND lease_until>$5::timestamptz", [job.id, status, errorCode, externalState, now(), job.lease_token]);
    });
    if (completed.rowCount !== 1) return { processed: true, executionId: job.id, status: "unknown", errorCode: "AI_LEASE_LOST" };
    if (attempts.rows.some(item => item.status === "reserved")) await options.ledger.recoverReservations(job.id, now());
    return { processed: true, executionId: job.id, status, errorCode };
  }
  return { runOnce, recoverExpired, discover, workerId };
}
