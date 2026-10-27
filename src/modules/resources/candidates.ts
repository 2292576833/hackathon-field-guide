import type { ResourceInput, ResourceType, ResourceUse } from "./domain.ts";

/** Planning-document inputs for human review. Never public seeds or verified recommendations. */
export interface ResourceCandidate {
  readonly candidateKey: string;
  readonly status: "unverified_candidate";
  readonly input: ResourceInput;
  readonly checkBeforePublishing: readonly string[];
}
const entries: readonly {key: string; name: string; url: string; type: ResourceType; use: ResourceUse; summary: string; check: string}[] = [
  {key: "awwwards", name: "Awwwards", url: "https://www.awwwards.com/", type: "inspiration", use: "layout", summary: "观察整站案例的信息层级、布局和交互。", check: "账号门槛；案例中的图片、商标与代码使用权。"},
  {key: "figma", name: "Figma", url: "https://www.figma.com/", type: "practical_tool", use: "prototype", summary: "作为界面原型和团队设计协作的候选。", check: "账号要求、当前套餐与协作限制、AI 数据设置。"},
  {key: "penpot", name: "Penpot", url: "https://penpot.app/features", type: "practical_tool", use: "prototype", summary: "作为原型制作和设计交接的候选。", check: "云端与自部署差异、配置成本、当前许可。"},
  {key: "v0", name: "v0", url: "https://v0.app/docs", type: "ai_design", use: "prototype", summary: "根据描述形成界面草稿，生成结果需检查。", check: "账号与额度、当前框架依赖、导出及生成代码验证。"},
  {key: "shadcn", name: "shadcn/ui", url: "https://ui.shadcn.com/docs", type: "ui_visual", use: "form", summary: "作为建立统一界面组件体系的候选。", check: "选中组件的技术栈、依赖、升级与许可。"},
  {key: "radix", name: "Radix Primitives", url: "https://www.radix-ui.com/primitives/docs/overview/introduction", type: "ui_visual", use: "form", summary: "作为交互基础组件的候选，需要样式与代码经验。", check: "当前版本和许可；整页可访问性仍需验证。"},
  {key: "antd", name: "Ant Design", url: "https://ant.design/docs/react/introduce/", type: "ui_visual", use: "workspace", summary: "作为工具型工作台界面体系的候选。", check: "当前技术栈、包体、主题统一、版本与许可。"},
  {key: "uiverse", name: "Uiverse", url: "https://uiverse.io/", type: "ui_visual", use: "layout", summary: "查找独立 UI 元素的参考，单个条目需分别核查。", check: "单个元素的技术栈、许可与可访问性；不能当完整组件体系。"},
  {key: "lucide", name: "Lucide", url: "https://lucide.dev/", type: "ui_visual", use: "icons", summary: "作为统一界面图标风格的候选。", check: "选用版本、当前许可、图标语义与文字标签。"},
  {key: "codespaces", name: "GitHub Codespaces", url: "https://docs.github.com/en/codespaces/about-codespaces/what-are-codespaces", type: "practical_tool", use: "development", summary: "作为配置云开发环境的候选，比赛前需要预演。", check: "账号、额度和计费、仓库配置、网络与环境要求。"},
];

export const RESOURCE_CANDIDATES: readonly ResourceCandidate[] = entries.map((entry, index) => ({
  candidateKey: entry.key, status: "unverified_candidate",
  input: {
    name: entry.name, officialUrl: entry.url, type: entry.type,
    stageTags: entry.use === "development" ? ["development"] : ["design"], useTags: [entry.use],
    stackTags: ["unknown"], prerequisites: ["browse"], summary: entry.summary,
    suitableFor: "待人工补充适合人群与账号、环境门槛。",
    notSuitableFor: "待核验候选；不能据此确定费用、许可或比赛允许使用。",
    quickStart: ["由运营核对官方说明后，补充最短使用步骤。"],
    costType: "unknown", costNote: "费用尚未核验。", costSourceUrl: null, costVerifiedAt: null,
    licenseStatus: "unknown", licenseNote: "许可尚未核验；设计参考不授予素材使用权。", licenseSourceUrl: null, licenseVerifiedAt: null,
    verifiedAt: null, linkStatus: "unknown", displayOrder: index + 1,
  },
  checkBeforePublishing: [entry.check, "核对官方入口可访问，补充用途、门槛、开始步骤与核验时间。", "通过 M08 人工审核后才可发布。"],
}));
