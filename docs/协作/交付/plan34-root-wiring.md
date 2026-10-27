# 规划 34 · 根接线与验收记录（主会话）

日期：2026-10-16 ｜ 依据：`docs/规划/34-主办方模块化与选手社区.md` 与宪法 **v1.23.0** 原则 XIII
本文件由主会话维护，记录**根接线、迁移、验收证据与如实未完成项**。模块自身的实现细节见各自 `docs/协作/交付/<slug>.md`。

## 1. 分期状态

| 期 | 内容 | 模块 | 根接线 | 迁移 | 界面 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | 赛事级独立能力配置 `EventCommunityConfig` + 本场参赛名录 | organizer / event-communication | 已有 | 无 | 已有 | **完成** |
| P2 | 作品展示（队伍可选公开） | event-judging | `JUDGING_ROUTES` 5 条 | `073_work_disclosures.sql` | 选手侧公开范围卡 + 已公开作品；主办方侧只读 | **完成** |
| P3 | 工作人员受限邀请 | organizer | 路由由既有 `organizerHttpRoute` 命中；注入 `accountEmails` | `074_staff_invitations.sql` | 比赛设置内「工作人员与授权」面板 + `/my/staff-invitations/<token>` 领取页 | **完成** |
| P4 | 模块助手框架 + 七个流程模块助手 | module-assistants | `GET/POST organizer/events/:eventId/module-assistants[/:key]` | `078_event_assistant_switches.sql` | 7 个 section 面板 + 本场概览 + 比赛设置内助手开关 | **完成**（助手 7/7；开关默认全开、可逐项关闭） |
| P5 | 文字留言 | event-judging | `JUDGING_ROUTES` 3 条 | `076_work_comments.sql` | 作品列表内独立折叠区 | **完成** |
| P6 | 连接 + 私信 | event-community | `COMMUNITY_ROUTES` 11 条 | `075_event_community.sql` | 选手侧 `CommunityPanel` + 主办方举报队列 | 模块+根+界面完成；通知复用既有 outbox（**已接**）；**物理保留清理未接**（见未完成项 3） |
| P7 | 数值互评 + 其余助手 | event-peer-review（新建）+ module-assistants | `PEER_REVIEW_ROUTES` 3 条；助手 **7/7** 全接 | `077_event_peer_review.sql` | 作品列表内独立互评区（与留言分列） | **完成** |

## 2. 根接线记录

- **路由**：全部挂在既有 `organizer-integration.ts` 的模块路由表里，不新增一级导航、不新增公开面；写请求走既有 `authorizeMutation`（Origin/CSRF），私有 `no-store`、`nosniff`。
- **迁移**：`073`–`079` 已在**停机**后逐次应用（PGlite 单写），随后单实例重启。迁移只**新增**本规划自己的表，不改既有表。
- **只读 Port**：`eventCommunication.directory`（本场名录）、`EventClosureSourcePort`、`ModuleAssistantScope/Facts/Model/Ledger`、`organizer.accountEmails.readVerifiedEmail`（同事务只读 `auth_users`，active + 已验证）。
- **模块助手账本**：每次调用先落一条最薄的 `ai_execution_jobs`（`kind=module_assistant`、合成键 `organizer-assistant:<eventId>:<assistantKey>`），在 `withAiExecutionContext` 内走既有 `createBudgetedModel` 的 reserve/settle；**没有模型调用就不伪造 `ledgerId`**，失败即 fail-closed 丢草稿。
- **发现并修复的真实缺口**：公开作品投影（`works.ts`）虽然手里有回执，却不返回快照 id，客户端**拿不到留言入口的定位参数**；已在 `WorkShowcaseEntry` 增加 `snapshotId`（event-judging 144/144 仍全通过）。

## 3. 验收证据

| 项 | 命令/方式 | 结果 |
| --- | --- | --- |
| 类型 | `tsc --noEmit --incremental false` | **无输出** |
| 根路由验收 | `node --experimental-strip-types --test src/server/organizer-router-acceptance.test.ts` | **5/5** |
| organizer | 模块测试 | **130/130** |
| event-judging | 模块测试 | **144/144** |
| event-community | 模块测试 | **33/33** |
| module-assistants | 模块测试 | **21/21** |
| 生产构建 | `next build` | **BUILD_EXIT=0** |
| 停机→迁移→重启 | `stop-server` → `migrate` → `serve start` | 干净停机；`Migrations applied: local.`；单实例重启 |
| 实机探测 | 页面与端点（真实演示赛事 id） | 页面 `/competitions`、`/organizers/workspace`、`/organizers/workspace/<id>`、`/competitions/<id>` 均 **200**；`works/public` **403**（默认关，正确）、`works`/`community`/`participants`/`module-assistants`/`judging/works`/`community/reports`/`dashboard`/`event` 均 **401** |

根验收覆盖的关键语义：社区配置非法组合 **422**、发布后 `changedFields` 不含 `community`、复制上一场的草稿社区配置**回到默认全关**、助手目录按能力过滤且列出**全部 7 个已接事实来源的助手**、助手运行在未配置模型时如实 `degraded/model_unavailable` 且 `manualWorkflowUnaffected`、本场名录默认 **403**、作品公开前 **403** / 公开后参赛者 **200** / 匿名 **401** / 非参赛者 **403**、受限邀请生成→列表不回显 token→领取→**二次领取 409**→库中恰好一条 `StaffGrant`、留言发表→举报→隐藏→**隐藏后正文不再返回**，且**每一次前后原始汇总都仍为 80**。

## 4. 如实未完成项

1. **P7 数值互评已完成**（独立模块 `src/modules/event-peer-review/`，使「互评无法进入名次」成为**结构性**保证）：32/32、tsc 0；根路由 3 条、迁移 `077`、选手侧界面、根验收均已完成。**仍未做**：主办方举报处理台（举报只记事实于 `epr_review_reports`，只增不改、不裁决）。
2. **P4 已完成**：助手 7/7 全接（读不到的键如实写进 `missing`）；**赛事级助手开关**已实现并接根——`organizer/events/:eventId/module-assistant-switches`（GET/POST），默认全开、可逐项关闭、**即时生效并写既有审计、不随发布版本冻结**；根验收断言关闭后目录不再列出、运行返回 403、赛事 `revision`/`published_revision` 逐字段不变、审计恰好 +1。
3. **P6**：① **通知 Port 已接入并复用同一 outbox**——共享 `EventNotificationPort` 增加可选 `kind: "community"` 与 `actorUserId`（缺省行为不变），根通知实现按社区来源入队，**不建第二套通知**；迁移 `079` 把 `kind` 与表级约束放宽到 `community`，并同步更新 `organizer-notifications-schema.sql`；新增回归测试证明「社区来源不再被 `NOTICE_NOT_FOUND` 拒绝、同来源同版本幂等、非本场已通过报名者被拒」。② **物理保留清理仍未接**：`maintainRetention` 需要在既有后台维护循环里按赛事枚举调用（不新建定时器）；**读取时已按主办方配置的保留口径生效**，因此保留语义不缺，缺的是物理 purge。
4. **P6 请求上限/冷却/限长/限频**目前是模块常量（20 / 30 天 / 1000 / 20 条每 10 分钟）；规划 §5.1 未把它们列为可配置项，若要可配置需先扩展共享 `EventCommunityConfig`（本模块未越界改 `src/shared`）。
5. **P5 留言冷却**固定 30 秒（`commentMaxLength` 已可配置）；若要可配置冷却需根在共享配置加字段。
6. **P3 界面已完成**：比赛设置 →「工作人员与授权」（仅组织管理员可见）＝生成面板（角色/能力/有效期/绑定邮箱/备注）、状态列表与撤销、**链接只显示一次**；`/my/staff-invitations/<token>` 领取页展示机构·比赛·能力·角色·有效期·绑定邮箱掩码后才「接受邀请」。
7. **P2/P5/P6 的新界面未做浏览器走查**；测试为隔离内存 PGlite + 受控 Port，**不代表真实多连接 PostgreSQL 并发或手机实测**。
8. **P6 举报处理队列**只做只读展示（只含被举报快照），**不做裁决、不自动隐藏**——这是宪法 XIII 的有意取舍。

## 5. 边界与有意不做项

- 作品公开**只能由队伍本人**选择；主办方只能决定本场是否允许这件事。
- 文字留言与数值互评**分列存储、分列展示**，**绝不**进入 `aggregate()`／名次／公布／对外导出；评分期评委不可见。
- 社区默认关、仅同场、连接**双向同意**（无单向关注）、屏蔽与举报必选、不自动暴露联系方式、不声称年龄核验、消息内容不进入任何模型训练（宪法 XII）。
- 受限邀请**禁止「点开即授权」**；领取只写既有 `StaffGrant`，不建第二套授权事实。
- 模块助手**不设平台强制次数上限**；额度若由赞助方自设，由账本 Port 负责，避免静默限流。
