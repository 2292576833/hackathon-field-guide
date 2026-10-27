/**
 * 画布批注（用户 2026-10-13 要求：右击弹出栏含画笔与橡皮）。
 *
 * 用户明确的两条边界：
 *  1. 是**画在画布上的批注**（自由手绘，橡皮擦掉笔迹），不是改组件样式；
 *  2. **不保存**，只是本人临时标记，刷新即清——不落库、不进迁移、不影响队友看到的内容。
 *
 * 同时提供面向团队空间的"标注"工具（用户要求参考 Word 里的工具但按团队空间定制）：
 *  - `highlighter` 荧光笔：半透明粗笔，用来圈出重点而不遮挡下面的组件文字；
 *  - `arrow` 箭头：从 A 指到 B，比手绘箭头更直，适合"看这里"；
 *  - `text` 文字便签：写一句"这里缺检查条件"这类协作提示，定位到具体位置。
 *
 * 设计约束（宪法 v1.20.0 原则 X）：
 *  - 批注**只属于当前浏览器会话**，不写任何状态、不参与完成判定、不影响权限与真实记录；
 *  - 橡皮按**整笔**擦除，不做像素级涂抹；擦除的是自己的批注，不是队友的内容；
 *  - 任何工具都不得让用户误以为"批注 = 任务完成"。
 */

export type AnnotationTool = "pen" | "highlighter" | "arrow" | "text" | "eraser";

export interface AnnotationPoint {
  readonly x: number;
  readonly y: number;
}

export interface AnnotationStroke {
  readonly id: string;
  readonly tool: "pen" | "highlighter" | "arrow";
  readonly color: string;
  /** 线宽（画布坐标，未经缩放换算）。 */
  readonly width: number;
  readonly points: readonly AnnotationPoint[];
}

/** 文字便签：写一句协作提示，钉在画布某个位置。 */
export interface AnnotationNote {
  readonly id: string;
  readonly color: string;
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

export interface AnnotationState {
  readonly strokes: readonly AnnotationStroke[];
  readonly notes: readonly AnnotationNote[];
  /** 已撤销的笔迹，供"重做"使用；清空或新画一笔时按需裁剪。 */
  readonly redo: readonly (AnnotationStroke | AnnotationNote)[];
}

export const ANNOTATION_LIMITS = {
  /** 单笔最多采样点：防止长时间涂鸦把内存和渲染拖垮。 */
  pointsPerStroke: 600,
  /** 会话内最多笔迹数：超出时丢弃最早的，保持画布可用。 */
  strokes: 400,
  notes: 100,
  noteLength: 200,
  redoDepth: 50,
} as const;

export const TOOL_LABELS: Record<AnnotationTool, string> = {
  pen: "画笔", highlighter: "荧光笔", arrow: "箭头", text: "文字便签", eraser: "橡皮",
};

export const TOOL_HINTS: Record<AnnotationTool, string> = {
  pen: "按住左键随手画，用来圈重点、画示意。",
  highlighter: "半透明粗笔，圈出重点但不挡住下面的字。",
  arrow: "从起点拖到终点，画一条指向明确的箭头。",
  text: "点一下写一句提示，例如「这里还缺检查条件」。",
  eraser: "点或划过笔迹即可整笔擦掉。",
};

export const ANNOTATION_COLORS = ["#b8351e", "#2f49b0", "#1f7a4d", "#845311", "#21201c"] as const;

export function emptyAnnotations(): AnnotationState {
  return { strokes: [], notes: [], redo: [] };
}

/** 每种工具的默认线宽；荧光笔明显更粗。 */
export function toolWidth(tool: AnnotationTool): number {
  return tool === "highlighter" ? 18 : tool === "arrow" ? 3 : 2.5;
}

export function toolColor(tool: AnnotationTool, chosen: string): string {
  return tool === "highlighter" ? `${chosen}59` : chosen;
}

/** 追加一笔。达到上限时丢弃最早的一笔，并清空重做栈（新的动作会派生新历史）。 */
export function addStroke(state: AnnotationState, stroke: AnnotationStroke): AnnotationState {
  const strokes = [...state.strokes, stroke].slice(-ANNOTATION_LIMITS.strokes);
  return { strokes, notes: state.notes, redo: [] };
}

export function addNote(state: AnnotationState, note: AnnotationNote): AnnotationState {
  const notes = [...state.notes, note].slice(-ANNOTATION_LIMITS.notes);
  return { strokes: state.strokes, notes, redo: [] };
}

/** 撤销最后一笔或最后一条便签（便签与笔迹共用一个时间顺序，用 id 顺序近似）。 */
export function undoAnnotation(state: AnnotationState): AnnotationState {
  const lastStroke = state.strokes.at(-1);
  const lastNote = state.notes.at(-1);
  if (!lastStroke && !lastNote) return state;
  // 谁后加进来没有统一时间戳，这里按"有便签就先撤便签、否则撤笔迹"的稳定顺序处理，避免猜测。
  if (lastNote) return { strokes: state.strokes, notes: state.notes.slice(0, -1), redo: [...state.redo, lastNote].slice(-ANNOTATION_LIMITS.redoDepth) };
  return { strokes: state.strokes.slice(0, -1), notes: state.notes, redo: [...state.redo, lastStroke!].slice(-ANNOTATION_LIMITS.redoDepth) };
}

export function redoAnnotation(state: AnnotationState): AnnotationState {
  const item = state.redo.at(-1);
  if (!item) return state;
  const redo = state.redo.slice(0, -1);
  if ("points" in item) return { strokes: [...state.strokes, item].slice(-ANNOTATION_LIMITS.strokes), notes: state.notes, redo };
  return { strokes: state.strokes, notes: [...state.notes, item].slice(-ANNOTATION_LIMITS.notes), redo };
}

export function clearAnnotations(): AnnotationState {
  return emptyAnnotations();
}

export function hasAnnotations(state: AnnotationState): boolean {
  return state.strokes.length > 0 || state.notes.length > 0;
}

/** 点到线段的距离平方；用于橡皮命中判定。 */
function distanceSquaredToSegment(point: AnnotationPoint, start: AnnotationPoint, end: AnnotationPoint): number {
  const dx = end.x - start.x, dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  const px = start.x + t * dx, py = start.y + t * dy;
  return (point.x - px) ** 2 + (point.y - py) ** 2;
}

/**
 * 橡皮命中：返回该点附近的笔迹 id（按**整笔**擦除）。
 * 阈值包含笔宽的一半，这样粗的荧光笔不需要点得极准。
 */
export function strokesAt(state: AnnotationState, point: AnnotationPoint, radius = 10): readonly string[] {
  const hit: string[] = [];
  for (const stroke of state.strokes) {
    const threshold = (radius + stroke.width / 2) ** 2;
    for (let index = 1; index < stroke.points.length; index += 1) {
      if (distanceSquaredToSegment(point, stroke.points[index - 1]!, stroke.points[index]!) <= threshold) { hit.push(stroke.id); break; }
    }
  }
  return hit;
}

/** 擦除指定笔迹；返回是否真的擦掉了内容（用于决定要不要提示）。 */
export function eraseStrokes(state: AnnotationState, ids: readonly string[]): AnnotationState {
  if (!ids.length) return state;
  const remove = new Set(ids);
  const strokes = state.strokes.filter(stroke => !remove.has(stroke.id));
  if (strokes.length === state.strokes.length) return state;
  return { strokes, notes: state.notes, redo: [] };
}

/** 便签命中：点在便签框内即算中。 */
export function noteAt(state: AnnotationState, point: AnnotationPoint, radius = 16): string | null {
  for (let index = state.notes.length - 1; index >= 0; index -= 1) {
    const note = state.notes[index]!;
    if (Math.abs(note.x - point.x) <= 90 + radius && Math.abs(note.y - point.y) <= 26 + radius) return note.id;
  }
  return null;
}

export function removeNotes(state: AnnotationState, ids: readonly string[]): AnnotationState {
  if (!ids.length) return state;
  const remove = new Set(ids);
  const notes = state.notes.filter(note => !remove.has(note.id));
  return notes.length === state.notes.length ? state : { strokes: state.strokes, notes, redo: [] };
}

/** 采样点：同一像素范围内的重复点不记录，避免长按产生成千上万个点。 */
export function appendPoint(points: readonly AnnotationPoint[], point: AnnotationPoint, minDistance = 2): readonly AnnotationPoint[] {
  if (points.length >= ANNOTATION_LIMITS.pointsPerStroke) return points;
  const last = points.at(-1);
  if (last && Math.hypot(point.x - last.x, point.y - last.y) < minDistance) return points;
  return [...points, point];
}

/** 便签文本按上限截断；空文本不产生便签。 */
export function normalizeNoteText(text: string): string {
  return text.trim().slice(0, ANNOTATION_LIMITS.noteLength);
}
