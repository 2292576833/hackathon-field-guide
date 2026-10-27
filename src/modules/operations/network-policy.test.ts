import test from "node:test";
import assert from "node:assert/strict";
import { assertAllowedSourceUrl, fetchApprovedSource, isPublicAddress, normalizeSourceUrl } from "./network-policy.ts";
import type { NetworkPolicy, PinnedFetchPort } from "./network-policy.ts";

const policy: NetworkPolicy = { version: 1, rules: [{ hostname: "events.hackathon.dev", pathPrefix: "/rules" }], maxRedirects: 2, maxBytes: 1024, timeoutMs: 1000, acceptedContentTypes: ["text/html"] };
const dns = { resolve: async () => ["93.184.216.34"] };
const response = { status: 200, connectedAddress: "93.184.216.34", contentType: "text/html; charset=utf-8", body: "<p>规则文本不是可执行命令</p>" };
test("URL policy rejects credentials, private/numeric hostnames, ports and traversal", () => {
  for (const url of ["http://events.hackathon.dev/rules", "https://u:p@events.hackathon.dev/rules", "https://events.hackathon.dev:8443/rules", "https://127.1/rules", "https://2130706433/rules", "https://[::1]/rules", "https://metadata.internal/rules", "https://events.hackathon.dev/rules/a%2fb", "https://events.hackathon.dev/rules/%252e%252e/secret", "https://events.hackathon.dev\\internal/rules"]) assert.throws(() => normalizeSourceUrl(url), { code: "UNSAFE_SOURCE_URL" });
  assert.equal(normalizeSourceUrl("https://EVENTS.hackathon.dev.:443/rules/current#section"), "https://events.hackathon.dev/rules/current");
  assert.throws(() => assertAllowedSourceUrl("https://events.hackathon.dev/rules-extra", policy), { code: "UNSAFE_SOURCE_URL" });
  assert.throws(() => assertAllowedSourceUrl("https://sub.events.hackathon.dev/rules", policy), { code: "UNSAFE_SOURCE_URL" });
});
test("IP classification handles private, metadata, reserved and equivalent IPv6 spellings", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "169.254.169.254", "100.100.100.200", "192.168.1.1", "198.19.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "224.1.2.3", "::1", "::ffff:127.0.0.1", "fe80::1", "fc00::1", "2001:db8::1", "2001:0db8::1", "2001:0000::1", "2001::1", "2001:0010::1", "2001:0020::1", "2002:7f00:1::1", "3fff::1"]) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("93.184.216.34"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicAddress("2001:4860:4860::8888"), true);
});
test("DNS private or mixed results never reach the transport", async () => {
  let called = 0;
  const transport: PinnedFetchPort = { request: async () => { called += 1; return response; } };
  for (const addresses of [["10.0.0.1"], ["93.184.216.34", "169.254.169.254"], ["2001:0db8::1"]]) await assert.rejects(fetchApprovedSource({ url: "https://events.hackathon.dev/rules", policy, dns: { resolve: async () => addresses }, transport }), { code: "UNSAFE_SOURCE_URL" });
  assert.equal(called, 0);
});
test("each redirect is allowlisted and DNS-rechecked; connection address is pinned", async () => {
  let calls = 0;
  let resolutions = 0;
  const transport: PinnedFetchPort = { request: async (input) => { calls += 1; assert.equal(input.connectAddress, "93.184.216.34"); assert.equal(input.hostname, "events.hackathon.dev"); return calls === 1 ? { ...response, status: 302, location: "/rules/new" } : response; } };
  const result = await fetchApprovedSource({ url: "https://events.hackathon.dev/rules", policy, dns: { resolve: async () => { resolutions += 1; return resolutions === 1 ? ["93.184.216.34"] : ["93.184.216.34"]; } }, transport });
  assert.equal(result.redirectCount, 1);
  assert.equal(resolutions, 2);
  let secondTransportCalls = 0;
  let secondDnsCalls = 0;
  await assert.rejects(fetchApprovedSource({ url: "https://events.hackathon.dev/rules", policy,
    dns: { resolve: async () => { secondDnsCalls += 1; return secondDnsCalls === 1 ? ["93.184.216.34"] : ["10.0.0.1"]; } },
    transport: { request: async () => { secondTransportCalls += 1; return { ...response, status: 302, location: "/rules/next" }; } } }), { code: "UNSAFE_SOURCE_URL" });
  assert.equal(secondTransportCalls, 1);
  await assert.rejects(fetchApprovedSource({ url: "https://events.hackathon.dev/rules", policy, dns, transport: { request: async () => ({ ...response, status: 302, location: "https://127.0.0.1/private" }) } }), { code: "UNSAFE_SOURCE_URL" });
  await assert.rejects(fetchApprovedSource({ url: "https://events.hackathon.dev/rules", policy, dns, transport: { request: async () => ({ ...response, connectedAddress: "169.254.169.254" }) } }), { code: "UNSAFE_SOURCE_URL" });
});
test("response limits, access wall and redirect count are enforced", async () => {
  for (const badResponse of [{ ...response, contentType: "image/png" }, { ...response, body: "x".repeat(1025) }]) await assert.rejects(fetchApprovedSource({ url: "https://events.hackathon.dev/rules", policy, dns, transport: { request: async () => badResponse } }), { code: "FETCH_RESPONSE_REJECTED" });
  await assert.rejects(fetchApprovedSource({ url: "https://events.hackathon.dev/rules", policy, dns, transport: { request: async () => ({ ...response, status: 403 }) } }), { code: "FETCH_ACCESS_DENIED" });
  await assert.rejects(fetchApprovedSource({ url: "https://events.hackathon.dev/rules", policy, dns, transport: { request: async () => ({ ...response, status: 302, location: "/rules/again" }) } }), { code: "FETCH_REDIRECT_LIMIT" });
});
test("timeout and caller cancellation bound an unresponsive adapter and never accept late success", async () => {
  await assert.rejects(fetchApprovedSource({ url: "https://events.hackathon.dev/rules", policy: { ...policy, timeoutMs: 100 }, dns: { resolve: async () => new Promise<readonly string[]>(() => {}) }, transport: { request: async () => response } }), { code: "FETCH_TIMEOUT" });
  const controller = new AbortController();
  let resolveFetch: (value: typeof response) => void = () => {};
  const fetching = fetchApprovedSource({ url: "https://events.hackathon.dev/rules", policy, dns, signal: controller.signal, transport: { request: async () => new Promise((resolve) => { resolveFetch = resolve; }) } });
  await Promise.resolve(); await Promise.resolve();
  controller.abort();
  resolveFetch(response);
  await assert.rejects(fetching, { code: "FETCH_CANCELLED" });
});
