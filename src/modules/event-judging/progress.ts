import type { EntityId } from "../../shared/contracts.ts";
import type { IntakeReceipt, JudgeAssignment, JudgingRound, ManualScore } from "./model.ts";

/**
 * 评审进度追踪（派生视图，只读）。
 *
 * 目的：`workspace()` 已经返回本轮的全部集合，但**没有任何地方把它聚合成**"哪件作品还差几位评委、
 * 哪位评委还没交"。主办方此前只能逐个作品点开数。本文件只做聚合与呈现，不新增状态、不落库、不加表、
 * 不新增查询——输入就是既有的 `receipts / assignments / checked / scores`。
 *
 * **口径必须与既有实现一致**（这是本文件最重要的约束，也是测试固定的重点）：
 *  - `submittedCount` 的判定 = `aggregate()` 的 `effective` 过滤（`status === "active" && declaration === "clear"`
 *    且评分 `state === "submitted"`）；
 *  - `judges[].submittedCount` = `calibration()` 的 `judges[].submittedCount`，两边必须相等。
 * 因此这里**不另写一套有效性判定**，直接复用同一条件；口径将来源于 `checkedIn()` 修正后的 `checked`。
 *
 * 措辞纪律（宪法 X / 规划 33 P06 第 1.3 节）：只报"已有 / 还差"，不出百分比、进度条、完成度或"落后"；
 * 不把"未提交"写成"不负责"。无指派时返回空态，**不得凭空造出评委行**。
 */

/** 单件作品的评审进度。 */
export interface RoundProgressRow {
  snapshotId: EntityId;
  title: string;
  /** 与本轮 `minJudges` 比较的已正式提交评分数（与 aggregate() 的判定一致）。 */
  submittedCount: number;
  /** 本轮配置的最少评委数。 */
  requiredJudges: number;
  /** 还差几位；已收齐为 0。 */
  stillNeeds: number;
  /** 已收齐（`submittedCount >= requiredJudges`）。 */
  complete: boolean;
}

/** 单件作品上"已预约但被排除、因此不计入分母"的指派。 */
export interface RoundProgressExcludedAssignment {
  assignmentId: EntityId;
  judgeUserId: EntityId;
  status: JudgeAssignment["status"];
  /** 可直接展示的中文原因；不是评价，只是状态说明。 */
  reason: string;
}

/** 单件作品的分母组成：已排定评委（计入分母）与被排除的指派（不计入分母）。 */
export interface RoundProgressSnapshot {
  snapshotId: EntityId;
  /** 本轮为该作品排定的评委数（`active` + 已申报无冲突），即"应评数"的分母。 */
  scheduledJudges: number;
  excluded: readonly RoundProgressExcludedAssignment[];
}

/** 单个评委在本轮的提交进度。 */
export interface JudgeProgressRow {
  judgeUserId: EntityId;
  /** 已正式提交的评分数（与 calibration() 的 submittedCount 相等）。 */
  submittedCount: number;
  /** 本轮该评委的应评数（仅计有效指派）。 */
  assignedCount: number;
  /** 应评但尚未提交的评分数。 */
  outstanding: number;
  /** 本轮该评委被排除、不计入分母的指派数。 */
  excludedCount: number;
}

export interface ProgressReport {
  roundId: EntityId;
  status: "empty" | "in_progress" | "complete";
  /** 本轮冻结作品数。 */
  snapshotCount: number;
  requiredJudges: number;
  /** 尚未收齐的作品数。 */
  incompleteSnapshots: number;
  /** 本轮已提交的有效评分数合计。 */
  submittedTotal: number;
  /** 本轮已排定的有效指派数合计（分母口径）。 */
  assignedTotal: number;
  rows: readonly RoundProgressRow[];
  /** 尚未收齐的作品清单：按缺口数降序，同数按作品标识稳定排序。 */
  remaining: readonly RoundProgressRow[];
  judges: readonly JudgeProgressRow[];
  snapshots: readonly RoundProgressSnapshot[];
  /** 被排除的指派汇总（不计入分母）：回避 / 待核查 / 已撤销各自标注原因。 */
  excluded: readonly (RoundProgressExcludedAssignment & { snapshotId: EntityId })[];
  notice: string;
}

/** 与 aggregate()/calibration() 完全相同的有效性判定，不许在这里另写一套。 */
function isEffective(assignment: JudgeAssignment): boolean {
  return assignment.status === "active" && assignment.declaration === "clear";
}
/** 与 aggregate()/calibration() 完全相同的"已正式提交评分"判定。 */
function submittedScore(scores: readonly ManualScore[], assignmentId: EntityId): ManualScore | undefined {
  return scores.find(score => score.assignmentId === assignmentId && score.state === "submitted");
}
const MAX_ITEMS = 50;

const EXCLUSION_REASONS: Record<JudgeAssignment["status"], string> = {
  active: "指派有效",
  needs_review: "关联核查待人工确认，评分暂不计入汇总",
  recused: "已申报回避，不计入汇总",
  revoked: "指派已撤销，不计入汇总",
};

/**
 * 计算一轮评审的进度报告。
 * `checked` 必须是服务层已按当前关联核查结论修正过的指派集合（与 aggregate() 的输入一致）。
 */
export function progress(
  round: JudgingRound,
  receipts: readonly IntakeReceipt[],
  checked: readonly JudgeAssignment[],
  scores: readonly ManualScore[],
): ProgressReport {
  const inRound = checked.filter(item => item.roundId === round.id);
  const bySnapshot = new Map<EntityId, JudgeAssignment[]>();
  for (const assignment of inRound) bySnapshot.set(assignment.snapshotId, [...(bySnapshot.get(assignment.snapshotId) ?? []), assignment]);

  const rows: RoundProgressRow[] = round.snapshotIds.map(snapshotId => {
    const assigned = bySnapshot.get(snapshotId) ?? [];
    const effective = assigned.filter(isEffective);
    const submitted = effective.filter(item => submittedScore(scores, item.id)).length;
    const stillNeeds = Math.max(0, round.config.minJudges - submitted);
    return {
      snapshotId,
      title: receipts.find(receipt => receipt.id === snapshotId)?.materials.title ?? "",
      submittedCount: submitted,
      requiredJudges: round.config.minJudges,
      stillNeeds,
      complete: stillNeeds === 0,
    };
  });
  // 稳定排序：缺口多的在前；同缺口按作品标识升序（不做任何"落后排名"）。
  rows.sort((left, right) => right.stillNeeds - left.stillNeeds || (left.snapshotId < right.snapshotId ? -1 : left.snapshotId > right.snapshotId ? 1 : 0));

  const judgeIds = new Set(inRound.map(item => item.judgeUserId));

  // 只有"本轮排定过指派"的评委才出现；没有任何指派时不产生评委行（空态）。
  const judges: JudgeProgressRow[] = [...judgeIds].map(judgeUserId => {
    const mine = inRound.filter(item => item.judgeUserId === judgeUserId);
    const effective = mine.filter(isEffective);
    const submittedCount = effective.filter(item => submittedScore(scores, item.id)).length;
    return {
      judgeUserId,
      submittedCount,
      assignedCount: effective.length,
      outstanding: effective.length - submittedCount,
      excludedCount: mine.length - effective.length,
    };
  }).sort((left, right) => right.outstanding - left.outstanding
    || right.assignedCount - left.assignedCount
    || (left.judgeUserId < right.judgeUserId ? -1 : left.judgeUserId > right.judgeUserId ? 1 : 0));

  // 分母组成：只列本轮冻结名单上出现过的作品，避免把其他轮的指派混进来。
  const snapshots: RoundProgressSnapshot[] = round.snapshotIds.map(snapshotId => {
    const assigned = bySnapshot.get(snapshotId) ?? [];
    return {
      snapshotId,
      scheduledJudges: assigned.filter(isEffective).length,
      excluded: assigned.filter(item => !isEffective(item)).map(item => ({
        assignmentId: item.id, judgeUserId: item.judgeUserId, status: item.status, reason: EXCLUSION_REASONS[item.status],
      })),
    };
  });

  const excluded = snapshots.flatMap(item => item.excluded.map(entry => ({ ...entry, snapshotId: item.snapshotId })));
  const incomplete = rows.filter(row => !row.complete);
  const submittedTotal = rows.reduce((sum, row) => sum + row.submittedCount, 0);
  const assignedTotal = snapshots.reduce((sum, item) => sum + item.scheduledJudges, 0);

  // 空态判据：本轮冻结名单上"一件作品都没有排定过有效指派"时才是空态。
  const hasAnyAssignment = snapshots.some(item => item.scheduledJudges > 0 || item.excluded.length > 0);
  const status: ProgressReport["status"] = !hasAnyAssignment ? "empty" : incomplete.length ? "in_progress" : "complete";
  const notice = status === "empty"
    ? "本轮还没有排定评委指派。指派评委后，这里会显示每件作品的已提交数与还差几位。"
    : status === "complete"
      ? `本轮 ${rows.length} 件作品都已收齐至少 ${round.config.minJudges} 位评委的评分；正式总分与名次仍由人工汇总与公布决定。`
      : `本轮 ${incomplete.length} 件作品尚未收齐至少 ${round.config.minJudges} 位评委的评分。本视图只统计既有事实，不做催办、不改变任何评分或指派。`;

  return {
    roundId: round.id,
    status,
    snapshotCount: round.snapshotIds.length,
    requiredJudges: round.config.minJudges,
    incompleteSnapshots: incomplete.length,
    submittedTotal,
    assignedTotal,
    rows: rows.slice(0, MAX_ITEMS),
    remaining: incomplete.slice(0, MAX_ITEMS),
    judges: judges.slice(0, MAX_ITEMS),
    snapshots: snapshots.slice(0, MAX_ITEMS),
    excluded: excluded.slice(0, MAX_ITEMS),
    notice,
  };
}
