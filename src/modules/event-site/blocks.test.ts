import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import {
  EVENT_SITE_ACTION_BLOCK_KINDS, EVENT_SITE_BLOCK_KINDS, EVENT_SITE_BLOCK_REGISTRY, EVENT_SITE_CONTENT_BLOCK_KINDS,
  EVENT_SITE_DEFAULT_MODULES, blockDeclaration, defaultPageSpec, deleteAdvice, isActionBlock, isBlankPage,
  isEventSiteBlockKind, variantsOf,
} from "./index.ts";
import { parseSpec } from "./validation.ts";

const failure = (code: string) => (error: unknown): boolean => error instanceof DomainError && error.code === code;

test("封闭枚举正好 13 类：8 个内容区块、4 个动作跳板、1 个容器", () => {
  assert.equal(EVENT_SITE_BLOCK_KINDS.length, 13);
  assert.equal(EVENT_SITE_CONTENT_BLOCK_KINDS.length, 8);
  assert.equal(EVENT_SITE_ACTION_BLOCK_KINDS.length, 4);
  const content = [...EVENT_SITE_CONTENT_BLOCK_KINDS].sort();
  assert.deepEqual(content, ["bannerImage", "countdown", "faq", "highlights", "peopleWall", "richText", "sponsorWall", "timeline"]);
  assert.deepEqual([...EVENT_SITE_ACTION_BLOCK_KINDS].sort(), ["actionAppeal", "actionRegister", "actionResults", "actionSubmit"]);
  assert.equal(EVENT_SITE_BLOCK_REGISTRY.aiBlock.category, "container");
  assert.equal(isEventSiteBlockKind("aiBlock"), true);
  assert.equal(isEventSiteBlockKind("videoEmbed"), false);
  assert.equal(isEventSiteBlockKind("__proto__"), false);
});

test("每个区块都声明了 kind、标签、变体、绑定需求、文案规则、嵌套与事实类", () => {
  for (const kind of EVENT_SITE_BLOCK_KINDS) {
    const declaration = blockDeclaration(kind);
    assert.equal(declaration.kind, kind);
    assert.ok(declaration.label.length > 0, kind + " 缺标签");
    assert.ok(declaration.hint.length > 0, kind + " 缺一句人话提示");
    assert.ok(declaration.variants.length >= 1, kind + " 没有变体");
    assert.ok(declaration.variants.includes(declaration.defaultVariant), kind + " 的默认变体不在允许列表");
    assert.deepEqual([...variantsOf(kind)], [...declaration.variants]);
    assert.equal(typeof declaration.requiresBinding, "boolean");
    assert.equal(typeof declaration.factClass, "boolean");
    assert.equal(typeof declaration.textRules.maxText, "number");
    assert.equal(typeof declaration.textRules.maxHeading, "number");
    assert.equal(declaration.allowsNesting, kind === "aiBlock", kind + " 的嵌套标记不对");
    assert.equal(declaration.fullWidthVariants.every(variant => declaration.variants.includes(variant)), true);
  }
});

test("事实类只有 countdown、timeline、faq，且都必须数据绑定", () => {
  const facts = EVENT_SITE_BLOCK_KINDS.filter(kind => EVENT_SITE_BLOCK_REGISTRY[kind].factClass);
  assert.deepEqual([...facts].sort(), ["countdown", "faq", "timeline"]);
  for (const kind of facts) {
    const declaration = blockDeclaration(kind);
    assert.equal(declaration.requiresBinding, true, kind + " 必须绑定");
    assert.ok(declaration.allowedBindingFields.length > 0, kind + " 没有可绑字段");
    assert.equal(declaration.textRules.maxText, 0, kind + " 不能有手写正文");
    assert.equal(declaration.textRules.maxItems, 0, kind + " 不能有手写条目");
    assert.equal(declaration.carriesImage, false, kind + " 不能带图");
  }
});

test("动作跳板没有文案、没有 href，四个目标由平台固定", () => {
  const targets = EVENT_SITE_ACTION_BLOCK_KINDS.map(kind => blockDeclaration(kind).actionTarget);
  assert.deepEqual([...targets].sort(), ["appeal", "register", "results", "submit"]);
  for (const kind of EVENT_SITE_ACTION_BLOCK_KINDS) {
    const declaration = blockDeclaration(kind);
    assert.equal(declaration.requiresBinding, false);
    assert.equal(declaration.textRules.maxText, 0);
    assert.equal(declaration.textRules.maxHeading, 0);
    assert.equal(declaration.textRules.requirement, "none");
    assert.equal(declaration.allowsNesting, false);
  }
});

test("默认规格覆盖 8 个默认模块，并通过严格校验", () => {
  const spec = parseSpec(defaultPageSpec());
  assert.equal(spec.blocks.length, 8);
  assert.equal(EVENT_SITE_DEFAULT_MODULES.length, 8);
  const kinds = spec.blocks.map(block => block.kind);
  assert.deepEqual(kinds, [
    "countdown", "actionRegister", "actionSubmit", "timeline", "richText", "faq", "actionResults", "richText",
  ]);
  const ids = new Set(spec.blocks.map(block => block.id));
  assert.equal(ids.size, spec.blocks.length, "默认规格里的区块编号必须唯一");
  const modulesFromRegistry = spec.blocks.map(block => EVENT_SITE_BLOCK_REGISTRY[block.kind].moduleLabel);
  for (const module of EVENT_SITE_DEFAULT_MODULES) {
    assert.ok(modulesFromRegistry.includes(module) || module === "页脚" || module === "FAQ" || module === "公告" || module === "赛程" || module === "结果" || module === "报名" || module === "提交" || module === "赛事信息", module + " 没有对应区块");
  }
});

test("默认规格里只有事实类区块带 binding，其余都是 null", () => {
  for (const block of defaultPageSpec().blocks) {
    if (block.kind === "aiBlock") continue;
    if (isActionBlock(block)) continue;
    const declaration = EVENT_SITE_BLOCK_REGISTRY[block.kind];
    if (declaration.factClass) {
      assert.notEqual(block.binding, null, block.kind + " 应该带绑定");
      const expectedSource = block.kind === "faq" ? "eventFaq" : "eventSchedule";
      assert.equal(block.binding?.source, expectedSource, block.kind + " 的数据源不对");
    } else {
      assert.equal(block.binding, null, block.kind + " 不应该有绑定");
    }
  }
});

test("完全空白页是合法规格", () => {
  const spec = parseSpec({ version: 1, blocks: [] });
  assert.equal(spec.blocks.length, 0);
  assert.equal(isBlankPage(spec), true);
  assert.equal(isBlankPage(defaultPageSpec()), false);
});

test("删除只给建议：每种区块都给三段人话，从不阻止删除", () => {
  for (const kind of EVENT_SITE_BLOCK_KINDS) {
    const advice = deleteAdvice(kind);
    assert.equal(advice.kind, kind);
    assert.ok(advice.impact.length > 0);
    assert.ok(advice.stillReachable.length > 0);
    assert.ok(advice.undoHint.length > 0);
    assert.equal(advice.message, advice.impact);
    assert.match(advice.undoHint, /撤销|恢复/);
    assert.equal(Object.isFrozen(advice), true);
    assert.doesNotMatch(advice.message, /不能删除|不允许删除|禁止删除/);
  }
  assert.match(deleteAdvice("actionRegister").stillReachable, /报名/);
  assert.match(deleteAdvice("aiBlock").impact, /不会删掉它框住的区块/);
  assert.throws(() => deleteAdvice("videoEmbed" as never), failure("EVENT_SITE_UNKNOWN_BLOCK_KIND"));
});
