# 赛事沟通与现场服务（O03）

本模块提供持久服务与可接入客户端界面；根路由、实际迁移与上线由主会话负责。所有表以 `ec_` 开头，只通过共享 Port 读取当前赛事权限和报名事实，不读取其他模块表。没有生产内存降级、假 AI 回答或默认邮件发送。

## 构造与边界

- `createEventCommunicationService({ database, eventAccess, participation, clock, ids, notification?, announcementAudience? })`：通知、站内版本已读、公开问题/私人求助、工作人员答复、作者同意的公开 FAQ。
- `createEventScheduleService({ database, eventAccess, participation, clock, ids })`：行程草稿、CSV 预览/确认、不可变发布、自愿破冰和人工分组。
- `createEventLogisticsService({ database, eventAccess, participation, clock, ids, tokens? })`：人工住宿、持久导入预览、分配更正、餐券类型/发放/撤销/核销。
- `createEventCommunicationHttpHandlers({ communication, schedule, logistics, resolvePrincipal, authorizeMutation, requestId? })`：`handle(Request, EventCommunicationHttpRoute): Promise<Response>`。
- `eventCommunicationHttpRoute(decodedSegments)`：只接受 `/api/v1` 之后的完整固定路径。方法、输入和输出详见交付文档。

`database` 为真实 `DatabasePort`；`eventAccess`/`participation` 为共享 `HostedEventAccessPort`/`EventParticipationPort`。所有非公开操作都使用根构造的 `OrganizerPrincipal`，其 `guard(sql)` 在同一事务开始及结束复核当前账号与本次请求会话。写操作通过 `getEvent(sql,eventId,{forUpdate:true})` 锁赛事，并反复复核当前授权/报名/版本。根适配必须兑现锁语义，不能仅返回一个缓存快照。

通知 staff 使用 `communication_manage`；行程 staff 使用 `schedule_manage`；住宿、券和破冰 staff 使用 `logistics_manage`。普通选手不能靠机构身份、队长身份或另一个赛事的身份放大权限。

`notification` 仅调用共享 `EventNotificationPort.enqueue`。还需根提供 `announcementAudience.listRecipientUserIds(sql,eventId)`；二者未同时注入时明确记录 `unconfigured`，只站内发布。`queued` 仅表示入队，不表示邮件实际送达。根应提供同事务持久 outbox，不能在 `enqueue` 内直接发邮件。

`tokens.generate()` 默认使用 Node `randomBytes(32)` 的 256 位随机不透明值；根可注入同等密码安全生成器。仅保存 SHA-256 hash。发券成功首次返回 token，幂等重试返回 `token:null`；此时可用当前赛事的券 ID 进行有授权的人工核销。任何列表、版本、幂等回执都不含 token，页面不调用第三方二维码服务。发放与核销幂等键绑定当前操作人、赛事和输入；UI 在失败重试时保留键。

## 数据与界面

SQL 建议按顺序为 `migrations/001_communication.sql`、`002_logistics.sql`、`003_schedule.sql`，均引用现有 `auth_users(id)`。不要直接作为根已应用迁移覆盖写入。公告/求助版本、行程发布、分组版本保留历史；草稿和关闭模块不改写历史或自动清理未解决求助。

业务公共入口为 `index.ts`，客户端单独从 `ui.ts` 导入：`EventCommunicationPanel`、`CommunicationManager`、`EventSchedulePanel`、`ScheduleManager`、`OwnEventServices`、`LogisticsManager`。各组件使用现有 `client-api`，固定 `/api/v1` 前缀。显示赛事/主办方/身份、时间与范围；错误保留表单输入；关闭的现场模块隐藏新操作，并提供已有安排的折叠历史阅读。根仍需按当前角色组合入口及执行实际手机验收。

住宿 CSV 表头：`userId,location,room,checkIn,checkOut,note`。行程 CSV 表头：`title,startsAt,endsAt,location,audience,userIds`；指定人员 ID 用分号分隔，时间必须带时区。预览由服务器持久保存并绑定操作者/赛事/版本，30 分钟有效，确认时重新核对报名/权限/版本；确认导入不会自动发布行程。

原作者新建公开问题时主动选择公开范围。私人求助的 FAQ 由工作人员整理**独立的公开文字预览**，原作者必须确认确切预览版本和当前 ticket revision；只删姓名不等于匿名安全。原 ticket 始终保持私人，公开 API 不投影所有者/原 ticket ID/私人回复/预览。私人 ticket 本人读写还需当前 approved 报名；撤回后普通公开列表只返回公开问题。

## 验证

```powershell
node --experimental-strip-types --test src/modules/event-communication/*.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

测试使用全新内存 PGlite 与受控跨模块 Port，未打开 `.env.local` 或实际数据库。PGlite 排队事务不能代替线上多连接 PostgreSQL 并发、真实邮件投递、手机浏览器或主办方现场验收。具体结果和根组合待办见 `docs/协作/交付/event-communication.md`。
