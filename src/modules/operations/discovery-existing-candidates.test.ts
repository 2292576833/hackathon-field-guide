import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DomainError } from "../../shared/errors.ts";
import { createContinuousDiscoveryWorker } from "./discovery-worker.ts";
import type { PublicSearchPort, PublicSearchResult } from "./discovery-types.ts";
import { discoveryDatabaseFixture, discoveryWorkerFixture, eventModelData, eventPageText } from "./discovery-test-fixtures.ts";

const oldUrl = "https://events.hackathon.dev/legacy";
const hint = (url: string): PublicSearchResult => ({ url, title: "Untrusted discovery hint", description: "Metadata must not become source evidence" });
const native = (f: ReturnType<typeof discoveryWorkerFixture>, batches: readonly (readonly PublicSearchResult[])[]): PublicSearchPort => ({
  modelCallsPerSearch: 1, resultOrdering: "interleave", requestIdentity: "existing-candidates-native-v1",
  async search() { const index = f.counters.search++; return { results: batches[index % batches.length]!,
    usage: { inputTokens: 100, outputTokens: 100, estimatedCostMicros: 25, currency: "USD" } }; },
});
async function legacy(f: ReturnType<typeof discoveryWorkerFixture>, unresolved = false) {
  const at = f.clock.now().toISOString();
  const cycle = await f.ledger.beginCycle({ workerId: f.dependencies.config.workerId, now: at, minimumIntervalMs: 60_000,
    leaseMs: 6000, limits: f.dependencies.config.limits, reservation: { searchCalls: 1, modelCalls: 1, estimatedCostMicros: 101 } });
  assert.ok("lease" in cycle);
  await f.ledger.claimUrl({ token: cycle.lease.token, canonicalUrl: oldUrl, now: at, recrawlAfterMs: 60_000 });
  const saved = await f.dependencies.candidates.save({ canonicalUrl: oldUrl, title: eventModelData.title, summary: eventModelData.summary,
    analysis: structuredClone(eventModelData.analysis), sources: [{ url: oldUrl, title: "Old source", excerpt: eventModelData.evidence[0]!, fetchedAt: at }],
    discoveredAt: at, lastAnalyzedAt: at, provider: "dsh" });
  await f.ledger.recordUrl({ token: cycle.lease.token, canonicalUrl: oldUrl, now: at,
    contentHash: createHash("sha256").update(eventPageText).digest("hex"), candidateId: saved.id,
    errorCode: unresolved ? "DISCOVERY_MODEL_REQUIRES_REVIEW" : null });
  await f.ledger.finishCycle({ token: cycle.lease.token, now: at,
    consumed: { searchCalls: 1, modelCalls: 1, estimatedCostMicros: unresolved ? 101 : 11 },
    errorCode: unresolved ? "DISCOVERY_MODEL_REQUIRES_REVIEW" : null });
  f.advance(60_001); f.saved.length = 0;
}

test("a stored card omitted by native search receives a real new-schema analysis inside the same three-page allowance", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const f = discoveryWorkerFixture(fixture.database, { queries: ["query A", "query B"], maxPagesPerCycle: 3, searchCostMicrosPerCall: 100 });
  await legacy(f);
  const modeled: string[] = [];
  f.dependencies.model.request = async request => {
    f.counters.model++;
    const input = request.input as { page: { url: string; text: string; sourceKind: string } };
    modeled.push(input.page.url); assert.equal(input.page.text, eventPageText); assert.equal(input.page.sourceKind, "page");
    return { data: { ...structuredClone(eventModelData), registration: null, participation: { recommendation: "insufficient_info", reason: "规则需要核对", suitableFor: ["愿意确认规则的新人"], cautionFor: [] } },
      usage: { inputTokens: 100, outputTokens: 100, estimatedCostMicros: 10, currency: "USD" } };
  };
  const worker = createContinuousDiscoveryWorker({ ...f.dependencies,
    search: native(f, [[hint("https://events.hackathon.dev/new-a"), hint("https://events.hackathon.dev/new-c")], [hint("https://events.hackathon.dev/new-b")]]),
    async existingCandidates() { assert.equal(f.counters.search, 2, "stored URLs do not trigger a search outside the normal paid cycle"); return [hint(`${oldUrl}?utm_source=stored`)]; } });
  const report = await worker.runOnce();
  assert.equal(report.status, "completed"); assert.equal(report.searched, 2); assert.equal(report.fetched, 3); assert.equal(report.saved, 3);
  assert.equal(modeled[0], oldUrl); assert.equal(new Set(modeled).size, 3);
  assert.ok(modeled.includes("https://events.hackathon.dev/new-a")); assert.ok(modeled.includes("https://events.hackathon.dev/new-b"));
  assert.ok(f.saved[0]!.participation); assert.equal(f.saved[0]!.registration, null);
  assert.equal((await fixture.database.query<{ revision: number }>("SELECT revision FROM fixture_discovery_cards WHERE canonical_url=$1", [oldUrl])).rows[0]!.revision, 2);
  const state = await f.ledger.readState(); assert.equal(state.modelCalls, 6); assert.equal(state.estimatedCostMicros, 91);
});

test("old metadata cannot provide cited evidence when its fresh page fetch fails", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const f = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1, searchCostMicrosPerCall: 100 });
  f.dependencies.transport.request = async () => { throw new DomainError("SOURCE_FETCH_FAILED", "fixture unavailable"); };
  const report = await createContinuousDiscoveryWorker({ ...f.dependencies, search: native(f, [[]]),
    existingCandidates: async () => [{ ...hint(oldUrl), indexedExcerpt: eventPageText }] }).runOnce();
  assert.equal(report.saved, 0); assert.equal(f.counters.model, 0); assert.equal(report.fetched, 0);
  assert.equal((await f.ledger.readState()).estimatedCostMicros, 25, "a failed stored fetch releases only the unused model reservation");
});

test("duplicate stored/native URLs keep priority and use only fresh native cited_text after an inaccessible page", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const f = discoveryWorkerFixture(fixture.database, { queries: ["query A", "query B"], maxPagesPerCycle: 1, searchCostMicrosPerCall: 100 });
  f.dependencies.transport.request = async () => { throw new DomainError("SOURCE_FETCH_FAILED", "fixture unavailable"); };
  const result = { ...hint(`${oldUrl}?utm_source=now`), indexedExcerpt: eventPageText };
  const report = await createContinuousDiscoveryWorker({ ...f.dependencies, search: native(f, [[result, result], [result]]),
    existingCandidates: async () => [{ ...hint(oldUrl), indexedExcerpt: "OLD_METADATA_MUST_NEVER_BE_EVIDENCE" }] }).runOnce();
  assert.equal(report.saved, 1); assert.equal(f.counters.model, 1); assert.equal(report.fetched, 0);
  assert.equal(f.saved[0]!.canonicalUrl, oldUrl); assert.equal(f.saved[0]!.sources[0]!.sourceKind, "indexed_excerpt");
  assert.equal(f.saved[0]!.sources[0]!.excerpt, eventModelData.evidence[0]);
  assert.equal((await f.ledger.readState()).modelCalls, 3);
});

test("stored URLs cannot bypass a prior unknown model hold even when no native result references them", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const f = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1, searchCostMicrosPerCall: 100 });
  await legacy(f, true);
  const report = await createContinuousDiscoveryWorker({ ...f.dependencies, search: native(f, [[]]), existingCandidates: async () => [hint(oldUrl)] }).runOnce();
  assert.equal(report.reason, "DISCOVERY_MODEL_REQUIRES_REVIEW"); assert.equal(report.saved, 0); assert.equal(report.fetched, 0); assert.equal(f.counters.model, 0);
  assert.equal(f.fetches.length, 0); assert.equal((await f.ledger.readState()).estimatedCostMicros, 126);
});

test("supplemental catalog hints alternate with native results without enlarging the model/page budget", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const f = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 3, searchCostMicrosPerCall: 100 });
  const official = Array.from({ length: 5 }, (_, index) => hint(`https://catalog.hackathon.dev/event-${index}`));
  const report = await createContinuousDiscoveryWorker({ ...f.dependencies,
    search: native(f, [[hint("https://social.hackathon.dev/event-a"), hint("https://social.hackathon.dev/event-b")]]),
    existingCandidates: async () => [hint(oldUrl), ...official] }).runOnce();
  assert.equal(report.saved, 3); assert.equal(report.fetched, 3); assert.equal(f.counters.model, 3);
  assert.deepEqual(f.saved.map(card => card.canonicalUrl), [oldUrl, "https://social.hackathon.dev/event-a", official[0]!.url]);
  assert.equal((await f.ledger.readState()).modelCalls, 4);
});

test("skipped, failed-search and non-native cycles do not consult the revisit port", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  let reads = 0; const existingCandidates = async () => { reads++; return [hint(oldUrl)]; };
  const f = discoveryWorkerFixture(fixture.database, { searchCostMicrosPerCall: 100 });
  await createContinuousDiscoveryWorker({ ...f.dependencies, existingCandidates }).runOnce();
  assert.equal(reads, 0, "approved-listing providers preserve their existing scope and ordering");
  assert.equal((await createContinuousDiscoveryWorker({ ...f.dependencies, search: native(f, [[]]), existingCandidates }).runOnce()).reason, "not_due");
  assert.equal(reads, 0);
  f.advance(60_001);
  const failedSearch: PublicSearchPort = { modelCallsPerSearch: 1, requestIdentity: "unknown-search-no-revisit", async search() { throw new DomainError("DSH_SEARCH_FAILED", "fixture unknown"); } };
  assert.equal((await createContinuousDiscoveryWorker({ ...f.dependencies, search: failedSearch, existingCandidates }).runOnce()).saved, 0);
  assert.equal(reads, 0);
});

test("a cycle snapshots its query list before any asynchronous search or reservation", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const f = discoveryWorkerFixture(fixture.database, { queries: ["initial A", "initial B"], searchCostMicrosPerCall: 100 });
  const requested: string[] = [];
  const search: PublicSearchPort = { modelCallsPerSearch: 1, requestIdentity: "fixed-round-query-v1", async search(input) {
    requested.push(input.query); f.dependencies.config.queries = ["changed during search"];
    return { results: [], usage: { inputTokens: 100, outputTokens: 100, estimatedCostMicros: 25, currency: "USD" } };
  } };
  const report = await createContinuousDiscoveryWorker({ ...f.dependencies, search }).runOnce();
  assert.equal(report.status, "completed"); assert.deepEqual(requested, ["initial A", "initial B"]);
  assert.equal((await f.ledger.readState()).searchCalls, 2); assert.equal((await f.ledger.readState()).modelCalls, 2);
});

test("native result ranks rotate across durable rounds so unchanged leaders cannot starve lower-ranked events", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const f = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1, searchCostMicrosPerCall: 100 });
  const results = ["first", "second", "third"].map(name => hint(`https://events.hackathon.dev/${name}`));
  const search = native(f, [results]);
  for (let index = 0; index < 3; index++) {
    assert.equal((await createContinuousDiscoveryWorker({ ...f.dependencies, search }).runOnce()).saved, 1);
    f.advance(60_001);
  }
  assert.deepEqual(f.saved.map(card => card.canonicalUrl), results.map(result => result.url));
  assert.equal((await f.ledger.readState()).modelCalls, 6);
});

test("official supplement URLs rebuild exact trusted event policies including www aliases", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const f = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1, searchCostMicrosPerCall: 100 });
  const visits: string[] = [];
  const transport = { async request(input: { url: string }) {
    visits.push(input.url); const url = new URL(input.url);
    if (url.pathname === "/robots.txt") return { status: 200, connectedAddress: "93.184.216.34", contentType: "text/plain", body: "User-agent: *\nAllow: /" };
    if (url.hostname === "ethglobal.com") return { status: 301, connectedAddress: "93.184.216.34", contentType: "text/html", body: "", location: "https://www.ethglobal.com/events/mumbai" };
    return { status: 200, connectedAddress: "93.184.216.34", contentType: "text/html", body: `<p>${eventPageText}</p>` };
  } };
  const report = await createContinuousDiscoveryWorker({ ...f.dependencies, transport, search: native(f, [[]]),
    existingCandidates: async () => [hint("https://ethglobal.com/events/mumbai")] }).runOnce();
  assert.equal(report.saved, 1); assert.equal(f.counters.model, 1); assert.ok(visits.includes("https://www.ethglobal.com/events/mumbai"));
  assert.equal(f.saved[0]!.sources[0]!.sourceKind, "page");
});

test("eight rotating query groups advance the same group's batch and rank on rounds zero, eight and sixteen", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const f = discoveryWorkerFixture(fixture.database, { queries: ["group-0 A", "group-0 B"], queryRotationGroups: 8, maxPagesPerCycle: 1, searchCostMicrosPerCall: 100,
    limits: { maxSearchCallsPerDay: 100, maxModelCallsPerDay: 200, maxEstimatedCostMicrosPerDay: 10_000, currency: "USD" } });
  const search: PublicSearchPort = { modelCallsPerSearch: 1, resultOrdering: "interleave", requestIdentity: "eight-groups-native-v1", async search(input) {
    f.counters.search++;
    const batch = input.query.endsWith("A") ? "a" : "b";
    return { results: input.query.startsWith("group-0 ") ? Array.from({ length: 4 }, (_, index) => hint(`https://events.hackathon.dev/${batch}-${index}`)) : [],
      usage: { inputTokens: 100, outputTokens: 100, estimatedCostMicros: 25, currency: "USD" } };
  } };
  for (let round = 0; round <= 16; round++) {
    f.dependencies.config.queries = [`group-${round % 8} A`, `group-${round % 8} B`];
    const report = await createContinuousDiscoveryWorker({ ...f.dependencies, search }).runOnce();
    assert.equal(report.status, "completed");
    if (round % 8 === 0) assert.equal(report.saved, 1, "each return to the same group reaches a different result within one page slot");
    f.advance(60_001);
  }
  assert.deepEqual(f.saved.map(card => card.canonicalUrl), ["https://events.hackathon.dev/a-0", "https://events.hackathon.dev/b-1", "https://events.hackathon.dev/a-2"]);
  assert.equal(f.counters.model, 3); assert.equal((await f.ledger.readState()).searchCalls, 34);
});

test("catalogue/native order alternates within three slots while a robots denial still consumes a bounded attempt", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const f = discoveryWorkerFixture(fixture.database, { queries: ["query A", "query B"], maxPagesPerCycle: 3, searchCostMicrosPerCall: 100 });
  const baseRequest = f.dependencies.transport.request;
  f.dependencies.transport.request = async input => new URL(input.url).hostname === "social.hackathon.dev"
    ? { status: 200, connectedAddress: "93.184.216.34", contentType: "text/plain", body: "User-agent: *\nDisallow: /" } : baseRequest(input);
  const claimed: string[] = [], baseClaim = f.ledger.claimUrl.bind(f.ledger);
  f.ledger.claimUrl = async input => { claimed.push(input.canonicalUrl); return baseClaim(input); };
  const search = native(f, [[hint("https://social.hackathon.dev/a")], [hint("https://social.hackathon.dev/b")]]);
  let reads = 0;
  const worker = createContinuousDiscoveryWorker({ ...f.dependencies, search, existingCandidates: async () => [hint(oldUrl), hint(`https://catalog.hackathon.dev/event-${++reads}`)] });
  const first = await worker.runOnce();
  assert.equal(first.saved, 2); assert.equal(first.rejected, 1);
  assert.deepEqual(claimed, [oldUrl, "https://social.hackathon.dev/a", "https://catalog.hackathon.dev/event-1"]);
  claimed.length = 0; f.advance(60_001);
  const second = await worker.runOnce();
  assert.equal(second.saved, 1); assert.equal(second.unchanged, 1); assert.equal(second.rejected, 1);
  assert.deepEqual(claimed, [oldUrl, "https://catalog.hackathon.dev/event-2", "https://social.hackathon.dev/b"]);
  assert.equal(f.counters.model, 3, "neither a failed robots check nor unchanged text licenses an extra page or model slot");
});

test("query rotation group bounds fail before any discovery work", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  for (const queryRotationGroups of [0, 33, 1.5, Number.NaN]) {
    const f = discoveryWorkerFixture(fixture.database);
    assert.throws(() => createContinuousDiscoveryWorker({ ...f.dependencies, config: { ...f.dependencies.config, queryRotationGroups } }), { code: "INVALID_DISCOVERY_CONFIG" });
    assert.equal(f.counters.search, 0); assert.equal(f.counters.model, 0);
  }
});
