import { EVENT_SITE_BINDING_FIELD_SOURCE, blockDeclaration } from "./blocks.ts";
import type { EventSiteBlockNode, EventSitePageSpec } from "./model.ts";

/**
 * 规划35 P6 的**内置起步模板**：主办方一键套用即可开始改文案。
 *
 * 每个模板都必须过与手写规格同一条闸门（normalizeSpec / deriveLayout / reviewSpec），
 * 由 templates.test.ts 保证；这里只用注册表的默认变体，不手写变体名。
 *
 * 取材：Devpost 的概览页必答三问（谁在办／目标是什么／为什么值得参加）与资格、提交要求，
 * 以及主流黑客松页面的区块顺序（倒计时 → 报名 → 说明 → 赛程 → 评审 → 赞助 → FAQ → 提交 → 结果）。
 */
export interface EventSiteStarterTemplate {
  readonly id: string;
  readonly name: string;
  readonly tagline: string;
  readonly bestFor: string;
  /** 覆盖了哪些环节（用于界面提示「这条模板含什么」）。 */
  readonly covers: readonly string[];
  /** 这套模板自带的视觉皮肤。 */
  readonly skin: "classic" | "dark" | "paper" | "neon";
  readonly build: () => EventSitePageSpec;
}

type ContentKind = "countdown" | "highlights" | "sponsorWall" | "timeline" | "peopleWall" | "faq" | "richText";
type ActionKind = "actionRegister" | "actionSubmit" | "actionResults" | "actionAppeal";
type BindingField = "registrationCloses" | "submissionCloses" | "scheduleNodes" | "faqEntries";

function content(kind: ContentKind, id: string, priority: number, init: {
  readonly heading?: string | null;
  readonly text?: string | null;
  readonly items?: readonly { readonly heading: string; readonly text?: string | null }[];
  readonly binding?: BindingField | null;
  readonly collapse?: boolean;
} = {}): EventSiteBlockNode {
  const declaration = blockDeclaration(kind);
  const field = init.binding ?? null;
  return {
    kind, id, variant: declaration.defaultVariant, priority, collapse: init.collapse ?? false,
    heading: init.heading ?? null, text: init.text ?? null,
    items: (init.items ?? []).map(item => ({ heading: item.heading, text: item.text ?? null, image: null })),
    image: null,
    binding: field === null ? null : { source: EVENT_SITE_BINDING_FIELD_SOURCE[field], field },
  } as EventSiteBlockNode;
}

function action(kind: ActionKind, id: string, priority: number): EventSiteBlockNode {
  const declaration = blockDeclaration(kind);
  return { kind, id, variant: declaration.defaultVariant, priority, collapse: false, action: declaration.actionTarget! } as EventSiteBlockNode;
}

function aiContainer(id: string, priority: number, duty: string, manages: readonly string[]): EventSiteBlockNode {
  const declaration = blockDeclaration("aiBlock");
  return { kind: "aiBlock", id, variant: declaration.defaultVariant, priority, collapse: false, manages: [...manages], duty, mode: "edit", fullPage: false } as EventSiteBlockNode;
}

const FOOTER = "如需联系主办方，请使用平台赛事页提供的官方联系方式。";

/** ① 全流程标准页：一条页走完报名 → 赛程 → 评审 → 提交 → 结果 → 申诉。 */
function standard(): EventSitePageSpec {
  return { version: 1, skin: "classic", blocks: [
    content("countdown", "t1-countdown", 5, { binding: "registrationCloses" }),
    action("actionRegister", "t1-register", 5),
    content("richText", "t1-intro", 5, { heading: "这是什么比赛", text: "由本场主办方发起，面向所有符合资格的同学。我们想看到能真正跑起来的作品，而不是一份设想。" }),
    content("highlights", "t1-highlights", 4, { heading: "参赛须知", items: [
      { heading: "谁可以参加" }, { heading: "提交什么" }, { heading: "怎么评审" },
    ] }),
    content("timeline", "t1-timeline", 4, { binding: "scheduleNodes" }),
    content("peopleWall", "t1-judges", 3, { heading: "评审与导师", items: [{ heading: "评审团" }, { heading: "现场导师" }] }),
    content("sponsorWall", "t1-sponsors", 2, { heading: "赞助与支持", items: [{ heading: "合作机构" }, { heading: "场地支持" }] }),
    content("faq", "t1-faq", 3, { binding: "faqEntries" }),
    action("actionSubmit", "t1-submit", 4),
    action("actionResults", "t1-results", 3),
    action("actionAppeal", "t1-appeal", 2),
    content("richText", "t1-footer", 1, { text: FOOTER }),
  ] };
}

/** ② 48 小时冲刺：只留最要紧的几块，报名与截止一眼可见。 */
function sprint(): EventSitePageSpec {
  return { version: 1, skin: "dark", blocks: [
    content("countdown", "t2-countdown", 5, { binding: "registrationCloses" }),
    action("actionRegister", "t2-register", 5),
    content("richText", "t2-intro", 4, { heading: "48 小时，做一个能演示的东西", text: "不要求完整产品，能跑、能讲清楚就够。评审只看现场演示。" }),
    content("highlights", "t2-highlights", 4, { heading: "三条规则", items: [
      { heading: "现场组队" }, { heading: "代码必须现场写" }, { heading: "提交演示与仓库" },
    ] }),
    content("timeline", "t2-timeline", 3, { binding: "scheduleNodes" }),
    content("faq", "t2-faq", 3, { binding: "faqEntries" }),
    action("actionSubmit", "t2-submit", 4),
    content("richText", "t2-footer", 1, { text: FOOTER }),
  ] };
}

/** ③ 路演 / 创业赛：评审导向，奖项、日程、评委、结果、申诉都在。 */
function pitch(): EventSitePageSpec {
  return { version: 1, skin: "neon", blocks: [
    content("richText", "t3-intro", 5, { heading: "把想法讲成一个可投的项目", text: "面向早期团队：8 分钟路演 + 5 分钟问答。评委来自产业与投资机构。" }),
    action("actionRegister", "t3-register", 5),
    content("countdown", "t3-countdown", 4, { binding: "submissionCloses" }),
    content("highlights", "t3-awards", 4, { heading: "奖项与评审标准", items: [
      { heading: "最佳项目" }, { heading: "技术创新" }, { heading: "商业潜力" },
    ] }),
    content("timeline", "t3-timeline", 4, { binding: "scheduleNodes" }),
    content("peopleWall", "t3-judges", 3, { heading: "评委", items: [{ heading: "产业评委" }, { heading: "投资评委" }] }),
    aiContainer("t3-ai", 2, "只把评委与日程的语气统一成正式口吻", ["t3-judges", "t3-timeline"]),
    action("actionSubmit", "t3-submit", 4),
    action("actionResults", "t3-results", 3),
    action("actionAppeal", "t3-appeal", 2),
    content("faq", "t3-faq", 3, { binding: "faqEntries" }),
    content("richText", "t3-footer", 1, { text: FOOTER }),
  ] };
}

/** ④ 学术会议风：议程、议题、讲者、赞助。 */
function academic(): EventSitePageSpec {
  return { version: 1, skin: "paper", blocks: [
    content("richText", "t4-intro", 5, { heading: "征稿与参会", text: "面向研究者与工程实践者。我们关心方法是否可复现、结论是否有证据。" }),
    action("actionRegister", "t4-register", 5),
    content("countdown", "t4-countdown", 4, { binding: "registrationCloses" }),
    content("highlights", "t4-topics", 4, { heading: "征稿方向", items: [
      { heading: "方法与评测" }, { heading: "系统与工程" }, { heading: "应用与案例" },
    ] }),
    content("timeline", "t4-agenda", 4, { heading: "议程", binding: "scheduleNodes" }),
    content("peopleWall", "t4-speakers", 3, { heading: "讲者", items: [{ heading: "主题报告" }, { heading: "圆桌嘉宾" }] }),
    content("sponsorWall", "t4-sponsors", 2, { heading: "支持单位", items: [{ heading: "主办单位" }, { heading: "协办单位" }] }),
    content("faq", "t4-faq", 3, { binding: "faqEntries" }),
    action("actionSubmit", "t4-submit", 3),
    content("richText", "t4-footer", 1, { text: FOOTER }),
  ] };
}

export const EVENT_SITE_STARTER_TEMPLATES: readonly EventSiteStarterTemplate[] = Object.freeze([
  {
    id: "standard", skin: "classic", name: "标准赛事页",
    tagline: "一条页走完报名、赛程、评审、提交、结果与申诉",
    bestFor: "第一次办、想把完整流程一次说清",
    covers: ["倒计时", "报名", "说明", "须知", "赛程", "评委", "赞助", "FAQ", "提交", "结果", "申诉"],
    build: standard,
  },
  {
    id: "sprint", skin: "dark", name: "48 小时冲刺",
    tagline: "只留最要紧的：截止、规则、日程、FAQ、提交",
    bestFor: "短周期、现场活动、页面越短越好",
    covers: ["倒计时", "报名", "说明", "规则", "赛程", "FAQ", "提交"],
    build: sprint,
  },
  {
    id: "pitch", skin: "neon", name: "路演 / 创业赛",
    tagline: "评审导向：奖项、评委、结果、申诉，还有一块 AI 组件",
    bestFor: "需要投资人视角、强调评审标准",
    covers: ["说明", "报名", "截止", "奖项", "赛程", "评委", "AI 组件", "提交", "结果", "申诉", "FAQ"],
    build: pitch,
  },
  {
    id: "academic", skin: "paper", name: "学术会议风",
    tagline: "征稿方向、议程、讲者、支持单位",
    bestFor: "研讨会、课程结课展示、偏正式的场合",
    covers: ["说明", "报名", "截止", "议题", "议程", "讲者", "赞助", "FAQ", "提交"],
    build: academic,
  },
]);
