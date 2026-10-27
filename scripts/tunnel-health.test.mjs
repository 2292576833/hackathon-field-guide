import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { classify, parseOptions, probe } from "./tunnel-health.mjs";

const healthy = () => ({ ok: true });
const failed = (error = "TIMEOUT") => ({ ok: false, error });
const checks = (overrides = {}) => ({
  localPage: healthy(),
  localSystem: healthy(),
  publicPage: failed(),
  publicSystem: failed(),
  pinnedPage: failed(),
  pinnedSystem: failed(),
  legacyPage: failed(),
  systemDns: { addresses: [] },
  googleDns: failed(),
  cloudflareDns: failed(),
  ...overrides,
});

test("CLI options have bounded defaults and accept both finite boundaries", () => {
  assert.deepEqual(parseOptions([]), { count: 1, intervalSeconds: 15, timeoutMs: 8000 });
  assert.deepEqual(parseOptions(["--count", "1", "--interval-seconds", "10", "--timeout-ms", "1000"]), {
    count: 1, intervalSeconds: 10, timeoutMs: 1000,
  });
  assert.deepEqual(parseOptions(["--count", "60", "--interval-seconds", "60", "--timeout-ms", "15000"]), {
    count: 60, intervalSeconds: 60, timeoutMs: 15000,
  });
});

test("CLI rejects missing, unknown, noninteger and out-of-range options", () => {
  const invalid = [
    ["--count"], ["--unknown", "1"], ["--count", "0"], ["--count", "61"],
    ["--count", "1.5"], ["--count", "NaN"], ["--count", "Infinity"],
    ["--count", ""], ["--interval-seconds", "9"], ["--interval-seconds", "61"],
    ["--timeout-ms", "999"], ["--timeout-ms", "15001"],
    ["--count", "1", "--timeout-ms"],
    ["__proto__", "1"], ["constructor", "1"], ["toString", "1"],
  ];
  for (const args of invalid) {
    assert.throws(() => parseOptions(args), /INVALID_OPTIONS/, JSON.stringify(args));
  }
});

test("both pinned checks succeeding never establish ordinary public health", () => {
  const report = classify(checks({ pinnedPage: healthy(), pinnedSystem: healthy() }));
  assert.equal(report.localHealthy, true);
  assert.equal(report.publicHealthy, false);
  assert.ok(report.findings.includes("NODE_ROUTE_WORKS_PUBLIC_ENTRY_FAILS"));
  assert.ok(!report.findings.includes("PUBLIC_HTTPS_HEALTHY"));
  assert.ok(!report.findings.includes("TUNNEL_OR_NODE_ROUTE_UNHEALTHY"));
  assert.equal(report.automaticRestart, "disabled");
});

test("public and pinned health each require page and system checks", () => {
  for (const only of ["publicPage", "publicSystem", "pinnedPage", "pinnedSystem"]) {
    const report = classify(checks({ [only]: healthy() }));
    assert.equal(report.publicHealthy, false, only);
    assert.ok(!report.findings.includes("NODE_ROUTE_WORKS_PUBLIC_ENTRY_FAILS"), only);
  }
  const report = classify(checks({ publicPage: healthy(), publicSystem: healthy() }));
  assert.equal(report.publicHealthy, true);
  assert.ok(report.findings.includes("PUBLIC_HTTPS_HEALTHY"));
});

test("local HTTP failures are distinguished from a failing tunnel with healthy local HTTP", () => {
  for (const local of ["localPage", "localSystem"]) {
    const report = classify(checks({ [local]: failed("ECONNREFUSED") }));
    assert.equal(report.localHealthy, false);
    assert.ok(report.findings.includes("LOCAL_HTTP_UNHEALTHY"));
    assert.ok(!report.findings.includes("TUNNEL_OR_NODE_ROUTE_UNHEALTHY"));
  }
  const report = classify(checks());
  assert.equal(report.localHealthy, true);
  assert.ok(!report.findings.includes("LOCAL_HTTP_UNHEALTHY"));
  assert.ok(report.findings.includes("TUNNEL_OR_NODE_ROUTE_UNHEALTHY"));
});

test("certificate failures and a broken automatic HTTPS mode remain distinct", () => {
  const cert = classify(checks({
    legacyPage: failed("DEPTH_ZERO_SELF_SIGNED_CERT"),
    publicSystem: failed("ERR_TLS_CERT_ALTNAME_INVALID"),
  }));
  assert.ok(cert.findings.includes("LEGACY_ENTRY_CERTIFICATE_INVALID"));
  assert.ok(cert.findings.includes("PUBLIC_CERTIFICATE_INVALID"));
  assert.ok(!cert.findings.includes("CHECK_AUTO_HTTPS_MODE"));
  const mode = classify(checks({ pinnedPage: failed("ERR_SSL_WRONG_VERSION_NUMBER") }));
  assert.ok(mode.findings.includes("CHECK_AUTO_HTTPS_MODE"));
  assert.ok(!mode.findings.includes("PUBLIC_CERTIFICATE_INVALID"));
});

test("DNS disagreement uses only successful HTTPS DNS responses", () => {
  const base = {
    systemDns: { addresses: ["192.0.2.1"] },
    googleDns: { ok: true, dns: { addresses: ["192.0.2.2"] } },
    cloudflareDns: { ok: false, dns: { addresses: ["192.0.2.1"] } },
  };
  assert.ok(classify(checks(base)).findings.includes("SYSTEM_DNS_DIFFERS_FROM_HTTPS_DNS"));
  assert.ok(!classify(checks({ ...base, systemDns: { addresses: ["192.0.2.2"] } })).findings.includes("SYSTEM_DNS_DIFFERS_FROM_HTTPS_DNS"));
  assert.ok(!classify(checks({ systemDns: base.systemDns })).findings.includes("SYSTEM_DNS_DIFFERS_FROM_HTTPS_DNS"));
});

async function fixture(t) {
  const server = http.createServer((req, res) => {
    const send = (status, type, body) => {
      res.writeHead(status, { "content-type": type, "x-private-fixture": "header-must-not-escape" });
      res.end(body);
    };
    switch (req.url) {
      case "/page": return send(200, "text/html; charset=utf-8", "<title>黑客松情报局</title>");
      case "/foreign": return send(200, "text/html", "<title>Unrelated reverse proxy</title>body-must-not-escape");
      case "/plain": return send(200, "text/plain", "黑客松情报局");
      case "/status": return send(503, "text/html", "<title>黑客松情报局</title>");
      case "/redirect": res.setHeader("location", "/page"); return send(302, "text/html", "黑客松情报局");
      case "/system": return send(200, "application/json", JSON.stringify({ data: { mode: "local", dshConfigured: false } }));
      case "/wrong-system": return send(200, "application/json", JSON.stringify({ data: { mode: "local", dshConfigured: "true" } }));
      case "/broken-json": return send(200, "application/json", "{broken");
      case "/dns": return send(200, "application/json", JSON.stringify({ Status: 0, Answer: [
        { type: 1, data: "192.0.2.7" }, { type: 5, data: "alias.example" }, { type: 1, data: "not-an-ip" },
      ] }));
      case "/dns-empty": return send(200, "application/json", JSON.stringify({ Status: 0, Answer: [] }));
      case "/too-large": return send(200, "text/html", "<title>黑客松情报局</title>" + "x".repeat(1024 * 1024));
      case "/stall": return;
      default: return send(404, "text/plain", "Unknown fixture endpoint");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("local HTTP fixture verifies identity, status, response limits and deadline", async (t) => {
  const origin = await fixture(t);
  await t.test("branded HTML and a correctly shaped system response are accepted", async () => {
    const page = await probe(`${origin}/page`, { timeoutMs: 1000 });
    assert.equal(page.ok, true);
    assert.equal(page.identity, true);
    const system = await probe(`${origin}/system`, { kind: "system", timeoutMs: 1000 });
    assert.equal(system.ok, true, "dshConfigured=false is a valid system identity, not a tunnel outage");
  });
  await t.test("unrelated 200, wrong media type and malformed system responses fail", async () => {
    for (const [path, kind] of [["foreign", "page"], ["plain", "page"], ["wrong-system", "system"], ["broken-json", "system"]]) {
      const result = await probe(`${origin}/${path}`, { kind, timeoutMs: 1000 });
      assert.equal(result.ok, false, path);
      assert.equal(result.error, "UNEXPECTED_RESPONSE", path);
    }
  });
  await t.test("a branded error or redirect is not a successful site response", async () => {
    for (const path of ["status", "redirect"]) {
      const result = await probe(`${origin}/${path}`, { timeoutMs: 1000 });
      assert.equal(result.ok, false);
      assert.equal(result.error, "HTTP_STATUS");
    }
  });
  await t.test("DNS identity requires a usable IPv4 A answer", async () => {
    const answer = await probe(`${origin}/dns`, { kind: "dns", timeoutMs: 1000 });
    assert.equal(answer.ok, true);
    assert.deepEqual(answer.dns.addresses, ["192.0.2.7"]);
    assert.equal((await probe(`${origin}/dns-empty`, { kind: "dns", timeoutMs: 1000 })).ok, false);
  });
  await t.test("response body and headers are absent from returned metadata", async () => {
    const output = JSON.stringify(await probe(`${origin}/foreign`, { timeoutMs: 1000 }));
    assert.ok(!output.includes("body-must-not-escape"));
    assert.ok(!output.includes("header-must-not-escape"));
    assert.ok(!output.includes("Unrelated reverse proxy"));
  });
  await t.test("oversized branded responses fail", async () => {
    const result = await probe(`${origin}/too-large`, { timeoutMs: 1000 });
    assert.equal(result.ok, false);
    assert.equal(result.error, "RESPONSE_TOO_LARGE");
  });
  await t.test("a connection that never responds reaches the bounded deadline", async () => {
    const result = await probe(`${origin}/stall`, { timeoutMs: 100 });
    assert.equal(result.ok, false);
    assert.equal(result.error, "TIMEOUT");
  });
  await t.test("HTTP pinning and invalid address pins fail before connecting", async () => {
    assert.equal((await probe(`${origin}/page`, { pin: "127.0.0.1" })).error, "INVALID_PIN");
    assert.equal((await probe("https://127.0.0.1:1/", { pin: "not-an-ip" })).error, "INVALID_PIN");
  });
});
