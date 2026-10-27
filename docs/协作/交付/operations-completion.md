# C07 运营审计、保留策略与来源故障归因交付

日期：2026-10-10。授权范围：只新增 `src/modules/operations/audit-query*`、`retention-policy*`、`observability*` 和本说明。未修改现有 operations/index/service/worker、C06 skill-review*、root server/app/shared/components、resources、实际迁移、依赖或公共规划。根组合及生产执行由主会话负责。

## 已完成

### 管理员审计查询与组件

- `audit-query-types/service/postgres/handlers/index.ts`：组合五类现有 M08 审计事实，提供操作者、对象种类/ID、动作、审计版本、内容版本、时间的固定安全投影。
- `audit-query-panel.tsx` 导出 `AdminAuditPanel`、`createAdminAuditLoader`，配套 `.module.css`。查询、空结果、读取错误、旧请求取消和下一页可接现有运营页；只读，没有后台抓取/收费/邮件。
- 默认最近 7 天，窗口最大 31 天；1–100 条/页，默认 50。HMAC 游标绑定账号、筛选和窗口，15 分钟过期。PostgreSQL 六位微秒+C字符序处理同时间记录。
- 普通用户/审核员无权查询；当前账号、管理员权限、请求会话在同事务读前/读后复核。不查询私人项目/测评/仓库，不返回理由正文、原始日志、URL、邮箱或凭据。未知动作只返回固定 `unrecognized`。
- `audit-query-indexes.sql` 是新递增迁移的索引建议，未执行；详情见模块 `audit-query-readme.md`。

### 单来源故障归因

- `observability-types/service/postgres/handlers.ts`：按来源和有界创建时间窗查询任务，支持 `kind/status/failureCategory`，默认7天、最多31天、1–100条。签名游标30分钟有效，绑定账号/来源/筛选/原窗口，保留六位微秒。
- 来源连续失败来自已有健康列；窗口内状态/最新失败类别统计覆盖整个筛选窗口，不只当前页。首次等待、当前排队时间、最近一次尝试耗时均以真实记录计算；缺失为null。失败分类包含后来恢复的任务，不把旧失败当作当前最终失败。
- `observability-panel.tsx` 导出 `AdminSourceObservabilityPanel({sourceId,endpoint?})`，配套CSS。展示当前来源、故障类别、时间依据、可选心跳/预算与有界下一页。默认读取 `GET /api/v1/admin/sources/:sourceId/observability`，不轮询，不触发采集。
- 当前权限同事务前后复核；SQL只投影 M08 的来源和任务字段，没有源URL、操作者、日志、令牌、原始正文。陌生失败分类在SQL及服务投影层统一归为unknown。
- 根心跳/预算未接时返回null，不能当成健康或免费；全局source-worker心跳明确 `scope:all_sources`，不能冒称每个来源独立实时健康。

### 临时原文/预览保留策略

- `retention-policy.ts`：`createRetentionPolicy({originalTextDays?,previewDays?})`。默认临时原文30天、临时预览7天，可配置1–3650天。默认标 `module_default_provisional`，部署传入值标 `deployment_config`；工程默认不代表真实保留期限已通过用户批准。
- 只清 `temporary_original_text` / `temporary_preview` 的孤立载荷。正式规则证据、项目不可变快照、审核记录、未知模型hold、预算、导航完整历史、不可变采集回执永久保留，不在本策略清理范围。
- 未采纳、过期且能完整证明无引用/无未知或待结算请求/无活跃或可重试消费者才允许清。任何未知都保留。
- `retention-policy-service.ts` 导出 `createRetentionService({cleanup,clock,ids,policy?})`；`retention-policy-worker.ts` 导出 `createRetentionWorker({service,getServiceCredential})`。`dryRunOnce(query?)` 与 `cleanupOnce(request)`严格分开；无定时器、无自动将预演转删除。清理限100项，每项保护事务锁检查→最终CAS复查→不可变审计→当前服务身份复核。
- 保留载荷ID/哈希/版本/清理墓碑；不能删receipt、改模型账本、清hold、删指纹/幂等/去重标记、增加attempt、入队或重放未知请求。CAS前引用、版本、hold发生race则保留。

## NEEDS_INTERFACE：根接入的精确工厂与权限

### 1. 审计查询

```ts
import { createAuditQueryService, PostgresAuditQueryPort, createAuditQueryHandlers } from "src/modules/operations/audit-query-index.ts";
const audit = createAuditQueryService({ database, query: new PostgresAuditQueryPort(),
  authorization: { assertCurrentAdmin: async (tx, actor) => { /* 根复核当前账号、可信请求会话、admin角色 */ } },
  clock, cursorSecret /* Uint8Array >=32字节，服务器专用 */ });
const handlers = createAuditQueryHandlers({ service: audit, resolveActor, requestId, assertMutationAllowed });
// GET /api/v1/admin/operations/audit -> handlers.list
```

`list(actor,{actorId?,action?,objectKind?,objectId?,revision?,stream?,from?,to?,limit?,cursor?}) -> {items,nextCursor,window:{from,to}}`。字段完整定义在 `audit-query-types.ts`。时间输入UTC ISO Z，下一页保留非时间筛选，时间未填写时从游标恢复原窗口。

`AuditAuthorizationPort.assertCurrentAdmin(tx,actor)` 必须复核活跃账号、当前请求的真实会话（过期/撤销/用户匹配）及当前admin角色，并按根既定顺序锁定身份事实至事务完成。可按请求构造授权闭包，不能只检查缓存Actor。即使知道某私人项目ID也不能通过审计查询读取它：port没有私人表。

查询范围为 `operations_execution_audit`、`operations_event_review_audit`、`operations_resource_review_audit`、`operations_correction_transitions`、`operations_discovery_control_audit`；C06技能审核审计、根权限授予审计需要各自经过授权的安全projection再扩展，当前不冒称全站审计已组合。

`AdminAuditPanel({endpoint?,loadPage?,initialPage?,initialInput?})`：`loadPage(input,signal)->Promise<AuditQueryPage>`，默认endpoint见上。初始页须来自管理员专用DTO；预载页有筛选时同时传入`initialInput`，确保下一页保留原筛选。不要将服务器 `cursorSecret`、账号会话或角色库传入client props。组件单独导入，不从包含node:crypto的服务bundle导入。

### 2. 单来源故障查询与根运行统计

```ts
const repository = createPostgresOperationsObservabilityQueryPort(database);
const service = createOperationsObservabilityService({ repository,
  authorization: { assertCurrentAdmin: async (actor, sql) => { /* 同事务当前身份/会话/admin */ } },
  clock, cursorSecret /* string UTF-8 >=32字节 */, runtime /* 可选root统计Port */ });
const handlers = createOperationsObservabilityHandlers({ service, resolveActor, requestId });
// GET /api/v1/admin/sources/:sourceId/observability -> handlers.source(sourceId)
```

上述工厂分别从 `observability-postgres.ts`、`observability-service.ts`、`observability-handlers.ts` 导入。`source(actor,{sourceId,since?,until?,kind?,status?,failureCategory?,limit?,cursor?}) -> SourceObservabilityReport`；字段见 `observability-types.ts`。管理员权限Port参数顺序为 `(actor,sql)`，审计Port为 `(tx,actor)`，根组合请留意。

`OperationsObservabilityRuntimePort.readSourceRuntime({sourceId,observedAt},sql)`只读返回：

- `measuredAt`；`worker:null|{scope:all_sources|source,status,lastSeenAt}`；
- `model:null|{quotaDay,quotaTimezone:UTC,calls,pendingReservations,unknownRequests,completeCostMicroUsd:string|null,reservedMicroUsd:string|null,admission:allowed|limited|unknown_request|not_configured}`。

根从已有 `backend_worker_heartbeats` 和AI账本读取，不初始化账本/刷新来源/入队。已确认source-budget关联 `ai_execution_jobs.kind='source' AND project_id='source:'+sourceId`；版本字段在该预算路径为run attempt。未知hold必须跨日检查全历史保留请求，不能只查今天预算使旧unknown消失；费用未知为null，不能补零。source-worker心跳目前是全局范围。

可供根新迁移采用的来源窗口索引：

```sql
CREATE INDEX operations_observability_source_window
ON operations_execution_runs(source_config_id,created_at DESC,id COLLATE "C" DESC);
```

### 3. RetentionCleanupPort：root安全SQL适配

完整类型及不可违背约束见 `retention-policy-service.ts` 的 `RetentionCleanupTransaction`，由root实现：

| 方法 | 返回及根行为 |
| --- | --- |
| `transaction(work)` | 复用同一真实executor/事务；不得独立提交副作用 |
| `authorize(serviceCredential)` | `VerifiedRetentionIdentity|null`，固定kind=`operations_retention_worker`，当前capabilities=`retention_dry_run/retention_cleanup`，sourceConfigIds为授权范围（null明确全来源、[]无权限）；网站Actor不能冒充 |
| `listExpiredTemporaryPage(scan)` | 元数据 `RetentionInspection[]`及hasMore；<=limit，按`(created_at,id COLLATE C)`ASC、应用每kind截止和当前来源scope |
| `lockAndInspectTemporaryArtifact(id)` | 载荷revision、createdAt、bytes、kind、采纳/payload状态；完整referenceState、modelRequestState、runState，查不全返回unknown |
| `clearTemporaryPayload(input)` | 最终CAS/NOT EXISTS重新核对current scope、kind、revision、不可变createdAt、cutoff、unadopted、present、引用、待结算/unknownhold及活跃/可重试消费者；返回cleared的新revision/bytes或固定kept reason |
| `appendCleanupAudit(event)` | clear同事务append-only，失败整体回滚该项；只存元数据，不存原文/凭据 |

`cleanup`输入 `{expectedPolicyFingerprint,candidates:[{artifactId,expectedRevision}]}` 必须来自可review的dry-run；策略变化拒绝。每条事务保证保护锁顺序及所有引用/hold创建者共享守卫，避免“查无引用后又被引用”的race。不能建立这个并发协议就返回unknown保留。若载荷是外部文件，root应设计事务outbox和版本化 guarded erasure，不能事务提交前unlink。

**当前 `integration_source_results.payload.acquired` 不能直接删或剥正文。**现有 `loadAnalysis`、哈希去重、分析输入与不可变回执校验都依赖它；它属于 `immutable_ingestion_receipt`。根若要减少长期存储，必须先将确实可分离的缓存/预览建模为独立临时载荷并证明所有引用覆盖，再接此port。此任务不对root表编写DELETE，也没有调用cleanup。

### 4. 资源链接检查：现有worker，root调度/robots/持久化

已有 `src/modules/resources/link-check-worker.ts` 的 `createResourceLinkCheckWorker({approvedUrls,clock,transport?,timeoutMs?,maxRedirects?}).check(url)`；本任务只读研究，没有改resources或调用外网。

根需要以下窄Port（建议契约，尚未接入，不是已存在功能）：

1. **审批与调度** `claimApprovedBatch(tx,{workerId,now,limit})`：建议每批<=20、串行、同URL至少24小时检查一次，租约防多worker重复；返回 `{resourceId,expectedRevision,approvedUrl,networkPolicyVersion,robotsEvidenceId,leaseToken}`。URL必须来自服务器已审核完整白名单，绝不能来自当前用户请求/模型输出。GET后台只能读保存结果，不能启动检查。
2. **公开网络/robots** `assertCheckAllowed({url,networkPolicyVersion,robotsEvidenceId,at})`：robots实际允许且证据在有效期；跳转每个完整URL重新验证。现有HEAD transport没有robots读取功能，因此root要提供robots gate及包裹每一跳的`ResourceLinkTransport.head(url,signal)`，可用现有M08安全获取/robots设施，不能靠“HEAD没有正文”绕过。保持公开DNS/IP固定、TLS、精确跳转名单、体积/头限制，不用任意crawler或登录凭据。
3. **结果持久化** `recordCheck(tx,{resourceId,expectedRevision,approvedUrl,networkPolicyVersion,leaseToken,check})`：同事务复核资源版本、官方URL、审批和lease，保存固定check状态/原因/httpStatus/checkedAt与审计；race丢弃旧结果，不覆盖新资源说明/费用/许可，也不将一次2xx当成已审核或自动上架。建议append-only活性历史+安全summary，具体存储由root/M09公开Port负责。
4. **管理员查询** `listSavedChecks(actor,{resourceId?,status?,limit?,cursor?})`：当前admin权限和有界分页，只读安全摘要，不返回响应正文/header/查询密钥或内部备注。

worker目前完整URL白名单1–100项，默认总超时8秒/最多3跳，上限15秒/5跳；HTTPS标准端口、固定公网IPv4/TLS，IPv6-only/403/429/405/网络失败保持unknown。未核验URL、robots不允许或无法判断时不请求；不下载图片或作品，不发邮件/模型调用，不在未知请求清理中触发重试。嵌入式PGlite继续网站同实例，不另开进程同目录；独立worker只用真实DATABASE_URL。次数与频率属root部署配置，以上24小时/20项是明确标注的工程建议。

## 验证与未接入

- 已完成隔离Node行为测试，最终合并复跑 **41/41通过**：audit 11/11、observability 10/10、retention 20/20。SQL验证只用内存PGlite测试夹具，没有读取 `.env.local`、生产路径或真实迁移。
- 审计覆盖权限撤销、游标伪造/账号/筛选绑定/过期、微秒分页、无界/异常Port、敏感字段脱敏及HTTP；可观测覆盖当前权限、分类脱敏、窗口/游标、SQL真实微秒连续页；保留覆盖引用/版本/hold race、未知判定、dry-run、scope撤销、最终CAS及审计失败回滚。
- 根API、真实授权/session锁、心跳/模型runtime、索引迁移、RetentionCleanupPort及资源检查调度仍未接入。保留无生产cleanup，资源无真实外网HEAD，未作build/start/生产数据库/迁移/付费或邮件调用。
- UI已提供独立组件与CSS，未宣称根浏览器视觉/键盘/权限走查通过。最终全局`node node_modules/typescript/bin/tsc --noEmit --incremental false`检查，本次全部新文件无类型错误；仍有并行根`src/server/router.ts:400–403`的3个参数数目与1个`retrospectiveEditDrafts`缺失错误，未越权修改。
- 本次完整新增服务、SQL适配、handler、两个React组件与全部测试另外执行独立严格TypeScript检查，退出码0；不会被其他并行根错误遮蔽。

最终测试命令：

```powershell
node --experimental-strip-types --test src/modules/operations/audit-query.test.ts src/modules/operations/audit-query-postgres.test.ts src/modules/operations/observability.test.ts src/modules/operations/retention-policy.test.ts
```

## 环境变量名称

本模块工厂不读取环境：根可使用建议 `OPERATIONS_AUDIT_CURSOR_SECRET`、`OPERATIONS_OBSERVABILITY_CURSOR_SECRET`、`OPERATIONS_TEMP_ORIGINAL_RETENTION_DAYS`、`OPERATIONS_TEMP_PREVIEW_RETENTION_DAYS`、`OPERATIONS_RETENTION_SERVICE_CREDENTIAL`。只列名称，无值；root需校验并传入，不把凭据给浏览器。source runtime沿用既有后端配置。资源检查enablement/interval/limit可由root显式制定，本文未新增生效环境项。

## 停止与交还

2026-10-10，C07及其内部代理已完成、停止全部代码和文档编辑；本次新增文件全部交还主会话。授权不作为后续覆盖根接入修改的持续权限。
