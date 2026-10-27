import type { ResourceInput } from "./domain.ts";
import type { CatalogEvidence, ResourceCatalogEntry } from "./catalog-types.ts";

export const RESOURCE_CATALOG_VERSION = "2026-10-08.1";
export const RESOURCE_CATALOG_VERIFICATION_DATE = "2026-10-08";
/** Fixed batch curation time; this is not a network probe or a M08 review timestamp. */
export const RESOURCE_CATALOG_CHECKED_AT = "2026-10-08T14:11:33.000Z";
const checkedAt = RESOURCE_CATALOG_CHECKED_AT;
const base = {
  verifiedAt: null, linkStatus: "unknown", costVerifiedAt: checkedAt,
  licenseStatus: "unknown", licenseVerifiedAt: null,
} as const;
const commonChecks = [
  "人工确认官方入口在实际使用环境可访问；本批内容浏览不等于 worker 连通性检查。",
  "核对所选版本、账号条件、依赖、实际素材和赛事使用规则。",
  "先导入草稿，经 M08 人工审核；不要把候选清单或浏览记录直接当发布许可。",
];
function evidence(field: CatalogEvidence["field"], url: string, note: string): CatalogEvidence {
  return {field, url, checkedAt, note};
}
function entry(candidateKey: string, input: ResourceInput, purposeSources: readonly CatalogEvidence[], remainingChecks: readonly string[] = []): ResourceCatalogEntry {
  return {candidateKey, catalogVersion: RESOURCE_CATALOG_VERSION, verificationDate: RESOURCE_CATALOG_VERIFICATION_DATE, reviewStatus: "candidate", input,
    evidence: [...purposeSources,
      ...(input.costSourceUrl ? [evidence("cost", input.costSourceUrl, input.costNote)] : []),
      ...(input.licenseSourceUrl ? [evidence("license", input.licenseSourceUrl, input.licenseNote)] : [])],
    remainingChecks: [...remainingChecks, ...commonChecks]};
}

/** Official-source researched candidates. No function here publishes or fetches these URLs. */
export const RESOURCE_CATALOG: readonly ResourceCatalogEntry[] = [
  entry("shadcn", {
    ...base, name: "shadcn/ui", officialUrl: "https://ui.shadcn.com/docs", type: "ui_visual",
    stageTags: ["design", "development"], useTags: ["form", "workspace", "layout"], stackTags: ["react", "html_css"], prerequisites: ["browse", "basic_code", "environment"],
    summary: "接入可修改的组件源码，统一按钮、表单、卡片与工作台。",
    suitableFor: "已有 React 项目、能维护组件源码并统一主题的开发成员。",
    notSuitableFor: "只想找截图，或没有代码环境；第三方 registry 条目与依赖需单独检查。",
    quickStart: ["选一个任务并阅读对应组件文档。", "按官方框架接入说明配置项目，记录组件与依赖版本。", "先接入按钮和输入框，检查错误、键盘及手机状态。"],
    costType: "free_plan", costNote: "所核验官方代码为 MIT，可无许可费复用；开发、部署和第三方服务成本另计。",
    costSourceUrl: "https://github.com/shadcn-ui/ui/blob/main/LICENSE.md",
    licenseStatus: "source_verified", licenseNote: "官方代码为 MIT；复制或分发时保留版权与许可声明。此结论不扩展到第三方 registry、依赖或素材。",
    licenseSourceUrl: "https://github.com/shadcn-ui/ui/blob/main/LICENSE.md", licenseVerifiedAt: checkedAt, displayOrder: 1,
  }, [evidence("purpose", "https://ui.shadcn.com/docs", "官方文档说明开放组件源码和可修改组件的接入方式。"), evidence("purpose", "https://ui.shadcn.com/docs/installation/next", "官方 Next.js 接入与添加组件步骤。")]),
  entry("radix", {
    ...base, name: "Radix Primitives", officialUrl: "https://www.radix-ui.com/primitives/docs/overview/introduction", type: "ui_visual",
    stageTags: ["development", "delivery"], useTags: ["form", "workspace"], stackTags: ["react"], prerequisites: ["browse", "basic_code", "environment"],
    summary: "用无预设样式的交互基础搭建菜单、弹窗与选择器。",
    suitableFor: "已有 React/CSS 基础、需要自己控制样式和交互组合的成员。",
    notSuitableFor: "需要立即得到完整页面主题的人；组件的焦点与键盘支持不替代整页验证。",
    quickStart: ["挑一个交互，阅读对应组件的组合结构。", "按官方入门说明接入并添加项目样式。", "验证打开、关闭、焦点恢复、错误提示和键盘操作。"],
    costType: "free_plan", costNote: "官方 Primitives 仓库为 MIT，无代码许可费；开发与部署另计。", costSourceUrl: "https://github.com/radix-ui/primitives/blob/main/LICENSE",
    licenseStatus: "source_verified", licenseNote: "Primitives 为 MIT，复制或分发保留版权和许可声明；不覆盖 WorkOS 的其他服务。", licenseSourceUrl: "https://github.com/radix-ui/primitives/blob/main/LICENSE", licenseVerifiedAt: checkedAt, displayOrder: 2,
  }, [evidence("purpose", "https://www.radix-ui.com/primitives/docs/overview/introduction", "官方说明无样式 React 基础与焦点、键盘和 ARIA 支持。"), evidence("purpose", "https://www.radix-ui.com/primitives/docs/overview/getting-started", "官方以 Popover 演示安装、组合与样式化。")]),
  entry("antd", {
    ...base, name: "Ant Design", officialUrl: "https://ant.design/docs/react/introduce/", type: "ui_visual",
    stageTags: ["design", "development"], useTags: ["workspace", "form"], stackTags: ["react"], prerequisites: ["browse", "basic_code", "environment"],
    summary: "用一套 React 组件组织表单、表格和工具型工作台。",
    suitableFor: "需要数据工作台且已有 React 基础、愿意统一主题的团队。",
    notSuitableFor: "准备混用多套完整表单体系，或未核对当前版本环境支持的项目。",
    quickStart: ["列出所需表单、表格和反馈组件。", "检查选定版本支持范围，按官方说明接入一个页面。", "统一主题并验证表单错误、窄屏表格和键盘。"],
    costType: "free_plan", costNote: "所核验 antd 仓库为 MIT，无代码许可费；其他关联产品与部署另查。", costSourceUrl: "https://github.com/ant-design/ant-design/blob/master/LICENSE",
    licenseStatus: "source_verified", licenseNote: "antd 为 MIT，保留版权与许可声明；模板、关联产品、依赖及素材分别核验。", licenseSourceUrl: "https://github.com/ant-design/ant-design/blob/master/LICENSE", licenseVerifiedAt: checkedAt, displayOrder: 3,
  }, [evidence("purpose", "https://ant.design/docs/react/introduce/", "官方介绍 React/TypeScript 组件、主题与接入要求。")]),
  entry("lucide", {
    ...base, name: "Lucide", officialUrl: "https://lucide.dev/guide/", type: "ui_visual",
    stageTags: ["design", "development"], useTags: ["icons", "workspace"], stackTags: ["html_css", "react", "vue"], prerequisites: ["browse", "basic_code"],
    summary: "为导航、按钮和状态提示选择统一风格的 SVG 图标。",
    suitableFor: "需要统一图标线宽、尺寸和颜色的设计或前端成员。",
    notSuitableFor: "寻找品牌标志或完整插画的人；重要动作仍需文字或可访问名称。",
    quickStart: ["按动作含义查找图标。", "选择官方对应技术栈包或 SVG，统一尺寸、线宽和颜色。", "为功能图标补文字或可访问名称，再检查状态区分。"],
    costType: "free_plan", costNote: "ISC 许可允许无许可费使用、复制、修改和分发图标代码，其他项目成本另计。", costSourceUrl: "https://lucide.dev/license",
    licenseStatus: "source_verified", licenseNote: "官方为 ISC；保留版权与许可声明。Feather 衍生图标需保留选用版本附带的完整声明。", licenseSourceUrl: "https://lucide.dev/license", licenseVerifiedAt: checkedAt, displayOrder: 4,
  }, [evidence("purpose", "https://lucide.dev/guide/", "官方提供 SVG 和 React、Vue 等使用方式。"), evidence("purpose", "https://lucide.dev/guide/react", "官方说明按需引入及尺寸、线宽配置。")]),
  entry("uiverse", {
    ...base, name: "Uiverse", officialUrl: "https://uiverse.io/", type: "ui_visual",
    stageTags: ["design", "development"], useTags: ["layout", "form"], stackTags: ["html_css", "react"], prerequisites: ["browse", "basic_code"],
    summary: "按按钮、输入框和卡片寻找独立 UI 元素，补充局部实现。",
    suitableFor: "已有基础页面、需要一个视觉元素且能审阅代码的成员。",
    notSuitableFor: "把零散元素当完整设计体系，或没有时间验证响应式与交互的项目。",
    quickStart: ["选定元素类别并保存作者和条目链接。", "查看代码格式与依赖，人工审阅后只接入需要的部分。", "统一视觉，检查键盘、减少动效与手机显示。"],
    costType: "free_plan", costNote: "官网声明站内 UI 元素免费用于个人和商业用途；外链工具和服务不在此范围。", costSourceUrl: "https://uiverse.io/",
    licenseStatus: "source_verified", licenseNote: "官网声明 UI 元素采用 MIT。保留所选条目的作者、版权和许可声明；不扩展到网站品牌或外链内容。", licenseSourceUrl: "https://uiverse.io/", licenseVerifiedAt: checkedAt, displayOrder: 5,
  }, [evidence("purpose", "https://uiverse.io/", "官方首页列出 UI 元素类别和提供的代码格式。")], ["逐个核对选用条目及代码，不自动执行或下载示例。"]),
  entry("penpot", {
    ...base, name: "Penpot", officialUrl: "https://penpot.app/features", type: "practical_tool",
    stageTags: ["design", "delivery"], useTags: ["prototype", "collaboration", "presentation"], stackTags: ["stack_agnostic"], prerequisites: ["account"],
    summary: "协作绘制界面和可点击原型，确认流程并准备演示。",
    suitableFor: "符合官方账号要求、需要设计协作与原型演练的成员。",
    notSuitableFor: "把原型当可运行应用；自部署也需要额外环境、维护和学习时间。",
    quickStart: ["核对账号要求与云套餐后创建设计文件。", "用有权使用的素材绘制关键界面并在 Prototype 中连接。", "在 View 中演练流程，确认共享范围后向队友分享。"],
    costType: "free_and_paid", costNote: "官方列出免费 Professional 及付费云方案，存储、历史和治理功能有差异；自部署基础设施和维护另计。", costSourceUrl: "https://penpot.app/pricing",
    licenseNote: "已查官方云条款和源码 MPL 2.0 许可；源码开源不统一授权云端素材、字体、模板或专有模块。实际所选内容与账号使用条件仍待逐项核验。", licenseSourceUrl: "https://penpot.app/terms", displayOrder: 6,
  }, [evidence("purpose", "https://penpot.app/features", "官方支持设计、原型与协作。"), evidence("purpose", "https://help.penpot.app/user-guide/prototyping-testing/prototyping/", "官方说明连接界面板和 View 分享。"), evidence("license", "https://github.com/penpot/penpot/blob/develop/LICENSE", "所查源码采用 MPL 2.0；此证据不替代云服务和项目素材权益核验。")], ["云条款含账号年龄条件；不能通过本站账号绕过第三方要求。"]),
  entry("awwwards", {
    ...base, name: "Awwwards", officialUrl: "https://www.awwwards.com/", type: "inspiration",
    stageTags: ["preparation", "design"], useTags: ["layout", "presentation"], stackTags: ["stack_agnostic"], prerequisites: ["browse"],
    summary: "观察整站案例的信息层级、排版与交互，把参考转化为自己的设计说明。",
    suitableFor: "正在选择视觉方向、能明确写出参考目的的成员。",
    notSuitableFor: "寻找可直接复制的图片、品牌、字体或代码的人；案例展示不授予素材使用权。",
    quickStart: ["按任务或风格找案例，并保留原站链接。", "写下层级、留白与导航等可学习点。", "使用自有或已授权素材重新画草稿，只保留时间允许的交互。"],
    costType: "unknown", costNote: "本次未获得足够官方证据确认现行价格；浏览、PRO、课程、市场素材及参评费用应分别人工核对。", costSourceUrl: null, costVerifiedAt: null,
    licenseNote: "本次未充分核实现行素材条款。仅作观察设计的入口，图片、品牌、字体与代码需向原权利方另行确认。", licenseSourceUrl: null, displayOrder: 7,
  }, [evidence("purpose", "https://www.awwwards.com/websites/single-page-1/", "官方案例分类可支持布局与交互观察；本次可读索引较旧，不据此确认价格和权益。")], ["主入口和当前费用/素材条款仍需运营人工核对。"]),
  entry("figma", {
    ...base, name: "Figma Design", officialUrl: "https://www.figma.com/design/", type: "practical_tool",
    stageTags: ["design", "development"], useTags: ["prototype", "layout", "collaboration"], stackTags: ["stack_agnostic"], prerequisites: ["account"],
    summary: "协作绘制关键页面与交互原型，向开发成员交接结构和组件状态。",
    suitableFor: "需要先确认报名、工作台或演示流程的设计与产品成员。",
    notSuitableFor: "需要真实数据库业务运行验证的场景；原型仍需开发与权限验证。",
    quickStart: ["登录并查看当前 Starter 与付费席位范围。", "绘制一条核心流程，统一颜色、字号和组件状态。", "连接交互并让队友评论，整理开发尺寸与错误状态。"],
    costType: "free_and_paid", costNote: "官方有受限免费 Starter 和付费方案；席位、协作功能及 AI 用量各有范围，使用前核对当前套餐。", costSourceUrl: "https://www.figma.com/pricing/",
    licenseNote: "Community 资源许可因资源类型和免费/付费状态而异，部分需署名；实际文件、字体、图片、插件和生成内容未逐项核验。", licenseSourceUrl: "https://help.figma.com/hc/en-us/articles/360042296374-Figma-Community-copyright-and-licensing", displayOrder: 8,
  }, [evidence("purpose", "https://www.figma.com/design/", "官方介绍设计、协作与原型用途。")]),
  entry("v0", {
    ...base, name: "v0", officialUrl: "https://v0.app/docs", type: "ai_design",
    stageTags: ["design", "development"], useTags: ["prototype", "layout", "workspace", "form"], stackTags: ["react"], prerequisites: ["account"],
    summary: "从文字描述形成界面草稿，再通过设计调整和代码审阅完善页面。",
    suitableFor: "想快速比较布局方案，并有成员负责检查生成代码的队伍。",
    notSuitableFor: "把生成预览当安全、可访问性或正式交付验收，或来不及检查复杂集成的项目。",
    quickStart: ["登录并检查额度和数据设置，用不含密钥的描述开始。", "说明用户动作、页面状态与视觉要求，先生成最小流程。", "调整布局、审阅代码并验证错误状态、权限与实际运行。"],
    costType: "free_and_paid", costNote: "官方有免费限制和付费方案，部分方案可另购用量额度；Vercel 部署服务费用另查，不代表无限免费。", costSourceUrl: "https://v0.app/pricing",
    licenseNote: "官方 FAQ 说明 Vercel 不拥有按用户提示生成的代码，并要求用户评估第三方知识产权及商业适用性；具体输出和依赖许可未核验。", licenseSourceUrl: "https://v0.app/docs/faqs", displayOrder: 9,
  }, [evidence("purpose", "https://v0.app/docs", "官方说明用提示生成界面与应用草稿。"), evidence("purpose", "https://v0.app/docs/faqs", "官方列出 React/Next.js 等框架适用信息和使用边界。")]),
  entry("github-codespaces", {
    ...base, name: "GitHub Codespaces", officialUrl: "https://docs.github.com/en/codespaces/about-codespaces/what-are-codespaces", type: "practical_tool",
    stageTags: ["preparation", "development", "delivery"], useTags: ["development", "collaboration"], stackTags: ["stack_agnostic"], prerequisites: ["account", "basic_code", "environment"],
    summary: "从可信仓库创建云端 Linux 开发环境，减少队员的本机环境差异。",
    suitableFor: "已有仓库访问权、希望使用浏览器开发并提前预演环境的技术成员。",
    notSuitableFor: "需要 Windows/macOS 远端环境、离线工作或长期生产部署的任务。",
    quickStart: ["核对仓库权限、费用承担者与账号额度，使用已知可信仓库。", "创建 codespace，查看开发容器并按项目文档启动。", "验证构建、保存代码，不用时停止环境并检查保留存储。"],
    costType: "usage_based", costNote: "个人账号有月度计算/存储额度，超额按量计费；组织及企业条件不同。停止后的保留存储仍须计入，事先检查预算。", costSourceUrl: "https://docs.github.com/en/billing/concepts/product-billing/github-codespaces",
    licenseNote: "云开发服务不统一授予仓库、模板或依赖的使用权；GitHub 条款要求遵守内容许可，具体项目和容器内容未核验。", licenseSourceUrl: "https://docs.github.com/en/site-policy/github-terms/github-terms-of-service", displayOrder: 10,
  }, [evidence("purpose", "https://docs.github.com/en/codespaces/about-codespaces/what-are-codespaces", "官方说明云端 Linux 开发容器与浏览器入口。")]),
  entry("excalidraw", {
    ...base, name: "Excalidraw", officialUrl: "https://excalidraw.com/", type: "practical_tool",
    stageTags: ["design", "retrospective"], useTags: ["flowchart", "prototype", "collaboration"], stackTags: ["stack_agnostic"], prerequisites: ["browse"],
    summary: "画流程、系统关系与低保真界面，让队友快速讨论范围和依赖。",
    suitableFor: "需要轻量白板整理用户流程、架构或复盘问题的任意角色。",
    notSuitableFor: "要求完整高保真组件、复杂交互原型或免费云端长期管理全部场景的任务。",
    quickStart: ["打开白板，用形状、箭头和文字画核心流程。", "标记问题，与队友检查遗漏和依赖。", "保存文件或导出图示，再把确认结论写回项目任务。"],
    costType: "free_and_paid", costNote: "官方区分免费白板和收费 Plus，云端管理与权限功能有差异；开源代码许可不等于 Plus 云服务免费。", costSourceUrl: "https://plus.excalidraw.com/pricing",
    licenseStatus: "source_verified", licenseNote: "核验官方源码为 MIT，代码复用保留版权与许可声明；不授予导入图片、品牌、AI 输出或第三方素材的权利，也不替代 Plus 服务条款。", licenseSourceUrl: "https://github.com/excalidraw/excalidraw/blob/master/LICENSE", licenseVerifiedAt: checkedAt, displayOrder: 11,
  }, [evidence("purpose", "https://plus.excalidraw.com/pricing", "官方免费/Plus 对比包含白板编辑、协作与导出；未进行账号和编辑实测。")]),
  entry("canva-presentations", {
    ...base, name: "Canva Presentations", officialUrl: "https://www.canva.com/presentations/", type: "practical_tool",
    stageTags: ["design", "delivery"], useTags: ["presentation", "collaboration"], stackTags: ["stack_agnostic"], prerequisites: ["account"],
    summary: "协作制作路演幻灯片，整理问题、方案、演示流程与结果。",
    suitableFor: "负责路演、文案与展示材料，希望使用拖拽编辑的成员。",
    notSuitableFor: "未经核查复制素材、音乐或品牌，或导出后不检查字体与现场兼容性的交付。",
    quickStart: ["登录后列出问题、用户、方案、演示和结果的提纲。", "逐项查看素材 Free/Pro 和来源标签，用少量模板统一视觉。", "替换为真实项目内容，导出需要的格式并预演播放。"],
    costType: "free_and_paid", costNote: "官方有免费与付费方案，高级素材、工具和 AI 额度不同；部分增购另收费，免费账号不代表所有素材免费。", costSourceUrl: "https://www.canva.com/pricing/",
    licenseNote: "官方内容许可区分素材类型及 Free/Pro 等条件，音乐另有规则；所选素材、上传内容和生成结果未逐项核验，不能整体认定可商用。", licenseSourceUrl: "https://www.canva.com/policies/content-license-agreement/", displayOrder: 12,
  }, [evidence("purpose", "https://www.canva.com/presentations/", "官方演示产品支持协作和文件导出；未进行现场播放实测。")]),
  entry("framer", {
    ...base, name: "Framer", officialUrl: "https://www.framer.com/", type: "practical_tool",
    stageTags: ["design", "delivery"], useTags: ["layout", "prototype", "deployment"], stackTags: ["stack_agnostic"], prerequisites: ["account"],
    summary: "可视化制作响应式展示站，并预演公开发布入口。",
    suitableFor: "需要项目介绍页、作品展示站或路演外链且能提前演练的成员。",
    notSuitableFor: "需要自管复杂后端，或未确认套餐、模板权益和域名成本的正式商业站。",
    quickStart: ["核对方案，从空白或已确认许可的模板开始。", "填写真实介绍与演示入口，检查桌面和手机。", "预演发布并核对公开访问、域名和套餐要求。"],
    costType: "free_and_paid", costNote: "官方有免费与付费方案，自有域名等功能需要付费条件，编辑席位和增购可能另计；免费方案用途限制应按官网复核。", costSourceUrl: "https://www.framer.com/pricing",
    licenseNote: "官方条款区分客户内容、服务和第三方社区资源；实际模板、字体、图片及生成内容未逐项核验，不作整体商用或再分发承诺。", licenseSourceUrl: "https://www.framer.com/legal/terms-of-service", displayOrder: 13,
  }, [evidence("purpose", "https://www.framer.com/", "官方介绍可视化设计与发布用途。"), evidence("purpose", "https://www.framer.com/help/articles/how-to-connect-a-custom-domain/", "官方说明连接自定义域名所需设置和条件。")]),
];
