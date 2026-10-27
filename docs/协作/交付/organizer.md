# O01 主办方入驻与赛事核心交付

日期：2026-10-11。独占范围：`src/modules/organizer/`、本文件。依据规划21/O01、宪法v1.11.0与公共`organizer-contracts.ts`。未修改app/server/shared/根components/实际migrations/公共规划/配置/依赖，未build、重启、安装依赖、打开实际PGlite目录或外部发布。

## 已实现

- 学校/公司/社区申请；受控联系人、文字和最多5条公开HTTPS证明链接；仅本人读取、pending/rejected补充后重新送审。附件上传首版明确不提供，也不抓取证明URL。
- 当前平台admin人工审批/退回/停用/恢复，机构申请人和当前工作人员不能自审，reviewer不能借平台角色审批。停用与恢复不删除赛事历史、不复活已撤销工作人员权限。
- Organization和StaffGrant真实SQL持久化；机构管理员、机构范围staff、单赛事staff及固定capabilities。复合FK和服务均防跨组织赛事授权；撤权保存revision与revokedAt；最后一位机构管理员不能撤销。
- 三个固定version1模板：线上、线下、校园/社区练习赛；有限module白名单、合理默认值、时区和分别记录的报名/作品截止。报名审核和容量、队伍模式/人数/锁定均为明确字段；未使用可执行表达式或任意模板JSON。
- 多赛事草稿、编辑、公开预览、正式发布、负责人交接、结束/归档。负责人必须拥有当前赛事event_manage，组织管理员才能更换负责人。
- 正式版本、发布变化回执与审计不可变；草稿修改不改变参赛模块使用的有效发布配置。发布后不允许直接关掉曾启用功能，避免隐藏报名/求助/收件历史。再次发布保存参赛影响说明。
- HostedEventAccessPort完整实现：当前组织approved+当前grant+赛事范围；撤权/停用/归档拒绝工作人员操作。getEvent返回有效已发布Scope而非未发布草稿，组织失效返回null。
- 公开赛事投影仅正式版本和明确可用状态，剔除联系人、邮箱、证明、申请人/工作人员/负责人标识、私密设置、linkedEventId；公开GET不写、不采集、不调用模型。
- 五个客户端组件、中文错误恢复、默认值和当前下一步；公开重要期限、时区、比赛和组织名称，工作人员真实身份范围；高级折叠、44px手机操作、focus与减少动效。表单不要求JSON，失败与冲突保留输入，切换前可保存/保留/放弃。已验证赛事所属组织规范化，避免同一账号多组织误编辑。

## 公共服务工厂与依赖

逻辑导出：`src/modules/organizer/index.ts`；客户端独立导出：`ui.ts`。

```ts
createOrganizerService({
  database: DatabasePort,
  clock: Clock,
  ids: IdGenerator,
  repository?: PostgresOrganizerRepository,
}): OrganizerService
createHostedEventAccessPort(service: OrganizerService): HostedEventAccessPort
```

默认repository为真实参数化Postgres适配，无生产内存降级/私有连接。所有私有方法第一参数为共享`OrganizerPrincipal={actor,guard}`，其余输入输出见下面。所有私有事务开始/结束调用当前请求guard；复核失败回滚业务和审计。org→event锁序稳定；撤权/审核/版本变更共享组织锁。Platform admin/reviewer不自动获得赛事工作人员权限或评委权力。

| 方法 | 后续参数 | 返回 |
| --- | --- | --- |
| createApplication | CreateApplicationInput | OrganizationApplication |
| updateApplication | id, CreateApplicationInput + expectedRevision | OrganizationApplication |
| listOwnApplications / listApplicationsForReview | 无 | OrganizationApplication[]；后者仅admin |
| reviewApplication | id, ReviewApplicationInput | OrganizationApplication |
| listOrganizations | 无 | 当前活跃grant所属Organization[] |
| updateOrganization | id, expectedRevision + description | Organization |
| listStaffGrants | organizationId | StaffGrant[]；仅机构admin |
| grantStaff | organizationId, GrantStaffInput | StaffGrant |
| revokeStaff | grantId, expectedRevision | StaffGrant |
| createEvent | organizationId, CreateEventInput | HostedEvent |
| listOrganizationEvents | organizationId | HostedEvent[]；依真实grant筛选 |
| getManagedEvent | eventId | 当前草稿HostedEvent |
| updateEvent | eventId, UpdateEventInput | HostedEvent |
| changeEventResponsible | eventId, expectedRevision + responsibleUserId | HostedEvent；仅机构admin |
| previewEvent | eventId | EventPreview |
| publishEvent | eventId, expectedRevision + changeSummary | HostedEvent |
| archiveEvent / endEvent | eventId, expectedRevision | HostedEvent |
| listCompetitionIdentities | 无 | CompetitionIdentity[]；仅工作人员身份，根另合并报名/评委 |
| listPublicationHistory | eventId | PublishedEventRevision[]；当前赛事staff可读 |
| listPublicationChanges | eventId | PublicationChange[]；communication_manage |
| listTemplates（公开，不传principal） | 无 | EventTemplate[] |
| listPublicCompetitions（公开，不传principal） | 无 | PublicCompetition[] |
| getPublicCompetition（公开，不传principal） | eventId | PublicCompetition |

完整输入字段以`model.ts`为准：CreateApplicationInput的name/kind/description/contactName/contactEmail/evidenceText/evidenceUrls；EventConfigurationInput的title/timezone/startsAt/endsAt/registrationOpensAt/registrationClosesAt/submissionClosesAt/modules/registration/teams/summary/rules/location；CreateEventInput额外templateKey/expectedOrganizationRevision，UpdateEventInput额外expectedRevision；GrantStaffInput含expectedOrganizationRevision/userId/eventId/role/capabilities，ReviewApplicationInput含expectedRevision/decision/note。

`service.eventAccess`即HostedEventAccessPort：`getEvent(sql,eventId,{forUpdate?})→HostedEventScope|null`、`requireStaff(sql,actor,eventId,capability)→HostedEventScope`。必须复用调用方SqlExecutor；Port本身没有请求会话参数，消费者仍需在事务前后调用当前principal.guard。草稿赛事Scope仅供有权工作人员配置，参赛侧须拒绝draft（O02目前已有此检查）。`revision`为当前编辑版本，`publishedRevision`为有效发布版本。

## HTTP工厂、路径与权限

```ts
createOrganizerHttpHandlers({
  service: OrganizerService,
  authenticate(request: Request): Promise<OrganizerPrincipal>,
  authorizeMutation(request: Request): Promise<void>,
  requestId(): string,
}): { handle(request: Request, route: OrganizerHttpRoute): Promise<Response> }
organizerHttpRoute(pathAfterApiV1: readonly string[]): OrganizerHttpRoute | null
```

根安装固定route。以下相对于`/api/v1`；GET无body，POST/PATCH为JSON（真实读取最多96KiB）。成功`{data,requestId}`，失败共享ErrorEnvelope；未知异常不披露SQL/堆栈。405提供Allow；所有响应private/no-store、Vary Cookie、nosniff。变更先authenticate和Origin/CSRF授权，再读取body，最后服务事务guard。

| 方法 / 路径 | body | data / 权限 |
| --- | --- | --- |
| GET /organizer/templates | — | EventTemplate[] / 公开 |
| GET /organizer/applications、/organizer/applications/mine | — | 本人OrganizationApplication[] |
| POST /organizer/applications | CreateApplicationInput | 本人OrganizationApplication |
| PATCH /organizer/applications/:id | CreateApplicationInput + expectedRevision | 本人OrganizationApplication |
| GET /admin/organizer/applications | — | OrganizationApplication[] / 当前admin |
| POST /admin/organizer/applications/:id/review | ReviewApplicationInput | OrganizationApplication / 当前admin，不得自审 |
| GET /organizer/organizations | — | 当前授权Organization[] |
| PATCH /organizer/organizations/:id | expectedRevision, description | Organization / 机构admin |
| GET /organizer/organizations/:id/events | — | HostedEvent[] / 机构或赛事范围staff |
| POST /organizer/organizations/:id/events | CreateEventInput | HostedEvent / 机构admin |
| GET /organizer/organizations/:id/staff-grants | — | StaffGrant[] / 机构admin |
| POST /organizer/organizations/:id/staff-grants | GrantStaffInput | StaffGrant / 机构admin |
| POST /organizer/staff-grants/:id/revoke | expectedRevision | StaffGrant / 所属机构admin |
| GET /organizer/events/:id | — | HostedEvent / 当前赛事staff |
| PATCH /organizer/events/:id | UpdateEventInput | HostedEvent / event_manage |
| POST /organizer/events/:id/responsible | expectedRevision, responsibleUserId | HostedEvent / 机构admin，target有当前赛event_manage |
| GET /organizer/events/:id/preview | — | EventPreview / event_manage |
| POST /organizer/events/:id/publish | expectedRevision, changeSummary | HostedEvent / event_manage |
| POST /organizer/events/:id/archive、/end | expectedRevision | HostedEvent / event_manage |
| GET /organizer/events/:id/history | — | PublishedEventRevision[] / 当前赛事staff |
| GET /organizer/events/:id/publication-changes | — | PublicationChange[] / communication_manage |
| GET /competitions | — | PublicCompetition[] / 公开 |
| GET /competitions/:id | — | PublicCompetition / 公开 |
| GET /me/competition-identities | — | CompetitionIdentity[] / 本人当前staff |

组织批准首次创建本人机构admin授权；恢复和重新审批不重复创建或复活已撤权限。pending→approved/rejected；approved→suspended；suspended→approved/rejected；rejected由本人补充回到pending。模块白名单依赖：teams须registration，judging须registration+teams；破冰、住宿、餐券须registration以核对资格；线上禁住宿和餐券。发布前要求简介、公开规则、参与位置及启用模块的重要期限，负责人仍须有event_manage。

## UI exports / props

- `OrganizerEntry({signedIn:boolean,loginHref?,workspaceHref?,onApplicationSubmitted?(application)})`；默认页面`/organizers`、工作区`/organizers/workspace`。
- `OrganizerWorkspace({currentUserId:string,initialOrganizationId?,initialEventId?,entryHref?,publicEventHref?(eventId),moduleLinks?(event),staffAccounts?:readonly {userId,label}[],onEventSaved?(event)})`。当前用户ID必须由根账号传入；账号标签仅由根提供可信可选清单。跨组织切换不会复用另一赛事表单；服务端赛事归属覆盖不一致的初始query上下文。
- `CompetitionDirectory({signedIn?,organizerHref?,competitionHref?(eventId),workspaceHref?(eventId),identitySlot?})`；根可在identitySlot合并报名/评委入口。
- `CompetitionOverview({eventId:string,directoryHref?,signedIn?,loginHref?,moduleLinks?:Partial<Record<EventModuleKey,string>>,participationSlot?})`；默认根规划参赛路径，根可覆盖。停用/结束/归档不展示新的参赛操作CTA。
- `AdminOrganizationReview({onReviewed?(application)})`；有效状态选项、人工依据；rejected仅提示等待本人补充。

Props类型全部从`ui.ts`导出。moduleLinks需根提供确实可用的模块页面，不能把源码模块当主导航；participationSlot必须是根当前授权本人状态。UI没有假待报名/待评审计数；下一步依据真实申请、权限、草稿与发布阻塞项。

## SQL建议

`src/modules/organizer/migrations/001_organizer.sql`：组织、申请、赛事、工作人员授权、不可变发布版本、不可变变化回执、不可变审计7张表。自有表前缀organizer_，唯一外部FK为auth_users(id)，不查/写其他模块表。复合赛事/机构FK阻止错属授权；组织/赛事分别有active grant唯一索引。三个不可变trigger拒绝UPDATE/DELETE历史。

根将其纳入真实递增迁移；本会话未修改根migration、未执行实际库。测试只使用隔离内存PGlite和最小auth_users身份表，参数化SQL与实际SQL约束均执行，不代表根全部迁移或生产账号guard已接入。

## 已隔离验证

- Node node:test：26/26通过（17项服务、9项HTTP），命令`node --experimental-strip-types --test src/modules/organizer/service.test.ts src/modules/organizer/handlers.test.ts`。
- 两组织三赛事、事件范围与机构范围矩阵、平台admin/reviewer无继承、不能自审、猜ID/跨组织grant、缺失目标账号、固定capability、最后admin保护。
- 撤权后缓存Actor写入/私有发布历史与变化读取均拒绝，身份/机构列表撤权重查；停用后Port无可用Scope而公开历史保留明确暂停状态。
- 同revision的Promise.allSettled两次更新仅一笔成功；冲突不覆盖旧值；未知字段/伪造linkedEventId/非法枚举数组/坏日期/缺模块依赖被拒。
- 草稿不泄露公开/参赛Scope，新发布版本与旧不可变snapshot分离；数据库UPDATE/DELETE发布/变化/审计直接拒绝。
- 当前账号、会话、admin角色撤销及事务结束guard失败回滚业务和审计；夹具guard是受控注入，未假称生产根guard通过。
- 重申批准不重复grant、不复活原负责人机构admin权限；负责人交接权限/版本/目标grant复核。
- HTTP公开GET只读、私有GET guard、Origin拒绝无写、405/415/400/413、96KiB字节上限、安全错误Envelope、no-store/nosniff。
- 服务及测试定向TypeScript已通过；最终`node node_modules/typescript/bin/tsc --noEmit --incremental false`全仓通过（含客户端），无tsbuild缓存写入。
- UI受控夹具检查5个组件SSR分支、跨组织上下文保护、公开操作暂停、审核有效选项与4项时区转换断言；这些检查不计入上述26项node:test，也不代表真实浏览器操作已通过。CSS按设计使用可读主按钮、输入边框和焦点色，重要期限字号不少于14px。

PGlite并发验证单实例事务行为，不能代替真实PostgreSQL多连接、根跨模块死锁/撤权调度或真实赛事试用。未实施浏览器/实体手机/公网交互验收，也未尝试真实DSH、邮件或GitHub。

## NEEDS_INTERFACE / 根接入

1. **OrganizerPrincipal.guard真实根实现必需**：同SqlExecutor先auth_users FOR SHARE（active、已验证邮箱、当前platform_roles与捕获actor角色一致），再锁当前请求auth_sessions FOR SHARE（未撤销、未过期、userId匹配），遵循账号→会话→组织→赛事锁序。现有只查session的guard不能替代账号/admin撤权检查。适用于私有读写和消费者Port调用前后。
2. **工作人员账号选取与目标活跃状态**：根提供允许选取的`staffAccounts={userId,label}[]`，建议可信`requireActiveTarget(sql,userId)` / 受限邮箱邀请或选择Port，不公开全站用户目录或枚举私人账号。模块当前仅通过auth_users FK验证账号存在；不能私查auth表，目标账号活跃与验证状态尚需根接入。失活工作人员本人的请求仍由当前principal.guard拒绝。例如机构admin选择本站已确认同事→root校验target活跃→调用grantStaff；不能凭JSON标签自报身份。
3. **PublicationChange→O03官方通知桥**：回执含id/eventId/organizationId/version/changeSummary/createdAt，root将新版影响纳入该赛官方公告，再通过EventNotificationPort分开记录站内发布、已读、邮件queued/unconfigured/投递。模块只保存变化回执，不声明通知已发。可以用当前communication_manage读取，不开公开/GET收费或发送。
4. **我的比赛组合和真实待办**：本模块返回工作人员身份；根通过O02参与事实与O04明确指派合并当前账号身份，并提供对应模块实际待办，不能从源码存在推断报名、作品或评审完成。
5. **M03显式关联**：HostedEvent.linkedEventId暂固定null。root须可信服务器管理桥校验M03真实eventId/权限/版本后关联，不按名称推断，不允许公开JSON自报验证或写他表。
6. 根API/页面/SiteShell、auth returnTo、实际增量迁移、全站构建/重启、跨模块角色与手机验收由主会话统一完成。本模块交付不等于根已接入或公网已上线。

## 环境变量

模块本身无新增环境变量。根DatabasePort依既有数据库配置选择真实pg或单实例PGlite；不读取.env、不携带密钥、不独立启动嵌入式库。根认证/邮件/DSH等既有环境由根管理，此处不列值。

## 最终状态

服务/持久适配/HTTP/UI/SQL建议/关键测试已实现；模块26/26测试及全仓TypeScript通过。根接入、实际增量迁移、构建重启和外部真实验收未完成，由主会话统一实施。

2026-10-11已停止编辑并交还`src/modules/organizer/`与本交付文档。三个内部子代理均已完成并停止编辑，无继续占用文件；旧授权不延续。主会话可开始组合或跨模块修复。

---

# P05 · 复制赛事与配置复用（2026-10-16）

依据 [规划 33 第 5 节第 1 期](../../规划/33-主办方可用性与赛后闭环.md) 与 [P05 分项](../../规划/主办方/P05-复制赛事与配置复用.md)。**不新增迁移、不新增表、不新增状态**；`MUST NOT` 改 `src/app`、`src/server`、`src/components`、`src/shared`、`migrations`（本会话遵守，接口需求见下方 NEEDS_INTERFACE）。

## 闸门三问（宪法 XII）

1. **解决我们哪个真实问题**：主办方每办一场都要把同一套配置重填一遍（基本信息、赛道、报名表单字段、评审维度与权重、品牌、模块开关），既有 `ORGANIZER_TEMPLATES` 只给三个固定默认值，**带不走上一场实际改过的内容**。全仓 grep 无 `copyEvent`/`duplicateEvent`/`cloneEvent`，属可复现的重复劳动。
2. **会碰到哪些既有能力**：`organizer` 的模板、`createEvent`（含 `expectedOrganizationRevision` 并发校验）、`PublishedEventRevision` 不可变快照、`EventModuleFlags`；跨模块为 `event-registration` 的 `saveForm` 与 `event-judging` 的 `saveConfig`。
3. **如何避免重复入口 / 第二份事实 / 第二套写路径**（本项最重要的证据）：
   - **单一写路径**：新建 `createEventIn(sql, principal, organization, input)` 私有方法作为**唯一**写 `organizer_hosted_events` 的实现；`createEvent` 与 `duplicateEvent` 都只经它。因此不存在第二套创建逻辑，也没有新增第二个创建入口或独立页面。
   - **不改任何表结构**：无新表、无新列、无新迁移；复制只写既有表的新行。
   - **只读既有读取**：来源列表复用既有 `listOrganizationEvents`，不新增查询。

## 已实现

| 文件 | 变更 |
| --- | --- |
| `src/modules/organizer/duplicate.ts` | 新增。纯逻辑（**无 IO、无 `Date.now()`**）：`duplicateTitle`、`shiftedOccurrenceTimes`、`mergeConfiguration`、`duplicateEventIdentity`、`duplicateFormInput`、`duplicateJudgingConfigInput`、`duplicateComparison`、`parseDuplicateRequest`、`assertDuplicateSource`、`assertTemplateCompatible`、`duplicateSourceHint` |
| `src/modules/organizer/service.ts` | 抽出唯一写路径 `createEventIn`；新增 `listDuplicateSources`、`duplicateEvent`；`OrganizerServiceOptions` 新增可选 `registrationForms` / `judgingConfig` 两个 Port |
| `src/modules/organizer/handlers.ts` | 新增 `POST organizer/events/:eventId/duplicate`、`GET organizer/organizations/:organizationId/duplicate-sources`（`duplicateSources` 单独成路由型，避免与 `eventId` 型混淆） |
| `src/modules/organizer/index.ts` | 导出 P05 纯函数、类型与两个 Port |
| `src/modules/organizer/testing.ts` | 夹具新增可选 Port 与 `createEvent` 的 `overrides` 参数（仅测试用） |
| `src/modules/organizer/duplicate.test.ts` | 新增，30 项纯逻辑验收 |
| `src/modules/organizer/duplicate-service.test.ts` | 新增，20 项服务编排与真实 PGlite 事务验收 |

**复制范围**：`title`（默认 `<原名>（副本）`，同名自动加序号）、`timezone`、`modules`、`registration`、`teams`（方式与人数范围）、`summary`、`rules`、`location`、`format`、`templateKey`、报名表 `title/description/fields[]`、评审 `JudgingConfig`（含 `appealWindowDays`）。
**不复制**：`linkedEventId`、报名答卷、正式队伍、通知与已读、评审轮次/指派/评分、申诉、审计、`publishedRevision`、发布历史。

## ⚠️ 与 P05 第 3 节的一处必要偏离（请主会话裁定）

P05 原文要求"**不复制时间字段**（`startsAt`/`endsAt`/`registrationOpensAt`/`registrationClosesAt`/`submissionClosesAt`/`teams.locksAt`）"。**实现改为"平移时间结构"**，理由是类型与行为的硬约束：

- `HostedEventScope` 的 `startsAt`/`endsAt` 在 `src/shared/organizer-contracts.ts` 中**是非空的 `Instant`**；`v.configuration` 也要求这两个时刻有效。若复制出的草稿带空时刻，会得到一个**类型上不可达**、且 `publishEvent` 会拿无效日期做比较的赛事（`blockers`/`preview`/`publicPublish` 都假定时间有效）。
- 因此 `shiftedOccurrenceTimes(source, now)` 保留来源的**时间结构与各截止的相对位置**，整体平移到现在：`startsAt = now`，`endsAt = now + 来源跨度`，其余四个截止按**相对 `startsAt` 的偏移**平移。
- **不沿用上一届的绝对日期**（这是"不继承时间"要避免的事，已有测试断言 `notEqual(coppied, source)`）；**报名窗口/作品截止/队伍锁定相对开赛的位置逐项保持不变**（有测试断言）。
- 副作用：副本可以立即编辑与发布，不会出现"打不开的草稿"。主办方在 `publishEvent` 前仍需确认每个时刻（发布快照会锁定它们）。
- **若要严格留空**，需先由主会话把 `HostedEventScope.startsAt/endsAt` 改为可空，并同步 `blockers`/`preview`/`publicProjection`/`publishEvent` 的空值分支——这超出本次文件范围，故未做。

这一偏离已在 `duplicate.ts` 的 `shiftedOccurrenceTimes` 注释与 `duplicate.test.ts` 中显式登记，不是静默改需求。

## 已隔离验证

命令与真实结果：

```
node --experimental-strip-types --test src/modules/organizer/duplicate.test.ts          # 30/30 通过
node --experimental-strip-types --test src/modules/organizer/duplicate-service.test.ts  # 20/20 通过
node --experimental-strip-types --test src/modules/organizer/*.test.ts                  # 91/91 通过（10 suites）
node node_modules/typescript/bin/tsc --noEmit --incremental false                       # 全仓通过，无输出
```

覆盖 P05 第 6 节全部验收项：

| 验收项 | 覆盖方式 |
| --- | --- |
| 独立可编辑 | 复制后走既有 `updateEvent` 改名成功（`revision` 1→2），且来源不受影响 |
| 来源逐字段不变 | 复制前后对比库里 `document` 的深比较，`status`/`published_revision` 也不变 |
| 任一步失败不新增赛事（事务回滚） | 报名表 `saveForm` 抛错 → 赛事数/审计数均不变且不继续写评审；评审 `saveConfig` 抛错 → 赛事数、发布变化数不变，**机构 revision 也回滚** |
| **只有既有 createEvent 一处写路径** | `createEventIn` 是唯一写 `organizer_hosted_events` 的实现，`createEvent` 与 `duplicateEvent` 共用 |
| 时间未沿用 | 四个时间字段 `notEqual` 来源；跨度与各截止相对位置 `equal` |
| 跨机构拒绝 | 另一机构管理员复制 → 403/404，且赛事数不变 |
| 并发版本冲突保留输入 | 过期 `expectedOrganizationRevision` → `ORGANIZER_REVISION_CONFLICT` 且带 `latestRevision`，赛事数不变 |
| 新赛事 `status=draft` 且 `publishedRevision=null` | 直接断言，并验证 `getManagedEvent` 可读（草稿没有被公开） |
| 不继承 `linkedEventId` | 来源有 `discovery-1` 时副本仍为 `null` |
| 结构性排除运行数据 | 断言副本字段集不含 `answers`/`roster`/`notifications`/`rounds`/`scores`/`appeals`/`audits` 等 |
| 同事务同执行器 | 断言两个 Port 收到**同一个** `SqlExecutor`，且都写**新赛事** id、`expectedRevision` 均为 0 |
| 如实说明未复制项 | 来源未配置时 `skipped` 写明原因；未注入 Port 时写明「未接入」；未启用模块时 `skipped` 为空且不调用 Port |
| 对照表措辞 | 断言不含「完成度/百分比/推荐/最佳/一键/进度」 |

**测试过程中发现并绕开的一处异常（如实登记，未定位根因）**：在 `organizerFixture` 夹具中，**同一测试内第二次调用 `f.service.createEvent(...)` 会抛 `ORGANIZER_FORBIDDEN`**，而首次调用成功；用 `ORG_DEBUG` 临时插桩发现失败那次进入 `authenticated` 时 `typeof principal.guard === "undefined"`，但调用方传入的对象**确实带有 `guard` 函数**（插桩已全部移除，`service.ts` 已核对干净）。该现象在**未修改的既有 17 项 `service.test.ts` 中不出现**（那些用例每个只建一场或走夹具 helper），因此**判断为夹具/调用上下文问题，不是 P05 引入的回归**；本次通过给夹具 `createEvent` 增加 `overrides` 参数绕过，未改动任何既有代码路径。**建议主会话复核**：若该现象在真实根组合下也成立，则是一个独立的既有缺陷（影响"同一会话连建两场"）。

PGlite 单实例事务不能代替线上多连接 PostgreSQL 的并发与保存点行为；本会话未打开实际库、未迁移、未构建、未重启。

## NEEDS_INTERFACE / 根接入

1. **注入 P05 的两个跨模块 Port**（核心接线，缺省时复制会**如实跳过**并在 `skipped` 写明「未接入」，不会失败也不会假装成功）：

```ts
import { createOrganizerService } from "./index.ts";
const organizer = createOrganizerService({
  database, clock, ids,
  registrationForms: {
    getForm: (sql, eventId) => registration.getConfiguredForm(sql, eventId),   // 已存在，签名即 (sql, eventId)
    saveForm: (sql, principal, eventId, input) => registration.saveFormIn(sql, principal, eventId, input),
  },
  judgingConfig: {
    getConfig: (sql, eventId) => judging.getConfigIn(sql, eventId),
    saveConfig: (sql, principal, eventId, input) => judging.saveConfigIn(sql, principal, eventId, input),
  },
});
```

**契约**：两个 Port 的每个方法都接收**当前事务的 `SqlExecutor`**，实现方 `MUST` 只使用传入的 `sql`（不自己开事务/连接），否则三步不在同一事务里，第 3 节的事务回滚保证失效。
**当前缺口**：`event-registration.getConfiguredForm` 已满足 `getForm`；但 `saveForm` 现有公开签名是 `saveForm(principal, eventId, input)`（自开事务），**需要一个接收 `sql` 的变体** `saveFormIn(sql, principal, eventId, input)`。`event-judging` 侧 `getConfig`/`saveConfigIn` 同样需要新增（`saveConfig` 现为 `service.saveConfig(principal, eventId, {roundId?, expectedRevision, config})`，新建轮次时 `expectedRevision: 0`，读侧可用 `workspace()` 的 `rounds[0].config`）。**这两处属于其他模块的文件范围，本会话未修改**，请在根组合时补齐或转相应会话。
2. **注册路由**（`src/server/organizer-integration.ts`）：`organizerHttpRoute` 已能解析 `organizer/events/:id/duplicate`、`organizer/organizations/:id/duplicate-sources`；确认根的路由表已调用本模块 `organizerHttpRoute` 即无须额外改动。两个都是私有路由（POST 需 Origin/CSRF；GET 需登录）。
3. **界面接入**（`src/components/competition-workspace.tsx` 与 `src/modules/organizer/OrganizerWorkspace.tsx`——**均超出本会话范围**）：按 [布局规划 5.8 节](../../设计/主办方工作台布局.md) 在模板选择卡下方加"复制上一场"入口：一个 `.secondary` 按钮 → 展开面板（来源 `<select>` + `duplicateComparison()` 的"将复制 / 不复制"双列对照 + **唯一** `.primary` "以它为起点创建草稿"）。**不新建独立页面或导航。**
4. **无新增迁移、无新增环境变量。** `duplicateEvent` 只写既有 `organizer_hosted_events` / `organizer_audit_events` / `organizer_organizations`（推进机构 revision，与 `grantStaff`/`revokeStaff` 同口径）。
5. 根仍需按既有 NEEDS_INTERFACE 第 1 项提供真实 `OrganizerPrincipal.guard`；P05 未新增或放宽任何权限判定。

## P05 环境变量

无新增。模块仍不读取 `.env`、不携带密钥。

---

# P07 · 数据看板下钻（2026-10-16）

依据 [规划 33 第 5 节第 3 期](../../规划/33-主办方可用性与赛后闭环.md)、[P07 分项](../../规划/主办方/P07-数据看板下钻.md)、[设计 §5.2、§7](../../设计/主办方工作台设计.md) 与 [布局 §3.3、§5.6、§9](../../设计/主办方工作台布局.md)。本会话只改 `src/modules/organizer/`（新增 `dashboard.ts`、`dashboard.test.ts`，增量改 `service.ts`、`handlers.ts`、`index.ts`、`README.md`）与本交付文档；**未改** `OrganizerWorkspace.tsx`（P05 会话正在为界面接线）、`src/app`、`src/server`、`src/shared`、`src/components`、`migrations` 或任何其他模块；未 build、未重启、未迁移、未安装依赖、未跑 git 写操作。

## 闸门三问（宪法 XII）

1. **解决我们哪个真实问题**：工作台与各 section 页的计数停在“总数”，主办方拿不到“哪个赛道提交少 / 哪些队伍还没收件 / 哪位评委还没交 / 报名的时间趋势 / 后勤还有多少人没安排”这类**筛选后**的答案。这些读数**都已在既有模块里**，缺口是聚合与下钻视图，不是新事实。
2. **会碰到哪些既有能力**：`event-registration` 的 `registrationCounts()` 与 `listStaff()`/`listStaffTeams()`；`event-judging` 的 `workspace()` 与 P06 的 `progress()`；`event-communication` 的 `listAccommodation()`/`listVouchers()` 与 `getScheduleDraft()`；`organizer` 的机构/赛事授权（`OrganizerPrincipal` + `eventAccess`）。
3. **如何避免重复入口 / 第二份事实 / 第二套写路径**：决定只做**既有事实的筛选与下钻**。MUST NOT 出预测、成功率、影响力/ROI、跨赛事优劣排名、给队伍或评委打综合分；每个数字都带**统计口径、统计范围与数据时间**；undefined（未读取）MUST NOT 显示为 0，空值写“未提供”；**不新增表、不建宽表/物化视图、不新增一级导航、不新增写路径**。

## 已实现

| 文件 | 变更 |
| --- | --- |
| `src/modules/organizer/dashboard.ts` | 新增。纯函数（**无 IO、无 Date.now()、无随机**）：`parseDashboardFilter`、`registrationPanel`、`teamPanel`、`intakePanel`、`judgingPanel`、`logisticsPanel`、`buildDashboard` 与全部类型。 |
| `src/modules/organizer/service.ts` | 新增只读 `dashboard(principal, eventId, filter)`；新增注入式只读 Port `OrganizerDashboardPort` 与 `OrganizerServiceOptions.dashboard`。 |
| `src/modules/organizer/handlers.ts` | 新增 `GET organizer/events/:eventId/dashboard`：route kind `dashboard`、methods 只允许 GET、查询串经 `parseDashboardFilter` 解析。 |
| `src/modules/organizer/index.ts` | 导出 P07 纯函数、类型与 `OrganizerDashboardPort`。 |
| `src/modules/organizer/README.md` | 增补 P07 Port 契约、方法表与 HTTP 表一行。 |
| `src/modules/organizer/dashboard.test.ts` | 新增，21 项（纯函数 16、服务 4、HTTP 1，见下）。 |

`model.ts` 未改动：P07 的类型全部是派生视图类型，集中在 `dashboard.ts` 并由 `index.ts` 再导出，不混入持久化模型。

**面板与下钻维度**：

| 面板 | 所需 capability | 下钻维度 | 数字口径 |
| --- | --- | --- | --- |
| 报名 | `registration_manage` | 状态、时间区间、赛道（来自报名者当前所属正式队伍） | 状态计数**原样取** `registrationCounts()`；筛选结果只数本次读取到的一页 |
| 队伍 | `teams_manage` | 赛道、状态 | 队伍数/成员齐备/已锁定/队员合计/已收件/已关联空间；人数与赛道分布为分组计数 |
| 收件 | `judging_manage` | 赛道、时间区间 | 每队取 `workspace().submissions` 中版本号最新的一版；“未交件”按当前队伍集合；“材料过薄”＝最新一版既无链接也无文件（显式事实，不是质量评分） |
| 评审 | `judging_manage` | 轮次 | 轮次数与已公布轮次取 `workspace().rounds`；本轮冻结作品/尚未收齐/已提交有效评分/有效指派/最少评委**原样取** `progress()` |
| 后勤 | `schedule_manage` 或 `logistics_manage` | 住宿、餐券、行程 | 住宿取 `listAccommodation()`；餐券取 `listVouchers()`；“未分配住宿”以已通过报名为分母；行程覆盖按 `getScheduleDraft()` 的适用范围与已通过报名取交集 |

**未读取的区分**：每个指标是 `{ value: number | undefined, definition, scope, readAt }`；未读取时 `value === undefined`（JSON 序列化后 `value` 键缺失），界面据此显示“未提供”，**绝不补 0**；真实 0 保留为 `0`（测试断言 `0 !== undefined`）。行内空值用 `null` 表示“未提供/不适用”，不写空字符串占位。

**已知偏离（如实登记）**：报名记录本身**没有赛道字段**（赛道是 `RosterTeam.track`）。因此“报名按赛道”实现为**按报名者当前所属正式队伍（不含已撤回队伍）的赛道筛选**，并在口径里写明；未读取队伍时该筛选显式不可用（`available:false`），不会静默放宽。

## 端点契约

`GET /api/v1/organizer/events/:eventId/dashboard`（**仅 GET**；无请求体）。

- 查询串（都可选）：`panel`（registration/teams/intake/judging/logistics）、`status`（5 种报名状态）、`track`、`from`、`to`（带时区 ISO 8601）、`roundId`、`cursor`、`limit`（1–100，默认 50，>100 截断）。非法值返回 **422** `DASHBOARD_FILTER_INVALID`，不静默忽略。
- 权限：当前账号必须对本场 `canView`（staff 且机构 approved、赛事非 archived）；只返回**具备对应 capability** 的面板；显式请求无权面板返回 **403** `ORGANIZER_FORBIDDEN`；跨机构/不可见赛事 403；匿名 401（由根 `authenticate` 给出）。
- 响应：`{ data: DashboardView, requestId }`；`DashboardView = { eventId, eventTitle, scope, readAt, filter, panels }`。`readAt` 来自注入 `Clock`，是所有指标的数据时间。
- 只读：GET 不触发采集、模型、通知或任何写入；无审计、无 revision 变更。

## 根无需改动（已核实）

1. `organizerHttpRoute(["organizer","events",eventId,"dashboard"])` 已返回 `{ kind: "dashboard", eventId }`（只需在既有 actions 映射里登记，未新增路由族）。
2. 根 `src/server/organizer-integration.ts` 的 `match()` 顺序是 REGISTRATION_ROUTES → JUDGING_ROUTES → `eventCommunicationHttpRoute` → `organizerHttpRoute`；`eventCommunicationHttpRoute(["organizer","events","e","dashboard"]) === null`（测试断言），`organizer/events/:id/dashboard` 不在 registration/judging 的既有正则内；因此**根不需要新增或修改路由**，现有 `handle()` 最后一步即可命中。
3. 根 `createOrganizerIntegration` 已 `await organizerHandlers.handle(request, organizerRoute)`，所以新增 kind 自动生效。本会话**未改根文件**。

## NEEDS_INTERFACE / 根接入

1. **注入 P07 的只读 Port**（唯一接线；缺省时对应面板如实显示“未读取/未提供”，不失败也不假装成功）：

~~~ts
const organizer = createOrganizerService({
  database, clock, ids, repository,
  dashboard: {
    registrationCounts: (principal, eventId) =>
      registration.registrationCounts(principal, eventId),                        // 既有签名即 (principal, eventId)
    registrations: async (principal, eventId, options) =>
      (await registration.listStaff(principal, eventId, options)).registrations,   // 既有 listStaff 的 Page<Registration>
    teams: async (principal, eventId, options) =>
      (await registration.listStaffTeams(principal, eventId, options)).teams,      // 既有 listStaffTeams 的 Page<RosterTeam>
    judgingWorkspace: (principal, eventId) => judging.workspace(principal, eventId), // rounds/submissions 直接透传
    judgingProgress: (principal, eventId, roundId) => judging.progress(principal, eventId, roundId),
    accommodation: (principal, eventId) => logistics.listAccommodation(principal, eventId),
    vouchers: (principal, eventId) => logistics.listVouchers(principal, eventId),
    scheduleDraft: (principal, eventId) => schedule.getScheduleDraft(principal, eventId),
  },
});
~~~

**契约**：Port 的每个方法都只是**对应既有读路径的转发**，实现方 MUST NOT 另写查询或另算口径；`OrganizerDashboardPort` 的方法全部可选，根可分批接线。Port 只在 organizer 已完成 `canView` 与 capability 判定后才会被调用；被转发的方法各自沿用原本的 capability（registration_manage/teams_manage/judging_manage/logistics_manage/schedule_manage），两边同名，不会放宽权限。`judgingProgress` 依赖 P06 的 `progress()`（已交付）。

2. **界面接入（超出本会话文件范围）**：按 [布局 §3.3 第 ⑤ 块](../../设计/主办方工作台布局.md) 把看板挂在**本场概览/各 section 既有区块内**，用**筛选页签**（报名/队伍/收件/评审/后勤）而不是一级导航；每块标统计范围与数据时间；undefined 显示“未提供”、空值不补占位；每页仍只有一个 `.primary`。本会话**禁止修改 `OrganizerWorkspace.tsx`**，故未接线。

3. **无新增迁移、无新增环境变量、无新增表/列。**

## 没有新增第二套入口 / 第二份状态 / 第二套写路径（证据）

- **入口**：全模块只新增 `organizerHttpRoute` 中 `organizer/events/:eventId/dashboard` 一个 kind；`methods.dashboard === ["GET"]`，POST/PATCH 返回 405（测试断言 `Allow: GET` 且不触达 `authenticate`）。未新增页面、未新增导航、未新增路由族；与 `event-communication` 的既有路由族经测试证明不冲突。
- **状态/事实**：`dashboard.ts` 不落任何状态，输入是各模块已读到的行；输出是 `{ readAt, filter, panels }` 的派生视图。无新表、无新列、无 migration、无宽表/物化视图。
- **写路径**：`service.dashboard` 只调用 `lockedEvent`/`listGrants`（读）与注入 Port（只读），**不调用任何 insert/save/audit**；服务测试把 `insertEvent`/`saveEvent`/`insertGrant`/`audit` 桩成“调用即抛错”，看板仍通过。GET 分支在 handler 中不经过 `authorizeMutation`（测试断言 mutation 调用数为 0）。
- **数字不是另算一套**：报名状态计数直接取 `registrationCounts()`；本轮评审数字直接取 `progress()`；队伍/收件/后勤数字来自既有分页与既有读方法的原样输出；纯函数只做筛选与计数。

## 已隔离验证

命令与真实结果：

~~~
node --experimental-strip-types --test src/modules/organizer/dashboard.test.ts   # 21/21 通过
$f = Get-ChildItem src/modules/organizer -Filter *.test.ts | % FullName; node --experimental-strip-types --test $f   # 112/112 通过（10 suites）
node node_modules/typescript/bin/tsc --noEmit --incremental false                # exit 0，无输出
~~~

覆盖 P07 第 6 节验收项：

| 验收项 | 覆盖方式 |
| --- | --- |
| 数字一致 | 报名 5 个状态计数逐一 `=== REG_COUNTS`；评审 7 个数字逐一 `=== progress()`；服务层再断言 Port 与视图相等 |
| 未读取 ≠ 0 | 未注入 Port/未读取时 `value === undefined` 且 `!== 0`；JSON 后 `value` 键缺失；真实 0 保留 |
| 空值不补 | 行内 `null` 表示“未提供”；未交队伍/未分配住宿只列已读到的事实，不补占位 |
| 无预测文案 | `buildDashboard` 全量 JSON 断言不含“预测/成功率/影响力/ROI/最佳/排名” |
| 权限 | 只有 `teams_manage` 时仅返回队伍面板；请求报名/评审面板 403；归档赛事 403 |
| 只读 | 写方法桩为抛错；handler GET 的 `authorizeMutation` 调用数为 0；无 INSERT/UPDATE |
| 排序 | 队伍按成员数、报名按提交时间、评委按还差数，均不按分数；同值按标识 |
| 首屏 | 不新增页面与一级导航；UI 接入建议见上（本会话未改界面文件） |

隔离测试不能代替线上 PostgreSQL 多连接与真实浏览器走查；本会话未打开实际库、未迁移、未构建、未重启。

## 明确不做

预测、成功率、“影响力/ROI”、成果转化预估、跨赛事优劣排名、给队伍或评委打综合分、为看板新建宽表/物化视图/第二份计数、新增一级导航或第二个工作台、把看板做成公开页面、用模型生成“分析结论”。

---

# P3 · 工作人员受限邀请（2026-10-16）

依据 [规划 34 第 1 节 A](../../规划/34-主办方模块化与选手社区.md)、[宪法 v1.23.0 原则 XIII「工作人员受限邀请」](../../../.specify/memory/constitution.md)。本会话只改 `src/modules/organizer/`（新增 `invitations.ts`、`invitations.test.ts`、`migrations/002-staff-invitations.sql`，增量改 `model.ts`、`service.ts`、`handlers.ts`、`validation.ts`、`postgres.ts`、`index.ts`、`testing.ts`、`README.md`）与本交付文档；**未改** `src/app`、`src/server`、`src/components`、`src/shared`、根 `migrations` 或任何其他模块。未 build、未迁移、未重启、未安装依赖、未跑 git 写操作。

## 吸收闸门三问（宪法 XII）

1. **解决我们哪个真实问题**：主办方要指定"模块负责人"时，既有 `grantStaff` 要求管理员**手输账号标识**，机构外的人无法自助入驻，于是现实里最省事的做法是"发一条链接点开就给权限"。规划明确裁定这种**"点开即授权"必须取消**，但没有受限邀请机制就没有可替代的合规路径——这是"想授权同事"与"不能无限期裸链接"之间的真实摩擦。
2. **会碰到哪些既有能力**：`OrganizerService.grantStaff` / `revokeStaff`（组织 revision、active grant 唯一索引、最后一名机构管理员保护）、`organizer_audit_events`（不可变审计）、`EVENT_STAFF_CAPABILITIES`（既有 7 类能力枚举）、根 `OrganizerPrincipal.guard` 与 `auth_users.email_verified_at`。
3. **如何避免重复入口 / 第二份事实 / 第二套写路径**（本项最重要的证据）：
   - **第二套写路径**：把既有 grant 写入抽成**唯一私有实现** `writeStaffGrant(sql, organization, fields)`；`grantStaff` 与邀请领取**都只经它**写 `organizer_staff_grants`。事件范围校验、active grant 重复检查、组织 revision 推进、FK 错误中文映射全部与原来逐字一致；邀请领取不可能绕过任何一条既有规则。
   - **第二份权限事实 / 第二份权限枚举**：没有新增权限表或权限列。邀请表只存**意图**（机构/赛事/角色/能力/期限/绑定邮箱），任何权限判定（`hasCapability` / `canView` / `requireStaff`）**只读 `organizer_staff_grants`**。测试断言：仅持有一份 open 邀请的账号 `getManagedEvent` / `listPublicationChanges` 仍 403、`listCompetitionIdentities` 为空；领取后同一路径立即按既有规则放行。能力取值仍来自 `EVENT_STAFF_CAPABILITIES`（测试断言 `organization_admin` 邀请领取后能力集合与排序完全等于该常量）。
   - **第二套入口 / 第二套状态**：只在既有 `organizerHttpRoute` 增加 4 个 kind，不新增页面、不新增一级导航、不新增路由族；邀请状态不新增"完成度/阶段"那类事实——`status` 只落 `open|claimed|revoked`，`expired` 由 `expiresAt` 派生。

## 硬性规则逐条落地（宪法 XIII）

| 规则 | 实现 | 断言位置 |
| --- | --- | --- |
| 单次使用 | 领取在机构锁后对邀请行 `FOR UPDATE`；状态非 `open` 一律明确报错 | "单次使用" 用例（第二次 409，grant 不增加） |
| 有有效期（默认 7 天、上限 30 天） | `expiresInDays` 缺省 7，`integer(...,1,30)` | "默认 7 天、上限 30 天" 用例（0/31/1.5/"7"/null 全拒） |
| 可撤销 | `revokeStaffInvitation` 只撤 `open`；`expectedRevision` 并发校验 | "撤销后不可领" 用例 |
| 可绑定指定邮箱 | `boundEmail` 可选，校验邮箱格式并转小写 | 邮箱用例 |
| 只存 `token_hash`（sha256），原文只在创建响应返回一次 | `mintInvitationToken()`→`hashInvitationToken()`；视图由**显式字段**构造，绝不展开记录 | 直接查库断言 `token_hash === sha256(token)`；列表/预览/领取 JSON 均不含 token 与 `tokenHash` |
| 列表/详情不返回 token | `StaffInvitationView` / `StaffInvitationPreview` 无 token/tokenHash 字段 | 同上 |
| 领取必须已登录且邮箱已验证 | `authenticated` + 注入 `OrganizerAccountEmailPort.readVerifiedEmail`；未验证→403，未接入→503 失败关闭 | "未验证邮箱" / "根未接入" 用例 |
| 绑定邮箱必须与领取账号一致 | 大小写归一后比较，不符→403 | 邮箱用例（含一致成功、Case 无关） |
| 领取只写既有 `StaffGrant`，走既有 grant 写路径与组织 revision 校验 | 唯一 `writeStaffGrant` + `saveOrganization(revision+1)` | "恰好一条 StaffGrant / 机构 revision 只推进一次" 用例（逐表计数 + 机构逐字段） |
| 不新增第二套权限事实 | 权限判定只读 `organizer_staff_grants` | "未领取的邀请不产生任何权限" 用例 |
| `organization_admin` 邀请只能由当前机构管理员创建 | `createStaffInvitation` 首步 `organizationAdmin` | "organization_admin 邀请只能由当前机构管理员创建" 用例（staff/ownerB/admin/reviewer 全拒） |
| 不绕过"最后一名机构管理员不可撤销" | 领取写真实 admin grant，既有 `revokeStaff` 保护不变 | "领取后计入既有最后一名管理员保护" 用例 |
| 过期/已领取/已撤销/邮箱不符明确错误码 | 各自独立 code（见下） | 各用例 |
| 创建、领取、撤销都写既有不可变审计 | `staff_invitation_created` / `_claimed` / `_revoked` 写入 `organizer_audit_events` | "审计条数" 用例（GROUP BY 精确计数 + UPDATE 触发 23514） |

## 端点与错误码契约

路径相对 `/api/v1`；GET 无 body，POST 为 JSON（沿用既有 96KiB/Content-Type/Origin 规则），成功 `{data,requestId}`。

| 方法 / 路径 | body | data / 权限 |
| --- | --- | --- |
| `GET organizer/organizations/:organizationId/staff-invitations` | — | `StaffInvitationView[]` / **机构管理员**（含领取人与时间，不含 token） |
| `POST organizer/organizations/:organizationId/staff-invitations` | `{role, capabilities, eventId?, expiresInDays?, boundEmail?, note?}` | `{invitation: StaffInvitationView, token: string}` / **机构管理员**；token 只此一次 |
| `POST organizer/staff-invitations/:invitationId/revoke` | `{expectedRevision}` | `StaffInvitationView` / **机构管理员** |
| `GET my/staff-invitations/:token` | — | `StaffInvitationPreview` / 任意**已登录** |
| `POST my/staff-invitations/:token/claim` | （不读字段；身份只来自当前 principal） | `{invitation: StaffInvitationPreview, grant: StaffGrant}` / 已登录 + 邮箱已验证 + 绑定邮箱一致 |

错误码（均不静默）：`ORGANIZER_INVITATION_NOT_FOUND`（沿用既有 `ORGANIZER_NOT_FOUND`，非法/未知 token 一律 404，不泄露存在性）、`ORGANIZER_INVITATION_CLAIMED` 409、`ORGANIZER_INVITATION_REVOKED` 409、`ORGANIZER_INVITATION_EXPIRED` **410**、`ORGANIZER_INVITATION_EMAIL_UNVERIFIED` 403、`ORGANIZER_INVITATION_EMAIL_MISMATCH` 403、`ORGANIZER_INVITATION_UNAVAILABLE` 503（邮箱 Port 未接入，失败关闭）、`ORGANIZER_FORBIDDEN` 403（非机构管理员 / 跨机构赛事 / 机构不可用）、`ORGANIZER_INPUT_INVALID` 422、`ORGANIZER_REVISION_CONFLICT` 409（撤销）、`ORGANIZER_GRANT_EXISTS` 409（领取人已有同范围 active grant，事务回滚、邀请保持 open）。

## 三处显式设计选择（如实登记）

1. **`expired` 派生而不落库**：迁移只允许 `status IN ('open','claimed','revoked')`，`expired` 由 `expiresAt <= now` 在读取时判定。理由：落库需要后台任务翻转状态，会出现"过期列没来得及改"的第二份事实（宪法 X 不允许把未知显示成成功）；派生是精确且无状态漂移的。规划 §1.3 的 `status open|claimed|revoked|expired` 因此在**接口视图上**完整，在**存储上**只留前三个。
2. **不设 `max_uses` 列**：单次使用由"机构锁 + 邀请行 `FOR UPDATE` + 状态机"结构性保证，加一个恒为 1 的列反而是会漂移的第二事实。规划 §1.3 的 `max_uses=1` 语义已由上述机制覆盖。
3. **绑定邮箱在领取预览里只显示掩码**（`a***@域名`）与 `emailBound: true`：持链接者需要知道"这份邀请绑了邮箱"，但转发者不应因此看到目标邮箱原文。

## 绝对没有第二套授权事实 / 第二套权限枚举（证据）

- **唯一写路径（就授权入口而言，且如实说明既有例外）**：`grep insertGrant src/modules/organizer` 只有两处调用——`writeStaffGrant`（`grantStaff` 与 `claimStaffInvitation` 共用）与 `reviewApplication` 里**既有未改动**的"机构首次批准时给 owner 建一条 admin grant"引导写入。邀请领取**只**走 `writeStaffGrant`，没有第三种写入口，也没有为邀请新开的写路径；`reviewApplication` 的那一处与本次改动无关、行为逐字未变。
- **唯一读取路径**：权限判定 `hasCapability` / `canView` / `requireStaff` 只读 `repository.listGrants`；邀请表从不参与授权判定（测试断言"未领取不产生权限"）。
- **唯一权限枚举**：`capabilities` 校验与 DB `CHECK` 都取自 `EVENT_STAFF_CAPABILITIES`；邀请表的能力列使用与 `organizer_staff_grants` **同一** `<@ ARRAY[...]` 约束。
- **唯一审计**：全部写入既有 `organizer_audit_events`（不可变 trigger 未改，测试断言 UPDATE 被 23514 拒绝）。
- **机构 revision 语义不变**：领取与 `grantStaff` 一样**只推进一次**机构 revision；邀请的创建/撤销不改机构权限事实，因此不推进机构 revision（有独立 `revision` 做并发校验）。

## 已隔离验证

命令与真实结果：

```
node --experimental-strip-types --test src/modules/organizer/invitations.test.ts   # 18/18 通过
$f = Get-ChildItem src/modules/organizer -Filter *.test.ts | % FullName; node --experimental-strip-types --test $f
                                                                                     # 130/130 通过（10 suites；既有 112 项未被破坏）
node node_modules/typescript/bin/tsc --noEmit --incremental false                   # 见下：本模块 0 条诊断
```

`tsc` 原文（exit 1）：

```
src/modules/event-community/handlers.ts(58,88): error TS2345: Argument of type 'Promise<string>' is not assignable to parameter of type 'string'.
src/modules/event-community/handlers.ts(60,92): error TS2345: Argument of type 'Promise<string>' is not assignable to parameter of type 'string'.
src/modules/event-community/ui.ts(3,87): error TS2307: Cannot find module './CommunityPanels.tsx' or its corresponding type declarations.
src/modules/event-community/ui.ts(4,107): error TS2307: Cannot find module './CommunityPanels.tsx' or its corresponding type declarations.
```

4 条全部位于 `src/modules/event-community/`（另一会话正在写的规划 34 P1 模块，缺 `CommunityPanels.tsx`），**与本模块无关**；`src/modules/organizer/` 诊断 0 条。按仓库纪律只报告、不越界修改。

未覆盖项：PGlite 单实例事务不能代替线上 PostgreSQL 多连接并发（尤其是两人同时用同一 token 领取时的 `FOR UPDATE` 争用）；本会话未打开实际库、未迁移、未 build、未重启。

## NEEDS_INTERFACE / 根接入

1. **【必须】注入领取用的账号邮箱 Port**（唯一新增接口；缺省时领取 503，其余邀请能力照常）：

```ts
const organizer = createOrganizerService({
  database, clock, ids,
  accountEmails: {
    // 只读 auth_users：status='active' AND email_verified_at IS NOT NULL；只使用传入的 sql（同事务）。
    readVerifiedEmail: async (sql, userId) => {
      const row = (await sql.query<{ email: string }>(
        "SELECT email FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR SHARE", [userId])).rows[0];
      return row ? { email: row.email } : null;
    },
  },
});
```

**契约**：实现方 MUST 只使用传入的 `sql`（不开新事务/连接），返回 `null` 表示不存在/未激活/未验证。根已有 `requireActiveTarget(sql,userId)`（`src/server/organizer-integration.ts`）做同类校验但不返回邮箱，因此需新增这一个返回 `{email}` 的只读方法；**这是"领取时的活跃账号校验是否需要根 Port"的答案：需要**，且必须是**返回邮箱**的 Port，否则无法实现"绑定邮箱必须一致"。

2. **注册路由：根无需改动（已核实）**。`organizerHttpRoute` 已能解析下列 5 条路径；根 `src/server/organizer-integration.ts` 的 `match()` 顺序是 REGISTRATION_ROUTES → JUDGING_ROUTES → CLOSURE_ROUTES → `eventCommunicationHttpRoute` → `organizerHttpRoute`，而 `organizer/.../staff-invitations`、`my/staff-invitations/:token`、`.../claim` 不与前四者任一正则匹配（registration/judging 用 `organizer/events/...` 与 `competitions/...`；recruiting 用 `me/...` 而非 `my/...`），因此现有 `match()` 末步即可命中，**不需要新增或修改根路由**。POST 由根 `handle()` 与 handler 双重 `authorizeMutation`（既有 WeakSet 幂等）覆盖。
3. **迁移建议编号**：`src/modules/organizer/migrations/002-staff-invitations.sql`，请根分配**下一个连续编号**（根 migrations 现到 072；本会话未创建根迁移文件）。该迁移只建 1 张新表 `organizer_staff_invitations` + 2 个索引，引用既有 `organizer_organizations(id)`、`organizer_hosted_events(id,organization_id)` 与 `auth_users(id)`；无触发器（邀请状态可变），无既有表改动。
4. **界面落点（超出本会话范围）**：按 [布局规划](../../设计/主办方工作台布局.md) 在**比赛设置 → 工作人员与授权**折叠区内加"生成邀请"面板：能力多选（既有 7 类）、范围（本组织全部比赛 / 指定一场）、角色（staff / organization_admin）、有效期天数（默认 7、上限 30）、可选绑定邮箱、备注；生成后**只显示一次**完整链接（`/my/staff-invitations/<token>`，QR 由根渲染）；下方是邀请状态列表（未被领取 / 已过期 / 已撤销 / 已被谁在何时领取），可撤销。领取页 `/my/staff-invitations/<token>` 明确展示机构、比赛、能力、角色、有效期、绑定邮箱掩码，并要求"接受邀请"后才 POST claim；**不新建一级导航**。`mintInvitationToken` 的原文 token 由创建响应给出，界面 MUST NOT 落库或写进审计。
5. **无需新增环境变量。**

## P3 明确不做

打开链接即获得权限、免登录领取、永久有效链接、把 token 原文或 sha256 存进客户端可读日志/审计、为邀请另建权限表或权限枚举、让邀请绕过 `writeStaffGrant`、用平台角色（admin/reviewer）代替机构管理员生成邀请、给已领取的邀请"改绑邮箱"或"延期"（要改就撤销后重发）。


---

# P4 赛事级模块助手开关（规划34 §2.1 / §5.1；宪法 XIII）

日期：2026-10-16。独占范围：`src/modules/organizer/`（含新增 `migrations/003-assistant-switches.sql`、`assistant-switches.test.ts`、`README.md`）与本节。**未改** `src/app`/`src/server`/`src/components`/`src/shared`/根 `migrations/`/`src/modules/module-assistants/` 及其他模块；未 build、未迁移、未重启、未 npm install、未做任何 git 写操作。

## 吸收闸门三问

1. **解决我们哪个真实问题**：规划34 §2.1 的 7 个流程模块助手已经在 `module-assistants` 注册表里，但"**某一场**比赛的某个模块要不要开助手"没有任何赛事级落点。用户裁定"所有跟主办方有关的都在工作台里可单独配置"，而 §5.1 又把助手开关定为**内部运营项（默认全开、即时生效、写审计、不随发布冻结）**。不做这一步只剩两种坏选择：全平台统一开（无法按场关闭），或把开关塞进 `EventCommunityConfig`（会随发布版本冻结，与 §5.1 的分野直接冲突）。
2. **与哪些既有能力冲突**：不与 `EventModuleFlags`（报名/队伍/破冰/评审/行程/住宿/餐券，随发布冻结）、`EventCommunityConfig`（面向选手的社区能力，随发布冻结）、`module-assistants` 注册表（助手的身份/所需 capability/可读事实键/允许产出）冲突。本模块只新增**一个**此前不存在的赛事级事实：`(event_id, assistant_key) → enabled`。
3. **如何避免重复入口 / 第二份事实 / 第二套写路径**：
   - **一个入口**：只在 `organizerHttpRoute` 增加 `organizer/events/:eventId/module-assistant-switches` 一条路径，不新增页面、不新增一级导航、不新增路由族。
   - **没有第二份事实**：key 清单仍只属于 `module-assistants` 注册表，本模块**不硬编码、不复制**；开关不落进赛事配置/发布快照；`document` 与索引列由 CHECK 绑成同一份事实。
   - **没有第二套写路径**：写入只经 `OrganizerService.setEventAssistantSwitch` 一个方法、只写 `organizer_event_assistant_switches` 一张表、复用既有 `requireStaff` + 既有 `audit()` + 既有 `authenticated()` 事务。

## 新增/改动

| 文件 | 变更 |
| --- | --- |
| `src/modules/organizer/migrations/003-assistant-switches.sql` | **新增**。唯一新表 `organizer_event_assistant_switches` + 1 个机构维度索引；无触发器（开关必须可变，历史由审计承担）；不改既有表。 |
| `src/modules/organizer/model.ts` | 新增 `EventAssistantSwitch` / `EventAssistantSwitchView` / `EventAssistantSwitchesView` / `SetEventAssistantSwitchInput`。 |
| `src/modules/organizer/validation.ts` | 新增 `assistantSwitch(value)`（只解析形状；key 是否合法由服务按注入清单判断）。 |
| `src/modules/organizer/postgres.ts` | 新增 `listAssistantSwitches` / `getAssistantSwitch`(FOR UPDATE) / `insertAssistantSwitch` / `saveAssistantSwitch`。 |
| `src/modules/organizer/service.ts` | `OrganizerServiceOptions` 新增**可选** `assistantKeys?: readonly string[]`；新增 `listEventAssistantSwitches` / `setEventAssistantSwitch` 与私有 `assistantSwitches()` 装配。 |
| `src/modules/organizer/handlers.ts` | 新增 kind `assistantSwitches`(GET+POST) 与 `setAssistantSwitch`(POST)，以及路径解析。 |
| `src/modules/organizer/testing.ts` | 夹具加载 `003` 迁移、统计新表、新增可选 `assistantKeys`（**夹具不硬编码**生产 7 个 key）。 |
| `src/modules/organizer/assistant-switches.test.ts` | **新增** 9 项测试。 |
| `src/modules/organizer/README.md` | 补 P4 的 key 清单契约、两个方法与两条 HTTP 行。 |

## 表结构（只新增）

```sql
CREATE TABLE organizer_event_assistant_switches (
 event_id text NOT NULL,
 organization_id text NOT NULL,
 assistant_key text NOT NULL CHECK(assistant_key <> '' AND length(assistant_key) <= 120),
 enabled boolean NOT NULL,
 revision integer NOT NULL CHECK(revision > 0),
 updated_by_user_id text NOT NULL REFERENCES auth_users(id),
 updated_at timestamptz NOT NULL,
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
 PRIMARY KEY(event_id, assistant_key),
 FOREIGN KEY(event_id, organization_id) REFERENCES organizer_hosted_events(id, organization_id),
 CHECK(document ? 'eventId' AND jsonb_typeof(document->'eventId') = 'string' AND document->>'eventId' = event_id
   AND document ? 'organizationId' AND jsonb_typeof(document->'organizationId') = 'string' AND document->>'organizationId' = organization_id
   AND document ? 'assistantKey' AND jsonb_typeof(document->'assistantKey') = 'string' AND document->>'assistantKey' = assistant_key
   AND document ? 'enabled' AND jsonb_typeof(document->'enabled') = 'boolean' AND document->'enabled' = to_jsonb(enabled)
   AND document ? 'revision' AND jsonb_typeof(document->'revision') = 'number' AND document->'revision' = to_jsonb(revision)
   AND document ? 'updatedByUserId' AND jsonb_typeof(document->'updatedByUserId') = 'string' AND document->>'updatedByUserId' = updated_by_user_id)
);
```

每一项先断言存在性（`document ? 'key'`）再断言 jsonb 类型：否则缺键时 `document->'key'` 是 SQL NULL，CHECK 会被 NULL 静默判通过——这是本会话实测到的真实缺陷（第一版 CHECK 漏了存在性断言，测试 `缺 document.enabled 不能让 CHECK 静默通过` 立刻失败，加上 `?` 后通过）。

## 端点契约（路径由主会话接根）

| 方法 / 路径（相对 `/api/v1`） | Body | data |
| --- | --- | --- |
| `GET organizer/events/:eventId/module-assistant-switches` | — | `{ eventId, switches: { assistantKey, enabled, revision }[] }` |
| `POST organizer/events/:eventId/module-assistant-switches` | `{ assistantKey, enabled, expectedRevision }` | 同 GET（写入后的**完整**开关集） |

- 顺序**严格按注入的 `assistantKeys` 顺序**；表里没有行的键返回 `enabled: true, revision: 0`（规划34 §5.1「默认全开」），**读取不补写占位行**。
- 权限：`event_manage`（机构管理员，或本场有该能力的当前工作人员）。非本场工作人员 403；跨机构/跨赛事 403；不存在 404；归档 403；匿名由根在 `authenticate` 前处理。
- 首次设置 `expectedRevision = 0`；已存在时必须等于当前 `revision`，否则 409 `ORGANIZER_REVISION_CONFLICT`（带 `latestRevision`，不覆盖、不写审计）。成功写入后 `revision + 1`。
- `assistantKey` 不在注入清单内 → 422 `ORGANIZER_INPUT_INVALID`；未注入清单 → 503 `ORGANIZER_ASSISTANT_SWITCH_UNAVAILABLE`（一个也不放行）。
- 同事务写既有 `organizer_audit_events`：action `assistant_switch_changed`，`entity_id = "<key>:enabled|disabled"`，`event_id`/`organization_id`/`actor_user_id`/`revision` 沿用既有列。审计表**没有** payload 列，助手指令/输出没有任何写入入口。
- 两个 kind：`assistantSwitches`（GET 读 / POST 写）与 `setAssistantSwitch`（仅 POST）。`organizerHttpRoute(path)` 只有路径入参（无 method），因此**默认解析为 `assistantSwitches`**；根若已知方法、希望按方法分派，可直接构造 `{ kind: "setAssistantSwitch", eventId }`（`handle` 已支持，GET 会按 methods 表返回 405 `Allow: POST` 且不触达 `authenticate`）。

## 没有第二份配置事实：证据

1. **key 清单唯一来源仍是 `module-assistants/registry.ts`**。本模块只在 `OrganizerServiceOptions.assistantKeys` 接收数组（去重保序、裁剪空白），**没有任何硬编码 key 列表**；测试夹具传的是 `beta`/`alpha`/`gamma` 这类**非生产键**，断言返回顺序跟着传入列表走、且 `overview` 这类真实注册表键在测试清单里会被 422 拒绝——若模块内藏了第二份注册表，这两条会立刻失败。
2. **`document` 与索引列由数据库绑成同一份事实**。测试 `P4 唯一新表` 证明：列说关/文档说开、缺 `document.enabled`、`document.revision` 与列不一致、主键重复、跨机构 `(event_id, organization_id)` 外键全部被拒绝，只剩一行真实事实。
3. **开关不进入任何赛事配置结构**。`EventConfigurationInput` / `CONFIGURATION_KEYS` / `EventModuleFlags` / `EventCommunityConfig` 一行未改；测试断言 `CONFIGURATION_KEYS` 无 assistant 键、`event.community` 无 `assistants` 键。
4. **审计是唯一历史**，表本身无 payload 列；测试断言 `organizer_audit_events` 无 `prompt|payload|content|message` 列名。

## 不进版本语义（不随发布版本冻结）：证据

测试 `P4 不随发布版本冻结` 先发布一场比赛，再改开关，逐字段比较：

- `getManagedEvent` 返回的赛事对象 **deepEqual 不变**（`revision`、`publishedRevision`、`status`、`updatedAt` 等全等）；
- `previewEvent` 的 `changedFields`、`publicProjection`、`publicationBlockers` **deepEqual 不变**（`changedFields` 由 `CONFIGURATION_KEYS` 对比发布快照派生，开关不在其中）；
- `listPublicationHistory` **deepEqual 不变**；`organizer_hosted_events` / `organizer_event_publications` / `organizer_publication_changes` / `organizer_event_profiles` / `organizer_organizations` 行数**逐表不变**；
- `organizer_audit_events` **恰好 +1**；
- 反向取证：把 `assistantSwitches` 混进 `PATCH organizer/events/:id` 的 body → 422 `ORGANIZER_INPUT_INVALID`（不存在"经赛事配置写开关"的第二套写路径），且赛事 `revision` 与 `changedFields` 长度都不变。

## 迁移建议

模块内已提供 `src/modules/organizer/migrations/003-assistant-switches.sql`（建议稿，本会话未执行）。**根 `migrations/078_event_assistant_switches.sql` 已由主会话创建**，内容与本模块建议稿逐行一致（注释亦标注"与模块 003 保持一致，由主会话编号并应用"）；根 `migrations/` 现有最大编号已是 `078`，**下一个可用编号为 `079`**（本会话结束时复核）。

- 文件名（根实际使用）：`migrations/078_event_assistant_switches.sql`。
- 内容：只新增 1 张表 + 1 个索引；引用既有 `organizer_hosted_events(id, organization_id)` 与 `auth_users(id)`；**无触发器、无既有表改动、无数据回填**。
- 无后续编号需求：本模块不再提议新迁移；若将来需要第二条，请用 `079`。
- 已在隔离夹具与根验收夹具中实际建表通过（见"已隔离验证"），有效性不依赖本会话执行生产迁移。

## 根接入 NEEDS_INTERFACE

1. **【必须】注入 `assistantKeys`（唯一新增接口；缺省时列表为空、写入 503，不静默放行）——已由主会话完成**。根 `src/server/organizer-integration.ts` 现为：

```ts
import { MODULE_ASSISTANT_KEYS, moduleAssistantCatalog } from "../modules/module-assistants/index.ts";
const organizer = new CurrentAccountOrganizerService({
  database, clock, ids, discovery, readinessEvidence, accountEmails, dashboard,
  assistantKeys: MODULE_ASSISTANT_KEYS, // 规划34 P4：助手 key 清单只此一份（模块不复制注册表）
});
```

（L237–L239；注释"P4：本场模块助手开关允许的键来自助手注册表（避免第二份硬编码列表）"。）

**契约**：数组顺序即 GET 返回顺序；模块内部去重保序。根此后增删助手只需改注册表，无需改本模块。

1b. **根已消费本接口**：`organizer-integration.ts` 的 `enabledModuleAssistants()` 调用 `organizer.listEventAssistantSwitches(principal, eventId)`，把结果作为 `enabledAssistants` 传给 `module-assistants` 运行时（`moduleAssistantDirectory` 的 GET 会返回 `enabledAssistants`，关闭的助手在执行时返回 403）。根页面/界面接线仍待做（第 3 条）。

2. **注册路由：根无需改动（已核实）**。`organizer/events/:id/module-assistant-switches` 会由 `organizerHttpRoute` 命中；根 `match()` 现有顺序 REGISTRATION_ROUTES → JUDGING_ROUTES → CLOSURE_ROUTES → PEER_REVIEW_ROUTES → 内置 `module-assistants` 正则 → COMMUNITY_ROUTES → `eventCommunicationHttpRoute` → `organizerHttpRoute` 中，前六者都不匹配该路径：内置 `module-assistants` 正则以 `$` 结尾且字面量不同（`module-assistants` ≠ `module-assistant-switches`），registration/judging/closure/community 用的是 `registration-*`、`teams`、`judging/...`、`closure`、`community/...` 等具体段。POST 由根 `handle()` 的 `authorizeMutation` 覆盖。若根希望按方法显式分派，可对 POST 构造 `{ kind: "setAssistantSwitch", eventId }`。

3. **界面落点（超出本会话范围）**：按 [布局规划](../../设计/主办方工作台布局.md) 在**比赛设置 → 模块助手**折叠区做 7 行开关（默认全开、可逐模块关），每行显示 `revision` 与"最近由谁在何时改"（从既有审计读）；**不新增一级导航**。助手不可用时原模块流程照常可用（本接口只决定是否显示助手入口，不改变任何人工流程）。

4. **无需新增环境变量**；无需新依赖。

## 已隔离验证

命令与真实结果：

```
node --experimental-strip-types --test src/modules/organizer/assistant-switches.test.ts   # 9/9 通过
$f = Get-ChildItem src/modules/organizer -Filter *.test.ts | % FullName; node --experimental-strip-types --test $f
                                                                                          # 139/139 通过（10 suites，0 fail；既有 130 项全部未被破坏）
node node_modules/typescript/bin/tsc --noEmit --incremental false                          # exit 0，无任何输出（本模块 0 条诊断，全仓 0 条诊断）
node --experimental-strip-types --test src/server/organizer-router-acceptance.test.ts       # 5/5 通过（含 P4 根接线段）
```

根验收 `organizer-router-acceptance.test.ts` 的 P4 段（主会话编写，本会话只读运行、未改）实测通过：`GET .../module-assistant-switches` 默认返回 **7** 项且全开、选手 403、匿名 401、`POST` 关 `judging` 后目录 `enabledAssistants` 不再含它、执行该助手 403、`organizer_hosted_events` 的 `revision`/`published_revision` 前后 `deepEqual` 相等、`assistant_switch_changed` 审计恰好 1 条。

`tsc` 原文（exit 0）：

```
(empty output)
```

未覆盖项：PGlite 单实例事务不能代替线上 PostgreSQL 多连接并发（两人同时改同一键时的 `FOR UPDATE` 争用）；本会话未打开实际库、未执行根迁移、未 build、未重启、未接界面。

## P4 明确不做

把助手开关放进 `EventModuleFlags`/`EventCommunityConfig`（会随发布冻结）、在模块内复制 7 个 key 的第二份注册表、未接入清单时默认放行任意 key、把助手指令/输出写进审计或开关表、用开关去暂停/隐藏人工流程、给开关另建第二套权限事实（仍只读既有 `StaffGrant`）。
