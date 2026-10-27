# 项目与团队（M02）

`index.ts` 是服务端公共入口。该模块管理私人参赛项目、队伍、当前成员关系、带名额邀请、项目阶段、成员可用时间集合和项目共享资料。没有内存生产仓储；测试夹具仅位于 `tests/`。

## C02 协作边界补全（2026-10-10）

归档项目的邀请撤销在项目事务锁内检查 `editable`，直接 DELETE 同样返回 `PROJECT_ARCHIVED` / 409，不能更改邀请、项目 revision 或审计。既有归档管理权交接与离队例外保留。

`InvitationAcceptance` 新增私有 `membershipId: string | null`。新加入或通过新邀请重新激活历史成员时，消费记录关联该事务实际使用的成员 ID；已活跃成员直接进入，不增加接受事实、不消耗名额、不升权。旧历史 `null` 明确表示当时未记录关联，不能从当前成员反推，也不能据此复活成员。已保存的消费记录保持不可改写、不可删除，邀请 DTO 不返回该记录。

主会话须将 `sql/invitation-acceptance-membership.sql` 组合为 024 之后的新根迁移，并在部署新仓储前应用。新增 nullable `membership_id`，保留所有旧事实与 quota；新 INSERT 校验现有 ProjectMembership/TeamMembership 的同空间、同账号、活跃身份。关联成员不可物理删除，已消费邀请不可更换空间，离队/移除仍更新历史成员状态。这里没有执行真实数据库迁移。`consumeInvitation(value,userId,membershipId,acceptedAt)` 的第三参数改为本次真实成员 ID；不能用空值创建新的消费事实。

职责表单只读本人 `/api/v1/me/participant-profile` 的经验作为预览，经“带入本人经验”明确点击后写入本地可编辑草稿。保存仍沿用项目独立意愿与本人选择的共享字段，不回写私人画像，不依 MBTI 或年龄推断职责；已有意愿与未保存经验不会被自动覆盖。

## U02 官方赛道、成员意愿与邀请名额

新增 `ProjectCollaborationService`、`PostgresProjectCollaborationRepository`、`createProjectCollaborationHandlers`，公共类型在 `collaboration.ts` 并由 `index.ts` 导出。

```ts
const collaboration = new ProjectCollaborationService({
  projects: projectsRepository, repository: new PostgresProjectCollaborationRepository(),
  officialRules: new PostgresOfficialTrackRulesPort(), // 从 M03 公共入口导入，公开注入 Port
  clock, ids,
});
const collaborationHandlers = createProjectCollaborationHandlers({ service: collaboration, resolveActor, authorizeMutation });
```

`PostgresOfficialTrackRulesPort` 使用 M02 传入的同一 `SqlExecutor` 读取 M03 正式规则确认、不可变规则快照与当前公开版本；M02 不读取/写入 M03 私有表。缺少官方规则 Port 时只影响赛道操作，意愿仍可独立使用。没有事务 executor 时返回 503，不以测试内存仓储作生产降级。

主会话执行新的根迁移时组合 `sql/ux-official-tracks-intentions.sql` 与 `sql/ux-invitation-capacity.sql`；它们只是建议，没有执行网站现有数据库。前者新增四张意愿/选择当前与历史表并扩展 `projects_change_fact_type_check`，后者新增邀请额度、不可变消费记录并将旧 `accepted` 单人邀请回填为 `maxUses=usedUses=1`。新仓储读写邀请需要后者迁移，不能先部署代码而不迁移。已应用的根迁移不改写。

| 建议根路由 | 工厂 route.kind | 返回 data |
| --- | --- | --- |
| GET `/projects/:id/official-tracks` | `officialTracks` | `ProjectOfficialTracksView` |
| PUT `/projects/:id/track-selection` | `trackSelection` | 同 GET view |
| GET/PUT `/projects/:id/my-intention` | `myIntention` | `MyIntentionView` |
| GET `/projects/:id/shared-intentions` | `sharedIntentions` | `SharedIntentionsView` |

赛道 PUT 输入 `TrackSelectionInput = {expectedRevision,eventId,rulesVersion,confirmationRevision,trackId,reason}`。初次选择 revision 为 0，后续使用选择自身 revision；同时核对正式规则指针和最新公开版本，避免换赛事但恰好同为版本 1 时写入旧表单。`none` 可用 `trackId:null` 确认统一要求；`unknown/conflict` 不能确认官方赛道。旧选择与历史保持，公开规则更新仅在 view 标记 `needsReview`，不更改分工/期限。

意愿 PUT 输入 `MemberIntentionInput = {expectedRevision,duties,experience,wantsAiHelp,helpQuestion,share}`，`share` 四项必须逐一提供布尔值，职责可多选或留空。职责值是 `requirements/design/development/testing/documentation/presentation/coordination/other`。本人可改，管理员也不能代改他人意愿。私人画像和测评均不读写。团队 projection 只包含显式 opt-in 字段；全私密时仅返回作者、revision、membershipRevision 和更新时间，使撤回共享也能使 AI 输入失效。离队排除；重新加入/角色 revision 变化后旧同意不会自动恢复。归档可读不可写。

两类保存都推进 `Project.revision` 并写同事务活动/outbox；摘要只含 revision/复核标记，不泄露私人问题或经验。`getCollaborationContext(actor,projectId)` 在一次项目锁内给根 M04/M05 适配器返回 `{project,members,officialTracks,intentions,availability}`；时间仍来自已有 M02 确认集合。根接口在同一 ambient DB 事务中重查当前账号、请求会话与活跃权限；不能将初始 Actor 快照当成登录会话始终有效的保证。HTTP mutation 必须经过已有 Origin/CSRF guard。

邀请新增 `InvitationInput.maxUses?:number`，默认 1，限制整数 1–50；role 省略默认普通成员，旧显式管理员/队长邀请兼容。每条链接额度固定，管理员角色仍通过空间中的明确管理操作调整。额度只在新增/重新加入成员时消费，活跃成员不耗额度不升级角色；使用过同一链接后离队/被移除不能重用，不退名额。`unique(invitation_id,user_id)`、scope 行锁、邀请 revision CAS、deferred 实际消费计数约束与不可改写消费表共同保留原子边界。邀请、额度、消费、成员与项目活动/outbox一起提交；队伍消费同事务保留带接受人和时间的独立审计记录。

匿名 GET `/invitations/:token/public-preview` 映射既有 `createProjectsHttpHandlers` 的新 `publicInvitationPreview`，只返回 `PublicInvitationPreview`。状态为 `pending/expired/revoked/used/unavailable`；有效时只显示 scopeType、名称、真实公开比赛名、邀请者公开 displayName、角色、到期与匿名名额，绝不返回 scopeId、私密目标、名单、邮箱、摘要、acceptances。失效名称等为 null；已满可保留匿名计数。旧需登录 GET `/invitations/:token` 与 POST accept 保留邮箱验证和当前权限，预览不会加入或消费。根提供 `publicInvitationDetails: PublicInvitationDetailsPort`，两个方法为 `getPublicEventName({projectId,initialEventId},transaction?)` 与 `getPublicDisplayName(userId,transaction?)`；只投影当前可公开读取的事实，不能从私人邮箱推导昵称。未注入时两名称字段为 null。前端可用独立只读 hook，避免登录状态 `/me` 401 清空匿名预览；根还应保持 token 不进日志的既有策略。

U02 验证运行 Node 内置 `node:test`，`tests/collaboration.test.ts` 使用隔离内存 PGlite 执行建议迁移和真实仓储，覆盖隐私撤回、归档、退出/重新加入、CAS、规则版本与事务回滚。`tests/invitation-capacity.test.ts` 覆盖两个 scope 的多名额、匿名隐私、邮箱限制、旧单人 backfill、末位并发、quota/成员/audit 回滚和消费不可删除。PGlite 为单连接，不能据此声称已通过线上多连接 PostgreSQL 或实际浏览器、邮件、DSH、GitHub 验收。无新增环境变量；根沿用已有数据库配置。

## 接入

```ts
import {
  PostgresProjectsRepository, ProjectsService, createInvitationTokens,
  createProjectsHttpHandlers,
} from "./src/modules/projects/index.ts";

const repository = new PostgresProjectsRepository(database);
const projects = new ProjectsService({
  repository, clock, ids, tokens: createInvitationTokens(),
  identity, availabilityValidator, workflow, resources, admission,
});
const handlers = createProjectsHttpHandlers({
  service: projects,
  resolveActor,        // M01 当前有效会话 -> Actor，不能读取请求 JSON 的 userId
  authorizeMutation,   // 主会话的 Origin/CSRF 写操作校验，必填
});

// Next.js 路由由主会话组合。示例：GET/POST /api/v1/projects
export const GET = (request: Request) => handlers.handle(request, { kind: "projects" });
export const POST = GET;
```

`database` 是共享 `DatabasePort` 的真实 PostgreSQL 连接池适配。`clock` / `ids` 来自共享契约。可选 Port 未注入时，服务仅开放不依赖该能力的流程：限定邮箱邀请接受、可用时间保存、进入执行/已记录提交阶段、审核资源 ID 收藏分别返回 `DEPENDENCY_UNAVAILABLE`，不假装外部能力已接入。普通邀请和手动 HTTP(S) 资料链接不依赖邮件或资源库。

审核资源查询 Port 为 `getReviewedResource(id,transaction?,expectedVersion?) -> {id,title,version} | null`。使用 `resources.getReviewedResources([id],transaction)` 构造此投影；返回当前版本，由 M02 对照 expectedVersion，过期引用返回 409。真实 `withProject` 回调提供同一 SqlExecutor；查询资源时锁 M09 发布行，直到 M02 提交。全部模块必须注入同一个支持当前事务查询复用的 DatabasePort。

`addReviewedResource(actor,{projectId,resourceId,resourceVersion,title,url,purposeNote}) -> {id,projectId}` 可直接接 M09 ProjectResourceSharePort。服务在项目锁内重新检查活跃成员、归档状态与当前审核版本，忽略传入 title/url，存储权威资源名和 `resourceVersion`；按项目+资源合并，重复同版本不会新增记录或事实。根迁移须增加 `resource_version` 并使用模块 SQL 的资源/版本配对约束。

M05 已提供结构兼容的 `createMemberAvailabilityValidator(access)` 与 `availabilityFromProjectCollection`，主会话可从 M05 的公共入口导入并注入。M02 不导入 M05 私有文件。窗口容量只由 M05 计算；集合与窗口在 M02 同一个事务写入。

## 权限与事务

- `ProjectAccessPort.getMembership` 返回当前成员关系，可能为 `left/removed`；所有调用者必须检查 `status === 'active'`，管理员动作还需要 `role === 'manager'`。
- `createdBy` 只留创建记录，平台管理员、队伍队长和同队关系都不授予私人项目权限。Team captain 的管理只作用于队伍。
- 个人项目创建即写入本人项目管理员关系；关联队伍时必须本人有活跃队伍成员关系且为项目管理员，明确确认不会自动加入其他队员。
- 项目所有写操作锁同一 Project 行；队伍写操作锁同一 Team 行。跨域关联固定先锁 Team、再锁 Project，嵌套仓储操作复用同一 SqlExecutor/事务。
- 项目编辑、成员角色/退出/移除、阶段和资料变更校验 `expectedRevision`。可用时间使用自己的集合 `expectedRevision`（首次为 0），同时推进 Project.revision，供计划输入失效检查。
- 最后一名活跃项目管理员不能退出、移除或降级。首版归档后仍保留管理员，避免没有恢复入口；档案保留与账户注销的转交策略由主会话后续定案。最后活跃队长可先转交或解散队伍。
- `transferProjectManagement/transferTeamCaptain` 在一次范围锁和事务中将目标活跃成员升为管理角色，将操作者降为普通成员；范围版本只增加一次，保留其他管理者。项目交接也可用于归档项目，仍保留归档状态和历史；队伍交接只用于活跃队伍，不改变任何项目权限。交接不是退出，成功后需要显式退出。
- 退出队伍不会连带退出项目；解散队伍撤销待消费邀请，保留全部项目、项目成员和成果。项目离队保留成员历史状态、作者归属、资料和已确认时间历史，但不再授予读取权限。

`getMembershipForUpdate(executor,projectId,userId)` 是 PostgreSQL 类的事务内公共访问适配，供 M03 确认规则、M04/M05 应用时与项目离队/降级使用同一 Project 锁。调用者必须传入自己当前事务的 SqlExecutor 并检查活跃状态与角色。不得另开事务后把权限快照用于写入。

`getPlanningContextForUpdate(executor,projectId,userId)` 在外部事务内锁 Project 并检查操作者活跃身份，返回项目修订号、历史/活跃成员与所有可用时间集合。M05 使用 `availabilityFromProjectCollection` 核对成员状态与 membershipRevision；这个内部快照接口保留历史，不能把旧集合直接当成当前容量。

## 邀请

邀请限定 project/team 范围、名额上限、目标角色、可选已验证邮箱和过期时间，默认 72 小时，最长 30 天（首版服务策略）。令牌使用 256-bit 随机值，只存 SHA-256 摘要；只有创建响应返回原始令牌。不得把响应、链接路径或令牌写入日志。

接受是明确的登录后 POST 操作。`now >= expiresAt` 拒绝新加入；管理员可撤销仍有名额的邀请。同用户重复接受返回现有成员关系；其他新人只有在剩余名额、身份和当前范围状态都有效时才可加入。已消费该链接后退出或被移除的人不能通过原邀请恢复权限，需新邀请。已有活跃成员接受另一份邀请不耗名额也不会暗中改变角色，角色变化必须走管理员入口。

`previewInvitation(actor,token)` 是登录后的只读预览，不消费邀请或加入成员。限定邮箱先核对已验证身份，仅返回 `scopeType/scopeId/scopeName/requestedRole/currentRole/expiresAt/alreadyMember/alreadyAccepted/maxUses/usedUses/remainingUses`；不返回邀请邮箱、摘要、创建者、接受者、成员名单或项目目标。预览与接受分别重查有效期、撤销、额度和当前关系，预览成功不保证随后接受成功。某人已消费该邀请时，必须仍是活跃成员才能通过原链接预览或幂等进入。

邀请无邮件发送副作用。调用者可生成 `/join/{token}` 链接，由用户复制给队友。HTTP 工厂设置 `private, no-store`、`no-referrer`，主会话也应在邀请落地页面设置对应策略。限定邮箱来自 `VerifiedIdentityPort`，请求自报邮箱不构成验证依据。

可选 `ProjectAdmissionPort` 在项目锁内检查已核验赛事限制，能保护同项目名额并发；没有已核验限制时不硬编码队伍人数。

## 可用时间、阶段与资料

可用时间窗口输入 `id/startsAt/endsAt/effectiveMinutes`，保留 IANA 时区、实际时刻和确认时间。M05 返回窗口修订号与汇总有效分钟。M02 当前窗口集合只有一个存储来源；M05 生效计划需持有输入快照，历史集合变更事实保留版本，不另外存重复容量。

`membershipRevision` 将时间确认绑定当前成员关系。离队后重新加入或角色变化使旧确认失效，`getPlanningContext/getAvailability` 过滤旧容量。`getMyAvailability` 允许本人读取先前集合修订号并显示 `confirmationRequired`，便于重新确认。

项目阶段必须显式变更并写说明：草稿→备赛→执行→整理提交→已记录提交→复盘→归档。未提交也可以复盘或归档。执行阶段需要已确认计划或实际手动任务；已记录提交需要 M06 真实记录查询，用户自报与平台验证仍由 M06 区分。阶段不会创建 SubmissionRecord、标记任务完成或授予仓库权限。归档恢复到草稿/备赛，并记录重新检查截止与授权的提示。

复制只选择目标/最小交付物文字与时区，新项目是私人草稿，只有操作者一名管理员；不复制旧截止、赛事、队伍、其他成员、可用时间、共享资料、测评、仓库授权或旧成功状态。创建时的 `eventId` 仅是未确认的初次选择，不开放 PATCH 修改；权威赛事关联、规则版本与截止由 M03 的确认指针/快照提供，界面与计划不能用这个初选字段替代它们。项目 `deadline` 只标为成员手填输入，不能代替已确认的赛事提交截止。

项目资料只引用当前审核资源 ID，或明确标为成员参考/待核验的 HTTP(S) URL。拒绝执行协议和包含用户名密码的链接；不抓取或执行外部 URL。相同项目资源引用幂等返回原记录，保留已有用途备注；仅收藏者或项目管理员能移除引用。M09 下架资源不删除现存项目备注；展示最新来源状态由集成层读取 M09。个人收藏不被这个模块读取，也不会因加入项目而共享。

## 事实通知

活动与 `ProjectCreated/ProjectScopeChanged/ProjectMemberJoined/ProjectMemberLeft/MemberAvailabilityChanged/ProjectStageChanged` 等变化事实和项目修改同事务保存。`listPendingFacts/acknowledgeFact` 是内部 dispatcher 接口，不是客户端权限入口。

离队响应的 `taskReassignmentPending: true` 表示已经保存待处理事实，不表示 M05 已完成重分配。统一 dispatcher 应将事实幂等交给 M04/M05，标记未完任务需重分配及计划需复核，保留完成成果，再 ack。可能重复投递，消费者以 eventId 去重并核对版本；一次角色更新可在同一 Project.revision 发多条不同事实，不能仅凭项目版本相同就跳过第二条。当前 ack 为全局确认，多消费者必须由统一 dispatcher 完成全部处理后确认，不能让一个消费者提前清掉其他人的通知。

所有注入的校验/身份/事实查询需使用本地确定性规则或受控数据库读取。不要在项目锁内发邮件、调用模型、执行 GitHub 写入或做无界网络请求。

## HTTP 路由映射

| 路径 `/api/v1` | descriptor.kind | 方法 |
| --- | --- | --- |
| `/projects` | projects | GET / POST |
| `/projects/{id}` | project | GET / PATCH |
| `/projects/{id}/team` | projectTeam | PUT |
| `/projects/{id}/invitations` | projectInvitations | GET / POST |
| `/projects/{id}/invitations/{invitationId}` | projectInvitation | DELETE |
| `/invitations/{token}` | invitationPreview | GET（本轮新增） |
| `/invitations/{token}/accept` | invitationAccept | POST |
| `/projects/{id}/members` | projectMembers | GET（本轮新增） |
| `/projects/{id}/members/{userId}` | projectMember | PATCH / DELETE |
| `/projects/{id}/management-transfer` | projectManagementTransfer | POST（本轮新增） |
| `/projects/{id}/leave` | projectLeave | POST |
| `/projects/{id}/my-availability` | projectAvailability | GET / PUT |
| `/projects/{id}/stage` | projectStage | POST |
| `/projects/{id}/clone` | projectClone | POST |
| `/projects/{id}/activity` | projectActivity | GET |
| `/projects/{id}/resources` | projectResources | GET / POST |
| `/projects/{id}/resources/{bookmarkId}` | projectResource | DELETE |
| `/teams` | teams | GET / POST |
| `/teams/{id}` | team | GET / PATCH / DELETE（解散） |
| `/teams/{id}/invitations` | teamInvitations | GET / POST |
| `/teams/{id}/invitations/{invitationId}` | teamInvitation | DELETE |
| `/teams/{id}/members` | teamMembers | GET（本轮新增） |
| `/teams/{id}/members/{userId}` | teamMember | PATCH / DELETE |
| `/teams/{id}/captain-transfer` | teamCaptainTransfer | POST（本轮新增） |
| `/teams/{id}/leave` | teamLeave | POST |

写操作用 JSON，普通版本动作携带 `expectedRevision`。请求体最大 64 KiB，不接收 Actor/userId/createdBy 的客户端身份字段。成员路径 `userId` 只用作管理员指定目标，自己退出和可用时间写入从 Actor 取本人。响应遵循共享 `data/error/requestId` 格式，未知异常不泄露内部栈或凭据。

本轮新增行是已实现的公开 handler 契约，主会话需要在根 router 映射这五个路径。原有团队 CRUD/成员/邀请/退出已由根 router 映射；`/stage` 与当前根路由保持一致。`projectMembers/teamMembers` 查询可用 `?history=true`，默认仅活跃成员；历史是当前成员关系状态快照，不是完整团队审计时间线。

### 团队管理请求与响应

| 操作 | JSON 请求 | `data` |
| --- | --- | --- |
| POST `/teams` | `{name}` | `Team`（201） |
| GET `/teams` | 无 | 本人的活跃成员队伍 `Team[]`，含已解散队伍 |
| GET `/teams/{id}` | 无 | `{team,membership,members,projects}`；projects 仅本人有活跃 ProjectMembership 的关联项目 |
| PATCH `/teams/{id}` | `{expectedRevision,name}` | 更新后的 `Team` |
| DELETE `/teams/{id}` | `{expectedRevision}` | `{team,projectMembershipsUnchanged:true,projectsPreserved:true}` |
| GET `/teams/{id}/invitations` | 无 | `PublicInvitation[]`，仅队长可读，不含 tokenHash 或原始 token |
| POST `/teams/{id}/invitations` | `{expectedRevision,role,invitedEmail?,expiresAt?}` | `{invitation,token,teamRevision}`（201），role 为 captain/member |
| DELETE `/teams/{id}/invitations/{invitationId}` | `{expectedRevision}` | `{invitation,teamRevision}` |
| GET `/teams/{id}/members?history=true` | 无 | `{membership,teamRevision,members}` |
| PATCH `/teams/{id}/members/{userId}` | `{expectedRevision,role}` | `{membership,teamRevision}`，role 为 captain/member |
| DELETE `/teams/{id}/members/{userId}` | `{expectedRevision}` | `{membership,teamRevision,projectMembershipsUnchanged:true}` |
| POST `/teams/{id}/captain-transfer` | `{expectedRevision,targetUserId}` | `{teamRevision,previousCaptain,targetCaptain,projectMembershipsUnchanged:true}` |
| POST `/teams/{id}/leave` | `{expectedRevision}` | `{membership,teamRevision,projectMembershipsUnchanged:true}` |

项目管理权转交请求相同，返回 `{projectRevision,previousManager,targetManager,availabilityConfirmationRequiredUserIds,otherManagersUnchanged:true}`。`previousManager/previousCaptain` 是交接后的普通成员关系；目标是同范围活跃成员且不能是本人；已有管理者目标可接管，未变角色的目标不会增加成员版本。角色变更的项目成员需要重新确认可用时间。

前端用 `membership.role/status` 判断当前动作，并将最新范围 `revision` 带入写请求。版本冲突显示最新内容并让用户重新确认，不自动覆盖。邀请页先 GET 预览，再明确 POST `/invitations/{token}/accept`；接受响应 `{scopeType,scopeId,membership,revision,alreadyAccepted}`，按范围跳到 `/app/teams/{scopeId}` 或 `/app/projects/{scopeId}`。已是成员时显示 `currentRole`，不能把请求邀请的角色说成实际角色。

解散后仍显示本人有权访问的项目与本人退出入口；改名、创建邀请、交接和角色编辑不可用。项目成员管理应接现有移除、退出、撤销邀请、队伍关联入口，归档仍允许管理权转交和在保留管理员条件下退出/移除。成员 DTO 无邮箱或显示名；可暂时展示 userId，显示名需要 M01 提供受限投影。

## 迁移、验证与环境

`sql/001-projects.sql` 仅是模块迁移建议，主会话决定组合与执行。建表包含成员唯一约束、邀请摘要唯一约束、项目资料引用唯一约束和修订号约束。User/Event/Resource 的表名与跨模块外键由集成迁移决定；不要从这个文件独立删库或覆盖其他模块数据。

Node 24 可直接运行 TypeScript 业务测试。执行：

```powershell
node --test src/modules/projects/tests/*.test.ts
npm run typecheck
```

最终验证 79/79（31服务、8原有HTTP/令牌安全、12模拟SQL、21新增团队Request/Response handler、7新增PGlite实际SQL）。模块独立strict类型检查通过；当前全局typecheck的其他模块错误见 `docs/协作/交付/projects.md`。内存夹具/模拟SQL、PGlite SQL约束和独立PostgreSQL多连接竞争分别标明，不混称真实服务验收。根路由接入与浏览器贯通由主会话验证。

环境变量：连接池由主会话使用 `DATABASE_URL`；本模块不自行读取环境变量，不需要邮件、模型或 GitHub 凭据。
