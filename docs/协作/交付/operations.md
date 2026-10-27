# M08 采集审核与运营交付

状态：真实采集与持续发现执行器已完成并停止修改；2026-10-08。本次范围为 `src/modules/operations/`、本文件，以及主会话明确授权独占的新后端桥接 `src/server/source-ingestion.ts`。实际数据库迁移、根运行时安装、配置与部署入口由主会话负责。

## NEEDS_INTERFACE

- 主会话最新 `DiscoveryCandidatePort.save(input): Promise<{id:string,revision:number}>`：本模块持续发现流程将使用 `{canonicalUrl,title,summary,analysis:{fit:string[],risks:string[],preparation:string[],unknowns:string[]},sources:[{url,title,excerpt,fetchedAt}],discoveredAt,lastAnalyzedAt,provider:'dsh'}`。URL/证据来自实际受限抓取；模型引用须是已取得片段。主会话保存为 `verificationStatus:'unverified'` 并按 canonicalUrl 去重，自动显示发现卡片，不能写入已核实官方规则发布指针。
- DSH 已实现官方 JSON-RPC stdio 运行适配，固定官方 commit `5badb15009ae1756c3afe0ae0cef1faafc290ccc` / 包 `@deepseek-ai/dsh@0.2.1-alpha.1`；配置/工厂见 `deepseek-harness.ts`。共用调用契约 `request({task:'discovery'|'navigator',prompt,input,signal})` 返回严格 JSON、实际 token 用量与配置费率的费用估计。导航使用同一真实 DSH 通道，无文件/命令/技能或修改能力；主会话负责导航提示与公开站点上下文。适配通过固定 `process.execPath` 启动预装的官方 `lib/bin.js`，不是普通模型 HTTP 调用的改名。
- 已导出 `createContinuousDiscoveryWorker({search,model,candidates,ledger,clock,config,dns?,transport?})`，具有 `runOnce({signal?})`、`loop({signal,onCycle?})`、`status(actor)` 与 `setPaused(admin,...)`。暂停、单租约、配额预留及 URL 去重使用实际 PostgreSQL `PostgresDiscoveryLedger`；本模块仅提供迁移建议，由主会话组合新迁移。搜索实现为 `createBraveSearchProvider({apiKey,timeoutMs?,maxResponseBytes?})` 的官方 Brave Web Search 端点，DSH 提取并分析实际取得的公开证据；其他引擎可实现同一 `PublicSearchPort`。不承诺覆盖整个互联网。
- 以上工厂现已从 `index.ts` 实际导出，确切配置见 `DeepSeekHarnessConfiguration`、`ContinuousDiscoveryConfig`。真实官方 CLI `--dump-config` 与离线 `initialize` 已通过，argv `[lib/bin.js,'--profile','m08-json']` 是该固定 CLI 的正确 SDK profile 语法；已确认无工具/shell/MCP/skills。未调用付费模型。
- 受批准来源后端接线：`identities=createConfiguredSourceWorkerIdentity({workerId,serviceCredential,sourceConfigIds:()=>approvedIds})`；`ingestion=createSourceCandidateIngestion({database,clock,ids,workerId,candidates:createEventCandidateAdapter(...)})`（获本次明确授权的新根文件 `src/server/source-ingestion.ts`）；`control=new WorkerRunService({repository,clock,ids,identities,validation:ingestion.validation})`；`sourceWorker=createSourceWorker({control,serviceCredential,clock,candidates:ingestion,model:createDshSourceModel(dshAdapter),network:{...createNodeNetworkPorts({userAgent}),userAgent}})`；`executionWorker=createSourceQueueRunner({worker:sourceWorker,queue:createPostgresSourceRunQueue(database),clock})`。`executionWorker.runOnce({signal?})` 读取实际 due queued IDs并顺序执行，`loop({signal,intervalMs,onCycle?})` 为后端进程入口。排队 `adapterVersion=SOURCE_CRAWL_ADAPTER_VERSION`，分析 `schemaVersion=SOURCE_ANALYSIS_SCHEMA_VERSION`，模型/提示版本取固定 DSH identity。排队管理员的真实 `run.requestedBy` 记录为 worker 候选创建人；服务身份/高熵租约不使用网站 Actor，不传生产数据库或用户/GitHub 凭据到 DSH 子进程。
- `PostgresDiscoveryLedger.commitCandidate` 在当前租约/URL 锁事务内调用 `DiscoveryCandidatePort.save`，然后以取得锁后的时钟和 signal 复核再提交。主会话的 card save 必须复用同一个 `DatabasePort` 实例的事务上下文（现有 AsyncLocalStorage/savepoint 组合支持），不能独立连接提交。配额、卡片写入、URL 哈希记账原子完成，暂停/过期写入回滚。迁移建议增加 `sql/discovery.sql` 和 `sql/source-results.sql`，根组合为新迁移，不改已应用文件。
- 配置范围以工厂校验为准：`queries` 1–5 条、`maxResultsPerQuery` 1–20、`maxPagesPerCycle` 1–10；最低轮询与复抓间隔均为 60 秒，单轮最多 10 分钟。主会话的根配置读取上限须与这些范围一致。使用部署认可的搜索单次价格、模型费率和日调用/费用限额；预留不足时不开新一轮，崩溃或未知用量保守保留预算。费用为估计账，不等于供应商最终账单。

- M03 `EventCandidatePublicationPort`：定义见 `src/modules/operations/event-review-types.ts`。方法为 `createManualCandidate(tx,{actor,eventId?,content,requestId})`、`getCandidate(tx,candidateId)`、`reviseManualCandidate(tx,{actor,candidateId,expectedRevision,content,reason,requestId})`、`publishCandidate(tx,{actor,candidateId,expectedRevision,expectedContentHash,expectedPublishedVersion,reviewId,reviewedAt,reason,requestId})`、`withdrawEvent(tx,{actor,eventId,expectedPublishedVersion,reason,requestId})`。返回候选/发布的真实 ID、修订号、内容哈希、schema、创建人和最后编辑人、结构校验错误、五类关键字段的证据/未知/冲突与当前发布值。日期摘要必须保留时区。M03 校验真实证据归属及各修订历史；公开发布版本不可改写；已发布周期的修正新建 candidateId。
- M03 发布适配必须参加调用方 `SqlExecutor` 事务，锁定候选/发布指针并核对精确版本；不能独立提交或调用远程发布 API。`getCandidate` 须按发布操作的顺序先锁住内容聚合（候选/赛事发布指针），再由 M08 锁审核；适配器内部读取审核时也遵守内容→审核顺序。M08 校验 reviewer/admin；M03 保存规则变更通知并提示项目复核，不静默覆盖项目快照。例：候选 revision=3 被审核后内容改成 revision=4，旧审批发布必须 409；用 `refreshCandidate` 显式重进审核。
- M03 `CandidateValidationPort`：定义见 `run-domain.ts`。`validateCrawl({runId,sourceConfigId,sourceRevision,targetUrl,resultRef})` 返回实际 `inputHash/eventSourceIds/candidateRefs/unchanged`；`validateAnalysis({runId,crawlRunId,inputHash,schemaVersion,modelVersion,promptVersion,resultRef})` 返回实际结果引用与 token/费用估计。必须加载 M03 的不可改写内容，校验来源/run/候选归属和 schema，不能原样接受 worker 自报字段。这两个方法没有发布能力。
- M09 `ResourcePublicationPort`：定义见 `resource-review-types.ts`。`readForReview(tx,resourceId)` 先锁住 M09 资源行，返回精确修订/哈希、该修订最后编辑人、链接、费用/许可的已知或未知、校验错误和当前发布版本；`publishReviewed(tx,{actor,resourceId,expectedRevision,expectedContentHash,expectedPublishedVersion,reviewOperationId,reviewedBy,reviewedAt,reason,requestId})`；`withdraw(tx,{actor,resourceId,expectedRevision,expectedPublishedVersion,reviewOperationId,reason,at,requestId})`。锁/CAS/幂等操作 ID 与历史、M09 通知在同一事务完成，发布返回严格增加的版本。所有入口统一资源→M08 审核锁顺序。已有 M09 公共 `createOperationsResourcePublicationAdapter` 与此同签名；主会话组装 `readReview(tx,id)` 回调读取同一 M08 事务记录。资源草稿创建/修改/送审使用 M09 的 `ResourceService`，M08 不另存资源实体。
- M03/M09 `PublicCorrectionTargetPort.isPublicVersion(tx,{kind,entityId,version})`：确认对应公开或曾公开的版本存在，未发布候选/私人项目不属于纠错对象。已确认纠错解决必须关联同内容的新公开版本。M09 的 `ResourceCorrectionPort` 可映射到本模块 `CorrectionService.submit`。M03 当前 `EventCorrection/submitCorrection` 仍自存；主会话需协调改为委托本模块，避免纠错队列与状态成为两套事实。
- M01：网站 handler 注入 `resolveActor(request)`（可信会话 Actor）及 `assertMutationAllowed(request,actor)`（CSRF/会话变更保护）。Worker 注入独立 `WorkerIdentityPort.authenticate(serviceCredential)`，返回固定 `operations_worker`、允许的 crawl/analysis 能力及来源 ID 集合；不能把网站角色或 JSON actor 当 Worker 认证。
- 主会话：提供 DatabasePort 连接池、迁移组合、可信 requestId/实体 ID、Worker 超时回收调度与受限抓取代理。服务内部生成 32 字节随机租约 token。`PublicDnsPort.resolve(hostname,signal)` 与 `PinnedFetchPort.request` 必须保证实际 TCP IP 固定、每跳复核、无自动重定向/环境凭据/脚本。DSH 仅获得最小任务来源配置和窄候选上传能力；不传生产数据库管理凭据、GitHub token 或网站认证密钥。

## 已完成

- 来源登记、用途/条款验证、管理员启停/改版、域/路径白名单、HTTPS/端口限制、频率与健康状态。修改网络配置使旧验证失效。
- CrawlRun/AnalysisRun 持久队列契约、明确步骤、独立 worker 身份、租约/绝对超时、网络获取最多 3 次尝试、错误分类/退避、取消与超时回收、版本化输入/适配器/schema/模型/提示、哈希去重与幂等请求映射。模型请求开始后的失败按终止类别处理，不自动重发未知计费请求；根中心模型预算由主会话组合。保存 token/费用估计，未测量的成本不标为真实费用。
- 真实 Node DNS/HTTPS transport：公开地址过滤、TCP 固定批准 IP、TLS/SNI/实际 peer 核对、无自动重定向/环境凭据、流式大小/时间上限与严格 UTF-8。每个内容重定向复核 URL、DNS 和 robots；robots 404/410 允许，读取失败、认证、限流、服务错误及跨域重定向阻止抓取。
- 固定 DSH 子进程、空根无工具 profile、有界输入/输出/token/时长、实际 usage 校验、取消后确认子进程退出并清理临时 home。官方 CLI 离线握手已真实验证。
- 持续公开搜索、真实页面证据提取与 DSH 分析、未核验卡片写入契约、URL/内容哈希去重、日预算预留、持久暂停与取消。模型引用必须是实际来源片段；中文页面输入经过字节约束；周期中断不记录假完成。
- 获授权的 `src/server/source-ingestion.ts`：同一事务按 run→source→auth 顺序锁定，使用取得锁后的当前时间与请求人 active/email-verified/admin 权限，校验实际租约/来源修订。保存未核验 M03 规则、worker 候选与不可改写结果引用；保留真实排队人，日期保留原文及未知 UTC，不自动发布。store/loadAnalysis 均拒绝权限已失效的排队人，最终 receipt 插入后再次复核租约/取消，超时回滚全部 M03 写入。
- 人工赛事候选、关键字段差异、逐项核验、未知确认、冲突/证据/schema 门禁、改版后审批失效、审批/拒绝/要求修改、精确版本发布与撤下。审计保留审核哈希、schema、核验清单和自己录入/修改再审核的事实。
- ResourceReview 注册、链接/费用/许可核验、版本冲突、发布/下架幂等；资源内容和当前可见性仍归 M09。
- 集成复核后的锁反转修复：赛事/资源审核均使用无锁定位内容 ID→锁内容→锁审核并复核的顺序，审核的预期版本与状态以锁定重读为准。资源历史发布幂等重试保留；赛事已发布审核仍不可改写。
- 纠错本人提交/查询、后台队列/处理、站内结果、同版本引用校验、不可改写原文和处理历史。运营角色不自动读取私人项目。
- 四类 PostgreSQL repository及发现账本，参数化 SQL、事务审计、行锁/CAS；`sql/` 内六份待组合迁移建议。无生产内存后端。
- `index.ts` 公共导出、README、五组可挂载 HTTP 工厂（赛事审核、资源审核、纠错、来源/任务后台、独立 Worker），默认流式 JSON 上限 128 KiB、安全错误 envelope 与 no-store 响应。

## 验证

最终回归：171 / 171 项 M08 测试通过，失败/跳过均为 0。模块及获授权的根采集桥接独立严格类型检查通过；全局 `npm run typecheck` 通过，均为退出码 0。包含原 84 项人工审核、资源纠错及来源服务测试，以及新增真实 PGlite 队列→采集→M03 桥接、发现账本、网络/robots、DSH 子进程和模型请求终止回归。已安装官方 CLI 的真实离线 SDK 握手通过，没有发出模型 prompt。

新增 15 项回归覆盖资源注册与详情/审批/发布的实际交错、赛事内容更新与审批的交错、无锁定位后归属/版本变化拒绝、内容哈希/schema 复核、已发布不可改写及资源历史发布重试。资源双事务夹具具有独立行锁及等待图环检测，并验证旧资源/审核反向锁序会形成死锁；SQL spy 验证显式无锁读取与默认锁定读取均参数化。

最后的租约回归已覆盖：等待来源行锁超过初始租约时长后领取，使用取得锁后的实际时间生成租约；等待锁跨过已运行任务截止时，完成操作拒绝，不记录 review_ready/succeeded。已确认旧任务失效、DNS/IPv6 等价地址拒绝、分析复用的幂等映射、SQL 外键锁兼容与 JSONB NULL 约束修复。

新增最终提交边界回归：取消或租约到期发生在最后 `operations_discovery_urls` UPDATE 期间时，已插入的卡片和 URL 哈希/引用一起回滚。来源桥接最终 receipt INSERT 期间过期也一起回滚 M03 与结果引用。模型开始后 DSH timeout、供应商异常、未知结果、deadline 与本地 abort 均在第一次尝试终止；模型开始前 DNS/HTTP/fetch 临时失败仍可退避。

独立模块类型检查已通过：

```powershell
$operationsFiles = @(rg --files src/modules/operations | Where-Object { $_ -like '*.ts' })
node node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module nodenext --moduleResolution nodenext --allowImportingTsExtensions @operationsFiles src/server/source-ingestion.ts
```

模块行为检查：

```powershell
$operationsTests = @(rg --files src/modules/operations | Where-Object { $_ -like '*.test.ts' })
node --test @operationsTests
```

测试使用 Node 内置 node:test，覆盖服务权限、可信身份字段映射、证据门禁、并发版本冲突、事务回滚、不可改写历史、幂等与租约边界。

## 模拟测试与真实验证边界

新增发现账本和采集桥接测试使用真实临时 PGlite PostgreSQL 引擎执行 SQL：持久配额/跨日恢复、NULL 租约约束、过期时钟、卡片与 URL 原子回滚、不可改写 receipt、真实 M03 规则/候选存储与 worker 状态贯通。这个引擎只是测试夹具，不替代主会话生产连接池。原服务测试仍有 SqlExecutor spy/失败模拟、内存 repository 与受控双事务锁夹具；没有验证多连接 PostgreSQL 的真实锁等待/死锁或生产吞吐。

DSH 的 22 项隔离子进程/协议回归与 1 项已安装官方 CLI 的配置 dump/initialize 验证分开计数。真实离线测试确认无 shell、tools、MCP、skills，随后在 session/prompt 前停止，没有模型费用。DNS/网页网络、搜索供应商和模型响应在业务测试中注入夹具；没有使用真实模型/搜索密钥完成付费请求，也没有宣称来源抓取、供应商账单或部署进程隔离已真实验证。HTTP 测试验证请求字段、可信身份与错误 envelope，部署路由与浏览器由主会话验收。

## 未接入

- 后台路由、页面和真实用户贯通由主会话组合；本模块交付 handler 工厂，未改 `src/app/` 或全局样式。
- 根持久数据库迁移、连接池部署、多连接并发与备份恢复由主会话执行；本会话只在临时 PGlite 验证新增 SQL 和事务回滚。主会话已组合根新增迁移 `014_continuous_discovery.sql` / `015_source_results.sql`，应用由主会话负责。审计/纠错/receipt 的不可改写 trigger 与运行角色权限须保留。
- M03/M09 内容 Port、公开历史版本查询、规则变更站内通知待组合；成功状态只能来自实际 Port 返回和同一事务提交。
- 真实官方列表与 robots 已由主会话的安全网络探测补验，具体范围见下方官方来源接管说明。列表提取不等于详情分析、卡片发布或付费模型账单已经验证；搜索供应商、部署出站隔离、来源合法用途及实际成本仍需各自验证。真实 transport 与 DSH 子进程代码已交付，但离线协议测试不能证明部署容器隔离已生效。
- 后端 scheduler/超时回收入口、中心模型预算、过期复核告警、候选/日志保留与删除策略由主会话接线。未购买或发布外部服务。

## 环境变量

运行工厂通过配置注入，不包含凭据值。根 `loadConfig` 当前读取 `DATABASE_URL`、`DSH_API_KEY`、`DSH_MODEL`、`DSH_RUNTIME_PACKAGE_DIRECTORY`、`DSH_BASE_URL`、`DSH_TIMEOUT_MS`、`DSH_MAX_OUTPUT_TOKENS`、`DSH_MAX_INPUT_BYTES`、`DSH_INPUT_MICRO_USD_PER_MILLION`、`DSH_OUTPUT_MICRO_USD_PER_MILLION`、`DSH_DAILY_SOURCE_CALL_LIMIT`、`DSH_DAILY_SOURCE_BUDGET_MICRO_USD`、`DSH_DAILY_NAVIGATOR_CALL_LIMIT`、`DSH_DAILY_NAVIGATOR_BUDGET_MICRO_USD`；发现使用 `BRAVE_SEARCH_API_KEY`、`BRAVE_SEARCH_COST_MICRO_USD_PER_CALL`、`DISCOVERY_QUERIES_JSON` 以及各 `DISCOVERY_*` 频率/大小/每日调用和预算项。变量的部署解析由主会话维护，模块不自动读取它们。`DSH_TEST_RUNTIME_DIRECTORY` 仅为官方离线握手测试的可选安装目录。缺凭据返回明确未配置错误，不回退为模拟成功或试用内存存储。

## 接管说明

### 无搜索密钥的官方来源

`createOfficialSourceProvider({ sourceIds, userAgent, timeoutMs, maxBytes, dns?, transport? })` 实现 `PublicSearchPort`。`sourceIds` 只接受已批准且不重复的来源 ID，目前为 `ethglobal`、`lablab`。`OFFICIAL_EVENT_SOURCES` 提供稳定 ID、名称、官方列表地址及详情路径规则。每次列表检查仍占发现轮数，但不产生搜索供应商费用；后续模型调用继续受现有预算与未知费用账本约束。

2026-10-09，主会话的网络子任务经显式可信本机 CONNECT 代理取得官方列表 HTTP 200，完成公网 DNS、固定连接 IP、TLS 与 robots 校验。本会话随后只读处理保存的真实 HTML：ETHGlobal 1,855,653 字节，提取 1 条；lablab 837,060 字节，提取 3 条。当前结果如下，列表状态仅表示近期线索：

- [ETHGlobal Mumbai](https://ethglobal.com/events/mumbai)
- [AMD AI League](https://lablab.ai/ai-hackathons/amd-lablab-ai-academy-challenge)
- [AMD Developer Hackathon: ACT III](https://lablab.ai/ai-hackathons/amd-developer-hackathon-act-iii)
- [Vultr: Agent Rush Hackathon](https://lablab.ai/ai-hackathons/vultr-hackathon)

解析器只读取静态可见 anchor/标题/状态。ETHGlobal 仅采 `Upcoming` 区域且带 Hackathon/Online 类型的单场链接，排除 Featured/Past、会议与 co-working；lablab 仅采 LIVE/Register 等当前状态卡片，排除 Finished。真实页面的 h2 位于多层 div/section 内，标题查找已改成有界递归，避免日期、报名状态、人数与正文混入标题。9 项解析和安全测试通过，其中小型夹具保留真实嵌套结构；全站 HTML 仅留 `.runtime`，未加入源码夹具。

根组合将**官方列表**上限固定为 2,097,152 字节，以容纳当前 ETHGlobal 静态页；详情仍由 worker 按根配置收紧到 1 MiB，没有扩大第三方或兄弟赛事详情许可。日期/资格/奖项不从列表强推为已核验事实；本会话未发送模型、发布卡片或请求未批准的外部赛事域名。MLH 的详情链接指向不同官网，因此不自动加入允许域。

### 持续发现的模型失败防重放

自动发现复用 `operations_discovery_urls.content_hash` 记录最后已尝试或完成的页面正文。发送模型前，先在独立持久事务写入该 hash 与 `DISCOVERY_MODEL_REQUIRES_REVIEW`；成功保存卡片或成功判定非赛事后才清除此标记。传输结果未知、无用量、JSON/证据无效、卡片提交失败、取消及进程丢失均保留标记。即使模型明确未发送，也采取保守的人工恢复策略，账本不据此猜测零费用。

只要 URL 已有待处理标记，后续自动发现就不再抓取该详情或发送模型，正文变化、冷却期与本轮其他 URL 的成功也不会把它改成 `completed`。原未知 hash 和错误标记保持不变，失败不刷新 URL 的 `last_completed_at`。管理员可通过现有来源管理配置并显式建立新的采集 run 独立处理；这不会自动清除原发现记录或声称未知调用已成功。

本轮没有历史表，采用**URL 级保守暂停**，而非全历史 hash 去重：A 失败后即使正文变成 B 再回退 A，自动模型调用总数仍为一次。未带错误标记的正常 URL 可以继续分析变化内容。本轮未新增迁移或 HTTP 入口。验证包括真实临时磁盘 PGlite 关闭/重开、发送前标记后租约替换、未知/无效输出、冷却期混合结果、A→B→A 保留标记与未知费用。测试未调用真实网页、搜索或模型供应商。

发现卡片的根持久化契约为 `title ≤ 200`、`summary ≤ 1200`、来源标题 `≤ 200`、每段原文证据 `≤ 500`。worker 提示词和解析器采用相同限制；过长模型输出拒绝后保留待处理标记，不能自动重复付费。列表标题属于显示元数据，保存前可有界截取；原文证据只接受完整原样片段，不截断后冒称原模型引用。

operations 主模块及其并行子任务已停止修改文件，主会话可接管 `index.ts`、六份 SQL 建议及获授权的 `src/server/source-ingestion.ts`。本会话未执行 git add/提交/切分支/reset/clean/push，未修改共享契约、其他模块、根依赖或外部服务。
