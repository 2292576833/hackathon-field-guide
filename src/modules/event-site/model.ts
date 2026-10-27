/**
 * 主办方专属页（规划 35 §3、§7、§21）的**类型与结构上限**。
 *
 * 这一层只有两件事：定义 PageSpec 的**两层模型**，和把"结构上不可能"写进类型。
 *
 * 两层（规划 35 §3）：
 * - **语义层** `EventSitePageSpec`：区块序列 + 每块的 priority / variant / collapse + AI 容器。
 *   AI 与主办方只碰这一层。
 * - **布局层** `EventSitePageLayout`：由 `policy.deriveLayout()` 从语义层**派生**，永远不是输入。
 *   本模块只出数据，不做 DOM、不出样式、不出断点。
 *
 * 三条结构性保证（不是靠提示词自律）：
 * 1. 没有坐标、没有宽度、没有 `style`/`className` —— "手机横向滚动"在类型上无法表达（规划 35 §7）；
 * 2. 没有 `html`/`script`/`component` 字段 —— "执行任意代码"无法表达（规划 35 §13、宪法 XIV）；
 * 3. 事实类区块**没有文案字段**，只有 `binding` —— "第二份事实"无法写进来（宪法 XIV「事实与展示分离」）。
 */

/** 规格序列化后的上限（规划 35 §4）。 */
export const EVENT_SITE_MAX_SPEC_BYTES = 128 * 1024;
/** 内容区块上限；动作跳板与 AI 容器不计入（规划 35 §4）。 */
export const EVENT_SITE_MAX_CONTENT_BLOCKS = 20;
/** 图片区块上限（规划 35 §4）。 */
export const EVENT_SITE_MAX_IMAGE_BLOCKS = 8;
/** 一次规格里引用图片总数的上限（超出只是提醒，见 policy）。 */
export const EVENT_SITE_MAX_IMAGES = 24;
/** 一页最多 3 个 AI 组件（规划 35 §21.1）。 */
export const EVENT_SITE_MAX_AI_BLOCKS = 3;
/** 兜底总块数，防止动作/容器无限堆叠。 */
export const EVENT_SITE_MAX_BLOCKS = 40;
/** 一个 AI 容器最多管辖的块数。 */
export const EVENT_SITE_MAX_MANAGES = 20;
/** AI 组件职责描述的字符上限（规划 35 §21.4「一行话」）。 */
export const EVENT_SITE_MAX_DUTY = 200;
/** 区块 id 的字符上限。 */
export const EVENT_SITE_MAX_BLOCK_ID = 64;

/* ------------------------------------------------------------------ *
 * 区块枚举（封闭）
 * ------------------------------------------------------------------ */

/** 8 个内容区块。 */
export type EventSiteContentBlockKind =
  | "countdown"
  | "highlights"
  | "sponsorWall"
  | "timeline"
  | "peopleWall"
  | "faq"
  | "bannerImage"
  | "richText";

/**
 * 4 个动作跳板。**只跳转到平台功能页，不承载表单**（规划 35 §8）。
 * 它们没有文案字段，也没有 href：目标由注册表固定，写不进第二个报名入口。
 */
export type EventSiteActionBlockKind =
  | "actionRegister"
  | "actionSubmit"
  | "actionResults"
  | "actionAppeal";

/** 唯一的容器：AI 组件（规划 35 §21）。 */
export type EventSiteContainerBlockKind = "aiBlock";

export type EventSiteBlockKind =
  | EventSiteContentBlockKind
  | EventSiteActionBlockKind
  | EventSiteContainerBlockKind;

export type EventSiteBlockCategory = "content" | "action" | "container";

/** 动作跳板指向的平台功能（不是 URL，URL 由根提供）。 */
export type EventSiteActionTarget = "register" | "submit" | "results" | "appeal";

/** AI 组件的模式。类型允许两种，本期只有 `edit` 被接受（规划 35 §21.3、§17）。 */
export type EventSiteAiMode = "edit" | "ask";

/* ------------------------------------------------------------------ *
 * 事实绑定（事实类区块的唯一内容来源）
 * ------------------------------------------------------------------ */

/** 允许的只读数据源。全部是既有平台的只读投影，不新增事实。 */
export type EventSiteBindingSource = "eventSchedule" | "eventFaq";

/** 闭合的字段枚举：每个字段归属唯一数据源。 */
export type EventSiteBindingField =
  | "registrationCloses"
  | "submissionCloses"
  | "startsAt"
  | "endsAt"
  | "scheduleNodes"
  | "faqEntries";

/** 事实类区块的数据绑定：**只指定读哪里**，带不了任何值。 */
export interface EventSiteBinding {
  readonly source: EventSiteBindingSource;
  readonly field: EventSiteBindingField;
}

/* ------------------------------------------------------------------ *
 * 语义层：PageSpec
 * ------------------------------------------------------------------ */

/** 1–5 重要度。**不是位置**：AI 说"什么重要"，引擎决定"放在哪"（规划 35 §3）。 */
export type EventSitePriority = 1 | 2 | 3 | 4 | 5;

/** 图片有确定宽高比，宽度由容器决定（规划 35 §7 第 3 条）。 */
export type EventSiteImageAspect = "16:9" | "4:3" | "1:1" | "3:4";

/** 图片引用：只存既有上传产物的 id 与替代文本，不存 URL、不存尺寸。 */
export interface EventSiteImageRef {
  readonly assetId: string;
  readonly alt: string;
  readonly aspect: EventSiteImageAspect;
}

/** 卡片/条目。纯文本，没有富文本、没有链接、没有自定义样式。 */
export interface EventSiteItem {
  readonly heading: string;
  readonly text: string | null;
  readonly image: EventSiteImageRef | null;
}

/** 内容区块。文案字段一律 `string | null`，没有 HTML 槽位。 */
export interface EventSiteBlock {
  readonly kind: EventSiteContentBlockKind;
  readonly id: string;
  readonly variant: string;
  readonly priority: EventSitePriority;
  readonly collapse: boolean;
  readonly heading: string | null;
  readonly text: string | null;
  readonly items: readonly EventSiteItem[];
  readonly image: EventSiteImageRef | null;
  /** 事实类区块必填、其余必须为 null（校验强制）。 */
  readonly binding: EventSiteBinding | null;
}

/** 动作跳板：没有文案、没有 href，只有平台固定的目标。 */
export interface EventSiteActionBlock {
  readonly kind: EventSiteActionBlockKind;
  readonly id: string;
  readonly variant: string;
  readonly priority: EventSitePriority;
  readonly collapse: boolean;
  readonly action: EventSiteActionTarget;
}

/** AI 组件（容器）：只管理它框住的块，作用域是结构性的（规划 35 §21.1）。 */
export interface EventSiteAiContainerBlock {
  readonly kind: EventSiteContainerBlockKind;
  readonly id: string;
  readonly variant: string;
  readonly priority: EventSitePriority;
  readonly collapse: boolean;
  /** 被管辖的区块 id。一块只能属于一个容器；容器不能管容器，也不能管动作跳板。 */
  readonly manages: readonly string[];
  /** 一行职责描述，可空（空职责不报错、不产生调用）。 */
  readonly duty: string | null;
  readonly mode: EventSiteAiMode;
  /** 整页模式：管辖集合必须等于本页全部内容区块。 */
  readonly fullPage: boolean;
}

export type EventSiteBlockNode =
  | EventSiteBlock
  | EventSiteActionBlock
  | EventSiteAiContainerBlock;

/** 语义层根对象。没有短码、没有可见性、没有状态——那些属于存储与发布（根负责）。 */
/**
 * 视觉皮肤：整套视觉语言（底色、文字、主色、圆角、标题字体、卡片质感）。
 * 只有平台预置的几套，**不开放自定义颜色或 CSS**（规划 35 §17）。
 */
export type EventSiteSkin = "classic" | "dark" | "paper" | "neon";

export const EVENT_SITE_SKINS: readonly EventSiteSkin[] = Object.freeze(["classic", "dark", "paper", "neon"]);

export interface EventSitePageSpec {
  readonly version: 1;
  readonly blocks: readonly EventSiteBlockNode[];
  /** 缺省 classic（暖白 + 橙红）。 */
  readonly skin?: EventSiteSkin;
}

/* ------------------------------------------------------------------ *
 * 布局层：由语义层派生，永不是输入
 * ------------------------------------------------------------------ */

/** 桌面栅格列宽。只允许这几档，不允许任意像素（规划 35 §7 第 4 条）。 */
export type EventSiteDesktopSpan = 3 | 4 | 6 | 8 | 12;

export interface EventSiteDesktopCell {
  readonly blockId: string;
  readonly span: EventSiteDesktopSpan;
}

export interface EventSiteDesktopRow {
  readonly index: number;
  /** 一行内列宽之和恒 ≤ 12（由 deriveLayout 保证）。 */
  readonly cells: readonly EventSiteDesktopCell[];
}

/** 容器不是布局盒，是作用域；因此单独列出，不占栅格。 */
export interface EventSiteContainerLayout {
  readonly containerId: string;
  readonly manages: readonly string[];
  readonly mode: EventSiteAiMode;
  readonly scope: "page" | "blocks";
}

export interface EventSiteMobileEntry {
  readonly blockId: string;
  /** 单列序号，从 0 开始，恒为连续整数（= 不可能横向滚动）。 */
  readonly order: number;
  readonly collapsed: boolean;
  /** 所属折叠组；未折叠为 null。折叠只有一层。 */
  readonly groupId: string | null;
}

export interface EventSiteMobileCollapseGroup {
  readonly id: string;
  readonly blockIds: readonly string[];
}

/** 结构约束的**字面量**声明：派生器不会产出别的值。 */
export interface EventSiteLayoutConstraints {
  readonly fixedWidth: false;
  readonly absolutePosition: false;
  readonly horizontalScroll: false;
  readonly collapseDepth: 1;
  readonly breakpoints: readonly [620, 760, 1024];
}

export interface EventSitePageLayout {
  readonly grid: {
    readonly columns: 12;
    readonly rows: readonly EventSiteDesktopRow[];
  };
  readonly containers: readonly EventSiteContainerLayout[];
  readonly mobile: {
    readonly columns: 1;
    readonly entries: readonly EventSiteMobileEntry[];
    readonly collapseGroups: readonly EventSiteMobileCollapseGroup[];
  };
  readonly constraints: EventSiteLayoutConstraints;
}
