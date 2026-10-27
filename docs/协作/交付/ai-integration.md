# 根 AI 执行与 Provider 接入交付

更新：2026-10-08。负责文件为 `src/server/ai.ts`、`ai-jobs.ts`、对应测试、`navigator.ts`、`navigator.test.ts` 和 `scripts/ai-worker.mts`。根应用、路由、配置、实际迁移以及模块自己的提示词适配器由对应负责会话组合。

## 已实现

- `createOpenAICompatibleModel(options)` 发出真实、非流式的 Chat Completions HTTP 请求，支持配置 DeepSeek 或其他兼容服务的地址、模型、密钥和 token 参数。远端只允许 HTTPS，禁止 URL 中的账号、查询参数、片段和自动重定向；本机 HTTP 需要显式开启。
- `createBudgetedModel({model, ledger, ...})` 在执行上下文内先预留预算，再调用模型，随后结算用量并重新检查租约。适配器直接调用预算模型而没有执行上下文时拒绝请求，避免绕过记账。
- `PostgresAiLedger` 持久化实际请求次数、预留金额、实际或保守计费、模型/提示词版本与安全错误码。账本不保存提示词、原始测评、模型正文或密钥。
- `createAiWorker` 发现模块排队任务，用数据库 `FOR UPDATE SKIP LOCKED` 和租约领取任务，在事务外执行模块服务，并记录完成、失败或外部结果不确定。未知外部结果不自动重放。
- `createStandardAiHandlers` 支持五类模块任务：赛事分析、测评评分、分工建议、时间计划、复盘整理。只读各模块队列元数据，不直接写模块存储；实际输入过滤、输出校验、权限与人工确认仍由模块服务负责。
- 站内导航员保留个人预算 scope `navigator-user:<userId>`，不要求虚构项目 ID。选中项目时，在请求前及返回前用真实 M02 服务检查访问权限。最终同一事务按用户根、项目根、执行记录的顺序持锁，检查活动账号与尚有效的同一租约，再以 CAS 完成任务。生成期间权限被撤回或租约失效时不返回建议。
- 中断后未结算的预算预留，由导航失败收尾或 worker 定期恢复保守结算；恢复账本不会再次请求模型。迟到的真实 usage 可校正保守金额，但失效租约阻止采用迟到正文。

## 公共契约与组合

```ts
// 服务端导出；构造/请求均不把密钥放入浏览器。
createOpenAICompatibleModel(options: AiHttpOptions): JsonModelPort
createBudgetedModel({ model, ledger, maxInputBytes?, maxOutputTokens?, maxAttempts?, clock? }): JsonModelPort
withAiExecutionContext({ executionId, leaseToken, projectId, actorId }, work)
new PostgresAiLedger(database, policy)
createStandardAiHandlers({ database, events, assessments, retrospectives, assignments?, planningGeneration? })
createAiWorker({ database, ledger, handlers, workerId?, leaseMs?, batchSize?, clock? })
```

`JsonModelPort.completeJSON(request, signal)` 接收 `{systemPrompt, input, promptVersion, outputExample?, maxOutputTokens?}`，返回 `{content: unknown, usage: {inputTokens,outputTokens}|null, requestId: string|null, modelVersion}`。JSON 对象解析成功不代表业务有效，必须继续由模块校验。传入模块的输出上限应为 `min(全局上限, 模块上限)`。

| kind | 队列元数据事实源 | 执行 / 恢复入口 |
|---|---|---|
| `m03_analysis` | `m03_analysis_runs` | `events.processAnalysisRun` / `recoverExpiredAnalysisRun` |
| `m04_scoring` | `assessments_scoring_jobs` | `assessments.processScoringJob` / `recoverExpiredScoringJob` |
| `assignment_suggestion` | `assessments_assignment_jobs` | `assignments.execute` / `recover` |
| `m05_planning` | `planning_generation_jobs` | `planningGeneration.processGenerationJob` / `recoverExpiredGenerationJob` |
| `m07_retrospective` | `m07_documents(kind=generation_job)` | `retrospectives.runGeneration` / `recoverExpiredGeneration` |

M03/M04/M05/M07 的模型 adapter 由模块通过公开出口提供；根组合必须注入上面的预算模型，并注册对应 handler。M07 可注入 `ledger.generationBudget()` 检查排队容量，实际调用时仍逐次记账，排队本身不重复计费。

导航员组合需传 `ledger: aiLedger` 以立即收尾未结算预留，并传 `maxOutputTokens: min(全局上限, 1500)`。它与 M02 服务必须共享根 `DatabasePort`，利用其事务上下文复用 executor，使嵌套项目锁保持到外层提交；模型网络调用在事务外。

HTTP 调用签名为 `navigator.reply(actor, value, assertFreshSession?: (sql: SqlExecutor) => Promise<void>)`。根路由从原请求读取 session token，按 M01 公共 SHA-256 规则计算 digest，然后在回调使用传入 executor 对匹配 token、用户且未撤回、未到期的 `auth_sessions` 行 `FOR SHARE`；无行返回 401。回调在初始及最终事务中均位于活动用户根锁之后、项目锁之前。最终会话锁保持到任务完成提交，生成期间注销本次会话时拒绝返回。没有 HTTP request 的内部直接服务调用可不传该回调，但不能拿它替代 HTTP 认证。

## 配置

以下是根 `config.ts` 已登记的环境变量名称。密钥只放本机环境或部署 secrets；此文档不含真实值。

| 变量 | 用途 / 当前根默认 |
|---|---|
| `AI_BASE_URL` | 必填，与下两项一起提供；填 API 根地址，不填 `/chat/completions`，传输层会追加该路径 |
| `AI_API_KEY` | 服务端 Bearer 密钥，必填 |
| `AI_MODEL` | 当前账号支持的确切模型 ID，必填；不猜测提供商的最新模型 |
| `AI_TOKEN_PARAMETER` | `max_tokens` 默认；需要时选 `max_completion_tokens` |
| `AI_TIMEOUT_MS` | 30000，最大 120000 |
| `AI_MAX_INPUT_BYTES` | 131072，最大 2097152；限制系统提示词与 JSON 输入总字节 |
| `AI_MAX_OUTPUT_TOKENS` | 8192，最大 65536；模块可进一步缩小 |
| `AI_MAX_HTTP_ATTEMPTS` | 1，最大 3；只有明确的 HTTP 429 拒绝允许重试 |
| `AI_DAILY_PROJECT_CALL_LIMIT` | UTC 每日项目实际请求次数，默认 40；个人导航使用个人 scope |
| `AI_INPUT_MICRO_USD_PER_MILLION` | 每百万输入 token 的微美元费率，可不填，必须与输出费率同时填或同时省略 |
| `AI_OUTPUT_MICRO_USD_PER_MILLION` | 每百万输出 token 的微美元费率，可不填 |
| `AI_DAILY_PROJECT_BUDGET_MICRO_USD` | 可选金额预算；使用金额预算必须先配置输入与输出费率 |
| `AI_WORKER_POLL_MS` | 空队列轮询间隔，默认 2000，最大 60000 |
| `AI_WORKER_LEASE_MS` | 根默认 180000；应覆盖模块超时与短暂的本地收尾时间，worker 允许 1000–600000 |
| `AI_ALLOW_INSECURE_LOOPBACK` | 仅本机模式显式 `true` 时允许本机 HTTP；远端仍要求 HTTPS |

未配置费率时照常限制调用次数、输入字节和输出 token，但 `cost_configured=false`，预留及实际金额为 `NULL`，界面必须显示费用未配置，不能当作零费用。费率是运营配置，没有硬编码模型价格；计费按整数微美元向上取整。输入预算估计使用 UTF-8 字节加消息余量，不能替代提供商 tokenizer 或账单；真实 usage 超出估计时如实记账并阻止后续超预算调用。需要严格账户消费上限时应另配提供商账户限额。

## 持久化与迁移

`AI_SCHEMA_SQL` 是交给根合并迁移的 schema 来源，运行服务不自动建表。根已登记 `migrations/007_ai_execution.sql`：

- `ai_execution_jobs`：模块任务 revision 去重、领取租约、安全状态与错误。
- `ai_usage_attempts`：每次实际请求的预算预留和结算。
- `ai_budget_buckets`：每日 scope 聚合账本。
- `ai_generation_admissions`：M07 排队准入的幂等记录。

`project_id` 是预算 scope，因此不加实体 Project 外键，以支持个人导航。模块任务仍使用其真实项目 ID，所属模块维持项目及成员约束。重复注册同一 `kind + module_job_id + source_revision` 不重复执行；队列查询跳过已注册 revision，避免停滞的旧排队行阻塞后续任务。

执行状态为 `queued/running/succeeded/failed/cancelled/unknown`。`unknown` 表示不能确认外部结果，不代表成功或无需计费；HTTP 已发送后的超时、网络中断和 5xx 均保守记录未知。仅明确的 429 拒绝会在配置允许时短暂等待后重新预留再重试。运营检查后可通过模块已有重试/重新生成流程建立新任务，不能直接把未知执行行改回 queued 自动重放。

## 启动方式

连接模式：配置真实 `DATABASE_URL` 与 AI 三项必填变量，先由根迁移机制完成实际迁移，再运行：

```powershell
node --experimental-strip-types scripts/ai-worker.mts
node --experimental-strip-types scripts/ai-worker.mts --once
```

worker 使用 `getApplication()` 提供的真实模块服务；没有 AI 配置或没有组合 worker 会报安全配置错误。`--once` 只处理一个领取结果，用于运维检查；日志仅输出执行 ID、状态与安全错误码。

本机网站使用持久化 PGlite 时，应采用根应用内同实例 worker。**网站运行时不要另外启动脚本打开同一个 PGlite 数据目录。** 只有完全停掉本机网站后，才允许维护模式：

```powershell
node --experimental-strip-types scripts/ai-worker.mts --local-exclusive --once
```

脚本不会替使用者停止网站，也不会因 `--local-exclusive` 获得其他模块写权限。连接 PostgreSQL 可运行多个 worker，领取使用真实数据库锁；本次 PGlite 测试未替代线上多连接 PostgreSQL 并发验收。

## 验证与限制

验证命令：

```powershell
node --test src/server/ai.test.ts src/server/ai-jobs.test.ts src/server/navigator.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

截至本次交付，以上测试 21/21 通过，`node --check scripts/ai-worker.mts` 通过。测试使用真实临时 PGlite 和本机 HTTP mock，覆盖 JSON 请求格式、可配置 token 字段、乱码/空/截断结果拒绝、安全错误、预算、429 与未知结果区别、并发领取、过期租约、迟到 usage 校正、五类队列元数据投影、导航账号/会话/项目权限撤回和中断记账恢复。队列测试中明确标注的最小模块表是 SQL 投影测试夹具，不能当作完整业务模块集成验收。导航项目权限用真实 M02 服务创建团队与移除成员。

本次全局 typecheck 未完全通过，最后一轮仅有仍在开发的 GitHub 授权测试夹具 `permissions` 类型错误；本交付文件无错误。根需在各会话停止编辑后重新做全局检查。

尚未使用真实外部 AI 密钥做 live 请求；不能以 mock 通过宣称用户账号已接通。DSH 的进程/工具调用适配不是本 HTTP transport；主会话另行组合它的导航模型端口。模型输出仍需人工确认，不能跳过赛事审核、分工确认、计划校验或正式交付记录。

## 官方依据

请求使用 JSON mode，提供明确的 JSON 提示词并检查完整结束标记、JSON 对象及 usage；业务 schema 校验由模块负责。DeepSeek 的 Chat Completions 定义支持 `response_format`、`max_tokens` 和标准 usage 字段；部分 OpenAI 模型使用 `max_completion_tokens`，因此 token 参数可配置。[DeepSeek 官方 Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion)、[OpenAI 官方 Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)

鉴权、余额、限流和服务故障使用安全的本地状态表达，不记录提供商正文；429 与 500/503 分开处理。只对明确拒绝进行自动重试是本项目为避免重复外部消费采用的保守策略。[DeepSeek 官方错误码](https://api-docs.deepseek.com/quick_start/error_codes)
