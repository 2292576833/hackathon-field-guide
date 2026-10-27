# P09 · 赛后闭环（event-closure）交付

日期：2026-10-16。依据：`docs/规划/33-主办方可用性与赛后闭环.md`（第 4 节吸收闸门、第 5 节第 6 期、第 6 节验收）
与分项 `docs/规划/主办方/P09-赛后闭环.md`；设计 `docs/设计/主办方工作台设计.md` §6.6、`docs/设计/主办方工作台布局.md`。
决策点 5 已由用户按推荐默认接受：**联系意愿由队伍成员本人明确选择，默认不公开，只对本场主办方可见**。

授权文件范围：**仅新增** `src/modules/event-closure/` 与本交付。
未编辑 `src/app`、`src/server`、`src/shared`、`src/components`、`migrations` 或任何其他模块的现有文件。

## 1. 已实现

### 1.1 唯一新增事实：队伍「是否愿意被联系」

- 默认不公开；只有队员本人主动提交后，本场主办方才看得到"愿意被联系"的队伍。
- 一队一条有效记录；撤回后可重提，历史行保留（撤回只把状态改成 `withdrawn` 且 `revision + 1`）。
- 只有本队当前成员可以提交/撤回，采用 event-judging 申诉的**成员双重校验**口径：
  ① 当前队伍名单包含本人；② 该队**最新正式收件回执**的成员快照也包含本人。队长不能代其他成员或别队选择。
- 同一重试标识幂等：同键同输入返回原记录；同键不同输入 `CLOSURE_IDEMPOTENCY_KEY_REUSED`。
- 只有**提交人本人**可以撤回（`authorUserId` 校验，沿用申诉的 `withdrawAppeal` 口径）。
- 界面必须逐字使用 `contactWillingnessConsentNotice`：
  "选择「愿意被联系」只表示同意主办方就本队成果与本队联系；这不代表获奖、投资、录用或孵化机会，
  主办方也没有承诺任何结果。是否联系、何时联系由主办方自行决定。"

**存储选型（二选一，已登记）**：本模块内新表 `ecl_contact_willingness`，
**不并入** event-judging 的 `ej_result_appeals`。两条表各管一件事，不存在同一事实两处存储。
`ec_` 前缀已被 event-communication 占用，故用 `ecl_`。

### 1.2 其余全部只读派生

- 主办方侧 `postEventSummary`：本场成果清单（正式收件数/最近交件时间、已公布结果、已确认复盘条目）、
  「下一届可复用」（只列 `published`/`approved` 且 `href` 非空的条目，每项指回既有记录）、
  唯一新增事实的公开投影、指回**既有**处理队列的路径。需复核（`reviewRequired`）的已公布版本
  **不列出任何作品、不导出反馈计数**。
- 队伍侧 `myContactWillingness`：只含本队自己的当前选择与历史，
  并指回**既有** `GET competitions/:eventId/my-checklists?teamId=` 赛后清单与
  既有 `/projects/:projectId/retrospectives` 复盘入口——**不另做一份赛后清单**。
- 复盘写路径完全复用既有 M07：本服务没有创建/更新复盘条目的方法，模块内没有第二个复盘写入点。
- 跨模块读取全部经注入的 `EventClosureSourcePort`；`postgres.ts` 只读写 `ecl_contact_willingness`，
  不碰其他模块的表。

## 2. 吸收闸门三问（宪法 XII / 规划 32 第 4.0 节）

| 问题 | 答案 |
| --- | --- |
| **① 解决我们哪个真实问题** | 赛后成果散在各模块：主办方拿不到一眼可见的本场成果与"下一届可复用"清单；队伍拿到结果后没有一个本人可控的"是否愿意被继续联系"入口，也没有从"已公布内容"到"既有复盘/复用清单"的连接。是 P09 §1 记录的摩擦点，不是"竞品有所以要有"。 |
| **② 会碰到的既有能力** | `event-judging` 正式收件回执与已公布结果/需要复核信号、`organizer` 的事件与配置/品牌记录、`event-registration` 正式队伍名单、M07 复盘写路径与 `/projects/:id/retrospectives` 入口、既有 `my-checklists` 赛后清单、既有 `judging_manage` 权限与 `event_manage`。 |
| **③ 如何避免重复入口 / 第二份事实 / 第二套写路径** | ① **只新增一件事实**：`ecl_contact_willingness`；其余全是派生读。② 声明只有一个写入点，且不写其他模块的表。③ 主办方侧挂在既有事件页"赛后"区、队伍侧挂在既有结果/复盘页，**不新增导航、不新增"我的赛事"入口**。④ 表格只由 `postgres.ts` 读写，避免同一事实两处存储。⑤ 赛事读走既有 `HostedEventAccessPort`；队伍成员读走既有 `EventParticipationPort`。 |

**可复核证据**（"没有新增第二套 X"）：

| 声明 | 证据 |
| --- | --- |
| 没有新增第二套业务事实 | 只建 1 张表 `ecl_contact_willingness`；`postEventSummary` 不落库；模块内没有其他 `INSERT/UPDATE/DELETE` 语句。 |
| 没有新增第二份赛后清单 | 队伍侧视图只返回 `myChecklistsHref` / `retrospectiveHref` 指回既有入口，不复制条目内容。 |
| 没有新增第二套评审/公布/申诉语义 | 不定义评分、名次、轮次状态或申诉状态；已公布结果只按来源投影计数。 |
| 没有新增复盘写路径 | 服务内无复盘写方法；复盘计数只由 `confirmedRetrospectiveCounts` 只读提供（可选，未接入显示"未读取"）。 |
| 没有新增第二套权限 | 复用 `requireStaff` + 既有能力枚举；队伍侧复用 `EventParticipationPort` 的当前名单。 |
| 没有把成绩当评价 | `policy.ts` 的对外文案与返回值均不含评分/排名/能力评价；`ClosurePublishedRow` 只用于计数与作品标题，不进入主办方视图文本。 |

## 3. 明确不做清单对照（分项 P09 第 6 节逐条）

| P09 第 6 节禁止项 | 本模块的处理 |
| --- | --- |
| ❌ 投资对接、招聘撮合、孵化推荐、交易或分账 | 未实现任何匹配、推荐、投递或交易；`contactWillingness` 只是布尔选择。 |
| ❌ 承诺投资、录用、孵化或任何结果 | 同意口径常量原文写"不代表获奖、投资、录用或孵化机会，主办方也没有承诺任何结果"，并由界面逐字展示。 |
| ❌ 把成绩、名次或评审分数当作能力评价或推荐依据 | 主办方视图只报"已公布版本的作品数/反馈数/需复核状态"，不给评分或排名文本；队伍侧只指回既有清单。 |
| ❌ 读取未提交草稿、私人测评、私人 AI 记忆或个人助手对话 | `confirmedRetrospectiveCounts` 契约只允许统计已确认条目，明确禁止读取草稿正文；本模块不接测评或 AI 记忆。 |
| ❌ 向主办方展示队伍的私人内容 | 只展示主动选择"愿意被联系"的队伍（`status='active' && willing`），未选择/不愿意/撤回都不出现，也不显示数量。 |
| ❌ 新增完成状态、影响力分、成果转化率 | 无新状态列、无分数、无转化率；`outcomes` 只报计数与版本。 |
| ❌ 自动把队伍转成项目或自动创建复盘条目 | 无任何项目创建或复盘写入调用。 |
| ❌ 第二套发布入口或第二个成果页面 | 无发布逻辑；界面为既有页面的一个区块，主会话接线时不新增导航。 |

另外，分项 P09 §3.1 列的"奖项与赞助结构"在本仓库**没有任何既有记录**（`src/modules/organizer` 内
grep `award|sponsor|奖项|赞助` 为 0 条），因此**不输出**该项——不为凑清单编造事实（宪法 XII）。

## 4. 新增文件

| 文件 | 内容 |
| --- | --- |
| `src/modules/event-closure/model.ts` | 唯一新事实、只读来源端口、两侧派生视图类型 |
| `src/modules/event-closure/policy.ts` | 纯函数：校验、同意口径原文常量、两侧视图构造、复用来源过滤 |
| `src/modules/event-closure/postgres.ts` | `ecl_contact_willingness` 的读写（含 scope 过滤与版本 CAS） |
| `src/modules/event-closure/service.ts` | `createEventClosureService`（6 个方法） |
| `src/modules/event-closure/handlers.ts` | `createEventClosureHandlers`（6 个入口） |
| `src/modules/event-closure/ClosurePanels.tsx` + `event-closure.module.css` | 主办方赛后面板与队伍侧选择卡片 |
| `src/modules/event-closure/ui.ts` | 客户端再导出 |
| `src/modules/event-closure/index.ts` | 公共导出 |
| `src/modules/event-closure/README.md` | 模块说明 |
| `src/modules/event-closure/migrations/001-event-closure.sql` | **迁移建议**（主会话编号） |
| `src/modules/event-closure/policy.test.ts` / `service.test.ts` / `postgres.test.ts` / `handlers.test.ts` | 25 项测试 |
| `docs/协作/交付/event-closure.md` | 本文件 |

## 5. 数据表契约（迁移建议）

表 `ecl_contact_willingness`：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | text PK | 记录标识 |
| `organization_id` / `event_id` / `team_id` | text | 范围；FK → `organizer_hosted_events(id, organization_id)`、`event_registration_teams(event_id, id)` |
| `author_user_id` | text | 提交人；FK → `auth_users(id)` |
| `willing` | boolean | 本人明确选择 |
| `status` | text | `active` / `withdrawn` |
| `revision` | integer | 从 1 起，撤回 +1 |
| `submitted_at` / `withdrawn_at` | timestamptz | 时间；`withdrawn_at` 与状态一致（CHECK） |
| `idempotency_key` | text | 1–120；`(organization_id, event_id, author_user_id, idempotency_key)` 唯一 |
| `document` | jsonb | 与索引列逐字段一致（CHECK） |

约束：`ecl_contact_willingness_one_active` 部分唯一索引（`WHERE status='active'`）保证**一队一条**；
触发器 `ecl_protect_contact_willingness` 冻结范围/提交人/原始选择/时间/重试标识，要求 `revision + 1`，
且只允许 `active → withdrawn`。

## 6. 服务与端点契约

服务方法、端点、权限、错误码见 `README.md` 第 4–5 节。端点为：

| 工厂成员 | 方法 | `/api/v1` 之后路径 |
| --- | --- | --- |
| `postEventSummary` | GET | `organizer/events/:eventId/closure` |
| `eventContactWillingness` | GET | `organizer/events/:eventId/closure/contact-willingness` |
| `myContactWillingness` | GET | `competitions/:eventId/contact-willingness?teamId=` |
| `myWillingnessEligibility` | GET | `competitions/:eventId/contact-willingness/eligibility?teamId=` |
| `submitContactWillingness` | POST | `competitions/:eventId/contact-willingness` |
| `withdrawContactWillingness` | POST | `competitions/:eventId/contact-willingness/:willingnessId/withdraw` |

关键返回形状：

```
PostEventSummary = { event{eventId,organizationId,title,status,timezone,startsAt,endsAt,submissionClosesAt,afterEvent},
  outcomes{ intake{count,latestSubmittedAt},
            published:[{roundId,roundTitle,version,visibility,publishedAt,reviewRequired,workCount,approvedFeedbackCount,works[]}],
            retrospectives{confirmedCount|null,linkedProjectCount,state:"read"|"unread",notice} },
  reuse:[{id,kind,label,detail,href,state}], contactWillingness:[{teamId,chosenAt}],
  existingQueues:[{id,label,href,note}], notice, limitations[] }
MyContactWillingness = { teamId, memberCount, active|null, history[],
  consentNotice, privacyNotice, withdrawNotice,
  reuse{myChecklistsHref, retrospectiveHref|null, linkedProjectId|null, notice} }
```

## 7. 验证（真实执行）

```
node --experimental-strip-types --test src/modules/event-closure/*.test.ts
ℹ tests 25
ℹ pass 25
ℹ fail 0

node node_modules/typescript/bin/tsc --noEmit --incremental false
TOTAL_ERROR_LINES=2
FILE 1 src/modules/organizer/dashboard.ts
FILE 1 src/modules/organizer/dashboard.test.ts
--- event-closure ---
(none)
```

本模块 `tsc` **0 报错**。全仓另有 2 条报错，均在 `src/modules/organizer/`（P07 看板文件，属另一会话），
不在本授权范围，未修改。（首次运行期间 `src/components/competition-workspace.tsx` 处于他方编辑中的
临时语法错误状态，与本模块无关；最终检查该项已消失。）

25 项测试覆盖：

1. **同意口径原文**：含"只表示同意"、"不代表"与"投资/录用/孵化"，且不含"保证获得/承诺录用/一定"。
2. **选择与边界校验**：非布尔拒绝；重试标识/版本越界拒绝。
3. **成员双重校验**：外部账号、他队成员、当前成员但不在正式收件快照（后入队）都被拒；无正式收件的队伍被拒。
4. **幂等**：同键同输入重放一致；同键不同输入拒绝。
5. **一队一条 + 撤回重提**：二次提交 `CLOSURE_ALREADY_SET`；撤回后重提生成新记录，撤回行不可改写；
   重复撤回 `CLOSURE_STATE_INVALID`。
6. **提交人本人撤回**：同队其他成员撤回被拒；版本不符 `CLOSURE_VERSION_CONFLICT`；记录不存在 404。
7. **默认不公开**：未选择/不愿意/撤回后主办方侧都看不到；选择愿意后只出现 `{teamId, chosenAt}`，无提交人账号。
8. **不改结果**：提交联系意愿前后 `postEventSummary` 的 `outcomes/reuse/existingQueues/event` 逐项深比较相等，
   唯一变化是 `contactWillingness` 多一条。
9. **只读边界**：非工作人员读赛后闭环 403；归档赛事读得到但写被拒（`CLOSURE_EVENT_READ_ONLY`）。
10. **本队隔离**：队伍侧视图只含本队，序列化结果中不出现他队记录 id；他队成员读不到。
11. **只列已公布内容**：`reviewRequired` 的版本 `works=[]`、反馈计数为 0；未公布作品不出现。
12. **复用来源过滤**：丢弃 draft/unpublished/无 href/重复条目。
13. **未读取 ≠ 0**：未接入复盘读取时 `confirmedCount=null, state="unread"`。
14. **SQL 边界**：scope 读隔离、部分唯一索引拒绝第二条 active、触发器冻结字段与版本、
    `document` 与索引列不一致被 CHECK 拒绝。
15. **HTTP 边界**：真实 principal、写授权、方法/压缩/超长/坏 JSON、`Idempotency-Key` 头正文不一致、缺少路由标识。

## 8. 根接入 NEEDS_INTERFACE

以下全部**未接入**，需主会话组合。本模块不提供根组合代码。

### 8.1 迁移编号与执行

- 建议编号：**`072_event_closure.sql`**（仓库现有最大为 `071_result_appeals.sql`）。
- 内容：模块内 `src/modules/event-closure/migrations/001-event-closure.sql`（表 + 2 索引 + 触发器）。
- 依赖：`auth_users`、`organizer_hosted_events(id, organization_id)`、`event_registration_teams(event_id, id)`
  已存在（042/043 已应用）。**未执行迁移**；由主会话编写并应用根迁移。

### 8.2 只读来源端口 `EventClosureSourcePort` 的实现

需在 `src/server/organizer-integration.ts`（或新的根适配文件）注入，且**必须复用既有读逻辑**、
与调用方同一个 `SqlExecutor`（同一事务，不另开连接）：

| 方法 | 建议实现 | 硬性语义 |
| --- | --- | --- |
| `intakeReceipts(sql, eventId)` | 投影 `ej_intake_receipts` 的 `{id, teamId, version, receiptNumber, ruleVersion, eventRevision, submittedAt, memberUserIds}`（或由 event-judging 新增一个公共只读方法） | 只读本场；`memberUserIds` 必须是**该回执冻结时**的成员快照 |
| `publishedResults(sql, eventId)` | 复用 event-judging 既有 `projection()`（含 `needs_review` 拦截与可见性复核） | **不得另算分数或名次**；`reviewRequired` 为真时 `rows` 必须为空 |
| `reuseSources(sql, eventId)` | 由既有记录构造：评审基准（`ej_judging_rounds` 最新已锁定/已公布轮）、时间表、报名表单（`event_registration_forms`）、通知模板、品牌/已发布版本（`organizer_event_publications`） | 只返回确实存在的记录；`state` 只允许标 `published`/`approved` 表示已公布/已批准；没有记录就不返回，**不补占位** |
| `confirmedRetrospectiveCounts(sql, eventId, projectIds)`（可选） | 只统计 M07 中 `status='confirmed'` 的复盘条目，按 `projectId` 分组计数 | 只允许计数；**不得读取草稿或正文**。不实现则在 `index` 处省略该属性，视图显示"未读取" |

### 8.3 路由注册

在 `src/server/organizer-integration.ts` 的 `JUDGING_ROUTES` 之后新增一组 `CLOSURE_ROUTES`（或等价分发），
并实例化 `createEventClosureHandlers({ service: closure, resolvePrincipal, authorizeMutation, requestIds })`：

| 工厂成员 | 方法 | 模式 | 参数 |
| --- | --- | --- | --- |
| `postEventSummary` | GET | `^organizer/events/([^/]+)/closure$` | `["eventId"]` |
| `eventContactWillingness` | GET | `^organizer/events/([^/]+)/closure/contact-willingness$` | `["eventId"]` |
| `myContactWillingness` | GET | `^competitions/([^/]+)/contact-willingness$` | `["eventId"]` |
| `myWillingnessEligibility` | GET | `^competitions/([^/]+)/contact-willingness/eligibility$` | `["eventId"]` |
| `submitContactWillingness` | POST | `^competitions/([^/]+)/contact-willingness$` | `["eventId"]` |
| `withdrawContactWillingness` | POST | `^competitions/([^/]+)/contact-willingness/([^/]+)/withdraw$` | `["eventId","willingnessId"]` |

注意：`competitions/:eventId/contact-willingness/eligibility` 必须注册在
`competitions/:eventId/contact-willingness` 之前或用精确正则区分（GET 与 POST 已由方法区分，
但 eligibility 是 GET 子路径，需要在匹配顺序上先于 `myContactWillingness`）——当前两个正则各自锚定
`$`，不会互相吞掉，只需按表顺序加入即可。

### 8.4 权限

- 主办方两个 GET：复用 `events.requireStaff(..., "judging_manage")`（本模块默认；若主会话认为应由
  `event_manage` 读取，可在工厂注入 `staffCapability: "event_manage"`，其余判定不变）。
- 队伍侧：当前队伍成员（双重校验），不需要 staff 能力。
- 写请求经既有 `authorizeMutation`（Origin/CSRF）；全部响应 no-store。

### 8.5 界面落点

- `PostEventClosurePanel`：放在既有主办方**本场概览/事件页的"赛后"区**（设计 §6.6），
  不新增一级导航、不新增第二个成果页面。滚动/粘性遵循布局文档（本组件本身不粘性）。
- `ContactWillingnessCard`：放在既有**本人结果页 / 空间复盘页**，与既有 `my-checklists` 展示同区；
  卡片内链接直接跳既有赛后清单与既有复盘页。
- 两组件从 `src/modules/event-closure/ui.ts` 导出；只使用 `globals.css` 既有令牌，无进度条/百分比/排名徽章。

### 8.6 所需环境变量

**无新增**。共用既有 `DATABASE_URL` / 本机单实例 PGlite 配置，不含密钥值。

## 9. 未做与边界

- **未接入根**：路由、迁移、界面挂载、`EventClosureSourcePort` 全部待主会话组合（见第 8 节）。
- **未做真实外部验收**：未跑生产构建、未重启服务、未执行迁移、未做真实浏览器/手机走查；
  测试均为隔离内存 PGlite 与受控 Port，不代表多连接 PostgreSQL 并发验收。
- **未实现催办/通知**：本模块不发任何消息，也不调用 `EventNotificationPort`。
- **未实现"待处理的下一步"落库**：P09 §3.1 要求"复用既有人工审批写路径"。本模块只把
  下一步指向既有申诉/评审/报名队列（`existingQueues`），**不新增审批表或状态**。
- **奖项与赞助结构**：仓库无既有记录，按第 3 节不输出。
- 未导入其他模块私有文件；未修改共享契约。
