/**
 * 分步（planSteps）与预填（applyPrefill）
 *
 * 分步规则（对调用方是稳定契约）：
 *  1. **不丢字段、不重复**：每个 schema 字段恰好出现在一步里一次。
 *  2. **每步 2–4 栏**：默认下限 2、上限 4；栏数不足 2（整张表单只有 1 栏）时才允许 1 栏一步。
 *  3. **步内顺序与 schema 一致**：一步内的栏按 schema 原顺序排列，模块从不改写标签或顺序。
 *  4. **必填优先**：跨步看，任一必填栏所在的步序号 ≤ 任一选填栏的步序号；
 *     即先把必填栏（按 schema 顺序）排完，再排选填栏（按 schema 顺序）。
 *     整张表单 ≤ 4 栏时全部落在一屏，栏序就是 schema 顺序。
 *  5. **确定性**：同样的 schema + options 永远得到同样的步骤 id 与栏序（id = formId:step-N）。
 *
 * 预填规则（applyPrefill）：
 *  - 只有 text / textarea / date / select 能被预填；**checkbox 一律不预填**（勾选必须本人点）。
 *  - **必填的多行文本是创作型字段**（个人陈述、作品介绍…），留给本人写，AI 不代笔。
 *  - 引用 schema 之外的字段名 → 直接 FORM_GUIDE_UNKNOWN_FIELD（AI 拟稿也不许发明字段）。
 *  - 跳过一律记账：理由 + 原值都不静默丢弃；值不做截断（超长直接跳过，不悄悄剪短）。
 *  - 已被本人填写的栏不被 AI 覆盖（user_value_kept）。
 */
import { DomainError } from "../../shared/errors.ts";
import {
  GUIDE_ORIGINS,
  countChars, ensureFormIdAllowed, isGuideFieldType, isGuideOrigin, validateGuideSchema,
} from "./model.ts";
import type { GuideDraftOrigin, GuideFieldType, GuideOrigin, GuideSchema, GuideSchemaField, FormGuideErrorCode } from "./model.ts";

export const GUIDE_MIN_PER_STEP = 2;
export const GUIDE_MAX_PER_STEP = 4;

/** 分步后的一栏：schema 事实 + 当前值 + 拟稿来源 + 提示。 */
export interface GuideField {
  readonly name: string;
  readonly label: string;
  readonly type: GuideFieldType;
  readonly required: boolean;
  /** select 的候选；非 select 恒为 []。 */
  readonly options: readonly string[];
  readonly maxLength: number | null;
  /** 在 schema.fields 里的原位置，便于界面回指与排查。 */
  readonly schemaIndex: number;
  /** 当前值；未填为 null。 */
  readonly value: string | null;
  readonly origin: GuideOrigin;
  /** 一句人话（来自 attachHints）；没通过校验的提示不会出现在这里。 */
  readonly hint: string | null;
}

export interface GuideStep {
  readonly id: string;
  readonly formId: string;
  /** 1 起。界面上就是「第 index / 总步数 步」。 */
  readonly index: number;
  readonly fields: readonly GuideField[];
  readonly fieldCount: number;
  readonly requiredCount: number;
  /** 本步能预填的栏数（供工作台决定要不要调 AI 拟稿）。 */
  readonly prefillableCount: number;
}

export interface PlanStepsOptions {
  /** 调用方的表单白名单；给了就只认名单里的 formId。 */
  readonly allowedFormIds?: readonly string[];
  /** 每步下限，只允许 2–4，默认 2。 */
  readonly minPerStep?: number;
  /** 每步上限，只允许 2–4，默认 4。 */
  readonly maxPerStep?: number;
  /** 默认 true（必填优先）；传 false 则完全按 schema 顺序切步，不做必填优先。 */
  readonly requiredFirst?: boolean;
}

function fail(code: FormGuideErrorCode, message: string): DomainError {
  return new DomainError(code, message);
}

function toGuideField(field: GuideSchemaField, schemaIndex: number): GuideField {
  return {
    name: field.name,
    label: field.label,
    type: field.type,
    required: field.required,
    options: field.type === "select" ? [...(field.options ?? [])] : [],
    maxLength: field.maxLength ?? null,
    schemaIndex,
    value: null,
    origin: "empty",
    hint: null,
  };
}

function readStepBounds(options: PlanStepsOptions): { min: number; max: number } {
  const min = options.minPerStep ?? GUIDE_MIN_PER_STEP;
  const max = options.maxPerStep ?? GUIDE_MAX_PER_STEP;
  for (const [name, value] of [["minPerStep", min], ["maxPerStep", max]] as const) {
    if (!Number.isInteger(value) || value < GUIDE_MIN_PER_STEP || value > GUIDE_MAX_PER_STEP) {
      throw fail("FORM_GUIDE_INVALID_OPTIONS", name + " 只能是 " + GUIDE_MIN_PER_STEP + "–" + GUIDE_MAX_PER_STEP + " 的整数，收到 " + String(value) + "。");
    }
  }
  if (min > max) throw fail("FORM_GUIDE_INVALID_OPTIONS", "minPerStep (" + min + ") 不能大于 maxPerStep (" + max + ")。");
  return { min, max };
}

/**
 * 切步大小：先按上限算最少几屏，再把余数平摊到前几屏，保证每屏 min–max 栏。
 * 例如 5 栏 → [3, 2]，9 栏 → [3, 3, 3]，13 栏 → [4, 3, 3, 3]。
 */
function chunkSizes(total: number, min: number, max: number): readonly number[] {
  if (total === 0) return [];
  if (total <= max) return [total];
  const screens = Math.ceil(total / max);
  const base = Math.floor(total / screens);
  const remainder = total % screens;
  const sizes = Array.from({ length: screens }, (_, i) => base + (i < remainder ? 1 : 0));
  for (const size of sizes) {
    if (size < min || size > max) {
      throw fail(
        "FORM_GUIDE_INVALID_OPTIONS",
        total + " 栏无法按每步 " + min + "–" + max + " 栏切分，请调整 minPerStep / maxPerStep。",
      );
    }
  }
  return sizes;
}

/**
 * 把调用方给的 schema 切成稳定步骤。schema.fields 为空时返回 []（不抛错），
 * 工作台据此显示「这张表还没有栏」而不是崩掉。
 */
export function planSteps(schema: GuideSchema, options: PlanStepsOptions = {}): readonly GuideStep[] {
  if (options === null || typeof options !== "object") {
    throw fail("FORM_GUIDE_INVALID_OPTIONS", "options 必须是对象（可以不传）。");
  }
  validateGuideSchema(schema);
  ensureFormIdAllowed(schema, options.allowedFormIds);
  const bounds = readStepBounds(options);

  const fields = schema.fields.map(toGuideField);
  const required = options.requiredFirst === false ? fields : fields.filter(field => field.required);
  const optional = options.requiredFirst === false ? [] : fields.filter(field => !field.required);
  const ordered = [...required, ...optional];

  const steps: GuideStep[] = [];
  let cursor = 0;
  const sizes = chunkSizes(ordered.length, bounds.min, bounds.max);
  sizes.forEach((size, index) => {
    // 步内恢复 schema 顺序：必填优先只决定「哪一屏」，不改一屏里的栏序。
    const chunk = ordered.slice(cursor, cursor + size).sort((a, b) => a.schemaIndex - b.schemaIndex);
    cursor += size;
    steps.push({
      id: schema.formId + ":step-" + (index + 1),
      formId: schema.formId,
      index: index + 1,
      fields: chunk,
      fieldCount: chunk.length,
      requiredCount: chunk.filter(field => field.required).length,
      prefillableCount: chunk.filter(field => field.type !== "checkbox").length,
    });
  });
  return steps;
}

/** 界面标题：「第 1/3 步」。由界面决定要不要显示，模块不拼接 HTML。 */
export function stepLabel(step: GuideStep, totalSteps: number): string {
  return "第 " + step.index + "/" + totalSteps + " 步";
}

// ---- 步骤数组的形状校验（applyPrefill / attachHints 共用；也便于工作台自查） ----

export function assertGuideSteps(steps: readonly GuideStep[]): void {
  if (!Array.isArray(steps)) throw fail("FORM_GUIDE_INVALID_STEPS", "steps 必须是 planSteps 返回的步骤数组。");
  const names = new Set<string>();
  for (const step of steps as readonly unknown[]) {
    if (step === null || typeof step !== "object") throw fail("FORM_GUIDE_INVALID_STEPS", "步骤必须是对象。");
    const candidate = step as Partial<GuideStep>;
    if (typeof candidate.id !== "string" || candidate.id === "") throw fail("FORM_GUIDE_INVALID_STEPS", "步骤缺少 id。");
    if (!Number.isInteger(candidate.index) || (candidate.index as number) < 1) throw fail("FORM_GUIDE_INVALID_STEPS", "步骤 " + candidate.id + " 的 index 必须是 1 起的整数。");
    if (!Array.isArray(candidate.fields)) throw fail("FORM_GUIDE_INVALID_STEPS", "步骤 " + candidate.id + " 缺少 fields 数组。");
    for (const raw of candidate.fields as readonly unknown[]) {
      if (raw === null || typeof raw !== "object") throw fail("FORM_GUIDE_INVALID_STEPS", "步骤 " + candidate.id + " 里有非对象字段。");
      const field = raw as Partial<GuideField>;
      if (typeof field.name !== "string" || field.name === "") throw fail("FORM_GUIDE_INVALID_STEPS", "步骤 " + candidate.id + " 里有字段缺 name。");
      if (!isGuideFieldType(field.type)) throw fail("FORM_GUIDE_INVALID_STEPS", "字段 " + field.name + " 的 type 不合法：" + String(field.type));
      if (!isGuideOrigin(field.origin)) throw fail("FORM_GUIDE_INVALID_STEPS", "字段 " + field.name + " 的 origin 不合法：" + String(field.origin));
      if (field.value !== null && typeof field.value !== "string") throw fail("FORM_GUIDE_INVALID_STEPS", "字段 " + field.name + " 的 value 必须是字符串或 null。");
      if (names.has(field.name)) throw fail("FORM_GUIDE_INVALID_STEPS", "字段名重复：" + field.name + "；步骤里的字段名必须唯一。");
      names.add(field.name);
    }
  }
}

// ---- 预填 ----

export interface GuidePrefillValue {
  readonly value: string;
  /** 不给就是 ai（AI 拟稿）；本人确认后的写入用 user。 */
  readonly origin?: GuideDraftOrigin;
}

export type GuidePrefillInput = Readonly<Record<string, string | GuidePrefillValue>>;

export const GUIDE_PREFILL_SKIP_REASONS = [
  "checkbox",
  "creative_textarea",
  "user_value_kept",
  "invalid_value_type",
  "empty_value",
  "not_in_options",
  "too_long",
] as const;
export type GuidePrefillSkipReason = (typeof GUIDE_PREFILL_SKIP_REASONS)[number];

export const GUIDE_PREFILL_SKIP_LABELS: Readonly<Record<GuidePrefillSkipReason, string>> = {
  checkbox: "勾选框只能本人点",
  creative_textarea: "必填的多行文本留给本人写",
  user_value_kept: "本人已填，AI 不覆盖",
  invalid_value_type: "值不是文本",
  empty_value: "值为空",
  not_in_options: "不在候选项里",
  too_long: "超过字数上限",
};

export interface PrefillFilledField {
  readonly field: string;
  readonly stepId: string;
  readonly stepIndex: number;
  readonly value: string;
  readonly origin: GuideOrigin;
}

export interface PrefillSkippedField {
  readonly field: string;
  readonly reason: GuidePrefillSkipReason;
  /** 给人看的一句话，说明为什么没填。 */
  readonly detail: string;
}

export interface PrefillResult {
  readonly steps: readonly GuideStep[];
  readonly filledFields: readonly PrefillFilledField[];
  readonly skippedFields: readonly PrefillSkippedField[];
}

/**
 * 按 schema 事实把值写进步骤（**不提交、不写库**；写进表单草稿是根的事）。
 * 返回新步骤数组，入参 steps 不被修改。
 */
export function applyPrefill(steps: readonly GuideStep[], prefill: GuidePrefillInput): PrefillResult {
  assertGuideSteps(steps);
  if (prefill === null || typeof prefill !== "object" || Array.isArray(prefill)) {
    throw fail("FORM_GUIDE_INVALID_PREFILL", "prefill 必须是以字段名为键的对象。");
  }

  const known = new Set<string>();
  for (const step of steps) for (const field of step.fields) known.add(field.name);
  const unknown = Object.keys(prefill).filter(name => !known.has(name));
  if (unknown.length > 0) {
    const shown = unknown.slice(0, 5).join("、");
    const more = unknown.length > 5 ? " 等 " + unknown.length + " 个" : "";
    throw new DomainError(
      "FORM_GUIDE_UNKNOWN_FIELD",
      "预填引用了表单里不存在的字段：" + shown + more + "。字段只能来自调用方传入的 schema。",
      { recoveryAction: "只提交 schema 中真实存在的字段；AI 拟稿也不许发明字段。" },
    );
  }

  // 先把调用方写错的结构（不是文本、来源不认识）挡在循环外，避免半途抛错留下半份结果。
  for (const key of Object.keys(prefill)) {
    const raw = prefill[key];
    if (raw !== null && typeof raw === "object") {
      const origin = (raw as GuidePrefillValue).origin;
      if (origin === undefined) continue;
      // 运行时仍要挡 "empty"：类型层已排除，但调用方可能从 JSON 传进来。
      if (String(origin) === "empty") {
        throw fail("FORM_GUIDE_INVALID_PREFILL", "字段 " + key + " 的 origin 不能是 empty；empty 表示没填。");
      }
      if (!isGuideOrigin(origin)) {
        throw fail("FORM_GUIDE_INVALID_PREFILL", "字段 " + key + " 的 origin 只能是 ai 或 user，收到 " + String(origin) + "。");
      }
    }
  }

  const filled: PrefillFilledField[] = [];
  const skipped: PrefillSkippedField[] = [];
  const skip = (field: GuideField, reason: GuidePrefillSkipReason, detail: string): GuideField => {
    skipped.push({ field: field.name, reason, detail });
    return field;
  };

  const nextSteps = steps.map(step => {
    const accept = (field: GuideField, value: string, origin: GuideDraftOrigin): GuideField => {
      filled.push({ field: field.name, stepId: step.id, stepIndex: step.index, value, origin });
      return { ...field, value, origin };
    };
    const fields = step.fields.map(field => {
      if (!Object.prototype.hasOwnProperty.call(prefill, field.name)) return field;
      const raw = prefill[field.name];
      const origin: GuideDraftOrigin = raw !== null && typeof raw === "object"
        ? ((raw as GuidePrefillValue).origin ?? "ai") as GuideDraftOrigin
        : "ai";

      if (field.origin === "user" && origin === "ai") {
        return skip(field, "user_value_kept", "该栏已有本人填写的内容，AI 不覆盖。");
      }
      if (field.type === "checkbox") {
        return skip(field, "checkbox", "勾选只能由本人点，AI 不代勾。");
      }
      if (field.required && field.type === "textarea") {
        return skip(field, "creative_textarea", "必填的多行文本是创作型字段，留给本人写。");
      }
      const value = raw !== null && typeof raw === "object"
        ? (raw as GuidePrefillValue).value
        : raw;
      if (typeof value !== "string") {
        return skip(field, "invalid_value_type", "预填值必须是字符串，收到 " + (value === null ? "null" : typeof value) + "。");
      }
      const text = value.trim();
      if (text === "") return skip(field, "empty_value", "预填值为空，不写入空白。");
      if (field.type === "select") {
        const option = field.options.find(candidate => candidate === text);
        if (option === undefined) {
          return skip(field, "not_in_options", "只能取：" + field.options.join(" / ") + "；收到「" + text + "」。");
        }
        return accept(field, option, origin);
      }
      if (field.maxLength !== null && countChars(text) > field.maxLength) {
        return skip(field, "too_long", "最多 " + field.maxLength + " 字，本次 " + countChars(text) + " 字；不截断，请本人改写。");
      }
      return accept(field, text, origin);
    });
    return { ...step, fields };
  });

  return { steps: nextSteps, filledFields: filled, skippedFields: skipped };
}

/**
 * 本人改过某栏后，把来源改回 user（界面据此撤掉「AI 拟稿」标注）；
 * origin 传 empty 表示清空该栏（value 同时置 null）。
 */
export function markFieldOrigin(steps: readonly GuideStep[], field: string, origin: GuideOrigin): readonly GuideStep[] {
  assertGuideSteps(steps);
  if (!isGuideOrigin(origin)) throw fail("FORM_GUIDE_INVALID_STEPS", "origin 只能是 " + GUIDE_ORIGINS.join(" / ") + "。");
  let found = false;
  const next = steps.map(step => {
    if (!step.fields.some(item => item.name === field)) return step;
    found = true;
    return {
      ...step,
      fields: step.fields.map(item => (item.name === field
        ? { ...item, origin, value: origin === "empty" ? null : item.value }
        : item)),
    };
  });
  if (!found) {
    throw new DomainError("FORM_GUIDE_UNKNOWN_FIELD", "步骤里没有这一栏：" + field + "。");
  }
  return next;
}
