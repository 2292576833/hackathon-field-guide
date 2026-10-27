import assert from "node:assert/strict";
import test from "node:test";
import type { IntakeReceipt, JudgeAssignment, JudgingRound, ManualScore, PublishedResults } from "./model.ts";
import { fairnessLinePreview, fairnessReport } from "./fairness.ts";

const round = (overrides: Partial<JudgingRound> = {}): JudgingRound => ({ id: "round-1", organizationId: "org", eventId: "event", revision: 3, status: "locked",
  config: { title: "决赛", criteria: [{ id: "idea", label: "想法", weight: 60, min: 0, max: 10 }, { id: "exec", label: "完成度", weight: 40, min: 0, max: 10 }],
    minJudges: 2, missingPolicy: "block_publication", tiePolicy: "shared_rank", appealWindowDays: 5 },
  snapshotIds: ["receipt-1"], createdAt: "2026-10-01T00:00:00.000Z", startedAt: null, lockedAt: null, lockedSummary: null, publishedResultId: null, ...overrides });
const receipt = (overrides: Partial<IntakeReceipt> = {}): IntakeReceipt => ({ id: "receipt-1", organizationId: "org", eventId: "event", teamId: "team-a", authorUserId: "alice", version: 1,
  receiptNumber: "R-1", idempotencyKey: "k", submittedAt: "2026-10-20T00:00:00.000Z", ruleVersion: 1, teamRevision: 1, memberUserIds: ["alice"], materialHash: "h", warning: "",
  inputHash: "input", submissionRecordId: null, eventRevision: 1, publishedRevision: 1, previousVersion: 0, submissionClosesAt: "2026-10-21T00:00:00.000Z",
  materials: { title: "作品", description: "这是一个足够长的作品说明，用来通过材料完整度检查的四十字门槛，并且写清了解决的问题与体验步骤。", links: [{ label: "演示", url: "https://example.test/x" }], files: [] }, ...overrides });
const report = (input: Partial<Parameters<typeof fairnessReport>[0]> = {}) => fairnessReport({ round: round(), receipts: [receipt()], assignments: [], scores: [], published: null, now: "2026-10-22T00:00:00.000Z", ...input });

test("公开规则包只写已冻结的事实，未提供的写未提供", () => {
  const result = report();
  assert.equal(result.declaration.title, "决赛 · 评审与公平规则");
  assert.ok(result.declaration.lines.some(line => line.includes("想法（权重 60，计分区间 0–10）")));
  assert.ok(result.declaration.lines.some(line => line.includes("最少评委数：2 位")));
  assert.ok(result.declaration.lines.some(line => line.includes("缺评时暂不公布")));
  assert.ok(result.declaration.lines.some(line => line.includes("并列名次")));
  assert.ok(result.declaration.lines.some(line => line.includes("结果公布后 5 天内")));
  assert.ok(result.declaration.lines.some(line => line.includes("链接最多 12 条")));
  const empty = report({ round: round({ config: { ...round().config, criteria: [] } }) });
  assert.ok(empty.declaration.lines.some(line => line.includes("评审维度：未提供")));
});

test("迟交只产生需人工确认的建议，绝不自动扣分", () => {
  const result = report({ receipts: [receipt({ submittedAt: "2026-10-22T00:00:00.000Z" })] });
  const late = result.suggestions.find(item => item.kind === "late_submission");
  assert.ok(late);
  assert.equal(late.needsConfirmation, true);
  assert.match(late.fact, /晚于作品截止/);
  assert.match(late.suggestion, /不会自动扣分或取消资格/);
  assert.ok(result.limitations.some(line => line.includes("系统不会自动执行")));
});

test("准时且材料完整时不给任何建议", () => {
  const result = report();
  assert.deepEqual(result.suggestions, []);
  assert.match(result.notice, /0 条待你人工确认/);
});

test("材料过薄与没有链接都会被指出，且只作为建议", () => {
  const noLinks = report({ receipts: [receipt({ materials: { ...receipt().materials, links: [] } })] });
  assert.equal(noLinks.suggestions[0]!.kind, "incomplete_materials");
  assert.match(noLinks.suggestions[0]!.fact, /没有可访问的作品链接/);
  const thin = report({ receipts: [receipt({ materials: { ...receipt().materials, description: "很短" } })] });
  assert.match(thin.suggestions[0]!.fact, /作品说明较短（2 字）/);
});

test("缺评建议来自已公布结果，并且要求人工决定是否补派", () => {
  const published: PublishedResults = { id: "result-1", roundId: "round-1", organizationId: "org", eventId: "event", version: 1, visibility: "public", publishedAt: "2026-10-22T00:00:00.000Z", publishedBy: "owner",
    rows: [{ snapshotId: "receipt-1", teamId: "team-a", title: "作品", submittedJudgeCount: 1, missingJudges: 1, total: 80, rank: 1 }], approvedFeedback: [] };
  const result = report({ published });
  const missing = result.suggestions.find(item => item.kind === "missing_judges");
  assert.ok(missing);
  assert.match(missing.fact, /1 位评委未提交评分/);
  assert.match(missing.suggestion, /是否处理由你决定/);
});

test("建议按事实类型与队伍稳定排序，便于逐条核对", () => {
  const result = report({ receipts: [receipt({ teamId: "team-b", submittedAt: "2026-10-25T00:00:00.000Z" }), receipt({ id: "receipt-2", teamId: "team-a", submittedAt: "2026-10-26T00:00:00.000Z" })] });
  assert.deepEqual(result.suggestions.map(item => item.teamId), ["team-a", "team-b"]);
  assert.ok(result.suggestions.every(item => item.kind === "late_submission" && item.needsConfirmation));
});

test("规则包摘要可以整段复制，超长时明确截断", () => {
  const preview = fairnessLinePreview(report());
  assert.match(preview, /^决赛 · 评审与公平规则/);
  assert.ok(preview.includes("\n· 评审维度："));
  const clipped = fairnessLinePreview(report(), 20);
  assert.equal(clipped.length, 20);
  assert.ok(clipped.endsWith("…"));
});

test("被回避或未申报的指派不计入汇总，并在规则包里说明数量", () => {
  const assignment = (status: JudgeAssignment["status"], declaration: JudgeAssignment["declaration"]): JudgeAssignment => ({ id: `a-${status}-${declaration}`, organizationId: "org", eventId: "event", roundId: "round-1",
    judgeUserId: "judge", snapshotId: "receipt-1", status, declaration, revision: 1, conflictReasons: [], createdAt: "2026-10-01T00:00:00.000Z" });
  const scores: ManualScore[] = [{ id: "s-1", organizationId: "org", eventId: "event", assignmentId: "a-active-clear", revision: 1, state: "submitted", values: { idea: 8, exec: 8 }, feedback: "", updatedAt: "2026-10-01T00:00:00.000Z" }];
  const result = report({ assignments: [assignment("active", "clear"), assignment("active", "conflict"), assignment("revoked", "clear")], scores });
  assert.ok(result.declaration.lines.some(line => line.includes("不计入汇总的评分") && line.includes("2 条")));
  assert.ok(result.declaration.lines.some(line => line.includes("已提交状态的评分共 1 条")));
});
