import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import { planSteps, stepLabel, GUIDE_MAX_PER_STEP, GUIDE_MIN_PER_STEP } from "./steps.ts";
import type { GuideSchema, GuideSchemaField } from "./model.ts";

function field(name: string, overrides: Partial<GuideSchemaField> = {}): GuideSchemaField {
  return { name, label: "标签-" + name, type: "text", required: false, ...overrides };
}
function schema(fields: readonly GuideSchemaField[], formId = "registration-form"): GuideSchema {
  return { formId, fields };
}
function rejectsCode(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof DomainError, "应当抛 DomainError");
    assert.equal((error as DomainError).code, code);
    return true;
  });
}
const allFields = (steps: ReturnType<typeof planSteps>) => steps.flatMap(step => step.fields);
const stepOf = (steps: ReturnType<typeof planSteps>, name: string): number => {
  const found = steps.find(step => step.fields.some(item => item.name === name));
  assert.ok(found !== undefined, "字段 " + name + " 应当出现在某一步");
  return found.index;
};

test("分步不丢字段：每个字段恰好出现一次，schemaIndex 完整", () => {
  const fields = Array.from({ length: 13 }, (_, i) => field("f" + i, { required: i % 3 === 0 }));
  const steps = planSteps(schema(fields));
  const names = allFields(steps).map(item => item.name);
  assert.equal(names.length, 13);
  assert.deepEqual([...names].sort(), fields.map(item => item.name).sort());
  assert.deepEqual(allFields(steps).map(item => item.schemaIndex).sort((a, b) => a - b), [...Array(13).keys()]);
});

test("每步 2–4 栏：2 到 17 栏都落在范围内", () => {
  for (let count = 2; count <= 17; count += 1) {
    const fields = Array.from({ length: count }, (_, i) => field("f" + i));
    const steps = planSteps(schema(fields));
    for (const step of steps) {
      assert.ok(step.fields.length >= GUIDE_MIN_PER_STEP && step.fields.length <= GUIDE_MAX_PER_STEP,
        count + " 栏切成 " + step.fields.map(item => item.name).join(",") + " 时不满足每步 2–4 栏");
    }
    assert.equal(allFields(steps).length, count);
  }
});

test("必填优先：任一必填栏的步序号 ≤ 任一选填栏的步序号", () => {
  const fields = [
    field("o0"), field("r1", { required: true }), field("o2"), field("r3", { required: true }),
    field("o4"), field("r5", { required: true }), field("o6"), field("o7"), field("r8", { required: true }, ),
    field("o9"),
  ];
  const steps = planSteps(schema(fields));
  const requiredAt = fields.filter(item => item.required).map(item => stepOf(steps, item.name));
  const optionalAt = fields.filter(item => !item.required).map(item => stepOf(steps, item.name));
  assert.ok(Math.max(...requiredAt) <= Math.min(...optionalAt),
    "必填步序号 " + requiredAt.join(",") + " 应全部早于选填步序号 " + optionalAt.join(","));
  assert.equal(stepOf(steps, "r1"), 1);
});

test("顺序与 schema 一致：必填已在前时，铺平后逐栏等于 schema 顺序", () => {
  const fields = [field("a", { required: true }), field("b", { required: true }), field("c", { required: true }),
    field("d"), field("e"), field("f")];
  const steps = planSteps(schema(fields));
  assert.deepEqual(allFields(steps).map(item => item.name), fields.map(item => item.name));
  assert.equal(steps.length, 2);
});

test("步内顺序与 schema 一致：即使某步同时含必填与选填，也按原顺序排列", () => {
  const fields = [field("o0"), field("r1", { required: true }), field("o2")];
  const steps = planSteps(schema(fields));
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0].fields.map(item => item.name), ["o0", "r1", "o2"]);
});

test("schema 为空时返回空步骤而不是抛错", () => {
  assert.deepEqual(planSteps(schema([])), []);
  assert.deepEqual(planSteps({ formId: "submit-form", fields: [] }), []);
});

test("整张表单只有 1 栏时允许 1 栏一步（唯一例外）", () => {
  const steps = planSteps(schema([field("only", { required: true })]));
  assert.equal(steps.length, 1);
  assert.equal(steps[0].fieldCount, 1);
  assert.equal(steps[0].requiredCount, 1);
});

test("未知 formId 拒绝：不在调用方白名单里就 404，模块不猜表", () => {
  const guide = schema([field("a"), field("b")], "registration-form");
  rejectsCode(() => planSteps(guide, { allowedFormIds: ["submit-form", "recruiting-post"] }), "FORM_GUIDE_UNKNOWN_FORM");
  assert.throws(() => planSteps(guide, { allowedFormIds: [] }), (error: unknown) => (error as DomainError).status === 404);
  assert.equal(planSteps(guide, { allowedFormIds: ["registration-form"] }).length, 1);
});

test("planSteps 默认不设 formId 白名单（schema 由调用方直接传入）", () => {
  assert.equal(planSteps(schema([field("a"), field("b")], "any-form")).length, 1);
});

test("非法 schema 拒绝：重名字段 / 空 formId / 未知 type", () => {
  rejectsCode(() => planSteps(schema([field("a"), field("a")])), "FORM_GUIDE_INVALID_SCHEMA");
  rejectsCode(() => planSteps({ formId: " ", fields: [field("a")] }), "FORM_GUIDE_INVALID_SCHEMA");
  rejectsCode(() => planSteps(schema([field("a", { type: "richtext" as never })])), "FORM_GUIDE_INVALID_SCHEMA");
  rejectsCode(() => planSteps(schema([field("a", { type: "select" })])), "FORM_GUIDE_INVALID_SCHEMA");
  rejectsCode(() => planSteps(schema([field("a", { type: "checkbox", maxLength: 10 })])), "FORM_GUIDE_INVALID_SCHEMA");
  rejectsCode(() => planSteps(schema([field("a"), field("a")])), "FORM_GUIDE_INVALID_SCHEMA");
});

test("步骤 id 与栏序确定：同样输入两次结果完全一致", () => {
  const guide = schema([field("a", { required: true }), field("b"), field("c")], "same-form");
  assert.deepEqual(planSteps(guide), planSteps(guide));
  assert.deepEqual(planSteps(guide).map(step => step.id), ["same-form:step-1"]);
});

test("不修改调用方的 schema", () => {
  const guide = schema([field("a", { required: true }), field("b")]);
  const snapshot = JSON.parse(JSON.stringify(guide));
  planSteps(guide);
  assert.deepEqual(JSON.parse(JSON.stringify(guide)), snapshot);
});

test("requiredFirst: false 时完全按 schema 顺序切步", () => {
  const fields = [field("o0"), field("r1", { required: true }), field("o2"), field("r3", { required: true }), field("o4")];
  const steps = planSteps(schema(fields), { requiredFirst: false });
  assert.deepEqual(allFields(steps).map(item => item.name), fields.map(item => item.name));
});

test("每步的 fieldCount / requiredCount / prefillableCount 与内容一致", () => {
  const fields = [field("a", { required: true }), field("b"), field("c", { type: "checkbox" }), field("d", { type: "select", options: ["x"] })];
  const [step] = planSteps(schema(fields));
  assert.equal(step.fieldCount, 4);
  assert.equal(step.requiredCount, 1);
  assert.equal(step.prefillableCount, 3);
  assert.equal(stepLabel(step, 1), "第 1/1 步");
});

test("每步栏数选项非法时拒绝（越界、倒挂、切不开）", () => {
  const guide = schema(Array.from({ length: 6 }, (_, i) => field("f" + i)));
  rejectsCode(() => planSteps(guide, { minPerStep: 1 }), "FORM_GUIDE_INVALID_OPTIONS");
  rejectsCode(() => planSteps(guide, { maxPerStep: 5 }), "FORM_GUIDE_INVALID_OPTIONS");
  rejectsCode(() => planSteps(guide, { minPerStep: 4, maxPerStep: 2 }), "FORM_GUIDE_INVALID_OPTIONS");
  const five = schema(Array.from({ length: 5 }, (_, i) => field("f" + i)));
  rejectsCode(() => planSteps(five, { minPerStep: 3, maxPerStep: 4 }), "FORM_GUIDE_INVALID_OPTIONS");
});
