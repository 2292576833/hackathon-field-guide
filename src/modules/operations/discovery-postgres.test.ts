import test from "node:test";
import assert from "node:assert/strict";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { PostgresDiscoveryLedger } from "./discovery-postgres.ts";
import { discoveryDatabaseFixture } from "./discovery-test-fixtures.ts";

test("discovery ledger executes durable reservations, fences and constraints in PostgreSQL WASM", async t => {
  const f = await discoveryDatabaseFixture(); t.after(() => f.engine.close());
  let milliseconds = Date.parse("2026-10-08T08:00:00Z"); const clock = { now: () => new Date(milliseconds) };
  let sequence = 0;
  const config = { workerId: "worker", minimumIntervalMs: 1000, leaseMs: 10_000,
    limits: { maxSearchCallsPerDay: 1, maxModelCallsPerDay: 1, maxEstimatedCostMicrosPerDay: 100, currency: "USD" as const },
    reservation: { searchCalls: 1, modelCalls: 1, estimatedCostMicros: 100 } };
  const begin = (ledger: PostgresDiscoveryLedger) => ledger.beginCycle({ ...config, now: clock.now().toISOString() });
  await t.test("daily quotas survive a ledger restart and reset only at the next UTC quota day", async () => {
    const id = `quota-${++sequence}`; const ledger = new PostgresDiscoveryLedger({ database: f.database, clock, id });
    const first = await begin(ledger); assert.ok("lease" in first);
    assert.deepEqual(await begin(ledger), { skipped: "busy" });
    await ledger.finishCycle({ token: first.lease.token, now: clock.now().toISOString(), consumed: { searchCalls: 1, modelCalls: 1, estimatedCostMicros: 20 }, errorCode: null });
    milliseconds += 1001;
    const restarted = new PostgresDiscoveryLedger({ database: f.database, clock, id });
    assert.deepEqual(await begin(restarted), { skipped: "daily_limit" });
    milliseconds += 86_400_000; const next = await begin(restarted); assert.ok("lease" in next);
    await restarted.finishCycle({ token: next.lease.token, now: clock.now().toISOString(), consumed: { searchCalls: 0, modelCalls: 0, estimatedCostMicros: 0 }, errorCode: null });
  });
  await t.test("URL claims serialize duplicate attempts; SQL rejects an active lease with NULL reservation", async () => {
    const id = `url-${++sequence}`; const ledger = new PostgresDiscoveryLedger({ database: f.database, clock, id });
    const cycle = await begin(ledger); assert.ok("lease" in cycle);
    const input = { token: cycle.lease.token, canonicalUrl: "https://events.hackathon.dev/quoted?'query", now: clock.now().toISOString(), recrawlAfterMs: 60_000 };
    const claims = await Promise.all([ledger.claimUrl(input), ledger.claimUrl(input)]);
    assert.equal(claims.filter(Boolean).length, 1);
    await assert.rejects(f.database.query("UPDATE operations_discovery_state SET reservation=NULL WHERE id=$1", [id]), /check constraint/);
    await ledger.finishCycle({ token: cycle.lease.token, now: clock.now().toISOString(), consumed: { searchCalls: 0, modelCalls: 0, estimatedCostMicros: 0 }, errorCode: null });
  });
  await t.test("native search claims serialize duplicates and preserve held attempts across a new lease", async () => {
    const id = `native-${++sequence}`; const ledger = new PostgresDiscoveryLedger({ database: f.database, clock, id });
    const cycle = await begin(ledger); assert.ok("lease" in cycle);
    const requestHash = "a".repeat(64); const input = { token: cycle.lease.token, requestHash, now: clock.now().toISOString() };
    assert.deepEqual((await Promise.all([ledger.claimSearch(input), ledger.claimSearch(input)])).sort(), [false, true]);
    await assert.rejects(ledger.recordSearch({ ...input, requestHash: "b".repeat(64), errorCode: null }), { code: "DISCOVERY_VERSION_CONFLICT" });
    await ledger.finishCycle({ token: cycle.lease.token, now: clock.now().toISOString(), consumed: { searchCalls: 0, modelCalls: 0, estimatedCostMicros: 0 }, errorCode: null });
    milliseconds += 1001;
    const next = await begin(ledger); assert.ok("lease" in next);
    assert.equal(await ledger.claimSearch({ ...input, token: next.lease.token }), false);
    await assert.rejects(ledger.recordSearch({ ...input, errorCode: null }), { code: "DISCOVERY_LEASE_LOST" });
    await assert.rejects(ledger.recordSearch({ ...input, token: next.lease.token, errorCode: null }), { code: "DISCOVERY_VERSION_CONFLICT" }, "a replacement lease cannot clear an older held request without a current-cycle claim");
  });
  await t.test("native search claim/record expiry at the SQL write rolls back admission or marker clearing", async () => {
    for (const operation of ["claim", "record"] as const) {
      const id = `native-write-expiry-${++sequence}`; const ledger = new PostgresDiscoveryLedger({ database: f.database, clock, id });
      const cycle = await begin(ledger); assert.ok("lease" in cycle);
      const input = { token: cycle.lease.token, requestHash: "c".repeat(64), now: clock.now().toISOString() };
      if (operation === "record") assert.equal(await ledger.claimSearch(input), true);
      const delayed: DatabasePort = { query: (sql, values) => f.database.query(sql, values), transaction: work => f.database.transaction(async tx => {
        const wrapped: SqlExecutor = { async query<Row>(sql: string, values?: readonly unknown[]) {
          const result = await tx.query<Row>(sql, values);
          if (sql.startsWith(operation === "claim" ? "INSERT INTO operations_discovery_search_attempts" : "UPDATE operations_discovery_search_attempts")) milliseconds += 10_001;
          return result;
        } }; return work(wrapped);
      }) };
      const late = new PostgresDiscoveryLedger({ database: delayed, clock, id });
      await assert.rejects(operation === "claim" ? late.claimSearch(input) : late.recordSearch({ ...input, errorCode: null }), { code: "DISCOVERY_LEASE_LOST" });
      const rows = (await f.database.query<{ last_error_code: string }>("SELECT last_error_code FROM operations_discovery_search_attempts WHERE scheduler_id=$1", [id])).rows;
      if (operation === "claim") assert.equal(rows.length, 0); else assert.equal(rows[0]!.last_error_code, "DISCOVERY_SEARCH_REQUIRES_REVIEW");
    }
  });
  await t.test("waiting past expiry uses the clock after row locks, despite the old caller timestamp", async () => {
    const id = `clock-${++sequence}`; const ledger = new PostgresDiscoveryLedger({ database: f.database, clock, id });
    const cycle = await begin(ledger); assert.ok("lease" in cycle); const oldNow = clock.now().toISOString();
    const delayed: DatabasePort = { query: (sql, values) => f.database.query(sql, values), transaction: work => f.database.transaction(async tx => {
      const wrapped: SqlExecutor = { async query<Row>(sql: string, values?: readonly unknown[]) {
        const result = await tx.query<Row>(sql, values); if (sql.includes("operations_discovery_state") && sql.includes("FOR UPDATE")) milliseconds += 10_001; return result;
      } }; return work(wrapped);
    }) };
    const late = new PostgresDiscoveryLedger({ database: delayed, clock, id });
    await assert.rejects(late.claimUrl({ token: cycle.lease.token, canonicalUrl: "https://events.hackathon.dev/event", now: oldNow, recrawlAfterMs: 1 }), { code: "DISCOVERY_LEASE_LOST" });
  });
  await t.test("a card and URL accounting roll back atomically when cancellation arrives before commit", async () => {
    const id = `fence-${++sequence}`; const ledger = new PostgresDiscoveryLedger({ database: f.database, clock, id });
    const cycle = await begin(ledger); assert.ok("lease" in cycle); const canonicalUrl = `https://events.hackathon.dev/${id}`;
    await ledger.claimUrl({ token: cycle.lease.token, canonicalUrl, now: clock.now().toISOString(), recrawlAfterMs: 1 });
    const controller = new AbortController();
    await assert.rejects(ledger.commitCandidate({ token: cycle.lease.token, canonicalUrl, contentHash: "a".repeat(64), signal: controller.signal }, async () => {
      await f.database.query("INSERT INTO fixture_discovery_cards(canonical_url,payload) VALUES($1,'{}'::jsonb)", [canonicalUrl]); controller.abort();
      return { id: "candidate", revision: 1 };
    }), { code: "DISCOVERY_LEASE_LOST" });
    assert.equal((await f.database.query("SELECT id FROM fixture_discovery_cards WHERE canonical_url=$1", [canonicalUrl])).rowCount, 0);
    assert.equal((await f.database.query<{ candidate_id: string | null }>("SELECT candidate_id FROM operations_discovery_urls WHERE scheduler_id=$1", [id])).rows[0]?.candidate_id, null);
  });
  await t.test("a replacement lease fences the old worker and control pause uses optimistic revisions", async () => {
    const id = `replacement-${++sequence}`; const ledger = new PostgresDiscoveryLedger({ database: f.database, clock, id });
    const first = await begin(ledger); assert.ok("lease" in first); milliseconds += 10_001;
    const replacement = await ledger.beginCycle({ ...config, now: clock.now().toISOString(), limits: { ...config.limits, maxSearchCallsPerDay: 2, maxModelCallsPerDay: 2, maxEstimatedCostMicrosPerDay: 200 } });
    assert.ok("lease" in replacement);
    await assert.rejects(ledger.assertCycle({ token: first.lease.token }), { code: "DISCOVERY_LEASE_LOST" });
    const before = await ledger.readState(); await ledger.setPaused({ actorId: "admin", expectedRevision: before.revision, paused: true, now: clock.now().toISOString() });
    await assert.rejects(ledger.setPaused({ actorId: "admin", expectedRevision: before.revision, paused: false, now: clock.now().toISOString() }), { code: "DISCOVERY_VERSION_CONFLICT" });
    await assert.rejects(ledger.assertCycle({ token: replacement.lease.token }), { code: "DISCOVERY_PAUSED" });
  });
  await t.test("expiry or cancellation during the final URL update rolls back the saved card", async () => {
    for (const mode of ["expiry", "cancel"] as const) {
      const id = `final-fence-${++sequence}`; const ledger = new PostgresDiscoveryLedger({ database: f.database, clock, id });
      const cycle = await begin(ledger); assert.ok("lease" in cycle); const canonicalUrl = `https://events.hackathon.dev/${id}`;
      await ledger.claimUrl({ token: cycle.lease.token, canonicalUrl, now: clock.now().toISOString(), recrawlAfterMs: 1 });
      const controller = new AbortController();
      const delayed: DatabasePort = { query: (sql, values) => f.database.query(sql, values), transaction: work => f.database.transaction(async tx => {
        const wrapped: SqlExecutor = { async query<Row>(sql: string, values?: readonly unknown[]) {
          const result = await tx.query<Row>(sql, values);
          if (sql.startsWith("UPDATE operations_discovery_urls SET content_hash")) {
            if (mode === "expiry") milliseconds += 10_001; else controller.abort();
          }
          return result;
        } }; return work(wrapped);
      }) };
      const committing = new PostgresDiscoveryLedger({ database: delayed, clock, id });
      await assert.rejects(committing.commitCandidate({ token: cycle.lease.token, canonicalUrl, contentHash: "a".repeat(64), signal: controller.signal }, async () => {
        await f.database.query("INSERT INTO fixture_discovery_cards(canonical_url,payload) VALUES($1,'{}'::jsonb)", [canonicalUrl]);
        return { id: "candidate", revision: 1 };
      }), { code: "DISCOVERY_LEASE_LOST" });
      assert.equal((await f.database.query("SELECT id FROM fixture_discovery_cards WHERE canonical_url=$1", [canonicalUrl])).rowCount, 0);
      assert.equal((await f.database.query<{ candidate_id: string | null }>("SELECT candidate_id FROM operations_discovery_urls WHERE scheduler_id=$1", [id])).rows[0]?.candidate_id, null);
    }
  });
});
