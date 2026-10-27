# P6 · 连接 + 私信（event-community）交付

日期：2026-10-16。依据：`docs/规划/34-主办方模块化与选手社区.md` §4 D（4.1 三层、4.2 安全底线）与 §5/§6/§7；
`.specify/memory/constitution.md` v1.23.0 原则 XIII 的「选手社区（名录、连接、私信）」与「明确不做」；
`src/shared/organizer-contracts.ts` 的 `EventCommunityConfig` / `DEFAULT_EVENT_COMMUNITY` / `eventCommunity(scope)`。
结构照 `src/modules/event-closure/`（model/service/postgres/handlers/index/ui + 迁移建议 + 测试 + README）。

授权文件范围：**仅新增** `src/modules/event-community/` 与本交付。
未编辑 `src/app`、`src/server`、`src/shared`、`src/components`、`migrations` 或任何其他模块的现有文件。
未运行 build / 迁移 / 重启 / npm install / 任何 git 写操作。

## 1. 已实现（逐条对应任务要点）

| # | 要求 | 落地 |
| --- | --- | --- |
| 1 | **门禁分层** | `policy.communityGate` 顺序固定：`connections` 关 → 连接与私信**全部 403 `COMMUNITY_DISABLED`**（不是空数组）；`directMessages` 关 → 连接照常、发信 403 `COMMUNITY_DIRECT_MESSAGES_DISABLED`；`status=draft` → 403 `COMMUNITY_EVENT_NOT_OPEN`；调用者本场报名非 `approved` → 403 `COMMUNITY_PARTICIPANT_REQUIRED`；`archived` 读沿用、写 409。配置一律用 `resolveCommunityConfig`（`eventCommunity(scope)` + 逐字段保守归一），旧文档缺字段按全关。 |
| 2 | **双向同意，不做单向关注** | `requestConnection → respondConnection(accept/reject)`；无 `follow` 概念、无粉丝/关注列表。同一对账号本场最多一条 `pending` 或 `accepted`（部分唯一索引）；同账号本场 `pending` 上限 **20**；被拒绝后同一对（双向）冷却 **30 天**；连接事实全部带 `(organization_id, event_id)`，**不跨赛事**。发起人可 `cancelConnection`，取消不计入冷却。 |
| 3 | **私信只在已连接内** | `sendDirectMessage` 先取 `accepted` 连接，否则 403 `COMMUNITY_NOT_CONNECTED`；单条限长 **1000**（trim 后）；同账号同赛事 **10 分钟 20 条** 限频；`withdrawDirectMessage` 仅发送人本人、版本 CAS，撤回后正文置 `NULL`，双方都只看到"已撤回"。 |
| 4 | **屏蔽与举报必选** | `blockUser`：屏蔽后对方不能发起连接、不能发消息（**双方**都发不出），并自动拒绝双方之间 `pending` 的请求；`unblockUser` 只解除屏蔽，不撤销事实、不重置冷却。`reportUser`：记录举报事实 + 举报时刻最近消息快照；状态恒为 `open`，模块**不自行裁决、不自动隐藏、不改任何业务状态**；`organizerReports` 只读、默认 `communication_manage`。 |
| 5 | **不自动暴露联系方式** | 所有投影与组件都不含邮箱/电话字段（测试断言 `model.ts` 无 `email`/`phone`，界面无输入或展示）；固定原文 `noAutoContactNotice`："平台不会补全、代办或公开…是否交换由你们在消息里自行决定。" |
| 6 | **保留口径** | `directMessageRetention`（`keep`/`freeze`/`purge`）+ `directMessagePurgeDays`。`purge` 只清**正文**，保留"谁、何时、哪条连接、消息状态"；判定在**读取时**也生效；`maintainRetention` 落库（建议接既有后台维护任务，不新建定时器）。主办方关闭能力后不再产生新数据（发信 403），既有消息按口径只读/清理。 |
| 7 | **只走既有通知** | 只调用注入的 `EventNotificationPort.enqueue`；不建第二套通知系统、不写站内通知表。结果三态 `queued`/`unconfigured`/`not_sent`，界面必须如实显示"未发送"。未注入时只落站内事实（连接/消息行）并明确说明未发送。 |
| 8 | **数据边界** | 本模块不调用任何 AI，不导入任何 AI/队列模块；消息内容不进入任何模型训练（宪法 XII）。公开文案固定 `trainingBoundaryNotice`。 |

补充定案（设计 §4.2.4 用"可"）：**不自动隐藏被举报内容**——宪法 XIII 要求本模块不自行裁决；当事人可用"屏蔽"立即止住对方，
举报交平台/主办方按既有权限处理。已写入 `reportNotice` 原文与 `organizerReports` 说明。

## 2. 吸收闸门三问（宪法 XII / 规划 32 §4.0）

| 问题 | 答案 |
| --- | --- |
| **① 解决我们哪个真实问题** | 同场参赛者目前只能靠公开名片与站外渠道联系：站内没有任何"想认识"的双向同意入口，也没有一个主办方可控、可关闭、可配置保留口径的私信面。规划 34 §4 已把这块定为 P6；不是"竞品有所以要有"。（竞品里单向关注/跨赛事图谱被宪法 XIII 明确禁止，未纳入。） |
| **② 会碰到的既有能力** | 主办方赛事配置与发布版本（`HostedEventScope.community`）、既有报名审核事实（`EventParticipationPort.getRegistration`）、既有通知写入（`EventNotificationPort`）、既有 staff 权限（`HostedEventAccessPort.requireStaff`）、既有参赛名片/名录（P1 只读投影）、既有后台维护任务。 |
| **③ 如何避免重复入口 / 第二份事实 / 第二套写路径** | ① **只新增四件本模块独有的事实**：连接、消息、屏蔽、举报（各一张表，别处不再存）；② **不建名录**：复用人脸名片（P1），本模块只返回账号标识与能力，不复制个人资料；③ **不建通知系统**：只调既有 `EventNotificationPort`；④ **不建权限/关系第二事实**：报名判定走 `EventParticipationPort`，staff 走 `requireStaff`，连接是 `(organization_id,event_id,pair_key)` 的事件内事实，不是全局好友关系；⑤ 界面是既有页面的一个区块，不新增一级导航。 |

**可复核证据（"没有第二套通知 / 没有第二份关系事实"）**：

| 声明 | 证据 |
| --- | --- |
| 没有第二套通知系统 | 模块内对通知的调用点只有 `service.ts` 的 `notify()` → `notification.enqueue`；模块迁移里**没有**任何 outbox/queue/notice 表；`postgres.ts` 只读写 `evc_*` 四张表。 |
| 没有第二份关系事实 | 连接只有 `evc_connections` 一张表，且只有本模块 `insertConnection`/`updateConnection` 两个写点；没有 `followers`/`friends`/`contacts` 表；连接主键语义是 `(organization_id, event_id, pair_key)`，跨赛事读不到（`postgres.test` 有断言）。 |
| 没有第二份名录/名片 | 模块没有 profile/card/directory 表与读写方法；`overview` 只返回账号标识、请求、连接、屏蔽与保留口径。 |
| 没有改评分/名次/报名状态 | 模块没有任何写 `ej_*`/`event_registration_*` 的语句；举报不隐藏内容、不记录裁决；消息与举报数据不出现在任何评分或公布链路里。 |
| 没有 AI / 训练入口 | `service.test` 静态断言：`service.ts / policy.ts / postgres.ts / handlers.ts` 的跨模块导入只允许 `shared/*`，且不出现 `openai|anthropic|deepseek|dsh|ai-queue|training job`。 |

## 3. 新增文件

| 文件 | 内容 |
| --- | --- |
| `src/modules/event-community/model.ts` | 连接/消息/屏蔽/举报事实与两侧视图类型、通知投递结果 |
| `src/modules/event-community/policy.ts` | 纯函数：配置归一、门禁、校验、账号对/冷却/上限/限频、可见性、举报快照、安全文案常量、保留口径文案 |
| `src/modules/event-community/postgres.ts` | `evc_connections` / `evc_direct_messages` / `evc_blocks` / `evc_reports` 的读写（scope 过滤、版本 CAS、`ON CONFLICT DO NOTHING`） |
| `src/modules/event-community/service.ts` | `createEventCommunityService`（12 个方法，含 `maintainRetention`） |
| `src/modules/event-community/handlers.ts` | `createEventCommunityHandlers`（11 个入口） |
| `src/modules/event-community/CommunityPanels.tsx` + `event-community.module.css` | 选手侧社区面板/会话/举报，主办方举报队列 |
| `src/modules/event-community/ui.ts` / `index.ts` | 客户端再导出 / 公共导出 |
| `src/modules/event-community/README.md` | 模块说明 |
| `src/modules/event-community/migrations/001-event-community.sql` | **迁移建议**（4 表 + 索引 + 触发器） |
| `src/modules/event-community/{policy,service,postgres,handlers}.test.ts` | 33 项测试 |
| `docs/协作/交付/event-community.md` | 本文件 |

## 4. 数据表契约（迁移建议）

| 表 | 关键列 | 约束/触发器 |
| --- | --- | --- |
| `evc_connections` | `id, organization_id, event_id, pair_key, requester_user_id, addressee_user_id, status(pending/accepted/rejected/cancelled), revision, requested_at, responded_at, decided_by_user_id, idempotency_key, document` | 部分唯一 `(org,event,pair_key) WHERE status IN ('pending','accepted')`；唯一 `(org,event,requester,idempotency_key)`；FK `organizer_hosted_events(id, organization_id)`、`auth_users(id)`；触发器冻结范围/双方/方向/时间/请求键，要求 `revision+1`，只允许 `pending → accepted|rejected|cancelled`，并限制接受者必须是 addressee、取消者必须是 requester |
| `evc_direct_messages` | `id, organization_id, event_id, connection_id, sender_user_id, recipient_user_id, content, status(active/withdrawn/purged), revision, created_at, withdrawn_at, purged_at, idempotency_key, document` | 唯一 `(org,event,sender,idempotency_key)`；复合 FK 到 `evc_connections(org,event,id)`；CHECK 状态与时间/正文一致；触发器冻结范围/双方/时间/请求键，只允许 `active → withdrawn|purged` 且正文只能清空不能改写 |
| `evc_blocks` | `id, organization_id, event_id, blocker_user_id, blocked_user_id, created_at, document` | 唯一 `(org,event,blocker,blocked)`；触发器禁止 UPDATE（不可变） |
| `evc_reports` | `id, organization_id, event_id, reporter_user_id, reported_user_id, connection_id, reason, detail, snapshot(jsonb), status(open), created_at, idempotency_key, document` | 唯一 `(org,event,reporter,idempotency_key)`；`snapshot` 必须是数组；`status` 只能是 `open`；触发器禁止 UPDATE（不可变） |

所有表的 `document` 都与索引列逐字段一致（CHECK），防止同一事实两处漂移。

## 5. 端点契约（建议，待主会话注册）

| 工厂成员 | 方法 | `/api/v1` 之后路径 | 路由参数 / 正文 |
| --- | --- | --- | --- |
| `overview` | GET | `competitions/:eventId/community` | `["eventId"]` |
| `requestConnection` | POST | `competitions/:eventId/community/connections` | `{peerUserId, idempotencyKey}` |
| `respondConnection` | POST | `competitions/:eventId/community/connections/:connectionId/respond` | `{decision, expectedRevision}` |
| `cancelConnection` | POST | `competitions/:eventId/community/connections/:connectionId/cancel` | `{expectedRevision}` |
| `conversation` | GET | `competitions/:eventId/community/conversations/:peerUserId` | `peerUserId`（路由参数或 `?peerUserId=`） |
| `sendDirectMessage` | POST | `competitions/:eventId/community/messages` | `{peerUserId, content, idempotencyKey}` |
| `withdrawDirectMessage` | POST | `competitions/:eventId/community/messages/:messageId/withdraw` | `{expectedRevision}` |
| `blockUser` | POST | `competitions/:eventId/community/blocks` | `{peerUserId}` |
| `unblockUser` | POST | `competitions/:eventId/community/blocks/delete` | `{peerUserId}` |
| `reportUser` | POST | `competitions/:eventId/community/reports` | `{peerUserId, reason, detail?, connectionId?, idempotencyKey}` |
| `organizerReports` | GET | `organizer/events/:eventId/community/reports` | `["eventId"]` |

关键返回形状（节选）：

```
CommunityOverview = { eventId, capabilities{directory,connections,directMessages,retention,purgeDays,retentionNotice},
  incoming[{id,peerUserId,requestedAt,revision}], outgoing[...], connections[{id,peerUserId,connectedAt,revision,blocked}],
  blocks[{peerUserId,blockedAt}], limits, notices, limitations[] }
ConversationView = { eventId, peerUserId, connectionId, connectedAt, messagesEnabled, blocked, canSend, sendBlockedReason,
  retention, retentionNotice, messages[{id,senderUserId,recipientUserId,mine,createdAt,status,revision,content,withdrawn,purged,display}],
  limits.maxLength/rateMax/rateWindowSeconds/rateRemaining, notices }
OrganizerReportsView = { eventId, count, reports[{id,reporterUserId,reportedUserId,connectionId,reason,reasonLabel,detail,
  snapshot[{messageId,senderUserId,recipientUserId,createdAt,status,content}],status,createdAt}], notice, limitations[] }
```

## 6. 验证（真实执行）

```
node --experimental-strip-types --test src/modules/event-community/*.test.ts

tests 33
suites 0
pass 33
fail 0
cancelled 0
skipped 0
duration_ms 20410.0795

node node_modules/typescript/bin/tsc --noEmit --incremental false
（无任何输出）exit 0
```

`tsc` 原文为本模块 **0 诊断**、全仓本次运行 **exit 0 且无输出**（先前一次运行的
`src/server/organizer-integration.ts(346,118)` 报错为其他会话并发编辑中的瞬时状态，复跑已消失，不在本模块范围）。

测试覆盖（对应任务清单逐项）：

1. 默认全关 → `overview/requestConnection/conversation/sendDirectMessage/reportUser/withdrawDirectMessage` 全部 **403 `COMMUNITY_DISABLED`**（断言是 403，不是空数组）。
2. 非本场参赛者（无报名、`pending`）→ 403 `COMMUNITY_PARTICIPANT_REQUIRED`；`draft` 赛事 → 403 `COMMUNITY_EVENT_NOT_OPEN`。
3. 请求 → 接受 → 可互发信；收件人侧 `mine=false`；通知经既有端口发给对方。
4. 未接受不能发信（`COMMUNITY_NOT_CONNECTED`）；重复请求 / 已连接 / 非被邀请方处理都明确拒绝；取消后可重提。
5. 拒绝后同一对（双向）冷却期内不能再请求；过 30 天后可再发起。
6. 屏蔽后双方都不能发消息、也不能发起连接；待处理请求被自动拒绝；解除不会撤销事实（仍受冷却）。
7. 限长（1001 字符、空白）拒绝；同账号 10 分钟 20 条限频；对方不受影响。
8. 撤回后对方读不到内容（`content=null`、`withdrawn=true`）；非本人/版本不符被拒；数据库里正文为空、最小事实保留。
9. `purge` 口径：超过天数的正文即使后台维护未跑也不返回；`maintainRetention` 落库 `purged` 且保留 `sender`/`created_at`；`keep` 时 `skipped`。
10. 举报记录（`status=open`、快照含最近消息）；主办方按 `requireStaff` 只读；非 staff 403。
11. 主办方读不到任何私人消息：没有会话通道（`conversation`/`overview` 对非参赛 staff 403）；`organizerReports` 只含**被举报那条连接**的快照，未被举报连接的正文不出现，且投影无 `email`/`phone`。
12. 连接只在本场有效：同机构另一场比赛没有这条连接，可重新走双向同意。
13. 通知三种结果：未注入 / 端口拒绝（`not_sent`，站内事实仍在）/ 端口未配置，都如实说明。
14. 静态边界：模块不导入任何 AI/队列路径，`model.ts` 无邮箱电话字段。
15. SQL 边界：scope 隔离、部分唯一索引、触发器冻结与状态机、限频与清理查询、`document` 一致性。
16. HTTP 边界：真实 principal、匿名 401、写授权 403、方法/压缩/超长/坏 JSON、缺少路由标识。

## 7. 根接入 NEEDS_INTERFACE

以下全部**未接入**，需主会话组合。本模块不提供根组合代码。

### 7.1 迁移编号与执行

- 建议编号：**`073_event_community.sql`**（仓库现有最大为 `072_event_closure.sql`）。
- 内容：`src/modules/event-community/migrations/001-event-community.sql`（4 张表 + 索引 + 部分唯一索引 + 4 个触发器）。
- 依赖：`auth_users`、`organizer_hosted_events(id, organization_id)` 已存在。**未执行迁移**。

### 7.2 路由注册

在 `src/server/organizer-integration.ts` 新增一组 `COMMUNITY_ROUTES`（或等价分发），实例化
`createEventCommunityHandlers({ service, resolvePrincipal, authorizeMutation, requestIds })`，
按第 5 节 11 个入口注册；写请求经既有 `authorizeMutation`（Origin/CSRF），全部响应 no-store。
注意：`competitions/:eventId/community/conversations/:peerUserId` 与
`competitions/:eventId/community/connections/:connectionId/respond` 正则必须各自锚定 `$`，避免互相吞并。

### 7.3 通知 Port（本次最需要主会话决策的一项）

- 模块只接受共享 `EventNotificationPort`，并以
  `enqueue(sql, { eventId, announcementId: <连接/消息记录 id>, revision, recipientUserIds: [对方] })` 调用。
- **现有实现 `src/server/organizer-notifications.ts` 是"公告形状"的**：`enqueue` 会按
  `getNotificationAnnouncement(announcementId, revision)` 查既有公告，查不到即抛 `NOTICE_NOT_FOUND`。
  因此若直接把现有实例注入本模块，社区通知会落到 `not_sent`（模块会如实显示"未发送"，绝不伪装成功）。
- 需要主会话提供**同一个接口**的社区感知实现（**仍是既有唯一通知写入路径**，同一 outbox，不新建第二套系统）：
  把 `announcementId` 当作不透明来源引用，kind 记为社区（连接请求 / 已接受 / 新消息），收件人校验收缩为
  "本场 approved 参赛者且是本模块记录里的对方"。若暂不扩展，则**省略注入** `notification`，
  模块只落站内事实并明确说明通知未发送——这比伪造成功安全。

### 7.4 保留维护任务

在既有后台维护任务（如 `retention-maintenance`）中按赛事调用
`service.maintainRetention({ eventId, organizationId })`。**不要新建定时器**；`purge` 的读取时判定已在模块内兜底，
维护任务只是把清理落到持久事实。

### 7.5 主办方开关（`HostedEventScope.community`）

本模块只**读** `eventCommunity(scope)`。请主会话在既有"比赛设置 → 公开与社区"折叠区写入并随正式发布版本冻结：

| 键 | 本模块用途 | 默认 |
| --- | --- | --- |
| `connections` | 总闸：不开则连接与私信全部 403 | false |
| `directMessages` | 关闭时连接可用、发信 403，既有消息按保留口径只读 | false |
| `directMessageRetention` / `directMessagePurgeDays` | 保留口径与清理天数 | freeze / null |
| `participantDirectory` | 本模块只读上报（名录由 P1 提供），不重做 | false |

`commentMaxLength`、`peerFeedback`、`peerReview*`、`workShowcase` 属 P2/P5/P7，本模块不读取、不改动。
**裁决建议**：规划 34 §5.1 未列出"请求上限/冷却/单据限长/限频"四个可配置项，本模块先用常量
（20 / 30 天 / 1000 / 20 条每 10 分钟）。若主会话希望主办方可配置，需要先扩展共享 `EventCommunityConfig`
（本模块不越界改 `src/shared/`）。

### 7.6 界面落点

- `CommunityPanel`：挂在既有**参赛者侧比赛页**的"选手社区"区（不新增一级导航）；关闭时逐字显示服务端 403 说明。
- `CommunityConversation`：在同一区内就地展开（点击"打开会话"）。
- `OrganizerCommunityReportsPanel`：挂在既有**主办方本场概览/沟通与治理**区，只读；处理走既有平台/主办方流程。
- 三者从 `src/modules/event-community/ui.ts` 导出，只使用 `globals.css` 既有令牌。

### 7.7 所需环境变量

**无新增**。共用既有 `DATABASE_URL` / 本机单实例 PGlite 配置，不含密钥值。

## 8. 未做与边界

- **未接入根**：路由、迁移、配置写入、通知适配、界面挂载、维护任务调用全部待主会话（见第 7 节）。
- **未做真实外部验收**：未跑生产构建、未重启服务、未执行迁移、未做真实多连接 PostgreSQL 并发或手机走查；
  测试为隔离内存 PGlite 与受控 Port。
- **不做**（规划 34 §7 / 宪法 XIII）：单向关注/粉丝图谱、跨赛事社交图谱、访客参与、自动补全或公开邮箱电话、
  声称年龄核验或未成年人保护、第二套通知系统、第二份参赛名录/关系事实、AI 裁决举报、把消息内容用于模型训练。
- **注册与发布的冻结语义由主会话负责**：本模块只把"该能力在这场比赛是否可用"当作输入，不参与发布版本管理。
