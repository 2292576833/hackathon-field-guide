# event-community · 选手社区：连接 + 私信（规划 34 §4 D2/D3）

比赛内的**连接（双向同意）**与**私信**。它不是"社交网络"：没有单向关注、没有粉丝、没有跨赛事社交图谱、
没有访客参与、也不会自动补全或公开联系方式。默认**全关**，由主办方按赛事逐项配置、由本人决定是否参与。

依据：`docs/规划/34-主办方模块化与选手社区.md` §4 D2/D3 与 §4.2 安全底线、§7 明确不做；
宪法 v1.23.0 原则 XIII「选手社区（名录、连接、私信）」；`EventCommunityConfig` / `eventCommunity(scope)`
（`src/shared/organizer-contracts.ts`，主会话提供，本模块只读）。

## 1. 门禁分层（顺序固定，可断言）

| 条件 | 结果 |
| --- | --- |
| `eventCommunity(scope).connections !== true` | **全部 403 `COMMUNITY_DISABLED`**（不是空数组）；不返回任何请求/连接/消息 |
| 上一条通过、`directMessages !== true` | 连接接口照常；**发信 403 `COMMUNITY_DIRECT_MESSAGES_DISABLED`**；既有消息按保留口径只读 |
| 赛事 `status === "draft"` | 403 `COMMUNITY_EVENT_NOT_OPEN` |
| 调用者本场报名不是 `approved` | 403 `COMMUNITY_PARTICIPANT_REQUIRED`（访客与报名未通过都不行） |
| 赛事 `status === "archived"` | 读沿用；写 409 `COMMUNITY_EVENT_READ_ONLY` |

配置读取用 `resolveCommunityConfig`：整块缺失按 `DEFAULT_EVENT_COMMUNITY`（全关）；历史文档里逐字段缺失也按"关闭"
处理，只有显式 `true` 才算开启（`directMessageRetention` 非法值回退 `freeze`，清理天数非正整数视为未设置）。

## 2. 唯一四张表

| 表 | 唯一负责的事实 |
| --- | --- |
| `evc_connections` | 一场比赛里一对账号之间的连接事实：`pending → accepted / rejected / cancelled` |
| `evc_direct_messages` | 已接受连接内的消息；撤回或到期清理后 `content = NULL`，只留最小事实 |
| `evc_blocks` | 本人对本场某人的屏蔽（**只在本场**） |
| `evc_reports` | 举报事实 + 举报时刻的最近消息快照（状态恒为 `open`，模块**不记录裁决**） |

四条不可变边界由触发器保证：范围/双方/方向/时间/重试标识不可改写；连接只能从 `pending` 前进；
消息只能从 `active` 清空正文到 `withdrawn`/`purged`；屏蔽与举报整行不可改写。
唯一索引保证："每对账号本场最多一条 `pending`/`accepted`"、"同一发送人同重试标识唯一"。
无写入使用 `INSERT ... ON CONFLICT DO NOTHING`：唯一冲突**不抛异常、不让事务进入 aborted 状态**。

本模块**不**建第二份参赛名录/名片（名录是 P1 的既有只读投影，复用既有参赛名片），也不碰其他模块的表。

## 3. 服务

`createEventCommunityService(deps: EventCommunityDependencies)`

| 依赖 | 必选 | 说明 |
| --- | --- | --- |
| `database` / `clock` / `ids` | 是 | 真实 `DatabasePort`（同一事务）；服务端时间；唯一 ID |
| `events` | 是 | `HostedEventAccessPort`：读赛事与 `community` 配置；`requireStaff` 判举报处理权限 |
| `participation` | 是 | `EventParticipationPort`：本场报名是否 `approved` |
| `notification` | 否 | **唯一**通知写路径 `EventNotificationPort`；不注入只落站内事实并说明未发送 |
| `staffCapability` | 否 | 举报读权限，默认 `communication_manage` |

| 方法 | 输入 | 输出 | 权限 / 行为 |
| --- | --- | --- | --- |
| `overview(principal, eventId)` | — | `CommunityOverview` | 本场 approved 参赛者；只含本人相关的请求/连接/屏蔽 |
| `requestConnection(p, eventId, {peerUserId, idempotencyKey})` | 对方账号 | `{connection, notification}` | 双方都必须 approved；不能自请求；屏蔽/重复/冷却/上限都明确拒绝 |
| `respondConnection(p, eventId, connectionId, {decision, expectedRevision})` | 接受/拒绝 | `{connection, notification}` | 只有被邀请方；接受才通知发起人；版本 CAS |
| `cancelConnection(p, eventId, connectionId, {expectedRevision})` | — | `{connection, notification}` | 只有发起人；不计入冷却 |
| `conversation(p, eventId, peerUserId)` | — | `ConversationView` | 必须已连接；私信关闭时按保留口径只读 |
| `sendDirectMessage(p, eventId, {peerUserId, content, idempotencyKey})` | 正文 | `{message, notification, limits}` | 必须已连接、未屏蔽；限长 1000；同账号同赛事 10 分钟 20 条 |
| `withdrawDirectMessage(p, eventId, messageId, {expectedRevision})` | — | `DirectMessageView` | 只有发送人本人；正文清空，双方都只看得到"已撤回" |
| `blockUser(p, eventId, peerUserId)` | — | `{block, rejectedRequests}` | 屏蔽；同时自动拒绝双方之间 `pending` 的请求 |
| `unblockUser(p, eventId, peerUserId)` | — | `{removed}` | 解除自己的屏蔽；不撤销任何事实、不重置冷却 |
| `reportUser(p, eventId, {peerUserId, reason, detail?, connectionId?, idempotencyKey})` | — | `{report, notice}` | 只记录事实与最近快照；不自动隐藏、不裁决 |
| `organizerReports(p, eventId)` | — | `OrganizerReportsView` | 默认 `communication_manage`；**只含被举报快照**，没有阅读任意私信的通道 |
| `maintainRetention({eventId, organizationId, limit?})` | — | `RetentionMaintenanceResult` | 系统维护（无 principal）；仅 `purge` 有效天数时清正文，建议由既有后台维护任务调用 |

模块常量（`EventCommunityConfig` 里没有这些键，已登记 NEEDS_INTERFACE）：
`CONNECTION_PENDING_LIMIT = 20`、`CONNECTION_REJECT_COOLDOWN_DAYS = 30`、
`DIRECT_MESSAGE_MAX_LENGTH = 1000`、`DIRECT_MESSAGE_RATE_LIMIT = 20 / 10 分钟`、
`REPORT_SNAPSHOT_LIMIT = 10`。

错误码（全部 `DomainError`）：`COMMUNITY_DISABLED`(403)、`COMMUNITY_DIRECT_MESSAGES_DISABLED`(403)、
`COMMUNITY_EVENT_NOT_OPEN`(403)、`COMMUNITY_PARTICIPANT_REQUIRED`(403)、`COMMUNITY_TARGET_NOT_PARTICIPANT`(403)、
`COMMUNITY_EVENT_NOT_FOUND`(404)、`COMMUNITY_EVENT_READ_ONLY`(409)、`COMMUNITY_EVENT_SCOPE_MISMATCH`(403)、
`COMMUNITY_BLOCKED`(403)、`COMMUNITY_NOT_CONNECTED`(403)、`COMMUNITY_ALREADY_CONNECTED`(409)、
`COMMUNITY_REQUEST_EXISTS`(409)、`COMMUNITY_REQUEST_COOLDOWN`(409)、`COMMUNITY_REQUEST_LIMIT`(429)、
`COMMUNITY_REQUEST_NOT_FOUND`(404)、`COMMUNITY_REQUEST_NOT_PENDING`(409)、`COMMUNITY_NOT_ADDRESSEE`(403)、
`COMMUNITY_NOT_REQUESTER`(403)、`COMMUNITY_VERSION_CONFLICT`(409)、`COMMUNITY_STATE_INVALID`(409)、
`COMMUNITY_MESSAGE_NOT_FOUND`(404)、`COMMUNITY_ACCESS_DENIED`(403)、`COMMUNITY_RATE_LIMITED`(429)、
`COMMUNITY_IDEMPOTENCY_KEY_REUSED`(409)、`COMMUNITY_INVALID_INPUT`(422)。

## 4. HTTP 工厂与建议路由

`createEventCommunityHandlers({ service, resolvePrincipal, authorizeMutation, requestIds })`；
统一 `(request, params:{eventId, connectionId?, messageId?, peerUserId?}) → Response`，
成功 `{data, requestId}`，全部 `Cache-Control: private, no-store`，JSON 最多 64KB 且不接受压缩。

| 工厂成员 | 方法 | `/api/v1` 之后路径 | JSON / 路由参数 |
| --- | --- | --- | --- |
| `overview` | GET | `competitions/:eventId/community` | `["eventId"]` |
| `requestConnection` | POST | `competitions/:eventId/community/connections` | `{peerUserId, idempotencyKey}` |
| `respondConnection` | POST | `competitions/:eventId/community/connections/:connectionId/respond` | `{decision, expectedRevision}` |
| `cancelConnection` | POST | `competitions/:eventId/community/connections/:connectionId/cancel` | `{expectedRevision}` |
| `conversation` | GET | `competitions/:eventId/community/conversations/:peerUserId` | 路由参数 `peerUserId`（也接受 `?peerUserId=`） |
| `sendDirectMessage` | POST | `competitions/:eventId/community/messages` | `{peerUserId, content, idempotencyKey}` |
| `withdrawDirectMessage` | POST | `competitions/:eventId/community/messages/:messageId/withdraw` | `{expectedRevision}` |
| `blockUser` | POST | `competitions/:eventId/community/blocks` | `{peerUserId}` |
| `unblockUser` | POST | `competitions/:eventId/community/blocks/delete` | `{peerUserId}` |
| `reportUser` | POST | `competitions/:eventId/community/reports` | `{peerUserId, reason, detail?, connectionId?, idempotencyKey}` |
| `organizerReports` | GET | `organizer/events/:eventId/community/reports` | `["eventId"]` |

以上路由**尚未接入** `src/server/organizer-integration.ts`；主会话按交付文档 NEEDS_INTERFACE 注册。

## 5. 通知与保留

- 通知只调用既有 `EventNotificationPort.enqueue(sql, {eventId, announcementId: <本模块记录 id>, revision, recipientUserIds: [对方]})`。
  不新建第二套通知系统，也不在模块内写站内通知表。返回值 `NoticeDelivery.state`：
  `queued` / `unconfigured`（端口未配置或未注入）/ `not_sent`（端口拒绝或重试沿用原记录）；界面必须如实显示。
- 保留口径按 `directMessageRetention` + `directMessagePurgeDays`：
  `keep`（保留可读）、`freeze`（冻结只读，默认）、`purge`（到期清理，只清正文，保留"谁、何时、哪条连接、消息状态"）。
  `purge` 的判定在**读取时**也生效（后台维护没跑也不会返回过期正文）；维护由 `maintainRetention` 落库，
  建议由既有后台维护任务调用，不新建定时器。
- 举报快照在 `purge` 口径下**不复制任何正文**；撤回/已清理的消息只复制最小事实。

## 6. 界面组件（`ui.ts`）

- `CommunityPanel({eventId, eventTitle})`：选手侧总览 + 请求/连接/屏蔽 + 内嵌会话；关闭时逐字显示服务端 403 说明。
- `CommunityConversation({eventId, peerUserId, onClose?, onChanged?})`：消息、发送、撤回、屏蔽、举报。
- `OrganizerCommunityReportsPanel({eventId, eventTitle})`：主办方举报队列（只读，只含被举报快照）。

只使用 `globals.css` 既有令牌；无关注/粉丝入口，无邮箱/电话字段，无进度条或排名徽章；手机上按钮独占一行。

## 7. SQL 迁移建议

`migrations/001-event-community.sql`：4 张表 + 索引 + 部分唯一索引 + 4 个不可变触发器。
**不是已部署迁移**：由主会话分配递增编号（仓库最新为 `072_event_closure.sql`，建议 `073`）写入根 `migrations/` 后执行。

## 8. 测试

```powershell
node --experimental-strip-types --test src/modules/event-community/*.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

33 项通过（policy 8 / service 16 / postgres 5 / handlers 4）：

- `policy.test.ts`：配置缺字段按全关、门禁分层、输入校验、账号对与拒绝冷却、待处理与限频、撤回与清理可见性、
  举报快照、安全口径原文。
- `service.test.ts`：默认全关 403、私信关闭只拒发信、赛事未开启/非参赛者 403、请求→接受→可发信、
  未接受不能发信、拒绝冷却、待处理上限、屏蔽与解除、限长限频、撤回、purge 口径、举报与主办方只读、
  主办方读不到私人消息、不跨赛事、通知三种结果、无 AI/无邮箱电话字段。
- `postgres.test.ts`：scope 读、部分唯一索引、触发器冻结与状态机、限频/清理查询、document 一致性。
- `handlers.test.ts`：真实 principal、匿名 401、写授权 403、方法/压缩/超长/坏 JSON、路由标识。

## 9. 明确不做（规划 34 §7 / 宪法 XIII「明确不做」）

单向关注或粉丝图谱、跨赛事社交图谱、对访客或非本场参赛者开放、自动补全或公开邮箱/电话、
声称年龄核验或未成年人保护、把私信做成第二套通知系统、新建第二份参赛名录或关系事实、
用 AI 裁决举报或自动隐藏内容、把消息内容用于任何模型训练。本模块不调用任何 AI。
