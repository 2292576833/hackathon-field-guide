# O02 报名与赛事队伍交付

日期：2026-10-11。所有权仅 `src/modules/event-registration/` 与本文。依据规划21、O02规划、宪法v1.11.0及本轮分工；未编辑根 app/server/shared/components、实际 migrations、配置或依赖。

## 状态

- 已实现：版本化动态表单、私人草稿、真实提交/审核/撤回、免费报名额度、幂等/版本/事务、分页及安全CSV。
- 已实现：自愿加入正式队伍、真实接受名额、一赛一活跃队伍、队長交接、锁定与名单历史、报名失效推导资格、工作人员说明原因重新开放名单、assigned/mixed人工建议与本人确认。
- 已实现：共享 `EventParticipationPort`、私人项目显式关联请求/当前管理员确认、公开最小招募投影、纯队伍工作人员安全候选投影。
- 已实现：报名/队伍/工作人员/我的比赛客户端组件、手机样式、常见字段配置、当前比赛与期限、错误保留输入、比赛切换处理草稿。
- 已隔离验证：完整模块39项Node测试通过，根全量TypeScript检查通过；均不连接实际生产数据库。UI另有隔离浏览器夹具验证，见下节。
- 未根接入：路由、页面/导航、真实 O01 授权适配、M02 当前管理员确认、实际SQL迁移与实际应用联调由主会话完成。本交付不代表网站已经可用。
- 外部未验收：真实多连接PostgreSQL竞争、真实机构/选手赛事、实际手机和公网登录返回、生产部署与TLS。本模块没有外部发送、收费、AI或生产库操作。

## 文件清单

| 文件 | 作用 |
| --- | --- |
| src/modules/event-registration/model.ts | 动态字段/答卷、队伍/建议/关联/分页/输入输出类型 |
| validation.ts | 白名单/长度/必填/类型/选项/URL/版本、CSV公式转义、规范化指纹 |
| repository.ts | 自有持久操作接口，仅当前executor和自身表 |
| postgres.ts | PostgresRegistrationRepository及PostgresRegistrationStore真实SQL适配 |
| sql/001-event-registration.sql | 模块内增量迁移建议，引用auth_users和自身表 |
| service.ts | 事务服务、组织/赛事/本人/工作人员权限、名单/额度/Port |
| ports.ts | 当前空间管理员只读预览、官方赛道配置的根接入提议 |
| http.ts | 固定方法HTTP工厂、可信Principal、同源授权注入、有界JSON、私有envelope |
| index.ts / ui.ts | 服务公共导出 / 客户端公共导出 |
| RegistrationPanel.tsx / RosterTeamsPanel.tsx | 本人报名、正式队伍与明确空间关联 |
| RegistrationManager.tsx / MyCompetitions.tsx / registration.module.css | 工作人员操作、本人比赛导航、暖白橙红手机样式 |
| postgres.test.ts / service.test.ts / http.test.ts / validation.test.ts / test-fixture.ts | 真实隔离SQL、业务、HTTP、校验测试及受控Port夹具 |
| README.md | 工厂接入、规则、完整HTTP及Port说明 |

目录项除首行外均位于 `src/modules/event-registration/`。

## 服务与持久工厂构造参数

`createEventRegistrationService(dependencies): EventRegistrationService` 与 `new EventRegistrationService(dependencies)`：

| 参数 | 类型/责任 |
| --- | --- |
| database | 必填 DatabasePort，根既有真实数据库实例；不可内存降级 |
| events | 必填 HostedEventAccessPort，getEvent/requireStaff在同SqlExecutor读取并锁定当前真实赛事/授权 |
| projectLinks | 必填 EventProjectLinkPort；confirmLink锁定/复核当前账号、请求会话、M02 manager、project revision及event/team/project显式映射，不授主办方项目权限，POST重试可重入 |
| clock | 必填 Clock；报名和组队窗口使用服务器时间 |
| ids | 必填 IdGenerator |
| projectLinkPreview | 可选 EventProjectLinkPreviewPort；非队员空间管理员的只读预览。未配时非队员GET403，没有写确认降级 |
| tracks | 可选 EventTeamTrackPort；官方赛道当前配置。未配时只允许空赛道，不虚构官方选项 |

`new PostgresRegistrationRepository(database: DatabasePort)` 暴露 `database` 与 `store(sql: SqlExecutor): RegistrationStore`。另导出 `new PostgresRegistrationStore(sql)`。GET只读，不创建 event_state；写调用 `lockEvent` 后才操作自有表。

所有非公开服务方法首参均为根构造 `OrganizerPrincipal {actor,guard}`；guard必须是当前账号与本次会话的真实复核函数，不能由JSON填充。服务在同事务前后执行guard，并前后复核工作人员能力及赛事归属/revision。统一锁序：会话 → O01赛事 → O02赛事 → 自有行。

`EventRegistrationService` 同时实现 `EventParticipationPort`：

- `getRegistration(sql,eventId,userId): Promise<EventRegistrationSnapshot|null>`，只给id/eventId/userId/status/revision，不给答卷/邮箱。
- `getTeam(sql,eventId,teamId): Promise<EventRosterTeamSnapshot|null>`，真实接受成员、当前报名批准、人数、官方赛道、冻结名单版本共同推导eligible。项目ID只是明确关联事实，不赋予读私人空间权限。
- 两者是可信内部Port，不是公开授权入口；调用模块负责本次账号/会话/赛事授权，并复用同executor，不能缓存旧权限。

## 输入类型

所有Body类型均从 `index.ts` 导出；所有字符串/数组/数字在服务重新校验。

| 类型 | 字段 |
| --- | --- |
| SaveFormInput | expectedRevision（首次0）、title、description、fields、changeNote（更新必填） |
| RegistrationField | id、type=text/textarea/number/choice/multichoice/url、label、description、required；按类型可有maxLength/min/max/options |
| SaveDraftInput | expectedRevision（首次0）、formRevision、answers（白名单字段→string/number/string[]） |
| MutationInput | expectedRevision（>=1）、idempotencyKey |
| ReviewRegistrationInput | MutationInput＋decision=approved/rejected、note（拒绝必填） |
| CreateTeamInput | name、introduction、track（官方ID或空）、idempotencyKey、suggestionId? |
| JoinTeamInput | expectedTeamRevision、message、idempotencyKey；本人发起才表示本人愿意 |
| RespondJoinInput | MutationInput＋expectedTeamRevision、decision=accepted/rejected、note（拒绝必填） |
| LeaveTeamInput | MutationInput＋successorUserId?（有其他成员的队长退出时需有效接任者） |
| ReopenRosterInput | MutationInput＋note（原因必填） |
| ProposeTeamInput | captainUserId、memberUserIds、name、track、note、idempotencyKey；仅建议，不生成成员 |
| RequestProjectLinkInput | MutationInput＋projectId |
| ConfirmProjectLinkInput | MutationInput＋expectedProjectRevision、expectedTeamRevision；当前空间管理员明确确认 |

分页 `cursor?`、`limit?`（默认20，上限100）；工作人员报名列表可传status=pending/approved/rejected/withdrawn，不能读私人draft。导出最多5000条，输出JSON `ExportResult {filename,contentType,csv,count}`，CSV已含UTF-8 BOM。

## HTTP工厂、方法、输出与权限

`createEventRegistrationHandlers({service,resolvePrincipal,authorizeMutation,requestIds,maxJsonBytes?})`：

- service为上面的EventRegistrationService；resolvePrincipal从真实请求会话返回Principal/null。
- authorizeMutation由根实现Origin/CSRF，所有非GET在入服务前调用。
- requestIds为IdGenerator。maxJsonBytes默认/上限131072，流式有界且拒绝无效UTF-8、压缩正文、未知顶层字段。
- 每个handler `(request:Request,params?:{eventId?,registrationId?,teamId?,requestId?})=>Promise<Response>`，固定方法不匹配405及Allow。返回共享 `{data,requestId}`/error envelope，private,no-store。
- 幂等请求头可代正文；正文和头同时存在须一致。其余输入完全由表中Body类型决定，不能自报organization/actor/权限。

建议路径以下均省略 `/api/v1`；客户端现有api函数已加该前缀。根最终挂载这些路径。

| handler / 对应service方法 | HTTP与路径 | 输入→data输出 | 当前授权 |
| --- | --- | --- | --- |
| getRegistrationForm | GET /competitions/:eventId/registration-form | 无→RegistrationFormView | 公开发布/历史赛事 |
| getStaffForm | GET /organizer/events/:eventId/registration-form | 无→RegistrationFormView | registration_manage |
| saveForm | PUT 同上 | SaveFormInput→RegistrationForm | registration_manage |
| getMine | GET /competitions/:eventId/my-registration | 无→MyRegistrationView | 本人 |
| saveDraft | PATCH 同上 | SaveDraftInput→Registration | 本人 |
| submit / withdraw | POST 同上/submit或/withdraw | MutationInput→Registration | 本人 |
| listStaff | GET /organizer/events/:eventId/registrations | 分页/状态→StaffRegistrationsView | registration_manage |
| review | POST 同上/:registrationId/review | ReviewRegistrationInput→Registration | registration_manage；私人草稿旧回执也不可读取 |
| exportRegistrations | GET 同上/export | 无→ExportResult | registration_manage |
| listTeams | GET /competitions/:eventId/teams | 分页→TeamsView | 登录本人；公开队伍＋本人队伍/申请 |
| createTeam | POST 同上 | CreateTeamInput→RosterTeam | 本人approved；assigned需本人建议 |
| listPublicTeams | GET 同上/public | 分页→{event,teams:Page<PublicRosterTeam>} | 公开最小招募投影 |
| listStaffTeams | GET /organizer/events/:eventId/teams | 分页→{event,teams:Page<RosterTeam>} | teams_manage |
| getStaffCandidates | GET /organizer/events/:eventId/team-candidates | 分页→{event,candidates:Page<TeamCandidate>} | teams_manage；只有userId/registrationId/revision |
| listTeamSuggestions | GET /organizer/events/:eventId/team-suggestions | 无→TeamSuggestion[] | teams_manage |
| proposeTeam | POST 同上 | ProposeTeamInput→TeamSuggestion | teams_manage |
| requestJoin | POST /competitions/:eventId/teams/:teamId/join-requests | JoinTeamInput→JoinRequest | 本人approved |
| respondJoin | POST 同前/requests/:requestId/respond | RespondJoinInput→JoinRequest | 当前队长，重放亦复核 |
| cancelJoin | POST 同前/requests/:requestId/cancel | MutationInput→JoinRequest | 申请本人 |
| leaveTeam | POST 同前/leave | LeaveTeamInput→RosterTeam | 当前真实队员 |
| lockRoster | POST 同前/lock | MutationInput→RosterTeam | 当前队长，重放亦复核 |
| reopenRoster | POST /organizer/events/:eventId/teams/:teamId/reopen | ReopenRosterInput→RosterTeam | teams_manage；不改组队截止 |
| getProjectLink | GET /competitions/:eventId/teams/:teamId/project-link | 无→ProjectLinkRequest/null | 当前队员，或根preview复核的当前项目manager |
| requestProjectLink | POST 同上 | RequestProjectLinkInput→ProjectLinkRequest | 当前队长，重放亦复核 |
| confirmProjectLink | POST 同上/:requestId/confirm | ConfirmProjectLinkInput→RosterTeam | 根复核当前M02 manager/版本；重放亦复核 |
| listMine | GET /me/competitions | 分页→Page<MyCompetition> | 本人报名事实（O01工作人员/评委入口由根另组合） |

## UI exports 与 props

从 `ui.ts` 导入客户端组件，与服务index分离：

| export | props | 行为 |
| --- | --- | --- |
| RegistrationPanel | {eventId:string,signedIn?:boolean}（默认true） | 动态报名；登录/注册保留returnTo；旧schema明确采纳与原答卷对照；失败保留输入 |
| RosterTeamsPanel | {eventId:string,currentUserId:string} | 本人队伍、真实人数、本人申请/队长接受、建议确认、锁定/退出及空间关联 |
| ProjectLinkConfirmation | {eventId:string,teamId:string,onConfirmed?:()=>void} | 从明确关联请求读取预览，核对当前manager并显式确认；根可独立挂确认页 |
| RegistrationManager | {eventId:string} | 待审核优先；动态字段编辑、上下移动、说明/审核/CSV；高级组队项按需展开 |
| RosterTeamManager | {eventId:string} | 纯teams_manage入口；安全候选、人工分组与说明原因重新开放名单，无答卷权限 |
| MyCompetitions | 无props | 从本人真实报名进入正确比赛/队伍，分页与明确状态 |

关键比赛/组织/身份、报名/组队期限保持可见；纯文本字段无需JSON；响应式主要按钮不需横向滚动。切换比赛时处理未保存输入，旧编辑器在确认前仍绑定原赛事，不能把本地草稿投给另一赛。未知网络结果沿用同输入幂等键重试，失败不清空资料。

## SQL与业务事实

SQL建议文件：`src/modules/event-registration/sql/001-event-registration.sql`，主会话分配后续实际迁移编号，不重写已应用迁移。自有10表：event_state/forms/registrations/teams/members/join_requests/project_links/team_suggestions/history/receipts，前缀 `event_registration_`。外键仅auth_users与自身表。

表单、变更历史、回执不可UPDATE/DELETE；建议原文不可更改，只能首次填入确认team_id。报名唯一(event,user)，真实accepted成员partial unique(event,user)且left_at IS NULL；答案/队伍JSON不是名额或权限来源。CAS保存与不可变历史同事务。pending/approved占额度，draft/rejected/withdrawn不占；拒绝/撤回保留历史。

锁定保存真实成员及批准答卷版本。成员离开，即使剩余人数仍达到最低，也不能把旧锁定名单判为有效；报名撤回/被拒、版本改变同样复核。私有ProjectMembership始终由M02独占，不因这些变化被删除或复制。

## 验证结果

执行命令：

```powershell
node --experimental-strip-types --test src/modules/event-registration/postgres.test.ts src/modules/event-registration/service.test.ts src/modules/event-registration/http.test.ts src/modules/event-registration/validation.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

结果：39 tests / 39 pass / 0 fail，20.77秒；TypeScript全仓检查exit0。四组分别SQL10、业务19、HTTP6、输入4。只有全新内存PGlite和受控多机构多赛Port，未加载`.env.local`或打开实际PGlite。

有意义覆盖：双组织/同用户双赛隔离、旧表单/原schema不改、最后报名/队伍名额、幂等变输入冲突、拒绝/撤回释放额度、草稿不进入工作人员名单/导出/旧审核回执、teams-only最小候选投影、撤权和赛事组织变更导致整事务回滚、本人加入/待请求不占位/一赛唯一活跃队伍、队长交接后旧回执拒绝、锁定名单与当前报名版本、退出历史不删、私有空间manager确认和根写同事务回滚、GET不调用confirmLink、assigned第101条建议不被展示上限误拒、正式赛道跨赛拒绝、CSV隐藏前缀公式转义、HTTP方法/Principal/CSRF/有界JSON。

并发Promise调度是单连接PGlite隔离演练，不等于真实多连接PostgreSQL；已提供赛事锁、CAS与数据库唯一约束供根目标环境验证。

UI隔离浏览器夹具检查11项通过、browserErrors为空：旧schema明确采纳及有效答案迁移、保存409保留输入、切换赛事不跨赛写、加入409保留输入/复用幂等键、360px无横向溢出且未配赛道无自由输入、审核409保留说明、我的比赛目的链接、纯队伍管理不读取报名答卷、拒绝/撤回后未改答案也先保存draft再提交、开放前可保存草稿且不会提交、组队截止后仍可锁定已有合格名单但不能接受新成员。该结果使用内存HTTP夹具，不是根实际应用或真实手机验收。

## NEEDS_INTERFACE / 根待办

1. 接入既有共享 `HostedEventAccessPort` 和 `EventProjectLinkPort`，同executor锁定真实授权。confirmLink必须可重入；若项目manager被撤权，旧幂等键亦不返回旧关联数据。
2. 新提议 `EventProjectLinkPreviewPort.requireManagerPreview(sql,principal,{eventId,teamId,projectId}): Promise<void>`，在根以当前M02 manager/账号/本次会话做只读复核和锁定。例：队长不是私人空间管理员，请求关联后把确认链接给管理员；非队员管理员读取这条待确认预览，确认前不关联。不接此Port则非成员预览403（没有读取/写入私有空间降级）。
3. 新提议 `EventTeamTrackPort.getConfiguration(sql,eventId): Promise<TeamTrackConfiguration>`，由根对真实已发布赛道给configured/required/revision及id/title选项，限定当前赛事并复用executor。例：赛事A有track-a，赛事B的track-b不能用于A。公共Scope暂未包含赛道，未配置时只能空赛道并明确显示待接入，不把自由标签当官方赛道。
4. 根可在安全必要身份投影提供本人公开称呼，方便工作人员辨认候选/队员；当前只有可信userId，不推断姓名，不为纯teams_manage读取答案、邮箱或私人画像。尚未添加此共享身份Port，无伪造称呼。
5. 根组合固定方法路由、网站页面/入口、returnTo允许路径、M02私人项目选择/manager预览、实际增量迁移、手机与多角色端到端验收；按当前权限单独显示registration_manage或teams_manage入口，身份切换时以当前账号key重新挂载私人组件并清除旧页面缓存。导出是JSON envelope内CSV，由客户端下载。

环境变量：本模块不新增环境变量。数据库/会话/Origin沿用根已有配置（真实连接部署可使用既有DATABASE_URL）；无密钥值、第三方请求或模型预算。

## 交还

本会话已完成本轮授权范围内实现与隔离验证，明确停止编辑，交还 `src/modules/event-registration/` 与本文，主会话可统一组合。所有已交付代码均在本轮授权范围，后续修改不得沿用旧授权覆盖主会话接入工作。
