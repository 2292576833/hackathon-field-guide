/** Editorial seed data checked against the official pages on 2026-10-09.
 * This module is pure data: it does not fetch, install, claim live AI updates,
 * contact a model, or open a database. Chinese descriptions are original.
 */
export type InspirationCategory = "visual" | "websites" | "components" | "motion";
export type InspirationContentType = "reference" | "code" | "asset";
export interface InspirationItem {
  id: string; name: string; url: string; category: InspirationCategory; contentType: InspirationContentType;
  description: string; useWhen: string; usageNote: string; tags: string[]; checkedAt: string; evidenceUrls: string[];
}
export type InspirationCandidate = Pick<InspirationItem, "id" | "name" | "url" | "category" | "contentType" | "tags">;
export interface InspirationCatalogStatus {
  kind: "curated" | "dsh"; message: string; updatedAt?: string | null;
}
const checkedAt = "2026-10-09";
function item(value: Omit<InspirationItem, "checkedAt" | "evidenceUrls"> & { evidenceUrls?: string[] }): InspirationItem {
  return { ...value, checkedAt, evidenceUrls: value.evidenceUrls ?? [value.url] };
}
export const inspirationSeed: readonly InspirationItem[] = [
  item({ id: "dribbble", name: "Dribbble", url: "https://dribbble.com/", category: "visual", contentType: "reference",
    description: "查看设计师发布的界面、插画和品牌作品，比较色彩、排版与界面细节。", useWhen: "方向还不清楚时，用少量作品对齐团队想要的视觉感觉。",
    usageNote: "主要是作品参考，不能直接当作组件源码；图片使用需核实作者授权，额外服务按官网说明。", tags: ["UI", "配色", "排版", "品牌"] }),
  item({ id: "behance", name: "Behance", url: "https://www.behance.net/", category: "visual", contentType: "reference",
    description: "按创意领域浏览完整项目，了解品牌、界面与作品展示如何组织成一个方案。", useWhen: "准备视觉方案或答辩展示时，参考项目叙述与视觉一致性。",
    usageNote: "以设计作品为主；素材与字体要另行核实授权，付费功能及服务以官网为准。", tags: ["品牌", "UI/UX", "作品集", "答辩"],
    evidenceUrls: ["https://help.behance.net/hc/en-us/articles/204483894-What-is-Behance", "https://help.behance.net/hc/en-us/articles/204483864-Guide-Search-Filter-Creative-Work"] }),
  item({ id: "mobbin", name: "Mobbin", url: "https://mobbin.com/", category: "visual", contentType: "reference",
    description: "浏览真实移动与网页产品的页面和操作流程，参考登录、引导、表单等交互。", useWhen: "要让作品更容易使用时，先比较同类产品的完整操作路径。",
    usageNote: "页面与流程属于设计参考，不是可直接部署的源码；素材授权、访问范围和订阅方案需在官网确认。", tags: ["移动端", "产品界面", "登录", "用户流程"] }),
  item({ id: "siteinspire", name: "Siteinspire", url: "https://www.siteinspire.com/", category: "visual", contentType: "reference",
    description: "按风格、类型和主题查看网站设计，寻找清楚的版式、字体和视觉节奏。", useWhen: "决定作品的整体设计方向时，挑两个风格接近的站点比较。",
    usageNote: "收录案例用于参考；站点图片、字体及实现代码的使用权限需要分别确认。", tags: ["网站设计", "风格", "字体", "版式"] }),
  item({ id: "awwwards", name: "Awwwards", url: "https://www.awwwards.com/", category: "websites", contentType: "reference",
    description: "查看网站案例与官方精选集合，研究首屏、导航、布局和页面转场。", useWhen: "做展示网站或打磨作品首屏时，拆解一个有用的设计细节。",
    usageNote: "主要提供网站与设计参考；案例素材不附自动复用授权，课程和额外功能需核实费用。", tags: ["获奖网站", "首屏", "网页案例", "交互"],
    evidenceUrls: ["https://www.awwwards.com/collections/"] }),
  item({ id: "httpster", name: "Httpster", url: "https://httpster.net/", category: "websites", contentType: "reference",
    description: "按网页风格与业务类型筛选案例，观察极简、字体驱动和网格布局等方向。", useWhen: "需要克制、清楚的网页排版时，比较内容密度与留白。",
    usageNote: "入口连接原网站，目录不提供整站源码授权；使用素材前查看原作者说明。", tags: ["极简", "网格", "字体", "整站案例"] }),
  item({ id: "lapa-ninja", name: "Lapa Ninja", url: "https://www.lapa.ninja/", category: "websites", contentType: "reference",
    description: "浏览落地页截图和站点案例，按产品类别、颜色与建站平台寻找参考。", useWhen: "需要快速解释作品价值时，参考首屏、功能介绍与行动入口。",
    usageNote: "截图和案例属于设计参考；模板是否包含代码、授权和价格需要逐项查看。", tags: ["落地页", "SaaS", "AI", "颜色"] }),
  item({ id: "landbook", name: "Landbook", url: "https://land-book.com/", category: "websites", contentType: "reference",
    description: "查看精选网站与落地页，寻找产品展示、作品集和品牌站的布局方案。", useWhen: "有了功能但展示平淡时，参考如何安排标题、图片与内容区块。",
    usageNote: "目录中的网站用作参考；收藏或额外功能的费用及素材授权以官网和作者说明为准。", tags: ["落地页", "产品展示", "作品集", "布局"] }),
  item({ id: "shadcn-ui", name: "shadcn/ui", url: "https://ui.shadcn.com/", category: "components", contentType: "code",
    description: "查看 React 组件与界面区块源码，挑选按钮、表单、对话框和工作台组件。", useWhen: "项目使用 React 时，先搭建风格一致的基础界面，再按需求修改。",
    usageNote: "提供可接入的组件代码；仍需核对项目依赖、当前许可及所选扩展资源的费用。", tags: ["React", "TypeScript", "组件源码", "表单"] }),
  item({ id: "radix-ui", name: "Radix UI", url: "https://www.radix-ui.com/", category: "components", contentType: "code",
    description: "查阅 React 界面组件与基础交互文档，理解菜单、弹窗等控件如何组合。", useWhen: "需要定制界面并认真处理键盘操作、焦点与交互行为时。",
    usageNote: "是组件与实现文档，不是整站设计模板；按所选组件核对依赖、样式要求和许可。", tags: ["React", "可访问性", "弹窗", "交互基础"] }),
  item({ id: "material-ui", name: "Material UI", url: "https://mui.com/material-ui/", category: "components", contentType: "code",
    description: "查看采用 Material Design 的 React 组件、示例和主题配置，搭建常见产品界面。", useWhen: "做数据展示或操作界面时，希望直接采用一套一致的组件体系。",
    usageNote: "代码需要按文档接入；核心组件、进阶产品和模板可能有不同许可与费用，分别确认。", tags: ["React", "Material Design", "主题", "数据界面"] }),
  item({ id: "ant-design", name: "Ant Design", url: "https://ant.design/", category: "components", contentType: "code",
    description: "查阅 React 组件、设计规范与示例，寻找表格、表单、导航和后台布局。", useWhen: "要在有限时间内搭建表单较多、操作较多的管理或协作页面。",
    usageNote: "组件代码不等于完整业务实现；核对版本、许可及具体模板或生态产品的使用条件。", tags: ["React", "中文文档", "表格", "后台"] }),
  item({ id: "daisyui", name: "daisyUI", url: "https://daisyui.com/", category: "components", contentType: "code",
    description: "在 Tailwind CSS 项目中用组件类名组织按钮、表单、卡片和主题。", useWhen: "希望减少重复样式编写，并快速统一基础界面外观时。",
    usageNote: "需要匹配 Tailwind 版本与项目配置；基础组件、模板和额外服务的许可及费用分别确认。", tags: ["Tailwind CSS", "CSS", "主题", "基础组件"] }),
  item({ id: "aceternity-ui", name: "Aceternity UI", url: "https://ui.aceternity.com/", category: "components", contentType: "code",
    description: "查看 React 与 Tailwind 组件，寻找卡片、背景、轮播和文本等展示效果。", useWhen: "核心功能已经能用，想给作品首屏或展示区增加一个视觉重点时。",
    usageNote: "部分内容提供组件源码；模板与套餐条件可能不同，接入前核对依赖、许可和费用。", tags: ["React", "Tailwind CSS", "展示组件", "动效"] }),
  item({ id: "magic-ui", name: "Magic UI", url: "https://magicui.design/", category: "components", contentType: "code",
    description: "浏览 React 动态组件与效果，寻找文字、背景和内容展示等界面元素。", useWhen: "在现有 React 界面里加入少量展示效果，并保持整体风格一致时。",
    usageNote: "组件与 Pro 模板的条件不同；核对 TypeScript、Tailwind、Motion 依赖和具体资源许可。", tags: ["React", "TypeScript", "Motion", "展示组件"] }),
  item({ id: "hyperui", name: "HyperUI", url: "https://www.hyperui.dev/", category: "components", contentType: "code",
    description: "查看基于 Tailwind CSS 的界面片段，参考表单、卡片和常见页面区块。", useWhen: "已有 Tailwind 项目，想直接修改一小块 HTML 与样式时。",
    usageNote: "代码片段仍需接上真实数据与交互；核对 Tailwind 版本、许可和当前页面说明。", tags: ["Tailwind CSS", "HTML", "界面片段", "页面区块"] }),
  item({ id: "21st-dev", name: "21st.dev", url: "https://21st.dev/", category: "components", contentType: "code",
    description: "浏览社区 React 组件、主题和模板，比较同一类界面的不同实现。", useWhen: "知道自己缺哪个界面元素，希望先比较现成组件再做选择时。",
    usageNote: "社区资源需逐项核对作者、源码依赖和许可；付费模板或服务以各自说明为准。", tags: ["React", "社区组件", "主题", "模板"] }),
  item({ id: "react-bits", name: "React Bits", url: "https://reactbits.dev/", category: "components", contentType: "code",
    description: "查看带动画与交互效果的 React 组件，包括文字、背景、卡片和导航。", useWhen: "需要一个局部视觉效果，并有时间测试移动端性能与交互时。",
    usageNote: "源码与 Pro 内容的条件需分别确认；阅读具体许可限制，并检查组件所需依赖。", tags: ["React", "动画组件", "背景", "文字效果"],
    evidenceUrls: ["https://www.reactbits.dev/get-started/index", "https://pro.reactbits.dev/docs/introduction"] }),
  item({ id: "motion", name: "Motion", url: "https://motion.dev/", category: "motion", contentType: "code",
    description: "查看 React、JavaScript 与 Vue 动画文档和示例，设计布局变化、手势和过渡。", useWhen: "希望状态变化更容易看懂，或给现有界面补上有目的的动效时。",
    usageNote: "这是动画实现代码与文档；库、扩展示例和 Motion+ 的许可与收费条件需分别查看。", tags: ["React", "JavaScript", "Vue", "交互动效"] }),
  item({ id: "gsap", name: "GSAP", url: "https://gsap.com/", category: "motion", contentType: "code",
    description: "查阅 JavaScript 动画文档，组合时间线、缓动与页面元素的动画控制。", useWhen: "有明确的演示需求，需要把多个动画按顺序组织与控制时。",
    usageNote: "需要编写和测试动画逻辑；插件、分发和项目使用条件按当前官方许可确认。", tags: ["JavaScript", "时间线", "缓动", "滚动动效"],
    evidenceUrls: ["https://gsap.com/docs/v3/", "https://gsap.com/docs/v3/GSAP/"] }),
  item({ id: "lottiefiles", name: "LottieFiles", url: "https://lottiefiles.com/", category: "motion", contentType: "asset",
    description: "浏览动画素材和预览工具，寻找引导、空状态或演示中的轻量动画。", useWhen: "需要现成动画素材，并能明确控制播放目的与次数时。",
    usageNote: "主要提供动画素材与工具，不能替代完整界面组件；每份素材的许可与付费条件单独查看。", tags: ["Lottie", "动画素材", "空状态", "引导"] }),
];

export const inspirationSeedStatus: InspirationCatalogStatus = {
  kind: "curated", message: "编辑精选目录 · 说明依据官网核查", updatedAt: checkedAt,
};
/** Verified identities only. Pending production cards must not show the
 * editorial descriptions as though they were completed DSH analysis. */
export const inspirationCandidates: readonly InspirationCandidate[] = inspirationSeed.map(({ id, name, url, category, contentType, tags }) => ({ id, name, url, category, contentType, tags }));
