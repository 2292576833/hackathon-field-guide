import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { DatabasePort } from "../shared/persistence.ts";
import type { DiscoveryCycleReport } from "../modules/operations/discovery-types.ts";
import { discoveryDatabaseFixture } from "../modules/operations/discovery-test-fixtures.ts";
import { createDiscoveryCoverage, type DiscoveryCoverageRecord } from "./discovery-coverage.ts";

const report: DiscoveryCycleReport = { status: "completed", searched: 1, fetched: 1, saved: 1, unchanged: 0, rejected: 0, errors: [] };
async function fixture() {
  const fixture = await discoveryDatabaseFixture();
  try {
    await fixture.engine.exec(await readFile(new URL("../../migrations/055_discovery_coverage.sql", import.meta.url), "utf8"));
    let current = new Date("2026-10-11T13:00:00.000Z");
    const clock = { now: () => new Date(current) };
    return { ...fixture, clock, service: createDiscoveryCoverage({ database: fixture.database, clock }),
      setNow(value: string) { current = new Date(value); },
      record(startedAt: string, completedAt: string, changes: Partial<DiscoveryCycleReport> = {}): DiscoveryCoverageRecord {
        return { attemptId: randomUUID(), startedAt, completedAt, report: { ...report, ...changes } };
      } };
  } catch (error) { await fixture.engine.close(); throw error; }
}

test("coverage counts durable unique cycles atomically and distinguishes processing from five-hour span", async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  const first = f.record("2026-10-11T08:00:00.000Z", "2026-10-11T08:00:02.000Z");
  assert.deepEqual((await Promise.all([f.service.record(first), f.service.record(first)])).sort(), [false, true]);
  assert.equal(await f.service.record({ ...first, attemptId: first.attemptId.toUpperCase() }), false);
  const later = f.record("2026-10-11T13:00:00.000Z", "2026-10-11T13:00:03.000Z", { status: "failed", fetched: 2, saved: 0 });
  assert.equal(await f.service.record(later), true);
  const restarted = createDiscoveryCoverage({ database: f.database, clock: f.clock });
  assert.equal(await restarted.record(first), false);
  const summary = await restarted.summary();
  assert.equal(summary.targetHours, 5); assert.equal(summary.cycles, 2);
  assert.equal(summary.searchCalls, 2); assert.equal(summary.fetchedPages, 3); assert.equal(summary.savedCards, 1);
  assert.equal(summary.activeMs, 5000); assert.equal(summary.spanMs, 5 * 3_600_000 + 3000);
  assert.equal("completed" in summary, false); assert.equal("targetReached" in summary, false);
  assert.equal((await f.database.query("SELECT attempt_id FROM operations_discovery_coverage_cycles")).rows.length, 2);
});

test("read-only current UTC summary never creates facts; skipped and unknown-only reports do not count", async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  const statements: string[] = [];
  const database: DatabasePort = { async query<Row>(statement: string, parameters?: readonly unknown[]) {
    statements.push(statement); return f.database.query<Row>(statement, parameters);
  }, transaction: work => f.database.transaction(work) };
  const reader = createDiscoveryCoverage({ database, clock: f.clock });
  const empty = await reader.summary(); assert.equal(empty.cycles, 0); assert.equal(empty.firstStartedAt, null); assert.equal(empty.activeMs, 0);
  assert.equal(statements.length, 1); assert.match(statements[0], /^SELECT /);
  for (const status of ["skipped", "failed", "cancelled"] as const) {
    const value = f.record("2026-10-11T08:00:00.000Z", "2026-10-11T13:00:00.000Z", { status, searched: 0, fetched: 0, saved: 0 });
    assert.equal(await reader.record(value), false);
  }
  assert.equal((await reader.summary()).cycles, 0);
  assert.equal((await f.database.query("SELECT attempt_id FROM operations_discovery_coverage_cycles")).rows.length, 0);
  await f.service.record(f.record("2026-10-11T23:59:59.000Z", "2026-10-12T00:00:01.000Z"));
  f.setNow("2026-10-12T00:00:02.000Z");
  assert.equal((await reader.summary()).quotaDay, "2026-10-12"); assert.equal((await reader.summary()).cycles, 0);
  f.setNow("2026-10-11T23:59:59.000Z");
  assert.equal((await reader.summary()).activeMs, 2000, "cross-midnight cycles belong to their actual start UTC day");
});

test("summary failure rolls back cycle dedup marker, so only observation can safely retry", async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  const broken: DatabasePort = { query: (statement, parameters) => f.database.query(statement, parameters),
    transaction: work => f.database.transaction(tx => work({ async query<Row>(statement: string, parameters?: readonly unknown[]) {
      if (statement.startsWith("INSERT INTO operations_discovery_coverage\n")) throw new Error("fixture summary failure");
      return tx.query<Row>(statement, parameters);
    } })) };
  const value = f.record("2026-10-11T08:00:00.000Z", "2026-10-11T08:00:02.000Z");
  await assert.rejects(createDiscoveryCoverage({ database: broken, clock: f.clock }).record(value), /fixture summary failure/);
  assert.equal((await f.database.query("SELECT attempt_id FROM operations_discovery_coverage_cycles")).rows.length, 0);
  assert.equal((await f.service.summary()).cycles, 0);
  assert.equal(await f.service.record(value), true); assert.equal((await f.service.summary()).cycles, 1);
});

test("invalid metrics, inverted clocks, attempt IDs and target hours cannot manufacture coverage", async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  const value = f.record("2026-10-11T08:00:00.000Z", "2026-10-11T08:00:02.000Z");
  for (const changes of [{ attemptId: "arbitrary-retry-id" }, { completedAt: "2026-10-11T07:59:59.000Z" },
    { report: { ...report, searched: -1 } }, { report: { ...report, saved: 0.5 } }]) {
    await assert.rejects(f.service.record({ ...value, ...changes }), { code: "INVALID_DISCOVERY_COVERAGE" });
  }
  for (const targetHours of [0, 25, 5.5]) assert.throws(() => createDiscoveryCoverage({ database: f.database, clock: f.clock, targetHours }), { code: "INVALID_DISCOVERY_COVERAGE" });
  assert.equal((await f.service.summary()).cycles, 0);
});
