# O03 沟通与现场服务交付

日期：2026-10-11。授权只覆盖新 `src/modules/event-communication/` 和本交付文档。未修改 app/server/shared、根 components、实际 migrations、配置、依赖、公共规划；未构建/重启/打开生产 PGlite/发送邮件或发布外部服务。

---

# P08 追加交付 · 选手侧资源与下一步汇总（2026-10-16）

> 依据 [规划 33](../规划/33-主办方可用性与赛后闭环.md) 第 5 节第 5 期与 [P08 分项](../规划/主办方/P08-选手侧资源汇总.md)，界面落点见 [主办方工作台设计](../../设计/主办方工作台设计.md) §6.5。
> 本轮授权只覆盖 `src/modules/event-communication/` 与本交付文档；**未改** `src/app`、`src/server`、`src/components`、`src/shared`、`migrations`。

## P08 已完成

| # | 交付物 | 说明 |
| --- | --- | --- |
| 1 | `participant-summary.ts`（新增） | **纯函数**：无 IO、无 `Date.now()`、无随机。`buildParticipantSummary` 把已读到的既有事实组装成区块；`buildNextStep` 给**唯一一条**下一步；`deadlineRows` 只输出有值的期限 |
| 2 | `service.ts` → `ownFacts()`、`ownRegistrationAndTeam()`（新增只读方法） | 复用既有 `scope(...,"member",...)` 判定本人是本场已通过报名的参赛者；导出已发布赛事事实的最小上下文；读取本模块自己拥有的公告/已读/求助 |
| 3 | `handlers.ts` → `GET competitions/:eventId/my-summary` | 新增路由种类 `mySummary`；**仅 GET**，方法不符 405 + `Allow: GET` |
| 4 | `handlers.ts` → `participantSummary()`（模块内辅助函数） | 组装三个服务：`communication.ownFacts` + `schedule.getSchedule` + `logistics.ownServices`，再交给纯函数 |
| 5 | `index.ts` | 导出纯函数与全部汇总类型 |
| 6 | `participant-summary.test.ts`（新增） | 12 项，覆盖 P08 第 6 节全部验收 |

## P08 设计要点（为什么这样做）

- **缺口在汇总呈现，不在数据**：行程与后勤分别复用 `schedule.getSchedule` 与 `logistics.ownServices`——它们是这两项事实各自的**唯一权威读路径**，没有另写第二份查询，因此不会出现第二份行程或后勤事实。
- **零写入**：整条链路只有 SELECT 与身份校验。汇总不产生发放、领取、核销、已读或完成状态。
- **`unread` 与 `absent` 严格区分**：`registration`/`team` 的 `undefined` 表示"根尚未接线该 Port（还没读到）"，`null` 表示"确实没有这条记录"。未读到时 `nextStep.kind = "unread"`，**不给建议**（宪法 X）。
- **只呈现已发布公告**：草稿与已撤回即使留在表里也不进入选手汇总（有测试断言）。
- **不承诺任何未确认资源**：算力 Token、云资源、支付、票券售卖、酒店预订、模型生成内容**均未出现**。

## P08 已验证

命令与实测结果（本会话真实执行）：

```powershell
node --experimental-strip-types --test src/modules/event-communication/participant-summary.test.ts
```

**12 项通过、0 失败**（约 6.1s）：

| 覆盖点 | 测试 |
| --- | --- |
| 期限只来自已发布规则版本；缺失不补、不用别的日期顶替 | 期限只输出有值的项 |
| 每项可回溯 | 每一项都能指回既有路由（断言 `/competitions/a/{register,teams,help,schedule,services}`） |
| `unread` vs `absent` | 报名与队伍区分「还没读到」和「确实没有」，未读到时不给建议 |
| 下一步唯一 | 按报名状态给唯一一条；未读通知优先于其他准备动作 |
| 无值不补 | 没有行程/住宿/餐券/求助时输出空态 |
| 公告过滤 | 纯函数只含已发布公告；未读计数不含草稿 |
| **队长不放大** | 队长看不到其他成员的住宿与餐券（断言不出现 Bob 的房号/地点/备注/餐券） |
| **选手互相不可见** | 选手 A 看不到选手 B 的求助（双向断言）；求助投影不含账号字段 |
| 未登录 / 非参与者 | 401（`guest`）／403（`carol` 未报名） |
| 跨赛事隔离 | alice 在 b 场得到空态，不拿到 a 场的公告/住宿/餐券 |
| 仅 GET | POST → 405 且 `Allow: GET`；`Cache-Control: private, no-store` |
| **读取前后事实一致** | 连续读 3 次汇总：公告已读数、住宿分配、餐券核销余量、求助状态与 revision **逐字段不变**（deepEqual） |
| 草稿/已撤回不出现 | 发布后再撤回，汇总从 1 条变 0 条 |
| 未接线可用 | 不注入 `ownFacts` 时 `ownFacts()` 仍可用，`ownRegistrationAndTeam()` 返回 `undefined` 而非 `null` |

模块全量回归：`node --experimental-strip-types --test src/modules/event-communication/*.test.ts` → **50 项通过、0 失败**（含既有 38 项，未被本轮改动破坏）。

类型检查：`node node_modules/typescript/bin/tsc --noEmit --incremental false` → **`src/modules/event-communication/` 0 错误**。全仓另有 6 处错误，**全部位于 `src/modules/organizer/duplicate-service.test.ts`（P05 会话正在编辑）**，按纪律只报告、不越界修改。

## P08 未接入 / NEEDS_INTERFACE（主会话要接的线）

1. **本人报名与队伍 Port（必须接线，否则汇总退化为 `unread`）**

   本模块**不查 `event-registration` 的表**。约定如下（定义在 `src/modules/event-communication/model.ts`）：

   ```ts
   // CommunicationDependencies 新增可选字段；不注入时汇总仍可用，但标记 unread。
   ownFacts?: EventOwnFactsPort

   interface EventOwnFactsPort {
     registration(sql: SqlExecutor, eventId: string, userId: string):
       Promise<{ status: "draft"|"pending"|"approved"|"rejected"|"withdrawn"; reviewNote: string } | null>;
     team(sql: SqlExecutor, eventId: string, userId: string):
       Promise<{ id: string; name: string; track: string; status: "forming"|"locked"|"withdrawn";
                 captainUserId: string; memberCount: number } | null>;
   }
   ```

   - 建议实现方式：根在 `src/server/organizer-integration.ts` 注入一个适配器，内部调用 event-registration 的既有服务方法（`listTeams` 的 `ownTeam`/`ownRequests` 分支已返回**本人队伍**；报名用 `getRegistration`）。
   - **必须落在同一个 `SqlExecutor`**（本模块通过 `deps.database.transaction` 传入），不得另开事务或连接。
   - **队长身份由 `captainUserId` 判定**，不由调用方声称；即使本人是队长，Port 也只能返回**本人那一条**住宿/餐券——本模块的住宿与餐券一律读取 `logistics.ownServices`（本人维度），不存在"按队伍批量读取"的路径。
   - `reviewNote` 当前未进入汇总投影（只呈现状态）。若要展示未通过原因，可后续扩展；**本模块不会编造原因**。

   建议的 Port 定义最终应上移到 `src/shared/organizer-contracts.ts`（**本轮不改该文件**，因为它属主会话独占；如需上移由主会话执行）。

2. **路由注册**：`eventCommunicationHttpRoute` 已识别 `competitions/:eventId/my-summary`（`fixed` 映射内），但根需确认 `/api/v1` 组合器已把该 kind 的 GET 放行且**不列入公开只读集合**（本模块已确保 `mySummary` 不在 `publicRead` 中，未登录返回 401）。

3. **界面挂载**：按设计 §6.5 挂在**既有** `/competitions/[eventId]` 页面内的只读汇总区。`MUST NOT` 新增第二个"我的赛事"入口，`MUST NOT` 放进 `participation` 模块。

4. **`my-checklists`（提交与自检）**：P08 第 3 节列出该区块，但它属于 `event-judging` 的既有接口 `GET competitions/:eventId/my-checklists?teamId=`。本模块**不重复实现**，由根在页面上并列展示即可。

5. **无新增迁移、无新增环境变量**：复用既有 `ec_*` 三张表的读取，不新建表。

## P08 明确不做（沿用 P08 第 5 节）

算力 Token / 云资源承诺（观猹官方接口未确认）、站内报名支付与票券售卖、酒店供应商预订、模型生成内容、第二份后勤记录、地理事实、服务端筛选选项。

## P08 交付状态

**模块实现完成、隔离测试通过（12/12，模块全量 50/50）、本模块类型检查通过；根路由注册、Port 接线、界面挂载与端到端验收未由本会话执行。**

---

# 以下为 2026-10-11 首轮交付记录（历史，保留）

## 已实现

- 官方公告草稿/发布/撤回、不可变版本、确切发布版本的站内已读；新版本未读，保存草稿保留上一个公开版本，已读不等于邮件投递。公开历史只显示曾发布内容，工作人员历史包含草稿和撤回。
- 公开问题和私人求助、原作者补充、工作人员答复、open/in_progress/answered/closed、CAS revision、不可变修改历史。管理列表按待回复优先；同一组织的不同赛事仍隔离。
- 私人求助由工作人员提出单独 FAQ 预览，只有原作者明确同意当前预览及 ticket 版本才可公开。公开独立投影不携带作者、原 ticket ID、私人正文/回复；新预览必须再次同意，不自动替换公开版本。
- 行程结构化输入、时区/时间/适用范围校验、持久 CSV 预览、确认保存草稿、明确发布、不可变发布版本。访客只读 all；已通过报名者再读 participants 和指定本人条目；不公开指定人员名单。
- 可选破冰、自愿 join/decline、人工分组、拒绝时退出当前组并保存分组历史；不得把参与/拒绝写成参赛资格或自动配对成功。选手端与工作人员端分别投影。
- 住宿人工分配、更正版本、持久 CSV 预览/确认、本人和专责人员隔离；预览与确认不同事实，过期/错误/版本冲突都禁止覆盖。
- 餐券类型、一人可有多种券、首次发券不透明随机 token、SHA-256 hash 持久、本人列表、过期/撤销、人工或 token 核销、原子最后次扣减、操作员回执及幂等绑定。token 不在列表/日志/版本保存；发放重试不再返回 token，可用券 ID 人工核销。
- 通俗 React 客户端组件与手机 CSS；当前赛事/主办方/身份、待回复/未读、关键期限与更新影响可见；高级输入折叠、失败保留输入、冲突可重新读取并核对服务器版本。关闭现场功能仍提供只读历史入口；当前赛事切换后重新初始化本地表单，未提交输入/未交付餐券凭证提示且监听beforeunload。没有虚构 AI 或供应商能力。

## 构造参数及公共出口

从 `src/modules/event-communication/index.ts` 导入业务；`ui.ts` 只导出客户端组件。

| 工厂 | 必填参数 | 可选参数 | 返回 |
| --- | --- | --- | --- |
| createEventCommunicationService | database: DatabasePort, eventAccess: HostedEventAccessPort, participation: EventParticipationPort, clock: Clock, ids: IdGenerator | notification: EventNotificationPort；announcementAudience.listRecipientUserIds(sql,eventId): Promise<readonly string[]> | EventCommunicationService |
| createEventScheduleService | database, eventAccess, participation, clock, ids 同上 | 无 | EventScheduleService |
| createEventLogisticsService | database, eventAccess, participation, clock, ids 同上 | tokens: {generate():string}；默认密码安全 randomBytes(32) | EventLogisticsService |
| createEventCommunicationHttpHandlers | communication, schedule, logistics 为上述服务；resolvePrincipal(Request): Promise<OrganizerPrincipal\|null>；authorizeMutation(Request): Promise<void> | requestId():string | {handle(Request,EventCommunicationHttpRoute):Promise<Response>} |
| eventCommunicationHttpRoute | readonly string[]，已解码的 /api/v1 后路径段 | 无 | EventCommunicationHttpRoute\|null |

各服务的第一个参数固定为根生成的 `OrganizerPrincipal`（公开读取允许 null），第二个为 eventId。principal 必须来自本次真实会话；guard(sql) 与 Port 在同一 DatabasePort.transaction 内复核。组织身份只从 getEvent 获得，不接收 client organizationId。写锁依赖根 `getEvent(...,{forUpdate:true})` 的真实锁实现。

## 方法/API 精确登记

以下路径均加 `/api/v1`。P=`/competitions/:eventId`，M=`/organizer/events/:eventId`。响应为 `{data,requestId}`；错误为共享 ErrorEnvelope。所有响应 `Cache-Control: private, no-store`，`Vary: Cookie`；写操作先由根检查 Origin/CSRF；JSON 流限制 128 KiB。表内 principal/eventId 为公共前两参数，不再重复列；其后 id 来自固定路径，不能被 JSON 覆盖。

### 公告及问答

| 方法/路径 | 服务方法与后续输入 | data 类型 | 权限 |
| --- | --- | --- | --- |
| GET P/announcements | listAnnouncements(principal\|null,eventId) | AnnouncementView[] | 已公开赛事，只返回 published pointer 对应正文；本人 read 可选 |
| GET M/announcements | listManagedAnnouncements | Announcement[] | communication_manage |
| POST M/announcements | publishAnnouncement(input) | Announcement | communication_manage |
| POST M/announcements/draft | saveAnnouncementDraft(input) | Announcement | communication_manage |
| POST M/announcements/:id/withdraw | withdrawAnnouncement(id,{expectedRevision}) | Announcement | communication_manage |
| POST P/announcements/:id/read | markAnnouncementRead(id,{revision}) | {announcementId,revision,read:true} | 当前账号/会话；只记录当前发布版本 |
| GET P/announcements/:id/versions | announcementHistory(id) | AnnouncementView[] | 当前公告仍公开；仅发布历史 |
| GET M/announcements/:id/versions | announcementHistory(id,true) | AnnouncementView[] | communication_manage；含历史草稿 |
| GET P/help-tickets | listTickets | TicketView[] | 公开问题＋当前approved本人的问题；无身份/报名撤回则只公开 |
| POST P/help-tickets | createTicket({visibility:'public'\|'private',question}) | TicketView | 本赛事 approved 报名 |
| GET M/help-tickets | listManagedTickets | TicketView[] | communication_manage；待回复优先 |
| GET P/help-tickets/:id | getTicket(id) | TicketView | 公开问题或当前approved本人；猜私人 ID /撤回报名后读私人记录返回404 |
| GET M/help-tickets/:id | getTicket(id,true) | TicketView | communication_manage |
| GET P/help-tickets/:id/replies | getTicket(id).replies | TicketReply[] | 同 ticket 读权限 |
| GET M/help-tickets/:id/replies | getTicket(id,true).replies | TicketReply[] | communication_manage |
| POST P/help-tickets/:id/replies | addReply(id,{body,expectedRevision}) | TicketView | 本人＋approved；关闭后不可追加 |
| POST M/help-tickets/:id/replies | addReply(id,{body,expectedRevision},true) | TicketView | communication_manage；自动answered |
| PATCH M/help-tickets/:id/status | changeTicketStatus(id,{status,expectedRevision}) | TicketView | communication_manage；未答复不能直接answered |
| POST M/help-tickets/:id/faq-preview | proposeFaqPreview(id,{title,question,answer,expectedRevision}) | TicketView | communication_manage；只提出预览 |
| POST P/help-tickets/:id/publish-consent | consentFaqPublication(id,{previewRevision,expectedRevision,consent:true}) | TicketView | 原作者本人＋approved；staff不能代同意 |
| GET P/faq | listPublicFaqs | PublicFaq[] | 已公开赛事；单独安全投影 |

公告 input=`{announcementId?:string,expectedRevision?:number,title,body,important:boolean,impact:string,dueAt?:ISO\|null}`；新建 expectedRevision=0，编辑必须传当前 revision；发布需要影响说明。dueAt 含时区。TicketReply=`{id,body,role:'author'\|'staff',createdAt}`，不暴露操作者账号。FaqPreview=`{revision,title,question,answer,proposedAt,consentedAt}`，只有本人/工作人员能读；PublicFaq=`{id,eventId,revision,title,question,answer,publishedAt}`。

### 行程和破冰

| 方法/路径 | 服务方法与后续输入 | data 类型 | 权限 |
| --- | --- | --- | --- |
| GET P/schedule | getSchedule | PublishedSchedule | 访客all；approved选手再按范围过滤 |
| GET M/schedule/draft | getScheduleDraft | ScheduleDraft | schedule_manage |
| PUT M/schedule/draft | saveScheduleDraft({expectedRevision,timezone,items,impact}) | ScheduleDraft | schedule_manage |
| POST M/schedule/import/preview | previewScheduleImport({csv,expectedRevision,timezone?,impact?}) | ScheduleImportPreview | schedule_manage；持久预览 |
| POST M/schedule/import/confirm | confirmScheduleImport({previewId,expectedRevision}) | ScheduleDraft | 同一预览操作者＋schedule_manage |
| POST M/schedule/publish | publishSchedule({expectedRevision}) | PublishedSchedule | schedule_manage；发布版本不可修改 |
| GET P/icebreakers | listIcebreakers | IcebreakerList | 当前 approved 选手；只本人选择/组别 |
| POST P/icebreakers/:id/respond | respondIcebreaker({activityId:路径id,choice:'join'\|'decline'}) | {activityId,choice,revision} | 本人 approved，自愿参与 |
| GET M/icebreakers | listManagedIcebreakers | IcebreakerList | logistics_manage；真实responses/groups |
| POST M/icebreakers | createIcebreaker({title,description,startsAt,location}) | IcebreakerActivity | logistics_manage |
| POST M/icebreakers/:id/groups | assignIcebreakerGroup({activityId:路径id,title,userIds,expectedRevision}) | {activityId,revision,group} | logistics_manage；每人仍approved且自愿join |

ScheduleItem input=`{id?:string,title,startsAt,endsAt,location,audience:'all'\|'participants'\|'users',userIds:string[]}`；开始/结束含时区且结束更晚；指定名单逐个核对真实报名。ScheduleDraft=`{eventId,organizationId,revision,publishedRevision,timezone,items,impact,updatedAt}`。PublishedSchedule=`{eventId,enabled,revision,timezone,items:去userIds,impact,publishedAt}`。ScheduleImportPreview=`{previewId,expectedRevision,timezone,items,impact,errors:[{row,message}],expiresAt}`。IcebreakerList=`{eventId,enabled,activities}`；activity 有 id/title/description/startsAt/location/revision/ownChoice/ownGroup，responses/groups 只在管理投影；详细类型在 schedule-model.ts。

### 本人服务和后勤

| 方法/路径 | 服务方法与后续输入 | data 类型 | 权限 |
| --- | --- | --- | --- |
| GET P/my-services | ownServices | OwnEventServices | 当前本人 approved；无他人安排或token |
| GET P/my-summary | ownFacts ＋ schedule.getSchedule ＋ logistics.ownServices → buildParticipantSummary | ParticipantSummary | 当前本人 approved；只含本人事实（P08，见文首） |
| GET M/accommodation-assignments | listAccommodation | AccommodationAssignment[] | logistics_manage |
| POST M/accommodation-assignments | assignAccommodation({userId,location,room,checkIn,checkOut,note?,expectedRevision}) | AccommodationAssignment | logistics_manage＋收件人approved |
| POST M/accommodation-import/preview | previewAccommodationImport({csv}) | AccommodationImportPreview | logistics_manage |
| POST M/accommodation-import/confirm | confirmAccommodationImport({previewId}) | {previewId,assignments,replayed} | 原预览操作者＋logistics_manage；确认每行版本 |
| GET M/meal-voucher-types | listVoucherTypes | VoucherType[] | logistics_manage |
| POST M/meal-voucher-types | createVoucherType({name,uses,expiresAt}) | VoucherType | logistics_manage；uses 1–100 |
| GET M/meal-vouchers | listVouchers；直接服务可第三参{userId?} | MealVoucher[] | logistics_manage；HTTP全当前赛事 |
| POST M/meal-vouchers | issueVoucher({userId,typeId,idempotencyKey}) | {voucher,token:string\|null,replayed} | logistics_manage＋收件人approved |
| POST M/meal-vouchers/:id/revoke | revokeVoucher({voucherId:路径id,expectedRevision}) | MealVoucher | logistics_manage |
| POST M/meal-vouchers/redeem | redeemVoucher({token?或voucherId?,idempotencyKey}) | {receipt:VoucherRedemption,replayed} | logistics_manage＋当前持券者approved；目标二选一 |

住宿 expectedRevision=0 首次分配，后续更正传当前值。Assignment=`{id,eventId,userId,location,room,checkIn,checkOut,note,revision,updatedAt,updatedBy}`。AccommodationImportPreview=`{id,eventId,createdBy,createdAt,expiresAt,rows:[上述fields,line,expectedRevision],errors:[{line,message}],state:'preview'\|'confirmed',assignments}`。CSV 表头严格为 userId,location,room,checkIn,checkOut,note。

VoucherType=`{id,eventId,name,uses,expiresAt,createdAt,createdBy}`。MealVoucher 包含 id/eventId/userId/typeId/name/totalUses/remainingUses/expiresAt/issuedAt/issuedBy/revokedAt/revokedBy/revision/state（available/exhausted/expired/revoked），没有token/hash。VoucherRedemption=`{id,eventId,voucherId,operatorUserId,mode:'token'\|'manual',redeemedAt,remainingUses,voucherRevision}`。OwnEventServices=`{eventId,modules:{accommodation,mealVouchers},accommodation:Assignment\|null,vouchers:MealVoucher[]}`。

## UI 出口/prop

所有核心组件 prop 共有 `eventId:string,eventTitle:string,organizationName:string,modules:EventModuleFlags`。根只应把当前用户有权的 manager 组件放入对应工作区；UI隐藏不能代替服务权限。

| ui.ts export | 附加 prop | 用途 |
| --- | --- | --- |
| EventCommunicationPanel | 无 | 当前通知/未读、公开FAQ、本人问题与明确公开同意 |
| CommunicationManager | initialTicketId?:string | 待回复直达、正式答复/状态/预览、公告草稿/发布/撤回 |
| EventSchedulePanel | 无 | 真实发布且适用本人行程，时区/地点/影响 |
| ScheduleManager | 无 | 结构化行程、CSV持久预览/确认、显式发布 |
| OwnEventServices | 无 | 本人住宿、券状态/券ID、自愿破冰选择 |
| LogisticsManager | participants?:readonly {userId:string,label:string}[] | 人工分配/导入、券类型/发放/撤销/核销、活动与自愿名单分组；可由根注入报名名单以便选择 |

## SQL/验证范围

- `src/modules/event-communication/migrations/001_communication.sql`：公告/版本/已读、ticket/版本、公开FAQ。
- `src/modules/event-communication/migrations/002_logistics.sql`：住宿/版本/预览、券类型/券hash/发放幂等/核销回执/版本。
- `src/modules/event-communication/migrations/003_schedule.sql`：行程状态/发布/导入预览、破冰活动/选择/分组/历史。
- 均兼容 pg/PGlite、引用auth_users(id)，无实际迁移执行。真实迁移编号由主会话分配，既有迁移不得改写。
- Node 测试在全新内存 PGlite 中执行自身 SQL，跨模块 Port 为受控夹具，不接真实账号/邮件/外部服务。
- 覆盖跨组织/赛事隔离、猜ID、会话/工作人员撤权、最终guard事务回滚、版本并发冲突、公开同意预览、报名检查、行程范围/时区/历史、住宿本人/导入、餐券 hash/过期/撤销/并发最后次扣券与幂等。
- 最终复核 `node --experimental-strip-types --test src/modules/event-communication/*.test.ts`：38项通过、0失败（14.52秒）；包括三个服务/HTTP工厂组合和三个SQL建议一起应用后的独立流程。细分handlers 6、communication 10、logistics 10、schedule 11、module组合1；共享Port为受控夹具。SQL触发器保护公告/求助/住宿/券/核销/行程/分组历史，日期校验拒绝无时区或日历自动归一化（例如2月30日）。**2026-10-16 P08 追加后为 50 项通过、0 失败**（新增 `participant-summary.test.ts` 12 项）。
- `node node_modules/typescript/bin/tsc --noEmit --incremental false`：首轮全仓通过（exit 0，无诊断）；不写根tsbuildinfo，不运行build。**2026-10-16 P08 追加后**：本模块 0 错误；全仓另有 6 处错误，全部位于 `src/modules/organizer/duplicate-service.test.ts`（P05 会话在改），按纪律只报告不越界。

## NEEDS_INTERFACE / 根接入

1. **当前真实授权/锁**：根注入 HostedEventAccessPort.getEvent(sql,eventId,{forUpdate:true}) 时需持有当前赛事行锁；requireStaff 同事务复核当前账号、组织审批/暂停、grant 与 capability，并与所有报名写复用锁，不能用缓存或 request JSON。guard(sql) 检查当前账号状态及本次请求会话，不只第一次resolvePrincipal。
2. **公告收件目录**：共享 EventNotificationPort.enqueue 已有，但 EventParticipationPort 没有整场名单。本模块本地可选 `announcementAudience.listRecipientUserIds(sql,eventId):Promise<readonly string[]>`；根需要从真实 approved 报名事实提供，以 communication_manage 发布授权为前置。同事务逐人复核报名，例：赛事A返回A已通过人员，绝不能把机构全部用户或赛事B收件人加入。目录或 outbox 未注入时只站内unconfigured；queued不冒充已投递。enqueue时公告主记录已持久于当前事务，确切版本随后以入队回执写入不可变快照；root outbox应存引用JSON/aggregate标识，不以跨模块外键要求该尚未插入的版本行。
3. **后勤人员选择**：LogisticsManager 可接根已授权 `participants:[{userId,label}]`，根从当前赛事approved报名投影最小显示名和ID，logistics_manage复核后提供。不返回整份报名答卷/联系人；未提供时由工作人员从当前报名名单复制账号ID，界面明确说明。推荐根统一提供列表/查找，避免用户手填ID。
4. **根API与页面**：将固定 route helper 接现有 `/api/v1` 组合器；真实resolvePrincipal、Origin/CSRF、当前赛事登录returnTo由根负责。管理组件需要按capability区分；根切赛事先处理保存/放弃本地草稿，避免跨赛事转投。
5. **后台/邮件/AI**：本模块没有SMTP/模型依赖或新增环境变量。邮件使用根既有持久outbox并独立展示实际投递状态；官方答复均人工。本轮没有调用DSH客服；未来真实自由聊天由根既有DSH组合，仅授权公开FAQ或当前ticket内容，不读选手记忆/项目。

## 未接入与外部未验收

尚未根路由/导航/页面组合、未执行实际042起迁移、未实际构建或服务启动。根需应用所有模块建议到独立测试库，并执行两组织/至少三赛事、多身份/撤权/跨模块链路与手机流程。真实PostgreSQL多连接并发、邮件实际投递、真实主办方试用、真实手机、公网证书/域名均未由本会话验收。没有酒店、支付、短信、自动配对或AI自动答复的成功声明。

交付状态：**模块实现完成、隔离测试通过、全仓类型检查通过；根接入/本机上线/外部真实验收未由本会话执行。**

**本会话及内部代理已停止编辑；src/modules/event-communication/ 与本交付文档全部交还主会话，临时独占授权结束。**

---

# 规划34 D1 · 本场参赛名录（2026-10-16，主会话）

> 依据 [规划 34](../../规划/34-主办方模块化与选手社区.md) §4.1 D1 与宪法 v1.23.0 原则 XIII（选手社区：默认关、仅同场参赛者、复用既有名片、不暴露邮箱）。

## 已实现（模块侧）

| 项 | 内容 |
| --- | --- |
| 门禁 | `directory()` 读取 `eventCommunity(event).participantDirectory`；未开启时**403 `EVENT_COMMUNITY_DISABLED`**（不是空数组），且 `run(..., "member", ...)` 已确认调用者是**本场报名已通过**的参赛者 |
| 路由 | `GET competitions/:eventId/participants`（route kind `participants`，非 publicRead，未登录 401） |
| 只读来源 Port | `EventDirectoryPort`：`approvedParticipantIds` / `publishedCards` / `publicTeams`；**不注入时返回空并写明「来源尚未接入」**，不把未接入当成「本场无人」 |
| 复用 | 名片口径与既有 `recruiting.listCards` 完全一致（`status='published'` + 账号活跃 + 当前 revision FOR SHARE）；只返回公开字段，不含邮箱/私人资料/头像字节 |
| 新增读法 | `recruiting.publishedCardsForUsers(userIds)`（按账号批量取已发布公开名片；最多 200 个账号） |

## 本轮已验证

- `node node_modules/typescript/bin/tsc --noEmit --incremental false` → **exit 0**
- `src/modules/recruiting/*.test.ts` → **55/55**
- `src/modules/event-communication/*.test.ts` → **50/50**

## 根接线（2026-10-16 主会话已完成）

1. `event-registration/service.ts` 新增两个 **sql 级只读**读法：`approvedParticipantIds(sql, eventId)`（复用既有 `store.listRegistrations({status:'approved'})`，分页取完或 500 上限）与 `publicTeamsIn(sql, eventId)`（复用既有 `store.listTeams` + `publicTeam` 投影，只给标识/名称/方向，不含成员账号）。
2. `recruiting.publishedCardsForUsers(sql, userIds)` 改为 **sql 优先**（调用方持有事务，不再自开事务），与目录同 executor。
3. `src/server/organizer-integration.ts` 注入 `directory`：三个方法全部为 sql 级转发；`OrganizerIntegrationDependencies` 新增惰性 `recruiting?: () => …`，`application.ts` 传 `recruiting:()=>recruiting`（与既有 L114 惰性闭包同法，解决组装顺序）。**根不需要新增路由**——`eventCommunicationHttpRoute` 已解析 `competitions/:id/participants`。
4. 界面：比赛页概览新增只读「本场参赛名录」区（`EventParticipantDirectory`）；403/404 时**不渲染任何入口**。

### 根验收（已追加并通过）

`src/server/organizer-router-acceptance.test.ts`：匿名 **401**；赛事未开启时参赛者 **403**；主办方开启 `participantDirectory` 并发布后，参赛者 **200**（`enabled: true`、无名片时 `entries` 为空而**不补占位**、含本场公开队伍）；非参赛者 **403**；响应中**不含邮箱**。该文件 **5/5** 通过。

### 本轮验证

- `tsc --noEmit` **exit 0**
- recruiting **55/55**、event-communication **50/50**、event-registration **39/39**
- `src/server/organizer-router-acceptance.test.ts` **5/5**
- `next build` **BUILD_EXIT=0**
