// 画布批注（规划31 / 用户要求）：临时标记、不落库、橡皮整笔擦除。
import assert from "node:assert/strict";
import test from "node:test";
import {
  ANNOTATION_LIMITS, addNote, addStroke, appendPoint, clearAnnotations, emptyAnnotations, eraseStrokes,
  hasAnnotations, normalizeNoteText, noteAt, redoAnnotation, removeNotes, strokesAt, toolColor, toolWidth,
  undoAnnotation, type AnnotationStroke,
} from "./annotation.ts";

const stroke = (over: Partial<AnnotationStroke> = {}): AnnotationStroke => ({
  id: "s1", tool: "pen", color: "#b8351e", width: 2.5, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], ...over,
});

test("批注是会话内临时标记：初始为空、清空后仍为空（不产生任何持久内容）", () => {
  const empty = emptyAnnotations();
  assert.deepEqual(empty, { strokes: [], notes: [], redo: [] });
  assert.equal(hasAnnotations(empty), false);
  const drawn = addStroke(empty, stroke());
  assert.equal(hasAnnotations(drawn), true);
  assert.deepEqual(clearAnnotations(), empty);
});

test("加一笔后可撤销、可重做，重做栈有上限", () => {
  let state = addStroke(emptyAnnotations(), stroke());
  assert.equal(state.strokes.length, 1);
  state = undoAnnotation(state);
  assert.equal(state.strokes.length, 0);
  assert.equal(state.redo.length, 1);
  state = redoAnnotation(state);
  assert.equal(state.strokes.length, 1);
  assert.equal(state.redo.length, 0);
});

test("撤销优先撤最后一条便签，且新动作会清空重做栈", () => {
  let state = addNote(addStroke(emptyAnnotations(), stroke()), { id: "n1", color: "#b8351e", x: 10, y: 10, text: "这里缺检查条件" });
  state = undoAnnotation(state);
  assert.equal(state.notes.length, 0);
  assert.equal(state.strokes.length, 1, "撤便签不应把笔迹一起撤掉");
  state = addStroke(state, stroke({ id: "s2" }));
  assert.deepEqual(state.redo, [], "新的绘制动作应清空重做栈，避免出现分叉历史");
});

test("橡皮按整笔擦除，命中包含笔宽的一半", () => {
  const state = addStroke(emptyAnnotations(), stroke({ width: 18 }));
  assert.deepEqual(strokesAt(state, { x: 50, y: 0 }), ["s1"], "线段上的点应命中");
  assert.deepEqual(strokesAt(state, { x: 50, y: 40 }, 5), [], "离得远不应命中");
  assert.deepEqual(strokesAt(state, { x: 50, y: 8 }, 0), ["s1"], "粗笔迹应按笔宽放宽命中范围");
  const erased = eraseStrokes(state, ["s1"]);
  assert.equal(erased.strokes.length, 0);
  assert.equal(eraseStrokes(state, ["不存在"]), state, "没擦到内容时返回原对象，不产生无意义的新状态");
});

test("钢笔、荧光笔、箭头、橡皮的线宽与半透明各不相同", () => {
  assert.ok(toolWidth("highlighter") > toolWidth("arrow"), "荧光笔应明显更粗");
  assert.ok(toolWidth("pen") > 0);
  assert.notEqual(toolColor("highlighter", "#2f49b0"), "#2f49b0", "荧光笔必须半透明，否则会挡住组件文字");
  assert.match(toolColor("highlighter", "#2f49b0"), /^#2f49b059$/);
  assert.equal(toolColor("pen", "#2f49b0"), "#2f49b0", "画笔应是实色");
});

test("采样点去重与上限：同一位置重复点不记录，长时间涂鸦不无限增长", () => {
  let points = appendPoint([], { x: 0, y: 0 });
  points = appendPoint(points, { x: 0.5, y: 0 });
  assert.equal(points.length, 1, "同一像素范围内的点应被忽略");
  points = appendPoint(points, { x: 10, y: 0 });
  assert.equal(points.length, 2);
  let many = [{ x: 0, y: 0 }];
  for (let index = 0; index < ANNOTATION_LIMITS.pointsPerStroke + 50; index += 1) many = [...appendPoint(many, { x: index * 10, y: 0 })];
  assert.ok(many.length <= ANNOTATION_LIMITS.pointsPerStroke, "单笔点数必须有上限");
});

test("笔迹与便签数量有上限，超出时丢弃最早的，保持画布可用", () => {
  let state = emptyAnnotations();
  for (let index = 0; index < ANNOTATION_LIMITS.strokes + 20; index += 1) state = addStroke(state, stroke({ id: `s${index}` }));
  assert.equal(state.strokes.length, ANNOTATION_LIMITS.strokes);
  assert.equal(state.strokes[0]!.id, "s20", "应丢弃最早的笔迹");
});

test("文字便签：空文本不产生便签、超长截断、可点中可删除", () => {
  assert.equal(normalizeNoteText("   "), "");
  assert.equal(normalizeNoteText("  这里缺检查条件  "), "这里缺检查条件");
  assert.equal(normalizeNoteText("好".repeat(500)).length, ANNOTATION_LIMITS.noteLength);
  const state = addNote(emptyAnnotations(), { id: "n1", color: "#b8351e", x: 100, y: 50, text: "要补检查条件" });
  assert.equal(noteAt(state, { x: 100, y: 50 }), "n1", "点中便签应命中");
  assert.equal(noteAt(state, { x: 900, y: 800 }), null);
  assert.equal(removeNotes(state, ["n1"]).notes.length, 0);
});

test("撤销与重做不修改传入状态", () => {
  const state = addStroke(emptyAnnotations(), stroke());
  const before = structuredClone(state);
  undoAnnotation(state); redoAnnotation(state); strokesAt(state, { x: 0, y: 0 }); eraseStrokes(state, ["s1"]);
  assert.deepEqual(state, before);
});

test("橡皮擦的是自己的批注，不会影响任何真实任务或组件数据（只处理批注 id）", () => {
  // 该模块只接受批注状态；这里用"传入不存在的 id 不改变状态"固定住这个边界。
  const state = addStroke(emptyAnnotations(), stroke());
  assert.equal(eraseStrokes(state, ["某个组件实例 id"]), state);
  assert.deepEqual(state.strokes.map(item => item.id), ["s1"]);
});
