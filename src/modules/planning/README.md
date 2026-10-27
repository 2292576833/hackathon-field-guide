# M05 任务规划与动态调整

## C03 站内计划提醒（2026-10-10）

`PlanningNotificationService` 与 `createPostgresPlanningNotificationRepository` 持久保存提醒及本人的已读/收起状态。`createPlanningNotificationWorker(service).runOnce({projectIds?,limit?})` 只检查确定性当前事实，合并 `project+cause+sourceRevision`，不调用模型、不应用或修改计划。M05 四类真实 outbox 经独立消费 receipt 在同一事务提交；保留原 `published_at` 给其他消费者。根传当前有计划项目，以及 M02/M03/M06 变更关联项目；时间流逝也由根周期 tick 检查，模块没有自行启动后台进程。

`PlanningNotificationProjectPort.lockProject(projectId,sql)` 要同 executor 保护当前项目、成员与有效账号事实；`PlanningNotificationSnapshotPort.readSnapshot(projectId,sql,now)` 要保护当前输入/风险。模块先取 `planning:<projectId>` 锁，再调用注入 Port，最后取通知锁。**根不能先锁 project 再调用现有 `planning.getCurrent/planningFacts.readInput`**：`facts.ts` 的保护路径先锁 M04 assignment head，再锁 project，会造成相反锁序。应组合专用只读通知快照，避免后置 head 写锁；或先在项目 Port 按全站顺序保护 head，再锁项目且快照不后置初始化。本人 GET 的 Port 不能用默认 `getHead()` 创建行。`derivePlanningNotificationFacts({current,input,progress?})` 只消费已构造的当前评估、当前输入与进度；公开规则更新尚未被项目确认时，根可另加真实 `rules_changed` 事实，不能把旧确认版本改成新版本。所有 link 从项目 ID 与原因白名单生成。

`listOwn(actor,{limit?,projectId?})` 只读取本人收件记录，每次复核活跃项目成员，服务端筛项目并用 keyset 继续扫描被撤权记录，避免其他项目占满候选。`markRead` 仅更新本人 receipt，CAS 不改变风险或任务；`dismissResolved` 重新读取当前风险，仍在触发时拒绝收起。已生效负责人安排是 `requiresAction:false` 的个人告知，允许知悉收起，按整份计划固定版本合并，不因一项任务完成重发。离队记录作持久撤销，不因重新加入恢复旧收件记录。归档停止新派送并结束当前提醒；恢复项目或已解除风险真实复发时重开同一 group，只将未撤权收件人的 read/dismiss 清空并推进 CAS，不新建同源记录。根复用同一 worker 实例，worker keyset 扫描 pending 并保留尚未选中的候选，和周期项目交错轮换，单项目失败返回有界 error code 不阻断全轮。

`createPlanningNotificationHandlers` 提供 GET `/me/planning-notifications?limit=50&projectId=...`（projectId 可省略）、POST `/me/planning-notifications/:id/read` 和 `/dismiss`，请求仅 `{expectedRevision}`；根负责可信会话和 CSRF。GET 无初始化/消费/写库/付费。UI 在 `components.tsx` 导出 `PlanningNotificationsPanel({viewerId,projectId?})`；账号切换或 session 失效清空私人列表。

## C03 历史恢复与逐项差异

`createPlanningHandlers.restoreAsDraft(request,{projectId,planId})` 接 POST `/projects/:projectId/plan-versions/:planId/restore`，返回 `201 {data:PlanVersion,requestId}`。`parseRestorePlanCommand` 只接受 `{reason,expectedTasksRevision,basePlanVersionId,idempotencyKey}`，拒绝客户端 tasks/buffers/身份。已有 `PlanningService.restoreAsDraft` 使用服务器历史版本，当前 manager/归档/事实/任务基线仍由原服务复核，生成新草案并保留已完成成果，不直接生效。

`PlanChangesPanel({plan,baseline,memberNames?,timeZone?})` 在 `components.tsx` 导出，baseline 必须是原始不可变基线，不能用后续新生效版本冒充。逐项列真实新旧负责人、检查人、协助工时、截止、依赖、必交要求、估时、窗口、缓冲与计算排程，未提供时区明确北京时间。`src/components/planning-client.tsx` 在追加授权下接入历史恢复、恢复理由、真实差异及本人通知面板。根路由和浏览器最终验收由主会话执行。

新增 `migrations/003-planning-notifications.sql` 仅为 SQL 建议，由根组合新的递增迁移。新增行为测试用独立 PGlite，未连接试用/生产数据库，也未验证线上 PostgreSQL 多连接锁等待。准确根接线与验证结果见 `docs/协作/交付/planning-event-completion.md`。无新增环境变量。

## C03 可选固定技能引用

`PlanningTask.skillRefs?: TaskSkillReference[]` 复用 M10 公共契约和纯校验 helpers；`PlanningReviewedSkillsPort.get(reference,transaction)` 注入已审核固定版本 lookup，不写 M10 表。缺省沿用原任务引用，`[]` 明确清空。新采用或用途、环境、学习分钟改变时核对精确 reference，应用再次核对；lookup 不能替换成最新或另一版本。已生效完全相同的历史引用保留，即使后来撤回；done 引用不可改，仍 cancelled 的历史不阻断其他操作，恢复为活动任务则重新审核。

学习分钟总和必须已包含在原任务 `durationEstimate.likelyMinutes` 中，不建立第二份容量。模型的可选 `skillRefs` schema 不要求旧输出提供字段，候选仅来自当前任务实际固定版本，不生成不存在的新候选。差异面板显示固定版本、用途、学习分钟和环境变化。根已接同 SqlExecutor 的 reviewedSkills；实际环境与最终页面验收由主会话完成。技能规则及差异新增 16 项测试通过。

本轮最终 planning/events 全部 Node 测试及 M08 纠错服务/handler 共 **384 项通过**，全局 `npm run typecheck` 通过（2026-10-10）。本会话完成交还后停止编辑；构建、真实迁移和启动由主会话执行。

本模块提供手动任务计划、确定性排程、进度记录、原子版本应用，以及可接入实际结构化模型的持久生成队列。模型结果经过严格解析与规则校验后仅保存为草案，由管理员确认应用。没有实际供应商调用证据时，不显示模型已接入成功。

## 公共入口

`index.ts` 导出实体、Ports、`validatePlan`、窗口/估时校验、`diffPlans`、M02 窗口适配、请求解析、`PlanningService`、HTTP handler 工厂和 PostgreSQL repository 工厂。`testing/` 仅用于模拟行为测试，不能作为真实队伍试用存储。

## 时间与容量

- 时间必须包含 ISO 日期、时间、offset 或 Z，时区保留 IANA 名称；canonical UTC 的 Z 与来源时区分别保存。带本地 offset 的窗口要与指定时区一致。不会从“周五晚上”推断时刻。
- M02 `MemberAvailability` 是唯一成员可用时间集合。M05 只读取版本化窗口，计划中的 inputSnapshot 为历史依据，不能作为当前可用时间的写入口。
- 有效容量合并重叠 work，扣除 rest/occupied，并裁剪已过去时段；扣除只作用于真实交集。学习、调试、交接、集成、测试、材料均为占用容量的任务。
- `createMemberAvailabilityValidator(access)` 可注入现有 M02 `AvailabilityValidationPort`。M02 当前输入表示已排除休息的工作窗口，`effectiveMinutes` 须等于窗口长度；适配返回并集总容量，不重复计算。`availabilityFromProjectCollection` 按成员关系 revision 核对唯一集合。上游需在 canonical 化前检查原始 local offset 与时区，才能保留矛盾检测。
- 采用稳定拓扑＋必须任务/截止排序的贪心排程；常规、保守估算各自计算。此算法可解释，但不声称全局最优。负责人和 helperEfforts 分别扣容量；协助工作按独立工作段安排，如需同步协作，应拆出明确协作约束并在集成层确认。
- 不可拆任务需要连续窗口；可拆任务在每个后续窗口占用 contextSwitchMinutes，waitMinutes 只计经过时间。多个 deadline 独立保留。截止前 buffer 为对应 submission 任务保留，其他工作不能侵占。
- `requiredTaskKinds` 必须由具体项目策略明确指定，通常包含 integration/testing/submission；陌生工具应另加 learning 或接入任务。策略和估算要用真实试用校准。

## 计划与进度

`PlanningService` 依赖 `ProjectAccessPort`、`PlanningFactsPort`、持久化 repository、Clock 和 IdGenerator。所有私人读取先核对活跃项目成员；创建/编辑/恢复/应用计划限项目 manager。平台管理员或 Team captain 不自动取得项目权限。

- `createDraft` 锁定基线与输入版本，保留状态和验收事实，返回 `ready` 或 `needs_changes`，生效指针不变。
- `editDraft` 可重新校验 stale 草案；已 applied/superseded 版本不可原地修改。
- `apply` 在同一数据库事务中重新核对输入、草案和任务版本、资源审核、当前时间；更新任务、生效指针、历史状态、幂等结果和 outbox。结构合法但 unknown/at_risk/infeasible 的方案必须明确确认全部未解决 issue codes。`applied` 不意味着 `feasible`，两字段独立。
- `restoreAsDraft` 将历史方案转为当前输入下的新草案，保留已验收工作；历史中的活动任务如果现在已删减，会提出显式重新启用（`reopenCancelled`），恢复也需要管理员确认。
- `updateProgress` 只允许本人负责人/manager更新，指定验收人可执行 done 验收。todo/in_progress → review → done；有指定验收人时负责人不能自判完成。无指定验收人可以明确 self_check；完成须有证据、验收说明且前置成果已验收。更新追加记录，修正引用原记录并说明理由，旧记录保留。
- 任何新进度使未应用 ready 草案 stale；应用旧草案返回 VERSION_CONFLICT，不覆盖新成果。没有进度时不自动增长完成率，getCurrent 返回 lastProgressAt 与实时评价。
- GitHub 保存、运行验证、正式提交仍由 M06 管理；本模块不从保存事件生成验收成功，也不生成 SubmissionRecord。
- `InputVersions.projectArchived/projectReadOnly` 为兼容旧事实 adapter 的可选字段。创建、编辑、应用、恢复和进度写入检查最终加锁的项目状态；归档/只读返回 `PROJECT_READ_ONLY`，保留原草案、进度与历史供读取。加锁后重新核对活跃 manager 或进度权限。

## 2026-10-09 U02 团队空间任务体验

`task-board.ts` 的公开纯函数 `buildTaskBoard`、`unmetDependencies`、`dependentTaskIds` 从同一份 `PlanningTask` 推导可开始、等待、正在做、待检查和已完成，不维护第二套完成状态。独立准备工作可以并行；完成报告（review）不会满足依赖。缺少前置任务、真实验收、活跃负责人或容量时显示原因，前端根据当前常规排程判断是否已有可安排的工作时间。“我现在能做”表示依赖和有效排期允许开始，页面同时提示结合本人实际可用时间，不宣称此刻一定空闲。

`TeamTaskBoard` 已组合进 `PlanPanel`。任务说明、成果、工时、前置任务名/负责人、可先做任务与最近进度就地展示。负责人/管理员提交成果到 review，指定检查人、管理员或允许自检的本人再按条件确认 done。普通更正引用旧进度和理由；已验收任务使用单独的管理员更正。可见页面每 10 秒只 GET 已保存 current/progress，隐藏与卸载取消正在读取的请求并停止定时器；刷新保留按任务 ID 固定的表单，不按 revision 重新挂载。输入开始时保存 revision，新记录出现后需要明确核对继续，服务器最终再次拒绝旧版本覆盖。`hackathon:project-input-changed` 事件只刷新 AssignmentPanel/PlanPanel 已保存数据并取消本地确认勾选，保留任务和草案输入，不请求 AI。

- `InputVersions.trackSelectionRevision?: number | null` 与 `memberIntentionRefs?: {membershipId, revision}[]` 进入版本比较和重大差异。意愿 refs 按成员 ID 稳定排序比较，撤回共享仍需传当前 revision。旧适配未提供时只保留未知兼容，不伪造历史依据。`getCurrent.inputVersionsChanged` 专门说明输入版本/资源依据变化；普通任务进度本身仍可以使已有 `staleInputs` 为 true，两者含义分别保留。`getCurrent/listHistory/listProgress` 在读取后复核活跃成员。
- `requestAcceptanceCorrection` 仅允许活跃 owner/helper 本人提出更正请求，最终事务核对归档、权限、task revision 和当前验收记录。请求追加 `ProgressUpdate.correctionRequest`（原验收快照、原记录 ID、理由、actorId、时间），不改任务、task revision、tasksRevision、计划或 acceptance，不释放/重新计算依赖。管理员任务板会显示当前验收的请求与理由；旧请求在实际更正或重新验收后继续保留在历史。
- `correctAcceptance` 仅 manager；校验当前 task revision、全局 tasksRevision、精确当前验收记录和全部活跃后继 ID。更正必须有理由，原 acceptance 完整保存在 `ProgressUpdate.acceptanceCorrection`。目标回 review/in_progress，已验收后继回 review 并清除当前 acceptance，在做后继标 blocked，待开始后继保持等待。每个受影响变动追加历史记录；历史验收与旧计划快照不改写。全部写入、ready 草案失效、幂等结果和既有 outbox 在同一事务提交，仍使用 ProgressUpdated/PlanRiskDetected 事件，不新增 outbox 枚举。

### NEEDS_INTERFACE（主会话根组合）

1. 新 POST `/projects/:projectId/tasks/:taskId/acceptance-correction-request` 接 `createPlanningHandlers.requestAcceptanceCorrection`。请求例：`{expectedRevision:2, acceptanceProgressId:"accepted-record-id", reason:"发现核心流程遗漏", idempotencyKey:"uuid"}`。403 非 owner/helper；409 旧 revision/旧验收/归档；保存输入后 GET 最新进度，核对后再重试。请求不授予更正权限。
2. 新 POST `/projects/:projectId/tasks/:taskId/acceptance-correction` 接 `createPlanningHandlers.correctAcceptance`。例：`{expectedRevision:2, expectedTasksRevision:8, correctionOf:"accepted-record-id", correctionReason:"原检查条件没有满足", status:"review", acknowledgedDependentTaskIds:["video","submit"], idempotencyKey:"uuid"}`。403 非 manager；409 VERSION_CONFLICT、ACCEPTANCE_NOT_CURRENT、INVALID_CORRECTION、CORRECTION_IMPACT_UNACKNOWLEDGED、归档。后继列表必须是当前真实依赖图的完整集合，不能由用户省略。普通 progress 入口仍拒绝回退 done。
3. `PlanningFactsPort.readInput/lockVersions` 同时组合 M02 赛道选择 revision 与成员意愿 refs（含撤回共享的版本）；账户、请求会话与 M02 活跃成员/只读状态需在同一实际事务最终复核。继续现有事务 executor 与稳定锁顺序，不直接写 M02/M04 私有表。
4. 现有 GET `/plans/current` 已随服务返回 `inputVersionsChanged`；GET `/progress` 返回新增可选历史 metadata。API 保持 private/no-store、同源 mutation/session 校验。客户端通过真实接口读取，没有静态成功结果。
5. **SQL 迁移需求为 0**：新增输入/更正字段保存于现有 `planning_states.state_json`，幂等和事件沿用现表。未改已应用迁移、未新增根 migration、未创建第二份状态。老 JSON 无可选 metadata 仍能读；无法找到旧验收对应 ProgressUpdate 时不虚构更正记录，页面提示管理员核对历史。

新增 `task-board.test.ts` / `progress-correction.test.ts` 验证并行准备、容量局部缺口、完成报告不释放依赖、当前精确验收、后继影响、原历史保留、owner请求幂等且不改状态、权限/归档/退出复核、并发 revision、赛道/意愿 stale 与严格 HTTP JSON 身份拒绝。完整 M05 测试继续覆盖循环、容量、时间、资源审核、AI 草案和 PostgreSQL adapter；PGlite 用独立测试实例。模块测试不等于运行网站两个真实账号、手机或线上 PostgreSQL 并发验收。没有新增环境变量，没有读取 `.env.local`，没有付费 DSH、真实 GitHub 写入、构建、重启或发布。

## 资源内容依据

前端继续提交 `TaskProposal.resourceRefs: string[]`。服务端把新引用固定为 `PlanningTask.resourceContentRefs: { resourceId, version }[]`，同时在 `inputSnapshot.resourceContentVersions` 保存当次查询的公开内容版本。`version` 是 M09 已审核公开内容版本，不能使用工作草稿的 `revision`，也不能由客户端声明审核状态。

- 新引用或显式 `refreshResourceRefs: string[]` 由服务端查询当前已审核版本并校验；刷新只传本任务的 ID，不传版本。刷新资源依据是重大计划差异，需要复核学习、接入与验收影响。已验收任务的历史依据不可刷新，应新增任务记录影响。
- `resourceReviewRequiredRefs` 保存新选择/刷新引用的服务端来源；标题编辑保留既有固定版本和待复核标记。应用时在同一事务中再次调用 M09 `validateResourceRefs`，公开版本改变或下架返回冲突，不能靠风险确认通过新引用审核。
- 已应用的历史引用保留原版本；同 ID 发布新版、下架或无法查询时，当前评价和差异返回资源风险并标记 `staleInputs`。继续使用旧依据需要新草案明确确认风险，历史快照不改写。
- 旧数据只有字符串 ID 时显示 `RESOURCE_CONTENT_VERSION_UNCONFIRMED`，不把今天的版本回填为历史事实。恢复旧计划通过服务端 `resourceLegacyRefs` 保留可信来源；恢复幂等指纹包含来源计划与资源依据。移除后重新加入的引用按新引用审核；取消的新任务也不能隐藏未审核引用。
- 查询所有引用按全局 ID 排序，每批最多 50 项，先在事务中保护全部 M09 公开行再校验新引用子集。无引用时可手动继续；仅实现旧 ID 查询的 adapter 仍可编译，但不能固定/应用新资源依据。

## 持久化与集成

`createPostgresPlanningRepository(database)` 仅依赖共享 DatabasePort/SqlExecutor，不创建连接池。`migrations/001-planning.sql` 是主会话审阅/执行的迁移建议；本模块不执行实际迁移。

首版少量队伍使用每项目 JSONB 聚合保存 tasks、plans 和追加进度，revision 乐观锁＋项目事务锁串行写入，避免初次计划并发初始化。计划快照、幂等和脱敏事件共用事务；没有数据规模实测前不引入复杂分表排程。使用 JSONB 的限制是项目历史增长会增加整聚合读写成本，试用后按实际规模拆表。

`PlanningFactsPort.lockVersions` 必须使用传入 SqlExecutor 锁住 M04 分工、M02 项目/成员/可用时间和 M03 规则当前事实直至提交；集成约定顺序为 M04 head → M02 context → M03 pointer，相关模块写操作需使用兼容顺序。随后资源 adapter 用同一 executor 保护 M09 公开行。内容版本由资源 Port 独立复核，不把它混入 M02/M03/M04 的版本相等判断。连接池、嵌套事务复用与路由组合由主会话负责。

`createPlanningHandlers` 提供 getCurrent/listHistory/listProgress/getDiff/createDraft/editDraft/apply/updateProgress。getDiff 检查草案输入新鲜度，差异包含来源截止、窗口、要求版本、排程与风险变化。主会话组合 Next.js 路由、会话解析和 `authorizeMutation`（cookie会话同源/CSRF校验）。Actor 不从 JSON 获得，请求拒绝未知字段，私人响应设置 no-store。手动创建草案同步返回 201；AI生成使用下方独立持久job与202入口。

## AI 计划生成

`createPlanningModelAdapter(jsonModel)` 适配根提供的结构化 transport，接口为 `PlanningJsonModelPort`：`modelVersion` 和 `completeJSON({systemPrompt,input,promptVersion,outputExample?,maxOutputTokens?}, signal)`。供应商与 DeepSeek 等 model 配置、网络调用、预算/费用 ledger 由根实现；模块不导入 `src/server/`，不读取凭据或在 adapter 中网络重试。

```ts
const generation = createPlanningGenerationService({
  planning,
  repository: createPostgresPlanningGenerationRepository(database),
  access,
  model: createPlanningModelAdapter(jsonModel),
  clock,
  ids,
});
const generationHandlers = createPlanningGenerationHandlers({
  service: generation, resolveActor, authorizeMutation, requestIds: ids,
});
```

- `queueGeneration(actor, projectId, command)` 原子保存真实 `queued` job，HTTP返回202；不在请求中同步运行模型。command为 `{goal,instructions?,resourceIds,buffers,expectedTasksRevision,basePlanVersionId,idempotencyKey}`，不接收Actor、版本事实或成功状态。同 project/actor/key 的同一请求复用原job，异内容冲突。
- `getGenerationJob/listGenerationJobs` 仅当前活跃项目成员读取；生成、显式重试和取消限原请求的活跃 manager。建议路由 `POST/GET /projects/:projectId/planning/generation-jobs`、`GET .../:jobId`、`POST .../:jobId/retry|cancel`；retry/cancel body为 `{expectedRevision}`。响应统一 requestId 和 private/no-store，写操作要求CSRF保护。
- 受控 worker 调用 `listQueuedAIJobs(limit)` 后 `processGenerationJob(jobId)`；`listRunningAIJobs(limit)` 和 `recoverExpiredGenerationJob(jobId)` 用于进程恢复。列表仅返回 `{id,projectId,actorId,revision,status,createdAt}`，不得把这些方法开放为未鉴权公网路由。状态为 `queued → running → succeeded/failed/cancelled`，业务 plan 的 ready/applied 独立。
- 排队固定实际项目/成员/分工/窗口/要求版本、任务基线、候选公开资源版本。发模型前和保存前复核，期间进度、规则、权限、归档或资源变化则终止，不采用新事实掩盖旧生成依据。新资源只允许捕获的已审核exact ID；已有历史依据继续保留风险，不创造链接或审核声明。
- 模型只返回 `{tasks,reason,assumptions}`；必须保留已有任务，取消需明确理由，完成成果不可重写。生成专用检查要求 must 集成/测试/材料/提交阶段、同原截止的必交项、每个作品/材料截止的正数确认缓冲及独立提交任务；正式提交的依赖链须等待同截止必须工作。缓冲来自管理员输入，模型不能替换。容量不可行的合法草案可供讨论；未确认假设持续参与 unknown 评价，应用仍需明确确认约束。
- 默认单次30秒、每job最多2次外部尝试（可配置，最高3）。取消和超时仅停止接受结果，不声称撤销供应商远端调用。过期租约终结为 `WORKER_INTERRUPTED`，迟到结果不能保存；不自动重试未知调用。只有可恢复外部失败可由原请求人显式重试，事实变化需新请求。无模型或失败时手动规划仍可使用。
- 完成使用同一 DatabasePort 事务，先 `planning:<projectId>` 项目锁，持久job租约/CAS检查，按既定顺序保护事实与资源，再嵌套 PlanningService创建draft及保存job。根必须复用同executor（嵌套保存点），确保job完成失败或租约过期会回滚草案/outbox/幂等。`migrations/002-planning-generation.sql` 为新增job表与索引建议，根采用新递增迁移，不重写已应用001。

## 验证

```powershell
node --test src/modules/planning/*.test.ts
$planningTypeFiles = @(rg --files src/modules/planning | Where-Object { $_ -match '\.ts$' })
node node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution bundler --allowImportingTsExtensions --types node @planningTypeFiles
```

当前 137 项模块测试与独立严格类型检查通过。规则与服务测试覆盖时间、依赖、容量、硬要求、权限、验收、版本冲突、幂等、资源内容固定/改版/历史恢复、超过50项分批锁顺序及最终加锁后的归档/权限撤销保护；生成测试覆盖真实持久队列与worker、HTTP、前后事实复核、模型预算契约、取消/超时/晚结果、人工确认及AI假设保留。SQL测试含模拟DatabasePort与4项隔离PGlite实际迁移/约束/持久化/同executor原子回滚，不能替代多连接PostgreSQL锁竞争验收。资源字段兼容既有JSONB；生成job需要新增002迁移。

主会话负责实际根迁移、事实与M09 adapter、中央worker/预算ledger和Next.js页面/路由组合，以及多连接PostgreSQL真实并发验收。本模块已提供生成adapter与持久worker，但未真实调用模型供应商；站内提醒消费和真实队伍参数仍待接入或校准。数据库环境变量由主会话连接池使用 `DATABASE_URL`，模型变量由根transport管理；本模块不直接读取凭据。
