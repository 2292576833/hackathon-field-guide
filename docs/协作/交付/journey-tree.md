# J02 参赛路线图树状界面交付

日期：2026-10-09。范围依据：宪法 v1.6.0、参赛树状路线图总体规划及 J02 文件授权。

## 已完成

仅新增/修改以下四个授权文件：

- `src/modules/journey/JourneyTree.tsx`
- `src/modules/journey/journey.module.css`
- `src/modules/journey/ui.ts`
- 本交付说明。

`JourneyTree({ guide })` 从 J01 的 `model.ts` 引用 `JourneyGuide`、`JourneyPhase` 和 `JourneyNode`，没有建立第二份内容类型。树根标题、说明、入口以及阶段、行动、并行提示、资源与注意事项均读取传入指南；`ui.ts` 只导出 `JourneyTree`，不修改纯数据入口。

桌面以居中树根、横向总分枝和三阶段连接线呈现，阶段下用纵向支线、圆点和短线连接行动；行动再接缩进的工具/资料子枝。1023px 及以下改左侧纵向主干，资源继续缩进；手机阶段捷径缩为“赛前 / 赛中 / 赛后”，完整阶段名保留在标题与链接可访问名称中。没有以互不相关的三列卡片代替树图。

组件使用原生 `section/nav/ol/li`、链接和 `details/summary`，标题为树根 H2 → 阶段 H3 → 行动 H4。列表显式保留列表语义，未使用 ARIA tree、画布或图形库；空内容 CSS 连接线不承载辅助技术信息，箭头为装饰。阶段注意事项紧邻阶段标题，默认收起，键盘可展开。

页面开头明确通用准备指南、主办方要求优先、浏览/点击不代表完成、具体依赖/真实进度在空间确认、报告完成后仍需检查，以及私人材料不自动共享。并行提示和按需辅助均有文字说明；不新增打钩、完成率、个人状态或固定任务依赖。

继承暖白/炭黑/橙红令牌；普通链接和主按钮使用深橙红 `--action`。所有链接及提醒开关至少 44px 高，键盘焦点为 3px 轮廓，连接线不截获点击，减少动效时去掉过渡。资源名称与使用时机/作用在同一可点击入口内，无嵌套链接。

组件为纯呈现：没有客户端 effect、API 请求、模型调用、私人资料读取或状态持久化，不重复 SiteShell、PageTitle 或全站导航。

## 已验证

- `npm run typecheck -- --incremental false` 通过，未写入增量编译缓存。首次检查时 J01 的 `catalog.ts` 尚未落盘，待其可用后复查通过。
- 通过已安装的 Edge（Playwright `channel: msedge`）在内存中渲染实际 `JourneyTree.tsx`、模块 CSS 和 J01 `getJourneyGuide()` 内容，检查 1280、1024、768、375、320px：文档宽度均等于视口宽度，没有横向溢出，所有链接/summary 均至少 44px 高。桌面为三阶段 grid，窄屏为纵向 block。
- 375px 原生 Tab 遍历到全部 54 个指南链接，全部具有可见的至少 3px 焦点。Enter 可展开提醒，三个阶段锚点均可跳转并将焦点交给对应 section。
- `prefers-reduced-motion: reduce` 下按钮过渡为 `0s`、动画为 `none`。375px 下逐元素 200% 文本字号、额外的长中英混合资源标题压力夹具均无横向溢出。
- 实际离线桌面/手机组件渲染已作视觉检查，根→阶段→行动→资源父子关系可辨。补齐了行动到资源的连接段，并对齐手机阶段圆点与主干。
- 离线浏览器检查的页面错误和网络请求均为 0。截图仅在内存中检查，未写入未授权的日志/截图文件。

## 模拟测试与未接入边界

上述浏览器检查使用离线 HTML 外壳和实际公开指南数据，网络全部拦截；它验证组件布局、键盘和静态语义，不等于真实 `/journey` 路由、SiteShell、登录返回、权限、API 或生产环境已经贯通。长文本为布局压力夹具，不是新增生产内容。

实际根路由、各处入口、登录返回和生产构建/启动由主会话接入；全站隔离贯通与持久截图归 J03。公网受信任证书、真实手机登录/扫码仍沿用既有独立验收边界。J02 未运行安装、build、服务重启、真实数据库/邮件/模型/仓库操作，也未输出凭据。

## NEEDS_INTERFACE

无新增服务接口、环境变量或数据库迁移。主会话按既有入口组合即可：

```tsx
import { getJourneyGuide } from "@/modules/journey/index.ts";
import { JourneyTree } from "@/modules/journey/ui.ts";

<JourneyTree guide={getJourneyGuide()} />
```

以上路径别名示意应按根项目的实际导入方式调整。组件阶段锚点为 `journey-phase-before`、`journey-phase-during`、`journey-phase-after`；根标题 ID 为 `journey-root-title`。组件默认在同页渲染一次，不读取或构造 projectId；私人功能使用 J01 提供的既有真实入口，由原功能继续执行权限与保存规则。

## 编辑交还

J02 已完成交付，已停止编辑。以上四个文件交还主会话；不沿用本轮授权继续修改。
