import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createContinuousDiscoveryWorker } from "./discovery-worker.ts";
import { discoveryDatabaseFixture, discoveryWorkerFixture, eventModelData, eventPageText } from "./discovery-test-fixtures.ts";

test("a successfully analyzed legacy page is reanalyzed once for registration/participation, then the upgraded prompt hash stays stable after restart", async () => {
  const fixture = await discoveryDatabaseFixture();
  try {
    const f = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1 });
    const originalUrl = "https://events.hackathon.dev/event", oldHash = createHash("sha256").update(eventPageText).digest("hex");
    const at = f.clock.now().toISOString();
    // Explicitly seed the persisted state produced by the former prompt: a
    // successfully settled result, not an unresolved model request.
    const first = await f.ledger.beginCycle({ workerId: f.dependencies.config.workerId, now: at, minimumIntervalMs: 60_000,
      leaseMs: 6000, limits: f.dependencies.config.limits, reservation: { searchCalls: 1, modelCalls: 1, estimatedCostMicros: 101 } });
    assert.ok("lease" in first);
    await f.ledger.claimUrl({ token: first.lease.token, canonicalUrl: originalUrl, now: at, recrawlAfterMs: 60_000 });
    const oldCard = await f.dependencies.candidates.save({ canonicalUrl: originalUrl, title: eventModelData.title, summary: eventModelData.summary,
      analysis: structuredClone(eventModelData.analysis), sources: [{ url: originalUrl, title: "Legacy test evidence", excerpt: eventModelData.evidence[0]!, fetchedAt: at }],
      discoveredAt: at, lastAnalyzedAt: at, provider: "dsh" });
    await f.ledger.recordUrl({ token: first.lease.token, canonicalUrl: originalUrl, now: at, contentHash: oldHash, candidateId: oldCard.id, errorCode: null });
    await f.ledger.finishCycle({ token: first.lease.token, now: at, consumed: { searchCalls: 1, modelCalls: 1, estimatedCostMicros: 11 }, errorCode: null });
    const recommendation = { recommendation: "insufficient_info" as const, reason: "报名日期和费用未提供，无法给出明确参赛判断。", suitableFor: ["愿意核实规则的新人"], cautionFor: ["时间和资格仍需确认"] };
    f.dependencies.model.request = async input => {
      f.counters.model++;
      assert.match(input.prompt, /"registration":null\|\{/);
      assert.match(input.prompt, /"participation":\{/);
      assert.match(input.prompt, /Never give matching percentages/);
      return { data: { ...structuredClone(eventModelData), registration: null, participation: recommendation }, usage: { inputTokens: 100, outputTokens: 100, estimatedCostMicros: 10, currency: "USD" } };
    };
    f.advance(60_001);
    const upgraded = await createContinuousDiscoveryWorker(f.dependencies).runOnce();
    assert.equal(upgraded.saved, 1); assert.equal(upgraded.unchanged, 0); assert.equal(upgraded.status, "completed");
    assert.equal(f.counters.model, 1, "schema upgrades require an actual model port call even when source text is unchanged");
    assert.deepEqual(f.saved.at(-1)?.participation, recommendation); assert.equal(f.saved.at(-1)?.registration, null);
    const row = (await fixture.database.query<{ content_hash: string; last_error_code: string | null }>("SELECT content_hash,last_error_code FROM operations_discovery_urls WHERE scheduler_id=$1 AND canonical_url=$2", [f.schedulerId, originalUrl])).rows[0]!;
    assert.match(row.content_hash, /^[a-f0-9]{64}$/); assert.notEqual(row.content_hash, oldHash); assert.equal(row.last_error_code, null);
    f.advance(60_001);
    // A new worker instance uses the same stable schema/prompt identity; date,
    // fetchedAt, or ordinary restarts must not generate another paid analysis.
    const restarted = await createContinuousDiscoveryWorker(f.dependencies).runOnce();
    assert.equal(restarted.unchanged, 1); assert.equal(restarted.saved, 0); assert.equal(f.counters.model, 1);
    const unchanged = (await fixture.database.query<{ content_hash: string }>("SELECT content_hash FROM operations_discovery_urls WHERE scheduler_id=$1 AND canonical_url=$2", [f.schedulerId, originalUrl])).rows[0]!;
    assert.equal(unchanged.content_hash, row.content_hash);
  } finally { await fixture.engine.close(); }
});

test("a legacy unresolved model hash remains held despite the response schema upgrade", async () => {
  const fixture = await discoveryDatabaseFixture();
  try {
    const f = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1 });
    const at = f.clock.now().toISOString(), originalUrl = "https://events.hackathon.dev/event";
    const first = await f.ledger.beginCycle({ workerId: f.dependencies.config.workerId, now: at, minimumIntervalMs: 60_000,
      leaseMs: 6000, limits: f.dependencies.config.limits, reservation: { searchCalls: 1, modelCalls: 1, estimatedCostMicros: 101 } });
    assert.ok("lease" in first);
    await f.ledger.claimUrl({ token: first.lease.token, canonicalUrl: originalUrl, now: at, recrawlAfterMs: 60_000 });
    await f.ledger.recordUrl({ token: first.lease.token, canonicalUrl: originalUrl, now: at, contentHash: createHash("sha256").update(eventPageText).digest("hex"), candidateId: null, errorCode: "DISCOVERY_MODEL_REQUIRES_REVIEW" });
    await f.ledger.finishCycle({ token: first.lease.token, now: at, consumed: { searchCalls: 1, modelCalls: 1, estimatedCostMicros: 101 }, errorCode: "DISCOVERY_MODEL_REQUIRES_REVIEW" });
    f.advance(60_001);
    const report = await createContinuousDiscoveryWorker(f.dependencies).runOnce();
    assert.equal(report.status, "failed"); assert.equal(report.reason, "DISCOVERY_MODEL_REQUIRES_REVIEW");
    assert.equal(report.fetched, 0); assert.equal(report.saved, 0); assert.equal(report.unchanged, 0); assert.equal(f.counters.model, 0);
    assert.equal((await f.ledger.readState()).estimatedCostMicros, 102, "the original unknown model cost cannot be released by a new response schema");
  } finally { await fixture.engine.close(); }
});
