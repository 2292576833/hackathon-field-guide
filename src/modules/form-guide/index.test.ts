import assert from "node:assert/strict";
import test from "node:test";
import { buildFormGuide } from "./index.ts";
import { GUIDE_ORIGIN_LABELS, isAiDrafted } from "./model.ts";
import type { GuideSchema } from "./model.ts";

const SCHEMA: GuideSchema = {
  formId: "recruiting-post",
  fields: [
    { name: "role", label: "招募角色", type: "text", required: true },
    { name: "pitch", label: "一句话说明", type: "textarea", required: true },
    { name: "skills", label: "技能要求", type: "text", required: false, maxLength: 30 },
    { name: "contact", label: "联系方式", type: "select", required: false, options: ["站内信", "邮箱"] },
    { name: "confirm", label: "确认信息属实", type: "checkbox", required: true },
  ],
};

function fieldNamed(guide: ReturnType<typeof buildFormGuide>, name: string) {
  for (const step of guide.steps) for (const item of step.fields) if (item.name === name) return item;
  throw new Error("没有字段 " + name);
}

test("buildFormGuide 一次做完分步 / 预填 / 提示，并给出 AI 拟稿清单", () => {
  const guide = buildFormGuide({
    schema: SCHEMA,
    prefill: { role: "前端开发", skills: "React / TypeScript", pitch: "AI 代写的介绍" },
    hints: [
      { field: "role", text: "写清楚你要找的人做什么。" },
      { field: "ghost", text: "这一句没有落点。" },
    ],
  });
  assert.equal(guide.formId, "recruiting-post");
  assert.deepEqual(guide.steps.map(step => step.fieldCount), [3, 2]);
  assert.deepEqual(guide.aiDraftedFields, ["role", "skills"]);
  assert.deepEqual(guide.skippedFields.map(item => item.field), ["pitch"]);
  assert.equal(guide.skippedFields[0].reason, "creative_textarea");
  assert.equal(guide.acceptedHints, 1);
  assert.equal(guide.droppedHints.length, 1);
  assert.equal(guide.droppedHints[0].reason, "unknown_field");
  assert.equal(fieldNamed(guide, "role").hint, "写清楚你要找的人做什么。");
  assert.equal(fieldNamed(guide, "confirm").origin, "empty");
});

test("只传 schema 也能用：没有预填与提示时段落为空、步骤照常", () => {
  const guide = buildFormGuide({ schema: SCHEMA });
  assert.equal(guide.steps.length, 2);
  assert.deepEqual(guide.filledFields, []);
  assert.deepEqual(guide.skippedFields, []);
  assert.deepEqual(guide.droppedHints, []);
  assert.equal(guide.acceptedHints, 0);
  assert.deepEqual(guide.aiDraftedFields, []);
});

test("aiDraftedFields 不含本人确认的栏，标注文案来自同一份常量", () => {
  const guide = buildFormGuide({
    schema: SCHEMA,
    prefill: { role: { value: "后端开发", origin: "user" }, skills: "Go" },
  });
  assert.deepEqual(guide.aiDraftedFields, ["skills"]);
  assert.equal(GUIDE_ORIGIN_LABELS.ai, "AI 拟稿");
  assert.equal(isAiDrafted("ai"), true);
  assert.equal(isAiDrafted("user"), false);
});
