import { createHash, randomBytes } from "node:crypto";
import type { Actor, Clock, IdGenerator } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { assertAllowedSourceUrl } from "./network-policy.ts";
import { assertExpectedRevision, requireOperationsAdmin, requireOperationsReader, requireText } from "./source-domain.ts";
import type { SourceConfig } from "./source-domain.ts";
import { approvedSourceSnapshot, assertRunLease, assertWorkerScope, redactRun, retryRun, workerRunState } from "./run-domain.ts";
import type { AnalysisOutput, AnalysisRun, ApprovedWorkerTask, CandidateValidationPort, CrawlOutput, CrawlRun, ExecutionKind, ExecutionRun, ExecutionStep, FailureCategory, VerifiedWorkerIdentity, WorkerIdentityPort, WorkerRunState } from "./run-domain.ts";
import type { OperationsExecutionRepository, OperationsExecutionTransaction } from "./run-repository.ts";

export interface RunServiceDependencies { repository: OperationsExecutionRepository; clock: Clock; ids: IdGenerator }
const fingerprint = (value: readonly unknown[]): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const notFound = (): never => { throw new DomainError("RUN_NOT_FOUND", "未找到执行任务。", { status: 404 }); };
const ensureEnabled = (source: SourceConfig | null): SourceConfig => {
  if (!source || source.status !== "enabled" || !source.verification || source.credentialPolicy !== "none") throw new DomainError("SOURCE_NOT_ENABLED", "来源尚未验证启用，不能自动获取。", { status: 409 });
  return source;
};
const isCurrentSource = (source: SourceConfig | null, run: ExecutionRun): boolean => !!source && source.status === "enabled" && !!source.verification && source.credentialPolicy === "none" && (run.kind !== "crawl" || source.revision === run.sourceSnapshot.revision);
function runLimits(kind: ExecutionKind, requestedAttempts?: number, requestedTimeout?: number) {
  const maxAttempts = requestedAttempts ?? 3;
  const timeoutMs = requestedTimeout ?? (kind === "crawl" ? 120_000 : 300_000);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3 || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) throw new DomainError("INVALID_RUN_LIMITS", "任务尝试次数需在 1–3 次内，超时最多 10 分钟。");
  return { maxAttempts, timeoutMs };
}
function baseRun(deps: RunServiceDependencies, input: { kind: ExecutionKind; actor: Actor; sourceConfigId: string; key: string; hash: string; requestId?: string; retryOf?: string; trigger?: "manual" | "scheduled"; maxAttempts?: number; timeoutMs?: number }) {
  const { maxAttempts, timeoutMs } = runLimits(input.kind, input.maxAttempts, input.timeoutMs);
  const now = deps.clock.now().toISOString();
  const id = deps.ids.next();
  return { id, kind: input.kind, sourceConfigId: input.sourceConfigId, revision: 1, status: "queued" as const, step: "queued" as const, requestedBy: input.actor.userId, requestId: input.requestId === undefined ? id : requireText(input.requestId, "请求标识", 120), idempotencyKey: input.key, fingerprint: input.hash, retryOf: input.retryOf ?? null, trigger: input.trigger ?? "manual", attempt: 0, maxAttempts, timeoutMs, availableAt: now, lastAttemptAt: null, lease: null, failures: [], history: [], createdAt: now, updatedAt: now, finishedAt: null };
}

export class RunService {
  private readonly deps: RunServiceDependencies;
  constructor(deps: RunServiceDependencies) { this.deps = deps; }
  async list(actor: Actor, limit = 50): Promise<readonly ExecutionRun[]> {
    requireOperationsReader(actor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError("INVALID_PAGE_LIMIT", "一次最多读取 100 个任务。");
    return (await this.deps.repository.listRuns(limit)).map(redactRun);
  }
  async get(actor: Actor, id: string): Promise<ExecutionRun> {
    requireOperationsReader(actor);
    const run = await this.deps.repository.getRun(id);
    if (!run) return notFound();
    return redactRun(run);
  }
  async enqueueCrawl(actor: Actor, input: { sourceConfigId: string; expectedSourceRevision: number; targetUrl: string; adapterVersion: string; idempotencyKey: string; requestId?: string; retryOf?: string; trigger?: "manual" | "scheduled"; maxAttempts?: number; timeoutMs?: number }): Promise<CrawlRun> {
    requireOperationsAdmin(actor);
    runLimits("crawl", input.maxAttempts, input.timeoutMs);
    if (input.trigger !== undefined && !["manual", "scheduled"].includes(input.trigger)) throw new DomainError("INVALID_RUN_TRIGGER", "采集触发方式不正确。");
    const key = requireText(input.idempotencyKey, "幂等键", 120);
    const adapterVersion = requireText(input.adapterVersion, "适配器版本", 120);
    const hash = fingerprint([input.sourceConfigId, input.expectedSourceRevision, input.targetUrl, adapterVersion, input.retryOf ?? null, input.trigger ?? "manual", input.maxAttempts ?? 3, input.timeoutMs ?? 120_000]);
    return this.deps.repository.transaction(async (tx) => {
      await tx.acquireLock(`crawl:${actor.userId}:${key}`);
      const existing = await tx.findIdempotentRun(actor.userId, "crawl", key);
      if (existing) {
        if (existing.fingerprint !== hash || existing.run.kind !== "crawl") throw new DomainError("IDEMPOTENCY_CONFLICT", "相同幂等键已用于不同采集输入。", { status: 409 });
        return redactRun(existing.run) as CrawlRun;
      }
      const source = ensureEnabled(await tx.getSource(input.sourceConfigId, true));
      assertExpectedRevision(source.revision, input.expectedSourceRevision);
      const targetUrl = assertAllowedSourceUrl(input.targetUrl, source.networkPolicy);
      const now = this.deps.clock.now();
      if (source.health.nextEligibleAt && Date.parse(source.health.nextEligibleAt) > now.getTime()) throw new DomainError("SOURCE_FREQUENCY_LIMIT", "此来源尚未到下一次允许采集时间。", { status: 429, recoveryAction: "wait_until_source_next_eligible" });
      if (await tx.findActiveCrawl(source.id)) throw new DomainError("SOURCE_RUN_ACTIVE", "此来源已有排队或执行中的任务。", { status: 409 });
      if (input.retryOf) {
        const prior = await tx.getRun(input.retryOf);
        if (!prior || prior.kind !== "crawl" || prior.sourceConfigId !== source.id || !["failed", "cancelled"].includes(prior.status)) throw new DomainError("INVALID_RETRY_REFERENCE", "手动重跑只能引用此来源已失败或已取消的采集任务。");
      }
      const run: CrawlRun = { ...baseRun(this.deps, { kind: "crawl", actor, sourceConfigId: source.id, key, hash, requestId: input.requestId, retryOf: input.retryOf, trigger: input.trigger, maxAttempts: input.maxAttempts, timeoutMs: input.timeoutMs }), kind: "crawl", sourceSnapshot: source, targetUrl, adapterVersion, output: null };
      await tx.insertRun(run);
      await tx.bindIdempotencyRun(actor.userId, "crawl", key, hash, run.id);
      await tx.reserveSourceInterval(source.id, new Date(now.getTime() + source.minimumIntervalSeconds * 1000).toISOString());
      await this.audit(tx, actor.userId, run, "CrawlRunQueued", "发起已批准来源采集");
      return run;
    });
  }
  async enqueueAnalysis(actor: Actor, input: { crawlRunId: string; inputHash: string; schemaVersion: string; modelVersion: string; promptVersion: string; idempotencyKey: string; requestId?: string; retryOf?: string; maxAttempts?: number; timeoutMs?: number }): Promise<AnalysisRun> {
    requireOperationsAdmin(actor);
    runLimits("analysis", input.maxAttempts, input.timeoutMs);
    const key = requireText(input.idempotencyKey, "幂等键", 120);
    const inputHash = requireText(input.inputHash, "输入哈希", 200);
    const schemaVersion = requireText(input.schemaVersion, "结构版本", 120);
    const modelVersion = requireText(input.modelVersion, "模型版本", 120);
    const promptVersion = requireText(input.promptVersion, "提示版本", 120);
    const hash = fingerprint([inputHash, schemaVersion, modelVersion, promptVersion]);
    const requestHash = fingerprint([input.crawlRunId, hash, input.retryOf ?? null, input.maxAttempts ?? 3, input.timeoutMs ?? 300_000]);
    return this.deps.repository.transaction(async (tx) => {
      await tx.acquireLock(`analysis-key:${actor.userId}:${key}`);
      const existing = await tx.findIdempotentRun(actor.userId, "analysis", key);
      if (existing) {
        if (existing.fingerprint !== requestHash || existing.run.kind !== "analysis") throw new DomainError("IDEMPOTENCY_CONFLICT", "相同幂等键已用于不同分析输入。", { status: 409 });
        return redactRun(existing.run) as AnalysisRun;
      }
      const crawl = await tx.getRun(input.crawlRunId);
      if (!crawl || crawl.kind !== "crawl" || crawl.status !== "review_ready" || !crawl.output || crawl.output.inputHash !== inputHash) throw new DomainError("CRAWL_INPUT_NOT_READY", "分析需引用已校验的采集结果和相同内容哈希。", { status: 409 });
      ensureEnabled(await tx.getSource(crawl.sourceConfigId, true));
      await tx.acquireLock(`analysis-content:${crawl.sourceConfigId}:${hash}`);
      if (!input.retryOf) {
        const reusable = await tx.findReusableAnalysis(crawl.sourceConfigId, hash);
        if (reusable?.kind === "analysis") {
          await tx.bindIdempotencyRun(actor.userId, "analysis", key, requestHash, reusable.id);
          await this.audit(tx, actor.userId, reusable, "AnalysisInputReused", "相同内容哈希与版本复用已有分析");
          return redactRun(reusable) as AnalysisRun;
        }
      } else {
        const prior = await tx.getRun(input.retryOf);
        if (!prior || prior.kind !== "analysis" || prior.sourceConfigId !== crawl.sourceConfigId || prior.inputHash !== inputHash || !["failed", "cancelled"].includes(prior.status)) throw new DomainError("INVALID_RETRY_REFERENCE", "手动重跑只能引用相同输入已失败或已取消的分析任务。");
      }
      if (!crawl.output.candidateRefs.length) throw new DomainError("ANALYSIS_CANDIDATES_MISSING", "本次内容未变化，需复用既有分析或提供有效候选引用。", { status: 409 });
      const run: AnalysisRun = { ...baseRun(this.deps, { kind: "analysis", actor, sourceConfigId: crawl.sourceConfigId, key, hash, requestId: input.requestId, retryOf: input.retryOf, maxAttempts: input.maxAttempts, timeoutMs: input.timeoutMs }), kind: "analysis", crawlRunId: crawl.id, inputHash, candidateRefs: crawl.output.candidateRefs, schemaVersion, modelVersion, promptVersion, output: null };
      await tx.insertRun(run);
      await tx.bindIdempotencyRun(actor.userId, "analysis", key, requestHash, run.id);
      await this.audit(tx, actor.userId, run, "AnalysisRunQueued", "发起已校验来源分析");
      return run;
    });
  }
  async cancel(actor: Actor, id: string, input: { expectedRevision: number; reason: string }): Promise<ExecutionRun> {
    requireOperationsAdmin(actor);
    const reason = requireText(input.reason, "取消理由");
    return this.deps.repository.transaction(async (tx) => {
      const run = await tx.getRun(id, true);
      if (!run) return notFound();
      assertExpectedRevision(run.revision, input.expectedRevision);
      if (!["queued", "running"].includes(run.status)) throw new DomainError("RUN_ALREADY_FINISHED", "任务已结束，不能撤销已产生的候选或外部动作。", { status: 409 });
      const now = this.deps.clock.now().toISOString();
      const next: ExecutionRun = { ...run, status: "cancelled", revision: run.revision + 1, lease: null, updatedAt: now, finishedAt: now };
      await tx.saveRun(next, run.revision);
      await this.audit(tx, actor.userId, next, "RunCancelled", reason);
      return next;
    });
  }
  async reclaimExpired(actor: Actor, limit = 50): Promise<readonly ExecutionRun[]> {
    requireOperationsAdmin(actor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError("INVALID_PAGE_LIMIT", "一次最多回收 100 个超时任务。");
    const now = this.deps.clock.now();
    const expired = await this.deps.repository.findExpiredRuns(now.toISOString(), limit);
    const reclaimed: ExecutionRun[] = [];
    for (const observed of expired) {
      const result = await this.deps.repository.transaction(async (tx) => {
        const run = await tx.getRun(observed.id, true);
        if (!run || !["queued", "running"].includes(run.status)) return null;
        const source = await tx.getSource(run.sourceConfigId, true);
        const currentTime = this.deps.clock.now();
        const stale = !isCurrentSource(source, run);
        if (!stale && (run.status !== "running" || !run.lease || Date.parse(run.lease.expiresAt) > currentTime.getTime())) return null;
        const category = stale ? "source_changed" : Date.parse(run.lease!.deadlineAt) <= currentTime.getTime() ? "timeout" : "worker_lost";
        const next = retryRun(run, category, currentTime, run.kind === "crawl" ? (source?.minimumIntervalSeconds ?? 300) : 0);
        await tx.saveRun(next, run.revision);
        if (run.kind === "crawl" && source && !stale) await tx.recordSourceHealth(run.sourceConfigId, false, currentTime.toISOString());
        await this.audit(tx, actor.userId, next, "RunLeaseReclaimed", "超时任务回收，保留旧步骤与错误类别");
        return next;
      });
      if (result) reclaimed.push(result);
    }
    return reclaimed;
  }
  private async audit(tx: OperationsExecutionTransaction, actorId: string, run: ExecutionRun, action: string, reason: string): Promise<void> {
    await tx.appendAudit({ id: this.deps.ids.next(), actorKind: "user", actorId, action, entityId: run.id, revision: run.revision, reason, occurredAt: this.deps.clock.now().toISOString() });
  }
}

export class WorkerRunService {
  private readonly deps: RunServiceDependencies & { identities: WorkerIdentityPort; validation: CandidateValidationPort; leaseDurationMs?: number };
  constructor(deps: RunServiceDependencies & { identities: WorkerIdentityPort; validation: CandidateValidationPort; leaseDurationMs?: number }) {
    if (deps.leaseDurationMs !== undefined && (!Number.isInteger(deps.leaseDurationMs) || deps.leaseDurationMs < 1000 || deps.leaseDurationMs > 60_000)) throw new DomainError("INVALID_LEASE_DURATION", "任务租约需为 1–60 秒。");
    this.deps = deps;
  }
  async claim(serviceCredential: string, runId: string): Promise<ApprovedWorkerTask> {
    const worker = await this.authenticate(serviceCredential);
    const result = await this.deps.repository.transaction(async (tx): Promise<ApprovedWorkerTask | { error: DomainError }> => {
      const run = await tx.getRun(runId, true);
      if (!run) return notFound();
      assertWorkerScope(worker, run);
      if (run.status !== "queued" || run.attempt >= run.maxAttempts) throw new DomainError("RUN_NOT_CLAIMABLE", "任务尚不能领取或已被其他执行器领取。", { status: 409 });
      const source = await tx.getSource(run.sourceConfigId, true);
      // Waiting for a source row lock may take longer than a lease interval.
      const now = this.deps.clock.now();
      if (Date.parse(run.availableAt) > now.getTime()) throw new DomainError("RUN_NOT_CLAIMABLE", "任务尚未到允许重试时间。", { status: 409 });
      if (!isCurrentSource(source, run)) {
        const failed = retryRun(run, "source_changed", now, 0);
        await tx.saveRun(failed, run.revision);
        await this.audit(tx, worker, failed, "RunSourceInvalidated");
        return { error: new DomainError("SOURCE_CONFIG_CHANGED", "来源已停用或配置已变化，需要重新创建任务。", { status: 409 }) };
      }
      const approvedSource = source!;
      const deadlineAt = new Date(now.getTime() + run.timeoutMs).toISOString();
      const lease = { workerId: worker.id, token: randomBytes(32).toString("base64url"), expiresAt: new Date(Math.min(Date.parse(deadlineAt), now.getTime() + (this.deps.leaseDurationMs ?? 30_000))).toISOString(), deadlineAt };
      const step = run.kind === "crawl" ? "fetching" as const : "extracting" as const;
      const next: ExecutionRun = { ...run, status: "running", step, attempt: run.attempt + 1, revision: run.revision + 1, lastAttemptAt: now.toISOString(), lease, history: [...run.history, { step, attempt: run.attempt + 1, occurredAt: now.toISOString() }], updatedAt: now.toISOString() };
      await tx.saveRun(next, run.revision);
      if (run.kind === "crawl") await tx.reserveSourceInterval(approvedSource.id, new Date(now.getTime() + approvedSource.minimumIntervalSeconds * 1000).toISOString());
      await this.audit(tx, worker, next, "RunClaimed");
      return { runId: next.id, kind: next.kind, revision: next.revision, attempt: next.attempt, leaseToken: lease.token, leaseExpiresAt: lease.expiresAt, deadlineAt, source: approvedSourceSnapshot(run.kind === "crawl" ? run.sourceSnapshot : approvedSource),
        ...(run.kind === "crawl" ? { crawl: { targetUrl: run.targetUrl, adapterVersion: run.adapterVersion } } : { analysis: { crawlRunId: run.crawlRunId, inputHash: run.inputHash, candidateRefs: run.candidateRefs, schemaVersion: run.schemaVersion, modelVersion: run.modelVersion, promptVersion: run.promptVersion } }) };
    });
    if ("error" in result) throw result.error;
    return result;
  }
  /** Same-step heartbeat is allowed, but the absolute attempt deadline never moves. */
  async advance(serviceCredential: string, input: { runId: string; leaseToken: string; expectedRevision: number; step: ExecutionStep }): Promise<WorkerRunState> {
    const worker = await this.authenticate(serviceCredential);
    return this.deps.repository.transaction(async (tx) => {
      const run = await this.loadLeased(tx, worker, input);
      const order = run.kind === "crawl" ? ["fetching", "normalizing", "extracting", "validating"] : ["extracting", "validating"];
      const current = order.indexOf(run.step);
      const proposed = order.indexOf(input.step);
      if (proposed < current || proposed > current + 1 || proposed < 0) throw new DomainError("INVALID_RUN_STEP", "任务步骤只能按顺序推进。");
      const now = this.deps.clock.now();
      const lease = { ...run.lease!, expiresAt: new Date(Math.min(Date.parse(run.lease!.deadlineAt), now.getTime() + (this.deps.leaseDurationMs ?? 30_000))).toISOString() };
      const next: ExecutionRun = { ...run, step: input.step, revision: run.revision + 1, lease, history: input.step === run.step ? run.history : [...run.history, { step: input.step, attempt: run.attempt, occurredAt: now.toISOString() }], updatedAt: now.toISOString() };
      await tx.saveRun(next, run.revision);
      await this.audit(tx, worker, next, input.step === run.step ? "RunLeaseRenewed" : "RunStepAdvanced");
      return workerRunState(next);
    });
  }
  async fail(serviceCredential: string, input: { runId: string; leaseToken: string; expectedRevision: number; category: FailureCategory; retryAfterSeconds?: number }): Promise<WorkerRunState> {
    const worker = await this.authenticate(serviceCredential);
    return this.deps.repository.transaction(async (tx) => {
      const run = await this.loadLeased(tx, worker, input, false);
      const source = await tx.getSource(run.sourceConfigId, true);
      const now = this.deps.clock.now();
      assertRunLease(run, worker, input.leaseToken, now);
      const stale = !isCurrentSource(source, run);
      const next = retryRun(run, stale ? "source_changed" : input.category, now, run.kind === "crawl" ? (source?.minimumIntervalSeconds ?? 300) : 0, input.retryAfterSeconds);
      await tx.saveRun(next, run.revision);
      if (run.kind === "crawl" && source && !stale) await tx.recordSourceHealth(run.sourceConfigId, false, now.toISOString());
      await this.audit(tx, worker, next, next.status === "queued" ? "RunRetryScheduled" : "RunFailed");
      return workerRunState(next);
    });
  }
  async complete(serviceCredential: string, input: { runId: string; leaseToken: string; expectedRevision: number; resultRef: string }): Promise<WorkerRunState> {
    const worker = await this.authenticate(serviceCredential);
    const observed = await this.deps.repository.getRun(input.runId);
    if (!observed) return notFound();
    assertExpectedRevision(observed.revision, input.expectedRevision);
    assertRunLease(observed, worker, input.leaseToken, this.deps.clock.now());
    if (observed.step !== "validating") throw new DomainError("RUN_NOT_VALIDATING", "结果必须在结构校验步骤提交。", { status: 409 });
    const resultRef = requireText(input.resultRef, "结果引用", 200);
    const output = observed.kind === "crawl"
      ? await this.deps.validation.validateCrawl({ runId: observed.id, sourceConfigId: observed.sourceConfigId, sourceRevision: observed.sourceSnapshot.revision, targetUrl: observed.targetUrl, resultRef })
      : await this.deps.validation.validateAnalysis({ runId: observed.id, crawlRunId: observed.crawlRunId, inputHash: observed.inputHash, schemaVersion: observed.schemaVersion, modelVersion: observed.modelVersion, promptVersion: observed.promptVersion, resultRef });
    this.assertValidatedOutput(observed, output, resultRef);
    return this.deps.repository.transaction(async (tx) => {
      const run = await this.loadLeased(tx, worker, input);
      const now = this.deps.clock.now().toISOString();
      const next: ExecutionRun = run.kind === "crawl" ? { ...run, output: output as CrawlOutput, status: "review_ready", step: "complete", revision: run.revision + 1, lease: null, updatedAt: now, finishedAt: now } : { ...run, output: output as AnalysisOutput, status: "succeeded", step: "complete", revision: run.revision + 1, lease: null, updatedAt: now, finishedAt: now };
      await tx.saveRun(next, run.revision);
      if (run.kind === "crawl") await tx.recordSourceHealth(run.sourceConfigId, true, now);
      await this.audit(tx, worker, next, run.kind === "crawl" ? "CrawlCandidateReady" : "AnalysisValidated");
      return workerRunState(next);
    });
  }
  private assertValidatedOutput(run: ExecutionRun, output: CrawlOutput | AnalysisOutput, resultRef: string): void {
    if (!output || output.resultRef !== resultRef) throw new DomainError("INVALID_CANDIDATE_RESULT", "候选结果引用无效。");
    if (run.kind === "crawl") {
      const crawl = output as CrawlOutput;
      requireText(crawl.inputHash, "内容哈希", 200);
      if (!Array.isArray(crawl.eventSourceIds) || !crawl.eventSourceIds.length || crawl.eventSourceIds.length > 100 || !Array.isArray(crawl.candidateRefs) || (!crawl.unchanged && !crawl.candidateRefs.length) || crawl.candidateRefs.length > 100 || typeof crawl.unchanged !== "boolean") throw new DomainError("INVALID_CANDIDATE_RESULT", "采集结果缺少来源或候选引用。");
      [...crawl.eventSourceIds, ...crawl.candidateRefs].forEach((ref) => requireText(ref, "候选引用", 200));
    } else {
      const analysis = output as AnalysisOutput;
      requireText(analysis.outputRef, "分析结果引用", 200);
      if (![analysis.inputTokens, analysis.outputTokens, analysis.estimatedCostMicros].every((n) => Number.isSafeInteger(n) && n >= 0) || !["USD", "CNY"].includes(analysis.currency)) throw new DomainError("INVALID_ANALYSIS_USAGE", "分析用量或估算费用不正确。");
    }
  }
  private async authenticate(serviceCredential: string): Promise<VerifiedWorkerIdentity> {
    const worker = await this.deps.identities.authenticate(serviceCredential);
    if (!worker || worker.kind !== "operations_worker") throw new DomainError("WORKER_UNAUTHENTICATED", "采集服务身份无效。", { status: 401 });
    return worker;
  }
  private async loadLeased(tx: OperationsExecutionTransaction, worker: VerifiedWorkerIdentity, input: { runId: string; leaseToken: string; expectedRevision: number }, checkSource = true): Promise<ExecutionRun> {
    const run = await tx.getRun(input.runId, true);
    if (!run) return notFound();
    assertExpectedRevision(run.revision, input.expectedRevision);
    assertRunLease(run, worker, input.leaseToken, this.deps.clock.now());
    if (checkSource) {
      const source = ensureEnabled(await tx.getSource(run.sourceConfigId, true));
      if (run.kind === "crawl" && source.revision !== run.sourceSnapshot.revision) throw new DomainError("SOURCE_CONFIG_CHANGED", "来源配置已变化，本任务不能继续获取或生成候选。", { status: 409 });
      assertRunLease(run, worker, input.leaseToken, this.deps.clock.now());
    }
    return run;
  }
  private async audit(tx: OperationsExecutionTransaction, worker: VerifiedWorkerIdentity, run: ExecutionRun, action: string): Promise<void> {
    await tx.appendAudit({ id: this.deps.ids.next(), actorKind: "worker", actorId: worker.id, action, entityId: run.id, revision: run.revision, reason: "受限执行服务更新任务；未执行公开发布", occurredAt: this.deps.clock.now().toISOString() });
  }
}
