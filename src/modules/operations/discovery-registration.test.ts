import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../shared/errors.ts";
import { extractRegistrationLinks, normalizeParticipation, normalizeRegistrationUrl, REGISTRATION_UNCONFIRMED, selectRegistration, type RegistrationLinkCandidate } from "./discovery-registration.ts";
import { createContinuousDiscoveryWorker } from "./discovery-worker.ts";
import { discoveryDatabaseFixture, discoveryWorkerFixture, eventModelData, eventPageText } from "./discovery-test-fixtures.ts";

const sourceUrl = "https://events.hackathon.dev/events/ai-build";
const participation = { recommendation: "insufficient_info" as const, reason: "规则未写清年龄与设备要求，先确认再决定是否报名。", suitableFor: ["愿意先向主办方核实规则的新人"], cautionFor: ["暂时无法确认线下地点或参赛时间的队伍"] };

test("registration extraction resolves actual relative anchors with visible event context and preserves provenance", () => {
  const html = '<main><h1>AI 黑客松比赛</h1><p>欢迎开发者参赛。</p><a href="../../apply/ai-build?utm_source=event&amp;track=public"><span>立即</span>报名</a><p>Hackathon welcomes beginners. <a href="https://forms.hackathon.dev/build">Register now</a></p></main>';
  const result = extractRegistrationLinks({ body: html, contentType: "text/html", sourceUrl });
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { url: "https://events.hackathon.dev/apply/ai-build?track=public", sourceUrl, anchorText: "立即报名", evidence: "立即报名" });
  assert.equal(result[1]?.url, "https://forms.hackathon.dev/build");
  assert.equal(result[1]?.evidence, "Register now");
  const chosen = { url: result[0]!.url, sourceUrl, evidence: "立即报名" };
  assert.deepEqual(selectRegistration(chosen, result), chosen);
});

test("script, style, comment, hidden and generic login/navigation anchors are not event registration", () => {
  const html = `<h1>AI Hackathon</h1>
    <nav><a href="/register">Register</a><a href="/apply-nav">报名</a></nav>
    <header><a href="/account">Sign up</a></header>
    <footer><a href="/newsletter">Register</a></footer>
    <script><a href="/apply-script">报名</a></script>
    <style><a href="/apply-style">报名</a></style>
    <!-- <a href="/apply-comment">报名</a> -->
    <div hidden><span><a href="/apply-hidden">报名</a></span></div>
    <div aria-hidden="true"><a href="/apply-aria">报名</a></div>
    <div style="display: none"><a href="/apply-none">报名</a></div>
    <div style="visibility:hidden"><a href="/apply-invisible">报名</a></div>
    <a href="/login">登录</a><a href="/account-create">Register account</a><a href="/newsletter-create">Register newsletter</a>`;
  assert.deepEqual(extractRegistrationLinks({ body: html, contentType: "text/html", sourceUrl }), []);
  assert.deepEqual(extractRegistrationLinks({ body: '<p>Welcome to our platform</p><a href="/register">Register</a>', contentType: "text/html", sourceUrl }), []);
});

test("registration URLs reject unsafe, credential-bearing and wrapper links without network access", () => {
  const links = ["javascript:alert(1)", "http://events.hackathon.dev/apply", "https://localhost/apply", "https://127.0.0.1/apply", "https://private.internal/apply", "https://user:password@events.hackathon.dev/apply", "/login", "/signup", "/redirect?url=https%3A%2F%2Fevents.hackathon.dev%2Fapply", "/apply?next=https%3A%2F%2Fevil.hackathon.dev%2F", "/apply?access_token=secret", "/apply?code=secret", "/apply?utm_source=event&token=secret", "https://bit.ly/event-registration", "#registration"];
  for (const link of links) {
    assert.throws(() => normalizeRegistrationUrl(link, sourceUrl));
    assert.deepEqual(extractRegistrationLinks({ body: `<h1>AI Hackathon</h1><a href="${link}">报名</a>`, contentType: "text/html", sourceUrl }), []);
  }
  assert.equal(normalizeRegistrationUrl("https://forms.hackathon.dev/apply?utm_campaign=event&event=ai"), "https://forms.hackathon.dev/apply?event=ai");
});

test("plain text and indexed excerpts require an actual signup URL next to a registration instruction", () => {
  const body = "AI 黑客松欢迎新人。\n报名链接：https://forms.hackathon.dev/ai 先核实年龄条件。";
  const result = extractRegistrationLinks({ body, contentType: "text/plain", sourceUrl, sourceKind: "indexed_excerpt" });
  assert.equal(result.length, 1); assert.equal(result[0]?.url, "https://forms.hackathon.dev/ai");
  assert.ok(result[0]?.evidence.includes("报名链接：https://forms.hackathon.dev/ai"));
  for (const excerpt of ["AI 黑客松已开放报名，详情请查原文。", "AI 黑客松 https://events.hackathon.dev/events/ai-build", "报名信息可向主办方询问。\n官网：https://events.hackathon.dev/", "<!-- 报名链接：https://forms.hackathon.dev/hidden -->"]) assert.deepEqual(extractRegistrationLinks({ body: excerpt, contentType: "text/plain", sourceUrl, sourceKind: "indexed_excerpt" }), []);
  assert.equal(selectRegistration({ url: sourceUrl, sourceUrl, evidence: "AI 黑客松已开放报名" }, []), null);
});

test("model registration selection cannot guess a destination, borrow a non-source URL or alter evidence", () => {
  const links = extractRegistrationLinks({ body: '<h1>AI 黑客松</h1><a href="/apply">报名</a>', contentType: "text/html", sourceUrl });
  const correct = { url: links[0]!.url, sourceUrl, evidence: "报名" };
  for (const value of [undefined, null, {}, { ...correct, url: "https://events.hackathon.dev/guessed-slug" }, { ...correct, sourceUrl: "https://other.hackathon.dev/" }, { ...correct, evidence: "不存在的报名证据" }, { ...correct, anchorText: "报名" }]) assert.equal(selectRegistration(value, links), null);
  assert.deepEqual(selectRegistration(correct, links), correct);
  const many = Array.from({ length: 30 }, (_, index) => `<a href="/apply/${index}">报名 ${index}</a>`).join("");
  assert.equal(extractRegistrationLinks({ body: `<h1>AI Hackathon</h1>${many}`, contentType: "text/html", sourceUrl }).length, 12);
  assert.deepEqual(extractRegistrationLinks({ body: `${"<div>".repeat(257)}<a href="/apply">报名</a>${"</div>".repeat(257)}`, contentType: "text/html", sourceUrl }), [], "untrusted pathological nesting has a fixed depth bound");
  const long = Array.from({ length: 12 }, (_, index) => `<a href="/apply/${index}/${"x".repeat(1000)}">${"报名参赛".repeat(100)}</a>`).join("");
  assert.ok(Buffer.byteLength(JSON.stringify(extractRegistrationLinks({ body: long, contentType: "text/html", sourceUrl })), "utf8") <= 24_576);
});

test("participation has bounded conditional recommendations and rejects percentages or guaranteed eligibility", () => {
  assert.equal(normalizeParticipation(undefined), undefined);
  assert.deepEqual(normalizeParticipation(participation), participation);
  for (const value of [null, { ...participation, recommendation: "guaranteed" }, { ...participation, reason: "r".repeat(601) }, { ...participation, reason: "适合程度为 99%" }, { ...participation, reason: "保证你符合报名资格" }, { ...participation, reason: "Guarantees eligibility for everyone" }, { ...participation, suitableFor: Array(9).fill("新人") }, { ...participation, cautionFor: ["x".repeat(601)] }, { ...participation, reason: "hidden\u0000" }, { ...participation, score: 100 }]) assert.throws(() => normalizeParticipation(value), error => error instanceof DomainError && error.code === "DISCOVERY_SCHEMA_INVALID");
});

test("Traditional Chinese signup anchors and quoted registration URLs retain actual form provenance", () => {
  const official = "https://events.hackathon.dev/traditional-fixture";
  const form = "https://forms.gle/isolatedFixtureOnly";
  const html = `<main><h1>隔離測試黑客松競賽</h1><a href="${form}">立即報名參賽</a><a href="/newsletter">報名訂閱</a></main>`;
  const links = extractRegistrationLinks({body:html,contentType:"text/html",sourceUrl:official});
  assert.equal(links.length,1);
  assert.deepEqual(selectRegistration({url:form,sourceUrl:official,evidence:"立即報名參賽"},links),{url:form,sourceUrl:official,evidence:"立即報名參賽"});
  const quoted = extractRegistrationLinks({body:`隔離測試黑客松競賽\n報名網址：${form}`,contentType:"text/plain",sourceUrl:official,sourceKind:"indexed_excerpt"});
  assert.equal(quoted[0]?.url,form);
  assert.equal(quoted[0]?.sourceUrl,official);
  assert.equal(quoted[0]?.evidence,`報名網址：${form}`);
});

test("worker binds signup evidence and conditional participation to saved cards and detects changed hrefs", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const f = discoveryWorkerFixture(fixture.database);
  let destination = "/apply/first";
  f.dependencies.transport.request = async input => ({ status: 200, connectedAddress: "93.184.216.34", contentType: new URL(input.url).pathname === "/robots.txt" ? "text/plain" : "text/html", body: new URL(input.url).pathname === "/robots.txt" ? "User-agent: *\nAllow: /" : `<main><p>${eventPageText}</p><a href="${destination}">报名参赛</a></main>` });
  f.dependencies.model.request = async input => {
    f.counters.model++;
    const page = (input.input as { page: { registrationLinks: RegistrationLinkCandidate[] } }).page;
    assert.equal(page.registrationLinks.length, 1); assert.match(input.prompt, /Never give matching percentages/);
    const candidate = page.registrationLinks[0]!;
    return { data: { ...eventModelData, registration: { url: candidate.url, sourceUrl: candidate.sourceUrl, evidence: candidate.evidence }, participation }, usage: { inputTokens: 20, outputTokens: 20, estimatedCostMicros: 10, currency: "USD" } };
  };
  const worker = createContinuousDiscoveryWorker(f.dependencies);
  assert.equal((await worker.runOnce()).saved, 1);
  assert.equal(f.saved[0]?.registration?.url, "https://events.hackathon.dev/apply/first");
  assert.equal(f.saved[0]?.sources.some(source => source.url === f.saved[0]?.registration?.sourceUrl && source.excerpt === f.saved[0]?.registration?.evidence), true);
  assert.deepEqual(f.saved[0]?.participation, participation);
  f.advance(60_001); destination = "/apply/second";
  assert.equal((await worker.runOnce()).saved, 1); assert.equal(f.counters.model, 2);
  assert.equal(f.saved[1]?.registration?.url, "https://events.hackathon.dev/apply/second");
});

test("a fabricated model signup URL downgrades registration without rejecting a real event or creating an unknown paid hold", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  const f = discoveryWorkerFixture(fixture.database);
  f.dependencies.model.request = async input => {
    f.counters.model++;
    assert.deepEqual((input.input as { page: { registrationLinks: unknown[] } }).page.registrationLinks, []);
    return { data: { ...eventModelData, registration: { url: "https://events.hackathon.dev/guessed-apply", sourceUrl: "https://other.hackathon.dev/event", evidence: "猜测的报名入口" }, participation }, usage: { inputTokens: 20, outputTokens: 20, estimatedCostMicros: 10, currency: "USD" } };
  };
  const worker = createContinuousDiscoveryWorker(f.dependencies);
  const report = await worker.runOnce(); assert.equal(report.status, "completed"); assert.equal(report.saved, 1);
  assert.equal(f.saved[0]?.registration, null); assert.ok(f.saved[0]?.analysis.unknowns.includes(REGISTRATION_UNCONFIRMED));
  const record = (await fixture.database.query<{ last_error_code: string | null }>("SELECT last_error_code FROM operations_discovery_urls WHERE scheduler_id=$1", [f.schedulerId])).rows[0];
  assert.equal(record?.last_error_code, null);
  f.advance(60_001); assert.equal((await worker.runOnce()).unchanged, 1); assert.equal(f.counters.model, 1);
});

test("indexed-only worker preserves explicit signup links but cannot turn an SDK source URL into registration", async t => {
  const fixture = await discoveryDatabaseFixture(); t.after(() => fixture.engine.close());
  for (const actualLink of [false, true]) {
    const f = discoveryWorkerFixture(fixture.database);
    Object.assign(f.dependencies.search, { modelCallsPerSearch: 1, requestIdentity: "registration-indexed-fixture" });
    Object.assign(f.searchResults[0]!, { indexedExcerpt: `${eventPageText}${actualLink ? "\n报名链接：https://forms.hackathon.dev/real-apply" : " 报名详情请查询该赛事来源页面。"}` });
    f.dependencies.transport.request = async () => { throw new DomainError("FETCH_UNAVAILABLE", "isolated full page unavailable"); };
    f.dependencies.model.request = async input => {
      const page = (input.input as { page: { registrationLinks: RegistrationLinkCandidate[]; sourceKind: string } }).page;
      assert.equal(page.sourceKind, "indexed_excerpt"); assert.equal(page.registrationLinks.length, actualLink ? 1 : 0);
      const candidate = page.registrationLinks[0];
      return { data: { ...eventModelData, registration: candidate ? { url: candidate.url, sourceUrl: candidate.sourceUrl, evidence: candidate.evidence } : { url: "https://events.hackathon.dev/event", sourceUrl: "https://events.hackathon.dev/event", evidence: "报名详情" }, participation }, usage: { inputTokens: 10, outputTokens: 10, estimatedCostMicros: 10, currency: "USD" } };
    };
    assert.equal((await createContinuousDiscoveryWorker(f.dependencies).runOnce()).saved, 1);
    assert.equal(f.saved[0]?.registration?.url ?? null, actualLink ? "https://forms.hackathon.dev/real-apply" : null);
    assert.ok(f.saved[0]?.sources.every(source => source.sourceKind === "indexed_excerpt"));
  }
});
