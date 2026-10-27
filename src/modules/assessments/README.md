# M04 测评与分工

本模块负责固定版本题组与量规、本人作答、评分任务、最小共享摘要和分工版本。公开入口为 `index.ts`。服务端组合时注入已验证的 `Actor`、M02 权限查询、项目输入快照、时钟、ID、PostgreSQL 数据库及可选评分器。没有模型仍可手动分工。

## 使用边界

- `PILOT_QUESTION_SET` 是待审核的试用题组，不会自动发布；量规未作真实队伍校准。审核后应通过正式题库流程发布不可变版本。
- 每份测评保存题组和量规快照。停用题组只阻止新建测评，历史测评保持原规则。
- 回答、经历、作品证据、评分理由与模型限制只通过本人报告返回。项目管理员与网站管理员无权读取其他成员的原始回答。
- 共享默认关闭；本人选择任务维度及评分项。团队摘要只含选择的任务与分项结果，不包含答案、证据文本、模型解释、私人经历。共享撤回立即影响下一次摘要读取和生成。
- 得分仅表示本次题组/量规行为锚点下的整数分。维度只展示已评分项的加权点数/可得点数；证据不足不等于零能力。未经科学校准，不返回百分比、匹配度、成功概率或排名，不接受年龄字段，不将分数换算成速度。
- 分工草案可手动创建，未测评成员可正常安排。负责人/协助者引用 `ProjectMembership.id`。缺负责人可保留 `needs_changes` 草案，但不能应用。
- `ready` 表示结构校验通过。管理员必须查看差异后确认应用，时间可行性由 M05 单独校验。已应用的内容不可覆盖，后续变化创建新版本。
- 当前事务的项目快照为 `stage:"archived"` 或 `readOnly:true` 时，所有人工测评/分工写入返回 `PROJECT_READ_ONLY`（409）。历史报告、评分任务、共享摘要与分工仍可按原权限读取；没有分工的历史读取不会初始化数据库 head。

受控 `AssignmentContextPort` 须从 M02 当前项目事实提供 `stage` 与适用的 `readOnly` 标志，并使用传入事务连接锁定这些事实。字段可选仅为兼容旧快照与测试夹具；正式组合不能省略项目状态，也不能接受客户端提供状态。阶段/只读变化纳入分工输入指纹。

评分 worker 在领取、派发前及发布结果的最终事务快照检查项目状态。排队前已归档时不调用模型，运行中归档时不发布新评分；可把已有任务终结为失败，并清除 attempt.activeJobId、更新失败运行状态/修订号与 outbox。这是已发生任务的执行元数据收尾，不改原始回答、旧评分、共享范围或分工事实，避免任务永久停在进行中。分工建议在生成前和结果保存前分别检查，晚到草案不能绕过归档。

## 服务与 HTTP 组合

`new AssessmentService({...})` 需要 `AssessmentRepository`、`QuestionCatalogPort`、共享 `ProjectAccessPort`、`AssignmentContextPort`、`Clock`、`IdGenerator`。`PostgresAssessmentRepository` 使用主会话提供的 `DatabasePort`；`PostgresQuestionCatalog` 读取模块题库表。SQL 建议在 `sql/001-assessments.sql`，由主会话审阅并纳入实际迁移。

使用 PostgreSQL 存储测评时，相应题组/量规版本必须先写入题库表，满足历史引用外键。`FixedQuestionCatalog` 是不可变配置适配，不能替代数据库题库中的历史版本。真实发布权限与审核记录由运营组合控制。

`createAssessmentHttpHandlers({ service, resolveActor, requestIds })` 返回与框架无关的 Request/Response handler。主会话将路径参数注入并组合 `/api/v1` 路由，同时配置会话 Cookie、Origin/CSRF 校验及速率限制。请求不得提供 actor、userId 或权限。HTTP 响应带 requestId、`Cache-Control: no-store`、中文稳定错误；输入不支持的字段、异常引用与过大 JSON 会被拒绝。

| 操作 | 建议路由与请求 |
| --- | --- |
| 已审核发布题组 | `GET /assessment-question-sets`；根层包装为 `{items}` |
| 恢复本人测评 | `GET /projects/:projectId/assessment-attempts`；根层包装为 `{items}` |
| 新建本人测评 | `POST /projects/:projectId/assessment-attempts` `{questionSetId}` |
| 保存草稿 | `PATCH /assessment-attempts/:attemptId/answers` `{expectedRevision, profile?, answers?, followUpAnswers?}` |
| 增加已审范围内追问 | `POST /assessment-attempts/:attemptId/follow-ups` `{expectedRevision, questionId, criterionId}` |
| 取消未提交测评 | `POST /assessment-attempts/:attemptId/cancel` `{expectedRevision}` |
| 提交/重试 | `POST /assessment-attempts/:attemptId/submit` `{expectedRevision}`，请求头 `Idempotency-Key` |
| 申请重评 | `POST /assessment-attempts/:attemptId/reassess` `{expectedRevision, correctionReason}`，请求头 `Idempotency-Key` |
| 本人完整报告 | `GET /assessment-attempts/:attemptId/report` |
| 查询评分任务 | `GET /assessment-scoring-jobs/:jobId` |
| 选择共享 | `PATCH /assessment-attempts/:attemptId/sharing` `{expectedRevision, selection:{confirmedTasks, criterionIds}}` |
| 队伍最小摘要 | `GET /projects/:projectId/assessment-summaries` |
| 手动分工草案 | `POST /projects/:projectId/assignment-versions` `{baseVersionId:null或当前生效ID,draft:{assignments,gaps,assumptions}}` |
| 草案修改 | `PATCH /assignment-versions/:assignmentId` `{expectedRevision,draft}` |
| 草案校验 | `POST /assignment-versions/:assignmentId/validate` `{expectedRevision}` |
| 确认应用 | `POST /assignment-versions/:assignmentId/apply` `{expectedRevision}` |
| 分工读取 | `GET /assignment-versions/:assignmentId` / `GET /projects/:projectId/assignment-versions/applied` |
| 生成分工草案 | `POST /projects/:projectId/assignment-generation-jobs` `{targetDeliverables:string[]}`，请求头 `Idempotency-Key` |
| 生成任务查询 | `GET /assignment-generation-jobs/:jobId`，成功返回 `assignmentVersionId` |

模型与根 worker 可执行时，评分返回 202 和真实 `queued` 任务。`isModelAvailable("scoring"|"assignment")` 提供组合检查；没有适配器时提交返回 503，不创建幽灵队列，保存回答和手动分工仍可用。主会话 worker 在服务端调用 `processScoringJob(jobId)`；刷新或重放不会重复调用评分器。`recoverExpiredScoringJob` 将超过调用上限加 30 秒租约的任务标为失败，用户以新幂等键受限重试。不得将 worker 方法作为公开未鉴权路由。默认调用上限 20 秒、每份测评最多 3 次评分（含重评），均可配置。失败只记录脱敏类别、时长和标识；旧评分不会因重评失败被删除。

`createModelAssessmentScorer({model:JsonModelPort,promptVersion?,maxOutputTokens?})` 已实现，注入 `AssessmentService.scorer`。根 `src/server/ai.ts` transport 与结构化 Port 相同，负责网络、凭据、预算与实际使用量；本模块不自行重试。原答和提示注入文字仅进入 input 数据，不能改写 systemPrompt。返回严格校验所有固定评分项、锚点范围和本次证据 ID；版本信息来自可信 transport 与服务端提示配置，不接受模型伪造。默认输出额度 4096 tokens，根 transport 应提供同等上限或传更小额度。`provenance:"test_fixture"` 默认被拒绝，仅测试显式启用。

`PostgresScoringQueue(database)` 有界扫描真实持久队列，只返回 `{id,projectId,actorId,revision,status,createdAt}`。`createAssessmentScoringRegistration({queue,service,clock,modelTimeoutMs?})` 提供 `listQueued/execute/recover/listRecoverable`；或用 `createAssessmentScoringWorker({...same,batchSize?,concurrency?}).runOnce()`。根拥有调度和预算，必须把同一个超时值传给 AssessmentService、registration 与 AssignmentGenerationService；恢复不重新调用原模型请求。稳定预算/超时不明错误码会保留，但 provider 原始错误正文不保存。

`createModelAssignmentSuggestions({model,maxOutputTokens?})` 注入 `AssessmentService.suggestions`；模型只接收活跃成员 ID 和当前 opt-in 摘要，没有原答、私人经历或用户身份 ID。`createAssignmentGenerationService({database,assessments,projectAccess,assignmentContext,clock,ids,modelTimeoutMs?})` 持久保存生成任务，`createAssignmentGenerationRegistration(service)` 提供统一调度接口，`createAssignmentGenerationHttpHandlers({service,resolveActor,requestIds})` 提供 queue/job。队列输入、同基线并发、共享撤回、归档和成员权限在调用前后检查；草案与任务成功引用在同一 SQL 事务保存，恢复终结后的晚到结果回滚。生成成功仅得到待确认草案，不自动应用。

适配器须用实际供应商配置填入 `modelVersion` 与 `promptVersion`，把成员回答当作待评分的数据；模型生成的文字不能改变权限、版本来源或提示词控制层。

## 题库审核与发布

`createAssessmentCatalogAdministration({database,clock,ids})` 与 `createAssessmentCatalogHttpHandlers({service,resolveActor,requestIds})` 已实现。只有平台 reviewer/admin 可以管理题库，项目 manager 不替代这项权限。`seedDraft(actor)` 或后台 `POST /admin/assessment-question-sets/seed` `{}` 幂等导入默认待审种子，不覆盖已有内容。随后查看 `GET /admin/assessment-question-sets/:questionSetId`，用 `{expectedRevision,note}` 分别调用 POST `.../review` 与 `.../publish`；revision 随每个人工动作递增，动作、操作者、时间与内容指纹均同事务留档。停用使用 `.../retire`。审核不代表科学校准，不能自动把 seed 变成 reviewed。

新题面或量规必须使用新 ID。已发布正文、固定 rubric 和审核审计不可覆盖；旧发布内容缺少审核记录时拒绝补造历史。新建测评在最终保存事务内锁定题组当前发布状态，停用只阻止新建，旧测评快照不变。

增量 SQL 建议分别为 `sql/002-assessment-runtime.sql`（恢复扫描索引）、`sql/003-assessment-catalog-review.sql`（审核/审计）、`sql/004-assessment-assignment-jobs.sql`（生成队列与作者列表索引）。主会话分配实际迁移号，不覆盖已应用文件。

## 并发与通知

所有修订使用 `expectedRevision`。PostgreSQL 写入执行 CAS；项目生效指针、被替代版本与 `AssignmentApplied` outbox 在同一事务写入。两个相同基线草案只允许一个生效。原始回答不进入事件。

读取分工返回动态 `inputFreshness` 与 `staleReason`，让成员/规则/可用时间/共享范围的变化可见；它们不写回历史记录，也不把已应用任务自动改成另一份计划。

输入快照按显式契约字段构造，成员与共享摘要引用按稳定 ID 排序。比较时同时规范化数据库历史快照与当前输入，避免 JSONB 对象键顺序和适配器额外字段导致误报；真实项目、成员、可用时间和共享版本变化仍使草案失效。

`AssignmentContextPort.getSnapshot(projectId, transaction?)` 在 SQL 事务中必须锁定权威项目/成员/可用时间/规则版本，直到调用者事务提交；否则并发离队可能在校验后发生。共享摘要由模块事务内读取并锁定，应用前比较快照版本。跨模块组合契约详见 `docs/协作/交付/assessments.md` 的 NEEDS_INTERFACE。M05 消费事件时按 eventId 去重，重新检查现有计划，不静默覆盖生效计划。

内存 repository 只存在于 `testing/`，供 Node 测试使用，不能作为试用存储。测试命令：

```powershell
node --test src/modules/assessments/*.test.ts
npm run typecheck
```

模块 162 项测试及独立严格 TypeScript 检查通过。题库、队列与生成任务使用实际 PGlite PostgreSQL 验证事务、恢复和 JSONB；模型 transport、HTTP provider 响应及业务外部依赖使用明确测试 stub。另本轮根层 application/ai/ai-jobs 15 项通过；全局 typecheck 的外模块失败详见交付文档。

本模块不自行读取环境变量。根层实际组合使用 `DATABASE_URL` 与 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL` 及预算/worker 配置；请勿将值写进交付文档。远程 PostgreSQL、真实模型凭据、浏览器页面与真实队伍校准尚需主会话验证。

## 2026-10-09 U02：赛道、职责意愿与私有帮助

正式测评仍可选，独立职责记录归 M02。一个人可同时负责设计、开发、测试等任务；同一交付物只有一个主负责人，不将职责当互斥岗位。本模块通过 `AssignmentContextPort` 接收 M02/M03 当前公开事实，不直接读写它们的表。

`AssignmentContextSnapshot` 新增：

- `officialTracks`：当前 eventId、rulesVersion、confirmationRevision、catalogStatus、selectedTrackId、needsReview、官方 tracks 与 evidenceIds；官方名称/资格/评分重点/必交材料来自主办方规则版本，旧规则缺字段为未知。
- `trackSelectionRevision` 与 `memberIntentionRefs:[{membershipId,revision}]`：项目选择与共享意愿修订，包括撤回共享产生的修订。
- `confirmedRequirements:[{id,text,evidenceIds}]`：真实已确认提交要求，不把成员目标文字替换成官方规定。
- `members[].availableMinutes`：M02 已确认可用窗口对应的分钟数，未知为 null；`sharedIntention:{revision,membershipRevision,duties?,experience?,wantsAiHelp?,helpQuestion?}` 只含本人主动共享字段，缺字段不能作已授权数据。

`contextFingerprint/inputSnapshot/isSnapshotCurrent/ensureSnapshotCurrent` 已公开导出。赛道、意愿、容量、共享版本的变化在排队后、派发后保存草案、校验和确认时复核。JSONB 对象键和集合顺序不会误报。已有赛道选择或选择 revision 且 `needsReview:true` 时，须核对项目赛道后才能确认。首次没有选择、资料未知/冲突或未细分时，会保留通用准备与待核对说明，可先确认通用分工。角色建议使用当前共享字段，未测评不阻塞；正式排期仍由 M05 完成容量、循环、期限与缓冲校验，分工 `ready` 不表示时间可行。

持久分工和队列的 `inputSnapshot` 只保存共享意愿 revision/membershipRevision 和引用，不保存经历或求助正文。模型仅在实际派发时读取当前明确共享内容，并在完成时复核 revision。撤回后团队读取的历史输入快照不会恢复原正文。用户确认的正式任务及其说明是团队事实；若要修改已确认任务，另建新分工版本，不静默改写历史。

`createModelRoleHelp({model:JsonModelPort,maxOutputTokens?})` 与 `createRoleHelpService({database,assignmentContext,clock,ids,model?,modelTimeoutMs?,assertActor})` 实现少量本人意愿问答。只有三个回答字段：`experience/interests/constraints`，每条至多 2000 字、至少一条非空，不需要测评或评分。答案、模型建议只属于当前原始成员本人，项目/平台管理员都不能代读；选择建议只给 UI 初始内容，不会写 M02 意愿、共享、分工或 M05 任务。

`createRoleHelpHttpHandlers` 的路由需求：

| 操作 | 路由与输入 | 输出 |
| --- | --- | --- |
| 排队 | `POST /projects/:projectId/role-help-jobs` `{answers:{experience,interests,constraints}}`，`Idempotency-Key` 头 | 202，私有 job view |
| 查询任务 | `GET /role-help-jobs/:jobId` | 仅本人，私有 job view |
| 最近请求 | `GET /projects/:projectId/role-help/latest` | `{job:view或null}`，只读，无派发 |

job view 为 `{id,projectId,actorId,idempotencyKey,revision,status,createdAt,startedAt,finishedAt,failureCode,result,inputFreshness,staleReason}`。未知 provider/超时/恢复还带 `execution:{status:"unknown",canRetry:false,message}`；根可叠加真实通用 execution/账本状态，数据库任务仍是终态 failed。成功结果为 `{suggestions:[{taskDimension,title,deliverable,reason,firstStep}],missingInformation,limitations,modelVersion,promptVersion}`，建议维度为六种已有 TaskDimension。版本来自可信模型 transport 与固定提示，不接受模型伪造；百分比/匹配度/成功概率、未知维度、额外字段都会拒绝。服务在持久化前再次校验注入 ModelPort 的结果，不依赖前端或某个适配器已经校验。GET 不回传原始 answers/inputSnapshot，不触发 AI、不初始化任务。POST 网络结果未知时，可用 latest 的本人 `idempotencyKey` 对照原请求；不同 key 的旧记录不能冒充本次已排队。

### NEEDS_INTERFACE（由主会话组合）

1. 将 `sql/005-assessment-role-help.sql` 分配为新的根迁移；只新增 `assessments_role_help_jobs`，私有 answers/result 持久保存、CAS、输入和终态不可改。不能覆盖任何已应用迁移。
2. 在同一个 SQL executor/事务中，将 M02 当前项目/成员/availability/共享意愿与 M03 当前规则/赛道选择映射到上面的 `AssignmentContextPort`。共享内容取公共 opt-in 服务，revision 引用使用当前 membershipId；退出或撤回均变化。`availableMinutes` 来自真实确认窗口，不能从测评分或私有画像推测。
3. `assertActor(actor,sql)` 必须复核当前账号；HTTP 调用还需同事务复核请求会话。公开 API 的 Actor 只从 verified session 解析，worker 仅允许服务器保存的作者身份。在保存结果事务复核账号/原 membershipId、归档与当前输入版本，旧成员重新加入也不能复用原任务。
   HTTP POST 同源/CSRF 授权必须由根在 `authorizeMutation(request,actor)` 或 `resolveActor` 包装中执行；不能只验证登录会话就接受任意跨站写入。
4. `createRoleHelpRegistration(service)` 返回 `kind:"m04_role_help"` 及 `listQueued/listRecoverable/execute/recover`，注入根通用 AI worker 与同一个 budgeted JsonModelPort。根负责预算、usage结算、未知请求 hold、有效 execution lease 和可信 provider；公开 HTTP 不能直接调用 execute。模块不读取 credentials、不发网络请求、不自动重试，超时/未知/崩溃终结原任务，晚到结果不能写入。根仍须保守结算未知费用并阻止 hold 重放，新增 key 也不能绕过根预算。
5. 根 `facts.ts` 若有重复手写 assignment fingerprint，需改为使用公开 `contextFingerprint`；M05 当前输入和锁定版本还需纳入官方选择/意愿 refs，不将旧输入分工当成新规则下的正式安排。

示例：共享意愿 revision 1 的队伍请求分工 → 成员撤回经历并产生 revision 2 → 队列返回 `ASSIGNMENT_INPUT_CHANGED`，无草案保存；或已生效分工只读返回 `inputFreshness:"changed"`，原分工不被自动覆盖。本人意愿帮助遇 `AI_NETWORK_UNCERTAIN` → 同任务持久失败、原 key 只读返回既有失败、GET/recover/execute 均不重新派发。

新增代码经过独立 in-memory PGlite SQL 和显式测试模型/身份 provider 验证，未执行真实 DSH、真实数据库或页面贯通验收。模块不新增环境变量；根使用现有 `AI_PROVIDER`、DSH/AI transport、预算和 DATABASE_URL 配置。模型版本及预算取现有根配置，不含密钥值。

本轮模块完整测试 `node --experimental-strip-types --test (rg --files src/modules/assessments -g '*test.ts')` 为 **197 项通过**；最终 `npm run typecheck` 全局通过。测试使用独立数据库和明确模型/身份夹具，不能据此宣称真实付费服务已验收。
