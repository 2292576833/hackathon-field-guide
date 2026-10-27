# 报名与正式赛事队伍（O02）

只拥有 `src/modules/event-registration/`；根会话负责应用路由、真实连接、增量迁移和验收。本模块没有读取其他模块表，没有创建 ProjectMembership，没有模型调用或内存生产降级。

## 构造与根接入

```ts
createEventRegistrationService({
  database, // 既有真实 DatabasePort，同事务调用共享 SqlExecutor
  events, // HostedEventAccessPort，当前组织/赛事授权由 O01 实现
  projectLinks, // EventProjectLinkPort，根同事务锁定并复核真实项目管理员、项目版本及关联
  clock, ids,
  projectLinkPreview, // 可选；下文 NEEDS_INTERFACE
  tracks, // 可选；下文 NEEDS_INTERFACE
});
```

`EventRegistrationService` 实现共享 `EventParticipationPort`。`getRegistration(sql,eventId,userId)` 只返回报名快照（id/eventId/userId/status/revision）。`getTeam(sql,eventId,teamId)` 只返回共享名单快照，资格从真实接受记录、当前批准报名、人数、赛道与已确认名单推导。Port 是可信内部接口，调用方仍须对当前账号、请求会话、比赛范围负责；它不是公开 HTTP。

持久工厂 `new PostgresRegistrationRepository(database)`、`repository.store(sql)` / `new PostgresRegistrationStore(sql)` 只使用模块自有表。所有写操作在 `DatabasePort.transaction` 内，锁定顺序为请求会话 → O01赛事行 → O02赛事行 → 自有记录，事务前后执行 `principal.guard(sql)`，工作人员能力也前后复核。根必须将 Port 调用绑定同一个 executor，并让 O01 `getEvent({forUpdate:true})` 实际锁赛事及授权事实。

SQL建议：`sql/001-event-registration.sql`。仅引用现有 `auth_users(id)` 和自有表；不在本会话执行真实迁移。

## 行为

- 报名免费。表单白名单支持 text/textarea/number/choice/multichoice/url，最多30项，不执行 HTML 或任意规则表达式。文本与选项有长度限制；URL只允许无凭据的 HTTP(S)。邮箱不重复收集。
- 表单每次发布新增不可变版本，修改需要变更说明。草稿保存当前 schema，旧草稿在表单升级后需要核对新版本才能提交；旧提交和各次状态变化进入不可变历史。
- 唯一 `(eventId,userId)` 报名；draft不占额度，pending和approved占额度，rejected和withdrawn释放。pending批准不再占第二个名额。保存不是提交，服务器时间控制报名窗口；提交前校验必填项。
- 已提交答卷需先撤回才能更正；保留旧答卷历史。私有草稿（含从未提交草稿的撤回）不能进入工作人员列表或导出。`registration_manage`才可查看已提交答案；`teams_manage`不能看答案。
- 加入请求由本人发起，队长接受后才新增真实成员；待处理请求不占成员名额。同一赛事最多一个活跃正式队伍，数据库 partial unique 与赛事锁共同保护。本人最多20条待回复申请。
- assigned/mixed支持工作人员建议：建议不创建队伍或成员。被建议队长明确同意后建队，其他人仍逐个主动申请、队长接受。assigned仅允许从本人建议进入指定队伍。
- 队长锁定时冻结成员和报名版本；后续撤回、拒绝或退出使名单资格失效。队长不能替人接受；退出不删除任何私人空间记录。唯一队长有其他成员时需指定现有合格队员接任。工作人员可说明原因重新开放名单，旧确认保留在历史，组队截止仍生效。
- 公开招募只含队伍名称、公开介绍、赛道ID、版本、真实人数/可用人数和状态；不含账号、答卷、联系人、私人项目ID。`track`只接受已接入官方配置的ID，未接入时只能留空，不能把自由标签当官方赛道。
- 空间关联由队长提出请求，再由当前私人项目管理员显式确认。根确认 Port 不得授予主办方私人空间权限。无私人项目仍可正式报名和组队。
- 重放回执绑定比赛、当前账号、操作、幂等键和规范化输入指纹。输入变更报409；当前会话、工作人员权限、队长身份/项目管理员仍复核。确认Port应可重入，同输入的POST重试不得再次授予权限。
- CSV有引号/换行转义，并防范前导空白隐藏的 `= + - @` 公式。导出最多5000条，由当前权限复核后返回私有 envelope，不读邮箱或私人画像。
- 关闭模块不删除既有事实；历史可读、本人可撤回/退出；归档只读。所有GET没有保存、采集、初始化账本或模型调用。

## HTTP 工厂

`createEventRegistrationHandlers({ service, resolvePrincipal, authorizeMutation, requestIds, maxJsonBytes? })` 返回固定方法 handlers。`maxJsonBytes`默认/上限131072。根提供真实Principal和同源/CSRF检查；JSON流有界读取、拒绝未知顶层字段、无效UTF-8/压缩正文，幂等头/正文必须一致。所有响应 `{data,requestId}` 或共享错误 envelope，`private,no-store`。

所有 handler 签名 `(request: Request, params?: {eventId?,registrationId?,teamId?,requestId?}) => Promise<Response>`；根挂载以下 `/api/v1` 路径。输入类型见 `model.ts`，分页为 `cursor?`、`limit?`（1–100，默认20），工作人员报名可另传 `status?`。

| Handler | 方法和路径（不含/api/v1） | Body/输出 | 权限 |
| --- | --- | --- | --- |
| getRegistrationForm | GET /competitions/:eventId/registration-form | 无 → RegistrationFormView | 公开已发布/历史赛事 |
| getStaffForm/saveForm | GET/PUT /organizer/events/:eventId/registration-form | PUT SaveFormInput → RegistrationForm；GET RegistrationFormView | registration_manage |
| getMine/saveDraft | GET/PATCH /competitions/:eventId/my-registration | PATCH SaveDraftInput → Registration；GET MyRegistrationView | 本人 |
| submit/withdraw | POST /competitions/:eventId/my-registration/submit或withdraw | MutationInput → Registration | 本人 |
| listStaff | GET /organizer/events/:eventId/registrations | 分页/状态 → StaffRegistrationsView | registration_manage |
| review | POST /organizer/events/:eventId/registrations/:registrationId/review | ReviewRegistrationInput → Registration | registration_manage |
| exportRegistrations | GET /organizer/events/:eventId/registrations/export | 无 → ExportResult(JSON envelope内CSV) | registration_manage |
| listTeams/createTeam | GET/POST /competitions/:eventId/teams | GET分页 → TeamsView；POST CreateTeamInput → RosterTeam | 当前账号 / approved建队 |
| listPublicTeams | GET /competitions/:eventId/teams/public | 分页 → {event,teams:Page<PublicRosterTeam>} | 公开最小投影 |
| listStaffTeams | GET /organizer/events/:eventId/teams | 分页 → {event,teams:Page<RosterTeam>} | teams_manage |
| getStaffCandidates | GET /organizer/events/:eventId/team-candidates | 分页 → {event,candidates:Page<TeamCandidate>}，只有userId/registrationId/revision | teams_manage，不能看答案 |
| listTeamSuggestions/proposeTeam | GET/POST /organizer/events/:eventId/team-suggestions | GET → TeamSuggestion[]；POST ProposeTeamInput → TeamSuggestion | teams_manage |
| requestJoin | POST /competitions/:eventId/teams/:teamId/join-requests | JoinTeamInput → JoinRequest | approved本人 |
| respondJoin | POST /competitions/:eventId/teams/:teamId/requests/:requestId/respond | RespondJoinInput → JoinRequest | 当前队长 |
| cancelJoin | POST /competitions/:eventId/teams/:teamId/requests/:requestId/cancel | MutationInput → JoinRequest | 请求本人 |
| leaveTeam | POST /competitions/:eventId/teams/:teamId/leave | LeaveTeamInput → RosterTeam | 当前成员 |
| lockRoster | POST /competitions/:eventId/teams/:teamId/lock | MutationInput → RosterTeam | 当前队长 |
| reopenRoster | POST /organizer/events/:eventId/teams/:teamId/reopen | ReopenRosterInput → RosterTeam | teams_manage，原因必填 |
| getProjectLink/requestProjectLink | GET/POST /competitions/:eventId/teams/:teamId/project-link | GET → ProjectLinkRequest或null；POST RequestProjectLinkInput → ProjectLinkRequest | GET当前成员或当前空间管理员；POST当前队长 |
| confirmProjectLink | POST /competitions/:eventId/teams/:teamId/project-link/:requestId/confirm | ConfirmProjectLinkInput → RosterTeam | 根复核当前项目管理员 |
| listMine | GET /me/competitions | 分页 → Page<MyCompetition> | 本人报名事实 |

直接服务方法与同名handler一致；所有非公开方法首参 `OrganizerPrincipal`，次参 `eventId`（`listMine`仅principal+分页）；记录方法接表中路径ID和input。`getStaffForm`/`saveForm`用于主办方；`getRegistrationForm`/`listPublicTeams`没有principal。`listTeamSuggestions`只读，`proposeTeam`写建议。

## NEEDS_INTERFACE

1. `EventProjectLinkPreviewPort.requireManagerPreview(sql,principal,{eventId,teamId,projectId}): Promise<void>`，根需同事务锁/复核当前账号、请求会话、M02 manager及关联范围，仅准读取关联请求预览，不改变权限。当前队员已能预览；非队员项目管理员在此Port未接入时403，GET不会调用写确认Port。
2. `EventTeamTrackPort.getConfiguration(sql,eventId): Promise<{configured,required,revision,options:[{id,title}]} >`，根从真实已发布赛事赛道配置提供，只读同事务且event限定。当前共享Scope没有赛道；没有Port时清楚显示未接入且只能空赛道，不伪造官方赛道。
3. 根必须实现既有 `EventProjectLinkPort.confirmLink`：锁定当前M02管理员和项目版本，对真实event/team/project显式映射，失败抛共享DomainError；同输入重试可重入。它是授权确认，不可读私人代码/测评/记忆，不授主办方权限。

本模块不要求新增环境变量。真实DatabasePort、事件授权、账号会话、Origin/CSRF与项目Port沿用根配置；没有任何第三方服务或密钥值。

## UI 与验证

从 `ui.ts` 导出 `RegistrationPanel({eventId,signedIn?})`、`RosterTeamsPanel({eventId,currentUserId})`、`RegistrationManager({eventId})`、`RosterTeamManager({eventId})`、`MyCompetitions()`、`ProjectLinkConfirmation({eventId,teamId,onConfirmed?})`。组件使用现有 `client-api.ts` 的 `/api/v1` 前缀，比赛名/组织/身份/关键期限常驻，动态表单和字段配置无需JSON，失败保留输入，比赛切换处理草稿，移动端按钮可触达。

测试使用 Node 内置 `node:test`，生产适配同一份SQL在全新内存PGlite中验证；此为隔离演练，不能代替真实多连接PostgreSQL、根组合、浏览器手机和外部主办方试用。具体结果及未接入事项见 `docs/协作/交付/event-registration.md`。
