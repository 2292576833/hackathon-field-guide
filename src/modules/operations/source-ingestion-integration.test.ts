import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { createSourceCandidateIngestion } from "../../server/source-ingestion.ts";
import { createEventCandidateAdapter } from "../../server/operations.ts";
import type { OperationsIntegrationDependencies } from "../../server/operations.ts";
import { discoveryDatabaseFixture } from "./discovery-test-fixtures.ts";
import { admin, draft, MutableClock, SequenceIds } from "./source-test-fixtures.ts";
import { PostgreSqlOperationsExecutionRepository } from "./source-postgres.ts";
import { SourceService } from "./source-service.ts";
import { RunService, WorkerRunService } from "./run-service.ts";
import { normalizeAcquiredSource, parseSourceAnalysis, parseSourceExtraction, SOURCE_ANALYSIS_SCHEMA_VERSION } from "./source-extraction.ts";
import { createSourceWorker, SOURCE_CRAWL_ADAPTER_VERSION } from "./source-worker.ts";
import { createPostgresSourceRunQueue, createSourceQueueRunner } from "./worker-factory.ts";
import type { SourceCandidateIngestionInput } from "./source-worker.ts";

const body = "Global Hackathon. All developers welcome. Bring a working demo. Dates and fees will be confirmed later.";
test("actual source ingestion + M03 immutable rules + lease service compose in one PostgreSQL transaction", async t => {
  const db = await discoveryDatabaseFixture(); t.after(() => db.engine.close());
  for (const path of ["../../../migrations/001_initial.sql", "../../../migrations/003_operations_candidates.sql", "./sql/source-results.sql"]) await db.engine.exec(await readFile(new URL(path, import.meta.url), "utf8"));
  await db.database.query("INSERT INTO auth_users(id,email,display_name,timezone,platform_roles,email_verified_at,created_at) VALUES($1,$2,'管理员','Asia/Shanghai',ARRAY['admin']::text[],$3::timestamptz,$3::timestamptz)", [admin.userId, "admin@fixture.dev", "2026-10-08T08:00:00Z"]);
  const ids = new SequenceIds();
  async function fixture() {
    const clock = new MutableClock(); const repository = new PostgreSqlOperationsExecutionRepository(db.database);
    const sources = new SourceService({ repository, clock, ids });
    let source = await sources.create(admin, draft);
    source = await sources.transition(admin, source.id, { expectedRevision: source.revision, status: "verifying", reason: "验证" });
    source = await sources.transition(admin, source.id, { expectedRevision: source.revision, status: "enabled", reason: "已核对用途", verification: {
      termsUrl: "https://events.hackathon.dev/terms", allowedUses: ["规则摘录"], minimumRetainedFields: ["证据与日期"], notes: "测试配置" } });
    // This fixture injects only getCandidate: that path uses its supplied transaction and
    // does not read events/resources/HTTP dependencies from the root composition.
    const candidateAdapter: Pick<ReturnType<typeof createEventCandidateAdapter>, "getCandidate"> = createEventCandidateAdapter(
      { database: db.database, clock, ids } as unknown as OperationsIntegrationDependencies,
    );
    const dependencies = { database: db.database, clock, ids, workerId: "source-fixture", candidates: candidateAdapter };
    const ingestion = createSourceCandidateIngestion(dependencies);
    const runs = new RunService({ repository, clock, ids });
    const workers = new WorkerRunService({ repository, clock, ids, validation: ingestion.validation,
      identities: { authenticate: async credential => credential === "fixture-secret" ? { id: "source-fixture", kind: "operations_worker", capabilities: ["crawl", "analysis"], sourceConfigIds: [source.id] } : null } });
    const run = await runs.enqueueCrawl(admin, { sourceConfigId: source.id, expectedSourceRevision: source.revision, targetUrl: source.sampleUrl, adapterVersion: SOURCE_CRAWL_ADAPTER_VERSION, idempotencyKey: source.id });
    const task = await workers.claim("fixture-secret", run.id); let revision = task.revision;
    for (const step of ["normalizing", "extracting", "validating"] as const) revision = (await workers.advance("fixture-secret", { runId: run.id, leaseToken: task.leaseToken, expectedRevision: revision, step })).revision;
    const acquired = normalizeAcquiredSource({ body, finalUrl: source.sampleUrl, fetchedAt: clock.now().toISOString(), contentType: "text/plain" });
    const candidates = parseSourceExtraction({ metadata: { name: "Global Hackathon", nameExcerpt: "Global Hackathon.", organizer: null, organizerExcerpt: null },
      facts: [{ key: "eligibility", statement: "All developers welcome.", excerpt: "All developers welcome." }], dates: [],
      requirements: [{ label: "working demo", necessity: "required", excerpt: "Bring a working demo." }], unknowns: [] }, acquired);
    const input: SourceCandidateIngestionInput = { runId: run.id, leaseToken: task.leaseToken, expectedRevision: revision, sourceConfigId: source.id, sourceRevision: source.revision,
      kind: "crawl", targetUrl: source.sampleUrl, acquired, candidates, model: { modelVersion: "fixture-model", promptVersion: "fixture-prompt", usage: { inputTokens: 100, outputTokens: 100, estimatedCostMicros: 10, currency: "USD" } } };
    return { dependencies, ingestion, workers, runs, clock, source, input, run };
  }
  await t.test("durable result validates real M03 references without promotion to verified/published; replay is idempotent", async () => {
    const f = await fixture(); const signal = new AbortController().signal;
    const saved = await f.ingestion.store(f.input, signal);
    assert.deepEqual(await f.ingestion.store(f.input, signal), saved);
    const record = (await db.database.query<{ payload: Record<string, unknown> }>("SELECT payload FROM integration_source_results WHERE id=$1", [saved.resultRef])).rows[0]!;
    assert.equal(JSON.stringify(record.payload).includes(f.input.leaseToken), false);
    const completed = await f.workers.complete("fixture-secret", { runId: f.run.id, leaseToken: f.input.leaseToken, expectedRevision: f.input.expectedRevision, resultRef: saved.resultRef });
    assert.equal(completed.status, "review_ready");
    const rules = (await db.database.query<{ body: { evidence: { verifiedBy: null; verifiedAt: null }[]; facts: { status: string }[] } }>("SELECT r.body FROM m03_rule_versions r JOIN integration_source_results x ON r.event_id=x.event_id WHERE x.id=$1", [saved.resultRef])).rows[0]!.body;
    assert.ok(rules.evidence.length > 0); assert.ok(rules.evidence.every(item => item.verifiedBy === null && item.verifiedAt === null));
    assert.ok(rules.facts.every(fact => fact.status !== "verified"));
    assert.equal((await db.database.query<{ origin: string; created_by: string; published_version: number | null }>("SELECT origin,created_by,published_version FROM integration_event_candidates WHERE event_id=(SELECT event_id FROM integration_source_results WHERE id=$1)", [saved.resultRef])).rows[0]?.created_by, admin.userId);
    assert.equal((await db.database.query<{ body: { publishedVersion: null } }>("SELECT body FROM m03_events WHERE id=(SELECT event_id FROM integration_source_results WHERE id=$1)", [saved.resultRef])).rows[0]?.body.publishedVersion, null);
    await assert.rejects(db.database.query("UPDATE integration_source_results SET input_hash=$2 WHERE id=$1", [saved.resultRef, "a".repeat(64)]), /immutable/);
  });
  await t.test("stale source revision or forged excerpt cannot create M03 writes", async () => {
    const f = await fixture(); const signal = new AbortController().signal;
    await assert.rejects(f.ingestion.store({ ...f.input, sourceRevision: f.source.revision + 1 }, signal), { code: "SOURCE_CONFIG_CHANGED" });
    if (f.input.kind !== "crawl") throw new Error("fixture kind");
    await assert.rejects(f.ingestion.store({ ...f.input, candidates: { ...f.input.candidates, metadata: { ...f.input.candidates.metadata, nameExcerpt: "invented official claim" } } }, signal), { code: "SOURCE_EXTRACTION_INVALID" });
    assert.equal((await db.database.query("SELECT id FROM integration_source_results WHERE run_id=$1", [f.run.id])).rowCount, 0);
  });
  await t.test("requester role loss and suspension reject late store and analysis loads", async () => {
    const f = await fixture(); const signal = new AbortController().signal;
    for (const mutation of ["platform_roles=ARRAY['user']::text[]", "status='suspended'"]) {
      await db.database.query(`UPDATE auth_users SET ${mutation} WHERE id=$1`, [admin.userId]);
      try { await assert.rejects(f.ingestion.store(f.input, signal), { code: "SOURCE_REQUESTER_FORBIDDEN" }); }
      finally { await db.database.query("UPDATE auth_users SET platform_roles=ARRAY['admin']::text[],status='active' WHERE id=$1", [admin.userId]); }
    }
    const saved = await f.ingestion.store(f.input, signal);
    await f.workers.complete("fixture-secret", { runId: f.run.id, leaseToken: f.input.leaseToken, expectedRevision: f.input.expectedRevision, resultRef: saved.resultRef });
    const output = await f.ingestion.validation.validateCrawl({ runId: f.run.id, sourceConfigId: f.source.id, sourceRevision: f.source.revision, targetUrl: f.source.sampleUrl, resultRef: saved.resultRef });
    const run = await f.runs.enqueueAnalysis(admin, { crawlRunId: f.run.id, inputHash: output.inputHash, schemaVersion: SOURCE_ANALYSIS_SCHEMA_VERSION, modelVersion: "fixture-model", promptVersion: "fixture-prompt", idempotencyKey: "analysis" });
    const task = await f.workers.claim("fixture-secret", run.id);
    await db.database.query("UPDATE auth_users SET status='suspended' WHERE id=$1", [admin.userId]);
    try { await assert.rejects(f.ingestion.loadAnalysis({ runId: run.id, leaseToken: task.leaseToken, expectedRevision: task.revision, sourceConfigId: f.source.id, sourceRevision: f.source.revision,
      crawlRunId: f.run.id, inputHash: output.inputHash, candidateRefs: output.candidateRefs }, signal), { code: "SOURCE_REQUESTER_FORBIDDEN" }); }
    finally { await db.database.query("UPDATE auth_users SET status='active' WHERE id=$1", [admin.userId]); }
    const loaded = await f.ingestion.loadAnalysis({ runId: run.id, leaseToken: task.leaseToken, expectedRevision: task.revision, sourceConfigId: f.source.id, sourceRevision: f.source.revision,
      crawlRunId: f.run.id, inputHash: output.inputHash, candidateRefs: output.candidateRefs }, signal);
    const stage = await f.workers.advance("fixture-secret", { runId: run.id, leaseToken: task.leaseToken, expectedRevision: task.revision, step: "validating" });
    const analysis = parseSourceAnalysis({ summary: "未核实候选分析", observations: [{ statement: "All developers welcome.", excerpt: "All developers welcome." }], suggestions: [], unknowns: [] }, loaded.acquired, loaded.candidates);
    const result = await f.ingestion.store({ runId: run.id, leaseToken: task.leaseToken, expectedRevision: stage.revision, sourceConfigId: f.source.id, sourceRevision: f.source.revision,
      kind: "analysis", crawlRunId: f.run.id, inputHash: output.inputHash, schemaVersion: SOURCE_ANALYSIS_SCHEMA_VERSION, targetUrl: loaded.targetUrl, acquired: loaded.acquired,
      analysis, model: f.input.model }, signal);
    assert.equal((await f.workers.complete("fixture-secret", { runId: run.id, leaseToken: task.leaseToken, expectedRevision: stage.revision, resultRef: result.resultRef })).status, "succeeded");
  });
  await t.test("expiry during the final receipt insert rolls back both the M03 candidate and receipt", async () => {
    const f = await fixture(); const before = (await db.database.query("SELECT id FROM m03_events")).rowCount;
    const delay: DatabasePort = { query: (sql, values) => db.database.query(sql, values), transaction: work => db.database.transaction(async tx => {
      const wrapped: SqlExecutor = { async query<Row>(sql: string, values?: readonly unknown[]) {
        const result = await tx.query<Row>(sql, values); if (sql.includes("INSERT INTO integration_source_results")) f.clock.advance(31_000); return result;
      } }; return work(wrapped);
    }) };
    await assert.rejects(createSourceCandidateIngestion({ ...f.dependencies, database: delay }).store(f.input, new AbortController().signal), { code: "WORKER_LEASE_LOST" });
    assert.equal((await db.database.query("SELECT id FROM m03_events")).rowCount, before);
    assert.equal((await db.database.query("SELECT id FROM integration_source_results WHERE run_id=$1", [f.run.id])).rowCount, 0);
  });
  await t.test("actual due queue runner executes a retried source lease through the real M03 ingestion bridge", async () => {
    const f = await fixture();
    await f.workers.fail("fixture-secret", { runId: f.run.id, leaseToken: f.input.leaseToken, expectedRevision: f.input.expectedRevision, category: "network_error" });
    f.clock.advance(300_001);
    const worker = createSourceWorker({ control: f.workers, serviceCredential: "fixture-secret", clock: f.clock, candidates: f.ingestion,
      model: { modelVersion: "fixture-model", promptVersion: "fixture-prompt", async generateJson() {
        return { json: { metadata: { name: "Global Hackathon", nameExcerpt: "Global Hackathon.", organizer: null, organizerExcerpt: null },
          facts: [{ key: "eligibility", statement: "All developers welcome.", excerpt: "All developers welcome." }], dates: [], requirements: [], unknowns: [] }, usage: f.input.model.usage };
      } }, network: { userAgent: "HackathonIntelBot/1.0", dns: { resolve: async () => ["93.184.216.34"] },
        transport: { request: async input => ({ status: 200, connectedAddress: "93.184.216.34", contentType: "text/plain", body: new URL(input.url).pathname === "/robots.txt" ? "User-agent: *\nAllow: /" : body }) } } });
    const runner = createSourceQueueRunner({ worker, queue: createPostgresSourceRunQueue(db.database), clock: f.clock, kinds: ["crawl"], maxRunsPerCycle: 1 });
    const report = await runner.runOnce(); assert.equal(report.errors.length, 0); assert.equal(report.runs[0]?.id, f.run.id); assert.equal(report.runs[0]?.status, "review_ready");
    assert.equal((await db.database.query("SELECT id FROM integration_source_results WHERE run_id=$1 AND attempt=2", [f.run.id])).rowCount, 1);
  });
});
