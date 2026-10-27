import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import { defaultPageSpec } from "./blocks.ts";
import {
  EVENT_SITE_SPEC_VERSION, jsonByteLength, normalizeSpec, parseSpec, serializeSpec, specByteLength, textLength,
} from "./validation.ts";

const failure = (code: string) => (error: unknown): boolean => error instanceof DomainError && error.code === code;

const specOf = (blocks: unknown[]) => ({ version: 1, blocks: blocks });

const rich = (over: Record<string, unknown> = {}) => ({
  kind: "richText", id: "r1", variant: "prose", priority: 3, collapse: false, text: "一句话", ...over,
});
const fact = (over: Record<string, unknown> = {}) => ({
  kind: "countdown", id: "c1", variant: "compact", priority: 3, collapse: false,
  binding: { source: "eventSchedule", field: "registrationCloses" }, ...over,
});
const action = (over: Record<string, unknown> = {}) => ({
  kind: "actionRegister", id: "a1", variant: "primary", priority: 3, collapse: false, action: "register", ...over,
});
const container = (over: Record<string, unknown> = {}) => ({
  kind: "aiBlock", id: "ai1", variant: "plain", priority: 3, collapse: false,
  manages: ["r1"], duty: "只管语气", mode: "edit", fullPage: false, ...over,
});
const image = (over: Record<string, unknown> = {}) => ({ assetId: "asset-1", alt: "主视觉", aspect: "16:9", ...over });

test("严格形态要求 id / kind / variant / priority / collapse", () => {
  assert.equal(parseSpec(specOf([rich()])).blocks.length, 1);
  assert.throws(() => parseSpec({ blocks: [rich()] }), failure("EVENT_SITE_UNSUPPORTED_VERSION"));
  assert.throws(() => parseSpec(specOf([{ kind: "richText", variant: "prose", priority: 3, collapse: false, text: "x" }])), failure("EVENT_SITE_INVALID_BLOCK_ID"));
  assert.throws(() => parseSpec(specOf([{ kind: "richText", id: "r1", priority: 3, collapse: false, text: "x" }])), failure("EVENT_SITE_UNKNOWN_VARIANT"));
  assert.throws(() => parseSpec(specOf([{ kind: "richText", id: "r1", variant: "prose", collapse: false, text: "x" }])), failure("EVENT_SITE_INVALID_PRIORITY"));
  assert.throws(() => parseSpec(specOf([{ kind: "richText", id: "r1", variant: "prose", priority: 3, text: "x" }])), failure("EVENT_SITE_INVALID_SPEC"));
  assert.equal(EVENT_SITE_SPEC_VERSION, 1);
  assert.throws(() => parseSpec({ version: 2, blocks: [] }), failure("EVENT_SITE_UNSUPPORTED_VERSION"));
});

test("拒绝未知 kind、未知区块字段与未知规格字段", () => {
  assert.throws(() => parseSpec(specOf([{ kind: "videoEmbed", id: "v1", variant: "x", priority: 3, collapse: false }])), failure("EVENT_SITE_UNKNOWN_BLOCK_KIND"));
  assert.throws(() => parseSpec(specOf([rich({ html: "<b>x</b>" })])), failure("EVENT_SITE_UNKNOWN_BLOCK_FIELD"));
  assert.throws(() => parseSpec(specOf([rich({ className: "hero" })])), failure("EVENT_SITE_UNKNOWN_BLOCK_FIELD"));
  assert.throws(() => parseSpec({ version: 1, blocks: [], layout: { columns: 12 } }), failure("EVENT_SITE_UNKNOWN_SPEC_FIELD"));
  assert.throws(() => parseSpec({ version: 1, blocks: [], shortCode: "abcdefgh" }), failure("EVENT_SITE_UNKNOWN_SPEC_FIELD"));
  assert.throws(() => parseSpec("not a spec"), failure("EVENT_SITE_INVALID_SPEC"));
  assert.throws(() => parseSpec({ version: 1 }), failure("EVENT_SITE_INVALID_SPEC"));
});

test("拒绝未知变体与非法重要度", () => {
  assert.throws(() => parseSpec(specOf([rich({ variant: "magazine" })])), failure("EVENT_SITE_UNKNOWN_VARIANT"));
  for (const priority of [0, 6, -1, 2.5, "3", null]) {
    assert.throws(() => parseSpec(specOf([rich({ priority })])), failure("EVENT_SITE_INVALID_PRIORITY"));
  }
  assert.throws(() => parseSpec(specOf([rich({ id: "有中文" })])), failure("EVENT_SITE_INVALID_BLOCK_ID"));
  assert.throws(() => parseSpec(specOf([rich({ id: "x".repeat(65) })])), failure("EVENT_SITE_INVALID_BLOCK_ID"));
});

test("文案只能是纯文本：禁 HTML、禁控制字符、有长度上限", () => {
  assert.throws(() => parseSpec(specOf([rich({ text: "<script>alert(1)</script>" })])), failure("EVENT_SITE_HTML_NOT_ALLOWED"));
  assert.throws(() => parseSpec(specOf([rich({ heading: "<h1>标题</h1>" })])), failure("EVENT_SITE_HTML_NOT_ALLOWED"));
  assert.throws(() => parseSpec(specOf([rich({ text: "带\u0001控制字符" })])), failure("EVENT_SITE_INVALID_TEXT"));
  assert.throws(() => parseSpec(specOf([rich({ text: 42 })])), failure("EVENT_SITE_INVALID_TEXT"));
  assert.throws(() => parseSpec(specOf([rich({ text: "字".repeat(2001) })])), failure("EVENT_SITE_TEXT_TOO_LONG"));
  assert.throws(() => parseSpec(specOf([rich({ text: "   " })])), failure("EVENT_SITE_TEXT_REQUIRED"));
  assert.throws(() => parseSpec(specOf([rich({ text: undefined })])), failure("EVENT_SITE_TEXT_REQUIRED"));
  assert.equal(textLength("字".repeat(2000)), 2000);
});

test("事实类区块必须绑定，且不能手写值（例如手写报名截止）", () => {
  assert.throws(() => parseSpec(specOf([fact({ binding: undefined })])), failure("EVENT_SITE_BINDING_REQUIRED"));
  assert.throws(() => parseSpec(specOf([fact({ text: "报名截止 2026-10-20" })])), failure("EVENT_SITE_FACT_VALUE_NOT_ALLOWED"));
  assert.throws(() => parseSpec(specOf([fact({ items: [{ heading: "10 月 20 日" }] })])), failure("EVENT_SITE_FACT_VALUE_NOT_ALLOWED"));
  assert.throws(() => parseSpec(specOf([fact({ date: "2026-10-20" })])), failure("EVENT_SITE_FACT_VALUE_NOT_ALLOWED"));
  assert.throws(() => parseSpec(specOf([fact({ value: "2026-10-20" })])), failure("EVENT_SITE_FACT_VALUE_NOT_ALLOWED"));
  const headingOnly = parseSpec(specOf([fact({ heading: "距离报名截止" })]));
  assert.equal(headingOnly.blocks[0].kind, "countdown");
});

test("文案区块不能声明平台绑定；绑定字段必须属于该区块且数据源匹配", () => {
  assert.throws(() => parseSpec(specOf([rich({ binding: { source: "eventSchedule", field: "registrationCloses" } })])), failure("EVENT_SITE_BINDING_NOT_ALLOWED"));
  assert.throws(() => parseSpec(specOf([fact({ binding: { source: "eventSchedule", field: "scheduleNodes" } })])), failure("EVENT_SITE_BINDING_INVALID"));
  assert.throws(() => parseSpec(specOf([fact({ binding: { source: "eventSchedule", field: "answerKey" } })])), failure("EVENT_SITE_BINDING_INVALID"));
  assert.throws(() => parseSpec(specOf([fact({ binding: { source: "eventFaq", field: "registrationCloses" } })])), failure("EVENT_SITE_BINDING_INVALID"));
  const faq = parseSpec(specOf([{ kind: "faq", id: "f1", variant: "plain", priority: 3, collapse: false, binding: { source: "eventFaq", field: "faqEntries" } }]));
  assert.equal(faq.blocks.length, 1);
});

test("区块编号必须唯一", () => {
  assert.throws(() => parseSpec(specOf([rich(), rich({ text: "另一句" })])), failure("EVENT_SITE_DUPLICATE_BLOCK_ID"));
});

test("内容区块上限 20、图片区块上限 8、图片总数上限 24", () => {
  const many = Array.from({ length: 21 }, (_, index) => rich({ id: "r" + String(index + 1) }));
  assert.throws(() => parseSpec(specOf(many)), failure("EVENT_SITE_TOO_MANY_BLOCKS"));
  assert.equal(parseSpec(specOf(many.slice(0, 20))).blocks.length, 20);

  const banners = Array.from({ length: 9 }, (_, index) => ({
    kind: "bannerImage", id: "i" + String(index + 1), variant: "wide", priority: 3, collapse: false, image: image(),
  }));
  assert.throws(() => parseSpec(specOf(banners)), failure("EVENT_SITE_TOO_MANY_IMAGE_BLOCKS"));

  const items = Array.from({ length: 24 }, (_, index) => ({
    heading: "赞助商" + String(index + 1), image: image({ assetId: "asset-" + String(index + 1) }),
  }));
  const wall = { kind: "sponsorWall", id: "w1", variant: "logoGrid", priority: 3, collapse: false, items };
  const banner = { kind: "bannerImage", id: "i1", variant: "wide", priority: 3, collapse: false, image: image() };
  assert.throws(() => parseSpec(specOf([wall, banner])), failure("EVENT_SITE_TOO_MANY_IMAGES"));
});

test("条目数与条目字段有上限", () => {
  const items = Array.from({ length: 7 }, (_, index) => ({ heading: "要点" + String(index + 1) }));
  assert.throws(() => parseSpec(specOf([{ kind: "highlights", id: "h1", variant: "grid", priority: 3, collapse: false, items }])), failure("EVENT_SITE_TOO_MANY_ITEMS"));
  assert.throws(() => parseSpec(specOf([{ kind: "highlights", id: "h1", variant: "grid", priority: 3, collapse: false, items: [{ heading: "" }] }])), failure("EVENT_SITE_TEXT_REQUIRED"));
  assert.throws(() => parseSpec(specOf([{ kind: "highlights", id: "h1", variant: "grid", priority: 3, collapse: false, items: [{ heading: "要点", image: image() }] }])), failure("EVENT_SITE_UNKNOWN_BLOCK_FIELD"));
  assert.throws(() => parseSpec(specOf([{ kind: "highlights", id: "h1", variant: "grid", priority: 3, collapse: false, items: ["纯字符串"] }])), failure("EVENT_SITE_ITEM_INVALID"));
});

test("图片必须带替代文本、合法宽高比与合法编号", () => {
  const banner = (value: unknown) => specOf([{ kind: "bannerImage", id: "i1", variant: "wide", priority: 3, collapse: false, image: value }]);
  assert.throws(() => parseSpec(banner(undefined)), failure("EVENT_SITE_IMAGE_REQUIRED"));
  assert.throws(() => parseSpec(banner(image({ alt: "" }))), failure("EVENT_SITE_TEXT_REQUIRED"));
  assert.throws(() => parseSpec(banner(image({ aspect: "21:9" }))), failure("EVENT_SITE_IMAGE_INVALID"));
  assert.throws(() => parseSpec(banner(image({ assetId: "有空格 的编号" }))), failure("EVENT_SITE_IMAGE_INVALID"));
  assert.throws(() => parseSpec(banner(image({ url: "https://example.test/a.png" }))), failure("EVENT_SITE_UNKNOWN_BLOCK_FIELD"));
  assert.equal(parseSpec(banner(image())).blocks.length, 1);
});

test("规格序列化上限 128KB，超限是 413", () => {
  const huge = specOf([rich({ text: "字".repeat(140000) })]);
  try {
    parseSpec(huge);
    assert.fail("应当抛出体积错误");
  } catch (error) {
    assert.equal(failure("EVENT_SITE_SPEC_TOO_LARGE")(error), true);
    assert.equal((error as DomainError).status, 413);
  }
  assert.ok(jsonByteLength(specOf([])) > 0);
  const bytes = specByteLength(defaultPageSpec());
  assert.ok(bytes > 100 && bytes < 128 * 1024, "默认规格应远小于上限");
});

test("动作跳板目标固定，不能加 href 或表单字段", () => {
  assert.throws(() => parseSpec(specOf([action({ action: "submit" })])), failure("EVENT_SITE_ACTION_TARGET_IMMUTABLE"));
  assert.throws(() => parseSpec(specOf([action({ href: "https://evil.test/register" })])), failure("EVENT_SITE_ACTION_TARGET_IMMUTABLE"));
  assert.throws(() => parseSpec(specOf([action({ form: { action: "post" } })])), failure("EVENT_SITE_ACTION_TARGET_IMMUTABLE"));
  assert.throws(() => parseSpec(specOf([action({ text: "立即报名" })])), failure("EVENT_SITE_UNKNOWN_BLOCK_FIELD"));
  assert.equal(parseSpec(specOf([action()])).blocks[0].kind, "actionRegister");
});

test("AI 组件：一页最多 3 个、不能空管辖、不能管自己/容器/动作", () => {
  const four = ["r1", "r2", "r3", "r4"];
  const blocks: unknown[] = four.map(id => rich({ id }));
  blocks.push(
    container({ id: "ai1", manages: ["r1"] }),
    container({ id: "ai2", manages: ["r2"] }),
    container({ id: "ai3", manages: ["r3"] }),
    container({ id: "ai4", manages: ["r4"] }),
  );
  assert.throws(() => parseSpec(specOf(blocks)), failure("EVENT_SITE_AI_TOO_MANY"));

  assert.throws(() => parseSpec(specOf([rich(), container({ manages: [] })])), failure("EVENT_SITE_AI_SCOPE_EMPTY"));
  assert.throws(() => parseSpec(specOf([rich(), container({ manages: ["nope"] })])), failure("EVENT_SITE_AI_SCOPE_UNKNOWN_BLOCK"));
  assert.throws(() => parseSpec(specOf([rich(), container({ id: "ai1", manages: ["ai1"] })])), failure("EVENT_SITE_AI_SCOPE_SELF"));
  assert.throws(() => parseSpec(specOf([rich(), container(), container({ id: "ai2", manages: ["ai1"] })])), failure("EVENT_SITE_AI_CONTAINER_NESTED"));
  assert.throws(() => parseSpec(specOf([rich(), action(), container({ manages: ["a1"] })])), failure("EVENT_SITE_AI_SCOPE_ACTION_NOT_ALLOWED"));
});

test("一块只能属于一个 AI 容器；重复列出也算重叠", () => {
  assert.throws(() => parseSpec(specOf([
    rich({ id: "r1" }), rich({ id: "r2", text: "另一句" }),
    container({ id: "ai1", manages: ["r1"] }), container({ id: "ai2", manages: ["r1", "r2"] }),
  ])), failure("EVENT_SITE_AI_SCOPE_OVERLAP"));
  assert.throws(() => parseSpec(specOf([rich({ id: "r1" }), container({ manages: ["r1", "r1"] })])), failure("EVENT_SITE_AI_SCOPE_OVERLAP"));
});

test("AI 组件本期只允许编辑模式", () => {
  assert.throws(() => parseSpec(specOf([rich(), container({ mode: "ask" })])), failure("EVENT_SITE_AI_MODE_UNSUPPORTED"));
  assert.throws(() => parseSpec(specOf([rich(), container({ mode: "chat" })])), failure("EVENT_SITE_AI_MODE_UNSUPPORTED"));
});

test("整页模式：只能一个，且必须刚好管全部内容区块", () => {
  const ok = parseSpec(specOf([rich({ id: "r1" }), container({ manages: ["r1"], fullPage: true })]));
  assert.equal(ok.blocks.length, 2);
  assert.throws(() => parseSpec(specOf([
    rich({ id: "r1" }), rich({ id: "r2", text: "另一句" }), container({ manages: ["r1"], fullPage: true }),
  ])), failure("EVENT_SITE_AI_FULL_PAGE_SCOPE"));
  assert.throws(() => parseSpec(specOf([
    rich({ id: "r1" }), container({ id: "ai1", manages: ["r1"], fullPage: true }), container({ id: "ai2", manages: ["r1"], fullPage: true }),
  ])), failure("EVENT_SITE_AI_FULL_PAGE_CONFLICT"));
});

test("手机折叠只允许一层", () => {
  assert.throws(() => parseSpec(specOf([
    rich({ id: "r1", collapse: true }), container({ collapse: true, manages: ["r1"] }),
  ])), failure("EVENT_SITE_NESTED_COLLAPSE"));
  const layered = parseSpec(specOf([
    rich({ id: "r1", collapse: true }), container({ collapse: false, manages: ["r1"] }),
    rich({ id: "r2", collapse: true, text: "另一句" }),
  ]));
  assert.equal(layered.blocks.length, 3);
});

test("normalizeSpec 补默认值，且对已归一结果幂等", () => {
  const filled = normalizeSpec({ blocks: [{ kind: "richText", text: "一句话" }, { kind: "actionResults" }] });
  assert.equal(filled.version, 1);
  assert.equal(filled.blocks[0].id, "b1");
  assert.equal(filled.blocks[0].variant, "prose");
  assert.equal(filled.blocks[0].priority, 3);
  assert.equal(filled.blocks[0].collapse, false);
  assert.equal(filled.blocks[1].kind, "actionResults");
  assert.deepEqual(normalizeSpec(filled), filled);
  assert.deepEqual(parseSpec(filled), filled);
  assert.deepEqual(normalizeSpec(defaultPageSpec()), defaultPageSpec());
});

test("serializeSpec 往返一致，且超限直接抛错", () => {
  const spec = defaultPageSpec();
  const json = serializeSpec(spec);
  assert.equal(typeof json, "string");
  assert.deepEqual(parseSpec(JSON.parse(json)), spec);
  assert.deepEqual(normalizeSpec(JSON.parse(json)), spec);
  assert.equal(jsonByteLength(JSON.parse(json)), Buffer.byteLength(json, "utf8"));
});

test("带条目的规格必须能往返：parseSpec 的输出可被 normalizeSpec / serializeSpec 再接受", () => {
  const input = { version: 1, blocks: [{
    kind: "highlights", id: "b1", variant: "grid", priority: 3, collapse: false,
    heading: "要点", items: [{ heading: "组队" }], text: null, image: null, binding: null,
  }] };
  const parsed = parseSpec(input);
  // 条目里带 image:null 是 parseSpec 的正常输出，不能因此被拒绝。
  assert.deepEqual(normalizeSpec(parsed), parsed);
  assert.doesNotThrow(() => serializeSpec(parsed));
  // 非空但该条目类型不允许的字段仍然拒绝（不放宽规则）。
  assert.throws(() => parseSpec({ version: 1, blocks: [{
    kind: "highlights", id: "b2", variant: "grid", priority: 3, collapse: false,
    items: [{ heading: "x", image: { assetId: "a1", alt: "x", aspect: "1:1" } }],
    text: null, image: null, binding: null,
  }] }), (error: unknown) => (error as { code?: string }).code === "EVENT_SITE_UNKNOWN_BLOCK_FIELD");
});
