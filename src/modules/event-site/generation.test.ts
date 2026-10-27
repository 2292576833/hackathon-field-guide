import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { defaultPageSpec } from "./blocks.ts";
import { DomainError } from "../../shared/errors.ts";
import {
  EVENT_SITE_GENERATION_MAX_OUTPUT_TOKENS, EVENT_SITE_MAX_SUGGESTIONS, EVENT_SITE_SUGGESTION_MAX_OUTPUT_TOKENS,
  generatePage, parseGenerationIntent, suggestForSpec,
} from "./generation.ts";
import type { EventSiteModelPort } from "./generation.ts";
import { reviewSpec } from "./policy.ts";
import { EVENT_SITE_GENERATION_SYSTEM_PROMPT } from "./prompt.ts";
import { normalizeSpec } from "./validation.ts";

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

const code = (expected: string, status = 422) => (error: unknown): boolean => {
  assert.ok(error instanceof DomainError, "应为 DomainError：" + String(error));
  assert.equal(error.code, expected);
  assert.equal(error.status, status);
  return true;
};

const intentOf = (over: Record<string, unknown> = {}) => ({
  eventTitle: "秋季校园黑客松",
  kind: "校园赛",
  audience: "第一次参赛的本科生",
  emphasis: ["评审标准"],
  tone: "清楚、鼓励",
  notes: null,
  ...over,
});

/** 一份合法、每块都带 priority 与 collapse 的整页草案。 */
const validSpec = () => ({
  version: 1,
  blocks: [
    {
      kind: "countdown", id: "b1", variant: "banner", priority: 5, collapse: false,
      binding: { source: "eventSchedule", field: "registrationCloses" },
    },
    {
      kind: "highlights", id: "b2", variant: "grid", priority: 4, collapse: true,
      heading: "两天做出可演示的原型", items: [{ heading: "组队", text: "三人一组" }],
    },
    { kind: "actionRegister", id: "b3", variant: "primary", priority: 5, collapse: false, action: "register" },
  ],
});

const containerSpec = () => ({
  version: 1,
  blocks: [
    {
      kind: "highlights", id: "h1", variant: "grid", priority: 4, collapse: false,
      heading: "要点", items: [{ heading: "一", text: "说明" }],
    },
    {
      kind: "aiBlock", id: "ai1", variant: "plain", priority: 3, collapse: false,
      manages: ["h1"], duty: "只管语气", mode: "edit", fullPage: false,
    },
  ],
});

interface ModelCall {
  readonly systemPrompt: string;
  readonly input: string;
  readonly maxOutputTokens: number;
}

function modelOf(
  content: unknown,
  options: { readonly available?: boolean; readonly modelVersion?: string; readonly usage?: unknown } = {},
) {
  const calls: ModelCall[] = [];
  const model: EventSiteModelPort = {
    available: options.available ?? true,
    modelVersion: options.modelVersion ?? "fixture-model-v1",
    async complete(request) {
      calls.push({ systemPrompt: request.systemPrompt, input: request.input, maxOutputTokens: request.maxOutputTokens });
      const response: { readonly content: unknown; readonly usage?: unknown } = options.usage === undefined
        ? { content: content }
        : { content: content, usage: options.usage };
      return response;
    },
  };
  return { model, calls };
}

const throwingModel = (message = "provider secret：https://internal.example/api?key=sk-test"): EventSiteModelPort => ({
  available: true,
  modelVersion: "fixture-throwing-v1",
  async complete() {
    throw new Error(message);
  },
});

const envelopeOf = (suggestions: readonly unknown[]) => ({ suggestions: suggestions });

/* ------------------------------------------------------------------ *
 * 一键生成：可用性与失败行为
 * ------------------------------------------------------------------ */

test("一键生成：端口未注入 / available:false / 没有版本号 → 503，并说明人工流程照常", async () => {
  await assert.rejects(generatePage({ intent: intentOf() }), (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, "EVENT_SITE_MODEL_UNAVAILABLE");
    assert.equal(error.status, 503);
    assert.match(error.message, /人工流程照常/);
    return true;
  });
  await assert.rejects(generatePage({ intent: intentOf(), model: null }), code("EVENT_SITE_MODEL_UNAVAILABLE", 503));
  const off = modelOf(validSpec(), { available: false });
  await assert.rejects(generatePage({ intent: intentOf(), model: off.model }), code("EVENT_SITE_MODEL_UNAVAILABLE", 503));
  assert.equal(off.calls.length, 0, "不可用时不得调用模型");
  const blankVersion = modelOf(validSpec(), { modelVersion: "   " });
  await assert.rejects(
    generatePage({ intent: intentOf(), model: blankVersion.model }), code("EVENT_SITE_MODEL_UNAVAILABLE", 503),
  );
  assert.equal(blankVersion.calls.length, 0);
});

test("一键生成：合法输出 → spec + findings + modelVersion + usage，且只调用一次", async () => {
  const fixture = modelOf(validSpec(), { usage: { inputTokens: 120, outputTokens: 340 } });
  const result = await generatePage({ model: fixture.model, intent: intentOf() });

  assert.deepEqual(result.spec, normalizeSpec(validSpec()));
  assert.deepEqual(result.findings.map(finding => finding.code), reviewSpec(validSpec()).map(finding => finding.code));
  assert.equal(result.modelVersion, "fixture-model-v1");
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 340 });
  assert.equal(result.usedFallback, false);
  assert.equal(result.failure, null);
  assert.equal(fixture.calls.length, 1);

  const call = fixture.calls[0];
  assert.equal(call.systemPrompt, EVENT_SITE_GENERATION_SYSTEM_PROMPT);
  assert.equal(call.input.includes("秋季校园黑客松"), true);
  assert.equal(call.input.includes(EVENT_SITE_GENERATION_SYSTEM_PROMPT), false, "用户输入不能夹带 system 提示");
  assert.equal(call.maxOutputTokens, EVENT_SITE_GENERATION_MAX_OUTPUT_TOKENS);
});

test("一键生成：端口没给可核对的用量就给 null，不猜也不补零", async () => {
  const none = await generatePage({ model: modelOf(validSpec()).model, intent: intentOf() });
  assert.equal(none.usage, null);
  const broken = modelOf(validSpec(), { usage: { inputTokens: -1, outputTokens: 2 } });
  const result = await generatePage({ model: broken.model, intent: intentOf() });
  assert.equal(result.usage, null);
  const partial = modelOf(validSpec(), { usage: { inputTokens: 3 } });
  assert.equal((await generatePage({ model: partial.model, intent: intentOf() })).usage, null);
});

test("一键生成：模型返回非对象 → 默认退回默认模板（不重试、不修），fallback:error 则 503", async () => {
  const fixture = modelOf("这不是 JSON");
  const result = await generatePage({ model: fixture.model, intent: intentOf() });
  assert.equal(result.usedFallback, true);
  assert.deepEqual(result.spec, defaultPageSpec());
  assert.equal(result.failure?.code, "EVENT_SITE_INVALID_SPEC");
  assert.deepEqual(result.findings.map(finding => finding.code), reviewSpec(defaultPageSpec()).map(finding => finding.code));
  assert.equal(fixture.calls.length, 1, "失败不静默重试");

  const strict = modelOf("这不是 JSON");
  await assert.rejects(
    generatePage({ model: strict.model, intent: intentOf(), fallback: "error" }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "EVENT_SITE_MODEL_RESULT_INVALID");
      assert.equal(error.status, 503);
      assert.match(error.message, /EVENT_SITE_INVALID_SPEC/);
      assert.match(error.message, /没有做任何自动修正/);
      return true;
    },
  );
  assert.equal(strict.calls.length, 1);
});

test("一键生成：未知 kind 与未知字段一律拒绝（复用 P1a 错误码，不做尽力修正）", async () => {
  const unknownKind = modelOf({
    version: 1,
    blocks: [{ kind: "videoBlock", id: "v1", variant: "wide", priority: 4, collapse: false }],
  });
  const result = await generatePage({ model: unknownKind.model, intent: intentOf() });
  assert.equal(result.usedFallback, true);
  assert.equal(result.failure?.code, "EVENT_SITE_UNKNOWN_BLOCK_KIND");

  const unknownField = modelOf({
    version: 1,
    blocks: [{
      kind: "richText", id: "r1", variant: "prose", priority: 3, collapse: false, text: "一句话", html: "<b>x</b>",
    }],
  });
  assert.equal((await generatePage({ model: unknownField.model, intent: intentOf() })).failure?.code,
    "EVENT_SITE_UNKNOWN_BLOCK_FIELD");

  const layoutField = modelOf({
    version: 1,
    blocks: [{ kind: "richText", id: "r1", variant: "prose", priority: 3, collapse: false, text: "一句话", width: "1200px" }],
  });
  assert.equal((await generatePage({ model: layoutField.model, intent: intentOf() })).failure?.code,
    "EVENT_SITE_UNKNOWN_BLOCK_FIELD");
});

test("一键生成：事实类区块必须 binding，手写事实值被拒", async () => {
  const handwritten = modelOf({
    version: 1,
    blocks: [{
      kind: "countdown", id: "c1", variant: "compact", priority: 5, collapse: false,
      heading: "距离报名截止 10 月 20 日", text: "报名截止 2026-10-20",
      binding: { source: "eventSchedule", field: "registrationCloses" },
    }],
  });
  assert.equal((await generatePage({ model: handwritten.model, intent: intentOf() })).failure?.code,
    "EVENT_SITE_FACT_VALUE_NOT_ALLOWED");

  const noBinding = modelOf({
    version: 1,
    blocks: [{ kind: "timeline", id: "t1", variant: "vertical", priority: 4, collapse: false }],
  });
  assert.equal((await generatePage({ model: noBinding.model, intent: intentOf() })).failure?.code,
    "EVENT_SITE_BINDING_REQUIRED");

  const wrongSource = modelOf({
    version: 1,
    blocks: [{
      kind: "timeline", id: "t1", variant: "vertical", priority: 4, collapse: false,
      binding: { source: "eventFaq", field: "scheduleNodes" },
    }],
  });
  assert.equal((await generatePage({ model: wrongSource.model, intent: intentOf() })).failure?.code,
    "EVENT_SITE_BINDING_INVALID");
});

test("一键生成：超限值一律拒绝（内容区块、AI 组件、文案长度）", async () => {
  const manyContent = {
    version: 1,
    blocks: Array.from({ length: 21 }, (_unused, index) => ({
      kind: "richText", id: "r" + String(index + 1), variant: "prose", priority: 3, collapse: false,
      text: "第 " + String(index + 1) + " 段",
    })),
  };
  assert.equal((await generatePage({ model: modelOf(manyContent).model, intent: intentOf() })).failure?.code,
    "EVENT_SITE_TOO_MANY_BLOCKS");

  const fourContainers = {
    version: 1,
    blocks: [
      ...["c1", "c2", "c3", "c4"].map(id => ({
        kind: "highlights", id: id, variant: "grid", priority: 3, collapse: false,
        heading: "要点", items: [{ heading: "一", text: "说明" }],
      })),
      ...["ai1", "ai2", "ai3", "ai4"].map((id, index) => ({
        kind: "aiBlock", id: id, variant: "plain", priority: 3, collapse: false,
        manages: ["c" + String(index + 1)], duty: "只管语气", mode: "edit", fullPage: false,
      })),
    ],
  };
  assert.equal((await generatePage({ model: modelOf(fourContainers).model, intent: intentOf() })).failure?.code,
    "EVENT_SITE_AI_TOO_MANY");

  const tooLong = {
    version: 1,
    blocks: [{ kind: "richText", id: "r1", variant: "prose", priority: 3, collapse: false, text: "字".repeat(2001) }],
  };
  assert.equal((await generatePage({ model: modelOf(tooLong).model, intent: intentOf() })).failure?.code,
    "EVENT_SITE_TEXT_TOO_LONG");
});

test("一键生成：省掉 priority / collapse 就等于让引擎猜手机语义，直接拒绝", async () => {
  const missing = modelOf({
    version: 1,
    blocks: [{ kind: "richText", id: "r1", variant: "prose", text: "一句话" }],
  });
  const result = await generatePage({ model: missing.model, intent: intentOf() });
  assert.equal(result.usedFallback, true);
  assert.equal(result.failure?.code, "EVENT_SITE_INVALID_PRIORITY");

  const noCollapse = modelOf({
    version: 1,
    blocks: [{ kind: "richText", id: "r1", variant: "prose", priority: 3, text: "一句话" }],
  });
  assert.equal((await generatePage({ model: noCollapse.model, intent: intentOf() })).failure?.code,
    "EVENT_SITE_INVALID_SPEC");
});

test("一键生成：模型调用抛错 → 503，且不泄露提供方原文", async () => {
  await assert.rejects(generatePage({ model: throwingModel(), intent: intentOf() }), (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, "EVENT_SITE_MODEL_UNAVAILABLE");
    assert.equal(error.status, 503);
    assert.equal(error.message.includes("provider secret"), false);
    assert.equal(error.message.includes("sk-test"), false);
    assert.match(error.message, /人工流程照常/);
    return true;
  });
});

test("一键生成：意图必须是封闭结构（非法 kind / 未知字段 / 超限 / 非对象）", async () => {
  const fixture = modelOf(validSpec());
  const model = fixture.model;
  await assert.rejects(generatePage({ model, intent: "校园赛" }), code("EVENT_SITE_GENERATION_INTENT_INVALID"));
  await assert.rejects(generatePage({ model, intent: intentOf({ kind: "校内赛" }) }), code("EVENT_SITE_GENERATION_INTENT_KIND_UNKNOWN"));
  await assert.rejects(generatePage({ model, intent: intentOf({ severity: "high" }) }), code("EVENT_SITE_GENERATION_INTENT_INVALID"));
  await assert.rejects(generatePage({ model, intent: intentOf({ eventTitle: "字".repeat(121) }) }), code("EVENT_SITE_GENERATION_INTENT_TOO_LONG"));
  await assert.rejects(generatePage({ model, intent: intentOf({ audience: "有\u0000控制字符" }) }), code("EVENT_SITE_GENERATION_INTENT_INVALID"));
  await assert.rejects(generatePage({ model, intent: intentOf({ emphasis: Array.from({ length: 9 }, (_u, i) => "要点" + String(i)) }) }),
    code("EVENT_SITE_GENERATION_INTENT_TOO_LONG"));
  await assert.rejects(generatePage({ model, intent: intentOf({ emphasis: "评审标准" }) }), code("EVENT_SITE_GENERATION_INTENT_INVALID"));
  await assert.rejects(generatePage({ model, intent: intentOf({ eventTitle: "   " }) }), code("EVENT_SITE_GENERATION_INTENT_INVALID"));
  await assert.rejects(generatePage({ model, intent: intentOf(), fallback: "retry" as never }), code("EVENT_SITE_GENERATION_OPTIONS_INVALID"));
  assert.equal(fixture.calls.length, 0, "意图不合法时不得调用模型");
});

test("意图归一：去空白、emphasis 去重保序，未知缺省写清楚", () => {
  const parsed = parseGenerationIntent({
    eventTitle: "  校园赛  ", kind: "其他", audience: " 社区开发者 ",
    emphasis: ["FAQ", "FAQ", " ", "评审标准"], tone: " 轻松 ", notes: null,
  });
  assert.deepEqual(parsed, {
    eventTitle: "校园赛", kind: "其他", audience: "社区开发者",
    emphasis: ["FAQ", "评审标准"], tone: "轻松", notes: null,
  });
  assert.deepEqual(parseGenerationIntent(intentOf({ emphasis: undefined })).emphasis, []);
});

/* ------------------------------------------------------------------ *
 * 生成助手建议：只建议、不自动改、patch 封闭校验
 * ------------------------------------------------------------------ */

test("建议：端口未注入 / available:false → 503", async () => {
  await assert.rejects(suggestForSpec({ spec: validSpec() }), code("EVENT_SITE_MODEL_UNAVAILABLE", 503));
  const off = modelOf(envelopeOf([]), { available: false });
  await assert.rejects(suggestForSpec({ model: off.model, spec: validSpec() }), code("EVENT_SITE_MODEL_UNAVAILABLE", 503));
  assert.equal(off.calls.length, 0);
});

test("建议：纯文字建议原样返回，当前规格不被修改", async () => {
  const current = validSpec();
  const snapshot = JSON.stringify(current);
  const fixture = modelOf(envelopeOf([
    { id: "s1", title: "把要点压到三条", rationale: "一屏读得完，报名按钮更容易被看到。" },
  ]), { usage: { inputTokens: 40, outputTokens: 60 } });
  const result = await suggestForSpec({ model: fixture.model, spec: current });

  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].id, "s1");
  assert.equal(result.suggestions[0].patch, undefined);
  assert.equal(result.dropped, 0);
  assert.equal(JSON.stringify(current), snapshot, "只建议，不自动改");
  assert.equal(result.modelVersion, "fixture-model-v1");
  assert.deepEqual(result.usage, { inputTokens: 40, outputTokens: 60 });
  assert.deepEqual(result.findings.map(finding => finding.code), reviewSpec(current).map(finding => finding.code));
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].systemPrompt.includes("最多 3 条"), true);
  assert.equal(fixture.calls[0].input.includes("\"blocks\""), true);
  assert.equal(fixture.calls[0].maxOutputTokens, EVENT_SITE_SUGGESTION_MAX_OUTPUT_TOKENS);
});

test("建议：replace_block 通过整页封闭校验，并回传规范化后的区块", async () => {
  const current = validSpec();
  const fixture = modelOf(envelopeOf([{
    id: "s1", title: "把要点改成列表", rationale: "三条以上用列表更好扫读。",
    patch: {
      kind: "replace_block", blockId: "b2",
      block: {
        kind: "highlights", id: "b2", variant: "list", priority: 4, collapse: false,
        heading: "两天做出可演示的原型", items: [{ heading: "组队", text: "三人一组" }, { heading: "取舍", text: "先做能演示的" }],
      },
    },
  }]));
  const result = await suggestForSpec({ model: fixture.model, spec: current });
  assert.equal(result.dropped, 0);
  const patch = result.suggestions[0].patch;
  assert.ok(patch);
  assert.equal(patch.kind, "replace_block");
  assert.equal(patch.blockId, "b2");
  assert.equal(patch.block?.id, "b2");
  assert.equal(patch.block?.kind, "highlights");
  assert.equal((patch.block as { variant: string }).variant, "list");
  assert.equal(JSON.stringify(current), JSON.stringify(validSpec()), "输入规格不被改动");
});

test("建议：add_block 与 remove_block 都能过校验，且不写任何东西", async () => {
  const added = await suggestForSpec({
    model: modelOf(envelopeOf([{
      id: "s1", title: "补一段报名说明", rationale: "选手常问报名后做什么。",
      patch: {
        kind: "add_block",
        block: { kind: "richText", id: "b4", variant: "prose", priority: 3, collapse: false, text: "报名后请在平台内加入队伍。" },
      },
    }])).model,
    spec: validSpec(),
  });
  assert.equal(added.dropped, 0);
  assert.equal(added.suggestions[0].patch?.kind, "add_block");
  assert.equal(added.suggestions[0].patch?.blockId, undefined);
  assert.equal(added.suggestions[0].patch?.block?.id, "b4");

  const removed = await suggestForSpec({
    model: modelOf(envelopeOf([{
      id: "s2", title: "去掉重复的要点", rationale: "这一页只留报名入口也成立。",
      patch: { kind: "remove_block", blockId: "b2" },
    }])).model,
    spec: validSpec(),
  });
  assert.equal(removed.dropped, 0);
  assert.equal(removed.suggestions[0].patch?.kind, "remove_block");
  assert.equal(removed.suggestions[0].patch?.blockId, "b2");
});

test("建议：非法 patch 被整条丢弃并计入 dropped（不修一修再用）", async () => {
  const cases: unknown[] = [
    { id: "s1", title: "删一个不存在的块", rationale: "r", patch: { kind: "remove_block", blockId: "nope" } },
    {
      id: "s2", title: "加一个表外类型", rationale: "r",
      patch: { kind: "add_block", block: { kind: "videoBlock", id: "v1", variant: "wide", priority: 3, collapse: false } },
    },
    {
      id: "s3", title: "手写报名截止", rationale: "r",
      patch: {
        kind: "add_block",
        block: { kind: "countdown", id: "c9", variant: "compact", priority: 5, collapse: false, text: "报名截止 2026-10-20" },
      },
    },
    {
      id: "s4", title: "替换块但编号对不上", rationale: "r",
      patch: {
        kind: "replace_block", blockId: "b2",
        block: { kind: "richText", id: "b9", variant: "prose", priority: 3, collapse: false, text: "x" },
      },
    },
    { id: "s5", title: "未知 patch 类型", rationale: "r", patch: { kind: "delete_page" } },
    { id: "s6", title: "patch 未知字段", rationale: "r", patch: { kind: "remove_block", blockId: "b2", href: "https://x" } },
    { id: "s7", title: "动作跳板改目标", rationale: "r", patch: { kind: "replace_block", blockId: "b3", block: { kind: "actionRegister", id: "b3", variant: "primary", priority: 5, collapse: false, action: "submit" } } },
    { id: "s8", title: "删除表外上限", rationale: "r", patch: { kind: "remove_block", blockId: "b2", block: {} } },
  ];
  const result = await suggestForSpec({ model: modelOf(envelopeOf(cases)).model, spec: validSpec() });
  assert.equal(result.suggestions.length, 0);
  assert.equal(result.dropped, cases.length);
});

test("建议：删掉被 AI 组件管辖的块会让整页不合法，同样丢弃", async () => {
  const result = await suggestForSpec({
    model: modelOf(envelopeOf([{
      id: "s1", title: "删掉被 AI 组件框住的要点", rationale: "看着多余。",
      patch: { kind: "remove_block", blockId: "h1" },
    }])).model,
    spec: containerSpec(),
  });
  assert.equal(result.suggestions.length, 0);
  assert.equal(result.dropped, 1);
});

test("建议：非法建议字段 / HTML 标题 / 重复 id 都被丢弃", async () => {
  const result = await suggestForSpec({
    model: modelOf(envelopeOf([
      { id: "s1", title: "正常建议", rationale: "有效。" },
      { id: "s1", title: "重复编号", rationale: "应该被丢。" },
      { id: "s2", title: "把 <b>标题</b> 改短", rationale: "含 HTML。" },
      { id: "s3", title: "多了个字段", rationale: "未知字段。", target: "b2" },
      { id: "s4", title: "", rationale: "标题为空。" },
      { id: "s5", title: "缺少理由" },
      "不是对象",
    ])).model,
    spec: validSpec(),
  });
  assert.deepEqual(result.suggestions.map(suggestion => suggestion.id), ["s1"]);
  assert.equal(result.dropped, 6);
});

test("建议：超过 3 条只回前 3 条，其余计入 dropped（不静默截断）", async () => {
  const many = Array.from({ length: 5 }, (_unused, index) => ({
    id: "s" + String(index + 1), title: "建议 " + String(index + 1), rationale: "理由 " + String(index + 1),
  }));
  const result = await suggestForSpec({ model: modelOf(envelopeOf(many)).model, spec: validSpec() });
  assert.equal(result.suggestions.length, EVENT_SITE_MAX_SUGGESTIONS);
  assert.deepEqual(result.suggestions.map(suggestion => suggestion.id), ["s1", "s2", "s3"]);
  assert.equal(result.dropped, 2);
  assert.equal(EVENT_SITE_MAX_SUGGESTIONS, 3);
});

test("建议：输出信封坏掉 → 503（非对象 / 缺 suggestions / 多字段）", async () => {
  await assert.rejects(suggestForSpec({ model: modelOf("建议如下").model, spec: validSpec() }),
    code("EVENT_SITE_MODEL_RESULT_INVALID", 503));
  await assert.rejects(suggestForSpec({ model: modelOf({ items: [] }).model, spec: validSpec() }),
    code("EVENT_SITE_MODEL_RESULT_INVALID", 503));
  await assert.rejects(suggestForSpec({ model: modelOf({ suggestions: [], extra: true }).model, spec: validSpec() }),
    code("EVENT_SITE_MODEL_RESULT_INVALID", 503));
  await assert.rejects(suggestForSpec({ model: modelOf({ suggestions: "s1" }).model, spec: validSpec() }),
    code("EVENT_SITE_MODEL_RESULT_INVALID", 503));
});

test("建议：当前规格本身不合法 → 直接抛 P1a 的 422，不调用模型", async () => {
  const fixture = modelOf(envelopeOf([]));
  await assert.rejects(
    suggestForSpec({ model: fixture.model, spec: { version: 1, blocks: [{ kind: "videoBlock", id: "v1" }] } }),
    code("EVENT_SITE_UNKNOWN_BLOCK_KIND"),
  );
  await assert.rejects(suggestForSpec({ model: fixture.model, spec: "不是规格" }), code("EVENT_SITE_INVALID_SPEC"));
  assert.equal(fixture.calls.length, 0);
});

test("建议：模型抛错 → 503，不泄露提供方原文", async () => {
  await assert.rejects(suggestForSpec({ model: throwingModel(), spec: validSpec() }), (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, "EVENT_SITE_MODEL_UNAVAILABLE");
    assert.equal(error.status, 503);
    assert.equal(error.message.includes("provider secret"), false);
    return true;
  });
});

test("建议：空建议清单是合法结果，dropped 为 0", async () => {
  const result = await suggestForSpec({ model: modelOf(envelopeOf([])).model, spec: defaultPageSpec() });
  assert.deepEqual(result.suggestions, []);
  assert.equal(result.dropped, 0);
  assert.equal(result.usage, null);
});

/* ------------------------------------------------------------------ *
 * 模块边界：不联网、不读时间、不写任何存储
 * ------------------------------------------------------------------ */

test("生成层不联网、不读时间、不随机、不碰数据库、不写审计", () => {
  const source = readFileSync(new URL("./generation.ts", import.meta.url), "utf8");
  for (const forbidden of ["fetch(", "Date.now", "Math.random", "process.env", "audit", "organizer_audit", "DatabasePort", "sql."]) {
    assert.equal(source.includes(forbidden), false, "generation.ts 不允许出现 " + forbidden);
  }
  assert.equal(source.includes("EVENT_SITE_MODEL_UNAVAILABLE"), true);
  assert.equal(source.includes("EVENT_SITE_MODEL_RESULT_INVALID"), true);
});
