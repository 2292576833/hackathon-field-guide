import { DomainError } from "../shared/errors.ts";

export interface LibraryArticle {
  slug: string; title: string; category: string; summary: string;
  body: readonly string[]; steps: readonly string[];
  links: readonly { title: string; url: string }[]; updatedAt: string;
}
/** Original Chinese guides. External links are references, not redistributed articles. */
export const LIBRARY_ARTICLES: readonly LibraryArticle[] = [
  { slug: "start-here", title: "第一次使用情报局，从这里开始", category: "网站介绍",
    summary: "先看当前一步，跟着报名、组队、做任务到交作品的路径继续。",
    body: ["新人不知道从哪里开始，先打开“参赛指引”；正在参赛的选手从“我的参赛”继续。主办方从顶部“主办方入驻”申请权限，审核后进入自己的办赛工作台。同一账号可以承担不同身份，功能按当前授权开放。", "找比赛时区分两个来源：全网赛事线索是 DSH 未核验分析，需要打开主办方原文报名；本站正式赛事由入驻主办方发布，可以在本网站报名、查看审核和入选通知。保存线索不等于报名成功。", "报名后准备参赛，在“我的参赛”创建或进入私人团队空间。写清最小作品，邀请队友，确认职责和时间，再做当前任务。本站比赛的正式队伍是赛事名单，私人空间是协作区，需要明确关联；主办方不会自动获得私人资料。", "到提交阶段，再准备演示、代码、讲稿和 PPT。本站赛事通过本场“提交作品”确认正式收件；外部比赛按主办方要求提交并记录凭据。GitHub保存、运行检查和正式提交分别核对。", "需要时再找工具、教程或问导航员。工具与参考资料经过审核，可做私人收藏，主动分享后才进入空间资料；设计灵感的官网说明由DSH更新，未完成显示等待。新人教程是本站原创。个人AI、计划和讲稿也默认私人保存，赛后留下经验。"],
    steps: ["找比赛，核对资格、时间与报名方式。", "完成报名；需要审核时查看本人审核结果。", "进入团队空间，确定作品目标、队友和分工。", "做当前任务，交接成果并更新阻塞。", "准备演示、核对材料，确认正式提交记录。", "写复盘，留下可复用经验。"],
    links: [{ title: "开始参赛指引", url: "/journey" }, { title: "找比赛", url: "/events" }, { title: "本站正式赛事", url: "/competitions" }, { title: "我的参赛", url: "/app" }, { title: "工具与资料", url: "/resources" }], updatedAt: "2026-10-11" },
  { slug: "hackathon-introduction", title: "黑客松是什么，第一次参赛需要准备什么", category: "黑客松入门",
    summary: "在有限时间内和队友完成一个能说明价值、可以演示的作品。",
    body: ["黑客松通常围绕主题或赛道限时协作。活动的时间、资格、人数、费用、AI 使用规则和提交方式各不相同，要逐项看主办方说明。", "新人可以负责调研、界面、内容、测试、演示或开发。先选择自己能验证完成的小任务，再承担更多责任。", "备赛时练习一次从启动项目到演示的完整流程。不要把赛前做完的内容默认当作合规参赛作品，应核对允许使用的既有代码和素材。", "先明确一个使用者、一个问题和一个核心流程。演示能走通之后，再增加功能。"],
    steps: ["核对资格、组队人数、时间和费用。", "确认赛道、评分重点、既有代码与 AI 使用规则。", "准备开发环境和备用演示方案。", "分配一个明确负责人给每项必交材料。"],
    links: [{ title: "MLH 黑客松组织指南", url: "https://guide.mlh.com/" }, { title: "比赛卡片", url: "/events" }], updatedAt: "2026-10-08" },
  { slug: "github-first-repository", title: "GitHub 入门：仓库、分支与第一次保存", category: "GitHub 指南",
    summary: "认识四个常用概念，再保存一个最小项目。",
    body: ["仓库存放项目文件及修改历史；分支让你独立修改；commit 是一次保存记录；pull request 是邀请别人检查并合入修改的请求。", "第一次可以创建带 README 的练习仓库，在新分支修改一个文件，保存后创建 pull request 并查看差异。", "比赛作品的 README 应说明用途、启动方法、已完成内容和演示方式。密钥、密码和个人资料应留在仓库外。"],
    steps: ["登录 GitHub，创建仓库，选择可见范围并初始化 README。", "建立工作分支，为一个小改动保存 commit。", "查看文件差异，再提交 pull request。", "回到仓库确认文件和版本确实存在。"],
    links: [{ title: "打开 GitHub 教程", url: "/github" }, { title: "GitHub 官方 Hello World", url: "https://docs.github.com/en/get-started/using-github/hello-world" }, { title: "创建项目仓库", url: "https://docs.github.com/en/get-started/start-your-journey/creating-a-repository-for-your-project-on-github" }], updatedAt: "2026-10-08" },
  { slug: "github-team-workflow", title: "队友一起改代码：怎样减少冲突", category: "GitHub 指南",
    summary: "把改动做小，说明文件分工，合并前先查看差异。",
    body: ["先约定谁主要修改哪些文件。共享配置和核心入口尽量由一位成员负责整合，避免多个人同时大改。", "开始工作前同步团队最新版本；每次提交围绕一个具体任务。合并前由队友检查差异，特别是接口和依赖变更。", "发生冲突时，先读冲突两侧的目的，和文件负责人确认保留方案。修完后重新启动并测试受到影响的流程，再保存解决记录。"],
    steps: ["写下当前任务、负责人和主要文件。", "同步最新版本，建立任务分支。", "小步保存，说明改动原因。", "查看差异、处理冲突并验证核心流程。"],
    links: [{ title: "打开 GitHub 教程", url: "/github" }, { title: "GitHub 协作入门", url: "https://docs.github.com/en/get-started/using-github/hello-world" }, { title: "项目工作台", url: "/app" }], updatedAt: "2026-10-08" },
  { slug: "delivery-checklist", title: "比赛结束前：演示与提交检查清单", category: "作品交付",
    summary: "留下可打开的作品、可复现的步骤和平台提交凭证。",
    body: ["规划时为集成、测试、材料和提交留出时间。完成一堆独立页面，不等于核心流程可以演示。", "用新窗口或另一台设备打开作品，按 README 从头执行一次。检查需要登录的功能、网络依赖和部署链接。", "保存 commit、运行验收和比赛平台提交是三件事。平台提交后保留时间、链接或确认凭证；不要用代码保存记录代替提交成功。"],
    steps: ["检查官网列出的必交材料。", "打开演示链接并完成核心流程。", "准备 README、演示说明和备用视频。", "在主办方平台提交并核对回执。", "记录提交凭证，赛后写复盘。"],
    links: [{ title: "前往项目交付工作台", url: "/app" }], updatedAt: "2026-10-08" },
  { slug: "skill-pack-guide", title: "技能包怎么选，安装前看什么", category: "AI 工具",
    summary: "按正在使用的 AI 工具和要完成的任务选择少量技能，安装前检查来源与范围。",
    body: ["技能是提供给 AI 工具的任务说明及相关文件。开源需要核对具体许可证；安装热度不能证明适合你的任务。", "先选择正在使用的 AI 工具，再查看任务套餐中每项技能的用途、固定版本、许可证与兼容证据。套餐分类不代表比赛主办方官方赛道。", "网页不能直接任意写入你的电脑。启用本机桥接并配对之后，检查项目目录、文件清单和冲突，再确认安装。文件写入、客户端发现与任务效果分别验证。"],
    steps: ["选择正在使用的 AI 工具和想完成的事。", "查看技能来源、版本、许可与证据。", "预览安装文件和项目目录。", "确认安装，保留回执；在工具中执行一次示例任务。"],
    links: [{ title: "AI 技能与任务套餐", url: "/skills" }, { title: "Agent Skills 标准", url: "https://agentskills.io/specification" }], updatedAt: "2026-10-08" },
];
export function listLibraryArticles(query = "", category = "") {
  if (query.length > 100 || category.length > 60) throw new DomainError("INVALID_FILTER", "资料筛选条件过长。");
  const keyword = query.trim().toLowerCase();
  return { items: LIBRARY_ARTICLES.filter(item => (!category || item.category === category) && (!keyword || `${item.title} ${item.summary} ${item.category}`.toLowerCase().includes(keyword))), categories: [...new Set(LIBRARY_ARTICLES.map(item => item.category))] };
}
export function getLibraryArticle(slug: string) {
  const result = LIBRARY_ARTICLES.find(item => item.slug === slug);
  if (!result) throw new DomainError("NOT_FOUND", "资料不存在。", { status: 404 });
  return result;
}
