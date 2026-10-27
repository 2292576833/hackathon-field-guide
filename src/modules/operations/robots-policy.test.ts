import test from "node:test";
import assert from "node:assert/strict";
import { assertRobotsAllowed, robotsAllows } from "./robots-policy.ts";
import type { NetworkPolicy, PinnedFetchPort, PinnedFetchRequest } from "./network-policy.ts";

const userAgent = "HackathonIntelBot/1.0";
const sourceUrl = "https://events.hackathon.dev/rules/public";
const policy: NetworkPolicy = { version: 1, rules: [{ hostname: "events.hackathon.dev", pathPrefix: "/rules" }],
  maxRedirects: 2, maxBytes: 1024, timeoutMs: 100, acceptedContentTypes: ["text/html"] };
const response = { status: 200, connectedAddress: "93.184.216.34", contentType: "text/plain; charset=utf-8", body: "User-agent: *\nDisallow: /private\n" };
const dns = { resolve: async () => ["93.184.216.34"] };
const check = (transport: PinnedFetchPort, extra: Partial<Parameters<typeof assertRobotsAllowed>[0]> = {}) =>
  assertRobotsAllowed({ sourceUrl, policy, dns, transport, userAgent, ...extra });

test("specific product groups merge and override wildcard; matching uses case-sensitive path", () => {
  const body = "User-agent: *\nDisallow: /\nUser-agent: hackathonintelbot\nDisallow: /rules/private\nUser-agent: HackathonIntelBot\nDisallow: /rules/secret\n";
  assert.equal(robotsAllows(body, sourceUrl, userAgent), true);
  assert.equal(robotsAllows(body, "https://events.hackathon.dev/rules/private", userAgent), false);
  assert.equal(robotsAllows(body, "https://events.hackathon.dev/rules/secret", userAgent), false);
  assert.equal(robotsAllows(body, "https://events.hackathon.dev/rules/Private", userAgent), true);
  assert.equal(robotsAllows(body, sourceUrl, "OtherBot"), false);
});

test("longest rule wins; Allow breaks ties; empty disallow does not match all paths", () => {
  const body = "User-agent: *\nDisallow: /rules\nAllow: /rules/public\nDisallow: /rules/public\nDisallow:\n";
  assert.equal(robotsAllows(body, sourceUrl, userAgent), true);
  assert.equal(robotsAllows(body, "https://events.hackathon.dev/rules/private", userAgent), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow:\n", sourceUrl, userAgent), true);
  assert.equal(robotsAllows("Disallow: /\nUser-agent: *\nSitemap: https://unused.invalid/a\nAllow: /\n", sourceUrl, userAgent), true);
});

test("wildcards and terminal anchors match path plus query without unsafe regex", () => {
  const body = "User-agent: *\nDisallow: /*.pdf$\nDisallow: /rules/*?draft=*\nAllow: /rules/public.pdf$\n";
  for (const [path, allowed] of [["/a.pdf", false], ["/a.pdf?view=public", true], ["/rules/public.pdf", true], ["/rules/event?draft=yes", false], ["/rules/event?ready=yes", true]] as const) {
    assert.equal(robotsAllows(body, `https://events.hackathon.dev${path}`, userAgent), allowed, path);
  }
  assert.equal(robotsAllows("User-agent: *\nDisallow: /*a*a*a*a*b$", `https://events.hackathon.dev/${"a".repeat(2000)}`, userAgent), true);
});

test("Unicode and percent-encoded octets match; escaped wildcard stays literal", () => {
  assert.equal(robotsAllows("User-agent: *\nDisallow: /rules/规则", "https://events.hackathon.dev/rules/%E8%A7%84%E5%88%99", userAgent), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /rules/%70ublic", sourceUrl, userAgent), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /rules/%2A", "https://events.hackathon.dev/rules/*", userAgent), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /rules/%2A", sourceUrl, userAgent), true);
});

test("approved path scope permits only same-origin root robots retrieval", async () => {
  const requests: PinnedFetchRequest[] = [];
  assert.equal((await check({ request: async (request) => { requests.push(request); return response; } })).status, "allowed");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://events.hackathon.dev/robots.txt");
  assert.deepEqual(requests[0].acceptedContentTypes, ["text/plain"]);
  assert.equal(requests[0].maxBytes, 1024);
  await assert.rejects(check({ request: async () => response }, { sourceUrl: "https://events.hackathon.dev/not-approved" }), { code: "UNSAFE_SOURCE_URL" });
});

test("same-origin exact robots redirect rechecks DNS; private rebind never reaches second socket", async () => {
  let resolutions = 0, requests = 0;
  await assert.rejects(check({ request: async () => { requests += 1; return { ...response, status: 302, location: "/robots.txt" }; } }, {
    dns: { resolve: async () => { resolutions += 1; return resolutions === 1 ? ["93.184.216.34"] : ["10.0.0.1"]; } },
  }), { code: "UNSAFE_SOURCE_URL" });
  assert.equal(resolutions, 2); assert.equal(requests, 1);
  for (const location of ["https://other.hackathon.dev/robots.txt", "/robots.txt/private", "/rules/public", "/robots.txt?token=secret"]) {
    requests = 0;
    await assert.rejects(check({ request: async () => { requests += 1; return { ...response, status: 302, location }; } }), { code: "ROBOTS_REDIRECT_REJECTED" });
    assert.equal(requests, 1);
  }
});

test("missing robots permits; deny rules, auth, rate, server and MIME failures stop collection", async () => {
  for (const status of [404, 410]) assert.equal((await check({ request: async () => ({ ...response, status }) })).status, "missing");
  for (const [override, code] of [
    [{ body: "User-agent: *\nDisallow: /rules" }, "ROBOTS_DISALLOWED"],
    [{ status: 403 }, "ROBOTS_ACCESS_DENIED"], [{ status: 401 }, "ROBOTS_ACCESS_DENIED"],
    [{ status: 429 }, "FETCH_RATE_LIMITED"], [{ status: 500 }, "ROBOTS_UNAVAILABLE"],
    [{ status: 400 }, "ROBOTS_UNAVAILABLE"], [{ contentType: "text/html" }, "ROBOTS_UNAVAILABLE"],
    [{ body: "\uFFFD" }, "ROBOTS_UNAVAILABLE"], [{ body: "x".repeat(1025) }, "ROBOTS_UNAVAILABLE"],
  ] as const) await assert.rejects(check({ request: async () => ({ ...response, ...override }) }), { code });
});

test("robots timeout and cancellation bound nonresponsive adapters", async () => {
  await assert.rejects(check({ request: async () => new Promise(() => {}) }), { code: "FETCH_TIMEOUT" });
  const controller = new AbortController();
  const pending = check({ request: async () => new Promise(() => {}) }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: "FETCH_CANCELLED" });
});
