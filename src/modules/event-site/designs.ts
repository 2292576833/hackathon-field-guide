import type { EventSiteSkin } from "./model.ts";

/**
 * 设计灵感：给主办方「拖进画布」的风格模板。
 *
 * 每一条只做两件事：① 套上平台的某套皮肤（封闭枚举）；② 给 AI 一句**风格说明**，
 * 让 AI 按这个语气与结构改写页面。它不携带任何自定义 CSS / 颜色值，
 * 所以拖进来永远不会破坏"只用既有令牌"的约束。
 *
 * 风格命名取自主流排版与视觉传统（瑞士国际主义、报纸头条、发布会主视觉等），
 * 不是从某个具体站点复制代码。
 */
export interface EventSiteDesignPreset {
  readonly id: string;
  readonly name: string;
  readonly mood: string;
  readonly skin: EventSiteSkin;
  /** 三个色块只用于**选择器里的预览**，不写进页面规格。 */
  readonly swatches: readonly [string, string, string];
  /** 给 AI 的风格说明（中文，一句话到两句话）。 */
  readonly brief: string;
}

export const EVENT_SITE_DESIGN_PRESETS: readonly EventSiteDesignPreset[] = Object.freeze([
  {
    id: "swiss",
    name: "瑞士排版",
    mood: "克制、可信、信息优先",
    skin: "paper",
    swatches: ["#fbf8f1", "#1f1c17", "#7a4a1d"],
    brief: "用瑞士国际主义的排版：左对齐、大字号标题、极少装饰、大量留白；句子短、信息密度高，不用感叹号。",
  },
  {
    id: "headline",
    name: "报纸头条",
    mood: "硬朗、有新闻感",
    skin: "dark",
    swatches: ["#0b0d10", "#f4f6f8", "#ff3b30"],
    brief: "像报纸头版：超大粗标题、全大写小标签、条目用细线分隔；文案直接、有结论，不写套话。",
  },
  {
    id: "neon-stage",
    name: "霓虹舞台",
    mood: "年轻、夜里、有现场感",
    skin: "neon",
    swatches: ["#0d0716", "#f3ecff", "#b388ff"],
    brief: "像夜间现场的舞台主视觉：暗底、亮色点缀、短句推进；把报名与截止放在最前面，语气有召唤感但不夸张。",
  },
  {
    id: "launch",
    name: "发布会",
    mood: "正式、克制、产品感",
    skin: "paper",
    swatches: ["#fbf8f1", "#23201a", "#8a5a2b"],
    brief: "像产品发布会页面：居中、宽留白、标题一句话讲清价值；少用列表，多用一句话说明再给一个动作。",
  },
  {
    id: "campus",
    name: "校园手作",
    mood: "亲切、轻快、好读",
    skin: "classic",
    swatches: ["#ffffff", "#21201c", "#ef4d2e"],
    brief: "像校园社团做的页面：语气亲切、句子短、把「谁可以来」「要带什么」说清楚；不要官腔。",
  },
  {
    id: "editorial",
    name: "杂志专栏",
    mood: "有叙事、耐读",
    skin: "classic",
    swatches: ["#ffffff", "#21201c", "#b8351e"],
    brief: "像杂志专栏：先讲一个小背景，再讲怎么参加；段落短、有节奏，避免条目堆砌。",
  },
]);

export function designPreset(id: string): EventSiteDesignPreset | null {
  return EVENT_SITE_DESIGN_PRESETS.find(preset => preset.id === id) ?? null;
}
