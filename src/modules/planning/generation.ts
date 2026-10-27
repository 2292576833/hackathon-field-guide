import { createHash } from "node:crypto";
import type { Actor, Clock, IdGenerator, ProjectAccessPort } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { parseDraftCommand } from "./parse.ts";
import { validateGeneratedPlanningOutput } from "./generation-model.ts";
import type { PlanningGenerationCommand, PlanningGenerationJob, PlanningGenerationModelPort, PlanningGenerationRepository, PlanningGenerationTransaction } from "./generation-types.ts";
import type { PlanningService } from "./service.ts";

export interface PlanningGenerationDependencies {
  planning: PlanningService;
  repository: PlanningGenerationRepository;
  access: ProjectAccessPort;
  model?: PlanningGenerationModelPort;
  clock: Clock;
  ids: IdGenerator;
  timeoutMs?: number;
  maxAttempts?: number;
}
function missing(): never { throw new DomainError("NOT_FOUND", "未找到可访问的计划生成任务。", { status: 404 }); }
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new DomainError("INVALID_INPUT", "需要有效修订号。", { status: 400 });
  return value as number;
}
function limit(value: number): number { if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new DomainError("INVALID_INPUT", "列表数量需要为1至100。", { status: 400 }); return value; }
export function parsePlanningGenerationCommand(raw: unknown): PlanningGenerationCommand {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DomainError("INVALID_INPUT", "生成请求需要JSON对象。", { status: 400 });
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !["goal", "instructions", "resourceIds", "buffers", "expectedTasksRevision", "basePlanVersionId", "idempotencyKey"].includes(key))) throw new DomainError("INVALID_INPUT", "生成请求包含不支持的字段。", { status: 400 });
  if (value.instructions !== undefined && (typeof value.instructions !== "string" || value.instructions.length > 4000)) throw new DomainError("INVALID_INPUT", "补充说明最多4000字。", { status: 400 });
  if (!Array.isArray(value.resourceIds) || value.resourceIds.length > 200 || value.resourceIds.some(id => typeof id !== "string" || !id.trim() || id.length > 200) || new Set(value.resourceIds).size !== value.resourceIds.length) throw new DomainError("INVALID_INPUT", "资源候选需要最多200个唯一准确ID。", { status: 400 });
  const parsed = parseDraftCommand({ tasks: [], buffers: value.buffers, reason: value.goal, expectedTasksRevision: value.expectedTasksRevision, basePlanVersionId: value.basePlanVersionId, idempotencyKey: value.idempotencyKey });
  if (parsed.idempotencyKey.length > 200) throw new DomainError("INVALID_INPUT", "操作标识最多200字。", { status: 400 });
  return { goal: parsed.reason, instructions: (value.instructions as string | undefined) ?? "", resourceIds: [...value.resourceIds as string[]].sort(), buffers: parsed.buffers, expectedTasksRevision: parsed.expectedTasksRevision, basePlanVersionId: parsed.basePlanVersionId, idempotencyKey: parsed.idempotencyKey };
}

/** External call happens after a durable claim and outside every database transaction. */
export class PlanningGenerationService {
  private dependencies: PlanningGenerationDependencies;
  private timeoutMs: number;
  private maxAttempts: number;
  constructor(dependencies: PlanningGenerationDependencies) {
    this.dependencies = dependencies;
    this.timeoutMs = dependencies.timeoutMs ?? 30_000;
    this.maxAttempts = dependencies.maxAttempts ?? 2;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000 || !Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 3) throw new DomainError("INVALID_GENERATION_CONFIG", "模型超时或显式重试上限配置无效。", { status: 500 });
  }
  private now(): string { return this.dependencies.clock.now().toISOString(); }
  private async authorize(actor: Actor, projectId: string, manager = false) {
    const membership = await this.dependencies.access.getMembership(projectId, actor.userId);
    if (!membership || membership.status !== "active") missing();
    if (manager && membership.role !== "manager") throw new DomainError("FORBIDDEN", "只有活跃项目管理员可生成时间计划。", { status: 403 });
    return membership;
  }
  private actor(job: PlanningGenerationJob): Actor { return { userId: job.actorId, platformRoles: ["user"] }; }
  private async originalManager(job: PlanningGenerationJob): Promise<void> {
    const membership = await this.dependencies.access.getMembership(job.projectId, job.actorId);
    if (!membership || membership.status !== "active" || membership.role !== "manager" || membership.membershipId !== job.membershipId) throw new DomainError("PROJECT_ACCESS_REVOKED", "原请求人的项目管理权限已变化，本次生成已停止。", { status: 403 });
  }
  private finished(job: PlanningGenerationJob, errorCode: string): PlanningGenerationJob {
    const now = this.now();
    return { ...job, status: "failed", errorCode, revision: job.revision + 1, finishedAt: now, leaseExpiresAt: null, durationMs: job.startedAt ? Math.max(0, Date.parse(now) - Date.parse(job.startedAt)) : 0 };
  }
  private failure(error: unknown): string {
    const allowed = ["MODEL_TIMEOUT", "WORKER_INTERRUPTED", "MODEL_UNAVAILABLE", "MODEL_VERSION_CHANGED", "INVALID_MODEL_METADATA", "INVALID_GENERATED_PLAN", "VERSION_CONFLICT", "RESOURCE_REFS_UNAVAILABLE", "UNAPPROVED_RESOURCE", "RESOURCE_CONTENT_VERSION_UNAVAILABLE", "PROJECT_READ_ONLY", "PROJECT_ACCESS_REVOKED", "GENERATION_INPUT_INCOMPLETE", "INVALID_GENERATION_BUFFER", "GENERATION_RETRY_LIMIT"];
    if (error instanceof DomainError && ["NOT_FOUND", "FORBIDDEN"].includes(error.code)) return "PROJECT_ACCESS_REVOKED";
    return error instanceof DomainError && allowed.includes(error.code) ? error.code : "MODEL_FAILED";
  }
  async queueGeneration(actor: Actor, projectId: string, raw: PlanningGenerationCommand): Promise<PlanningGenerationJob> {
    const command = parsePlanningGenerationCommand(raw);
    await this.authorize(actor, projectId, true);
    const model = this.dependencies.model;
    if (!model) throw new DomainError("MODEL_UNAVAILABLE", "模型尚未接入，可以继续手动调整计划。", { status: 503, recoveryAction: "use_manual_planning" });
    const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    return this.dependencies.repository.transaction(projectId, async tx => {
      const membership = await this.authorize(actor, projectId, true);
      const previous = await tx.findRequest(actor.userId, command.idempotencyKey);
      if (previous) {
        if (previous.commandFingerprint !== fingerprint) throw new DomainError("IDEMPOTENCY_CONFLICT", "相同操作标识已用于不同生成输入。", { status: 409 });
        return previous;
      }
      const snapshot = await this.dependencies.planning.captureGenerationContext(actor, projectId, command, tx.sql);
      const finalMembership = await this.authorize(actor, projectId, true);
      if (finalMembership.membershipId !== membership.membershipId) throw new DomainError("PROJECT_ACCESS_REVOKED", "本次项目成员关系已变化。", { status: 409 });
      const job: PlanningGenerationJob = { id: this.dependencies.ids.next(), projectId, actorId: actor.userId, membershipId: membership.membershipId, idempotencyKey: command.idempotencyKey, commandFingerprint: fingerprint, snapshot, status: "queued", revision: 1, attempts: 0, createdAt: this.now(), startedAt: null, finishedAt: null, leaseExpiresAt: null, durationMs: null, errorCode: null, resultPlanId: null, modelVersion: model.modelVersion, promptVersion: model.promptVersion, usage: null, providerRequestId: null };
      await tx.save(job, null);
      return job;
    });
  }
  async getGenerationJob(actor: Actor, projectId: string, jobId: string): Promise<PlanningGenerationJob> {
    await this.authorize(actor, projectId);
    const job = await this.dependencies.repository.read(jobId);
    if (!job || job.projectId !== projectId) missing();
    return job;
  }
  async listGenerationJobs(actor: Actor, projectId: string, count = 30): Promise<PlanningGenerationJob[]> {
    await this.authorize(actor, projectId);
    return this.dependencies.repository.listForProject(projectId, limit(count));
  }
  /** Trusted root worker inventory. Never expose these methods without worker authentication. */
  async listQueuedAIJobs(count = 20) { return this.dependencies.repository.listQueued(limit(count)); }
  async listRunningAIJobs(count = 20) { return this.dependencies.repository.listRunning(limit(count)); }
  private async failJob(reference: PlanningGenerationJob, error: unknown): Promise<PlanningGenerationJob> {
    return this.dependencies.repository.transaction(reference.projectId, async tx => {
      const job = await tx.get(reference.id);
      if (!job) missing();
      if (job.status !== "running" || job.revision !== reference.revision) return job;
      const failed = this.finished(job, this.failure(error));
      await tx.save(failed, job.revision);
      return failed;
    });
  }
  private async bounded<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(() => work(controller.signal)), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new DomainError("MODEL_TIMEOUT", "模型未在限定时间内返回。", { status: 503 })); }, this.timeoutMs); })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  private assertLease(job: PlanningGenerationJob): void {
    if (!job.leaseExpiresAt || Date.parse(this.now()) >= Date.parse(job.leaseExpiresAt)) throw new DomainError("WORKER_INTERRUPTED", "生成租约已到期，本次迟到结果不能保存。", { status: 409 });
  }
  async processGenerationJob(jobId: string): Promise<PlanningGenerationJob> {
    const reference = await this.dependencies.repository.read(jobId);
    if (!reference) missing();
    const claimed = await this.dependencies.repository.transaction(reference.projectId, async tx => {
      const job = await tx.get(jobId);
      if (!job) missing();
      if (job.status !== "queued") return { claimed: false as const, job };
      try {
        await this.originalManager(job);
        await this.dependencies.planning.assertGenerationContext(this.actor(job), job.projectId, job.snapshot, tx.sql);
        await this.originalManager(job);
        if (!this.dependencies.model) throw new DomainError("MODEL_UNAVAILABLE", "模型尚未接入。", { status: 503 });
        if (this.dependencies.model.modelVersion !== job.modelVersion || this.dependencies.model.promptVersion !== job.promptVersion) throw new DomainError("MODEL_VERSION_CHANGED", "生成配置已变化，请重新排队。", { status: 409 });
        if (job.attempts >= this.maxAttempts) throw new DomainError("GENERATION_RETRY_LIMIT", "生成任务已达调用上限。", { status: 429 });
      } catch (error) {
        const failed = this.finished(job, this.failure(error)); await tx.save(failed, job.revision);
        return { claimed: false as const, job: failed };
      }
      const now = this.now();
      const running: PlanningGenerationJob = { ...job, status: "running", revision: job.revision + 1, attempts: job.attempts + 1, startedAt: now, finishedAt: null, leaseExpiresAt: new Date(Date.parse(now) + this.timeoutMs + 30_000).toISOString(), errorCode: null, durationMs: null };
      await tx.save(running, job.revision);
      return { claimed: true as const, job: running };
    });
    if (!claimed.claimed) return claimed.job;
    try {
      const output = await this.bounded(signal => this.dependencies.model!.generate(structuredClone(claimed.job.snapshot), signal));
      const proposal = validateGeneratedPlanningOutput({ tasks: output.tasks, reason: output.reason, assumptions: output.assumptions }, claimed.job.snapshot);
      if (output.modelVersion !== claimed.job.modelVersion) throw new DomainError("MODEL_VERSION_CHANGED", "实际模型版本变化。", { status: 409 });
      if (output.usage && (!Number.isSafeInteger(output.usage.inputTokens) || output.usage.inputTokens < 0 || !Number.isSafeInteger(output.usage.outputTokens) || output.usage.outputTokens < 0)) throw new DomainError("INVALID_MODEL_METADATA", "模型用量记录无效。", { status: 502 });
      return await this.dependencies.repository.transaction(claimed.job.projectId, async tx => {
        const job = await tx.get(jobId);
        if (!job) missing();
        if (job.status !== "running" || job.revision !== claimed.job.revision) return job;
        if (!job.leaseExpiresAt || Date.parse(this.now()) >= Date.parse(job.leaseExpiresAt)) { const failed = this.finished(job, "WORKER_INTERRUPTED"); await tx.save(failed, job.revision); return failed; }
        await this.originalManager(job);
        await this.dependencies.planning.assertGenerationContext(this.actor(job), job.projectId, job.snapshot, tx.sql);
        await this.originalManager(job);
        this.assertLease(job);
        const plan = await this.dependencies.planning.createGeneratedDraft(this.actor(job), job.projectId, { tasks: proposal.tasks, buffers: job.snapshot.buffers, reason: proposal.reason, expectedTasksRevision: job.snapshot.tasksRevision, basePlanVersionId: job.snapshot.basePlanVersionId, idempotencyKey: `generation:${job.id}` }, job.snapshot, { jobId: job.id, modelVersion: job.modelVersion, promptVersion: job.promptVersion, assumptions: proposal.assumptions, usage: output.usage, providerRequestId: output.requestId });
        // A lock wait inside the nested planning write can also outlive the lease.
        // Throwing rolls back its draft/outbox/idempotency together with this job transaction.
        this.assertLease(job);
        const now = this.now();
        const succeeded: PlanningGenerationJob = { ...job, status: "succeeded", revision: job.revision + 1, resultPlanId: plan.id, finishedAt: now, leaseExpiresAt: null, durationMs: Math.max(0, Date.parse(now) - Date.parse(job.startedAt!)), usage: output.usage, providerRequestId: output.requestId };
        await tx.save(succeeded, job.revision);
        return succeeded;
      });
    } catch (error) { return this.failJob(claimed.job, error); }
  }
  async recoverExpiredGenerationJob(jobId: string): Promise<PlanningGenerationJob> {
    const reference = await this.dependencies.repository.read(jobId);
    if (!reference) missing();
    return this.dependencies.repository.transaction(reference.projectId, async tx => {
      const job = await tx.get(jobId); if (!job) missing();
      if (job.status !== "running" || !job.leaseExpiresAt || Date.parse(this.now()) < Date.parse(job.leaseExpiresAt)) return job;
      const failed = this.finished(job, "WORKER_INTERRUPTED"); await tx.save(failed, job.revision); return failed;
    });
  }
  async retryGeneration(actor: Actor, projectId: string, jobId: string, expectedRevision: number): Promise<PlanningGenerationJob> {
    integer(expectedRevision); await this.authorize(actor, projectId, true);
    return this.dependencies.repository.transaction(projectId, async tx => {
      const job = await tx.get(jobId); if (!job || job.actorId !== actor.userId) missing();
      if (job.revision !== expectedRevision) throw new DomainError("VERSION_CONFLICT", "生成任务已经变化。", { status: 409, latestRevision: job.revision });
      if (job.status !== "failed" || !["MODEL_FAILED", "MODEL_TIMEOUT", "WORKER_INTERRUPTED"].includes(job.errorCode ?? "")) throw new DomainError("RETRY_NOT_ALLOWED", "请按最新输入重新排队或继续手动规划。", { status: 409 });
      if (job.attempts >= this.maxAttempts) throw new DomainError("GENERATION_RETRY_LIMIT", "本次生成已达调用上限，请保留成果并手动调整。", { status: 429 });
      await this.originalManager(job); await this.dependencies.planning.assertGenerationContext(actor, projectId, job.snapshot, tx.sql); await this.originalManager(job);
      const next: PlanningGenerationJob = { ...job, status: "queued", revision: job.revision + 1, startedAt: null, finishedAt: null, leaseExpiresAt: null, errorCode: null, durationMs: null, usage: null, providerRequestId: null };
      await tx.save(next, job.revision); return next;
    });
  }
  async cancelGeneration(actor: Actor, projectId: string, jobId: string, expectedRevision: number): Promise<PlanningGenerationJob> {
    integer(expectedRevision); await this.authorize(actor, projectId, true);
    return this.dependencies.repository.transaction(projectId, async tx => {
      const job = await tx.get(jobId); if (!job || job.actorId !== actor.userId) missing();
      await this.originalManager(job);
      if (job.revision !== expectedRevision) throw new DomainError("VERSION_CONFLICT", "生成任务已经变化。", { status: 409, latestRevision: job.revision });
      if (!["queued", "running"].includes(job.status)) throw new DomainError("CANCELLATION_NOT_ALLOWED", "生成任务已经结束。", { status: 409 });
      const now = this.now();
      const cancelled: PlanningGenerationJob = { ...job, status: "cancelled", revision: job.revision + 1, finishedAt: now, leaseExpiresAt: null, errorCode: null, durationMs: job.startedAt ? Math.max(0, Date.parse(now) - Date.parse(job.startedAt)) : 0 };
      await tx.save(cancelled, job.revision); return cancelled;
    });
  }
}
export function createPlanningGenerationService(dependencies: PlanningGenerationDependencies): PlanningGenerationService { return new PlanningGenerationService(dependencies); }
