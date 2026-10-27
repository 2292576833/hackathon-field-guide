import assert from "node:assert/strict";
import test from "node:test";
import {
  canUseCanvasGesture, canvasSelectionRect, intersectingCanvasItems, isLongPressClick,
  movedBeforeLongPress, planningReadPresentation, pointInCanvas, scaleCanvasGroup, translateCanvasGroup,
} from "./canvas-gestures.ts";

test("首读保留 loading，已有快照的后台刷新不退回 loading", () => {
  assert.deepEqual(planningReadPresentation({ hasData: false, loading: true, error: null, previousError: null }), { planningLoading: true, planningError: null });
  assert.deepEqual(planningReadPresentation({ hasData: true, loading: true, error: null, previousError: null }), { planningLoading: false, planningError: null });
});

test("刷新失败在重试期间持续明确，只有成功返回才清除", () => {
  const failure = "读取超时";
  assert.equal(planningReadPresentation({ hasData: true, loading: false, error: failure, previousError: null }).planningError, failure);
  assert.deepEqual(planningReadPresentation({ hasData: true, loading: true, error: null, previousError: failure }), { planningLoading: false, planningError: failure });
  assert.equal(planningReadPresentation({ hasData: true, loading: false, error: null, previousError: failure }).planningError, null);
  assert.equal(planningReadPresentation({ hasData: false, loading: true, error: null, previousError: failure }).planningError, failure);
});

test("独立节点、表单、菜单和弹窗不接受外层拖动或滚轮缩放", () => {
  for (const region of ["graph-node", "options", "dialog"] as const) {
    assert.equal(canUseCanvasGesture(region, "drag"), false, region);
    assert.equal(canUseCanvasGesture(region, "zoom"), false, region);
  }
  assert.equal(canUseCanvasGesture("editor", "drag"), false, "编辑区不接受外层拖动");
  assert.equal(canUseCanvasGesture("editor", "zoom"), false, "编辑区内还有可滚动内容时，滚轮留给原生滚动");
  assert.equal(canUseCanvasGesture("document-text", "drag"), false, "正文保留选字");
  assert.equal(canUseCanvasGesture("document-text", "zoom"), true, "只读正文可缩放");
});

test("编辑框内部没有可滚动内容时允许滚轮缩放（文档卡默认就是编辑态且占满整张卡）", () => {
  // 用户报"文档组件无法放大缩小"：文档正文 textarea 占满整卡、内部不滚动，
  // 若一律拒绝缩放，鼠标落在正文上滚轮就毫无反应。
  assert.equal(canUseCanvasGesture("editor", "zoom", false, false), true, "无可滚动内容的编辑框应允许缩放卡片");
  assert.equal(canUseCanvasGesture("editor", "zoom", false, true), false, "有可滚动内容时仍以原生滚动优先");
  assert.equal(canUseCanvasGesture("editor", "drag", false, false), false, "拖动仍不借用，避免误移卡片");
});

test("只允许显式白名单按钮长按；每个组件的外侧空白可移动和缩放", () => {
  assert.equal(canUseCanvasGesture("control", "drag"), false);
  assert.equal(canUseCanvasGesture("safe-control", "drag"), true);
  assert.equal(canUseCanvasGesture("content", "drag"), true);
  assert.equal(canUseCanvasGesture("surface", "drag"), true);
  assert.equal(canUseCanvasGesture("surface", "zoom", true), true, "文档编辑器仍有焦点时，外侧空白仍可缩放");
  assert.equal(canUseCanvasGesture("content", "zoom", true), false, "编辑状态不误抢正文区域的滚动");
});

test("长按前手指或鼠标正常滑动立即退出候选，微小抖动不误取消", () => {
  assert.equal(movedBeforeLongPress(4, 4), false);
  assert.equal(movedBeforeLongPress(0, 8), false);
  assert.equal(movedBeforeLongPress(6, 6), true);
  assert.equal(movedBeforeLongPress(-20, 0), true);
});

test("长按后的尾随点击按卡片与指针隔离，短按和键盘始终保留", () => {
  const fence = { cardId: "assistant", pointerId: 7, until: 1800 };
  const click = { cardId: "assistant", pointerId: 7, detail: 1, now: 1100 };
  assert.equal(isLongPressClick(fence, click), true);
  assert.equal(isLongPressClick(fence, { ...click, detail: 0 }), false, "键盘 Enter/Space");
  assert.equal(isLongPressClick(fence, { ...click, cardId: "documents" }), false);
  assert.equal(isLongPressClick(fence, { ...click, pointerId: 8 }), false);
  assert.equal(isLongPressClick(fence, { ...click, now: 1801 }), false);
  assert.equal(isLongPressClick(null, click), false, "正常短按没有围栏");
  assert.equal(isLongPressClick(fence, { ...click, pointerId: undefined }), true, "旧浏览器 MouseEvent 兼容");
});

test("圈选几何支持反向拖框与已经平移的画布坐标", () => {
  assert.deepEqual(canvasSelectionRect({ x: 900, y: 600 }, { x: 300, y: 200 }), { x: 300, y: 200, width: 600, height: 400 });
  assert.deepEqual(canvasSelectionRect({ x: 1300, y: 800 }, { x: 1500, y: 750 }), { x: 1300, y: 750, width: 200, height: 50 });
});

test("流程内圈选与拖动换算外层组件缩放和滚动，不放大移动距离", () => {
  const start = pointInCanvas({ x: 440, y: 320 }, { x: -160, y: 80 }, 2, 2);
  const end = pointInCanvas({ x: 540, y: 380 }, { x: -160, y: 80 }, 2, 2);
  assert.deepEqual(start, { x: 300, y: 120 });
  assert.deepEqual(translateCanvasGroup([{ x: 200, y: 100 }, { x: 550, y: 180 }], end.x - start.x, end.y - start.y), [{ x: 250, y: 130 }, { x: 600, y: 210 }]);
  assert.deepEqual(pointInCanvas({ x: 240, y: 160 }, { x: 40, y: 60 }, 0.5, 0.5), { x: 400, y: 200 });
});

test("圈选使用实际缩放后边界，交叠/包含可选，空点不选", () => {
  const items = [
    { instanceId: "half-scale", x: 10, y: 20, width: 190, height: 90 },
    { instanceId: "double-scale", x: 500, y: 100, width: 760, height: 500 },
    { instanceId: "outside", x: 1800, y: 100, width: 300, height: 400 },
  ];
  assert.deepEqual(intersectingCanvasItems(items, { x: 180, y: 100, width: 400, height: 300 }), ["half-scale", "double-scale"]);
  assert.deepEqual(intersectingCanvasItems(items, { x: 0, y: 0, width: 400, height: 200 }), ["half-scale"]);
  assert.deepEqual(intersectingCanvasItems(items, { x: 510, y: 110, width: 0, height: 0 }), []);
});

test("多选整体边界约束保持间距与尺寸，不独立挤压靠边组件", () => {
  const items = [{ x: 30, y: 80, scale: 0.5 }, { x: 230, y: 20, scale: 2 }];
  const moved = translateCanvasGroup(items, -200, -200);
  assert.deepEqual(moved, [{ x: 0, y: 60, scale: 0.5 }, { x: 200, y: 0, scale: 2 }]);
  assert.equal(moved[1]!.x - moved[0]!.x, items[1]!.x - items[0]!.x);
  assert.equal(moved[1]!.y - moved[0]!.y, items[1]!.y - items[0]!.y);
  assert.deepEqual(items, [{ x: 30, y: 80, scale: 0.5 }, { x: 230, y: 20, scale: 2 }]);
});

test("多选整组平移保留其他字段，空选择和非法增量不污染坐标", () => {
  const item = { instanceId: "path", x: 20, y: 40, width: 600, collapsed: false };
  assert.deepEqual(translateCanvasGroup([item], 100.4, 35.6), [{ ...item, x: 120, y: 76 }]);
  assert.deepEqual(translateCanvasGroup([], 20, 20), []);
  assert.deepEqual(translateCanvasGroup([item], Number.NaN, 30), [item]);
});

function near(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`); }

test("整组缩放使用同一锚点和倍率，保留大小比例、相对位置及其它字段", () => {
  const items = [
    { id: "a", x: 40.25, y: 120.5, scale: 0.75, width: 280, collapsed: false },
    { id: "b", x: 370.75, y: 40.125, scale: 1.25, width: 380, collapsed: true },
  ];
  const before = structuredClone(items), { items: scaled, factor } = scaleCanvasGroup(items, 1.05);
  assert.equal(factor, 1.05);
  assert.equal(scaled[0]!.x, items[0]!.x); assert.equal(scaled[1]!.y, items[1]!.y);
  for (let index = 0; index < items.length; index++) {
    near(scaled[index]!.x - 40.25, (items[index]!.x - 40.25) * factor);
    near(scaled[index]!.y - 40.125, (items[index]!.y - 40.125) * factor);
    near(scaled[index]!.scale / items[index]!.scale, factor);
    assert.equal(scaled[index]!.width, items[index]!.width); assert.equal(scaled[index]!.collapsed, items[index]!.collapsed);
  }
  near(scaled[1]!.scale / scaled[0]!.scale, items[1]!.scale / items[0]!.scale);
  assert.deepEqual(items, before);
});

test("任一成员达到缩放上下限时限制全组倍率，不分别截断其它成员", () => {
  for (const [scales, requested, expected] of [
    [[1, 1.9], 1.2, 2 / 1.9], [[0.55, 1.1], 0.5, 0.5 / 0.55],
  ] as const) {
    const items = scales.map((scale, index) => ({ x: 40 + index * 330, y: 40 + index * 80, scale }));
    const result = scaleCanvasGroup(items, requested);
    near(result.factor, expected);
    for (let index = 0; index < items.length; index++) near(result.items[index]!.scale / items[index]!.scale, result.factor);
    near(result.items[1]!.x - result.items[0]!.x, 330 * expected);
    near(result.items[1]!.y - result.items[0]!.y, 80 * expected);
  }
  const bounded = [{ x: 0, y: 0, scale: 0.5 }, { x: 100, y: 100, scale: 2 }];
  for (const factor of [0.95, 1.05]) assert.equal(scaleCanvasGroup(bounded, factor).items, bounded);
});

test("恢复指向项100%时仍按相同比例缩放整组，反向滚轮可还原小数坐标", () => {
  const items = [{ x: 10.125, y: 20.875, scale: 0.8 }, { x: 340.375, y: 80.25, scale: 1.2 }];
  const restored = scaleCanvasGroup(items, 1 / items[0]!.scale);
  near(restored.items[0]!.scale, 1); near(restored.items[1]!.scale, 1.5);
  const roundTrip = scaleCanvasGroup(scaleCanvasGroup(items, 1.05).items, 1 / 1.05);
  for (let index = 0; index < items.length; index++) for (const field of ["x", "y", "scale"] as const) near(roundTrip.items[index]![field], items[index]![field]);
});

test("非法倍率、坐标、边界及空组安全无变化", () => {
  const items = [{ x: 10, y: 20, scale: 1 }];
  for (const factor of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) assert.equal(scaleCanvasGroup(items, factor).items, items);
  for (const limits of [[0, 2], [1, 0.5], [0.5, Number.NaN]]) assert.equal(scaleCanvasGroup(items, 1.1, limits[0], limits[1]).items, items);
  for (const item of [{ x: Number.NaN, y: 20, scale: 1 }, { x: -1, y: 20, scale: 1 }, { x: 10, y: 20, scale: 3 }]) {
    const invalid = [item]; assert.equal(scaleCanvasGroup(invalid, 1.1).items, invalid);
  }
  assert.deepEqual(scaleCanvasGroup([], 1.1), { items: [], factor: 1 });
});
