import type { Clock } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { assertAllowedSourceUrl, fetchApprovedSource } from "./network-policy.ts";
import type { NetworkPolicy, PinnedFetchPort, PublicDnsPort } from "./network-policy.ts";
import { assertRobotsAllowed } from "./robots-policy.ts";
import type { ApprovedWorkerTask, ExecutionStep, FailureCategory, WorkerRunState } from "./run-domain.ts";
import type { WorkerRunService } from "./run-service.ts";
import { normalizeAcquiredSource, parseSourceAnalysis, parseSourceExtraction, SOURCE_ANALYSIS_PROMPT, SOURCE_ANALYSIS_SCHEMA_VERSION, SOURCE_EXTRACTION_PROMPT, SOURCE_EXTRACTION_SCHEMA_VERSION, validateAcquiredSource } from "./source-extraction.ts";
import type { AcquiredSource, SourceAnalysisDraft, SourceExtractionCandidates } from "./source-extraction.ts";

export const SOURCE_CRAWL_ADAPTER_VERSION = "restricted-source-v1";
export interface SourceModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostMicros: number;
  readonly currency: "USD" | "CNY";
}
export interface SourceJsonModelPort {
  readonly modelVersion: string;
  readonly promptVersion: string;
  generateJson(input: { readonly taskId: string; readonly task: "source_crawl" | "source_analysis"; readonly schemaVersion: string; readonly prompt: string; readonly input: Readonly<Record<string, unknown>>; readonly signal: AbortSignal }): Promise<{ readonly json: unknown; readonly usage: SourceModelUsage }>;
}
export interface SourceLeaseGuard {
  readonly runId: string;
  readonly leaseToken: string;
  readonly expectedRevision: number;
  readonly sourceConfigId: string;
  readonly sourceRevision: number;
}
export interface SourceModelProvenance {
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly usage: SourceModelUsage;
}
export type SourceCandidateIngestionInput = SourceLeaseGuard & {
  readonly targetUrl: string;
  readonly acquired: AcquiredSource;
  readonly model: SourceModelProvenance;
} & ({ readonly kind: "crawl"; readonly candidates: SourceExtractionCandidates }
  | { readonly kind: "analysis"; readonly crawlRunId: string; readonly inputHash: string; readonly schemaVersion: string; readonly analysis: SourceAnalysisDraft });
type IngestionWithoutGuard<T> = T extends SourceLeaseGuard ? Omit<T, keyof SourceLeaseGuard> : never;
type SourceIngestionPayload = IngestionWithoutGuard<SourceCandidateIngestionInput>;

/** Control-plane bridge to M03. Both methods must authenticate the worker's run,
 * lock current run/source, validate token+revision+expiry+source approval in the SAME
 * transaction as reads/writes, and honor cancellation before committing. Immutable
 * resultRefs must bind run/source, acquisition hashes and all schema/model versions.
 * store has no publication capability and must never promote evidence to verified.
 * Do not provide DatabasePort or site/GitHub credentials to the isolated executor. */
export interface SourceCandidateIngestionPort {
  store(input: SourceCandidateIngestionInput, signal: AbortSignal): Promise<{ readonly resultRef: string }>;
  loadAnalysis(input: SourceLeaseGuard & { readonly crawlRunId: string; readonly inputHash: string; readonly candidateRefs: readonly string[] }, signal: AbortSignal): Promise<{ readonly inputHash: string; readonly targetUrl: string; readonly acquired: AcquiredSource; readonly candidates: SourceExtractionCandidates }>;
}
export interface SourceWorkerNetworkPorts {
  readonly dns: PublicDnsPort;
  readonly transport: PinnedFetchPort;
  readonly userAgent: string;
  readonly assertRobotsAllowed?: (input: { readonly sourceUrl: string; readonly policy: NetworkPolicy; readonly dns: PublicDnsPort; readonly transport: PinnedFetchPort; readonly userAgent: string; readonly signal?: AbortSignal }) => Promise<unknown>;
}
export interface SourceWorkerDependencies {
  readonly control: Pick<WorkerRunService, "claim" | "advance" | "fail" | "complete">;
  readonly serviceCredential: string;
  readonly clock: Clock;
  readonly candidates: SourceCandidateIngestionPort;
  readonly model: SourceJsonModelPort;
  readonly network: SourceWorkerNetworkPorts;
  readonly heartbeatIntervalMs?: number;
  readonly controlTimeoutMs?: number;
}
export interface SourceWorker {
  execute(runId: string, options?: { readonly signal?: AbortSignal }): Promise<WorkerRunState>;
}

function aborted(signal: AbortSignal): never {
  if (signal.reason instanceof DomainError) throw signal.reason;
  throw new DomainError("SOURCE_WORKER_CANCELLED", "采集执行已停止，未执行公开发布。", { status: 409 });
}
async function interruptible<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return aborted(signal);
  let onAbort = () => {};
  const interruption = new Promise<never>((_, reject) => {
    onAbort = () => {
      try { aborted(signal); } catch (error) { reject(error); }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([Promise.resolve().then(() => { if (signal.aborted) return aborted(signal); return start(); }), interruption]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
async function boundedControl<T>(start: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DomainError("SOURCE_WORKER_CONTROL_TIMEOUT", "任务控制接口超时，请由看门狗核对租约状态。", { status: 503 })), timeoutMs); });
  try { return await Promise.race([Promise.resolve().then(start), timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
export function sourceWorkerFailureCategory(error: unknown, step: ExecutionStep, modelRequestStarted = false): FailureCategory {
  // Once a model request starts, its paid outcome can be unknown. Retrying the
  // whole run could charge again, including after a downstream storage failure.
  if (modelRequestStarted) return "parse_error";
  if (error instanceof DomainError) {
    if (["FETCH_TIMEOUT", "SOURCE_WORKER_TIMEOUT", "DSH_TIMEOUT", "MODEL_TIMEOUT"].includes(error.code)) return "timeout";
    if (["FETCH_RATE_LIMITED", "DSH_RATE_LIMITED", "MODEL_RATE_LIMITED"].includes(error.code)) return "rate_limited";
    if (["FETCH_ACCESS_DENIED", "ROBOTS_ACCESS_DENIED", "ROBOTS_DISALLOWED", "ROBOTS_DENIED"].includes(error.code)) return "access_denied";
    if (["SOURCE_CONFIG_CHANGED", "SOURCE_NOT_ENABLED"].includes(error.code)) return "source_changed";
    if (error.code === "SOURCE_WORKER_CANCELLED") return "worker_lost";
    if (["SOURCE_EXTRACTION_INVALID", "INVALID_CANDIDATE_RESULT", "INVALID_RULE_VERSION", "INVALID_ANALYSIS_USAGE", "SOURCE_MODEL_USAGE_INVALID"].includes(error.code)) return "schema_invalid";
    if (["SOURCE_CONTENT_EMPTY", "SOURCE_CONTENT_PARSE_FAILED", "SOURCE_CONTENT_TYPE_UNSUPPORTED", "SOURCE_TEXT_TOO_LARGE", "SOURCE_CONTENT_TOO_LARGE"].includes(error.code)) return "parse_error";
    if (["UNSAFE_SOURCE_URL", "FETCH_RESPONSE_REJECTED", "FETCH_REDIRECT_LIMIT", "ROBOTS_REDIRECT_REJECTED", "SOURCE_ADAPTER_UNSUPPORTED", "SOURCE_MODEL_VERSION_MISMATCH"].includes(error.code)) return "invalid_input";
    if (["FETCH_UNAVAILABLE", "ROBOTS_UNAVAILABLE", "SOURCE_MODEL_UNCONFIGURED", "DSH_NOT_CONFIGURED", "DSH_UNAVAILABLE", "SOURCE_WORKER_CONTROL_TIMEOUT"].includes(error.code)) return "provider_unavailable";
  }
  return step === "fetching" ? "network_error" : step === "normalizing" ? "parse_error" : step === "extracting" ? "provider_unavailable" : "schema_invalid";
}
function checkedUsage(value: SourceModelUsage): SourceModelUsage {
  if (!value || ![value.inputTokens, value.outputTokens, value.estimatedCostMicros].every((amount) => Number.isSafeInteger(amount) && amount >= 0) || !["USD", "CNY"].includes(value.currency)) throw new DomainError("SOURCE_MODEL_USAGE_INVALID", "模型未返回有效用量或费用估计。", { status: 422 });
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens, estimatedCostMicros: value.estimatedCostMicros, currency: value.currency };
}
function assertTask(task: ApprovedWorkerTask, runId: string): void {
  if (!task || task.runId !== runId || !Number.isSafeInteger(task.revision) || task.revision < 1 || !task.leaseToken || !Number.isFinite(Date.parse(task.leaseExpiresAt)) || !Number.isFinite(Date.parse(task.deadlineAt)) || !["crawl", "analysis"].includes(task.kind)) throw new DomainError("SOURCE_WORKER_TASK_INVALID", "任务控制接口返回了无效的批准任务。", { status: 503 });
}
function assertState(state: WorkerRunState, task: ApprovedWorkerTask, priorRevision: number): void {
  if (!state || state.id !== task.runId || state.kind !== task.kind || !Number.isSafeInteger(state.revision) || state.revision <= priorRevision) throw new DomainError("SOURCE_WORKER_CONTROL_INVALID", "任务控制状态与当前租约不一致。", { status: 503 });
}

/** Executes exactly one approved lease. It never discovers arbitrary URLs or
 * calls a publication port; discovery scheduling is a separate root-owned flow. */
export function createSourceWorker(deps: SourceWorkerDependencies): SourceWorker {
  if (!deps.control || !deps.candidates || !deps.network?.dns || !deps.network?.transport || !deps.network.userAgent?.trim() || !deps.serviceCredential?.trim()) throw new DomainError("SOURCE_WORKER_UNCONFIGURED", "受限采集执行器尚未完成端口配置。", { status: 503 });
  if (!deps.model?.generateJson || !deps.model.modelVersion?.trim() || !deps.model.promptVersion?.trim()) throw new DomainError("SOURCE_MODEL_UNCONFIGURED", "来源提取模型尚未配置，不能生成采集成功状态。", { status: 503 });
  if (deps.heartbeatIntervalMs !== undefined && (!Number.isInteger(deps.heartbeatIntervalMs) || deps.heartbeatIntervalMs < 5 || deps.heartbeatIntervalMs > 20_000)) throw new DomainError("INVALID_SOURCE_WORKER_LIMIT", "心跳间隔需为 5–20000 毫秒。", { status: 422 });
  const controlTimeoutMs = deps.controlTimeoutMs ?? 10_000;
  if (!Number.isInteger(controlTimeoutMs) || controlTimeoutMs < 100 || controlTimeoutMs > 30_000) throw new DomainError("INVALID_SOURCE_WORKER_LIMIT", "控制请求超时需为 100–30000 毫秒。", { status: 422 });

  return { async execute(runId, options = {}) {
    if (options.signal?.aborted) return aborted(options.signal);
    const task = await boundedControl(() => deps.control.claim(deps.serviceCredential, runId), controlTimeoutMs);
    assertTask(task, runId);
    let state: WorkerRunState = { id: task.runId, kind: task.kind, revision: task.revision, status: "running", step: task.kind === "crawl" ? "fetching" : "extracting", attempt: task.attempt, availableAt: deps.clock.now().toISOString(), leaseExpiresAt: task.leaseExpiresAt, deadlineAt: task.deadlineAt, finishedAt: null };
    const controller = new AbortController();
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let queue: Promise<unknown> = Promise.resolve();
    let heartbeatError: unknown = null;
    let completing = false;
    let modelRequestStarted = false;
    const onExternalAbort = () => controller.abort(new DomainError("SOURCE_WORKER_CANCELLED", "采集执行已停止，任务需核对或重试。", { status: 409 }));
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (options.signal?.aborted) onExternalAbort();
    const remaining = Date.parse(task.deadlineAt) - deps.clock.now().getTime();
    // Leave a small budget to record timeout before the authoritative lease expires.
    const deadlineBudget = Math.max(0, remaining - Math.min(100, Math.floor(Math.max(0, remaining) / 10)));
    deadlineTimer = setTimeout(() => controller.abort(new DomainError("SOURCE_WORKER_TIMEOUT", "采集尝试已到执行时限，已停止网络与模型请求。", { status: 503 })), deadlineBudget);

    const serial = <T>(work: () => Promise<T>): Promise<T> => {
      const result = queue.then(work);
      queue = result.catch(() => {});
      return result;
    };
    const checkActive = () => {
      if (heartbeatError) throw heartbeatError;
      if (controller.signal.aborted) return aborted(controller.signal);
      const now = deps.clock.now().getTime();
      if (state.status !== "running" || !state.leaseExpiresAt || !state.deadlineAt || Date.parse(state.leaseExpiresAt) <= now || Date.parse(state.deadlineAt) <= now) throw new DomainError("WORKER_LEASE_LOST", "当前执行租约已经失效。", { status: 409 });
    };
    const guard = (): SourceLeaseGuard => ({ runId: task.runId, leaseToken: task.leaseToken, expectedRevision: state.revision, sourceConfigId: task.source.id, sourceRevision: task.source.revision });
    const update = async (step: ExecutionStep): Promise<void> => {
      checkActive();
      const revision = state.revision;
      const updated = await boundedControl(() => deps.control.advance(deps.serviceCredential, { runId: task.runId, leaseToken: task.leaseToken, expectedRevision: revision, step }), controlTimeoutMs);
      assertState(updated, task, revision);
      state = updated;
    };
    const clearHeartbeat = () => { if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer); heartbeatTimer = undefined; };
    const scheduleHeartbeat = () => {
      if (completing || controller.signal.aborted || state.status !== "running") return;
      clearHeartbeat();
      const leaseRemaining = Math.max(1, Date.parse(state.leaseExpiresAt!) - deps.clock.now().getTime());
      const interval = Math.max(1, Math.min(deps.heartbeatIntervalMs ?? 10_000, Math.floor(leaseRemaining / 3)));
      heartbeatTimer = setTimeout(() => {
        void serial(async () => { if (!completing) await update(state.step); }).then(scheduleHeartbeat).catch((error) => { heartbeatError = error; controller.abort(error); });
      }, interval);
    };
    const robots = deps.network.assertRobotsAllowed ?? assertRobotsAllowed;
    const robotsFor = (sourceUrl: string) => interruptible(() => robots({ sourceUrl, policy: task.source.networkPolicy, dns: deps.network.dns, transport: deps.network.transport, userAgent: deps.network.userAgent, signal: controller.signal }), controller.signal);
    const model = (purpose: "source_crawl" | "source_analysis", acquired: AcquiredSource, candidates?: SourceExtractionCandidates) => interruptible(() => {
      modelRequestStarted = true;
      return deps.model.generateJson({ taskId: task.runId, task: purpose, schemaVersion: purpose === "source_crawl" ? SOURCE_EXTRACTION_SCHEMA_VERSION : SOURCE_ANALYSIS_SCHEMA_VERSION, prompt: purpose === "source_crawl" ? SOURCE_EXTRACTION_PROMPT : SOURCE_ANALYSIS_PROMPT, input: { schemaVersion: purpose === "source_crawl" ? SOURCE_EXTRACTION_SCHEMA_VERSION : SOURCE_ANALYSIS_SCHEMA_VERSION, sourceUrl: acquired.finalUrl, sourceText: acquired.text, ...(candidates ? { candidates } : {}) }, signal: controller.signal });
    }, controller.signal);
    scheduleHeartbeat();
    try {
      checkActive();
      let ingestion: SourceIngestionPayload;
      if (task.kind === "crawl") {
        if (!task.crawl || task.crawl.adapterVersion !== SOURCE_CRAWL_ADAPTER_VERSION) throw new DomainError("SOURCE_ADAPTER_UNSUPPORTED", "当前采集适配器版本未被此执行器批准。", { status: 422 });
        const targetUrl = assertAllowedSourceUrl(task.crawl.targetUrl, task.source.networkPolicy);
        await robotsFor(targetUrl);
        const redirectAwareTransport: PinnedFetchPort = { request: async (request) => {
          const response = await deps.network.transport.request(request);
          if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
            const nextUrl = assertAllowedSourceUrl(new URL(response.location, request.url).toString(), task.source.networkPolicy);
            await robotsFor(nextUrl);
          }
          return response;
        } };
        const fetched = await interruptible(() => fetchApprovedSource({ url: targetUrl, policy: task.source.networkPolicy, dns: deps.network.dns, transport: redirectAwareTransport, signal: controller.signal }), controller.signal);
        await serial(() => update("normalizing"));
        const acquired = normalizeAcquiredSource({ ...fetched, fetchedAt: deps.clock.now().toISOString() });
        await serial(() => update("extracting"));
        const generated = await model("source_crawl", acquired);
        const candidates = parseSourceExtraction(generated.json, acquired);
        ingestion = { kind: "crawl", targetUrl, acquired, candidates, model: { modelVersion: deps.model.modelVersion, promptVersion: deps.model.promptVersion, usage: checkedUsage(generated.usage) } };
      } else {
        if (!task.analysis || task.analysis.schemaVersion !== SOURCE_ANALYSIS_SCHEMA_VERSION || task.analysis.modelVersion !== deps.model.modelVersion || task.analysis.promptVersion !== deps.model.promptVersion) throw new DomainError("SOURCE_MODEL_VERSION_MISMATCH", "分析任务的结构、模型或提示版本与当前执行器不匹配。", { status: 422 });
        const analysisTask = task.analysis;
        const loaded = await serial(async () => {
          checkActive();
          return interruptible(() => deps.candidates.loadAnalysis({ ...guard(), crawlRunId: analysisTask.crawlRunId, inputHash: analysisTask.inputHash, candidateRefs: analysisTask.candidateRefs }, controller.signal), controller.signal);
        });
        if (loaded.inputHash !== analysisTask.inputHash) throw new DomainError("SOURCE_EXTRACTION_INVALID", "分析加载内容与批准的输入哈希不同。", { status: 422 });
        const acquired = validateAcquiredSource(loaded.acquired);
        const targetUrl = assertAllowedSourceUrl(loaded.targetUrl, task.source.networkPolicy);
        assertAllowedSourceUrl(acquired.finalUrl, task.source.networkPolicy);
        if (loaded.candidates.verificationStatus !== "unverified" || loaded.candidates.schemaVersion !== SOURCE_EXTRACTION_SCHEMA_VERSION) throw new DomainError("SOURCE_EXTRACTION_INVALID", "分析输入不是当前候选结构。", { status: 422 });
        const generated = await model("source_analysis", acquired, loaded.candidates);
        const analysis = parseSourceAnalysis(generated.json, acquired, loaded.candidates);
        ingestion = { kind: "analysis", targetUrl, acquired, crawlRunId: analysisTask.crawlRunId, inputHash: analysisTask.inputHash, schemaVersion: analysisTask.schemaVersion, analysis, model: { modelVersion: deps.model.modelVersion, promptVersion: deps.model.promptVersion, usage: checkedUsage(generated.usage) } };
      }
      await serial(() => update("validating"));
      completing = true;
      clearHeartbeat();
      return await serial(async () => {
        checkActive();
        const persisted = await interruptible(() => deps.candidates.store({ ...ingestion, ...guard() } as SourceCandidateIngestionInput, controller.signal), controller.signal);
        checkActive();
        if (!persisted || typeof persisted.resultRef !== "string" || !persisted.resultRef.trim() || persisted.resultRef.length > 200) throw new DomainError("INVALID_CANDIDATE_RESULT", "候选写入未返回有效的持久化结果引用。", { status: 422 });
        const revision = state.revision;
        const completed = await boundedControl(() => deps.control.complete(deps.serviceCredential, { runId: task.runId, leaseToken: task.leaseToken, expectedRevision: revision, resultRef: persisted.resultRef }), controlTimeoutMs);
        assertState(completed, task, revision);
        if (completed.status !== (task.kind === "crawl" ? "review_ready" : "succeeded")) throw new DomainError("SOURCE_WORKER_CONTROL_INVALID", "任务结果尚未获得实际校验完成状态。", { status: 503 });
        state = completed;
        return state;
      });
    } catch (error) {
      completing = true;
      clearHeartbeat();
      controller.abort(error);
      await queue;
      if (error instanceof DomainError && ["WORKER_LEASE_LOST", "VERSION_CONFLICT", "WORKER_SCOPE_DENIED", "WORKER_UNAUTHENTICATED"].includes(error.code)) throw error;
      return await serial(async () => {
        const revision = state.revision;
        const failed = await boundedControl(() => deps.control.fail(deps.serviceCredential, { runId: task.runId, leaseToken: task.leaseToken, expectedRevision: revision, category: sourceWorkerFailureCategory(error, state.step, modelRequestStarted) }), controlTimeoutMs);
        assertState(failed, task, revision);
        if (!["queued", "failed"].includes(failed.status)) throw new DomainError("SOURCE_WORKER_CONTROL_INVALID", "失败状态尚未得到实际任务控制确认。", { status: 503 });
        state = failed;
        return state;
      });
    } finally {
      completing = true;
      clearHeartbeat();
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      options.signal?.removeEventListener("abort", onExternalAbort);
      controller.abort();
    }
  } };
}
