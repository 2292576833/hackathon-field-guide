import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import { applyPrefill, markFieldOrigin, planSteps } from "./steps.ts";
import type { GuideStep } from "./steps.ts";
import { attachHints } from "./hints.ts";
import type { GuideSchema } from "./model.ts";

const SCHEMA: GuideSchema = {
  formId: "submission-form",
  fields: [
    { name: "title", label: "作品名称", type: "text", required: true, maxLength: 40 },
    { name: "summary", label: "一句话介绍", type: "text", required: false, maxLength: 20 },
    { name: "bio", label: "团队介绍", type: "textarea", required: true },
    { name: "notes", label: "补充说明", type: "textarea", required: false },
    { name: "track", label: "赛道", type: "select", required: true, options: ["AI 应用", "硬件"] },
    { name: "demoDay", label: "演示日期", type: "date", required: false },
    { name: "agree", label: "同意赛事规则", type: "checkbox", required: true },
    { name: "repo", label: "仓库地址", type: "text", required: false },
  ],
};

function steps(): readonly GuideStep[] { return planSteps(SCHEMA); }
function fieldNamed(list: readonly GuideStep[], name: string) {
  for (const step of list) for (const item of step.fields) if (item.name === name) return item;
  throw new Error("没有字段 " + name);
}
function rejectsCode(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal((error as DomainError).code, code);
    return true;
  });
}

test("text 预填成功并标 ai", () => {
  const result = applyPrefill(steps(), { title: " 我的作品 " });
  const title = fieldNamed(result.steps, "title");
  assert.equal(title.value, "我的作品");
  assert.equal(title.origin, "ai");
  assert.deepEqual(result.filledFields, [{ field: "title", stepId: "submission-form:step-1", stepIndex: 1, value: "我的作品", origin: "ai" }]);
  assert.deepEqual(result.skippedFields, []);
});

test("选填 textarea 可以预填", () => {
  const result = applyPrefill(steps(), { notes: "这里补充。" });
  assert.equal(fieldNamed(result.steps, "notes").value, "这里补充。");
  assert.equal(fieldNamed(result.steps, "notes").origin, "ai");
});

test("checkbox 一律不预填（勾选只能本人点）", () => {
  const result = applyPrefill(steps(), { agree: "true" });
  const agree = fieldNamed(result.steps, "agree");
  assert.equal(agree.value, null);
  assert.equal(agree.origin, "empty");
  assert.deepEqual(result.filledFields, []);
  assert.deepEqual(result.skippedFields, [{ field: "agree", reason: "checkbox", detail: "勾选只能由本人点，AI 不代勾。" }]);
});

test("必填的多行文本（创作型字段）不预填，留给本人写", () => {
  const result = applyPrefill(steps(), { bio: "AI 帮我写好的团队介绍。" });
  const bio = fieldNamed(result.steps, "bio");
  assert.equal(bio.value, null);
  assert.equal(bio.origin, "empty");
  assert.equal(result.skippedFields[0].field, "bio");
  assert.equal(result.skippedFields[0].reason, "creative_textarea");
});

test("date 与 select 可预填；select 不在候选项时按 not_in_options 跳过", () => {
  const ok = applyPrefill(steps(), { demoDay: "2026-11-01", track: "AI 应用" });
  assert.equal(fieldNamed(ok.steps, "demoDay").value, "2026-11-01");
  assert.equal(fieldNamed(ok.steps, "track").value, "AI 应用");

  const bad = applyPrefill(steps(), { track: "区块链" });
  assert.equal(fieldNamed(bad.steps, "track").value, null);
  assert.equal(bad.skippedFields[0].reason, "not_in_options");
  assert.match(bad.skippedFields[0].detail, /AI 应用/);
});

test("超长值按 too_long 跳过，不悄悄截断", () => {
  const result = applyPrefill(steps(), { summary: "这是一句超过二十个字的介绍，用来验证不会截断。" });
  assert.equal(fieldNamed(result.steps, "summary").value, null);
  assert.equal(result.skippedFields[0].reason, "too_long");
  assert.match(result.skippedFields[0].detail, /最多 20 字/);
});

test("空值与纯空白按 empty_value 跳过", () => {
  const result = applyPrefill(steps(), { title: "   ", repo: "" });
  assert.deepEqual(result.skippedFields.map(item => item.reason), ["empty_value", "empty_value"]);
  assert.equal(fieldNamed(result.steps, "title").value, null);
});

test("非文本值按 invalid_value_type 跳过", () => {
  const result = applyPrefill(steps(), { title: 42 as never });
  assert.equal(result.skippedFields[0].reason, "invalid_value_type");
  assert.equal(fieldNamed(result.steps, "title").value, null);
});

test("未知字段一律拒绝：预填不许发明 schema 之外的字段", () => {
  rejectsCode(() => applyPrefill(steps(), { aiInvented: "编出来的值" }), "FORM_GUIDE_UNKNOWN_FIELD");
  assert.throws(
    () => applyPrefill(steps(), { title: "好的", ghost: "x" }),
    (error: unknown) => {
      assert.match((error as Error).message, /ghost/);
      return true;
    },
  );
});

test("origin 标注正确：默认 ai、可指定 user、未预填保持 empty", () => {
  const result = applyPrefill(steps(), {
    title: { value: "确认过的标题", origin: "user" },
    repo: "https://example.test/repo",
  });
  assert.equal(fieldNamed(result.steps, "title").origin, "user");
  assert.equal(fieldNamed(result.steps, "repo").origin, "ai");
  assert.equal(fieldNamed(result.steps, "track").origin, "empty");
  assert.deepEqual(result.filledFields.map(item => item.origin), ["user", "ai"]);
});

test("本人已填的栏不被 AI 覆盖（user_value_kept）", () => {
  const drafted = applyPrefill(steps(), { title: { value: "本人写的", origin: "user" } });
  const second = applyPrefill(drafted.steps, { title: "AI 想改" });
  assert.equal(fieldNamed(second.steps, "title").value, "本人写的");
  assert.equal(second.skippedFields[0].reason, "user_value_kept");
  assert.equal(second.filledFields.length, 0);
});

test("filledFields 按步骤顺序排列，skippedFields 逐条给出原因", () => {
  const result = applyPrefill(steps(), {
    repo: "https://example.test/repo",
    title: "标题",
    agree: "true",
    bio: "AI 代笔",
  });
  assert.deepEqual(result.filledFields.map(item => item.field), ["title", "repo"]);
  assert.deepEqual(result.skippedFields.map(item => item.field), ["bio", "agree"]);
  assert.deepEqual(result.skippedFields.map(item => item.reason), ["creative_textarea", "checkbox"]);
});

test("不修改传入的步骤与值判定（纯函数）", () => {
  const original = steps();
  const snapshot = JSON.parse(JSON.stringify(original));
  const result = applyPrefill(original, { title: "标题" });
  assert.deepEqual(JSON.parse(JSON.stringify(original)), snapshot);
  assert.equal(fieldNamed(original, "title").value, null);
  assert.equal(fieldNamed(result.steps, "title").value, "标题");
});

test("预填保留已有提示（提示与预填互不覆盖）", () => {
  const hinted = attachHints(steps(), [{ field: "title", text: "写一个能让人记住的名字。" }]);
  const prefilled = applyPrefill(hinted.steps, { title: "已拟好的名字" });
  assert.equal(fieldNamed(prefilled.steps, "title").hint, "写一个能让人记住的名字。");
  assert.equal(fieldNamed(prefilled.steps, "title").value, "已拟好的名字");
});

test("markFieldOrigin：ai → user 撤掉标注并保留值；→ empty 清空值", () => {
  const prefilled = applyPrefill(steps(), { title: "AI 拟的标题" });
  const toUser = markFieldOrigin(prefilled.steps, "title", "user");
  assert.equal(fieldNamed(toUser, "title").origin, "user");
  assert.equal(fieldNamed(toUser, "title").value, "AI 拟的标题");
  const cleared = markFieldOrigin(prefilled.steps, "title", "empty");
  assert.equal(fieldNamed(cleared, "title").origin, "empty");
  assert.equal(fieldNamed(cleared, "title").value, null);
  rejectsCode(() => markFieldOrigin(prefilled.steps, "ghost", "user"), "FORM_GUIDE_UNKNOWN_FIELD");
});

test("prefill 形状非法时直接报错（null / 数组 / origin 不认识）", () => {
  rejectsCode(() => applyPrefill(steps(), null as never), "FORM_GUIDE_INVALID_PREFILL");
  rejectsCode(() => applyPrefill(steps(), [] as never), "FORM_GUIDE_INVALID_PREFILL");
  rejectsCode(() => applyPrefill(steps(), { title: { value: "x", origin: "robot" as never } }), "FORM_GUIDE_INVALID_PREFILL");
});
