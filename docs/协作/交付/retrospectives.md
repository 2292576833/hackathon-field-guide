# M07 复盘模块交付

日期：2026-10-08。仅修改 `src/modules/retrospectives/` 与本文。共同结论首版由活跃 ProjectMembership.manager 确认，个人内容本人确认；不使用 Team captain 扩权。服务、适配、handler和可接入组件已完成，本会话及子任务已停止修改，可由主会话接管集成。

## 已完成

- 五问人工复盘、私人/项目范围、版本冲突、人确认、经验卡、证据引用、工具使用经历、历史版本。已确认内容修改后回到草稿，改变分享范围限作者。归档项目只读，个人删除仍可用；本人离队后仍可处理不依赖撤回项目证据的个人记录。
- 每次读/历史/导出/确认/复用检查当前权限。证据、来源分享撤回或来源变更后返回安全元数据和 `needsReview:true`、隐藏正文；来源工具下架也传播到经验卡。旧私人历史不随新分享公开。更换失效来源而不提供新正文不能读出保留的撤回正文，适用于卡作者和管理员。
- 工具记录保存用途、限制、当时费用、原始链接、核验时间；外链仅为成员记录，不是审核事实。审核资源ID在关键动作复核，模型仅引用输入审核ID；拒绝链接query/fragment中的明显凭据。没有贡献排名/能力字段。
- 选择性复用保存来源ID/版本、目标项目、操作者与字段白名单；不保存源正文，不直接写目标计划。草稿固定个人可见，每次打开重新校验源权限、版本、证据与资源；不继承旧日期、资格、授权、测评、提交状态。工具verifiedAt只是历史核验时间。
- PostgreSQL适配：正文、不可覆盖版本、只含标识的审计同事务；CAS与latestRevision；个人删除级联清除历史。迁移建议含版本/身份/历史保护和生成队列索引，没有M06事实表。
- 新增可注入 `FinalFactsLockPort`：人工create/update/confirm/reuse及生成排队/结果落库在repository事务内，先锁并消费当前成员/归档/证据/审核资源快照，再锁M07记录和来源版本、执行CAS。生产SQL缺少该Port时503拒绝写入；旧无SQL测试夹具保持兼容。模型、预算和网络调用不在锁事务中。
- Handler工厂：真实会话Actor、严格正文白名单、100KB流式上限、错误envelope、私有no-store；小型Markdown/JSON导出直接返回附件，只导出允许字段，撤回正文禁止导出。
- 可选模型任务：持久化queued/running/succeeded/failed、worker CAS、超时、原子预算Port、生成前后权限/证据/输入复核。生成成功只进入review_required，需显式采用和人确认；失败保留人工内容，不自动重试。过期worker恢复钩子避免永久running。
- 新增真实transport领域适配 `createRetrospectiveModelAdapter`：按根统一JsonModelPort注入，不依赖server私有代码；固定提示把用户文本作为数据，字段白名单、known-pattern脱敏、输入证据/审核资源约束、100KB输出限制和有界tokens、AbortSignal、可信响应modelVersion；拒绝模型自报版本/附加字段/敏感文字/URL/捏造引用。测试为模拟transport，未真实供应商调用。
- 新增持久化 `PostgresRetrospectiveGenerationQueue` 与 `createRetrospectiveGenerationWorker`：公开统一调度注册/listQueued/listRunning/execute/recover、过期恢复和有界runOnce；只查询/返回任务metadata，不扫描用户正文。worker CAS拒绝并发重复模型调用，abort停止新任务并等待当前结束，失败不停止后续任务、无自动重试；root成本ledger独占实际扣费。无新增schema需求，沿用现有M07任务表和索引。
- M06只读交付汇总：三种状态独立，无记录显示“未记录”；reported显示“队员记录”。本模块不写验收/提交，不再造成功状态。当前M06字段version、requirementsVersion:string、inconclusive、evidenceRefs:string[]已对齐。
- 服务公共入口 `index.ts`、客户端入口 `client.ts`、README、行为测试与本目录SQL建议。
- `RetrospectiveEditor` 五问/明确分享/保存/确认/冲突对照、`ExperienceReusePicker` 字段选择与条件核验、`DeliverySummaryPanel` 三类事实和来源分别展示；模块CSS暖白橙红、44px按钮、键盘焦点、窄屏与减少动效。保存回调只采纳安全响应revision建立基线，不从响应正文覆盖本地编辑。

## 已验证、模拟测试

- `npm test -- retrospectives`：**111/111通过**。六组测试中PostgreSQL仓储18项、最终事实锁23项、模型适配24项、队列/worker15项、HTTP8项，另服务规则23项。SQL与transport使用模拟执行器/供应商，内存仓库只作夹具。覆盖权限/撤回/历史/跨项目/版本/并发、SQL事务回滚与参数化、个人删除、复用过滤、模型超时/预算/人工编辑/成员移除/崩溃恢复、来源工具下架传播、query/fragment凭据、三种状态和请求身份伪造。
- 最终事实锁测试先让普通Port预检查成功并冻结旧快照，再通过Promise barrier先提交离队/降权/归档/证据撤回/不可共享/资源下架，事务内锁后快照拒绝写入，正文/历史/审计不变。另验证复用两项目成员、旧新来源证据及资源锁集合、personal/project audience、同一SqlExecutor、普通Port不在最终事务里读取、SQL缺少Port拒绝写入、旧夹具兼容；模型在事务外等待，返回后撤回事实阻止生成正文与succeeded状态落库，人工内容保留。
- 新验证：模型input严格重建，不含私有Actor/项目/复盘ID、原始测评或证据正文、工具URL；已知key/Bearer/email/手机号/路径及完整/截断多行私钥块脱敏而不改人工原文或ref/version。模型版本从transport元数据，返回四字段与现有service二次校验兼容；错误/abort/伪造输出不重试且不写泄露文本。队列SQL参数化，running库存、批次上限/过期阈值、CAS双worker仅一次调用、失败继续、abort drain均验证。HTTP202实际持久job、GET真实状态、personal/project权限撤回、旧private job后续分享、expectedRevision和身份伪造均验证。
- 测试内存仓库和模拟模型仅为夹具，不能成为试用唯一存储，也不是实际外部接入成功证据。
- 后端定向严格TypeScript检查（服务公共入口及6组测试）exit0；本轮最终全局 `npm run typecheck` 未通过，剩余失败均在其他模块：M06 tests/authorization-vault.test.ts（keyring类型）、tests/repository-creation.test.ts（revokeToken mock缺失）及M08 deepseek-harness.ts（ProcessEnv缺NODE_ENV）。M07无报错，本会话未越界修改。
- 未执行实际迁移、未真实DB事务/恢复演练、未供应商模型/GitHub/平台测试、未跨模块端到端或浏览器视觉验收。

## 未接入与实施选择

- 主会话接真实连接池、会话、权限/归档/证据/资源/交付Port、最终事实锁Port、App Router与迁移；SQL中的用户/项目外键需按最终表名组合。
- 模块已交付可注册worker及持久queue；根ai.ts/ai-jobs.ts负责真实网络、执行租约、成本/usage账本、循环调度与unknown保留。主应用已开始引用model adapter；真实供应商与双连接PostgreSQL端到端验收由主会话执行。本模块不建立第二份供应商计费账本。模型与预算未配置时人工路径仍可用。
- 导出限小型文本响应；没有大附件/异步ExportJob/下载URL有效期、公开作品集或自动发布。
- 共同结论采用manager确认；复用只给本人参考草稿。M02/M05分享或应用前仍需展示具体将共享内容并重新确认当前规则、日期、容量、授权和工具条件。
- 最终写入已通过同一SqlExecutor的锁后快照决策，不依赖普通ProjectAccessPort的事务外预检查。主会话仍需实现并实测跨模块事实锁适配，让离队/降权/归档/证据撤回/资源下架与M07写入锁住相同当前事实根，才能获得真实PostgreSQL并发保证。
- schema/网址限制不证明模型语义真实，适配器需按Port要求只整理事实，用户仍要确认；字段白名单也不能证明任意自由文字已自动脱敏。

## NEEDS_INTERFACE

- AI/root对接契约（已实现）：`createRetrospectiveModelAdapter({transport:JsonModelPort,maxOutputTokens?:number}):RetrospectiveModelPort`。模块只依赖结构相同的Port，不导入 `src/server/ai.ts`。`JsonModelPort` 为 `readonly modelVersion:string; completeJSON({systemPrompt:string,input:unknown,promptVersion:string,outputExample?:unknown,maxOutputTokens?:number},signal:AbortSignal):Promise<{content:unknown,usage:{inputTokens:number,outputTokens:number}|null,requestId:string|null,modelVersion:string}>`。output只接受 `answers/evidenceRefs/resourceIds`，modelVersion取transport返回元数据，service-owned promptVersion不接受模型覆写；用户身份、原始source URL/正文、额外私有字段不进入payload。root负责真实网络、供应商配置、成本ledger和未知结果策略；M07不网络重试或自动confirm。默认maxOutputTokens3000，模块可配置512–8000且必须不高于transport上限；service modelTimeoutMs默认20000，可配置1–60000，worker必须一致。
- worker/root统一注册（已实现）：`PostgresRetrospectiveGenerationQueue(database:SqlExecutor)` 和 `createRetrospectiveGenerationWorker({service,queue,clock,modelTimeoutMs?,batchSize?})` 从index导出；worker提供 `{kind:'m07_retrospective',listQueued(limit),listRunning(limit),execute(jobId),recover(jobId)}`，jobmeta `{id,projectId,actorId,revision,status,createdAt,errorCode?}`，仅调度metadata，无正文。queue持久查询m07_documents；额外 `listExpiredRunning({updatedBefore,limit})/runOnce({signal?})` 用于过期恢复/有界单次批处理，根统一循环调度。native listRunning无过期过滤，供根租约库存发现；旧没有listRunning的queue stub回退当前时钟之前running查询。只能注册一套root执行路径，不能同时启动独立runOnce循环，避免多套任务账本。
- HTTP/root现有工厂 `createRetrospectiveHandlers({service,authenticate,requestId})`：`enqueueGeneration`（与 `generate`同一handler）挂 POST `/api/v1/retrospectives/{id}/generate`，params `{id}`，JSON仅 `{expectedRevision:number}`，202返回 `{data:GenerationJob,requestId}`。`getGenerationJob`挂GET `/api/v1/retrospective-jobs/{id}`，相同params、无body，返回 `{data:GenerationJob,requestId}`。身份来自真实session，个人job仅owner，项目job当前成员；原个人job不会因复盘后来分享自动公开。POST `/api/v1/retrospectives/{id}/confirm` payload `{expectedRevision,useGeneratedDraft?:boolean}` 仍为显式人工动作，成功生成只变review_required。
- 预算语义：enqueue只校验model/budget已配置，不调用reserve，202不代表额度预留、模型调用或实际成本。worker在模型调用之前、锁事务外执行现有 `GenerationBudgetPort.reserve({jobId,projectId,actorId,occurredAt})`，按jobId幂等，拒绝则job失败、保留人工内容。root应把该Port作为任务准入检查/幂等预留，实际请求计量和扣费由transport ledger独占，不能两处重复计费；未知供应商结果不得自动重试。
- 主会话/M02/证据/M09：`FinalFactsLockPort.lock(request:FinalFactsLockRequest, transaction:SqlExecutor):Promise<FinalFactsSnapshot>`，从模块 `index.ts` 导出。request含 `actor`、`operation`、排序去重 `projectIds/resourceIds` 和 `evidence:[{projectId,audience,refs}]`；覆盖复用源/目标、旧新来源链和人工/生成审核ID。snapshot含 `projects:[{projectId,membership:ProjectMembershipAccess|null,archived:boolean}]`、`evidence:[{projectId,audience,states:EvidenceState[]}]`、当前可用 `reviewedResourceIds:string[]`。权限：同actor的活跃成员可写，本人以外编辑及项目确认需要manager，归档禁止写；证据必须对对应audience可用。行为示例：预检查manager，但取得锁时成员已removed，返回removed/null，M07在CAS前拒绝，正文/版本/审计不变。
- 最终锁适配必须仅用提供的SqlExecutor读取新事实，按全局固定顺序锁项目成员/归档变更根、证据当前分享/撤回指针、资源发布状态根至提交；不能用缓存、普通连接池、嵌套事务、模型/网络调用或写M07表。服务在此之后按ID锁M07记录与旧新来源行。只锁不可变历史版本不足以阻止撤回；事实更新适配必须锁同一根并遵守同样顺序。缺失项目事实/不相符成员事实返回 `FINAL_FACTS_INVALID`（503）；缺失/撤回证据与未审核ID不批准。根Database的ALS连接复用可用于组合，仍以传入SqlExecutor为准。
- M02：现有 `ProjectAccessPort.getMembership(projectId,userId)`；另需 `ProjectStatePort.isArchived(projectId)`，归档禁止编辑、生成、确认、复用写入，个人导出/删除仍允许。
- M02/M03/M04/M05/M06：`EvidenceAccessPort.resolve(actor, projectId, refs, audience)`。refs 为 `{kind,id,revision}`，kind 只允许 rule/plan/task/assignment/git_save/delivery_verification/submission/project_resource；返回同一引用、projectId、state（available/withdrawn/unavailable/outdated）、projectShareable 和可选公开于该 audience 的 title。必须执行当前成员资格/撤回规则；不得返回原始测评或私人正文。示例：project audience 下私人证据返回 unavailable，而不是允许管理员读取。
- M06：`DeliveryFactsPort.read(actor,projectId)` 只读仓库保存、DeliveryVerification、SubmissionRecord 与材料清单。Git记录带revision、验收/提交带原version；requirementsVersion:string、验收outcome=inconclusive保留原意、原evidenceRefs:string[]不重新解释。M07结构化证据引用的是M06记录ID/version。SubmissionRecord沿用not_submitted/reported/verified/rejected_or_withdrawn，来源user_reported/platform_verified；页面写入直接接M06同一服务。
- M09：`ReviewedResourcePort.isReviewed(resourceId)` 当前审核可用校验；人工外部工具经历可保存为成员记录，模型推荐必须只用已审核 ID。
- M01：handler 的 `authenticate(request)` 从真实会话构造 Actor；不能使用请求正文的 userId/角色。个人记录本人离队后仍可导出/删除，项目共享记录需要当前活跃成员。
- 主会话：注入 DatabasePort/Clock/IdGenerator，组合路由与执行本模块 SQL 建议。复用返回 personal 草稿契约，M02/M05 必须重新确认目标项目规则、日期、容量、授权，不自动应用。
- 模型适配：`RetrospectiveModelPort.generate(input,AbortSignal)` 只整理有权字段、缺资料写“无法确认”，不做性格/天赋/能力/贡献评价；输出不能补URL。`GenerationBudgetPort.reserve({jobId,projectId,actorId,occurredAt})` 为worker侧按jobId幂等的原子准入；预算限额、供应商与实际扣费ledger由主会话负责。

## 所需环境变量名称

本模块不直接读取环境变量；主会话真实连接池需要 `DATABASE_URL`。根统一AI配置名称为 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`；限额/调度为 `AI_TIMEOUT_MS`、`AI_MAX_INPUT_BYTES`、`AI_MAX_OUTPUT_TOKENS`、`AI_TOKEN_PARAMETER`、`AI_DAILY_PROJECT_CALL_LIMIT`、`AI_DAILY_PROJECT_BUDGET_MICRO_USD`、`AI_INPUT_MICRO_USD_PER_MILLION`、`AI_OUTPUT_MICRO_USD_PER_MILLION`、`AI_WORKER_POLL_MS`、`AI_WORKER_LEASE_MS`、`AI_MAX_HTTP_ATTEMPTS`。模块只收injected transport/budget/clock等，不读取或返回凭据值，无采购或发布。

## 集成顺序

1. 主会话审核/执行SQL建议，按最终M01/M02表名补外键，真实测试数据库验证事务、级联删除与恢复。
2. 接M01 Actor、M02权限/归档、当前证据、M09审核ID、M06交付投影及同一事务最终事实锁；组合README列出的handler。在真实PostgreSQL双连接提交离队/降权/撤回后验证确认拒绝、无新快照与审计。
3. 人工复盘→人确认→经验卡→选择性复用先贯通；接组件后做窄屏/键盘/长中文/冲突/减少动效的实际浏览器检查。
4. 启用模型前接预算、队列worker、过期监督与真实测试供应商；不能让排队任务无人执行。
