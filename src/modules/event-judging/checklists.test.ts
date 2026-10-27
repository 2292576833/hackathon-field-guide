import assert from "node:assert/strict";
import test from "node:test";
import type { IntakeReceipt, PublishedResults } from "./model.ts";
import { postEventReuse, preEventReadiness } from "./checklists.ts";

const receipt = (overrides: Partial<IntakeReceipt> = {}): IntakeReceipt => ({ id: "receipt-1", organizationId: "org", eventId: "event", teamId: "team-a", authorUserId: "alice", version: 1,
  receiptNumber: "R-1", idempotencyKey: "k", submittedAt: "2026-10-20T00:00:00.000Z", ruleVersion: 3, teamRevision: 2, memberUserIds: ["alice", "bob"], materialHash: "h", warning: "",
  inputHash: "input", submissionRecordId: null, eventRevision: 5, publishedRevision: 4, previousVersion: 0, submissionClosesAt: "2026-10-21T00:00:00.000Z",
  materials: { title: "作品", description: "这是一个足够长的作品说明，用来通过材料完整度检查的四十字门槛，并且写清了体验步骤。", links: [{ label: "演示", url: "https://example.test/x" }],
    files: [{ name: "说明.pdf", url: "https://example.test/spec.pdf", sizeBytes: 2048, sha256: "a".repeat(64), mediaType: "application/pdf" }] }, ...overrides });
const published = (overrides: Partial<PublishedResults> = {}): PublishedResults => ({ id: "result-1", roundId: "round-1", organizationId: "org", eventId: "event", version: 2, visibility: "public",
  publishedAt: "2026-10-22T00:00:00.000Z", publishedBy: "owner",
  rows: [{ snapshotId: "receipt-1", teamId: "team-a", title: "作品", submittedJudgeCount: 2, missingJudges: 0, total: 88, rank: 2 }],
  approvedFeedback: [{ snapshotId: "receipt-1", visibility: "team", text: "演示很清楚，建议补充限制说明。" }], ...overrides });
const readiness = (input: Partial<Parameters<typeof preEventReadiness>[0]> = {}) => preEventReadiness({ registration: { status: "approved" }, memberUserIds: ["alice", "bob"], receipts: [receipt()],
  published: null, now: "2026-10-20T12:00:00.000Z", ...input });

test("赛前自检只读列出可核对项，不写入任何打勾状态", () => {
  const result = readiness();
  assert.deepEqual(result.items.map(item => item.id), ["registration", "team", "team_size", "receipt", "materials", "deadline", "published"]);
  assert.equal(result.ready, 5); assert.equal(result.total, 5, "info 项（人数规则、公布状态）不计入可核对总数");
  assert.ok(result.limitations.some(line => line.includes("不写入任何打勾记录")));
  assert.match(result.notice, /共 5 项可核对，其中 5 项已完成/);
});

test("未报名、未组队、未交件时逐项指出下一步", () => {
  const result = readiness({ registration: null, memberUserIds: [], receipts: [] });
  assert.equal(result.items.find(item => item.id === "registration")!.state, "todo");
  assert.match(result.items.find(item => item.id === "registration")!.detail, /尚未报名/);
  assert.equal(result.items.find(item => item.id === "team")!.state, "todo");
  assert.equal(result.items.find(item => item.id === "receipt")!.state, "todo");
  assert.equal(result.items.find(item => item.id === "deadline")!.state, "info", "没交件时不知道截止时间，不能编");
  assert.equal(result.ready, 0);
});

test("材料不齐时具体指出缺链接还是说明太短", () => {
  const noLinks = readiness({ receipts: [receipt({ materials: { ...receipt().materials, links: [] } })] });
  assert.equal(noLinks.items.find(item => item.id === "materials")!.state, "todo");
  assert.match(noLinks.items.find(item => item.id === "materials")!.detail, /缺少可访问的作品链接/);
  const thin = readiness({ receipts: [receipt({ materials: { ...receipt().materials, description: "太短" } })] });
  assert.match(thin.items.find(item => item.id === "materials")!.detail, /只有 2 字/);
});

test("截止时间按实际比较，过期就明确说已过并指向主办方", () => {
  const late = readiness({ now: "2026-10-22T00:00:00.000Z" });
  const item = late.items.find(entry => entry.id === "deadline")!;
  assert.equal(item.state, "todo");
  assert.match(item.detail, /已过/);
  assert.match(item.detail, /历史版本保留/);
});

test("已公布时给出复用清单：本队材料、反馈、规则版本，且只含自己内容", () => {
  const reuse = postEventReuse({ receipts: [receipt()], published: published() });
  assert.equal(reuse.published, true); assert.equal(reuse.version, 2);
  assert.deepEqual(reuse.entries.map(entry => entry.kind), ["receipt", "rules", "link", "file", "feedback"]);
  assert.equal(reuse.entries[3]!.label, "说明.pdf");
  assert.match(reuse.entries[3]!.detail, /SHA-256 aaaaaaaaaaaa…/);
  assert.match(reuse.notice, /本队名次：第 2 名/);
  assert.ok(reuse.limitations.some(line => line.includes("不包含其他队伍内容")));
  assert.ok(reuse.limitations.some(line => line.includes("许可与署名")));
});

test("公布后只会取本队那一行的反馈，不会带出其他队伍或未批准内容", () => {
  const other = published({ rows: [{ snapshotId: "receipt-9", teamId: "team-b", title: "别人的作品", submittedJudgeCount: 2, missingJudges: 0, total: 99, rank: 1 }],
    approvedFeedback: [{ snapshotId: "receipt-9", visibility: "public", text: "别人的反馈" }] });
  const reuse = postEventReuse({ receipts: [receipt()], published: other });
  assert.equal(reuse.entries.some(entry => entry.kind === "feedback"), false);
  assert.equal(JSON.stringify(reuse).includes("别人的"), false, "不得泄露其他队伍的作品名与反馈");
});

test("没有交件时复用清单为空并说明原因", () => {
  const reuse = postEventReuse({ receipts: [], published: null });
  assert.deepEqual(reuse.entries, []);
  assert.equal(reuse.published, false);
  assert.match(reuse.notice, /还没有正式交件/);
});

test("公布被更正时清单跟随最新版本，并在说明里写明这一点", () => {
  const reuse = postEventReuse({ receipts: [receipt()], published: published({ version: 3 }) });
  assert.match(reuse.notice, /第 3 版/);
  assert.ok(reuse.limitations.some(line => line.includes("本清单会随最新公布版本变化")));
});
