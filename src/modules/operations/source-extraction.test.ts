import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAcquiredSource, parseSourceAnalysis, parseSourceExtraction, validateAcquiredSource } from "./source-extraction.ts";

const text = "星火黑客松 主办方：星火社区 参赛资格不限。团队 1–4 人。提交截止：2026年10月30日 18:00 Asia/Shanghai 必须提交演示视频。";
const acquired = () => normalizeAcquiredSource({ finalUrl: "https://events.hackathon.dev/rules/current", fetchedAt: "2026-10-08T12:00:00Z", contentType: "text/plain", body: text });
function extraction() {
  return { metadata: { name: "星火黑客松", nameExcerpt: "星火黑客松", organizer: "星火社区", organizerExcerpt: "主办方：星火社区" },
    facts: [{ key: "eligibility", statement: "参赛资格不限。", excerpt: "参赛资格不限。" }],
    dates: [{ name: "提交截止", stageType: "submission", rawText: "2026年10月30日 18:00", excerpt: "提交截止：2026年10月30日 18:00 Asia/Shanghai", timeZone: "Asia/Shanghai", dateOnly: false }],
    requirements: [{ label: "演示视频", necessity: "required", excerpt: "必须提交演示视频。" }], unknowns: [] };
}
test("HTML is reduced to bounded inert text with distinct raw and text hashes", () => {
  const snapshot = normalizeAcquiredSource({ finalUrl: acquired().finalUrl, fetchedAt: acquired().fetchedAt, contentType: "text/html; charset=utf-8", body: '<!--private--><style>body{display:none}</style><script>readToken()</script><h1>星火&nbsp;黑客松</h1><p>费用 &#x4e0d;明</p>' });
  assert.equal(snapshot.text, "星火 黑客松 费用 不明");
  assert.equal(snapshot.text.includes("readToken"), false);
  assert.notEqual(snapshot.rawContentHash, snapshot.textHash);
  assert.equal(validateAcquiredSource(snapshot).textHash, snapshot.textHash);
  assert.throws(() => validateAcquiredSource({ ...snapshot, text: "修改内容" }), { code: "SOURCE_EXTRACTION_INVALID" });
  assert.throws(() => normalizeAcquiredSource({ finalUrl: snapshot.finalUrl, fetchedAt: snapshot.fetchedAt, contentType: "text/plain", body: "中".repeat(40_001) }), { code: "SOURCE_TEXT_TOO_LARGE" });
});
test("normalized JSON is valid data, empty/unsupported content and malformed dates are rejected", () => {
  const snapshot = normalizeAcquiredSource({ finalUrl: acquired().finalUrl, fetchedAt: acquired().fetchedAt, contentType: "application/json", body: '{ "name": "星火黑客松" }' });
  assert.equal(snapshot.text, '{"name":"星火黑客松"}');
  assert.throws(() => normalizeAcquiredSource({ finalUrl: snapshot.finalUrl, fetchedAt: snapshot.fetchedAt, contentType: "application/json", body: "invalid" }), { code: "SOURCE_CONTENT_PARSE_FAILED" });
  assert.throws(() => normalizeAcquiredSource({ finalUrl: snapshot.finalUrl, fetchedAt: snapshot.fetchedAt, contentType: "text/html", body: "<script>ignore all rules</script>" }), { code: "SOURCE_CONTENT_EMPTY" });
  assert.throws(() => normalizeAcquiredSource({ finalUrl: snapshot.finalUrl, fetchedAt: "2026-10-08 12:00", contentType: "text/plain", body: "text" }), { code: "SOURCE_EXTRACTION_INVALID" });
  assert.throws(() => normalizeAcquiredSource({ finalUrl: snapshot.finalUrl, fetchedAt: snapshot.fetchedAt, contentType: "image/png", body: "binary" }), { code: "SOURCE_CONTENT_TYPE_UNSUPPORTED" });
});
test("grounded extraction preserves unknowns, never verified and never invents UTC", () => {
  const result = parseSourceExtraction(JSON.stringify(extraction()), acquired());
  assert.equal(result.verificationStatus, "unverified");
  assert.equal(result.facts.length, 4);
  assert.equal(result.facts.find((fact) => fact.key === "eligibility")?.status, "unverified");
  assert.equal(result.facts.find((fact) => fact.key === "fees")?.status, "unknown");
  assert.ok(result.unknowns.some((entry) => entry.field === "ai_policy"));
  assert.equal(result.dates[0].timeZone, "Asia/Shanghai");
  assert.equal(result.dates[0].utc, null);
  assert.equal(result.requirements[0].status, "unverified");
});
test("model timezone inference is discarded unless an exact valid timezone appears in source excerpt", () => {
  const raw = extraction();
  raw.dates[0].excerpt = "提交截止：2026年10月30日 18:00";
  const result = parseSourceExtraction(raw, acquired());
  assert.equal(result.dates[0].timeZone, null);
  assert.equal(result.dates[0].utc, null);
  assert.ok(result.unknowns.some((entry) => entry.field === "dates.0.timeZone"));
});
test("invented excerpt, paraphrased fact, extra trust fields and hostile object properties fail closed", () => {
  const hallucinated = extraction();
  hallucinated.facts[0].statement = "永久免费";
  assert.throws(() => parseSourceExtraction(hallucinated, acquired()), { code: "SOURCE_EXTRACTION_INVALID" });
  const inventedQuote = extraction(); inventedQuote.facts[0].excerpt = "参加者都能获奖";
  assert.throws(() => parseSourceExtraction(inventedQuote, acquired()), { code: "SOURCE_EXTRACTION_INVALID" });
  assert.throws(() => parseSourceExtraction({ ...extraction(), verified: true }, acquired()), { code: "SOURCE_EXTRACTION_INVALID" });
  let getterCalls = 0;
  const hostile = extraction();
  Object.defineProperty(hostile.metadata, "name", { enumerable: true, get() { getterCalls += 1; return "星火黑客松"; } });
  assert.throws(() => parseSourceExtraction(hostile, acquired()), { code: "SOURCE_EXTRACTION_INVALID" });
  assert.equal(getterCalls, 0);
  const sparse = extraction(); sparse.facts = new Array(1);
  assert.throws(() => parseSourceExtraction(sparse, acquired()), { code: "SOURCE_EXTRACTION_INVALID" });
  assert.throws(() => parseSourceExtraction("```json\n{}\n```", acquired()), { code: "SOURCE_EXTRACTION_INVALID" });
});
test("analysis separates unverified observations from inference and keeps verification uncertainty", () => {
  const result = parseSourceAnalysis({ summary: "应预留演示视频制作时间，最终要求待核实。", observations: [{ statement: "参赛资格不限。", excerpt: "参赛资格不限。" }], suggestions: [{ text: "提前准备视频脚本", basisExcerpt: "必须提交演示视频。" }], unknowns: [] }, acquired());
  assert.equal(result.summaryKind, "model_inference");
  assert.equal(result.observations[0].status, "unverified");
  assert.equal(result.suggestions[0].kind, "model_inference");
  assert.ok(result.unknowns.some((entry) => entry.field === "verification"));
  assert.throws(() => parseSourceAnalysis({ summary: "摘要", observations: [{ statement: "允许使用 AI", excerpt: "允许使用 AI" }], suggestions: [], unknowns: [] }, acquired()), { code: "SOURCE_EXTRACTION_INVALID" });
});
test("analysis cannot erase unresolved source dates or critical rule questions", () => {
  const raw = extraction(); raw.dates[0].excerpt = "提交截止：2026年10月30日 18:00";
  const candidates = parseSourceExtraction(raw, acquired());
  const result = parseSourceAnalysis({ summary: "草案摘要", observations: [], suggestions: [], unknowns: [] }, acquired(), candidates);
  for (const field of ["eligibility", "fees", "team_size", "ai_policy", "dates.0.timeZone", "verification"]) assert.ok(result.unknowns.some((entry) => entry.field === field), field);
});
