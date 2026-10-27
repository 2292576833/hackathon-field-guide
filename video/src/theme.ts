/** 视频视觉令牌：与网站设计令牌保持一致（纸色 / 墨色 / 品牌橙红），保证"纪录"是同一种气质。 */
export const COLORS = {
  paper: "#f6f3eb",
  paperDeep: "#efeade",
  surface: "#fffdf8",
  ink: "#21201c",
  inkSoft: "#4a463d",
  muted: "#6f6a5e",
  brand: "#ef4d2e",
  action: "#b8351e",
  line: "#d9d4c8",
  lineSoft: "#e7e2d7",
  success: "#2c6647",
  quote: "#8a8377",
} as const;

/** Windows 本机可用字体优先；不依赖网络字体，避免渲染时缺字。 */
export const FONT_STACK =
  '"Source Han Sans SC","Noto Sans SC","Microsoft YaHei","PingFang SC","Hiragino Sans GB",system-ui,sans-serif';

export const FPS = 30;
/** 4K 输出：文字与矢量元素按 3840 宽原生渲染，页面截图也是 2 倍像素（3840×2160），避免放大发虚。 */
export const WIDTH = 3840;
export const HEIGHT = 2160;
/** 全片时长（帧）。音乐 134.4 秒，但画面按更快的节奏收在约 118 秒，避免末尾拖沓。 */
export const DURATION_IN_FRAMES = 3540;
/** 音乐淡出起点（帧），让结尾自然收束而不是被硬切。 */
export const MUSIC_FADE_OUT_FRAMES = 300;

/**
 * 入场动画时长（帧）。从 0.75 秒（≈23 帧）收紧到 0.42 秒（13 帧）——
 * 这是"节奏更快"最直接的来源：内容上屏更快，观众不必等。
 */
export const REVEAL_FRAMES = 13;

export const sec = (seconds: number) => Math.round(seconds * FPS);
