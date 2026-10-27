import { createHash } from "node:crypto";
import type { Actor, Clock } from "../shared/contracts.ts";
import type { DatabasePort } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import type { ApplicationConfig } from "./config.ts";
import { aiServiceSettings } from "./config.ts";
import { OFFICIAL_EVENT_SOURCES } from "../modules/operations/index.ts";
import type { AiBudgetPolicy } from "./ai-jobs.ts";
import type { DiscoveryCoverageSummary } from "./discovery-coverage.ts";

export type BackendAiStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export type BackendSourceStatus = "queued" | "running" | "review_ready" | "succeeded" | "failed" | "cancelled";
export type BackendDomainKind = "m03_analysis" | "m04_scoring" | "assignment_suggestion" | "m05_planning" | "m07_retrospective" | "m04_role_help";
export interface BackendTask { id: string; kind: string; status: string; errorCode: string | null; updatedAt: string }
export interface BackendBudgetPolicy {
  scope: "project" | "project_or_user" | "source";
  dailyCallLimit: number;
  dailyBudgetMicroUsd: string | null;
  pricingConfigured: boolean;
}
export interface BackendDiscoveryState {
  revision: number; paused: boolean; quotaDay: string; currency: "USD" | "CNY";
  searchCalls: number; modelCalls: number; estimatedCostMicros: string; includesReservation: boolean;
  nextEligibleAt: string | null; leaseExpiresAt: string | null; lastCompletedAt: string | null; lastErrorCode: string | null;
}
export interface BackendUrlResult {
  id: string; host: string | null; status: "pending" | "completed" | "failed" | "needs_review";
  errorCode: string | null; lastAttemptAt: string; lastCompletedAt: string | null;
}
/** Inventory is all-time/current state; aiBudget alone is the current UTC day. */
export interface BackendDashboard {
  generatedAt: string; quotaDay: string; quotaTimezone: "UTC";
  services: { id: "database" | "mail" | "generic_ai" | "dsh" | "search" | "github"; configured: boolean; connectivity: "reachable" | "not_checked" }[];
  workers: { kind: "ai" | "source" | "discovery" | "inspiration" | "planning-notifications" | "github-maintenance" | "retention-maintenance" | "resource-links" | "organizer-notifications"; configured: boolean; status: "not_started" | "idle" | "running" | "failed" | "stopped" | "stale"; lastSeenAt: string | null; lastCompletedAt: string | null; errorCode: string | null; ageMs: number | null; staleAfterMs: 120000 }[];
  queues: {
    ai: { counts: Record<BackendAiStatus, number>; total: number; recent: BackendTask[] };
    sourceRuns: { counts: Record<BackendSourceStatus, number>; total: number; recent: BackendTask[] };
    domainWaiting: { totalQueued: number; totalRunning: number; byKind: { kind: BackendDomainKind; queued: number; running: number }[] };
  };
  aiBudget: {
    currency: "USD"; amountUnit: "micro_usd"; quotaTimezone: "UTC";
    calls: number; attempts: number; pendingAttempts: number; unknownFeeAttempts: number; unverifiedUsageAttempts: number;
    knownChargedMicroUsd: string; knownReservedMicroUsd: string; knownTotalMicroUsd: string;
    /** Null whenever unpriced usage, outstanding reservations or uncertain billed usage prevent a complete actual total. */
    completeTotalMicroUsd: string | null; includesEstimates: boolean;
  };
  /** Each policy applies to ONE scope; global usage must not be divided by these caps. */
  budgetPolicies: { genericAi: BackendBudgetPolicy | null; dshProjects: BackendBudgetPolicy | null; dshSources: BackendBudgetPolicy | null };
  discovery: {
    configured: boolean; phase: "not_started" | "paused" | "running" | "stale" | "waiting" | "ready" | "limited" | "attention";
    provider: "brave" | "official_sources" | "dsh_native" | null; sources: { name: string; url: string }[];
    /** Counts belong to this state's quotaDay, which can be older than the dashboard day. */
    state: BackendDiscoveryState | null; minimumIntervalMs: number | null;
    limits: { maxSearchCallsPerDay: number; maxModelCallsPerDay: number; maxEstimatedCostMicrosPerDay: string; currency: "USD" | "CNY" } | null;
    cards: { active: number; withdrawn: number }; recentUrls: BackendUrlResult[];
    coverage?: DiscoveryCoverageSummary | null;
  };
  inspiration: {
    configured: boolean; phase: BackendDashboard["discovery"]["phase"] | "limited" | "attention";
    state: BackendDiscoveryState | null; minimumIntervalMs: number | null;
    limits: BackendDashboard["discovery"]["limits"]; cards: number;
  };
  reviews: { events: Record<string, number>; resources: Record<string, number>; corrections: Record<string, number> };
}

const aiStatuses: readonly BackendAiStatus[] = ["queued", "running", "succeeded", "failed", "cancelled", "unknown"];
const sourceStatuses: readonly BackendSourceStatus[] = ["queued", "running", "review_ready", "succeeded", "failed", "cancelled"];
const aiKinds: readonly string[] = ["m03_analysis", "m04_scoring", "assignment_suggestion", "m05_planning", "m07_retrospective", "m04_role_help", "navigator", "source"];
const reviewStatuses = ["pending", "changes_requested", "approved", "rejected", "published"] as const;
const correctionStatuses = ["received", "triaging", "confirmed", "needs_more_info", "dismissed", "resolved"] as const;
const sourceFailures = ["timeout", "network_error", "rate_limited", "provider_unavailable", "worker_lost", "access_denied", "invalid_input", "parse_error", "schema_invalid", "source_changed"];
const countProjection = (table: string, where = "") => `(SELECT COALESCE(jsonb_object_agg(status,n),'{}'::jsonb) FROM (SELECT status,count(*)::text n FROM ${table} ${where} GROUP BY status) counts)`;
const recentProjection = (query: string) => `(SELECT COALESCE(jsonb_agg(to_jsonb(recent)),'[]'::jsonb) FROM (${query}) recent)`;
// All names and clauses below are repository constants. Values use parameters.
// A single statement gives all aggregates one PostgreSQL snapshot after the
// account row has been locked; no scheduler readState/ensure or writes occur.
const snapshotSql = `WITH domain_waiting AS (
  SELECT 'm03_analysis'::text kind,(count(*) FILTER(WHERE body->>'status'='queued'))::text queued,(count(*) FILTER(WHERE body->>'status'='running'))::text running FROM m03_analysis_runs
  UNION ALL SELECT 'm04_scoring',(count(*) FILTER(WHERE status='queued'))::text,(count(*) FILTER(WHERE status='running'))::text FROM assessments_scoring_jobs
  UNION ALL SELECT 'assignment_suggestion',(count(*) FILTER(WHERE status='queued'))::text,(count(*) FILTER(WHERE status='running'))::text FROM assessments_assignment_jobs
  UNION ALL SELECT 'm05_planning',(count(*) FILTER(WHERE status='queued'))::text,(count(*) FILTER(WHERE status='running'))::text FROM planning_generation_jobs
  UNION ALL SELECT 'm07_retrospective',(count(*) FILTER(WHERE body->>'status'='queued'))::text,(count(*) FILTER(WHERE body->>'status'='running'))::text FROM m07_documents WHERE kind='generation_job'
  UNION ALL SELECT 'm04_role_help',(count(*) FILTER(WHERE status='queued'))::text,(count(*) FILTER(WHERE status='running'))::text FROM assessments_role_help_jobs
), daily_attempts AS (
  SELECT count(*)::text attempts,(count(*) FILTER(WHERE status='reserved'))::text pending,
    (count(*) FILTER(WHERE NOT cost_configured))::text unknown_fee,
    (count(*) FILTER(WHERE cost_configured AND status='settled' AND NOT usage_verified AND external_state IN ('response_received','unknown')))::text unverified
  FROM ai_usage_attempts WHERE period=$1::date
), daily_buckets AS (
  SELECT COALESCE(sum(calls),0)::text calls,COALESCE(sum(charged_micro_usd),0)::text charged,COALESCE(sum(reserved_micro_usd),0)::text reserved
  FROM ai_budget_buckets WHERE period=$1::date
)
SELECT
  ${countProjection("ai_execution_jobs")} ai_counts,
  ${recentProjection("SELECT id,kind,status,error_code,updated_at FROM ai_execution_jobs ORDER BY updated_at DESC,id DESC LIMIT 12")} ai_recent,
  ${countProjection("operations_execution_runs")} source_counts,
  ${recentProjection("SELECT id,kind,status,((data->'failures')-> -1 ->> 'category') error_code,updated_at FROM operations_execution_runs ORDER BY updated_at DESC,id DESC LIMIT 12")} source_recent,
  (SELECT jsonb_agg(to_jsonb(domain_waiting)) FROM domain_waiting) domain_waiting,
  (SELECT to_jsonb(daily_attempts) FROM daily_attempts) daily_attempts,
  (SELECT to_jsonb(daily_buckets) FROM daily_buckets) daily_buckets,
  ${recentProjection("SELECT DISTINCT ON(kind) kind,status,last_seen_at,last_completed_at,error_code FROM backend_worker_heartbeats ORDER BY kind,(status<>'stopped' AND last_seen_at>=$2::timestamptz-interval '120 seconds') DESC,last_seen_at DESC,worker_id DESC")} workers,
  (SELECT jsonb_build_object('revision',revision,'paused',paused,'quota_day',quota_day,'currency',currency,'search_calls',search_calls,'model_calls',model_calls,'estimated_cost_micros',estimated_cost_micros::text,'includes_reservation',reservation IS NOT NULL,'next_eligible_at',next_eligible_at,'lease_expires_at',lease_expires_at,'last_completed_at',last_completed_at,'last_error_code',last_error_code) FROM operations_discovery_state WHERE id='event-discovery') discovery_state,
  (SELECT jsonb_build_object('revision',revision,'paused',paused,'quota_day',quota_day,'currency',currency,'search_calls',search_calls,'model_calls',model_calls,'estimated_cost_micros',estimated_cost_micros::text,'includes_reservation',reservation IS NOT NULL,'next_eligible_at',next_eligible_at,'lease_expires_at',lease_expires_at,'last_completed_at',last_completed_at,'last_error_code',last_error_code) FROM operations_discovery_state WHERE id='inspiration-catalog') inspiration_state,
  (SELECT count(*)::text FROM inspiration_cards) inspiration_cards,
  (SELECT to_jsonb(c) FROM operations_discovery_coverage c WHERE scheduler_id='event-discovery' AND quota_day=$1::text) discovery_coverage,
  ${countProjection("event_discovery_cards")} cards,
  ${recentProjection("SELECT canonical_url,last_attempt_at,last_completed_at,last_error_code FROM operations_discovery_urls WHERE scheduler_id='event-discovery' ORDER BY last_attempt_at DESC,canonical_url LIMIT 12")} urls,
  ${countProjection("operations_event_reviews")} event_reviews,
  ${countProjection("operations_resource_reviews")} resource_reviews,
  ${countProjection("operations_corrections")} corrections`;

function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid aggregate"); return value as Record<string, unknown>; }
function array(value: unknown): Record<string, unknown>[] { if (!Array.isArray(value)) throw new Error("Invalid aggregate"); return value.map(object); }
function integer(value: unknown): number { const result = typeof value === "number" || typeof value === "string" ? Number(value) : NaN; if (!Number.isSafeInteger(result) || result < 0) throw new Error("Invalid count"); return result; }
function micros(value: unknown): string { if ((typeof value !== "string" && typeof value !== "number") || !/^\d+$/.test(String(value))) throw new Error("Invalid amount"); return BigInt(String(value)).toString(); }
function iso(value: unknown): string | null { if (value === null || value === undefined) return null; if (!(typeof value === "string" || value instanceof Date)) throw new Error("Invalid date"); const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new Error("Invalid date"); return date.toISOString(); }
function code(value: unknown, fallback: string): string | null {
  if (value === null || value === undefined) return null;
  // These stores can outlive older adapters. An uppercase driver message/token
  // is not automatically a safe diagnostic; only application namespaces pass.
  const known = typeof value === "string" && (/^(AI|DSH|SOURCE|DISCOVERY|INSPIRATION|WORKER|MODEL|FETCH|ROBOTS|BRAVE|PROJECT|RESOURCE|GENERATION|ASSESSMENT|SCORING|ASSIGNMENT|EVENT|RETROSPECTIVE|PLAN)_[A-Z0-9_]+$/.test(value) || ["OFFICIAL_SOURCE_RULES_CHANGED", "OFFICIAL_SOURCE_LINK_REJECTED", "FORBIDDEN", "NOT_FOUND", "VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT", "INVALID_INPUT", "INVALID_STATE", "BUDGET_EXCEEDED"].includes(value));
  return known && value.length <= 64 ? value : fallback;
}
function counts<T extends string>(raw: unknown, statuses: readonly T[]): Record<T, number> { const values = object(raw); return Object.fromEntries(statuses.map(status => [status, integer(values[status] ?? 0)])) as Record<T, number>; }
function total(values: Record<string, number>): number { return integer(Object.values(values).reduce((sum, count) => sum + count, 0)); }
function tasks(raw: unknown, source = false): BackendTask[] {
  return array(raw).map(row => ({ id: String(row.id), kind: (source ? ["crawl", "analysis"] : aiKinds).includes(String(row.kind)) ? String(row.kind) : "other", status: String(row.status),
    errorCode: source ? row.error_code === null ? null : sourceFailures.includes(String(row.error_code)) ? String(row.error_code).toUpperCase() : "SOURCE_RUN_FAILED" : code(row.error_code, "AI_EXECUTION_FAILED"), updatedAt: iso(row.updated_at)! }));
}
function policy(value: AiBudgetPolicy | undefined, scope: BackendBudgetPolicy["scope"]): BackendBudgetPolicy | null {
  return value ? { scope, dailyCallLimit: integer(value.dailyProjectCallLimit), dailyBudgetMicroUsd: value.dailyProjectBudgetMicroUsd === undefined ? null : micros(value.dailyProjectBudgetMicroUsd), pricingConfigured: value.inputMicroUsdPerMillion !== undefined && value.outputMicroUsdPerMillion !== undefined } : null;
}
function schedulingState(raw: unknown): BackendDiscoveryState | null {
  const stored = raw == null ? null : object(raw);
  return stored ? { revision: integer(stored.revision), paused: Boolean(stored.paused), quotaDay: String(stored.quota_day), currency: stored.currency as "USD" | "CNY", searchCalls: integer(stored.search_calls), modelCalls: integer(stored.model_calls), estimatedCostMicros: micros(stored.estimated_cost_micros), includesReservation: Boolean(stored.includes_reservation), nextEligibleAt: iso(stored.next_eligible_at), leaseExpiresAt: iso(stored.lease_expires_at), lastCompletedAt: iso(stored.last_completed_at), lastErrorCode: code(stored.last_error_code, "DISCOVERY_FAILED") } : null;
}
function schedulingPhase(state: BackendDiscoveryState | null, now: number): BackendDashboard["discovery"]["phase"] {
  return !state ? "not_started" : state.paused ? "paused" : state.leaseExpiresAt ? Date.parse(state.leaseExpiresAt) > now ? "running" : "stale" : state.nextEligibleAt && Date.parse(state.nextEligibleAt) > now ? "waiting" : "ready";
}

/** Read-only admin snapshot. No filesystem, external request or implicit scheduler initialization. */
export async function readBackendDashboard(deps: { database: DatabasePort; config: ApplicationConfig; clock: Clock }, actor: Actor | null): Promise<BackendDashboard> {
  const denied = new DomainError("FORBIDDEN", "需要当前有效的管理员权限。", { status: 403 });
  if (!actor || typeof actor.userId !== "string" || !actor.userId.trim()) throw denied;
  try {
    return await deps.database.transaction(async sql => {
      const authority = await sql.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL AND 'admin'=ANY(platform_roles) FOR SHARE", [actor.userId]);
      if (!authority.rows.length) throw denied;
      const generatedAt = deps.clock.now().toISOString(), now = Date.parse(generatedAt), quotaDay = generatedAt.slice(0, 10);
      const row = (await sql.query(snapshotSql, [quotaDay, generatedAt])).rows[0];
      if (!row) throw new Error("Missing snapshot");
      const aiCounts = counts(row.ai_counts, aiStatuses), sourceCounts = counts(row.source_counts, sourceStatuses);
      const waiting = array(row.domain_waiting).map(item => ({ kind: item.kind as BackendDomainKind, queued: integer(item.queued), running: integer(item.running) }));
      const attempts = object(row.daily_attempts), buckets = object(row.daily_buckets);
      const pending = integer(attempts.pending), unknownFee = integer(attempts.unknown_fee), unverified = integer(attempts.unverified);
      const charged = micros(buckets.charged), reserved = micros(buckets.reserved), knownTotal = (BigInt(charged) + BigInt(reserved)).toString();
      const config = deps.config, modelSettings = aiServiceSettings(config), discoveryConfigured = Boolean(config.dsh && config.discovery), inspirationConfigured = Boolean(config.dsh && config.inspiration);
      const heartbeats = array(row.workers);
      const workers: BackendDashboard["workers"] = (["ai", "source", "discovery", "inspiration", "planning-notifications", "github-maintenance", "retention-maintenance", "resource-links", "organizer-notifications"] as const).map(kind => {
        const heartbeat = heartbeats.find(item => item.kind === kind), lastSeenAt = heartbeat ? iso(heartbeat.last_seen_at) : null;
        const ageMs = lastSeenAt === null ? null : Math.max(0, now - Date.parse(lastSeenAt));
        return { kind, configured: kind === "ai" ? Boolean(modelSettings) : kind === "source" ? Boolean(config.dsh) : kind === "discovery" ? discoveryConfigured : kind === "inspiration" ? inspirationConfigured : true,
          status: heartbeat ? heartbeat.status !== "stopped" && ageMs! > 120000 ? "stale" : heartbeat.status as "idle" | "running" | "failed" | "stopped" : "not_started",
          lastSeenAt, lastCompletedAt: heartbeat ? iso(heartbeat.last_completed_at) : null, errorCode: heartbeat ? code(heartbeat.error_code, "WORKER_FAILED") : null, ageMs, staleAfterMs: 120000 };
      });
      const state = schedulingState(row.discovery_state), inspirationState = schedulingState(row.inspiration_state);
      let phase = schedulingPhase(state, now);
      const recentUrls = array(row.urls).map(item => {
        const rawUrl = String(item.canonical_url), lastAttemptAt = iso(item.last_attempt_at)!, lastCompletedAt = iso(item.last_completed_at);
        const pending = !lastCompletedAt || Date.parse(lastCompletedAt) < Date.parse(lastAttemptAt);
        const needsReview = item.last_error_code === "DISCOVERY_MODEL_REQUIRES_REVIEW";
        let host: string | null = null; try { const url = new URL(rawUrl); if (["http:", "https:"].includes(url.protocol)) host = url.hostname.slice(0, 253); } catch { /* No raw URL is returned. */ }
        return { id: createHash("sha256").update(rawUrl).digest("hex"), host, status: needsReview ? "needs_review" as const : item.last_error_code ? "failed" as const : pending ? "pending" as const : "completed" as const,
          errorCode: code(item.last_error_code, "DISCOVERY_URL_FAILED"), lastAttemptAt, lastCompletedAt };
      });
      const limits = config.discovery?.worker.limits;
      if (!["paused", "running", "stale"].includes(phase) && config.discovery) {
        const sameDay = state?.quotaDay === quotaDay;
        const worker = config.discovery.worker, searches = worker.queries.length;
        const models = worker.maxPagesPerCycle + (config.discovery.provider === "dsh_native" ? searches : 0);
        const reservation = searches * worker.searchCostMicrosPerCall + worker.maxPagesPerCycle * worker.modelCostReservationMicrosPerCall;
        if ((sameDay ? state!.searchCalls : 0) + searches > worker.limits.maxSearchCallsPerDay ||
          (sameDay ? state!.modelCalls : 0) + models > worker.limits.maxModelCallsPerDay ||
          BigInt(sameDay ? state!.estimatedCostMicros : "0") + BigInt(reservation) > BigInt(worker.limits.maxEstimatedCostMicrosPerDay)) phase = "limited";
        else if (state?.lastErrorCode) phase = "attention";
      }
      const coverageRow = row.discovery_coverage == null ? null : object(row.discovery_coverage);
      const firstStartedAt = coverageRow ? iso(coverageRow.first_started_at) : null;
      const lastCompletedAt = coverageRow ? iso(coverageRow.last_completed_at) : null;
      const coverage: DiscoveryCoverageSummary | null = config.discovery ? {
        quotaDay, targetHours: config.discovery.coverageTargetHours ?? 5, firstStartedAt, lastCompletedAt,
        cycles: integer(coverageRow?.cycles ?? 0), searchCalls: integer(coverageRow?.search_calls ?? 0),
        fetchedPages: integer(coverageRow?.fetched_pages ?? 0), savedCards: integer(coverageRow?.saved_cards ?? 0),
        activeMs: integer(coverageRow?.active_ms ?? 0),
        spanMs: firstStartedAt && lastCompletedAt ? Date.parse(lastCompletedAt) - Date.parse(firstStartedAt) : 0,
      } : null;
      const inspirationLimits = config.inspiration?.limits;
      let inspirationPhase: BackendDashboard["inspiration"]["phase"] = schedulingPhase(inspirationState, now);
      if (!["paused", "running", "stale"].includes(inspirationPhase) && config.inspiration) {
        const sameDay = inspirationState?.quotaDay === quotaDay;
        if ((sameDay ? inspirationState!.modelCalls : 0) + 1 > config.inspiration.limits.maxModelCallsPerDay ||
          BigInt(sameDay ? inspirationState!.estimatedCostMicros : "0") + BigInt(config.inspiration.modelCostReservationMicrosPerCall) > BigInt(config.inspiration.limits.maxEstimatedCostMicrosPerDay)) inspirationPhase = "limited";
        else if (inspirationState?.lastErrorCode) inspirationPhase = "attention";
      }
      return {
        generatedAt, quotaDay, quotaTimezone: "UTC",
        services: [{ id: "database", configured: true, connectivity: "reachable" }, ...(["mail", "generic_ai", "dsh", "search", "github"] as const).map(id => ({ id, configured: id === "mail" ? Boolean(config.resendKey || config.smtp) : id === "generic_ai" ? Boolean(modelSettings) : id === "dsh" ? Boolean(config.dsh) : id === "search" ? Boolean(config.discovery) : Boolean(config.github), connectivity: "not_checked" as const }))],
        workers,
        queues: { ai: { counts: aiCounts, total: total(aiCounts), recent: tasks(row.ai_recent) }, sourceRuns: { counts: sourceCounts, total: total(sourceCounts), recent: tasks(row.source_recent, true) }, domainWaiting: { totalQueued: integer(waiting.reduce((sum, item) => sum + item.queued, 0)), totalRunning: integer(waiting.reduce((sum, item) => sum + item.running, 0)), byKind: waiting } },
        aiBudget: { currency: "USD", amountUnit: "micro_usd", quotaTimezone: "UTC", calls: integer(buckets.calls), attempts: integer(attempts.attempts), pendingAttempts: pending, unknownFeeAttempts: unknownFee, unverifiedUsageAttempts: unverified, knownChargedMicroUsd: charged, knownReservedMicroUsd: reserved, knownTotalMicroUsd: knownTotal, completeTotalMicroUsd: unknownFee || pending || unverified ? null : knownTotal, includesEstimates: Boolean(pending || unverified || charged !== "0" || reserved !== "0") },
        budgetPolicies: { genericAi: policy(modelSettings?.budget, "project"), dshProjects: policy(config.dsh?.budget, "project_or_user"), dshSources: policy(config.dsh?.sourceBudget, "source") },
        discovery: { configured: discoveryConfigured, phase, state, coverage, provider: config.discovery ? config.discovery.provider ?? "brave" : null,
          sources: config.discovery?.provider === "official_sources" ? OFFICIAL_EVENT_SOURCES.filter(source => config.discovery!.worker.queries.includes(source.id)).map(source => ({ name: source.name, url: source.listUrl })) : [],
          minimumIntervalMs: config.discovery?.worker.minimumIntervalMs ?? null, limits: limits ? { maxSearchCallsPerDay: limits.maxSearchCallsPerDay, maxModelCallsPerDay: limits.maxModelCallsPerDay, maxEstimatedCostMicrosPerDay: micros(limits.maxEstimatedCostMicrosPerDay), currency: limits.currency } : null, cards: counts(row.cards, ["active", "withdrawn"]), recentUrls },
        inspiration: { configured: inspirationConfigured, phase: inspirationPhase, state: inspirationState,
          minimumIntervalMs: config.inspiration?.minimumIntervalMs ?? null, cards: integer(row.inspiration_cards),
          limits: inspirationLimits ? { maxSearchCallsPerDay: inspirationLimits.maxSearchCallsPerDay, maxModelCallsPerDay: inspirationLimits.maxModelCallsPerDay, maxEstimatedCostMicrosPerDay: micros(inspirationLimits.maxEstimatedCostMicrosPerDay), currency: inspirationLimits.currency } : null },
        reviews: { events: counts(row.event_reviews, reviewStatuses), resources: counts(row.resource_reviews, reviewStatuses), corrections: counts(row.corrections, correctionStatuses) },
      };
    });
  } catch (error) {
    if (error === denied) throw denied;
    throw new DomainError("BACKEND_DASHBOARD_UNAVAILABLE", "暂时无法读取后台运行状态，请稍后刷新。", { status: 503, recoveryAction: "retry_snapshot" });
  }
}
