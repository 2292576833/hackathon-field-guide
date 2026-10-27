# 规划33 根接线交付（P07 看板 + P09 赛后闭环）· 2026-10-16

> 依据：[规划 33](../规划/33-主办方可用性与赛后闭环.md)、[主办方工作台设计](../设计/主办方工作台设计.md)、[主办方工作台布局](../设计/主办方工作台布局.md)。
> 用户 2026-10-16「完成 / 继续做完」：把上一轮登记的三个待办（P07 看板界面、P09 根接线、列表页与设置页拆分）做完。

## 1. P07 数据看板下钻（根接线）

| 项 | 内容 |
| --- | --- |
| 注入 | `src/server/organizer-integration.ts` 给 `OrganizerService` 注入只读 `OrganizerDashboardPort`：8 个方法**原样转发**既有读路径（`registration.registrationCounts` / `listStaff` / `listStaffTeams`、`judging.workspace` / `progress`、`logistics.listAccommodation` / `listVouchers`、`schedule.getScheduleDraft`），不另写查询、不另算口径 |
| 端点 | `GET organizer/events/:eventId/dashboard?panel=…`；**未新增路由族**（`organizerHttpRoute` 已解析该路径） |
| 界面 | 本场概览页新增「数据看板」区块：按 capability 过滤的筛选页签（报名/队伍/收件/评审/后勤）＋ 指标卡 ＋ 分组 ＋ 记录列表；每块标统计范围与数据时间；`undefined` 显示「未提供」，绝不用 0 代替 |
| 只读 | 无新表、无新列、无迁移、无审计、无 revision 变更 |

## 2. P09 赛后闭环（根接线）

| 项 | 内容 |
| --- | --- |
| 迁移 | `migrations/072_event_closure.sql` —— 唯一新表 `ecl_contact_willingness` ＋ 不可变守卫触发器 ＋ `one_active` 部分唯一索引；来源为模块建议 `src/modules/event-closure/migrations/001-event-closure.sql`，**已按递增编号落根** |
| 路由 | `CLOSURE_ROUTES` 5 条模式（6 个 handler 成员）：`GET organizer/events/:id/closure`、`GET …/closure/contact-willingness`、`GET|POST competitions/:id/contact-willingness`、`GET …/contact-willingness/eligibility`、`POST …/contact-willingness/:id/withdraw` |
| 服务 | `createEventClosureService`（`staffCapability` 默认 `judging_manage`），与本模块测试夹具同一实现 |
| 来源端口 | `EventClosureSourcePort` 全部只读：`intakeReceipts` → `judging.closureIntakeReceipts`（复用既有 `store.listReceipts`）；`publishedResults` → `judging.closurePublishedResults`（复用 `publicationReview` / `summaryIn`，`needs_review` 时 `rows=[]`）；`reuseSources` → 已发布规则版本 ＋ 已发布报名表 ＋ **最近已公布**评审轮基准，每一项 `href` 指回既有页面 |
| 界面 | 主办方本场概览「赛后闭环」区（`PostEventClosurePanel`）；本人比赛结果页「是否愿意被联系」卡（`ContactWillingnessCard`，默认不公开、可撤回、原文写明不代表投资/录用/孵化） |
| 边界 | 唯一新增事实；不撮合、不承诺结果、不把成绩当能力评价；不改分数/名次/公布；不新增一级导航或第二个成果页面 |

## 3. 工作台列表页与设置页拆分（设计 §10 步骤 2 收尾）

- `OrganizerWorkspace` 新增可选 `eventSelectionHref`：提供后，把「当前比赛」切到一场**既有**比赛会直接跳到该场设置页，而不是在本页内联渲染配置表单。
- 根传入 `id => \`/organizers/workspace/${id}/settings\``，于是**配置表单只在设置页出现**（创建 `new` 时仍在向导内完成，因为创建本身要填表单）。
- 列表页折叠区标题改为「创建比赛与机构设置」，内容只保留创建与机构级设置；`?event=` 历史链接仍重定向到设置页。

## 4. 验证（真实执行）

| 项 | 结果 |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit --incremental false` | **exit 0** |
| `src/server/organizer-router-acceptance.test.ts` | **5/5**：新增 P07 断言（看板「待审核/已通过」与 `registration-counts` **逐一相等**、评委/选手/匿名 403/401、读取后原始汇总仍为 80）与 P09 断言（默认不公开、本人选择后才对本场主办方可见、同一重试标识幂等、非本人撤回 403、撤回后不再显示、提交前后汇总仍为 80） |
| `src/modules/event-judging/*.test.ts` | 110/110（新增 `closureIntakeReceipts` / `closurePublishedResults` / `closureJudgingRounds` 未破坏既有） |
| `src/modules/event-closure/*.test.ts` | 25/25 |
| `next build` + `postbuild verify --sanitize` | **BUILD_EXIT=0 / VERIFY_EXIT=0** |
| 停机 → `scripts/migrate.mts` → 单实例重启 | 迁移 **Migrations applied: local**；核实 `application_migrations` 有 `072_event_closure.sql`、表 `ecl_contact_willingness`、触发器 `ecl_contact_willingness_identity_frozen` 均存在 |
| 重启后页面与新端点 | `/organizers/workspace`、`/organizers/workspace/demo-event`、`/organizers/workspace/demo-event/settings`、`/organizers`、`/competitions` 均 **200**；`/api/v1/organizer/events/demo/dashboard`、`/closure`、`/api/v1/competitions/demo/contact-willingness` 未登录均 **401** |

## 5. 仍然未做（明确登记，不假装完成）

1. **`confirmedRetrospectiveCounts`（M07 已确认复盘计数）**：`EventClosureSourcePort` 的可选方法，未接入。赛后视图中「复盘条目」如实显示**未读取**（不显示 0、不编造）。接入需要在 M07 侧提供 `(sql, projectIds)` 级只读计数，并与根 application 组合。
2. **复用来只覆盖三类**：`published_revision`、`registration_form`、`judging_baseline`。`schedule`、`notification_template`、`branding` 未接入（模块约定「没有记录就不要返回这一项」，因此**不补占位**）。
3. 真机窄屏走查与 320–1440 七档 `scrollWidth === clientWidth` 自动化核验仍未执行（需 Playwright 环境）。
