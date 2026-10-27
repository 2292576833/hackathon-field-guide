import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import {
  createClientKeyProvider, createSignedProxyClientKeyProvider, normalizeClientAddress,
  signProxyClientAttestation, type ClientKeyPolicy, type ProxyClientAttestation,
} from "./client-key.ts";

const origin = "https://auth.example.test";
const now = Date.parse("2026-10-08T12:00:00Z");
const signingKey = "test-only-private-proxy-key-at-least-32-bytes";
const request = (headers: Record<string, string> = {}, target = "/api/v1/auth/login-challenges", method = "POST") => new Request(`http://127.0.0.1:3000${target}`, { method, headers });
const unavailable = (error: unknown) => error instanceof DomainError && error.code === "AUTH_CLIENT_SOURCE_UNAVAILABLE" && error.status === 503;
const basePacket: ProxyClientAttestation = { proxyId: "ingress-a", clientAddress: "198.51.100.14", issuedAt: now, method: "POST", target: "/api/v1/auth/login-challenges" };
const signedProvider = (currentTime = now) => createSignedProxyClientKeyProvider({ proxies: [{ id: "ingress-a", signingKey }], origin, clock: { now: () => new Date(currentTime) } });
const signedRequest = (packet: ProxyClientAttestation = basePacket, key = signingKey, siteOrigin = origin) => request({ "x-hackathon-client-attestation": signProxyClientAttestation(packet, siteOrigin, key) });

test("direct and explicitly shared budgets ignore arbitrary forwarding headers", async () => {
  const direct = createClientKeyProvider({ mode: "direct", connection: { getPeerAddress: () => "::ffff:198.51.100.14" } });
  const spoof = request({ "x-forwarded-for": "1.2.3.4", forwarded: "for=1.2.3.4", "x-real-ip": "1.2.3.4", "x-client-ip": "1.2.3.4" });
  assert.equal(await direct.getClientKey(spoof), "client:ip:198.51.100.14");
  const shared = createClientKeyProvider({ mode: "shared-budget", budgetId: "public-ingress" });
  assert.equal(await shared.getClientKey(spoof), await shared.getClientKey(request()));
  assert.throws(() => createClientKeyProvider({ mode: "shared-budget", budgetId: undefined } as unknown as ClientKeyPolicy));
});

test("proxy chains start at the verified peer and stop at the nearest untrusted address", async () => {
  const cidrs = ["10.0.0.0/24", "2001:db8:ffff::/48"];
  const proxy = createClientKeyProvider({ mode: "trusted-proxy", connection: { getPeerAddress: () => "10.0.0.2" }, trustedProxyCidrs: cidrs });
  const spoof = request({ "x-forwarded-for": "203.0.113.100, 198.51.100.14, 10.0.0.1" });
  assert.equal(await proxy.getClientKey(spoof), "client:ip:198.51.100.14");
  const v6 = createClientKeyProvider({ mode: "trusted-proxy", connection: { getPeerAddress: () => "2001:db8:ffff::2" }, trustedProxyCidrs: cidrs });
  assert.equal(await v6.getClientKey(request({ "x-forwarded-for": "2001:0db8:0000:0000:0000:0000:0000:0014, 2001:db8:ffff::1" })), "client:ip:2001:db8::14");
});

test("unknown or absent socket metadata cannot make a proxy header trusted", async () => {
  for (const peer of [null, "198.51.100.14", "not-an-address", "fe80::1%eth0"]) {
    const proxy = createClientKeyProvider({ mode: "trusted-proxy", connection: { getPeerAddress: () => peer }, trustedProxyCidrs: ["10.0.0.0/24"] });
    await assert.rejects(proxy.getClientKey(request({ "x-forwarded-for": "1.2.3.4", "x-proxy-peer": "10.0.0.1" })), unavailable);
  }
  const broken = createClientKeyProvider({ mode: "direct", connection: { getPeerAddress: () => { throw new Error("private transport error"); } } });
  await assert.rejects(broken.getClientKey(request()), (error: unknown) => unavailable(error) && error instanceof Error && !error.message.includes("private"));
  assert.throws(() => createClientKeyProvider({ mode: "trusted-proxy", connection: { getPeerAddress: () => "10.0.0.1" }, trustedProxyCidrs: [] }));
  assert.throws(() => createClientKeyProvider({ mode: "trusted-proxy", connection: { getPeerAddress: () => "10.0.0.1" }, trustedProxyCidrs: ["0.0.0.0/0"] }));
});

test("invalid, oversized and ambiguous chains fail instead of selecting an attacker-controlled address", async () => {
  const proxy = createClientKeyProvider({ mode: "trusted-proxy", connection: { getPeerAddress: () => "10.0.0.1" }, trustedProxyCidrs: ["10.0.0.0/24"], maxForwardedEntries: 2 });
  for (const value of ["", "10.0.0.2", "1.2.3.4,", "1.2.3.4:80", "[2001:db8::1]", "fe80::1%eth0", "unknown", "1.2.3.4, 10.0.0.2, 10.0.0.3", "1".repeat(2049)]) {
    await assert.rejects(proxy.getClientKey(request({ "x-forwarded-for": value })), unavailable);
  }
  const single = createClientKeyProvider({ mode: "trusted-proxy", connection: { getPeerAddress: () => "10.0.0.1" }, trustedProxyCidrs: ["10.0.0.0/24"], forwardedHeader: "x-real-ip" });
  assert.equal(await single.getClientKey(request({ "x-real-ip": "198.51.100.14" })), "client:ip:198.51.100.14");
  await assert.rejects(single.getClientKey(request({ "x-real-ip": "198.51.100.14, 10.0.0.2" })), unavailable);
});

test("equivalent mapped IPv4 and IPv6 addresses have a single canonical rate key", () => {
  assert.equal(normalizeClientAddress("::ffff:198.51.100.14"), normalizeClientAddress("198.51.100.14"));
  assert.equal(normalizeClientAddress("0:0:0:0:0:FFFF:c633:640e"), "198.51.100.14");
  assert.equal(normalizeClientAddress("2001:0DB8:0:0:0:0:0:1"), "2001:db8::1");
  for (const input of ["127.0.0.1:443", "192.168.01.2", "::1%lo", "[::1]", " 127.0.0.1", undefined]) assert.equal(normalizeClientAddress(input), null);
});

test("signed allowlisted proxy metadata works with an internal Next URL and ignores unsigned XFF", async () => {
  const provider = signedProvider();
  const encoded = signProxyClientAttestation({ ...basePacket, clientAddress: "::ffff:198.51.100.14" }, origin, signingKey);
  assert.equal(await provider.getClientKey(request({ "x-hackathon-client-attestation": encoded, "x-forwarded-for": "1.2.3.4" })), "client:ip:198.51.100.14");
  assert.equal(await provider.getClientKey(signedRequest()), "client:ip:198.51.100.14");
  assert.equal(await provider.getClientKey(signedRequest()), "client:ip:198.51.100.14"); // Stable replay remains in the same budget, never a new identity.
});

test("signature binds every field and the configured audience before IP normalization", async () => {
  const encoded = signProxyClientAttestation(basePacket, origin, signingKey);
  const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
  for (const change of [
    { proxyId: "ingress-b" }, { clientAddress: "198.51.100.15" }, { issuedAt: now + 1 },
    { method: "GET" }, { target: "/api/v1/auth/logout" }, { target: `${basePacket.target}?x=1` },
  ]) {
    const tampered = Buffer.from(JSON.stringify({ ...decoded, ...change })).toString("base64url");
    await assert.rejects(signedProvider().getClientKey(request({ "x-hackathon-client-attestation": tampered })), unavailable);
  }
  await assert.rejects(signedProvider().getClientKey(signedRequest(basePacket, signingKey, "https://other.example.test")), unavailable);
  await assert.rejects(signedProvider().getClientKey(signedRequest(basePacket, "different-test-proxy-secret-at-least-32-bytes")), unavailable);
});

test("signed method/path/query and timestamp TTL/skew boundaries are enforced", async () => {
  const provider = signedProvider(); const encoded = signProxyClientAttestation(basePacket, origin, signingKey);
  await assert.rejects(provider.getClientKey(request({ "x-hackathon-client-attestation": encoded }, `${basePacket.target}?x=1`)), unavailable);
  await assert.rejects(provider.getClientKey(request({ "x-hackathon-client-attestation": encoded }, basePacket.target, "GET")), unavailable);
  assert.equal(await signedProvider(now + 29_999).getClientKey(signedRequest()), "client:ip:198.51.100.14");
  await assert.rejects(signedProvider(now + 30_000).getClientKey(signedRequest()), unavailable);
  assert.equal(await signedProvider(now - 5_000).getClientKey(signedRequest()), "client:ip:198.51.100.14");
  await assert.rejects(signedProvider(now - 5_001).getClientKey(signedRequest()), unavailable);
});

test("missing/merged/noncanonical/oversized signed headers and unknown proxies fail closed", async () => {
  const provider = signedProvider(); const valid = signProxyClientAttestation(basePacket, origin, signingKey);
  for (const header of ["", `${valid},${valid}`, `${valid}=`, "!", "a".repeat(4097), Buffer.from("null").toString("base64url"), Buffer.from(JSON.stringify({ ...basePacket, signature: "not-a-hash" })).toString("base64url")]) {
    await assert.rejects(provider.getClientKey(request({ "x-hackathon-client-attestation": header })), unavailable);
  }
  await assert.rejects(provider.getClientKey(request()), unavailable);
  await assert.rejects(provider.getClientKey(signedRequest({ ...basePacket, proxyId: "not-listed" })), unavailable);
});

test("proxy trust is copied at construction and configuration cannot become a browser provider", async () => {
  const proxies = [{ id: "ingress-a", signingKey }];
  const provider = createSignedProxyClientKeyProvider({ proxies, origin, clock: { now: () => new Date(now) } });
  proxies[0]!.signingKey = "changed-test-key-at-least-thirty-two-bytes";
  proxies.push({ id: "ingress-b", signingKey });
  assert.equal(await provider.getClientKey(signedRequest()), "client:ip:198.51.100.14");
  await assert.rejects(provider.getClientKey(signedRequest({ ...basePacket, proxyId: "ingress-b" })), unavailable);
  for (const patch of [{ proxies: [] }, { proxies: [{ id: "ingress-a", signingKey: "short" }] }, { headerName: "x-forwarded-for" }, { maxAgeMs: 0 }, { origin: `${origin}/` }]) {
    assert.throws(() => createSignedProxyClientKeyProvider({ proxies: [{ id: "ingress-a", signingKey }], origin, clock: { now: () => new Date(now) }, ...patch }));
  }
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  try { assert.throws(() => createClientKeyProvider({ mode: "shared-budget", budgetId: "a" }), /server runtime/); }
  finally { Reflect.deleteProperty(globalThis, "window"); }
});

test("a native IPv6 allowlist cannot implicitly trust every IPv4 peer through mapped space", async () => {
  const proxy = createClientKeyProvider({ mode: "trusted-proxy", connection: { getPeerAddress: () => "198.51.100.14" }, trustedProxyCidrs: ["::/80"] });
  await assert.rejects(proxy.getClientKey(request({ "x-forwarded-for": "2001:db8:1::1" })), unavailable);
  const mapped = createClientKeyProvider({ mode: "trusted-proxy", connection: { getPeerAddress: () => "::ffff:10.0.0.1" }, trustedProxyCidrs: ["::ffff:10.0.0.0/120"] });
  assert.equal(await mapped.getClientKey(request({ "x-forwarded-for": "198.51.100.14" })), "client:ip:198.51.100.14");
});
