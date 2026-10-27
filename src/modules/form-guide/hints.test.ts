import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import { attachHints, hintTextRejectReason, GUIDE_HINT_MAX_CHARS } from "./hints.ts";
import type { GuideHintInput } from "./hints.ts";
import { planSteps } from "./steps.ts";
import type { GuideStep } from "./steps.ts";
import type { GuideSchema, GuideSchemaField } from "./model.ts";

function field(name: string, overrides: Partial<GuideSchemaField> = {}): GuideSchemaField {
  return { name, label: "标签-" + name, type: "text", required: false, ...overrides };
}
function schema(fields: readonly GuideSchemaField[], formId = "registration-form"): GuideSchema {
  return { formId, fields };
}
/** 两屏：name/email/team 一屏，bio/agree 一屏（必填优先后可能不同，这里按实际结果取）。 */
function planned(): readonly GuideStep[] {
  return planSteps(schema([
    field("name", { required: true }), field("email", { required: true, type: "text" }),
    field("team"), field("bio", { type: "textarea" }), field("agree", { type: "checkbox" }),
    field("day", { type: "date" }),
  ]));
}
function hintOf(steps: readonly GuideStep[], name: string): string | null {
  for (const step of steps) for (const item of step.fields) if (item.name === name) return item.hint;
  throw new Error("没有字段 " + name);
}
const longText = (length: number) => "字".repeat(length);

test("合法提示挂到对应栏并计数", () => {
  const steps = planned();
  const result = attachHints(steps, [
    { field: "name", text: "写你证件上的名字，之后改起来麻烦。" },
    { field: "day", text: "选你确认能到场的日期。" },
  ]);
  assert.equal(result.accepted, 2);
  assert.equal(result.droppedCount, 0);
  assert.equal(result.hintCount, 2);
  assert.equal(hintOf(result.steps, "name"), "写你证件上的名字，之后改起来麻烦。");
  assert.equal(hintOf(result.steps, "day"), "选你确认能到场的日期。");
});

test("80 字接受、81 字按 too_long 丢弃（按码点计，不是 UTF-16 长度）", () => {
  const steps = planned();
  const ok = attachHints(steps, [{ field: "name", text: longText(GUIDE_HINT_MAX_CHARS) }]);
  assert.equal(ok.accepted, 1);
  const tooLong = attachHints(steps, [{ field: "name", text: longText(GUIDE_HINT_MAX_CHARS + 1) }]);
  assert.equal(tooLong.accepted, 0);
  assert.equal(tooLong.dropped[0].reason, "too_long");
  assert.equal(tooLong.droppedCount, 1);
});

test("空提示与纯空白按 empty_text 丢弃", () => {
  const steps = planned();
  const result = attachHints(steps, [{ field: "name", text: "   " }, { field: "name", text: "" }]);
  assert.equal(result.accepted, 0);
  assert.deepEqual(result.dropped.map(item => item.reason), ["empty_text", "empty_text"]);
  assert.equal(result.droppedCount, 2);
});

test("含换行或控制字符的提示按 control_character 丢弃", () => {
  const steps = planned();
  const result = attachHints(steps, [
    { field: "name", text: "第一行\n第二行" },
    { field: "name", text: "带\u0000控制符" },
    { field: "name", text: "带\u2028行分隔符" },
  ]);
  assert.equal(result.accepted, 0);
  assert.deepEqual(result.dropped.map(item => item.reason), ["control_character", "control_character", "control_character"]);
});

test("指向 schema 里没有的字段按 unknown_field 丢弃", () => {
  const steps = planned();
  const result = attachHints(steps, [{ field: "aiInventedField", text: "这句没有落点。" }]);
  assert.equal(result.accepted, 0);
  assert.equal(result.dropped[0].reason, "unknown_field");
  assert.equal(result.dropped[0].field, "aiInventedField");
});

test("指向别的步骤按 field_not_in_step 丢弃", () => {
  const steps = planned();
  const target = steps[0];
  const other = steps[1];
  assert.ok(other !== undefined, "需要至少两步：fixture 有 6 栏");
  const result = attachHints(steps, [{ field: target.fields[0].name, text: "这一栏不在那一步。", stepId: other.id }]);
  assert.equal(result.accepted, 0);
  assert.equal(result.dropped[0].reason, "field_not_in_step");
  assert.equal(result.dropped[0].stepId, other.id);
});

test("不存在的 stepId / stepIndex 按 unknown_step 丢弃", () => {
  const steps = planned();
  const result = attachHints(steps, [
    { field: "name", text: "步骤不存在。", stepId: "registration-form:step-99" },
    { field: "name", text: "序号不存在。", stepIndex: 99 },
  ]);
  assert.equal(result.accepted, 0);
  assert.deepEqual(result.dropped.map(item => item.reason), ["unknown_step", "unknown_step"]);
});

test("stepId 与 stepIndex 同时给出且一致时接受，不一致时丢弃", () => {
  const steps = planned();
  const first = steps[0];
  const ok = attachHints(steps, [{ field: first.fields[0].name, text: "这一步的第一栏。", stepId: first.id, stepIndex: first.index }]);
  assert.equal(ok.accepted, 1);
  const conflict = attachHints(steps, [{ field: first.fields[0].name, text: "两个指认打架。", stepId: first.id, stepIndex: steps[1].index }]);
  assert.equal(conflict.accepted, 0);
  assert.equal(conflict.dropped[0].reason, "field_not_in_step");
});

test("非法提示逐条丢弃并计数：合法的照常挂上，互不影响", () => {
  const steps = planned();
  const result = attachHints(steps, [
    { field: "name", text: "写证件上的名字。" },
    { field: "noSuchField", text: "编出来的字段。" },
    { field: "email", text: "" },
    { field: "team", text: longText(200) },
    { field: "day", text: "选你能到场的日期。" },
    { field: "agree", text: "有换行\n" },
  ]);
  assert.equal(result.hintCount, 6);
  assert.equal(result.accepted, 2);
  assert.equal(result.droppedCount, 4);
  assert.deepEqual(result.dropped.map(item => item.index), [1, 2, 3, 5]);
  assert.deepEqual(result.dropped.map(item => item.reason), ["unknown_field", "empty_text", "too_long", "control_character"]);
  assert.equal(hintOf(result.steps, "name"), "写证件上的名字。");
  assert.equal(hintOf(result.steps, "day"), "选你能到场的日期。");
  assert.equal(hintOf(result.steps, "email"), null);
});

test("同一栏重复给提示：先到先得，后到的按 duplicate_field 计数丢弃", () => {
  const steps = planned();
  const result = attachHints(steps, [
    { field: "name", text: "第一条。" },
    { field: "name", text: "第二条。" },
  ]);
  assert.equal(result.accepted, 1);
  assert.equal(result.droppedCount, 1);
  assert.equal(result.dropped[0].reason, "duplicate_field");
  assert.equal(hintOf(result.steps, "name"), "第一条。");
});

test("已经带提示的栏再挂也算重复（重复调用不叠加）", () => {
  const once = attachHints(planned(), [{ field: "name", text: "只保留这一条。" }]);
  const twice = attachHints(once.steps, [{ field: "name", text: "覆盖掉？" }]);
  assert.equal(twice.accepted, 0);
  assert.equal(twice.dropped[0].reason, "duplicate_field");
  assert.equal(hintOf(twice.steps, "name"), "只保留这一条。");
});

test("hints 不是数组时直接报错，不假装成功", () => {
  assert.throws(() => attachHints(planned(), null as never), (error: unknown) => (error as DomainError).code === "FORM_GUIDE_INVALID_HINTS");
});

test("不修改传入的步骤（原数组与新数组互不影响）", () => {
  const steps = planned();
  const result = attachHints(steps, [{ field: "name", text: "一句人话。" }]);
  assert.equal(hintOf(steps, "name"), null);
  assert.equal(hintOf(result.steps, "name"), "一句人话。");
});

test("hintTextRejectReason 与 attachHints 共用同一套规则", () => {
  assert.equal(hintTextRejectReason("一句正常的话。"), null);
  assert.equal(hintTextRejectReason("  "), "empty_text");
  assert.equal(hintTextRejectReason(42), "invalid_shape");
  assert.equal(hintTextRejectReason(longText(81)), "too_long");
  assert.equal(hintTextRejectReason("含\n换行"), "control_character");
});

test("提示只挂在字段上，步骤结构（id/栏数）不变", () => {
  const steps = planned();
  const result = attachHints(steps, [{ field: "email", text: "填你能收到信的邮箱。" }]);
  assert.deepEqual(result.steps.map(step => step.id), steps.map(step => step.id));
  assert.deepEqual(result.steps.map(step => step.fieldCount), steps.map(step => step.fieldCount));
});
