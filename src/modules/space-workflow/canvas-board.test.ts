// 画布摆放（规划27 追加）：组件箱加进画布、自由移动、折叠、删除（不删数据）、容错。
import assert from "node:assert/strict";
import test from "node:test";
import {
  CARD, SPACE_COMPONENT_KINDS, addToCanvas, availableKinds, bareLayout, canvasBounds, clampHeight, clampWidth, emptyLayout,
  findFreeSpot, heightOf, isSpaceComponentKind, moveOnCanvas, normalizeCanvasLayout, removeFromCanvas, resizeOnCanvas,
  scaleOf, scaleOnCanvas, toggleCanvasCollapsed, toggleFromCanvas, wheelResizeDelta, wheelScaleDelta, widthOf, initialCollaborationCanvas,
} from "./canvas-board.ts";

test("组件箱开关：点一次收回、再点一次回到原来的位置与大小", () => {
  // 先放到画布上并拖到一个明确的位置、调过大小
  let layout = addToCanvas(bareLayout(), "documents", "documents-1");
  layout = moveOnCanvas(layout, "documents-1", 640, 420);
  layout = resizeOnCanvas(layout, "documents-1", 520, 360);
  const placed = layout.items[0]!;

  // 收回：从画布移除，但记住它原来的摆放
  const remembered = placed;
  const hidden = toggleFromCanvas(layout, "documents", remembered);
  assert.deepEqual(hidden.items, [], "收回后画布上没有该组件");

  // 再点一次：回到**原来**的位置，而不是另找一个空位
  const restored = toggleFromCanvas(hidden, "documents", remembered);
  const back = restored.items[0]!;
  assert.deepEqual({ x: back.x, y: back.y }, { x: 640, y: 420 }, "应回到原位置");
  assert.equal(widthOf(back), 520, "应保留原来的宽度");
  assert.equal(heightOf(back), 360, "应保留原来的高度");
});

test("组件箱开关：没有历史位置时才自动找空位", () => {
  const layout = toggleFromCanvas(bareLayout(), "todos");
  assert.equal(layout.items.length, 1);
  assert.ok(layout.items[0]!.x >= 0 && layout.items[0]!.y >= 0);
});

test("组件箱开关：已成对存在时不会点一次多出一个", () => {
  let layout = toggleFromCanvas(bareLayout(), "todos");
  assert.equal(layout.items.length, 1);
  layout = toggleFromCanvas(layout, "todos");           // 收回
  assert.equal(layout.items.length, 0);
  layout = toggleFromCanvas(layout, "todos");           // 再放回
  assert.equal(layout.items.length, 1, "同类组件只应有一个实例");
});

test("整块缩放：比例受限、不改位置、不动业务数据", () => {
  const layout = addToCanvas(bareLayout(), "todos", "todos-1");
  const zoomedIn = scaleOnCanvas(layout, "todos-1", 1.6).items[0]!;
  assert.equal(scaleOf(zoomedIn), 1.6);
  assert.deepEqual({ x: zoomedIn.x, y: zoomedIn.y }, { x: layout.items[0]!.x, y: layout.items[0]!.y }, "缩放不改位置");
  assert.equal(scaleOf(scaleOnCanvas(layout, "todos-1", 99).items[0]!), 2, "上限 2");
  assert.equal(scaleOf(scaleOnCanvas(layout, "todos-1", 0.01).items[0]!), 0.5, "下限 0.5");
  assert.equal(scaleOf(layout.items[0]!), 1, "缺省为原始大小");
});

test("缩放容错：非法比例被丢弃，坏值不会写成 NaN", () => {
  const layout = normalizeCanvasLayout([
    { instanceId: "a", kind: "todos", x: 0, y: 0, scale: "坏" },
    { instanceId: "b", kind: "path", x: 0, y: 0, scale: 1.25 },
  ]);
  assert.equal(layout.items.find(item => item.instanceId === "a")!.scale, undefined);
  assert.equal(scaleOf(layout.items.find(item => item.instanceId === "a")!), 1);
  assert.equal(layout.items.find(item => item.instanceId === "b")!.scale, 1.25);
});

test("滚轮缩放方向：向上放大、向下缩小、Shift 步长更大", () => {
  assert.deepEqual(wheelScaleDelta({ deltaY: -100, shiftKey: false }), { scaleDelta: 0.05 });
  assert.deepEqual(wheelScaleDelta({ deltaY: 100, shiftKey: false }), { scaleDelta: -0.05 });
  assert.deepEqual(wheelScaleDelta({ deltaY: -100, shiftKey: true }), { scaleDelta: 0.15 });
  assert.deepEqual(wheelScaleDelta({ deltaY: 0, shiftKey: false }), { scaleDelta: 0 });
});

test("缩放后画布范围按缩放后的尺寸计算，不裁切", () => {
  const layout = scaleOnCanvas(addToCanvas(bareLayout(), "todos", "todos-1"), "todos-1", 2);
  const item = layout.items[0]!;
  const bounds = canvasBounds(layout.items, 200, 200);
  // 视觉尺寸 = 宽 × 缩放；容器应至少容得下未缩放的原始尺寸（位置不变）
  assert.ok(bounds.width >= item.x + widthOf(item), "宽度方向仍应容得下原始尺寸");
  assert.ok(bounds.height >= item.y + heightOf(item), "高度方向仍应容得下原始尺寸");
  assert.ok(scaleOf(item) > 1);
});

test("滚轮方向：纵向改高度、横向改宽度、Shift 纵向改宽度", () => {
  const down = wheelResizeDelta({ deltaX: 0, deltaY: 100, shiftKey: false });
  assert.deepEqual(down, { widthDelta: 0, heightDelta: -24 }, "往下滚应改高度");
  const up = wheelResizeDelta({ deltaX: 0, deltaY: -100, shiftKey: false });
  assert.deepEqual(up, { widthDelta: 0, heightDelta: 24 }, "往上滚应把高度改大");
  const sideways = wheelResizeDelta({ deltaX: 100, deltaY: 0, shiftKey: false });
  assert.deepEqual(sideways, { widthDelta: -24, heightDelta: 0 }, "横向滚轮应改宽度");
  const shifted = wheelResizeDelta({ deltaX: 0, deltaY: -100, shiftKey: true });
  assert.deepEqual(shifted, { widthDelta: 60, heightDelta: 0 }, "Shift + 纵向应改宽度且步长更大");
  assert.deepEqual(wheelResizeDelta({ deltaX: 0, deltaY: 0, shiftKey: false }), { widthDelta: 0, heightDelta: 0 });
});

test("把滚轮增量喂给 resize 后，高度确实发生变化（不是只改宽度）", () => {
  const layout = addToCanvas(bareLayout(), "todos", "todos-1");
  const before = heightOf(layout.items[0]!);
  const delta = wheelResizeDelta({ deltaX: 0, deltaY: -100, shiftKey: false });
  const after = resizeOnCanvas(layout, "todos-1", widthOf(layout.items[0]!) + delta.widthDelta, before + delta.heightDelta).items[0]!;
  assert.equal(heightOf(after), before + 24, "高度必须跟着变");
  assert.equal(widthOf(after), CARD.width, "纵向滚动不应改宽度");
});

test("滚轮改变大小：只改尺寸，不改位置、不动折叠状态", () => {
  const layout = addToCanvas(bareLayout(), "todos", "todos-1");
  const before = layout.items[0]!;
  const bigger = resizeOnCanvas(layout, "todos-1", CARD.width + 200, 500);
  const after = bigger.items[0]!;
  assert.equal(widthOf(after), CARD.width + 200);
  assert.equal(heightOf(after), 500);
  assert.deepEqual({ x: after.x, y: after.y }, { x: before.x, y: before.y }, "位置不应改变");
  assert.equal(after.collapsed, before.collapsed, "折叠状态不应改变");
  assert.equal(after.kind, before.kind);
});

test("尺寸限位：滚轮缩放不会把卡片缩到看不见或撑到无限大", () => {
  const layout = addToCanvas(bareLayout(), "todos", "todos-1");
  const tiny = resizeOnCanvas(layout, "todos-1", 10, 10).items[0]!;
  assert.equal(widthOf(tiny), CARD.minWidth);
  assert.equal(heightOf(tiny), CARD.minHeight);
  const huge = resizeOnCanvas(layout, "todos-1", 99999, 99999).items[0]!;
  assert.equal(widthOf(huge), CARD.maxWidth);
  assert.equal(heightOf(huge), CARD.maxHeight);
  assert.equal(clampWidth(-5), CARD.minWidth);
  assert.equal(clampHeight(0), CARD.minHeight);
});

test("尺寸容错：非法或缺失尺寸回退默认，坏值被丢弃", () => {
  const layout = normalizeCanvasLayout([
    { instanceId: "a", kind: "todos", x: 0, y: 0, width: "坏", height: null },
    { instanceId: "b", kind: "path", x: 0, y: 0, width: 500.7, height: 320.2 },
  ]);
  const first = layout.items.find(item => item.instanceId === "a")!;
  assert.equal(first.width, undefined, "非法宽度应被丢弃而不是写成 NaN");
  assert.equal(first.height, undefined);
  assert.equal(widthOf(first), CARD.width, "缺省时用默认宽度");
  const second = layout.items.find(item => item.instanceId === "b")!;
  assert.equal(second.width, 501, "合法宽度四舍五入保留");
  assert.equal(second.height, 320);
});

test("尺寸参与画布范围计算：放大后容器跟着变大，不裁切", () => {
  const layout = resizeOnCanvas(addToCanvas(bareLayout(), "todos", "todos-1"), "todos-1", 700, 900);
  const bounds = canvasBounds(layout.items);
  const item = layout.items[0]!;
  assert.ok(item.x + widthOf(item) <= bounds.width, "右边缘必须在容器内");
  assert.ok(item.y + heightOf(item) <= bounds.height, "下边缘必须在容器内");
});

test("长按拖动不改尺寸；改尺寸不改位置（互不干扰）", () => {
  let layout = addToCanvas(bareLayout(), "todos", "todos-1");
  const original = layout.items[0]!;
  layout = moveOnCanvas(layout, "todos-1", 400, 260);
  layout = resizeOnCanvas(layout, "todos-1", 600, 500);
  const final = layout.items[0]!;
  assert.deepEqual({ x: final.x, y: final.y }, { x: 400, y: 260 });
  assert.equal(widthOf(final), 600);
  assert.equal(heightOf(final), 500);
  assert.notDeepEqual({ x: original.x, y: original.y }, { x: final.x, y: final.y });
});

test("默认画布：上方空白处先放好参赛流程主线，且避开左侧组件箱", () => {
  const layout = emptyLayout();
  assert.deepEqual(layout.items.map(item => item.kind), ["path"], "默认应有且只有流程主线");
  const path = layout.items[0]!;
  assert.ok(path.y <= CARD.margin + 1, "应在上方");
  assert.ok(path.x >= 280, "应避开左侧浮动的组件箱");
  assert.equal(path.collapsed, false);
  assert.equal(layout.revision, 0);
});

test("真正空白的画布仍然可用（清空语义）", () => {
  const bare = bareLayout();
  assert.deepEqual(bare.items, []);
  assert.deepEqual(availableKinds(bare), [...SPACE_COMPONENT_KINDS], "空画布时组件箱应有全部组件");
});

test("默认已有流程主线后，组件箱不再提供它，但提供其余组件", () => {
  const layout = emptyLayout();
  const available = availableKinds(layout);
  assert.ok(!available.includes("path"), "已放上的不应重复提供");
  assert.deepEqual(available, SPACE_COMPONENT_KINDS.filter(kind => kind !== "path"));
});

test("从组件箱加进画布：自动找空位，且不与已有卡片重叠", () => {
  let layout = bareLayout();
  for (const kind of SPACE_COMPONENT_KINDS) layout = addToCanvas(layout, kind, `${kind}-1`);
  assert.equal(layout.items.length, SPACE_COMPONENT_KINDS.length);
  for (let a = 0; a < layout.items.length; a += 1) for (let b = a + 1; b < layout.items.length; b += 1) {
    const left = layout.items[a]!, right = layout.items[b]!;
    const overlapX = Math.abs(left.x - right.x) < CARD.width;
    const overlapY = Math.abs(left.y - right.y) < CARD.height;
    assert.ok(!(overlapX && overlapY), `${left.kind} 与 ${right.kind} 不应重叠`);
  }
});

test("加进画布后组件箱不再提供同一个组件；删除后又能加回来", () => {
  let layout = addToCanvas(bareLayout(), "todos", "todos-1");
  assert.ok(!availableKinds(layout).includes("todos"), "已放上的组件不应再出现在组件箱");
  layout = removeFromCanvas(layout, "todos-1");
  assert.deepEqual(layout.items, [], "删除只从画布移除");
  assert.ok(availableKinds(layout).includes("todos"), "删除后可以再加回来");
});

test("同一实例重复添加不会产生两份", () => {
  const once = addToCanvas(bareLayout(), "documents", "documents-1");
  const twice = addToCanvas(once, "documents", "documents-1");
  assert.equal(twice.items.length, 1);
});

test("删除默认的流程主线后仍能从组件箱加回（删除不等于删数据）", () => {
  const without = removeFromCanvas(emptyLayout(), "path-1");
  assert.deepEqual(without.items, []);
  assert.ok(availableKinds(without).includes("path"), "删除后组件箱应重新提供流程主线");
  const restored = addToCanvas(without, "path", "path-2");
  assert.equal(restored.items.length, 1);
  assert.equal(restored.items[0]!.kind, "path");
});

test("自由移动：位置被限制为非负，其它卡片不受影响", () => {
  let layout = addToCanvas(addToCanvas(bareLayout(), "todos", "todos-1"), "path", "path-1");
  layout = moveOnCanvas(layout, "todos-1", 500, 320);
  assert.deepEqual({ x: layout.items[0]!.x, y: layout.items[0]!.y }, { x: 500, y: 320 });
  assert.equal(layout.items[1]!.x >= 0 && layout.items[1]!.y >= 0, true, "另一张卡片位置不变");
  const negative = moveOnCanvas(layout, "todos-1", -80, -40);
  assert.deepEqual({ x: negative.items[0]!.x, y: negative.items[0]!.y }, { x: 0, y: 0 }, "拖出左上边界应收敛到 0");
});

test("折叠只影响目标卡片，且不改位置", () => {
  const layout = addToCanvas(addToCanvas(bareLayout(), "todos", "todos-1"), "path", "path-1");
  const folded = toggleCanvasCollapsed(layout, "path-1");
  assert.equal(folded.items.find(item => item.instanceId === "path-1")!.collapsed, true);
  assert.equal(folded.items.find(item => item.instanceId === "todos-1")!.collapsed, false);
  assert.deepEqual({ x: folded.items[1]!.x, y: folded.items[1]!.y }, { x: layout.items[1]!.x, y: layout.items[1]!.y });
  assert.equal(toggleCanvasCollapsed(folded, "path-1").items.find(item => item.instanceId === "path-1")!.collapsed, false);
});

test("归一化：丢弃未知组件与坏数据、补齐实例标识、空值回退空画布", () => {
  for (const raw of [null, undefined, "x", 42, {}, []]) {
    assert.deepEqual(normalizeCanvasLayout(raw).items, []);
  }
  const layout = normalizeCanvasLayout([
    { kind: "todos", x: 10, y: 20 },
    { kind: "不存在的组件" },
    null,
    "字符串",
    { kind: "documents", x: "坏", y: -5, collapsed: true },
  ], 7);
  assert.equal(layout.revision, 7);
  assert.equal(layout.items.length, 2, "只保留已知组件");
  assert.ok(layout.items.every(item => item.instanceId.trim().length > 0), "每个实例都要有标识");
  const documents = layout.items.find(item => item.kind === "documents")!;
  assert.equal(documents.collapsed, true, "保留折叠状态");
  assert.equal(documents.y, 0, "负坐标收敛到 0");
  assert.equal(documents.x, 0, "非法坐标回退 0");
  assert.equal(new Set(layout.items.map(item => item.instanceId)).size, layout.items.length, "实例标识不重复");
});

test("找空位：画布铺满一行后自动换行，极端铺满也不会返回 NaN", () => {
  const crowded = Array.from({ length: 40 }, (_, index) => ({ instanceId: `i-${index}`, kind: "todos" as const,
    x: CARD.margin + index * (CARD.width + CARD.gap), y: CARD.margin, collapsed: false }));
  const spot = findFreeSpot(crowded, 900);
  assert.ok(Number.isFinite(spot.x) && Number.isFinite(spot.y));
  assert.ok(spot.y > CARD.margin, "横向放不下时应换到下一行");
});

test("画布范围：空画布仍给可放置区域，有内容时随内容撑开", () => {
  const empty = canvasBounds([]);
  assert.ok(empty.width >= 720 && empty.height >= 420, "空画布也要能放下第一个组件");
  const one = canvasBounds([{ instanceId: "a", kind: "todos", x: 900, y: 700, collapsed: false }]);
  assert.ok(one.width > 900, "宽度应容得下右边缘");
  assert.ok(one.height > 700, "高度应容得下下边缘");
  const folded = canvasBounds([{ instanceId: "a", kind: "todos", x: 0, y: 0, collapsed: true }]);
  assert.ok(folded.height >= 420, "折叠后仍保持最小可放置区域");
});

test("类型判定只认已知组件", () => {
  for (const kind of SPACE_COMPONENT_KINDS) assert.equal(isSpaceComponentKind(kind), true);
  for (const value of ["黑客组件", "", null, 42, {}]) assert.equal(isSpaceComponentKind(value), false);
});

test("团队进度组件支持私人摆放与旧布局兼容，不构造第二份任务状态", () => {
  const legacy = normalizeCanvasLayout([{ instanceId: "path-old", kind: "path", x: 280, y: 24, collapsed: false }], 3);
  const combined = addToCanvas(legacy, "overview", "overview-1");
  assert.deepEqual(combined.items[0], legacy.items[0]);
  assert.equal(combined.items[1]?.kind, "overview");
  assert.equal(combined.revision, 3);
  assert.deepEqual(removeFromCanvas(combined, "overview-1"), legacy);
});

test("新用户默认画布含常用协作组件，但不会覆盖既有布局或提前写数据库", () => {
  const fresh = initialCollaborationCanvas();
  assert.deepEqual(fresh.items.map(item => item.kind), ["todos", "overview", "teammates", "supervision", "path", "documents"]);
  assert.equal(fresh.revision, 0);
  assert.ok(fresh.items.every(item => !item.collapsed && item.x >= 0 && item.y >= 0));
  assert.deepEqual(emptyLayout().items.map(item => item.kind), ["path"]);
});
