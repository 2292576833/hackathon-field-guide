import type { EntityId } from "../../shared/contracts.ts";
import type { IntakeReceipt, JudgeAssignment, JudgingRound, ManualScore } from "./model.ts";

/**
 * 评审隔离一键自检（派生视图，只读）。
 *
 * 依据：竞品源码把"评审隔离边界是否真的有效"做成可随时自查的能力（JUDGELAYER `POST /api/audit/probe`、
 * `server.ts` L1157–1213，配合 L772–793 的服务端硬拒绝）。我们此前只有逐个入口的 403，没有一处能回答
 * "现在这轮评审的边界还成立吗"。本文件只用既有事实回答这个问题，不新增状态、表或写路径。
 *
 * 自检不改变任何事实：它只报告"应当被排除但确实被排除了""仍然有效但已被最新核查阻断""分数落在冻结标准之外"
 * 这类边界结论，由主办方决定是否处理。
 */

export interface IntegrityItem { assignmentId?: EntityId; snapshotId?: EntityId; judgeUserId?: EntityId; detail: string }
export interface IntegrityCheck {
  id: "conflict_blocked" | "excluded_scores" | "score_values" | "duplicate_assignments" | "round_snapshots";
  label: string;
  status: "pass" | "attention";
  count: number;
  notice: string;
  items: readonly IntegrityItem[];
}
export interface IntegrityReport {
  roundId: EntityId;
  status: "pass" | "attention";
  checks: readonly IntegrityCheck[];
  notice: string;
}

const MAX_ITEMS = 50;
const scoreOf = (scores: readonly ManualScore[], assignmentId: EntityId): ManualScore | undefined =>
  scores.find(score => score.assignmentId === assignmentId && score.state === "submitted");

/**
 * @param assignments 数据库里的指派原样（未经最新核查修正）
 * @param effective 服务层按当前关联核查结论修正后的指派（与 aggregate() 的输入一致）
 */
export function integrity(
  round: JudgingRound,
  receipts: readonly IntakeReceipt[],
  assignments: readonly JudgeAssignment[],
  effective: readonly JudgeAssignment[],
  scores: readonly ManualScore[],
): IntegrityReport {
  const inRound = assignments.filter(item => item.roundId === round.id);
  // 服务层按最新关联核查修正的是**同一个指派对象**（id 不变、状态可能变成 recused/needs_review），
  // 所以"是否仍有效"必须比较状态，而不能用 id 是否出现在 effective 里来判断。
  const effectiveStatus = new Map(effective.map(item => [item.id, `${item.status}:${item.declaration}`]));
  const isEffective = (item: JudgeAssignment): boolean => effectiveStatus.get(item.id) === "active:clear";
  const check = (value: Omit<IntegrityCheck, "status"> & { status?: IntegrityCheck["status"] }): IntegrityCheck =>
    ({ ...value, status: value.status ?? (value.count ? "attention" : "pass") });

  // 1. 存储里仍是有效指派，但按最新关联核查已被阻断：这些评分不会进入汇总，需要主办方处理指派本身。
  const blocked = inRound.filter(item => item.status === "active" && item.declaration === "clear" && !isEffective(item));
  const conflictBlocked = check({ id: "conflict_blocked", label: "最新核查后仍为有效但已阻断的指派", count: blocked.length,
    notice: blocked.length ? "这些指派在关联核查后不再可读，评分不会进入汇总；请核查关系或撤销/重新指派。" : "没有发现需要处理的阻断指派。",
    items: blocked.map(item => ({ assignmentId: item.id, snapshotId: item.snapshotId, judgeUserId: item.judgeUserId, detail: "最新关联核查结论不是 clear" })) });

  // 2. 已被排除的评分：应当不计入，自检把它们列出来作为"边界确实生效"的证据。
  const excluded = inRound.filter(item => !isEffective(item) && !!scoreOf(scores, item.id));
  const excludedScores = check({ id: "excluded_scores", label: "已排除、未计入汇总的评分", count: excluded.length, status: "pass",
    notice: excluded.length ? "这些评分因为指派被回避、待核查或撤销而没有计入汇总；这是预期行为，仅供核对。" : "没有被排除的评分。",
    items: excluded.map(item => ({ assignmentId: item.id, snapshotId: item.snapshotId, judgeUserId: item.judgeUserId, detail: `指派状态 ${effectiveStatus.get(item.id) ?? `${item.status}:${item.declaration}`}` })) });

  // 3. 分数必须落在冻结标准之内，且不出现未知维度或非整数。
  const invalid: IntegrityItem[] = [];
  for (const assignment of effective) {
    const score = scoreOf(scores, assignment.id); if (!score) continue;
    const keys = Object.keys(score.values);
    if (keys.length !== round.config.criteria.length) invalid.push({ assignmentId: assignment.id, judgeUserId: assignment.judgeUserId, detail: `评分数与冻结维度数不一致（${keys.length}/${round.config.criteria.length}）` });
    for (const key of keys) {
      const criterion = round.config.criteria.find(item => item.id === key);
      if (!criterion) { invalid.push({ assignmentId: assignment.id, judgeUserId: assignment.judgeUserId, detail: `出现冻结标准之外的维度 ${key}` }); continue; }
      const value = score.values[key]!;
      if (!Number.isInteger(value) || value < criterion.min || value > criterion.max) invalid.push({ assignmentId: assignment.id, judgeUserId: assignment.judgeUserId, detail: `维度 ${criterion.label} 的分数 ${value} 超出 ${criterion.min}–${criterion.max}` });
    }
  }
  const scoreValues = check({ id: "score_values", label: "分数是否落在冻结标准内", count: invalid.length,
    notice: invalid.length ? "有评分不符合本轮回溯冻结的整数范围或维度；请人工核对来源后纠正。" : `全部有效评分都落在 ${round.config.criteria.length} 个冻结维度与范围内。`, items: invalid });

  // 4. 同一评委对同一作品出现多条有效指派会造成同一意见被重复计入。
  const seen = new Map<string, JudgeAssignment[]>();
  for (const assignment of effective) {
    const key = `${assignment.snapshotId}:${assignment.judgeUserId}`;
    seen.set(key, [...(seen.get(key) ?? []), assignment]);
  }
  const duplicates = [...seen.entries()].filter(([, list]) => list.length > 1);
  const duplicateAssignments = check({ id: "duplicate_assignments", label: "同一评委对同一作品的有效指派是否唯一", count: duplicates.length,
    notice: duplicates.length ? "同一评委对同一作品存在多条有效指派，评分会被重复计入；请撤销多余指派。" : "每位评委对每件作品只有一条有效指派。",
    items: duplicates.map(([key, list]) => ({ snapshotId: list[0]!.snapshotId, judgeUserId: list[0]!.judgeUserId, assignmentId: list[0]!.id, detail: `${key} 有 ${list.length} 条有效指派` })) });

  // 5. 本轮冻结的作品名单必须都能找到正式收件材料。
  const missing = round.snapshotIds.filter(snapshotId => !receipts.some(receipt => receipt.id === snapshotId));
  const roundSnapshots = check({ id: "round_snapshots", label: "本轮作品名单与正式收件材料一致", count: missing.length,
    notice: missing.length ? "本轮冻结名单里有作品找不到正式收件材料，汇总会中断；请核对收件记录。" : "本轮冻结的每件作品都有正式收件材料。",
    items: missing.map(snapshotId => ({ snapshotId, detail: "缺少对应的正式收件材料" })) });

  const checks = [conflictBlocked, excludedScores, scoreValues, duplicateAssignments, roundSnapshots]
    .map(item => ({ ...item, items: item.items.slice(0, MAX_ITEMS) }));
  const attention = checks.filter(item => item.status === "attention");
  return { roundId: round.id, status: attention.length ? "attention" : "pass", checks,
    notice: attention.length
      ? `自检发现 ${attention.length} 项需要人工处理：${attention.map(item => item.label).join("；")}。自检只报告边界结论，不改变任何评分、指派或公布。`
      : "自检通过：回避与撤销的评分未进入汇总，分数都在冻结标准内，指派与作品名单一致。自检不改变任何事实。" };
}
