# M03 赛事模块交付

范围：`src/modules/events/`；不修改共享文件、其他模块、实际迁移或依赖。

本轮增量已完成并停止修改：真实可调用 JsonModelPort 适配器、SQL 队列及 worker 入口，旧分析 jobs 直接复用。全模块 127 项测试通过；新 SQL 集成使用真实 PGlite PostgreSQL 引擎、模拟模型 transport，不等同供应商网络调用或线上多连接 PG 验收。

## NEEDS_INTERFACE

### 本轮真实 AI / Worker 接口（根会话可立即组合）

- `createEventAnalysisModelAdapter({ model, promptVersion?, maxOutputTokens?, maxInputBytes? }): AnalysisModelPort`，从模块 `index.ts` 导出。model 是结构等同根 transport 的本模块 `EventAnalysisJsonModelPort`：`readonly modelVersion:string`；`completeJSON({systemPrompt:string,input:unknown,promptVersion:string,outputExample?:unknown,maxOutputTokens?:number}, signal:AbortSignal)` → `{content:unknown,usage:{inputTokens:number,outputTokens:number}|null,requestId:string|null,modelVersion:string}`。模块不导入 `src/server/ai.ts`，不网络重试；根负责网络请求、JSON 响应上限、凭据和预算 ledger。提示把来源摘录/团队背景仅作为不可信数据；模块构造有界 schema 和证据白名单，返回领域校验通过的草案，不能自动确认。
- `new PostgresEventAnalysisQueue(database)` 实现 `listQueuedRunIds(limit)` / `listRunningRunIds(limit)`，只查询本模块持久任务表。`createEventAnalysisWorker({service,queue,batchSize?,concurrency?})` 返回 `runOnce(signal?)`。已有 `EventsService.processAnalysisRun(runId)` 原子 claim、权限重验、落盘结果；`recoverExpiredAnalysisRun(runId)` 回收超时/进程崩溃任务。worker 不无限轮询、不自动重试、不确认规则，由根定时或统一 worker 驱动。
- `EventsService.listQueuedAnalysisRuns(limit=10)` / `listRunningAnalysisRuns(limit=10)` 及 `PostgresEventAnalysisQueue` 同名方法现在均公开可用，返回 `{id,projectId,actorId,revision,status,createdAt}`（createdAt=原 queuedAt），不返回背景/报告；每批 1..50。根中央 ledger 可以按 runId+revision 记账后调用 `processAnalysisRun`，记录 WORKER/NETWORK_UNKNOWN，避免自动 replay。本模块明确保留 `NETWORK_UNKNOWN` failed code，`retryAnalysis` 拒绝此类同 run 重试；需要用户清楚发起新的请求/幂等键，根 ledger 再核对先前请求结果。
- 已与实际根 `AiProviderError` 结构核对：`externalState=unknown`、AI_NETWORK_UNCERTAIN/AI_TIMEOUT_UNCERTAIN/AI_CANCELLED_UNCERTAIN/AI_PROVIDER_UNCERTAIN 归为 NETWORK_UNKNOWN。AI 预算、授权、余额、限流、截断/JSON错误保留明确失败 code，不能因为异常被统称 MODEL_FAILED 就误导同 run 重试。根 `projectWriteAccess` 返回 PROJECT_READ_ONLY 时，queued job 直接 failed 且不调用模型；运行中归档则丢弃晚报告并终结 job，不永久 queued。
- 已有用户 HTTP 工厂无需新迁移：`queueAnalysis(request,projectId)` → `POST /api/v1/projects/{id}/event-analyses`（202）；`analysis(request,projectId,analysisId)` → `GET .../event-analyses/{analysisId}`；`run(request,projectId,runId)` → `GET .../event-analysis-runs/{runId}`；`retryRun`/`cancelRun` → `POST .../event-analysis-runs/{runId}/retry` 或 `/cancel`；`confirm` 保持项目管理员明确 POST。worker 不应挂到普通用户匿名 HTTP，根使用内部调度/独立 worker 授权。
- SQL：沿用已应用的 `m03_analysis_runs` / `m03_event_analyses`，没有新状态表；新增队列索引建议将单独放在 `src/modules/events/migrations/002-analysis-worker-indexes.sql`，主会话以新的实际迁移整合，不能重写已应用迁移。

- M02 / 主会话：注入共享 `ProjectAccessPort.getMembership(projectId,userId)` 作私人读取校验。变更使用本模块 `ProjectWriteAccessPort.getMembershipForUpdate(executor,projectId,userId)`：在同一个 PostgreSQL 事务中锁定项目及该成员关系，返回活跃 membership（manager 才可关联/确认）；M02 的退出/移除/降级也需要同一个项目锁。缺少该适配时写操作明确拒绝，不降低权限保证。
- M02：`ProjectRuleConfirmation` 生效指针由 M03 保存，`getProjectRules(actor,projectId)` 提供确认快照；Project 若需要展示 eventId/rulesVersion，应读取此指针，不能另外维护可独立修改的规则版本。关联前 expectedRevision 是 M03 项目规则指针修订号，初次为 0；不把它当 Project.revision。
- M02：可注入 `ProjectBackgroundVersionPort.getCurrentBackgroundVersion(projectId)` 返回当前队伍背景 revision 或 null。`getAnalysis` 返回 current/outdated/unknown 的 backgroundFreshness；已知背景更新时拒绝直接确认旧分析。未接入不伪称背景最新；背景内容来自 manager 显式输入，不读个人原始测评。
- M08：`createCandidate(actor,rules,expectedRevision)` / `requestReview` / `publishCandidate` 是运营内容边界，actor 必须来自已验证会话且 platformRoles 包含 reviewer/admin；候选 JSON 经过 M03 校验，公开发布再检查证据。`EventSource.sourceConfigId` 仅引用 M08 配置；来源白名单/SSRF/采集隔离仍归 M08。
- M04/M05/M06：读取 `getProjectRules(actor,projectId)` 返回 `{confirmation,rules}`。阶段保留原文/IANA timezone/UTC/日期精度/证据，材料使用稳定 requirementId。`getAnalysis` 同时返回报告使用的历史 `rules`，方便旧报告回查原始依据。`ProjectRequirementsConfirmed` / `EventRulesChanged` 写入事务性 outbox（含 rulesEventId/rulesVersion），消费者按事件 ID 幂等；M03 不改写 M05 生效计划或 M06 提交状态。
- 主会话：组合 HTTP handler 工厂、M01 session resolver、真实 DatabasePort、模块 SQL 建议迁移和受控分析 worker；模型通过 `AnalysisModelPort` 注入，未接入时仍可人工录入分析草案。

接口示例：项目 manager 确认 event-1 version=2，expectedRevision=1 → M03 指针 revision=2 并记录事件；公开 event-1 version=3 发布后，项目指针仍为 version=2，`getProjectChanges` 返回差异，必须再次确认。

## 已完成

- `index.ts` 公共服务导出；`components.tsx` 独立 React 入口，不妨碍 Node 直接加载服务入口；README 包含组合方式与边界。
- 单次来源快照、RuleEvidence、结构化事实/未知/冲突、资格/费用/团队规模/AI 条款、多阶段时间和材料稳定 ID；版本输入与发布校验。
- 已公开规则查询、文本/形式/地域/新人资格已注明状态/阶段筛选与游标分页；待审核候选不替代原公开版本。初次发布、退回、审核、撤下有服务端权限，撤下内容不能被创建草稿绕过审核重新曝光。
- 项目规则生效指针、活跃 manager 确认、乐观锁、精确规则版本 outbox、旧版回查与变更差异；不改写任何计划或交付成功事实。
- 人工分析草案、AI Port 与持久任务（queued/running/succeeded/failed/cancelled）、输入摘要/哈希/模型与提示版本、作用域幂等键、超时/有限显式重试/取消/崩溃恢复；管理员撤权前后重新检查，晚结果不能覆盖当前状态。
- 实际 AI 适配 factory 与有界 schema/输入预算、源文本提示隔离、真实证据/背景/材料 ID 白名单、实际返回 modelVersion/providerRequestId/usage；根 transport 只调用一次，不在模块做网络重试或自动确认。`PostgresEventAnalysisQueue` 和 `createEventAnalysisWorker.runOnce` 已实现查询与处理，不只是 Port 声明。
- 分析证据/背景/材料引用校验，事实、建议、未知分段；保留每个未核验关键问题，AI 未说明不得当作允许；确认新草案后旧报告 superseded。
- PostgreSQL DatabasePort 适配、参数化 SQL、事务/CAS、模块内迁移建议；HTTP handler 工厂（统一响应与错误、JSON 限制、可信 session 注入）及无演示数据的只读规则面板。
- 登录用户纠错记录独立于公开事实和证据，提交后返回编号/状态与 outbox；尚不提供 M08 审核处理或用户查询进展页面。

## 已验证（本地）

- `node --test src/modules/events/*.test.ts`：本轮最终 127/127 通过（领域/日期 21、分析 28、服务 26、handler 4、SQL 单元 3、AI adapter 21、worker 19、AI/SQL 集成 5）。
- 覆盖权限撤销、跨项目 ID、版本并发、幂等键内容冲突、旧公开版/已确认快照/旧分析依据、背景过期、错证据/未知 AI、必交清单、超时重试、取消和崩溃恢复、回滚及 SQL 参数化；日期覆盖跨午夜、夏令时无效时刻、时区/offset不一致、非法日历日期、中文/英文仅日期和模糊截止、ISO T/Z与offset、无来源精确日期拒绝。
- `node --input-type=module -e "await import('./src/modules/events/index.ts')"`：公共服务入口直接加载成功。
- 模块独立 TypeScript 检查（对本模块所有 .ts/.tsx 使用与根配置一致的 strict / ES2022 / bundler / allowImportingTsExtensions / react-jsx / DOM 参数）：通过。
- `npm run typecheck`：本轮最终未报告赛事错误；当前全局失败来自 `src/modules/github/tests/authorization-vault.test.ts:65` keyring 类型、`src/modules/github/tests/repository-creation.test.ts:65` 缺 revokeToken 和 `src/modules/operations/deepseek-harness.ts:361` ProcessEnv 缺 NODE_ENV，未越界修复。
- 公共 AI adapter / worker / PostgreSQL queue 导出直接通过 Node 加载检查。worker 测试执行实际 PGlite SQL 选队列；5 项集成执行 001+002 建表/索引建议、真实 JSONB 任务/结果/审计落盘，覆盖生成后仍 draft、坏证据不确认、双 worker 单次调用、NETWORK_UNKNOWN 不重放、过期恢复拒绝晚结果及人工确认后续路径。
- 只读独立代码审查：没有发现可直接触发的高价值问题；核对公开指针隔离、事务锁顺序、晚结果修订保护、参数化 SQL 与迁移建议的延迟 FK。

## 模拟测试与未接入

- 服务测试使用 `testing/memory-repository.ts` 和注入模型 mock；内存库只用于测试，不从生产入口导出，不作为真实试用唯一存储。
- SQL 单元使用 recording DatabasePort；新增 SQL 集成使用真实 PGlite PostgreSQL 引擎，执行迁移/索引、事务和 JSONB 持久化。PGlite 是串行单连接验证，不能代表线上多连接 PostgreSQL 并发验收。
- 本模块未修改根连接池、已应用迁移、认证、M02 权限、M08 来源审核、根 AI transport/预算 ledger、主 worker 调度、根 HTTP 路由和全站视觉。它们的挂载和真实网络调用验收由主会话负责，按当前实际配置记录成功，而不是由模块测试推断。纠错审核进度页面尚未扩展。
- HTTP/服务有独立人工路径；AI/来源测试数据显式为 fixture，不冒充真实赛事或供应商调用。分析校验保证结构和引用归属，不能完全证明任意自由文本的语义，最终建议仍需管理员复核。
- 来源是否过期由 M08/人工核验状态传入；没有擅自确定自动过期阈值。撤下是首版终态，恢复审核另行扩展。规则全文不保存，当前短证据与历史版本的保留/删除期限由主会话确定。

## 环境变量名称

本模块不直接读取环境变量；按现行根配置沿用 `DATABASE_URL`、`AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`、`AI_TIMEOUT_MS`、`AI_MAX_INPUT_BYTES`、`AI_MAX_OUTPUT_TOKENS`、`AI_TOKEN_PARAMETER`、`AI_WORKER_POLL_MS`、`AI_WORKER_LEASE_MS`、`AI_MAX_HTTP_ATTEMPTS`、`AI_DAILY_PROJECT_CALL_LIMIT` 与相应预算/单价名称（仅名称，无值）。没有新增依赖、安装操作、改动实际迁移、git 批量操作或外部发布。
