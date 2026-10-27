import type { SpaceGuideStep, SpaceGuideStepId } from "./guide-tree.ts";

export interface SpaceFlowNode {
  id: string;
  kind: "action" | "link" | "tool";
  actionId: string;
  stageId: SpaceGuideStepId;
  title: string;
  href?: string;
  purpose?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale?: number;
}
export interface SpaceFlowEdge { from: string; to: string; kind: "main" | "resource" }
export interface SpaceFlowGraph {
  nodes: SpaceFlowNode[];
  edges: SpaceFlowEdge[];
  stages: { id: SpaceGuideStepId; title: string; x: number; y: number }[];
}
export interface FlowPosition { x: number; y: number; scale?: number }
const stageLabels: Record<SpaceGuideStepId, string> = {
  enter: "作品目标", rules: "比赛要求", planning: "分工与时间", execution: "任务与交接", submission: "演示与提交", reflection: "复盘与经验",
};
const actionLabels: Record<string, string> = {
  goal: "写清作品目标", invite: "邀请队友（可选）", registration: "核对报名", "official-track": "选择官方赛道", requirements: "确认要求与截止",
  "duties-time": "选职责，填时间", assignment: "确认分工与草案", "applied-plan": "核对并确认计划", "start-task": "查看任务与前置条件",
  handoff: "交成果，做好交接", "check-unlock": "检查成果，继续任务", "code-runtime": "核对版本与运行", "presentation-materials": "准备 PPT、视频与路演",
  "formal-submission": "正式提交，保留依据", retrospective: "整理成果与经验", "reuse-archive": "选择复用或归档",
};
const resourceLabels: Record<string, string> = {
  "填写作品目标与最小成果": "填写作品目标", "查看目标，与管理员核对": "查看作品目标", "查看完整参赛路线图": "参赛路线图",
  "打开邀请队友窗口": "邀请窗口", "查看队友，联系空间管理员邀请": "查看队友", "去比赛与资料核对要求": "比赛要求",
  "查看与更新本空间赛事线索": "赛事线索", "去找比赛页查看线索": "找比赛", "黑客松与规则入门": "规则入门",
  "去队友与分工填写本人时间": "本人可用时间", "选择职责，查看分工建议": "职责与分工建议", "个人参赛与出行准备": "参赛与出行准备",
  "确认职责与分工": "确认职责分工", "去任务进度查看安排": "任务进度", "查看本空间共享资料": "共享资料", "找视觉与组件灵感": "视觉与组件灵感",
  "AI 技能与赛道包": "AI 技能与赛道包", "GitHub 全流程教程": "GitHub 教程", "保存代码或查看运行记录": "代码与运行记录",
  "查看代码保存与当前版本运行": "版本与运行记录", "准备路演讲稿": "路演讲稿", "准备 PPT 大纲": "PPT 大纲",
  "核对材料并查看正式提交依据": "正式提交记录", "查看或整理本空间复盘": "本场复盘", "回看代码、运行和正式提交": "交付历史",
  "查看经验与选择性复用": "经验与复用", "查看空间设置与历史": "设置与历史", "打开空间设置，按需归档": "空间设置", "查看空间设置，联系管理员归档": "空间设置",
  "回顾参赛路线图": "参赛路线图",
};
export const FLOW_GRAPH = { actionWidth: 236, actionHeight: 82, resourceWidth: 214, resourceHeight: 62, resourceGap: 24, rowGap: 18, columns: 3, padding: 320 } as const;

export function clampSpaceFlowScale(value: number): number {
  return Number.isFinite(value) ? Math.min(2, Math.max(0.5, value)) : 1;
}

/** SVG and bounds use visual rectangles, while DOM measurement stays unscaled. */
export function scaleSpaceFlowNodes(nodes: readonly SpaceFlowNode[]): SpaceFlowNode[] {
  return nodes.map(node => { const scale = clampSpaceFlowScale(node.scale ?? 1); return { ...node, scale, width: node.width * scale, height: node.height * scale }; });
}

/** ResizeObserver reports unscaled border boxes. Apply both measured axes before
 * scaling, leaving the guide graph and private placement untouched. */
export function measureSpaceFlowNodes(nodes: readonly SpaceFlowNode[], sizes: Readonly<Record<string, { width: number; height: number }>>): SpaceFlowNode[] {
  return nodes.map(node => {
    const size = sizes[node.id];
    return { ...node, ...(size && Number.isFinite(size.width) && size.width > 0 ? { width: size.width } : {}),
      ...(size && Number.isFinite(size.height) && size.height > 0 ? { height: size.height } : {}) };
  });
}

/** Every real action and each of its existing links/tools is an independent
 * visible node. Stages are light labels, never another card or progress state. */
export function buildSpaceFlowGraph(steps: readonly SpaceGuideStep[], options: { includeResources?: boolean } = {}): SpaceFlowGraph {
  const nodes: SpaceFlowNode[] = [], edges: SpaceFlowEdge[] = [], stages: SpaceFlowGraph["stages"] = [];
  let cursor = 24, previousAction: string | null = null;
  for (const step of steps) {
    stages.push({ id: step.id, title: stageLabels[step.id], x: 16, y: cursor });
    cursor += 34;
    for (const action of step.nodes) {
      const resources = options.includeResources === false ? [] : [...action.links.map(link => ({ ...link, kind: "link" as const })), ...action.tools.map(link => ({ ...link, kind: "tool" as const }))];
      const rows = Math.ceil(resources.length / FLOW_GRAPH.columns);
      const height = Math.max(FLOW_GRAPH.actionHeight, rows * (FLOW_GRAPH.resourceHeight + FLOW_GRAPH.rowGap) - FLOW_GRAPH.rowGap);
      const actionId = `action:${action.id}`;
      nodes.push({ id: actionId, kind: "action", actionId: action.id, stageId: step.id, title: actionLabels[action.id] ?? action.title,
        x: 160, y: cursor + Math.round((height - FLOW_GRAPH.actionHeight) / 2), width: FLOW_GRAPH.actionWidth, height: FLOW_GRAPH.actionHeight });
      if (previousAction) edges.push({ from: previousAction, to: actionId, kind: "main" });
      previousAction = actionId;
      resources.forEach((resource, index) => {
        const id = `resource:${action.id}:${resource.kind}:${index}`;
        nodes.push({ id, kind: resource.kind, actionId: action.id, stageId: step.id, title: resourceLabels[resource.title] ?? resource.title, href: resource.href, purpose: resource.purpose,
          x: 438 + (index % FLOW_GRAPH.columns) * (FLOW_GRAPH.resourceWidth + FLOW_GRAPH.resourceGap),
          y: cursor + Math.floor(index / FLOW_GRAPH.columns) * (FLOW_GRAPH.resourceHeight + FLOW_GRAPH.rowGap), width: FLOW_GRAPH.resourceWidth, height: FLOW_GRAPH.resourceHeight });
        edges.push({ from: actionId, to: id, kind: "resource" });
      });
      cursor += height + 44;
    }
    cursor += 12;
  }
  return { nodes, edges, stages };
}

/** New version keys deliberately leave the old six-card canvas history intact. */
export function spaceFlowStorageKey(projectId: string, userId: string, mobile = false): string {
  return `hackathon.space.flow.v2.${mobile ? "mobile-order." : "desktop."}${encodeURIComponent(projectId)}.${encodeURIComponent(userId)}`;
}

export function readSpaceFlowPositions(nodes: readonly SpaceFlowNode[], raw: string | null): Record<string, FlowPosition> {
  const positions: Record<string, FlowPosition> = Object.fromEntries(nodes.map(node => [node.id, { x: node.x, y: node.y }]));
  if (!raw) return positions;
  try {
    const saved: unknown = JSON.parse(raw);
    if (!Array.isArray(saved)) return positions;
    for (const item of saved) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const point = item as Record<string, unknown>;
      if (typeof point.id !== "string" || !Object.hasOwn(positions, point.id) || typeof point.x !== "number" || !Number.isFinite(point.x)
        || typeof point.y !== "number" || !Number.isFinite(point.y) || point.x < 0 || point.y < 0) continue;
      positions[point.id] = { x: point.x, y: point.y,
        ...(typeof point.scale === "number" && Number.isFinite(point.scale) ? { scale: clampSpaceFlowScale(point.scale) } : {}) };
    }
  } catch { /* corrupt preference has no effect on business facts */ }
  return positions;
}

export function readSpaceFlowOrder(nodes: readonly SpaceFlowNode[], raw: string | null): string[] {
  const known = new Set(nodes.map(node => node.id)), order: string[] = [];
  try {
    const saved: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(saved)) for (const id of saved) if (typeof id === "string" && known.has(id) && !order.includes(id)) order.push(id);
  } catch { /* use the normal graph order */ }
  for (const node of nodes) if (!order.includes(node.id)) order.push(node.id);
  return order;
}

export function moveSpaceFlowOrder(order: readonly string[], id: string, index: number): string[] {
  if (!order.includes(id) || !Number.isFinite(index)) return [...order];
  const next = order.filter(value => value !== id);
  next.splice(Math.max(0, Math.min(next.length, Math.round(index))), 0, id);
  return next;
}

/** Phone positions are derived only from its independent order, never desktop
 * coordinates. Leave two narrow lanes for main and resource connections. */
export function mobileSpaceFlowNodes(nodes: readonly SpaceFlowNode[], order: readonly string[], width: number): SpaceFlowNode[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const result: SpaceFlowNode[] = [];
  const labelled = new Set<SpaceGuideStepId>();
  let y = 38;
  for (const id of order) {
    const node = byId.get(id); if (!node) continue;
    if (node.kind === "action" && !labelled.has(node.stageId)) { y += 28; labelled.add(node.stageId); }
    const x = node.kind === "action" ? 40 : 56;
    const next = { ...node, x, y, scale: 1, width: Math.max(120, width - x - 4) };
    result.push(next); y += next.height + 20;
  }
  return result;
}

export function spaceFlowBounds(nodes: readonly SpaceFlowNode[], padding: number = FLOW_GRAPH.padding): { width: number; height: number } {
  return { width: Math.max(1, ...nodes.map(node => node.x + node.width)) + padding,
    height: Math.max(1, ...nodes.map(node => node.y + node.height)) + padding };
}

/** Ends are computed from the actual current node rectangles, so every line
 * follows movement and measured height. SVG owns no pointer interactions. */
export function spaceFlowPaths(nodes: readonly SpaceFlowNode[], edges: readonly SpaceFlowEdge[], mobile = false): (SpaceFlowEdge & { d: string })[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  return edges.flatMap(edge => {
    const from = byId.get(edge.from), to = byId.get(edge.to);
    if (!from || !to) return [];
    const fromY = from.y + from.height / 2, toY = to.y + to.height / 2;
    let d: string;
    if (mobile) {
      const lane = edge.kind === "main" ? 8 : 24;
      d = `M ${from.x} ${fromY} H ${lane} V ${toY} H ${to.x}`;
    } else if (edge.kind === "main") {
      const down = toY >= fromY;
      const sx = from.x + from.width / 2, sy = from.y + (down ? from.height : 0);
      const tx = to.x + to.width / 2, ty = to.y + (down ? 0 : to.height);
      const middle = (sy + ty) / 2;
      d = `M ${sx} ${sy} C ${sx} ${middle}, ${tx} ${middle}, ${tx} ${ty}`;
    } else if (to.x >= from.x + from.width + 20) {
      // A branch goes above its resource row, rather than through the title of
      // a resource in an earlier column.
      const sx = from.x + from.width, trunk = sx + 18, tx = to.x + to.width / 2, laneY = to.y - 12;
      d = `M ${sx} ${fromY} H ${trunk} V ${laneY} H ${tx} V ${to.y}`;
    } else {
      const right = to.x + to.width / 2 >= from.x + from.width / 2;
      const sx = from.x + (right ? from.width : 0), tx = to.x + (right ? 0 : to.width);
      const middle = (sx + tx) / 2;
      d = `M ${sx} ${fromY} C ${middle} ${fromY}, ${middle} ${toY}, ${tx} ${toY}`;
    }
    return [{ ...edge, d }];
  });
}
