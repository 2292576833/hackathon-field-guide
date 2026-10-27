import assert from "node:assert/strict";
import test from "node:test";
import type { IntakeReceipt, JudgeAssignment, JudgingRound, ManualScore } from "./model.ts";
import { aggregate } from "./validation.ts";
import { calibration, calibrationThresholds, compressionFlags } from "./calibration.ts";

// 评审权重合计 100%，两个维度都按 0..100 取值，因此单个评委的作品分 = 0.6×product + 0.4×demo。
const criteria = [{ id: "product", label: "作品", weight: 60, min: 0, max: 100 }, { id: "demo", label: "展示", weight: 40, min: 0, max: 100 }];
const round = (snapshotIds: readonly string[], minJudges = 2): JudgingRound => ({ id: "round", eventId: "A", organizationId: "org", revision: 1, status: "open",
  config: { title: "决赛", criteria, minJudges, missingPolicy: "exclude_incomplete", tiePolicy: "shared_rank" }, snapshotIds,
  createdAt: "2026-10-15T00:00:00Z", startedAt: null, lockedAt: null, lockedSummary: null, publishedResultId: null });
const receipts = (ids: readonly string[]): IntakeReceipt[] => ids.map(id => ({ id, teamId: `team-${id}`, materials: { title: `作品 ${id}` } } as IntakeReceipt));
const assignment = (id: string, snapshotId: string, judgeUserId: string, status: JudgeAssignment["status"] = "active"): JudgeAssignment =>
  ({ id, snapshotId, roundId: "round", judgeUserId, status, declaration: "clear", revision: 1, conflictReasons: [] } as unknown as JudgeAssignment);
/** 只用一个维度的分数构造作品分：product 值直接决定 0.6×product。 */
const score = (assignmentId: string, product: number, state: ManualScore["state"] = "submitted"): ManualScore =>
  ({ id: `s-${assignmentId}`, assignmentId, values: { product, demo: product }, state, revision: 1 } as unknown as ManualScore);

function fixture(snapshotIds: readonly string[], minJudges = 2) {
  const r = round(snapshotIds, minJudges), list = receipts(snapshotIds);
  const assignments: JudgeAssignment[] = [], scores: ManualScore[] = [];
  return { round: r, receipts: list, assignments, scores,
    judge(judgeUserId: string, entries: readonly [string, number][], status: JudgeAssignment["status"] = "active") {
      for (const [snapshotId, product] of entries) {
        const a = assignment(`${judgeUserId}-${snapshotId}`, snapshotId, judgeUserId, status);
        assignments.push(a); if (product >= 0) scores.push(score(a.id, product));
      }
      return this;
    } };
}

test("样本不足时不提供校准分，且原始分与既有汇总完全一致", () => {
  const f = fixture(["a", "b"]).judge("harsh", [["a", 40], ["b", 60]]).judge("lenient", [["a", 70], ["b", 90]]);
  const report = calibration(f.round, f.receipts, f.assignments, f.scores);
  assert.equal(report.status, "insufficient_sample"); assert.equal(report.reason, "sample_size");
  assert.match(report.notice, /样本不足/); assert.equal(report.rows.every(row => row.calibratedTotal === null), true);
  const summary = aggregate(f.round, f.receipts, f.assignments, f.scores);
  for (const row of report.rows) {
    const raw = summary.rows.find(item => item.snapshotId === row.snapshotId)!;
    assert.equal(row.rawTotal, raw.total); assert.equal(row.rawRank, raw.rank);
  }
});

test("样本达标后校准启用：原始分不变，仅派生分改变跨评委可比性", () => {
  // A 是严评委、B 是松评委；前 5 个作品两人都评，harshOnly/lenientOnly 各只有一人评。
  const shared = ["s1", "s2", "s3", "s4", "s5"];
  const f = fixture([...shared, "harshOnly", "lenientOnly"], 1)
    .judge("harsh", [["s1", 40], ["s2", 42], ["s3", 44], ["s4", 46], ["s5", 50], ["harshOnly", 60]])
    .judge("lenient", [["s1", 70], ["s2", 72], ["s3", 74], ["s4", 76], ["s5", 80], ["lenientOnly", 70]]);
  const report = calibration(f.round, f.receipts, f.assignments, f.scores);
  assert.equal(report.status, "applied"); assert.equal(report.reason, "applied");
  assert.equal(report.judges.length, 2);
  const harsh = report.judges.find(judge => judge.judgeUserId === "harsh")!;
  const lenient = report.judges.find(judge => judge.judgeUserId === "lenient")!;
  assert.equal(harsh.submittedCount, 6); assert.equal(round4(harsh.mean!), 47); assert.equal(round4(harsh.standardDeviation!), 6.6081);
  assert.equal(lenient.submittedCount, 6); assert.equal(round4(lenient.mean!), 73.6667);

  // 原始分：严评委的单人作品 60，松评委的单人作品 70 —— 原始名次里松评委的作品在前。
  const summary = aggregate(f.round, f.receipts, f.assignments, f.scores);
  const rawOf = (id: string) => report.rows.find(row => row.snapshotId === id)!.rawTotal;
  const rowOf = (id: string) => report.rows.find(row => row.snapshotId === id)!;
  assert.equal(rawOf("harshOnly"), 60); assert.equal(rawOf("lenientOnly"), 70);
  for (const row of report.rows) assert.equal(row.rawTotal, summary.rows.find(item => item.snapshotId === row.snapshotId)!.total);
  assert.ok(rowOf("lenientOnly").rawRank! < rowOf("harshOnly").rawRank!);
  // 校准后：严评委给出的最高分不再被自己的低基准拖累，名次相对松评委的最低分反转。
  assert.ok(rowOf("harshOnly").calibratedTotal! > rowOf("lenientOnly").calibratedTotal!);
  assert.ok(rowOf("harshOnly").calibratedRank! < rowOf("lenientOnly").calibratedRank!);
  // 同一相对位置的校准分互相可比，且作品差异仍然保留。
  assert.ok(rowOf("s1").calibratedTotal! < rowOf("s5").calibratedTotal!);
});

test("单个评委只有一份评分时整轮不校准（不沿用竞品把该评委压成全局均值的做法）", () => {
  const snapshots = ["s1", "s2", "s3", "s4", "s5"];
  const f = fixture(snapshots, 1).judge("harsh", [["s1", 40], ["s2", 42], ["s3", 44], ["s4", 46], ["s5", 50]]).judge("newcomer", [["s1", 90]]);
  const report = calibration(f.round, f.receipts, f.assignments, f.scores);
  assert.equal(report.status, "insufficient_sample"); assert.equal(report.reason, "sample_size");
  const newcomer = report.judges.find(judge => judge.judgeUserId === "newcomer")!;
  assert.equal(newcomer.submittedCount, 1); assert.equal(newcomer.eligible, false);
  // 该评委的评分仍在原始分里生效，只是不参与校准，也不会被静默替换成全局平均。
  const summary = aggregate(f.round, f.receipts, f.assignments, f.scores);
  assert.equal(summary.rows.find(row => row.snapshotId === "s1")!.total, 65);
  assert.equal(report.rows.every(row => row.calibratedTotal === null), true);
});

test("打分无区分度的评委被标记，但只作提示、不影响原始分", () => {
  const snapshots = ["s1", "s2", "s3", "s4", "s5"];
  const f = fixture(snapshots)
    .judge("flat", snapshots.map(id => [id, 50] as [string, number]))
    .judge("spread", [["s1", 20], ["s2", 40], ["s3", 60], ["s4", 80], ["s5", 100]]);
  const report = calibration(f.round, f.receipts, f.assignments, f.scores);
  const flat = report.judges.find(judge => judge.judgeUserId === "flat")!;
  const spread = report.judges.find(judge => judge.judgeUserId === "spread")!;
  assert.equal(flat.compressionFlagged, true); assert.equal(flat.standardDeviation, 0);
  assert.equal(spread.compressionFlagged, false);
  assert.deepEqual(compressionFlags(report).map(judge => judge.judgeUserId), ["flat"]);
  const summary = aggregate(f.round, f.receipts, f.assignments, f.scores);
  for (const row of report.rows) assert.equal(row.rawTotal, summary.rows.find(item => item.snapshotId === row.snapshotId)!.total);
});

test("本轮评分完全没有差异时不校准，并说明原因", () => {
  const snapshots = ["s1", "s2", "s3", "s4", "s5"];
  const f = fixture(snapshots).judge("one", snapshots.map(id => [id, 50] as [string, number])).judge("two", snapshots.map(id => [id, 50] as [string, number]));
  const report = calibration(f.round, f.receipts, f.assignments, f.scores);
  assert.equal(report.status, "insufficient_sample"); assert.equal(report.reason, "no_variance");
  assert.match(report.notice, /完全一致/); assert.equal(report.globalStandardDeviation, 0);
});

test("缺评作品两项都为 null，且未进入汇总的评分被列出原因", () => {
  const f = fixture(["done", "incomplete"], 3)
    .judge("harsh", [["done", 60], ["incomplete", 60]])
    .judge("lenient", [["done", 60], ["incomplete", 60]])
    .judge("recused", [["done", 60], ["incomplete", 60]], "recused")
    .judge("silent", [["done", -1], ["incomplete", -1]]);
  const report = calibration(f.round, f.receipts, f.assignments, f.scores);
  const incomplete = report.rows.find(row => row.snapshotId === "incomplete")!;
  assert.equal(incomplete.rawTotal, null); assert.equal(incomplete.calibratedTotal, null);
  assert.equal(incomplete.rawRank, null); assert.equal(incomplete.calibratedRank, null);
  const reasons = new Map(report.excludedScores.map(item => [`${item.judgeUserId}-${item.snapshotId}`, item.reason]));
  assert.equal(reasons.get("recused-done"), "assignment_not_effective");
  assert.equal(reasons.get("silent-done"), "not_submitted");
  assert.equal(report.thresholds, calibrationThresholds);
});

test("同分共享名次：原始与校准两侧都不产生并列错位", () => {
  const snapshots = ["s1", "s2", "s3", "s4", "s5"];
  const f = fixture(snapshots, 1)
    .judge("a", [["s1", 50], ["s2", 50], ["s3", 70], ["s4", 70], ["s5", 90]])
    .judge("b", [["s1", 50], ["s2", 50], ["s3", 70], ["s4", 70], ["s5", 90]]);
  const report = calibration(f.round, f.receipts, f.assignments, f.scores);
  const ranks = (key: "rawRank" | "calibratedRank") => report.rows.map(row => [row.snapshotId, row[key]] as const);
  assert.deepEqual(ranks("rawRank"), [["s5", 1], ["s3", 2], ["s4", 2], ["s1", 4], ["s2", 4]]);
  assert.deepEqual(ranks("calibratedRank"), [["s5", 1], ["s3", 2], ["s4", 2], ["s1", 4], ["s2", 4]]);
});

function round4(value: number): number { return Math.round(value * 10000) / 10000; }
