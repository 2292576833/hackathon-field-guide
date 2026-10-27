/**
 * 提示（attachHints）：每栏一句人话
 *
 * 规则（对调用方是稳定契约）：
 *  - 一条提示只描述**该步真实存在的一栏**；指向 schema/步骤里没有的字段一律拒绝。
 *  - 1–80 字（按 Unicode 码点计），去掉首尾空白后不能为空。
 *  - 不能含控制字符、换行、行分隔符——提示是一句人话，不是段落。
 *  - **非法逐条丢弃并计数**：返回 dropped[]（含序号、字段、原因、说明），绝不静默；
 *    合法提示照常挂到对应栏，不受其他非法项影响。
 *  - 同一栏只保留一条提示：后到的重复项按 duplicate_field 记账丢弃（先到先得，确定性）。
 *
 * 这一层只做形状与归属校验，不判断提示文案写得好不好——那是 AI 与人工的事。
 */
import { DomainError } from "../../shared/errors.ts";
import { countChars, hasControlChars } from "./model.ts";
import { assertGuideSteps } from "./steps.ts";
import type { GuideStep } from "./steps.ts";

export const GUIDE_HINT_MIN_CHARS = 1;
export const GUIDE_HINT_MAX_CHARS = 80;

export interface GuideHintInput {
  /** 目标字段名（必填）。字段名在整张表单里唯一，所以它已经能定位到步骤。 */
  readonly field: string;
  /** 一句人话。 */
  readonly text: string;
  /** 可选：调用方认定的步骤 id；与本模块解析结果不一致时按「不在这步」丢弃。 */
  readonly stepId?: string;
  /** 可选：调用方认定的步骤序号（1 起），同上。 */
  readonly stepIndex?: number;
}

export const GUIDE_HINT_REJECT_REASONS = [
  "invalid_shape",
  "unknown_step",
  "unknown_field",
  "field_not_in_step",
  "empty_text",
  "control_character",
  "too_long",
  "duplicate_field",
] as const;
export type GuideHintRejectReason = (typeof GUIDE_HINT_REJECT_REASONS)[number];

export const GUIDE_HINT_REJECT_LABELS: Readonly<Record<GuideHintRejectReason, string>> = {
  invalid_shape: "提示结构不合法",
  unknown_step: "指向的步骤不存在",
  unknown_field: "指向的字段不存在",
  field_not_in_step: "该字段不在这步",
  empty_text: "提示为空",
  control_character: "含控制字符或换行",
  too_long: "超过 80 字",
  duplicate_field: "同一栏重复给了提示",
};

export interface DroppedGuideHint {
  /** 在入参数组里的下标（0 起），方便工作台定位到原句。 */
  readonly index: number;
  /** 能读出字段名时给出，读不出为 null。 */
  readonly field: string | null;
  readonly stepId: string | null;
  readonly reason: GuideHintRejectReason;
  /** 给人看的一句话，不包含原句全文（避免把非法控制字符带回界面）。 */
  readonly detail: string;
}

export interface HintsResult {
  readonly steps: readonly GuideStep[];
  /** 成功挂上的提示条数。 */
  readonly accepted: number;
  readonly dropped: readonly DroppedGuideHint[];
  readonly droppedCount: number;
  /** 入参提示条数（= accepted + droppedCount）。 */
  readonly hintCount: number;
}

/** 不合法时返回原因，合法返回 null。供工作台在调 AI 前自查同一套规则。 */
export function hintTextRejectReason(text: unknown): GuideHintRejectReason | null {
  if (typeof text !== "string") return "invalid_shape";
  const trimmed = text.trim();
  if (trimmed === "") return "empty_text";
  if (hasControlChars(text)) return "control_character";
  if (countChars(trimmed) > GUIDE_HINT_MAX_CHARS) return "too_long";
  return null;
}

function fail(message: string): DomainError {
  return new DomainError("FORM_GUIDE_INVALID_HINTS", message);
}

/**
 * 把提示挂到步骤上。返回新步骤数组，入参 steps 不被修改；
 * 已经带提示的栏视为已占用（重复项按 duplicate_field 丢弃）。
 */
export function attachHints(steps: readonly GuideStep[], hints: readonly GuideHintInput[]): HintsResult {
  assertGuideSteps(steps);
  if (!Array.isArray(hints)) throw fail("hints 必须是数组；没有提示请传 []。");

  const stepById = new Map<string, GuideStep>();
  const stepByField = new Map<string, GuideStep>();
  for (const step of steps) {
    stepById.set(step.id, step);
    for (const field of step.fields) stepByField.set(field.name, step);
  }

  const hintsByField = new Map<string, string>();
  for (const step of steps) {
    for (const field of step.fields) {
      if (field.hint !== null) hintsByField.set(field.name, field.hint);
    }
  }

  const dropped: DroppedGuideHint[] = [];
  let accepted = 0;

  const drop = (index: number, field: string | null, stepId: string | null, reason: GuideHintRejectReason, detail: string): false => {
    dropped.push({ index, field, stepId, reason, detail });
    return false;
  };

  hints.forEach((raw: unknown, index: number) => {
    if (raw === null || typeof raw !== "object") {
      drop(index, null, null, "invalid_shape", "提示必须是 { field, text } 对象。");
      return;
    }
    const hint = raw as Partial<GuideHintInput>;
    const fieldName = typeof hint.field === "string" ? hint.field : null;
    const claimedStepId = typeof hint.stepId === "string" ? hint.stepId : null;

    if (fieldName === null || fieldName.trim() === "") {
      drop(index, null, claimedStepId, "invalid_shape", "提示缺少字段名 field。");
      return;
    }

    let claimedStep: GuideStep | null = null;
    if (hint.stepId !== undefined) {
      if (typeof hint.stepId !== "string" || !stepById.has(hint.stepId)) {
        drop(index, fieldName, claimedStepId, "unknown_step", "步骤 " + String(hint.stepId) + " 不在这次分步结果里。");
        return;
      }
      claimedStep = stepById.get(hint.stepId) ?? null;
    }
    if (hint.stepIndex !== undefined) {
      const claimedIndex = hint.stepIndex;
      const found = Number.isInteger(claimedIndex) ? steps.find(step => step.index === claimedIndex) : undefined;
      if (found === undefined) {
        drop(index, fieldName, claimedStep === null ? null : claimedStep.id, "unknown_step", "步骤序号 " + String(claimedIndex) + " 不在这次分步结果里。");
        return;
      }
      if (claimedStep !== null && found.id !== claimedStep.id) {
        drop(index, fieldName, claimedStep.id, "field_not_in_step", "stepId 与 stepIndex 指向了不同步骤。");
        return;
      }
      claimedStep = found;
    }

    const owner = stepByField.get(fieldName);
    if (owner === undefined) {
      drop(index, fieldName, claimedStep === null ? null : claimedStep.id, "unknown_field", "表单里没有这一栏：" + fieldName + "。");
      return;
    }
    if (claimedStep !== null && claimedStep.id !== owner.id) {
      drop(index, fieldName, claimedStep.id, "field_not_in_step", "「" + fieldName + "」在 " + owner.id + "，不在 " + claimedStep.id + "。");
      return;
    }
    if (hintsByField.has(fieldName)) {
      drop(index, fieldName, owner.id, "duplicate_field", "这一栏已经有一条提示，先到先得。");
      return;
    }

    const reason = hintTextRejectReason(hint.text);
    if (reason !== null) {
      drop(index, fieldName, owner.id, reason, GUIDE_HINT_REJECT_LABELS[reason] + "。");
      return;
    }

    const text = (hint.text as string).trim();
    hintsByField.set(fieldName, text);
    accepted += 1;
  });

  const nextSteps = steps.map(step => ({
    ...step,
    fields: step.fields.map(field => {
      const hint = hintsByField.get(field.name);
      return hint !== undefined && hint !== field.hint ? { ...field, hint } : field;
    }),
  }));

  return {
    steps: nextSteps,
    accepted,
    dropped,
    droppedCount: dropped.length,
    hintCount: hints.length,
  };
}
