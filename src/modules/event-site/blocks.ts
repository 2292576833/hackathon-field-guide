import { DomainError } from "../../shared/errors.ts";
import type {
  EventSiteActionBlockKind, EventSiteActionTarget, EventSiteBinding, EventSiteBindingField,
  EventSiteBindingSource, EventSiteBlockCategory, EventSiteBlockKind, EventSiteBlockNode,
  EventSiteContentBlockKind, EventSitePageSpec, EventSitePriority,
} from "./model.ts";

/**
 * 区块注册表：**封闭枚举**（规划 35 §4）。
 *
 * 每一条声明固定六件事：kind、中文标签、允许的变体、是否必须数据绑定、
 * 文案是否必填与长度上限、是否允许嵌套、是否属于事实类。
 * 校验器与规则提醒都**只读这张表**，不在别处硬编码长度或变体。
 */

export interface EventSiteTextRules {
  /** none：不接受任何文案字段；optional：可空；required：text 必填。 */
  readonly requirement: "none" | "optional" | "required";
  /** 0 表示该块不接受 heading。 */
  readonly maxHeading: number;
  /** 0 表示该块不接受 text。 */
  readonly maxText: number;
  /** 0 表示该块不接受 items。 */
  readonly maxItems: number;
  readonly minItems: number;
  readonly maxItemHeading: number;
  readonly maxItemText: number;
}

export interface EventSiteBlockDeclaration {
  readonly kind: EventSiteBlockKind;
  readonly category: EventSiteBlockCategory;
  /** 中文标签（编辑器、提示条、删除建议统一用它）。 */
  readonly label: string;
  /** hover 时显示的一句人话（规划 35 §19.4）。 */
  readonly hint: string;
  readonly variants: readonly string[];
  readonly defaultVariant: string;
  /** 这些变体强制桌面整行（引擎派生用）。 */
  readonly fullWidthVariants: readonly string[];
  /** 是否必须用 binding 指定数据源。 */
  readonly requiresBinding: boolean;
  /** 允许绑定的字段（闭合；每块只能绑自己领得到的字段）。 */
  readonly allowedBindingFields: readonly EventSiteBindingField[];
  readonly textRules: EventSiteTextRules;
  /** 是否允许嵌套别的区块；只有容器为 true。 */
  readonly allowsNesting: boolean;
  /** 事实类：内容来自平台记录，只能绑定、不能手写（宪法 XIV）。 */
  readonly factClass: boolean;
  /** 是否带图片（计入「图片区块 ≤ 8」）。 */
  readonly carriesImage: boolean;
  /** 是否必须带图片。 */
  readonly requiresImage: boolean;
  /** 条目里是否可以带图片（赞助商墙、人物墙）。 */
  readonly itemImage: boolean;
  /** 动作跳板的固定平台目标；非动作为 null。 */
  readonly actionTarget: EventSiteActionTarget | null;
  /** 归属的默认模块名（默认模块集用，便于界面按模块说明）。 */
  readonly moduleLabel: string;
}

/** 每个字段唯一归属的数据源：source 与 field 不匹配直接拒绝。 */
export const EVENT_SITE_BINDING_FIELD_SOURCE: Readonly<Record<EventSiteBindingField, EventSiteBindingSource>> = {
  registrationCloses: "eventSchedule",
  submissionCloses: "eventSchedule",
  startsAt: "eventSchedule",
  endsAt: "eventSchedule",
  scheduleNodes: "eventSchedule",
  faqEntries: "eventFaq",
};

const noText: EventSiteTextRules = {
  requirement: "none", maxHeading: 0, maxText: 0, maxItems: 0, minItems: 0, maxItemHeading: 0, maxItemText: 0,
};

export const EVENT_SITE_BLOCK_REGISTRY: Readonly<Record<EventSiteBlockKind, EventSiteBlockDeclaration>> = {
  /* ---------------- 8 个内容区块 ---------------- */
  countdown: {
    kind: "countdown",
    category: "content",
    label: "倒计时",
    hint: "这块是倒计时，时间来自你的赛程，不能手填。",
    variants: ["compact", "banner"],
    defaultVariant: "compact",
    fullWidthVariants: ["banner"],
    requiresBinding: true,
    allowedBindingFields: ["registrationCloses", "submissionCloses", "startsAt", "endsAt"],
    textRules: { ...noText, maxHeading: 24 },
    allowsNesting: false,
    factClass: true,
    carriesImage: false,
    requiresImage: false,
    itemImage: false,
    actionTarget: null,
    moduleLabel: "赛事信息",
  },
  highlights: {
    kind: "highlights",
    category: "content",
    label: "要点卡片",
    hint: "这块放你自己写的要点，每条一句，不执行任何代码。",
    variants: ["grid", "list"],
    defaultVariant: "grid",
    fullWidthVariants: [],
    requiresBinding: false,
    allowedBindingFields: [],
    textRules: { requirement: "optional", maxHeading: 60, maxText: 400, maxItems: 6, minItems: 1, maxItemHeading: 40, maxItemText: 120 },
    allowsNesting: false,
    factClass: false,
    carriesImage: false,
    requiresImage: false,
    itemImage: false,
    actionTarget: null,
    moduleLabel: "赛事信息",
  },
  sponsorWall: {
    kind: "sponsorWall",
    category: "content",
    label: "赞助商／合作方墙",
    hint: "这块放赞助商名字与 Logo，图片走既有上传校验。",
    variants: ["logoGrid", "logoRow"],
    defaultVariant: "logoGrid",
    fullWidthVariants: ["logoRow"],
    requiresBinding: false,
    allowedBindingFields: [],
    textRules: { requirement: "optional", maxHeading: 60, maxText: 200, maxItems: 24, minItems: 1, maxItemHeading: 40, maxItemText: 60 },
    allowsNesting: false,
    factClass: false,
    carriesImage: true,
    requiresImage: false,
    itemImage: true,
    actionTarget: null,
    moduleLabel: "赞助商",
  },
  timeline: {
    kind: "timeline",
    category: "content",
    label: "时间线",
    hint: "这块是赛程，节点来自平台赛程记录，不能手填。",
    variants: ["vertical", "compact"],
    defaultVariant: "vertical",
    fullWidthVariants: [],
    requiresBinding: true,
    allowedBindingFields: ["scheduleNodes"],
    textRules: { ...noText, maxHeading: 40 },
    allowsNesting: false,
    factClass: true,
    carriesImage: false,
    requiresImage: false,
    itemImage: false,
    actionTarget: null,
    moduleLabel: "赛程",
  },
  peopleWall: {
    kind: "peopleWall",
    category: "content",
    label: "评委／导师／嘉宾墙",
    hint: "这块放人物名字与照片，都是你自己填的介绍。",
    variants: ["grid", "row"],
    defaultVariant: "grid",
    fullWidthVariants: ["row"],
    requiresBinding: false,
    allowedBindingFields: [],
    textRules: { requirement: "optional", maxHeading: 60, maxText: 200, maxItems: 24, minItems: 1, maxItemHeading: 40, maxItemText: 120 },
    allowsNesting: false,
    factClass: false,
    carriesImage: true,
    requiresImage: false,
    itemImage: true,
    actionTarget: null,
    moduleLabel: "评委与嘉宾",
  },
  faq: {
    kind: "faq",
    category: "content",
    label: "常见问题",
    hint: "这块是平台的公开 FAQ 投影，不能自己编问答。",
    variants: ["accordion", "plain"],
    defaultVariant: "accordion",
    fullWidthVariants: [],
    requiresBinding: true,
    allowedBindingFields: ["faqEntries"],
    textRules: { ...noText, maxHeading: 40 },
    allowsNesting: false,
    factClass: true,
    carriesImage: false,
    requiresImage: false,
    itemImage: false,
    actionTarget: null,
    moduleLabel: "FAQ",
  },
  bannerImage: {
    kind: "bannerImage",
    category: "content",
    label: "图片横幅",
    hint: "这块是一张大图，有固定比例，宽度不会超出手机屏。",
    variants: ["wide", "square"],
    defaultVariant: "wide",
    fullWidthVariants: ["wide"],
    requiresBinding: false,
    allowedBindingFields: [],
    textRules: { requirement: "optional", maxHeading: 60, maxText: 120, maxItems: 0, minItems: 0, maxItemHeading: 0, maxItemText: 0 },
    allowsNesting: false,
    factClass: false,
    carriesImage: true,
    requiresImage: true,
    itemImage: false,
    actionTarget: null,
    moduleLabel: "主视觉",
  },
  richText: {
    kind: "richText",
    category: "content",
    label: "文字段落",
    hint: "这块是纯文本段落，按纯文本显示，不执行 HTML。",
    variants: ["prose", "callout", "footer"],
    defaultVariant: "prose",
    fullWidthVariants: ["footer"],
    requiresBinding: false,
    allowedBindingFields: [],
    textRules: { requirement: "required", maxHeading: 60, maxText: 2000, maxItems: 0, minItems: 0, maxItemHeading: 0, maxItemText: 0 },
    allowsNesting: false,
    factClass: false,
    carriesImage: false,
    requiresImage: false,
    itemImage: false,
    actionTarget: null,
    moduleLabel: "公告",
  },

  /* ---------------- 4 个动作跳板（只跳转，不承载表单） ---------------- */
  actionRegister: {
    kind: "actionRegister",
    category: "action",
    label: "报名跳板",
    hint: "点了会跳到平台的报名页；表单不在这一页。",
    variants: ["primary", "inline", "banner"],
    defaultVariant: "primary",
    fullWidthVariants: ["banner"],
    requiresBinding: false,
    allowedBindingFields: [],
    textRules: noText,
    allowsNesting: false,
    factClass: false,
    carriesImage: false,
    requiresImage: false,
    itemImage: false,
    actionTarget: "register",
    moduleLabel: "报名",
  },
  actionSubmit: {
    kind: "actionSubmit",
    category: "action",
    label: "提交跳板",
    hint: "点了会跳到平台的提交页；作品只走平台收件。",
    variants: ["primary", "inline", "banner"],
    defaultVariant: "primary",
    fullWidthVariants: ["banner"],
    requiresBinding: false,
    allowedBindingFields: [],
    textRules: noText,
    allowsNesting: false,
    factClass: false,
    carriesImage: false,
    requiresImage: false,
    itemImage: false,
    actionTarget: "submit",
    moduleLabel: "提交",
  },
  actionResults: {
    kind: "actionResults",
    category: "action",
    label: "结果跳板",
    hint: "点了会跳到平台的结果页；成绩只在平台算。",
    variants: ["primary", "inline", "banner"],
    defaultVariant: "inline",
    fullWidthVariants: ["banner"],
    requiresBinding: false,
    allowedBindingFields: [],
    textRules: noText,
    allowsNesting: false,
    factClass: false,
    carriesImage: false,
    requiresImage: false,
    itemImage: false,
    actionTarget: "results",
    moduleLabel: "结果",
  },
  actionAppeal: {
    kind: "actionAppeal",
    category: "action",
    label: "申诉跳板",
    hint: "点了会跳到平台的申诉页；申诉不会改分数。",
    variants: ["primary", "inline", "text", "banner"],
    defaultVariant: "inline",
    fullWidthVariants: ["banner"],
    requiresBinding: false,
    allowedBindingFields: [],
    textRules: noText,
    allowsNesting: false,
    factClass: false,
    carriesImage: false,
    requiresImage: false,
    itemImage: false,
    actionTarget: "appeal",
    moduleLabel: "申诉",
  },

  /* ---------------- 1 个容器 ---------------- */
  aiBlock: {
    kind: "aiBlock",
    category: "container",
    label: "AI 组件",
    hint: "框住几块，它只改这几块的写法，不改事实。",
    variants: ["plain", "card"],
    defaultVariant: "plain",
    fullWidthVariants: [],
    requiresBinding: false,
    allowedBindingFields: [],
    textRules: noText,
    allowsNesting: true,
    factClass: false,
    carriesImage: false,
    requiresImage: false,
    itemImage: false,
    actionTarget: null,
    moduleLabel: "AI 组件",
  },
};

export const EVENT_SITE_BLOCK_KINDS: readonly EventSiteBlockKind[] = Object.freeze(
  Object.keys(EVENT_SITE_BLOCK_REGISTRY).sort() as EventSiteBlockKind[],
);

export const EVENT_SITE_CONTENT_BLOCK_KINDS: readonly EventSiteContentBlockKind[] = Object.freeze(
  EVENT_SITE_BLOCK_KINDS.filter((kind): kind is EventSiteContentBlockKind => EVENT_SITE_BLOCK_REGISTRY[kind].category === "content"),
);

export const EVENT_SITE_ACTION_BLOCK_KINDS: readonly EventSiteActionBlockKind[] = Object.freeze(
  EVENT_SITE_BLOCK_KINDS.filter((kind): kind is EventSiteActionBlockKind => EVENT_SITE_BLOCK_REGISTRY[kind].category === "action"),
);

export function isEventSiteBlockKind(value: unknown): value is EventSiteBlockKind {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(EVENT_SITE_BLOCK_REGISTRY, value);
}

export function isEventSiteActionKind(value: unknown): value is EventSiteActionBlockKind {
  return typeof value === "string" && (EVENT_SITE_ACTION_BLOCK_KINDS as readonly string[]).includes(value);
}

/** 取声明；未知 kind 抛 EVENT_SITE_UNKNOWN_BLOCK_KIND（封闭枚举，不做兜底渲染）。 */
export function blockDeclaration(kind: unknown): EventSiteBlockDeclaration {
  if (!isEventSiteBlockKind(kind)) {
    throw new DomainError("EVENT_SITE_UNKNOWN_BLOCK_KIND", "区块类型「" + String(kind) + "」不在注册表里。", { status: 422 });
  }
  return EVENT_SITE_BLOCK_REGISTRY[kind];
}

export function variantsOf(kind: EventSiteBlockKind): readonly string[] {
  return EVENT_SITE_BLOCK_REGISTRY[kind].variants;
}

/** 动作跳板在平台上的固定目标。 */
export function actionTargetOf(kind: EventSiteActionBlockKind): EventSiteActionTarget {
  const target = EVENT_SITE_BLOCK_REGISTRY[kind].actionTarget;
  if (target === null) throw new DomainError("EVENT_SITE_UNKNOWN_BLOCK_KIND", "这个区块不是动作跳板。", { status: 422 });
  return target;
}

/* ------------------------------------------------------------------ *
 * 默认模块集（规划 35 §5）
 * ------------------------------------------------------------------ */

function scheduleBinding(field: EventSiteBindingField): EventSiteBinding {
  return { source: EVENT_SITE_BINDING_FIELD_SOURCE[field], field };
}

/**
 * 新建专属页的默认规格：**默认全在**（规划 35 §5 第 1 条）。
 *
 * 8 个默认模块与区块的对应关系（README 与交付文档同表）：
 *
 * | 默认模块 | 区块 |
 * | --- | --- |
 * | 赛事信息 | countdown（绑定报名截止） |
 * | 报名 | actionRegister |
 * | 提交 | actionSubmit |
 * | 赛程 | timeline（绑定赛程节点） |
 * | 公告 | richText（prose） |
 * | FAQ | faq（绑定公开 FAQ 投影） |
 * | 结果 | actionResults |
 * | 页脚 | richText（footer，平台署名不可删） |
 *
 * 全部区块都可被删除；删空后仍是合法规格（规划 35 §5 第 3 条）。
 */
export function defaultPageSpec(): EventSitePageSpec {
  return {
    version: 1,
    blocks: [
      {
        kind: "countdown", id: "b1", variant: "banner", priority: 5, collapse: false,
        heading: null, text: null, items: [], image: null, binding: scheduleBinding("registrationCloses"),
      },
      { kind: "actionRegister", id: "b2", variant: "primary", priority: 5, collapse: false, action: "register" },
      { kind: "actionSubmit", id: "b3", variant: "primary", priority: 4, collapse: false, action: "submit" },
      {
        kind: "timeline", id: "b4", variant: "vertical", priority: 4, collapse: false,
        heading: null, text: null, items: [], image: null, binding: scheduleBinding("scheduleNodes"),
      },
      {
        kind: "richText", id: "b5", variant: "prose", priority: 3, collapse: false,
        heading: "公告", text: "本页由主办方维护；报名、提交与结果以平台功能页为准。", items: [], image: null, binding: null,
      },
      {
        kind: "faq", id: "b6", variant: "accordion", priority: 3, collapse: false,
        heading: null, text: null, items: [], image: null, binding: scheduleBinding("faqEntries"),
      },
      { kind: "actionResults", id: "b7", variant: "inline", priority: 3, collapse: false, action: "results" },
      {
        kind: "richText", id: "b8", variant: "footer", priority: 1, collapse: false,
        heading: null, text: "如需联系主办方，请使用平台赛事页提供的官方联系方式。", items: [], image: null, binding: null,
      },
    ],
  };
}

/** 默认模块名列表（界面「一键恢复默认模块集」用，顺序即默认顺序）。 */
export const EVENT_SITE_DEFAULT_MODULES: readonly string[] = Object.freeze([
  "赛事信息", "报名", "提交", "赛程", "公告", "FAQ", "结果", "页脚",
]);

/* ------------------------------------------------------------------ *
 * 删除只建议，不阻止（规划 35 §5 第 2 条）
 * ------------------------------------------------------------------ */

export interface EventSiteDeleteAdvice {
  readonly kind: EventSiteBlockKind;
  /** 三段式：影响。 */
  readonly impact: string;
  /** 三段式：仍可到达。 */
  readonly stillReachable: string;
  /** 三段式：一键恢复。 */
  readonly undoHint: string;
  /** 界面显示的一句人话（= impact，避免组件里另写一套）。 */
  readonly message: string;
}

type DeleteAdviceBody = Omit<EventSiteDeleteAdvice, "kind" | "message">;

const DELETE_ADVICE: Readonly<Record<EventSiteBlockKind, DeleteAdviceBody>> = {
  countdown: {
    impact: "删掉倒计时后，这一页不再显示报名截止或开赛时间。",
    stillReachable: "截止时间仍来自平台赛程，平台赛事页与报名页照样显示，选手照样能报名。",
    undoHint: "删除后顶部会出现「已删除 · 撤销」，也可以一键恢复默认模块集。",
  },
  highlights: {
    impact: "删掉要点卡片后，这一页少一块你自己写的说明。",
    stillReachable: "这只是展示层，报名、提交与结果都不受影响。",
    undoHint: "删除后顶部会出现「已删除 · 撤销」，也可以一键恢复默认模块集。",
  },
  sponsorWall: {
    impact: "删掉赞助商墙后，赞助商 Logo 不再出现在这一页。",
    stillReachable: "图片仍在既有素材库里，重新加回来不用再上传一次。",
    undoHint: "删除后顶部会出现「已删除 · 撤销」，也可以一键恢复默认模块集。",
  },
  timeline: {
    impact: "删掉时间线后，这一页不再展示赛程节点。",
    stillReachable: "赛程来自平台赛程记录，平台赛事页照样能看，截止与开赛时间不变。",
    undoHint: "删除后顶部会出现「已删除 · 撤销」，也可以一键恢复默认模块集。",
  },
  peopleWall: {
    impact: "删掉人物墙后，评委、导师与嘉宾不再出现在这一页。",
    stillReachable: "人物介绍只是展示层，评审指派与权限都不受影响。",
    undoHint: "删除后顶部会出现「已删除 · 撤销」，也可以一键恢复默认模块集。",
  },
  faq: {
    impact: "删掉常见问题后，这一页不再展示平台公开 FAQ。",
    stillReachable: "FAQ 仍是平台的同一份投影，平台赛事页照样能看到。",
    undoHint: "删除后顶部会出现「已删除 · 撤销」，也可以一键恢复默认模块集。",
  },
  bannerImage: {
    impact: "删掉图片横幅后，这一页少一张主视觉。",
    stillReachable: "图片仍在既有素材库里，重新加回来不用再上传一次。",
    undoHint: "删除后顶部会出现「已删除 · 撤销」，也可以一键恢复默认模块集。",
  },
  richText: {
    impact: "删掉这段文字后，这一页少一段你自己写的内容。",
    stillReachable: "这只是文案展示，任何平台功能都不受影响。",
    undoHint: "删除后顶部会出现「已删除 · 撤销」，版本历史里也能找回上一版。",
  },
  actionRegister: {
    impact: "删掉「报名」跳板后，这一页上不再有报名入口。",
    stillReachable: "报名页仍然是平台的那一个，平台赛事页与直达链接照样能报名——只是选手要多点一次才能找到。",
    undoHint: "删除后顶部会出现「已删除 · 撤销」，也可以一键恢复默认模块集。",
  },
  actionSubmit: {
    impact: "删掉「提交」跳板后，这一页上不再有提交入口。",
    stillReachable: "提交仍然只走平台收件，平台赛事页与队伍空间照样能交件——只是选手要多点一次才能找到。",
    undoHint: "删除后顶部会出现「已删除 · 撤销」，也可以一键恢复默认模块集。",
  },
  actionResults: {
    impact: "删掉「结果」跳板后，这一页上不再有结果入口。",
    stillReachable: "成绩仍然只在平台计算与公布，结果页照样能进——只是选手要多点一次才能找到。",
    undoHint: "删除后顶部会出现「已删除 · 撤销」，也可以一键恢复默认模块集。",
  },
  actionAppeal: {
    impact: "删掉「申诉」跳板后，这一页上不再有申诉入口。",
    stillReachable: "申诉仍然只在平台受理，结果页的申诉入口照样在——只是选手要多点一次才能找到。",
    undoHint: "删除后顶部会出现「已删除 · 撤销」，也可以一键恢复默认模块集。",
  },
  aiBlock: {
    impact: "删掉 AI 组件不会删掉它框住的区块——框内区块会作为普通区块留在原位，它的职责描述一并删除。",
    stillReachable: "被框住的区块照常显示、照常可编辑；AI 只是少了一个只管这几块的入口。",
    undoHint: "删除后顶部会出现「已删除 · 撤销」，重新拖一个 AI 组件再框住同样的块即可。",
  },
};

/**
 * 删除建议：**永远返回一段人话，永远不阻止删除**（规划 35 §5 第 2 条）。
 * 只有在 kind 根本不在注册表时才抛 EVENT_SITE_UNKNOWN_BLOCK_KIND。
 */
export function deleteAdvice(kind: EventSiteBlockKind): EventSiteDeleteAdvice {
  const declaration = blockDeclaration(kind);
  const advice = DELETE_ADVICE[declaration.kind];
  return Object.freeze({ kind: declaration.kind, ...advice, message: advice.impact });
}

/** 页面是否「完全空白」（只剩平台赛事名与页脚）：合法，不是错误。 */
export function isBlankPage(spec: EventSitePageSpec): boolean {
  return spec.blocks.length === 0;
}

/** 类型守卫：块是不是 AI 容器。 */
export function isAiContainerBlock(block: EventSiteBlockNode): block is Extract<EventSiteBlockNode, { kind: "aiBlock" }> {
  return block.kind === "aiBlock";
}

/** 类型守卫：块是不是动作跳板。 */
export function isActionBlock(block: EventSiteBlockNode): block is Extract<EventSiteBlockNode, { kind: EventSiteActionBlockKind }> {
  return isEventSiteActionKind(block.kind);
}

/** 优先级默认值（normalizeSpec 与编辑器插入新块时用）。 */
export const EVENT_SITE_DEFAULT_PRIORITY: EventSitePriority = 3;
