import { createHash } from "node:crypto";
import type { Actor, Clock, IdGenerator, ProjectAccessPort } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { assertPublishable, diffRuleVersions, validateRuleVersion } from "./domain.ts";
import type { EventRuleVersion } from "./domain.ts";
import { validateAnalysisContent, validateAnalysisInput } from "./analysis.ts";
import type {
  AnalysisInput, AnalysisModelPort, AnalysisRun, EventAnalysis, EventFilter, EventRecord,
  EventsRepository, EventsUnitOfWork, ProjectWriteAccessPort, ProjectBackgroundVersionPort, PublicationStatus,
} from "./model.ts";

export interface EventsServiceDependencies {
  repository: EventsRepository;
  projectAccess: ProjectAccessPort;
  projectWriteAccess?: ProjectWriteAccessPort;
  projectBackgroundVersion?: ProjectBackgroundVersionPort;
  clock: Clock;
  ids: IdGenerator;
  model?: AnalysisModelPort;
  modelTimeoutMs?: number;
  maxModelAttempts?: number;
}
function requiredText(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new DomainError("INVALID_INPUT", `${name}不能为空或超过长度限制。`);
  }
  return value.trim();
}
function revision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new DomainError("INVALID_REVISION", "请提供有效的预期版本号。");
}
function checkRevision(expected: number, actual: number): void {
  revision(expected);
  if (expected !== actual) throw new DomainError("VERSION_CONFLICT", "内容已被更新，请查看最新版本后重试。", {
    status: 409, recoveryAction: "review_latest_version", latestRevision: actual,
  });
}
function authenticated(actor: Actor | null): asserts actor is Actor {
  if (!actor?.userId) throw new DomainError("AUTH_REQUIRED", "请登录后继续。", { status: 401 });
}
function reviewer(actor: Actor): void {
  authenticated(actor);
  if (!actor.platformRoles.some(role => role === "reviewer" || role === "admin")) {
    throw new DomainError("REVIEW_PERMISSION_REQUIRED", "只有运营审核员可以修改公共赛事内容。", { status: 403 });
  }
}
function notFound(): never { throw new DomainError("NOT_FOUND", "未找到可访问的内容。", { status: 404 }); }
function modelFailureCode(error: unknown): string {
  if (!(error instanceof DomainError)) return "MODEL_FAILED";
  // The root transport has a structural externalState marker. Inspect safe own
  // metadata without importing its class or accessing arbitrary error getters.
  const externalState = Object.getOwnPropertyDescriptor(error, "externalState")?.value;
  if (externalState === "unknown" || ["NETWORK_UNKNOWN", "AI_NETWORK_UNCERTAIN", "AI_TIMEOUT_UNCERTAIN", "AI_CANCELLED_UNCERTAIN", "AI_PROVIDER_UNCERTAIN"].includes(error.code)) return "NETWORK_UNKNOWN";
  const stable = [
    "MODEL_TIMEOUT", "INVALID_ANALYSIS", "ANALYSIS_INPUT_TOO_LARGE", "INVALID_ANALYSIS_INPUT", "INVALID_MODEL_RESPONSE",
    "AI_BUDGET_EXCEEDED", "AI_AUTH_FAILED", "AI_BALANCE_INSUFFICIENT", "AI_RATE_LIMITED", "AI_REQUEST_REJECTED",
    "AI_INPUT_INVALID", "AI_INPUT_TOO_LARGE", "AI_RESPONSE_INVALID", "AI_RESPONSE_TOO_LARGE", "AI_OUTPUT_TRUNCATED", "AI_JSON_INVALID", "AI_EXECUTION_CONTEXT_REQUIRED", "AI_RETRY_LIMIT",
  ];
  return stable.includes(error.code) ? error.code : "MODEL_FAILED";
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function analysisInputHash(input: AnalysisInput): string {
  return createHash("sha256").update(canonical(input)).digest("hex");
}

export class EventsService {
  private readonly dependencies: EventsServiceDependencies;
  constructor(dependencies: EventsServiceDependencies) {
    const timeout = dependencies.modelTimeoutMs ?? 30_000;
    const attempts = dependencies.maxModelAttempts ?? 2;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000 || !Number.isSafeInteger(attempts) || attempts < 1 || attempts > 3) {
      throw new DomainError("INVALID_CONFIGURATION", "模型超时或重试配置无效。");
    }
    this.dependencies = dependencies;
  }
  private get repository(): EventsRepository { return this.dependencies.repository; }
  private now(): string { return this.dependencies.clock.now().toISOString(); }
  private async membership(actor: Actor, projectId: string, manager = false, transaction?: EventsUnitOfWork): Promise<void> {
    authenticated(actor);
    requiredText(projectId, "项目 ID");
    const guard = this.dependencies.projectWriteAccess;
    if (transaction && !guard) throw new DomainError("PROJECT_WRITE_ACCESS_UNAVAILABLE", "项目事务权限适配尚未接入。", { status: 503 });
    const member = transaction
      ? await guard!.getMembershipForUpdate(transaction.executor, projectId, actor.userId)
      : await this.dependencies.projectAccess.getMembership(projectId, actor.userId);
    if (!member || member.status !== "active" || member.userId !== actor.userId || member.projectId !== projectId) notFound();
    if (manager && member.role !== "manager") throw new DomainError("PROJECT_MANAGER_REQUIRED", "只有活跃项目管理员可以确认赛事要求。", { status: 403 });
  }
  private async rules(transaction: EventsUnitOfWork, eventId: string, version: number): Promise<EventRuleVersion> {
    const value = await transaction.getRules(eventId, version);
    if (!value) notFound();
    return value;
  }
  private async selectableRules(transaction: EventsUnitOfWork, projectId: string, eventId: string, version: number): Promise<EventRuleVersion> {
    const event = await transaction.getEvent(eventId);
    const confirmed = await transaction.getConfirmation(projectId);
    const isCurrent = event && event.publicationStatus !== "archived" && event.publishedVersion === version;
    const isConfirmed = confirmed?.eventId === eventId && confirmed.rulesVersion === version;
    if (!isCurrent && !isConfirmed) notFound();
    return this.rules(transaction, eventId, version);
  }
  private async audit(transaction: EventsUnitOfWork, type: "EventPublished" | "EventRulesChanged" | "ProjectRequirementsConfirmed" | "EventCorrectionSubmitted", aggregateId: string, version: number, actor: Actor, projectId: string | null = null, rulesEventId = aggregateId, rulesVersion = version): Promise<void> {
    await transaction.appendAudit({ id: this.dependencies.ids.next(), type, aggregateId, version, actorId: actor.userId, projectId, occurredAt: this.now(), rulesEventId, rulesVersion });
  }
  async listEvents(filter: EventFilter = {}) {
    if (filter.limit !== undefined && (!Number.isSafeInteger(filter.limit) || filter.limit < 1 || filter.limit > 50)) throw new DomainError("INVALID_FILTER", "每页数量必须在 1 到 50 之间。");
    if (filter.format !== undefined && !["online", "offline", "hybrid", "unknown"].includes(filter.format)) throw new DomainError("INVALID_FILTER", "赛事形式筛选无效。");
    if (filter.phase !== undefined && !["registration", "active", "awaiting_submission", "ended", "unknown"].includes(filter.phase)) throw new DomainError("INVALID_FILTER", "赛事阶段筛选无效。");
    if (filter.beginnerEligibility !== undefined && !["verified", "unknown"].includes(filter.beginnerEligibility)) throw new DomainError("INVALID_FILTER", "新人资格筛选无效。");
    for (const field of [filter.query, filter.region, filter.cursor]) if (field !== undefined && (typeof field !== "string" || field.length > 200)) throw new DomainError("INVALID_FILTER", "筛选条件过长或无效。");
    return this.repository.listPublished(filter, this.dependencies.clock.now());
  }
  async getEvent(eventId: string) {
    const id = requiredText(eventId, "赛事 ID");
    const event = await this.repository.getEvent(id);
    if (!event?.publishedVersion || event.publicationStatus === "archived") notFound();
    return { event, rules: await this.rules(this.repository, id, event.publishedVersion) };
  }
  async createCandidate(actor: Actor, input: unknown, expectedRevision: number): Promise<EventRecord> {
    reviewer(actor);
    const rules = validateRuleVersion(input);
    return this.repository.transaction(async transaction => {
      const current = await transaction.getEvent(rules.eventId);
      checkRevision(expectedRevision, current?.revision ?? 0);
      if (current?.publicationStatus === "archived") throw new DomainError("EVENT_ARCHIVED", "已撤下赛事需要单独的恢复审核流程，不能直接改为公开候选。");
      if (rules.version !== (current?.candidateVersion ?? 0) + 1) throw new DomainError("INVALID_RULES_VERSION", "新规则必须使用下一个版本号。");
      const next: EventRecord = {
        id: rules.eventId, revision: expectedRevision + 1, publicationStatus: "draft",
        candidateVersion: rules.version, publishedVersion: current?.publishedVersion ?? null,
        lastVerifiedAt: current?.lastVerifiedAt ?? null,
      };
      await transaction.insertRules({ ...rules, createdAt: this.now() });
      await transaction.saveEvent(next, expectedRevision);
      return next;
    });
  }
  async requestReview(actor: Actor, eventId: string, expectedRevision: number) {
    return this.changePublication(actor, eventId, expectedRevision, "pending_review");
  }
  async returnToDraft(actor: Actor, eventId: string, expectedRevision: number) {
    return this.changePublication(actor, eventId, expectedRevision, "draft");
  }
  async archiveEvent(actor: Actor, eventId: string, expectedRevision: number) {
    return this.changePublication(actor, eventId, expectedRevision, "archived");
  }
  private async changePublication(actor: Actor, eventId: string, expectedRevision: number, status: PublicationStatus) {
    reviewer(actor);
    return this.repository.transaction(async transaction => {
      const event = await transaction.getEvent(eventId);
      if (!event) notFound();
      checkRevision(expectedRevision, event.revision);
      if (status === "pending_review" && event.publicationStatus !== "draft") throw new DomainError("INVALID_PUBLICATION_STATE", "仅草稿可提交审核。");
      if (status === "draft" && event.publicationStatus !== "pending_review") throw new DomainError("INVALID_PUBLICATION_STATE", "仅待审核内容可退回草稿。");
      const next = { ...event, revision: event.revision + 1, publicationStatus: status };
      await transaction.saveEvent(next, expectedRevision);
      return next;
    });
  }
  async publishCandidate(actor: Actor, eventId: string, expectedRevision: number) {
    reviewer(actor);
    return this.repository.transaction(async transaction => {
      const event = await transaction.getEvent(eventId);
      if (!event) notFound();
      checkRevision(expectedRevision, event.revision);
      if (event.publicationStatus !== "pending_review") throw new DomainError("REVIEW_REQUIRED", "请先将候选规则提交审核。");
      const rules = await this.rules(transaction, eventId, event.candidateVersion);
      assertPublishable(rules);
      const next: EventRecord = { ...event, revision: event.revision + 1, publicationStatus: "published", publishedVersion: event.candidateVersion, lastVerifiedAt: this.now() };
      await transaction.saveEvent(next, expectedRevision);
      await this.audit(transaction, event.publishedVersion ? "EventRulesChanged" : "EventPublished", eventId, rules.version, actor);
      return { event: next, rules };
    });
  }
  async getProjectRules(actor: Actor, projectId: string) {
    await this.membership(actor, projectId);
    const confirmation = await this.repository.getConfirmation(projectId);
    if (!confirmation) return { confirmation: null, rules: null };
    return { confirmation, rules: await this.rules(this.repository, confirmation.eventId, confirmation.rulesVersion) };
  }
  async confirmProjectRules(actor: Actor, projectId: string, eventId: string, rulesVersion: number, expectedRevision: number, analysisId: string | null = null) {
    if (!Number.isSafeInteger(rulesVersion) || rulesVersion < 1) throw new DomainError("INVALID_RULES_VERSION", "规则版本必须是正整数。");
    return this.repository.transaction(async transaction => {
      await this.membership(actor, projectId, true, transaction);
      const current = await transaction.getConfirmation(projectId);
      checkRevision(expectedRevision, current?.revision ?? 0);
      await this.selectableRules(transaction, projectId, eventId, rulesVersion);
      if (analysisId) {
        const analysis = await transaction.getAnalysis(analysisId);
        if (!analysis || analysis.projectId !== projectId || analysis.eventId !== eventId || analysis.rulesVersion !== rulesVersion || !analysis.content) notFound();
        if (analysis.status !== "draft") throw new DomainError("INVALID_ANALYSIS_STATE", "只有分析草案可以确认。");
        const backgroundVersion = await this.dependencies.projectBackgroundVersion?.getCurrentBackgroundVersion(projectId);
        if (backgroundVersion !== undefined && backgroundVersion !== null && backgroundVersion !== analysis.backgroundVersion) throw new DomainError("ANALYSIS_BACKGROUND_CHANGED", "队伍背景已更新，请对照旧分析后重新整理草案。", { status: 409, recoveryAction: "regenerate_analysis" });
        validateAnalysisContent(analysis.content, await this.rules(transaction, eventId, rulesVersion), analysis.input.background);
        await transaction.saveAnalysis({ ...analysis, status: "confirmed", confirmedBy: actor.userId, confirmedAt: this.now(), revision: analysis.revision + 1 }, analysis.revision);
      }
      if (current?.analysisId && current.analysisId !== analysisId) {
        const prior = await transaction.getAnalysis(current.analysisId);
        if (prior) await transaction.saveAnalysis({ ...prior, status: "superseded", revision: prior.revision + 1 }, prior.revision);
      }
      const confirmation = { projectId, eventId, rulesVersion, revision: expectedRevision + 1, analysisId, confirmedBy: actor.userId, confirmedAt: this.now() };
      await transaction.saveConfirmation(confirmation, expectedRevision);
      await this.audit(transaction, "ProjectRequirementsConfirmed", projectId, confirmation.revision, actor, projectId, eventId, rulesVersion);
      return confirmation;
    });
  }
  async getProjectChanges(actor: Actor, projectId: string) {
    const current = await this.getProjectRules(actor, projectId);
    if (!current.confirmation || !current.rules) return { confirmation: null, latestVersion: null, changes: [], needsConfirmation: false };
    const event = await this.repository.getEvent(current.confirmation.eventId);
    if (!event?.publishedVersion || event.publicationStatus === "archived") return { confirmation: current.confirmation, latestVersion: null, changes: [], needsConfirmation: false, publicationUnavailable: true };
    const latest = await this.rules(this.repository, event.id, event.publishedVersion);
    return { confirmation: current.confirmation, latestVersion: latest.version, changes: diffRuleVersions(current.rules, latest), needsConfirmation: latest.version !== current.rules.version };
  }
  async saveManualAnalysis(actor: Actor, rawInput: unknown, content: unknown): Promise<EventAnalysis> {
    const input = validateAnalysisInput(rawInput);
    return this.repository.transaction(async transaction => {
      await this.membership(actor, input.projectId, true, transaction);
      const rules = await this.selectableRules(transaction, input.projectId, input.eventId, input.rulesVersion);
      const analysis = this.newAnalysis(actor, input, "manual");
      analysis.content = validateAnalysisContent(content, rules, input.background);
      await transaction.saveAnalysis(analysis, 0);
      return analysis;
    });
  }
  private newAnalysis(actor: Actor, input: AnalysisInput, origin: "manual" | "model"): EventAnalysis {
    return {
      id: this.dependencies.ids.next(), projectId: input.projectId, eventId: input.eventId,
      rulesVersion: input.rulesVersion, backgroundVersion: input.backgroundVersion,
      inputHash: analysisInputHash(input), input, content: null, status: "draft", origin,
      modelVersion: origin === "model" ? this.dependencies.model?.modelVersion ?? null : null,
      promptVersion: origin === "model" ? this.dependencies.model?.promptVersion ?? null : null,
      revision: 1, createdBy: actor.userId, createdAt: this.now(), confirmedBy: null, confirmedAt: null,
    };
  }
  async queueAnalysis(actor: Actor, rawInput: unknown, idempotencyKey: string): Promise<AnalysisRun> {
    const input = validateAnalysisInput(rawInput);
    const key = requiredText(idempotencyKey, "幂等键", 100);
    if (!this.dependencies.model) throw new DomainError("MODEL_UNAVAILABLE", "模型尚未接入，可以手工录入分析草案。", { status: 503, recoveryAction: "use_manual_analysis" });
    return this.repository.transaction(async transaction => {
      await this.membership(actor, input.projectId, true, transaction);
      const hash = analysisInputHash(input);
      const previous = await transaction.findRun(input.projectId, actor.userId, key);
      if (previous) {
        if (previous.inputHash !== hash) throw new DomainError("IDEMPOTENCY_CONFLICT", "此幂等键已用于不同输入。", { status: 409 });
        return previous;
      }
      await this.selectableRules(transaction, input.projectId, input.eventId, input.rulesVersion);
      const analysis = this.newAnalysis(actor, input, "model");
      const run: AnalysisRun = {
        id: this.dependencies.ids.next(), analysisId: analysis.id, projectId: input.projectId, actorId: actor.userId,
        idempotencyKey: key, inputHash: hash, status: "queued", attempts: 0, queuedAt: this.now(),
        startedAt: null, finishedAt: null, errorCode: null, usage: null, revision: 1,
      };
      await transaction.saveAnalysis(analysis, 0);
      await transaction.saveRun(run, 0);
      return run;
    });
  }
  async getAnalysis(actor: Actor, projectId: string, analysisId: string) {
    await this.membership(actor, projectId);
    const analysis = await this.repository.getAnalysis(analysisId);
    if (!analysis || analysis.projectId !== projectId) notFound();
    const currentBackgroundVersion = await this.dependencies.projectBackgroundVersion?.getCurrentBackgroundVersion(projectId) ?? null;
    return {
      ...analysis, rules: await this.rules(this.repository, analysis.eventId, analysis.rulesVersion),
      currentBackgroundVersion,
      backgroundFreshness: currentBackgroundVersion === null ? "unknown" as const : currentBackgroundVersion === analysis.backgroundVersion ? "current" as const : "outdated" as const,
    };
  }
  async getAnalysisRun(actor: Actor, projectId: string, runId: string) {
    await this.membership(actor, projectId);
    const run = await this.repository.getRun(runId);
    if (!run || run.projectId !== projectId) notFound();
    return run;
  }
  /** Internal root worker discovery; no ordinary HTTP endpoint exposes global jobs. */
  async listQueuedAnalysisRuns(limit = 10) { return this.listAnalysisRunMetadata("queued", limit); }
  async listRunningAnalysisRuns(limit = 10) { return this.listAnalysisRunMetadata("running", limit); }
  private async listAnalysisRunMetadata(status: "queued" | "running", limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new DomainError("INVALID_WORKER_BATCH", "任务批次必须在 1 到 50 之间。");
    if (!this.repository.listAnalysisRuns) throw new DomainError("ANALYSIS_QUEUE_UNAVAILABLE", "持久任务发现适配尚未接入。", { status: 503 });
    const runs = await this.repository.listAnalysisRuns(status, limit);
    return runs.map(run => ({ id: run.id, projectId: run.projectId, actorId: run.actorId, revision: run.revision, status: run.status, createdAt: run.queuedAt }));
  }
  async retryAnalysis(actor: Actor, projectId: string, runId: string) {
    return this.repository.transaction(async transaction => {
      await this.membership(actor, projectId, true, transaction);
      const run = await transaction.getRun(runId);
      if (!run || run.projectId !== projectId) notFound();
      if (run.status !== "failed" || !["MODEL_TIMEOUT", "MODEL_FAILED"].includes(run.errorCode ?? "") || run.attempts >= (this.dependencies.maxModelAttempts ?? 2)) throw new DomainError("RETRY_NOT_ALLOWED", "该任务不能再次重试，请补充资料或手工整理。");
      const next: AnalysisRun = { ...run, status: "queued", startedAt: null, finishedAt: null, errorCode: null, revision: run.revision + 1 };
      await transaction.saveRun(next, run.revision);
      return next;
    });
  }
  async cancelAnalysis(actor: Actor, projectId: string, runId: string) {
    return this.repository.transaction(async transaction => {
      await this.membership(actor, projectId, true, transaction);
      const run = await transaction.getRun(runId);
      if (!run || run.projectId !== projectId) notFound();
      if (run.status !== "queued" && run.status !== "running") throw new DomainError("CANCELLATION_NOT_ALLOWED", "任务已结束。");
      const next: AnalysisRun = { ...run, status: "cancelled", finishedAt: this.now(), revision: run.revision + 1 };
      await transaction.saveRun(next, run.revision);
      return next;
    });
  }
  /** Server-only worker entry point. Do not expose it as an unauthenticated HTTP route. */
  async processAnalysisRun(runId: string): Promise<AnalysisRun> {
    const model = this.dependencies.model;
    if (!model) throw new DomainError("MODEL_UNAVAILABLE", "模型尚未接入。", { status: 503 });
    const peek = await this.repository.getRun(runId);
    if (!peek) notFound();
    const claimed = await this.repository.transaction(async transaction => {
      // Use the same project lock order as queue/confirm/cancel; revoked managers
      // cannot have an old queued request disclose project inputs to the model.
      try { await this.membership({ userId: peek.actorId, platformRoles: ["user"] }, peek.projectId, true, transaction); }
      catch (error) {
        if (!(error instanceof DomainError) || !["NOT_FOUND", "PROJECT_MANAGER_REQUIRED", "PROJECT_READ_ONLY"].includes(error.code)) throw error;
        const denied = await transaction.getRun(runId);
        if (!denied) notFound();
        if (denied.status !== "queued") return { run: denied, analysis: null, rules: null };
        const failed: AnalysisRun = { ...denied, status: "failed", errorCode: error.code === "PROJECT_READ_ONLY" ? "PROJECT_READ_ONLY" : "PROJECT_ACCESS_REVOKED", finishedAt: this.now(), revision: denied.revision + 1 };
        await transaction.saveRun(failed, denied.revision);
        return { run: failed, analysis: null, rules: null };
      }
      const run = await transaction.getRun(runId);
      if (!run) notFound();
      if (run.status !== "queued") return { run, analysis: null, rules: null };
      const analysis = await transaction.getAnalysis(run.analysisId);
      if (!analysis) notFound();
      const rules = await this.rules(transaction, analysis.eventId, analysis.rulesVersion);
      const next: AnalysisRun = { ...run, status: "running", attempts: run.attempts + 1, startedAt: this.now(), revision: run.revision + 1 };
      await transaction.saveRun(next, run.revision);
      return { run: next, analysis, rules };
    });
    if (!claimed.analysis || !claimed.rules) return claimed.run;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let content: EventAnalysis["content"] = null;
    let usage: AnalysisRun["usage"] = null;
    let providerRequestId: string | null = null;
    let actualModelVersion = model.modelVersion;
    let errorCode: string | null = null;
    try {
      const result = await Promise.race([
        model.generate({ rules: claimed.rules, background: claimed.analysis.input.background }, controller.signal),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new DomainError("MODEL_TIMEOUT", "模型生成超时。")); }, this.dependencies.modelTimeoutMs ?? 30_000); }),
      ]);
      content = validateAnalysisContent(result.content, claimed.rules, claimed.analysis.input.background);
      providerRequestId = result.providerRequestId ?? null;
      actualModelVersion = result.modelVersion ?? model.modelVersion;
      if (result.usage && Number.isSafeInteger(result.usage.inputTokens) && result.usage.inputTokens >= 0 && Number.isSafeInteger(result.usage.outputTokens) && result.usage.outputTokens >= 0) usage = result.usage;
    } catch (error) {
      errorCode = modelFailureCode(error);
    } finally { if (timer) clearTimeout(timer); }
    return this.repository.transaction(async transaction => {
      let writeAccessFailure: string | null = null;
      try { await this.membership({ userId: peek.actorId, platformRoles: ["user"] }, peek.projectId, true, transaction); }
      catch (error) {
        if (!(error instanceof DomainError) || !["NOT_FOUND", "PROJECT_MANAGER_REQUIRED", "PROJECT_READ_ONLY"].includes(error.code)) throw error;
        writeAccessFailure = error.code === "PROJECT_READ_ONLY" ? "PROJECT_READ_ONLY" : "PROJECT_ACCESS_REVOKED";
      }
      const current = await transaction.getRun(runId);
      if (!current) notFound();
      if (current.status !== "running" || current.revision !== claimed.run.revision) return current;
      const analysis = await transaction.getAnalysis(current.analysisId);
      if (!analysis) notFound();
      if (writeAccessFailure) { content = null; errorCode = writeAccessFailure; }
      if (content) await transaction.saveAnalysis({ ...analysis, content, modelVersion: actualModelVersion, revision: analysis.revision + 1 }, analysis.revision);
      const finished: AnalysisRun = { ...current, status: errorCode ? "failed" : "succeeded", errorCode, usage, providerRequestId, finishedAt: this.now(), revision: current.revision + 1 };
      await transaction.saveRun(finished, current.revision);
      return finished;
    });
  }
  /** Worker recovery after a process crash; stale completion cannot overwrite it. */
  async recoverExpiredAnalysisRun(runId: string): Promise<AnalysisRun> {
    return this.repository.transaction(async transaction => {
      const run = await transaction.getRun(runId);
      if (!run) notFound();
      const expired = run.status === "running" && run.startedAt !== null
        && this.dependencies.clock.now().getTime() - Date.parse(run.startedAt) > (this.dependencies.modelTimeoutMs ?? 30_000) + 5_000;
      if (!expired) return run;
      const next: AnalysisRun = { ...run, status: "failed", errorCode: "MODEL_TIMEOUT", finishedAt: this.now(), revision: run.revision + 1 };
      await transaction.saveRun(next, run.revision);
      return next;
    });
  }
  async submitCorrection(actor: Actor, eventId: string, input: { field: string; explanation: string; sourceUrl?: string | null }) {
    authenticated(actor);
    const publicEvent = await this.getEvent(eventId);
    const field = requiredText(input.field, "字段", 100);
    const explanation = requiredText(input.explanation, "纠错说明", 3000);
    const sourceUrl = input.sourceUrl ? requiredText(input.sourceUrl, "来源链接", 2000) : null;
    if (sourceUrl) {
      let parsed: URL;
      try { parsed = new URL(sourceUrl); } catch { throw new DomainError("INVALID_URL", "来源链接无效。"); }
      if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new DomainError("INVALID_URL", "来源链接须为不含凭据的 HTTP 地址。");
    }
    const correction = { id: this.dependencies.ids.next(), eventId, rulesVersion: publicEvent.rules.version, field, explanation, sourceUrl, submittedBy: actor.userId, submittedAt: this.now(), status: "submitted" as const };
    await this.repository.transaction(async transaction => {
      await transaction.insertCorrection(correction);
      await this.audit(transaction, "EventCorrectionSubmitted", eventId, correction.rulesVersion, actor);
    });
    return correction;
  }
}
