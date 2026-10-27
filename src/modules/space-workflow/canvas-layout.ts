/**
 * 流程画布布局（规划27 第1期 · 用户选择"画布"形态）。
 *
 * 约束：
 *  - 拖动**只改视觉位置**，不改任何任务、进度、阶段或权限事实；
 *  - 位置先只存本地（localStorage），不上服务端，避免并发与迁移成本；
 *  - 连线用 SVG 三次贝塞尔曲线，跟随拖动实时重算；
 *  - 提供"恢复默认排列"，用户永远能回到规整布局。
 *
 * 本模块是纯函数，便于单测；DOM 与存储访问只在明确传入适配器时发生。
 */
export interface CanvasNode { readonly id: string; readonly x: number; readonly y: number }
export interface CanvasSize { readonly width: number; readonly height: number }
export interface Point { readonly x: number; readonly y: number }

/**
 * 画布：**没有外框**，方框按固定像素尺寸自由摆放，任意位置可拖。
 * 这里只提供逻辑坐标与默认排布；尺寸由界面按像素给定，避免缩放把文字压成竖排。
 */
export const CANVAS = { width: 1180, height: 430, nodeWidth: 206, nodeHeight: 104, gap: 40 } as const;

/**
 * 默认排布：折行网格，方框之间留足空隙（为连线留出空间）。
 * 6 个节点在默认宽度下排成两行，每行 3 个，字能完整横排。
 */
export function defaultLayout(ids: readonly string[], canvas: { width: number; height: number; nodeWidth: number; nodeHeight: number; gap: number } = CANVAS): CanvasNode[] {
  const total = ids.length;
  if (total === 0) return [];
  const columnGap = canvas.gap;
  const rowGap = Math.round(canvas.nodeHeight * 0.75);
  const perRow = Math.max(1, Math.min(total, Math.floor((canvas.width + columnGap) / (canvas.nodeWidth + columnGap))));
  const rowCount = Math.ceil(total / perRow);
  return ids.map((id, index) => {
    const row = Math.floor(index / perRow);
    const column = index % perRow;
    // 每行按该行实际数量居中，最后一行不偏左。
    const inRow = Math.min(perRow, total - row * perRow);
    const rowWidth = inRow * canvas.nodeWidth + (inRow - 1) * columnGap;
    const startX = Math.max(0, (canvas.width - rowWidth) / 2);
    const totalHeight = rowCount * canvas.nodeHeight + (rowCount - 1) * rowGap;
    const startY = Math.max(0, (canvas.height - totalHeight) / 2);
    return { id, x: Math.round(startX + column * (canvas.nodeWidth + columnGap)), y: Math.round(startY + row * (canvas.nodeHeight + rowGap)) };
  });
}

/** 长方形右/左边框中点：横向连线从右侧出发、进入下一个的左侧，视觉上像一条流程。 */
export function anchorOf(node: CanvasNode, side: "right" | "left", size: { nodeWidth: number; nodeHeight: number } = CANVAS): Point {
  return { x: node.x + (side === "right" ? size.nodeWidth : 0), y: node.y + size.nodeHeight / 2 };
}

/** 三次贝塞尔：控制点带水平偏移，线会自然弯曲；拖动后自动跟着走。 */
export function connectorPath(from: Point, to: Point): string {
  const dx = Math.max(30, Math.abs(to.x - from.x) * 0.45);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}

/** 节点两两之间的连线路径（按给定顺序，单向不分支）。 */
export function connectorPaths(nodes: readonly CanvasNode[], size: { nodeWidth: number; nodeHeight: number } = CANVAS): { readonly from: string; readonly to: string; readonly d: string }[] {
  const result: { from: string; to: string; d: string }[] = [];
  for (let index = 0; index + 1 < nodes.length; index += 1) {
    const current = nodes[index]!, next = nodes[index + 1]!;
    // 若下一个在左侧（用户拖到左边），改从左/右相反侧出发，避免线穿过方框。
    const backwards = next.x + size.nodeWidth / 2 < current.x + size.nodeWidth / 2;
    result.push({ from: current.id, to: next.id,
      d: connectorPath(anchorOf(current, backwards ? "left" : "right", size), anchorOf(next, backwards ? "right" : "left", size)) });
  }
  return result;
}

/**
 * 拖动限位：只禁止**负坐标**（拖出左上边界会看不见）。
 * 右下不限，容器会随内容撑开——否则用户没法把方框摆到自己想要的位置。
 */
export function clampPosition(node: CanvasNode, _canvas: { width: number; height: number; nodeWidth: number; nodeHeight: number } = CANVAS): CanvasNode {
  return { id: node.id, x: Math.max(0, Math.round(node.x)), y: Math.max(0, Math.round(node.y)) };
}

/**
 * 覆盖所有方框的可见范围（含四周留白），用于让画布**没有多余外框、又不裁切方框**。
 * 新增/拖动到边缘时，容器会自动长大。
 */
export function boundsOf(nodes: readonly CanvasNode[], size: { nodeWidth: number; nodeHeight: number } = CANVAS, padding = 24): { width: number; height: number } {
  if (nodes.length === 0) return { width: size.nodeWidth + padding * 2, height: size.nodeHeight + padding * 2 };
  const right = Math.max(...nodes.map(node => node.x + size.nodeWidth));
  const bottom = Math.max(...nodes.map(node => node.y + size.nodeHeight));
  const left = Math.min(...nodes.map(node => node.x));
  const top = Math.min(...nodes.map(node => node.y));
  return { width: Math.round(right - Math.min(0, left) + padding * 2), height: Math.round(bottom - Math.min(0, top) + padding * 2) };
}

/** 合并已保存位置与新节点：节点集合变化时（新增/移除）缺失的用默认位置补齐。 */
export function mergeLayout(ids: readonly string[], saved: readonly CanvasNode[], canvas: { width: number; height: number; nodeWidth: number; nodeHeight: number; gap: number } = CANVAS): CanvasNode[] {
  const fallback = defaultLayout(ids, canvas);
  const byId = new Map(saved.map(node => [node.id, node]));
  return fallback.map(node => { const kept = byId.get(node.id); return kept ? clampPosition({ id: node.id, x: kept.x, y: kept.y }, canvas) : node; });
}

const STORAGE_PREFIX = "hackathon.space.canvas.";
export function storageKey(projectId: string, userId: string): string { return `${STORAGE_PREFIX}${projectId}.${userId}`; }

/** 读取本地位置；损坏或缺失时回退默认，不抛错、不影响渲染。 */
export function readLayout(ids: readonly string[], raw: string | null | undefined, canvas: { width: number; height: number; nodeWidth: number; nodeHeight: number; gap: number } = CANVAS): CanvasNode[] {
  if (!raw) return defaultLayout(ids, canvas);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultLayout(ids, canvas);
    const nodes = parsed.filter((item): item is CanvasNode => Boolean(item) && typeof item === "object"
      && typeof (item as CanvasNode).id === "string" && Number.isFinite((item as CanvasNode).x) && Number.isFinite((item as CanvasNode).y));
    return mergeLayout(ids, nodes, canvas);
  } catch { return defaultLayout(ids, canvas); }
}
