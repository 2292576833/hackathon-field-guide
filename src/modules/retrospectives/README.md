# M07 · 复盘与经验

本模块提供人工结构化复盘、经验卡、选择性复用草稿、Markdown/JSON 导出、可选模型整理任务，以及 M06 交付事实的只读汇总。生产必须注入 `PostgresRetrospectiveRepository`；`tests/fixtures.ts` 的内存实现仅用于行为测试。

## 接入

服务入口为 `index.ts`。客户端组件从 `components.tsx` 导入（另见 `client.ts`），避免 Node 服务测试加载 TSX/CSS。

客户端导出 `RetrospectiveEditor`、`ExperienceReusePicker`、`DeliverySummaryPanel`。Editor保存回调返回 `{revision}`，可以使用安全的DocumentView；父组件应在真实保存/加载后更新已授权内容和expectedRevision。组件不会自行fetch或把权限props当服务端授权。DeliverySummaryPanel接收M06已授权的 `DeliveryFacts`。

```ts
import { RetrospectiveService, PostgresRetrospectiveRepository,
  createRetrospectiveHandlers, createRetrospectiveModelAdapter,
  PostgresRetrospectiveGenerationQueue, createRetrospectiveGenerationWorker }
  from "./src/modules/retrospectives/index.ts";

const service = new RetrospectiveService({
  repository: new PostgresRetrospectiveRepository(database),
  access: projectAccess, projects: projectState, evidence: evidenceAccess,
  resources: reviewedResources, delivery: deliveryFacts,
  finalFactsLock: finalFactLocks,
  model: createRetrospectiveModelAdapter({ transport: jsonModel }),
  generationBudget: taskAdmission,
  modelTimeoutMs: 20_000,
  clock, ids,
  // 无模型配置时省略model/generationBudget，人工路径仍可用。
});
const handlers = createRetrospectiveHandlers({
  service, authenticate: verifiedSessionActor, requestId: makeRequestId,
});
const generationWorker = createRetrospectiveGenerationWorker({
  service, queue: new PostgresRetrospectiveGenerationQueue(database), clock,
  modelTimeoutMs: 20_000,
});
// 根worker注册 generationWorker 的 kind/listQueued/listRunning/execute/recover。
// 已由根worker调度时，不要再启动另一套runOnce循环。
```

主会话负责真实连接池、会话、跨模块 Port、路由和迁移。`migrations/001_retrospectives.sql` 只是迁移建议，未执行。数据保存、版本快照与仅含标识的审计在同一事务中完成；CAS 返回 `VERSION_CONFLICT` 与最新版本。数据库表不包含运行验收或正式提交事实。

## 最终事实锁

`FinalFactsLockPort.lock(request, transaction)` 接收仓储当前事务的同一个 `SqlExecutor`，返回 `FinalFactsSnapshot`。人工复盘/经验卡创建、更新、确认、跨项目复用，以及生成排队/结果落库，在该事务内先锁当前成员资格、归档、证据可见性/撤回和资源审核事实，再复核当前记录和来源版本，最后执行 CAS、快照与审计。最终判断只消费锁后快照，不重新读普通权限或资源 Port 的缓存。

请求包含 `actor/operation/projectIds/evidence/resourceIds`。`projectIds` 包括复用来源和目标项目；`evidence` 为 `{projectId,audience,refs}`，覆盖旧、新记录及来源链所需 audience；资源包含人工工具及生成草稿审核 ID。返回 `projects:[{projectId,membership,archived}]`、`evidence:[{projectId,audience,states}]`、`reviewedResourceIds`。每个请求项目必须有唯一事实，缺失成员用 `null`；不存在/撤回证据及已下架资源不得批准。

适配器必须用传入执行器，按固定顺序锁可被成员移除、降权、归档、证据撤回/分享变更、资源下架操作更新的当前事实根，并保持到事务提交。只锁不可变证据历史版本不能阻止撤回。外部事实锁在前，M07 当前记录及旧、新来源行按 ID 排序锁在后；事务内来源版本变化直接拒绝，不临时扩大锁集合。主会话负责 M02/证据/M09 的真实锁适配，并让相关事实变更使用相同锁根和顺序。

SQL 仓储未配置 `finalFactsLock` 时关键写入返回 `FINAL_FACTS_LOCK_REQUIRED`（503），不会降级为普通预检查；配置锁 Port 但仓储不提供执行器时返回 `FINAL_FACTS_LOCK_UNAVAILABLE`。不带 SQL 的旧测试夹具保留兼容，事务入口再读当前事实，但不提供生产锁原子保证。模型/预算/网络调用在锁事务外，结果落库单独执行最终锁后复核。过期任务与失败清理只修改任务/草稿状态，不持 M07 行锁后再取外部事实锁。

## 数据与权限

- 五个回答对应目标/实际交付、阻塞与处理、有帮助的做法、删减范围、下次改变。可填写“不知道”“没有记录”“不愿分享”；工具经历另记用途、限制、当时费用、原始来源和核验时间。
- 新记录必须显式选择 `personal` 或 `project`。个人内容只对作者开放，管理员/平台角色不能越权；当前活跃项目成员可看项目内容。共同结论由活跃项目 manager 确认，个人结论本人确认。
- 每次编辑检查 `expectedRevision`，已确认内容修改后回到草稿。共享范围改变只允许作者发起。归档项目只读，个人删除/导出仍可用；本人离队后可以读取、导出、删除不依赖撤回项目证据的个人笔记。
- 证据仅记录 `{kind,id,revision}`，不存源记录正文。仅允许规则、计划、任务、共享分工、仓库保存、验收、提交、项目资源引用；原始测评与私人笔记不能成为证据类型。Evidence Port 必须校验当前权限和历史版本。
- 引用撤回或不可访问时，读取/历史响应保留安全元数据和复核提示，正文不返回；导出/确认/复用被阻止。来源复盘修改后，经验卡正文暂不可用，需重新提交已核对的全文并选择当前确认的来源版本；只换引用不能取出保留的撤回正文。旧私人历史不会因为后来分享而公开。
- M09 审核资源 ID 在保存/确认/生成/复用时复核；外部工具链接是成员记录，不成为审核事实。工具账号、令牌字段不在 schema 中，链接中的凭据和明显令牌参数被拒绝。用户自由文字仍需本人核对，schema 不可能证明任意文字没有敏感信息。

经验卡默认草稿，包含场景、建议步骤、适用条件、不适用/未知条件、证据与工具经历。确认不表示普遍有效，不产生贡献排名或能力字段。

## 选择性复用

`createReuseDraft` 输入 `sourceCardId/sourceRevision/selectedFields/acknowledgeRechecks`。字段只允许 `title/scenario/advice/conditions/limitations/tools/skillUsage`；没有技能记录的旧卡不能选择 skillUsage。目标必须是另一个当前可编辑项目。草稿固定 `personal`，只保存来源 ID、版本与选择项，不保存来源正文，不写项目计划。

`getReuseDraft` 每次复核源卡当前权限、确认状态、版本、证据与资源，再投影选定字段。源卡撤回、删除或修改后，旧草稿不能继续读取。目标成员不能自动读取作者的个人草稿。后续接入 M02/M05 的分享或应用入口必须先让用户检查将共享的具体内容，并重新确认当前规则、截止与时区、成员容量、授权、工具费用/许可。工具 `verifiedAt` 是历史核验时间，不是新项目核验通过。

## 生成任务

`enqueueGeneration` 返回已持久化的 queued job；`enqueueGeneration`/兼容名 `generate` handler 返回 202，请求只允许 `{expectedRevision:number}`。GET `getGenerationJob` 返回真实任务状态；个人job只给作者，原个人job不因为复盘后来分享变为项目可见。202只检查模型/预算配置及写入权限，不执行reserve，不意味着额度占用或外部调用完成。worker调用 `runGeneration(jobId)`，通过 job revision CAS 独占执行；调用之前检查最新成员资格、归档、输入版本、证据与资源，再在锁外执行 `generationBudget.reserve` 幂等任务准入。实际请求额度和计费由root transport ledger负责，不能重复扣费。无自动重试；重试是显式创建新的任务。模型超时默认20秒，允许配置1–60000毫秒。

模型输入只有当前复盘回答、可读证据标题、人工工具经历和审核资源ID，逐字段重建，不传actor、projectId、retrospectiveId、证据源正文、工具originalUrl或额外字段；已知凭据、多行私钥块、邮箱、手机号、链接和本机路径先脱敏，人工原文保持。引用ID不改写，ID本身含这些敏感模式时拒绝外发。此过滤不能证明任意自由文字完全匿名。输出只允许五个回答、输入证据引用及审核资源ID，modelVersion取可信transport响应元数据；URL、版本自报、额外私有字段、敏感文字和捏造引用被拒绝。输入或权限在运行中变化时结果不覆盖新人工内容。成功状态为 `review_required`，采用草稿必须由用户显式选择 `useGeneratedDraft:true` 并执行确认；原始所有输入引用持续保留，不能靠模型漏写引用逃过撤回检查。

`createRetrospectiveModelAdapter({transport:JsonModelPort,maxOutputTokens?})` 已实现真实transport适配，结构与根 `src/server/ai.ts` 的JsonModelPort一致，模块不导入根实现。固定systemPrompt把答案/证据/工具作为不可信数据，要求资料不足写无法确认、区分三类交付事实、不做成员特质/能力/贡献排名。一次completeJSON调用，共享AbortSignal；默认输出上限3000 tokens，配置范围512–8000，JSON结果上限100KB，无网络重试。usage/requestId留给根账本，不入复盘或任务错误。结构校验不证明语义真实，人工确认必需；本模块测试使用模拟transport，未供应商实调用。

`PostgresRetrospectiveGenerationQueue(database)` 持久查询m07_documents中的generation_job，只返回调度metadata；公开 `listQueued/listRunning/listExpiredRunning`。`createRetrospectiveGenerationWorker` 注册形状为 `{kind:'m07_retrospective',listQueued,listRunning,execute,recover}`，元数据 `{id,projectId,actorId,revision,status,createdAt,errorCode?}`，适配根worker租约/成本上下文；不要把这些账本身份字段送回模型input。模块也提供 `runOnce({signal?})`：先恢复过期任务，再顺序处理queued，恢复和生成总数默认10、范围1–100；单任务失败继续，CAS竞争跳过、不重试模型。abort停止新任务并等待当前调用完成。根统一调度和module runOnce只能选择一套执行路径。

`recoverExpiredGeneration(jobId)` 供监督器处理崩溃：超过模型超时再加30秒的running job标为failed，人工草稿恢复；晚到结果不能通过CAS。worker modelTimeoutMs需与service相同。超时/取消/worker过期不证明供应商没计费；根ledger负责保留unknown事实和已发送成本，不得盲目重试。

## HTTP 工厂

所有 handler 从认证回调读取 Actor，正文不能提供角色或作者。JSON body 流式限 100KB；统一 `data/error/requestId`，错误不返回栈或供应商响应，响应 `private,no-store`。

| 推荐路由（均以 `/api/v1` 开始） | handler |
| --- | --- |
| POST/GET `/projects/{projectId}/retrospectives` | createRetrospective/listRetrospectives |
| GET/PATCH `/retrospectives/{id}` | getRetrospective/updateRetrospective |
| POST `/retrospectives/{id}/confirm` | confirmRetrospective |
| POST `/retrospectives/{id}/generate` | enqueueGeneration / generate（202） |
| GET `/retrospective-jobs/{id}` | getGenerationJob |
| GET `/retrospectives/{id}/history?revision=…` | historyVersion |
| POST/GET `/projects/{projectId}/experience-cards` | createExperienceCard/listExperienceCards |
| GET/PATCH `/experience-cards/{id}` | getExperienceCard/updateExperienceCard |
| POST `/experience-cards/{id}/confirm` | confirmExperienceCard |
| POST `/projects/{projectId}/experience-reuses` | createReuseDraft |
| GET `/experience-reuses/{id}` | getReuseDraft |
| POST `/retrospectives/{id}/export` | exportDocument（json/markdown） |
| DELETE `/retrospectives/{id}` 或 `/experience-cards/{id}` | deletePersonal |
| GET `/projects/{projectId}/delivery-summary` | deliverySummary |

删除与所有变更使用 `expectedRevision`，不是客户端提供的作者身份。小型文本导出直接返回附件，当前不实现大附件/异步下载任务/外部存储链接，因此没有下载有效期或后台导出任务的虚假状态。

## M06 边界

`DeliveryFactsPort.read` 由主会话组合 M06 的已授权 `GitService.listOperations`、`DeliveryService.listVerifications/listSubmissions`。只投影仓库URL、分支、commit和操作状态，不复制文件预览或授权。验收 `outcome=passed/failed/inconclusive`、`version`、提交 `requirementsVersion:string`、`evidenceRefs:string[]` 与 M06 当前公共字段一致。M07 结构化证据引用的是这些记录 ID/version，不重新解释其字符串证据链接。M09当前 `ReviewedResourceLookupPort.getReviewedResource` 可包成 `isReviewed`（null为不可用），无需新增资源事实存储。

仓库保存、运行验收、正式提交分别展示。无记录显示“未记录”，不推断未工作或未提交；手动 `reported` 显示“队员记录”，只有 `verified/platform_verified` 可显示平台核验。概览校验来源/状态相容性并按白名单投影返回，不把保存成功推成另外两项成功。填写验收/提交入口由主会话直接调用 M06 handler，M07 没有重复写入。

## 验证

```powershell
npm test -- retrospectives
npm run typecheck
```

测试为 Node 内置 node:test。服务测试使用测试夹具，SQL 适配测试使用模拟 SqlExecutor，验证事务/CAS/参数绑定/隐私删除；这些不能代替真实 PostgreSQL 迁移、回滚与恢复演练。组件需由主会话集成后做手机、键盘、长中文和真实异步状态视觉验收。

本轮最终验证结果及全局检查状态见 `docs/协作/交付/retrospectives.md`。没有执行迁移、真实模型调用或浏览器视觉QA。

组件的确认与分享权限 props 仅用于界面；服务端仍执行权限检查。变更响应使用安全 `DocumentView`，顶层提供 id/revision/scope/status/needsReview，受撤回影响的 document 为空；客户端应保留本地输入、展示复核原因，不能把空正文当新草稿自动保存。

模块不直接读取环境变量；主会话连接池需要 `DATABASE_URL`。模型供应商凭据、超时和每日额度名称由主会话适配器配置（只在服务端），本模块不提供凭据值或默认真实账号。

## C05 个人入口与自动编辑草稿（2026-10-10）

`PersonalExperiencePanel` 位于获授权的 `src/components/experience-client.tsx`，供根挂 `/app/experience`。它提供本人私人经验/复盘列表、场景文字/状态/来源项目筛选、历史版本、Markdown/JSON 导出、显式删除、选择性复用字段预览、复用草案找回、自动编辑草稿读取/导出/删除。项目经验面板也增加历史及本人私人记录删除入口。离队不阻止本人记录处理；当前不可访问的项目引用/来源正文仍隐藏，个人入口不读取旧团队的源事实。

`RetrospectiveService.listPersonalRecords(actor,kind,filter)` 的 kind 为 experience_card/retrospective，filter 为 `{projectId?,query?,status?,limit?,afterId?}`。存储的新增 `personalOnly:true` 强制本人/private，former project 筛选不查成员权限。搜索发生在授权后的可见正文，单次最多扫描 1000 条，每页最多 100 个匹配项；continuation cursor 可继续搜索，隐藏正文不会命中关键词。

`listReuseDrafts(actor,{projectId?,limit?,afterId?})` 与 `getPersonalReuseDraft(actor,id)` 返回 `ReuseDraftView={draft,selectedContent:Record|null,requiredRechecks,unavailableReason?}`。目标撤权、来源撤回/版本变化时仍显示本人选择元数据，源正文为空。原 `getReuseDraft` 保持严格预览及原错误契约。草案只存来源版本和选择项，不继承旧截止、权限或提交成功状态。

追加原工厂 handler：GET `/experience-cards` → listPersonalExperienceCards；GET `/retrospectives` → listPersonalRetrospectives；GET `/experience-reuses` 或 `/projects/:projectId/experience-reuses` → listReuseDrafts；可选 GET `/personal-experience-reuses/:id` → getPersonalReuseDraft。DELETE `/experience-reuses/:id` 复用 deletePersonal，GET `/experience-cards/:id/history?revision=…` 复用 historyVersion。历史继续服从当前权限/撤回，不恢复私人分享。

正式复盘承担完整回答、项目分享、AI 整理和确认版本；直接自动 PATCH 会即时改变项目可见正文，无法保存未填完的答案。因此新增 `RetrospectiveEditDraft` 私有缓冲，键为 ownerId/projectId/documentId（新建 null），保留 requestedScope 意图、baseDocumentRevision 正式基线、允许空白的原文 draftContent 与 CAS revision。自动保存没有确认事件、AI任务或第二套完成状态；正式保存、分享、确认仍走原接口。

服务器公共导出：RetrospectiveEditDraftService、PostgresRetrospectiveEditDraftRepository、createRetrospectiveEditDraftHandlers 及 DTO/deps/Port。增量 SQL 建议在 `migrations/002_edit_drafts.sql`，由根用新的迁移序号执行。新表保存私有输入、空行锁根及仅 hash/标识/revision 的幂等回执。创建 expectedRevision=0；更新带当前草稿 revision。同 mutationId 同 payload 回放不产生新写，异 payload 返回 IDEMPOTENCY_CONFLICT。回放返回当前 draft 与当时 acceptedRevision，二者不同先对照冲突；删除后旧回放 DRAFT_DELETED，不恢复输入。M01 账号完全删除需清除本人 drafts、roots、receipts 元数据。

```ts
const editDrafts = new RetrospectiveEditDraftService({
  repository: new PostgresRetrospectiveEditDraftRepository(database),
  access: projectAccess, projects: projectState, finalFactsLock: finalFactLocks,
  ownerRetrospectives: ownerIdentityPort, clock, ids,
});
const editDraftHandlers = createRetrospectiveEditDraftHandlers({
  service: editDrafts, authenticate: verifiedSessionActor, requestId: makeRequestId,
});
```

根 ownerIdentityPort.readIdentity({actor,projectId,documentId},sql?) 仅投影本人正式复盘 id/projectId/ownerId/revision，使用传入同一 SQL executor 锁当前正式记录至提交，不返回正文/源事实。非作者/不同项目/已删除返回 null。服务锁顺序为 FinalFactsLockPort（operation retrospective.update、所属 projectIds、空 evidence/resources）→正式 identity→幂等回执→草稿根/CAS。缺最终锁拒绝新写，正式版本不同 DOCUMENT_CHANGED。撤权/归档禁止新写；已有本人缓冲可读/导出/删除，不调用旧项目源 Port。

| 路由（`/api/v1` 前缀） | 自动草稿工厂 handler |
| --- | --- |
| GET/PUT `/projects/:projectId/retrospective-edit-draft?documentId=:id`（新建省略 query） | get / save |
| GET `/retrospective-edit-drafts?projectId=&limit=&afterId=` | list |
| GET/DELETE `/retrospective-edit-drafts/:id` | getById / delete |
| POST `/retrospective-edit-drafts/:id/export` | exportDraft |

PUT body 仅 `{documentId:null|string,baseDocumentRevision:number,expectedRevision:number,mutationId:string,requestedScope:'personal'|'project',draftContent:RetrospectiveContent}`。GET 不存在返回 null，PUT 返回 `{draft,acceptedRevision,replayed}`，DELETE 带 expectedRevision，export 带 format:json/markdown。真实 session 身份、100KB 流式限额、private/no-store，错误不泄露 SQL 或供应商正文。

客户端 createAutosaveController 从 client.ts 导出，默认 800ms debounce、序列化请求、CAS 冲突停写。未知结果用原 payload/同 key 显式恢复；输入不会被晚到响应覆盖；403/归档停写、dispose 停止新请求。Editor restoredDraft/restoredDraftKey 只在初始或明确采用时替换输入，不改正式 baseline；onDraftChange 用于私有保存，canSave 控制正式动作，preserveDraftOnRemoteChange/onAcceptOfficialRevision 支持明确对照。按钮区分“正式保存复盘草稿”与自动私有缓冲。

导出先 schema 白名单，再剔除可识别密钥、Bearer、联系方式和本机路径，数据库原文不变。自由文字无法机械证明完全匿名。新增测试不读取 .env、不连接生产目录、不调用付费模型；内存 PGlite 验证 SQL/CAS，但不代替远程 PostgreSQL 多连接验收。最终交付见 `docs/协作/交付/experience-completion.md`。

### 可选技能使用经验

人工复盘与经验卡可选 `skillUsage?:{reference:FixedSkillReference,purpose:string,feedback:string,limitations:string}[]`，最多12项、文字各2000。旧记录没有此字段仍合法，独立编辑缓冲允许未填完的文字并保留原文。元数据固定为 M10 的 kind/id/version/versionId/contentHash/revision；这些是历史引用，当前目录撤回不会修改本人过去文字。全条仅表示成员自报，不能加入安装 receipt、compatibility、verified 或交付成功字段。

复盘/经验编辑折叠字段、账号查看、历史、自动草稿、JSON/Markdown 导出均保留可选历史。选择性复用可选 skillUsage，创建前展示具体引用与本人文字；requiredRechecks 要重核固定版本、客户端/环境、许可、学习时间、赛事允许范围和当前可获取性。复制只是元数据/文字参考，不执行任何安装。旧卡没有技能记录时不能勾选该字段，其他复用保持兼容。

`parseSkillUsage` 只 type-import M10 public index 的 FixedSkillReference；runtime 为 browser-safe 的结构校验，与 M10 public parseFixedSkillReference 做 parity 测试。M10 当前服务 index/project-selection 引入 node:crypto，M07 validation 同时用于浏览器，故没有 runtime 导入整服务；没有修改 M10、没有当前目录 lookup 或第二套技能状态。
