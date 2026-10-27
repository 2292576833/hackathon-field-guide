// 画布布局（规划27 第1期）：默认排布、连线弯曲、拖动限位、本地位置容错。
import assert from "node:assert/strict";
import test from "node:test";
import { CANVAS, boundsOf, clampPosition, connectorPaths, connectorPath, defaultLayout, mergeLayout, readLayout, storageKey } from "./canvas-layout.ts";

const ids = ["enter", "rules", "planning", "execution", "submission", "reflection"];

test("默认排布：自动折行成不重叠的网格，顺序保持从左到右、从上到下", () => {
  const nodes = defaultLayout(ids);
  assert.equal(nodes.length, ids.length);
  const perRow = new Set(nodes.map(node => node.y)).size > 1 ? nodes.filter(node => node.y === nodes[0]!.y).length : nodes.length;
  assert.ok(perRow >= 1);
  for (const node of nodes) {
    assert.ok(node.x >= 0 && node.x + CANVAS.nodeWidth <= CANVAS.width, "不得超出画布宽度");
    assert.ok(node.y >= 0 && node.y + CANVAS.nodeHeight <= CANVAS.height, "不得超出画布高度");
  }
  // 任意两个方框都不得重叠
  for (let a = 0; a < nodes.length; a += 1) for (let b = a + 1; b < nodes.length; b += 1) {
    const left = nodes[a]!, right = nodes[b]!;
    const overlapX = left.x < right.x + CANVAS.nodeWidth && right.x < left.x + CANVAS.nodeWidth;
    const overlapY = left.y < right.y + CANVAS.nodeHeight && right.y < left.y + CANVAS.nodeHeight;
    assert.ok(!(overlapX && overlapY), `方框 ${left.id} 与 ${right.id} 不应重叠`);
  }
  // 顺序保持：同一行内 x 递增；换行后 y 递增
  for (let index = 1; index < nodes.length; index += 1) {
    const previous = nodes[index - 1]!, current = nodes[index]!;
    assert.ok(current.y > previous.y || current.x > previous.x, "顺序必须保持从左到右、从上到下");
  }
});

test("每行数量随画布宽度自适应，窄画布也不会重叠", () => {
  const narrow = { width: 420, height: 600, nodeWidth: 178, nodeHeight: 96, gap: 34 };
  const ids6 = ["a", "b", "c", "d", "e", "f"];
  const nodes = defaultLayout(ids6, narrow);
  assert.equal(nodes.length, 6);
  for (let a = 0; a < nodes.length; a += 1) for (let b = a + 1; b < nodes.length; b += 1) {
    const left = nodes[a]!, right = nodes[b]!;
    const overlapX = left.x < right.x + narrow.nodeWidth && right.x < left.x + narrow.nodeWidth;
    const overlapY = left.y < right.y + narrow.nodeHeight && right.y < left.y + narrow.nodeHeight;
    assert.ok(!(overlapX && overlapY), `窄画布下 ${left.id} 与 ${right.id} 不应重叠`);
  }
});

test("单个节点也能排布（不会除以零或越界）", () => {
  const nodes = defaultLayout(["only"]);
  assert.equal(nodes.length, 1);
  assert.ok(nodes[0]!.x >= 0);
});

test("连线是贝塞尔曲线，且拖动后会跟着改变（线跟随拖动）", () => {
  const nodes = defaultLayout(ids);
  const before = connectorPaths(nodes);
  assert.equal(before.length, ids.length - 1);
  for (const connector of before) assert.match(connector.d, /^M [-\d.]+ [-\d.]+ C /, "应为三次贝塞尔曲线");
  const moved = nodes.map((node, index) => index === 2 ? { ...node, y: node.y + 60 } : node);
  const after = connectorPaths(moved);
  assert.notEqual(before[1]!.d, after[1]!.d, "节点移动后连线必须重算");
});

test("下一个节点被拖到左边时，连线改从相反侧出发（不穿过方框）", () => {
  const nodes = defaultLayout(ids);
  const backwards = nodes.map((node, index) => index === 1 ? { ...node, x: 0 } : node);
  const paths = connectorPaths(backwards);
  assert.match(paths[0]!.d, /^M /, "仍应生成有效路径");
  assert.notEqual(paths[0]!.d, connectorPaths(nodes)[0]!.d, "反向时应改变出发侧");
});

test("拖动限位：只禁止负坐标（拖出左上会看不见），右下不限、容器随之撑开", () => {
  const negative = clampPosition({ id: "a", x: -500, y: -20 });
  assert.equal(negative.x, 0, "负 x 应收敛到 0");
  assert.equal(negative.y, 0, "负 y 应收敛到 0");

  // 右下不再截断：用户可以把方框摆到自己想要的位置，容器会跟着长大。
  const far = clampPosition({ id: "a", x: 99999, y: 8888 });
  assert.equal(far.x, 99999);
  assert.equal(far.y, 8888);
  const grown = boundsOf([{ id: "a", x: far.x, y: far.y }]);
  assert.ok(grown.width > CANVAS.width, "容器应随内容撑开");
  assert.ok(far.x + CANVAS.nodeWidth <= grown.width, "撑开后不应裁切");
});

test("本地位置容错：损坏内容、错误结构、缺节点都回退默认而不抛错", () => {
  for (const raw of [null, undefined, "", "{不是JSON", "[]", "{}", "[1,2,3]", JSON.stringify([{ id: "enter", x: "x", y: 1 }])]) {
    const nodes = readLayout(ids, raw as string | null | undefined);
    assert.equal(nodes.length, ids.length, "任何输入都应得到完整排布");
    assert.ok(nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));
  }
});

test("本地位置生效：保存过的节点沿用，未保存的用默认补齐", () => {
  const saved = [{ id: "planning", x: 12, y: 40 }];
  const nodes = readLayout(ids, JSON.stringify(saved));
  const planning = nodes.find(node => node.id === "planning")!;
  assert.equal(planning.x, 12);
  assert.equal(planning.y, 40);
  assert.equal(nodes.length, ids.length);
});

test("节点集合变化时保留已有位置、补齐新增节点（新增段不丢）", () => {
  const saved = defaultLayout(ids).map(node => ({ ...node, y: 10 }));
  const extended = mergeLayout([...ids, "新段"], saved);
  assert.equal(extended.length, ids.length + 1);
  const added = extended.find(node => node.id === "新段")!;
  assert.ok(Number.isFinite(added.x) && Number.isFinite(added.y), "新增节点必须有可用位置");
  for (const id of ids) assert.equal(extended.find(node => node.id === id)!.y, 10, "已有位置应保留");
});

test("存储键按项目与账号隔离，不同人互不覆盖", () => {
  assert.notEqual(storageKey("p1", "u1"), storageKey("p1", "u2"));
  assert.notEqual(storageKey("p1", "u1"), storageKey("p2", "u1"));
  assert.match(storageKey("p1", "u1"), /^hackathon\.space\.canvas\./);
});

test("连线路径在极端重合时仍是合法路径（不产生 NaN）", () => {
  const d = connectorPath({ x: 100, y: 100 }, { x: 100, y: 100 });
  assert.ok(!d.includes("NaN"));
  assert.match(d, /^M 100 100 C /);
});

test("容器范围按内容撑开：容得下所有方框，拖到边缘也不裁切", () => {
  const nodes = defaultLayout(ids);
  const bounds = boundsOf(nodes);
  for (const node of nodes) {
    assert.ok(node.x + CANVAS.nodeWidth <= bounds.width, "方框右边缘必须在容器内");
    assert.ok(node.y + CANVAS.nodeHeight <= bounds.height, "方框下边缘必须在容器内");
  }
  // 把最后一个方框拖到右下极限后，容器应随之变大
  const dragged = nodes.map((node, index) => index === nodes.length - 1
    ? clampPosition({ id: node.id, x: 99999, y: 99999 }) : node);
  const grown = boundsOf(dragged);
  assert.ok(grown.width >= bounds.width, "容器不应缩小到裁切内容");
  const last = dragged.find(node => node.id === ids[ids.length - 1]!)!;
  assert.ok(last.x + CANVAS.nodeWidth <= grown.width);
  assert.ok(last.y + CANVAS.nodeHeight <= grown.height);
});

test("空集合也有可用范围（不产生 0 或负数）", () => {
  const empty = boundsOf([]);
  assert.ok(empty.width > 0 && empty.height > 0);
});
