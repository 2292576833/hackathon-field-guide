import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import { FixedQuestionCatalog, PILOT_QUESTION_SET, PILOT_RUBRIC, validateQuestionCatalog } from "./catalog.ts";
import { calculateDimensionResults, SCORE_MEANING, validateScoringOutput } from "./scoring-rules.ts";
import type { AssessmentAttempt, QuestionSet, RubricVersion } from "./types.ts";

/** Published content here is an explicit test configuration; no actual human review is claimed. */
function fixture() {
  const rubric = {
    id: "rubric_test_v1",
    version: 1,
    missingEvidencePolicy: "exclude_from_denominator" as const,
    limitations: ["仅测试配置，尚未校准。"],
    criteria: [
      { id: "scope", dimension: "requirements" as const, label: "范围", weight: 1, maxScore: 3, anchors: ["无关", "目标", "范围", "验证"] },
      { id: "debug", dimension: "development" as const, label: "调试", weight: 2, maxScore: 3, anchors: ["无关", "尝试", "步骤", "复现"] },
      { id: "verify", dimension: "development" as const, label: "验证", weight: 1, maxScore: 3, anchors: ["无关", "意识", "步骤", "异常"] },
      { id: "delivery", dimension: "testing" as const, label: "交付", weight: 1, maxScore: 3, anchors: ["无关", "清单", "条件", "异常"] },
    ],
  } satisfies RubricVersion;
  const set = {
    id: "set_test_v1",
    version: 1,
    rubricVersionId: rubric.id,
    status: "published" as const,
    difficultyLabel: "测试任务",
    allowedTools: ["编辑器"],
    maxFollowUps: 3,
    limitations: ["仅测试发布状态，不表示真实审核。"],
    questions: [
      { id: "q_scope", taskTemplateId: "scope_v1", prompt: "描述最小范围", criterionIds: ["scope"], required: true },
      { id: "q_development", taskTemplateId: "debug_v1", prompt: "描述排查与验证", criterionIds: ["debug", "verify"], required: false },
      { id: "q_delivery", taskTemplateId: "delivery_v1", prompt: "描述交付检查", criterionIds: ["delivery"], required: false },
    ],
  } satisfies QuestionSet;
  const attempt: AssessmentAttempt = {
    id: "attempt_1", projectId: "project_1", membershipId: "pm_1", userId: "user_1",
    questionSetId: set.id, rubricVersionId: rubric.id, questionSetSnapshot: set, rubricSnapshot: rubric,
    profile: { experience: "", tools: [], preferredTasks: [], memberAvailabilityVersionId: null },
    answers: [
      { questionId: "q_scope", text: "先交主流程，补充检查步骤。", aiUsage: "未使用", evidence: [{ id: "scope_sample", kind: "self_report", text: "最小范围清单", url: null }] },
      { questionId: "q_development", text: "重现后逐步定位并检查预期。", aiUsage: "辅助解释报错", evidence: [{ id: "debug_steps", kind: "verification_steps", text: "可重复检查步骤", url: null }] },
    ],
    followUps: [{ id: "follow_verify", questionId: "q_development", criterionId: "verify", prompt: "怎样检查异常？", answer: "检查失败响应和恢复操作。" }],
    sharing: { confirmedTasks: [], criterionIds: [] }, status: "scoring", revision: 3,
    latestScoreId: null, activeJobId: "job_1", scoringRuns: 1,
    createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z", submittedAt: "2026-10-08T00:00:00.000Z",
  };
  const output = {
    rubricVersionId: rubric.id,
    criterionScores: [
      { criterionId: "scope", state: "scored", score: 2, evidenceRefs: ["q_scope", "scope_sample"], reason: "已描述范围。", unverified: ["实际交付尚未核对。"] },
      { criterionId: "debug", state: "scored", score: 1, evidenceRefs: ["debug_steps"], reason: "有主要尝试。", unverified: [] },
      { criterionId: "verify", state: "scored", score: 3, evidenceRefs: ["follow_verify"], reason: "有步骤与异常恢复。", unverified: [] },
      { criterionId: "delivery", state: "insufficient_evidence", score: null, evidenceRefs: [], reason: "未选择交付检查题。", unverified: ["此项尚无证据。"] },
    ],
    limitations: ["仅本次任务证据，未经真实队伍校准。"], modelVersion: "fixture-model-v1", promptVersion: "fixture-prompt-v1",
  };
  return { rubric, set, attempt, output };
}

function fails(operation: () => unknown, code = "INVALID_SCORING_OUTPUT"): void {
  assert.throws(operation, (error: unknown) => error instanceof DomainError && error.code === code);
}

test("catalog isolates configuration mutations and freezes nested snapshots", async () => {
  const { set, rubric } = fixture();
  const catalog = new FixedQuestionCatalog({ questionSets: [set], rubrics: [rubric] });
  set.questions[0]!.prompt = "被修改的输入";
  rubric.criteria[0]!.anchors[0] = "被修改的锚点";
  rubric.criteria[0]!.weight = 20;
  const storedSet = await catalog.getQuestionSet(set.id);
  const storedRubric = await catalog.getRubric(rubric.id);
  assert.equal(storedSet!.questions[0]!.prompt, "描述最小范围");
  assert.equal(storedRubric!.criteria[0]!.anchors[0], "无关");
  assert.equal(storedRubric!.criteria[0]!.weight, 1);
  assert.ok(Object.isFrozen(storedSet));
  assert.ok(Object.isFrozen(storedSet!.questions));
  assert.ok(Object.isFrozen(storedSet!.questions[0]!.criterionIds));
  assert.ok(Object.isFrozen(storedRubric!.criteria[0]!.anchors));
  assert.equal(Reflect.set(storedSet!.questions[0]!, "prompt", "越界修改"), false);
  assert.equal(await catalog.getQuestionSet("missing"), null);
  assert.equal(await catalog.getRubric("missing"), null);
});

test("pilot stays draft and records incomplete review and calibration", async () => {
  validateQuestionCatalog(PILOT_QUESTION_SET, PILOT_RUBRIC);
  const catalog = new FixedQuestionCatalog({ questionSets: [PILOT_QUESTION_SET], rubrics: [PILOT_RUBRIC] });
  assert.equal((await catalog.getQuestionSet(PILOT_QUESTION_SET.id))!.status, "draft");
  assert.ok(PILOT_QUESTION_SET.limitations.some((value) => value.includes("尚未完成题库审核")));
  assert.ok(PILOT_RUBRIC.limitations.some((value) => value.includes("尚未经过真实队伍校准")));
  assert.equal(PILOT_QUESTION_SET.questions.filter((question) => question.required).length, 1);
});

test("catalog rejects mismatched fixed versions, duplicate ids, and dangling criteria", () => {
  const { set, rubric } = fixture();
  fails(() => validateQuestionCatalog({ ...set, rubricVersionId: "rubric_other" }, rubric), "INVALID_QUESTION_CATALOG");
  fails(() => validateQuestionCatalog({ ...set, questions: [set.questions[0]!, set.questions[0]!] }, rubric), "INVALID_QUESTION_CATALOG");
  fails(() => validateQuestionCatalog({ ...set, questions: set.questions.slice(0, 2) }, rubric), "INVALID_QUESTION_CATALOG");
  fails(() => validateQuestionCatalog({ ...set, questions: [{ ...set.questions[0]!, criterionIds: ["invented"] }] }, rubric), "INVALID_QUESTION_CATALOG");
  fails(() => new FixedQuestionCatalog({ questionSets: [set, set], rubrics: [rubric] }), "INVALID_QUESTION_CATALOG");
  fails(() => new FixedQuestionCatalog({ questionSets: [set], rubrics: [rubric, rubric] }), "INVALID_QUESTION_CATALOG");
});

test("catalog rejects unsupported dimensions, incomplete anchors, invalid weights and follow-up budgets", () => {
  const { set, rubric } = fixture();
  const badRubrics: unknown[] = [
    { ...rubric, criteria: [{ ...rubric.criteria[0]!, dimension: "age" }, ...rubric.criteria.slice(1)] },
    { ...rubric, criteria: [{ ...rubric.criteria[0]!, anchors: ["零分"] }, ...rubric.criteria.slice(1)] },
    { ...rubric, criteria: [{ ...rubric.criteria[0]!, weight: 0 }, ...rubric.criteria.slice(1)] },
    { ...rubric, criteria: [{ ...rubric.criteria[0]!, weight: Number.NaN }, ...rubric.criteria.slice(1)] },
    { ...rubric, criteria: [{ ...rubric.criteria[0]!, maxScore: 2.5 }, ...rubric.criteria.slice(1)] },
    { ...rubric, missingEvidencePolicy: "zero_score" },
  ];
  badRubrics.forEach((entry) => fails(() => validateQuestionCatalog(set, entry as RubricVersion), "INVALID_QUESTION_CATALOG"));
  [-1, 4, 1.5].forEach((maxFollowUps) => fails(() => validateQuestionCatalog({ ...set, maxFollowUps }, rubric), "INVALID_QUESTION_CATALOG"));
});

test("score accepts only actual associated answer, evidence and answered follow-up references", () => {
  const { attempt, output } = fixture();
  const validated = validateScoringOutput(output, attempt);
  assert.equal(validated.criterionScores.length, 4);
  assert.deepEqual(validated.criterionScores[0]!.evidenceRefs, ["q_scope", "scope_sample"]);
  assert.equal(validated.criterionScores[3]!.score, null);
  assert.equal(Object.hasOwn(validated, "provenance"), false);
  output.criterionScores[0]!.reason = "随后修改模型对象";
  (output.criterionScores[0]!.evidenceRefs as string[]).push("fake");
  assert.equal(validated.criterionScores[0]!.reason, "已描述范围。");
  assert.deepEqual(validated.criterionScores[0]!.evidenceRefs, ["q_scope", "scope_sample"]);
});

test("score rejects model-supplied publication, provenance, aggregate, and extra nested fields", () => {
  const { attempt, output } = fixture();
  ["provenance", "status", "overallAbility", "validatedAt"].forEach((key) => fails(() => validateScoringOutput({ ...output, [key]: "invented" }, attempt)));
  fails(() => validateScoringOutput({ ...output, criterionScores: [{ ...output.criterionScores[0]!, humanReviewed: true }, ...output.criterionScores.slice(1)] }, attempt));
  fails(() => validateScoringOutput({ ...output, [Symbol("hidden")]: "fake" }, attempt));
  const withGetter = { ...output };
  Object.defineProperty(withGetter, "modelVersion", { get: () => { throw new Error("getter must never execute"); }, enumerable: true });
  fails(() => validateScoringOutput(withGetter, attempt));
});

test("score rejects unsupported percentage or match-rate fields at every score boundary", () => {
  const { attempt, output } = fixture();
  for (const field of ["percentage", "abilityPercentage", "matchRate"]) {
    fails(() => validateScoringOutput({ ...output, [field]: 75 }, attempt));
    fails(() => validateScoringOutput({ ...output, criterionScores: [{ ...output.criterionScores[0]!, [field]: 75 }, ...output.criterionScores.slice(1)] }, attempt));
  }
});

test("score rejects omitted, duplicate, invented, or mismatched rubric scoring items", () => {
  const { attempt, output } = fixture();
  fails(() => validateScoringOutput({ ...output, rubricVersionId: "rubric_other" }, attempt));
  fails(() => validateScoringOutput({ ...output, criterionScores: output.criterionScores.slice(0, 3) }, attempt));
  fails(() => validateScoringOutput({ ...output, criterionScores: [...output.criterionScores, output.criterionScores[0]!] }, attempt));
  fails(() => validateScoringOutput({ ...output, criterionScores: [{ ...output.criterionScores[0]!, criterionId: "fake" }, ...output.criterionScores.slice(1)] }, attempt));
  fails(() => validateScoringOutput(output, { ...attempt, questionSetId: "other" }));
});

test("score bounds remain integers and zero is scored only with evidence", () => {
  const { attempt, output } = fixture();
  [-1, 4, 2.1, Number.NaN, Number.POSITIVE_INFINITY, "2", null].forEach((score) => {
    fails(() => validateScoringOutput({ ...output, criterionScores: [{ ...output.criterionScores[0]!, score }, ...output.criterionScores.slice(1)] }, attempt));
  });
  assert.equal(validateScoringOutput({ ...output, criterionScores: [{ ...output.criterionScores[0]!, score: 0 }, ...output.criterionScores.slice(1)] }, attempt).criterionScores[0]!.score, 0);
  fails(() => validateScoringOutput({ ...output, criterionScores: [{ ...output.criterionScores[0]!, evidenceRefs: [] }, ...output.criterionScores.slice(1)] }, attempt));
  fails(() => validateScoringOutput({ ...output, criterionScores: [...output.criterionScores.slice(0, 3), { ...output.criterionScores[3]!, score: 0 }] }, attempt));
  const notApplicable = validateScoringOutput({ ...output, criterionScores: [...output.criterionScores.slice(0, 3), { ...output.criterionScores[3]!, state: "not_applicable" }] }, attempt);
  assert.equal(notApplicable.criterionScores[3]!.score, null);
});

test("score rejects invented or cross-question evidence and evidence-free answer references", () => {
  const { attempt, output } = fixture();
  ["invented", "debug_steps", "q_development", "follow_verify", "q_delivery"].forEach((ref) => {
    fails(() => validateScoringOutput({ ...output, criterionScores: [{ ...output.criterionScores[0]!, evidenceRefs: [ref] }, ...output.criterionScores.slice(1)] }, attempt));
  });
  fails(() => validateScoringOutput(output, { ...attempt, answers: [{ ...attempt.answers[0]!, text: "" }, attempt.answers[1]!] }));
  fails(() => validateScoringOutput(output, { ...attempt, followUps: [{ ...attempt.followUps[0]!, answer: null }] }));
  fails(() => validateScoringOutput({ ...output, criterionScores: [output.criterionScores[0]!, { ...output.criterionScores[1]!, evidenceRefs: ["follow_verify"] }, ...output.criterionScores.slice(2)] }, attempt));
});

test("score requires version, rationale, limitation array and unverified fields", () => {
  const { attempt, output } = fixture();
  const { modelVersion: _modelVersion, ...missingModelVersion } = output;
  fails(() => validateScoringOutput(missingModelVersion, attempt));
  fails(() => validateScoringOutput({ ...output, promptVersion: " " }, attempt));
  fails(() => validateScoringOutput({ ...output, limitations: "无" }, attempt));
  fails(() => validateScoringOutput({ ...output, criterionScores: [{ ...output.criterionScores[0]!, reason: " " }, ...output.criterionScores.slice(1)] }, attempt));
  fails(() => validateScoringOutput({ ...output, criterionScores: [{ ...output.criterionScores[0]!, unverified: null }, ...output.criterionScores.slice(1)] }, attempt));
  const sparse = new Array(output.criterionScores.length);
  fails(() => validateScoringOutput({ ...output, criterionScores: sparse }, attempt));
});

test("dimension results retain weighted anchor points without percentages or an aggregate", () => {
  const { attempt, output, rubric } = fixture();
  const score = validateScoringOutput(output, attempt);
  const results = calculateDimensionResults(score, rubric);
  assert.equal(results.length, 6);
  assert.deepEqual(results.find((result) => result.dimension === "development"), { dimension: "development", earned: 5, possible: 9, unscoredCriterionIds: [] });
  assert.deepEqual(results.find((result) => result.dimension === "testing"), { dimension: "testing", earned: 0, possible: 0, unscoredCriterionIds: ["delivery"] });
  assert.deepEqual(results.find((result) => result.dimension === "design"), { dimension: "design", earned: 0, possible: 0, unscoredCriterionIds: [] });
  assert.ok(results.every((result) => !Object.hasOwn(result, "percentage") && !Object.hasOwn(result, "matchRate")));
  assert.ok(SCORE_MEANING.includes("未覆盖能力另列"));
  assert.ok(SCORE_MEANING.includes("行为锚点对应的整数分"));
  assert.ok(SCORE_MEANING.includes("按固定量规权重加总"));
  assert.ok(SCORE_MEANING.includes("未经科学校准"));
  assert.ok(SCORE_MEANING.includes("不换算能力百分比"));
  assert.ok(SCORE_MEANING.includes("不生成能力排名"));
  fails(() => calculateDimensionResults({ ...score, rubricVersionId: "other" }, rubric));
});

test("missing evidence is excluded rather than converted to capability zero", () => {
  const { attempt, output, rubric } = fixture();
  const scores = output.criterionScores.map((entry) => entry.criterionId === "verify" ? { ...entry, state: "insufficient_evidence", score: null, evidenceRefs: [], reason: "未验证。" } : entry);
  const result = calculateDimensionResults(validateScoringOutput({ ...output, criterionScores: scores }, attempt), rubric).find((entry) => entry.dimension === "development");
  assert.deepEqual(result, { dimension: "development", earned: 2, possible: 6, unscoredCriterionIds: ["verify"] });
  assert.ok(SCORE_MEANING.includes("证据不足不表示零能力"));
});
