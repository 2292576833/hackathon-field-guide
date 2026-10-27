import test from "node:test";
import assert from "node:assert/strict";
import { diffRuleVersions } from "./domain.ts";
import type { EventRuleVersion } from "./domain.ts";
import { formatRuleChangeValue, resolveRuleDisplayTimeZone, ruleChangeRows } from "./rule-display.ts";

function rules(): EventRuleVersion { return { eventId: "event-1", version: 1, createdAt: "2026-10-10T00:00:00Z", metadata: { name: "赛事", organizer: "主办方", format: "online", region: "全球", officialUrl: "https://example.org/rules" }, sources: [], evidence: [], facts: ["eligibility", "fees", "team_size", "ai_policy"].map(key => ({ key, statement: "尚未说明", status: "unknown", evidenceIds: [] })), stages: [], requirements: [], qualityFlags: ["missing_information"] }; }

test("default and invalid display zones explicitly use Beijing; selected/account/browser zones are truthful", () => {
  assert.deepEqual(resolveRuleDisplayTimeZone(), { timeZone: "Asia/Shanghai", label: "北京时间", fallback: true });
  assert.deepEqual(resolveRuleDisplayTimeZone("Invalid/Zone", "账号时间"), { timeZone: "Asia/Shanghai", label: "北京时间", fallback: true });
  assert.equal(resolveRuleDisplayTimeZone("America/New_York").label, "所选时区 America/New_York");
  assert.equal(resolveRuleDisplayTimeZone("America/New_York", "浏览器时间").label, "浏览器时间");
  assert.equal(resolveRuleDisplayTimeZone("Asia/Shanghai", "账号时间").label, "账号时间");
  assert.notEqual(resolveRuleDisplayTimeZone("America/New_York", "北京时间").label, "北京时间");
  assert.doesNotMatch(formatRuleChangeValue("2026-10-10T01:00:00Z", "/stages/s/endsAt/utc"), /你的时间/);
  assert.match(formatRuleChangeValue("2026-10-10T01:00:00Z", "/stages/s/endsAt/utc"), /北京时间/);
  assert.equal(formatRuleChangeValue("2026-10-10", "/stages/s/endsAt/rawText"), "2026-10-10", "date-only raw values remain imprecise");
});

test("real rule diff expands added/removed stage fields and shows exact old/new values with stable pointer IDs", () => {
  const before = rules(), after = structuredClone(before); after.version = 2;
  after.metadata.name = "更新的赛事名称";
  after.facts[0]!.statement = "资格信息等待官网补充";
  after.stages.push({ id: "报名/~", stageType: "registration", name: "报名阶段", startsAt: null, endsAt: { rawText: "2026-10-12", timeZone: null, utc: null, dateOnly: true, evidenceIds: [] }, submissionUrl: null });
  const changes = diffRuleVersions(before, after), original = structuredClone(changes);
  const rows = ruleChangeRows(changes, { currentRules: before, latestRules: after });
  const name = rows.find(row => row.path === "/metadata/name")!;
  assert.equal(name.before, "赛事"); assert.equal(name.after, "更新的赛事名称"); assert.equal(name.kind, "changed");
  assert.equal(rows.find(row => row.path === "/facts/eligibility/statement")!.label, "规则事实 · 参赛资格 · 说明");
  const raw = rows.find(row => row.path === "/stages/报名~1~0/endsAt/rawText")!;
  assert.equal(raw.label, "阶段 · 报名阶段 · 截止时间 · 原文时间"); assert.equal(raw.kind, "added"); assert.equal(raw.after, "2026-10-12");
  const removed = ruleChangeRows(diffRuleVersions(after, before), { currentRules: after, latestRules: before }).find(row => row.path === raw.path)!;
  assert.equal(removed.kind, "removed"); assert.equal(removed.before, "2026-10-12"); assert.equal(removed.after, null);
  assert.deepEqual(changes, original, "display does not change the authoritative diff or snapshots");
});

test("official track arrays expand by stable ID into individual content differences", () => {
  const rows = ruleChangeRows([{ path: "/officialTracks/tracks", before: [{ id: "track-a", name: "旧名称", eligibility: { text: "旧资格", evidenceIds: ["proof"] } }], after: [{ id: "track-a", name: "新名称", eligibility: { text: "新资格", evidenceIds: ["proof"] } }] }]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => [row.path, row.before, row.after]), [["/officialTracks/tracks/track-a/eligibility/text", "旧资格", "新资格"], ["/officialTracks/tracks/track-a/name", "旧名称", "新名称"]]);
  assert.equal(formatRuleChangeValue("required", "/requirements/readme/necessity"), "必交");
  assert.equal(formatRuleChangeValue(["missing_information"], "/qualityFlags"), "信息尚未确认");
});
