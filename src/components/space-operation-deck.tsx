"use client";

import type { ProjectDetail } from "./projects-client.tsx";
import { SpaceCanvasBoard } from "./space-canvas-board.tsx";

/**
 * 空间首屏（规划27 第1期 + 追加）：**组件箱 + 自由画布**形态。
 * 左侧组件箱、画布自由摆放；每张卡片可拖动、折叠、删除（只从画布移除，不删数据）。
 * 布局是本人私有偏好；有没有队友都停在这个界面。
 */
export function SpaceOperationDeck({ detail, reload, membersError }: { detail: ProjectDetail; reload: () => Promise<void>; membersError?: string }) {
  return <SpaceCanvasBoard detail={detail} reload={reload} membersError={membersError}/>;
}
