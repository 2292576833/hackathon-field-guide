// Read-only diagnostics. No credentials, process management, DNS changes or TLS bypasses.
// node scripts/tunnel-health.mjs [--count 1..60] [--interval-seconds 10..60] [--timeout-ms 1000..15000]
import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

const HOST = "hib.mywire.org";
const NODE_IP = "60.215.128.117"; // Observed node; diagnostic only, never an OS DNS override.
const PORT = 44353;
const LIMIT = 1024 * 1024;
const CERT_ERRORS = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_REVOKED",
]);

export function parseOptions(args) {
  const options = { count: 1, intervalSeconds: 15, timeoutMs: 8000 };
  const specs = {
    "--count": ["count", 1, 60],
    "--interval-seconds": ["intervalSeconds", 10, 60],
    "--timeout-ms": ["timeoutMs", 1000, 15000],
  };
  for (let i = 0; i < args.length; i += 2) {
    const spec = Object.hasOwn(specs, args[i]) ? specs[args[i]] : undefined;
    const value = Number(args[i + 1]);
    if (!spec || !Number.isInteger(value) || value < spec[1] || value > spec[2]) {
      throw new Error("INVALID_OPTIONS");
    }
    options[spec[0]] = value;
  }
  return options;
}

// Only safe metadata leaves this function. Response bodies and headers are never printed.
export function probe(url, { timeoutMs = 8000, pin, kind = "page" } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const secure = new URL(url).protocol === "https:";
    let done = false;
    let response;
    let timer;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, ...result, elapsedMs: Date.now() - started });
    };
    const options = {
      method: "GET", agent: false, rejectUnauthorized: true,
      headers: { accept: kind === "page" ? "text/html" : "application/json", "user-agent": "hib-tunnel-health/1.0", connection: "close" },
    };
    if (pin) {
      if (!secure || !isIP(pin)) { finish({ error: "INVALID_PIN" }); return; }
      // URL hostname remains the SNI, Host header and certificate identity.
      options.lookup = (_host, lookupOptions, callback) => {
        const answer = { address: pin, family: isIP(pin) };
        callback(null, lookupOptions.all ? [answer] : answer.address, answer.family);
      };
    }
    const request = (secure ? https : http).request(url, options, (res) => {
      response = res;
      const tls = secure ? {
        authorized: res.socket.authorized === true,
        protocol: res.socket.getProtocol(),
        subjectAltName: res.socket.getPeerCertificate()?.subjectaltname ?? null,
        validTo: res.socket.getPeerCertificate()?.valid_to ?? null,
      } : undefined;
      const remoteAddress = res.socket.remoteAddress;
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > LIMIT) {
          finish({ error: "RESPONSE_TOO_LARGE", status: res.statusCode });
          res.destroy(); request.destroy();
        } else chunks.push(chunk);
      });
      res.once("error", (error) => finish({ error: error.code ?? "RESPONSE_ERROR" }));
      res.once("aborted", () => finish({ error: "RESPONSE_ABORTED" }));
      res.once("end", () => {
        if (done) return;
        const body = Buffer.concat(chunks).toString("utf8");
        let identity = false;
        let dns;
        if (kind === "page") identity = body.includes("黑客松情报局") && /text\/html/i.test(res.headers["content-type"] ?? "");
        else {
          try {
            const data = JSON.parse(body);
            if (kind === "system") identity = ["local", "connected"].includes(data?.data?.mode) && typeof data?.data?.dshConfigured === "boolean";
            if (kind === "dns") {
              dns = { status: data.Status, addresses: (data.Answer ?? []).filter((a) => a.type === 1 && isIP(a.data) === 4).map((a) => a.data) };
              identity = dns.status === 0 && dns.addresses.length > 0;
            }
          } catch { /* Invalid JSON is a failed identity check. */ }
        }
        const ok = res.statusCode === 200 && identity && (!secure || tls.authorized);
        finish({ ok, status: res.statusCode, identity, bytes, remoteAddress, ...(tls ? { tls } : {}), ...(dns ? { dns } : {}), ...(!ok ? { error: res.statusCode !== 200 ? "HTTP_STATUS" : "UNEXPECTED_RESPONSE" } : {}) });
      });
    });
    timer = setTimeout(() => {
      finish({ error: "TIMEOUT" });
      response?.destroy();
      request.destroy();
    }, timeoutMs);
    request.once("error", (error) => finish({ error: error.code ?? "REQUEST_ERROR" }));
    request.end();
  });
}

async function systemDns(timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      lookup(HOST, { all: true }).then((answers) => ({ addresses: answers.map((a) => a.address) })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ error: "TIMEOUT" }), timeoutMs); }),
    ]);
  } catch (error) { return { error: error.code ?? "DNS_ERROR" }; }
  finally { clearTimeout(timer); }
}

export function classify(checks) {
  const findings = [];
  const localHealthy = checks.localPage.ok && checks.localSystem.ok;
  const publicHealthy = checks.publicPage.ok && checks.publicSystem.ok;
  if (!localHealthy) findings.push("LOCAL_HTTP_UNHEALTHY");
  if (publicHealthy) findings.push("PUBLIC_HTTPS_HEALTHY");
  if (CERT_ERRORS.has(checks.legacyPage.error)) findings.push("LEGACY_ENTRY_CERTIFICATE_INVALID");
  if (CERT_ERRORS.has(checks.publicPage.error) || CERT_ERRORS.has(checks.publicSystem.error)) findings.push("PUBLIC_CERTIFICATE_INVALID");
  const trustedAnswers = [checks.googleDns, checks.cloudflareDns].filter((v) => v.ok).flatMap((v) => v.dns.addresses);
  const localAnswers = checks.systemDns.addresses ?? [];
  if (trustedAnswers.length && localAnswers.length && !localAnswers.some((a) => trustedAnswers.includes(a))) findings.push("SYSTEM_DNS_DIFFERS_FROM_HTTPS_DNS");
  if (!publicHealthy && checks.pinnedPage.ok && checks.pinnedSystem.ok) findings.push("NODE_ROUTE_WORKS_PUBLIC_ENTRY_FAILS");
  if (localHealthy && (!checks.pinnedPage.ok || !checks.pinnedSystem.ok)) findings.push("TUNNEL_OR_NODE_ROUTE_UNHEALTHY");
  if (!publicHealthy && [checks.publicPage, checks.publicSystem, checks.pinnedPage, checks.pinnedSystem].some((v) => v.error === "ERR_SSL_WRONG_VERSION_NUMBER")) findings.push("CHECK_AUTO_HTTPS_MODE");
  return { localHealthy, publicHealthy, findings, automaticRestart: "disabled" };
}

export async function runRound({ timeoutMs = 8000 } = {}) {
  const page = "/events";
  const system = "/api/v1/system/status";
  const jobs = {
    localPage: probe(`http://127.0.0.1:3000${page}`, { timeoutMs }),
    localSystem: probe(`http://127.0.0.1:3000${system}`, { timeoutMs, kind: "system" }),
    publicPage: probe(`https://${HOST}:${PORT}${page}`, { timeoutMs }),
    publicSystem: probe(`https://${HOST}:${PORT}${system}`, { timeoutMs, kind: "system" }),
    pinnedPage: probe(`https://${HOST}:${PORT}${page}`, { timeoutMs, pin: NODE_IP }),
    pinnedSystem: probe(`https://${HOST}:${PORT}${system}`, { timeoutMs, pin: NODE_IP, kind: "system" }),
    legacyPage: probe(`https://frp-off.com:${PORT}${page}`, { timeoutMs }),
    systemDns: systemDns(timeoutMs),
    googleDns: probe(`https://dns.google/resolve?name=${HOST}&type=A`, { timeoutMs, kind: "dns" }),
    cloudflareDns: probe(`https://cloudflare-dns.com/dns-query?name=${HOST}&type=A`, { timeoutMs, kind: "dns" }),
  };
  const entries = await Promise.all(Object.entries(jobs).map(async ([name, result]) => [name, await result]));
  const checks = Object.fromEntries(entries);
  return { checkedAt: new Date().toISOString(), publicOrigin: `https://${HOST}:${PORT}`, diagnosticNodeIp: NODE_IP, ...classify(checks), checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseOptions(process.argv.slice(2));
    let hadFailure = false;
    for (let round = 1; round <= options.count; round++) {
      const report = await runRound(options);
      console.log(JSON.stringify({ round, totalRounds: options.count, ...report }));
      hadFailure ||= !report.localHealthy || !report.publicHealthy;
      if (round < options.count) await new Promise((resolve) => setTimeout(resolve, options.intervalSeconds * 1000));
    }
    process.exitCode = hadFailure ? 1 : 0;
  } catch {
    console.error("INVALID_OPTIONS_OR_PROBE_FAILURE: --count 1..60 --interval-seconds 10..60 --timeout-ms 1000..15000");
    process.exitCode = 2;
  }
}
