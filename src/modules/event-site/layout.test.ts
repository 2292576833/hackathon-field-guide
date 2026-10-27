import assert from "node:assert/strict";
import test from "node:test";
import { defaultPageSpec } from "./blocks.ts";
import type { EventSitePageLayout } from "./model.ts";
import { deriveLayout, reviewSpec } from "./policy.ts";
import { normalizeSpec } from "./validation.ts";

const specOf = (blocks: unknown[]) => normalizeSpec({ version: 1, blocks });
const rich = (over: Record<string, unknown> = {}) => ({
  kind: "richText", id: "r1", variant: "prose", priority: 3, collapse: false, text: "一句话", ...over,
});

const spansFor = (layout: EventSitePageLayout): Record<string, number> => {
  const spans: Record<string, number> = {};
  for (const row of layout.grid.rows) for (const cell of row.cells) spans[cell.blockId] = cell.span;
  return spans;
};

const allKeys = (value: unknown, into: Set<string> = new Set()): Set<string> => {
  if (Array.isArray(value)) {
    for (const entry of value) allKeys(entry, into);
    return into;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      into.add(key);
      allKeys(entry, into);
    }
  }
  return into;
};

test("桌面列宽由 priority 派生：5→12、4→8、3→6、2→4、1→3", () => {
  const spec = specOf([
    rich({ id: "p5", priority: 5, text: "五" }),
    rich({ id: "p4", priority: 4, text: "四" }),
    rich({ id: "p3", priority: 3, text: "三" }),
    rich({ id: "p2", priority: 2, text: "二" }),
    rich({ id: "p1", priority: 1, text: "一" }),
  ]);
  const layout = deriveLayout(spec);
  assert.equal(layout.grid.columns, 12);
  assert.deepEqual(spansFor(layout), { p5: 12, p4: 8, p3: 6, p2: 4, p1: 3 });
});

test("整行变体强制 12 列；同块的其他变体仍按 priority", () => {
  const layout = deriveLayout(specOf([
    { kind: "countdown", id: "c-banner", variant: "banner", priority: 2, collapse: false, binding: { source: "eventSchedule", field: "startsAt" } },
    { kind: "countdown", id: "c-compact", variant: "compact", priority: 2, collapse: false, binding: { source: "eventSchedule", field: "startsAt" } },
    { kind: "bannerImage", id: "i-wide", variant: "wide", priority: 1, collapse: false, image: { assetId: "a1", alt: "图", aspect: "16:9" } },
    { kind: "bannerImage", id: "i-square", variant: "square", priority: 1, collapse: false, image: { assetId: "a2", alt: "图", aspect: "1:1" } },
  ]));
  assert.deepEqual(spansFor(layout), { "c-banner": 12, "c-compact": 4, "i-wide": 12, "i-square": 3 });
});

test("桌面行打包：一行列宽之和不超过 12，满行另起一行", () => {
  const layout = deriveLayout(specOf([
    rich({ id: "r1", text: "一" }), rich({ id: "r2", text: "二" }), rich({ id: "r3", text: "三" }),
    rich({ id: "r4", priority: 4, text: "四" }), rich({ id: "r5", priority: 2, text: "五" }),
  ]));
  for (const row of layout.grid.rows) {
    assert.ok(row.cells.length > 0);
    const sum = row.cells.reduce((total, cell) => total + cell.span, 0);
    assert.ok(sum <= 12, "第 " + String(row.index) + " 行超宽：" + String(sum));
  }
  assert.deepEqual(layout.grid.rows[0].cells.map(cell => cell.blockId), ["r1", "r2"]);
  assert.deepEqual(layout.grid.rows[1].cells.map(cell => cell.blockId), ["r3"]);
  assert.deepEqual(layout.grid.rows[2].cells.map(cell => cell.blockId), ["r4", "r5"]);
  assert.deepEqual(layout.grid.rows.map(row => row.index), [0, 1, 2]);
});

test("手机单列：按 priority 降序、同级保持原顺序，order 连续", () => {
  const layout = deriveLayout(specOf([
    rich({ id: "a", priority: 3, text: "甲" }),
    rich({ id: "b", priority: 5, text: "乙" }),
    rich({ id: "c", priority: 3, text: "丙" }),
    rich({ id: "d", priority: 1, text: "丁" }),
  ]));
  assert.equal(layout.mobile.columns, 1);
  assert.deepEqual(layout.mobile.entries.map(entry => entry.blockId), ["b", "a", "c", "d"]);
  assert.deepEqual(layout.mobile.entries.map(entry => entry.order), [0, 1, 2, 3]);
  assert.deepEqual(layout.mobile.collapseGroups, []);
  for (const entry of layout.mobile.entries) assert.equal(entry.groupId, null);
});

test("手机折叠：相邻的折叠块合成一组，中间断开就另起一组", () => {
  const layout = deriveLayout(specOf([
    rich({ id: "a", priority: 5, collapse: true, text: "甲" }),
    rich({ id: "b", priority: 4, collapse: true, text: "乙" }),
    rich({ id: "c", priority: 3, text: "丙" }),
    rich({ id: "d", priority: 2, collapse: true, text: "丁" }),
  ]));
  assert.deepEqual(layout.mobile.entries.map(entry => entry.blockId), ["a", "b", "c", "d"]);
  assert.deepEqual(layout.mobile.collapseGroups.map(group => [...group.blockIds]), [["a", "b"], ["d"]]);
  const byId = new Map(layout.mobile.entries.map(entry => [entry.blockId, entry]));
  assert.equal(byId.get("a")?.groupId, "g1");
  assert.equal(byId.get("b")?.groupId, "g1");
  assert.equal(byId.get("c")?.groupId, null);
  assert.equal(byId.get("d")?.groupId, "g2");
  assert.equal(layout.constraints.collapseDepth, 1);
});

test("容器不是布局盒：不进栅格、不进手机序列，作用域单独列出", () => {
  const layout = deriveLayout(specOf([
    rich({ id: "r1" }), rich({ id: "r2", text: "另一句" }),
    { kind: "aiBlock", id: "ai1", variant: "plain", priority: 3, collapse: false, manages: ["r1", "r2"], duty: "只管语气" },
  ]));
  assert.deepEqual(Object.keys(spansFor(layout)).sort(), ["r1", "r2"]);
  assert.deepEqual(layout.mobile.entries.map(entry => entry.blockId).sort(), ["r1", "r2"]);
  assert.equal(layout.containers.length, 1);
  assert.deepEqual(layout.containers[0], { containerId: "ai1", manages: ["r1", "r2"], mode: "edit", scope: "blocks" });
});

test("整页模式的容器作用域是 page", () => {
  const layout = deriveLayout(specOf([
    rich({ id: "r1" }),
    { kind: "aiBlock", id: "ai1", variant: "plain", priority: 3, collapse: false, manages: ["r1"], duty: "整页语气", fullPage: true },
  ]));
  assert.equal(layout.containers[0].scope, "page");
});

test("布局层没有任何固定几何：约束是字面量，输出里没有 width/left/style", () => {
  const layout = deriveLayout(defaultPageSpec());
  assert.deepEqual(layout.constraints, {
    fixedWidth: false, absolutePosition: false, horizontalScroll: false, collapseDepth: 1, breakpoints: [620, 760, 1024],
  });
  const keys = allKeys(layout);
  for (const forbidden of ["width", "height", "left", "top", "x", "y", "style", "className", "px", "position"]) {
    assert.equal(keys.has(forbidden), false, "布局层不应该产出 " + forbidden);
  }
  for (const span of Object.values(spansFor(layout))) assert.ok([3, 4, 6, 8, 12].includes(span));
});

test("空白页派生为空布局，仍然是合法的", () => {
  const layout = deriveLayout(specOf([]));
  assert.deepEqual(layout.grid.rows, []);
  assert.deepEqual(layout.mobile.entries, []);
  assert.deepEqual(layout.mobile.collapseGroups, []);
  assert.deepEqual(layout.containers, []);
});

test("派生不修改输入；手机条目数恒等于非容器块数", () => {
  const spec = defaultPageSpec();
  const before = JSON.parse(JSON.stringify(spec));
  const layout = deriveLayout(spec);
  assert.deepEqual(JSON.parse(JSON.stringify(spec)), before);
  const nonContainer = spec.blocks.filter(block => block.kind !== "aiBlock").length;
  assert.equal(layout.mobile.entries.length, nonContainer);
  const cells = layout.grid.rows.reduce((total, row) => total + row.cells.length, 0);
  assert.equal(cells, nonContainer);
});

test("派生与体检对同一份默认规格的口径一致：0 条提醒且布局可出", () => {
  const spec = defaultPageSpec();
  assert.deepEqual(reviewSpec(spec), []);
  const layout = deriveLayout(spec);
  assert.equal(layout.grid.rows.length > 0, true);
  assert.equal(layout.mobile.entries.length, spec.blocks.length);
});
