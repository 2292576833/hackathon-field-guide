import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../shared/errors.ts";
import {
  assertPublishable, deriveEventPhase, diffRuleVersions, formatRuleMoment,
  isVerifiedRuleEvidence, validateRuleVersion,
} from "./domain.ts";
import type { EventRuleVersion, EventStage, RuleMoment } from "./domain.ts";

function fixture(): EventRuleVersion {
  const rules: EventRuleVersion = {
    eventId: "event-1", version: 1, createdAt: "2026-10-08T00:00:00Z",
    metadata: { name: "新人黑客松", organizer: "测试主办方", format: "online", region: "全球", officialUrl: "https://example.com/rules" },
    sources: [{ id: "official", eventId: "event-1", version: 1, sourceConfigId: null,
      url: "https://example.com/rules", kind: "official", contentHash: "fixture-hash",
      fetchedAt: "2026-10-01T00:00:00Z", trustScope: "official_rules", status: "available" }],
    evidence: [], facts: [], stages: [], requirements: [], qualityFlags: [],
  };
  for (const key of ["eligibility", "fees", "team_size", "ai_policy"]) {
    addEvidence(rules, key, key, null);
    rules.facts.push({ key, statement: `${key} 的已核验说明`, status: "verified", evidenceIds: [key] });
  }
  addStage(rules, "submission", "submission", "2026-10-10 09:00", "2026-10-10T01:00:00Z", "2026-10-20 18:00", "2026-10-20T10:00:00Z");
  addEvidence(rules, "readme-proof", "requirements", null);
  rules.requirements.push({ id: "readme", label: "项目 README", necessity: "required", stageId: "submission", evidenceIds: ["readme-proof"] });
  return rules;
}
function addEvidence(rules: EventRuleVersion, id: string, fieldKey: string, rawDateText: string | null): void {
  rules.evidence.push({ id, eventId: rules.eventId, version: rules.version, sourceId: "official", fieldKey,
    excerpt: rawDateText ?? `${fieldKey} 原文`, locator: `#${id}`, rawDateText,
    verifiedBy: "reviewer-1", verifiedAt: "2026-10-02T00:00:00Z", conflictsWith: [] });
}
function addStage(rules: EventRuleVersion, id: string, stageType: EventStage["stageType"], startRaw: string, start: string, endRaw: string, end: string): void {
  addEvidence(rules, `${id}-start`, `${id}.startsAt`, startRaw);
  addEvidence(rules, `${id}-end`, `${id}.endsAt`, endRaw);
  rules.stages.push({ id, stageType, name: id,
    startsAt: { rawText: startRaw, timeZone: "Asia/Shanghai", utc: start, dateOnly: false, evidenceIds: [`${id}-start`] },
    endsAt: { rawText: endRaw, timeZone: "Asia/Shanghai", utc: end, dateOnly: false, evidenceIds: [`${id}-end`] },
    submissionUrl: "https://example.com/submit" });
}
function invalidRules(rules: unknown): void {
  assert.throws(() => validateRuleVersion(rules), error => error instanceof DomainError && error.code === "INVALID_RULE_VERSION");
}

test("valid version is copied, normalized and publishable without mutating the input", () => {
  const original = fixture();
  const parsed = validateRuleVersion({ ...original, privateBackground: "must not leak" });
  assert.equal(parsed.createdAt, "2026-10-08T00:00:00.000Z");
  assert.deepEqual(validateRuleVersion(parsed), parsed);
  assert.equal("privateBackground" in parsed, false);
  assertPublishable(parsed);
  parsed.sources[0]!.url = "https://example.com/changed";
  assert.equal(original.sources[0]!.url, "https://example.com/rules");
});

test("every key rule is explicit even when unknown; duplicate IDs are rejected", () => {
  const missing = fixture(); missing.facts.pop(); invalidRules(missing);
  const duplicate = fixture(); duplicate.stages.push(structuredClone(duplicate.stages[0]!)); invalidRules(duplicate);
  const duplicateEvidence = fixture(); duplicateEvidence.evidence.push(structuredClone(duplicateEvidence.evidence[0]!)); invalidRules(duplicateEvidence);
});

test("all source/evidence and child references must belong to the exact event version", () => {
  for (const mutation of [
    (rules: EventRuleVersion) => { rules.sources[0]!.eventId = "another-event"; },
    (rules: EventRuleVersion) => { rules.sources[0]!.version = 2; },
    (rules: EventRuleVersion) => { rules.evidence[0]!.eventId = "another-event"; },
    (rules: EventRuleVersion) => { rules.evidence[0]!.version = 2; },
    (rules: EventRuleVersion) => { rules.evidence[0]!.sourceId = "invented-source"; },
    (rules: EventRuleVersion) => { rules.facts[0]!.evidenceIds = ["invented-evidence"]; },
    (rules: EventRuleVersion) => { rules.stages[0]!.endsAt!.evidenceIds = ["invented-evidence"]; },
    (rules: EventRuleVersion) => { rules.requirements[0]!.stageId = "invented-stage"; },
  ]) { const rules = fixture(); mutation(rules); invalidRules(rules); }
});

test("unrelated official evidence cannot verify a fact and verification attribution must be paired", () => {
  const wrongField = fixture(); wrongField.facts[0]!.evidenceIds = ["fees"]; invalidRules(wrongField);
  const missingVerifier = fixture(); missingVerifier.evidence[0]!.verifiedBy = null; invalidRules(missingVerifier);
  const noProof = fixture(); noProof.facts[0]!.evidenceIds = []; invalidRules(noProof);
});

test("user and secondary sources cannot impersonate official verification", () => {
  for (const [kind, trustScope] of [["user_provided", "user_claim"], ["secondary", "secondary_report"]] as const) {
    const rules = fixture(); rules.sources[0]!.kind = kind; rules.sources[0]!.trustScope = trustScope;
    invalidRules(rules);
  }
  const fakeScope = fixture(); fakeScope.sources[0]!.kind = "user_provided"; invalidRules(fakeScope);
});

test("URLs must use HTTP(S) and never carry credentials", () => {
  for (const url of ["javascript:alert(1)", "/relative", "https://secret:password@example.com/rules"]) {
    const rules = fixture(); rules.sources[0]!.url = url; invalidRules(rules);
  }
});

test("illegal zones, missing offsets and impossible calendar dates are rejected", () => {
  for (const mutation of [
    (date: RuleMoment) => { date.timeZone = "Asia/Imaginary"; },
    (date: RuleMoment) => { date.timeZone = "+08:00"; },
    (date: RuleMoment) => { date.timeZone = null; },
    (date: RuleMoment) => { date.utc = "2026-10-20T10:00:00"; },
    (date: RuleMoment) => { date.utc = "2026-02-30T10:00:00Z"; },
    (date: RuleMoment) => { date.utc = "2026-10-20T10:00:00+24:00"; },
    (date: RuleMoment) => { date.rawText = "2026-02-30 18:00"; },
    (date: RuleMoment) => { date.rawText = "2026年2月30日 18:00"; },
  ]) { const rules = fixture(); mutation(rules.stages[0]!.endsAt!); invalidRules(rules); }
});

test("only a date or an ambiguous before-date phrase can never become a precise deadline", () => {
  for (const rawText of ["2026-10-20", "2026年10月20日", "10 月 20 日前", "2026年10月20日之前", "Oct 20", "before October 20", "Oct 20 UTC+08:00"]) {
    const rules = fixture(); rules.stages[0]!.endsAt!.rawText = rawText;
    rules.evidence.find(item => item.id === "submission-end")!.rawDateText = rawText;
    invalidRules(rules);
  }
});

test("ISO original times with T/Z and explicit offsets remain valid clock evidence", () => {
  for (const [rawText, timeZone] of [["2026-10-20T18:00:00+08:00", "Asia/Shanghai"], ["2026-10-20T10:00:00Z", "UTC"]]) {
    const rules = fixture(); rules.stages[0]!.endsAt!.rawText = rawText!; rules.stages[0]!.endsAt!.timeZone = timeZone!;
    rules.evidence.find(item => item.id === "submission-end")!.rawDateText = rawText!;
    assertPublishable(rules);
    assert.equal(formatRuleMoment(rules.stages[0]!.endsAt!, "Asia/Shanghai").precise, true);
  }
});

test("date-only and missing timezone remain imprecise and never get a local countdown time", () => {
  const date: RuleMoment = { rawText: "10 月 20 日前", timeZone: null, utc: null, dateOnly: true, evidenceIds: [] };
  const displayed = formatRuleMoment(date, "Asia/Shanghai");
  assert.equal(displayed.precise, false); assert.equal(displayed.local, null);
  assert.match(displayed.original, /10 月 20 日前/); assert.match(displayed.original, /时区未注明/);
  assert.throws(() => formatRuleMoment({ ...date, timeZone: "Asia/Shanghai", utc: "2026-10-20T15:59:59Z" }, "Asia/Shanghai"), DomainError);
});

test("exact and date-only reversed intervals are rejected without inventing end seconds", () => {
  const exact = fixture(); [exact.stages[0]!.startsAt, exact.stages[0]!.endsAt] = [exact.stages[0]!.endsAt, exact.stages[0]!.startsAt]; invalidRules(exact);
  const coarse = fixture();
  coarse.stages[0]!.startsAt = { rawText: "2026-10-21", timeZone: null, utc: null, dateOnly: true, evidenceIds: [] };
  coarse.stages[0]!.endsAt = { rawText: "2026-10-20", timeZone: null, utc: null, dateOnly: true, evidenceIds: [] };
  invalidRules(coarse);
});

test("timezone conversion preserves the original and correctly crosses midnight", () => {
  const date: RuleMoment = { rawText: "2026-10-20 00:30", timeZone: "Asia/Shanghai", utc: "2026-10-19T16:30:00Z", dateOnly: false, evidenceIds: [] };
  const displayed = formatRuleMoment(date, "America/Los_Angeles");
  assert.equal(displayed.precise, true); assert.match(displayed.original, /2026-10-20 00:30/);
  assert.match(displayed.local!, /2026\/10\/19/); assert.match(displayed.local!, /09:30:00/);
});

test("daylight-saving nonexistent clocks and wrong original offsets are rejected", () => {
  const gap: RuleMoment = { rawText: "2026-03-08 02:30", timeZone: "America/New_York", utc: "2026-03-08T07:30:00Z", dateOnly: false, evidenceIds: [] };
  assert.throws(() => formatRuleMoment(gap, "Asia/Shanghai"), DomainError);
  assert.equal(formatRuleMoment({ ...gap, rawText: "2026-03-08 03:30" }, "Asia/Shanghai").precise, true);
  const wrongOffset: RuleMoment = { rawText: "2026-10-20T18:00:00+07:00", timeZone: "Asia/Shanghai", utc: "2026-10-20T10:00:00Z", dateOnly: false, evidenceIds: [] };
  assert.throws(() => formatRuleMoment(wrongOffset, "UTC"), DomainError);
});

test("a precise draft with unchecked dates stays unknown and cannot be published", () => {
  const rules = fixture();
  for (const id of ["submission-start", "submission-end"]) {
    const evidence = rules.evidence.find(item => item.id === id)!; evidence.verifiedBy = null; evidence.verifiedAt = null;
  }
  validateRuleVersion(rules);
  assert.equal(deriveEventPhase(rules, new Date("2026-10-15T00:00:00Z")), "unknown");
  assert.throws(() => assertPublishable(rules), error => error instanceof DomainError && error.code === "RULES_NOT_PUBLISHABLE");
});

test("date publication requires the matching original date evidence", () => {
  const rules = fixture(); rules.evidence.find(item => item.id === "submission-end")!.rawDateText = "不同的日期原文";
  validateRuleVersion(rules);
  assert.throws(() => assertPublishable(rules), DomainError);
  assert.equal(deriveEventPhase(rules, new Date("2026-10-15T00:00:00Z")), "unknown");
});

test("unknown versions can be published only with explicit missing-information quality", () => {
  const rules = fixture(); rules.facts.forEach(item => { item.status = "unknown"; item.evidenceIds = []; });
  rules.stages = []; rules.requirements = []; rules.evidence = [];
  assert.throws(() => assertPublishable(rules), DomainError);
  rules.qualityFlags = ["missing_information"]; assertPublishable(rules);
  assert.equal(deriveEventPhase(rules, new Date("2026-10-15T00:00:00Z")), "unknown");
});

test("asymmetric conflicts invalidate both directions and require a recheck marker", () => {
  const rules = fixture(); addEvidence(rules, "fee-alternative", "fees", null);
  rules.evidence.find(item => item.id === "fees")!.conflictsWith = ["fee-alternative"];
  assert.equal(isVerifiedRuleEvidence(rules, "fees"), false);
  assert.equal(isVerifiedRuleEvidence(rules, "fee-alternative"), false);
  rules.facts.find(item => item.key === "fees")!.evidenceIds = ["fee-alternative"];
  invalidRules(rules);
  rules.facts.find(item => item.key === "fees")!.status = "conflicted";
  rules.facts.find(item => item.key === "fees")!.evidenceIds = ["fees", "fee-alternative"];
  validateRuleVersion(rules); assert.throws(() => assertPublishable(rules), DomainError);
  rules.qualityFlags = ["needs_recheck"]; assertPublishable(rules);
});

test("stale and failed source quality is explicit; failed snapshots cannot verify facts", () => {
  const stale = fixture(); stale.sources[0]!.status = "stale";
  assert.equal(isVerifiedRuleEvidence(stale, "fees"), true);
  assert.throws(() => assertPublishable(stale), DomainError);
  stale.qualityFlags = ["source_stale"]; assertPublishable(stale);
  const failed = fixture(); failed.sources[0]!.status = "failed";
  assert.equal(isVerifiedRuleEvidence(failed, "fees"), false); invalidRules(failed);
  failed.facts.forEach(item => { item.status = "unknown"; item.evidenceIds = []; });
  failed.stages = []; failed.requirements = []; failed.evidence = []; failed.qualityFlags = ["missing_information"];
  assert.throws(() => assertPublishable(failed), DomainError);
  failed.qualityFlags.push("source_failed"); assertPublishable(failed);
});

test("phase uses exact checked intervals and stops at their boundaries", () => {
  const rules = fixture();
  addStage(rules, "registration", "registration", "2026-10-01 09:00", "2026-10-01T01:00:00Z", "2026-10-05 18:00", "2026-10-05T10:00:00Z");
  addStage(rules, "development", "development", "2026-10-05 18:00", "2026-10-05T10:00:00Z", "2026-10-15 18:00", "2026-10-15T10:00:00Z");
  assert.equal(deriveEventPhase(rules, new Date("2026-10-01T00:59:59Z")), "unknown");
  assert.equal(deriveEventPhase(rules, new Date("2026-10-01T01:00:00Z")), "registration");
  assert.equal(deriveEventPhase(rules, new Date("2026-10-05T10:00:00Z")), "active");
  assert.equal(deriveEventPhase(rules, new Date("2026-10-15T10:00:00Z")), "awaiting_submission");
  assert.equal(deriveEventPhase(rules, new Date("2026-10-20T10:00:00Z")), "ended");
  rules.stages[0]!.endsAt = { rawText: "10 月 20 日前", timeZone: null, utc: null, dateOnly: true, evidenceIds: [] };
  assert.equal(deriveEventPhase(rules, new Date("2026-10-21T00:00:00Z")), "unknown");
  assert.throws(() => deriveEventPhase(fixture(), new Date("invalid")), DomainError);
});

test("version diff ignores reorder and bookkeeping but exposes stable-ID rule/source edits", () => {
  const before = fixture(), after = structuredClone(before);
  after.version = 2; after.createdAt = "2026-10-09T00:00:00Z";
  after.sources.forEach(item => { item.version = 2; }); after.evidence.forEach(item => { item.version = 2; });
  after.sources.reverse(); after.evidence.reverse(); after.facts.reverse(); after.requirements.reverse();
  assert.deepEqual(diffRuleVersions(before, after), []);
  after.metadata.name = "更新后的赛事名";
  after.facts.find(item => item.key === "fees")!.statement = "费用改为 100 元";
  after.sources[0]!.contentHash = "new-hash";
  after.requirements[0]!.label = "README 和演示视频";
  const changes = diffRuleVersions(before, after);
  assert.deepEqual(changes.map(item => item.path).sort(), ["/facts/fees/statement", "/metadata/name", "/requirements/readme/label", "/sources/official/contentHash"].sort());
  assert.equal(changes.find(item => item.path === "/facts/fees/statement")!.before, "fees 的已核验说明");
  assert.equal(before.facts.find(item => item.key === "fees")!.statement, "fees 的已核验说明");
});

test("version diff exposes precise dates, material additions/removals and all key facts", () => {
  const before = fixture(), after = structuredClone(before);
  for (const fact of after.facts) fact.statement += " 更新";
  after.stages[0]!.endsAt!.rawText = "2026-10-21 18:00"; after.stages[0]!.endsAt!.utc = "2026-10-21T10:00:00Z";
  after.evidence.find(item => item.id === "submission-end")!.rawDateText = "2026-10-21 18:00";
  after.requirements = [{ id: "video", label: "视频", necessity: "unknown", stageId: "submission", evidenceIds: [] }];
  const paths = diffRuleVersions(before, after).map(item => item.path);
  for (const key of ["eligibility", "fees", "team_size", "ai_policy"]) assert.ok(paths.includes(`/facts/${key}/statement`));
  assert.ok(paths.includes("/stages/submission/endsAt/utc")); assert.ok(paths.includes("/requirements/readme")); assert.ok(paths.includes("/requirements/video"));
  const otherEvent = fixture(); otherEvent.eventId = "event-2"; otherEvent.sources.forEach(item => { item.eventId = "event-2"; }); otherEvent.evidence.forEach(item => { item.eventId = "event-2"; });
  assert.throws(() => diffRuleVersions(before, otherEvent), error => error instanceof DomainError && error.code === "EVENT_MISMATCH");
});
