import { createHash } from "node:crypto";
import type { Actor, Clock, IdGenerator } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import { assertPublishable, isVerifiedRuleEvidence, validateRuleVersion } from "../modules/events/domain.ts";
import type { EventRuleVersion } from "../modules/events/domain.ts";
import type { EventsRepository, EventsUnitOfWork } from "../modules/events/model.ts";
import type { EventsService } from "../modules/events/service.ts";
import { PostgresEventsRepository } from "../modules/events/postgres.ts";
import {
  CorrectionService, EventReviewService, PostgresCorrectionRepository, PostgresEventReviewRepository,
  PostgresResourceReviewRepository, PostgreSqlOperationsExecutionRepository, ResourceReviewService,
  RunService, SourceService, assertOperationsReviewer, createCorrectionHandlers, createEventReviewHandlers,
  createExecutionAdminHandlers, createOperationsHttpHandler, createResourceReviewHandlers,
  positiveRevision, requireOperationsAdmin,
} from "../modules/operations/index.ts";
import type { CandidateCriticalField, EventCandidatePublicationPort, EventCandidateSnapshot, EventReview, OperationsHttpDependencies } from "../modules/operations/index.ts";
import { createOperationsResourcePublicationAdapter } from "../modules/resources/integration.ts";
import type { ResourceService } from "../modules/resources/service.ts";
import type { ResourceInput } from "../modules/resources/domain.ts";
import type { ResourceCorrectionKind } from "../modules/resources/ports.ts";

/** Server composition only. No raw M03 review/publish handler or worker credential is exported. */
export interface OperationsIntegrationDependencies {
  database: DatabasePort;
  eventsRepository: EventsRepository;
  events: EventsService;
  resources: ResourceService;
  clock: Clock;
  ids: IdGenerator;
  executionEnabled?: boolean;
  resolveActor(request: Request): Promise<Actor | null>;
  assertMutationAllowed(request: Request, actor: Actor): Promise<void>;
}

type ExecutionHandlers = ReturnType<typeof createExecutionAdminHandlers>;
type ResourceReviewHandlers = ReturnType<typeof createResourceReviewHandlers>;
type HttpHandler = (request: Request) => Promise<Response>;
export interface OperationsIntegration {
  services: {
    source: SourceService; execution: RunService; eventReview: EventReviewService;
    resourceReview: ResourceReviewService; corrections: CorrectionService; resources: ResourceService;
  };
  handlers: {
    source: Pick<ExecutionHandlers, "listSources" | "source" | "createSource" | "reviseSource" | "transitionSource">;
    execution: Pick<ExecutionHandlers, "enqueueCrawl" | "enqueueAnalysis" | "listRuns" | "run" | "cancel" | "reclaimExpired">;
    eventReview: ReturnType<typeof createEventReviewHandlers>;
    resourceReview: ResourceReviewHandlers & {
      createDraft: HttpHandler; draft(id: string): HttpHandler;
      reviseDraft(id: string): HttpHandler; requestReview(id: string): HttpHandler;
    };
    corrections: ReturnType<typeof createCorrectionHandlers>;
  };
  availability: { worker: "enabled" | "disabled"; enqueue: "enabled" | "disabled"; reason: string | null };
  submitResourceCorrection(actor: Actor, input: { resourceId: string; kind: ResourceCorrectionKind; note: string }): Promise<{ id: string }>;
  /** Segments are relative to /api/v1. A known path with the wrong verb still returns its 405 guard. */
  resolveRoute(method: string, segments: readonly string[]): HttpHandler | null;
}

interface CandidateMetadata {
  id: string; event_id: string; revision: number; rules_version: number; content_hash: string;
  schema_version: string; created_by: string; last_modified_by: string; origin: "manual" | "worker";
  created_at: string | Date; updated_at: string | Date; published_version: number | null;
}
const schemaVersion = "m03.rules.v1";
function conflict(revision: number): never {
  throw new DomainError("VERSION_CONFLICT", "候选或公开版本已更新，请重新核验。", { status: 409, latestRevision: revision, recoveryAction: "review_latest_version" });
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const contentHash = (rules: EventRuleVersion): string => createHash("sha256").update(canonical(rules)).digest("hex");

/** Public repositories are scoped to the caller's executor; transaction() never commits here. */
function transactionDatabase(tx: SqlExecutor): DatabasePort {
  return { query: (sql, values) => tx.query(sql, values), transaction: work => work(tx) };
}
function withEvents<T>(tx: SqlExecutor, work: (unit: EventsUnitOfWork) => Promise<T>): Promise<T> {
  return new PostgresEventsRepository(transactionDatabase(tx)).transaction(work);
}
async function metadata(tx: SqlExecutor, id: string): Promise<CandidateMetadata | null> {
  const result = await tx.query<CandidateMetadata>("SELECT * FROM integration_event_candidates WHERE id=$1 FOR UPDATE", [id]);
  return result.rows[0] ?? null;
}
async function rememberRevision(tx: SqlExecutor, id: string): Promise<void> {
  await tx.query(`INSERT INTO integration_event_candidate_revisions
    (candidate_id,revision,event_id,rules_version,content_hash,schema_version,created_by,last_modified_by,origin,changed_at)
    SELECT id,revision,event_id,rules_version,content_hash,schema_version,created_by,last_modified_by,origin,updated_at
    FROM integration_event_candidates WHERE id=$1`, [id]);
}
async function rememberPublication(tx: SqlExecutor, kind: "event" | "resource", id: string, version: number, at: string, reviewId: string): Promise<void> {
  await tx.query("INSERT INTO integration_public_versions(kind,entity_id,version,published_at,review_id) VALUES($1,$2,$3,$4::timestamptz,$5) ON CONFLICT(kind,entity_id,version) DO NOTHING", [kind, id, version, at, reviewId]);
}

function prepareRules(content: unknown, eventId: string, version: number, actor: Actor, now: string): EventRuleVersion {
  if (!content || typeof content !== "object" || Array.isArray(content)) throw new DomainError("INVALID_RULE_VERSION", "请提供完整赛事规则对象。");
  const input = content as Record<string, unknown>;
  if (input.eventId !== undefined && input.eventId !== eventId) throw new DomainError("INVALID_RULE_VERSION", "规则不能切换赛事归属。");
  // Validate original cross-references before rebinding the next immutable M03 version.
  const original = validateRuleVersion({ ...input, eventId, version: input.version ?? version, createdAt: input.createdAt ?? now });
  return validateRuleVersion({ ...original, version, createdAt: now,
    sources: original.sources.map(source => ({ ...source, version })),
    evidence: original.evidence.map(evidence => ({ ...evidence, version,
      // A manual editor attests the explicitly marked checks as the trusted session actor.
      verifiedBy: evidence.verifiedBy === null ? null : actor.userId,
      verifiedAt: evidence.verifiedAt === null ? null : now,
    })),
  });
}

function criticalFields(rules: EventRuleVersion): CandidateCriticalField[] {
  const field = (key: CandidateCriticalField["key"], known: boolean, ids: string[], summary: string, conflicted = false): CandidateCriticalField => ({
    key, state: conflicted ? "conflict" : known ? "known" : "unknown", evidenceIds: [...new Set(ids)], summary,
  });
  const factField = (key: "eligibility" | "fees", keys: string[]) => {
    const facts = rules.facts.filter(fact => keys.includes(fact.key));
    return field(key, facts.length === keys.length && facts.every(fact => fact.status === "verified"), facts.flatMap(fact => fact.evidenceIds),
      facts.map(fact => `${fact.key}：${fact.statement}（${fact.status}）`).join("；") || "未说明",
      facts.some(fact => fact.status === "conflicted"));
  };
  const dates = rules.stages.flatMap(stage => [stage.startsAt, stage.endsAt]);
  const dateIds = dates.flatMap(date => date?.evidenceIds ?? []);
  const datesKnown = rules.stages.length > 0 && dates.every(date => date?.utc && date.evidenceIds.length > 0 && date.evidenceIds.every(id => isVerifiedRuleEvidence(rules, id)));
  const requirements = rules.requirements;
  const deliverableIds = requirements.flatMap(requirement => requirement.evidenceIds);
  const submissionStages = rules.stages.filter(stage => stage.stageType === "submission");
  const submissionEvidence = submissionStages.flatMap(stage => rules.evidence.filter(evidence =>
    ["submission", "submission_method", "submission_url", `${stage.id}.submissionUrl`, `stages.${stage.id}.submissionUrl`].includes(evidence.fieldKey) &&
    stage.submissionUrl !== null && evidence.excerpt.includes(stage.submissionUrl) && isVerifiedRuleEvidence(rules, evidence.id)).map(evidence => evidence.id));
  const submissionKnown = submissionStages.length > 0 && submissionStages.every(stage => stage.submissionUrl && rules.evidence.some(evidence =>
    submissionEvidence.includes(evidence.id) && evidence.excerpt.includes(stage.submissionUrl!)));
  return [
    factField("eligibility", ["eligibility", "team_size", "ai_policy"]),
    field("deadlines", datesKnown, dateIds, rules.stages.map(stage => `${stage.name}：${stage.startsAt?.rawText ?? "开始时间未说明"} → ${stage.endsAt?.rawText ?? "截止未说明"}`).join("；") || "日期未说明"),
    factField("fees", ["fees"]),
    field("deliverables", requirements.length > 0 && requirements.every(requirement => requirement.necessity !== "unknown" && requirement.evidenceIds.length > 0 && requirement.evidenceIds.every(id => isVerifiedRuleEvidence(rules, id))), deliverableIds,
      requirements.map(requirement => `${requirement.label}（${requirement.necessity}）`).join("；") || "材料未说明"),
    field("submission", submissionKnown, submissionEvidence, submissionStages.map(stage => `${stage.name}：${stage.submissionUrl ?? "链接未说明"}${submissionKnown ? "" : "（提交方式尚未核验）"}`).join("；") || "提交方式未说明"),
  ];
}

export function createEventCandidateAdapter(deps: OperationsIntegrationDependencies): EventCandidatePublicationPort {
  const now = () => deps.clock.now().toISOString();
  async function snapshot(tx: SqlExecutor, meta: CandidateMetadata): Promise<EventCandidateSnapshot> {
    return withEvents(tx, async unit => {
      const event = await unit.getEvent(meta.event_id);
      const rules = await unit.getRules(meta.event_id, meta.rules_version);
      if (!event || !rules) throw new DomainError("NOT_FOUND", "候选对应的规则不存在。", { status: 404 });
      if (contentHash(rules) !== meta.content_hash) throw new DomainError("CANDIDATE_INTEGRITY_ERROR", "候选哈希与规则快照不一致。", { status: 503 });
      const validationErrors: string[] = [];
      try { assertPublishable(rules); } catch (error) { if (!(error instanceof DomainError)) throw error; validationErrors.push(error.message); }
      if (rules.evidence.some(evidence => evidence.conflictsWith.length > 0) || rules.facts.some(fact => fact.status === "conflicted")) validationErrors.push("来源证据存在冲突，需修正后重新审核。");
      if (event.candidateVersion !== meta.rules_version) validationErrors.push("已有更新候选，请核验最新版本。");
      if (event.publicationStatus === "archived") validationErrors.push("赛事已撤下，恢复流程尚未开放。");
      const published = event.publishedVersion === null ? null : await unit.getRules(event.id, event.publishedVersion);
      return { eventId: meta.event_id, candidateId: meta.id, revision: meta.revision, contentHash: meta.content_hash,
        schemaVersion: meta.schema_version, createdBy: meta.created_by, lastModifiedBy: meta.last_modified_by, origin: meta.origin,
        validationErrors, criticalFields: criticalFields(rules), currentPublishedVersion: event.publishedVersion,
        currentPublishedCriticalFields: published ? criticalFields(published) : null };
    });
  }
  async function review(tx: SqlExecutor, id: string): Promise<EventReview | null> {
    return new PostgresEventReviewRepository(transactionDatabase(tx)).transaction(unit => unit.getReview(id));
  }
  return {
    async createManualCandidate(tx, input) {
      assertOperationsReviewer(input.actor);
      const payloadId = input.content && typeof input.content === "object" && !Array.isArray(input.content) ? (input.content as Record<string, unknown>).eventId : undefined;
      const eventId = input.eventId ?? (typeof payloadId === "string" ? payloadId : deps.ids.next());
      const candidateId = deps.ids.next();
      return withEvents(tx, async unit => {
        const current = await unit.getEvent(eventId);
        if (current?.publicationStatus === "archived") throw new DomainError("EVENT_ARCHIVED", "撤下赛事尚不支持直接恢复。", { status: 409 });
        const at = now();
        const rules = prepareRules(input.content, eventId, (current?.candidateVersion ?? 0) + 1, input.actor, at);
        await unit.insertRules(rules);
        await unit.saveEvent({ id: eventId, revision: (current?.revision ?? 0) + 1, publicationStatus: "pending_review", candidateVersion: rules.version,
          publishedVersion: current?.publishedVersion ?? null, lastVerifiedAt: current?.lastVerifiedAt ?? null }, current?.revision ?? 0);
        await tx.query(`INSERT INTO integration_event_candidates(id,event_id,revision,rules_version,content_hash,schema_version,created_by,last_modified_by,origin,created_at,updated_at)
          VALUES($1,$2,1,$3,$4,$5,$6,$6,'manual',$7::timestamptz,$7::timestamptz)`, [candidateId, eventId, rules.version, contentHash(rules), schemaVersion, input.actor.userId, at]);
        await rememberRevision(tx, candidateId);
        return snapshot(tx, (await metadata(tx, candidateId))!);
      });
    },
    async getCandidate(tx, id) { const meta = await metadata(tx, id); return meta ? snapshot(tx, meta) : null; },
    async reviseManualCandidate(tx, input) {
      assertOperationsReviewer(input.actor);
      const meta = await metadata(tx, input.candidateId);
      if (!meta) throw new DomainError("NOT_FOUND", "候选不存在。", { status: 404 });
      if (meta.revision !== input.expectedRevision) conflict(meta.revision);
      if (meta.published_version !== null || meta.origin !== "manual") throw new DomainError("INVALID_STATE", "已发布或 worker 候选不可原地改写，请新建人工候选。", { status: 409 });
      return withEvents(tx, async unit => {
        const current = await unit.getEvent(meta.event_id);
        if (!current || current.candidateVersion !== meta.rules_version || current.publicationStatus === "archived") conflict(meta.revision);
        const at = now(); const rules = prepareRules(input.content, meta.event_id, current.candidateVersion + 1, input.actor, at);
        await unit.insertRules(rules);
        await unit.saveEvent({ ...current, revision: current.revision + 1, publicationStatus: "pending_review", candidateVersion: rules.version }, current.revision);
        const result = await tx.query("UPDATE integration_event_candidates SET revision=revision+1,rules_version=$2,content_hash=$3,last_modified_by=$4,updated_at=$5::timestamptz WHERE id=$1 AND revision=$6 AND published_version IS NULL", [meta.id, rules.version, contentHash(rules), input.actor.userId, at, meta.revision]);
        if (result.rowCount !== 1) conflict(meta.revision);
        await rememberRevision(tx, meta.id);
        return snapshot(tx, (await metadata(tx, meta.id))!);
      });
    },
    async publishCandidate(tx, input) {
      assertOperationsReviewer(input.actor);
      const meta = await metadata(tx, input.candidateId);
      if (!meta) throw new DomainError("NOT_FOUND", "候选不存在。", { status: 404 });
      if (meta.revision !== input.expectedRevision || meta.content_hash !== input.expectedContentHash || meta.published_version !== null) conflict(meta.revision);
      // Verify the real M08 approval again at the publication boundary, in this exact transaction.
      const approval = await review(tx, input.reviewId);
      if (!approval || approval.status !== "approved" || !approval.reviewedBy || approval.reviewedAt !== input.reviewedAt || approval.eventId !== meta.event_id || approval.candidateId !== meta.id || approval.candidateRevision !== meta.revision || approval.contentHash !== meta.content_hash || approval.schemaVersion !== meta.schema_version) throw new DomainError("REVIEW_REQUIRED", "发布必须绑定当前候选的真实人工审核。", { status: 409 });
      const candidate = await snapshot(tx, meta);
      if (candidate.validationErrors.length) throw new DomainError("CANDIDATE_INVALID", "请先修正候选和证据。");
      if (candidate.currentPublishedVersion !== input.expectedPublishedVersion) conflict(candidate.currentPublishedVersion ?? 0);
      return withEvents(tx, async unit => {
        const current = (await unit.getEvent(meta.event_id))!;
        if (current.candidateVersion !== meta.rules_version || current.publishedVersion !== input.expectedPublishedVersion || current.publicationStatus === "archived") conflict(current.revision);
        const rules = (await unit.getRules(meta.event_id, meta.rules_version))!; assertPublishable(rules);
        const at = now();
        await unit.saveEvent({ ...current, revision: current.revision + 1, publicationStatus: "published", publishedVersion: meta.rules_version, lastVerifiedAt: at }, current.revision);
        await tx.query("UPDATE integration_event_candidates SET published_version=$2 WHERE id=$1 AND published_version IS NULL", [meta.id, meta.rules_version]);
        await rememberPublication(tx, "event", meta.event_id, meta.rules_version, at, approval.id);
        await unit.appendAudit({ id: deps.ids.next(), type: current.publishedVersion === null ? "EventPublished" : "EventRulesChanged", aggregateId: meta.event_id, projectId: null,
          version: meta.rules_version, actorId: input.actor.userId, occurredAt: at, rulesEventId: meta.event_id, rulesVersion: meta.rules_version });
        return { eventId: meta.event_id, publishedVersion: meta.rules_version };
      });
    },
    async withdrawEvent(tx, input) {
      assertOperationsReviewer(input.actor);
      return withEvents(tx, async unit => {
        const event = await unit.getEvent(input.eventId);
        if (!event || event.publishedVersion === null) throw new DomainError("NOT_FOUND", "公开赛事不存在。", { status: 404 });
        if (event.publishedVersion !== input.expectedPublishedVersion) conflict(event.revision);
        if (event.publicationStatus === "archived") throw new DomainError("INVALID_STATE", "赛事已撤下。", { status: 409 });
        await unit.saveEvent({ ...event, revision: event.revision + 1, publicationStatus: "archived" }, event.revision);
        await unit.appendAudit({ id: deps.ids.next(), type: "EventRulesChanged", aggregateId: event.id, projectId: null, version: event.publishedVersion,
          actorId: input.actor.userId, occurredAt: now(), rulesEventId: event.id, rulesVersion: event.publishedVersion });
        return { eventId: event.id, publishedVersion: event.publishedVersion };
      });
    },
  };
}

class DisabledExecutionService extends RunService {
  private unavailable(actor: Actor): never {
    requireOperationsAdmin(actor);
    throw new DomainError("WORKER_UNAVAILABLE", "采集服务凭据尚未配置，暂不能发起执行。", { status: 503, recoveryAction: "configure_isolated_worker" });
  }
  override async enqueueCrawl(...args: Parameters<RunService["enqueueCrawl"]>): ReturnType<RunService["enqueueCrawl"]> { return this.unavailable(args[0]); }
  override async enqueueAnalysis(...args: Parameters<RunService["enqueueAnalysis"]>): ReturnType<RunService["enqueueAnalysis"]> { return this.unavailable(args[0]); }
}

export function createOperationsIntegration(deps: OperationsIntegrationDependencies): OperationsIntegration {
  const executionRepository = new PostgreSqlOperationsExecutionRepository(deps.database);
  const source = new SourceService({ repository: executionRepository, clock: deps.clock, ids: deps.ids });
  const execution = deps.executionEnabled ? new RunService({ repository: executionRepository, clock: deps.clock, ids: deps.ids }) : new DisabledExecutionService({ repository: executionRepository, clock: deps.clock, ids: deps.ids });
  const eventReview = new EventReviewService({ repository: new PostgresEventReviewRepository(deps.database), events: createEventCandidateAdapter(deps), clock: deps.clock, ids: deps.ids });
  const resourceAdapter = createOperationsResourcePublicationAdapter({ clock: deps.clock, ids: deps.ids,
    readReview: (tx, id) => new PostgresResourceReviewRepository(transactionDatabase(tx)).transaction(unit => unit.getReview(id)),
  });
  const resourceReview = new ResourceReviewService({ repository: new PostgresResourceReviewRepository(deps.database), clock: deps.clock, ids: deps.ids,
    resources: { ...resourceAdapter, async publishReviewed(tx, input) {
      const result = await resourceAdapter.publishReviewed(tx, input);
      await rememberPublication(tx, "resource", result.resourceId, result.publishedVersion, input.reviewedAt, input.reviewOperationId);
      return result;
    } },
  });
  const corrections = new CorrectionService({ repository: new PostgresCorrectionRepository(deps.database), clock: deps.clock, ids: deps.ids,
    targets: { async isPublicVersion(tx, target) {
      const publicVersion = await tx.query("SELECT 1 FROM integration_public_versions WHERE kind=$1 AND entity_id=$2 AND version=$3", [target.kind, target.entityId, target.version]);
      if (publicVersion.rows.length > 0) return true;
      // Compatibility for a legacy published/withdrawn current M03 pointer, never an arbitrary draft.
      if (target.kind === "event") return withEvents(tx, async unit => {
        const event = await unit.getEvent(target.entityId);
        return event?.publishedVersion === target.version && !!await unit.getRules(target.entityId, target.version);
      });
      return false;
    } },
  });
  const http: OperationsHttpDependencies = { resolveActor: deps.resolveActor, assertMutationAllowed: deps.assertMutationAllowed, requestId: () => deps.ids.next() };
  const admin = createExecutionAdminHandlers({ ...http, sources: source, runs: execution });
  const resources = deps.resources;
  const eventEvidence = (id: string): HttpHandler => createOperationsHttpHandler(http, { method: "GET", execute: actor => deps.database.transaction(async transaction => {
    const detail = await eventReview.getDetail(actor, id);
    const candidate = await metadata(transaction, detail.review.candidateId);
    if (!candidate || candidate.revision !== detail.candidate.revision || candidate.content_hash !== detail.candidate.contentHash) throw new DomainError("VERSION_CONFLICT", "候选依据已变化，请刷新审核。", { status: 409 });
    const rules = await withEvents(transaction, unit => unit.getRules(candidate.event_id, candidate.rules_version));
    if (!rules || contentHash(rules) !== candidate.content_hash) throw new DomainError("CANDIDATE_INTEGRITY_ERROR", "候选原文与审核版本不一致。", { status: 503 });
    return { reviewId: id, candidateRevision: candidate.revision, contentHash: candidate.content_hash, rules };
  }) });
  const resourceHandler = (method: "GET" | "POST" | "PATCH", execute: (actor: Actor, input: Record<string, unknown>) => Promise<unknown>, status?: number): HttpHandler => createOperationsHttpHandler(http, { method, execute, successStatus: status });
  const resourceContent = (input: Record<string, unknown>): ResourceInput => {
    if (!input.content || typeof input.content !== "object" || Array.isArray(input.content)) throw new DomainError("INVALID_RESOURCE_INPUT", "请提供完整资源内容。");
    return input.content as ResourceInput;
  };
  const integration: OperationsIntegration = {
    services: { source, execution, eventReview, resourceReview, corrections, resources },
    handlers: {
      source: { listSources: admin.listSources, source: admin.source, createSource: admin.createSource, reviseSource: admin.reviseSource, transitionSource: admin.transitionSource },
      execution: { enqueueCrawl: admin.enqueueCrawl, enqueueAnalysis: admin.enqueueAnalysis, listRuns: admin.listRuns, run: admin.run, cancel: admin.cancel, reclaimExpired: admin.reclaimExpired },
      eventReview: createEventReviewHandlers({ ...http, service: eventReview }),
      resourceReview: { ...createResourceReviewHandlers({ ...http, service: resourceReview }),
        createDraft: resourceHandler("POST", (actor, input) => resources.createDraft(actor, resourceContent(input)), 201),
        draft: id => resourceHandler("GET", actor => resources.getDraft(actor, id)),
        reviseDraft: id => resourceHandler("PATCH", (actor, input) => resources.updateDraft(actor, id, positiveRevision(input, "expectedRevision"), resourceContent(input))),
        requestReview: id => resourceHandler("POST", (actor, input) => deps.database.transaction(async () => {
          const resource = await resources.requestReview(actor, id, positiveRevision(input, "expectedRevision"));
          const review = await resourceReview.register(actor, { resourceId: id, expectedResourceRevision: resource.revision }, deps.ids.next());
          return { resource, review };
        })),
      },
      corrections: createCorrectionHandlers({ ...http, service: corrections }),
    },
    availability: { worker: deps.executionEnabled ? "enabled" : "disabled", enqueue: deps.executionEnabled ? "enabled" : "disabled", reason: deps.executionEnabled ? null : "worker_credentials_unconfigured" },
    async submitResourceCorrection(actor, input) {
      const resource = await resources.detail(input.resourceId);
      const correction = await corrections.submit(actor, { target: { kind: "resource", entityId: resource.id, version: resource.version }, field: input.kind, message: input.note });
      return { id: correction.id };
    },
    resolveRoute(method, segments) {
      const path = segments.join("/");
      const h = integration.handlers;
      const routes: { pattern: RegExp; methods: (match: RegExpMatchArray) => Record<string, HttpHandler> }[] = [
        { pattern: /^admin\/sources$/, methods: () => ({ GET: h.source.listSources, POST: h.source.createSource }) },
        { pattern: /^admin\/sources\/([^/]+)$/, methods: m => ({ GET: h.source.source(m[1]), PATCH: h.source.reviseSource(m[1]) }) },
        { pattern: /^admin\/sources\/([^/]+)\/status$/, methods: m => ({ POST: h.source.transitionSource(m[1]) }) },
        { pattern: /^admin\/sources\/([^/]+)\/crawl$/, methods: m => ({ POST: h.execution.enqueueCrawl(m[1]) }) },
        { pattern: /^admin\/execution-runs$/, methods: () => ({ GET: h.execution.listRuns }) },
        { pattern: /^admin\/execution-runs\/reclaim-expired$/, methods: () => ({ POST: h.execution.reclaimExpired }) },
        { pattern: /^admin\/(?:analysis-runs|execution-runs\/analysis)$/, methods: () => ({ POST: h.execution.enqueueAnalysis }) },
        { pattern: /^admin\/execution-runs\/([^/]+)$/, methods: m => ({ GET: h.execution.run(m[1]) }) },
        { pattern: /^admin\/execution-runs\/([^/]+)\/cancel$/, methods: m => ({ POST: h.execution.cancel(m[1]) }) },
        { pattern: /^admin\/event-reviews$/, methods: () => ({ GET: h.eventReview.list, POST: h.eventReview.submitManual }) },
        { pattern: /^admin\/event-reviews\/register$/, methods: () => ({ POST: h.eventReview.registerCandidate }) },
        { pattern: /^admin\/event-reviews\/([^/]+)$/, methods: m => ({ GET: h.eventReview.detail(m[1]), PATCH: h.eventReview.revise(m[1]) }) },
        { pattern: /^admin\/event-reviews\/([^/]+)\/evidence$/, methods: m => ({ GET: eventEvidence(m[1]) }) },
        { pattern: /^admin\/event-reviews\/([^/]+)\/(refresh|approve|decide|publish)$/, methods: m => ({ POST: h.eventReview[m[2] as "refresh" | "approve" | "decide" | "publish"](m[1]) }) },
        { pattern: /^admin\/events\/([^/]+)\/withdraw$/, methods: m => ({ POST: h.eventReview.withdraw(m[1]) }) },
        { pattern: /^admin\/resources$/, methods: () => ({ POST: h.resourceReview.createDraft }) },
        { pattern: /^admin\/resources\/([^/]+)$/, methods: m => ({ GET: h.resourceReview.draft(m[1]), PATCH: h.resourceReview.reviseDraft(m[1]) }) },
        { pattern: /^admin\/resources\/([^/]+)\/request-review$/, methods: m => ({ POST: h.resourceReview.requestReview(m[1]) }) },
        { pattern: /^admin\/resources\/([^/]+)\/register$/, methods: m => ({ POST: h.resourceReview.register(m[1]) }) },
        { pattern: /^admin\/resources\/([^/]+)\/withdraw$/, methods: m => ({ POST: h.resourceReview.withdraw(m[1]) }) },
        { pattern: /^admin\/resource-reviews$/, methods: () => ({ GET: h.resourceReview.list }) },
        { pattern: /^admin\/resource-reviews\/([^/]+)$/, methods: m => ({ GET: h.resourceReview.detail(m[1]) }) },
        { pattern: /^admin\/resource-reviews\/([^/]+)\/(decide|publish)$/, methods: m => ({ POST: h.resourceReview[m[2] as "decide" | "publish"](m[1]) }) },
        { pattern: /^corrections$/, methods: () => ({ POST: h.corrections.submit }) },
        { pattern: /^me\/corrections$/, methods: () => ({ GET: h.corrections.listOwn }) },
        { pattern: /^me\/corrections\/([^/]+)$/, methods: m => ({ GET: h.corrections.getOwn(m[1]) }) },
        { pattern: /^admin\/corrections$/, methods: () => ({ GET: h.corrections.listQueue }) },
        { pattern: /^admin\/corrections\/([^/]+)$/, methods: m => ({ GET: h.corrections.getForReview(m[1]), PATCH: h.corrections.process(m[1]) }) },
      ];
      for (const route of routes) {
        const match = path.match(route.pattern);
        if (match) { const methods = route.methods(match); return methods[method] ?? Object.values(methods)[0]; }
      }
      return null;
    },
  };
  return integration;
}
