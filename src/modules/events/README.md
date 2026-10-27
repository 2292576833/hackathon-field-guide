# M03 赛事与证据分析

`index.ts` 是不依赖 Next.js/React 的服务与 DTO 入口；`components.tsx` 是 React 规则、变更和纠错面板入口。模块不自动连接数据库、采集网站、调用模型或发布赛事。

## C03 用户纠错与规则字段比较

`EventCorrectionPanel` 从 `components.tsx` 导出，props 为 `{eventId:string,currentEvent:PublicEvent,viewerId:string|null}`。`currentEvent` 必须来自正式 `GET /api/v1/events/:id` 的公开规则快照，赛事身份、规则 eventId 与 publishedVersion 必须一致且未撤下；新候选待审核不阻止读取此前正式发布的版本。公开 DSH 发现对象没有这组身份，不得用 discovery ID 代替正式赛事 ID。`viewerId` 仅用于切换账号时清空展示状态与防止错误缓存，不能授予权限；实际认证、CSRF 与公开版本校验仍由现有 M08 HTTP/service 执行。

面板复用现有统一队列，不调用旧 M03 `submitCorrection` 另存一份：`POST /api/v1/corrections`，body `{target:{kind:'event',entityId,version},field,message,evidenceUrls}`，201 返回 `{data:Correction,requestId}`；原因选择与具体说明合并为 `message`，不增加后端字段。`GET /api/v1/me/corrections?limit=100` 返回本人最近 100 条已保存记录，面板只显示对应正式赛事，包含本人此前正式版本；API 没有按 event 分页，UI 明示此数量边界。`GET /api/v1/me/corrections/:id` 为本人单条详情读取，由 `createEventCorrectionClient().getOwn(id,signal?)` 提供。全部 GET 只读取已保存数据，不启动模型或修改规则。

`correction-client.ts` 提供结构与 M08 公共接口一致的 `EventCorrectionDto`、`SubmitEventCorrectionDto`、状态文案和可注入 fetch 的 API adapter；不拥有纠错持久化表、不写 M08 私有表。本人列表按 `submittedBy` 与 event 引用防御性过滤，账号/event/正式版本变更时 UI 整体重挂载、取消旧请求。401/403 和站内登出事件清空本人记录。POST 传输失败或 5xx 时保留输入并要求先刷新本人记录核对再重试，已确认成功响应直接插入列表，避免读取刷新失败误报提交失败。状态显示真实 `received/triaging/confirmed/needs_more_info/dismissed/resolved` 与站内处理说明；`resolved` 不等同于一定修正规则，关联正式版本仅按服务返回显示。来源最多 5 个 HTTP(S) 链接，不含账号密码；无依据可以说明待核对，不标成已核验。

`RuleChangesPanel`（Rule 单数，Changes 复数）props 为 `{comparison:ProjectRuleChanges,currentRules?:EventRuleVersion|null,latestRules?:EventRuleVersion|null,timeZone?:string}`，准确 DTO 为 `{confirmation:ProjectRuleConfirmation|null,latestVersion:number|null,changes:RuleChange[],needsConfirmation:boolean,publicationUnavailable?:boolean}`，`RuleChange={path,before,after}`。根已存在 `GET /api/v1/projects/:id/rules/changes`；根客户端读取并传入，面板不自行确认规则或改变计划。新增/移除的阶段、材料及稳定 ID 赛道数组展开为逐字段旧/新对照，提供当前/最新规则可把阶段及材料 ID 显示为名称，JSON pointer 转义不破坏稳定 ID。公开版本不可用时说明保留队伍历史快照。

`EventRulesPanel` 新增 `timeZone?:string`、`localTimeLabel?:'账号时间'|'浏览器时间'|'北京时间'`，保留 `userTimeZone?:string` 兼容别名；`timeZone` 优先。未提供或无效时区明确显示“北京时间（Asia/Shanghai）”，不称“你的时间”。有效时区可按根真实来源传 `localTimeLabel`；非 Shanghai 不能标成北京时间。日期原文、原文时区及仅日期/未知精度仍保持，不补造具体截止时刻。纯显示 helpers 在 `rule-display.ts`，通过 `index.ts` 导出。

新增 Node 测试覆盖正式版本/发现ID拒绝、复用 M08 路由、本人 HTTP 隔离与登出、真实核对/待补充/确认/解决状态、原始纠错不变、稳定 ID 逐项字段差异以及时区文案。局部新增测试与 M08 纠错服务/handler 共 14 项通过；最终 planning/events 全部测试与 M08 纠错服务/handler 合计 384 项通过，全局 `npm run typecheck` 通过（2026-10-10）。fixture 为模拟 HTTP/持久化接口，不是生产数据库验收。没有真实服务、模型、邮件、GitHub、生产迁移、build 或启动；页面根组合与浏览器验收由主会话负责。无新增环境变量或迁移建议。本轮 C03 已完成并停止编辑，文件交还主会话；准确范围见 `docs/协作/交付/planning-event-completion.md`。

## U02 主办方官方赛道

`EventRuleVersion.officialTracks?: OfficialTrackCatalog` 与公共 `getOfficialTrackCatalog`、`validateOfficialTrackCatalog` 在 `official-tracks.ts`，由 `index.ts` 导出。当前不可变规则 JSONB 已能保存新增字段，无须改写旧规则或已应用迁移。旧版本没有字段时读取为 `{status:'unknown',tracks:[],evidenceIds:[]}`；不能解释为主办方没有细分赛道。

Catalog 状态为 `unknown/none/conflict/confirmed`；确认和未细分都需对应 `official_tracks` 官方人工核验证据，冲突必须保留实际相互冲突的官方证据。unknown 不允许保留假定赛道。稳定 track ID 由人工规则整理维护、跨版本复用，绝不从资源包分类或模型能力标签生成。每条包含 `{id,name,evidenceIds,eligibility:{text,evidenceIds}|null,scoringFocus:{text,evidenceIds}|null,deliverables:[{requirementId,evidenceIds}]}`，必交材料必须引用该版本正式 requirement ID。版本/来源/证据图在原规则 validator 中复核；资源名称、二手证据、不相关字段、重复身份与虚构 requirement 都拒绝。

`diffRuleVersions` 现在比较 officialTracks；新显式未知/冲突状态需相应质量标记，历史发布兼容不重写。`PostgresOfficialTrackRulesPort.getProjectTrackRules(projectId,executor)` 提供公开可注入契约：`{eventId,rulesVersion,confirmationRevision,latestPublishedRulesVersion,catalog,requirements}|null`，只读取 M03 所有的确认/规则/事件表。调用者必须先在相同事务锁 M02 项目并复核权限，Port 不建立第二份规则确认或写项目表。当前已确认 snapshot 与更新公开版本分开返回，由 M02 显示需要复核；不静默修改计划。

Node `official-tracks.test.ts` 覆盖旧未知、明确无细分、官方对应证据、虚构资源标签拒绝、冲突和稳定 ID 版本差异；M02 的隔离 SQL 测试覆盖该 Port 与赛道引用历史。没有进行采集、收费模型或实际网站数据库接入；根需组合 Port、项目路由和 M02 建议迁移。已有规则里仍缺赛道字段的比赛会真实显示待核对，不补造官方赛道。无新增环境变量。

## 持久化与组合

主会话执行 `migrations/001-events.sql` 建议迁移，注入共享 `DatabasePort` 至 `PostgresEventsRepository`，再创建 `EventsService`。JSONB 保存校验后的不可改写规则内容，独立表保存生效指针、私有分析、任务、纠错和事务性 outbox；公开列表使用 publishedVersion，待审核候选不会替代原公开版本。

```ts
import { EventsService, PostgresEventsRepository, createEventsHandlers } from './index.ts';
const service = new EventsService({
  repository: new PostgresEventsRepository(database),
  projectAccess, projectWriteAccess, clock, ids,
  // model 可省略；人工分析不依赖模型。
});
const handlers = createEventsHandlers({ service, resolveActor: verifiedSessionResolver, requestIds });
```

项目读取使用共享 `ProjectAccessPort`。写入必须注入 `ProjectWriteAccessPort.getMembershipForUpdate(executor,projectId,userId)`，在同一事务中锁定 M02 项目和当前成员关系；M02 成员撤销/降级需使用相同项目锁。没有适配时返回 503，不能回退到不受事务保护的写入。权限以活跃 ProjectMembership 为准，Team captain 不赋予项目确认权限。

M03 自己维护一条 `ProjectRuleConfirmation` 生效指针，初次 expectedRevision=0。它不是 Project.revision；M02 应读取/引用，不独立维护另一份可变规则版本。确认、分析状态与 outbox 在同一事务内写入。事件消费者按 outbox ID 去重。规则变化不会改写 M05 的任务期限。

## 运营与公共规则

运营通过可信 session Actor（reviewer/admin）调用：

1. `createCandidate(actor, rules, expectedRevision)`：新规则版本等于 candidateVersion+1，初次 revision=0。
2. `requestReview(actor, eventId, expectedRevision)`。
3. `publishCandidate(actor, eventId, expectedRevision)`：再次检查关键字段证据、精确日期依据与质量状态。

`returnToDraft` 退回审核，`archiveEvent` 撤下公开读取；项目已确认的旧规则仍可回查。首版已撤下状态为终态，不能创建候选绕过恢复审核而使旧内容重新公开。普通用户、AI 和采集 worker 不能自行公开发布。M08 保有 SourceConfig、来源白名单、SSRF 校验、采集隔离和纠错审核的职责。

每次 `EventSource` 是单次来源快照，含 sourceConfigId 引用、哈希、抓取时间和可信范围，不保存原网页全文。`RuleEvidence` 必须属于同一赛事规则版本；用户粘贴文字可以保留，但不能标成官方人工核验。事实与推断分开，关键未知必须保持未知。日期保留原文、IANA 时区、UTC 和精度；只写日期、时区未知或截止未知时不补 23:59，不生成精确倒计时。

## 分析与任务

已实现 `createEventAnalysisModelAdapter`，可直接适配根 `JsonModelPort`；模块无需访问供应商凭据或导入根代码。固定 system 提示与外部数据输入分开，来源文字、定位信息、规则标签和团队背景不能升级成指令。输出 schema 封闭字段，限制数组/字符串并使用真实 evidenceId/requirementId/backgroundKeys 白名单；服务端仍执行 `validateAnalysisContent`，不只相信模型按 schema 返回。Schema 的 `additionalProperties`、`maxItems` 与 `maxLength` 用法核对自 [JSON Schema 官方对象](https://json-schema.org/understanding-json-schema/reference/object)、[数组](https://json-schema.org/understanding-json-schema/reference/array)与[字符串](https://json-schema.org/understanding-json-schema/reference/string)说明。

```ts
import {
  createEventAnalysisModelAdapter, PostgresEventAnalysisQueue,
  createEventAnalysisWorker, EventsService, PostgresEventsRepository,
} from './index.ts';
const model = createEventAnalysisModelAdapter({ model: rootJsonModelPort });
const service = new EventsService({
  repository: new PostgresEventsRepository(database),
  projectAccess, projectWriteAccess, projectBackgroundVersion, clock, ids, model,
});
const queue = new PostgresEventAnalysisQueue(database);
const worker = createEventAnalysisWorker({ service, queue, batchSize: 10, concurrency: 2 });
await worker.runOnce(shutdownSignal);
```

根中央 ledger 可直接用 `service.listQueuedAnalysisRuns(limit)` / `listRunningAnalysisRuns(limit)` 返回 `{id,projectId,actorId,revision,status,createdAt}`，再经预算/未知请求核对后调用 `processAnalysisRun` 或 `recoverExpiredAnalysisRun`。`PostgresEventAnalysisQueue` 同时提供相同元信息和 ID 查询；均为内部 worker API，不向普通 HTTP 用户公开整个队列。不要同时启动两套绕过中央台账的自动处理循环；同实例 `runOnce` 合并重入，不同 worker 由服务事务 claim/CAS 防止重复调用。

默认输入请求上限 96KiB、输出 token 上限 4096（可配置范围分别为 1–256KiB 与 256–8192）。超过上限明确失败，不能静默截去证据或必交项。每次 generate 只调用一次 transport，传递原 AbortSignal；网络重试、供应商请求及预算属于根 transport/ledger。成功报告记录实际返回的 modelVersion、usage 和 providerRequestId；服务端将规则分析保存为 draft。

`saveManualAnalysis(actor,input,content)` 保存一份新草案；修改通过新草案留存，不覆盖已确认分析。`queueAnalysis` 保存输入版本/哈希、幂等键和 queued 任务，HTTP 返回 202。`processAnalysisRun(runId)` 是受控 worker 的服务端入口，不能暴露为公共 HTTP 路由。

模型调用在事务之外执行，使用 AbortSignal 和确定超时。成功只代表结构校验通过；引用不存在、冲突或未核验证据会失败。默认最大两次调用，仅 MODEL_FAILED/MODEL_TIMEOUT 可由用户显式重试；模块 worker 不自动重试，根 ledger 对结果未知的原请求仍需核对，不能因为恢复为 failed 就自动重放。NETWORK_UNKNOWN 单独保留，不能使用同 run 的 retry；用户须明确发起新请求/幂等键并由中央台账核对。校验失败需修正输入或人工录入。取消只停止接受本次结果，不声称已经撤销模型供应商的远端调用。`recoverExpiredAnalysisRun` 供 worker 恢复超过超时加 5 秒的运行记录，迟到结果被版本校验拒绝。

模型生成前和保存结果前重新检查管理员资格。队伍撤销管理员后，旧队列不会继续授权访问；M02 写权限返回 PROJECT_READ_ONLY 时，任务明确进入 failed，运行前不调用模型，运行中归档不保存晚报告，避免永久 queued。报告读取始终验证当前成员关系。输入背景是管理员提供的私有字符串摘要，不能公开到赛事详情。可注入 M02 的 `ProjectBackgroundVersionPort`；报告读取返回 backgroundFreshness=current/outdated/unknown，已知背景更新时不能直接确认旧分析。未接入时明确 unknown，不能声称已自动核对背景最新（见交付 NEEDS_INTERFACE）。背景更新也应沿用 M02 项目锁。

`confirmProjectRules` 可以引用有内容、同项目、同赛事版本的分析草案；管理员确认后才成为 confirmed，原分析成为 superseded。直接确认规则不强制先使用模型。`getProjectChanges` 只返回与最新公开规则的差异，不自动应用。`getAnalysis` 还返回报告所用的历史 rules 快照，公开版本更新后仍能回查原证据。

## HTTP 与视图

`createEventsHandlers` 返回公开列表/详情、项目规则/差异/确认、人工分析/模型队列/查询/重试/取消、纠错，以及候选/审核/发布/撤下 handler。主会话将方法接入 `/api/v1` 路由，注入 M01 session resolver，另行完成 CSRF/来源校验和适合试用的限频。

写入 JSON 限 128KiB、拒绝不支持字段，actor 不从 JSON 获取。错误沿用共享 DomainError 响应；未知错误不泄露堆栈或供应商返回。项目响应 no-store。只读面板以文本显示核验/冲突/未知、证据展开、各阶段原时区/本地时间、必交材料和私有建议；无模拟数据、自动倒计时或非必要动画。

## 验证

```powershell
node --test src/modules/events/*.test.ts
npm run typecheck
```

`testing/memory-repository.ts` 只供 Node 测试使用，生产入口不导出。SQL 适配测试使用记录查询的 mock，模型测试使用注入 mock；这些不能作为 PostgreSQL 迁移成功、真实赛事来源或真实模型调用的证据。

模块的模型适配与有限 worker 已实现；真实网络 transport、中央 budget/未知请求 ledger、调度/worker授权、连接池、实际迁移、官方来源人工核验、DSH、路由与 outbox 消费由主会话/相关模块组合。服务是否真实可用，以已挂载配置和真实调用记录为准，不以“已有凭据”推断成功。环境变量由根连接池/模型 transport 管理，沿用根配置名称，本模块不读取或输出值。
