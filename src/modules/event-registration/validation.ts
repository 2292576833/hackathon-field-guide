import { DomainError } from "../../shared/errors.ts";
import { FIELD_TYPES } from "./model.ts";
import type { RegistrationField, RegistrationForm, RegistrationAnswers, AnswerValue } from "./model.ts";

export function invalid(message: string): never { throw new DomainError("INVALID_INPUT", message); }
export function identifier(value: unknown, label = "记录标识"): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) invalid(`请提供有效的${label}。`);
}
export function revision(value: unknown, allowZero = false): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1)) invalid("请提供有效的记录版本，读取最新资料后再操作。");
}
export function plainText(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid(`${label}须是${max}字以内的纯文本。`);
  const result = value.trim(); if (required && !result) invalid(`请填写${label}。`); return result;
}
export function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid("请提供有效的表单资料。");
}
export function validateFields(value: unknown): RegistrationField[] {
  if (!Array.isArray(value) || value.length > 30) invalid("报名表最多设置30个字段。");
  const used = new Set<string>();
  return value.map(item => {
    object(item);
    if (typeof item.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(item.id) || ["constructor", "prototype", "__proto__"].includes(item.id) || used.has(item.id)) invalid("字段编号须唯一，且只含字母、数字和下划线。");
    used.add(item.id);
    if (!FIELD_TYPES.includes(item.type as RegistrationField["type"]) || typeof item.required !== "boolean") invalid("请选择支持的字段类型和必填设置。");
    const result: RegistrationField = { id: item.id, type: item.type as RegistrationField["type"], label: plainText(item.label, "字段名称", 100, true), description: plainText(item.description ?? "", "字段说明", 500), required: item.required };
    if (["text", "textarea", "url"].includes(result.type)) {
      const maximum = result.type === "textarea" ? 4000 : result.type === "url" ? 2000 : 500;
      const length = item.maxLength ?? maximum;
      if (!Number.isSafeInteger(length) || (length as number) < 1 || (length as number) > maximum) invalid(`字段长度须在1至${maximum}之间。`);
      result.maxLength = length as number;
    }
    if (result.type === "number") {
      for (const key of ["min", "max"] as const) {
        if (item[key] !== undefined) {
          if (typeof item[key] !== "number" || !Number.isFinite(item[key]) || Math.abs(item[key]) > 1e9) invalid("数字范围须是正负十亿以内的有效数字。");
          result[key] = item[key];
        }
      }
      if (result.min !== undefined && result.max !== undefined && result.min > result.max) invalid("数字下限不能大于上限。");
    }
    if (["choice", "multichoice"].includes(result.type)) {
      if (!Array.isArray(item.options) || item.options.length < 1 || item.options.length > 30) invalid("选择题须设置1至30个选项。");
      result.options = item.options.map(option => plainText(option, "选项", 100, true));
      if (new Set(result.options).size !== result.options.length) invalid("选项不能重复。");
    }
    return result;
  });
}
export function validateAnswers(form: RegistrationForm, value: unknown, submitted: boolean): RegistrationAnswers {
  object(value);
  if (JSON.stringify(value).length > 60000) invalid("报名资料过长，请精简后保存。");
  const allowed = new Set(form.fields.map(field => field.id));
  if (Object.keys(value).some(key => !allowed.has(key))) invalid("表单已变更或包含未知字段，请核对最新报名表。");
  const result: RegistrationAnswers = Object.create(null) as RegistrationAnswers;
  for (const field of form.fields) {
    const answer = Object.hasOwn(value, field.id) ? value[field.id] : undefined;
    const empty = answer === undefined || answer === "" || (Array.isArray(answer) && answer.length === 0);
    if (empty) { if (submitted && field.required) invalid(`请填写${field.label}。`); continue; }
    let next: AnswerValue;
    switch (field.type) {
      case "number":
        if (typeof answer !== "number" || !Number.isFinite(answer) || Math.abs(answer) > 1e9 || (field.min !== undefined && answer < field.min) || (field.max !== undefined && answer > field.max)) invalid(`${field.label}超出允许的数字范围。`);
        next = answer; break;
      case "choice":
        if (typeof answer !== "string" || !field.options?.includes(answer)) invalid(`请重新选择${field.label}。`);
        next = answer; break;
      case "multichoice":
        if (!Array.isArray(answer) || answer.length > 30 || answer.some(item => typeof item !== "string" || !field.options?.includes(item)) || new Set(answer).size !== answer.length) invalid(`请重新选择${field.label}。`);
        next = [...answer] as string[]; break;
      default:
        next = plainText(answer, field.label, field.maxLength ?? 500, submitted && field.required);
        if (field.type === "url" && next) {
          let parsed: URL; try { parsed = new URL(next); } catch { invalid(`${field.label}须是完整的网址。`); }
          if (!["https:", "http:"].includes(parsed!.protocol) || parsed!.username || parsed!.password) invalid(`${field.label}只支持不含账号密码的http或https网址。`);
        }
    }
    result[field.id] = next;
  }
  return result;
}
export function pageOptions(value: { status?: string; cursor?: string; limit?: number } = {}) {
  const limit = value.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid("每页读取数量须在1至100之间。");
  if (value.cursor !== undefined) identifier(value.cursor, "分页位置");
  return { ...(value.status ? { status: value.status } : {}), ...(value.cursor ? { cursor: value.cursor } : {}), limit };
}
export function assertRevision(actual: number, expected: number) {
  revision(expected, true);
  if (actual !== expected) throw new DomainError("VERSION_CONFLICT", "资料已更新，输入已保留。请读取最新版本并核对后再操作。", { status: 409, latestRevision: actual, recoveryAction: "review_latest_version" });
}
/** Deterministic fingerprints ignore harmless JSON object key ordering. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function csvCell(value: unknown): string {
  let text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  // Leading whitespace/control characters can hide spreadsheet formula prefixes.
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
