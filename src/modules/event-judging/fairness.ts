import type { IntakeReceipt, JudgeAssignment, JudgingRound, ManualScore, PublishedResults } from "./model.ts";

/**
 * 公开公平规则包 ＋ 需要人工确认的扣分建议。
 *
 * 依据：竞品把扣分规则**公开写死**（CraftStadium 公开页原文：Base = Judge×0.75 + Peer×0.25，
 * 迟交按 `<5→0% / 5–10→5% / 11–20→10% / 21–30→20% / ≥31 取消资格` 阶梯扣分，REA 逐字核对）。
 * 我们吸收它的**"事先公开、可预期"**，拒绝它的两处：① 不做选手互评；② **不自动扣分**。
 *
 * 因此这里只产出两样东西：
 * 1. **公开规则包**：把本轮已冻结的事实整理成一段可以直接展示给选手的声明（维度与权重、最少评委数、
 *    缺评与同分处理、材料范围、申诉时限、以及哪些评分不计入）。未知的一律写"未提供"，不替主办方补。
 * 2. **扣分/异常建议**：只根据**已有事实**（迟交、材料不完整、缺评）给出建议与依据，
 *    每条都标注 `needsConfirmation`，**系统不会自动改分、也不会自动取消资格**。
 */

export interface FairnessDeclaration { title: string; lines: readonly string[] }
export interface FairnessSuggestion {
  teamId: string; receiptId: string | null; kind: "late_submission" | "incomplete_materials" | "missing_judges";
  fact: string; suggestion: string; needsConfirmation: true;
}
export interface FairnessReport {
  roundId: string; roundTitle: string; roundStatus: JudgingRound["status"];
  declaration: FairnessDeclaration;
  suggestions: readonly FairnessSuggestion[];
  /** 公开规则包是否已经"有主"：主办方是否在比赛规则里写了补充条款，这一项只读取，不修改。 */
  organizerRulesNote: string;
  notice: string;
  limitations: readonly string[];
}

const shortDescription = 200;

export function fairnessReport(input: {
  round: JudgingRound; receipts: readonly IntakeReceipt[]; assignments: readonly JudgeAssignment[];
  scores: readonly ManualScore[]; published: PublishedResults | null; now: string;
}): FairnessReport {
  const { round, receipts, assignments, scores, published } = input;
  const criteria = round.config.criteria;
  const criteriaLines = criteria.map(item => `${item.label}（权重 ${item.weight}，计分区间 ${item.min}–${item.max}）`);
  const countedScores = scores.filter(score => score.state === "submitted");
  const excluded = assignments.filter(item => item.status !== "active" || item.declaration !== "clear");
  const days = round.config.appealWindowDays ?? 7;

  const lines = [
    `评审维度：${criteriaLines.length ? criteriaLines.join("；") : "未提供"}`,
    `最少评委数：${round.config.minJudges} 位`,
    `缺评处理：${round.config.missingPolicy === "block_publication" ? "缺评时暂不公布" : "缺评的作品不参与汇总"}`,
    `同分处理：${round.config.tiePolicy === "shared_rank" ? "并列名次" : "由主办方人工排序"}`,
    `材料范围：作品名称与说明必填，链接最多 12 条、文件元数据最多 12 份，材料合计不超过 24 KB`,
    `不计入汇总的评分：与本作品存在回避关系、已撤销或未完成申报的评委评分不计入（本轮当前有 ${excluded.length} 条这样的指派）`,
    `正式计入的评分：已提交状态的评分共 ${countedScores.length} 条`,
    `结果申诉：结果公布后 ${days} 天内可以在赛事页面提交申诉；申诉只记录说明，不自动改分`,
    `结果更正：如需更正分数，主办方会按"撤回 → 重新开放 → 补评 → 重新核定 → 重新公布"处理`,
  ];

  const suggestions: FairnessSuggestion[] = [];
  for (const receipt of receipts) {
    const late = Date.parse(receipt.submittedAt) > Date.parse(receipt.submissionClosesAt);
    if (late) suggestions.push({ teamId: receipt.teamId, receiptId: receipt.id, kind: "late_submission",
      fact: `正式收件时间 ${receipt.submittedAt} 晚于作品截止 ${receipt.submissionClosesAt}`,
      suggestion: "请依据你事先公布的迟到规则决定是否处理；系统不会自动扣分或取消资格。", needsConfirmation: true });
    const materials = receipt.materials;
    const thin = !materials.links.length || materials.description.trim().length < 40;
    if (thin) suggestions.push({ teamId: receipt.teamId, receiptId: receipt.id, kind: "incomplete_materials",
      fact: !materials.links.length ? "材料里没有可访问的作品链接" : `作品说明较短（${materials.description.trim().length} 字）`,
      suggestion: "可以先按公开规则要求队伍补交说明；补交会产生新版本，历史版本保留。", needsConfirmation: true });
  }
  for (const row of published?.rows ?? []) {
    if (row.missingJudges > 0) suggestions.push({ teamId: row.teamId, receiptId: row.snapshotId, kind: "missing_judges",
      fact: `公布结果里该作品有 ${row.missingJudges} 位评委未提交评分（已提交 ${row.submittedJudgeCount} 位）`,
      suggestion: "可以补派评委重新开放本轮后再重新核对公布；是否处理由你决定。", needsConfirmation: true });
  }

  const order = { late_submission: 0, missing_judges: 1, incomplete_materials: 2 } as const;
  const sorted = [...suggestions].sort((left, right) => order[left.kind] - order[right.kind]
    || left.teamId.localeCompare(right.teamId) || (left.receiptId ?? "").localeCompare(right.receiptId ?? ""));

  return { roundId: round.id, roundTitle: round.config.title, roundStatus: round.status,
    declaration: { title: `${round.config.title} · 评审与公平规则`, lines },
    suggestions: sorted,
    organizerRulesNote: "比赛规则正文由主办方在赛事设置里维护；这里不修改它，只把本轮评审事实整理成可直接展示的说明。",
    notice: `公开规则包已按本轮冻结配置生成（${lines.length} 条）。另有 ${sorted.length} 条待你人工确认的处理建议。`,
    limitations: [
      "这里只做派生整理：不改变分数、名次、公布或任何队伍的材料。",
      "扣分与取消资格属于主办方裁量，必须由你确认后按公开规则处理；系统不会自动执行。",
      "未填写的规则（例如你的补充条款）会显示为“未提供”，不会被自动补全。",
      "本包不包含选手互评：我们不做互评，也不把互评结果计入名次。",
    ] };
}

export function fairnessLinePreview(report: FairnessReport, limit = shortDescription * 6): string {
  const text = `${report.declaration.title}\n${report.declaration.lines.map(line => `· ${line}`).join("\n")}`;
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
