import type { EntityId } from "../../shared/contracts.ts";
import type { IntakeReceipt, JudgeAssignment, JudgingRound, ManualScore } from "./model.ts";

/**
 * 评委严格度校准（派生视图）。
 *
 * 依据与目的：不同评委的平均分与打分幅度差异会让队伍"因为遇到严评委而吃亏"。
 * 本文件按评委自身的均值和标准差把分数映射到全局分布，使跨评委比较更公平。
 *
 * 与竞品实现（JUDGELAYER `server.ts` L294–382）的关键差异，也是本实现必须守住的约束：
 *  1. **只做派生**：原始分与原始名次由 aggregate() 计算且保持不变，校准分单独返回，永不覆盖正式结果。
 *  2. **样本不足不校准**：每位提交过评分的评委都必须达到最小样本量，否则整轮不提供校准分；
 *     竞品在 N_j = 1 时 σ = 0，Z 恒为 0，会把该评委的评分压成全局平均、抹平全部区分度。
 *  3. **无差异不校准**：本轮有效评分若完全没有差异，校准没有意义。
 *  4. 标准差设下限，避免极小方差把 Z 放大成极端值（竞品取 max(σ, 0.25)，本实现按 0..100 分制取 5 分）。
 */

export interface CalibrationThresholds {
  /** 每位评委进入校准所需的最少已完成评分数。 */
  minScoresPerJudge: number;
  /** 至少多少个作品获得了两位及以上评委的评分。 */
  minScoredSnapshots: number;
  /** 评委自身标准差的下限（0..100 分制），避免极小方差放大 Z。 */
  sigmaFloor: number;
  /** 判定"打分无区分度"所需的最少样本数。 */
  compressionMinSample: number;
  /** 低于该标准差视为分数压缩（0..100 分制）。 */
  compressionSigma: number;
}

export const calibrationThresholds: CalibrationThresholds = {
  minScoresPerJudge: 5,
  minScoredSnapshots: 3,
  sigmaFloor: 5,
  compressionMinSample: 3,
  compressionSigma: 3,
};

export interface JudgeCalibration {
  judgeUserId: EntityId;
  /** 本轮这位评委已正式提交的评分数。 */
  submittedCount: number;
  /** 该评委自己给出的平均分（0..100，四位小数）。 */
  mean: number | null;
  /** 该评委自己打分的总体标准差（0..100，四位小数）。 */
  standardDeviation: number | null;
  /** 是否达到最小样本量。 */
  eligible: boolean;
  /** 样本足够但几乎没有区分度（给所有作品同一类分数），提示主办方复核。 */
  compressionFlagged: boolean;
}

export interface CalibrationRow {
  snapshotId: EntityId;
  title: string;
  /** 与 aggregate() 完全一致的原始总分（正式结果）。 */
  rawTotal: number | null;
  rawRank: number | null;
  /** 校准分；仅在 status 为 applied 且该作品不缺评时有值。 */
  calibratedTotal: number | null;
  calibratedRank: number | null;
  /** 参与校准平均的评委数（缺评作品为 0）。 */
  calibratedJudgeCount: number;
}

export interface CalibrationReport {
  roundId: EntityId;
  status: "applied" | "insufficient_sample";
  reason: "applied" | "sample_size" | "no_variance";
  notice: string;
  thresholds: CalibrationThresholds;
  judges: readonly JudgeCalibration[];
  globalMean: number | null;
  globalStandardDeviation: number | null;
  rows: readonly CalibrationRow[];
  /** 本轮存在但未进入汇总的评分，说明原因，便于"先校验后聚合"的复核。 */
  excludedScores: readonly { assignmentId: EntityId; judgeUserId: EntityId; snapshotId: EntityId; reason: "assignment_not_effective" | "not_submitted" }[];
}

const round4 = (value: number): number => Math.round(value * 10000) / 10000;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
const populationStd = (values: readonly number[], average = mean(values)): number =>
  Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);

/** 单个评委对单个作品的分数，换算到与 aggregate() 相同的 0..100 分制。 */
function unitScore(round: JudgingRound, score: ManualScore): number {
  const units = round.config.criteria.reduce((sum, criterion) =>
    sum + Math.round((score.values[criterion.id]! - criterion.min) * 10000 / (criterion.max - criterion.min)) * criterion.weight, 0);
  return units / 10000;
}

/** 与 aggregate() 相同的等权平均与固定整数精度（先四舍五入到整数单位再还原）。 */
function rawTotal(round: JudgingRound, scores: readonly ManualScore[]): number {
  const units = scores.map(score => round.config.criteria.reduce((sum, criterion) =>
    sum + Math.round((score.values[criterion.id]! - criterion.min) * 10000 / (criterion.max - criterion.min)) * criterion.weight, 0));
  return round4(Math.round(units.reduce((sum, unit) => sum + unit, 0) / units.length) / 10000);
}

/** 与既有结果一致的名次规则：同分共享名次，未完成的作品不参与排名。 */
function assignRanks<T extends { rank: number | null; total: number | null }>(rows: T[]): boolean {
  let hasTies = false;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (row.total === null) { row.rank = null; continue; }
    const tied = index > 0 && rows[index - 1]!.total === row.total;
    if (tied) hasTies = true;
    row.rank = tied ? rows[index - 1]!.rank : index + 1;
  }
  return hasTies;
}

/**
 * 计算一轮评审的校准报告。
 * `checked` 必须是服务层已按当前关联核查结论修正过的指派集合（与 aggregate() 的输入一致）。
 */
export function calibration(
  round: JudgingRound,
  receipts: readonly IntakeReceipt[],
  checked: readonly JudgeAssignment[],
  scores: readonly ManualScore[],
): CalibrationReport {
  const effective = checked.filter(item => item.roundId === round.id && item.status === "active" && item.declaration === "clear");
  const submittedFor = (assignmentId: EntityId): ManualScore | undefined =>
    scores.find(score => score.assignmentId === assignmentId && score.state === "submitted");

  const perSnapshot = round.snapshotIds.map(snapshotId => {
    const rows = effective.filter(item => item.snapshotId === snapshotId)
      .map(item => ({ assignment: item, score: submittedFor(item.id) }))
      .filter((entry): entry is { assignment: JudgeAssignment; score: ManualScore } => !!entry.score);
    return { snapshotId, entries: rows };
  });

  const judgedScores = perSnapshot.flatMap(item => item.entries);
  const byJudge = new Map<EntityId, number[]>();
  for (const entry of judgedScores) {
    const values = byJudge.get(entry.assignment.judgeUserId) ?? [];
    values.push(unitScore(round, entry.score));
    byJudge.set(entry.assignment.judgeUserId, values);
  }
  const allJudges: JudgeCalibration[] = [...byJudge.entries()].map(([judgeUserId, values]) => {
    const average = round4(mean(values)), deviation = round4(populationStd(values, mean(values)));
    return {
      judgeUserId,
      submittedCount: values.length,
      mean: average,
      standardDeviation: deviation,
      eligible: values.length >= calibrationThresholds.minScoresPerJudge,
      compressionFlagged: values.length >= calibrationThresholds.compressionMinSample && populationStd(values, mean(values)) < calibrationThresholds.compressionSigma,
    };
  }).sort((left, right) => right.submittedCount - left.submittedCount || (left.judgeUserId < right.judgeUserId ? -1 : left.judgeUserId > right.judgeUserId ? 1 : 0));
  // Eligibility is decided on the complete set; only the returned list is bounded.
  const judges = allJudges.slice(0, 100);

  const allValues = judgedScores.map(entry => unitScore(round, entry.score));
  const globalMean = allValues.length ? round4(mean(allValues)) : null;
  const globalStandardDeviation = allValues.length ? round4(populationStd(allValues, mean(allValues))) : null;
  const scoredSnapshots = perSnapshot.filter(item => item.entries.length >= 2).length;
  const everyJudgeEligible = allJudges.length > 0 && allJudges.every(judge => judge.eligible);

  const reason: CalibrationReport["reason"] =
    allJudges.length < 2 || !everyJudgeEligible || scoredSnapshots < calibrationThresholds.minScoredSnapshots ? "sample_size"
      : (globalStandardDeviation ?? 0) <= 0 ? "no_variance"
        : "applied";
  const status: CalibrationReport["status"] = reason === "applied" ? "applied" : "insufficient_sample";

  const rows: CalibrationRow[] = perSnapshot.map(item => {
    const snapshot = receipts.find(receipt => receipt.id === item.snapshotId);
    const missing = Math.max(0, round.config.minJudges - item.entries.length);
    // Missing judges make the official total null; the derived view must mirror that rule exactly.
    const raw = !missing && item.entries.length ? rawTotal(round, item.entries.map(entry => entry.score)) : null;
    let calibrated: number | null = null;
    if (status === "applied" && !missing && globalMean !== null && globalStandardDeviation !== null) {
      const normalized = item.entries.map(({ assignment, score }) => {
        const values = byJudge.get(assignment.judgeUserId)!;
        const judgeMean = mean(values), judgeStd = populationStd(values, judgeMean);
        const z = (unitScore(round, score) - judgeMean) / Math.max(judgeStd, calibrationThresholds.sigmaFloor);
        return clamp(globalMean + z * globalStandardDeviation, 0, 100);
      });
      calibrated = round4(mean(normalized));
    }
    return { snapshotId: item.snapshotId, title: snapshot?.materials.title ?? "", rawTotal: raw, rawRank: null,
      calibratedTotal: calibrated, calibratedRank: null, calibratedJudgeCount: calibrated === null ? 0 : item.entries.length };
  });
  rows.sort((left, right) => (right.rawTotal ?? -1) - (left.rawTotal ?? -1) || (left.snapshotId < right.snapshotId ? -1 : left.snapshotId > right.snapshotId ? 1 : 0));
  const rawOrder = rows.map(row => ({ rank: null as number | null, total: row.rawTotal }));
  assignRanks(rawOrder);
  rows.forEach((row, index) => { row.rawRank = rawOrder[index]!.rank; });
  const calibratedRows = [...rows].sort((left, right) => (right.calibratedTotal ?? -1) - (left.calibratedTotal ?? -1) || (left.snapshotId < right.snapshotId ? -1 : left.snapshotId > right.snapshotId ? 1 : 0));
  const calibratedOrder = calibratedRows.map(row => ({ rank: null as number | null, total: row.calibratedTotal }));
  assignRanks(calibratedOrder);
  calibratedRows.forEach((row, index) => { row.calibratedRank = calibratedOrder[index]!.rank; });

  const excludedScores: { assignmentId: EntityId; judgeUserId: EntityId; snapshotId: EntityId; reason: CalibrationReport["excludedScores"][number]["reason"] }[] = [];
  for (const assignment of checked.filter(item => item.roundId === round.id)) {
    const score = scores.find(item => item.assignmentId === assignment.id && item.state === "submitted");
    if (!score) { excludedScores.push({ assignmentId: assignment.id, judgeUserId: assignment.judgeUserId, snapshotId: assignment.snapshotId, reason: "not_submitted" }); continue; }
    if (assignment.status !== "active" || assignment.declaration !== "clear")
      excludedScores.push({ assignmentId: assignment.id, judgeUserId: assignment.judgeUserId, snapshotId: assignment.snapshotId, reason: "assignment_not_effective" });
  }

  const notice = status === "applied"
    ? `校准为派生视图：正式总分与名次仍以原始分为准，校准分仅供复核参考。门槛为每位评委至少 ${calibrationThresholds.minScoresPerJudge} 份已完成评分、至少 ${calibrationThresholds.minScoredSnapshots} 个作品获得两位及以上评委评分，标准差下限 ${calibrationThresholds.sigmaFloor} 分。`
    : reason === "no_variance"
      ? "本轮所有有效评分完全一致，校准没有区分意义，因此不提供校准分；原始分与名次不受影响。"
      : `样本不足，本轮不提供校准分（需要每位评委至少 ${calibrationThresholds.minScoresPerJudge} 份已完成评分、至少 ${calibrationThresholds.minScoredSnapshots} 个作品获得两位及以上评委评分）；原始分与名次不受影响。`;
  return { roundId: round.id, status, reason, notice, thresholds: calibrationThresholds, judges,
    globalMean, globalStandardDeviation, rows, excludedScores: excludedScores.slice(0, 100) };
}

/** 提示主办方需要人工复核的评委（样本足够但打分无区分度）。 */
export function compressionFlags(report: CalibrationReport): readonly JudgeCalibration[] {
  return report.judges.filter(judge => judge.compressionFlagged);
}
