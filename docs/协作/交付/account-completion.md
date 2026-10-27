# C01 账号自助收尾

状态：已实现、模块验收通过并停止编辑，2026-10-10。仅修改 auth 模块及本文；文件交还主会话，根组合/真实迁移由主会话执行。

## NEEDS_INTERFACE

- `OwnDataExportPort.collectOwnData(actor, executor, limits): Promise<OwnDataBundle>`：root 在传入事务 executor 上读取本人原始资料、对话、生成、测评、复盘与收藏；每项记录携带 `userId`，只接受 actor.userId。项目仅给当前活跃成员可读摘要 `{projectId,name,summary}`，禁止队友原始测评、凭据、验证码。limits 给出最大记录数/总字节。`assertProjectAccess(actor, projectIds, executor): Promise<void>` 在生成完成与下载时再次核对全部项目权限，撤权则拒绝交付并建议重新导出。
- `AccountDeletionImpactPort.inspectOwnDeletion(actor, executor): Promise<DeletionImpact>`：读取/锁定本人当前项目成员事实，给出最后管理员项目 `{projectId,name,remediationUrl}` 与影响说明。`remediationUrl` 必须为 `/app/projects/<id>/team`；最后管理员须转交或由根认可的归档流程解决，不能静默删除共享成果。申请/刷新/进入处理时都重查；root 实现须与 M02 管理员变更使用一致锁序及同事务 executor。
- 新公共工厂已经落文件：`new PostgresAccountStore(database, ids, clock)`；`new AccountCompletionService({store,crypto,email,ownData,deletionImpact,clock,ids,policy?})`；`createAccountCompletionHandlers({service,origin,requestIds,clientKeys,readSessionToken,clearSessionCookie})`。后两个 Cookie 值直接取原 `createAuthHandlers` 返回对象；新增 `clearSessionCookie` 仅公开已配置的清 Cookie 文本，不含任何会话令牌。DTO 在 `account-types.ts`、Port 在 `account-ports.ts`，全部服务端工厂从 `auth/index.ts` 导出。
- `AccountEmailPort.sendEmailChangeCode({email,code,expiresAt,purpose:"current_email"|"new_email"}): Promise<void>`：复用 root 真实邮件 transport，只有供应商受理 resolve，缺配置/超时 reject。模块提供专用中文模板适配；验证码不进入 HTTP/审计。发送结果未知标记 `unknown`，该挑战不可用、不自动重发；用户冷却后明确新建挑战才允许新尝试。
- 独立 server-only `beginDeletionProcessing(userId,requestId,expectedRevision)` 已实现，同事务重查阻塞，真正进入处理后标记账号 `deletion_pending` 并撤销会话。不是浏览器 handler，不表示物理删除已经完成；root 仍负责后续跨模块删除/去标识化与保留政策。
- 根后台定期调用 `PostgresAccountStore.clearExpiredExportDocuments(maximum=100):Promise<number>`，每批 1–1000 条，所有账号过期文件清正文/byteLength并标记 expired，保留申请元数据。不暴露 HTTP，不锁 auth_users/session，SKIP LOCKED 避免和本人请求相互长等；幂等并有隔离测试。此维护入口需 root 接入现有后台，不能只靠用户点击过期文件清理。

### HTTP 接入与 DTO

统一成功 `{data,requestId}`、错误 shared envelope；原始 JSON 下载例外为 attachment。所有 POST Origin 精确匹配，拒绝额外 owner/actor 字段。

| 建议路由 | 方法 / handler | 请求 JSON | data |
| --- | --- | --- | --- |
| `/api/v1/me/data-controls` | GET `getDataOverview` | 无 | `AccountDataOverview` |
| `/api/v1/me/data-exports` | POST `requestExport` | `{}` | `DataExportSummary`，queued |
| `/api/v1/me/data-exports/prepare` | POST `prepareExport` | `{id,expectedRevision}` | `DataExportSummary`，ready/failed/expired |
| `/api/v1/me/data-exports/download?id=...` | GET `downloadExport` | 无 | 本人 JSON 文件，no-store |
| `/api/v1/me/deletion-requests` | POST `requestDeletion` | `{confirmed:true}` | `AccountDeletionSummary`，pending/blocked |
| `/api/v1/me/deletion-requests/refresh` | POST `refreshDeletion` | `{id,expectedRevision}` | `AccountDeletionSummary` |
| `/api/v1/me/deletion-requests/cancel` | POST `cancelDeletion` | `{id,expectedRevision}` | `AccountDeletionSummary`，cancelled |
| `/api/v1/me/email-change-challenges` | POST `requestEmailChange` | `{newEmail,expectedRevision}` | `EmailChangeReceipt`，无验证码 |
| `/api/v1/me/email-change-challenges/verify` | POST `verifyEmailChange` | `{challengeId,currentCode,newCode}` | `EmailChangeResult` + 清 Cookie |

服务同名方法第一个参数均为 cookie `sessionToken`；prepare/refresh/cancel 后接 `(id,expectedRevision)`；requestEmailChange 后接 `({newEmail,expectedRevision},trustedClientKey)`，verify 后接 `({challengeId,currentCode,newCode},trustedClientKey)`。`downloadExport(token,id)` 返回 `{filename,json}`。UI 的 requestDeletion 无参数适配需 POST `{confirmed:true}`，因为组件内已明确展示影响及勾选。

SQL 建议 `src/modules/auth/migrations/004_account_completion.sql` 为新增文件，不重写已应用迁移。新增三表 `auth_data_exports`、`auth_deletion_requests`、`auth_email_change_challenges`，复用原 `auth_users` / `auth_sessions` / `auth_rate_limits` / `auth_audit_events`。

### UI props

React 从独立 `auth/ui.ts` 导出，保持 Node `index.ts` 不依赖 TSX。建议两个组件按本人 `profile.id` 设置 React `key`；账号切换必须卸载旧组件，避免旧账号异步结果残留。

- `AccountDataControls({initialState:AccountDataOverview,api:AccountDataControlsApi,onSessionExpired?(),onReauthenticate?()})`。api 方法 `getOverview()`、`requestExport()`、`prepareExport(id,expectedRevision)`、`downloadExport(id)`、`requestDeletion()`、`refreshDeletion(id,expectedRevision)`、`cancelDeletion(id,expectedRevision)`。返回分别为 overview、export summary、export summary、`{filename,json}`、deletion summary；root HTTP wrapper 要解析共享 envelope 并把失败 throw 为带 code/message/recoveryAction 的对象。
- `AccountEmailChange({profile:UserProfile,api:AccountEmailChangeApi,onChanged(result:EmailChangeResult),onReauthenticate?()})`。api 方法 `requestEmailChange({newEmail,expectedRevision})` / `verifyEmailChange({challengeId,currentCode,newCode})`。成功需清 root 当前账号状态并跳到新邮箱登录，不能只更新旧会话中的邮箱文字。验证码仅组件内存，无 localStorage/sessionStorage。未知受理有保守冷却、重新获取；版本冲突保留新邮箱与说明。

## 已完成

- 本人导出请求、限量、固定有效期、失败编号、三次有限整理/重试、下载前再次权限复核和 no-store attachment。服务拒绝混入他人主体及递归安全字段，正文只存在于私有存储与本人下载，overview 最多 20 条且 SQL 层剥离正文。
- 持久删除申请/影响/最后管理员阻塞、幂等、版本化重新检查与取消。申请不撤会话，可信根 worker 进入 processing 才撤；不提供虚假 completed 或队友成果/外部仓库删除。
- 双邮箱短期证明、近期认证、HMAC、发送/验证限流、未知受理封存、过期/消费防重放；邮箱 advisory 锁、唯一索引/保存点恢复、CAS 与稳定 userId。成功撤旧会话及两邮箱旧登录挑战，HTTP 清原 Cookie。
- 对应两个响应式 React 组件、专用邮件模板、Node 公共工厂/类型与 SQL 建议；旧 Auth HTTP 附加清 Cookie 文本供组合，原登录行为保留。

## 验证

`node --experimental-strip-types --test --test-reporter=dot src/modules/auth/*.test.ts`：**127 项全部通过**。其中新增 20 项服务真实 SQL 测试、8 项 SQL 适配测试、4 项 HTTP 边界测试、5 项邮件适配测试，共 37 项。未用真实邮件或生产数据库。

- 模拟外部服务：OwnData/M02 impact/邮件 transport 均注入测试替身，未发送真实邮件/模型/GitHub 请求。
- 实际引擎：一次性内存 PGlite 执行 auth 001–004 建议 SQL；覆盖不同账号隔离、原始资料/安全字段拒绝、SQL 失败事务恢复、限量/有效期/CAS、收集中失效会话、撤权下载；删除阻塞/幂等/取消/处理撤销；邮箱未知受理/冷却/失败次数/总限流/唯一邮箱竞争/版本冲突与恢复/单次消费。不是连接式 PostgreSQL 多连接证明。
- 前端：两 TSX 严格模块类型检查与 SSR 状态检查通过；queued/blocked/取消/申请未完成说明、转交链接防护和初始 0 API 调用已检查。未做浏览器交互或实体手机验收。
- auth 全 `.ts`/`.tsx` 独立严格检查通过：`$authCompletionFiles = @(Get-ChildItem -LiteralPath 'src/modules/auth' -File | Where-Object { $_.Extension -in '.ts','.tsx' } | ForEach-Object { $_.FullName }); & node 'node_modules/typescript/bin/tsc' --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --jsx react-jsx --allowImportingTsExtensions --skipLibCheck next-env.d.ts @authCompletionFiles`。
- 最终全站 `npm run typecheck -- --incremental false` 只剩 `src/modules/space-workflow/service.test.ts:78/333/336` 测试 DTO 缺少新 `branchVerificationSource` 与 DeliveryMaterialsSummary 字段；无 auth 错误。本会话未越界修改其它模块，根组合后重跑即可。

## 未接入

root 汇总本人数据、M02 最后管理员事实锁、App Router/账号页、后台过期文件清理调度、递增实际迁移、真实邮件与连接式 PostgreSQL 多连接验收。实际删除/去标识化、法定/审计保留范围及期限仍由根明确并接入；本轮交付的是删除申请入口与真实进入处理的会话规则，未宣称物理删除已完成。

## 环境变量名称

沿用 `AUTH_CODE_PEPPER`、`AUTH_ORIGIN`、`AUTH_EMAIL_FROM`、root 邮件 transport 配置与 `DATABASE_URL`；不读取或输出值。
