import { createHash } from "node:crypto";
import type { Actor, Clock, IdGenerator } from "../../shared/contracts.ts";
import { DomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { contextFingerprint, inputSnapshot } from "./assignment-rules.ts";
import { MODEL_TRANSPORT_FAILURE_CODES } from "./model-failures.ts";
import type { AssignmentContextPort } from "./ports.ts";
import type { AssignmentContextSnapshot } from "./types.ts";
import { keys, object, string } from "./validation.ts";
import type { RoleHelpAnswers, RoleHelpModelPort, RoleHelpResult } from "./role-help-model.ts";
import { validateRoleHelpAnswers, validateRoleHelpModelResult } from "./role-help-model.ts";

export interface RoleHelpJob {
  readonly id: string;
  readonly projectId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly idempotencyKey: string;
  readonly inputFingerprint: string;
  readonly inputSnapshot: AssignmentContextSnapshot;
  readonly answers: RoleHelpAnswers;
  readonly status: "queued" | "running" | "succeeded" | "failed";
  readonly revision: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly failureCode: string | null;
  readonly result: RoleHelpResult | null;
}
export interface RoleHelpOptions {
  readonly database: DatabasePort;
  readonly assignmentContext: AssignmentContextPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly model?: RoleHelpModelPort;
  readonly modelTimeoutMs?: number;
  /** Required root check: active account/request session for HTTP; active account for worker.
   * Run on the same executor as project locks. Never accept identity from body JSON. */
  readonly assertActor: (actor: Actor, transaction: SqlExecutor) => Promise<void>;
}
interface Row { readonly data: unknown }
const UNCERTAIN_FAILURE_CODES = ["AI_NETWORK_UNCERTAIN", "AI_PROVIDER_UNCERTAIN", "AI_TIMEOUT_UNCERTAIN", "AI_CANCELLED_UNCERTAIN", "AI_WORKER_EXPIRED_UNCERTAIN", "AI_ACTOR_REVOKED", "AI_LEASE_LOST"];
function decode(row: Row): RoleHelpJob {
  try {
    const data: unknown = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid job");
    return data as RoleHelpJob;
  } catch { throw new DomainError("PERSISTENCE_INVALID_DATA", "意愿帮助任务暂时无法读取。", { status: 500 }); }
}
function metadata(job: RoleHelpJob) {
  return { id: job.id, projectId: job.projectId, actorId: job.userId, revision: job.revision, status: job.status, createdAt: job.createdAt, failureCode: job.failureCode };
}
/** Private, durable generation. No private answers/results enter team summaries or outbox. */
export class RoleHelpService {
  private readonly options: RoleHelpOptions;
  private readonly timeoutMs: number;
  constructor(options: RoleHelpOptions) {
    this.options = options; this.timeoutMs = options.modelTimeoutMs ?? 20000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120000) throw new DomainError("INVALID_MODEL_CONFIG", "意愿帮助超时配置无效。");
  }
  private now() { return this.options.clock.now().toISOString(); }
  private async read(sql: SqlExecutor, id: string, lock = false): Promise<RoleHelpJob | null> {
    const result = await sql.query<Row>(`SELECT data FROM assessments_role_help_jobs WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [id]);
    return result.rows[0] ? decode(result.rows[0]) : null;
  }
  private async save(sql: SqlExecutor, job: RoleHelpJob, expected: number) {
    const result = await sql.query("UPDATE assessments_role_help_jobs SET status=$2,revision=$3,started_at=$4,finished_at=$5,failure_code=$6,data=$7::jsonb WHERE id=$1 AND revision=$8 RETURNING id",
      [job.id, job.status, job.revision, job.startedAt, job.finishedAt, job.failureCode, JSON.stringify(job), expected]);
    if (!result.rowCount) throw new DomainError("VERSION_CONFLICT", "意愿帮助任务已有更新，请刷新。", { status: 409 });
  }
  private async context(sql: SqlExecutor, actor: Actor, projectId: string, membershipId?: string, write = false) {
    if (!actor.userId) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
    await this.options.assertActor(actor, sql);
    const context = await this.options.assignmentContext.getSnapshot(projectId, sql);
    if (context.projectId !== projectId) throw new DomainError("INVALID_INPUT", "项目上下文不匹配。");
    const member = context.members.find((entry) => entry.userId === actor.userId && entry.status === "active" && (membershipId === undefined || entry.membershipId === membershipId));
    if (!member) throw new DomainError("FORBIDDEN", "需要本项目当前的活跃成员权限。", { status: 403 });
    if (write && (context.readOnly === true || context.stage === "archived")) throw new DomainError("PROJECT_READ_ONLY", "项目已归档，可以查看本人历史建议，不能继续生成。", { status: 409 });
    return { context, member };
  }
  private current(job: RoleHelpJob, context: AssignmentContextSnapshot) {
    return contextFingerprint(job.inputSnapshot) === contextFingerprint(context);
  }
  /** The semantic fingerprint excludes the caller's idempotency key and the UTC day.
   * Never turn an unresolved paid call into another request by choosing a new key. */
  private async assertNoUnresolvedRequest(sql: SqlExecutor, projectId: string, userId: string, fingerprint: string, excludeId?: string) {
    const rows = await sql.query<Row>("SELECT data FROM assessments_role_help_jobs WHERE project_id=$1 AND user_id=$2 AND input_fingerprint=$3 AND ($4::text IS NULL OR id<>$4) ORDER BY created_at,id",
      [projectId,userId,fingerprint,excludeId??null]);
    for (const row of rows.rows) {
      const job=decode(row);
      if (UNCERTAIN_FAILURE_CODES.includes(job.failureCode??"")) throw new DomainError("AI_REQUEST_UNRESOLVED", "相同回答的模型请求结果尚未确定，不会重新发送；请查看原任务。", {status:409});
      if (job.status==="queued" || job.status==="running") throw new DomainError("AI_REQUEST_PENDING", "相同回答已有任务正在排队或生成，请查看原任务。", {status:409});
    }
  }
  private view(job: RoleHelpJob, context: AssignmentContextSnapshot) {
    const current = this.current(job, context);
    const uncertain = UNCERTAIN_FAILURE_CODES.includes(job.failureCode ?? "");
    return { ...metadata(job), idempotencyKey: job.idempotencyKey, startedAt: job.startedAt, finishedAt: job.finishedAt, result: job.result,
      ...(uncertain ? { execution: { status: "unknown" as const, canRetry: false, message: "模型请求结果暂不确定，原请求不会自动重发。" } } : {}),
      inputFreshness: current ? "current" as const : "changed" as const, staleReason: current ? null : "赛道、成员意愿或可用时间已变化，请结合当前信息重新判断。" };
  }
  async queue(actor: Actor, projectId: string, value: unknown, idempotencyKey: string) {
    const answers = validateRoleHelpAnswers(value); const key = string(idempotencyKey, "幂等键", 200);
    return this.options.database.transaction(async (sql) => {
      const { context, member } = await this.context(sql, actor, projectId, undefined, true);
      if (!this.options.model) throw new DomainError("MODEL_UNAVAILABLE", "意愿帮助模型尚未接入，你仍可自己选择职责。", { status: 503 });
      const snapshot = inputSnapshot(context, []);
      const fingerprint = createHash("sha256").update(JSON.stringify({ context: contextFingerprint(snapshot), membershipId: member.membershipId, answers })).digest("hex");
      const existing = await sql.query<Row>("SELECT data FROM assessments_role_help_jobs WHERE project_id=$1 AND user_id=$2 AND idempotency_key=$3 FOR UPDATE", [projectId, actor.userId, key]);
      if (existing.rows[0]) {
        const job = decode(existing.rows[0]);
        if (job.membershipId !== member.membershipId || job.inputFingerprint !== fingerprint) throw new DomainError("IDEMPOTENCY_CONFLICT", "同一幂等键不能用于不同的回答或项目版本。", { status: 409 });
        return this.view(job, context);
      }
      await this.assertNoUnresolvedRequest(sql, projectId, actor.userId, fingerprint);
      const job: RoleHelpJob = { id: this.options.ids.next(), projectId, userId: actor.userId, membershipId: member.membershipId,
        idempotencyKey: key, inputFingerprint: fingerprint, inputSnapshot: snapshot, answers, status: "queued", revision: 1,
        createdAt: this.now(), startedAt: null, finishedAt: null, failureCode: null, result: null };
      const inserted = await sql.query("INSERT INTO assessments_role_help_jobs(id,project_id,user_id,membership_id,idempotency_key,input_fingerprint,status,revision,created_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT DO NOTHING RETURNING id",
        [job.id, projectId, actor.userId, member.membershipId, key, fingerprint, job.status, job.revision, job.createdAt, JSON.stringify(job)]);
      if (!inserted.rowCount) throw new DomainError("VERSION_CONFLICT", "已有并发意愿帮助任务，请保留回答并刷新。", { status: 409 });
      return this.view(job, context);
    });
  }
  async getJob(actor: Actor, jobId: string) {
    const ref = await this.read(this.options.database, jobId);
    if (!ref || ref.userId !== actor.userId) throw new DomainError("NOT_FOUND", "未找到本人的意愿帮助任务。", { status: 404 });
    return this.options.database.transaction(async (sql) => {
      const { context } = await this.context(sql, actor, ref.projectId, ref.membershipId);
      const job = await this.read(sql, jobId);
      if (!job || job.userId !== actor.userId || job.membershipId !== ref.membershipId) throw new DomainError("NOT_FOUND", "未找到本人的意愿帮助任务。", { status: 404 });
      return this.view(job, context);
    });
  }
  async getLatest(actor: Actor, projectId: string) {
    return this.options.database.transaction(async (sql) => {
      const { context, member } = await this.context(sql, actor, projectId);
      const rows = await sql.query<Row>("SELECT data FROM assessments_role_help_jobs WHERE project_id=$1 AND user_id=$2 AND membership_id=$3 ORDER BY created_at DESC,id DESC LIMIT 1", [projectId, actor.userId, member.membershipId]);
      return { job: rows.rows[0] ? this.view(decode(rows.rows[0]), context) : null };
    });
  }
  async listQueued(limit: number) { return this.list("queued", limit); }
  async listRecoverable(limit: number) { return this.list("running", limit); }
  private async list(status: "queued" | "running", limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new DomainError("INVALID_INPUT", "扫描任务数量无效。");
    const rows = await this.options.database.query<Row>(`SELECT data FROM assessments_role_help_jobs WHERE status=$1${status === "running" ? " AND started_at < $3" : ""} ORDER BY created_at,id LIMIT $2`,
      status === "running" ? [status, limit, new Date(this.options.clock.now().getTime() - this.timeoutMs - 30000).toISOString()] : [status, limit]);
    return rows.rows.map((row) => metadata(decode(row)));
  }
  private async fail(id: string, code: string) {
    return this.options.database.transaction(async (sql) => {
      const job = await this.read(sql, id, true);
      if (!job) throw new DomainError("NOT_FOUND", "意愿帮助任务不存在。", { status: 404 });
      if (job.status !== "running") return metadata(job);
      const failed: RoleHelpJob = { ...job, status: "failed", revision: job.revision + 1, finishedAt: this.now(), failureCode: code, result: null };
      await this.save(sql, failed, job.revision); return metadata(failed);
    });
  }
  /** Trusted generic worker only. One claim, one bounded provider call; never auto-retry. */
  async execute(jobId: string) {
    const claim = await this.options.database.transaction(async (sql) => {
      const job = await this.read(sql, jobId, true);
      if (!job) throw new DomainError("NOT_FOUND", "意愿帮助任务不存在。", { status: 404 });
      if (job.status !== "queued") return { claimed: false, job };
      const running: RoleHelpJob = { ...job, status: "running", revision: job.revision + 1, startedAt: this.now() };
      await this.save(sql, running, job.revision); return { claimed: true, job: running };
    });
    if (!claim.claimed) return metadata(claim.job);
    const actor: Actor = { userId: claim.job.userId, platformRoles: ["user"] };
    try {
      const context = await this.options.database.transaction(async (sql) => {
        const current = await this.context(sql, actor, claim.job.projectId, claim.job.membershipId, true);
        if (!this.current(claim.job, current.context)) throw new DomainError("ASSIGNMENT_INPUT_CHANGED", "排队期间项目输入已变化，请重新判断。", { status: 409 });
        const job = await this.read(sql, jobId, true);
        if (!job || job.status !== "running" || job.revision !== claim.job.revision) throw new DomainError("JOB_STALE", "任务已失效。", { status: 409 });
        await this.assertNoUnresolvedRequest(sql,job.projectId,job.userId,job.inputFingerprint,job.id);
        return current.context;
      });
      if (!this.options.model) throw new DomainError("MODEL_UNAVAILABLE", "意愿帮助模型尚未接入。", { status: 503 });
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
      let result: RoleHelpResult;
      try {
        result = await Promise.race([
          this.options.model.suggest({ context, membershipId: claim.job.membershipId, answers: claim.job.answers }, controller.signal),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new DomainError("AI_TIMEOUT_UNCERTAIN", "模型请求结果暂不确定，本任务不会自动重发。", { status: 504 })); }, this.timeoutMs); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
      result = validateRoleHelpModelResult(result);
      return await this.options.database.transaction(async (sql) => {
        const fresh = await this.context(sql, actor, claim.job.projectId, claim.job.membershipId, true);
        if (!this.current(claim.job, fresh.context)) throw new DomainError("ASSIGNMENT_INPUT_CHANGED", "生成期间项目输入已变化，请重新判断。", { status: 409 });
        const job = await this.read(sql, jobId, true);
        if (!job || job.status !== "running" || job.revision !== claim.job.revision) throw new DomainError("JOB_STALE", "晚到结果不会保存。", { status: 409 });
        const succeeded: RoleHelpJob = { ...job, status: "succeeded", revision: job.revision + 1, finishedAt: this.now(), result, failureCode: null };
        await this.save(sql, succeeded, job.revision); return metadata(succeeded);
      });
    } catch (error) {
      const safe = ["FORBIDDEN", "UNAUTHENTICATED", "PROJECT_READ_ONLY", "ASSIGNMENT_INPUT_CHANGED", "MODEL_UNAVAILABLE", "INVALID_INPUT", "JOB_STALE", "AI_REQUEST_PENDING", "AI_REQUEST_UNRESOLVED", "AI_ACTOR_REVOKED", ...MODEL_TRANSPORT_FAILURE_CODES];
      return this.fail(jobId, error instanceof DomainError && safe.includes(error.code) ? error.code : "MODEL_FAILED");
    }
  }
  async recover(jobId: string) {
    const job = await this.read(this.options.database, jobId);
    if (!job) throw new DomainError("NOT_FOUND", "意愿帮助任务不存在。", { status: 404 });
    if (job.status !== "running" || !job.startedAt || this.options.clock.now().getTime() - Date.parse(job.startedAt) <= this.timeoutMs + 30000) return metadata(job);
    return this.fail(jobId, "AI_WORKER_EXPIRED_UNCERTAIN");
  }
}
export function createRoleHelpService(options: RoleHelpOptions) { return new RoleHelpService(options); }
export function createRoleHelpRegistration(service: RoleHelpService) {
  return { kind: "m04_role_help", listQueued: (limit: number) => service.listQueued(limit), listRecoverable: (limit: number) => service.listRecoverable(limit), execute: (jobId: string) => service.execute(jobId), recover: (jobId: string) => service.recover(jobId) };
}
export function createRoleHelpHttpHandlers(options: { readonly service: RoleHelpService; readonly resolveActor: (request: Request) => Promise<Actor | null>; readonly requestIds: IdGenerator;
  /** Production must enforce same-origin/CSRF here or in resolveActor before POST. */
  readonly authorizeMutation?: (request: Request, actor: Actor) => Promise<void>;
}) {
  const respond = async (request: Request, method: "GET" | "POST", work: (actor: Actor) => Promise<unknown>, status = 200) => {
    const requestId = options.requestIds.next();
    try {
      if (request.method !== method) throw new DomainError("METHOD_NOT_ALLOWED", "此意愿帮助接口不支持该请求方法。", { status: 405 });
      const actor = await options.resolveActor(request);
      if (!actor) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
      if (method === "POST") await options.authorizeMutation?.(request, actor);
      return Response.json({ data: await work(actor), requestId }, { status, headers: { "Cache-Control": "no-store" } });
    } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: error instanceof DomainError ? error.status : 500, headers: { "Cache-Control": "no-store" } }); }
  };
  return {
    queue: (request: Request, { projectId }: { readonly projectId: string }) => respond(request, "POST", async (actor) => {
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new DomainError("UNSUPPORTED_MEDIA_TYPE", "请使用 JSON 请求。", { status: 415 });
      const reader = request.body?.getReader(); if (!reader) throw new DomainError("INVALID_INPUT", "请求内容不能为空。");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
          if (size > 32768) { void reader.cancel().catch(() => undefined); throw new DomainError("PAYLOAD_TOO_LARGE", "意愿帮助回答过长。", { status: 413 }); }
          chunks.push(part.value); }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new DomainError("INVALID_INPUT", "请求 JSON 格式或编码不正确。"); }
      const data = object(parsed, "请求内容"); keys(data, ["answers"], "请求内容");
      return options.service.queue(actor, projectId, data.answers, string(request.headers.get("Idempotency-Key"), "Idempotency-Key 请求头", 200));
    }, 202),
    job: (request: Request, { jobId }: { readonly jobId: string }) => respond(request, "GET", (actor) => options.service.getJob(actor, jobId)),
    latest: (request: Request, { projectId }: { readonly projectId: string }) => respond(request, "GET", (actor) => options.service.getLatest(actor, projectId)),
  };
}
