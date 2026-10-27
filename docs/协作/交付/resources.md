# M09 工具与灵感库交付

状态：第二轮补全完成，已停止修改，可由主会话集成。文件范围为 `src/modules/resources/` 与本文。根应用当前已组合资源服务、路由、持久化本地 PGlite 和连接模式；本模块没有执行实际应用数据库迁移、导入或发布。新增目录 CLI、检查点迁移和活性 worker 工厂待主会话接入。候选没有作为已审核资源公开。

## 已完成

- `index.ts` 公共服务端导出、README、领域类型/受控分类与标签、人工候选输入。
- 发布状态、链接状态、费用/许可未知与依据、带时区核验时间及过期派生；公开列表搜索筛选、编辑/名称/核验排序、分页、详情与下架原因。
- 工作稿与公开快照分开。新草稿不遮挡旧发布版；内容版本与乐观锁修订独立，历史保存不可覆写。
- 个人收藏唯一/幂等、本人隔离、备注 CAS、移除；新增收藏不会隐式共享。下架保留个人及项目引用历史。
- 当前审核 ID 查询、带版本引用校验；M05 应用时可在调用方事务内锁定资源行，防与撤下并发。
- `shareResource` 与 `shareBookmark`：明确选择项目、预检活跃成员、校验当前审核版本、以服务端快照重建标题/链接。本次共享备注可独立编辑，不修改私人收藏。
- PostgreSQL 参数化适配与建议迁移：资源头、不可改写版本、个人收藏、发布幂等结果与轻量通知。没有重复建立 M02 项目资料或 M08 审核表。
- M08 同事务发布适配：revision＋contentHash 校验、真实审核记录查询、一次提交保存历史/幂等结果/通知；重复同输入返回原结果，异输入同键拒绝。
- HTTP handler 工厂：可信会话 Actor、必需同源/CSRF 钩子、私有 no-store、输入上限、错误脱敏；公开读与本人收藏/纠错。
- 6 个 React 可接入组件：Card、Filters、Detail、BookmarkEditor、ProjectShare、List。暖白＋橙红、稳定加载/错误/空状态、失败备注保留、下架/风险外链全部停用、项目默认不选择。私有组件按身份 key 重挂，避免账号切换残留上一人的草稿。
- 官方来源精选 `RESOURCE_CATALOG`：13 条工具/AI 界面/UI 组件/设计灵感候选，覆盖现有四类与五阶段，版本 `2026-10-08.1`、核验日期 `2026-10-08`。每条保存用途、费用、许可来源证据及待核验项。源码许可与云服务/素材权益分开，未知不猜；所有链接初始未知、所有条目初始候选。原 `candidates.ts` 的十条规划候选保留，M10 独立模型未被改动。
- `createResourceCatalogCli(deps).run(args)`：默认预览；可信 reviewer/admin 导入；审核要求明确链接确认、非空审核理由与必要的未知确认；发布走 M08 register/decide/publish。三个阶段同事务保存资源/审核/检查点，重复导入复用，失败可恢复，人工修改或目录版本变化拒绝覆盖。没有调用直接发布绕过 M08。
- `createResourceCatalogCheckpointPort(tx)` 与新增建议迁移 `002-resource-catalog-imports.sql`：按候选 key 的事务 advisory lock 包含首次导入空记录，检查点 CAS、稳定内容哈希、资源引用。主会话须采用递增根迁移。
- `createResourceLinkCheckWorker` 与真正可执行的 Node HTTPS HEAD transport：服务端精确审批 URL、仅公网 DNS 固定连接、原域名 TLS 检查、总超时与跳转上限、跳转逐 URL 审批、响应头检查且不执行网页。结果只描述可达性，无内容发布、费用或许可更新权限。

## 已验证

2026-10-08 收尾验证：

| 验证 | 命令/结果 |
| --- | --- |
| 模块行为 | `npm test -- resources`：70/70 通过（原 50、目录 3、CLI 10、活性 6、真实隔离 SQL 集成 1） |
| 模块类型 | 资源目录全部 `.ts/.tsx`＋`next-env.d.ts` 的定向 `tsc --noEmit --strict`：通过 |
| 全局类型 | 当次 `npm run typecheck` 未通过：M06 测试 2 处、根 application/navigator 测试 4 处；资源目录无类型错误，未越界修改 |
| 组件 | 内存静态渲染和身份 key 检查通过；浏览器实测未完成 |
| 服务端公共入口 | Node 直接导入 `index.ts` 成功，13 条目录、CLI 与 worker 工厂均已公开导出 |
| 隔离 SQL | PGlite 实际执行模块 001/002 与 M08 审核表建议 SQL；真实资源/审核/检查点适配通过导入、审核、发布回滚恢复与重复运行验证 |

定向类型检查参数与根配置的相关项相同：`--target ES2022 --lib dom,dom.iterable,es2022 --module esnext --moduleResolution bundler --allowImportingTsExtensions --jsx react-jsx --esModuleInterop --skipLibCheck`。没有新增依赖、运行应用数据库迁移或执行全局 Git 写操作。

当次全局错误明细：`github/tests/authorization-service.test.ts:34` 的 `permissions` 夹具有可选 undefined；`github/tests/repository-creation.test.ts:65` 的授权 HTTP 夹具缺 `revokeToken`；`server/application.ts:133`、`server/navigator.test.ts:20/57/111` 的 `ledger` 参数尚未匹配工厂定义。其他会话继续开发时可能变化，以主会话最终全局检查为准。

## 模拟测试与未接入

- 业务测试使用 `testing/memory-repository.ts`：事务互斥、copy-on-write 回滚与独立读快照，仅为测试夹具。
- 原 SQL/HTTP/审核事务测试使用录制 `DatabasePort/SqlExecutor` 和注入审核 Port；不能证明线上 PostgreSQL 多连接并发或实际应用迁移已运行。
- 新增 `catalog-integration.test.ts` 用无路径隔离 PGlite 真实执行 SQL，M08 通过公共 repository/service 接入同 executor。批准后在发布审计 INSERT 成功处注入异常，确认 M09 公开快照/历史/幂等操作/通知、M08 审核/审计、CLI 检查点整个发布阶段回滚；恢复后仅生成一次成功事实。该测试不使用实际应用数据库、真实登录身份、外网或 PostgreSQL 多连接池。
- React 静态渲染检查覆盖外链/恶意协议、未知标签、UTC+8、匿名隐私、明确项目选择、列表失败/空态、账号切换隔离；未实测浏览器焦点、320/390px、200% 放大和减少动效。
- 根持久化、认证/同源检查、M02/M05 与 M08 路由已由主会话组合；本次只读确认其契约，没有替主会话宣称整站或连接数据库验收完成。通知消费/确认与账号删除联动仍需其整体验证。
- 原十条规划候选未核验；新增 13 条候选经官方文档/价格/许可来源查阅。没有实际应用 ResourceReview 或已发布种子，没有工具账号实测、图片下载或脚本执行。
- 活性 worker 一次真实本机请求：`https://lucide.dev/`，3 秒总超时，结果 `unknown / request_timeout`，记录时间 `2026-10-08T14:10:20.046Z`。其余成功、受限、跳转、私网和超时分支为注入 transport 的模拟验证。无法据此标记候选链接可用。
- 新增根 CLI 入口、递增迁移、worker 调度/审批配置/结果存储尚未由本模块接入；工厂没有暗中读取环境或发起发布。官方来源表与工厂调用示例见模块 README。

## 当前根 API 对齐

以下从 `src/server/router.ts` 和 `src/server/operations.ts` 的当前组合核对，统一前缀 `/api/v1`。身份来自登录 Cookie；修改请求须通过根同源检查。平台 reviewer/admin 仅用于公开内容审核，不能代替项目成员权限。运营新建/更新资源的正文必须有 `content` 包装。

| 方法与路径 | 输入与行为 |
| --- | --- |
| `GET /resources` | 单值 `search/type/stage/stack/prerequisite/use/costType/sort/cursor/limit`，受控词表 |
| `GET /resources/{id}`、`GET /resource-categories` | 当前公开详情/受控分类 |
| `GET /me/resource-bookmarks` | 只接受 `cursor/limit`，仅本人 |
| `POST /me/resource-bookmarks` | `{resourceId,purposeNote}` |
| `PATCH /me/resource-bookmarks/{id}` | `{purposeNote,expectedRevision}` |
| `DELETE /me/resource-bookmarks/{id}` | 移除本人收藏，不删除项目资料 |
| `POST /resources/{id}/share` | `{projectId,resourceVersion,purposeNote}`；当前活跃成员，服务端重建标题/链接 |
| `POST /resource-corrections` | `{resourceId,kind,note}`；根组合登录后转 M08 当前公开版本纠错 |
| `POST /admin/resources` | `{content: ResourceInput}`；草稿，201 |
| `GET /admin/resources/{id}` | 当前工作稿，包括 `revision/version` |
| `PATCH /admin/resources/{id}` | `{expectedRevision,content: ResourceInput}` |
| `POST /admin/resources/{id}/request-review` | `{expectedRevision}`；根同事务提交并 M08 register，返回 `{resource,review}` |
| `POST /admin/resources/{id}/register` | `{expectedResourceRevision}`；为已提交版本注册 M08 核验；request-review 已注册时无需再调用 |
| `GET /admin/resource-reviews` | 可选 `status/limit` |
| `GET /admin/resource-reviews/{reviewId}` | 返回 `{review,resource}` 核验与内容快照 |
| `POST /admin/resource-reviews/{reviewId}/decide` | `{expectedRevision,expectedResourceRevision,decision,reason,verification?}` |
| `POST /admin/resource-reviews/{reviewId}/publish` | `{expectedRevision,expectedResourceRevision}`；已批准版本，M08 事务发布与审计 |
| `POST /admin/resources/{id}/withdraw` | `{expectedResourceRevision,expectedPublishedVersion,operationId,reason}` |

批准时 `verification` 必须为 `{link:{status:"available",checkedUrl},fees:{status:"verified"|"unknown",sourceUrl},license:{status:"verified"|"unknown",sourceUrl}}`；已知结论来源须匹配内容当前版本；未知须 `status:"unknown",sourceUrl:null`。`expectedRevision` 是审核修订，`expectedResourceRevision` 是工作稿整体修订，不是内容 `version`。例如首次提交后先使用返回的两种修订批准，再使用批准响应的新审核修订发布；旧修订返回冲突，不能预估成固定数字。

## NEEDS_INTERFACE

- 新增目录接入：导出 `RESOURCE_CATALOG`、`createResourceCatalogCli`、`createResourceCatalogCheckpointPort` 与 `ResourceCatalogCliDependencies`。`loadTrustedActor(): Promise<Actor>` 由根可信身份查询返回真实角色，不从 argv 自授。`runEach(work)` 必须把 `resources` 命令、M08 `reviews` 和 `checkpoints` 绑定同一 executor；整个阶段错误一起回滚。根当前同事务复用实现可用 `application.database.transaction(tx => work({resources:application.resources,reviews:application.operations.services.resourceReview,checkpoints:createResourceCatalogCheckpointPort(tx)}))`。正式根接入必须使用已有 M08 服务的发布台账包装，不能另建一条缺少纠错目标登记的发布链。详细 argv 示例在 README；干跑不需加载身份或写库。
- 新增检查点迁移仅建议：将模块 `migrations/002-resource-catalog-imports.sql` 复制为下一份根递增迁移，先迁移再导入；已应用根文件不重写。同 key 的目录版本/哈希不同返回 `CATALOG_ENTRY_CONFLICT`，已导入草稿或审核被修改返回冲突，需要人工协调更新，不能自动覆盖。导入/审核/发布阶段分别提交，审核阶段注册与批准原子完成；检查点 `submitted_for_review` 仅预留，不是目前 CLI 的独立落库阶段。
- 新增活性检查接入：`createResourceLinkCheckWorker({approvedUrls,clock,timeoutMs?,maxRedirects?,transport?}).check(url)` → `{url,finalUrl,checkedAt,status,httpStatus,reason}`。审批完整 URL 必须来自服务端配置，不得从用户请求或模型输出直接扩容；重定向也逐完整 URL 审批。结果只供运营复核，不能给 worker 平台 reviewer/admin 角色、自动调用 M08 approve/publish 或覆盖费用/许可。根负责隔离入口和结果存储，本模块没有新环境变量协议。

- M08 事务接入使用 `createOperationsResourcePublicationAdapter({clock, ids, readReview})` → `OperationsResourcePublicationPort`。结构兼容 M08 `readForReview(tx, id) / publishReviewed(tx, input) / withdraw(tx, input)`。集成层将 `readReview(tx, reviewId)` 委托 M08 的同一事务 `getReview`，返回其审核记录；不得让浏览器提供记录，不得独立提交。状态映射 `in_review → pending_review`，有旧公开版和新草稿时为 `needs_recheck`。先 `ResourceService.requestReview`，再 M08 register/decide/publish。M08 目前撤下接口无风险标志，因此适配默认阻断所有外链。
- 另一种直接服务组合可注入 `ResourceReviewLookupPort.getApprovedReview(reviewId)`，返回 `{ id, resourceId, resourceVersion, reviewerId, checkedAt, sourceLinks, result: "approved" }` 或 null。此路径没有 M08 审核事务/通知，正式审核链路优先上一项。
- 内容命令 `ResourcePublicationPort`：`getDraft(actor, id)`、`createDraft(actor, input)`、`updateDraft(actor, id, expectedRevision, input)`、`requestReview(actor, id, expectedRevision)`、`publish(actor, id, expectedRevision, reviewId)`、`withdraw(actor, id, expectedRevision, reason, blockExternalLink)`。仅 reviewer/admin；普通 worker 不得获得该 Actor。
- M05 `getDisplayableApprovedIds(ids, tx?)`，以及 `getReviewedResources(ids, tx?) / validateResourceRefs(refs, tx?)`。传 `SqlExecutor` 时按稳定 ID 顺序 `FOR UPDATE` 锁定发布头，保留至计划事务提交；不另开事务。只返回当前 published、链接 available、外链未阻断的审核条目。`refs` 为 `{resourceId, version}`；未知/下架/版本变化拒绝或过滤，计划核心任务仍可无资源继续。
- M02 `getReviewedResource(id, tx?)` → `{id,title} | null`，与现有 `ReviewedResourcePort` 兼容。资料写入希望同样传事务锁住当前发布状态，避免读完后资源撤下的竞态。
- M02 注入 `ProjectResourceSharePort.addReviewedResource(actor, { projectId, resourceId, resourceVersion, title, url, purposeNote })`，返回共享资料 `{id, projectId}`。必须在 M02 写入事务内再次校验活跃 ProjectMembership 和当前审核资源版本；按项目＋资源幂等合并。M09 仅在用户明确选择 projectId 后调用，同时预检活跃成员，不建立项目共享表。例如收藏成功不会共享；已离队用户显式共享返回 403，个人收藏仍保留。
- M08 可注入 `ResourceCorrectionPort.submit(actor|null, {resourceId, kind, note})`；M08 限流并审核，M09 不另存 ResourceReview/纠错队列。
- 主会话组合认证 `resolveActor(Request)`、真实 `DatabasePort` 与路由。模块不接收请求 JSON 中的 userId/平台角色。
- 私有 UI 组件 `ResourceBookmarkEditor / ResourceProjectShare` 必须传 `identityKey: string | null`（当前可信用户 ID 或身份 key）；私人 bookmark、初始备注和项目列表必须属于此身份。Card 可传同一 key。组件会在身份变化时重挂载，旧 Promise 不能更新新身份状态。

## 所需环境变量名称

`DATABASE_URL`（由主会话持有和配置）。本模块不需要邮件、模型或 GitHub 凭据。
