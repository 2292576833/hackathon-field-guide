# O04 正式收件与人工评审交付

日期：2026-10-11。授权文件仅 `src/modules/event-judging/` 和本交付。没有编辑根app/server/shared、依赖、实际迁移或其他模块。

## 已实现

- 正式材料预览、当前队长授权收件、锁定名单/通过报名/期限/事件与队伍版本复核、上一版本CAS、同键同输入重放和异输入拒绝。不可变回执记录组织/赛事/队伍/作者/时间/规则与配置版本/哈希/版本/编号。原文件hash为选手元数据，材料hash是服务端冻结内容hash，不冒充下载或运行验证。
- 真实DatabasePort持久适配，组织/赛事范围过滤、复合关联、版本CAS；模块事件锁串行写、事务回滚，原始回执/公布版本/审计SQL层禁止UPDATE/DELETE。
- 开轮前评分配置校验、开轮冻结最新正式作品及标准；指定评委、系统已知成员检查、可信关联核查、本人声明/回避、待人工核查、撤销；非clear不能读取/打分。评委投影不含成员名单、作者、重试key、其他作品名单或汇总。
- 人工部分维度草稿/完整整数正式分数、纠正必填说明、修改前后审计；最少有效评委、缺评null、归一化权重汇总、并列或仅同分人工排序。
- 预览/锁定/手工公布/撤回/重开、递增公布版本；公布绑定预览hash，JSONB对象字段重排不会改变hash；公开与参与者范围、当前队伍反馈隔离；公开结果仅最新可见轮，明确轮名。
- `judging_manage` 才能管理/导出/读审计，CSV文本防公式注入。管理员不能代未指派评委打分。
- 四个客户端组件、同赛事路径、服务端确认、期限与当前待办、手机样式、失败保留输入。AI只有严格材料摘要契约，无真实/静态假分析，无评分字段，无导航或备赛记忆依赖。

## 文件与SQL

逻辑：`model.ts,ports.ts,validation.ts,service.ts,postgres.ts,http.ts,index.ts`。
界面：`JudgingPanels.tsx,judging.module.css,ui.ts`。
数据库建议：`src/modules/event-judging/schema.sql`，7表 `ej_event_locks,ej_intake_receipts,ej_judging_rounds,ej_judge_assignments,ej_manual_scores,ej_published_results,ej_judging_audits`；根必须分配实际增量迁移编号，未运行根迁移。
测试：`validation.test.ts,http.test.ts,service.test.ts,postgres.test.ts`。

## 服务工厂与权限

`createEventJudgingService(deps:EventJudgingDependencies):EventJudgingService`：

| 参数 | 类型/必选 | 行为 |
| --- | --- | --- |
| database | DatabasePort，必选 | 所有私人读取/写入同transaction，生产不得内存降级 |
| clock / ids | Clock / IdGenerator，必选 | 服务端时间与不可预测唯一ID |
| events | HostedEventAccessPort，必选 | 当前事件归属/状态/版本；同事务requireStaff判断judging_manage |
| participation | EventParticipationPort，必选 | 当前报名、队伍成员/队长/资格/名单版本；根须实现下述锁定约定 |
| conflicts | EventJudgeConflictPort，必选 | 当前参赛/备赛关联核查，needs_review不放行 |
| verifiedSubmissions | VerifiedEventSubmissionPort，可选 | 可信M06正式事实，同executor本地事务写入；不能网络外部副作用 |
| submissionLinkContext | 本模块SubmissionLinkContextPort，可选 | resolve(sql,principal,event,team)→{stageId:string,requirementsVersion:string,repositoryCommitSha:string\|null}\|null；完整确认键`${linkedEventId}:${rulesVersion}:${confirmationRevision}`，与verifiedSubmissions成对 |

私人方法统一首参 `principal:OrganizerPrincipal`；除本人赛事发现`listAssignedEventIds`外，次参为 `eventId:string`。服务端Principal含真实actor与请求session guard，HTTP JSON不能构造它。scope从event Port读取，不信任JSON organizationId。

| 服务方法 | 后续输入 | 输出 | 权限 |
| --- | --- | --- | --- |
| listAssignedEventIds | 无eventId、无userId | Promise<string[]> | 当前本人有效session，active/needs_review指派对应去重赛事ID，按ID升序最多100；候选末次复核，前后session guard；不授予作品/评分权限 |
| previewSubmission | {teamId,materials} | SubmissionPreview | 当前队长/approved报名/eligible且locked队伍/开放截止内 |
| submit | SubmissionInput | IntakeReceipt | 同上；已保存重放只复核当前队伍读取权限，截止后可查真实回执 |
| mySubmissions | teamId | {items:IntakeReceipt[]} | 当前队伍成员，前后复核 |
| workspace | 无 | JudgingWorkspace | judging_manage，前后复核 |
| saveConfig | {roundId?,expectedRevision,config} | JudgingRound | judging_manage，仅setup；新轮expectedRevision=0 |
| startRound / lockRound | roundId,expectedRevision | JudgingRound | judging_manage，状态与版本复核 |
| reopenRound | roundId,{expectedRevision,reason} | JudgingRound | judging_manage，仅locked；published须先撤回 |
| assignJudge | {roundId,snapshotId,judgeUserId,expectedRoundRevision} | JudgeAssignment | judging_manage，open、正式冻结快照、当前关联 |
| reviewAssignment / revokeAssignment | assignmentId,{expectedRevision,reason} | JudgeAssignment | judging_manage，open；review要求可信Port现为clear，不能覆盖已知冲突 |
| declareConflict | assignmentId,{expectedRevision,hasConflict,reason} | JudgeAssignment | 本人指派；有冲突可在locked/published立即回避，无冲突仅open |
| judgeAssignments | 无 | {items:JudgeWorkItem[]} | 只查本人指派；读取score后及完整列表返回前再核权，访问变化清title/score，新增accessStatus为当前可读依据 |
| judgeMaterials | assignmentId | {assignment,round:JudgeRoundView,receipt:JudgeReceiptView,score:ManualScore\|null} | 本人active+clear指派、实时ConflictPort clear，前后复核 |
| saveScore / submitScore | assignmentId,ScoreInput | ManualScore | 本人有效评委、open；draft可部分维度、submit须完整；已提交纠正必填说明 |
| previewResults | roundId | {round,summary,summaryHash,publicationReview} | judging_manage，实时有效分检查及已有公布待复核信号 |
| publishResults | roundId,PublishInput | PublishedResults | judging_manage，locked、当前revision/hash相符、人工批准反馈 |
| withdrawResults | roundId,{expectedRevision,reason} | JudgingRound | judging_manage，published、版本复核，历史不改 |
| myResults | 无 | ResultProjection | 本人真实session；参与者范围复核approved、队伍反馈当前成员前后复核 |
| exportScores | 无 | {filename,csv} | judging_manage，CSV文本防公式 |
| auditHistory | 无 | {items:JudgingAudit[]} | judging_manage，完整改分/锁定/公布/撤回审计 |
| publicResults | 只有eventId，无principal | ResultProjection | published/ended赛事，仅公开发布投影 |

`SubmissionMaterials={title,description,links:[{label,url}],files:[{name,url,sizeBytes,sha256,mediaType}]}`；名称160/说明12000字符且总24KB、links/files各12、HTTPS无凭据；文件最多1GiB的元数据，不上传/下载。
`SubmissionInput={teamId,materials,expectedEventRevision,expectedTeamRevision,expectedPreviousVersion,expectedMaterialHash,idempotencyKey}`；重试key最长120，范围event+author，团队版本和上一作品版本防跨作者覆盖。
`JudgingConfig={title,criteria:[{id,label,weight,min,max}],minJudges,missingPolicy,tiePolicy}`；1–12维度，范围0–1000整数/权重1–100整数且总100/最少1–20评委；`missingPolicy=block_publication|exclude_incomplete`，`tiePolicy=shared_rank|manual_order`。
`ScoreInput={expectedAssignmentRevision,expectedScoreRevision,values:Record<criterionId,integer>,feedback,correctionReason?}`；新分数revision=0；已submitted纠正必填reason1000，反馈3000。
`PublishInput={expectedRevision,expectedSummaryHash,visibility:public|participants,orderedSnapshotIds?,approvedFeedback:[{snapshotId,text,visibility:team|public}]}`；manual_order须完整有效作品顺序且不能颠倒不同总分；批准反馈最多每作品每范围一条3000。

## HTTP工厂与建议路由

`createEventJudgingHandlers({service,resolvePrincipal(request),authorizeMutation(request,principal),requestIds})`。
统一 `(request:Request, params:{eventId,roundId?,assignmentId?})→Promise<Response>`。200成功 `{data:<上表对应输出>,requestId}`；失败沿用DomainError envelope，无内部stack/provider响应。私有方法由根真实session解析和Origin/CSRF授权；JSON最多64KB且不接受压缩。GET仅读取，无模型调用。所有响应no-store。

| 工厂成员 | 方法 | /api/v1后路径 | JSON/query |
| --- | --- | --- | --- |
| previewSubmission | POST | /competitions/:eventId/submissions/preview | {teamId,materials} |
| submit | POST | /competitions/:eventId/submissions/submit | SubmissionInput，可传Idempotency-Key header；与body不一致拒绝 |
| mySubmissions | GET | /competitions/:eventId/my-submissions | ?teamId=... |
| workspace | GET | /organizer/events/:eventId/judging/config | 无 |
| saveConfig | PUT | 同上 | {roundId?,expectedRevision,config} |
| startRound / lockRound / reopenRound | POST | /organizer/events/:eventId/judging/rounds/:roundId/start\|lock\|reopen | {expectedRevision,reason?} |
| assignJudge | POST | /organizer/events/:eventId/judge-assignments | {roundId,snapshotId,judgeUserId,expectedRoundRevision} |
| reviewAssignment / revokeAssignment | POST | /organizer/events/:eventId/judging/assignments/:assignmentId/review\|revoke | {expectedRevision,reason} |
| judgeAssignments | GET | /judging/:eventId/assignments | 无 |
| judgeMaterials | GET | /judging/:eventId/assignments/:assignmentId/materials | 无 |
| declareConflict | POST | /judging/:eventId/assignments/:assignmentId/conflicts | {expectedRevision,hasConflict,reason} |
| saveScore / submitScore | POST | /judging/:eventId/assignments/:assignmentId/scores/draft\|submit | ScoreInput |
| previewResults | POST | /organizer/events/:eventId/judging/results/preview | {roundId} |
| publishResults | POST | /organizer/events/:eventId/judging/results/publish | {roundId,...PublishInput} |
| withdrawResults | POST | /organizer/events/:eventId/judging/results/withdraw | {roundId,expectedRevision,reason} |
| publicResults | GET | /competitions/:eventId/results | 无，匿名安全投影 |
| myResults | GET | /competitions/:eventId/results/mine | 无，private no-store |
| exportScores / auditHistory | GET | /organizer/events/:eventId/judging/export\|audit | 无，judging_manage |

## UI exports / props

从 `src/modules/event-judging/ui.ts` 导出：

- `EventSubmissionPanel({eventId,eventTitle,organizationName,teamId,deadline?})`：明确材料预览→本人确认→正式回执，重试保持相同key和原预览输入。
- `JudgeWorkspace({eventId,eventTitle,organizationName})`：本人指派与无冲突申报、原材料优先、手工评分草稿与正式提交，不显示假AI摘要。
- `JudgingManager({eventId,eventTitle,organizationName,judgeOptions?,refreshRevision?})`：配置/当前待办/指派核查/锁定/汇总与人工公布。`judgeOptions?:readonly{userId,displayName}[]` 是根可信候选供易用选择，不作为授权；缺候选不虚构评委目录。`refreshRevision?:number`用于同账号同赛事外部事实刷新，变化只调用workspace.reload，保留未保存配置草稿。
- `EventResultsPanel({eventId,eventTitle,organizationName,scope?})`：scope默认public；mine调本人反馈。当前轮名、发布时间、版本和待公布清晰可见。

根须按真实userId给组件key，并在跨赛事导航前提示保存/放弃草稿；组件内部按eventId/teamId/scope重挂载，不能沿用别赛草稿。全部前端调用复用根client-api自动`/api/v1`。

关系核查成功等同赛事外部操作不得用刷新版本改变JudgingManager的key，否则React重挂会丢弃本地配置；根保留账号/赛事身份key并增加refreshRevision。ManagerPanel记录初始值，在该prop变化时的useEffect只触发workspace.reload，初次挂载及值相同不额外刷新。现有configDirty与configRevision逻辑保留：后台新revision只更新事实并提示核对，dirty本地config不被覆盖；没有重置configDirty、config、当前轮次或其他本地草稿。

## NEEDS_INTERFACE / 根组合要求

1. **收件/角色并发锁定约定**：公共EventParticipationPort只有getTeam/getRegistration，无forUpdate参数。本模块先`events.getEvent(sql,eventId,{forUpdate:true})`，使用相同executor在读写前后复核。根的O02报名撤回、换队长、名单修改、资格变更，以及O01授权撤销必须遵循同一赛事/相关授权锁顺序，或根追加可信锁定Port（建议`requireSubmissionContext(sql,principal,{eventId,teamId,expectedTeamRevision})→当前approved报名+locked/eligible名单`）。权限：仅当前提交者且同组织/赛事；示例：名单撤回与submit竞争须只有先取得锁的合法事实生效，不能旧名单收件后另事务并发撤回导致错误成功。本模块不私查O02表；真实PostgreSQL并发须根验收。
2. **可信M06桥**：本模块`SubmissionLinkContextPort.resolve`需要根读取当前明确M02项目/M03赛事关联、已确认stage/requirementsVersion/commit，并由VerifiedEventSubmissionPort.recordReceipt复核当前权限和规则。`requirementsVersion:string`使用完整M03确认键`${linkedEventId}:${rulesVersion}:${confirmationRevision}`，O04验证同linkedEventId前缀和两项正安全整数，一字不改传桥；数字、短字符串、不同赛事、零版本、超安全整数及前后空白均409 `TRUSTED_REQUIREMENTS_VERSION_INVALID`，不做`String(number)`。根仍须按真实已确认版本复核，格式有效不代表当前确认有效。本模块不接受这些字段的客户端输入；`receiptUrl`是服务端生成的相对`/competitions/<eventId>/submit?receipt=<id>`，根按可信origin转真实绝对URL并严格核对确认入口，不能信任客户端绝对URL。既有公开M06接口仍只接受user_reported，O04没有修改或绕过该规则。没有关联/上下文返回null，只收独立比赛作品；不会创造私人项目platform_verified。桥只同tx数据库操作，不在未提交事务调用GitHub或收费模型。回执自身`ruleVersion:number`是O01已发布版本，不能代替完整M03/M06确认键。
3. **人工关系核查落点**：`EventJudgeConflictPort.inspect`是可信实时关系来源。`needs_review`指派留存但不能读材料；`reviewAssignment`只有该Port现为clear才激活，工作人员不能用一段reason覆盖系统known conflict。根须为外部不确定关系提供受控人工核查保存/审计适配与judge候选当前账号校验。平台不能知道全部线下辅导，评委本人仍需声明。
4. **评审AI**：仅有JudgingSummaryPort类型，当前不调用。根真接入须区分评审身份/检索/缓存/队列、限定正式材料和已发布规则、禁止选手个人资料/导航/空间AI记忆、预算unknown hold、权限前后复核；未真实验收不展示“已分析”。
5. **公共页面/期限/导航**：root提供可信eventTitle/organizationName/teamId/deadline与judgeOptions，挂实际路由、真实session guard/Origin/CSRF、增量迁移，按账号key和导航处理草稿。schema是建议，不是已部署迁移。

## 根探针补修：新的读取投影

2026-10-11主会话只读根探针指出列表关联变化、公布后回避及M06版本键三项，重新授权原O04范围修复。没有修改根shared，`VerifiedEventSubmissionPort.requirementsVersion:string`由主会话更新；本模块ports/service及桥测试同步。

- **评委列表**：`JudgeWorkItem.accessStatus`精确为`pending_declaration|available|needs_review|recused|revoked`。只有available可展示title/score、开启材料；读取分数后和列表末次都会重新读取当前指派并检查可信ConflictPort。变为conflict/needs_review/撤销/回避时score=null、title为通用阻断提示；旧active若关联失效，输出assignment.status只读派生为needs_review，真实指派/history不在GET中修改。UI不从assignment单独推断可读，accessStatus变化清掉材料、选中作品及评分草稿。本人申报写入后重读权威列表。
- **公开/本人结果**：`ResultProjection.status`新增`needs_review`（原waiting_publication/published保留），始终新增`reviewRequired:boolean,reviewNotice:string|null`。当前有效summary与published轮的lockedSummary不一致时，返回needs_review/true/通用notice，保留原version、publishedAt、roundId、roundTitle，**rows=[]**，不展示失效旧分/排名/批准反馈，也不自动重算公开排名或回退别轮冒充当前版本。notice不含评委、回避原因、评分详情或指派ID；参与者范围在所有末次summary/反馈读取之后再次复核approved资格，撤权返回waiting且版本/轮次为空；队伍反馈再次复核当前成员。该状态只读派生，数据库round.status仍published，旧ej_published_results不修改。
- **管理复核**：`JudgingWorkspace.publicationReviews`新增仅已公布轮的`readonly({roundId,publishedResultId}&PublicationReview)[]`；`previewResults`新增`publicationReview:PublicationReview`。`PublicationReview={required:boolean,notice:string|null,nextSteps:readonly action[]}`，action枚举`withdraw_results|reopen_round|review_assignments|lock_round|preview_results|publish_results`。required时精确步骤为`[preview_results,withdraw_results,reopen_round,review_assignments,lock_round,preview_results,publish_results]`：先核查当前汇总，填原因撤回，填原因重开，补评/处理指派，重新锁定，再次预览并人工公布。管理UI突出待复核轮与现有汇总/撤回入口，撤回后提供重开，成功后刷新状态；不自动撤回或改变排名。新的人工公布产生下一版本，旧版审计可查。
- **HTTP**：原工厂成员/路由/请求JSON/权限不变；`judgeAssignments`、`workspace`、`previewResults`、`publicResults`、`myResults`的200成功data透传上述新字段，仍no-store；needs_review是成功读取的业务状态，不是HTTP403/500。公开结果和本人结果UI均以status needs_review或reviewRequired true为阻断展示依据，不显示rows，即使异常旧缓存含rows。
- **SQL/配置**：不新增SQL迁移或环境变量；完整字符串键只修改可信Port输入，没有把回执O01版本改成M03版本，没有修改M06公开接口。

## 评委本人赛事入口补充

2026-10-11主会话补授权原O04范围，增加公共方法精确签名：`listAssignedEventIds(principal:OrganizerPrincipal):Promise<string[]>`。该方法已通过`createEventJudgingService`返回，`EventJudgingService`和模块index现有公共导出自动包含它；不接受eventId、judgeUserId或客户端Principal，没有新增本模块HTTP handler或根路由。

同一DatabasePort.transaction中先guard真实本人会话，再以principal.actor.userId参数化查询ej_judge_assignments，只取distinct event_id、status为active/needs_review，按event_id升序LIMIT100；待声明保留以便进入申报，待核查保留以便知道需处理，recused/revoked排除。若同赛事仍有另一项有效本人指派，赛事继续保留。随后以候选集合重新查询本人当前仍有效指派，末次guard会话，返回最多100个唯一字符串ID。没有读取assignment document、receipt、score或材料，也不检查他人的赛事；平台admin无本人指派同样返回空数组。空候选没有额外指派SQL。

repo新增内部签名：`listAssignedEventIds(sql:SqlExecutor,judgeUserId:EntityId,candidates?:readonly EntityId[]):Promise<EntityId[]>`；候选复核追加`event_id=ANY($2::text[])`，同样只查本人，不扩展候选范围，无新迁移/环境变量。该repo不是HTTP权限入口，必须由受控service传入真实当前本人。

根组合要求：可在`/me/competition-identities`合并或新增`/me/judging-competitions`调用该service；根再用同一当前本人会话及HostedEventAccessPort投影赛事名/主办方/状态，组合前后复核会话并设no-store。返回ID是入口发现，不能替代judgeAssignments/judgeMaterials/saveScore的本人指派与实时关联授权；不向其他账号暴露评委名单、作品、评分或材料。本模块未修改根API、共享Port及导航。

## P06 · 评审进度追踪与已公布结果导出（2026-10-16）

授权范围：**仅 `src/modules/event-judging/` 与本交付**。未编辑 `src/app`、`src/server`、`src/components`、`src/shared`、`migrations` 或根配置。依据 `docs/规划/33-主办方可用性与赛后闭环.md` 与分项 `docs/规划/主办方/P06-评审进度与结果导出.md`。**没有新增迁移、没有新增表、没有修改既有表或 Port。**

### 吸收闸门（规划 32 第 4.0 节 / 宪法 XII）

**N2 评审进度追踪**

1. **解决哪个真实问题**：`service.workspace()`（`service.ts` L314–322）**已经返回** `rounds / submissions / assignments / scores`，但全模块没有任何地方把它聚合成"哪件作品还差几位评委、哪位评委还没交"。主办方只能逐个作品点开数——这是可复现的摩擦点，不是"竞品有所以要有"。
2. **会碰到的既有能力**：`workspace()`、`checkedIn()`（L141，唯一"有效指派 + 已提交"判定）、`aggregate()`、`calibration()`、`integrity()`，以及既有 `judging_manage` 权限与 `audit`。
3. **如何避免重复入口 / 第二份事实 / 第二套写路径**：
   - **不新增读取路径**：`progress.ts` 是纯函数，输入就是 `checkedIn()` 已经读出的四个集合；服务方法内部只调用一次 `checkedIn()`，**没有新增任何 SQL 查询**（`postgres.ts` 未改）。
   - **不新增状态**：不落库、不加列、不加表、不产生任何写入；**没有自动催办**（催办会真实发邮件，属规划 33 决策点 3，未确认前不做）。
   - **不新增入口**：复用既有 `judging` 路由族与折叠面板位置（界面接线由主会话做，见下）。
   - **口径不另写一套**：`isEffective()` / `submittedScore()` 与 `aggregate()` 的 `effective` 过滤逐字同义；`checkedIn()` 的 `checked` 是唯一输入。

**N4 已公布结果导出**

1. **解决哪个真实问题**：既有 `exportScores`（L674–682）导出的是"指派编号 + 评委账号 + 维度 JSON"的**内部对账表**，不能交给赞助方或学校留档；作品级结果此前只能一页页看。
2. **会碰到的既有能力**：`exportScores` 与 `csvCell` 防注入、`projection()`（L195，已实现 `needs_review` 拦截与 `participants` 可见性复核）、`staff()`、`audit()`。
3. **如何避免冲突**：**新增一种口径，不覆盖既有**。`exportScores` **一行未改**；新方法只读 `projection(sql, scope, null)`（公开投影），因此**不另算一套分数或名次**。两文件名单不同、用途在文档中写明，主管线不会拿错。

### 未新增第二套状态 / 写路径 / 入口的证据

| 声明 | 证据 |
| --- | --- |
| 没有新增第二套评审状态 | 未新增 `JudgingRound.status` 取值、未新增表、未新增列；`progress` 的 `status` 是**返回对象的派生字段**（`empty`/`in_progress`/`complete`），不落库，也不是轮次状态 |
| 没有新增读取路径 | `postgres.ts` 与 `schema.sql` 未修改；`progress()` 只调用既有 `checkedIn()`；`exportResults()` 只调用既有 `roundIn()`、`store.getPublished()`、`projection()`、`audit()` |
| 没有新增写路径 | `exportResults` 的唯一写入是**既有 `audit()`**（新增审计动作名 `results_exported`）；不写评分、指派、轮次、公布 |
| 没有新增入口 | 复用既有 `judging` section；路由挂在既有 `organizer/events/:eventId/judging/...` 前缀下，与 `calibration`/`integrity`/`fairness` 同族 |
| 没有改既有导出口径 | `exportScores` 源码与文件名 `judging-scores.csv` 均未变；新增文件名 `judging-results.csv` |
| 没有改既有判定 | `aggregate`、`calibration`、`integrity`、`checkedIn`、`projection` 均未修改；`progress` 复用它们的判定条件 |

### 新增文件与改动

| 文件 | 变更 |
| --- | --- |
| `src/modules/event-judging/progress.ts` | **新增**：`progress()` 纯函数（无 IO、无 `Date.now()`）及 `ProgressReport` / `RoundProgressRow` / `JudgeProgressRow` / `RoundProgressSnapshot` / `RoundProgressExcludedAssignment` 类型 |
| `src/modules/event-judging/service.ts` | 新增只读 `progress()`；新增 `exportResults()`；新增内部辅助 `csvNote()`；导入 `progress` 与类型 |
| `src/modules/event-judging/http.ts` | 新增 handler `progress`（GET）与 `exportResults`（GET） |
| `src/modules/event-judging/index.ts` | 导出 `progress` 与 5 个公共类型 |
| `src/modules/event-judging/README.md` | 新增两节说明与验证记录 |
| `src/modules/event-judging/progress.test.ts` | **新增** 9 项测试 |
| 本交付 | 本 P06 小节 |

**未改**：`model.ts`、`validation.ts`、`calibration.ts`、`integrity.ts`、`duplicates.ts`、`fairness.ts`、`checklists.ts`、`appeal.ts`、`postgres.ts`、`schema.sql`、`ports.ts`、`ui.ts`、`JudgingPanels.tsx`、`judging.module.css`。

### 接口与数据形状

**`service.progress(principal, eventId, roundId) → ProgressReport`**（只读，仅本场 `judging_manage`）

| 字段 | 含义 |
| --- | --- |
| `status` | `empty`（本轮冻结名单上一件作品都没有排定过指派）/ `in_progress` / `complete`（均已收齐） |
| `snapshotCount` / `requiredJudges` / `incompleteSnapshots` | 本轮作品数 / `minJudges` / 尚未收齐的作品数 |
| `submittedTotal` / `assignedTotal` | 已提交有效评分合计 / 已排定有效指派合计（分母口径） |
| `rows[]` | `snapshotId,title,submittedCount,requiredJudges,stillNeeds,complete` |
| `remaining[]` | 尚未收齐清单；按 `stillNeeds` 降序、同值按 `snapshotId` 升序**稳定排序** |
| `judges[]` | `judgeUserId,submittedCount,assignedCount,outstanding,excludedCount` |
| `snapshots[]` | 每件作品的 `scheduledJudges`（分母）与 `excluded[]`（`assignmentId,judgeUserId,status,reason`） |
| `excluded[]` | 上述排除项汇总，附 `snapshotId` |
| `notice` | 中文说明；**不含**百分比、进度条、完成度或"落后"字样 |

**`service.exportResults(principal, eventId, roundId) → { filename, csv }`** → `filename` 固定 `judging-results.csv`；`csv` 带 BOM，首行为 `#` 注释（赛事、评审轮、公布版本、公布时间、生成时间），随后是表头与数据行。

**错误**：`RESULTS_NOT_PUBLISHED`（409）——本轮未公布、已撤回，或当前公开可见的是另一轮；`JUDGING_ROUND_NOT_FOUND`（404）；`STAFF_REQUIRED`（403）。

**已核实但未导出**：内部快照 ID（`snapshotId`）、评委账号 / 真名、联系人、答卷、私人求助、住宿、申诉正文、**队伍专属反馈**（只导出 `visibility==="public"` 的批准反馈）。

### 验证（真实执行）

```
node --experimental-strip-types --test src/modules/event-judging/*.test.ts
→ tests 110, pass 110, fail 0（新增 progress.test.ts 9 项；此前 101 项全部保留）
node node_modules/typescript/bin/tsc --noEmit
→ 本模块 0 报错（全仓另有 1 条报错，在 src/modules/event-communication/participant-summary.test.ts，属另一会话文件，不在本授权范围，未修改）
```

`progress.test.ts` 9 项覆盖：

1. **口径一致 + 只读**：`rows[].submittedCount` 与 `aggregate()` 的 `submittedJudgeCount` 逐一相等；`judges[].submittedCount` 与 `calibration()` 的 `submittedCount` 完全相等；读取前后 `workspace()` 的轮次（含 `lockedSummary`、`publishedResultId`）、指派（含 revision/status/declaration）、评分（含 revision/values）、`publicationReviews` **深比较完全一致**。
2. **空态**：无任何指派时 `status === "empty"`、`judges` 与 `excluded` 为空数组，**不凭空造出评委行**。
3. **回避不计入分母**：`recused` 计入 `excluded` 并标注"已申报回避"，`assignedCount` 不包含它，因此该作品仍显示"还差一位"；队伍成员被系统判定关联时不能指派（`JUDGE_CONFLICT`）。
4. **权限**：非工作人员 `STAFF_REQUIRED`；跨赛事轮次 ID 报 `JUDGING_ROUND_NOT_FOUND`，不返回其他赛事数据。
5. **导出不含评委身份**：CSV 文本中不出现 `judge-1`、不出现内部快照 ID、不出现队伍专属反馈，只含公开反馈；含公布版本与生成时间头。
6. **未公布 / 已撤回拒绝**：`RESULTS_NOT_PUBLISHED`；撤回后再次拒绝。
7. **需复核拦截**：公布后关联变为 `needs_review` 时，导出**不输出分数与名次**（断言不含 `"80"`），只输出状态与版本。
8. **防注入**：作品名为 `=1+1` 时导出为 `"'=1+1"`（复用既有 `csvCell`）。
9. **只读与审计**：读取 `progress` **不产生审计**；`exportResults` 恰好新增 1 条 `results_exported` 审计（按动作名过滤，不依赖顺序——夹具时钟固定，多条审计可能同一时刻）。

测试同时抓出并修正了三处**我自己的错误假设**（实现无误）：作品级"还差"人数应按 `minJudges` 计算而非笔误值；`=1+1` 作品的两维权重合计后总分为 80 而非 8；审计查询顺序在固定时钟下不稳定，改为按动作名过滤。

### NEEDS_INTERFACE（根接线）

**状态：已被主会话接线**（`src/server/organizer-integration.ts` L97–98 已存在两条路由），此处登记以便复核：

| Handler 成员 | 方法 | `/api/v1` 之后路径 | 参数 | 权限 |
| --- | --- | --- | --- | --- |
| `progress` | GET | `organizer/events/:eventId/judging/rounds/:roundId/progress` | `["eventId","roundId"]` | `judging_manage` |
| `exportResults` | GET | `organizer/events/:eventId/judging/rounds/:roundId/results-export` | `["eventId","roundId"]` | `judging_manage` |

两者均为 **GET、无正文、no-store**，不触发模型或采集。

**界面接线：已完成**（2026-10-16 追加授权，见下节「P06 界面接线」）。以下保留原始需求描述供复核：

1. **评审进度面板**：放在 `JudgingPanels.tsx` 既有 `judging` 内容区，与 `calibration`/`integrity`/`fairness`/`duplicates`/申诉队列**并列**（**不替换、不合并**）。布局按 `docs/设计/主办方工作台布局.md` 第 5.7 节：桌面"作品 / 评委"两列，≤620px 纵向堆叠，每行 `min-height:44px`，计数用文字 `已提交 3 / 最少 3` 与"还差 2 位"徽标，**禁止进度条与百分比**。
2. **两个导出按钮**：放在既有"审计与导出"区，`导出分数明细（内部对账）` → `/judging/export`；`导出已公布结果（可对外留档）` → `/judging/rounds/:roundId/results-export`。**每个按钮下各一句说明用途与是否含评委账号**，避免拿错。
3. **轮次上下文**：两个端点的导出与进度均需 `roundId`，界面须使用当前选中轮次的 id。

### 未做与边界

- **未做自动催办**（规划 33 决策点 3 未确认）。若后续要做，`MUST` 复用 `EventNotificationPort` 既有写路径与投递状态记录。
- **未做界面**（授权范围仅模块与本文档）。
- **未新增迁移**；本模块 `schema.sql` 未改动，无需根执行迁移。
- 未修改根路由之外的任何共享文件。
- 未做真实 PostgreSQL 多连接并发、根跨角色流程或手机外部试用；本文件中的测试均为隔离内存 PGlite 与受控 Port。

### P06 界面接线（2026-10-16，追加授权）

授权范围：**仅** `ui.ts`、`JudgingPanels.tsx`、`judging.module.css`、本模块 `README.md`、本交付。未改 `src/app`、`src/server`、`src/components`、`src/shared`、`migrations`，也未改 event-judging 的其他服务文件。

#### 改动的文件

| 文件 | 变更 |
| --- | --- |
| `JudgingPanels.tsx` | 新增 `ProgressView` 组件与 `showProgress()`；`ManagerPanel` 新增 `progressReport` 状态、折叠面板与"读取/刷新进度"入口；`chooseRound` 与 `unauthenticated` 清理新增 `setProgressReport(null)`；`ManagementRecords` 新增 `roundId`/`roundTitle` props、抽出 `saveCsv()`、新增 `downloadResults()`、改为两个导出按钮各带一句说明、审计动作名新增 `results_exported` |
| `judging.module.css` | 新增 6 个类：`.progressGrid` `.progressCol` `.progressRow` `.badgeWarning` `.badgeSuccess` `.badgeMuted`；`.progressGrid` 纳入既有 `@media (max-width:620px)` 单列规则 |
| `README.md` | 进度与导出两节各追加"界面"说明 |
| **未改** | `ui.ts`（现有导出已足够，无需新增导出）；`service.ts`（已由主会话改为 `mutate=false`，本次未动） |

#### 复用的既有类名与令牌（未新造视觉体系）

| 用途 | 复用 |
| --- | --- |
| 面板外壳 / 卡片 | `.preview`、`.details`、`.actions`、`.sectionTop`、`.cardTop`、`.card` |
| 徽标 | `.badge`（中性）；新增 `.badgeWarning` / `.badgeSuccess` / `.badgeMuted` **只覆盖背景与文字色**，边界圆角继承 |
| 清单与文本 | `.linkList`（行容器）、`.hint`、`.prose`、`.empty`、`.notice`、`.error` |
| 按钮 | `.secondary`、`.tertiary`（未新增按钮样式） |
| 颜色 | `var(--surface)`、`var(--warning)`/`var(--warning-bg)`、`var(--success)`/`var(--success-bg)`、本模块既有 `--judging-muted` |

**唯一新增字面色值是 `.badgeMuted` 的 `background:#f2ece2`**，与本模块既有中性色同族（`.details`/`.card` 用 `#e8dfd1`，`.empty` 用 `#f7f3ec`），未引入新色相。

**红色只用于真阻塞**：进度未收齐用 `--warning`（琥珀），已收齐/已交齐用 `--success`（绿），已排除用中性灰。未收齐**不是**阻塞，因此本视图**未使用 `--danger` 或任何红色**。

#### 渲染的状态

| 状态 | 渲染 |
| --- | --- |
| `status === "empty"`（无指派） | 徽标"本轮尚未排定指派"；作品区仍列"还差 N 位"；**评委区显示"本轮还没有排定评委指派"，不造评委行**；已排除组显示"没有被排除的指派" |
| `status === "in_progress"` | "本轮仍在收集中"；未收齐作品给 `还差 N 位`（警告色）；未交齐评委给 `还差 N 份`；另有"尚未收齐：…"汇总句 |
| `status === "complete"` | "本轮已收齐"；作品 `已收齐`、评委 `已交齐`（成功色）；`remaining` 为空故不渲染汇总句 |
| 已排除指派（`recused`/`revoked`/`needs_review`） | 独立折叠组"已排除、不计入分母的指派（N 项）"，逐条给原因文本 + `assignmentNames` 状态徽标（中性色）；说明明确"不计入应评数分母，不代表对任何人的评价" |
| 无收件 / 作品名单为空 | 作品区"本轮作品名单为空。"（`report.rows` 为空） |
| 轮次 `status === "setup"` | 按钮禁用 + "本轮尚未开始评分。开始并指派评委后，才能读取进度视图"；不自动请求 |
| 未选择轮次 | 进度面板不渲染（位于 `round` 存在的分支内） |
| 进度接口失败 | 复用 `run()` 的 `Notice error`，保留页面输入 |
| 已公布结果导出被拒 | 后端 `RESULTS_NOT_PUBLISHED`（未公布/已撤回/可见轮次不符）与需复核状态经 `message(error)` 显示在既有 `Notice`；按钮**不禁用**，因为"是否可导出"由后端权威判定 |

**空态与"未读取"的区分**：面板未展开或未点击前 `progressReport === null`，此时**不渲染任何计数**（只显示说明与按钮），符合"未读取不显示 0"的纪律。

#### 布局落实情况（对照 `docs/设计/主办方工作台布局.md` 第 5.7 节）

| 要求 | 落实 |
| --- | --- |
| 与校准/自检/公平包**并列**，不替换不合并 | 新增第 4 个 `<details>`，位于校准、自检之后、公平规则包之前；既有 4 个面板**一行未改** |
| 桌面「作品 / 评委」两列 | `.progressGrid { grid-template-columns: repeat(2, minmax(0,1fr)) }` |
| `≤620px` 堆叠 | `.progressGrid` 加入既有 `@media (max-width:620px)` 单列规则 —— **复用既有 620px 断点，未新增断点** |
| 每行 `min-height:44px` | `.progressRow { min-height:44px }` |
| 计数一律文字 | `已提交 3 / 最少 3`、`还差 2 位`、`还差 2 份`、`已收齐`、`已交齐`；无进度条、无百分比、无完成度 |
| 禁止项 | 未出现进度条、百分比、完成度、评委排名、"最慢评委"；`recused`/`revoked` 单独成组且不计入分母 |

#### 与授权要求的偏离（逐条说明）

1. **替换了既有导出按钮文案**：旧按钮"下载本赛事评分 CSV"改为"导出分数明细（内部对账）"。因为现在同时存在两个导出，旧名无法区分。**这是对既有文案的改动，需要你知晓。** 授权给的两个新名字**照用未改**。
2. **说明文字放在按钮行下方**（带 `.hint` 的独立段落），而不是塞进按钮文字或 `title` 属性 —— 这样才能写清"含/不含评委账号"这类关键差异，且手机上不会被截断。
3. **抽出 `saveCsv(csv, filename)`**：两个导出共用同一套 Blob + 临时 `<a download>` 逻辑。**下载机制未变**（仍是 GET → Blob → 临时锚点 → 1 秒后 `revokeObjectURL`），只是不再硬编码文件名、改由调用方传入。
4. **`ManagementRecords` 新增 `roundId`/`roundTitle` 两个 props**：因为"已公布结果导出"必须用**当前选中轮次**的 id，而选中轮次状态在 `ManagerPanel`。选择传 props 而非在 `ManagementRecords` 内另取一处轮次来源，正为满足"与面板同一轮次来源，不要各取一处"。
5. **切换轮次清空进度**：`chooseRound` 新增 `setProgressReport(null)`；**只清进度**，未动校准/自检/公平包在 `chooseRound` 中的既有行为，以免影响本次授权范围外的面板。`unauthenticated` 的 `clear()` 同样新增该行。
6. **额外加了"刷新进度"次要按钮**（既有 `.tertiary`）：进度是派生视图，补评后需要重读；与"读取评审进度"同排。
7. **审计动作名新增 `results_exported: "导出已公布结果"`**：否则新审计会落成通用"评审操作"。

#### 验证（真实执行）

```
node --experimental-strip-types --test src/modules/event-judging/*.test.ts
→ tests 110, pass 110, fail 0      （纯 UI 改动，未影响服务与逻辑测试）

node node_modules/typescript/bin/tsc --noEmit --incremental false
→ event-judging 0 报错
  全仓另有 2 条报错，均在 src/modules/organizer/（不属本授权范围，未修改）：
    duplicate-service.test.ts(273,57) 与 zz-debug.test.ts(24,51)
    均为 Argument of type 'string' is not assignable to parameter of type 'OrganizerPrincipal'
```

**未做**：未新增接口、未改路由、未改 service/types 语义、未新增迁移；未跑真实浏览器走查或生产构建（不在授权范围，`tsc` 已过）。

## 已隔离验证 / 根组合边界 / 外部未验收

本人赛事入口补充后最终模块测试：`node --experimental-strip-types --test src/modules/event-judging/http.test.ts src/modules/event-judging/validation.test.ts src/modules/event-judging/service.test.ts src/modules/event-judging/postgres.test.ts`，**51通过，0失败**，约27.14秒。HTTP4项、验证5项、服务29项、持久层13项。所有数据库测试均使用全新内存PGlite和受控跨模块Port，不加载.env、不打开生产目录。初次交付为33项，三项根探针补修后42项；本人赛事入口另增6项服务与3项实际SQL回归，全部原测试保留。

覆盖跨组织/赛事猜ID及权限拒绝、队长/名单/资格/期限、同key重放与异输入拒绝、同上一版本并发唯一收件、末次账号/工作人员撤权及可信M06同事务回滚、材料/公布/审计不可变、开轮冻结、known关联与needs_review、回避/撤销读写拒绝、部分草稿与完整提交、评分CAS/纠正before-after审计、缺评null/共享名次/人工同分限制、旧hash禁止公布、JSONB重排hash稳定、参与者/队伍反馈返前撤权、最新可见轮、CSV公式防注入、请求方法/Origin前置授权/64KB流限/匿名仅公开投影。PGlite并发测试是单实例事务/CAS演练，不代表多连接pg验收。

新增回归覆盖读分数期间出现关联冲突/needs_review/撤销后的评委列表脱敏；公布80分后迟到回避暂停当前结果，完整人工撤回/重开/补评/锁定/重公布90分且旧版80分保持不可变；参与者范围复核信号和最后summary读取期间撤权不泄露版本/轮次；完整可信M06字符串版本键保留，非法缩短/外赛事/数字/不安全版本在桥接前拒绝，客户端附加URL/规则/关联/阶段字段不能覆盖可信上下文。

本人赛事入口回归覆盖other账号/无指派admin为空、只用当前principal身份且不读作品/分数/材料、跨组织多赛事重复去重、待声明/needs_review保留与recused/revoked排除、初始及读取期间会话撤销、同executor前后guard、最后有效指派读取期间撤销后剔除而另一有效指派仍保留；101/105组实际SQL事实验证最多100及稳定顺序、候选过滤在limit之前、空候选零SQL、账号及候选注入字符串绑定安全。

本人赛事入口及管理刷新参数完成后最终完整类型检查：`node node_modules/typescript/bin/tsc --noEmit --incremental false`，**退出0**；不写根tsbuildinfo。开发期间遇到其他O模块尚未完成的类型错误，未越界修改，最终全局检查已通过。此前UI子代理在内存完成9个SSR视图冒烟及4个模拟Hook访问变化探针（含复核阻断、恶意文字转义与本地草稿/材料清除）。本轮另完成refreshRevision模拟Hook验证：两次版本变化各刷新一次、同值/首次挂载不额外刷新、新workspace revision不会覆盖dirty配置；SSR确认组件接受新prop。没有真实HTTP、实际数据库或文件写入；这不代替真实浏览器/手机测试。

本模块没有执行build/重启/真实迁移/外部发布，没有安装依赖或修改根配置。

根组合边界：实际增量迁移编号/路由/页面/工厂组合、O01/O02真实事务Port及授权锁、M06可信桥、真实关系核查适配和AI隔离由主会话组合与验收，本交付只证明模块隔离结果。主会话本轮已推进根组合，其实际接入状态以根交付和验收记录为准；可先不注入M06/AI运行完整独立人工闭环。
外部未验收：真实PostgreSQL多连接并发、两机构多赛全链路、真实手机/主办方试用、文件受控上传与外部模型摘要。隔离夹具不能冒充这些成功。
所需环境变量：本模块无新增；根DatabasePort沿用既有DATABASE_URL或单实例本机持久配置。无密钥值。

**交付状态：O04模块、三项根探针补修、本人赛事入口与管理refreshRevision参数已完成，最终51项隔离测试、刷新草稿模拟Hook验证及完整类型检查通过；根实际组合及外部验收以主会话记录为准。2026-10-11已停止编辑并再次交还 `src/modules/event-judging/` 及本交付文件，后续由主会话统一组合。**


## 规划 34 C① · 作品展示（队伍可选公开）（2026-10-16）

授权范围：**仅 `src/modules/event-judging/` 与本交付**。未编辑 `src/app`、`src/server`、`src/components`、`src/shared`、`migrations` 或根配置。依据 `docs/规划/34-主办方模块化与选手社区.md` §3.1（三层开关）/ §3.3（公开投影）/ §3.4（验收）与宪法 v1.23.0 原则 XIII「作品公开与点评」。**本批只做 C① 作品展示**，不做 P5 文字留言与 P7 数值互评。

### 吸收闸门三问（规划 32 第 4.0 节）

1. **解决我们哪个真实问题**：裁定 3 与追加裁定把作品公开定为**队伍本人可选、默认不公开**。此前模块内没有任何地方记录队伍自己的披露意愿——`ej_intake_receipts` 只冻结材料，`projection()` 只投影分数与名次，`workspace()` 只有主办方视角。缺的是「**队伍说可以公开到什么程度**」这一件事实，不是「竞品有所以要有」。
2. **与哪些既有能力冲突**：会接触 `transact()`/`lockEvent()` 的赛事级写锁、`staff()` 的 `judging_manage`、`audit()` 既有审计表、`participation.getTeam/getRegistration()` 的成员与资格口径、`store.listReceipts()` 的正式材料，以及主会话新增的共享 `eventCommunity(scope)`（本模块**只读**）。均按其既有语义使用，未改其行为。
3. **如何避免重复入口 / 第二份事实 / 第二套写路径**：
   - **第二份事实 = 没有**：唯一新增表 `ej_work_disclosures`；「作品是否公开」不落库第二遍，公开列表是**只读派生**（`works.ts` 纯函数）。未新增 `JudgingRound.status` 取值、未改 `IntakeReceipt`、未改 `PublishedResults`、未动共享 `EventModuleFlags`。
   - **第二套写路径 = 没有**：`submitWorkDisclosure` / `withdrawWorkDisclosure` 是本模块唯一写 `ej_work_disclosures` 的方法，内部只调用 `store.insertWorkDisclosure` / `store.updateWorkDisclosure`（本模块 repo 唯一两处 INSERT/UPDATE）；除既有 `audit()` 外不写任何其他表。
   - **第二套评价 = 没有**：本批不产生分数、名次、点评或文本；正式分与名次仍是既有 `aggregate()`，披露前后逐字段不变（断言见下）。
   - **重复入口 = 没有**：路由挂在既有 `competitions/...` 与 `organizer/events/:eventId/judging/...` 前缀下，与申诉/导出同族；未新增一级导航、未新增页面。

### 唯一新增事实与不变量

| 不变量 | 实现 | 证据 |
| --- | --- | --- |
| 一队一份**有效**记录 | 部分唯一索引 `ej_work_disclosures_one_active(organization_id,event_id,team_id) WHERE status='active'` + 服务层 `findActiveWorkDisclosure`；写操作在 `transact(mutate:true)` 内先取 `ej_event_locks` 赛事写锁，同赛事写串行化 | `service.test.ts`「同重试标识幂等…」断言替换后总行数 2、active 1 |
| 撤回后可重提 | 只允许 `active -> withdrawn`（触发器 + 服务层）；撤回后可插入新记录，旧行保留 | `service.test.ts`「未正式交件…」撤回后列表 0 条、用新标识重提后恢复 1 条 |
| 同一重试标识幂等 | `UNIQUE(organization_id,event_id,author_user_id,idempotency_key)` + `findWorkDisclosureReplay` 重放返回原记录；同键不同选择 409 `IDEMPOTENCY_KEY_REUSED` | 同上测试 |
| 原始选择与范围**不可改写** | 触发器 `ej_protect_work_disclosure`：`scope`、`document->'fields'`、`receiptId`、`receiptVersion`、`team_id`、`author_user_id`、`idempotency_key` 冻结；只允许 `active -> withdrawn` 且 revision 必须 +1 | 同上测试对该表直接 UPDATE 断言 `only move from active to withdrawn` 与 `revision must increase by one` |
| 只有**当前队伍成员**提交 | `disclosureTeam()`：当前名单（`participation.getTeam`，`status='withdrawn'` 直接拒绝）**且**该队最新正式收件回执的成员快照（沿用 `appealTarget` 口径） |「只有当前队伍成员…」测试：他队队长 403、跨赛事队伍 403、后加入但不在回执快照者 403、快照内成员 200 |
| 正式交件后才能选择 | 无最新回执 → POST 409 `WORK_DISCLOSURE_NOT_PARTICIPATED`；GET 仍 200 并说明 |「未正式交件…」测试 |
| 赛事开关关闭即不可读不可写 | `requireWorkShowcase(scope)` 读共享 `eventCommunity(scope).workShowcase`，假则 403 `WORK_SHOWCASE_DISABLED`（**不是空数组**） |「作品展示门禁…」测试覆盖 6 条入口 + 0 行落库 |

### 未新增第二套事实 / 写路径 / 入口的证据

| 声明 | 证据 |
| --- | --- |
| 公开列表是**只读派生** | `works.ts` 无 IO、无 `Date.now()`；服务层 `buildWorkShowcase()` 只读 `store.listReceipts`、`store.listWorkDisclosures`、`participation.getRegistration`；参赛者读、主办方读与访客读**共用同一个** `buildWorkShowcase()` |
| 只读投影**不写审计** |「公开范围写既有审计…」测试：`works`/`myWorkDisclosure`/`eventWorkShowcase` 前后审计条数相等 |
| 写入只有一条路径 | `submitWorkDisclosure`/`withdrawWorkDisclosure` 各只调用一次 `insert/updateWorkDisclosure` + 既有 `audit()`；`postgres.ts` 里读写 `ej_work_disclosures` 的函数恰好 6 个，没有任何第二个服务方法引用它们 |
| 不改正式结果 |「提交公开范围前后…」测试：`previewResults().summary` / `summaryHash` / `round` / `publicationReview`、`exportResults().csv`、`myResults()`、`judgeMaterials()` **逐字段深比较相等**；分数仍为 80 / 60、名次仍为 1 / 2 |
| 公开投影不含禁用字段 | 投影函数输入类型只有 `IntakeReceipt.materials`（名称/简介/链接/文件元数据）与披露记录，结构上取不到联系人、邮箱、答卷、求助、住宿、队伍专属反馈、评委身份；测试对 JSON 断言不含他队作品名/说明/链接/文件、不含 `receiptId`/`sha256` 等内部或未勾选内容 |
| 未新增共享契约 | `src/shared/` 一行未改；本模块只 import 共享的 `eventCommunity` / `DEFAULT_EVENT_COMMUNITY` 与类型（主会话已提供） |

### 新增与改动文件

| 文件 | 变更 |
| --- | --- |
| `src/modules/event-judging/works.ts` | **新增**：范围/逐项字段校验、同选择比较、最新回执选取、**只读投影**（`workShowcaseEntry` / `workShowcaseEntries`）、队伍侧视图、隐私口径原文与限制清单（纯函数，无 IO） |
| `src/modules/event-judging/model.ts` | 新增 `WorkDisclosureScope` / `WorkShowcaseFieldKey` / `WorkDisclosureFields` / `WorkDisclosure` / `WorkDisclosureInput` / `WorkDisclosureWithdrawInput` / `WorkShowcaseEntry` / `WorkShowcaseList` / `OrganizerWorkShowcase` / `MyWorkDisclosure` |
| `src/modules/event-judging/postgres.ts` | 新增 `listWorkDisclosures` / `getWorkDisclosure` / `findWorkDisclosureReplay` / `findActiveWorkDisclosure` / `insertWorkDisclosure` / `updateWorkDisclosure`（本表唯一读写点） |
| `src/modules/event-judging/service.ts` | 新增 `requireWorkShowcase` / `disclosureTeam` / `buildWorkShowcase` 三个内部辅助；新增 `works` / `publicWorks` / `myWorkDisclosure` / `submitWorkDisclosure` / `withdrawWorkDisclosure` / `eventWorkShowcase` 六个方法 |
| `src/modules/event-judging/http.ts` | 新增 handler `works` / `myWorkDisclosure` / `submitWorkDisclosure` / `withdrawWorkDisclosure` / `eventWorkShowcase` / `publicWorks`；`EventJudgingRouteParams` 新增 `teamId?` |
| `src/modules/event-judging/index.ts` | 导出 `works.ts` 的纯函数与类型 |
| `src/modules/event-judging/schema.sql` | 新增 `ej_work_disclosures` + 部分唯一索引 + 触发器（与迁移建议逐字一致） |
| `src/modules/event-judging/migrations/003-work-disclosure.sql` | **新增**迁移建议（根分配递增编号后应用；不动任何既有表） |
| `src/modules/event-judging/service.test.ts` | 追加 **10** 项作品展示服务验收 |
| `src/modules/event-judging/http.test.ts` | 追加 **3** 项路由验收（参数 / idempotency 头 / 写授权 / 访客入口） |
| `src/modules/event-judging/README.md` | 新增「作品展示（队伍可选公开）」一节与验证记录 |
| 本交付 | 本小节 |

**未改**：`validation.ts`、`calibration.ts`、`integrity.ts`、`progress.ts`、`duplicates.ts`、`fairness.ts`、`checklists.ts`、`appeal.ts`、`preflight.ts`、`ports.ts`、`ui.ts`、`JudgingPanels.tsx`、`judging.module.css`，以及 `src/shared/`、`src/app/`、`src/server/`、`src/components/`、根 `migrations/`。

### 唯一新增事实的数据形状

`ej_work_disclosures`（JSONB `document` + 索引化身份列 + 文档一致性 CHECK + 守卫触发器）：

| 字段 | 含义 |
| --- | --- |
| `id, organizationId, eventId, teamId, authorUserId` | 身份；跨组织/赛事复合外键；提交人与队伍不可改写 |
| `scope` | `private`（默认）/ `participants`（仅本场参赛者）/ `public`（含访客） |
| `fields` | `{title,description,links,files}` 逐项布尔；`private` 时强制全 false |
| `receiptId, receiptVersion` | 提交选择时该队最新的正式收件回执（只作「当时是哪一版」的证据；当前投影始终取**最新**回执） |
| `status, revision` | `active`/`withdrawn`；CAS 版本，撤回 +1 |
| `updatedAt, withdrawnAt` | 选择/撤回时间（`withdrawnAt` 与 `status` 由 CHECK 绑定） |
| `idempotencyKey` | 重试标识（1–120 字符），与提交人组成唯一键 |

> 设计取舍（如实登记）：选择是**队伍级**而非回执级（裁定「一队一份有效记录」），`receiptId` 只记录选择时的版本；队伍之后提交新版本时，公开投影自动跟随**最新**回执的勾选字段，不需要重新选择。若日后要「每版分别选择」，属新的需求变更，需要新的唯一约束与迁移，本批不做。

### 端点契约

| Handler | 方法 | `/api/v1` 之后路径 | 参数 | 权限 | 行为 |
| --- | --- | --- | --- | --- | --- |
| `works` | GET | `competitions/:eventId/works` | `eventId` | 已登录 | 本场作品展示只读投影。`participants` 档只对本场报名已通过者返回，`public` 档对所有已登录账号返回。开关关闭 → 403 `WORK_SHOWCASE_DISABLED`；无人选择公开 → 200 空列表 |
| `myWorkDisclosure` | GET | `competitions/:eventId/works/:teamId/disclosure` | `eventId,teamId` | 本队当前成员（+ 回执快照） | 本队有效选择、历史与口径原文；无回执时 200 且 `canSubmit=false` |
| `submitWorkDisclosure` | POST | `competitions/:eventId/works/:teamId/disclosure` | `eventId,teamId` | 本队当前成员（+ 回执快照） | 提交/重新提交；`Idempotency-Key` 头与正文不一致 400；同键不同选择 409；未交件 409；开关关闭 403 |
| `withdrawWorkDisclosure` | POST | `competitions/:eventId/works/:teamId/disclosure/withdraw` | `eventId,teamId` | 本队当前成员（+ 回执快照） | **可选第四条路由**（主会话可不接：重新提交 `private` 同样达到「不再公开」）；`expectedRevision` 不匹配 409 |
| `eventWorkShowcase` | GET | `organizer/events/:eventId/judging/works` | `eventId` | `judging_manage` | 已选择公开的作品（含 `participants` 档）+ 未公开队伍**数量**（不含身份）；开关关闭 403 |
| `publicWorks` | GET | 建议 `competitions/:eventId/works/public`（**访客、无需登录**） | `eventId` | 无 | 只看 `public` 档；与 `works` 共用同一投影实现。**若不接**，「公开（含访客）」这一档实际上只对已登录账号生效，界面说明会与行为不一致 |

**错误码**（均为既有 `DomainError` 信封 + no-store）：`WORK_SHOWCASE_DISABLED`(403)、`WORK_DISCLOSURE_ACCESS_DENIED`(403)、`WORK_DISCLOSURE_NOT_PARTICIPATED`(409)、`WORK_DISCLOSURE_NOT_FOUND`(404)、`IDEMPOTENCY_KEY_REUSED`(409)、`IDEMPOTENCY_KEY_MISMATCH`(400)、`JUDGING_VERSION_CONFLICT`(409，带 `latestRevision`/`recoveryAction`)、`JUDGING_INVALID_INPUT`(422)、`STAFF_REQUIRED`(403)、`EVENT_SCOPE_MISMATCH`(403)、`EVENT_NOT_FOUND`(404)。

**返回形状**：`WorkShowcaseList = { eventId, showcaseEnabled: true, visibleCount, items, notice, limitations }`；`items[]` 为 `{ teamId, scope, disclosedFields, updatedAt, title?, description?, links?, files? }`——**未勾选的键整体缺失**；`OrganizerWorkShowcase` 追加 `notDisclosedTeamCount`。

### 迁移建议

`src/modules/event-judging/migrations/003-work-disclosure.sql`（模块内建议，非已部署）：只新增 `ej_work_disclosures`、一个部分唯一索引、一个守卫触发器；**不改动任何既有表**。由主会话分配递增编号（根最新 072，建议 **073**）写入 `migrations/` 后执行。根应用前停机（PGlite 单写），应用后重启单实例。

### 验证（真实执行）

```
node --experimental-strip-types --test src/modules/event-judging/*.test.ts
→ tests 123, pass 123, fail 0
  （此前 110 项全部保留；新增 service.test.ts 10 项 + http.test.ts 3 项）

node node_modules/typescript/bin/tsc --noEmit --incremental false
→（无任何输出）
EXIT=0
```

新增断言逐条对应规划 34 §3.4：

1. **门禁**：`workShowcase=false` 时 `works` / `myWorkDisclosure` / `submitWorkDisclosure` / `withdrawWorkDisclosure` / `eventWorkShowcase` / `publicWorks` 全部 403，且**零行**落库；开启后无人选择 → 200 **空列表**（不是错误）。
2. **只列本人选择公开的队**：未提交披露的 `team-two` 的作品名、说明、链接、文件名与队伍标识在整段 JSON 里都不出现；未勾选的 `description`/`files` **键不存在**。
3. **`participants` / `public` 两档**：非本场账号与访客入口看不到 `participants` 档；改为 `public` 后两者都能看到，且列表里仍只有一条。
4. **不改结果（§3.4 第 1 条）**：提交披露前后 `aggregate()`（经 `previewResults().summary` + `summaryHash`）、`results/preview`、`results-export`（CSV 逐字节相等）、`myResults()` 与 `judgeMaterials()` 逐字段不变；分数仍是 80/60、名次 1/2；披露内容不进入结果投影、导出与评委读取面。
5. **幂等**：同键重放返回同一条；同键不同选择 409；新键替换后旧行 `scope` 与 `fields` 原样保留。
6. **非本队成员 403**：他队队长、跨赛事队伍、后加入但不在回执快照里的人全部 `WORK_DISCLOSURE_ACCESS_DENIED`；快照内成员 200。
7. **撤回与重提**：撤回后访客列表立即为 0；用新标识重提后恢复 1；无有效记录时撤回 404。
8. **不可变触发器**：直接 UPDATE 尝试把 `withdrawn` 改回 `active`、或跳版本，都被数据库拒绝。
9. **主办方侧**：只列已公开作品 + `notDisclosedTeamCount`，未公开队伍身份与作品名不出现；非本场工作人员 403。
10. **只读纪律**：三条读入口前后审计条数不变；提交/撤回各写 1 条既有审计。
11. **路由层**（`http.test.ts`）：缺 `teamId` → 400；`Idempotency-Key` 与正文不一致 → 400 且**不到达服务层**；未通过 mutation 授权 → 403 且不调用服务；`publicWorks` 不解析私有身份（调用序列里没有 `resolve`）。

### NEEDS_INTERFACE（根接线）

**状态：待主会话接线。** 本模块只提供 handler 成员；路由、迁移编号、界面由根决定。

1. **`EventJudgingRouteParams` 新增 `teamId?: string`**（已在模块内声明；根现有原型转换 `as unknown as EventJudgingRouteParams` 无需改动）。
2. **向 `JUDGING_ROUTES`（`src/server/organizer-integration.ts` L79–114）追加**：

```ts
{ pattern: /^competitions\/([^/]+)\/works$/, methods: { GET: "works" }, parameters: ["eventId"] },
{ pattern: /^competitions\/([^/]+)\/works\/([^/]+)\/disclosure$/, methods: { GET: "myWorkDisclosure", POST: "submitWorkDisclosure" }, parameters: ["eventId", "teamId"] },
// 可选：撤回入口（不接也可，重新提交 private 等效）
{ pattern: /^competitions\/([^/]+)\/works\/([^/]+)\/disclosure\/withdraw$/, methods: { POST: "withdrawWorkDisclosure" }, parameters: ["eventId", "teamId"] },
{ pattern: /^organizer\/events\/([^/]+)\/judging\/works$/, methods: { GET: "eventWorkShowcase" }, parameters: ["eventId"] },
// 建议：访客入口，与既有 publicResults 同形（该成员自己在 handler 里不解析登录身份）
{ pattern: /^competitions\/([^/]+)\/works\/public$/, methods: { GET: "publicWorks" }, parameters: ["eventId"] },
```

3. **迁移**：把 `src/modules/event-judging/migrations/003-work-disclosure.sql` 复制为根 `migrations/073_work_disclosures.sql`（自选编号，需递增且未被占用），停机后应用、重启单实例。本批**未执行**任何迁移。
4. **配置前置**：`community.workShowcase` 已由 `organizer` 模块的赛事配置（`src/modules/organizer/validation.ts` L75–97）写入并随发布版本冻结；本模块只读，不需要根额外接线。请确认线上赛事该开关默认 false。
5. **界面（本批未做，避免越权改 `src/app`/`src/components`）**：
   - 选手侧：在比赛页新增「作品展示」区（`works`）+ 本人队伍「公开范围」卡（`myWorkDisclosure` / `submitWorkDisclosure`，展示 `notices` 原文）。未公开时不得出现「空占位」，也不得暗示有人已经公开。
   - 主办方侧：`judging` section 的两个只读面板（已公开作品列表 + 未公开队伍数量），位置与 `calibration`/`progress`/`fairness` 并列折叠；文案必须写明「未公开队伍的身份不显示」。
   - 点评（文字留言、数值互评）**不在本批**，界面不要预留「留言/打分」入口，否则会暗示规划 34 P5/P7 已可用。
6. **依赖边界**：本模块不再需要新的共享 Port。`works` 判定「本场参赛者」用的是既有 `EventParticipationPort.getRegistration`，若根后续更换该 Port 语义，需同步复核两档可见性。

### 未做与边界

- **未做 P5 文字留言与 P7 数值互评**（含去自评、参与率门槛、举报与隐藏）；本批不建评论表、不出任何评论文本，`community.peerFeedback`/`peerReview` 本模块一律不读。
- **未做内容治理**（主办方隐藏/下架单件作品、举报处理）——属 P5 范围；本批只有队伍本人撤回。
- **未做界面**（授权仅模块与本交付）。
- **未执行迁移、未跑 build/重启、未改根路由**；根接入状态以主会话记录为准。
- 未做真实 PostgreSQL 多连接并发、根跨角色流程或手机外部试用；全部测试为隔离内存 PGlite + 受控 Port。
- 未在「队伍已退出比赛（`status='withdrawn'`）」之外再引入新的可见性规则：当前有效披露记录即展示依据；队伍退出后其历史披露记录不会被自动撤回（如需，属新的产品规则）。

---

## P5 · 文字留言（规划 34 C② / 宪法 v1.23.0 原则 XIII）

日期：2026-10-16。授权范围：**仅 `src/modules/event-judging/` 与本交付**。未编辑 `src/app`、`src/server`、`src/components`、`src/shared`、根 `migrations`、其他模块或根配置；未跑 build / 迁移 / 重启 / npm install / git 写操作。**本轮只做文字留言（P5），不做数值互评（P7）。**

依据：`docs/规划/34-主办方模块化与选手社区.md` §3.1（三层开关）、§3.2（两种点评分列）、§3.4（验收）；`.specify/memory/constitution.md` 原则 XIII「作品公开与点评（分列、不计入名次）」。

### 吸收闸门（规划 32 第 4.0 节三问）

1. **解决我们哪个真实问题**：P2（`ej_work_disclosures` + `works()`）只解决了"作品能不能被看到"，**零互动的公开展示对参赛者没有意义**；规划 34 §3.2 已把"文字留言"列为与"数值互评"**并列但分列**的能力，且用户裁定"文字与数值互评都要"。本批补的是**文字**这一列，P7 的数值互评（去自评、参与率门槛、量纲与维度）**不做**。
2. **会碰到哪些既有能力**：P2 的 `eventCommunity(scope).workShowcase`、`ej_work_disclosures` 与 `workShowcaseEntries()`；`IntakeReceipt`（作品快照）与 `latestReceiptOf()`；`EventParticipationPort.getRegistration`（本场报名资格）；`staff()`（`judging_manage`）；既有 `audit()`；`aggregate()` / `projection()` / `exportScores()` / `exportResults()`（结果链路，**一行未改**）。
3. **如何避免重复入口 / 第二份事实 / 第二套写路径**：
   - **不新增"能不能公开"的第二套判定**：读取与写入都调用 P2 同一个 `workShowcaseEntries` 前置事实（活跃披露记录）与新增纯函数 `comments.ts#commentGate()`；作品可见性、`participants/public` 两档语义与 `works()` **逐字同口径**。
   - **不新增配置**：长度上限直接读共享 `eventCommunity(scope).commentMaxLength`；**未改 `src/shared/organizer-contracts.ts`**，也未动 `EventModuleFlags`。
   - **不新增结果语义**：结果链路（`aggregate`/`previewResults`/`exportResults`/`exportScores`/`projection`）**一个字符未改**，也**不引用**新表——测试用逐字节比较与"删除留言行后仍不变"固定这一点。
   - **不新增入口族**：路由挂在既有 `competitions/:eventId/works/...` 前缀下（P2 已接），不新开一级导航或第二个作品详情页。

### 硬性要求逐条落实（每条都有行为断言，不是目测）

| 要求 | 落实 | 断言位置（`service.test.ts` / `comments.test.ts`） |
| --- | --- | --- |
| 1 三层门禁缺一即 403、零行落库 | `commentGate()` 顺序固定为 `workShowcase` → `peerFeedback` → 队伍有效披露（非 private）；四入口（读/写/隐藏/举报）都先过门禁。**不是空数组** | 「文字留言门禁…」：三种缺层各 403（`WORK_SHOWCASE_DISABLED` / `WORK_COMMENTS_DISABLED` / `WORK_COMMENTS_NOT_DISCLOSED`）、`count(ej_work_comments)=0`；`comments.test.ts` 另测顺序与 `withdrawn` 记录 |
| 2 只有能看到该作品的人能留言 | `commentViewerAccess()`=`participants` 必须本场报名 `approved`；`public` 任何已登录账号；未登录由 HTTP 层 401。读、写、举报都要过；作者本人隐藏不受观看资格限制（治理动作） | 「只有看得到该作品的人能读和留言…」：外队不通过者读/写/举报全 403 且零行；改 `public` 后同一账号可读可写；`http.test.ts` 断言未登录 401 且不调用服务 |
| 3 文字与互评分列、无评分字段 | 只有 `text`（上限取自配置）；无 `score/rating/percent/dimension/scale/weight`；**不建互评表**、不读写任何互评数据 | 「文字留言与互评分列…」：61 字拒绝/60 字通过（配置 60）、`information_schema` 无 `peer_review`/`peer_feedback` 表、视图字段集合固定 |
| 4 绝不并入结果 | 结果链路不引用留言表；`previewResults.summary`/`summaryHash`、`results-export` CSV、`exportScores` CSV、`myResults`、`publicResults`、`workspace`、`judgeMaterials` 前后**逐字节/逐字段**相等；删行后仍相等 | 「文字留言绝不并入结果…」（时钟保持不动，因为留档件头部含"生成时间"；这一点由第一版失败暴露并已如实修正断言，代码无误） |
| 5 评审隔离 | `judgeMaterials`、`judgeAssignments`、`eventWorkShowcase`、校准/自检/进度/公平包/重复线索、以及既有审计**都不含留言正文**；审计只记留言 ID/队伍/字数 | 「评审隔离…」8 个读取面逐一断言不含正文；审计断言含 `work_comment_created`+`charCount` 而不含正文；隐藏后审计仍不含正文 |
| 6 治理（隐藏/举报/限频/幂等） | 作者本人或本场 `judging_manage` 可隐藏；隐藏后视图 `text=null`；重复隐藏幂等（返回原记录、版本不变、不写第二行）；任一可见者可举报且同账号同留言只有一条（append-only）；同账号同赛事 30 秒冷却、隐藏不能绕过 | 「治理…」「举报…」「同账号同赛事限频…」 |
| 7 文案与用词 | `workCommentNotices` 写明"只提供文字留言""不计入名次""同一条只能隐藏一次""只记录事实"；断言不含"完成度/百分比/%/进度条/排名第/榜" | `comments.test.ts`「治理文案…」 |

### "没有第二份事实 / 第二套写路径 / 不出现在结果里"的证据

| 声明 | 证据 |
| --- | --- |
| 没有第二份事实 | 新增两张表只存**新事实**：一条留言（`ej_work_comments`）与一次举报（`ej_work_comment_reports`）。"作品是否公开"仍是 P2 的 `ej_work_disclosures`；"本场能不能留言"仍是共享 `community` 配置。三层门禁是**只读派生**，不落库、不新增状态枚举。 |
| 没有第二套写路径 | `postgres.ts` 里读写这两张表的函数各 `list/get/findReplay/insert/update`（留言）与 `list/find/insert`（举报），**没有任何第二个服务方法引用它们**；写入只有既有 `audit()` 一条附加路径，审计动作名固定为 `work_comment_created` / `work_comment_hidden` / `work_comment_reported`。隐藏只有 `active → hidden` 一条迁移（触发器强制、版本 +1），举报没有 UPDATE/DELETE 入口（触发器拒绝）。 |
| 不出现在结果里 | `aggregate()`、`summaryIn()`、`projection()`、`previewResults()`、`exportResults()`、`exportScores()`、`publishResults()` **一行未改**；`service.test.ts` 对提交留言前后逐字节比较，并把两张表的数据整体删除后再次比较仍相等——结果链路根本不引用它们。 |
| 不新增共享契约 | `src/shared/` 一行未改；本模块只 `import` 既有 `eventCommunity` / `DEFAULT_EVENT_COMMUNITY` 与类型。 |
| 不改 P2 | `works.ts`（P2 纯函数）、`ej_work_disclosures` 的读写函数、`works/publicWorks/myWorkDisclosure/submitWorkDisclosure/withdrawWorkDisclosure/eventWorkShowcase` 均未改；`workShowcaseEntries` 只被额外调用，未修改。 |

### 新增与改动文件

| 文件 | 变更 |
| --- | --- |
| `src/modules/event-judging/comments.ts` | **新增**：门禁（`commentGate`）、观看者资格（`commentViewerAccess`）、长度（`commentLimit`/绝对上界 4000）、正文与重试标识校验、冷却（`commentCooldownRemaining`，30 秒、含已隐藏）、视图投影（`commentView`，不含作者账号、隐藏即 `text=null`）、列表分页（`commentPage`，上限 200 保留最新）、治理文案与限制清单（纯函数，无 IO、无 `Date.now()`） |
| `src/modules/event-judging/model.ts` | 新增 `WorkCommentStatus` / `WorkComment` / `WorkCommentInput` / `WorkCommentHideInput` / `WorkCommentReportInput` / `WorkCommentReport` / `WorkCommentView` / `WorkCommentList` / `WorkCommentReportReceipt` |
| `src/modules/event-judging/postgres.ts` | 新增两表的**唯一**读写函数：`listWorkComments` / `getWorkComment` / `findWorkCommentReplay` / `insertWorkComment` / `updateWorkComment` / `listWorkCommentReports` / `findWorkCommentReport` / `insertWorkCommentReport` |
| `src/modules/event-judging/service.ts` | 新增内部辅助 `requireComments` / `commentTarget` / `commentViewerParticipant` / `requireCommentViewer` / `commentViewerIsStaff` / `commentIn` / `commentViews`；新增方法 `workComments` / `createWorkComment` / `hideWorkComment` / `reportWorkComment` |
| `src/modules/event-judging/http.ts` | 新增 handler `workComments`(GET) / `createWorkComment`(POST) / `hideWorkComment`(POST) / `reportWorkComment`(POST)；`EventJudgingRouteParams` 新增 `snapshotId?`、`commentId?` |
| `src/modules/event-judging/index.ts` | 导出 `comments.ts` 的纯函数、常量与 `CommentGateFailure` 类型 |
| `src/modules/event-judging/schema.sql` | 新增 `ej_work_comments`（+ 索引 + 守卫触发器）与 `ej_work_comment_reports`（+ 索引 + append-only 触发器），与迁移建议逐字一致 |
| `src/modules/event-judging/migrations/004-work-comments.sql` | **新增**迁移建议（根分配递增编号后应用；不动任何既有表） |
| `src/modules/event-judging/comments.test.ts` | **新增** 8 项纯逻辑验收 |
| `src/modules/event-judging/service.test.ts` | 追加 **11** 项文字留言服务验收（含 1 项"根合同抛 `ORGANIZER_FORBIDDEN`"回归） |
| `src/modules/event-judging/http.test.ts` | 追加 **2** 项路由验收 |
| `src/modules/event-judging/README.md` | 新增「文字留言（与数值互评分列）」一节与验证记录 |
| 本交付 | 本 P5 小节 |

**未改**：`validation.ts`、`works.ts`、`calibration.ts`、`integrity.ts`、`progress.ts`、`duplicates.ts`、`fairness.ts`、`checklists.ts`、`appeal.ts`、`preflight.ts`、`ports.ts`、`ui.ts`、`JudgingPanels.tsx`、`judging.module.css`，以及 `src/shared/`、`src/app/`、`src/server/`、`src/components/`、根 `migrations/`。

### 唯一新增事实的数据形状

`ej_work_comments`（JSONB `document` + 索引化身份列 + 文档一致性 CHECK + 守卫触发器）：

| 字段 | 含义 |
| --- | --- |
| `id, organizationId, eventId, authorUserId` | 身份；跨组织/赛事复合外键；正文、作者与重试标识不可改写 |
| `teamId` | **作品身份**：沿用 P2"一队一件作品"的展示单位（公开投影也是队伍级），不是回执级 |
| `snapshotId` | 写这条留言时该队**最新正式收件**（外键到 `ej_intake_receipts`），只作"当时是哪一版"的证据；入口要求 `snapshotId` 必须是**当前展示版本** |
| `text` / `status` / `revision` | 纯文字（1–4000 硬上界，实际上限取本场配置）；`active`/`hidden`；CAS 版本，隐藏 +1 |
| `createdAt, hiddenAt, hiddenByUserId, hiddenByRole, hiddenReason` | 时间与治理事实（`hiddenByRole = author\|staff`）；`hiddenAt` 与 `status` 由 CHECK 绑定 |
| `idempotencyKey` | 重试标识（1–120 字符），与提交人组成唯一键 |

`ej_work_comment_reports`：`id, organizationId, eventId, commentId, reporterUserId, reason(≤1000), createdAt`；`UNIQUE(organization_id,event_id,comment_id,reporter_user_id)` 保证同账号同留言一条；触发器拒绝 UPDATE/DELETE。

> 设计取舍（如实登记）：① 留言是**队伍级**而非回执级——与 P2 公开投影的单位一致，队伍换版本后留言不丢；代价是 `snapshotId` 只是证据，入口仍要求"当前展示版本"。② 隐藏保留库内正文（治理留痕需要），但**所有读取面**（包括审计）都不返回，视图 `text=null`。③ 冷却 **30 秒是模块内固定规则**：`EventCommunityConfig` 由共享契约持有、本会话无权修改 `src/shared`；若主办方要自行配置冷却，需根在 `EventCommunityConfig` 增加字段（见 NEEDS_INTERFACE 第 4 条）。
>
> 第三点已如实写入 `comments.ts#workCommentsLimitations` 附近的常量注释与 `workCommentNotices.rate`（界面会显示冷却秒数）。

### 端点契约

| Handler | 方法 | `/api/v1` 之后路径 | 参数 | 权限 | 行为 |
| --- | --- | --- | --- | --- | --- |
| `workComments` | GET | `competitions/:eventId/works/:snapshotId/comments` | `eventId,snapshotId` | 已登录 + 能看到该作品 | 返回留言区（`items` 无作者账号、隐藏项不出现）、`totalCount`/`hiddenCount`/`truncated`、`commentMaxLength`、`cooldownSeconds`、口径原文与限制清单。空列表是正常结果；三层门禁缺一 403 |
| `createWorkComment` | POST | 同上 | `eventId,snapshotId` | 同上 | `{text,idempotencyKey?}` + 可选 `Idempotency-Key` 头（不一致 400）；超长/空 422；冷却 429；同键不同正文或不同作品 409 |
| `hideWorkComment` | POST | `.../comments/:commentId/hide` | `eventId,snapshotId,commentId` | **留言作者本人**或本场 `judging_manage` | `{reason?}`；隐藏后对所有人 `text=null`；重复隐藏幂等（返回原记录、版本不变） |
| `reportWorkComment` | POST | `.../comments/:commentId/report` | `eventId,snapshotId,commentId` | 任一可见者 | `{reason?}`；只写举报事实，不改留言状态、不裁决；同账号同留言幂等；隐藏后的留言 404 |

**错误码**（既有 `DomainError` 信封 + no-store）：`WORK_SHOWCASE_DISABLED`(403)、`WORK_COMMENTS_DISABLED`(403)、`WORK_COMMENTS_NOT_DISCLOSED`(403)、`WORK_COMMENTS_PARTICIPANTS_ONLY`(403)、`WORK_COMMENTS_RATE_LIMITED`(429)、`WORK_COMMENT_NOT_FOUND`(404)、`INTAKE_NOT_FOUND`(404)、`IDEMPOTENCY_KEY_REUSED`(409)、`IDEMPOTENCY_KEY_MISMATCH`(400)、`JUDGING_INVALID_INPUT`(422)、`STAFF_REQUIRED`(403)、`UNAUTHENTICATED`(401)、`METHOD_NOT_ALLOWED`(405)。

**返回形状**：`WorkCommentList = { eventId, snapshotId, teamId, commentsEnabled: true, scope: "participants"|"public", commentMaxLength, cooldownSeconds, items, totalCount, hiddenCount, truncated, notice, notices, limitations }`；`items[] = { id, teamId, createdAt, status, text|null, isMine, canHide, canReport, reportedCount, reportedByViewer, hiddenAt, hiddenBy }`（**无作者账号、无任何评分字段**）。

### 迁移建议

`src/modules/event-judging/migrations/004-work-comments.sql`（模块内建议，非已部署）：只新增 `ej_work_comments` 与 `ej_work_comment_reports`、两个索引、两个触发器；**不改动任何既有表**。由主会话分配递增编号（根最新 072；P2 的 003 建议 073，本文件建议 **074**）写入根 `migrations/` 后执行。根应用前停机（PGlite 单写），应用后重启单实例。**本批未执行**任何迁移。

### 验证（真实执行）

```
node --experimental-strip-types --test src/modules/event-judging/*.test.ts
→ tests 144, suites 0, pass 144, fail 0, cancelled 0, skipped 0, todo 0
  （既有 123 项全部保留；新增 comments.test.ts 8 项 + service.test.ts 11 项 + http.test.ts 2 项）

node --experimental-strip-types --test src/server/organizer-router-acceptance.test.ts
→ tests 5, pass 5, fail 0（根已接好 3 条留言路由；L356–359 断言：参赛者 GET 留言区 200、匿名 401、评委 403）

node node_modules/typescript/bin/tsc --noEmit --incremental false
→（无任何输出）
EXIT=0
```

新增断言逐条对应规划 34 §3.4 与任务硬性要求：

1. **门禁**：三种缺层分别 403，四入口都覆盖，`count(ej_work_comments)=0`；三层齐全后空列表 200（不是错误）。
2. **可见性**：外队不通过者读/写/举报全 403 且零行；改 `public` 后同一账号可读可写；HTTP 层未登录 401 且不调用服务。
3. **分列**：长度取自配置（60 生效、61 拒绝）；无任何评分字段；库内不存在互评表。
4. **不变性**：`summary`/`summaryHash`/`round`/`publicationReview`/`exportResults().csv`/`exportScores().csv`/`myResults()`/`publicResults()`/`workspace()`/`judgeMaterials()` 前后逐字节（字段）相等，分数仍 80/60、名次 1/2；**删除两张留言表数据后仍相等**。
5. **隔离**：8 个评委/主办方读取面与审计都不含正文；审计含 `work_comment_created` + `charCount`。
6. **治理**：非作者非工作人员 403 且状态不变；工作人员与作者各隐藏成功且 `hiddenBy` 正确；重复隐藏 `deepEqual` 相等、库内仍 1 行、`revision=2`、原隐藏说明不被改写；触发器拒绝回退 `active`、跳版本、改写正文/作者。
7. **举报**：同账号第二次举报 `alreadyReported=true` 且库内 1 行；留言仍 `active` 且正文照常返回；其他可见者仍可各自举报；隐藏后举报 404；`UPDATE/DELETE` 被触发器拒绝。
8. **限频**：冷却内 429 且零行；隐藏不能绕过；他人不受影响；到点后放行。
9. **幂等/不可变**：同键同正文重放 `deepEqual`；同键不同正文或不同作品 409；新键产生新行。
10. **版本定位**：旧版本快照 403；未知/跨赛事快照 404；留言在最新版本下照常返回（队伍级作品事实）。
11. **路由层**：缺 `snapshotId`/`commentId` → 400；`Idempotency-Key` 与正文不一致 → 400 且不到服务层；未登录 401；未通过 mutation 授权 → 403 且不调用服务；错误方法 → 405。
12. **宿主拒绝写法差异**：同一份代码在模块夹具（`STAFF_REQUIRED`）与真实根（organizer 的 `ORGANIZER_FORBIDDEN`）下都必须能读出留言——见下节「根接线修复」。

### 根接线修复（2026-10-16，主会话根路由验收反馈）

主会话接好三条路由后跑真实根路由验收，暴露一个**模块测试夹具掩盖了的集成缺陷**：

- **现象**：本场 `workShowcase=true`、`peerFeedback=true`、作品已由队伍本人选择 `participants` 公开，请求者是**本场报名已通过的选手**（非工作人员）→ `GET .../comments` 期望 200，实际 **403 `ORGANIZER_FORBIDDEN`**。
- **根因**：`commentViewerIsStaff`（只用于把 `canHide` 如实告诉界面）只把 `STAFF_REQUIRED` 当作"不是工作人员"。真实根里 `staff()` 走注入的 `events.requireStaff`，即 organizer 的 `eventAccess.requireStaff`，拒绝时抛的是 `ORGANIZER_FORBIDDEN`，于是探测异常把读留言的 200 变成了 403。模块测试没暴露，是因为夹具自己抛 `STAFF_REQUIRED`。
- **修复**：改用共享 `isDomainError()`（跨 bundle 副本也稳）并**把任何 403 都视为"不是本场工作人员"**（同时兼容 `STAFF_REQUIRED` / `ORGANIZER_FORBIDDEN`）；非 403（会话失效、赛事范围不符、Port 故障）照常抛出，不静默吞掉。`canHide` 只是展示信息，**探测绝不能改变业务结论**。
- **回归测试**：`service.test.ts` 给夹具加了 `hooks.staffDenial`，复现"根抛 `ORGANIZER_FORBIDDEN`"：参赛者读留言 200、可写、作者 `canHide=true`、他人 `canHide=false` 且可举报；换成 401 `SESSION_REVOKED` 时照常抛出。
- **验证**：模块 144/144、根 `src/server/organizer-router-acceptance.test.ts` 5/5（L356–359：参赛者 200 / 匿名 401 / 评委 403）、`tsc --noEmit --incremental false` exit 0、无输出。

### NEEDS_INTERFACE（根接线）

**状态：三条路由与 `snapshotId`/`commentId` 参数已由主会话接线并通过根路由验收；迁移与界面仍待主会话决定。** 本模块只提供 handler 成员。

1. **`EventJudgingRouteParams` 新增 `snapshotId?: string` 与 `commentId?: string`**（已在模块内声明；根现有原型转换 `as unknown as EventJudgingRouteParams` 无需改动）。
2. **向 `JUDGING_ROUTES`（`src/server/organizer-integration.ts` L91–132）追加三条**（注意放在 P2 现有 `works` 规则之后即可，后缀不冲突）：

```ts
{ pattern: /^competitions\/([^/]+)\/works\/([^/]+)\/comments$/, methods: { GET: "workComments", POST: "createWorkComment" }, parameters: ["eventId", "snapshotId"] },
{ pattern: /^competitions\/([^/]+)\/works\/([^/]+)\/comments\/([^/]+)\/hide$/, methods: { POST: "hideWorkComment" }, parameters: ["eventId", "snapshotId", "commentId"] },
{ pattern: /^competitions\/([^/]+)\/works\/([^/]+)\/comments\/([^/]+)\/report$/, methods: { POST: "reportWorkComment" }, parameters: ["eventId", "snapshotId", "commentId"] },
```

3. **迁移**：把 `src/modules/event-judging/migrations/004-work-comments.sql` 复制为根 `migrations/074_work_comments.sql`（自选编号，需递增且未被占用；若 P2 的 003 尚未应用，**先 003 后 004**——留言表的 `snapshot_id` 外键指向 `ej_intake_receipts`，不依赖 `ej_work_disclosures`），停机后应用、重启单实例。本批**未执行**任何迁移。
4. **配置前置**：文字留言只读共享 `community` 的两个开关（`workShowcase` + `peerFeedback`）与 `commentMaxLength`（主会话在 `src/modules/organizer/validation.ts` 已校验 50–2000）。**本模块未改 `src/shared/`**。若主办方需要可配置的评论冷却（当前固定 30 秒）或留言条数上限，需根在 `EventCommunityConfig` 增加字段并随发布版本冻结；本会话无权改共享契约。
5. **界面（本批未做，避免越权改 `src/app`/`src/components`）**：作品详情页新增**独立区**（标题写明"选手文字留言 · 不计入名次"），使用 `GET/POST competitions/:eventId/works/:snapshotId/comments`；隐藏/举报按钮分别调 `hide`/`report`（`canHide`/`canReport` 由服务端给出，不要在前端推断身份）；必须逐字展示 `notices` 与 `commentMaxLength`。**不要把留言塞进既有结果页/评审面板**（那会与要求 5「评审隔离」和"分列"冲突）。P7 数值互评**未做**，界面不要预留打分入口。
6. **举报后续处理的读取面**：本模块按任务只提供"记录举报事实"的写入口（reports 表 + 既有 `auditHistory` 的 `work_comment_reported` 条目）。若主办方需要"举报处理队列"，属新的读取接口与产品流程（规划 34 未列该端点），需另行授权后新增。
7. **依赖边界**：不新增共享 Port。作品可见性与留言资格都用既有的 `HostedEventAccessPort`（`requireStaff(judging_manage)`）与 `EventParticipationPort.getRegistration`。

### 未做与边界

- **未做 P7 数值互评**：无评分列、无量纲、无维度、无去自评、无参与率门槛；本批不建互评表，`peerReview` 系列配置本模块**一律不读**。
- **未做界面**（授权仅模块与本交付）；`ui.ts` 与 `JudgingPanels.tsx` 未改。
- **未做举报处理队列**（见 NEEDS_INTERFACE 第 6 条）。
- **未做评论分页的多页游标**：一次最多返回最新 200 条（`truncated`/totalCount 如实报出），需要翻页属新的接口设计。
- **未改任何结果链路**；未执行迁移、未跑 build/重启、未改根路由。
- 全部测试为隔离内存 PGlite + 受控 Port，**不代替**真实 PostgreSQL 多连接竞态、根跨角色流程或手机外部试用。
