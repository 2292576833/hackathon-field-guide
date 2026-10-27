import { createHash } from "node:crypto";
import type { Clock, IdGenerator } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import { PostgresEventsRepository, validateRuleVersion } from "../modules/events/index.ts";
import type { EventRuleVersion, RuleEvidence } from "../modules/events/index.ts";
import { assertAllowedSourceUrl, assertRunLease, parseSourceAnalysis, parseSourceExtraction, validateAcquiredSource, SOURCE_CRAWL_ADAPTER_VERSION, SOURCE_ANALYSIS_SCHEMA_VERSION, SOURCE_EXTRACTION_SCHEMA_VERSION } from "../modules/operations/index.ts";
import type { AcquiredSource, AnalysisOutput, CandidateValidationPort, CrawlOutput, EventCandidatePublicationPort, ExecutionRun, SourceCandidateIngestionInput, SourceCandidateIngestionPort, SourceConfig, SourceExtractionCandidates, SourceLeaseGuard } from "../modules/operations/index.ts";

/** Backend composition only. Never expose this object or its DatabasePort to a browser or DSH. */
export interface SourceCandidateIngestionDependencies {
  readonly database: DatabasePort; readonly clock: Clock; readonly ids: IdGenerator;
  readonly workerId: string; readonly candidates: Pick<EventCandidatePublicationPort, "getCandidate">;
}
interface Receipt {
  readonly id: string; readonly run_id: string; readonly attempt: number; readonly kind: "crawl" | "analysis";
  readonly source_config_id: string; readonly source_revision: number; readonly target_url: string; readonly input_hash: string;
  readonly request_hash: string; readonly event_id: string; readonly payload: {
    readonly acquired: AcquiredSource; readonly candidates: SourceExtractionCandidates;
    readonly analysis?: unknown; readonly model: SourceCandidateIngestionInput["model"];
    readonly schemaVersion: string; readonly crawlRunId?: string; readonly unchanged: boolean;
    readonly eventSourceIds: readonly string[]; readonly candidateRefs: readonly string[];
  };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const scoped = (tx: SqlExecutor): DatabasePort => ({ query: (sql, values) => tx.query(sql, values), transaction: work => work(tx) });
const invalid = (): never => { throw new DomainError("INVALID_CANDIDATE_RESULT", "来源结果与当前任务或不可改写依据不一致。", { status: 409 }); };
function active(signal: AbortSignal): void { if (signal.aborted) throw new DomainError("SOURCE_WORKER_CANCELLED", "来源写入已停止。", { status: 409 }); }
function parsedCandidates(input: SourceExtractionCandidates, source: AcquiredSource): SourceExtractionCandidates {
  if (!input || input.schemaVersion !== SOURCE_EXTRACTION_SCHEMA_VERSION || input.verificationStatus !== "unverified") invalid();
  return parseSourceExtraction({ metadata: input.metadata, facts: input.facts.map(({ key, statement, excerpt }) => ({ key, statement, excerpt })),
    dates: input.dates.map(({ name, stageType, rawText, excerpt, timeZone, dateOnly }) => ({ name, stageType, rawText, excerpt, timeZone, dateOnly })),
    requirements: input.requirements.map(({ label, necessity, excerpt }) => ({ label, necessity, excerpt })), unknowns: input.unknowns }, source);
}
/** Worker text is evidence for human review, never an attestation of verified facts. */
function rulesFromExtraction(deps: SourceCandidateIngestionDependencies, candidates: SourceExtractionCandidates, source: AcquiredSource,
  sourceConfigId: string, eventId: string, version: number): EventRuleVersion {
  const sourceId = deps.ids.next(); const evidence: RuleEvidence[] = [];
  const addEvidence = (fieldKey: string, excerpt: string | null, rawDateText: string | null = null): string[] => {
    if (excerpt === null) return [];
    const id = deps.ids.next(); const offset = source.text.indexOf(excerpt); if (offset < 0) invalid();
    evidence.push({ id, eventId, version, sourceId, fieldKey, excerpt, locator: `normalized-text:${offset}:${offset + excerpt.length}`, rawDateText,
      verifiedBy: null, verifiedAt: null, conflictsWith: [] }); return [id];
  };
  addEvidence("metadata.name", candidates.metadata.nameExcerpt);
  addEvidence("metadata.organizer", candidates.metadata.organizerExcerpt);
  const facts = candidates.facts.map(fact => ({ key: fact.key, statement: fact.statement ?? "来源未说明，待人工核实。", status: fact.statement === null ? "unknown" as const : "unverified" as const, evidenceIds: addEvidence(fact.key, fact.excerpt) }));
  // Preserve raw dates as unverified evidence/facts; do not guess a start/end boundary.
  candidates.dates.forEach((date, index) => facts.push({ key: `date.${index}` as typeof facts[number]["key"], statement: date.rawText,
    status: "unverified", evidenceIds: addEvidence(`date.${index}`, date.excerpt, date.rawText) }));
  return validateRuleVersion({ eventId, version, createdAt: deps.clock.now().toISOString(),
    metadata: { name: candidates.metadata.name, organizer: candidates.metadata.organizer ?? "", format: "unknown", region: "", officialUrl: source.finalUrl },
    sources: [{ id: sourceId, eventId, version, sourceConfigId, url: source.finalUrl, kind: "official", contentHash: source.rawContentHash,
      fetchedAt: source.fetchedAt, trustScope: "official_rules", status: "available" }], evidence, facts,
    stages: candidates.dates.map(date => ({ id: deps.ids.next(), stageType: date.stageType, name: date.name, startsAt: null, endsAt: null, submissionUrl: null })),
    requirements: candidates.requirements.map(item => ({ id: deps.ids.next(), label: item.label, necessity: item.necessity, stageId: null, evidenceIds: addEvidence("materials", item.excerpt) })),
    qualityFlags: ["needs_recheck", "missing_information"] });
}

export function createSourceCandidateIngestion(deps: SourceCandidateIngestionDependencies): SourceCandidateIngestionPort & { readonly validation: CandidateValidationPort } {
  if (!deps.workerId) throw new DomainError("SOURCE_WORKER_UNCONFIGURED", "来源写入缺少固定服务身份。", { status: 503 });
  async function leased(tx: SqlExecutor, input: SourceLeaseGuard, signal: AbortSignal, validating = false): Promise<{ run: ExecutionRun; source: SourceConfig }> {
    active(signal);
    const result = await tx.query<{ data: ExecutionRun }>("SELECT data FROM operations_execution_runs WHERE id=$1 FOR NO KEY UPDATE", [input.runId]);
    const run = result.rows[0]?.data; if (!run) invalid();
    if (run.revision !== input.expectedRevision || run.sourceConfigId !== input.sourceConfigId) invalid();
    const sources = await tx.query<{ data: SourceConfig; revision: number; status: string }>("SELECT data,revision,status FROM operations_source_configs WHERE id=$1 FOR UPDATE", [input.sourceConfigId]);
    const row = sources.rows[0]; if (!row || row.status !== "enabled" || !row.data.verification || row.data.credentialPolicy !== "none" || row.revision !== input.sourceRevision) throw new DomainError("SOURCE_CONFIG_CHANGED", "来源配置已变化或停用。", { status: 409 });
    // Keep the same global order as task control: run -> source -> requester account.
    const requester = await tx.query<{ status: string; platform_roles: string[]; email_verified_at: string | Date | null }>("SELECT status,platform_roles,email_verified_at FROM auth_users WHERE id=$1 FOR NO KEY UPDATE", [run.requestedBy]);
    const account = requester.rows[0];
    if (!account || account.status !== "active" || !account.email_verified_at || !account.platform_roles.includes("admin")) throw new DomainError("SOURCE_REQUESTER_FORBIDDEN", "排队请求者已停用或失去管理员权限，不能继续来源写入。", { status: 403 });
    if (run.kind === "crawl" && (run.sourceSnapshot.revision !== row.revision || run.adapterVersion !== SOURCE_CRAWL_ADAPTER_VERSION)) invalid();
    assertRunLease(run, { id: deps.workerId, kind: "operations_worker", capabilities: ["crawl", "analysis"], sourceConfigIds: [run.sourceConfigId] }, input.leaseToken, deps.clock.now());
    if (validating && run.step !== "validating") invalid(); active(signal);
    return { run, source: row.data };
  }
  async function receipt(tx: SqlExecutor, id: string): Promise<Receipt> {
    const result = await tx.query<Receipt>("SELECT * FROM integration_source_results WHERE id=$1", [id]);
    if (!result.rows[0]) invalid(); return result.rows[0];
  }
  async function crawlReceipt(tx: SqlExecutor, runId: string, inputHash: string, candidateRefs: readonly string[]): Promise<Receipt> {
    const result = await tx.query<Receipt>("SELECT * FROM integration_source_results WHERE run_id=$1 AND kind='crawl' AND input_hash=$2 ORDER BY attempt DESC LIMIT 1", [runId, inputHash]);
    const row = result.rows[0]; if (!row || canonical(row.payload.candidateRefs) !== canonical(candidateRefs)) invalid();
    validateAcquiredSource(row.payload.acquired); parsedCandidates(row.payload.candidates, row.payload.acquired);
    return row;
  }
  const port: SourceCandidateIngestionPort = {
    async loadAnalysis(input, signal) {
      return deps.database.transaction(async tx => {
        const { run } = await leased(tx, input, signal);
        if (run.kind !== "analysis" || run.crawlRunId !== input.crawlRunId || run.inputHash !== input.inputHash || canonical(run.candidateRefs) !== canonical(input.candidateRefs)) invalid();
        const source = await crawlReceipt(tx, input.crawlRunId, input.inputHash, input.candidateRefs);
        if (source.source_config_id !== run.sourceConfigId) invalid(); active(signal);
        return { inputHash: source.input_hash, targetUrl: source.target_url, acquired: source.payload.acquired, candidates: source.payload.candidates };
      });
    },
    async store(input, signal) {
      return deps.database.transaction(async tx => {
        const { run, source } = await leased(tx, input, signal, true);
        if (run.kind !== input.kind || !input.model || ![input.model.usage.inputTokens, input.model.usage.outputTokens, input.model.usage.estimatedCostMicros].every(value => Number.isSafeInteger(value) && value >= 0) || !["USD", "CNY"].includes(input.model.usage.currency) || !input.model.modelVersion || !input.model.promptVersion) invalid();
        const acquired = validateAcquiredSource(input.acquired);
        const targetUrl = assertAllowedSourceUrl(input.targetUrl, source.networkPolicy); assertAllowedSourceUrl(acquired.finalUrl, source.networkPolicy);
        if (run.kind === "crawl" && targetUrl !== run.targetUrl) invalid();
        const previousAnalysis = run.kind === "analysis" ? await crawlReceipt(tx, run.crawlRunId, run.inputHash, run.candidateRefs) : null;
        if (run.kind === "analysis" && input.kind === "analysis" && (run.crawlRunId !== input.crawlRunId || run.inputHash !== input.inputHash || run.schemaVersion !== input.schemaVersion || input.schemaVersion !== SOURCE_ANALYSIS_SCHEMA_VERSION || run.modelVersion !== input.model.modelVersion || run.promptVersion !== input.model.promptVersion || previousAnalysis!.source_config_id !== run.sourceConfigId || previousAnalysis!.target_url !== targetUrl || canonical(previousAnalysis!.payload.acquired) !== canonical(acquired))) invalid();
        const candidates = input.kind === "crawl" ? parsedCandidates(input.candidates, acquired) : parsedCandidates(previousAnalysis!.payload.candidates, acquired);
        const analysis = input.kind === "analysis" ? parseSourceAnalysis({ summary: input.analysis.summary,
          observations: input.analysis.observations.map(({ statement, excerpt }) => ({ statement, excerpt })),
          suggestions: input.analysis.suggestions.map(({ text, basisExcerpt }) => ({ text, basisExcerpt })), unknowns: input.analysis.unknowns }, acquired, candidates) : undefined;
        const normalized = { acquired, candidates, analysis, model: input.model, schemaVersion: input.kind === "crawl" ? SOURCE_EXTRACTION_SCHEMA_VERSION : SOURCE_ANALYSIS_SCHEMA_VERSION,
          ...(input.kind === "analysis" ? { crawlRunId: input.crawlRunId } : {}) };
        const requestHash = hash(normalized);
        const prior = await tx.query<Receipt>("SELECT * FROM integration_source_results WHERE run_id=$1 AND attempt=$2", [run.id, run.attempt]);
        if (prior.rows[0]) { if (prior.rows[0].request_hash !== requestHash) invalid(); return { resultRef: prior.rows[0].id }; }
        let eventId = previousAnalysis?.event_id ?? deps.ids.next(); let eventSourceIds = previousAnalysis?.payload.eventSourceIds ?? [];
        let candidateRefs = previousAnalysis?.payload.candidateRefs ?? []; let unchanged = false;
        if (input.kind === "crawl") {
          const previous = await tx.query<Receipt>("SELECT * FROM integration_source_results WHERE source_config_id=$1 AND target_url=$2 AND kind='crawl' ORDER BY created_at DESC,id DESC LIMIT 1", [run.sourceConfigId, targetUrl]);
          const earlier = previous.rows[0];
          if (earlier && earlier.input_hash === acquired.textHash && earlier.payload.acquired.rawContentHash === acquired.rawContentHash) {
            eventId = earlier.event_id; eventSourceIds = earlier.payload.eventSourceIds; candidateRefs = []; unchanged = true;
          } else {
            eventId = earlier?.event_id ?? eventId;
            const repository = new PostgresEventsRepository(scoped(tx));
            const rules = await repository.transaction(async unit => {
              const current = await unit.getEvent(eventId);
              if (current?.publicationStatus === "archived") throw new DomainError("EVENT_ARCHIVED", "已撤下的赛事不能由采集恢复。", { status: 409 });
              const rules = rulesFromExtraction(deps, candidates, acquired, source.id, eventId, (current?.candidateVersion ?? 0) + 1);
              await unit.insertRules(rules);
              await unit.saveEvent({ id: eventId, revision: (current?.revision ?? 0) + 1, publicationStatus: "pending_review", candidateVersion: rules.version,
                publishedVersion: current?.publishedVersion ?? null, lastVerifiedAt: current?.lastVerifiedAt ?? null }, current?.revision ?? 0);
              return rules;
            });
            const candidateId = deps.ids.next(); const at = deps.clock.now().toISOString();
            await tx.query(`INSERT INTO integration_event_candidates(id,event_id,revision,rules_version,content_hash,schema_version,created_by,last_modified_by,origin,created_at,updated_at)
              VALUES($1,$2,1,$3,$4,'m03.rules.v1',$5,$5,'worker',$6::timestamptz,$6::timestamptz)`, [candidateId, eventId, rules.version, hash(rules), run.requestedBy, at]);
            await tx.query(`INSERT INTO integration_event_candidate_revisions(candidate_id,revision,event_id,rules_version,content_hash,schema_version,created_by,last_modified_by,origin,changed_at)
              SELECT id,revision,event_id,rules_version,content_hash,schema_version,created_by,last_modified_by,origin,updated_at FROM integration_event_candidates WHERE id=$1`, [candidateId]);
            eventSourceIds = rules.sources.map(source => source.id); candidateRefs = [candidateId];
            const actual = await deps.candidates.getCandidate(tx, candidateId);
            if (!actual || actual.origin !== "worker" || actual.eventId !== eventId || actual.contentHash !== hash(rules)) invalid();
          }
        }
        const resultRef = deps.ids.next();
        const payload = { ...normalized, unchanged, eventSourceIds, candidateRefs };
        active(signal); assertRunLease(run, { id: deps.workerId, kind: "operations_worker", capabilities: [run.kind], sourceConfigIds: [source.id] }, input.leaseToken, deps.clock.now());
        await tx.query(`INSERT INTO integration_source_results(id,run_id,attempt,kind,source_config_id,source_revision,target_url,input_hash,request_hash,event_id,payload,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::timestamptz)`, [resultRef, run.id, run.attempt, input.kind, source.id, source.revision, targetUrl, acquired.textHash, requestHash, eventId, JSON.stringify(payload), deps.clock.now().toISOString()]);
        active(signal); assertRunLease(run, { id: deps.workerId, kind: "operations_worker", capabilities: [run.kind], sourceConfigIds: [source.id] }, input.leaseToken, deps.clock.now());
        return { resultRef };
      });
    },
  };
  const validation: CandidateValidationPort = {
    async validateCrawl(input): Promise<CrawlOutput> {
      return deps.database.transaction(async tx => {
        const row = await receipt(tx, input.resultRef);
        const current = (await tx.query<{ data: ExecutionRun }>("SELECT data FROM operations_execution_runs WHERE id=$1", [input.runId])).rows[0]?.data;
        if (!current || current.kind !== "crawl" || current.attempt !== row.attempt || current.sourceConfigId !== row.source_config_id) invalid();
        if (row.kind !== "crawl" || row.run_id !== input.runId || row.source_config_id !== input.sourceConfigId || row.source_revision !== input.sourceRevision || row.target_url !== input.targetUrl || row.input_hash !== validateAcquiredSource(row.payload.acquired).textHash) invalid();
        parsedCandidates(row.payload.candidates, row.payload.acquired);
        for (const id of row.payload.candidateRefs) { const candidate = await deps.candidates.getCandidate(tx, id); if (!candidate || candidate.origin !== "worker" || candidate.eventId !== row.event_id) invalid(); }
        return { resultRef: row.id, inputHash: row.input_hash, eventSourceIds: row.payload.eventSourceIds, candidateRefs: row.payload.candidateRefs, unchanged: row.payload.unchanged };
      });
    },
    async validateAnalysis(input): Promise<AnalysisOutput> {
      return deps.database.transaction(async tx => {
        const row = await receipt(tx, input.resultRef);
        const current = (await tx.query<{ data: ExecutionRun }>("SELECT data FROM operations_execution_runs WHERE id=$1", [input.runId])).rows[0]?.data;
        if (!current || current.kind !== "analysis" || current.attempt !== row.attempt || current.sourceConfigId !== row.source_config_id) invalid();
        if (row.kind !== "analysis" || row.run_id !== input.runId || row.input_hash !== input.inputHash || row.payload.crawlRunId !== input.crawlRunId || row.payload.schemaVersion !== input.schemaVersion || row.payload.model.modelVersion !== input.modelVersion || row.payload.model.promptVersion !== input.promptVersion || !row.payload.analysis) invalid();
        validateAcquiredSource(row.payload.acquired);
        return { resultRef: row.id, outputRef: row.id, ...row.payload.model.usage };
      });
    },
  };
  return { ...port, validation };
}
