import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { defaultPageSpec } from "./blocks.ts";
import type { EventSitePolicyFinding } from "./policy.ts";
import {
  eventSiteFreeNotice, eventSiteMobileNotice, eventSiteZeroCostNotice, reviewSpec, summarizeFindings, topFindings,
} from "./policy.ts";

const codesOf = (findings: readonly EventSitePolicyFinding[]): string[] => findings.map(finding => finding.code);
const specOf = (blocks: unknown[]) => ({ version: 1, blocks });
const rich = (over: Record<string, unknown> = {}) => ({
  kind: "richText", id: "r1", variant: "prose", priority: 3, collapse: false, text: "一句话", ...over,
});
const fact = (over: Record<string, unknown> = {}) => ({
  kind: "countdown", id: "c1", variant: "compact", priority: 3, collapse: false,
  binding: { source: "eventSchedule", field: "registrationCloses" }, ...over,
});
const container = (over: Record<string, unknown> = {}) => ({
  kind: "aiBlock", id: "ai1", variant: "plain", priority: 3, collapse: false,
  manages: ["r1"], duty: "只管语气", mode: "edit", fullPage: false, ...over,
});
const action = (over: Record<string, unknown> = {}) => ({
  kind: "actionRegister", id: "a1", variant: "primary", priority: 3, collapse: false, action: "register", ...over,
});

test("默认规格体检 0 条：默认模块集本身是干净的一页", () => {
  const findings = reviewSpec(defaultPageSpec());
  assert.deepEqual(codesOf(findings), []);
  assert.equal(summarizeFindings(findings).worst, null);
  assert.equal(eventSiteZeroCostNotice.includes("不调用模型"), true);
  assert.match(eventSiteFreeNotice, /空白页也是合法/);
  assert.match(eventSiteMobileNotice, /单列/);
});

test("体检永不抛错：垃圾输入、循环引用、半成品都只返回提醒", () => {
  const circular: Record<string, unknown> = { blocks: [] };
  circular.self = circular;
  const inputs: unknown[] = [
    undefined, null, 42, "x", [], {}, { blocks: 3 }, { blocks: [null, 3, {}, []] },
    { version: 1, blocks: [{ kind: "unknownKind", id: "x1" }] }, circular,
  ];
  for (const input of inputs) {
    const findings = reviewSpec(input);
    assert.equal(Array.isArray(findings), true);
    for (const finding of findings) {
      assert.ok(["error", "warning", "info"].includes(finding.level));
      assert.ok(finding.message.length > 0 && finding.fixHint.length > 0);
    }
  }
  assert.ok(codesOf(reviewSpec(null)).includes("REVIEW_SPEC_INVALID"));
  assert.ok(codesOf(reviewSpec({ blocks: 3 })).includes("REVIEW_SPEC_INVALID"));
});

test("手机不横向滚动：写了固定位置或宽度就提醒", () => {
  const findings = reviewSpec(specOf([rich({ width: "1200px" }), rich({ id: "r2", text: "另一句", x: 0, y: 0 })]));
  assert.equal(codesOf(findings).filter(code => code === "REVIEW_MOBILE_FIXED_WIDTH").length, 3);
  assert.equal(findings.find(finding => finding.code === "REVIEW_MOBILE_FIXED_WIDTH")?.level, "error");
  assert.match(String(findings[0].fixHint), /单列|引擎/);
});

test("未知字段、未知类型、非法重要度都会被提醒", () => {
  const findings = reviewSpec(specOf([rich({ html: "<b>x</b>" }), { kind: "videoEmbed", id: "v1" }, rich({ id: "r3", text: "x", priority: 9 })]));
  const codes = codesOf(findings);
  assert.ok(codes.includes("REVIEW_UNKNOWN_FIELD"));
  assert.ok(codes.includes("REVIEW_UNKNOWN_BLOCK_KIND"));
  assert.ok(codes.includes("REVIEW_PRIORITY_INVALID"));
});

test("文案超长与 HTML 会被提醒", () => {
  const long = reviewSpec(specOf([rich({ text: "字".repeat(2500) })]));
  assert.ok(codesOf(long).includes("REVIEW_TEXT_TOO_LONG"));
  const html = reviewSpec(specOf([rich({ text: "<script>x</script>" })]));
  assert.equal(html.find(finding => finding.code === "REVIEW_HTML_IN_TEXT")?.level, "error");
  const required = reviewSpec(specOf([rich({ text: "" })]));
  assert.ok(codesOf(required).includes("REVIEW_TEXT_REQUIRED"));
});

test("事实类缺少绑定、手写日期、绑定错字段都会被提醒", () => {
  assert.ok(codesOf(reviewSpec(specOf([fact({ binding: undefined })]))).includes("REVIEW_FACT_BLOCK_MISSING_BINDING"));
  const handWritten = reviewSpec(specOf([fact({ heading: "报名 10 月 20 日截止" })]));
  assert.ok(codesOf(handWritten).includes("REVIEW_FACT_HEADING_LOOKS_LIKE_VALUE"));
  const wrong = reviewSpec(specOf([fact({ binding: { source: "eventFaq", field: "scheduleNodes" } })]));
  assert.ok(codesOf(wrong).includes("REVIEW_FACT_BINDING_INVALID"));
  const notAllowed = reviewSpec(specOf([rich({ binding: { source: "eventSchedule", field: "startsAt" } })]));
  assert.ok(codesOf(notAllowed).includes("REVIEW_BINDING_NOT_ALLOWED"));
});

test("区块数、图片数、规格体积超限都会被提醒", () => {
  const many = Array.from({ length: 21 }, (_, index) => rich({ id: "r" + String(index + 1), text: "第 " + String(index) + " 句" }));
  assert.ok(codesOf(reviewSpec(specOf(many))).includes("REVIEW_TOO_MANY_BLOCKS"));
  const banners = Array.from({ length: 9 }, (_, index) => ({
    kind: "bannerImage", id: "i" + String(index + 1), variant: "wide", priority: 3, collapse: false,
    image: { assetId: "asset-" + String(index + 1), alt: "图", aspect: "16:9" },
  }));
  assert.ok(codesOf(reviewSpec(specOf(banners))).includes("REVIEW_TOO_MANY_IMAGE_BLOCKS"));
  const huge = reviewSpec(specOf([rich({ text: "字".repeat(140000) })]));
  assert.ok(codesOf(huge).includes("REVIEW_SPEC_TOO_LARGE"));
});

test("空区块、重复区块都会被提醒（重复只算 info）", () => {
  const empty = reviewSpec(specOf([{ kind: "highlights", id: "h1", variant: "grid", priority: 3, collapse: false, items: [] }]));
  const emptyFinding = empty.find(finding => finding.code === "REVIEW_BLOCK_EMPTY");
  assert.notEqual(emptyFinding, undefined);
  assert.equal(emptyFinding?.level, "warning");
  assert.match(String(emptyFinding?.fixHint), /删掉这块|加/);

  const duplicate = reviewSpec(specOf([rich({ id: "r1" }), rich({ id: "r2" })]));
  const duplicateFinding = duplicate.find(finding => finding.code === "REVIEW_DUPLICATE_BLOCK");
  assert.equal(duplicateFinding?.level, "info");
  assert.equal(duplicateFinding?.blockId, "r2");
});

test("动作跳板缺失只提示、不阻止（info 且不抛错）", () => {
  const findings = reviewSpec(specOf([rich()]));
  const missing = findings.filter(finding => finding.code === "REVIEW_ACTION_MISSING");
  assert.equal(missing.length, 2);
  for (const finding of missing) assert.equal(finding.level, "info");
  assert.match(String(missing[0].fixHint), /不加也能保存与发布/);
});

test("AI 容器：空职责 info、空管辖 error、重叠与嵌套 error、超过 3 个 error", () => {
  const noDuty = reviewSpec(specOf([rich(), container({ duty: null })]));
  assert.equal(noDuty.find(finding => finding.code === "REVIEW_AI_DUTY_EMPTY")?.level, "info");
  assert.match(String(noDuty.find(finding => finding.code === "REVIEW_AI_DUTY_EMPTY")?.message), /不会产生任何调用/);

  assert.equal(reviewSpec(specOf([rich(), container({ manages: [] })])).find(finding => finding.code === "REVIEW_AI_SCOPE_EMPTY")?.level, "error");
  assert.ok(codesOf(reviewSpec(specOf([rich({ id: "r1" }), rich({ id: "r2", text: "另一句" }),
    container({ id: "ai1", manages: ["r1"] }), container({ id: "ai2", manages: ["r1"] })]))).includes("REVIEW_AI_SCOPE_OVERLAP"));
  assert.ok(codesOf(reviewSpec(specOf([rich(), container({ manages: ["ai1"] })]))).includes("REVIEW_AI_SCOPE_SELF"));
  assert.ok(codesOf(reviewSpec(specOf([rich(), container(), container({ id: "ai2", manages: ["ai1"] })]))).includes("REVIEW_AI_CONTAINER_NESTED"));
  assert.ok(codesOf(reviewSpec(specOf([rich(), action(), container({ manages: ["a1"] })]))).includes("REVIEW_AI_SCOPE_ACTION_NOT_ALLOWED"));
  assert.ok(codesOf(reviewSpec(specOf([rich(), container({ mode: "ask" })]))).includes("REVIEW_AI_MODE_UNSUPPORTED"));

  const four: unknown[] = ["r1", "r2", "r3", "r4"].map(id => rich({ id, text: "句子 " + id }));
  four.push(
    container({ id: "ai1", manages: ["r1"] }), container({ id: "ai2", manages: ["r2"] }),
    container({ id: "ai3", manages: ["r3"] }), container({ id: "ai4", manages: ["r4"] }),
  );
  assert.ok(codesOf(reviewSpec(specOf(four))).includes("REVIEW_AI_TOO_MANY"));
});

test("折叠两层会被提醒", () => {
  const findings = reviewSpec(specOf([rich({ id: "r1", collapse: true }), container({ collapse: true, manages: ["r1"] })]));
  assert.equal(findings.find(finding => finding.code === "REVIEW_NESTED_COLLAPSE")?.level, "error");
});

test("topFindings 只给最严重的几条，summarizeFindings 给计数", () => {
  const findings = reviewSpec(specOf([
    rich({ id: "r1", width: "900px", text: "<b>x</b>" }),
    rich({ id: "r2", text: "字".repeat(2500) }),
  ]));
  const top = topFindings(findings, 2);
  assert.equal(top.length, 2);
  assert.equal(top[0].level, "error");
  assert.equal(topFindings(findings, 0).length, 0);
  const summary = summarizeFindings(findings);
  assert.equal(summary.total, findings.length);
  assert.equal(summary.counts.error + summary.counts.warning + summary.counts.info, findings.length);
  assert.equal(summary.worst, "error");
  assert.equal(summarizeFindings([]).worst, null);
});

test("体检是纯函数：同一输入两次结果一致，源码里没有模型/网络/时间", () => {
  const input = specOf([rich({ text: "字".repeat(2500) }), fact({ binding: undefined })]);
  assert.deepEqual(reviewSpec(input), reviewSpec(input));
  const source = readFileSync(new URL("./policy.ts", import.meta.url), "utf8");
  for (const forbidden of ["fetch(", "Date.now", "Math.random", "completeJSON", "process.env", "await "]) {
    assert.equal(source.includes(forbidden), false, "policy 不允许出现 " + forbidden);
  }
});
