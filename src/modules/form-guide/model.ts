/**
 * AI 工作台 · 表单步骤指引（纯逻辑）
 *
 * 依据：规划 36 §2.2（表单步骤指引）、规划 35 §19.4（默认即可用、每个区块一句人话）、
 * 宪法 v1.24.0 原则 XIII（助手只读、只出草稿、不执行、不判分）与 XIV（AI 生成内容须人工确认）、
 * 原则 II / XII（不编事实、字段只能来自平台表单定义）。
 *
 * 本模块**不持有任何表单定义**：schema 一律由调用方传入（报名表 / 提交表 / 招募贴…）。
 * 模块只回答三件事：**怎么分步、每栏一句人话、哪些能预填**。
 *
 * 硬边界（本文件是这些边界的落点）：
 *  - **不发明字段**：schema 之外的字段名一律 FORM_GUIDE_UNKNOWN_FIELD；模块里没有字段清单、
 *    没有默认表单、没有按 formId 的内置白名单。
 *  - **不提交、不校验业务规则**：必填、格式、日期区间、名额都是真表单与后端的事；
 *    这里只搬运 schema 事实。
 *  - **不生成 HTML**：只产出结构化数据，渲染是界面的事。
 *  - **纯函数**：无 IO、无 Date.now()、无随机；同一输入永远同一输出；不修改调用方的入参。
 *  - **不静默**：非法提示逐条丢弃并计数；被跳过的预填逐条给出原因。
 */
import { DomainError } from "../../shared/errors.ts";

// ---- 字段类型与拟稿来源（都是封闭集合，不接受自定义类型） ----

export const GUIDE_FIELD_TYPES = ["text", "textarea", "select", "date", "checkbox"] as const;
export type GuideFieldType = (typeof GUIDE_FIELD_TYPES)[number];

export const GUIDE_FIELD_TYPE_LABELS: Readonly<Record<GuideFieldType, string>> = {
  text: "单行文本",
  textarea: "多行文本",
  select: "单选",
  date: "日期",
  checkbox: "勾选",
};

/**
 * 每一栏都必须带 origin，供界面标注「AI 拟稿」：
 *  - user：本人填写（包括本人改写过 AI 拟稿的栏）；
 *  - ai：AI 预填或拟稿，**必须**由本人确认后才写进表单草稿；
 *  - empty：还没填。
 */
export const GUIDE_ORIGINS = ["user", "ai", "empty"] as const;
export type GuideOrigin = (typeof GUIDE_ORIGINS)[number];
/** 预填只能产出 ai / user（empty 不是一次写入）。 */
export type GuideDraftOrigin = Exclude<GuideOrigin, "empty">;

export const GUIDE_ORIGIN_LABELS: Readonly<Record<GuideOrigin, string>> = {
  user: "本人填写",
  ai: "AI 拟稿",
  empty: "未填写",
};

export const MAX_GUIDE_FIELDS = 200;
export const MAX_FIELD_NAME_CHARS = 64;
export const MAX_FIELD_LABEL_CHARS = 120;
export const MAX_SELECT_OPTIONS = 100;
export const MAX_FORM_ID_CHARS = 120;
export const MAX_FIELD_LENGTH_LIMIT = 10000;

// ---- 外部传入的 schema（模块只读它，不持有它） ----

export interface GuideSchemaField {
  readonly name: string;
  readonly label: string;
  readonly type: GuideFieldType;
  readonly required: boolean;
  /** 仅 select 允许有；其余类型带非空 options 视为 schema 错误。 */
  readonly options?: readonly string[];
  /** 仅文本类允许有；checkbox 带 maxLength 视为 schema 错误。 */
  readonly maxLength?: number;
}

export interface GuideSchema {
  readonly formId: string;
  readonly fields: readonly GuideSchemaField[];
}

// ---- 错误：全部是 FORM_GUIDE_* 的 DomainError（可经既有 HTTP 边界透出） ----

export type FormGuideErrorCode =
  | "FORM_GUIDE_INVALID_SCHEMA"
  | "FORM_GUIDE_UNKNOWN_FORM"
  | "FORM_GUIDE_UNKNOWN_FIELD"
  | "FORM_GUIDE_INVALID_OPTIONS"
  | "FORM_GUIDE_INVALID_STEPS"
  | "FORM_GUIDE_INVALID_HINTS"
  | "FORM_GUIDE_INVALID_PREFILL";

/**
 * name 固定回写为 "DomainError"，让 shared/errors.ts 的 isDomainError() 在跨打包副本时仍认它。
 * 状态码：未知表单 404；其余调用方输入问题 422。
 */
export class FormGuideError extends DomainError {
  constructor(code: FormGuideErrorCode, message: string, status = 422, recoveryAction?: string) {
    super(code, message, {
      status,
      ...(recoveryAction === undefined ? {} : { recoveryAction }),
    });
    this.name = "DomainError";
  }
}

function invalidSchema(message: string): FormGuideError {
  return new FormGuideError("FORM_GUIDE_INVALID_SCHEMA", message, 422, "schema 由调用方提供；请按 GuideSchema 修正后重试。");
}
function unknownField(message: string): FormGuideError {
  return new FormGuideError("FORM_GUIDE_UNKNOWN_FIELD", message, 422, "只提交 schema 中真实存在的字段；模块不发明字段。");
}
function invalidOptions(message: string): FormGuideError {
  return new FormGuideError("FORM_GUIDE_INVALID_OPTIONS", message);
}

// ---- 字符与来源判定（提示的 1–80 字按 Unicode 码点计，不按 UTF-16 长度） ----

export function countChars(text: string): number {
  return Array.from(text).length;
}

const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u;

/** 控制字符、换行、行分隔符：提示必须是一句人话，不能带这些。 */
export function hasControlChars(text: string): boolean {
  return CONTROL_CHARS.test(text);
}

export function isGuideFieldType(value: unknown): value is GuideFieldType {
  return typeof value === "string" && (GUIDE_FIELD_TYPES as readonly string[]).includes(value);
}

export function isGuideOrigin(value: unknown): value is GuideOrigin {
  return typeof value === "string" && (GUIDE_ORIGINS as readonly string[]).includes(value);
}

/** 能被预填的只有这四类；checkbox 与「必填的多行文本」由本人填。 */
export function isPrefillableType(type: GuideFieldType): boolean {
  return type !== "checkbox";
}

export function isAiDrafted(origin: GuideOrigin): boolean {
  return origin === "ai";
}

// ---- schema 校验：只核对「是不是一张合法的表单」，不判定业务必填是否合理 ----

/**
 * 校验调用方传入的 schema。**成功不返回副本**：模块不接管 schema 的所有权，
 * 后续步骤只按字段读取，绝不回写。
 */
export function validateGuideSchema(schema: GuideSchema): void {
  if (schema === null || typeof schema !== "object") throw invalidSchema("schema 必须是对象。");

  const formId: unknown = (schema as { formId?: unknown }).formId;
  if (typeof formId !== "string" || formId.trim() === "") {
    throw invalidSchema("schema.formId 必须是非空字符串；模块不接受没有出处的表单。");
  }
  if (formId !== formId.trim() || hasControlChars(formId)) {
    throw invalidSchema("schema.formId 不能带首尾空白或控制字符。");
  }
  if (countChars(formId) > MAX_FORM_ID_CHARS) {
    throw invalidSchema("schema.formId 过长（上限 " + MAX_FORM_ID_CHARS + " 字符）。");
  }

  const fields: unknown = (schema as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) {
    throw invalidSchema("schema.fields 必须是数组；空表单请传 []，此时分步结果也是空数组。");
  }
  if (fields.length > MAX_GUIDE_FIELDS) {
    throw invalidSchema("一张表单最多 " + MAX_GUIDE_FIELDS + " 栏，收到 " + fields.length + " 栏。");
  }

  const seen = new Set<string>();
  fields.forEach((raw: unknown, index: number) => validateSchemaField(raw, index, seen));
}

function validateSchemaField(raw: unknown, index: number, seen: Set<string>): void {
  const position = "第 " + (index + 1) + " 栏";
  if (raw === null || typeof raw !== "object") throw invalidSchema(position + "必须是对象。");
  const field = raw as Partial<GuideSchemaField>;

  const name: unknown = field.name;
  if (typeof name !== "string" || name.trim() === "") throw invalidSchema(position + "的 name 必须是非空字符串。");
  if (name !== name.trim()) throw invalidSchema(position + "的 name 不能带首尾空白。");
  if (hasControlChars(name)) throw invalidSchema(position + "的 name 不能带控制字符。");
  if (countChars(name) > MAX_FIELD_NAME_CHARS) throw invalidSchema(position + "的 name 过长（上限 " + MAX_FIELD_NAME_CHARS + " 字符）。");
  if (seen.has(name)) throw invalidSchema("字段名重复：" + name + "；一栏只能出现一次。");
  seen.add(name);

  const label: unknown = field.label;
  if (typeof label !== "string" || label.trim() === "") throw invalidSchema(position + "（" + name + "）的 label 必须是非空字符串。");
  if (hasControlChars(label)) throw invalidSchema(position + "（" + name + "）的 label 不能带控制字符。");
  if (countChars(label) > MAX_FIELD_LABEL_CHARS) throw invalidSchema(position + "（" + name + "）的 label 过长（上限 " + MAX_FIELD_LABEL_CHARS + " 字符）。");

  if (!isGuideFieldType(field.type)) {
    throw invalidSchema(position + "（" + name + "）的 type 必须是 " + GUIDE_FIELD_TYPES.join(" / ") + " 之一。");
  }
  if (typeof field.required !== "boolean") throw invalidSchema(position + "（" + name + "）的 required 必须是布尔值。");

  const options: unknown = field.options;
  if (field.type === "select") {
    if (!Array.isArray(options) || options.length === 0) {
      throw invalidSchema(position + "（" + name + "）是单选，必须带非空 options。");
    }
    if (options.length > MAX_SELECT_OPTIONS) {
      throw invalidSchema(position + "（" + name + "）的 options 过多（上限 " + MAX_SELECT_OPTIONS + " 项）。");
    }
    const seenOptions = new Set<string>();
    options.forEach((option: unknown) => {
      if (typeof option !== "string" || option.trim() === "") {
        throw invalidSchema(position + "（" + name + "）的 options 只能是非空字符串。");
      }
      if (option !== option.trim() || hasControlChars(option)) {
        throw invalidSchema(position + "（" + name + "）的 options 不能带首尾空白或控制字符：" + option);
      }
      if (seenOptions.has(option)) throw invalidSchema(position + "（" + name + "）的 options 有重复项：" + option);
      seenOptions.add(option);
    });
  } else if (options !== undefined) {
    if (!Array.isArray(options)) throw invalidSchema(position + "（" + name + "）的 options 必须是数组。");
    if (options.length > 0) {
      throw invalidSchema(position + "（" + name + "）是 " + field.type + "，不能带 options；选项只属于单选。");
    }
  }

  const maxLength: unknown = field.maxLength;
  if (maxLength !== undefined) {
    if (field.type === "checkbox") throw invalidSchema(position + "（" + name + "）是勾选，不能带 maxLength。");
    if (typeof maxLength !== "number" || !Number.isInteger(maxLength) || maxLength < 1 || maxLength > MAX_FIELD_LENGTH_LIMIT) {
      throw invalidSchema(position + "（" + name + "）的 maxLength 必须是 1–" + MAX_FIELD_LENGTH_LIMIT + " 的整数。");
    }
  }
}

/**
 * 「formId 只接受调用方给的 schema」的落点：
 * 调用方手里有一份表单目录（例如报名表 / 提交表 / 招募贴三张已注册的表单），
 * 传进来的 formId 必须在这份目录里，否则 404，模块不会按名字猜一张表。
 */
export function resolveSchema(catalog: readonly GuideSchema[], formId: string): GuideSchema {
  if (!Array.isArray(catalog)) throw invalidSchema("catalog 必须是 GuideSchema 数组（由调用方提供）。");
  if (typeof formId !== "string" || formId.trim() === "") throw unknownForm(formId);
  const found = catalog.find(schema => schema !== null && typeof schema === "object" && schema.formId === formId);
  if (found === undefined) throw unknownForm(formId);
  validateGuideSchema(found);
  return found;
}

function unknownForm(formId: unknown): FormGuideError {
  const shown = typeof formId === "string" ? formId : "(非字符串)";
  return new FormGuideError(
    "FORM_GUIDE_UNKNOWN_FORM",
    "没有这张表单：" + shown + "。表单定义只能由调用方传入，模块不内置任何表单。",
    404,
    "由调用方在表单目录里查出 schema 再调用；或用 resolveSchema(catalog, formId)。",
  );
}

/** 可选的 formId 白名单：给了就只认名单里的（空数组等于一张都不认）。 */
export function ensureFormIdAllowed(schema: GuideSchema, allowedFormIds?: readonly string[]): void {
  if (allowedFormIds === undefined) return;
  if (!Array.isArray(allowedFormIds)) throw invalidOptions("allowedFormIds 必须是字符串数组。");
  if (!allowedFormIds.includes(schema.formId)) throw unknownForm(schema.formId);
}
