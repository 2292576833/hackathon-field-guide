/**
 * 空间画布摆放（规划27 追加 · 用户确认的形态："组件箱 + 自由画布"）。
 *
 * 形态：
 *  - 左侧是**组件箱**（所有可用的组件清单）；
 *  - 用户把需要的组件**拖进画布**自由摆放，每个组件自己拖位置；
 *  - 画布上的组件能**折叠**、**共享**、**删除**；删除只是从画布移除，**不删业务数据**，可随时加回。
 *
 * 约束：这里只处理**摆放偏好**，不碰任何业务数据；坐标只用于显示。
 * 纯函数，便于单测；DOM 与存储都在界面层。
 */
export const SPACE_COMPONENT_KINDS = ["todos", "overview", "path", "teammates", "documents", "supervision", "assistant", "deadline", "scope"] as const;
export type SpaceComponentKind = (typeof SPACE_COMPONENT_KINDS)[number];

/** 放下一个组件时的默认尺寸与可调范围：卡片内容直接铺开，不再套滚动容器。 */
export const CARD = { width: 380, height: 300, gap: 24, margin: 24, minWidth: 280, maxWidth: 900, minHeight: 160, maxHeight: 1400 } as const;

export interface CanvasPlacement {
  /** 实例标识：同一个组件可以放多份（例如两份文档面板）。 */
  readonly instanceId: string;
  readonly kind: SpaceComponentKind;
  readonly x: number;
  readonly y: number;
  readonly collapsed: boolean;
  /** 卡片宽度（滚轮可调）；缺省用 `CARD.width`。 */
  readonly width?: number;
  /** 卡片高度上限；内容超过时**不裁剪**，由内容自己决定实际高度。 */
  readonly height?: number;
  /** 整块组件的缩放比例（滚轮可调，1 = 原始大小）。 */
  readonly scale?: number;
}

/** 缩放范围：缩到 0.5 仍可读，放到 2 倍够用，避免出现无法操作的尺寸。 */
export const SCALE_MIN = 0.5;
export const SCALE_MAX = 2;
export interface CanvasLayout {
  readonly revision: number;
  readonly items: readonly CanvasPlacement[];
}

export const COMPONENT_LABELS: Record<SpaceComponentKind, string> = {
  todos: "我的待办", path: "参赛流程主线", teammates: "队友状态", documents: "空间文档", assistant: "空间 AI 助手",
  deadline: "倒计时与资源", scope: "范围调整",
  overview: "团队进度",
  supervision: "协作提醒",
};
/** 组件箱里的说明，帮用户决定要不要拖进来。 */
export const COMPONENT_HINTS: Record<SpaceComponentKind, string> = {
  todos: "现在要做什么，每件都写清做完的标准", path: "一条可拖动的流程主线，点方框打开那一步",
  teammates: "谁在做什么、等谁确认、谁卡住了；可就地邀请", documents: "全队一起写的文档，可共享给队友编辑",
  assistant: "围绕本场项目的私人助手，点开才建立对话",
  deadline: "还剩多少天、什么阶段；时间没读到就直说未知",
  scope: "时间不够时先保住什么、可以砍掉什么",
  overview: "当前任务进度和我的下一步",
  supervision: "关注协作卡点，按需开启原生DSH自动建议",
};

export function isSpaceComponentKind(value: unknown): value is SpaceComponentKind {
  return typeof value === "string" && (SPACE_COMPONENT_KINDS as readonly string[]).includes(value);
}

/**
 * 默认画布：**上方空白处先放好「参赛流程主线」**。
 * 新人进来就有东西可看可点，不用先理解"组件箱"；其余组件仍由用户从组件箱里挑。
 * 位置避开左侧浮动的组件箱（默认 236 宽 + 12 边距）。
 */
export function emptyLayout(): CanvasLayout {
  return { revision: 0, items: [{ instanceId: "path-1", kind: "path", x: 280, y: CARD.margin, collapsed: false }] };
}
/** New unsaved preference only. UI measures actual content before arranging
 * the flow and document below; existing saved items never go through this seed. */
export function initialCollaborationCanvas(): CanvasLayout {
  return { revision: 0, items: [
    { instanceId: "todos-1", kind: "todos", x: 24, y: 24, width: 380, height: 160, collapsed: false },
    { instanceId: "overview-1", kind: "overview", x: 452, y: 24, width: 380, height: 160, collapsed: false },
    { instanceId: "teammates-1", kind: "teammates", x: 880, y: 24, width: 280, height: 160, collapsed: false },
    { instanceId: "supervision-1", kind: "supervision", x: 1184, y: 24, width: 340, height: 160, collapsed: false },
    { instanceId: "path-1", kind: "path", x: 24, y: 360, collapsed: false },
    { instanceId: "documents-1", kind: "documents", x: 24, y: 2000, width: 860, height: 180, collapsed: false },
  ] };
}
/** 真正没有任何卡片的画布（用于"清空"语义与测试）。 */
export function bareLayout(): CanvasLayout { return { revision: 0, items: [] }; }

/** 归一化：丢弃未知组件与非法坐标、去重实例、补齐实例标识；空值回退空画布。 */
export function normalizeCanvasLayout(input: unknown, revision = 0): CanvasLayout {
  const source = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const items: CanvasPlacement[] = [];
  for (const raw of source) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (!isSpaceComponentKind(item.kind)) continue;
    const instanceId = typeof item.instanceId === "string" && item.instanceId.trim() ? item.instanceId.trim() : `${item.kind}-${items.length + 1}`;
    if (seen.has(instanceId)) continue;
    seen.add(instanceId);
    const x = Number.isFinite(item.x) ? Math.max(0, item.x as number) : 0;
    const y = Number.isFinite(item.y) ? Math.max(0, item.y as number) : 0;
    const width = Number.isFinite(item.width) ? clampWidth(item.width as number) : undefined;
    const height = Number.isFinite(item.height) ? clampHeight(item.height as number) : undefined;
    const scale = Number.isFinite(item.scale) ? clampScale(item.scale as number) : undefined;
    items.push({ instanceId, kind: item.kind, x, y, collapsed: item.collapsed === true,
      ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }),
      ...(scale === undefined ? {} : { scale }) });
  }
  return { revision, items };
}

/** Preserve group scaling precision across save/load; clamp only its readable bounds. */
export function clampScale(value: number): number {
  return Number.isFinite(value) ? Math.min(SCALE_MAX, Math.max(SCALE_MIN, value)) : 1;
}
/** 某张卡片实际使用的缩放比例。 */
export function scaleOf(item: CanvasPlacement): number { return item.scale === undefined ? 1 : clampScale(item.scale); }

/** 滚轮缩放：只改缩放比例，不改位置、不动业务数据。 */
export function scaleOnCanvas(layout: CanvasLayout, instanceId: string, scale: number): CanvasLayout {
  return { ...layout, items: layout.items.map(item => item.instanceId === instanceId
    ? { ...item, scale: clampScale(scale) } : item) };
}

/** 宽度限制在可读范围内，避免被滚轮缩到看不见。 */
export function clampWidth(value: number): number {
  return Math.min(CARD.maxWidth, Math.max(CARD.minWidth, Math.round(value)));
}
/** 高度上限限制在合理范围。 */
export function clampHeight(value: number): number {
  return Math.min(CARD.maxHeight, Math.max(CARD.minHeight, Math.round(value)));
}
/** 某张卡片实际使用的宽度。 */
export function widthOf(item: CanvasPlacement): number { return item.width === undefined ? CARD.width : clampWidth(item.width); }
/** 某张卡片实际使用的高度上限。 */
export function heightOf(item: CanvasPlacement): number { return item.height === undefined ? CARD.height : clampHeight(item.height); }

/** 滚轮改变大小：只改尺寸，不改位置、不动业务数据。 */
export function resizeOnCanvas(layout: CanvasLayout, instanceId: string, width: number, height: number): CanvasLayout {
  return { ...layout, items: layout.items.map(item => item.instanceId === instanceId
    ? { ...item, width: clampWidth(width), height: clampHeight(height) } : item) };
}

/**
 * 根据滚轮事件算出宽高增量（纯函数，便于单测）。
 * 规则：**纵向滚动改高度**（最符合"往下滚就变高"的直觉）；横向滚动改宽度；
 *      按住 `Shift` 时纵向滚动改宽度。
 */
export function wheelResizeDelta(input: { readonly deltaX: number; readonly deltaY: number; readonly shiftKey: boolean }, step = 24, fastStep = 60) {
  const size = input.shiftKey ? fastStep : step;
  const vertical = input.deltaY === 0 ? 0 : (input.deltaY > 0 ? -1 : 1);
  const horizontal = input.deltaX === 0 ? 0 : (input.deltaX > 0 ? -1 : 1);
  const widthDelta = (input.shiftKey ? vertical : horizontal) * size;
  const heightDelta = (input.shiftKey ? 0 : vertical) * size;
  return { widthDelta, heightDelta };
}

/**
 * 根据滚轮事件算出**缩放**增量（纯函数，便于单测）。
 * 规则：`Alt`+滚轮缩放整块组件；向上放大、向下缩小；步长 0.05（`Shift` 时 0.15）。
 */
export function wheelScaleDelta(input: { readonly deltaY: number; readonly shiftKey: boolean }, step = 0.05, fastStep = 0.15) {
  if (input.deltaY === 0) return { scaleDelta: 0 };
  const direction = input.deltaY > 0 ? -1 : 1;
  return { scaleDelta: direction * (input.shiftKey ? fastStep : step) };
}

/**
 * 找一个不与现有卡片重叠的落点：从左到右、从上到下扫描网格。
 * 左侧留出 `safeLeft`（组件箱浮在那边，默认 280px），避免新卡片被组件箱压住。
 */
export function findFreeSpot(items: readonly CanvasPlacement[], canvasWidth = 1180, safeLeft = 280): { x: number; y: number } {
  const step = CARD.width + CARD.gap;
  const startX = Math.max(CARD.margin, safeLeft);
  const perRow = Math.max(1, Math.floor((canvasWidth - startX + CARD.gap) / step));
  const occupied = (x: number, y: number) => items.some(item => Math.abs(item.x - x) < CARD.width && Math.abs(item.y - y) < CARD.height);
  for (let row = 0; row < 40; row += 1) {
    for (let column = 0; column < perRow; column += 1) {
      const x = startX + column * step;
      const y = CARD.margin + row * (CARD.height + CARD.gap);
      if (!occupied(x, y)) return { x, y };
    }
  }
  // 极端情况（网格铺满）时落到最下面，保证仍可用。
  const bottom = items.reduce((max, item) => Math.max(max, item.y + CARD.height), 0) + CARD.gap;
  return { x: startX, y: bottom };
}

/** 放到画布上：自动找空位，不覆盖已有卡片。 */
export function addToCanvas(layout: CanvasLayout, kind: SpaceComponentKind, instanceId: string): CanvasLayout {
  if (layout.items.some(item => item.instanceId === instanceId)) return layout;
  const spot = findFreeSpot(layout.items);
  return { ...layout, items: [...layout.items, { instanceId, kind, x: spot.x, y: spot.y, collapsed: false }] };
}

/** 从画布移除：只影响摆放，**不删任何业务数据**，可再用 `addToCanvas` / `toggleFromCanvas` 加回。 */
export function removeFromCanvas(layout: CanvasLayout, instanceId: string): CanvasLayout {
  return { ...layout, items: layout.items.filter(item => item.instanceId !== instanceId) };
}

/**
 * 组件箱的开关式切换：已在画布上就**收回**（从画布移除，保留它原来的摆放），
 * 不在画布上就**按原位置放回**；没有历史位置时才自动找空位。
 *
 * 这正是用户要的"点击对应组件可收回，再点击一次可在原位置显示"。
 */
export function toggleFromCanvas(layout: CanvasLayout, kind: SpaceComponentKind, remembered?: CanvasPlacement): CanvasLayout {
  // 已存在同类组件：收回它（同类只放一个实例，避免组件箱点一次多出一个）。
  const existing = layout.items.find(item => item.kind === kind);
  if (existing) return removeFromCanvas(layout, existing.instanceId);
  const instanceId = remembered?.instanceId ?? `${kind}-1`;
  const spot = remembered ? { x: remembered.x, y: remembered.y } : findFreeSpot(layout.items);
  const restored: CanvasPlacement = { instanceId, kind, x: spot.x, y: spot.y, collapsed: remembered?.collapsed ?? false,
    ...(remembered?.width === undefined ? {} : { width: remembered.width }),
    ...(remembered?.height === undefined ? {} : { height: remembered.height }),
    ...(remembered?.scale === undefined ? {} : { scale: remembered.scale }) };
  return { ...layout, items: [...layout.items, restored] };
}

export function moveOnCanvas(layout: CanvasLayout, instanceId: string, x: number, y: number): CanvasLayout {
  return { ...layout, items: layout.items.map(item => item.instanceId === instanceId
    ? { ...item, x: Number.isFinite(x) ? Math.max(0, x) : item.x, y: Number.isFinite(y) ? Math.max(0, y) : item.y } : item) };
}

export function toggleCanvasCollapsed(layout: CanvasLayout, instanceId: string): CanvasLayout {
  return { ...layout, items: layout.items.map(item => item.instanceId === instanceId ? { ...item, collapsed: !item.collapsed } : item) };
}

/** 画布按内容撑开：没有内容时给一个最小可放置区域，否则用户没地方拖。 */
export function canvasBounds(items: readonly CanvasPlacement[], minWidth = 720, minHeight = 420): { width: number; height: number } {
  if (items.length === 0) return { width: minWidth, height: minHeight };
  const right = Math.max(...items.map(item => item.x + widthOf(item)));
  const bottom = Math.max(...items.map(item => item.y + (item.collapsed ? 56 : heightOf(item))));
  return { width: Math.max(minWidth, right + CARD.margin), height: Math.max(minHeight, bottom + CARD.margin) };
}

/** 组件箱里还有哪些组件可以加（已全部放上时给出空数组）。 */
export function availableKinds(layout: CanvasLayout): SpaceComponentKind[] {
  const placed = new Set(layout.items.map(item => item.kind));
  return SPACE_COMPONENT_KINDS.filter(kind => !placed.has(kind));
}
