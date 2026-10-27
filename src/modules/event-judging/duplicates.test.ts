import assert from "node:assert/strict";
import test from "node:test";
import type { IntakeReceipt, SubmissionMaterials } from "./model.ts";
import { duplicateReport, maxDuplicatePairs, normalizedTitle, normalizedUrl } from "./duplicates.ts";

const materials = (overrides: Partial<SubmissionMaterials> = {}): SubmissionMaterials => ({ title: "校园助手", description: "说明",
  links: [{ label: "演示", url: "https://demo.example.test/app" }],
  files: [{ name: "说明.pdf", url: "https://files.example.test/spec.pdf", sizeBytes: 1024, sha256: "a".repeat(64), mediaType: "application/pdf" }], ...overrides });
const receipt = (teamId: string, version: number, overrides: Partial<SubmissionMaterials> = {}, submittedAt = "2026-10-15T00:00:00.000Z"): IntakeReceipt => ({
  id: `receipt-${teamId}-${version}`, organizationId: "org", eventId: "event", teamId, authorUserId: `user-${teamId}`, version, receiptNumber: `R-${teamId}-${version}`,
  idempotencyKey: `key-${teamId}-${version}`, submittedAt, ruleVersion: 1, teamRevision: 1, memberUserIds: [], materials: materials(overrides), materialHash: "h", warning: "",
  eventRevision: 1, publishedRevision: 1, previousVersion: version - 1, submissionClosesAt: "2026-10-30T00:00:00.000Z", inputHash: `input-${teamId}-${version}`, submissionRecordId: null });

test("同一队伍的连续版本不参与比较，只比较各队最新一版", () => {
  const receipts = [receipt("team-a", 1), receipt("team-a", 2, { title: "校园助手 v2" })];
  const report = duplicateReport(receipts);
  assert.equal(report.checkedTeams, 1, "同队两版只算一支队伍");
  assert.deepEqual(report.pairs, []);
});

test("同一文件哈希是最强线索，并给出可核对依据", () => {
  const report = duplicateReport([receipt("team-a", 1), receipt("team-b", 1)]);
  assert.equal(report.pairs.length, 1);
  const pair = report.pairs[0]!;
  assert.equal(pair.strength, "high");
  assert.ok(pair.reasons.some(reason => reason.kind === "file_hash" && /同一文件哈希/.test(reason.detail)));
  assert.ok(pair.reasons.some(reason => reason.kind === "material_url"), "演示地址相同也应一并列出");
  assert.ok(pair.reasons.some(reason => reason.kind === "title"), "同名也应一并列出");
});

test("同名但材料完全不同只是最低强度线索，不升级结论", () => {
  const report = duplicateReport([receipt("team-a", 1, { links: [{ label: "演示", url: "https://a.example.test/x" }], files: [] }),
    receipt("team-b", 1, { links: [{ label: "演示", url: "https://b.example.test/y" }], files: [] })]);
  assert.equal(report.pairs.length, 1);
  assert.equal(report.pairs[0]!.strength, "low");
  assert.deepEqual(report.pairs[0]!.reasons.map(reason => reason.kind), ["title"]);
});

test("地址归一：忽略查询串、片段与结尾斜杠，但保留主机与路径", () => {
  assert.equal(normalizedUrl("https://Demo.Example.test/app/?utm=1#top"), "demo.example.test/app");
  assert.equal(normalizedUrl("https://demo.example.test/app"), "demo.example.test/app");
  assert.equal(normalizedUrl("http://demo.example.test/app"), null, "非 HTTPS 不参与比较");
  const report = duplicateReport([receipt("team-a", 1, { title: "队伍甲的助手", links: [{ label: "演示", url: "https://demo.example.test/app?utm_source=x" }], files: [] }),
    receipt("team-b", 1, { title: "队伍乙的看板", links: [{ label: "演示", url: "https://demo.example.test/app#readme" }], files: [] })]);
  assert.equal(report.pairs[0]!.strength, "medium", "只共享地址时是中等强度");
  assert.deepEqual(report.pairs[0]!.reasons.map(reason => reason.kind), ["material_url"]);
});

test("名称归一去掉空白与常见分隔符号", () => {
  assert.equal(normalizedTitle(" 作品 A·校园 "), normalizedTitle("作品A校园"));
  assert.equal(normalizedTitle("作品-A"), normalizedTitle("作品 A"));
});

test("没有共同事实时不产生任何线索，也不凭空猜测", () => {
  const report = duplicateReport([receipt("team-a", 1, { title: "甲", links: [{ label: "演示", url: "https://a.example.test/x" }], files: [] }),
    receipt("team-b", 1, { title: "乙", links: [{ label: "演示", url: "https://b.example.test/y" }], files: [] })]);
  assert.deepEqual(report.pairs, []);
  assert.match(report.notice, /0 条线索/);
  assert.deepEqual(report.limitations, [
    "只比较各队最新一版材料；同一队伍的连续版本属于版本关系，不在这里比较。",
    "线索只是可核对的事实：同一文件哈希、同一材料地址、同名作品。",
    "同一套开源模板、同一场工作坊脚手架或主办方示例都可能造成相同地址或同名，请先核对再处理。",
    "这里不做评分、不给百分比，也不自动通知任何队伍。",
  ]);
});

test("线索数量有上限，截断时明确告知而不是静默丢弃", () => {
  const receipts = Array.from({ length: maxDuplicatePairs + 6 }, (_, index) => receipt(`team-${String(index).padStart(3, "0")}`, 1));
  const report = duplicateReport(receipts);
  assert.equal(report.truncated, true);
  assert.equal(report.pairs.length, maxDuplicatePairs);
  assert.match(report.notice, /只展示前 50 条/);
  assert.equal(report.pairs[0]!.strength, "high");
});
