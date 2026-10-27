import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { defaultNativeEventQueries, defaultNativeEventQueryBatch } from "./config.ts";

async function check(overrides: Record<string, string>, discoveryDetails = false) {
  const script = `import {loadConfig} from ${JSON.stringify(pathToFileURL(resolve("src/server/config.ts")).href)}; try { const c=await loadConfig(); console.log(JSON.stringify({provider:c.discovery?.provider??null,queries:c.discovery?.worker.queries??[],rate:c.discovery?.worker.searchCostMicrosPerCall??null,hasSearchKey:Boolean(c.discovery?.searchKey),...(c.sourceProxyUrl?{sourceProxyUrl:c.sourceProxyUrl}:{}),...(${discoveryDetails}?{batchSize:c.discovery?.nativeQueriesPerCycle,targetHours:c.discovery?.coverageTargetHours,minimumIntervalMs:c.discovery?.worker.minimumIntervalMs,maxPagesPerCycle:c.discovery?.worker.maxPagesPerCycle,limits:c.discovery?.worker.limits}:{})})); } catch {console.log('CONFIG_REJECTED');}`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { windowsHide: true, shell: false,
    env: { NODE_ENV: "production", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), APP_MODE: "local", AUTH_ORIGIN: "http://localhost:3000", AUTH_CODE_PEPPER: "fixture-only-config-pepper-32bytes", DSH_API_KEY: "fixture-only-not-a-real-key", DSH_MODEL: "fixture-model", DSH_INPUT_MICRO_USD_PER_MILLION: "1", DSH_OUTPUT_MICRO_USD_PER_MILLION: "1", ...overrides } });
  return stdout.trim();
}
test("official source configuration needs no search key, selects only known sources and has zero paid search cost", async () => {
  assert.deepEqual(JSON.parse(await check({ DISCOVERY_PROVIDER: "official_sources" })), { provider: "official_sources", queries: ["ethglobal", "lablab"], rate: 0, hasSearchKey: false });
  assert.deepEqual(JSON.parse(await check({ DISCOVERY_PROVIDER: "official_sources", DISCOVERY_SOURCE_IDS_JSON: '["lablab"]' })), { provider: "official_sources", queries: ["lablab"], rate: 0, hasSearchKey: false });
});
test("invalid source IDs, duplicates and an unknown provider fail closed", async () => {
  for (const sources of ['["https://127.0.0.1/private"]', '["ethglobal","ethglobal"]', '[]', '{}']) assert.equal(await check({ DISCOVERY_PROVIDER: "official_sources", DISCOVERY_SOURCE_IDS_JSON: sources }), "CONFIG_REJECTED");
  assert.equal(await check({ DISCOVERY_PROVIDER: "arbitrary" }), "CONFIG_REJECTED");
});
test("Brave still requires its search key and configured price; official mode does not inherit a Brave key", async () => {
  assert.equal(await check({ DISCOVERY_PROVIDER: "brave" }), "CONFIG_REJECTED");
  assert.equal(await check({ BRAVE_SEARCH_API_KEY: "fixture-search-key" }), "CONFIG_REJECTED");
  assert.deepEqual(JSON.parse(await check({ BRAVE_SEARCH_API_KEY: "fixture-search-key", BRAVE_SEARCH_COST_MICRO_USD_PER_CALL: "12" })).provider, "brave");
  assert.equal(JSON.parse(await check({ DISCOVERY_PROVIDER: "official_sources", BRAVE_SEARCH_API_KEY: "fixture-search-key" })).hasSearchKey, false);
});
test("the source proxy must be explicitly configured as a credential-free loopback endpoint", async () => {
  for (const sourceProxy of ["http://127.0.0.1:22321", "http://[::1]:22321/"]) {
    assert.equal(JSON.parse(await check({ SOURCE_HTTP_PROXY: sourceProxy })).sourceProxyUrl, sourceProxy);
  }
  for (const sourceProxy of ["http://127.0.0.1:0", "http://127.0.0.1:65536", "http://localhost:22321", "http://192.168.1.1:22321", "http://8.8.8.8:22321", "https://127.0.0.1:22321", "http://user:password@127.0.0.1:22321", "http://127.0.0.1:22321/private", "http://127.0.0.1:22321/?token=private"]) {
    assert.equal(await check({ SOURCE_HTTP_PROXY: sourceProxy }), "CONFIG_REJECTED");
  }
});
test("native search uses the installed account runtime without Brave and reserves paid model search", async () => {
  const desktop = { DSH_API_KEY: "", DSH_DESKTOP_DIRECTORY: "D:\\fixture-only-desktop", DISCOVERY_PROVIDER: "dsh_native", DSH_SEARCH_INPUT_MICRO_USD_PER_MILLION: "300000", DSH_SEARCH_OUTPUT_MICRO_USD_PER_MILLION: "1200000" };
  const result = JSON.parse(await check(desktop));
  assert.equal(result.provider, "dsh_native"); assert.equal(result.hasSearchKey, false);
  assert.equal(result.queries.length, 2); assert.match(result.queries.join(" "), /黑客松.*hackathon/);
  assert.equal(result.rate, Math.ceil((1_048_576 * 300000 + 2048 * 1200000) / 1_000_000));
  assert.equal(await check({ DISCOVERY_PROVIDER: "dsh_native" }), "CONFIG_REJECTED");
  for (const override of [{ DSH_SEARCH_MAX_USES: "3" }, { DSH_SEARCH_MAX_OUTPUT_TOKENS: "4096" }, { DSH_SEARCH_INPUT_MICRO_USD_PER_MILLION: "0" }, { DISCOVERY_QUERIES_JSON: '["重复","重复"]' }, { DISCOVERY_QUERIES_JSON: '[]' }] as Record<string, string>[]) {
    assert.equal(await check({ ...desktop, ...override }), "CONFIG_REJECTED");
  }
});

test("one-query rounds retain all sixteen source queries and roll dates across the calendar year", () => {
  const december = new Date("2026-12-31T23:59:59.000Z"), january = new Date("2027-01-01T00:00:00.000Z");
  const batches = Array.from({ length: 16 }, (_, round) => defaultNativeEventQueryBatch(december, round, 1));
  assert.equal(batches.every(batch => batch.length === 1), true);
  assert.equal(new Set(batches.flat()).size, 16);
  assert.deepEqual(batches.flat(), Array.from({ length: 8 }, (_, group) => defaultNativeEventQueries(december, group)).flat());
  assert.deepEqual(defaultNativeEventQueryBatch(december, 16, 1), batches[0]);
  assert.deepEqual(defaultNativeEventQueryBatch(december, 17, 1), batches[1]);
  assert.deepEqual(defaultNativeEventQueryBatch(december, 3, 2), defaultNativeEventQueries(december, 3));
  assert.match(batches[2][0], /2026年12月.*2027年1月.*2027年2月/u);
  assert.match(batches[2][0], /2026-12-31/);
  const nextYear = Array.from({ length: 16 }, (_, round) => defaultNativeEventQueryBatch(january, round, 1)).flat();
  assert.equal(nextYear.every(query => query.includes("2027-01-01")), true);
  assert.match(nextYear[2], /2027年1月.*2027年2月.*2027年3月/u);
  assert.doesNotMatch(nextYear.join(" "), /2026/);
  for (const batchSize of [0, 3, 1.5, NaN]) assert.throws(() => defaultNativeEventQueryBatch(december, 0, batchSize));
});

test("a one-query five-hour target changes count allowance without increasing the one-dollar budget", async () => {
  const overrides = { DSH_API_KEY: "", DSH_DESKTOP_DIRECTORY: "D:\\fixture-only-desktop", DISCOVERY_PROVIDER: "dsh_native",
    DSH_SEARCH_INPUT_MICRO_USD_PER_MILLION: "300000", DSH_SEARCH_OUTPUT_MICRO_USD_PER_MILLION: "1200000",
    DISCOVERY_NATIVE_QUERIES_PER_CYCLE: "1", DISCOVERY_COVERAGE_TARGET_HOURS: "5", DISCOVERY_MINIMUM_INTERVAL_MS: "300000",
    DISCOVERY_MAX_PAGES_PER_CYCLE: "1", DISCOVERY_DAILY_SEARCH_CALL_LIMIT: "144", DISCOVERY_DAILY_MODEL_CALL_LIMIT: "360", DISCOVERY_DAILY_BUDGET_MICRO_USD: "1000000" };
  const config = JSON.parse(await check(overrides, true));
  assert.equal(config.queries.length, 1); assert.equal(config.batchSize, 1); assert.equal(config.targetHours, 5);
  assert.equal(config.minimumIntervalMs, 300_000); assert.equal(config.maxPagesPerCycle, 1);
  assert.deepEqual(config.limits, { maxSearchCallsPerDay: 144, maxModelCallsPerDay: 360, maxEstimatedCostMicrosPerDay: 1_000_000, currency: "USD" });
  assert.equal(config.rate, 317_031, "splitting queries cannot lower the native search's conservative context reservation");
  const defaults = JSON.parse(await check({ ...overrides, DISCOVERY_NATIVE_QUERIES_PER_CYCLE: "2" }, true));
  assert.equal(defaults.queries.length, 2); assert.equal(defaults.rate, config.rate); assert.deepEqual(defaults.limits, config.limits);
});

test("invalid batch sizes and daily coverage target hours fail configuration before scheduling", async () => {
  const desktop = { DSH_API_KEY: "", DSH_DESKTOP_DIRECTORY: "D:\\fixture-only-desktop", DISCOVERY_PROVIDER: "dsh_native" };
  for (const batchSize of ["0", "3", "1.5", "invalid"]) {
    assert.equal(await check({ ...desktop, DISCOVERY_NATIVE_QUERIES_PER_CYCLE: batchSize }), "CONFIG_REJECTED");
  }
  for (const targetHours of ["0", "25", "5.5", "invalid"]) {
    assert.equal(await check({ ...desktop, DISCOVERY_COVERAGE_TARGET_HOURS: targetHours }), "CONFIG_REJECTED");
  }
  assert.equal(JSON.parse(await check(desktop, true)).targetHours, 5);
  assert.equal(JSON.parse(await check({ ...desktop, DISCOVERY_COVERAGE_TARGET_HOURS: "24" }, true)).targetHours, 24);
});
