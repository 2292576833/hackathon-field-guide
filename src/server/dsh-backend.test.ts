import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDiscoveryRoundWorker, createNativeDiscoveryQuerySelector, createStoredDiscoveryCandidates } from "./dsh-backend.ts";
import { defaultNativeEventQueries, defaultNativeEventQueryBatch } from "./config.ts";
import { DomainError } from "../shared/errors.ts";
import type { DiscoveryCoverageRecord } from "./discovery-coverage.ts";
import { createContinuousDiscoveryWorker } from "../modules/operations/discovery-worker.ts";
import type { PublicSearchPort } from "../modules/operations/discovery-types.ts";
import { discoveryDatabaseFixture, discoveryWorkerFixture } from "../modules/operations/discovery-test-fixtures.ts";

test("stored card hints choose one least-recently-attempted active URL, excluding unresolved canonical and alias holds", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  await fixture.engine.exec(`CREATE TABLE event_discovery_cards(id text PRIMARY KEY,canonical_url text NOT NULL UNIQUE,
    content jsonb NOT NULL,status text NOT NULL,last_analyzed_at timestamptz NOT NULL)`);
  const f = discoveryWorkerFixture(fixture.database, {}, "event-discovery"); await f.ledger.readState();
  for (const [id, age, status] of [["held", 10, "active"], ["alias-held", 9, "active"], ["withdrawn", 8, "withdrawn"], ["old-unvisited", 7, "active"], ["recently-attempted", 6, "active"], ["next-unvisited", 5, "active"]] as const) {
    await fixture.database.query("INSERT INTO event_discovery_cards(id,canonical_url,content,status,last_analyzed_at) VALUES($1,$2,$3::jsonb,$4,$5::timestamptz)",
      [id, `https://events.hackathon.dev/${id}`, JSON.stringify({ title: `Title ${id}`, summary: `Summary ${id}`, sources: [{ indexedExcerpt: "OLD_PRIVATE_SOURCE" }], registration: { url: "OLD_SIGNUP" } }), status,
        new Date(f.clock.now().getTime() - age * 60_000).toISOString()]);
  }
  for (const [url, id, error] of [["held", "held", "DISCOVERY_MODEL_REQUIRES_REVIEW"], ["old-alias-url", "alias-held", "DISCOVERY_MODEL_REQUIRES_REVIEW"], ["recently-attempted", "recently-attempted", null]] as const) {
    await fixture.database.query("INSERT INTO operations_discovery_urls(scheduler_id,canonical_url,last_attempt_at,cycle_token,candidate_id,last_error_code) VALUES($1,$2,$3::timestamptz,'fixture-cycle',$4,$5)",
      ["event-discovery", `https://events.hackathon.dev/${url}`, f.clock.now().toISOString(), id, error]);
  }
  const read = createStoredDiscoveryCandidates(fixture.database);
  assert.deepEqual(await read(), [{ url: "https://events.hackathon.dev/old-unvisited", title: "Title old-unvisited", description: "Summary old-unvisited" }]);
  await fixture.database.query("INSERT INTO operations_discovery_urls(scheduler_id,canonical_url,last_attempt_at,cycle_token) VALUES('event-discovery','https://events.hackathon.dev/old-unvisited',$1::timestamptz,'fixture-cycle')", [f.clock.now().toISOString()]);
  assert.equal((await read())[0]!.url, "https://events.hackathon.dev/next-unvisited", "an attempted old card cannot monopolize future cycles");
  const readonlyStatements: string[] = [];
  const wrapped = { ...fixture.database, async query<Row>(statement: string, parameters?: readonly unknown[]) {
    readonlyStatements.push(statement); return fixture.database.query<Row>(statement, parameters);
  } };
  const results = await createStoredDiscoveryCandidates(wrapped)();
  assert.equal(results.length, 1); assert.deepEqual(Object.keys(results[0]!).sort(), ["description", "title", "url"]);
  assert.equal(readonlyStatements.length, 1); assert.match(readonlyStatements[0]!, /^SELECT /);
});

test("native query rounds resume from durable search counts after a worker restart and restart at UTC midnight", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const f = discoveryWorkerFixture(fixture.database, { queries: defaultNativeEventQueries(new Date("2026-10-08T08:00:00Z")), maxPagesPerCycle: 1, searchCostMicrosPerCall: 100 });
  const requested: string[] = [];
  const search: PublicSearchPort = { modelCallsPerSearch: 1, requestIdentity: "rotating-native-fixture-v1", async search(input) {
    requested.push(input.query); return { results: [], usage: { inputTokens: 100, outputTokens: 100, estimatedCostMicros: 25, currency: "USD" } };
  } };
  const restartedWorker = () => createDiscoveryRoundWorker({ worker: createContinuousDiscoveryWorker({ ...f.dependencies, search }), config: f.dependencies.config,
    ledger: f.ledger, clock: f.clock, rollingNativeQueries: true });
  assert.equal((await restartedWorker().runOnce()).status, "completed");
  assert.deepEqual(requested, defaultNativeEventQueries(f.clock.now(), 0));
  f.advance(60_001);
  assert.equal((await restartedWorker().runOnce()).status, "completed");
  assert.deepEqual(requested.slice(2), defaultNativeEventQueries(f.clock.now(), 1));
  f.advance(60_001);
  assert.equal((await restartedWorker().runOnce()).status, "completed");
  assert.deepEqual(requested.slice(4), defaultNativeEventQueries(f.clock.now(), 2));
  assert.equal((await f.ledger.readState()).searchCalls, 6); assert.equal(f.counters.model, 0);
  f.advance(86_400_001);
  assert.equal((await restartedWorker().runOnce()).status, "completed");
  assert.deepEqual(requested.slice(6), defaultNativeEventQueries(f.clock.now(), 0));
  assert.equal((await f.ledger.readState()).searchCalls, 2);
});

test("round preparation refuses reentry while its two paid requests are in flight", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const f = discoveryWorkerFixture(fixture.database, { queries: defaultNativeEventQueries(new Date("2026-10-08T08:00:00Z")), maxPagesPerCycle: 1, searchCostMicrosPerCall: 100 });
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { started = resolve; });
  const requested: string[] = [];
  const search: PublicSearchPort = { modelCallsPerSearch: 1, requestIdentity: "serial-native-fixture-v1", async search(input) {
    requested.push(input.query); if (requested.length === 1) { started(); await pending; }
    return { results: [], usage: { inputTokens: 100, outputTokens: 100, estimatedCostMicros: 25, currency: "USD" } };
  } };
  const wrapper = createDiscoveryRoundWorker({ worker: createContinuousDiscoveryWorker({ ...f.dependencies, search }), config: f.dependencies.config,
    ledger: f.ledger, clock: f.clock, rollingNativeQueries: true });
  const first = wrapper.runOnce(); await reached;
  const second = await wrapper.runOnce(); assert.equal(second.status, "skipped"); assert.equal(second.reason, "busy");
  assert.equal(requested.length, 1); release(); assert.equal((await first).status, "completed");
  assert.deepEqual(requested, defaultNativeEventQueries(f.clock.now(), 0));
  assert.equal((await f.ledger.readState()).searchCalls, 2);
});

test("explicit custom discovery queries stay fixed across rounds", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const queries = ["custom source A", "custom source B"];
  const f = discoveryWorkerFixture(fixture.database, { queries, maxPagesPerCycle: 1, searchCostMicrosPerCall: 100 });
  const requested: string[] = [];
  const search: PublicSearchPort = { modelCallsPerSearch: 1, requestIdentity: "custom-native-fixture-v1", async search(input) {
    requested.push(input.query); return { results: [], usage: { inputTokens: 100, outputTokens: 100, estimatedCostMicros: 25, currency: "USD" } };
  } };
  const wrapper = createDiscoveryRoundWorker({ worker: createContinuousDiscoveryWorker({ ...f.dependencies, search }), config: f.dependencies.config,
    ledger: f.ledger, clock: f.clock, rollingNativeQueries: false });
  assert.equal((await wrapper.runOnce()).status, "completed"); f.advance(60_001); assert.equal((await wrapper.runOnce()).status, "completed");
  assert.deepEqual(requested, [...queries, ...queries]);
});

test("one-query batches cover both queries of all eight groups and resume after restart", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const f = discoveryWorkerFixture(fixture.database, { queries: defaultNativeEventQueryBatch(new Date("2026-10-08T08:00:00Z"), 0, 1),
    queryRotationGroups: 16, maxPagesPerCycle: 1, searchCostMicrosPerCall: 100,
    limits: { maxSearchCallsPerDay: 32, maxModelCallsPerDay: 64, maxEstimatedCostMicrosPerDay: 10_000, currency: "USD" } });
  const requested: string[] = [];
  const search: PublicSearchPort = { modelCallsPerSearch: 1, requestIdentity: "one-query-native-fixture", async search(value) {
    requested.push(value.query); return { results: [], usage: { inputTokens: 100, outputTokens: 100, estimatedCostMicros: 25, currency: "USD" } };
  } };
  for (let round = 0; round <= 16; round++) {
    const wrapper = createDiscoveryRoundWorker({ worker: createContinuousDiscoveryWorker({ ...f.dependencies, search }), config: f.dependencies.config,
      ledger: f.ledger, clock: f.clock, rollingNativeQueries: true, nativeQueriesPerCycle: 1 });
    assert.equal((await wrapper.runOnce()).status, "completed");
    assert.equal(requested[round], defaultNativeEventQueryBatch(f.clock.now(), round, 1)[0]);
    f.advance(60_001);
  }
  assert.equal(new Set(requested.slice(0, 16)).size, 16);
  assert.deepEqual(requested.slice(0, 16), Array.from({ length: 8 }, (_, group) => defaultNativeEventQueries(f.clock.now(), group)).flat());
  assert.equal(requested[16], requested[0]); assert.equal((await f.ledger.readState()).searchCalls, 17);
  f.advance(86_400_001);
  const restarted = createDiscoveryRoundWorker({ worker: createContinuousDiscoveryWorker({ ...f.dependencies, search }), config: f.dependencies.config,
    ledger: f.ledger, clock: f.clock, rollingNativeQueries: true, nativeQueriesPerCycle: 1 });
  await restarted.runOnce(); assert.equal(requested.at(-1), defaultNativeEventQueryBatch(f.clock.now(), 0, 1)[0]);
});

test("coverage observes actual reports once and excludes due waits from processing time", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const f = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1, searchCostMicrosPerCall: 100 });
  const records: DiscoveryCoverageRecord[] = [];
  const search: PublicSearchPort = { modelCallsPerSearch: 1, requestIdentity: "coverage-observation-fixture", async search() {
    f.advance(1200); return { results: [], usage: { inputTokens: 100, outputTokens: 100, estimatedCostMicros: 25, currency: "USD" } };
  } };
  const wrapper = createDiscoveryRoundWorker({ worker: createContinuousDiscoveryWorker({ ...f.dependencies, search }), config: f.dependencies.config,
    ledger: f.ledger, clock: f.clock, rollingNativeQueries: false,
    coverage: { async record(value) { records.push(value); return true; } } });
  assert.equal((await wrapper.runOnce()).searched, 1);
  assert.equal((await wrapper.runOnce()).reason, "not_due");
  assert.equal(records.length, 1);
  assert.equal(Date.parse(records[0].completedAt) - Date.parse(records[0].startedAt), 1200);
  f.advance(5 * 3_600_000);
  assert.equal((await wrapper.runOnce()).searched, 1); assert.equal(records.length, 2);
  assert.notEqual(records[0].attemptId, records[1].attemptId);
  assert.equal(Date.parse(records[1].completedAt) - Date.parse(records[1].startedAt), 1200);
});

test("coverage persistence failure never fails or retries an already billed discovery result", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const f = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1, searchCostMicrosPerCall: 100 });
  let calls = 0, observations = 0, alerts = 0;
  const search: PublicSearchPort = { modelCallsPerSearch: 1, requestIdentity: "coverage-failure-fixture", async search() {
    calls++; return { results: [], usage: { inputTokens: 100, outputTokens: 100, estimatedCostMicros: 25, currency: "USD" } };
  } };
  const wrapper = createDiscoveryRoundWorker({ worker: createContinuousDiscoveryWorker({ ...f.dependencies, search }), config: f.dependencies.config,
    ledger: f.ledger, clock: f.clock, rollingNativeQueries: false,
    coverage: { async record() { observations++; throw new Error("isolated coverage write failure"); } }, onCoverageError() { alerts++; } });
  const report = await wrapper.runOnce();
  assert.equal(report.status, "completed"); assert.equal(report.searched, 1); assert.deepEqual(report.errors, []);
  assert.equal(alerts, 1); assert.equal(observations, 1); assert.equal(calls, 1);
  assert.equal((await f.ledger.readState()).estimatedCostMicros, 25);
  assert.equal((await wrapper.runOnce()).reason, "not_due"); assert.equal(calls, 1); assert.equal(observations, 1);
});

test("rolling native queries avoid durable unknown requests without clearing holds or billing skipped searches", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const identity = "held-selection-actual-provider-v1";
  const requestHash = (query: string, value = identity) => createHash("sha256").update(`${value}\n${query}`).digest("hex");
  async function seed(f: ReturnType<typeof discoveryWorkerFixture>, queries: readonly string[], value = identity, error: string | null = "DISCOVERY_SEARCH_REQUIRES_REVIEW") {
    await f.ledger.readState();
    for (const query of queries) await fixture.database.query(`INSERT INTO operations_discovery_search_attempts(scheduler_id,request_hash,last_attempt_at,cycle_token,last_error_code)
      VALUES($1,$2,$3::timestamptz,'isolated-held-cycle',$4)`, [f.schedulerId, requestHash(query, value), f.clock.now().toISOString(), error]);
  }
  function selector(f: ReturnType<typeof discoveryWorkerFixture>) {
    return createNativeDiscoveryQuerySelector({ database: fixture.database, requestIdentity: identity, schedulerId: f.schedulerId });
  }
  function wrapper(f: ReturnType<typeof discoveryWorkerFixture>, search: PublicSearchPort, batchSize = 1) {
    return createDiscoveryRoundWorker({ worker: createContinuousDiscoveryWorker({ ...f.dependencies, search }), config: f.dependencies.config,
      ledger: f.ledger, clock: f.clock, rollingNativeQueries: true, nativeQueriesPerCycle: batchSize, selectNativeQueries: selector(f) });
  }
  await t.test("a restarted wrapper passes a held starting query and settles only an independent real request", async () => {
    const f = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1, searchCostMicrosPerCall: 100 });
    const requested: string[] = [];
    const search: PublicSearchPort = { modelCallsPerSearch: 1, requestIdentity: identity, resultOrdering: "interleave", async search(value) {
      requested.push(value.query);
      if (requested.length === 1) throw new DomainError("DSH_SEARCH_PROVIDER_UNCERTAIN", "isolated unknown result");
      return { results: [], usage: { inputTokens: 100, outputTokens: 100, estimatedCostMicros: 25, currency: "USD" } };
    } };
    assert.equal((await wrapper(f, search).runOnce()).status, "failed");
    assert.equal((await f.ledger.readState()).estimatedCostMicros, 100);
    const blockedNext = defaultNativeEventQueryBatch(f.clock.now(), 1, 1)[0]!;
    await seed(f, [blockedNext]);
    const heldBefore = (await fixture.database.query("SELECT request_hash,last_error_code,last_attempt_at,cycle_token FROM operations_discovery_search_attempts WHERE scheduler_id=$1 ORDER BY request_hash", [f.schedulerId])).rows;
    f.advance(60_001);
    const report = await wrapper(f, search).runOnce();
    assert.equal(report.status, "completed"); assert.equal(report.searched, 1);
    assert.deepEqual(requested, [defaultNativeEventQueryBatch(f.clock.now(), 0, 1)[0], defaultNativeEventQueryBatch(f.clock.now(), 2, 1)[0]]);
    const state = await f.ledger.readState(); assert.equal(state.searchCalls, 2); assert.equal(state.modelCalls, 2); assert.equal(state.estimatedCostMicros, 125);
    const heldAfter = (await fixture.database.query("SELECT request_hash,last_error_code,last_attempt_at,cycle_token FROM operations_discovery_search_attempts WHERE scheduler_id=$1 AND last_error_code=$2 ORDER BY request_hash", [f.schedulerId, "DISCOVERY_SEARCH_REQUIRES_REVIEW"])).rows;
    assert.deepEqual(heldAfter, heldBefore, "both unknown requests retain their original durable markers");
  });
  await t.test("two-query batches skip either held member using exactly the actual provider identity", async () => {
    const f = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1, searchCostMicrosPerCall: 100 });
    const first = defaultNativeEventQueryBatch(f.clock.now(), 0, 2), second = defaultNativeEventQueryBatch(f.clock.now(), 1, 2);
    await seed(f, [first[1]!]); await seed(f, [second[0]!], "different-provider-identity"); await seed(f, [second[1]!], identity, null);
    const queries = await selector(f)({ now: f.clock.now(), round: 0, batchSize: 2 });
    assert.deepEqual(queries, second, "another provider's hold and this provider's known successful marker cannot exclude this batch");
    assert.equal((await f.ledger.readState()).searchCalls, 0); assert.equal((await f.ledger.readState()).estimatedCostMicros, 0);
  });
  await t.test("all held batches return an explicit failure without calling worker, writing state or recording coverage", async () => {
    const f = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1, searchCostMicrosPerCall: 100 });
    await seed(f, Array.from({ length: 16 }, (_, round) => defaultNativeEventQueryBatch(f.clock.now(), round, 1)[0]!));
    const statements: string[] = [];
    const readDatabase = { ...fixture.database, async query<Row>(statement: string, parameters?: readonly unknown[]) {
      statements.push(statement); return fixture.database.query<Row>(statement, parameters);
    } };
    const before = (await fixture.database.query("SELECT * FROM operations_discovery_state WHERE id=$1", [f.schedulerId])).rows;
    let workerCalls = 0, coverageCalls = 0;
    const run = createDiscoveryRoundWorker({ worker: { ...f.worker, async runOnce(options) { workerCalls++; return f.worker.runOnce(options); } },
      config: f.dependencies.config, ledger: f.ledger, clock: f.clock, rollingNativeQueries: true, nativeQueriesPerCycle: 1,
      selectNativeQueries: createNativeDiscoveryQuerySelector({ database: readDatabase, requestIdentity: identity, schedulerId: f.schedulerId }),
      coverage: { async record() { coverageCalls++; return true; } } });
    const report = await run.runOnce();
    assert.equal(report.status, "failed"); assert.equal(report.reason, "DISCOVERY_SEARCH_REQUIRES_REVIEW");
    assert.deepEqual(report.errors, [{ code: "DISCOVERY_SEARCH_REQUIRES_REVIEW" }]); assert.equal(report.searched, 0); assert.equal(report.fetched, 0);
    assert.equal(workerCalls, 0); assert.equal(coverageCalls, 0); assert.equal(f.counters.search, 0);
    assert.equal(statements.length, 1); assert.match(statements[0]!, /^SELECT /);
    assert.deepEqual((await fixture.database.query("SELECT * FROM operations_discovery_state WHERE id=$1", [f.schedulerId])).rows, before);
    assert.equal((await fixture.database.query("SELECT count(*)::int AS n FROM operations_discovery_search_attempts WHERE scheduler_id=$1 AND last_error_code=$2", [f.schedulerId, "DISCOVERY_SEARCH_REQUIRES_REVIEW"])).rows[0].n, 16);
  });
  await t.test("a selector read failure never dispatches or reserves a paid request", async () => {
    const f = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1, searchCostMicrosPerCall: 100 });
    const selectNativeQueries = createNativeDiscoveryQuerySelector({ requestIdentity: identity, schedulerId: f.schedulerId,
      database: { ...fixture.database, async query() { throw new DomainError("DATABASE_UNAVAILABLE", "isolated read failure"); } } });
    const before = await f.ledger.readState();
    const run = createDiscoveryRoundWorker({ worker: f.worker, config: f.dependencies.config, ledger: f.ledger,
      clock: f.clock, rollingNativeQueries: true, nativeQueriesPerCycle: 1, selectNativeQueries });
    const report = await run.runOnce(); assert.equal(report.status, "failed"); assert.equal(report.reason, "DATABASE_UNAVAILABLE");
    assert.equal(f.counters.search, 0); assert.deepEqual(await f.ledger.readState(), before);
  });
  await t.test("UTC rollover retains old holds and skips an independently held query in the new dated pool", async () => {
    const f = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1, searchCostMicrosPerCall: 100 });
    const today = f.clock.now(), tomorrow = new Date(today.getTime() + 86_400_001);
    const heldQueries = [defaultNativeEventQueryBatch(today, 0, 1)[0]!, defaultNativeEventQueryBatch(tomorrow, 0, 1)[0]!];
    await seed(f, heldQueries);
    const before = (await fixture.database.query("SELECT * FROM operations_discovery_search_attempts WHERE scheduler_id=$1 ORDER BY request_hash", [f.schedulerId])).rows;
    const requested: string[] = [];
    const search: PublicSearchPort = { modelCallsPerSearch: 1, requestIdentity: identity, async search(value) {
      requested.push(value.query); return { results: [], usage: { inputTokens: 100, outputTokens: 100, estimatedCostMicros: 25, currency: "USD" } };
    } };
    assert.equal((await wrapper(f, search).runOnce()).searched, 1); f.advance(86_400_001);
    assert.equal((await wrapper(f, search).runOnce()).searched, 1);
    assert.deepEqual(requested, [defaultNativeEventQueryBatch(today, 1, 1)[0], defaultNativeEventQueryBatch(tomorrow, 1, 1)[0]]);
    assert.deepEqual((await fixture.database.query("SELECT * FROM operations_discovery_search_attempts WHERE scheduler_id=$1 AND last_error_code=$2 ORDER BY request_hash", [f.schedulerId, "DISCOVERY_SEARCH_REQUIRES_REVIEW"])).rows, before);
    assert.equal((await f.ledger.readState()).searchCalls, 1); assert.equal((await f.ledger.readState()).estimatedCostMicros, 25);
  });
  await t.test("fixed custom queries keep their own hold instead of silently selecting a different default query", async () => {
    const queries = ["my explicitly configured independent query"];
    const f = discoveryWorkerFixture(fixture.database, { queries, maxPagesPerCycle: 1, searchCostMicrosPerCall: 100 }); await seed(f, queries);
    let selectorCalls = 0, searchCalls = 0;
    const search: PublicSearchPort = { modelCallsPerSearch: 1, requestIdentity: identity, async search() { searchCalls++; return []; } };
    const run = createDiscoveryRoundWorker({ worker: createContinuousDiscoveryWorker({ ...f.dependencies, search }), config: f.dependencies.config,
      ledger: f.ledger, clock: f.clock, rollingNativeQueries: false, selectNativeQueries: async () => { selectorCalls++; throw new Error("custom queries must remain fixed"); } });
    const report = await run.runOnce(); assert.equal(report.reason, "DISCOVERY_SEARCH_REQUIRES_REVIEW");
    assert.equal(selectorCalls, 0); assert.equal(searchCalls, 0); assert.deepEqual(f.dependencies.config.queries, queries);
    const state = await f.ledger.readState(); assert.equal(state.searchCalls, 0); assert.equal(state.modelCalls, 0); assert.equal(state.estimatedCostMicros, 0);
  });
});
