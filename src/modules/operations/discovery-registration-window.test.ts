import assert from "node:assert/strict";
import test from "node:test";
import { createContinuousDiscoveryWorker } from "./discovery-worker.ts";
import { discoveryDatabaseFixture, discoveryWorkerFixture, eventModelData, eventPageText, eventRegistrationEvidence } from "./discovery-test-fixtures.ts";
import { normalizeRegistrationWindow } from "../../shared/registration-window.ts";

test("worker retains every analyzed event and does not repeatedly charge unchanged pages", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const cases = [
    { name: "future event with past registration", text: "Event starts 2027-01-30. Registration closes 2026-07-26T18:00:00Z.", window: { status: "open", closesAt: "2026-07-26T18:00:00Z", closesOn: null, evidence: ["Registration closes 2026-07-26T18:00:00Z."] }, saved: 1 },
    { name: "missing registration info", text: "The future hackathon starts 2027-01-30. No application date was specified.", window: undefined, saved: 1 },
    { name: "open without cutoff", text: "Registration is open.", window: { status: "open", closesAt: null, closesOn: null, evidence: ["Registration is open."] }, saved: 1 },
    { name: "submission is not registration", text: "Submission deadline: 2026-10-30.", window: { status: "open", closesAt: null, closesOn: "2026-10-30", evidence: ["Submission deadline: 2026-10-30."] }, saved: 1 },
    { name: "fake registration evidence", text: "Registration is open.", window: { status: "open", closesAt: null, closesOn: "2026-10-30", evidence: ["Registration closes 2026-10-30."] }, saved: 1 },
    { name: "date-only open", text: "报名截止日期：2026年10月30日。", window: { status: "open", closesAt: null, closesOn: "2026-10-30", evidence: ["报名截止日期：2026年10月30日。"] }, saved: 1 },
    { name: "explicit offset open", text: "Registration closes 2026-10-30T18:00:00+08:00.", window: { status: "open", closesAt: "2026-10-30T18:00:00+08:00", closesOn: null, evidence: ["Registration closes 2026-10-30T18:00:00+08:00."] }, saved: 1 },
  ] as const;
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const f = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1 });
    const body = `${eventPageText}\n${scenario.text}`;
    f.dependencies.transport.request = async input => ({ status: 200, connectedAddress: "93.184.216.34", contentType: "text/plain", body: new URL(input.url).pathname === "/robots.txt" ? "User-agent: *\nAllow: /" : body });
    f.dependencies.model.request = async input => {
      f.counters.model++;
      assert.equal((input.input as { now: string }).now, f.clock.now().toISOString());
      assert.match(input.prompt, /Submission\/deliverable\/demo deadlines/); assert.match(input.prompt, /Upcoming Events/);
      return { data: { ...eventModelData, registrationWindow: scenario.window }, usage: { inputTokens: 10, outputTokens: 10, estimatedCostMicros: 10, currency: "USD" } };
    };
    const report = await createContinuousDiscoveryWorker(f.dependencies).runOnce();
    assert.equal(report.status, "completed"); assert.equal(report.saved, scenario.saved); assert.equal(f.counters.model, 1);
    assert.equal((await f.ledger.readState()).estimatedCostMicros, 11);
    assert.equal(f.saved.length, 1);
    if (f.saved[0]!.registrationWindow) assert.ok(f.saved[0]!.registrationWindow.evidence.every(quote => f.saved[0]!.sources.some(source => source.excerpt === quote)));
    f.advance(60_001); const unchanged = await createContinuousDiscoveryWorker(f.dependencies).runOnce();
    assert.equal(unchanged.unchanged, 1); assert.equal(f.counters.model, 1, "unchanged rejected evidence must not repeatedly incur a model request");
  });
});

test("unchanged source after registration expiry does not trigger another paid analysis", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const f = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1 });
  assert.equal((await f.worker.runOnce()).saved, 1);
  f.advance(23 * 86_400_000);
  const report = await createContinuousDiscoveryWorker(f.dependencies).runOnce();
  assert.equal(report.unchanged, 1); assert.equal(report.saved, 0); assert.equal(f.counters.model, 1);
});

test("closed analyses are saved as cards instead of being removed from the feed", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  for (const exists of [true, false]) await t.test(exists ? "existing open card" : "new closed URL", async () => {
    const f = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1 });
    if (exists) { assert.equal((await f.worker.runOnce()).saved, 1); f.advance(60_001); }
    // The fixture database is shared, so give a new closed URL its own identity.
    if (!exists) f.searchResults[0]!.url = "https://events.hackathon.dev/new-closed-url";
    f.dependencies.transport.request = async input => ({ status: 200, connectedAddress: "93.184.216.34", contentType: "text/plain", body: new URL(input.url).pathname === "/robots.txt" ? "User-agent: *\nAllow: /" : `${eventPageText}\nRegistration is closed.` });
    f.dependencies.model.request = async () => { f.counters.model++; return { data: { ...eventModelData, registrationWindow: { ...eventModelData.registrationWindow, evidence: [eventRegistrationEvidence, "Registration is closed."] } }, usage: { inputTokens: 10, outputTokens: 10, estimatedCostMicros: 10, currency: "USD" } }; };
    const report = await createContinuousDiscoveryWorker(f.dependencies).runOnce();
    assert.equal(report.status, "completed"); assert.equal(report.saved, 1);
    if (exists) {
      const row = (await fixture.database.query<{ revision: number; payload: { registrationWindow: { status: string } } }>("SELECT revision,payload FROM fixture_discovery_cards WHERE canonical_url=$1", ["https://events.hackathon.dev/event"])).rows[0]!;
      assert.equal(row.revision, 2); assert.equal(row.payload.registrationWindow.status, "closed");
    }
    const attempts = (await fixture.database.query<{ last_error_code: string }>("SELECT last_error_code FROM operations_discovery_urls WHERE scheduler_id=$1", [f.schedulerId])).rows;
    assert.ok(attempts.every(row => row.last_error_code === null));
    const paid = f.counters.model; f.advance(60_001); assert.equal((await createContinuousDiscoveryWorker(f.dependencies).runOnce()).unchanged, 1); assert.equal(f.counters.model, paid);
  });
});

test("official-style partial-date table keeps annual evidence for server verification without fabricating a timezone", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const f = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1 });
  const evidence = "9/16（三）- 10/30（五）23:59 截止 書審報名";
  const page = `115年正式期程\n${eventPageText.split("Registration")[0]}\n${evidence}\n©2026 115新竹政策黑客松`;
  f.dependencies.transport.request = async input => ({ status: 200, connectedAddress: "93.184.216.34", contentType: "text/plain", body: new URL(input.url).pathname === "/robots.txt" ? "User-agent: *\nAllow: /" : page });
  f.dependencies.model.request = async () => ({ data: { ...eventModelData, registrationWindow: { status: "open", closesAt: null, closesOn: "2026-10-30", evidence: [evidence] } }, usage: { inputTokens: 10, outputTokens: 10, estimatedCostMicros: 10, currency: "USD" } });
  assert.equal((await createContinuousDiscoveryWorker(f.dependencies).runOnce()).saved, 1);
  const card = f.saved[0]!; assert.equal(card.registrationWindow?.closesAt, null); assert.equal(card.registrationWindow?.closesOn, "2026-10-30");
  assert.ok(card.sources.some(source => source.excerpt.includes("115年正式期程")));
  assert.deepEqual(normalizeRegistrationWindow(card.registrationWindow, { texts: card.sources.map(source => source.excerpt), checkedAt: card.lastAnalyzedAt }), card.registrationWindow, "retained same-source annual evidence lets durable storage revalidate the partial date");
});

test("a future event may be shown when the registration cutoff is still unknown", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const f = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1 });
  const registrationEvidence = "Registration is open, but the application deadline is not specified.";
  const eventEvidence = "Hackathon starts 2027-01-30.";
  f.dependencies.transport.request = async input => ({ status: 200, connectedAddress: "93.184.216.34", contentType: "text/plain", body: new URL(input.url).pathname === "/robots.txt" ? "User-agent: *\nAllow: /" : `${eventPageText}\n${registrationEvidence}\n${eventEvidence}` });
  f.dependencies.model.request = async () => ({ data: { ...eventModelData, registrationWindow: { status: "unknown", closesAt: null, closesOn: null, evidence: [registrationEvidence] }, eventWindow: { status: "future", startsAt: null, startsOn: "2027-01-30", evidence: [eventEvidence] } }, usage: { inputTokens: 10, outputTokens: 10, estimatedCostMicros: 10, currency: "USD" } });
  const report = await f.worker.runOnce();
  assert.equal(report.saved, 1);
  assert.equal(f.saved[0]?.registrationWindow?.status, "unknown");
  assert.equal(f.saved[0]?.eventWindow?.startsOn, "2027-01-30");
});
