import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { DomainError } from "../../shared/errors.ts";
import type { PublicSearchPort, PublicSearchResult, PublicSearchUsage } from "./discovery-types.ts";
import { createContinuousDiscoveryWorker } from "./discovery-worker.ts";
import { discoveryDatabaseFixture, discoveryTestConfig, discoveryWorkerFixture, eventModelData, eventPageText } from "./discovery-test-fixtures.ts";

const identity = "native:model-v1/prompt-v1/maxTokens=100/maxUses=1";
const usage: PublicSearchUsage = { inputTokens: 120, outputTokens: 30, estimatedCostMicros: 25, currency: "USD" };
function nativeSearch(f: ReturnType<typeof discoveryWorkerFixture>, options: {
  identity?: string; usage?: PublicSearchUsage | null; results?: readonly PublicSearchResult[];
  failure?: unknown; check?: () => void | Promise<void>;
} = {}): PublicSearchPort {
  return { modelCallsPerSearch: 1, requestIdentity: options.identity ?? identity,
    async search() {
      f.counters.search++; await options.check?.(); if (options.failure) throw options.failure;
      return { results: options.results ?? f.searchResults, usage: options.usage === undefined ? usage : options.usage };
    } };
}

test("paid native discovery search uses durable PostgreSQL accounting and source evidence", async t => {
  const databaseFixture = await discoveryDatabaseFixture(); t.after(() => databaseFixture.engine.close());
  const fixture = (overrides: Parameters<typeof discoveryWorkerFixture>[1] = {}) => discoveryWorkerFixture(databaseFixture.database, { searchCostMicrosPerCall: 100, ...overrides });
  await t.test("search and analysis both count model calls and measured costs settle separately", async () => {
    const f = fixture(); const provider = nativeSearch(f, { check: async () => {
      const row = (await databaseFixture.database.query<{ request_hash: string; last_error_code: string }>("SELECT request_hash,last_error_code FROM operations_discovery_search_attempts WHERE scheduler_id=$1", [f.schedulerId])).rows[0]!;
      assert.equal(row.request_hash, createHash("sha256").update(`${identity}\nAI hackathon 2026`).digest("hex"));
      assert.equal(row.last_error_code, "DISCOVERY_SEARCH_REQUIRES_REVIEW", "paid request marker exists before provider invocation");
    } });
    const report = await createContinuousDiscoveryWorker({ ...f.dependencies, search: provider }).runOnce();
    assert.equal(report.saved, 1); assert.equal(report.status, "completed");
    const state = await f.ledger.readState(); assert.equal(state.searchCalls, 1); assert.equal(state.modelCalls, 2); assert.equal(state.estimatedCostMicros, 35);
    assert.equal(f.saved[0]!.sources[0]!.sourceKind, "page");
    assert.equal((await databaseFixture.database.query<{ last_error_code: string | null }>("SELECT last_error_code FROM operations_discovery_search_attempts WHERE scheduler_id=$1", [f.schedulerId])).rows[0]!.last_error_code, null);
  });
  await t.test("native search worst-case model admission can stop a cycle before send", async () => {
    const f = fixture({ limits: { ...discoveryTestConfig.limits, maxModelCallsPerDay: 2 } });
    const report = await createContinuousDiscoveryWorker({ ...f.dependencies, search: nativeSearch(f) }).runOnce();
    assert.equal(report.reason, "daily_limit"); assert.equal(f.counters.search, 0); assert.equal(f.counters.model, 0);
  });
  await t.test("known results without usage retain full search cost but do not hold a successful request", async () => {
    const f = fixture(); const worker = () => createContinuousDiscoveryWorker({ ...f.dependencies, search: nativeSearch(f, { usage: null }) });
    assert.equal((await worker().runOnce()).saved, 1); assert.equal((await f.ledger.readState()).estimatedCostMicros, 110);
    f.advance(60_001); assert.equal((await worker().runOnce()).status, "completed");
    assert.equal(f.counters.search, 2); assert.equal(f.counters.model, 1); assert.equal((await f.ledger.readState()).estimatedCostMicros, 210);
  });
  await t.test("not_sent is the only external failure that refunds native search admission and permits later retry", async () => {
    const f = fixture(); const failure = Object.assign(new DomainError("DSH_SEARCH_UNCONFIGURED", "fixture pre-send"), { externalState: "not_sent" as const });
    const first = await createContinuousDiscoveryWorker({ ...f.dependencies, search: nativeSearch(f, { failure }) }).runOnce();
    assert.equal(first.reason, "DSH_SEARCH_UNCONFIGURED");
    const state = await f.ledger.readState(); assert.equal(state.searchCalls, 0); assert.equal(state.modelCalls, 0); assert.equal(state.estimatedCostMicros, 0);
    f.advance(60_001); assert.equal((await createContinuousDiscoveryWorker({ ...f.dependencies, search: nativeSearch(f) }).runOnce()).saved, 1);
  });
  await t.test("unknown, invalid usage and over-reservation responses retain the request across count changes and UTC days", async () => {
    for (const mode of ["unknown", "invalid_usage", "expensive"] as const) {
      const f = fixture();
      const options = mode === "unknown" ? { failure: Object.assign(new DomainError("DSH_SEARCH_FAILED", "fixture unknown"), { externalState: "unknown" }) }
        : { usage: { ...usage, ...(mode === "invalid_usage" ? { currency: "CNY" as const } : { estimatedCostMicros: 101 }) } };
      const first = await createContinuousDiscoveryWorker({ ...f.dependencies, search: nativeSearch(f, options) }).runOnce();
      assert.equal(first.saved, 0); assert.equal((await f.ledger.readState()).modelCalls, 1);
      assert.equal((await f.ledger.readState()).estimatedCostMicros, mode === "expensive" ? 101 : 100);
      f.advance(86_400_001);
      const restarted = createContinuousDiscoveryWorker({ ...f.dependencies, config: { ...f.dependencies.config, maxResultsPerQuery: 2 }, search: nativeSearch(f) });
      const blocked = await restarted.runOnce(); assert.equal(blocked.reason, "DISCOVERY_SEARCH_REQUIRES_REVIEW");
      assert.equal(f.counters.search, 1); assert.equal(f.counters.model, 0); assert.equal((await f.ledger.readState()).estimatedCostMicros, 0, "a held request cannot spend the next UTC day's budget");
    }
  });
  await t.test("interleaved native queries continue after an unknown first result while retaining its durable marker", async () => {
    const queries = ["social hackathon query A", "social hackathon query B"];
    const f = fixture({ queries, maxPagesPerCycle: 1 }); const requested: string[] = [];
    const provider: PublicSearchPort = { resultOrdering: "interleave", modelCallsPerSearch: 1, requestIdentity: identity,
      async search(input) {
        f.counters.search++; requested.push(input.query);
        if (input.query === queries[0]) throw Object.assign(new DomainError("DSH_SEARCH_FAILED", "fixture unknown first query"), { externalState: "unknown" });
        return { results: f.searchResults, usage };
      } };
    const worker = () => createContinuousDiscoveryWorker({ ...f.dependencies, search: provider });
    const report = await worker().runOnce();
    assert.equal(report.saved, 1); assert.equal(report.searched, 1); assert.equal(report.status, "completed");
    assert.deepEqual(requested, queries); assert.ok(report.errors.some(error => error.code === "DSH_SEARCH_FAILED"));
    const firstHash = createHash("sha256").update(`${identity}\n${queries[0]}`).digest("hex");
    const secondHash = createHash("sha256").update(`${identity}\n${queries[1]}`).digest("hex");
    const rows = (await databaseFixture.database.query<{ request_hash: string; last_error_code: string | null }>("SELECT request_hash,last_error_code FROM operations_discovery_search_attempts WHERE scheduler_id=$1", [f.schedulerId])).rows;
    assert.equal(rows.find(row => row.request_hash === firstHash)!.last_error_code, "DISCOVERY_SEARCH_REQUIRES_REVIEW");
    assert.equal(rows.find(row => row.request_hash === secondHash)!.last_error_code, null);
    const state = await f.ledger.readState(); assert.equal(state.searchCalls, 2); assert.equal(state.modelCalls, 3); assert.equal(state.estimatedCostMicros, 135);
    f.advance(60_001); const next = await worker().runOnce();
    assert.equal(next.reason, "DISCOVERY_SEARCH_REQUIRES_REVIEW"); assert.equal(next.unchanged, 1);
    assert.deepEqual(requested, [queries[0], queries[1], queries[1]], "the independent successful query can run again, while the unknown request is never resent");
  });
  await t.test("interleaved native search stops immediately when the first query exceeds its reserved fee", async () => {
    const queries = ["over-budget social query", "later independent query"];
    const f = fixture({ queries, maxPagesPerCycle: 1 }); const requested: string[] = [];
    const provider: PublicSearchPort = { resultOrdering: "interleave", modelCallsPerSearch: 1, requestIdentity: identity,
      async search(input) {
        f.counters.search++; requested.push(input.query);
        return { results: f.searchResults, usage: { ...usage, estimatedCostMicros: input.query === queries[0] ? 101 : 25 } };
      } };
    const report = await createContinuousDiscoveryWorker({ ...f.dependencies, search: provider }).runOnce();
    assert.equal(report.reason, "DISCOVERY_BUDGET_EXCEEDED"); assert.equal(report.status, "failed");
    assert.deepEqual(requested, [queries[0]]); assert.equal(f.counters.model, 0); assert.equal(report.fetched, 0); assert.equal(report.saved, 0);
    const state = await f.ledger.readState(); assert.equal(state.searchCalls, 1); assert.equal(state.modelCalls, 1); assert.equal(state.estimatedCostMicros, 101);
    const rows = (await databaseFixture.database.query<{ last_error_code: string }>("SELECT last_error_code FROM operations_discovery_search_attempts WHERE scheduler_id=$1", [f.schedulerId])).rows;
    assert.equal(rows.length, 1, "the second query is never admitted after the budget breach"); assert.equal(rows[0]!.last_error_code, "DISCOVERY_SEARCH_REQUIRES_REVIEW");
  });
  await t.test("fetch failure uses only bounded native cited_text and always persists the full-text limitation", async () => {
    const f = fixture(); f.dependencies.transport.request = async () => { throw new DomainError("SOURCE_FETCH_FAILED", "fixture inaccessible page"); };
    const excerpt = `${eventPageText} ${"x".repeat(17_000)}`;
    f.dependencies.model.request = async request => {
      f.counters.model++; const input = request.input as { page: { text: string; sourceKind: string; fullTextFetched: boolean } };
      assert.equal(input.page.text.length, 16_000); assert.equal(input.page.sourceKind, "indexed_excerpt"); assert.equal(input.page.fullTextFetched, false);
      assert.match(request.prompt, /full page was NOT read/u); assert.match(request.prompt, /do not infer activity status/u);
      return { data: { ...eventModelData, analysis: { ...eventModelData.analysis, unknowns: Array.from({ length: 8 }, (_, index) => `model unknown ${index}`) } }, usage };
    };
    const report = await createContinuousDiscoveryWorker({ ...f.dependencies, search: nativeSearch(f, { results: [{ ...f.searchResults[0]!, indexedExcerpt: excerpt }] }) }).runOnce();
    assert.equal(report.saved, 1); assert.equal(report.fetched, 0); assert.equal(report.status, "completed"); assert.ok(report.errors.some(error => error.code === "SOURCE_FETCH_FAILED"));
    const card = f.saved[0]!; assert.equal(card.sources[0]!.sourceKind, "indexed_excerpt"); assert.equal(card.sources[0]!.excerpt, eventModelData.evidence[0]);
    assert.equal(card.analysis.unknowns[0], "仅取得公开搜索引用，未读取全文；完整规则需确认"); assert.equal(card.analysis.unknowns.length, 8);
  });
  await t.test("search descriptions, short snippets and non-native excerpts cannot be substituted as page evidence", async () => {
    for (const mode of ["description_only", "short", "non_native"] as const) {
      const f = fixture(); f.dependencies.transport.request = async () => { throw new DomainError("SOURCE_FETCH_FAILED", "fixture inaccessible page"); };
      const results = [{ ...f.searchResults[0]!, description: eventPageText, ...(mode === "description_only" ? {} : { indexedExcerpt: mode === "short" ? "x".repeat(79) : eventPageText }) }];
      const provider: PublicSearchPort = mode === "non_native" ? { async search() { return results; } } : nativeSearch(f, { results });
      const report = await createContinuousDiscoveryWorker({ ...f.dependencies, search: provider }).runOnce();
      assert.equal(report.saved, 0); assert.equal(f.counters.model, 0);
    }
  });
  await t.test("a non-event response is settled and cooled down, while changed content can later be analyzed", async () => {
    const f = fixture({ recrawlAfterMs: 120_000 });
    f.dependencies.model.request = async request => { f.counters.model++; assert.match(request.prompt, /post-event reports/u); return { data: { notEvent: true }, usage }; };
    const provider = nativeSearch(f); const worker = () => createContinuousDiscoveryWorker({ ...f.dependencies, search: provider });
    const first = await worker().runOnce(); assert.equal(first.status, "completed"); assert.equal(first.saved, 0); assert.equal(first.rejected, 1);
    const row = (await databaseFixture.database.query<{ last_error_code: string; content_hash: string }>("SELECT last_error_code,content_hash FROM operations_discovery_urls WHERE scheduler_id=$1", [f.schedulerId])).rows[0]!;
    assert.equal(row.last_error_code, "DISCOVERY_NOT_EVENT"); assert.match(row.content_hash, /^[a-f0-9]{64}$/);
    assert.equal((await f.ledger.readState()).estimatedCostMicros, 50);
    f.advance(60_001); assert.equal((await worker().runOnce()).unchanged, 1); assert.equal(f.counters.model, 1);
    f.advance(60_001); const transport = f.dependencies.transport.request;
    f.dependencies.transport.request = async input => { const result = await transport(input); return { ...result, body: new URL(input.url).pathname === "/robots.txt" ? result.body : `${eventPageText} Registration now open.` }; };
    f.dependencies.model.request = async () => { f.counters.model++; return { data: eventModelData, usage }; };
    assert.equal((await worker().runOnce()).saved, 1); assert.equal(f.counters.model, 2);
  });
});

test("a native pre-send search marker survives database close/reopen, lease replacement and page-count changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "discovery-native-restart-"));
  let fixture: Awaited<ReturnType<typeof discoveryDatabaseFixture>> | null = null;
  try {
    fixture = await discoveryDatabaseFixture(join(directory, "postgres"));
    const f = discoveryWorkerFixture(fixture.database, { searchCostMicrosPerCall: 100 });
    const cycle = await f.ledger.beginCycle({ workerId: "native-crashed-worker", now: f.clock.now().toISOString(), minimumIntervalMs: 60_000,
      leaseMs: 6000, limits: f.dependencies.config.limits, reservation: { searchCalls: 1, modelCalls: 3, estimatedCostMicros: 300 } });
    assert.ok("lease" in cycle);
    assert.equal(await f.ledger.claimSearch({ token: cycle.lease.token, requestHash: createHash("sha256").update(`${identity}\nAI hackathon 2026`).digest("hex"), now: f.clock.now().toISOString() }), true);
    await fixture.engine.close(); fixture = null;
    fixture = await discoveryDatabaseFixture(join(directory, "postgres"));
    const restarted = discoveryWorkerFixture(fixture.database, { searchCostMicrosPerCall: 100, maxResultsPerQuery: 1 }, f.schedulerId); restarted.advance(60_001);
    const report = await createContinuousDiscoveryWorker({ ...restarted.dependencies, search: nativeSearch(restarted) }).runOnce();
    assert.equal(report.reason, "DISCOVERY_SEARCH_REQUIRES_REVIEW"); assert.equal(restarted.counters.search, 0); assert.equal(restarted.counters.model, 0);
    const state = await restarted.ledger.readState(); assert.equal(state.estimatedCostMicros, 300); assert.equal(state.modelCalls, 3);
  } finally {
    await fixture?.engine.close();
    const owned = relative(tmpdir(), directory);
    assert.equal(dirname(directory), tmpdir()); assert.ok(owned.startsWith("discovery-native-restart-") && !owned.includes(sep) && !isAbsolute(owned));
    await rm(directory, { recursive: true, force: true });
  }
});
