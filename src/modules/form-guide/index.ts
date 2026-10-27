/**
 * form-guide 公共出口
 *
 * 给 AI 工作台一个入口：buildFormGuide({ schema, steps, prefill, hints })。
 * 一次做完「分步 → 预填 → 提示」，仍然**不提交、不写库、不生成 HTML**；
 * 工作台拿到结果后负责渲染、让本人确认，再由根已有的表单写路径落草稿。
 */
import { DomainError } from "../../shared/errors.ts";
import { planSteps } from "./steps.ts";
import { applyPrefill } from "./steps.ts";
import { attachHints } from "./hints.ts";
import type { GuideSchema } from "./model.ts";
import type { GuidePrefillInput, GuideStep, PlanStepsOptions, PrefillFilledField, PrefillSkippedField } from "./steps.ts";
import type { DroppedGuideHint, GuideHintInput } from "./hints.ts";

export interface BuildFormGuideInput {
  /** 调用方提供的表单定义（模块不持有表单）。 */
  readonly schema: GuideSchema;
  readonly steps?: PlanStepsOptions;
  readonly prefill?: GuidePrefillInput;
  readonly hints?: readonly GuideHintInput[];
}

export interface FormGuide {
  readonly formId: string;
  readonly steps: readonly GuideStep[];
  readonly filledFields: readonly PrefillFilledField[];
  readonly skippedFields: readonly PrefillSkippedField[];
  readonly acceptedHints: number;
  readonly droppedHints: readonly DroppedGuideHint[];
  /**
   * 需要界面标注「AI 拟稿」并在写入草稿前由本人确认的栏（按步骤顺序）。
   * 本人改过的栏用 markFieldOrigin(steps, field, "user") 撤掉标注。
   */
  readonly aiDraftedFields: readonly string[];
}

export function buildFormGuide(input: BuildFormGuideInput): FormGuide {
  if (input === null || typeof input !== "object") {
    throw new DomainError("FORM_GUIDE_INVALID_SCHEMA", "buildFormGuide 需要一个 { schema } 对象。");
  }
  const planned = planSteps(input.schema, input.steps ?? {});
  const prefilled = input.prefill === undefined
    ? { steps: planned, filledFields: [] as readonly PrefillFilledField[], skippedFields: [] as readonly PrefillSkippedField[] }
    : applyPrefill(planned, input.prefill);
  const hinted = input.hints === undefined
    ? { steps: prefilled.steps, accepted: 0, dropped: [] as readonly DroppedGuideHint[] }
    : attachHints(prefilled.steps, input.hints);

  return {
    formId: input.schema.formId,
    steps: hinted.steps,
    filledFields: prefilled.filledFields,
    skippedFields: prefilled.skippedFields,
    acceptedHints: hinted.accepted,
    droppedHints: hinted.dropped,
    aiDraftedFields: prefilled.filledFields
      .filter(entry => entry.origin === "ai")
      .map(entry => entry.field),
  };
}

export * from "./model.ts";
export * from "./steps.ts";
export * from "./hints.ts";
