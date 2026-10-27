import test from "node:test";
import assert from "node:assert/strict";
import { createNativeDiscoverySearch } from "./native-discovery.ts";
import type { ApplicationConfig } from "./config.ts";
import { defaultNativeEventQueries } from "./config.ts";
import type { DshNativeSearchResult } from "./dsh-search-runtime.ts";

const config = {} as NonNullable<ApplicationConfig["dsh"]>;
const options = { modelVersion: "deepseek-v4-flash", maxTokens: 2048, maxUses: 1, timeoutMs: 90_000, inputRate: 300000, outputRate: 1200000 };
test("long-running native discovery advances its registration window across a year boundary", () => {
  const december = defaultNativeEventQueries(new Date("2026-12-31T23:59:59Z"),1);
  const january = defaultNativeEventQueries(new Date("2027-01-01T00:00:00Z"),1);
  assert.equal(december.length, 2); assert.equal(january.length, 2);
  assert.match(december[0]!, /2026年12月.*2027年1月.*2027年2月/);
  assert.match(january[0]!, /2027年1月.*2027年2月.*2027年3月/);
  assert.notDeepEqual(january, december);
});
test("native discovery rotates two bounded requests across the public web and social sources",()=>{
  const now=new Date("2026-10-09T00:00:00Z");
  const rounds=Array.from({length:8},(_,round)=>defaultNativeEventQueries(now,round));
  assert.ok(rounds.every(queries=>queries.length===2 && queries.every(query=>query.length<=600)));
  assert.equal(new Set(rounds.map(queries=>JSON.stringify(queries))).size,8);
  assert.ok(rounds.flat().every(query => /报名截止晚于 2026-10-09|application deadline after 2026-10-09/u.test(query)));
  const queries=rounds.flat().join("\n");
  for(const host of ["mp.weixin.qq.com","xiaohongshu.com","weibo.com","bilibili.com","okjike.com","zhihu.com","douyin.com","ethglobal.com","lablab.ai","devpost.com","x.com","linkedin.com","reddit.com"]) assert.ok(queries.includes(host));
  assert.deepEqual(defaultNativeEventQueries(now,8),rounds[0]);
});
function runtime(value: DshNativeSearchResult) { return { identity: { modelVersion: options.modelVersion, promptVersion: "field-dsh-native-search-v1" as const, maxTokens: 2048, maxUses: 1 }, async search() { return value; } }; }
test("native search preserves only real structured public results and cited snippets", async () => {
  const provider = createNativeDiscoverySearch(config, options, runtime({ sources: [
    { url: "https://weibo.com/2/detail/5351443240584148", title: "来源夹具", snippet: "仅为测试公开引用，不属于生产赛事。" },
    { url: "https://127.0.0.1/private", title: "不得采用" },
    { url: "https://weibo.com/2/detail/5351443240584148", title: "重复不得采用" },
  ], usage: { inputTokens: 5275, outputTokens: 688 }, truncated: false }));
  const result = await provider.search({ query: "fixture", count: 5, signal: new AbortController().signal });
  assert.ok(!Array.isArray(result) && "results" in result);
  assert.equal(result.results.length, 1); assert.equal(result.results[0]?.indexedExcerpt, "仅为测试公开引用，不属于生产赛事。");
  assert.equal(result.usage?.estimatedCostMicros, 2409); assert.equal(provider.modelCallsPerSearch, 1);
});
test("missing citation text and missing token usage are not synthesized", async () => {
  const provider = createNativeDiscoverySearch(config, options, runtime({ sources: [{ url: "https://example.com/event", title: "来源夹具" }], usage: null, truncated: false }));
  const result = await provider.search({ query: "fixture", count: 5, signal: new AbortController().signal });
  assert.ok(!Array.isArray(result) && "results" in result);
  assert.equal(result.usage, null); assert.equal(result.results[0]?.indexedExcerpt, undefined); assert.equal(result.results[0]?.description, "");
});
