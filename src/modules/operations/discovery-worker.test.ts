import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { DomainError } from "../../shared/errors.ts";
import { canonicalDiscoveryUrl, createContinuousDiscoveryWorker, discoveryPageText } from "./discovery-worker.ts";
import { discoveryDatabaseFixture, discoveryWorkerFixture, eventModelData, eventPageText, eventRegistrationEvidence } from "./discovery-test-fixtures.ts";
import { createOfficialSourceProvider } from "./official-sources.ts";
import type { PublicSearchPort, PublicSearchResult } from "./discovery-types.ts";

test("discovery worker with actual PostgreSQL quota/dedupe transactions", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  await t.test("searched and fetched evidence yields one durable DSH card; unchanged pages skip the next model call", async () => {
    const f = discoveryWorkerFixture(fixture.database);
    const report = await f.worker.runOnce();
    assert.equal(report.status, "completed"); assert.equal(report.saved, 1);
    assert.equal(f.saved[0]?.provider, "dsh"); assert.equal(f.saved[0]?.canonicalUrl, "https://events.hackathon.dev/event");
    assert.equal("verificationStatus" in f.saved[0]!, false); assert.deepEqual(f.saved[0]?.sources.map(source => source.excerpt), [...eventModelData.evidence, eventRegistrationEvidence]);
    assert.equal(f.fetches[0], "https://events.hackathon.dev/robots.txt");
    assert.equal((await f.ledger.readState()).estimatedCostMicros, 11);
    f.advance(60_001);
    const next = await f.worker.runOnce(); assert.equal(next.unchanged, 1); assert.equal(next.saved, 0); assert.equal(f.counters.model, 1);
  });
  await t.test("URLs are deduplicated before fetching and a repeated trigger obeys the persisted interval", async () => {
    const f = discoveryWorkerFixture(fixture.database);
    f.searchResults.push({ ...f.searchResults[0]!, url: "https://events.hackathon.dev/event?utm_source=duplicate" });
    assert.equal((await f.worker.runOnce()).saved, 1);
    const skip = await f.worker.runOnce(); assert.equal(skip.reason, "not_due"); assert.equal(f.counters.search, 1); assert.equal(f.counters.model, 1);
  });
  await t.test("private DNS and login URLs never reach a page transport or create a card", async () => {
    const f = discoveryWorkerFixture(fixture.database);
    f.dependencies.dns.resolve = async () => ["127.0.0.1"];
    const report = await createContinuousDiscoveryWorker(f.dependencies).runOnce();
    assert.equal(report.status, "failed"); assert.equal(report.saved, 0); assert.equal(f.fetches.length, 0); assert.equal(f.counters.model, 0);
    assert.throws(() => canonicalDiscoveryUrl("https://events.hackathon.dev/login"), { code: "DISCOVERY_LOGIN_WALL" });
    assert.throws(() => canonicalDiscoveryUrl("https://events.hackathon.dev/event?access_token=secret"), { code: "DISCOVERY_LOGIN_WALL" });
  });
  await t.test("robots denial and a fabricated evidence excerpt produce explicit failed reports", async () => {
    const f = discoveryWorkerFixture(fixture.database);
    f.dependencies.transport.request = async input => ({ status: 200, connectedAddress: "93.184.216.34", contentType: "text/plain", body: new URL(input.url).pathname === "/robots.txt" ? "User-agent: *\nDisallow: /" : "unreachable content" });
    const denied = await createContinuousDiscoveryWorker(f.dependencies).runOnce();
    assert.equal(denied.reason, "ROBOTS_DISALLOWED"); assert.equal(f.counters.model, 0);
    const fake = discoveryWorkerFixture(fixture.database);
    fake.dependencies.model.request = async () => ({ data: { ...eventModelData, evidence: ["Made-up official deadline"] }, usage: { inputTokens: 10, outputTokens: 10, estimatedCostMicros: 1, currency: "USD" } });
    const report = await createContinuousDiscoveryWorker(fake.dependencies).runOnce();
    assert.equal(report.reason, "DISCOVERY_EVIDENCE_INVALID"); assert.equal(fake.saved.length, 0);
  });
  await t.test("fetch-only failure can be retried without fabricating a model-attempt hash", async () => {
    const f = discoveryWorkerFixture(fixture.database);
    const originalTransport = f.dependencies.transport.request;
    f.dependencies.transport.request = async input => ({ status: 200, connectedAddress: "93.184.216.34", contentType: "text/plain", body: new URL(input.url).pathname === "/robots.txt" ? "User-agent: *\nDisallow: /" : eventPageText });
    assert.equal((await createContinuousDiscoveryWorker(f.dependencies).runOnce()).reason, "ROBOTS_DISALLOWED");
    const row = (await fixture.database.query<{ content_hash: string | null; last_error_code: string | null; last_completed_at: string | null }>("SELECT content_hash,last_error_code,last_completed_at FROM operations_discovery_urls WHERE scheduler_id=$1", [f.schedulerId])).rows[0]!;
    assert.equal(row.content_hash, null); assert.equal(row.last_error_code, "ROBOTS_DISALLOWED"); assert.equal(row.last_completed_at, null);
    f.advance(60_001); f.dependencies.transport.request = originalTransport;
    assert.equal((await createContinuousDiscoveryWorker(f.dependencies).runOnce()).saved, 1); assert.equal(f.counters.model, 1);
  });
  await t.test("an unresolved URL stays failed during cooldown even when another URL produces a card", async () => {
    const f = discoveryWorkerFixture(fixture.database, { recrawlAfterMs: 120_000 });
    const model = f.dependencies.model.request;
    f.dependencies.model.request = async () => { throw new DomainError("DSH_TRANSPORT_FAILED", "fixture uncertain response"); };
    assert.equal((await createContinuousDiscoveryWorker(f.dependencies).runOnce()).status, "failed");
    f.dependencies.model.request = model;
    f.searchResults.push({ ...f.searchResults[0]!, url: "https://events.hackathon.dev/another-event" });
    f.advance(60_001);
    const mixed = await createContinuousDiscoveryWorker(f.dependencies).runOnce();
    assert.equal(mixed.status, "failed"); assert.equal(mixed.reason, "DISCOVERY_MODEL_REQUIRES_REVIEW");
    assert.equal(mixed.saved, 1); assert.equal(mixed.rejected, 1); assert.equal(f.counters.model, 1, "only the new URL invokes the model");
    assert.equal((await f.ledger.readState()).lastErrorCode, "DISCOVERY_MODEL_REQUIRES_REVIEW");
  });
  await t.test("model unconfigured and exceeded cost reservations never report a saved card", async () => {
    const f = discoveryWorkerFixture(fixture.database);
    f.dependencies.model.request = async () => { throw new DomainError("DSH_UNCONFIGURED", "未配置", { status: 503 }); };
    assert.equal((await createContinuousDiscoveryWorker(f.dependencies).runOnce()).reason, "DSH_UNCONFIGURED"); assert.equal(f.saved.length, 0);
    const expensive = discoveryWorkerFixture(fixture.database);
    expensive.dependencies.model.request = async () => ({ data: eventModelData, usage: { inputTokens: 10, outputTokens: 10, estimatedCostMicros: 101, currency: "USD" } });
    const report = await createContinuousDiscoveryWorker(expensive.dependencies).runOnce();
    assert.equal(report.reason, "DISCOVERY_BUDGET_EXCEEDED"); assert.equal(expensive.saved.length, 0);
    assert.equal((await expensive.ledger.readState()).estimatedCostMicros, 102);
  });
  await t.test("model output upper bounds match the durable card contract and oversized evidence is rejected intact", async () => {
    for (const field of ["title", "summary", "evidence"] as const) {
      const f = discoveryWorkerFixture(fixture.database), excerpt = "e".repeat(501);
      const transport = f.dependencies.transport.request;
      f.dependencies.transport.request = async input => {
        const response = await transport(input); return { ...response, body: new URL(input.url).pathname === "/robots.txt" ? response.body : `${response.body}\n${excerpt}` };
      };
      f.dependencies.model.request = async input => {
        f.counters.model++;
        assert.match(input.prompt, /Title <=200 characters, summary <=1200/u); assert.match(input.prompt, /at most 500 characters/u);
        return { data: { ...eventModelData, ...(field === "title" ? { title: "t".repeat(201) } : field === "summary" ? { summary: "s".repeat(1201) } : { evidence: [excerpt] }) },
          usage: { inputTokens: 10, outputTokens: 10, estimatedCostMicros: 10, currency: "USD" } };
      };
      const report = await createContinuousDiscoveryWorker(f.dependencies).runOnce();
      assert.equal(report.reason, "DISCOVERY_SCHEMA_INVALID"); assert.equal(report.saved, 0); assert.equal(f.saved.length, 0);
      f.advance(60_001); await createContinuousDiscoveryWorker(f.dependencies).runOnce();
      assert.equal(f.counters.model, 1, "a paid invalid response is retained for manual review rather than resent");
    }
    const accepted = discoveryWorkerFixture(fixture.database), excerpt = "e".repeat(500), transport = accepted.dependencies.transport.request;
    accepted.searchResults[0]!.title = "metadata".repeat(40);
    accepted.dependencies.transport.request = async input => {
      const response = await transport(input); return { ...response, body: new URL(input.url).pathname === "/robots.txt" ? response.body : `${response.body}\n${excerpt}` };
    };
    accepted.dependencies.model.request = async () => ({ data: { ...eventModelData, title: "t".repeat(200), summary: "s".repeat(1200), evidence: [excerpt] },
      usage: { inputTokens: 10, outputTokens: 10, estimatedCostMicros: 10, currency: "USD" } });
    assert.equal((await createContinuousDiscoveryWorker(accepted.dependencies).runOnce()).saved, 1);
    assert.equal(accepted.saved[0]!.title.length, 200); assert.equal(accepted.saved[0]!.summary.length, 1200);
    assert.equal(accepted.saved[0]!.sources[0]!.title.length, 200); assert.equal(accepted.saved[0]!.sources[0]!.excerpt, excerpt, "verbatim model evidence is preserved rather than silently truncated");
  });
  await t.test("pause is admin-only and aborts a stuck model without producing a candidate", async () => {
    const f = discoveryWorkerFixture(fixture.database); let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    f.dependencies.model.request = async () => { started(); return new Promise(() => {}); };
    const worker = createContinuousDiscoveryWorker(f.dependencies);
    await assert.rejects(worker.setPaused({ userId: "ordinary", platformRoles: ["user"] }, { expectedRevision: 1, paused: true }), { code: "SOURCE_ADMIN_REQUIRED" });
    const running = worker.runOnce(); await ready;
    await worker.setPaused({ userId: "admin", platformRoles: ["admin"] }, { expectedRevision: (await f.ledger.readState()).revision, paused: true });
    const report = await running; assert.equal(report.status, "cancelled"); assert.equal(f.saved.length, 0);
    assert.equal((await worker.runOnce()).reason, "paused");
  });
  await t.test("loop honors caller cancellation after a bounded cycle and database failure is an explicit report", async () => {
    const f = discoveryWorkerFixture(fixture.database); const controller = new AbortController(); let cycles = 0;
    await f.worker.loop({ signal: controller.signal, onCycle: () => { cycles++; controller.abort(); } });
    assert.equal(cycles, 1);
    const unavailable = createContinuousDiscoveryWorker({ ...f.dependencies, ledger: { ...f.ledger,
      beginCycle: async () => { throw new DomainError("DATABASE_UNAVAILABLE", "数据库不可用", { status: 503 }); },
      claimSearch: f.ledger.claimSearch.bind(f.ledger), recordSearch: f.ledger.recordSearch.bind(f.ledger),
      assertCycle: f.ledger.assertCycle.bind(f.ledger), commitCandidate: f.ledger.commitCandidate.bind(f.ledger), claimUrl: f.ledger.claimUrl.bind(f.ledger),
      recordUrl: f.ledger.recordUrl.bind(f.ledger), finishCycle: f.ledger.finishCycle.bind(f.ledger), readState: f.ledger.readState.bind(f.ledger), setPaused: f.ledger.setPaused.bind(f.ledger) } });
    assert.equal((await unavailable.runOnce()).reason, "DATABASE_UNAVAILABLE");
  });
  function officialFixture(maxPagesPerCycle = 2) {
    const f = discoveryWorkerFixture(fixture.database, { queries: ["ethglobal", "lablab"], maxPagesPerCycle, maxResultsPerQuery: 3, searchCostMicrosPerCall: 0, recrawlAfterMs: 120_000 });
    const ethHtml = `<h2>Upcoming Events</h2>${["alpha", "beta", "gamma"].map(slug => `<a href="/events/${slug}"><span>IRL Hackathon</span><h3>ETHGlobal ${slug}</h3></a>`).join("")}<h2>Past Events</h2>`;
    const labHtml = ["alpha", "beta", "gamma"].map(slug => `<a href="/ai-hackathons/${slug}"><span>Register</span><h3>lablab ${slug}</h3></a>`).join("");
    f.dependencies.transport.request = async input => {
      f.fetches.push(input.url); const url = new URL(input.url);
      return { status: 200, connectedAddress: "93.184.216.34", contentType: url.pathname === "/robots.txt" ? "text/plain" : "text/html",
        body: url.pathname === "/robots.txt" ? "User-agent: *\nAllow: /" : url.pathname === "/events" ? ethHtml : url.pathname === "/ai-hackathons" ? labHtml : `<main>${eventPageText}</main>` };
    };
    const provider = createOfficialSourceProvider({ sourceIds: ["ethglobal", "lablab"], userAgent: f.dependencies.config.userAgent,
      timeoutMs: f.dependencies.config.fetchTimeoutMs, maxBytes: f.dependencies.config.maxPageBytes, dns: f.dependencies.dns, transport: f.dependencies.transport });
    const worker = () => createContinuousDiscoveryWorker({ ...f.dependencies, search: provider });
    return { ...f, provider, worker };
  }
  await t.test("official sources interleave details fairly and cooling prefixes never consume detail slots", async () => {
    const f = officialFixture();
    const first = await f.worker().runOnce(); assert.equal(first.saved, 2); assert.equal(first.fetched, 2);
    assert.deepEqual(f.saved.map(card => card.canonicalUrl), ["https://ethglobal.com/events/alpha", "https://lablab.ai/ai-hackathons/alpha"]);
    const state = await f.ledger.readState(); assert.equal(state.searchCalls, 2); assert.equal(state.modelCalls, 2); assert.equal(state.estimatedCostMicros, 20, "official checks have no search-provider fee; only measured model estimates remain");
    f.advance(60_001);
    const second = await f.worker().runOnce(); assert.equal(second.saved, 2); assert.equal(second.fetched, 2); assert.equal(second.unchanged, 2);
    assert.deepEqual(f.saved.slice(2).map(card => card.canonicalUrl), ["https://lablab.ai/ai-hackathons/beta", "https://ethglobal.com/events/beta"]);
    assert.equal(f.counters.model, 4);
  });
  await t.test("a one-detail budget rotates first source using persisted check rounds", async () => {
    const f = officialFixture(1);
    await f.worker().runOnce(); f.advance(120_001);
    // A fresh worker object observes the durable round count rather than resetting fairness.
    await f.worker().runOnce();
    assert.deepEqual(f.saved.map(card => card.canonicalUrl), ["https://ethglobal.com/events/alpha", "https://lablab.ai/ai-hackathons/alpha"]);
    assert.equal(f.counters.model, 2);
  });
  await t.test("one official listing rule failure remains visible while another approved source progresses", async () => {
    const f = officialFixture(1), transport = f.dependencies.transport.request;
    f.dependencies.transport.request = async input => new URL(input.url).pathname === "/events"
      ? { status: 200, connectedAddress: "93.184.216.34", contentType: "text/html", body: "<h2>Different page structure</h2>" } : transport(input);
    const report = await f.worker().runOnce(); assert.equal(report.saved, 1); assert.equal(report.errors[0]?.code, "OFFICIAL_SOURCE_RULES_CHANGED");
    assert.equal(f.saved[0]!.canonicalUrl, "https://lablab.ai/ai-hackathons/alpha");
    const state = await f.ledger.readState(); assert.equal(state.searchCalls, 2); assert.equal(state.modelCalls, 1); assert.equal(state.estimatedCostMicros, 10);
  });
  await t.test("official detail redirects allow the same event on canonical www and recheck robots", async () => {
    const f = officialFixture(1), transport = f.dependencies.transport.request;
    f.dependencies.transport.request = async input => {
      const url = new URL(input.url);
      if (url.hostname === "ethglobal.com" && url.pathname === "/events/alpha") {
        f.fetches.push(input.url); return { status: 301, connectedAddress: "93.184.216.34", contentType: "text/html", body: "", location: "https://www.ethglobal.com/events/alpha/" };
      }
      return transport(input);
    };
    const report = await f.worker().runOnce(); assert.equal(report.saved, 1); assert.equal(f.counters.model, 1);
    assert.ok(f.fetches.includes("https://www.ethglobal.com/robots.txt")); assert.ok(f.fetches.includes("https://www.ethglobal.com/events/alpha/"));
  });
  await t.test("official detail policy blocks sibling or external redirects before another page or model is read", async () => {
    for (const location of ["/events/private-sibling", "https://evil.org/events/alpha"]) {
      const f = officialFixture(1), transport = f.dependencies.transport.request;
      f.dependencies.transport.request = async input => new URL(input.url).pathname === "/events/alpha"
        ? { status: 302, connectedAddress: "93.184.216.34", contentType: "text/html", body: "", location } : transport(input);
      const report = await f.worker().runOnce(); assert.equal(report.saved, 0); assert.equal(f.counters.model, 0); assert.ok(report.errors.some(error => error.code === "UNSAFE_SOURCE_URL"));
      assert.equal(f.fetches.some(url => url.includes("private-sibling") || url.includes("evil.org")), false);
      assert.equal((await f.ledger.readState()).modelCalls, 0);
    }
  });
});

test("single-page paid discovery shares durable slots between fresh search and stored updates", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const oldUrl = "https://events.hackathon.dev/stored-fairness";
  const oldHint = { url: oldUrl, title: "Stored hint", description: "OLD_METADATA_MUST_NOT_BECOME_EVIDENCE" };
  function paidSearch(f: ReturnType<typeof discoveryWorkerFixture>, results: () => readonly PublicSearchResult[], interleave = true): PublicSearchPort {
    return { modelCallsPerSearch: 1, requestIdentity: "single-page-fairness-fixture-v1", ...(interleave ? { resultOrdering: "interleave" as const } : {}),
      async search() { f.counters.search++; return { results: results(), usage: { inputTokens: 100, outputTokens: 100, estimatedCostMicros: 25, currency: "USD" } }; } };
  }
  for (const interleave of [true, false]) await t.test(`fresh worker objects alternate ${interleave ? "interleaved" : "plain"} native results with real stored-card revisions`, async () => {
    const f = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1, searchCostMicrosPerCall: 100 });
    const caseOldUrl = `${oldUrl}-${interleave ? "interleaved" : "plain"}`;
    const caseHint = { ...oldHint, url: caseOldUrl };
    const at = f.clock.now().toISOString();
    await f.dependencies.candidates.save({ canonicalUrl: caseOldUrl, title: eventModelData.title, summary: eventModelData.summary,
      analysis: structuredClone(eventModelData.analysis), sources: [{ url: caseOldUrl, title: "Old source", excerpt: eventModelData.evidence[0], fetchedAt: at }],
      discoveredAt: at, lastAnalyzedAt: at, provider: "dsh" });
    f.saved.length = 0;
    const transport = f.dependencies.transport.request;
    f.dependencies.transport.request = async input => {
      const response = await transport(input);
      return { ...response, body: input.url === caseOldUrl && f.counters.search === 4 ? `${response.body}\nUpdated official preparation information.` : response.body };
    };
    const search = paidSearch(f, () => [{ url: `https://events.hackathon.dev/new-${f.counters.search}`, title: "Fresh search", description: "Current native hint" }], interleave);
    for (let round = 0; round < 4; round++) {
      const worker = createContinuousDiscoveryWorker({ ...f.dependencies, search, existingCandidates: async () => [caseHint] });
      const report = await worker.runOnce();
      assert.equal(report.searched, 1); assert.equal(report.fetched, 1); assert.equal(report.saved, 1);
      assert.equal(report.status, "completed"); f.advance(60_001);
    }
    assert.deepEqual(f.saved.map(card => card.canonicalUrl), ["https://events.hackathon.dev/new-1", caseOldUrl, "https://events.hackathon.dev/new-3", caseOldUrl]);
    assert.equal((await fixture.database.query<{ revision: number }>("SELECT revision FROM fixture_discovery_cards WHERE canonical_url=$1", [caseOldUrl])).rows[0].revision, 3);
    assert.equal(f.counters.model, 4);
    const state = await f.ledger.readState(); assert.equal(state.searchCalls, 4); assert.equal(state.modelCalls, 8); assert.equal(state.estimatedCostMicros, 140);
  });
  await t.test("a same-URL stored hint retains only this search's real citation on the native-first round", async () => {
    const f = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1, searchCostMicrosPerCall: 100 });
    f.dependencies.transport.request = async () => { throw new DomainError("FETCH_UNAVAILABLE", "isolated source unavailable"); };
    const search = paidSearch(f, () => [{ ...oldHint, url: `${oldUrl}?utm_source=current-native`, indexedExcerpt: eventPageText }]);
    const report = await createContinuousDiscoveryWorker({ ...f.dependencies, search,
      existingCandidates: async () => [{ ...oldHint, indexedExcerpt: "OLD_INDEXED_EXCERPT_MUST_NOT_BE_USED" }] }).runOnce();
    assert.equal(report.saved, 1); assert.equal(report.fetched, 0); assert.equal(f.counters.model, 1);
    assert.equal(f.saved[0].canonicalUrl, oldUrl); assert.equal(f.saved[0].sources[0].sourceKind, "indexed_excerpt");
    assert.equal(f.saved[0].sources[0].excerpt, eventModelData.evidence[0]);
    assert.doesNotMatch(JSON.stringify(f.saved[0]), /OLD_INDEXED_EXCERPT|OLD_METADATA/);
  });
  await t.test("no native results still revisit stored URLs without reusing their old summaries as citations", async () => {
    const f = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1, searchCostMicrosPerCall: 100 });
    f.dependencies.transport.request = async () => { throw new DomainError("FETCH_UNAVAILABLE", "isolated source unavailable"); };
    const search = paidSearch(f, () => []);
    const report = await createContinuousDiscoveryWorker({ ...f.dependencies, search,
      existingCandidates: async () => [{ ...oldHint, description: eventPageText, indexedExcerpt: eventPageText }] }).runOnce();
    assert.equal(report.reason, "FETCH_UNAVAILABLE"); assert.equal(report.saved, 0); assert.equal(f.counters.model, 0);
    assert.equal((await f.ledger.readState()).estimatedCostMicros, 25, "only the actual search is settled; unused analysis allowance is released");
    const claimed = (await fixture.database.query<{ canonical_url: string; content_hash: string | null }>("SELECT canonical_url,content_hash FROM operations_discovery_urls WHERE scheduler_id=$1", [f.schedulerId])).rows[0];
    assert.equal(claimed.canonical_url, oldUrl); assert.equal(claimed.content_hash, null);
  });
  await t.test("native-first same-URL merging preserves the stored official event's approved www redirect policy", async () => {
    const f = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1, searchCostMicrosPerCall: 100 });
    const url = "https://ethglobal.com/events/fairness";
    const transport = f.dependencies.transport.request;
    f.dependencies.transport.request = async input => {
      if (input.url === url) return { status: 301, connectedAddress: "93.184.216.34", contentType: "text/html", body: "", location: "https://www.ethglobal.com/events/fairness/" };
      const response = await transport(input);
      return new URL(input.url).pathname === "/robots.txt" ? response : { ...response, contentType: "text/html", body: `<p>${response.body}</p>` };
    };
    const search = paidSearch(f, () => [{ url, title: "Fresh official result", description: "Current metadata" }]);
    const report = await createContinuousDiscoveryWorker({ ...f.dependencies, search,
      existingCandidates: async () => [{ url, title: "Old official hint", description: "Old official metadata" }] }).runOnce();
    assert.equal(report.saved, 1); assert.equal(report.fetched, 1); assert.equal(f.counters.model, 1);
    assert.ok(f.fetches.includes("https://www.ethglobal.com/robots.txt")); assert.ok(f.fetches.includes("https://www.ethglobal.com/events/fairness/"));
    assert.equal(f.saved[0].sources[0].url, "https://www.ethglobal.com/events/fairness/");
  });
});

test("unknown or invalid model outcomes survive a real database close/reopen and hold the URL even when content changes", async t => {
  for (const failure of ["unknown", "invalid_json", "invalid_evidence"] as const) {
    await t.test(failure, async () => {
      const directory = await mkdtemp(join(tmpdir(), "discovery-restart-fixture-"));
      let fixture: Awaited<ReturnType<typeof discoveryDatabaseFixture>> | null = null;
      try {
        fixture = await discoveryDatabaseFixture(join(directory, "postgres"));
        const first = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1, recrawlAfterMs: 120_000 });
        let modelCalls = 0;
        first.dependencies.model.request = async () => {
          modelCalls++;
          const started = (await fixture!.database.query<{ content_hash: string | null; last_error_code: string | null; last_completed_at: string | null }>("SELECT content_hash,last_error_code,last_completed_at FROM operations_discovery_urls WHERE scheduler_id=$1", [first.schedulerId])).rows[0]!;
          assert.match(started.content_hash!, /^[a-f0-9]{64}$/); assert.equal(started.last_error_code, "DISCOVERY_MODEL_REQUIRES_REVIEW"); assert.equal(started.last_completed_at, null);
          if (failure !== "invalid_evidence") throw new DomainError(failure === "unknown" ? "DSH_TRANSPORT_FAILED" : "DSH_INVALID_JSON", "fixture uncertain response");
          return { data: { ...eventModelData, evidence: ["invented evidence"] }, usage: { inputTokens: 10, outputTokens: 10, estimatedCostMicros: 10, currency: "USD" } };
        };
        const failed = await createContinuousDiscoveryWorker(first.dependencies).runOnce();
        assert.equal(failed.status, "failed"); assert.equal(failed.saved, 0); assert.equal(modelCalls, 1);
        assert.equal((await first.ledger.readState()).estimatedCostMicros, failure === "invalid_evidence" ? 11 : 101, "unknown fees retain their reservation; invalid responses with measured usage retain measured fees");
        const attempted = (await fixture.database.query<{ content_hash: string; last_error_code: string | null; last_completed_at: string | null }>("SELECT content_hash,last_error_code,last_completed_at FROM operations_discovery_urls WHERE scheduler_id=$1", [first.schedulerId])).rows[0]!;
        assert.equal(attempted.last_error_code, "DISCOVERY_MODEL_REQUIRES_REVIEW"); assert.equal(attempted.last_completed_at, null);
        await fixture.engine.close(); fixture = null;

        fixture = await discoveryDatabaseFixture(join(directory, "postgres"));
        const restarted = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1, recrawlAfterMs: 120_000 }, first.schedulerId);
        restarted.advance(60_001);
        const cooldown = await restarted.worker.runOnce();
        assert.equal(cooldown.status, "failed"); assert.equal(cooldown.reason, "DISCOVERY_MODEL_REQUIRES_REVIEW");
        assert.equal(cooldown.fetched, 0); assert.equal(cooldown.unchanged, 0); assert.equal(restarted.counters.model, 0);
        assert.equal((await restarted.ledger.readState()).lastErrorCode, "DISCOVERY_MODEL_REQUIRES_REVIEW");
        restarted.advance(86_340_000);
        const repeated = await restarted.worker.runOnce();
        assert.equal(repeated.status, "failed"); assert.equal(repeated.reason, "DISCOVERY_MODEL_REQUIRES_REVIEW");
        assert.equal(repeated.fetched, 0); assert.equal(repeated.unchanged, 0); assert.equal(repeated.saved, 0); assert.equal(restarted.counters.model, 0);
        assert.equal((await restarted.ledger.readState()).modelCalls, 0);

        // A temporary page/DNS failure must not overwrite the pending model outcome.
        const dns = restarted.dependencies.dns.resolve;
        restarted.advance(120_001); restarted.dependencies.dns.resolve = async () => ["127.0.0.1"];
        await createContinuousDiscoveryWorker(restarted.dependencies).runOnce();
        const retained = (await fixture.database.query<{ content_hash: string; last_error_code: string | null; last_completed_at: string | null }>("SELECT content_hash,last_error_code,last_completed_at FROM operations_discovery_urls WHERE scheduler_id=$1", [first.schedulerId])).rows[0]!;
        assert.equal(retained.content_hash, attempted.content_hash); assert.equal(retained.last_error_code, "DISCOVERY_MODEL_REQUIRES_REVIEW"); assert.equal(retained.last_completed_at, null);
        restarted.advance(120_001); restarted.dependencies.dns.resolve = dns;
        assert.equal((await createContinuousDiscoveryWorker(restarted.dependencies).runOnce()).reason, "DISCOVERY_MODEL_REQUIRES_REVIEW"); assert.equal(restarted.counters.model, 0);

        // A changed page cannot overwrite unresolved A, then replay A on a later
        // revert. The conservative URL hold remains until explicit manual recovery.
        const transport = restarted.dependencies.transport.request;
        restarted.dependencies.transport.request = async input => {
          const page = await transport(input); return { ...page, body: new URL(input.url).pathname === "/robots.txt" ? page.body : `${page.body}\nNew registration instructions are available.` };
        };
        restarted.advance(120_001);
        const changed = await createContinuousDiscoveryWorker(restarted.dependencies).runOnce();
        assert.equal(changed.status, "failed"); assert.equal(changed.reason, "DISCOVERY_MODEL_REQUIRES_REVIEW");
        assert.equal(changed.fetched, 0); assert.equal(changed.saved, 0); assert.equal(restarted.counters.model, 0);
        restarted.dependencies.transport.request = transport; restarted.advance(120_001);
        const reverted = await createContinuousDiscoveryWorker(restarted.dependencies).runOnce();
        assert.equal(reverted.status, "failed"); assert.equal(reverted.fetched, 0); assert.equal(restarted.counters.model, 0); assert.equal(modelCalls, 1);
        const completed = (await fixture.database.query<{ content_hash: string; last_error_code: string | null; last_completed_at: string | null }>("SELECT content_hash,last_error_code,last_completed_at FROM operations_discovery_urls WHERE scheduler_id=$1", [first.schedulerId])).rows[0]!;
        assert.equal(completed.content_hash, attempted.content_hash); assert.equal(completed.last_error_code, "DISCOVERY_MODEL_REQUIRES_REVIEW"); assert.equal(completed.last_completed_at, null);
      } finally {
        await fixture?.engine.close();
        const owned = relative(tmpdir(), directory);
        assert.equal(dirname(directory), tmpdir()); assert.ok(owned.startsWith("discovery-restart-fixture-") && !owned.includes(sep) && !isAbsolute(owned));
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("a pre-send model marker survives process/database restart and expired lease replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "discovery-restart-fixture-"));
  let fixture: Awaited<ReturnType<typeof discoveryDatabaseFixture>> | null = null;
  try {
    fixture = await discoveryDatabaseFixture(join(directory, "postgres"));
    const first = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1 });
    const reservation = { searchCalls: 1, modelCalls: 1, estimatedCostMicros: 101 };
    const cycle = await first.ledger.beginCycle({ workerId: first.dependencies.config.workerId, now: first.clock.now().toISOString(), minimumIntervalMs: 60_000,
      leaseMs: 6000, limits: first.dependencies.config.limits, reservation });
    assert.ok("lease" in cycle);
    const canonicalUrl = "https://events.hackathon.dev/event";
    await first.ledger.claimUrl({ token: cycle.lease.token, canonicalUrl, now: first.clock.now().toISOString(), recrawlAfterMs: 60_000 });
    const { createHash } = await import("node:crypto");
    await first.ledger.recordUrl({ token: cycle.lease.token, canonicalUrl, now: first.clock.now().toISOString(), contentHash: createHash("sha256").update(eventPageText).digest("hex"), candidateId: null, errorCode: "DISCOVERY_MODEL_REQUIRES_REVIEW" });
    // Simulate losing the process immediately after durable admission: no reply,
    // no successful URL timestamp and no finishCycle that could release its fee.
    await fixture.engine.close(); fixture = null;
    fixture = await discoveryDatabaseFixture(join(directory, "postgres"));
    const restarted = discoveryWorkerFixture(fixture.database, { maxPagesPerCycle: 1 }, first.schedulerId);
    restarted.advance(60_001);
    const report = await restarted.worker.runOnce();
    assert.equal(report.status, "failed"); assert.equal(report.reason, "DISCOVERY_MODEL_REQUIRES_REVIEW");
    assert.equal(restarted.counters.model, 0); assert.equal(report.saved, 0); assert.equal(report.unchanged, 0);
    assert.equal((await restarted.ledger.readState()).estimatedCostMicros, 102, "the previous unknown reservation is retained, with one new search fee");
    const row = (await fixture.database.query<{ last_error_code: string | null; last_completed_at: string | null }>("SELECT last_error_code,last_completed_at FROM operations_discovery_urls WHERE scheduler_id=$1", [first.schedulerId])).rows[0]!;
    assert.equal(row.last_error_code, "DISCOVERY_MODEL_REQUIRES_REVIEW"); assert.equal(row.last_completed_at, null);
  } finally {
    await fixture?.engine.close();
    const owned = relative(tmpdir(), directory);
    assert.equal(dirname(directory), tmpdir()); assert.ok(owned.startsWith("discovery-restart-fixture-") && !owned.includes(sep) && !isAbsolute(owned));
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalized CJK pages remain inside the DSH input budget and scripts never become evidence", () => {
  const text = discoveryPageText(`<script>dangerous secrets</script><p>${"汉".repeat(60_000)}</p>`, "text/html");
  assert.equal(text.includes("dangerous secrets"), false); assert.ok(Buffer.byteLength(text) <= 48_000);
  assert.throws(() => discoveryPageText('<input type="password">Sign in to read event details.', "text/html"), { code: "DISCOVERY_LOGIN_WALL" });
});
