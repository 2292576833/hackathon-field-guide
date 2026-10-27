# M08 · 采集审核与运营

本模块维护公开内容的来源配置、执行记录和审核事实。赛事候选、EventSource 快照、证据与不可改写发布版本归 M03；Resource 内容与个人收藏归 M09。这里没有私人项目查询或 GitHub 操作入口。

## 接入方式

公共入口为 `index.ts`。主会话注入共享 `DatabasePort`、`Clock`、`IdGenerator` 和可信会话 Actor；PostgreSQL 适配使用参数化 SQL。`sql/` 内仅是待组合的迁移建议，本模块不执行迁移、不配置连接池。

`EventReviewService` 的流程：

1. `submitManual(actor,{eventId?,content},requestId)` 在同一事务调用 M03 创建候选，再保存 M08 审核记录。`content` 使用 M03 schema，不被 M08 复制存储。
2. `getDetail` 返回候选的五类关键字段（资格、日期、费用、材料、提交方式）、与当前发布版本的逐字段差异和 `needsRefresh`。已知值必须有证据，未知值必须人工明确确认保持未知，冲突及结构错误阻止审批。
3. `approve` 要求审核记录和候选各自的预期修订号及完整核验清单。首版允许录入人审核自己，但审计标明 `selfReviewed`，以最后编辑人为准。
4. `reviseManual` 清空原审批；M03 外部修改后的草稿使用 `refreshCandidate` 显式重入审核，再次审批。已发布审核记录禁止改写。
5. `publish` 核对候选修订、哈希、schema 和当前发布版本，在同一 PostgreSQL 事务中调用 M03 发布，再写审核/审计。`withdraw` 仅撤下指定发布版本的可见性，历史快照由 M03 保留。

审核记录的 published 表示该次发布操作曾完成；当前内容可见性读取 M03/M09，不因保留历史审核成功而显示撤下内容仍上架。

`EventCandidatePublicationPort` 必须使用调用者提供的 `SqlExecutor`，锁定候选/发布指针，并再次进行精确版本校验；不能在内部独立提交或执行网络发布。M03 返回候选最后编辑人和当前发布关键字段以供差异核对，保存每次实际内容修订、证据引用关系、规则变更 outbox 以及关联项目变更提示，不能静默修改项目已确认的规则。已发布候选的后续修正须生成新的 candidateId，不能改写原审核周期。

跨模块行锁顺序统一为内容在前、审核在后：赛事先由 M03 `getCandidate` 锁住发布操作所需的内容聚合（包含候选/赛事发布指针），资源先由 M09 `readForReview` 锁住资源，再锁 M08 审核记录。按 reviewId 访问时，`getReview(id,false)` 只用于无锁定位内容 ID；取得内容锁后必须锁定重读审核记录、复核归属，并使用重读版本/审批状态校验操作。内容适配器内部如读取 M08 审核，也须保持相同顺序并使用同一事务。注册已有候选/资源直接从内容锁开始。已提交的资源发布重试可直接返回不可改写的历史审核结果，不再次发布。

资源的 `ResourceReviewService` 通过 `ResourcePublicationPort` 操作 M09 的同一批资源，M08 仅记录核验链接、费用/许可来源或明确未知、审核人与时间。`recordedBy` 为精确资源修订的最后编辑人。发布/撤下也必须在调用方事务内完成；普通采集 worker 没有发布方法。M09 已提供公开的 `createOperationsResourcePublicationAdapter` 同签名适配，主会话需注入 `readReview(tx,id)` 回调来读取同一 M08 事务的审核记录；实际数据库贯通仍待执行。创建/编辑资源草稿使用 M09 的 `ResourceService.createDraft/updateDraft/requestReview`，不在 M08 复制存储。

纠错由 `CorrectionService` 提供本人提交/查询和运营处理。`PublicCorrectionTargetPort` 只检查公开或曾公开的版本；纠错不能变成读取私人项目的通道。处理结果是站内状态，不发送邮件或外部消息。

## HTTP 组合

`createEventReviewHandlers` 返回 list/detail/submitManual/registerCandidate/revise/refresh/approve/decide/publish/withdraw。主会话将工厂函数挂载到 `/api/v1/admin/...`；动态路径 ID 由路由传入 `detail(id)(request)` 等函数。

`createOperationsHttpHandler` 可复用于其他 M08 服务。必须提供 `resolveActor` 和 `assertMutationAllowed`（站点 CSRF/会话变更检查），Actor 不读取请求 JSON。JSON 流默认上限 128 KiB，错误使用共享中文 envelope；未知异常不泄露内部响应、栈或凭据。后台响应设 `Cache-Control: no-store`。

`createResourceReviewHandlers` 覆盖资源注册核验、审批、发布和撤下；`createCorrectionHandlers` 覆盖本人纠错列表/详情/提交及后台队列/处理。不要把后台 `getForReview` 暴露为本人查询路径；服务仍会拒绝普通用户。

`createExecutionAdminHandlers` 提供来源登记/验证/改版、任务排队/状态/取消/超时回收。手动采集 HTTP 固定记录为 manual；定时调度由独立、可信的调度器调用 `RunService`。

`createWorkerExecutionHandlers` 使用独立 `resolveServiceCredential`，只有 claim/advance/fail/complete；请求 JSON 中的 Actor、凭据或 runId 不能覆盖路由和认证结果。claim 只返回最小批准来源配置和租约；后续仅返回任务状态与租约时间。Worker endpoint 的 Bearer 认证、TLS、限流及网络暴露范围由主会话部署。

```ts
const handlers = createEventReviewHandlers({
  service: eventReviewService,
  resolveActor: getVerifiedSessionActor,
  requestId: getServerRequestId,
  assertMutationAllowed: verifySessionMutation,
});
// Next.js 路由组合示意，实际 app 路由由主会话实现。
export const POST = handlers.submitManual;
```

## 采集边界

`SourceService` 只允许 admin 修改白名单、频率与状态；reviewer/admin 可读。启用前要求验证记录；修改配置会使原验证失效。

`RunService` 保存任务并提供后台控制；独立 `WorkerRunService` 使用经服务认证的 worker 身份和租约，仅能处理已批准来源、更新自身任务及提交候选引用，不具备内容发布权限。采集候选就绪与公开发布是两个事实；采集结果不写入公开内容表。服务使用 32 字节随机租约 token；普通实体 ID 由主会话注入。Worker 要按返回的 leaseExpiresAt 提前续租，心跳不延长绝对执行截止。HTTP 排队记录可信 requestId，直接服务调用未提供时使用实际 runId 关联。

公开网页获取默认最多 3 次尝试；明确的网络、限流、超时、服务不可用和获取期间 worker 丢失可退避重试，仍遵守来源最小间隔。模型请求开始后的失败终止，不自动重发用量未知的付费请求。解析/输入/结构错误停止。取消或来源停用后不能接受晚到的成功结果；后台读取屏蔽租约 token。

`fetchApprovedSource` 要求注入 `PublicDnsPort` 和 `PinnedFetchPort`：每跳重新白名单/DNS 核查；TCP 固定到批准 IP、TLS 使用原 hostname，禁止自动重定向、环境 cookie/凭据和脚本执行。仅 HTTPS、批准域名/路径、端口 443；大小、时长、内容类型和重定向次数有上限。没有退回到 unrestricted fetch 的路径。

`createNodeNetworkPorts({userAgent})` 已实现真实 OS DNS 与 Node HTTPS 请求：批准 IP 固定、TLS/SNI 与实际 peer 核对、流式大小/时间上限、严格 UTF-8；`assertRobotsAllowed` 在每次内容重定向之前检查同域 robots。每个 HTTP/DNS 调用支持 AbortSignal。部署的出站网络与操作系统权限仍由主会话配置。

## 后端执行器与持续发现

`createDeepSeekHarnessAdapter(DeepSeekHarnessConfiguration)` 启动预装的固定官方 `@deepseek-ai/dsh@0.2.1-alpha.1`，使用 stdio JSON-RPC SDK profile。每个会话只有无工具模型推理，输入/JSON输出/token/时长均有上限；子进程获得最小环境与独立临时 home，退出确认后清理。`generate(...)` 用于赛事提取/分析，`request({task:'discovery'|'navigator',prompt,input,signal})` 为发现和导航共用通道。详见 [DSH 说明](./dsh/README.md)。浏览器只调用站点后端 API。

受批准来源的组合顺序为 `createConfiguredSourceWorkerIdentity` → `WorkerRunService` → `createSourceWorker` → `createSourceQueueRunner`；模型用 `createDshSourceModel(dshAdapter)`，队列用 `createPostgresSourceRunQueue(database)`。根获授权的 `createSourceCandidateIngestion` 在同库事务复核当前 run/source/requester/lease，将真实来源证据保存为未核验 M03 候选及不可改写结果引用。不会自动发布，模型不获得数据库或 Worker 凭据。精确接线和版本常量见交付文档。

`createContinuousDiscoveryWorker` 使用 `PublicSearchPort`、DSH、受限网络及 `PostgresDiscoveryLedger`。官方 Brave 实现为 `createBraveSearchProvider`。`runOnce` 进行一轮，`loop` 按频率执行，`setPaused` 仅管理员可用；本地 AbortSignal 和持久暂停均中断请求。每轮预留搜索/模型调用和费用，日账本跨重启保留，未知用量保守占用预算；URL/内容哈希去重，只有实际证据支持的赛事才写发现卡片。工厂允许 1–5 个搜索词、每轮 1–10 个页面、至少一分钟间隔；不承诺覆盖整个互联网。

`DiscoveryCandidatePort.save` 由根负责保存为 `unverified`，不能写官方发布指针。`ledger.commitCandidate` 同时锁定当前周期和 URL，并把卡片保存、URL 记账、取消/租约复核放在一笔事务中；save 必须复用同一 `DatabasePort` 的事务上下文。根中心模型预算和超时回收由主会话负责，不自动重试已发送的模型请求。

## 验证与迁移

Node 24 可直接运行模块下的 `*.test.ts`，均使用 `node:test`。测试内存 repository、DNS、transport 与 M03/M09 Port 仅作夹具，不能用于真实试用存储。具体结果见 `docs/协作/交付/operations.md`。

SQL 建议涵盖本模块事实和审计；正式执行前主会话组合迁移、备份并确认连接池事务回滚行为。审核元数据与内容发布必须原子提交，远程发布适配不满足当前同库事务 Port；若未来跨服务，需要先实现持久意图/outbox。

新增账本和根采集桥接测试使用真实临时 PGlite 引擎执行 SQL/M03 repository，覆盖配额恢复、原子回滚与权限失效；原服务并发测试仍有受控锁夹具。已安装官方 DSH CLI 真实离线配置/初始化验证通过，测试在模型 prompt 前停止。真实来源抓取、付费搜索/模型、最终供应商账单、多连接 PostgreSQL 并发及部署权限仍需主会话验收。依赖不可用时可继续保存手工候选并审核。
