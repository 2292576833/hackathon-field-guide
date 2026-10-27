import test from "node:test";
import assert from "node:assert/strict";
import type { Clock } from "../shared/contracts.ts";
import type { DatabasePort } from "../shared/persistence.ts";
import type { ApplicationConfig } from "./config.ts";
import { createDatabase } from "./database.ts";
import { createDiscoveryService, type DiscoveryInput } from "./discovery.ts";
import { createDiscoveryLiveService, type DiscoveryLiveState } from "./discovery-live.ts";
import { createApplication } from "./application.ts";
import { dispatch } from "./router.ts";

const origin = "http://localhost:3000";
const base: ApplicationConfig = { mode: "local", origin, codePepper: "isolated-live-test-pepper-at-least-32", emailFrom: "live@localhost.invalid" };
function configured(provider: "dsh_native" | "brave" = "dsh_native"): ApplicationConfig {
  const budget = { dailyProjectCallLimit: 10, dailyProjectBudgetMicroUsd: 1000 };
  return { ...base,
    dsh: { apiKey: "PRIVATE_DSH_FIXTURE_KEY", modelVersion: "PRIVATE_DSH_MODEL", promptVersion: "PRIVATE_PROMPT", currency: "USD", inputCostMicrosPerMillionTokens: 1, outputCostMicrosPerMillionTokens: 2, budget, sourceBudget: budget },
    discovery: { provider, searchKey: "PRIVATE_SEARCH_FIXTURE_KEY", worker: {
      workerId: "PRIVATE_WORKER_ID", userAgent: "isolated-live-fixture", queries: ["PRIVATE_QUERY_ONE", "PRIVATE_QUERY_TWO"],
      minimumIntervalMs: 300_000, recrawlAfterMs: 86_400_000, maxResultsPerQuery: 5, maxPagesPerCycle: 3,
      maxCycleDurationMs: 360_000, fetchTimeoutMs: 15_000, maxPageBytes: 262_144,
      searchCostMicrosPerCall: 100, modelCostReservationMicrosPerCall: 200,
      limits: { maxSearchCallsPerDay: 10, maxModelCallsPerDay: 10, maxEstimatedCostMicrosPerDay: 1000, currency: "USD" },
    } },
  };
}
async function fixture(config = configured()) {
  // No path is supplied: every fixture owns a fresh in-memory PostgreSQL engine.
  const database = await createDatabase({});
  try {
    await database.migrate();
    let current = new Date();
    const clock: Clock = { now: () => new Date(current) };
    const live = createDiscoveryLiveService({ database, config, clock, cacheMs: 0 });
    return { database, config, clock, live,
      advance(ms: number) { current = new Date(current.getTime() + ms); },
      async scheduler() {
        await database.query("INSERT INTO operations_discovery_state(id,quota_day,last_completed_at,next_eligible_at) VALUES('event-discovery',$1,$2::timestamptz,$3::timestamptz)", [clock.now().toISOString().slice(0, 10), new Date(clock.now().getTime() - 60_000).toISOString(), new Date(clock.now().getTime() + 300_000).toISOString()]);
      },
      async heartbeat(status = "idle", ageMs = 0, id = "isolated-discovery-worker") {
        await database.query("INSERT INTO backend_worker_heartbeats(worker_id,kind,status,last_seen_at,error_code) VALUES($1,'discovery',$2,$3::timestamptz,'PRIVATE_HEARTBEAT_DIAGNOSTIC') ON CONFLICT(worker_id) DO UPDATE SET status=excluded.status,last_seen_at=excluded.last_seen_at", [id, status, new Date(clock.now().getTime() - ageMs).toISOString()]);
      },
    };
  } catch (error) { await database.close(); throw error; }
}
function candidate(at: string, title = "隔离实时赛事夹具"): DiscoveryInput {
  const url = "https://example.com/isolated-live-event";
  const closesAt = new Date(Date.parse(at) + 10 * 86_400_000).toISOString(), evidence = `报名开放，报名截止时间为 ${closesAt}。`;
  return { canonicalUrl: url, title, summary: "仅供隔离测试的赛事线索，不用于真实网站内容。", analysis: { fit: ["适合原型练习"], risks: [], preparation: ["核实规则"], unknowns: ["截止日期"] }, sources: [{ url, title: "隔离来源", excerpt: evidence, fetchedAt: at }], discoveredAt: at, lastAnalyzedAt: at, provider: "dsh",
    registrationWindow: { status: "open", closesAt, closesOn: null, evidence: [evidence], checkedAt: at } };
}
const publicFields = ["count", "lastCompletedAt", "minimumIntervalMs", "nextEligibleAt", "state", "version"].sort();
function assertPublic(value: DiscoveryLiveState) {
  assert.deepEqual(Object.keys(value).sort(), publicFields);
  assert.match(value.version, /^[a-f0-9]{32}$/);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|apiKey|queries|searchKey|leaseToken|quota|errorCode|estimatedCost|workerId|reservation/);
}

test("live metadata changes for new cards, unchanged-revision reanalysis, revised analysis and withdrawal", async () => {
  const f = await fixture();
  try {
    const discoveries = createDiscoveryService(f.database, f.clock);
    const empty = await f.live.snapshot(); assert.equal(empty.count, 0);
    assert.equal((await discoveries.list()).version, empty.version);
    const originalInput = candidate(f.clock.now().toISOString());
    const first = await discoveries.save(originalInput);
    const original = await f.live.snapshot();
    assert.equal((await discoveries.list()).version, original.version);
    assert.equal((await discoveries.list({ query: "no matching title" })).version, original.version);
    assert.equal(original.count, 1); assert.notEqual(original.version, empty.version);
    f.advance(1000);
    const reanalysis = await discoveries.save({ ...originalInput, lastAnalyzedAt: f.clock.now().toISOString(), sources: originalInput.sources.map(source => ({ ...source, fetchedAt: f.clock.now().toISOString() })) });
    assert.deepEqual(reanalysis, first);
    const refreshed = await f.live.snapshot(); assert.notEqual(refreshed.version, original.version);
    assert.equal((await discoveries.list()).version, refreshed.version);
    // Rejected stale worker results cannot create a false live change.
    await discoveries.save(originalInput);
    assert.equal((await f.live.snapshot()).version, refreshed.version);
    f.advance(1000);
    const updated = await discoveries.save({ ...originalInput, title: "修订后的隔离赛事", lastAnalyzedAt: f.clock.now().toISOString() });
    assert.equal(updated.revision, 2);
    const revised = await f.live.snapshot(); assert.notEqual(revised.version, refreshed.version);
    await f.database.query("UPDATE event_discovery_cards SET status='withdrawn' WHERE id=$1", [first.id]);
    const withdrawn = await f.live.snapshot(); assert.equal(withdrawn.count, 0); assert.equal(withdrawn.version, empty.version);
    assert.equal((await discoveries.list()).version, withdrawn.version);
    for (const state of [empty, original, refreshed, revised, withdrawn]) assertPublic(state);
  } finally { await f.database.close(); }
});

test("live snapshots merge simultaneous database reads, cache for one second and isolate caller mutations", async () => {
  const f = await fixture();
  try {
    let queries = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const readonly: DatabasePort = {
      async query<Row>(sql: string, parameters: readonly unknown[] = []) {
        assert.match(sql.trim(), /^SELECT\b/i); queries++; if (queries === 1) await gate;
        return f.database.query<Row>(sql, parameters);
      },
      transaction() { throw new Error("live synchronization must never open a write transaction"); },
    };
    const live = createDiscoveryLiveService({ database: readonly, config: f.config, clock: f.clock });
    const waiting = Array.from({ length: 20 }, () => live.snapshot());
    assert.equal(queries, 1); release();
    const snapshots = await Promise.all(waiting);
    for (const state of snapshots) assert.deepEqual(state, snapshots[0]);
    snapshots[0]!.version = "caller-modified";
    assert.notEqual(snapshots[1]!.version, "caller-modified");
    assert.notEqual((await live.snapshot()).version, "caller-modified");
    f.advance(999); await live.snapshot(); assert.equal(queries, 1);
    f.advance(1); await live.snapshot(); assert.equal(queries, 2);
  } finally { await f.database.close(); }
});

test("a failed live database read releases the shared pending request and can recover", async () => {
  const f = await fixture();
  try {
    let queries = 0;
    const failure = new Error("isolated unavailable database");
    const readonly: DatabasePort = { async query<Row>(sql: string, parameters: readonly unknown[] = []) {
      if (++queries === 1) throw failure;
      return f.database.query<Row>(sql, parameters);
    }, transaction() { throw new Error("unexpected transaction"); } };
    const live = createDiscoveryLiveService({ database: readonly, config: f.config, clock: f.clock });
    const result = await Promise.allSettled([live.snapshot(), live.snapshot()]);
    assert.ok(result.every(item => item.status === "rejected" && item.reason === failure));
    assert.equal(queries, 1);
    assert.equal((await live.snapshot()).count, 0); assert.equal(queries, 2);
  } finally { await f.database.close(); }
});

test("live status reflects durable scheduling and healthy worker activity without exposing diagnostics", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.live.snapshot()).state, "offline");
    await f.scheduler(); await f.heartbeat();
    const waiting = await f.live.snapshot(); assert.equal(waiting.state, "waiting");
    assert.equal(waiting.minimumIntervalMs, 300_000);
    assert.equal(waiting.lastCompletedAt, new Date(f.clock.now().getTime() - 60_000).toISOString());
    assert.equal(waiting.nextEligibleAt, new Date(f.clock.now().getTime() + 300_000).toISOString());
    await f.database.query("UPDATE operations_discovery_state SET lease_token='PRIVATE_LEASE_TOKEN',lease_expires_at=$1::timestamptz,reservation=$2::jsonb", [new Date(f.clock.now().getTime() + 60_000).toISOString(), JSON.stringify({ searchCalls: 2, modelCalls: 5, estimatedCostMicros: 800 })]);
    assert.equal((await f.live.snapshot()).state, "running");
    await f.database.query("UPDATE operations_discovery_state SET paused=true");
    assert.equal((await f.live.snapshot()).state, "paused");
    await f.database.query("UPDATE operations_discovery_state SET paused=false,lease_token=NULL,lease_expires_at=NULL,reservation=NULL,last_error_code='PRIVATE_PROVIDER_DIAGNOSTIC'");
    assert.equal((await f.live.snapshot()).state, "attention");
    await f.database.query("UPDATE operations_discovery_state SET last_error_code=NULL"); await f.heartbeat("failed");
    assert.equal((await f.live.snapshot()).state, "attention");
    await f.heartbeat("idle", 120_001);
    assert.equal((await f.live.snapshot()).state, "offline");
    await f.heartbeat("stopped");
    assert.equal((await f.live.snapshot()).state, "offline");
    for (const config of [{ ...f.config, dsh: undefined }, { ...f.config, discovery: undefined }]) {
      const state = await createDiscoveryLiveService({ database: f.database, config, clock: f.clock, cacheMs: 0 }).snapshot();
      assert.equal(state.state, "unconfigured"); assertPublic(state);
    }
    assertPublic(await f.live.snapshot());
  } finally { await f.database.close(); }
});

test("a new healthy worker takes precedence over stopped or stale instances", async () => {
  const f = await fixture();
  try {
    await f.scheduler();
    await f.heartbeat("idle", 10_000, "live-instance");
    await f.heartbeat("stopped", 0, "old-stopped-instance");
    await f.heartbeat("failed", 180_000, "old-stale-instance");
    assert.equal((await f.live.snapshot()).state, "waiting");
  } finally { await f.database.close(); }
});

test("live daily-limit state includes the whole upcoming search and analysis reservation", async () => {
  const f = await fixture();
  try {
    await f.scheduler(); await f.heartbeat();
    // Each native round requires 2 searches, 2 search-model calls, 3 analyses,
    // and 2*100 + 3*200 = 800 cost micros even before actual calls begin.
    for (const counters of [
      { search: 9, model: 0, cost: 0 },
      { search: 0, model: 6, cost: 0 },
      { search: 0, model: 0, cost: 201 },
    ]) {
      await f.database.query("UPDATE operations_discovery_state SET search_calls=$1,model_calls=$2,estimated_cost_micros=$3", [counters.search, counters.model, counters.cost]);
      assert.equal((await f.live.snapshot()).state, "limited");
    }
    // Exact remaining capacity may be consumed; the comparison is strict >.
    await f.database.query("UPDATE operations_discovery_state SET search_calls=8,model_calls=5,estimated_cost_micros=200");
    assert.equal((await f.live.snapshot()).state, "waiting");
    await f.database.query("UPDATE operations_discovery_state SET model_calls=6");
    const brave = createDiscoveryLiveService({ database: f.database, config: configured("brave"), clock: f.clock, cacheMs: 0 });
    assert.equal((await brave.snapshot()).state, "waiting", "non-native searches do not reserve extra model calls");
    assert.equal((await f.live.snapshot()).state, "limited");
    const previousDay = new Date(f.clock.now().getTime() - 86_400_000).toISOString().slice(0, 10);
    await f.database.query("UPDATE operations_discovery_state SET quota_day=$1,search_calls=10,model_calls=10,estimated_cost_micros=1000", [previousDay]);
    assert.equal((await f.live.snapshot()).state, "waiting", "yesterday's usage must not block today's available budget");
  } finally { await f.database.close(); }
});

test("an impossible single-round reservation remains limited before initialization and across quota days", async () => {
  const config = configured();
  config.discovery!.worker = { ...config.discovery!.worker, limits: { ...config.discovery!.worker.limits, maxModelCallsPerDay: 4 } };
  const f = await fixture(config);
  try {
    await f.heartbeat();
    assert.equal((await f.live.snapshot()).state, "limited", "a five-model round cannot fit a four-model daily cap without a scheduler row");
    await f.scheduler();
    assert.equal((await f.live.snapshot()).state, "limited");
    await f.database.query("UPDATE operations_discovery_state SET quota_day=$1", [new Date(f.clock.now().getTime() - 86_400_000).toISOString().slice(0, 10)]);
    assert.equal((await f.live.snapshot()).state, "limited", "changing quota days cannot make the impossible round admissible");
  } finally { await f.database.close(); }
});

test("anonymous live HTTP reads do not initialize schedulers, create heartbeats or invoke providers", async () => {
  const database = await createDatabase({});
  try {
    const app = await createApplication(base, database);
    let calls = 0;
    app.dshBackend.status = async () => { calls++; throw new Error("provider status must not be called from the public read route"); };
    const path = "event-discoveries/live";
    for (let i = 0; i < 3; i++) {
      const response = await dispatch(app, new Request(`${origin}/api/v1/${path}`), path.split("/"));
      assert.equal(response.status, 200); assert.match(response.headers.get("cache-control") ?? "", /no-store/);
      const envelope = await response.json() as { data: DiscoveryLiveState; requestId: string };
      assert.equal(envelope.data.state, "unconfigured"); assert.equal(envelope.data.count, 0); assertPublic(envelope.data);
      assert.ok(envelope.requestId);
    }
    assert.equal(calls, 0);
    assert.equal((await database.query("SELECT id FROM operations_discovery_state")).rowCount, 0);
    assert.equal((await database.query("SELECT worker_id FROM backend_worker_heartbeats")).rowCount, 0);
    const response = await dispatch(app, new Request(`${origin}/api/v1/${path}`, { method: "POST", headers: { origin } }), path.split("/"));
    assert.equal(response.status, 405);
    assert.equal((await database.query("SELECT id FROM operations_discovery_state")).rowCount, 0);
  } finally { await database.close(); }
});

test("live count/version keep precise and date-only cards after their dates", async () => {
  const database = await createDatabase({});
  try {
    await database.migrate(); let milliseconds = Date.parse("2026-10-08T09:59:59.500Z");
    const clock = { now: () => new Date(milliseconds) }, discoveries = createDiscoveryService(database, clock);
    const at = clock.now().toISOString();
    for (const dateOnly of [false, true]) {
      const evidence = dateOnly ? "报名开放，报名截止日期为 2026-10-09，具体时间及时区未提供。" : "报名开放，报名截止时间为 2026-10-08T18:00:00+08:00。";
      const value = candidate(at);
      await discoveries.save({ ...value, canonicalUrl: `https://example.com/${dateOnly ? "date" : "instant"}`,
        sources: [{ ...value.sources[0]!, excerpt: evidence }], registrationWindow: { status: "open", closesAt: dateOnly ? null : "2026-10-08T18:00:00+08:00",
          closesOn: dateOnly ? "2026-10-09" : null, evidence: [evidence], checkedAt: at } });
    }
    const legacy = candidate(at); delete legacy.registrationWindow; await discoveries.save({ ...legacy, canonicalUrl: "https://example.com/legacy" });
    let queries = 0;
    const readonly: DatabasePort = { ...database, async query<Row>(sql: string, parameters?: readonly unknown[]) { queries++; return database.query<Row>(sql, parameters); } };
    const live = createDiscoveryLiveService({ database: readonly, config: base, clock, cacheMs: 10_000 });
    const before = await live.snapshot(); assert.equal(before.count, 3); assert.equal((await discoveries.list()).items.length, 3);
    milliseconds += 499; assert.equal((await live.snapshot()).count, 3); assert.equal(queries, 1);
    milliseconds++; const expired = await live.snapshot(); assert.equal(expired.count, 3); assert.equal(expired.version, before.version); assert.equal(queries, 1);
    assert.equal((await discoveries.list()).items.length, 3); assertPublic(expired);
    assert.equal((await database.query("SELECT id FROM event_discovery_cards")).rowCount, 3, "expiry and legacy exclusion do not delete history");
    assert.equal((await database.query("SELECT id FROM operations_discovery_state")).rowCount, 0);
  } finally { await database.close(); }
});

test("a deadline passing during an in-flight live read is rechecked before returning the count", async () => {
  const database = await createDatabase({});
  try {
    await database.migrate(); let milliseconds = Date.parse("2026-10-08T09:59:59.500Z");
    const clock = { now: () => new Date(milliseconds) }, discoveries = createDiscoveryService(database, clock), value = candidate(clock.now().toISOString());
    const evidence = "报名开放，报名截止时间为 2026-10-08T10:00:00Z。";
    await discoveries.save({ ...value, sources: [{ ...value.sources[0]!, excerpt: evidence }], registrationWindow: { status: "open", closesAt: "2026-10-08T10:00:00Z", closesOn: null, evidence: [evidence], checkedAt: value.lastAnalyzedAt } });
    let queries = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const readonly: DatabasePort = { ...database, async query<Row>(sql: string, parameters?: readonly unknown[]) { if (++queries === 1) await gate; return database.query<Row>(sql, parameters); } };
    const live = createDiscoveryLiveService({ database: readonly, config: base, clock });
    const waiting = Array.from({ length: 5 }, () => live.snapshot()); assert.equal(queries, 1);
    milliseconds += 500; release();
    const snapshots = await Promise.all(waiting); assert.ok(snapshots.every(state => state.count === 1));
    assert.equal(queries, 1, "without a visibility deadline the shared read remains valid"); assert.equal((await discoveries.list()).items.length, 1);
  } finally { await database.close(); }
});
