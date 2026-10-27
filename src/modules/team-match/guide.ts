import type { RecruitingRole } from "../recruiting/index.ts";
import { canonicalRoles } from "./matching.ts";
import {
  teamMatchRoleLabels,
  type TeamMatchCandidate,
  type TeamMatchDegradedReason,
  type TeamMatchExplainModel,
  type TeamMatchExplanation,
  type TeamMatchExplanationFacts,
} from "./model.ts";

/**
 * 可选的 1–2 句解释。
 *
 * 纪律：
 * - 只允许引用 `facts` 里真实存在的字段（职责、技能、城市、是否同城）；不读简历、年龄、MBTI、头像或联系方式。
 * - 模型未注入、调用失败、或输出包含 facts 之外的事实/评分/排名/百分比时，**一律退回模板句**并标 `degraded: true`。
 * - 模板句与模型句都不出现"最佳匹配""匹配度""推荐指数"等措辞。
 *
 * 已知边界：中文自由文本无法做到完备的事实验证。这里校验 ASCII 技能名、引号内术语、"会/擅长/熟悉…"后的
 * 断言，以及评分/排名/年龄等禁用词；仍可能漏掉高度口语化的中文虚构。因此根适配必须使用禁工具、低温模型，
 * 并把解释标为「AI 拟句」，不把它当作事实来源。
 */

export const teamMatchExplanationInstruction = [
  "你在为黑客松的组队大厅写一段中性的候选人说明。",
  "只使用提供的事实：职责、技能、城市、是否同城。不得补充、推断或编造任何技能、经历、性格、年龄、MBTI、头像或联系方式。",
  "写 1 到 2 句中文，平实陈述；不评分、不给匹配度或百分比、不排名、不写「最佳」「最适合」或推荐结论，也不承诺获奖、录用或加入结果。",
  "不要使用 Markdown、列表或换行。",
].join("\n");

const normalizeFacts = (facts: TeamMatchExplanationFacts): TeamMatchExplanationFacts => ({
  displayName: facts.displayName.trim(),
  roles: canonicalRoles(facts.roles),
  skills: [...new Set(facts.skills.map(skill => skill.trim()).filter(Boolean))],
  city: facts.city.trim(),
  sameCity: facts.sameCity === true,
  ...(facts.postTitle?.trim() ? { postTitle: facts.postTitle.trim() } : {}),
});

const roleText = (roles: readonly RecruitingRole[]): string => roles.map(role => teamMatchRoleLabels[role]).join("、");

/** 固定模板句：模型不可用时的唯一退路；只引用传入的事实。 */
export function templateExplanation(factsInput: TeamMatchExplanationFacts): string {
  const facts = normalizeFacts(factsInput);
  const roles = roleText(facts.roles);
  const first = facts.roles.length
    ? `${facts.postTitle ? `就「${facts.postTitle}」的职责缺口，` : ""}${facts.displayName}的名片把「${roles}」列为可补上的职责。`
    : `${facts.displayName}的名片还没有声明能补上的职责。`;
  const details: string[] = [];
  if (facts.skills.length) details.push(`名片里写的技能是 ${facts.skills.join("、")}`);
  if (facts.sameCity && facts.city) details.push(`城市和你相同（${facts.city}）`);
  else if (facts.city) details.push(`城市写的是 ${facts.city}`);
  return first + (details.length ? `${details.join("；")}。` : "");
}

/** 把候选人投影收敛成解释允许引用的事实；不把名片里的其他字段带进来。 */
export function explanationFacts(input: { candidate: TeamMatchCandidate; postTitle?: string }): TeamMatchExplanationFacts {
  const { candidate } = input;
  const roles = candidate.coveringRoles.length
    ? candidate.coveringRoles
    : [...candidate.primaryRoles, ...candidate.supportingRoles];
  return {
    displayName: candidate.displayName,
    roles,
    skills: candidate.skills,
    city: candidate.city,
    sameCity: candidate.sameCity,
    ...(input.postTitle ? { postTitle: input.postTitle } : {}),
  };
}

const factStrings = (facts: TeamMatchExplanationFacts): string[] => [
  facts.displayName,
  facts.city,
  facts.postTitle ?? "",
  ...facts.roles.map(role => teamMatchRoleLabels[role]),
  ...facts.skills,
].filter(Boolean);

/** 词/短语是否完全由事实里的字符串组成（允许用"和/与/、/，"连接多个事实）。 */
const backedText = (text: string, allowed: readonly string[]): boolean => {
  const pieces = text.split(/[和与、,，/]/).map(piece => piece.trim()).filter(Boolean);
  return pieces.length > 0 && pieces.every(piece => allowed.some(item => item.includes(piece)));
};

const forbidden = /(?:最佳|最适合|最匹配|最合适|匹配|适合|合适|推荐|优先|值得|得分|评分|排名|名次|成功率|百分比|%|年龄|MBTI|头像|外貌|性别|联系方式|邮箱|电话|微信|简历)/i;
const asciiToken = /[A-Za-z][A-Za-z0-9+#.\-]*/g;
const markdown = /[*`>\[\]{}]/;

type Validation = { ok: true; text: string } | { ok: false };

const reject = (): Validation => ({ ok: false });

function validateModelText(raw: string, facts: TeamMatchExplanationFacts): Validation {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || text.length > 240) return reject();
  if (forbidden.test(text) || markdown.test(text)) return reject();

  const sentences = text.split(/[。！？!?]+/).map(sentence => sentence.trim()).filter(Boolean);
  if (sentences.length < 1 || sentences.length > 2) return reject();

  const allowed = factStrings(facts);
  const allowedAscii = new Set<string>();
  for (const value of allowed) {
    for (const token of value.match(asciiToken) ?? []) {
      if (token.length > 1) allowedAscii.add(token.toLowerCase());
    }
  }
  for (const token of text.match(asciiToken) ?? []) {
    if (token.length > 1 && !allowedAscii.has(token.toLowerCase())) return reject();
  }

  for (const match of text.matchAll(/[「“"《]([^」”"》]{1,40})[」”"》]/g)) {
    if (!backedText(match[1]!.trim(), allowed)) return reject();
  }

  for (const match of text.matchAll(/(?<![机社不])会([^，。；、,.;！？\s「」“”"']{1,12})/g)) {
    if (!backedText(match[1]!.trim(), allowed)) return reject();
  }
  for (const match of text.matchAll(/(?:擅长|精通|熟悉|掌握|做过|用过)([^，。；、,.;！？\s「」“”"']{1,12})/g)) {
    if (!backedText(match[1]!.trim(), allowed)) return reject();
  }
  for (const match of text.matchAll(/有([^，。；、,.;！？\s]{1,12})经验/g)) {
    if (!backedText(match[1]!.trim(), allowed)) return reject();
  }

  // 只重复姓名不算"给了理由"：至少要提到职责、技能、城市或招募贴标题中的一项。
  const substance = [
    facts.city,
    facts.postTitle ?? "",
    ...facts.roles.map(role => teamMatchRoleLabels[role]),
    ...facts.skills,
  ].filter(Boolean);
  const mentionsFact = substance.some(item => text.includes(item))
    || (facts.sameCity && /同城|城市相同/.test(text));
  if (!mentionsFact) return reject();

  return { ok: true, text: /[。！？!?]$/.test(text) ? text : `${text}。` };
}

const templateResult = (facts: TeamMatchExplanationFacts, reason: TeamMatchDegradedReason): TeamMatchExplanation => ({
  text: templateExplanation(facts),
  degraded: true,
  source: "template",
  degradedReason: reason,
});

/**
 * 生成 1–2 句解释。模型是可选依赖：
 * - 未注入 → 模板句 + `degraded: true`；
 * - 抛错 → 模板句 + `degraded: true`；
 * - 输出越界（编造技能/评分/排名/百分比/年龄等）→ 模板句 + `degraded: true`，绝不透传。
 */
export async function explainCandidate(input: {
  model?: TeamMatchExplainModel | null;
  facts: TeamMatchExplanationFacts;
}): Promise<TeamMatchExplanation> {
  const facts = normalizeFacts(input.facts);
  if (!input.model) return templateResult(facts, "model_not_injected");

  let raw: string;
  try {
    raw = await input.model.explain({ instruction: teamMatchExplanationInstruction, facts });
  } catch {
    return templateResult(facts, "model_failed");
  }

  if (typeof raw !== "string") return templateResult(facts, "model_failed");
  const validation = validateModelText(raw, facts);
  if (!validation.ok) return templateResult(facts, "model_output_rejected");
  return { text: validation.text, degraded: false, source: "model", degradedReason: null };
}
