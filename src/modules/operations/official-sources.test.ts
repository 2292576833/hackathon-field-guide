import test from "node:test";
import assert from "node:assert/strict";
import { OFFICIAL_EVENT_SOURCES, OFFICIAL_SOURCE_CATALOGUE, createOfficialSourceProvider, extractOfficialEventLinks, officialSourceDetailPolicy } from "./official-sources.ts";
import { assertAllowedSourceUrl, type PinnedFetchRequest, type PinnedFetchResponse, type PublicDnsPort } from "./network-policy.ts";

const ethCard = (slug: string, label = "IRL Hackathon", title = "ETHGlobal Mumbai") => `<article><a href="/events/${slug}"><span>${label}</span><h3>${title}</h3><p>November 5–7, 2026</p></a></article>`;
const ethHtml = `<h2>Featured <span>2</span></h2>${ethCard("featured")}<h2>Upcoming <span>7</span></h2>
 ${ethCard("mumbai")}${ethCard("online-hack", "Online")}${ethCard("pragma-mumbai", "Conference", "Pragma Mumbai")}${ethCard("co-working-week", "Co-working", "Co-working")}
 <h2>Past <span>332</span></h2>${ethCard("past-city")}`;
const labCard = (slug: string, label: string, title: string) => `<article><a href="/ai-hackathons/${slug}"><div><span>${label}</span><h3>${title}</h3><p>Dates on the list require verification.</p></div></a></article>`;
const labHtml = `${labCard("current-challenge", "LIVE", "Current Challenge")}${labCard("amd-developer-hackathon-act-iii", "Register", "AMD Developer Hackathon ACT III")}${labCard("vultr-hackathon", "Register", "Vultr Agent Rush")}${labCard("old-challenge", "Finished", "Old Challenge")}`;
function fixture(options: { html?: string; robots?: string; address?: string; response?: (request: PinnedFetchRequest) => PinnedFetchResponse | Promise<PinnedFetchResponse> } = {}) {
  const calls: PinnedFetchRequest[] = [];
  const dns: PublicDnsPort = { async resolve() { return [options.address ?? "93.184.216.34"]; } };
  const transport = { async request(input: PinnedFetchRequest): Promise<PinnedFetchResponse> {
    calls.push(input);
    assert.equal(input.connectAddress, "93.184.216.34"); assert.ok(input.resolvedAddresses.includes(input.connectAddress));
    if (options.response) return options.response(input);
    const robots = new URL(input.url).pathname === "/robots.txt";
    return { status: 200, connectedAddress: "93.184.216.34", contentType: robots ? "text/plain" : "text/html", body: robots ? options.robots ?? "User-agent: *\nAllow: /" : options.html ?? ethHtml };
  } };
  const provider = createOfficialSourceProvider({ sourceIds: ["ethglobal", "lablab"], userAgent: "HackathonFieldGuide/1.0", timeoutMs: 1000, maxBytes: 100_000, dns, transport });
  return { provider, calls };
}
const query = (id: string, count = 20) => ({ query: id, count, signal: new AbortController().signal });

test("official catalogue is immutable and only approved source IDs may be configured", () => {
  assert.equal(OFFICIAL_EVENT_SOURCES, OFFICIAL_SOURCE_CATALOGUE);
  assert.deepEqual(OFFICIAL_EVENT_SOURCES.map(source => source.id), ["ethglobal", "lablab"]);
  for (const source of OFFICIAL_EVENT_SOURCES) { assert.equal(source.url, source.listUrl); assert.ok(Object.isFrozen(source)); assert.ok(Object.isFrozen(source.detailLinkRules.hosts)); }
  for (const sourceIds of [[], ["other"], ["ethglobal", "ethglobal"], ["ethglobal", "lablab", "a", "b", "c", "d"]]) {
    assert.throws(() => createOfficialSourceProvider({ sourceIds, userAgent: "HackathonFieldGuide/1.0" }), { code: "INVALID_OFFICIAL_SOURCES" });
  }
});

test("ETHGlobal extracts upcoming hackathons, excluding Featured/Past/conference/co-working cards", () => {
  const links = extractOfficialEventLinks("ethglobal", ethHtml);
  assert.deepEqual(links.map(link => link.url), ["https://ethglobal.com/events/mumbai", "https://ethglobal.com/events/online-hack"]);
  assert.equal(links[0]!.title, "ETHGlobal Mumbai"); assert.match(links[0]!.description, /未.*核验/u);
  assert.equal(extractOfficialEventLinks("ethglobal", ethHtml, 1).length, 1);
  assert.deepEqual(extractOfficialEventLinks("ethglobal", "<h2>Upcoming Events</h2>" + ethCard("conference-week", "Conference")), []);
  assert.deepEqual(extractOfficialEventLinks("ethglobal", '<h2>Upcoming <b>Events</b></h2><a href="/events/nested-label"><span><b>IRL</b> Hackathon</span><h3>ETHGlobal <b>Mumbai</b></h3></a>').map(link => [link.url, link.title]), [["https://ethglobal.com/events/nested-label", "ETHGlobal Mumbai"]]);
});

test("lablab requires current card status and never accepts Finished cards or hydration scripts", () => {
  const links = extractOfficialEventLinks("lablab", labHtml);
  assert.deepEqual(links.map(link => link.url), ["https://lablab.ai/ai-hackathons/current-challenge", "https://lablab.ai/ai-hackathons/amd-developer-hackathon-act-iii", "https://lablab.ai/ai-hackathons/vultr-hackathon"]);
  assert.deepEqual(extractOfficialEventLinks("lablab", labCard("old-challenge", "Finished", "Old Challenge")), []);
  assert.throws(() => extractOfficialEventLinks("lablab", `<script>${labHtml}</script><a href="/ai-hackathons/bare-card">No status</a>`), { code: "OFFICIAL_SOURCE_RULES_CHANGED" });
  assert.throws(() => extractOfficialEventLinks("ethglobal", `<script>${ethHtml}</script>`), { code: "OFFICIAL_SOURCE_RULES_CHANGED" });
  assert.throws(() => extractOfficialEventLinks("lablab", '<a href="/ai-hackathons/news-page"><h3>News page</h3><p>Register for our newsletter to read about AI.</p></a>'), { code: "OFFICIAL_SOURCE_RULES_CHANGED" });
  assert.deepEqual(extractOfficialEventLinks("ethglobal", '<h2>Upcoming Events</h2><a href="/events/news-page"><h3>News page</h3><p>This page describes an online meeting.</p></a>'), []);
});

test("real October 2026 listing structure extracts deeply nested event titles without dates or status metadata", () => {
  // Reduced from the safely fetched public pages. Assets, hydration data and
  // long descriptions are omitted; heading/anchor/status nesting is preserved.
  const eth = `<h2>Featured <span>2</span></h2>${ethCard("featured")}
    <h2>Upcoming <span>7</span></h2><a class="block lg:col-span-2" href="/events/mumbai">
      <section><div><div><div>November</div><div><span>5</span><span>7</span></div><div>Thu<span>—</span>Sat</div></div>
        <div><h2 class="text-2xl md:text-4xl font-bold">ETHGlobal Mumbai</h2>
          <div><span><span>Mumbai, India</span></span><span><span>IRL Hackathon</span></span></div><div>Apply to Attend</div>
        </div></div></section></a>${ethCard("ethconf", "Conference", "ETHConf")}
    <h2>Past <span>332</span></h2>${ethCard("past-city")}`;
  assert.deepEqual(extractOfficialEventLinks("ethglobal", eth).map(link => [link.url, link.title]), [
    ["https://ethglobal.com/events/mumbai", "ETHGlobal Mumbai"],
  ]);
  const actualLabCard = (slug: string, status: string, title: string) => `<a class="flex h-full flex-col justify-between" href="/ai-hackathons/${slug}">
    <div><div class="relative aspect-video"></div></div><span class="absolute left-2 top-2">${status}</span><span>Hybrid</span>
    <div class="p-4 flex h-max flex-1 flex-col"><div class="mb-auto"><div><div><div><time dateTime="2026-10-12T15:00:00.000Z"><span>OCT 12 - 18</span></time></div></div><div><p>5085</p></div></div>
      <h2 hidden>Hidden title must not win</h2><h2 class="mt-1 line-clamp-1 font-bold leading-tight text-2xl">${title}</h2><p>Dates still require detail-page evidence.</p>
    </div></div></a>`;
  const lab = `<h1>AI Hackathons</h1>${actualLabCard("amd-lablab-ai-academy-challenge", "LIVE", "AMD AI League")}
    ${actualLabCard("amd-developer-hackathon-act-iii", "Register", "AMD Developer Hackathon: ACT III")}
    ${actualLabCard("vultr-hackathon", "Register", "Vultr: Agent Rush Hackathon")}
    ${actualLabCard("old-hackathon", "Finished", "Old Hackathon")}`;
  assert.deepEqual(extractOfficialEventLinks("lablab", lab).map(link => [link.url, link.title]), [
    ["https://lablab.ai/ai-hackathons/amd-lablab-ai-academy-challenge", "AMD AI League"],
    ["https://lablab.ai/ai-hackathons/amd-developer-hackathon-act-iii", "AMD Developer Hackathon: ACT III"],
    ["https://lablab.ai/ai-hackathons/vultr-hackathon", "Vultr: Agent Rush Hackathon"],
  ]);
});

test("detail links are canonicalized/deduplicated and tracker/auth/private/cross-host links are rejected", () => {
  const html = `<h2>Upcoming Events</h2>${ethCard("mumbai")}${ethCard("mumbai/")}
    <a href="https://www.ethglobal.com/events/mumbai"><span>Online</span><h3>Same official detail</h3></a>
    ${["/events/mumbai?utm_source=tracker", "/events/mumbai?token=private", "/events/login", "/events/private", "/events/archive", "https://evil.org/events/other", "https://127.0.0.1/events/other", "https://user:pass@ethglobal.com/events/other", "/events/%2fprivate", "/events/other#tracking", "javascript:alert(1)"].map(href => `<a href="${href}"><span>IRL Hackathon</span><h3>Rejected</h3></a>`).join("")}
    <template>${ethCard("hidden")}</template><div hidden>${ethCard("hidden-again")}</div>`;
  assert.deepEqual(extractOfficialEventLinks("ethglobal", html).map(link => link.url), ["https://ethglobal.com/events/mumbai"]);
  assert.deepEqual(extractOfficialEventLinks("ethglobal", '<H2>Upcoming Events</H2><A HREF="/events/uppercase"><span>Online</span><H3>Uppercase HTML</H3></A>').map(link => link.url), ["https://ethglobal.com/events/uppercase"]);
});

test("missing or overlarge/malformed listing rules stop with an actionable error instead of invented events", () => {
  assert.throws(() => extractOfficialEventLinks("ethglobal", "<h2>News</h2>" + ethCard("mumbai")), { code: "OFFICIAL_SOURCE_RULES_CHANGED" });
  assert.throws(() => extractOfficialEventLinks("ethglobal", ethHtml, 20, { maxBytes: 20 }), { code: "OFFICIAL_SOURCE_RULES_CHANGED" });
  assert.throws(() => officialSourceDetailPolicy("https://ethglobal.com/events"), { code: "OFFICIAL_SOURCE_LINK_REJECTED" });
  const policy = officialSourceDetailPolicy("https://ethglobal.com/events/mumbai");
  assert.equal(assertAllowedSourceUrl("https://www.ethglobal.com/events/mumbai/", policy), "https://www.ethglobal.com/events/mumbai/");
  assert.throws(() => assertAllowedSourceUrl("https://ethglobal.com/events/other", policy), { code: "UNSAFE_SOURCE_URL" });
  assert.throws(() => assertAllowedSourceUrl("https://evil.org/events/mumbai", policy), { code: "UNSAFE_SOURCE_URL" });
});

test("source check uses robots then pinned HTML fetch, with no key or unrestricted fetch", async () => {
  const f = fixture(); const links = await f.provider.search(query("ethglobal", 2));
  assert.equal(f.provider.resultOrdering, "interleave"); assert.equal(links.length, 2);
  assert.deepEqual(f.calls.map(call => call.url), ["https://ethglobal.com/robots.txt", "https://ethglobal.com/events"]);
  assert.ok(f.calls.every(call => call.maxBytes <= 100_000));
  assert.equal(links[0]!.detailPolicy!.rules[0]!.pathPrefix, "/events/mumbai");
  await assert.rejects(f.provider.search(query("https://evil.org/events")), { code: "INVALID_OFFICIAL_SOURCE_QUERY" });
  assert.equal(f.calls.length, 2);
});

test("robots deny/unavailable, private DNS, wrong peer IP and request cancellation stop safely", async () => {
  const denied = fixture({ robots: "User-agent: *\nDisallow: /events" });
  await assert.rejects(denied.provider.search(query("ethglobal")), { code: "ROBOTS_DISALLOWED" }); assert.equal(denied.calls.length, 1);
  const privateDns = fixture({ address: "127.0.0.1" });
  await assert.rejects(privateDns.provider.search(query("ethglobal")), { code: "UNSAFE_SOURCE_URL" }); assert.equal(privateDns.calls.length, 0);
  const unavailable = fixture({ response: () => ({ status: 500, connectedAddress: "93.184.216.34", contentType: "text/plain", body: "unavailable" }) });
  await assert.rejects(unavailable.provider.search(query("ethglobal")), { code: "ROBOTS_UNAVAILABLE" });
  const rebinding = fixture({ response: () => ({ status: 200, connectedAddress: "127.0.0.1", contentType: "text/plain", body: "User-agent: *\nAllow: /" }) });
  await assert.rejects(rebinding.provider.search(query("ethglobal")), { code: "UNSAFE_SOURCE_URL" });
  const controller = new AbortController(); controller.abort(); const cancelled = fixture();
  await assert.rejects(cancelled.provider.search({ ...query("ethglobal"), signal: controller.signal }), { code: "FETCH_CANCELLED" }); assert.equal(cancelled.calls.length, 0);
});

test("only same official listing canonical redirects are allowed and each host rechecks robots", async () => {
  const f = fixture({ response: request => {
    const url = new URL(request.url);
    if (url.pathname === "/robots.txt") return { status: 200, connectedAddress: "93.184.216.34", contentType: "text/plain", body: "User-agent: *\nAllow: /" };
    if (url.hostname === "ethglobal.com") return { status: 301, connectedAddress: "93.184.216.34", contentType: "text/html", body: "", location: "https://www.ethglobal.com/events/" };
    return { status: 200, connectedAddress: "93.184.216.34", contentType: "text/html", body: ethHtml };
  } });
  assert.equal((await f.provider.search(query("ethglobal"))).length, 2);
  assert.deepEqual(f.calls.map(call => call.url), ["https://ethglobal.com/robots.txt", "https://ethglobal.com/events", "https://www.ethglobal.com/robots.txt", "https://www.ethglobal.com/events/"]);
  const escaped = fixture({ response: request => new URL(request.url).pathname === "/robots.txt"
    ? { status: 200, connectedAddress: "93.184.216.34", contentType: "text/plain", body: "User-agent: *\nAllow: /" }
    : { status: 302, connectedAddress: "93.184.216.34", contentType: "text/html", body: "", location: "https://evil.org/events" } });
  await assert.rejects(escaped.provider.search(query("ethglobal")), { code: "UNSAFE_SOURCE_URL" }); assert.equal(escaped.calls.length, 2);
  const sibling = fixture({ response: request => new URL(request.url).pathname === "/robots.txt"
    ? { status: 200, connectedAddress: "93.184.216.34", contentType: "text/plain", body: "User-agent: *\nAllow: /" }
    : { status: 302, connectedAddress: "93.184.216.34", contentType: "text/html", body: "", location: "/events/mumbai" } });
  await assert.rejects(sibling.provider.search(query("ethglobal")), { code: "OFFICIAL_SOURCE_LINK_REJECTED" }); assert.equal(sibling.calls.length, 2);
});
