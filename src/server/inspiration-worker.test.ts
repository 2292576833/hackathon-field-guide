import test from "node:test";
import assert from "node:assert/strict";
import type { DatabasePort } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import { PostgresDiscoveryLedger } from "../modules/operations/discovery-postgres.ts";
import { discoveryDatabaseFixture } from "../modules/operations/discovery-test-fixtures.ts";
import type { DiscoveryModelPort } from "../modules/operations/discovery-types.ts";
import type { PinnedFetchPort } from "../modules/operations/network-policy.ts";
import type { InspirationCandidate, InspirationItem } from "./inspiration-catalog.ts";
import { createInspirationWorker, inspirationPageText, INSPIRATION_PROMPT_VERSION, INSPIRATION_SCHEDULER_ID } from "./inspiration-worker.ts";
import { discoveryPageText } from "../modules/operations/discovery-worker.ts";

const pageText = "Accessible interface components can be customized for a working prototype. Review each component documentation before use.";
const modelData = { description: "DSH 根据当前官方正文说明组件的作用。", useWhen: "DSH 建议在原型已有功能时完善界面。", usageNote: "DSH 提醒先核实当前组件文档，许可与费用若未说明须另行确认。", evidence: ["Accessible interface components can be customized for a working prototype."] };
const config = { workerId: "inspiration-test-worker", userAgent: "InspirationTestBot/1.0", minimumIntervalMs: 60_000, recrawlAfterMs: 120_000, maxCycleDurationMs: 5000,
  fetchTimeoutMs: 1000, maxPageBytes: 65_536, modelCostReservationMicrosPerCall: 100,
  limits: { maxSearchCallsPerDay: 0, maxModelCallsPerDay: 10, maxEstimatedCostMicrosPerDay: 1000, currency: "USD" as const } };
function candidate(id: string): InspirationCandidate & { evidenceUrls: string[] } {
  return { id, name: `固定来源 ${id}`, url: `https://inspiration.hackathon.dev/${id}`, category: "components", contentType: "code", tags: ["组件"], evidenceUrls: [`https://inspiration.hackathon.dev/${id}`] };
}
async function fixture(candidates: readonly (InspirationCandidate & { evidenceUrls: string[] })[] = [candidate("one")]) {
  const databaseFixture = await discoveryDatabaseFixture();
  let time = Date.parse("2026-10-09T06:00:00.000Z");
  const clock = { now: () => new Date(time) };
  const ledger = new PostgresDiscoveryLedger({ database: databaseFixture.database, clock, id: INSPIRATION_SCHEDULER_ID });
  const saved: InspirationItem[] = [], requests: Parameters<DiscoveryModelPort["request"]>[0][] = [], fetches: string[] = [];
  const model: DiscoveryModelPort = { async request(input) {
    requests.push(input);
    return { data: structuredClone(modelData), usage: { inputTokens: 20, outputTokens: 20, estimatedCostMicros: 7, currency: "USD" } };
  } };
  const transport: PinnedFetchPort = { async request(input) {
    fetches.push(input.url);
    return { status: 200, connectedAddress: "93.184.216.34", contentType: "text/plain", body: new URL(input.url).pathname === "/robots.txt" ? "User-agent: *\nAllow: /" : pageText };
  } };
  const deps = { database: databaseFixture.database, clock, ledger, model, config: { ...config, limits: { ...config.limits } }, candidates,
    network: { dns: { async resolve() { return ["93.184.216.34"]; } }, transport },
    async save(item: InspirationItem) {
      return databaseFixture.database.transaction(async tx => {
        const result = await tx.query<{ id: number; revision: number }>("INSERT INTO fixture_discovery_cards(canonical_url,payload) VALUES($1,$2::jsonb) ON CONFLICT(canonical_url) DO UPDATE SET revision=fixture_discovery_cards.revision+1,payload=EXCLUDED.payload RETURNING id,revision", [item.url, JSON.stringify(item)]);
        saved.push(structuredClone(item));
        return { id: String(result.rows[0]!.id), revision: result.rows[0]!.revision };
      });
    } };
  return { ...databaseFixture, clock, ledger, deps, saved, requests, fetches, advance(ms: number) { time += ms; } };
}

test("inspiration worker uses real fetched text and model descriptions while keeping identity metadata server-owned", async t => {
  const injected = { ...candidate("one"), description: "PRIVATE_EDITORIAL_SENTINEL", useWhen: "PRIVATE_EDITORIAL_SENTINEL", usageNote: "PRIVATE_EDITORIAL_SENTINEL" };
  const f = await fixture([injected]); t.after(() => f.engine.close());
  f.deps.model.request = async input => {
    f.requests.push(input); f.advance(1234);
    assert.doesNotMatch(JSON.stringify(input), /PRIVATE_EDITORIAL_SENTINEL/);
    assert.equal((input.input as { promptVersion: string }).promptVersion, INSPIRATION_PROMPT_VERSION);
    assert.match(input.prompt, /untrusted DATA/);
    return { data: modelData, usage: { inputTokens: 20, outputTokens: 20, estimatedCostMicros: 7, currency: "USD" } };
  };
  const result = await createInspirationWorker(f.deps).runOnce();
  assert.equal(result.status, "completed"); assert.equal(result.saved, 1); assert.equal(result.searched, 0);
  assert.equal(f.requests.length, 1); assert.equal(f.saved[0]?.description, modelData.description);
  assert.equal(f.saved[0]?.useWhen, modelData.useWhen); assert.equal(f.saved[0]?.usageNote, modelData.usageNote);
  assert.equal(f.saved[0]?.id, "one"); assert.deepEqual(f.saved[0]?.tags, ["组件"]);
  assert.equal(f.saved[0]?.checkedAt, "2026-10-09T06:00:01.234Z");
  assert.deepEqual(f.saved[0]?.evidenceUrls, [candidate("one").url]);
  const state = await f.ledger.readState(); assert.equal(state.searchCalls, 0); assert.equal(state.modelCalls, 1); assert.equal(state.estimatedCostMicros, 7);
  assert.equal((await f.database.query("SELECT payload FROM fixture_discovery_cards")).rowCount, 1);
});

test("initial default selection prioritizes readable component sites without copying editorial seed descriptions", async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  const { candidates: _unused, ...deps } = f.deps;
  assert.equal((await createInspirationWorker(deps).runOnce()).saved, 1);
  const resource = (f.requests[0]!.input as { resource: { id: string; [key: string]: unknown } }).resource;
  assert.equal(resource.id, "shadcn-ui");
  for (const field of ["description", "useWhen", "usageNote", "checkedAt", "evidenceUrls"]) assert.equal(field in resource, false);
  assert.ok(f.fetches.includes("https://ui.shadcn.com/robots.txt"));
  f.advance(60_001);
  assert.equal((await createInspirationWorker(deps).runOnce()).saved, 1);
  assert.equal((f.requests[1]!.input as { resource: { id: string } }).resource.id, "radix-ui");
});

test("one site per cycle rotates to unattempted sites and unchanged pages do not consume model calls", async t => {
  const f = await fixture([candidate("one"), candidate("two")]); t.after(() => f.engine.close());
  const worker = createInspirationWorker(f.deps);
  assert.equal((await worker.runOnce()).saved, 1); assert.equal(f.saved[0]?.id, "one");
  assert.equal((await worker.runOnce()).reason, "not_due"); assert.equal(f.requests.length, 1);
  f.advance(60_001);
  assert.equal((await worker.runOnce()).saved, 1); assert.equal(f.saved[1]?.id, "two");
  f.advance(60_001);
  const third = await worker.runOnce(); assert.equal(third.unchanged, 1); assert.equal(third.saved, 0); assert.equal(f.requests.length, 2);
  const state = await f.ledger.readState(); assert.equal(state.modelCalls, 2); assert.equal(state.estimatedCostMicros, 14);
});

test("no due candidate skips before reserving budget or initializing the scheduler", async t => {
  const f = await fixture([]); t.after(() => f.engine.close());
  const report = await createInspirationWorker(f.deps).runOnce(); assert.equal(report.status, "skipped"); assert.equal(report.reason, "no_due");
  assert.equal(f.requests.length, 0); assert.equal(f.fetches.length, 0);
  assert.equal((await f.database.query("SELECT id FROM operations_discovery_state")).rowCount, 0);
  const full = await fixture(); t.after(() => full.engine.close());
  const worker = createInspirationWorker(full.deps); await worker.runOnce();
  const before = await full.ledger.readState(); full.advance(60_001);
  assert.equal((await worker.runOnce()).reason, "no_due");
  assert.deepEqual(await full.ledger.readState(), before); assert.equal(full.requests.length, 1);
});

test("fetch and robots failures remain retryable and do not block unattempted sites or charge model fees", async t => {
  const f = await fixture([candidate("one"), candidate("two")]); t.after(() => f.engine.close());
  const transport = f.deps.network.transport.request;
  f.deps.network.transport.request = async input => new URL(input.url).pathname === "/one" ? { status: 403, connectedAddress: "93.184.216.34", contentType: "text/plain", body: "" } : transport(input);
  const worker = createInspirationWorker(f.deps);
  assert.equal((await worker.runOnce()).status, "failed"); assert.equal(f.requests.length, 0);
  assert.equal((await f.ledger.readState()).estimatedCostMicros, 0);
  f.advance(60_001); assert.equal((await worker.runOnce()).saved, 1); assert.equal(f.saved[0]?.id, "two");
  f.deps.network.transport.request = transport; f.advance(60_001);
  assert.equal((await worker.runOnce()).saved, 1); assert.equal(f.saved[1]?.id, "one");
  const blocked = await fixture(); t.after(() => blocked.engine.close());
  blocked.deps.network.transport.request = async () => ({ status: 200, connectedAddress: "93.184.216.34", contentType: "text/plain", body: "User-agent: *\nDisallow: /" });
  const denied = await createInspirationWorker(blocked.deps).runOnce(); assert.equal(denied.reason, "ROBOTS_DISALLOWED"); assert.equal(blocked.requests.length, 0);
});

test("invalid model schema or invented source excerpts leave a durable unknown hold without retries across days", async t => {
  for (const invalid of [{ ...modelData, evidence: ["A completely invented source quote"] }, { ...modelData, description: "x".repeat(601) }, { ...modelData, url: "https://guessed.hackathon.dev/" }]) {
    const f = await fixture(); t.after(() => f.engine.close());
    f.deps.model.request = async input => { f.requests.push(input); return { data: invalid, usage: { inputTokens: 20, outputTokens: 20, estimatedCostMicros: 7, currency: "USD" } }; };
    const first = await createInspirationWorker(f.deps).runOnce(); assert.equal(first.status, "failed"); assert.equal(first.saved, 0);
    const row = (await f.database.query<{ last_error_code: string; content_hash: string }>("SELECT last_error_code,content_hash FROM operations_discovery_urls WHERE scheduler_id=$1", [INSPIRATION_SCHEDULER_ID])).rows[0]!;
    assert.equal(row.last_error_code, "DISCOVERY_MODEL_REQUIRES_REVIEW"); assert.match(row.content_hash, /^[a-f0-9]{64}$/);
    f.advance(2 * 86_400_000);
    assert.equal((await createInspirationWorker(f.deps).runOnce()).reason, "no_due"); assert.equal(f.requests.length, 1);
    assert.equal((await f.database.query("SELECT payload FROM fixture_discovery_cards")).rowCount, 0);
  }
});

test("unknown model transport outcomes conservatively settle the full reservation and are never automatically resent", async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  f.deps.model.request = async input => { f.requests.push(input); throw new Error("PRIVATE_REMOTE_DIAGNOSTIC"); };
  const result = await createInspirationWorker(f.deps).runOnce(); assert.equal(result.status, "failed"); assert.equal(result.reason, "INSPIRATION_INTERNAL_ERROR");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_REMOTE_DIAGNOSTIC/);
  const state = await f.ledger.readState(); assert.equal(state.modelCalls, 1); assert.equal(state.estimatedCostMicros, 100);
  f.advance(86_400_000); assert.equal((await createInspirationWorker(f.deps).runOnce()).reason, "no_due"); assert.equal(f.requests.length, 1);
});

test("caller cancellation after dispatch retains the model hold and cannot publish a late result", async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  let started!: () => void, late!: (value: Awaited<ReturnType<DiscoveryModelPort["request"]>>) => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  f.deps.model.request = async input => { f.requests.push(input); started(); return new Promise(resolve => { late = resolve; }); };
  const cancel = new AbortController();
  const running = createInspirationWorker(f.deps).runOnce({ signal: cancel.signal });
  await ready; cancel.abort();
  assert.equal((await running).status, "cancelled");
  late({ data: modelData, usage: { inputTokens: 20, outputTokens: 20, estimatedCostMicros: 7, currency: "USD" } });
  await Promise.resolve(); assert.equal(f.saved.length, 0);
  const row = (await f.database.query<{ last_error_code: string }>("SELECT last_error_code FROM operations_discovery_urls")).rows[0]!;
  assert.equal(row.last_error_code, "DISCOVERY_MODEL_REQUIRES_REVIEW");
  assert.equal((await f.ledger.readState()).estimatedCostMicros, 100);
});

test("invalid currency/usage preserves the reservation and an actual overrun is recorded before further calls stop", async t => {
  for (const usage of [{ inputTokens: 20, outputTokens: 20, estimatedCostMicros: 7, currency: "CNY" as const }, { inputTokens: -1, outputTokens: 20, estimatedCostMicros: 7, currency: "USD" as const }, { inputTokens: 20, outputTokens: 20, estimatedCostMicros: 101, currency: "USD" as const }]) {
    const f = await fixture(); t.after(() => f.engine.close());
    f.deps.model.request = async input => { f.requests.push(input); return { data: modelData, usage }; };
    const result = await createInspirationWorker(f.deps).runOnce(); assert.equal(result.status, "failed"); assert.equal(f.saved.length, 0);
    assert.equal((await f.ledger.readState()).estimatedCostMicros, usage.estimatedCostMicros === 101 ? 101 : 100);
    f.advance(86_400_000); await createInspirationWorker(f.deps).runOnce(); assert.equal(f.requests.length, 1);
  }
});

test("transactional publication fences rollback failed saves and retain a model hold", async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  f.deps.save = async item => {
    await f.database.query("INSERT INTO fixture_discovery_cards(canonical_url,payload) VALUES($1,$2::jsonb)", [item.url, JSON.stringify(item)]);
    throw new DomainError("INSPIRATION_STORAGE_UNAVAILABLE", "isolated storage error", { status: 503 });
  };
  const result = await createInspirationWorker(f.deps).runOnce(); assert.equal(result.status, "failed"); assert.equal(result.saved, 0);
  assert.equal((await f.database.query("SELECT payload FROM fixture_discovery_cards")).rowCount, 0);
  const row = (await f.database.query<{ last_error_code: string }>("SELECT last_error_code FROM operations_discovery_urls")).rows[0]!;
  assert.equal(row.last_error_code, "DISCOVERY_MODEL_REQUIRES_REVIEW");
  assert.equal((await f.ledger.readState()).estimatedCostMicros, 7);
});

test("model input is bounded by UTF-8 bytes and evidence URLs use only actual allowed final URLs", async t => {
  const original = candidate("one"); original.evidenceUrls = [original.url, `${original.url}/guide`, `${original.url}/examples`];
  const f = await fixture([original]); t.after(() => f.engine.close());
  f.deps.config.maxPageBytes = 131_072;
  f.deps.network.transport.request = async input => {
    const url = new URL(input.url);
    if (url.pathname === "/robots.txt") return { status: 200, connectedAddress: "93.184.216.34", contentType: "text/plain", body: "User-agent: *\nAllow: /" };
    if (url.pathname === "/one" && !url.hostname.startsWith("www.")) return { status: 302, connectedAddress: "93.184.216.34", contentType: "text/plain", body: "", location: "https://www.inspiration.hackathon.dev/one" };
    return { status: 200, connectedAddress: "93.184.216.34", contentType: "text/plain", body: `${pageText}\n${"设计组件".repeat(10_000)}` };
  };
  f.deps.model.request = async input => {
    f.requests.push(input);
    const pages = (input.input as { pages: { url: string; text: string; truncated: boolean }[] }).pages;
    assert.ok(Buffer.byteLength(JSON.stringify(pages), "utf8") <= 65_536);
    assert.equal(pages.length, 3); assert.ok(pages.every(page => page.truncated));
    assert.ok(Buffer.byteLength(JSON.stringify(input.input), "utf8") + Buffer.byteLength(input.prompt, "utf8") < 131_072);
    assert.equal(pages[0]?.url, "https://www.inspiration.hackathon.dev/one");
    return { data: modelData, usage: { inputTokens: 20, outputTokens: 20, estimatedCostMicros: 7, currency: "USD" } };
  };
  assert.equal((await createInspirationWorker(f.deps).runOnce()).saved, 1);
  assert.deepEqual(f.saved[0]?.evidenceUrls, ["https://www.inspiration.hackathon.dev/one", `${original.url}/guide`, `${original.url}/examples`]);
});

test("private DNS and redirects outside fixed official hostnames never reach the model", async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  f.deps.network.dns.resolve = async () => ["127.0.0.1"];
  assert.equal((await createInspirationWorker(f.deps).runOnce()).reason, "UNSAFE_SOURCE_URL"); assert.equal(f.fetches.length, 0); assert.equal(f.requests.length, 0);
  const g = await fixture(); t.after(() => g.engine.close());
  const network = g.deps.network.transport.request;
  g.deps.network.transport.request = async input => new URL(input.url).pathname === "/robots.txt" ? network(input) : { status: 302, connectedAddress: "93.184.216.34", contentType: "text/plain", body: "", location: "https://guessed.hackathon.dev/source" };
  assert.equal((await createInspirationWorker(g.deps).runOnce()).status, "failed");
  assert.equal(g.requests.length, 0); assert.equal(g.fetches.some(url => url.includes("guessed.hackathon.dev")), false);
});

test("configuration permits zero search allowance and pre-aborted calls cannot touch the database", async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  assert.equal(f.deps.config.limits.maxSearchCallsPerDay, 0);
  const database: DatabasePort = { query() { throw new Error("aborted read forbidden"); }, transaction() { throw new Error("aborted mutation forbidden"); } };
  const cancel = new AbortController(); cancel.abort();
  const result = await createInspirationWorker({ ...f.deps, database }).runOnce({ signal: cancel.signal });
  assert.equal(result.status, "cancelled"); assert.equal(f.fetches.length, 0); assert.equal(f.requests.length, 0);
  assert.throws(() => createInspirationWorker({ ...f.deps, config: { ...f.deps.config, limits: { ...f.deps.config.limits, currency: "CNY" } } }), { code: "INVALID_INSPIRATION_CONFIG" });
});

test("normal public component homepages may demonstrate password fields without being login walls", () => {
  const html = `<html><head><title>shadcn/ui - The Foundation for your Design System</title></head><body>
    <h1>Accessible interface components for your prototype.</h1><p>Browse component documentation and customize your design system.</p>
    <section><h2>Example login component</h2><form><label>Email</label><input type="email"><label>Password</label><input class="component-input" type="password" autocomplete="current-password"><button>Log in</button></form></section>
    <script>SECRET_SCRIPT_TEXT</script><style>SECRET_STYLE_TEXT</style><!-- SECRET_COMMENT_TEXT --></body></html>`;
  const text = inspirationPageText(html, "text/html");
  assert.match(text, /Accessible interface components/); assert.match(text, /Example login component/);
  assert.doesNotMatch(text, /SECRET_|<input|current-password/);
  assert.throws(() => discoveryPageText(html, "text/html"), { code: "DISCOVERY_LOGIN_WALL" }, "event discovery keeps its existing stricter boundary");
  for (const input of ["<input type=password>", "<input TYPE='password' />", '<input data-slot="input" type = "password">']) assert.match(inspirationPageText(`<title>Component Library</title><h1>Example components and documentation.</h1>${input}`, "text/html"), /Example components/);
});

test("actual login pages and challenge markers stay rejected by the inspiration parser", () => {
  for (const body of [
    '<title>Log in | Design Library</title><p>Enter credentials to continue.</p><form><input type="password"></form>',
    '<title>Site account</title><form><label>Email</label><label>Password</label><input type="password"><button>Sign in</button><p>Please authenticate to continue.</p></form>',
    '<title>Official Documentation</title><form><label>Password</label><input type="password"><p>Sign in to read the documentation.</p></form>',
    '<title>Just a moment...</title><p>Verify your browser before continuing.</p>',
    '<title>Components</title><p>Accessible components have documentation.</p><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>',
    '<title>Components</title><p>cf-chl-token content must not be treated as a source.</p>',
  ]) assert.throws(() => inspirationPageText(body, "text/html"), { code: "DISCOVERY_LOGIN_WALL" });
});

test("normal component password examples reach DSH, while known fetch failures retry after five minutes using the same claim cooldown", async t => {
  const f = await fixture([candidate("one"), candidate("two")]); t.after(() => f.engine.close());
  f.deps.config.recrawlAfterMs = 86_400_000;
  let unavailable = true;
  f.deps.network.transport.request = async input => {
    const path = new URL(input.url).pathname;
    if (path === "/robots.txt") return { status: 200, connectedAddress: "93.184.216.34", contentType: "text/plain", body: "User-agent: *\nAllow: /" };
    if (path === "/one" && unavailable) return { status: 403, connectedAddress: "93.184.216.34", contentType: "text/plain", body: "" };
    return { status: 200, connectedAddress: "93.184.216.34", contentType: "text/html", body: `<title>Component Documentation</title><p>${pageText}</p><form><label>Example Password</label><input type="password"><button>Log in</button></form>` };
  };
  const worker = createInspirationWorker(f.deps);
  assert.equal((await worker.runOnce()).status, "failed"); assert.equal(f.requests.length, 0);
  f.advance(60_001);
  assert.equal((await worker.runOnce()).saved, 1); assert.equal(f.saved[0]?.id, "two", "unattempted sites precede a known failed source");
  unavailable = false; f.advance(239_998);
  assert.equal((await worker.runOnce()).reason, "no_due"); assert.equal(f.requests.length, 1);
  f.advance(1);
  assert.equal((await worker.runOnce()).saved, 1); assert.equal(f.saved[1]?.id, "one"); assert.equal(f.requests.length, 2);
  f.advance(60_001);
  assert.equal((await worker.runOnce()).reason, "no_due", "successful analyses retain the full daily recrawl interval");
  assert.equal(f.requests.length, 2);
  const state = await f.ledger.readState(); assert.equal(state.modelCalls, 2); assert.equal(state.estimatedCostMicros, 14);
});
