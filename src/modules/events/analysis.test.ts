import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import { ANALYSIS_LIMITS, validateAnalysisContent, validateAnalysisInput } from "./analysis.ts";
import type { EventRuleVersion } from "./domain.ts";
import type { AnalysisContent, AnalysisInput } from "./model.ts";

const keyFacts = ["eligibility", "fees", "team_size", "ai_policy"];
function rules(): EventRuleVersion {
  const fields = [...keyFacts, "repository", "video"];
  return {
    eventId: "event-one", version: 2, createdAt: "2026-10-08T01:00:00Z",
    metadata: { name: "模拟赛事", organizer: "测试主办方", format: "online", region: "不限地域", officialUrl: "https://example.test/rules" },
    sources: [{
      id: "source-official", eventId: "event-one", version: 2, sourceConfigId: "config-one",
      url: "https://example.test/rules", kind: "official", contentHash: "a".repeat(64),
      fetchedAt: "2026-10-08T00:00:00Z", trustScope: "official_rules", status: "available",
    }],
    evidence: fields.map(field => ({
      id: `evidence-${field}`, eventId: "event-one", version: 2, sourceId: "source-official",
      fieldKey: field, excerpt: `已核验的 ${field} 原文`, locator: `规则第 ${field} 段`, rawDateText: null,
      verifiedBy: "reviewer-one", verifiedAt: "2026-10-08T00:30:00Z", conflictsWith: [],
    })),
    facts: keyFacts.map(key => ({ key, statement: `已核验的 ${key} 规则`, status: "verified", evidenceIds: [`evidence-${key}`] })),
    stages: [],
    requirements: [
      { id: "requirement-repository", label: "仓库链接", necessity: "required", stageId: null, evidenceIds: ["evidence-repository"] },
      { id: "requirement-video", label: "演示视频", necessity: "required", stageId: null, evidenceIds: ["evidence-video"] },
      { id: "requirement-pitch", label: "路演讲稿", necessity: "optional", stageId: null, evidenceIds: [] },
    ],
    qualityFlags: [],
  };
}
function input(): AnalysisInput {
  return { projectId: "project-one", eventId: "event-one", rulesVersion: 2, backgroundVersion: 1, background: { goal: "完成一个可演示的项目", budget: "0 元" } };
}
function content(): AnalysisContent {
  return {
    facts: [{ statement: "新人可以参赛", evidenceIds: ["evidence-eligibility"] }],
    suggestions: [
      { text: "优先实现可演示的最小范围", evidenceIds: [], backgroundKeys: ["goal"] },
      { text: "提前准备演示视频", evidenceIds: ["evidence-video"], backgroundKeys: [] },
    ],
    unknowns: [],
    checklist: [
      { requirementId: "requirement-repository", action: "检查仓库可访问" },
      { requirementId: "requirement-video", action: "录制演示视频" },
    ],
  };
}
function rejectsAnalysis(run: () => unknown): void {
  assert.throws(run, error => error instanceof DomainError && error.code === "INVALID_ANALYSIS" && error.status === 422);
}
function rejectsInput(run: () => unknown): void {
  assert.throws(run, error => error instanceof DomainError && error.code === "INVALID_ANALYSIS_INPUT" && error.status === 422);
}

test("valid input is normalized and detached from caller objects", () => {
  const original = input();
  original.projectId = " project-one ";
  original.background.goal = " 完成演示 ";
  const result = validateAnalysisInput(original);
  assert.equal(result.projectId, "project-one");
  assert.equal(result.background.goal, "完成演示");
  assert.notEqual(result, original);
  assert.notEqual(result.background, original.background);
  assert.equal(original.background.goal, " 完成演示 ");
});

test("valid analysis has verified facts, grounded suggestions and every required item", () => {
  const original = content();
  const result = validateAnalysisContent(original, rules(), input().background);
  assert.deepEqual(result, original);
  assert.notEqual(result.facts, original.facts);
  assert.notEqual(result.facts[0]!.evidenceIds, original.facts[0]!.evidenceIds);
});

test("input whitelists fields and requires nonempty IDs and positive safe versions", () => {
  for (const invalid of [
    null, [], {}, { ...input(), role: "manager" }, { ...input(), projectId: " " }, { ...input(), eventId: "" },
    { ...input(), rulesVersion: 0 }, { ...input(), backgroundVersion: -1 }, { ...input(), rulesVersion: 1.5 },
    { ...input(), rulesVersion: Number.MAX_SAFE_INTEGER + 1 }, { ...input(), backgroundVersion: "1" },
  ]) rejectsInput(() => validateAnalysisInput(invalid));
});

test("input rejects nonstring backgrounds, more than 20 keys and total text over 15000", () => {
  for (const background of [
    null, [], { goal: 1 }, { goal: { text: "nested" } }, { goal: "x".repeat(2001) },
    Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`field-${i}`, "x"])),
    Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`field-${i}`, "x".repeat(i === 7 ? 1001 : 2000)])),
    { " goal ": "目标" }, { "": "目标" },
  ]) rejectsInput(() => validateAnalysisInput({ ...input(), background }));
});

test("input accepts exactly 20 background keys and the text size boundary", () => {
  const background = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field-${i}`, ""]));
  for (let i = 0; i < 8; i += 1) background[`field-${i}`] = "x".repeat(i === 7 ? 1000 : 2000);
  assert.equal(Object.keys(validateAnalysisInput({ ...input(), background }).background).length, 20);
});

test("input rejects prototype pollution and inherited properties without modifying prototypes", () => {
  for (const background of [
    JSON.parse('{"__proto__":{"polluted":true}}'),
    JSON.parse('{"constructor":"payload"}'), JSON.parse('{"prototype":"payload"}'),
    Object.create({ privateTeam: "secret" }),
  ]) rejectsInput(() => validateAnalysisInput({ ...input(), background }));
  rejectsInput(() => validateAnalysisInput(JSON.parse('{"__proto__":{},"projectId":"p","eventId":"e","rulesVersion":1,"backgroundVersion":1,"background":{}}')));
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
  const clean = Object.create(null) as Record<string, string>;
  clean.goal = "演示";
  assert.equal(validateAnalysisInput({ ...input(), background: clean }).background.goal, "演示");
});

test("input rejects accessor and symbol properties without invoking adapter code", () => {
  let called = false;
  const accessor = input();
  Object.defineProperty(accessor, "projectId", { enumerable: true, get() { called = true; return "secret-project"; } });
  rejectsInput(() => validateAnalysisInput(accessor));
  assert.equal(called, false);
  rejectsInput(() => validateAnalysisInput({ ...input(), [Symbol("hidden")]: "payload" }));
});

test("fact evidence must exist and cannot be borrowed from another team or event", () => {
  const value = content();
  value.facts[0]!.evidenceIds = ["other-team-private-evidence"];
  rejectsAnalysis(() => validateAnalysisContent(value, rules(), input().background));
  const version = rules();
  version.evidence[0]!.eventId = "other-team-event";
  value.facts[0]!.evidenceIds = ["evidence-eligibility"];
  rejectsAnalysis(() => validateAnalysisContent(value, version, input().background));
});

test("fact evidence and its source must belong to the requested rules version", () => {
  const wrongEvidence = rules();
  wrongEvidence.evidence[0]!.version = 1;
  rejectsAnalysis(() => validateAnalysisContent(content(), wrongEvidence, input().background));
  const wrongSource = rules();
  wrongSource.sources[0]!.version = 1;
  rejectsAnalysis(() => validateAnalysisContent(content(), wrongSource, input().background));
});

test("fact evidence needs both reviewer identity and verification time", () => {
  for (const field of ["verifiedBy", "verifiedAt"] as const) {
    const version = rules();
    version.evidence[0]![field] = null;
    rejectsAnalysis(() => validateAnalysisContent(content(), version, input().background));
  }
});

test("facts never upgrade user supplied or secondary sources to verified rules", () => {
  const userVersion = rules();
  userVersion.sources[0]!.kind = "user_provided";
  userVersion.sources[0]!.trustScope = "user_claim";
  rejectsAnalysis(() => validateAnalysisContent(content(), userVersion, input().background));
  const secondaryVersion = rules();
  secondaryVersion.sources[0]!.kind = "secondary";
  secondaryVersion.sources[0]!.trustScope = "secondary_report";
  rejectsAnalysis(() => validateAnalysisContent(content(), secondaryVersion, input().background));
});

test("removed or failed sources cannot ground analysis facts", () => {
  for (const status of ["failed", "removed"] as const) {
    const version = rules();
    version.sources[0]!.status = status;
    rejectsAnalysis(() => validateAnalysisContent(content(), version, input().background));
  }
});

test("historical official stale snapshots retain their verified facts", () => {
  const version = rules();
  version.sources[0]!.status = "stale";
  version.qualityFlags = ["source_stale"];
  assert.deepEqual(validateAnalysisContent(content(), version, input().background), content());
});

test("fact evidence cannot have direct or incoming conflicts", () => {
  const direct = rules();
  direct.evidence[0]!.conflictsWith = ["evidence-fees"];
  rejectsAnalysis(() => validateAnalysisContent(content(), direct, input().background));
  const incoming = rules();
  incoming.evidence[1]!.conflictsWith = ["evidence-eligibility"];
  rejectsAnalysis(() => validateAnalysisContent(content(), incoming, input().background));
});

test("every fact needs at least one distinct evidence ID", () => {
  const value = content();
  value.facts[0]!.evidenceIds = [];
  rejectsAnalysis(() => validateAnalysisContent(value, rules(), input().background));
  value.facts[0]!.evidenceIds = ["evidence-eligibility", "evidence-eligibility"];
  rejectsAnalysis(() => validateAnalysisContent(value, rules(), input().background));
});

test("suggestions need verified evidence or a known project background key", () => {
  for (const suggestion of [
    { text: "建议", evidenceIds: [], backgroundKeys: [] },
    { text: "建议", evidenceIds: [], backgroundKeys: ["other-team-background"] },
    { text: "建议", evidenceIds: ["fabricated-evidence"], backgroundKeys: ["goal"] },
    { text: "建议", evidenceIds: [], backgroundKeys: ["goal", "goal"] },
  ]) {
    const value = content();
    value.suggestions = [suggestion];
    rejectsAnalysis(() => validateAnalysisContent(value, rules(), input().background));
  }
  const unverified = rules();
  unverified.evidence.at(-1)!.verifiedAt = null;
  rejectsAnalysis(() => validateAnalysisContent(content(), unverified, input().background));
});

test("missing AI policy must remain an unknown and cannot imply permission", () => {
  const version = rules();
  version.facts = version.facts.filter(fact => fact.key !== "ai_policy");
  const value = content();
  rejectsAnalysis(() => validateAnalysisContent(value, version, input().background));
  value.unknowns = [{ field: "ai_policy", question: "赛事未说明 AI 使用规则，请核对是否允许。" }];
  assert.deepEqual(validateAnalysisContent(value, version, input().background), value);
  value.facts[0]!.statement = "本赛事允许使用 AI";
  rejectsAnalysis(() => validateAnalysisContent(value, version, input().background));
  value.facts = [];
  value.suggestions = [{ text: "AI is allowed", evidenceIds: [], backgroundKeys: ["goal"] }];
  rejectsAnalysis(() => validateAnalysisContent(value, version, input().background));
});

test("an AI policy question is permitted while its answer is unknown", () => {
  const version = rules();
  version.facts.find(fact => fact.key === "ai_policy")!.status = "unknown";
  const value = content();
  value.unknowns = [{ field: "ai_policy", question: "AI 使用规则未说明，需要确认。" }];
  value.suggestions = [
    { text: "请先确认是否允许使用 AI", evidenceIds: [], backgroundKeys: ["goal"] },
    { text: "Check whether AI is allowed", evidenceIds: [], backgroundKeys: ["goal"] },
  ];
  assert.deepEqual(validateAnalysisContent(value, version, input().background), value);
});

test("unknown, conflicted and unverified critical clauses all require questions", () => {
  for (const status of ["unknown", "conflicted", "unverified"] as const) {
    const version = rules();
    const fact = version.facts.find(item => item.key === "fees")!;
    fact.status = status;
    const value = content();
    rejectsAnalysis(() => validateAnalysisContent(value, version, input().background));
    value.unknowns = [{ field: "fees", question: "请确认费用条款。" }];
    assert.deepEqual(validateAnalysisContent(value, version, input().background), value);
  }
});

test("a verified label alone cannot hide a critical clause without usable evidence", () => {
  const version = rules();
  version.facts.find(fact => fact.key === "team_size")!.evidenceIds = [];
  rejectsAnalysis(() => validateAnalysisContent(content(), version, input().background));
});

test("a manual draft may have no facts when all critical clauses are unresolved", () => {
  const version = rules();
  version.facts = [];
  const value = content();
  value.facts = [];
  value.suggestions = [];
  value.unknowns = keyFacts.map(field => ({ field, question: "尚未核验，请确认。" }));
  assert.deepEqual(validateAnalysisContent(value, version, input().background), value);
});

test("checklist cannot omit any required material", () => {
  const value = content();
  value.checklist.pop();
  rejectsAnalysis(() => validateAnalysisContent(value, rules(), input().background));
});

test("checklist cannot reference fabricated or other event requirement IDs", () => {
  const value = content();
  value.checklist.push({ requirementId: "other-team-secret-material", action: "准备" });
  rejectsAnalysis(() => validateAnalysisContent(value, rules(), input().background));
});

test("checklist cannot duplicate stable requirement IDs and may include existing optional material", () => {
  const value = content();
  value.checklist.push({ ...value.checklist[0]! });
  rejectsAnalysis(() => validateAnalysisContent(value, rules(), input().background));
  value.checklist.pop();
  value.checklist.push({ requirementId: "requirement-pitch", action: "准备可选讲稿" });
  assert.equal(validateAnalysisContent(value, rules(), input().background).checklist.length, 3);
});

test("output rejects model URLs, ownership fields and unknown per-section properties", () => {
  const value = content();
  for (const output of [
    { ...value, url: "https://invented.test" },
    { ...value, projectId: "other-team" },
    { ...value, facts: [{ ...value.facts[0]!, sourceUrl: "https://invented.test" }] },
    { ...value, suggestions: [{ ...value.suggestions[0]!, evidenceUrl: "https://invented.test" }] },
    { ...value, unknowns: [{ field: "ai_policy", question: "确认", url: "https://invented.test" }] },
    { ...value, checklist: [{ ...value.checklist[0]!, eventId: "other-event" }] },
  ]) rejectsAnalysis(() => validateAnalysisContent(output, rules(), input().background));
});

test("sections require ordinary object arrays and reject holes, metadata or symbols", () => {
  const sparse = new Array(1);
  const decorated = [...content().facts];
  Object.defineProperty(decorated, "url", { enumerable: true, value: "https://invented.test" });
  const symbolic = [...content().facts];
  Object.defineProperty(symbolic, Symbol("hidden"), { value: "payload" });
  for (const facts of [null, "facts", {}, ["statement"], sparse, decorated, symbolic]) {
    rejectsAnalysis(() => validateAnalysisContent({ ...content(), facts }, rules(), input().background));
  }
  for (const section of ["facts", "suggestions", "unknowns", "checklist"]) {
    rejectsAnalysis(() => validateAnalysisContent({ ...content(), [section]: null }, rules(), input().background));
  }
});

test("each section applies count limits and text limits", () => {
  const value = content();
  for (const [field, max, entry] of [
    ["facts", ANALYSIS_LIMITS.facts, value.facts[0]!],
    ["suggestions", ANALYSIS_LIMITS.suggestions, value.suggestions[0]!],
    ["unknowns", ANALYSIS_LIMITS.unknowns, { field: "other", question: "确认" }],
    ["checklist", ANALYSIS_LIMITS.checklist, value.checklist[0]!],
  ] as const) {
    rejectsAnalysis(() => validateAnalysisContent({ ...value, [field]: Array.from({ length: max + 1 }, () => entry) }, rules(), input().background));
  }
  for (const output of [
    { ...value, facts: [{ ...value.facts[0]!, statement: "x".repeat(ANALYSIS_LIMITS.statement + 1) }] },
    { ...value, suggestions: [{ ...value.suggestions[0]!, text: "x".repeat(ANALYSIS_LIMITS.suggestion + 1) }] },
    { ...value, unknowns: [{ field: "other", question: "x".repeat(ANALYSIS_LIMITS.question + 1) }] },
    { ...value, checklist: [{ ...value.checklist[0]!, action: "x".repeat(ANALYSIS_LIMITS.action + 1) }] },
    { ...value, facts: [{ ...value.facts[0]!, statement: " " }] },
    { ...value, unknowns: [{ field: "", question: "确认" }] },
  ]) rejectsAnalysis(() => validateAnalysisContent(output, rules(), input().background));
});

test("output never invokes a getter or accepts polluted objects", () => {
  let called = false;
  const fact = Object.defineProperty({ evidenceIds: ["evidence-eligibility"] }, "statement", {
    enumerable: true, get() { called = true; return "payload"; },
  });
  rejectsAnalysis(() => validateAnalysisContent({ ...content(), facts: [fact] }, rules(), input().background));
  assert.equal(called, false);
  const polluted = JSON.parse('{"statement":"事实","evidenceIds":["evidence-eligibility"],"__proto__":{}}');
  rejectsAnalysis(() => validateAnalysisContent({ ...content(), facts: [polluted] }, rules(), input().background));
});
