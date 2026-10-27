import { createHash } from "node:crypto";
import type { Actor, Clock, IdGenerator, ProjectAccessPort } from "../../shared/contracts.ts";
import { DomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { AssignmentContextPort } from "./ports.ts";
import type { AssessmentService } from "./service.ts";
import type { AssignmentInputSnapshot } from "./types.ts";
import { keys, object, string, strings } from "./validation.ts";
import { MODEL_TRANSPORT_FAILURE_CODES } from "./model-failures.ts";

export interface AssignmentGenerationJob {
  readonly id: string;
  readonly projectId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly idempotencyKey: string;
  readonly inputFingerprint: string;
  readonly inputSnapshot: AssignmentInputSnapshot;
  readonly baseVersionId: string | null;
  readonly targetDeliverables: readonly string[];
  readonly status: "queued" | "running" | "succeeded" | "failed";
  readonly revision: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly assignmentVersionId: string | null;
  readonly failureCode: string | null;
}
export interface AssignmentGenerationOptions {
  readonly database: DatabasePort;
  readonly assessments: AssessmentService;
  readonly projectAccess: ProjectAccessPort;
  readonly assignmentContext: AssignmentContextPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly modelTimeoutMs?: number;
}
interface JobRow { readonly data: unknown }
function decode(row: JobRow): AssignmentGenerationJob {
  try {
    const data: unknown = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid job");
    return data as AssignmentGenerationJob;
  } catch { throw new DomainError("PERSISTENCE_INVALID_DATA", "生成任务暂时无法读取。", { status: 500 }); }
}
function metadata(job: AssignmentGenerationJob) {
  return { id: job.id, projectId: job.projectId, actorId: job.userId, revision: job.revision, status: job.status, createdAt: job.createdAt, failureCode: job.failureCode, assignmentVersionId: job.assignmentVersionId };
}
function view(job: AssignmentGenerationJob) {
  return { ...metadata(job), startedAt: job.startedAt, finishedAt: job.finishedAt };
}
/** Durable, trusted worker service. Queue facts contain only shared-input references,
 * targets and the requesting manager; raw answers never enter this table.
 */
export class AssignmentGenerationService {
  private readonly options: AssignmentGenerationOptions;
  private readonly timeoutMs: number;
  constructor(options: AssignmentGenerationOptions) {
    this.options = options;
    this.timeoutMs = options.modelTimeoutMs ?? 20000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120000) throw new DomainError("INVALID_MODEL_CONFIG", "生成任务超时配置无效。");
  }
  private now(): string { return this.options.clock.now().toISOString(); }
  private async read(sql: SqlExecutor, id: string, lock = false): Promise<AssignmentGenerationJob | null> {
    const result = await sql.query<JobRow>(`SELECT data FROM assessments_assignment_jobs WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
    return result.rows[0] ? decode(result.rows[0]) : null;
  }
  private async save(sql: SqlExecutor, job: AssignmentGenerationJob, expected: number): Promise<void> {
    const result = await sql.query(`UPDATE assessments_assignment_jobs SET status=$2,revision=$3,started_at=$4,finished_at=$5,assignment_version_id=$6,failure_code=$7,data=$8::jsonb WHERE id=$1 AND revision=$9 RETURNING id`,
      [job.id, job.status, job.revision, job.startedAt, job.finishedAt, job.assignmentVersionId, job.failureCode, JSON.stringify(job), expected]);
    if (!result.rowCount) throw new DomainError("VERSION_CONFLICT", "生成任务状态已变化，请刷新。", { status: 409 });
  }
  async queue(actor: Actor, projectId: string, targetDeliverables: readonly string[], idempotencyKey: string) {
    const key = string(idempotencyKey, "幂等键", 200);
    // Keep authoritative project/head/summary locks until the job INSERT commits;
    // never acquire another connection inside this transaction.
    return this.options.assessments.withAssignmentSuggestionInputs(actor, projectId, targetDeliverables, async (inputs, sql) => {
      if (!sql) throw new DomainError("PERSISTENCE_REQUIRED", "生成任务需要持久数据库。", { status: 503 });
      if (!this.options.assessments.isModelAvailable("assignment")) throw new DomainError("MODEL_UNAVAILABLE", "分工建议模型暂未接入，可以继续手动建立草案。", { status: 503 });
      const fingerprint = createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
      const existing = await sql.query<JobRow>("SELECT data FROM assessments_assignment_jobs WHERE project_id=$1 AND user_id=$2 AND idempotency_key=$3 FOR UPDATE", [projectId, actor.userId, key]);
      if (existing.rows[0]) {
        const job = decode(existing.rows[0]);
        if (job.inputFingerprint !== fingerprint) throw new DomainError("IDEMPOTENCY_CONFLICT", "同一幂等键不能用于不同分工输入。", { status: 409 });
        return view(job);
      }
      const job: AssignmentGenerationJob = {
        id: this.options.ids.next(), projectId, userId: actor.userId, membershipId: inputs.membershipId,
        idempotencyKey: key, inputFingerprint: fingerprint, inputSnapshot: inputs.inputSnapshot,
        baseVersionId: inputs.baseVersionId, targetDeliverables: inputs.targetDeliverables,
        status: "queued", revision: 1, createdAt: this.now(), startedAt: null, finishedAt: null,
        assignmentVersionId: null, failureCode: null,
      };
      const inserted = await sql.query("INSERT INTO assessments_assignment_jobs(id,project_id,user_id,membership_id,idempotency_key,input_fingerprint,status,revision,created_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT DO NOTHING RETURNING id",
        [job.id, projectId, actor.userId, job.membershipId, key, fingerprint, job.status, job.revision, job.createdAt, JSON.stringify(job)]);
      if (!inserted.rowCount) throw new DomainError("VERSION_CONFLICT", "生成任务已有并发更新，请刷新后重试。", { status: 409 });
      return view(job);
    });
  }
  async getJob(actor: Actor, jobId: string) {
    const reference = await this.read(this.options.database, jobId);
    if (!reference || reference.userId !== actor.userId) throw new DomainError("NOT_FOUND", "未找到本人的分工生成任务。", { status: 404 });
    const member = await this.options.projectAccess.getMembership(reference.projectId, actor.userId);
    if (!member || member.status !== "active" || member.membershipId !== reference.membershipId) throw new DomainError("FORBIDDEN", "当前项目成员关系已变化。", { status: 403 });
    return this.options.database.transaction(async (sql) => {
      const context = await this.options.assignmentContext.getSnapshot(reference.projectId, sql);
      if (context.projectId !== reference.projectId || !context.members.some((entry) => entry.membershipId === reference.membershipId && entry.userId === actor.userId && entry.status === "active")) throw new DomainError("FORBIDDEN", "当前项目成员关系已变化。", { status: 403 });
      const current = await this.read(sql, jobId);
      if (!current || current.userId !== actor.userId) throw new DomainError("NOT_FOUND", "未找到本人的分工生成任务。", { status: 404 });
      return view(current);
    });
  }
  async listQueued(limit: number) { return this.list("queued", limit); }
  async listRecoverable(limit: number) { return this.list("running", limit); }
  private async list(status: "queued" | "running", limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new DomainError("INVALID_BATCH_SIZE", "任务批量大小应为 1 至 100。");
    const result = await this.options.database.query<JobRow>(`SELECT data FROM assessments_assignment_jobs WHERE status=$1${status === "running" ? " AND started_at < $3" : ""} ORDER BY created_at,id LIMIT $2`, status === "running" ? [status, limit, new Date(this.options.clock.now().getTime() - this.timeoutMs - 30000).toISOString()] : [status, limit]);
    return result.rows.map((row) => metadata(decode(row)));
  }
  private async finish(id: string, status: "succeeded" | "failed", resultId: string | null, failureCode: string | null) {
    return this.options.database.transaction(async (sql) => {
      const job = await this.read(sql, id, true);
      if (!job) throw new DomainError("NOT_FOUND", "生成任务不存在。", { status: 404 });
      if (job.status !== "running") return metadata(job);
      const next: AssignmentGenerationJob = { ...job, status, revision: job.revision + 1, finishedAt: this.now(), assignmentVersionId: resultId, failureCode };
      await this.save(sql, next, job.revision); return metadata(next);
    });
  }
  /** Claim is atomic. The existing service checks queued inputs before model dispatch
   * and current inputs again before saving a reviewable draft, never auto-applies it.
   */
  async execute(jobId: string) {
    const claim = await this.options.database.transaction(async (sql) => {
      const job = await this.read(sql, jobId, true);
      if (!job) throw new DomainError("NOT_FOUND", "生成任务不存在。", { status: 404 });
      if (job.status !== "queued") return { claimed: false, job };
      const running: AssignmentGenerationJob = { ...job, status: "running", revision: job.revision + 1, startedAt: this.now() };
      await this.save(sql, running, job.revision); return { claimed: true, job: running };
    });
    if (!claim.claimed) return metadata(claim.job);
    try {
      const currentMember = await this.options.projectAccess.getMembership(claim.job.projectId, claim.job.userId);
      if (!currentMember || currentMember.status !== "active" || currentMember.role !== "manager" || currentMember.membershipId !== claim.job.membershipId) throw new DomainError("FORBIDDEN", "生成任务的管理员权限已失效。", { status: 403 });
      let finished: AssignmentGenerationJob | undefined;
      await this.options.assessments.suggestAssignment({ userId: claim.job.userId, platformRoles: ["user"] }, claim.job.projectId, claim.job.targetDeliverables, {
        baseVersionId: claim.job.baseVersionId, inputSnapshot: claim.job.inputSnapshot,
        onDraftSaved: async (assignment, sql) => {
          if (!sql) throw new DomainError("PERSISTENCE_REQUIRED", "生成任务需要持久数据库。", { status: 503 });
          const job = await this.read(sql, jobId, true);
          if (!job || job.status !== "running" || job.revision !== claim.job.revision) throw new DomainError("JOB_STALE", "生成任务已失效，晚到草案不会保存。", { status: 409 });
          finished = { ...job, status: "succeeded", revision: job.revision + 1, finishedAt: this.now(), assignmentVersionId: assignment.id, failureCode: null };
          await this.save(sql, finished, job.revision);
        },
      });
      if (!finished) throw new DomainError("JOB_STALE", "生成任务结果未能保存。", { status: 409 });
      return metadata(finished);
    } catch (error) {
      const safeCodes = ["FORBIDDEN", "PROJECT_READ_ONLY", "ASSIGNMENT_INPUT_CHANGED", "ASSIGNMENT_BASE_CHANGED", "MODEL_TIMEOUT", "MODEL_UNAVAILABLE", "INVALID_INPUT", "UNVERIFIED_EVIDENCE", "JOB_STALE", "PERSISTENCE_REQUIRED", ...MODEL_TRANSPORT_FAILURE_CODES];
      return this.finish(jobId, "failed", null, error instanceof DomainError && safeCodes.includes(error.code) ? error.code : "MODEL_FAILED");
    }
  }
  /** Crash/unknown outcomes close the lease. A new user action creates a new job. */
  async recover(jobId: string) {
    const job = await this.read(this.options.database, jobId);
    if (!job) throw new DomainError("NOT_FOUND", "生成任务不存在。", { status: 404 });
    if (job.status !== "running" || !job.startedAt || this.options.clock.now().getTime() - Date.parse(job.startedAt) <= this.timeoutMs + 30000) return metadata(job);
    return this.finish(jobId, "failed", null, "WORKER_INTERRUPTED");
  }
}
export function createAssignmentGenerationService(options: AssignmentGenerationOptions) { return new AssignmentGenerationService(options); }
export function createAssignmentGenerationRegistration(service: AssignmentGenerationService) {
  return { kind: "assignment_suggestion", listQueued: (limit: number) => service.listQueued(limit), execute: (jobId: string) => service.execute(jobId), recover: (jobId: string) => service.recover(jobId), listRecoverable: (limit: number) => service.listRecoverable(limit) };
}
export function createAssignmentGenerationHttpHandlers(options: { readonly service: AssignmentGenerationService; readonly resolveActor: (request: Request) => Promise<Actor | null>; readonly requestIds: IdGenerator }) {
  const respond = async (request: Request, method: "GET" | "POST", work: (actor: Actor) => Promise<unknown>, status = 200) => {
    const requestId = options.requestIds.next();
    try {
      if (request.method !== method) throw new DomainError("METHOD_NOT_ALLOWED", "此生成接口不支持该请求方法。", { status: 405 });
      const actor = await options.resolveActor(request);
      if (!actor) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
      return Response.json({ data: await work(actor), requestId }, { status, headers: { "Cache-Control": "no-store" } });
    } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: error instanceof DomainError ? error.status : 500, headers: { "Cache-Control": "no-store" } }); }
  };
  return {
    queue: (request: Request, { projectId }: { readonly projectId: string }) => respond(request, "POST", async (actor) => {
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new DomainError("UNSUPPORTED_MEDIA_TYPE", "请使用 JSON 请求。", { status: 415 });
      const reader = request.body?.getReader();
      if (!reader) throw new DomainError("INVALID_INPUT", "请求内容不能为空。");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > 65536) { await reader.cancel(); throw new DomainError("PAYLOAD_TOO_LARGE", "目标交付物内容过大。", { status: 413 }); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let raw: string; try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new DomainError("INVALID_INPUT", "请求 JSON 编码不正确。"); }
      let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new DomainError("INVALID_INPUT", "请求 JSON 格式不正确。"); }
      const data = object(parsed, "请求内容"); keys(data, ["targetDeliverables"], "请求内容");
      return options.service.queue(actor, projectId, strings(data.targetDeliverables, "目标交付物", 30, 2000), string(request.headers.get("Idempotency-Key"), "Idempotency-Key 请求头", 200));
    }, 202),
    job: (request: Request, { jobId }: { readonly jobId: string }) => respond(request, "GET", (actor) => options.service.getJob(actor, jobId)),
  };
}
