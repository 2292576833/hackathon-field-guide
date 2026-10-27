# event-closure · 赛后闭环（规划 33 P09 / 缺口 N6）

比赛结束后把**已经产生的事实连起来**，并新增**一件**由队伍本人决定的选择。"赛后闭环"不是投资对接、
招聘撮合或孵化推荐模块；本模块**没有**这些功能，也不接受把它们加进来。

依据：`docs/规划/33-主办方可用性与赛后闭环.md` 第 4 节吸收闸门、第 5 节第 6 期、第 6 节验收；
分项 `docs/规划/主办方/P09-赛后闭环.md`；设计 `docs/设计/主办方工作台设计.md` §6.6。

## 1. 唯一新增事实

**队伍「是否愿意被联系」**（`ContactWillingness`）：

- 默认不公开；只有队员本人主动提交后，本场主办方才看得到"愿意被联系"的队伍。
- 一队一条有效记录；撤回后可重提，历史行保留。
- 只有本队当前成员可以提交/撤回；沿用 event-judging 申诉的**成员双重校验**口径：
  ① 当前队伍名单包含本人；② 该队**最新正式收件回执**的成员快照也包含本人。
- 同一重试标识幂等：同键同输入返回原记录，同键不同输入拒绝。
- 只有**提交人本人**可以撤回（队长不能代其他成员决定，也不能替其他队伍选择）。

界面**必须逐字**使用 `policy.ts` 的常量（`contactWillingnessConsentNotice` 等）：
"选择「愿意被联系」只表示同意主办方就本队成果与本队联系；这不代表获奖、投资、录用或孵化机会，
主办方也没有承诺任何结果。"

## 2. 存储选型（二选一，已登记）

分项 P09 第 4 节要求在"申请表"与"并入既有申诉表"之间**二选一**，不得两处并存。

**本模块选：模块内新表 `ecl_contact_willingness`**（迁移建议 `migrations/001-event-closure.sql`）。
不并入 `event-judging` 的 `ej_result_appeals`——那张表管"结果申诉"，是另一件事。
`ec_` 前缀已被 event-communication 占用，因此使用 `ecl_`（event-**cl**osure）。

不可变边界由触发器保证：队伍、提交人、提交时间、原始选择与重试标识不可改写；
撤回只允许 `active → withdrawn` 且 `revision + 1`；部分唯一索引强制"一队一条有效记录"。

## 3. 其余全部只读派生

- 主办方侧 `postEventSummary`：本场成果清单（正式收件数、已公布结果、已确认复盘条目）、
  「下一届可复用」（只列 published/approved 且**必须指回既有记录**的条目）、唯一新增事实的公开投影、
  以及指回**既有**处理队列的路径。
- 队伍侧 `myContactWillingness`：本队自己的选择与历史；**指回既有** `GET competitions/:eventId/my-checklists`
  赛后清单与既有 `/projects/:projectId/retrospectives` 复盘入口——**不另做一份赛后清单**。
- 复盘写路径完全复用既有 M07：本服务**没有**创建/更新复盘条目的方法。

跨模块读取一律通过注入的 `EventClosureSourcePort`；本模块不导入其他模块的私有文件，
也不直接读写其他模块的表（`postgres.ts` 只碰 `ecl_contact_willingness`）。

## 4. 服务

`createEventClosureService(deps: EventClosureDependencies)`

| 依赖 | 必选 | 说明 |
| --- | --- | --- |
| `database` | 是 | `DatabasePort`；所有读写同一事务，生产不得内存降级 |
| `clock` / `ids` | 是 | 服务端时间与唯一 ID |
| `events` | 是 | `HostedEventAccessPort`；`requireStaff` 默认按 `judging_manage` |
| `participation` | 是 | `EventParticipationPort`；当前队伍名单（成员双重校验） |
| `source` | 是 | `EventClosureSourcePort`；既有的收件/公布/复用/复盘只读投影 |
| `staffCapability` | 否 | 默认 `judging_manage` |

| 方法 | 输入 | 输出 | 权限 / 行为 |
| --- | --- | --- | --- |
| `postEventSummary(principal, eventId)` | — | `PostEventSummary` | 本场 `judging_manage`；只读派生 |
| `eventContactWillingness(principal, eventId)` | — | `{items, visibleCount, notice, limitations}` | 本场 `judging_manage`；只列愿意被联系 |
| `myContactWillingness(principal, eventId, teamId)` | — | `MyContactWillingness` | 本队当前成员（双重校验）；只含本队 |
| `submitContactWillingness(principal, eventId, input)` | `{teamId, willing, idempotencyKey}` | `ContactWillingness` | 本队当前成员；归档赛事只读；一队一条；幂等 |
| `withdrawContactWillingness(principal, eventId, id, input)` | `{expectedRevision}` | `ContactWillingness` | 只有提交人本人；版本 CAS |
| `myWillingnessEligibility(principal, eventId, teamId)` | — | `{teamId, eligible, active, reason}` | 只读；供界面决定是否显示表单 |

错误码：`CLOSURE_INVALID_INPUT`(422)、`CLOSURE_TEAM_ACCESS_DENIED`(403)、
`CLOSURE_TEAM_NOT_PARTICIPATED`(409)、`CLOSURE_ALREADY_SET`(409)、`CLOSURE_ACCESS_DENIED`(403)、
`CLOSURE_VERSION_CONFLICT`(409)、`CLOSURE_STATE_INVALID`(409)、`CLOSURE_NOT_FOUND`(404)、
`CLOSURE_EVENT_READ_ONLY`(409)、`CLOSURE_IDEMPOTENCY_KEY_REUSED`(409)。

## 5. HTTP 工厂与建议路由

`createEventClosureHandlers({ service, resolvePrincipal, authorizeMutation, requestIds })`；
统一 `(request, params:{eventId, willingnessId?}) → Response`，200 成功 `{data, requestId}`，
全部 `Cache-Control: private, no-store`，JSON 最多 64KB 且不接受压缩。

| 工厂成员 | 方法 | `/api/v1` 之后路径 | JSON / query |
| --- | --- | --- | --- |
| `postEventSummary` | GET | `organizer/events/:eventId/closure` | 无 |
| `eventContactWillingness` | GET | `organizer/events/:eventId/closure/contact-willingness` | 无 |
| `myContactWillingness` | GET | `competitions/:eventId/contact-willingness` | `?teamId=` |
| `myWillingnessEligibility` | GET | `competitions/:eventId/contact-willingness/eligibility` | `?teamId=` |
| `submitContactWillingness` | POST | `competitions/:eventId/contact-willingness` | `{teamId, willing, idempotencyKey}`；可用 `Idempotency-Key` 头 |
| `withdrawContactWillingness` | POST | `competitions/:eventId/contact-willingness/:willingnessId/withdraw` | `{expectedRevision}` |

以上路由**尚未接入** `src/server/organizer-integration.ts`；主会话按交付文档 NEEDS_INTERFACE 注册。

## 6. 界面组件（`ui.ts`）

- `PostEventClosurePanel({eventId, eventTitle, organizationName})`：主办方事件页"赛后"区。
- `ContactWillingnessCard({eventId, teamId})`：队伍侧选择/撤回卡片，逐字展示同意口径与隐私说明。

只使用 `globals.css` 既有令牌；无进度条、无百分比、无完成度、无排名徽章；手机上按钮独占一行。

## 7. SQL 迁移建议

`migrations/001-event-closure.sql`：表 `ecl_contact_willingness` + `ecl_contact_willingness_scope_time` 索引 +
`ecl_contact_willingness_one_active` 部分唯一索引 + `ecl_protect_contact_willingness()` 触发器。
**不是已部署迁移**：由主会话分配递增编号（建议 `072`）写入根 `migrations/` 后执行。

## 8. 测试

`node --experimental-strip-types --test src/modules/event-closure/*.test.ts` → 25 项通过。

- `policy.test.ts`：同意口径原文、选择校验、主办方只列愿意、本队视图隔离、只列已公布内容、复用来源过滤。
- `service.test.ts`：成员双重校验、幂等、一队一条与撤回重提、提交人本人撤回、默认不公开、
  "提交前后既有事实完全一致"、归档只读、本队视图隔离、复盘未接入显示未读取。
- `postgres.test.ts`：scope 读、部分唯一索引、触发器冻结、document 与索引列一致。
- `handlers.test.ts`：真实 principal、写请求授权、方法/压缩/超长/坏 JSON、幂等头、路由标识。

## 9. 明确不做（分项 P09 第 6 节）

投资对接、招聘撮合、孵化推荐、交易或分账；承诺投资/录用/孵化或任何结果；把成绩、名次或评审分数
当作能力评价或推荐依据；读取未提交草稿、私人测评、私人 AI 记忆或个人助手对话；向主办方展示队伍的
私人内容（只展示本人选择公开的"联系意愿"与已公布/已批准内容）；新增完成状态、影响力分、成果转化率；
自动把队伍转成项目或自动创建复盘条目；第二套发布入口或第二个成果页面。
