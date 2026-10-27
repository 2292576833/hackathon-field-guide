# O01 · 主办方入驻与赛事核心

本模块为持久服务和可组合界面，不自行安装路由、执行迁移或启动服务。标准流程为申请机构 → 平台人工核查 → 选择模板建赛 → 查看公开预览 → 发布 → 按当前机构/赛事权限处理工作。机构通过审核不代表平台保证赛事质量。

## 根组合

```ts
import { createOrganizerService, createOrganizerHttpHandlers, organizerHttpRoute } from "./index.ts";
const service = createOrganizerService({ database, clock, ids });
const eventAccess = service.eventAccess; // HostedEventAccessPort，传入O02/O03/O04
const handlers = createOrganizerHttpHandlers({ service, authenticate, authorizeMutation, requestId });
const route = organizerHttpRoute(pathAfterApiV1);
if (route) return handlers.handle(request, route);
```

`createOrganizerService(options: OrganizerServiceOptions): OrganizerService` 的必需参数为共享 `DatabasePort`、`Clock`、`IdGenerator`；可选 `repository: PostgresOrganizerRepository`，默认真实参数化 SQL 适配；可选 `discovery` / `readinessEvidence`（规划25）、`registrationForms` / `judgingConfig`（**P05 复制赛事**）、`dashboard`（**P07 数据看板下钻**）、`accountEmails`（**P3 受限邀请领取的邮箱校验**）与 `assistantKeys`（**P4 赛事级模块助手开关**的 key 清单，见下），见下。没有生产内存降级、外部模型调用或独立连接。类的 `database/clock/ids/repository` 用于根组合；生产应只调用公共服务方法。

### P05 复制赛事的两个跨模块 Port（可选，缺省则如实跳过）

复制要同时写 `organizer`、`event-registration`（报名表）与 `event-judging`（评审配置）。按模块边界，后两者通过注入 Port 调用；**每个方法都接收当前事务的 `SqlExecutor`，实现方只使用传入的 `sql`**（不自己开事务/连接），三步因此落在同一事务里，任一步失败整体回滚：

```ts
registrationForms: {
  getForm(sql, eventId)                          // → { title, description, fields } | null
  saveForm(sql, principal, eventId, input)       // → 新赛事第一版（expectedRevision: 0）
},
judgingConfig: {
  getConfig(sql, eventId)                        // → 配置对象 | null（未配置返回 null）
  saveConfig(sql, principal, eventId, { expectedRevision: 0, config })
}
```

未注入时 `duplicateEvent` **不失败**，而是在返回的 `skipped` 里写明「未接入…」，界面据此如实说明；来源未配置或未启用对应模块时同样只跳过。真实适配由根组合提供（`event-registration` / `event-judging` 需各自的 `sql` 变体），详见 [交付说明 P05 段](../../../docs/协作/交付/organizer.md)。

### P07 数据看板下钻的只读 Port（可选，缺省则如实显示"未提供"）

看板的五块事实分别由其他模块拥有，本模块**不直接读它们的表**，只把既有读取经注入 Port 取一次，再交给纯函数 `dashboard.ts` 做筛选与聚合。未注入时对应指标返回 `undefined`（界面显示"未提供"），**绝不补 0**；不具备对应 capability 的面板不出现（显式请求越权面板 403）。

```ts
dashboard: {
  registrationCounts(principal, eventId)              // 既有 registrationCounts() 原样
  registrations(principal, eventId, { cursor, limit }) // 既有 listStaff()
  teams(principal, eventId, { limit })                // 既有 listStaffTeams()
  judgingWorkspace(principal, eventId)                // 既有 workspace() 的 rounds/submissions
  judgingProgress(principal, eventId, roundId)        // 既有 progress() 原样
  accommodation(principal, eventId)                   // 既有 logistics.listAccommodation()
  vouchers(principal, eventId)                        // 既有 logistics.listVouchers()
  scheduleDraft(principal, eventId)                   // 既有 schedule.getScheduleDraft()
}
```

**契约**：所有方法只读、直接转发既有读路径（不另算一套数字）；实现方各自沿用原本的 capability 判定。每个数字都带统计口径、统计范围与数据时间；未读取为 `undefined`，空值写"未提供"。详见 [交付说明 P07 段](../../../docs/协作/交付/organizer.md)。

### P3 受限邀请的账号邮箱 Port（可选，缺省则领取失败关闭）

受限邀请（宪法 XIII）单次使用、有有效期、可撤销、可绑定指定邮箱；领取 MUST 只由**已登录且邮箱已验证**的账号完成。本模块不直接查 `auth_users`，由根注入只读 Port，并用**当前事务的 `SqlExecutor`** 读取，使邮箱校验与既有 grant 写入同事务：

```ts
accountEmails: {
  readVerifiedEmail(sql, userId)   // → { email } | null（null＝不存在/未激活/未验证）
}
```

**契约**：实现方 MUST 只读、只使用传入的 `sql`；账号不存在/未激活/未验证一律返回 `null`。**未注入时领取失败关闭**（`ORGANIZER_INVITATION_UNAVAILABLE`，503），绝不因为"拿不到校验"而放行。**未注入不影响生成、列表、预览与撤销**；已领取的权限本来就在既有 `StaffGrant` 里，不受 Port 影响。详见 [交付说明 P3 段](../../../docs/协作/交付/organizer.md)。

### P4 赛事级模块助手开关的 key 清单（可选，缺省则列表为空、写入 503）

助手开关是**内部运营项**（规划34 §5.1）：即时生效、写既有审计、**不随正式发布版本冻结**。key 清单**不在本模块**——它是根从 `module-assistants` 注册表传入的数组，避免第二份注册表；顺序即返回顺序：

```ts
import { MODULE_ASSISTANT_KEYS } from "../module-assistants/index.ts";
const service = createOrganizerService({ database, clock, ids, assistantKeys: MODULE_ASSISTANT_KEYS });
```

**契约**：未传入（或传空数组）时 `listEventAssistantSwitches` 返回 `{ eventId, switches: [] }`，`setEventAssistantSwitch` 一律 503 `ORGANIZER_ASSISTANT_SWITCH_UNAVAILABLE`；表里没有行的键按**默认全开**（`enabled: true, revision: 0`），读取不补写占位行。写入只改 `organizer_event_assistant_switches` 并同事务写一条 `assistant_switch_changed` 审计（只记 key 与 enabled），**不推进赛事 revision、不进 changedFields/发布版本/历史**。详见 [交付说明 P4 段](../../../docs/协作/交付/organizer.md)。

`createHostedEventAccessPort(service): HostedEventAccessPort` 与 `service.eventAccess` 等价。`getEvent(sql,eventId,{forUpdate?})` 返回有效已发布配置（未发布赛事返回草稿Scope），机构非approved返回null。未发布草稿不能改变O02/O03/O04当前使用的规则；`revision`仍为当前编辑版本，`publishedRevision`为实际发布版本。`requireStaff(sql,actor,eventId,capability)` 锁定组织→赛事并依据当前grant判断；平台admin/reviewer不继承赛事权限，撤权、停用、归档均拒绝操作。消费者必须先/后调用自己的当前 `OrganizerPrincipal.guard(sql)`；Port本身没有请求会话参数，不能替代此检查。

所有私有服务方法接受第一参数 `OrganizerPrincipal={actor,guard}`。根必须从真实请求会话构造并在guard里锁定/核查当前账号、平台角色和该请求会话；guard前后在同一个事务调用，结束复核失败会回滚写入。根不得信任JSON中的actor、tenant、linkedEventId或角色。`linkedEventId`固定null，仅未来根可信M03桥可关联。

## 方法与返回

| 方法（除公开方法外第一参数均为principal） | 后续参数 | 返回 |
| --- | --- | --- |
| createApplication | `CreateApplicationInput` | `OrganizationApplication` |
| updateApplication | `id, CreateApplicationInput & {expectedRevision}` | `OrganizationApplication`，pending/rejected本人补充后重新pending |
| listOwnApplications | 无 | `OrganizationApplication[]` |
| listApplicationsForReview | 无 | `OrganizationApplication[]`，仅当前平台admin |
| reviewApplication | `id, ReviewApplicationInput` | `OrganizationApplication` |
| listOrganizations | 无 | `Organization[]`，仅当前活跃授权所属机构 |
| updateOrganization | `id, {expectedRevision,description}` | `Organization`，机构身份变化另走人工核查 |
| listStaffGrants | `organizationId` | `StaffGrant[]`，仅机构管理员 |
| grantStaff | `organizationId, GrantStaffInput` | `StaffGrant` |
| revokeStaff | `grantId, {expectedRevision}` | `StaffGrant`，保留revoked事实 |
| createEvent | `organizationId, CreateEventInput` | `HostedEvent`，字段可由已选模板提供默认配置 |
| listOrganizationEvents | `organizationId` | `HostedEvent[]`，按event-specific grant筛选 |
| getManagedEvent | `eventId` | `HostedEvent`，当前草稿 |
| updateEvent | `eventId, UpdateEventInput` | `HostedEvent`，只写草稿 |
| changeEventResponsible | `eventId, {expectedRevision,responsibleUserId}` | `HostedEvent`，仅机构管理员，新负责人须已有该赛event_manage |
| previewEvent | `eventId` | `EventPreview`，`event/publicProjection/publicationBlockers/changedFields` |
| publishEvent | `eventId, {expectedRevision,changeSummary}` | `HostedEvent`，新不可变版本与变化回执同事务 |
| archiveEvent / endEvent | `eventId, {expectedRevision}` | `HostedEvent`，归档/结束不删除历史 |
| listCompetitionIdentities | 无 | `CompetitionIdentity[]`，仅工作人员范围；根另合并报名/评委身份 |
| listPublicationHistory | `eventId` | `PublishedEventRevision[]`，当前授权可读历史 |
| listPublicationChanges | `eventId` | `PublicationChange[]`，communication_manage权限 |
| dashboard | `eventId, DashboardFilter` | `DashboardView`（P07：报名/队伍/收件/评审/后勤五块既有事实的筛选下钻；未接入或未读取为 `undefined`，越权面板 403） |
| listEventAssistantSwitches | `eventId` | `EventAssistantSwitchesView`（P4：`event_manage`；顺序按注入的 `assistantKeys`，无行默认全开；未注入为空集） |
| setEventAssistantSwitch | `eventId, {assistantKey,enabled,expectedRevision}` | `EventAssistantSwitchesView`（P4：`event_manage`；key 须在注入清单内否则 422，首次 `expectedRevision=0`，不符 409；同事务写审计） |
| createStaffInvitation | `organizationId, CreateStaffInvitationInput` | `{ invitation, token }`（P3：仅机构管理员；**token 只在此响应返回一次**，库内只存 sha256） |
| listStaffInvitations | `organizationId` | `StaffInvitationView[]`（P3：机构管理员；含"谁/何时/领取了哪些能力"，**不含 token**） |
| revokeStaffInvitation | `invitationId, {expectedRevision}` | `StaffInvitationView`（P3：仅机构管理员；只撤 `open`） |
| previewStaffInvitation | `token` | `StaffInvitationPreview`（P3：任意已登录；不含 token、邀请人标识与备注） |
| claimStaffInvitation | `token` | `{ invitation, grant }`（P3：已登录+邮箱已验证+绑定邮箱一致；只经既有 grant 写路径写**恰好一条** `StaffGrant`） |
| listTemplates（公开，无principal） | 无 | `EventTemplate[]`，线上/线下/练习赛固定version1 |
| listPublicCompetitions（公开，无principal） | 无 | `PublicCompetition[]` |
| getPublicCompetition（公开，无principal） | `eventId` | `PublicCompetition` |

完整字段见`model.ts`，共享Scope/module/capability命名见`../../shared/organizer-contracts.ts`。申请证明仅受限文字和最多5个公开HTTPS地址，不抓取地址、不支持上传附件。团队能力不授予M02私人空间权限；judging_manage只管理赛事评审流程，不产生评委指派或打分权。

## HTTP工厂

`createOrganizerHttpHandlers({service, authenticate(request):Promise<OrganizerPrincipal>, authorizeMutation(request):Promise<void>, requestId():string})` 返回 `{handle(request,route):Promise<Response>}`。

下面路径均相对于`/api/v1`。GET无正文；POST/PATCH为JSON（最大96KiB，包含真实字节读取限制）。成功统一`{data:<下列返回>,requestId}`；DomainError保留`code/message/recoveryAction/latestRevision`，未知异常不泄露SQL/堆栈。所有响应`private,no-store`、`Vary: Cookie`、`nosniff`，不缓存私人身份。方法不符405及Allow；公开GET只读且不触发采集/模型/通知。

| 方法 / 路径 | Body | data |
| --- | --- | --- |
| GET /organizer/templates | — | EventTemplate[] |
| GET /organizer/applications 或 /organizer/applications/mine | — | 本人OrganizationApplication[] |
| POST /organizer/applications | CreateApplicationInput | OrganizationApplication |
| PATCH /organizer/applications/:id | CreateApplicationInput + expectedRevision | OrganizationApplication |
| GET /admin/organizer/applications | — | OrganizationApplication[] |
| POST /admin/organizer/applications/:id/review | ReviewApplicationInput | OrganizationApplication |
| GET /organizer/organizations | — | Organization[] |
| PATCH /organizer/organizations/:id | expectedRevision, description | Organization |
| GET /organizer/organizations/:id/events | — | HostedEvent[] |
| POST /organizer/organizations/:id/events | CreateEventInput | HostedEvent |
| GET /organizer/organizations/:id/staff-grants | — | StaffGrant[] |
| POST /organizer/organizations/:id/staff-grants | GrantStaffInput | StaffGrant |
| POST /organizer/staff-grants/:id/revoke | expectedRevision | StaffGrant |
| GET /organizer/organizations/:id/staff-invitations | — | StaffInvitationView[]（P3 机构管理员；不含 token） |
| POST /organizer/organizations/:id/staff-invitations | {role, capabilities, eventId?, expiresInDays?, boundEmail?, note?} | {invitation, token}（token 只此一次） |
| POST /organizer/staff-invitations/:id/revoke | expectedRevision | StaffInvitationView（仅机构管理员） |
| GET /my/staff-invitations/:token | — | StaffInvitationPreview（任意已登录；不含 token） |
| POST /my/staff-invitations/:token/claim | （无字段） | {invitation, grant}（已登录+已验证邮箱+绑定邮箱一致） |
| GET /organizer/events/:id | — | HostedEvent |
| PATCH /organizer/events/:id | UpdateEventInput | HostedEvent |
| POST /organizer/events/:id/responsible | expectedRevision, responsibleUserId | HostedEvent |
| GET /organizer/events/:id/preview | — | EventPreview |
| POST /organizer/events/:id/publish | expectedRevision, changeSummary | HostedEvent |
| POST /organizer/events/:id/archive 或 /end | expectedRevision | HostedEvent |
| GET /organizer/events/:id/history | — | PublishedEventRevision[] |
| GET /organizer/events/:id/publication-changes | — | PublicationChange[] |
| POST /organizer/events/:id/duplicate | {title?, includeRegistrationForm?, includeJudgingConfig?, expectedOrganizationRevision} | DuplicateEventResult（新草稿 + skipped 说明） |
| GET /organizer/organizations/:id/duplicate-sources | — | HostedEvent[]（本机构中有 event_manage 的赛事） |
| GET /organizer/events/:id/dashboard?panel=&status=&track=&from=&to=&roundId=&cursor=&limit= | — | DashboardView（P07 只读；仅本场 staff 且具备对应 capability 的面板可见；非法筛选 422） |
| GET /organizer/events/:id/module-assistant-switches | — | EventAssistantSwitchesView（P4：`event_manage`；无行默认全开；未注入 key 清单时为空集） |
| POST /organizer/events/:id/module-assistant-switches | {assistantKey, enabled, expectedRevision} | EventAssistantSwitchesView（P4：内部运营项，写审计但不改赛事 revision/发布版本/变化字段） |
| GET /competitions | — | PublicCompetition[] |
| GET /competitions/:id | — | PublicCompetition |
| GET /me/competition-identities | — | CompetitionIdentity[] |

申请状态pending允许approved/rejected；approved允许suspended；suspended允许approved/rejected；rejected必须本人补充重新pending。管理员为自己或自己当前工作的机构审核会403。批准首次申请创建本人机构管理员grant；恢复停用机构保留现有授权，不复活已撤权用户。

## 持久与并发边界

SQL建议：`migrations/001_organizer.sql`（模块内，根增量编号并执行）。自有表前缀`organizer_`，仅引用`auth_users(id)`及本模块表；应用、组织、赛事、授权、不可变发布版本、发布变化回执和审计均持久。staff的event/organization复合FK阻止跨组织归属；机构/赛事的活跃授权分别唯一。不可变trigger保护发布版本、变化回执和审计。输入列与JSON由同一适配更新。

变更先guard→组织FOR UPDATE→赛事FOR UPDATE→当前grant→expectedRevision→写入→guard。审核、停用、授权和撤权复用组织锁。修改失败不覆盖数据库旧值；同版本编辑只允许一笔成功。所有query参数化，跨模块Port复用同一个SqlExecutor，不另开事务或连接。PGlite隔离测试不能证明线上PostgreSQL多连接调度和真实部署锁行为。

首次发布前必须明确简介、规则、参与位置、启用报名的独立开放/截止和启用评审的作品截止，负责人必须仍有event_manage。已有版本后禁直接关闭曾启用功能；不得靠关开关隐藏报名、收件或求助。修订规则只写草稿，发布再新增不可变snapshot。每次发布需要参赛影响说明并保存`PublicationChange`；这是待根处理的站内更新事实，不等于已发公告/已读/邮件送达。

公开投影只含赛事字段和机构名称/状态；不含联系人、邮箱、证明、申请人/负责人/工作人员ID、私密设置或linkedEventId。停用组织仍展示最后发布规则和明确不可操作状态，保留记录。

## 根仍需接入

- 真实auth/session guard、Origin/CSRF、固定API和页面路由、SiteShell入口、登录returnTo。
- guard必须复核当前活跃且已验证邮箱的账号、当前平台角色和本请求session；仅session存在检查不足。目标工作人员/负责人目前通过FK验证账号存在，根还需提供目标活跃状态校验和受限staffAccounts选择清单。
- O02/O03/O04注入eventAccess；root合并本人工作人员/报名/评委身份，不用本模块工作人员身份冒充全部“我的比赛”。
- PublicationChange与O03官方通知/已读、EventNotificationPort邮件流程的可信根桥；不能展示“通知已发送”假成功。
- 跨模块真实待办计数由根提供。UI仅显示已读取当前事实，不制造待报名/待评审计数。
- P3 受限邀请：根需注入 `accountEmails.readVerifiedEmail(sql,userId)`（只读 `auth_users`，返回已激活且邮箱已验证的邮箱）；未注入时领取 503，生成/列表/预览/撤销不受影响。`my/staff-invitations/:token` 与 `.../claim` 由本模块 `organizerHttpRoute` 解析，且不与 registration/judging/closure/communication 任一既有路径前缀冲突。
- M03 linkedEventId关联由根新增可信管理接口；本模块HTTP不允许客户端自报。
- 实际迁移、全站构建/重启、PostgreSQL并发、浏览器/实体手机、公网TLS与两家主办方真实试用。

## 客户端公共导出

从独立`ui.ts`导入，避免客户端打包服务/数据库/Node代码。五个组件及其Props类型均公开导出。

- `OrganizerEntry({signedIn,loginHref?,workspaceHref?,onApplicationSubmitted?})`：申请、本人审核状态与补充申请；`onApplicationSubmitted(application)`只在服务确认保存后触发。
- `OrganizerWorkspace({currentUserId,initialOrganizationId?,initialEventId?,entryHref?,publicEventHref?,moduleLinks?,staffAccounts?,onEventSaved?})`：机构/赛事切换、模板配置、预览发布、范围授权与撤权。`currentUserId`由根真实账号提供；`staffAccounts`为根允许选择的`{userId,label}[]`，缺少时只能输入已知账号标识，不查询全站用户。`moduleLinks(event)`映射受限模块到根工作人员页面。
- `CompetitionDirectory({signedIn?,organizerHref?,competitionHref?,workspaceHref?,identitySlot?})`：正式赛事和真实工作人员身份；`identitySlot`供根合并报名/评委入口，不虚构身份记录。
- `CompetitionOverview({eventId,directoryHref?,signedIn?,loginHref?,moduleLinks?,participationSlot?})`：当前已发布规则、独立重要期限、版本、组织暂停与当前可用入口。`moduleLinks`为固定模块键→根真实页面地址，`participationSlot`仅放经根当前权限读取的本人状态。
- `AdminOrganizationReview({onReviewed?})`：人工审批队列、依据与有效状态动作，权限由HTTP/服务强制执行。

日期按赛事IANA时区展示和输入；未保存草稿按组织/赛事分开，切换前显式保存、保留或放弃，避免把另一场的规则转投当前比赛。错误与冲突保留输入；公开页仅显示服务返回的真实版本。手机操作、focus和减少动效样式由本模块CSS提供；实际浏览器与实体手机检查由根完成。

## 验证记录

2026-10-11：`node --experimental-strip-types --test src/modules/organizer/service.test.ts src/modules/organizer/handlers.test.ts` 26/26通过；`node node_modules/typescript/bin/tsc --noEmit --incremental false` 全仓通过，无tsbuild缓存写入。隔离数据库仅new PGlite()内存实例，不能替代实际pg多连接并发。未build/重启/打开实际库；根页面和外部服务未验收。

2026-10-16（P3 受限邀请）：`node --experimental-strip-types --test <src/modules/organizer 全部 *.test.ts>` **130/130 通过（10 suites）**，其中 `invitations.test.ts` 18 项。`node node_modules/typescript/bin/tsc --noEmit --incremental false` 仅报 `src/modules/event-community/` 4 条（另一会话在写，非本模块）——本模块 0 条诊断。未 build、未迁移、未重启、未安装依赖。
