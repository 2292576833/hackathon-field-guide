import { DomainError } from "../../shared/errors.ts";
import { isVerifiedRuleEvidence } from "./domain.ts";
import type { EventRuleVersion } from "./domain.ts";
import type { AnalysisContent, AnalysisInput } from "./model.ts";

/** Limits apply equally to manual drafts and untrusted model output. */
export const ANALYSIS_LIMITS = {
  id: 200,
  facts: 50,
  suggestions: 50,
  unknowns: 50,
  checklist: 200,
  references: 20,
  statement: 2000,
  suggestion: 3000,
  question: 2000,
  action: 2000,
  field: 100,
  backgroundFields: 20,
  backgroundValue: 2000,
  backgroundTotal: 15000,
} as const;

type ValidationCode = "INVALID_ANALYSIS" | "INVALID_ANALYSIS_INPUT";
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
const criticalFields = ["eligibility", "fees", "team_size", "ai_policy"] as const;

function invalid(code: ValidationCode, message: string): never {
  throw new DomainError(code, message, { recoveryAction: "edit_analysis" });
}

/** Accept JSON objects only; never invoke getters from an adapter's output. */
function object(value: unknown, label: string, code: ValidationCode, fields?: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(code, `${label}必须是对象。`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(code, `${label}必须是普通对象。`);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string" || unsafeKeys.has(key))) invalid(code, `${label}包含不允许的字段。`);
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !("value" in descriptor)) invalid(code, `${label}包含不允许的属性。`);
  }
  if (fields && (keys.length !== fields.length || fields.some(field => !Object.hasOwn(value, field)))) {
    invalid(code, `${label}字段不完整或包含额外字段。`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max: number, code: ValidationCode, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    invalid(code, `${label}必须是长度限制内的文本。`);
  }
  const result = value.trim();
  if (!allowEmpty && !result) invalid(code, `${label}不能为空。`);
  return result;
}

function array(value: unknown, label: string, max: number, code: ValidationCode): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) {
    invalid(code, `${label}必须是长度限制内的数组。`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some(key => key !== "length" &&
    (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length))) {
    invalid(code, `${label}不能包含空位或额外属性。`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid(code, `${label}必须包含普通数组元素。`);
  }
  return value;
}

function strings(value: unknown, label: string, max: number, code: ValidationCode): string[] {
  const result = array(value, label, max, code).map(item => text(item, label, ANALYSIS_LIMITS.id, code));
  if (new Set(result).size !== result.length) invalid(code, `${label}不能重复。`);
  return result;
}

function positiveVersion(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    invalid("INVALID_ANALYSIS_INPUT", `${label}必须是正整数。`);
  }
  return value;
}

function backgroundValues(value: unknown, code: ValidationCode): Record<string, string> {
  const input = object(value, "团队背景", code);
  const entries = Object.entries(input);
  if (entries.length > ANALYSIS_LIMITS.backgroundFields) invalid(code, "团队背景最多包含 20 个字段。");
  const result: Record<string, string> = {};
  let total = 0;
  for (const [key, value] of entries) {
    if (key !== text(key, "团队背景字段名", ANALYSIS_LIMITS.field, code)) invalid(code, "团队背景字段名不能含首尾空白。");
    const normalized = text(value, "团队背景", ANALYSIS_LIMITS.backgroundValue, code, true);
    total += (value as string).length;
    if (total > ANALYSIS_LIMITS.backgroundTotal) invalid(code, "团队背景总长度不能超过 15000 个字符。");
    result[key] = normalized;
  }
  return result;
}

export function validateAnalysisInput(input: unknown): AnalysisInput {
  const value = object(input, "分析输入", "INVALID_ANALYSIS_INPUT", ["projectId", "eventId", "rulesVersion", "backgroundVersion", "background"]);
  return {
    projectId: text(value.projectId, "项目 ID", ANALYSIS_LIMITS.id, "INVALID_ANALYSIS_INPUT"),
    eventId: text(value.eventId, "赛事 ID", ANALYSIS_LIMITS.id, "INVALID_ANALYSIS_INPUT"),
    rulesVersion: positiveVersion(value.rulesVersion, "规则版本"),
    backgroundVersion: positiveVersion(value.backgroundVersion, "团队背景版本"),
    background: backgroundValues(value.background, "INVALID_ANALYSIS_INPUT"),
  };
}

/** Reused by the model adapter without fabricating project/version identities. */
export function validateAnalysisBackground(input: unknown): Record<string, string> {
  return backgroundValues(input, "INVALID_ANALYSIS_INPUT");
}

function verifiedReferences(value: unknown, label: string, rules: EventRuleVersion, required: boolean): string[] {
  const ids = strings(value, label, ANALYSIS_LIMITS.references, "INVALID_ANALYSIS");
  if ((required && ids.length === 0) || ids.some(id => !isVerifiedRuleEvidence(rules, id))) {
    invalid("INVALID_ANALYSIS", `${label}必须引用本赛事规则版本内已核验、无冲突的官方证据。`);
  }
  return ids;
}

function unresolvedCriticalFields(rules: EventRuleVersion): string[] {
  return criticalFields.filter(key => {
    const facts = rules.facts.filter(fact => fact.key === key);
    return facts.length === 0 || facts.some(fact => fact.status !== "verified" || fact.evidenceIds.length === 0 ||
      fact.evidenceIds.some(id => !isVerifiedRuleEvidence(rules, id)));
  });
}

/** A missing AI policy may support a question, never an affirmative permission claim. */
function rejectUnknownAiPermission(statement: string): void {
  const patterns = [
    /(?:允许|可以|可|不限(?:制)?(?:使用)?)\s*(?:使用|采用|借助|利用)?\s*(?:AI\b|人工智能|生成式(?:人工智能|模型)|大模型)/giu,
    /(?:AI\b|人工智能|生成式(?:人工智能|模型)|大模型)\s*(?:工具|使用|辅助)?\s*(?:是|均|被|都)?\s*(?:允许|许可|不限(?:制)?)/giu,
    /\b(?:AI|artificial intelligence|generative AI)\s+(?:use\s+)?(?:is\s+|are\s+)?(?:allowed|permitted|unrestricted)\b/giu,
    /\b(?:allow|allows|allowing|permit|permits|permitting)\s+(?:the\s+use\s+of\s+)?(?:AI|artificial intelligence|generative AI)\b/giu,
  ];
  for (const pattern of patterns) {
    for (const match of statement.matchAll(pattern)) {
      const start = match.index!;
      const prefix = statement.slice(Math.max(0, start - 40), start).split(/[。！？!?;；,，\n]/u).at(-1)!;
      if (/(?:是否|能否|有没有|确认|核实|whether|verify|check)\s*(?:比赛|赛事|规则|the event|the rules)?\s*$/iu.test(prefix)) continue;
      invalid("INVALID_ANALYSIS", "AI 使用规则尚未核验，不能将允许使用 AI 写成已确定的结论。请列为待确认问题。");
    }
  }
}

export function validateAnalysisContent(input: unknown, rules: EventRuleVersion, background: Record<string, string>): AnalysisContent {
  const value = object(input, "分析草案", "INVALID_ANALYSIS", ["facts", "suggestions", "unknowns", "checklist"]);
  const knownBackground = backgroundValues(background, "INVALID_ANALYSIS");
  const unresolved = unresolvedCriticalFields(rules);
  const aiUnresolved = unresolved.includes("ai_policy");
  const facts = array(value.facts, "规则事实", ANALYSIS_LIMITS.facts, "INVALID_ANALYSIS").map(item => {
    const fact = object(item, "规则事实", "INVALID_ANALYSIS", ["statement", "evidenceIds"]);
    const statement = text(fact.statement, "规则事实", ANALYSIS_LIMITS.statement, "INVALID_ANALYSIS");
    if (aiUnresolved) rejectUnknownAiPermission(statement);
    return { statement, evidenceIds: verifiedReferences(fact.evidenceIds, "事实证据", rules, true) };
  });
  const suggestions = array(value.suggestions, "参赛建议", ANALYSIS_LIMITS.suggestions, "INVALID_ANALYSIS").map(item => {
    const suggestion = object(item, "参赛建议", "INVALID_ANALYSIS", ["text", "evidenceIds", "backgroundKeys"]);
    const suggestionText = text(suggestion.text, "参赛建议", ANALYSIS_LIMITS.suggestion, "INVALID_ANALYSIS");
    if (aiUnresolved) rejectUnknownAiPermission(suggestionText);
    const evidenceIds = verifiedReferences(suggestion.evidenceIds, "建议证据", rules, false);
    const backgroundKeys = strings(suggestion.backgroundKeys, "背景引用", ANALYSIS_LIMITS.backgroundFields, "INVALID_ANALYSIS");
    if (backgroundKeys.some(key => !Object.hasOwn(knownBackground, key))) invalid("INVALID_ANALYSIS", "参赛建议引用了本项目未提供的团队背景。");
    if (evidenceIds.length === 0 && backgroundKeys.length === 0) invalid("INVALID_ANALYSIS", "每项建议必须说明规则证据或本项目团队背景依据。");
    return { text: suggestionText, evidenceIds, backgroundKeys };
  });
  const unknowns = array(value.unknowns, "待确认问题", ANALYSIS_LIMITS.unknowns, "INVALID_ANALYSIS").map(item => {
    const unknown = object(item, "待确认问题", "INVALID_ANALYSIS", ["field", "question"]);
    return {
      field: text(unknown.field, "待确认字段", ANALYSIS_LIMITS.field, "INVALID_ANALYSIS"),
      question: text(unknown.question, "待确认问题", ANALYSIS_LIMITS.question, "INVALID_ANALYSIS"),
    };
  });
  if (unresolved.some(field => !unknowns.some(item => item.field === field))) {
    invalid("INVALID_ANALYSIS", "未核验、冲突或未知的资格、费用、团队规模与 AI 条款必须列入待确认问题。");
  }
  const requirementIds = new Set(rules.requirements.map(requirement => requirement.id));
  const checklist = array(value.checklist, "备赛清单", ANALYSIS_LIMITS.checklist, "INVALID_ANALYSIS").map(item => {
    const entry = object(item, "备赛清单", "INVALID_ANALYSIS", ["requirementId", "action"]);
    const requirementId = text(entry.requirementId, "提交要求 ID", ANALYSIS_LIMITS.id, "INVALID_ANALYSIS");
    if (!requirementIds.has(requirementId)) invalid("INVALID_ANALYSIS", "备赛清单只能引用本赛事规则版本内的提交要求。");
    return { requirementId, action: text(entry.action, "备赛动作", ANALYSIS_LIMITS.action, "INVALID_ANALYSIS") };
  });
  const listed = new Set(checklist.map(item => item.requirementId));
  if (listed.size !== checklist.length) invalid("INVALID_ANALYSIS", "备赛清单不能重复同一提交要求。");
  if (rules.requirements.some(requirement => requirement.necessity === "required" && !listed.has(requirement.id))) {
    invalid("INVALID_ANALYSIS", "备赛清单遗漏了本赛事的必交材料。");
  }
  return { facts, suggestions, unknowns, checklist };
}
