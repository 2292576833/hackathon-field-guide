import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Actor, Clock, IdGenerator } from "../shared/contracts.ts";
import type { DatabasePort } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import { createDeepSeekHarnessAdapter, createBraveSearchProvider, createContinuousDiscoveryWorker, PostgresDiscoveryLedger, PostgreSqlOperationsExecutionRepository, WorkerRunService, createSourceWorker, createDshSourceModel, createNodeNetworkPorts, createPostgresSourceRunQueue, createSourceQueueRunner, retryRun } from "../modules/operations/index.ts";
import type { EventCandidatePublicationPort } from "../modules/operations/index.ts";
import type { ApplicationConfig } from "./config.ts";
import { defaultNativeEventQueryBatch } from "./config.ts";
import { createSourceCandidateIngestion } from "./source-ingestion.ts";
import type { createDiscoveryService } from "./discovery.ts";
import { createBudgetedSourceModel } from "./source-budget.ts";
import { PostgresAiLedger } from "./ai-jobs.ts";
import { createServerDshAdapter } from "./dsh-runtime.ts";
import { createOfficialSourceProvider, OFFICIAL_EVENT_SOURCES } from "../modules/operations/index.ts";
import { createNativeDiscoverySearch } from "./native-discovery.ts";
import { createDiscoverySourceSupplement } from "./discovery-sources.ts";
import { createDiscoveryCoverage } from "./discovery-coverage.ts";
import { DISCOVERY_MODEL_REQUIRES_REVIEW, DISCOVERY_SEARCH_REQUIRES_REVIEW, type ContinuousDiscoveryConfig, type DiscoveryCycleReport, type DiscoveryLedgerPort, type PublicSearchPort, type PublicSearchResult } from "../modules/operations/discovery-types.ts";

/** Existing card content supplies only discovery hints. The worker still fetches
 * a fresh public source, verifies robots/evidence and claims the durable URL. */
export function createStoredDiscoveryCandidates(database: DatabasePort) {
  return async (): Promise<readonly PublicSearchResult[]> => {
    const result = await database.query<{ canonical_url: string; title: string | null; description: string | null }>(`SELECT c.canonical_url,c.content->>'title' AS title,c.content->>'summary' AS description
      FROM event_discovery_cards c LEFT JOIN operations_discovery_urls u ON u.scheduler_id=$1 AND u.canonical_url=c.canonical_url
      WHERE c.status='active' AND u.last_error_code IS DISTINCT FROM $2
        AND NOT EXISTS (SELECT 1 FROM operations_discovery_urls held WHERE held.scheduler_id=$1 AND held.candidate_id=c.id AND held.last_error_code=$2)
      ORDER BY CASE WHEN NOT(c.content ? 'registrationWindow') AND c.content->'registration' IS NOT NULL AND c.content->'registration'<>'null'::jsonb THEN 0 ELSE 1 END,
        COALESCE(u.last_attempt_at,c.last_analyzed_at) ASC,c.last_analyzed_at ASC,c.id ASC LIMIT 1`, ["event-discovery", DISCOVERY_MODEL_REQUIRES_REVIEW]);
    return result.rows.flatMap(row => typeof row.title === "string" && typeof row.description === "string"
      ? [{ url: row.canonical_url, title: row.title.slice(0, 200), description: row.description.slice(0, 1000) }] : []);
  };
}

type CycleConfig = Omit<ContinuousDiscoveryConfig, "queries"> & { queries: readonly string[] };
type NativeQuerySelection = { now: Date; round: number; batchSize: number };
/** Observe existing paid-request markers without claiming, clearing or billing
 * them. The worker's transactional claimSearch remains the final send fence. */
export function createNativeDiscoveryQuerySelector(input: { database: DatabasePort; requestIdentity: string; schedulerId?: string }) {
  if (typeof input.requestIdentity !== "string" || !input.requestIdentity.trim() || input.requestIdentity.length > 2000) {
    throw new DomainError("INVALID_DISCOVERY_CONFIG", "原生搜索需要稳定请求标识。");
  }
  return async (selection: NativeQuerySelection): Promise<readonly string[] | null> => {
    const groups = selection.batchSize === 1 ? 16 : 8;
    const batches = Array.from({ length: groups }, (_, offset) => defaultNativeEventQueryBatch(selection.now, selection.round + offset, selection.batchSize));
    const hashes = batches.map(queries => queries.map(query => createHash("sha256").update(`${input.requestIdentity}\n${query}`).digest("hex")));
    const result = await input.database.query<{ request_hash: string; last_error_code: string | null }>(`SELECT request_hash,last_error_code
      FROM operations_discovery_search_attempts WHERE scheduler_id=$1 AND request_hash=ANY($2::text[]) AND last_error_code=$3`,
      [input.schedulerId ?? "event-discovery", hashes.flat(), DISCOVERY_SEARCH_REQUIRES_REVIEW]);
    const held = new Set(result.rows.filter(row => row.last_error_code === DISCOVERY_SEARCH_REQUIRES_REVIEW).map(row => row.request_hash));
    const index = hashes.findIndex(batch => batch.every(hash => !held.has(hash)));
    return index < 0 ? null : batches[index]!;
  };
}
/** Fix each round before reservation/send; restart position comes from the
 * durable paid-search counter, never browser activity or an in-memory cursor. */
export function createDiscoveryRoundWorker(input: { worker: ReturnType<typeof createContinuousDiscoveryWorker>; config: CycleConfig;
  ledger: Pick<DiscoveryLedgerPort, "readState">; clock: Clock; rollingNativeQueries: boolean; nativeQueriesPerCycle?: number;
  selectNativeQueries?: (selection: NativeQuerySelection) => Promise<readonly string[] | null>;
  coverage?: Pick<ReturnType<typeof createDiscoveryCoverage>, "record">; onCoverageError?: () => void }) {
  let running = false;
  const emptyReport = (status: DiscoveryCycleReport["status"], reason?: string): DiscoveryCycleReport => ({ status, ...(reason ? { reason } : {}),
    searched: 0, fetched: 0, saved: 0, unchanged: 0, rejected: 0, errors: [] });
  async function runOnce(options: { signal?: AbortSignal } = {}): Promise<DiscoveryCycleReport> {
    if (options.signal?.aborted) return emptyReport("cancelled");
    if (running) return emptyReport("skipped", "busy");
    running = true;
    const attemptId = randomUUID(), startedAt = input.clock.now().toISOString();
    try {
      if (input.rollingNativeQueries) {
        const state = await input.ledger.readState(), now = input.clock.now();
        const queryCount = input.nativeQueriesPerCycle ?? 2;
        const round = state.quotaDay === now.toISOString().slice(0, 10) ? Math.floor(state.searchCalls / queryCount) : 0;
        const queries = input.selectNativeQueries ? await input.selectNativeQueries({ now, round, batchSize: queryCount }) : defaultNativeEventQueryBatch(now, round, queryCount);
        if (!queries) return { ...emptyReport("failed", DISCOVERY_SEARCH_REQUIRES_REVIEW), errors: [{ code: DISCOVERY_SEARCH_REQUIRES_REVIEW }] };
        input.config.queries = queries;
      }
      const report = await input.worker.runOnce(options);
      const completedAt = input.clock.now().toISOString();
      if (input.coverage && report.status !== "skipped" && (report.searched > 0 || report.fetched > 0)) {
        try { await input.coverage.record({ attemptId, startedAt, completedAt, report }); }
        catch { try { input.onCoverageError?.(); } catch { /* Observation cannot replay or change billed work. */ } }
      }
      return report;
    } catch (error) {
      const reason = error instanceof DomainError ? error.code : "DISCOVERY_INTERNAL_ERROR";
      return { ...emptyReport("failed", reason), errors: [{ code: reason }] };
    } finally { running = false; }
  }
  return { ...input.worker, runOnce, async loop(options: { signal: AbortSignal; onCycle?: (report: DiscoveryCycleReport) => void | Promise<void> }) {
    while (!options.signal.aborted) {
      const report = await runOnce({ signal: options.signal }); await options.onCycle?.(report);
      if (options.signal.aborted) break;
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); options.signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, input.config.minimumIntervalMs);
        options.signal.addEventListener("abort", finish, { once: true }); if (options.signal.aborted) finish();
      });
    }
  } };
}

/** Trusted parent process holds SQL/search credentials. DSH receives bounded public text only. */
export function createDshBackend(deps: { config: ApplicationConfig; database: DatabasePort; clock: Clock; ids: IdGenerator;
  candidates: Pick<EventCandidatePublicationPort, "getCandidate">; discoveries: ReturnType<typeof createDiscoveryService> }) {
  const ledger = new PostgresDiscoveryLedger({ database: deps.database, clock: deps.clock });
  const adapter = deps.config.dsh ? createServerDshAdapter(deps.config.dsh) : null;
  const network = createNodeNetworkPorts({ userAgent: deps.config.discovery?.worker.userAgent ?? "HackathonFieldGuide/0.1", proxyUrl: deps.config.sourceProxyUrl });
  const coverage = createDiscoveryCoverage({ database: deps.database, clock: deps.clock, targetHours: deps.config.discovery?.coverageTargetHours });
  let coverageRecordingError: string | null = null;
  const workerConfig: CycleConfig | null = deps.config.discovery ? { ...deps.config.discovery.worker, queries: [...deps.config.discovery.worker.queries],
    queryRotationGroups: deps.config.discovery.rollingNativeQueries ? (deps.config.discovery.nativeQueriesPerCycle === 1 ? 16 : 8) : 1 } : null;
  const readStoredCandidates = createStoredDiscoveryCandidates(deps.database);
  const supplement = createDiscoverySourceSupplement({ config: deps.config, clock: deps.clock, network });
  const search: PublicSearchPort | null = adapter && deps.config.discovery ? deps.config.discovery.provider === "official_sources"
    ? createOfficialSourceProvider({ sourceIds: deps.config.discovery.worker.queries, userAgent: deps.config.discovery.worker.userAgent, timeoutMs: deps.config.discovery.worker.fetchTimeoutMs, maxBytes: 2_097_152, ...network })
    : deps.config.discovery.provider === "dsh_native" ? createNativeDiscoverySearch(deps.config.dsh!, deps.config.discovery.native!)
    : createBraveSearchProvider({ apiKey: deps.config.discovery.searchKey! }) : null;
  const selectNativeQueries = search && deps.config.discovery?.rollingNativeQueries && deps.config.discovery.provider === "dsh_native"
    ? createNativeDiscoveryQuerySelector({ database: deps.database, requestIdentity: search.requestIdentity! }) : undefined;
  const continuousWorker = adapter && deps.config.discovery && search ? createContinuousDiscoveryWorker({ search,
    model: adapter, ledger, candidates: deps.discoveries, async existingCandidates(input) {
      const stored = await readStoredCandidates();
      const state = await ledger.readState();
      // beginCycle has already reserved this round's search count. Start the
      // catalogue rotation independently of browser activity. New Chinese
      // catalogues and established international sources share bounded rounds.
      const round = Math.max(0, Math.floor(state.searchCalls / workerConfig!.queries.length) - 1) + 1;
      const catalog = await supplement.read({ signal: input?.signal ?? AbortSignal.timeout(20_000), round });
      const offset = catalog.length ? round % catalog.length : 0;
      return [...stored, ...catalog.slice(offset), ...catalog.slice(0, offset)];
    }, clock: deps.clock, config: workerConfig!, ...network }) : null;
  const discoveryWorker = continuousWorker ? createDiscoveryRoundWorker({ worker: continuousWorker, ledger, clock: deps.clock, config: workerConfig!,
    rollingNativeQueries: Boolean(deps.config.discovery?.rollingNativeQueries), nativeQueriesPerCycle: deps.config.discovery?.nativeQueriesPerCycle,
    selectNativeQueries,
    coverage: { async record(value) { const recorded = await coverage.record(value); coverageRecordingError = null; return recorded; } },
    onCoverageError() { coverageRecordingError = "DISCOVERY_COVERAGE_RECORD_FAILED"; } }) : null;
  const workerId = `source-${randomUUID()}`;
  const credential = randomBytes(32).toString("base64url");
  const ingestion = createSourceCandidateIngestion({ database: deps.database, clock: deps.clock, ids: deps.ids, workerId, candidates: deps.candidates });
  const executionRepository = new PostgreSqlOperationsExecutionRepository(deps.database);
  const control = new WorkerRunService({ repository: executionRepository, clock: deps.clock, ids: deps.ids, validation: ingestion.validation,
    identities: { async authenticate(value) {
      if (typeof value !== "string" || value.length !== credential.length || !timingSafeEqual(Buffer.from(value), Buffer.from(credential))) return null;
      const approved = await deps.database.query<{ id: string }>("SELECT id FROM operations_source_configs WHERE status='enabled'");
      return { id: workerId, kind: "operations_worker", capabilities: ["crawl", "analysis"], sourceConfigIds: approved.rows.map(row => row.id) };
    } } });
  const sourceQueue = adapter ? createSourceQueueRunner({ worker: createSourceWorker({ control, serviceCredential: credential, clock: deps.clock, candidates: ingestion,
    model: createBudgetedSourceModel({ database: deps.database, clock: deps.clock, ids: deps.ids, model: createDshSourceModel(adapter),
      ledger: new PostgresAiLedger(deps.database, deps.config.dsh!.sourceBudget), maxInputBytes: deps.config.dsh!.maxInputBytes ?? 131_072, maxOutputTokens: deps.config.dsh!.maxTokens ?? 8192 }),
    network: { ...network, userAgent: deps.config.discovery?.worker.userAgent ?? "HackathonFieldGuide/0.1" } }),
    queue: createPostgresSourceRunQueue(deps.database), clock: deps.clock, maxRunsPerCycle: 1 }) : null;
  async function recoverSources() {
    const results = [];
    for (const observed of await executionRepository.findExpiredRuns(deps.clock.now().toISOString(), 50)) {
      const recovered = await executionRepository.transaction(async tx => {
        const run = await tx.getRun(observed.id, true);
        if (!run || !["queued", "running"].includes(run.status)) return null;
        const source = await tx.getSource(run.sourceConfigId, true); const now = deps.clock.now();
        const changed = !source || source.status !== "enabled" || (run.kind === "crawl" && source.revision !== run.sourceSnapshot.revision);
        if (!changed && (run.status !== "running" || !run.lease || Date.parse(run.lease.expiresAt) > now.getTime())) return null;
        // A crashed model call may already have been billed. Close it; explicit admin retry is required.
        const next = { ...retryRun(run, changed ? "source_changed" : "worker_lost", now, 0), status: "failed" as const, lease: null, finishedAt: now.toISOString() };
        await tx.saveRun(next, run.revision);
        await tx.appendAudit({ id: deps.ids.next(), actorKind: "worker", actorId: workerId, action: "RunLeaseReclaimed", entityId: run.id, revision: next.revision,
          reason: "来源失效或后台租约过期；外部结果可能未知，未自动重发模型请求", occurredAt: now.toISOString() });
        return next.id;
      });
      if (recovered) results.push(recovered);
    }
    return results;
  }
  async function status() { return { configured: Boolean(discoveryWorker), state: await ledger.readState(), currency: "USD" as const, minimumIntervalMs: deps.config.discovery?.worker.minimumIntervalMs ?? null,
    coverage: await coverage.summary(), coverageRecordingError,
    provider: deps.config.discovery ? deps.config.discovery.provider ?? "brave" : null,
    sources: deps.config.discovery?.provider === "official_sources" ? OFFICIAL_EVENT_SOURCES.filter(source => deps.config.discovery!.worker.queries.includes(source.id)).map(source => ({ name: source.name, url: source.listUrl })) : [] }; }
  async function setPaused(actor: Actor, value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError("INVALID_INPUT", "请提供发现调度参数。");
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some(key => !["expectedRevision", "paused"].includes(key)) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1 || typeof input.paused !== "boolean") throw new DomainError("INVALID_INPUT", "发现调度版本或暂停状态无效。");
    return deps.database.transaction(async tx => {
      const fresh = await tx.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL AND 'admin'=ANY(platform_roles) FOR SHARE", [actor.userId]);
      if (!fresh.rows.length) throw new DomainError("FORBIDDEN", "此操作需要当前有效的管理员权限。", { status: 403 });
      await ledger.setPaused({ actorId: actor.userId, expectedRevision: Number(input.expectedRevision), paused: input.paused as boolean, now: deps.clock.now().toISOString() });
      return status();
    });
  }
  return { adapter, sourceQueue, discoveryWorker, coverage, status, setPaused, recoverSources };
}
