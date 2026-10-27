import test from "node:test";
import assert from "node:assert/strict";
import { createDiscoverySourceSupplement } from "./discovery-sources.ts";
import type { ApplicationConfig } from "./config.ts";
import type { PinnedFetchRequest, PinnedFetchResponse, PublicSearchPort, PublicSearchResult } from "../modules/operations/index.ts";

const clock = { now: () => new Date("2026-10-09T00:00:00Z") };
function config(provider: "dsh_native" | "official_sources" | "brave" = "dsh_native", timeoutMs = 15_000): ApplicationConfig {
  return { mode: "local", origin: "http://localhost:3000", codePepper: "fixture", emailFrom: "fixture@localhost",
    discovery: { provider, worker: { workerId: "fixture", fetchTimeoutMs: timeoutMs, userAgent: "HackathonFieldGuide/0.1",
      queries: ["custom native query, unrelated to official IDs"], minimumIntervalMs: 300_000, recrawlAfterMs: 300_000,
      maxResultsPerQuery: 5, maxPagesPerCycle: 3, maxCycleDurationMs: 360_000, maxPageBytes: 262_144,
      searchCostMicrosPerCall: 1, modelCostReservationMicrosPerCall: 1,
      limits: { maxSearchCallsPerDay: 48, maxModelCallsPerDay: 120, maxEstimatedCostMicrosPerDay: 1_000_000, currency: "USD" } } } };
}
function network(options: { html?: string; robots?: string; address?: string; response?: (request: PinnedFetchRequest) => PinnedFetchResponse | Promise<PinnedFetchResponse> } = {}) {
  const calls: PinnedFetchRequest[] = [];
  return { calls,
    dns: { async resolve() { return [options.address ?? "93.184.216.34"]; } },
    transport: { async request(request: PinnedFetchRequest): Promise<PinnedFetchResponse> {
      calls.push(request);
      if (options.response) return options.response(request);
      const url = new URL(request.url), robots = url.pathname === "/robots.txt";
      const eth = `<h2>Upcoming Events</h2>${Array.from({ length: 7 }, (_, i) => `<a href="/events/fixture-${i}"><span>IRL Hackathon</span><h3>Fixture ${i}</h3></a>`).join("")}
        <a href="/events/pragma-fixture"><span>Conference</span><h3>Excluded conference</h3></a>
        <a href="https://evil.org/events/cross-host"><span>Online</span><h3>Excluded host</h3></a><h2>Past Events</h2><a href="/events/past-fixture"><span>IRL Hackathon</span><h3>Past fixture</h3></a>`;
      const lab = `<article><a href="/ai-hackathons/live-fixture"><span>LIVE</span><h3>Live fixture</h3></a></article>
        <article><a href="/ai-hackathons/register-fixture"><span>Register</span><h3>Register fixture</h3></a></article>
        <article><a href="/ai-hackathons/old-fixture"><span>Finished</span><h3>Excluded past fixture</h3></a></article>`;
      return { status: 200, connectedAddress: "93.184.216.34", contentType: robots ? "text/plain" : "text/html",
        body: robots ? options.robots ?? "User-agent: *\nAllow: /" : options.html ?? (url.hostname === "ethglobal.com" ? eth : lab) };
    } },
  };
}
const signal = () => new AbortController().signal;
const result = (url: string, title = "Actual listing fixture"): PublicSearchResult => ({ url, title, description: "Actual description fixture" });

test("supplement is disabled outside native discovery and refuses paid search ports", async () => {
  let calls = 0;
  const source: PublicSearchPort = { async search() { calls++; return []; } };
  for (const provider of ["official_sources", "brave"] as const) {
    const supplement = createDiscoverySourceSupplement({ config: config(provider), clock, network: network(), source });
    assert.deepEqual(await supplement.read({ signal: signal(), round: 0 }), []);
  }
  const disabled = config(); delete disabled.discovery;
  assert.deepEqual(await createDiscoverySourceSupplement({ config: disabled, clock, network: network(), source }).read({ signal: signal(), round: 0 }), []);
  const paid = createDiscoverySourceSupplement({ config: config(), clock, network: network(), source: { ...source, modelCallsPerSearch: 1 } });
  assert.deepEqual(await paid.read({ signal: signal(), round: 0 }), []);
  assert.equal(calls, 0);
});

test("rounds rotate one catalogue with five hints independently of custom native queries", async () => {
  const requests: { query: string; count: number; signal: AbortSignal }[] = [];
  const urls: Record<string, string> = { hackertrip: "https://hackertrip.space/hackathon/96fac334-7dea-4f27-91e2-c34007583c40",
    tencent: "https://tch.cloud.tencent.com/contest/47", xiaoyuanvc: "https://www.feishu.cn/share/base/form/fixture",
    hsinchu: "https://115hsinchuhackathon.com/", ethglobal: "https://ethglobal.com/events/fixture-event", lablab: "https://lablab.ai/ai-hackathons/fixture-event" };
  const source: PublicSearchPort = { async search(input) {
    requests.push(input);
    return { results: [result(urls[input.query]!)],
      usage: { inputTokens: 99, outputTokens: 99, estimatedCostMicros: 99, currency: "USD" } };
  } };
  const supplement = createDiscoverySourceSupplement({ config: config(), clock, network: network(), source });
  for (const round of [0, 1, 2, 3, 4, 5, 6]) {
    const found = await supplement.read({ signal: signal(), round });
    assert.ok(Array.isArray(found)); assert.equal(found.length, 1);
    assert.equal(found[0]!.title, "Actual listing fixture");
    assert.ok(found[0]!.description.endsWith("Actual description fixture"));
    assert.equal(found[0]!.provenance.catalogueId, requests[round]!.query);
    assert.equal(found[0]!.provenance.fetchedAt, clock.now().toISOString());
    assert.equal(Object.hasOwn(found, "usage"), false);
    assert.equal(Object.hasOwn(found[0]!, "indexedExcerpt"), false);
  }
  assert.deepEqual(requests.map(request => [request.query, request.count]), [["hackertrip", 5], ["tencent", 5], ["xiaoyuanvc", 5], ["hsinchu", 5], ["ethglobal", 5], ["lablab", 5], ["hackertrip", 5]]);
  assert.ok(requests.every(request => request.signal.aborted), "completed reads release their child controllers");
});

test("official hints reject unsafe, non-event, cross-source and tracker links; preserve only safe real fields", async () => {
  const source: PublicSearchPort = { async search() { return [
    result("https://ethglobal.com/events"), result("https://ethglobal.com/events/login"), result("https://ethglobal.com/events/pragma-conference"),
    result("https://127.0.0.1/events/private"), result("https://evil.org/events/cross-host"), result("https://lablab.ai/ai-hackathons/wrong-source"),
    result("https://ethglobal.com/events/fixture?token=secret"), result("https://user:pass@ethglobal.com/events/fixture"),
    result("https://ethglobal.com/events/fixture#tracking"), result("https://ethglobal.com/events/fixture/nested"),
    { ...result("https://www.ethglobal.com/events/valid-fixture/"), indexedExcerpt: "must never become page evidence",
      detailPolicy: { version: 1, rules: [{ hostname: "evil.org", pathPrefix: "/" }], maxRedirects: 3,
        maxBytes: 2_097_152, timeoutMs: 60_000, acceptedContentTypes: ["text/html"] } },
    result("https://ethglobal.com/events/valid-fixture", "Duplicate"),
  ]; } };
  const found = await createDiscoverySourceSupplement({ config: config(), clock, network: network(), source }).read({ signal: signal(), round: 4 });
  assert.equal(found.length, 1); assert.equal(found[0]!.url, "https://ethglobal.com/events/valid-fixture");
  assert.equal(found[0]!.title, "Actual listing fixture"); assert.ok(found[0]!.description.endsWith("Actual description fixture"));
  assert.equal(found[0]!.indexedExcerpt, undefined);
  assert.ok(found[0]!.detailPolicy!.rules.every(rule => ["ethglobal.com", "www.ethglobal.com"].includes(rule.hostname)));
  assert.equal(found[0]!.detailPolicy!.rules[0]!.pathPrefix, "/events/valid-fixture");
});

test("real official provider reads robots and pinned lists, filters current competitions and bounds count/bytes", async () => {
  const net = network();
  const supplement = createDiscoverySourceSupplement({ config: config(), clock, network: net });
  const eth = await supplement.read({ signal: signal(), round: 4 });
  const lab = await supplement.read({ signal: signal(), round: 5 });
  assert.equal(eth.length, 5); assert.deepEqual(eth.map(item => item.title), ["Fixture 0", "Fixture 1", "Fixture 2", "Fixture 3", "Fixture 4"]);
  assert.deepEqual(lab.map(item => item.url), ["https://lablab.ai/ai-hackathons/live-fixture", "https://lablab.ai/ai-hackathons/register-fixture"]);
  assert.deepEqual(net.calls.map(request => request.url), ["https://ethglobal.com/robots.txt", "https://ethglobal.com/events", "https://lablab.ai/robots.txt", "https://lablab.ai/ai-hackathons"]);
  assert.ok(net.calls.every(request => request.maxBytes <= 2_097_152 && request.connectAddress === "93.184.216.34" && request.resolvedAddresses.includes(request.connectAddress)));
  assert.ok([...eth, ...lab].every(item => !Object.hasOwn(item, "indexedExcerpt") && !Object.hasOwn(item, "usage")));
});

test("robots/private DNS/oversized responses fail empty and cannot replace native results", async () => {
  const denied = network({ robots: "User-agent: *\nDisallow: /events" });
  assert.deepEqual(await createDiscoverySourceSupplement({ config: config(), clock, network: denied }).read({ signal: signal(), round: 4 }), []);
  assert.equal(denied.calls.length, 1);
  const privateDns = network({ address: "127.0.0.1" });
  assert.deepEqual(await createDiscoverySourceSupplement({ config: config(), clock, network: privateDns }).read({ signal: signal(), round: 4 }), []);
  assert.equal(privateDns.calls.length, 0);
  const oversized = network({ response: request => ({ status: 200, connectedAddress: "93.184.216.34",
    contentType: new URL(request.url).pathname === "/robots.txt" ? "text/plain" : "text/html",
    body: new URL(request.url).pathname === "/robots.txt" ? "User-agent: *\nAllow: /" : "x".repeat(2_097_153) }) });
  assert.deepEqual(await createDiscoverySourceSupplement({ config: config(), clock, network: oversized }).read({ signal: signal(), round: 4 }), []);
  assert.equal(oversized.calls.length, 2);
});

test("a failed catalogue is empty and the next round can read the other source", async () => {
  let calls = 0;
  const source: PublicSearchPort = { async search(input) { calls++; if (input.query === "ethglobal") throw new Error("fixture unavailable"); return [result("https://lablab.ai/ai-hackathons/recovery-fixture")]; } };
  const supplement = createDiscoverySourceSupplement({ config: config(), clock, network: network(), source });
  assert.deepEqual(await supplement.read({ signal: signal(), round: 4 }), []);
  assert.equal((await supplement.read({ signal: signal(), round: 5 })).length, 1);
  assert.equal(calls, 2);
});

test("an uncooperative read respects configured timeouts and the twenty-second whole-read cap", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [configured, deadline] of [[100, 100], [60_000, 20_000]]) {
    let child: AbortSignal | undefined, settled = false;
    const source: PublicSearchPort = { async search(input) { child = input.signal; return new Promise(() => {}); } };
    const supplement = createDiscoverySourceSupplement({ config: config("dsh_native", configured), clock, network: network(), source });
    const pending = supplement.read({ signal: signal(), round: 0 }).then(found => { settled = true; return found; });
    await Promise.resolve();
    context.mock.timers.tick(deadline! - 1); await Promise.resolve();
    assert.equal(settled, false); assert.equal(child?.aborted, false);
    context.mock.timers.tick(1);
    assert.deepEqual(await pending, []); assert.equal(child?.aborted, true);
  }
});

test("parent cancellation releases a hanging read promptly and pre-cancelled/invalid rounds make no request", async () => {
  let calls = 0, child: AbortSignal | undefined;
  const source: PublicSearchPort = { async search(input) { calls++; child = input.signal; return new Promise(() => {}); } };
  const supplement = createDiscoverySourceSupplement({ config: config(), clock, network: network(), source });
  const controller = new AbortController();
  const pending = supplement.read({ signal: controller.signal, round: 0 });
  await Promise.resolve(); controller.abort();
  assert.deepEqual(await pending, []); assert.equal(child?.aborted, true);
  assert.deepEqual(await supplement.read({ signal: controller.signal, round: 0 }), []);
  for (const round of [-1, 0.5, Number.NaN]) assert.deepEqual(await supplement.read({ signal: signal(), round }), []);
  assert.equal(calls, 1);
});

test("current-month Chinese catalogue returns only current individual details and rotates beyond its first five", async () => {
  const ids = Array.from({ length: 8 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
  const card = (id: string, title: string) => `<a href="/hackathon/${id}"><h3>${title}</h3><p>仅供测试的真实页面形状，不是生产比赛。</p></a>`;
  const html = `<h1>当月黑客松测试目录</h1><h2>即将开始 / 报名中</h2>${ids.map((id, i) => card(id, `测试赛事${i}`)).join("")}
    <a href="/hackathon/month/2026-10"><h3>月目录不能成为赛事</h3></a><a href="/hackathon/collections"><h3>合集不能成为赛事</h3></a>
    <a href="https://127.0.0.1/hackathon/${ids[0]}"><h3>拒绝私网</h3></a><a hidden href="/hackathon/11111111-1111-1111-1111-111111111111">隐藏赛事</a>
    <script>${card("22222222-2222-2222-2222-222222222222", "脚本不是来源")}</script><h2>往届回顾</h2>${card("33333333-3333-3333-3333-333333333333", "已结束赛事")}`;
  let now = new Date("2026-12-31T23:59:59Z");
  const net = network({ html }), supplement = createDiscoverySourceSupplement({ config: config(), clock: { now: () => now }, network: net });
  const first = await supplement.read({ signal: signal(), round: 0 });
  assert.deepEqual(first.map(item => item.title), ["测试赛事0", "测试赛事1", "测试赛事2", "测试赛事3", "测试赛事4"]);
  assert.ok(first.every(item => item.provenance.kind === "third_party_listing" && /第三方目录/u.test(item.description)));
  assert.equal(first[0]!.provenance.catalogueUrl, "https://hackertrip.space/hackathon/month/2026-12");
  now = new Date("2027-01-01T00:00:00Z");
  const next = await supplement.read({ signal: signal(), round: 6 });
  assert.deepEqual(next.map(item => item.title), ["测试赛事5", "测试赛事6", "测试赛事7", "测试赛事0", "测试赛事1"]);
  assert.equal(next[0]!.provenance.catalogueUrl, "https://hackertrip.space/hackathon/month/2027-01");
  assert.equal(net.calls.filter(request => new URL(request.url).pathname !== "/robots.txt").length, 2, "one catalogue read per round");
});

test("Tencent literal server data keeps source URLs and visible names, without inventing IDs or executing scripts", async () => {
  const payload = `3:${JSON.stringify(["$", "$L18", null, { data: {
    bannerData: [{ link: "https://tch.cloud.tencent.com/contest/47" }, { link: "https://tch.cloud.tencent.com/contest/29" },
      { link: "https://tch.cloud.tencent.com/contest/49" }, { link: "https://evil.org/contest/47" }],
    onlineData: [{ id: 47, name: "重庆校园赛", endTime: "2026-11-21 00:00:00", introduce: "目录中实际取得的说明，报名状态仍须单场证据。" },
      { id: 48, name: "有ID但没有链接", endTime: "2026-11-21 00:00:00" },
      { id: 29, name: "往届比赛", endTime: "2026-09-13 00:00:00" },
      { id: 49, name: "仅隐藏JSON里的名字", endTime: "2026-11-21 00:00:00" }],
  } }])}\n`;
  const html = `<h1>腾讯云黑客松测试目录</h1><div class="hidden md:block">重庆校园赛</div><div>有ID但没有链接 往届比赛；目录仅作为未核验线索，详情仍须单独取得。</div>
    <script>self.__next_f.push(${JSON.stringify([1, payload])})</script><script>globalThis.__catalogueExecuted = true</script>`;
  const found = await createDiscoverySourceSupplement({ config: config(), clock, network: network({ html }) }).read({ signal: signal(), round: 13 });
  assert.equal(found.length, 1); assert.equal(found[0]!.url, "https://tch.cloud.tencent.com/contest/47");
  assert.equal(found[0]!.title, "重庆校园赛"); assert.equal(found[0]!.provenance.catalogueUrl, "https://tch.cloud.tencent.com/");
  assert.equal(found[0]!.provenance.kind, "official_listing"); assert.equal(found[0]!.indexedExcerpt, undefined);
  assert.equal((globalThis as typeof globalThis & { __catalogueExecuted?: boolean }).__catalogueExecuted, undefined);
  const malformed = network({ html: '<h1>腾讯云黑客松测试目录及当前说明</h1><script>self.__next_f.push([1,"bad"]) ; globalThis.__catalogueExecuted=true</script>' });
  assert.deepEqual(await createDiscoverySourceSupplement({ config: config(), clock, network: malformed }).read({ signal: signal(), round: 1 }), []);
});

test("campus calendar extracts its current event heading and actual registration href; never returns guides or the calendar", async () => {
  const html = `<h1>中国黑客松赛事日历</h1><h3>近期仍可报名赛事</h3><div><h4>雾客松2027</h4><p>报名截止2026/11/30，目录状态仍需核对。</p>
    <a href="https://www.feishu.cn/share/base/form/fixture?share_link_type=qrcode&amp;ccm_open_type=form_qrcode">查看报名表 →</a>
    <a href="/resources/hackathon-starter-guide">查看参赛指南</a><a href="/resources/china-hackathon-statistics">赛事日历</a>
    <a href="https://user:pass@external.org/event">报名</a><a href="https://external.org/event?token=private">报名</a></div>
    <h3>已截止报名的赛事记录</h3><h4>已截止黑客松</h4><a href="https://external.org/past-event">查看报名表</a>`;
  const found = await createDiscoverySourceSupplement({ config: config(), clock, network: network({ html }) }).read({ signal: signal(), round: 2 });
  assert.equal(found.length, 1); assert.equal(found[0]!.title, "雾客松2027");
  assert.equal(found[0]!.url, "https://www.feishu.cn/share/base/form/fixture?share_link_type=qrcode&ccm_open_type=form_qrcode");
  assert.equal(found[0]!.provenance.kind, "third_party_listing");
  assert.ok(found[0]!.description.includes("https://xiaoyuanvc.com/resources/china-hackathon-statistics"));
});

test("fixed organizer identity yields a hint only after current real page text is obtained", async () => {
  const html = "<title>115新竹政策黑客松</title><h1>115新竹政策黑客松</h1><p>115年正式期程，政府出题，青年创意解题。仅供隔离测试。</p>";
  const net = network({ html });
  const found = await createDiscoverySourceSupplement({ config: config(), clock, network: net }).read({ signal: signal(), round: 3 });
  assert.equal(found.length, 1); assert.equal(found[0]!.url, "https://115hsinchuhackathon.com/");
  assert.equal(found[0]!.title, "115新竹政策黑客松"); assert.equal(found[0]!.provenance.kind, "organizer_page");
  assert.deepEqual(net.calls.map(request => request.url), ["https://115hsinchuhackathon.com/robots.txt", "https://115hsinchuhackathon.com/"]);
  const blocked = network({ robots: "User-agent: *\nDisallow: /", html });
  assert.deepEqual(await createDiscoverySourceSupplement({ config: config(), clock, network: blocked }).read({ signal: signal(), round: 3 }), []);
  const stale = network({ html: "<title>114新竹政策黑客松</title><p>114年过去的旧比赛，仅供测试，不要作为当前比赛线索。</p>" });
  assert.deepEqual(await createDiscoverySourceSupplement({ config: config(), clock, network: stale }).read({ signal: signal(), round: 3 }), []);
});

test("catalogue canonical redirects, robots denials and private redirects stop without fabricated hints", async () => {
  const denied = network({ robots: "User-agent: *\nDisallow: /hackathon" });
  assert.deepEqual(await createDiscoverySourceSupplement({ config: config(), clock, network: denied }).read({ signal: signal(), round: 0 }), []);
  assert.equal(denied.calls.length, 1);
  const escaped = network({ response: request => new URL(request.url).pathname === "/robots.txt"
    ? { status: 200, connectedAddress: "93.184.216.34", contentType: "text/plain", body: "User-agent: *\nAllow: /" }
    : { status: 302, connectedAddress: "93.184.216.34", contentType: "text/html", body: "", location: "https://127.0.0.1/private" } });
  assert.deepEqual(await createDiscoverySourceSupplement({ config: config(), clock, network: escaped }).read({ signal: signal(), round: 0 }), []);
  assert.equal(escaped.calls.length, 2);
});
