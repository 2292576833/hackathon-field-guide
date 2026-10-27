import assert from "node:assert/strict";
import test from "node:test";
import type { IntakeReceipt, JudgeAssignment, JudgingRound, ManualScore } from "./model.ts";
import { integrity } from "./integrity.ts";

const criteria = [{ id: "idea", label: "想法", weight: 60, min: 0, max: 10 }, { id: "build", label: "实现", weight: 40, min: 0, max: 10 }];
const round = (snapshotIds: readonly string[]): JudgingRound => ({ id: "round", eventId: "A", organizationId: "org", revision: 1, status: "open",
  config: { title: "决赛", criteria, minJudges: 1, missingPolicy: "exclude_incomplete", tiePolicy: "shared_rank" }, snapshotIds,
  createdAt: "2026-10-15T00:00:00Z", startedAt: null, lockedAt: null, lockedSummary: null, publishedResultId: null });
const receipts = (ids: readonly string[]): IntakeReceipt[] => ids.map(id => ({ id, teamId: `team-${id}`, materials: { title: `作品 ${id}` } } as IntakeReceipt));
const assignment = (id: string, snapshotId: string, judgeUserId: string, overrides: Partial<JudgeAssignment> = {}): JudgeAssignment =>
  ({ id, snapshotId, roundId: "round", judgeUserId, status: "active", declaration: "clear", revision: 1, conflictReasons: [], ...overrides } as unknown as JudgeAssignment);
const score = (assignmentId: string, values: Record<string, number>, state: ManualScore["state"] = "submitted"): ManualScore =>
  ({ id: `s-${assignmentId}`, assignmentId, values, state, revision: 1 } as unknown as ManualScore);
const check = (report: ReturnType<typeof integrity>, id: string) => report.checks.find(item => item.id === id)!;

test("健康的一轮全部通过，并如实报告被排除的评分数量", () => {
  const snapshots = ["s1", "s2"];
  const stored = [assignment("a1", "s1", "judge-1"), assignment("a2", "s2", "judge-1"), assignment("a3", "s1", "judge-2", { status: "recused", declaration: "conflict" })];
  const effective = stored.filter(item => item.status === "active" && item.declaration === "clear");
  const scores = [score("a1", { idea: 8, build: 7 }), score("a2", { idea: 6, build: 6 }), score("a3", { idea: 10, build: 10 })];
  const report = integrity(round(snapshots), receipts(snapshots), stored, effective, scores);
  assert.equal(report.status, "pass");
  assert.equal(check(report, "conflict_blocked").status, "pass");
  assert.equal(check(report, "score_values").status, "pass");
  assert.equal(check(report, "duplicate_assignments").status, "pass");
  assert.equal(check(report, "round_snapshots").status, "pass");
  // 被回避的评委虽然提交了满分，但明确记为"已排除、未计入"，且不影响通过结论。
  assert.equal(check(report, "excluded_scores").status, "pass");
  assert.equal(check(report, "excluded_scores").count, 1);
  assert.match(check(report, "excluded_scores").items[0]!.detail, /recused/);
});

test("存储里有效但被最新关联核查阻断的指派会被点名，而不是静默丢弃", () => {
  const snapshots = ["s1"];
  const stored = [assignment("a1", "s1", "judge-1")];
  const effective = [{ ...stored[0]!, status: "needs_review" as const }];
  const report = integrity(round(snapshots), receipts(snapshots), stored, effective, [score("a1", { idea: 9, build: 9 })]);
  assert.equal(report.status, "attention");
  const blocked = check(report, "conflict_blocked");
  assert.equal(blocked.count, 1); assert.equal(blocked.items[0]!.judgeUserId, "judge-1");
  assert.equal(check(report, "excluded_scores").count, 1);
  assert.equal(check(report, "score_values").status, "pass");
});

test("越界分数、未知维度与维度数不符都会被列出", () => {
  const snapshots = ["s1", "s2", "s3"];
  const stored = [assignment("a1", "s1", "judge-1"), assignment("a2", "s2", "judge-1"), assignment("a3", "s3", "judge-1")];
  const scores = [score("a1", { idea: 11, build: 5 }), score("a2", { idea: 5, extra: 5 }), score("a3", { idea: 5 })];
  const report = integrity(round(snapshots), receipts(snapshots), stored, stored, scores);
  assert.equal(report.status, "attention");
  const values = check(report, "score_values");
  assert.equal(values.count, 3);
  const details = values.items.map(item => item.detail).join(" | ");
  assert.match(details, /超出 0–10/); assert.match(details, /冻结标准之外的维度 extra/); assert.match(details, /与冻结维度数不一致/);
});

test("同一评委对同一作品的多条有效指派会被判为重复计分风险", () => {
  const snapshots = ["s1"];
  const stored = [assignment("a1", "s1", "judge-1"), assignment("a2", "s1", "judge-1")];
  const report = integrity(round(snapshots), receipts(snapshots), stored, stored, [score("a1", { idea: 7, build: 7 }), score("a2", { idea: 7, build: 7 })]);
  assert.equal(report.status, "attention");
  const duplicates = check(report, "duplicate_assignments");
  assert.equal(duplicates.count, 1); assert.match(duplicates.items[0]!.detail, /2 条有效指派/);
});

test("本轮名单缺少正式收件材料时如实报出，不继续假装可以汇总", () => {
  const report = integrity(round(["s1", "missing"]), receipts(["s1"]),
    [assignment("a1", "s1", "judge-1")], [assignment("a1", "s1", "judge-1")], [score("a1", { idea: 5, build: 5 })]);
  assert.equal(report.status, "attention");
  const snapshots = check(report, "round_snapshots");
  assert.equal(snapshots.count, 1); assert.equal(snapshots.items[0]!.snapshotId, "missing");
});

test("草稿评分不进入任何检查，也不改变通过结论", () => {
  const snapshots = ["s1"];
  const stored = [assignment("a1", "s1", "judge-1")];
  const report = integrity(round(snapshots), receipts(snapshots), stored, stored, [score("a1", { idea: 99, build: 99 }, "draft")]);
  assert.equal(report.status, "pass");
  assert.equal(check(report, "score_values").count, 0);
  assert.equal(check(report, "excluded_scores").count, 0);
});
