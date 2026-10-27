# 主办方工作台布局重构交付 · 2026-10-16

> 依据：[主办方工作台布局](../设计/主办方工作台布局.md)（布局规格 v1.0 第 2、3、5、6、7、9 节）、[主办方工作台设计](../设计/主办方工作台设计.md)（§4–§6、§10 步骤 1–3、5.8）、[规划 33](../规划/33-主办方可用性与赛后闭环.md)。
> 授权：用户 2026-10-16「读取新规划，新主办方工作台布局设计规划，继续分会话完成未完成的内容」。布局文档第 11 节五个待确认项按文档自身推荐的默认执行。

## 1. 完成内容（对照布局规格逐条）

| 布局要求 | 落实 |
| --- | --- |
| §2.1 去掉 section 页双层容器，桌面内容宽度 1092px → 1140px | 新增 `.sectionPage`（只做 `display:grid;gap:24px`，不再自带 `width:min(1200px,calc(100% - 48px))`）；`OrganizerSectionPage` 改用它。`.container` 一行未改（仍有公开赛事页等 7 处引用） |
| §3.2 / §7 上下文条与页签粘性、同一粘性容器、不遮挡内容 | `IdentityFrame` 的 staff 模式把上下文条 + 期限 + 页签包进 `.stickyChrome`（`position:sticky;top:0;background:var(--paper)`）；`.sectionPage [id]` 给锚点留 `scroll-margin-top:160px` |
| §5.2 状态条由 `OrganizerActionCenter` 改造，容器 `padding:22px`、底色 `--tint` 同族、不使用两列 | 外层类从 `.card` 改为既有 `.nextStep`（`#fff1e5`），内容保持通栏单列 |
| §6.1 发布门槛清单移出状态条、只在设置页出现一次；删除「你的身份可以处理…」 | 抽出 `OrganizerPublishGate`（同文件导出），状态条不再渲染门槛；门槛只挂在新的比赛设置页 |
| §5.5 页签顺序固定为 报名→队伍→通知→行程→现场→评审 | 复用既有 `staffNames`（顺序已一致），本次把它固定下来 |
| §5.1 / §6.2 比赛卡、指标卡 290px/165px 下限、手机上强制单列 | 新增 `.eventCards`（minmax 290px）、`.metricRow`（minmax 165px）、`.metric`；`@media(max-width:620px)` 里显式 `1fr` |
| §6.1 断点只准 S/M/L | 新增规则只用 `@media(max-width:620px)`；未新增 640/650 |
| §5.4 期限行无值不渲染、不显示占位 | 概览与比赛卡的期限行都只在有值时渲染 |
| §7 粘性不遮挡、误差焦点不被压住 | 粘性容器有实底色并用 `z-index:10`；锚点留位 |
| §2.3 / §5.2 徽标与次级说明 | 补上本模块缺失的 `.badge` / `.badgeWarning` / `.badgeSuccess` / `.badgeMuted` / `.muted`（只用 `globals.css` 既有令牌） |

## 2. 新增页面与路径（设计 §10 步骤 2–3）

| 路径 | 组件 | 说明 |
| --- | --- | --- |
| `/organizers/workspace` | `OrganizerWorkspacePage` | 顶部新增「我的比赛」状态卡（`WorkbenchEventCards`）＋「进入本场运营 / 比赛设置 / 看选手视图」；原配置与创建收进 `<details>高级设置与创建比赛</details>` |
| `/organizers/workspace/[eventId]` | `OrganizerEventOverviewPage` | **新落地页**：上下文条 + 状态条 + 报名计数指标行 + 本场运营入口 + 最近变化；P07 未落地前不渲染看板区 |
| `/organizers/workspace/[eventId]/settings` | `OrganizerEventSettingsPage` | 上下文条 + **发布门槛清单** + 既有配置表单 |
| `/organizers/workspace?event=…` | `OrganizerWorkspaceFromQuery` | 历史链接**仍可用**，`router.replace` 重定向到该场设置页 |

## 3. 与布局文档的偏离（逐条说明，不是静默改需求）

1. **状态条位置后移一位**。布局 §3.2 的线框是 ①上下文 ②状态 ③页签，但 §7 要求 ①③ 包在**同一个**粘性容器内而 ② 不粘性——② 夹在中间时 CSS 无法既同容器又让 ② 滚走。实现取「①上下文+期限+③页签 同容器粘性，②状态条紧随其后」，DOM 顺序为 ①③②④。L1「首屏免滚动」仍成立（上下文约 120px + 页签约 50px + 状态条约 180px，1280×800 下可见）。
2. **补齐 `.badge` / `.muted`**。`competition-workspace.module.css` 一直被本模块多处引用这两个类名却没有定义（渲染为无类）。布局 §2.3 把徽标与次级说明列为既有层级，故按既有令牌补上；这会让原先无样式的这些元素获得符合设计的样式，属修复而非新色板。
3. **列表页未做「零配置表单」的完全拆分**。设计 §10 步骤 2 要求配置表单只留在设置页；本次把列表页的重内容收进折叠区（首屏先是比赛卡与下一步），但没有把 `OrganizerWorkspace` 的机构/比赛选择器从列表页彻底移除以避免改动创建路径；已登记为后续。
4. **每屏唯一 `.primary`** 只在工作台外壳内保证（状态条 1 个主按钮；卡片与页签用 `.secondary`）。各模块内容区（如报名审核）自己的主按钮不在本次范围内，未改动。

## 4. 验证

| 项 | 结果 |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit --incremental false` | **exit 0**（全仓无诊断） |
| `src/modules/organizer/*.test.ts`（含 P05、P07） | 112 / 112 |
| `src/modules/event-judging/*.test.ts`（含 P06） | 110 / 110 |
| `src/modules/event-communication/*.test.ts`（含 P08） | 50 / 50 |
| `src/server/organizer-router-acceptance.test.ts`（已追加 P05/P06/P08 断言） | **5 / 5 通过**：匿名 401、非本机构 403、读取进度/导出前后原始汇总仍为 80、对外留档件不含评委账号、复制不改来源逐字段且不进公开目录 |
| 全量 `src/server/*.test.ts`（84 个文件） | 679 项：676 通过、2 跳过、1 失败（`graceful-stop.test.ts` 请求排空计数，与本次改动无关，登记待复核） |
| `next build` + `postbuild verify-build-tracing --sanitize` | **BUILD_EXIT=0**、**VERIFY_EXIT=0**；路由表已出现 `/organizers/workspace/[eventId]` 与 `/organizers/workspace/[eventId]/settings` |
| 停机 → 单实例重启 → 页面核验 | 正常停机（数据库关闭后退出）；重启后 `/organizers/workspace`、`/organizers/workspace/demo-event`、`/organizers/workspace/demo-event/settings`、`/organizers`、`/competitions` 均 **200**；`/api/v1/organizer/events/demo/readiness` 未登录 **401** |

## 5. 本轮未做 / 待办

> **2026-10-16 续（用户「继续做完」）：上面第 1–3 项已完成**，逐项见 [plan33-root-wiring.md](plan33-root-wiring.md)。

1. ~~P07 看板界面接线~~ —— 已完成：概览页「数据看板」筛选页签＋指标＋记录，未读取显示「未提供」。
2. ~~P09 根接线~~ —— 已完成：迁移 `072_event_closure.sql`、`CLOSURE_ROUTES`、只读 `EventClosureSourcePort`、主办方「赛后闭环」区与本人联系意愿卡。
3. ~~列表页与设置页的完全拆分~~ —— 已完成：`OrganizerWorkspace.eventSelectionHref` 使既有比赛一律跳到设置页，配置表单只在设置页（创建 `new` 时在向导内）出现。
4. 真机窄屏走查与 320–1440 七档 `scrollWidth === clientWidth` 自动化核验尚未执行（需 Playwright 环境）。
5. P09 仍有两项**如实未接**（不补占位）：M07「已确认复盘条目」计数、`schedule`/`notification_template`/`branding` 三类复用来源。
