# M04 测评与分工交付

日期：2026-10-08。范围：`src/modules/assessments/`。状态：本轮补全已完成、验证并停止修改，可由主会话继续集成。

## 本轮根层组合契约（优先集成）

- 已保存 `createModelAssessmentScorer({model:JsonModelPort,promptVersion?,maxOutputTokens?})`，返回 `AssessmentScorerPort`，由 `new AssessmentService({...scorer})` 注入。JsonModelPort 与根层统一 `completeJSON({systemPrompt,input,promptVersion,outputExample?,maxOutputTokens?},signal)` 结构相同，无 server 私有导入；根层处理凭据、预算和使用量。本模块不网络重试。
- `AssessmentService.isModelAvailable(kind?:"scoring"|"assignment")` 可供根层组合检查。新评分/生成提交在模块内检查对应模型适配器，无模型返回 503 且不新建 queued；测试 scorer 默认禁止。根层同时检查 worker 已配置可执行，不能仅存在适配器就返回不会被处理的 202。无模型时仍可保存回答、查看历史和手动分工。默认 adapter 输出上限 4096 tokens，根 transport 的输出额度须至少相同，或向 adapter 显式传更小预算。
- 已保存 `AssessmentService.listOwnAttempts(actor,projectId)` 与 HTTP `handlers.listAttempts`：`GET /api/v1/projects/:projectId/assessment-attempts`，只返回当前本人项目成员关系的测评元信息，包含 ID/版本/状态/activeJobId/sharing，不含答案、经历或评分理由。根层列表响应包装为 `{data:{items},requestId}`。
- 评分路由已有 handler：`POST /api/v1/assessment-attempts/:attemptId/submit` `{expectedRevision}`，`POST .../:attemptId/reassess` `{expectedRevision,correctionReason}`，二者必须 `Idempotency-Key`，响应 202/真实 ScoringJob；根层当前已组合 `GET /api/v1/assessment-scoring-jobs/:jobId` 查询本人任务，`GET .../:attemptId/report` 查询本人报告，verified session / Origin / 限流由根层负责。
- 已保存并公开导出 `PostgresScoringQueue(database)` 与 `createAssessmentScoringRegistration({queue,service,clock,modelTimeoutMs?})`，返回 `{kind:"assessment_scoring",listQueued(limit),execute(jobId),recover(jobId),listRecoverable(limit)}`。队列只读取 `{id,projectId,actorId,revision,status,createdAt}`，不扫描答案；service CAS claim 唯一模型调用。根层的 worker 注册该 registration，恢复只关闭超期 running，不盲目重新调用模型。`modelTimeoutMs` 须与 AssessmentService 相同，租约额外 30 秒；可选 `createAssessmentScoringWorker({...same,batchSize?,concurrency?}).runOnce()`。
- 根层需将同一个 `modelTimeoutMs:config.ai?.timeoutMs` 传给 AssessmentService 与 AssignmentGenerationService（以及使用独立评分 registration 时的配置）。若 AssessmentService 不传则其实际评分/分工模型调用上限仍为默认 20 秒，而生成恢复配置可能使用根 transport 的 30 秒；保持一致可避免配置和实际超时体验不一致。
- 已保存并公开导出 `createAssessmentCatalogAdministration({database,clock,ids})` 与 `createAssessmentCatalogHttpHandlers({service,resolveActor,requestIds})`。审核/发布 actor 必须为平台 reviewer/admin，项目 manager 不替代题库权限。默认种子保持 draft，真实审核操作记录操作者、时间与说明后才可 reviewed→published；已发布题面/量规保持固定，新修订采用新 ID。
- 题库根层已组合路由：`GET /api/v1/assessment-question-sets` → `listPublished`（已登录可读，仅 published，列表包装为 `{data:{items},requestId}`）；后台 `GET /api/v1/admin/assessment-question-sets` → `reviewQueue`，`GET .../:questionSetId` → `details`，`POST .../seed` → `seedDraft`（`{}` 用默认待审种子，或 `{questionSet,rubric}`）；`POST .../:questionSetId/review|publish|retire` → 同名 handler，body `{expectedRevision,note}`。新增 SQL 建议在 `sql/003-assessment-catalog-review.sql`，根层已复制到递增迁移，不覆盖已应用 001。
- 已保存并公开导出持久 AI 分工生成：`createModelAssignmentSuggestions({model,maxOutputTokens?})` 注入 AssessmentService 的 `suggestions`；`createAssignmentGenerationService({database,assessments,projectAccess,assignmentContext,clock,ids,modelTimeoutMs?})`；`createAssignmentGenerationRegistration(service)` 返回 kind:"assignment_suggestion" 与统一 listQueued/execute/recover/listRecoverable。新表 SQL 建议为 `sql/004-assessment-assignment-jobs.sql`。`createAssignmentGenerationHttpHandlers({service,resolveActor,requestIds})` 的 `queue` 已由根层组合 `POST /api/v1/projects/:projectId/assignment-generation-jobs` `{targetDeliverables:string[]}` + Idempotency-Key，返回 202；`job` 组合 `GET /api/v1/assignment-generation-jobs/:jobId`。只返回元信息，成功得到 assignmentVersionId，仍须编辑/校验/明确应用。排队输入在模型前检查、模型后再次检查；草案保存和 job成功引用同事务，超期收尾后的晚到草案回滚；20 项真实 PGlite 回归通过。

未经科学校准的百分比已从 `DimensionResult` 移除，报告仅含固定量规整数分项、加权点数与未评分项。不存在能力百分比或全队排名。

## 已完成

- 固定题组与量规快照、本人草稿、有限的确定性追问、提交和持久评分任务。
- 服务端作者/活跃项目成员校验；管理员和运营角色不绕过私人答案隔离。
- 幂等提交、有限重试、模型超时、失败恢复、评分结构和证据引用校验、重评追加记录。
- 默认不共享；本人按任务/评分项选择共享，团队摘要不返回原答、经历、证据文字或模型理由。摘要同时携带公开量规项名称/维度/满分、得分含义及模型/测试来源标识。
- 未测评成员手动分工、草稿编辑、依赖校验、差异、ready 校验、管理员应用、并发基线检查与事务事件；读取时显示动态 `inputFreshness/staleReason`，不覆盖历史事实。
- 框架无关 HTTP handler 工厂、PostgreSQL 适配和本模块 SQL 建议。
- 验收修复：以受控当前快照的 `stage/readOnly` 拒绝归档/只读项目的全部人工写入与 worker 新评分发布，保留历史读取；阶段变化纳入分工输入指纹，空项目历史查询不写入 head。
- JSONB 集成修复：分工快照只保留显式契约字段，成员与共享摘要引用按稳定 ID 排序，并对历史快照和当前输入分别规范化后比较。数据库对象键重排、集合顺序变化及额外适配字段不会触发虚假的 `ASSIGNMENT_INPUT_CHANGED`；真实版本、成员、权限、状态和可用时间变化仍返回 409。
- 真实模型 transport 的评分/分工领域适配；固定提示、严格输出与证据校验、可信版本、稳定预算/不明超时错误码，无模块网络重试。
- 评分有界队列扫描、持久恢复与统一 worker registration；AI 分工新增持久队列、幂等输入、同事务结果指针与晚到结果回滚，不自动应用。
- 题组待审种子导入、平台题库审核/发布/停用、CAS 与不可变审计，公开已发布列表及本人测评恢复列表；导入不虚构审核或科学校准。
- 移除未经科学校准的 percentage/匹配度输出，只保留固定行为锚点整数分与含义明确的加权点数。

## 已验证 / 模拟测试

最终合并测试 **162/162 通过**：评分/题库规则 13 项、分工快照 20 项、服务业务 36 项、SQL 契约 16 项、HTTP 5 项、模型评分适配 22 项、评分 HTTP 贯通 10 项、评分 worker 9 项、题库审核 11 项、持久分工生成 20 项。命令：

```powershell
node --test src/modules/assessments/*.test.ts
```

重点覆盖：管理员/运营角色不可读取他人答案、同队未入项目拒绝、草稿修订冲突、固定题组快照、追问限制、幂等与重复 worker、评分越界/假证据拒绝、超时/晚到结果不发布、评分中离队不发布、重评保留历史、共享默认关闭与撤回、分工输入变更失效、两个草案仅一个生效、事务 outbox 回滚、单连接池下不嵌套借连接。

新增归档/只读检查覆盖两种状态下的 12 个写接口拒绝、历史读取不变、外部权限查询后归档的竞争、排队任务零模型调用、运行中重评拒绝发布并保留旧评分、生成中归档拒绝晚到分工草案，以及无分工历史查询不插入 head。人工拒绝操作的持久数据保持原样。

新增 20 项分工快照测试使用 PGlite 嵌入式 PostgreSQL 执行真实 `SELECT $1::jsonb` 往返，并断言成员和摘要引用的对象键确实发生重排。测试覆盖集合逆序、额外 M02 字段和旧快照的可选 readOnly；项目/成员/可用时间字段及共享引用 ID、修订、增删变化仍失效。

新增题库测试实际加载 001+003 SQL，验证 seed→review→publish→createAttempt→retire、普通 manager 无平台审核权、审核 CAS、指纹绑定、禁止补造 legacy 已发布审核历史、审计失败事务回滚。审核动作来自测试 actor，仅验证业务流程，不代表真人审核首批种子。

新增 worker 测试包含磁盘 PGlite close/reopen 后仍可扫描队列、两个扫描器重放但实际 SQL CAS 仅 claim 一次、超期恢复不二次派发。分工生成实际加载 001+004 SQL，使用真实 repository/service，验证草案和 job 成功引用同事务、排队/运行中的规则和可用时间变化/共享撤回/归档/角色撤回、超时与错误输出，以及恢复后的晚到 INSERT 实际回滚。无模型时 queue 返回 503 且零任务，原回答保存和手动分工仍可使用。

模块全部 TypeScript 文件的独立严格检查通过：

```powershell
$assessmentTypeFiles = @(rg --files src/modules/assessments --glob '*.ts')
node node_modules/typescript/bin/tsc --noEmit --incremental false --target ES2022 --module esnext --moduleResolution bundler --allowImportingTsExtensions --strict --skipLibCheck $assessmentTypeFiles
```

M04 独立严格检查通过。本轮最新 `npm run typecheck -- --incremental false` 全局检查未通过，仅有外模块错误：M06 `github/tests/authorization-vault.test.ts:65` keyring 联合类型、`github/tests/repository-creation.test.ts:65` 缺少 revokeToken；M08 `operations/deepseek-harness.ts:361` 缺少 ProcessEnv.NODE_ENV。未越界修改，主会话待外模块完成后重验。

主会话已有 application、ai、ai-jobs 根层测试本轮 **15/15 通过**，包括两项本地应用流程/HTTP 权限测试，以及统一 transport、五模块队列、真实使用量账本、预算与超时不明结果不盲目重试。实际执行：

```powershell
node --test src/server/application.test.ts src/server/ai.test.ts src/server/ai-jobs.test.ts
```

模型输入/输出由明确 JsonModelPort 或 fetch stub 模拟，没有真实模型网络调用。内存 repository 和 SQL recording fixture 只用于隔离测试；PGlite 数据库流程为真实 SQL，但未验证远程 PostgreSQL 多连接并发或浏览器流程。测试来源不得作为真实模型评分或真人审核展示。

## 未接入

- 远程 PostgreSQL 多连接环境、真实供应商凭据下的模型调用、浏览器流程、真实队伍校准。根层已组合模型 transport、worker、路由和增量迁移；本次验证仍使用隔离测试依赖。
- 首批题组状态为 draft，尚需有题库职责的人审后发布；不虚构审核完成。
- 原同步 suggestAssignment 仅供服务内部/worker 使用；对外生成必须经过持久 AssignmentGenerationService，不能绕过队列或直接自动应用。
- 暂不接受 `evidenceLevel:verified`：尚无真实交付核验 Port，避免把自述当核实。`assessed` 必须来自负责人当前共享评分项。
- 本模块不直接改 M02/M03/M05 数据，不自动修改已经生效的计划。

## NEEDS_INTERFACE

### M02/M03 → M04 的当前分工输入快照

`AssignmentContextPort.getSnapshot(projectId: string, transaction?: SqlExecutor): Promise<AssignmentContextSnapshot>`，公共类型在模块 `ports.ts` / `types.ts`。

返回字段：`projectId, stage?:string, readOnly?:boolean, projectRevision, membershipRevision, requirementVersionId:string|null, members:[{membershipId,userId,role:"manager"|"member",status:"active"|"left"|"removed",memberAvailabilityVersionId:string|null}]`。`stage/readOnly` 的可选性仅兼容旧存储快照与历史测试夹具；正式 root 适配须从 M02 当前事实返回 stage，并在适用时返回 readOnly，不接受请求 JSON/模型提供的状态。

权限：调用前 M04 使用共享 `ProjectAccessPort` 校验当前项目成员；管理操作在快照中再次核对 actor 为 active manager。Port 仅供受控服务端组合，不接受客户端/模型提供的快照。不得包含年龄、原始回答、成员私有经历或新的可用时间事实。

事务要求：提供 `transaction` 时，在同一个 SQL executor 中锁定 M02 当前项目/成员/可用时间集合，以及 M03 已确认要求版本指针，直到 M04 事务结束。不能在该事务中重新向连接池借连接。M04 的权限外查在事务之外，最终授权由当前事务快照复核；本人操作采用 context→attempt→job，分工应用采用 head→context→attempts→assignment 的锁顺序。`projectRevision` 可使用 M02 项目 aggregate revision；`membershipRevision` 必须在成员加入/退出/权限变更时递增（若 M02 共用 aggregate revision，填同一 revision 可保守使旧草案失效）。`memberAvailabilityVersionId` 引用 M02 集合版本，M04 不另建窗口或容量。

行为例：草案引用 pm_2 active / mav_4；pm_2 离队或集合更新为 mav_5 后应用返回 `ASSIGNMENT_INPUT_CHANGED`，用户可编辑草案重新校验；不得静默安排已离队成员。模型生成期间摘要撤回也阻止保存旧结果。

归档行为：人工创建/修改/追问/取消/共享/提交/重评，以及分工创建/编辑/校验/应用/建议，均在同一事务最终快照拒绝 `stage:"archived"` 或 `readOnly:true`，返回 `PROJECT_READ_ONLY`（409）。历史读取保持当前项目成员/作者权限，并标记已变化的分工依据。worker 对已有 queued/running 任务允许终结执行元数据：记录失败、清 activeJobId、更新失败状态与审计事件；不增加评分、不改答案、旧评分、共享范围或分工事实，避免永远显示排队/评分中。此收尾不构成恢复项目可写。

### M04 → M05 的已确认分工

服务：`getAppliedAssignment(actor, projectId)` 返回 `{head:{projectId,versionId,revision},version:AssignmentVersionView|null}`，仅活跃项目成员。`AssignmentVersionView` 为保存的分工版本加计算字段 `inputFreshness:"current"|"changed",staleReason:string|null`，不修改已应用历史内容。M05 通过主会话注入调用，不导入 M04 私有存储。

`AssignmentApplied` 事务 outbox：`eventId,type,aggregateId,projectId,version,occurredAt,payload:{assignmentVersionId,previousAssignmentVersionId,headRevision,appliedBy}`。不携带原答。消费按 `eventId` 去重；通知已应用计划需要复核，保留现有计划，由项目管理员确认新计划。

任务字段：`clientTaskId,title,priority,ownerMembershipId,helperMembershipIds,deliverable,acceptanceCriteria,dependencyTaskIds,proposedDeadlineRef,reason,evidenceLevel`。所有成员 ID 均为 `ProjectMembership.id`，期限只为建议引用；ready/applied 不说明时间可行，不把分数换算成速度。

### 主会话 → M04 的评分器与任务运行

`AssessmentScorerPort {provenance:"model"|"test_fixture"; score({attempt,correctionReason},signal):Promise<unknown>}`。仅受控 worker 得到作者的必要私有回答；不能把该数据用于团队分工提示词。回答、URL 和模型输出都只能作为数据，不能改变提示词控制层、权限或执行动作。输出 `rubricVersionId,criterionScores,limitations,modelVersion,promptVersion`，服务校验完整量规/证据后发布，强制附上固定版本的限制与得分定义。不能由模型提供 provenance、权限或应用状态。

模块生产 factory `createModelAssessmentScorer` 只让模型返回 `rubricVersionId,criterionScores,limitations`，并将根 transport 的可信 modelVersion 和服务端 promptVersion 附加到上述 Port 输出，随后做完整领域校验。统一 JsonModelPort 在 `ports.ts`；未配置 transport 不调用外部模型。

worker 调用 `processScoringJob(jobId)` 和故障恢复 `recoverExpiredScoringJob(jobId)`；数据库任务记录已保存，主会话负责扫描 queued/running 与按需调度、预算限制。HTTP submit 返回 202，不代表评分完成。

### 主会话 → M04 的登录与 HTTP

`createAssessmentHttpHandlers({service,resolveActor,requestIds})` 中 `resolveActor(request):Promise<Actor|null>` 必须来自已验证会话。Cookie、Origin/CSRF 与全局限流由主会话组合；任何请求 JSON 的 actor/userId/role 都被拒绝。

## 环境变量名称

模块不直接访问 env。根层当前配置名称：`DATABASE_URL`、`AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`、`AI_TIMEOUT_MS`、`AI_MAX_INPUT_BYTES`、`AI_MAX_OUTPUT_TOKENS`、`AI_TOKEN_PARAMETER`、`AI_DAILY_PROJECT_CALL_LIMIT`、`AI_DAILY_PROJECT_BUDGET_MICRO_USD`、`AI_INPUT_MICRO_USD_PER_MILLION`、`AI_OUTPUT_MICRO_USD_PER_MILLION`、`AI_WORKER_POLL_MS`、`AI_WORKER_LEASE_MS`、`AI_MAX_HTTP_ATTEMPTS`。供应商价格需由根层真实配置，未配置费用保持未知而非零。此文档不含任何值，真实凭据与费用尚未验证。
