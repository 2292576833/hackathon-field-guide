import { DomainError } from "../../shared/errors.ts";
import type { QuestionCatalogPort } from "./ports.ts";
import type { QuestionSet, RubricVersion, TaskDimension } from "./types.ts";

const DIMENSIONS: readonly TaskDimension[] = ["requirements", "design", "development", "testing", "documentation", "presentation"];
const SET_FIELDS = ["id", "version", "rubricVersionId", "status", "difficultyLabel", "allowedTools", "questions", "maxFollowUps", "limitations"];
const RUBRIC_FIELDS = ["id", "version", "criteria", "missingEvidencePolicy", "limitations"];

function invalid(message: string): never {
  throw new DomainError("INVALID_QUESTION_CATALOG", message);
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

function text(value: unknown, label: string, maximum = 10000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) invalid(`${label}不能为空或过长。`);
  return value;
}

function id(value: unknown, label: string): string {
  const result = text(value, label, 200);
  if (result !== result.trim()) invalid(`${label}不能包含首尾空白。`);
  return result;
}

function list(value: unknown, label: string, maximum: number, minimum = 0): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalid(`${label}数量不正确。`);
  if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9]\d*)$/.test(key)))) invalid(`${label}必须是普通数组。`);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.get || descriptor.set) invalid(`${label}不能包含空缺或动态项目。`);
  }
  return value;
}

function texts(value: unknown, label: string, maximum: number, itemMaximum = 2000): readonly string[] {
  const result = list(value, label, maximum).map((entry) => text(entry, label, itemMaximum));
  if (new Set(result).size !== result.length) invalid(`${label}不能重复。`);
  return result;
}

function positiveVersion(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(`${label}必须是正整数。`);
}

/** Validates each anchored score and its explicit dimension; no aggregate capability score is defined. */
export function validateRubric(rubric: RubricVersion): void {
  const data = record(rubric, RUBRIC_FIELDS, "评分量规");
  id(data.id, "量规 ID");
  positiveVersion(data.version, "量规版本");
  if (data.missingEvidencePolicy !== "exclude_from_denominator") invalid("证据不足项必须从得分分母中排除。");
  texts(data.limitations, "量规限制", 30);
  const criterionIds = new Set<string>();
  for (const entry of list(data.criteria, "评分项", 100, 1)) {
    const criterion = record(entry, ["id", "dimension", "label", "weight", "maxScore", "anchors"], "评分项");
    const criterionId = id(criterion.id, "评分项 ID");
    if (criterionIds.has(criterionId)) invalid("评分项 ID 不能重复。");
    criterionIds.add(criterionId);
    if (!DIMENSIONS.includes(criterion.dimension as TaskDimension)) invalid("评分项包含未知任务维度。");
    text(criterion.label, "评分项名称", 300);
    if (typeof criterion.weight !== "number" || !Number.isFinite(criterion.weight) || criterion.weight <= 0 || criterion.weight > 1000000) invalid("评分项权重必须是有限的正数。");
    if (!Number.isSafeInteger(criterion.maxScore) || (criterion.maxScore as number) < 1 || (criterion.maxScore as number) > 100) invalid("评分项可得分必须是 1 至 100 的整数。");
    const anchors = texts(criterion.anchors, "行为锚点", 101);
    if (anchors.length !== (criterion.maxScore as number) + 1) invalid("每个从零到满分的整数分值都需要独立行为锚点。");
  }
}

/** A published set is accepted only when explicitly configured; this function never changes review status. */
export function validateQuestionCatalog(set: QuestionSet, rubric: RubricVersion): void {
  validateRubric(rubric);
  const data = record(set, SET_FIELDS, "题组");
  id(data.id, "题组 ID");
  positiveVersion(data.version, "题组版本");
  if (id(data.rubricVersionId, "题组量规 ID") !== rubric.id) invalid("题组必须绑定所提供的固定量规版本。");
  if (!["draft", "reviewed", "published", "retired"].includes(data.status as string)) invalid("题组状态不支持。");
  text(data.difficultyLabel, "任务难度说明", 300);
  texts(data.allowedTools, "允许工具", 30, 300);
  texts(data.limitations, "题组限制", 30);
  // Three is the initial operational ceiling, a pilot parameter rather than a calibrated test length.
  if (!Number.isSafeInteger(data.maxFollowUps) || (data.maxFollowUps as number) < 0 || (data.maxFollowUps as number) > 3) invalid("首版补充问题上限必须是 0 至 3。");
  const criterionIds = new Set(rubric.criteria.map((criterion) => criterion.id));
  const covered = new Set<string>();
  const questionIds = new Set<string>();
  for (const entry of list(data.questions, "题目", 30, 1)) {
    const question = record(entry, ["id", "taskTemplateId", "prompt", "criterionIds", "required"], "题目");
    const questionId = id(question.id, "题目 ID");
    if (questionIds.has(questionId)) invalid("同一题组的题目 ID 不能重复。");
    questionIds.add(questionId);
    id(question.taskTemplateId, "任务模板 ID");
    text(question.prompt, "题目内容");
    if (typeof question.required !== "boolean") invalid("题目是否必答必须明确。");
    const refs = texts(question.criterionIds, "题目评分项", 100, 200);
    if (refs.length === 0 || refs.some((ref) => !criterionIds.has(ref))) invalid("题目必须引用本量规中的至少一个评分项。");
    refs.forEach((ref) => covered.add(ref));
  }
  if (covered.size !== criterionIds.size) invalid("量规的每个评分项都需要有对应题目；未选择的题目可以保持未评分。");
}

function frozenCopy<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (entry: unknown): void => {
    if (entry === null || typeof entry !== "object" || Object.isFrozen(entry)) return;
    Object.values(entry).forEach(freeze);
    Object.freeze(entry);
  };
  freeze(clone);
  return clone;
}

/** Immutable local configuration adapter. Publishing/review remains an explicit operational decision. */
export class FixedQuestionCatalog implements QuestionCatalogPort {
  private readonly questionSets: ReadonlyMap<string, QuestionSet>;
  private readonly rubrics: ReadonlyMap<string, RubricVersion>;

  constructor(configuration: { readonly questionSets: readonly QuestionSet[]; readonly rubrics: readonly RubricVersion[] }) {
    const rubrics = new Map<string, RubricVersion>();
    for (const rubric of configuration.rubrics) {
      validateRubric(rubric);
      if (rubrics.has(rubric.id)) invalid("量规版本 ID 不能重复。");
      rubrics.set(rubric.id, frozenCopy(rubric));
    }
    const questionSets = new Map<string, QuestionSet>();
    for (const set of configuration.questionSets) {
      const rubric = rubrics.get(set.rubricVersionId);
      if (!rubric) invalid("题组引用的量规版本尚未配置。");
      validateQuestionCatalog(set, rubric);
      if (questionSets.has(set.id)) invalid("题组版本 ID 不能重复。");
      questionSets.set(set.id, frozenCopy(set));
    }
    this.questionSets = questionSets;
    this.rubrics = rubrics;
  }

  async getQuestionSet(id: string): Promise<QuestionSet | null> {
    return this.questionSets.get(id) ?? null;
  }

  async getRubric(id: string): Promise<RubricVersion | null> {
    return this.rubrics.get(id) ?? null;
  }
}

const PILOT_LIMITATIONS = [
  "首批试用草案，尚未完成题库审核；正式测评须由题库负责人明确审核并配置已发布版本。",
  "题面、行为锚点和权重尚未经过真实队伍校准；不同题组或难度的结果不可合并排名。",
  "只反映本次任务证据，未覆盖能力另列；不表示真实能力百分比或任务成功概率。",
] as const;

/** Draft reference content, not evidence that human review or pilot calibration has happened. */
export const PILOT_RUBRIC: RubricVersion = frozenCopy({
  id: "pilot_rubric_v1",
  version: 1,
  missingEvidencePolicy: "exclude_from_denominator",
  limitations: PILOT_LIMITATIONS,
  criteria: [
    { id: "requirements_scope", dimension: "requirements", label: "需求与最小范围", weight: 1, maxScore: 3, anchors: ["答案与交付目标无关", "描述目标但未区分必须与可选", "明确最小交付物与主要取舍", "说明必交依据、取舍与验收边界"] },
    { id: "design_flow", dimension: "design", label: "页面与使用流程", weight: 1, maxScore: 3, anchors: ["未形成可解释的使用流程", "描述页面但关键操作不清楚", "提供可执行主流程与信息层级", "提供主流程、异常状态及可用性验证依据"] },
    { id: "development_verification", dimension: "development", label: "开发与排错验证", weight: 1, maxScore: 3, anchors: ["步骤与问题无关", "知道需要验证但不能描述步骤", "给出主要排查步骤和预期结果", "给出可复现步骤、异常处理和未验证边界"] },
    { id: "testing_delivery", dimension: "testing", label: "测试与交付检查", weight: 1, maxScore: 3, anchors: ["检查与功能或交付无关", "列出检查项但没有通过条件", "覆盖主流程、材料和主要通过条件", "覆盖主流程、典型异常和提交遗漏，并提供可重复检查步骤"] },
    { id: "documentation_accuracy", dimension: "documentation", label: "文档与素材准确性", weight: 1, maxScore: 3, anchors: ["说明与作品目标无关", "有介绍但关键材料缺失或未经区分", "清楚说明用途、运行方式和材料清单", "说明准确可复用，链接、步骤及未知事项有核对依据"] },
    { id: "presentation_collaboration", dimension: "presentation", label: "路演与协作表达", weight: 1, maxScore: 3, anchors: ["说明与项目问题无关", "能介绍项目但叙述或协作请求不清楚", "清楚说明问题、演示流程和协作需求", "叙述连贯，能解释限制并提出具体协助与验证办法"] },
  ],
});

export const PILOT_QUESTION_SET: QuestionSet = frozenCopy({
  id: "pilot_question_set_v1",
  version: 1,
  rubricVersionId: PILOT_RUBRIC.id,
  status: "draft",
  difficultyLabel: "新人小任务试用草案；任务之间尚未校准难度等价性",
  allowedTools: ["文字编辑工具", "原型或绘图工具", "代码编辑器", "AI 工具（仅赛事规则允许时，并记录使用方式）"],
  maxFollowUps: 3,
  limitations: PILOT_LIMITATIONS,
  questions: [
    { id: "pilot_requirements", taskTemplateId: "minimum_scope_v1", prompt: "以你们当前作品目标为例，列出一个能演示的最小版本：必须交付什么、什么可以暂缓、怎样检查已经完成？赛事要求未确认时请明确写出假设。", criterionIds: ["requirements_scope"], required: true },
    { id: "pilot_design", taskTemplateId: "user_flow_v1", prompt: "选择一个你愿意负责的页面，用文字或简图说明新人怎样完成主要操作。说明关键信息、一个失败状态及你会如何检查它。", criterionIds: ["design_flow"], required: false },
    { id: "pilot_development", taskTemplateId: "debug_verification_v1", prompt: "选择一段你写过或能理解的功能，描述一次问题排查或修改过程：怎样重现、检查什么、预期结果是什么、还有什么没有验证？可附作品链接或步骤。", criterionIds: ["development_verification"], required: false },
    { id: "pilot_testing", taskTemplateId: "delivery_checklist_v1", prompt: "为作品的一个主要功能和正式交付列一份短检查清单，写出通过条件、一个异常情景及容易遗漏的材料。", criterionIds: ["testing_delivery"], required: false },
    { id: "pilot_documentation", taskTemplateId: "readme_materials_v1", prompt: "为当前作品写一段简短说明，列出运行或体验步骤及演示素材。标明已经核对与仍未知的内容，可提供对应材料。", criterionIds: ["documentation_accuracy"], required: false },
    { id: "pilot_presentation", taskTemplateId: "presentation_collaboration_v1", prompt: "用简短文字介绍作品解决的问题与演示流程，再说明一个限制以及你希望队友提供的具体协助。", criterionIds: ["presentation_collaboration"], required: false },
  ],
});
