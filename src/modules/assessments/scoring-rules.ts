import { DomainError } from "../../shared/errors.ts";
import { validateQuestionCatalog, validateRubric } from "./catalog.ts";
import type { AssessmentAttempt, AssessmentScore, CriterionScore, DimensionResult, RubricVersion, TaskDimension } from "./types.ts";

export const SCORE_MEANING = "每项得分是本次固定题组与量规行为锚点对应的整数分，仅说明当前任务中已有证据的表现。维度点数是已评分项的锚点整数分按固定量规权重加总，可得点数是同一批已评分项满分按相同权重加总；证据不足或不适用项不纳入这两项合计，证据不足不表示零能力，未覆盖能力另列。当前未经科学校准，不换算能力百分比、任务匹配度或成功概率，不生成能力排名。";
const DIMENSIONS: readonly TaskDimension[] = ["requirements", "design", "development", "testing", "documentation", "presentation"];

export interface ValidatedScoringOutput {
  readonly rubricVersionId: string;
  readonly criterionScores: readonly CriterionScore[];
  readonly limitations: readonly string[];
  readonly modelVersion: string;
  readonly promptVersion: string;
}

function invalid(message: string): never {
  throw new DomainError("INVALID_SCORING_OUTPUT", message, { recoveryAction: "retry_or_request_review" });
}

function record(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label}必须是对象。`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label}必须是普通对象。`);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))) invalid(`${label}包含不支持的字段。`);
  if (fields.some((key) => !Object.hasOwn(value, key))) invalid(`${label}缺少必要字段。`);
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => descriptor.get || descriptor.set)) invalid(`${label}不能含动态属性。`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) invalid(`${label}不能为空或过长。`);
  return value.trim();
}

function list(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(`${label}数量不正确。`);
  if (Object.getPrototypeOf(value) !== Array.prototype) invalid(`${label}必须是普通数组。`);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9]\d*)$/.test(key)))) invalid(`${label}包含不支持的字段。`);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.get || descriptor.set) invalid(`${label}不能包含空缺或动态项目。`);
  }
  return value;
}

function texts(value: unknown, label: string, maximum: number, itemMaximum: number): readonly string[] {
  const result = list(value, label, maximum).map((entry) => text(entry, label, itemMaximum));
  if (new Set(result).size !== result.length) invalid(`${label}不能重复。`);
  return result;
}

function criterionScores(value: unknown, rubric: RubricVersion): readonly CriterionScore[] {
  const knownCriteria = new Map(rubric.criteria.map((criterion) => [criterion.id, criterion]));
  const scores = list(value, "评分项", 100).map((entry) => {
    const data = record(entry, ["criterionId", "state", "score", "evidenceRefs", "reason", "unverified"], "评分项");
    const criterionId = text(data.criterionId, "评分项 ID", 200);
    const criterion = knownCriteria.get(criterionId);
    if (!criterion) invalid("评分必须引用本次量规中的评分项。");
    if (!["scored", "insufficient_evidence", "not_applicable"].includes(data.state as string)) invalid("评分项状态不支持。");
    const state = data.state as CriterionScore["state"];
    if (state === "scored") {
      if (!Number.isSafeInteger(data.score) || (data.score as number) < 0 || (data.score as number) > criterion.maxScore) invalid("得分必须是量规范围内的整数。");
    } else if (data.score !== null) invalid("证据不足和不适用项必须保留空得分，不能补为零分。");
    const evidenceRefs = texts(data.evidenceRefs, "证据引用", 100, 200);
    if (state === "scored" && evidenceRefs.length === 0) invalid("已评分项必须提供本次回答中的证据依据。");
    return {
      criterionId,
      state,
      score: data.score as number | null,
      evidenceRefs,
      reason: text(data.reason, "评分理由", 4000),
      unverified: texts(data.unverified, "未验证项", 30, 2000),
    };
  });
  if (new Set(scores.map((score) => score.criterionId)).size !== scores.length) invalid("评分项不能重复。");
  if (scores.length !== knownCriteria.size) invalid("必须完整返回本次量规的所有评分项，未测项目应明确标为证据不足或不适用。");
  // Return fixed rubric order so provider order cannot change the report layout or result comparison.
  const byId = new Map(scores.map((score) => [score.criterionId, score]));
  return rubric.criteria.map((criterion) => byId.get(criterion.id)!);
}

/** The provider controls no publication or provenance fields. The service attaches those after validation. */
export function validateScoringOutput(output: unknown, attempt: AssessmentAttempt): ValidatedScoringOutput {
  validateQuestionCatalog(attempt.questionSetSnapshot, attempt.rubricSnapshot);
  if (attempt.questionSetId !== attempt.questionSetSnapshot.id || attempt.rubricVersionId !== attempt.rubricSnapshot.id) invalid("测评快照与固定版本引用不一致。");
  const data = record(output, ["rubricVersionId", "criterionScores", "limitations", "modelVersion", "promptVersion"], "评分输出");
  const rubricVersionId = text(data.rubricVersionId, "量规版本 ID", 200);
  if (rubricVersionId !== attempt.rubricVersionId) invalid("评分输出的量规版本与本次测评不一致。");
  const scores = criterionScores(data.criterionScores, attempt.rubricSnapshot);
  const evidenceByCriterion = new Map(attempt.rubricSnapshot.criteria.map((criterion) => [criterion.id, new Set<string>()]));
  const questionById = new Map(attempt.questionSetSnapshot.questions.map((question) => [question.id, question]));
  const allRefs = new Set<string>();
  const addRef = (ref: string, ids: readonly string[]): void => {
    if (allRefs.has(ref)) invalid("本次回答中的证据引用存在歧义。");
    allRefs.add(ref);
    ids.forEach((id) => evidenceByCriterion.get(id)!.add(ref));
  };
  for (const answer of attempt.answers) {
    const question = questionById.get(answer.questionId);
    if (!question) invalid("回答引用的题目不属于本次测评。");
    if (answer.text.trim()) addRef(answer.questionId, question.criterionIds);
    for (const evidence of answer.evidence) {
      if (!evidence.text.trim()) invalid("回答证据缺少说明。");
      addRef(evidence.id, question.criterionIds);
    }
  }
  for (const followUp of attempt.followUps) {
    const question = questionById.get(followUp.questionId);
    if (!question || !question.criterionIds.includes(followUp.criterionId)) invalid("追问必须绑定原题的评分项。");
    if (followUp.answer?.trim()) addRef(followUp.id, [followUp.criterionId]);
  }
  for (const score of scores) {
    if (score.evidenceRefs.some((ref) => !evidenceByCriterion.get(score.criterionId)!.has(ref))) invalid("评分引用了不存在、未回答或与此评分项无关的证据。");
  }
  return {
    rubricVersionId,
    criterionScores: scores,
    limitations: texts(data.limitations, "评分限制", 30, 2000),
    modelVersion: text(data.modelVersion, "模型版本", 200),
    promptVersion: text(data.promptVersion, "提示版本", 200),
  };
}

/** Weighted anchor points describe evidence under this fixed rubric; no percentage, match rate or ranking is derived. */
export function calculateDimensionResults(score: Pick<AssessmentScore, "rubricVersionId" | "criterionScores">, rubric: RubricVersion): readonly DimensionResult[] {
  validateRubric(rubric);
  if (score.rubricVersionId !== rubric.id) invalid("得分与量规版本不一致，不能合并计算。");
  const scores = new Map(criterionScores(score.criterionScores, rubric).map((entry) => [entry.criterionId, entry]));
  return DIMENSIONS.map((dimension) => {
    let earned = 0;
    let possible = 0;
    const unscoredCriterionIds: string[] = [];
    for (const criterion of rubric.criteria.filter((entry) => entry.dimension === dimension)) {
      const criterionScore = scores.get(criterion.id)!;
      if (criterionScore.state !== "scored") { unscoredCriterionIds.push(criterion.id); continue; }
      earned += criterionScore.score! * criterion.weight;
      possible += criterion.maxScore * criterion.weight;
    }
    return { dimension, earned, possible, unscoredCriterionIds };
  });
}
