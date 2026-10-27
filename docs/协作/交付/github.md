# M06 GitHub 助手与赛事交付

状态：2026-10-08 主会话重新授权的 GitHub App 授权/凭据/发现/显式建库已完成并公开导出；模块194项测试通过。模块与全部子代理已停止修改，主会话可接管。下方前次交付验证记录保留；新接口如下，接口签名在 `authorization-types.ts`。

## 本轮接线约定

仅 GitHub App 的 user access token，不支持 OAuth App/PAT/installation token 冒充。GitHub 当前官方已支持 App 的 PKCE S256；请求 `scope=offline_access` 使令牌必须含过期与 refresh。注册 GitHub App 时分别配置 OAuth callback 和 installation setup URL，并关闭“Request user authorization (OAuth) during installation”（该选项与独立 setup URL 互斥）；本实现先独立用户授权后安装，setup 的 Redirect on update 可开启。个人写入需要 Contents write，可选 Pull requests write；建库需要 Repository creation write 或官方允许的 Administration write，不能把 Contents write 认作建库权限。

- 已导出 `GitHubAuthorizationService({options,store,cipher,http,access,clock,ids})`，同时实现既有 `GitHubCredentialPort` 与新的 `GitHubUserCredentialProvider`。`index.ts` 已公开所有6个新class和 `createGitHubAuthorizationHandler(action,deps)`（action-first，与旧handler参数顺序不同）。
- `GitHubAppOptions`：`appId/clientId/clientSecret/appSlug/origin/callbackUrl`，可选 `stateTtlSeconds`（默认600）、`refreshSkewSeconds`（默认60）。`callbackUrl` 与 `origin` 同源，生产 HTTPS，开发仅 loopback HTTP。
- HTTP：`GitHubAppAuthorizationHttpAdapter(options,{fetch?,clock?,timeoutMs?,maxResponseBytes?,maxPages?})`；SQL：`PostgresAuthorizationStore(database)`；cipher：`AesGcmCredentialCipher({activeKeyId,keyring:Record<keyId,base64_32_byte_key>})`。keys 从受控 config 传，不默认生成 ephemeral key；旧 keyring 供解密轮换。
- Environment 接线名称：`GITHUB_APP_ID`、`GITHUB_APP_CLIENT_ID`、`GITHUB_APP_CLIENT_SECRET`、`GITHUB_APP_SLUG`、`GITHUB_TOKEN_ENCRYPTION_KEY`，可选 `GITHUB_TOKEN_ENCRYPTION_KEY_ID`（默认v1）与 `GITHUB_TOKEN_ENCRYPTION_PREVIOUS_KEYS` JSON keyring；key 是标准带padding base64的32字节。主会话 config callback 从 `AUTH_ORIGIN` 派生；可选 `GITHUB_CALLBACK_URL` 仅用于校验与该路由相同。DB 复用 `DATABASE_URL`/现有 DatabasePort。不使用 App private key/installation token 代替用户。
- handler 工厂接已有可信 `resolveActor/requestId/assertMutationAllowed`（接口同 GitHubHandlerDependencies 的 auth hooks），固定以下动作；callback GET 用 single-use state +当前网站Actor+HttpOnly浏览器cookie校验，不按 JSON userId 关联。

| Method / 建议路径（/api/v1） | action | payload / 响应 |
| --- | --- | --- |
| POST `/github/authorization/start` | `authorization.start` | `{projectId?:string}` -> `{authorizationUrl,expiresAt}`，服务端 Set-Cookie，前端跳转 authorizationUrl |
| GET `/github/authorization/callback` | `authorization.callback` | GitHub query `code/state` -> 303到该项目delivery或 `/app/account`；不回显code/token |
| GET `/github/authorization` | `authorization.status` | 自己的绑定身份与状态、expiry，无token |
| DELETE `/github/authorization` | `authorization.revoke` | 无body -> 本站立即撤销+远端撤销单独结果 |
| POST `/github/installation/start` | `installation.start` | `{projectId?:string}` -> `{installationUrl,expiresAt}`+cookie，GitHub consent由用户点击 |
| GET `/github/installation/callback` | `installation.callback` | App setup URL，query `state/installation_id` 实际App/user发现验证后303 |
| GET `/github/installations` | `installations.list` | 当前GitHub用户可见且App ID相符的安装，无任意installation跳过 |
| GET `/github/repositories?installationId=<id>` | `repositories.list` | 当前用户+指定已验证App安装的仓库白名单DTO，映射既有binding六字段 |
| POST `/projects/:projectId/repository-creations/preview` | `creation.preview` | `{name,description?,private:boolean,idempotencyKey}` -> 15分钟preview+confirmationHash+owner；必须显式选择公开/私有 |
| GET `/projects/:projectId/repository-creations/:operationId` | `creation.get` | 建库真实状态 |
| POST `/projects/:projectId/repository-creations/:operationId/confirm` | `creation.confirm` | `{confirmationHash}` -> 只此步骤POST /user/repos，personal owner由GitHub身份确定，auto_init:true |
| POST `/projects/:projectId/repository-creations/:operationId/reconcile` | `creation.reconcile` | 无body，仅远端GET核对，不重复POST；不能因同名仓库存在就冒称本操作成功 |

新库创建不自动绑定/写文件：新仓库可能还不在 App selected scope，前端引导安装范围更新→刷新发现→明确绑定→沿原manifest预览保存confirm。scope=offline_access不授予仓库权限。新SQL建议 `sql/authorization.sql` 与 `sql/repository-creation.sql` 已交付，主会话纳入递增迁移，不重写已应用迁移。

**迁移接线提醒**：最终授权SQL新增 `epochs.revocation_in_progress`、`credentials.revocation_pending`，身份唯一索引为 `WHERE status<>'revoked' OR revocation_pending`。本会话只读看到主会话早先复制的 `migrations/013_github_authorization.sql` 尚不含这两个门禁字段；主会话执行前需使用最终SQL，若已应用则新增后续迁移，不能改历史。本会话未改根迁移。撤销 API 本地先commit、远端grant处理后 `finishRevocation` 按epoch CAS释放门禁；旧callback与跨账号占用都被挡住。

远端撤销 `unknown` 不能声称远端已完成；本地解除后允许重新连接，但迟到grant删除仍可能使新token失效。每次服务器获取token都请求 `/user` 复核，401转 `reauthorize_required` 并拒绝写入；README与测试明确此边界。`bound` 是本地身份绑定状态，不代表实时安装/权限。

## 本轮完成与验证

- App 授权服务、固定HTTP adapter、加密SQL vault、刷新/撤销、实际身份核对、installation/setup 与仓库发现；一次性state按网站user/App/browser/flow/expiry关联，PKCE verifier 与token分别用身份上下文的AES-256-GCM认证加密，密钥轮换可读旧key。
- 个人仓库创建预览/显式确认/只读核对及PostgreSQL幂等/CAS/审计；auto_init:true，新库不自动绑定；201已有可信ID时保存ack，即使初始化GET失败也不能伪装失败后盲重POST。公开/私有必填，350个Unicode code point说明在预览和HTTP adapter一致。
- 12个新handler动作已导出，server Actor/CSRF、64KiB JSON、callback browser cookie、303安全返回、敏感响应防线，unknown/creating返回202。
- `node scripts/run-module-tests.mjs github` **194/194通过**（约2.7秒）；新增104项：handler17、HTTP16、authorization service19、vault/authorization SQL23、creation25、creation SQL4。
- 授权SQL的12项与创建SQL的4项使用真实临时PGlite执行SQL与PLpgSQL回滚触发器；另有2项授权SQL错误/输入mock、9项crypto测试。PGlite为单连接本地fixture，不等于多连接网络PostgreSQL验证；其他业务/HTTP测试按注入Port/fetch夹具隔离外部。
- 本轮曾在修复自己的test fixture类型后全局 `npm run typecheck` 通过。最终重复检查时主会话同期 `src/server/background.ts:7,34,35` 缺少 `dshBackend` 类型而失败；没有M06错误，本会话未改server。模块严格ES2022 NodeNext入口及全部测试检查见README。
- 没有使用真实GitHub凭据、创建仓库、保存用户文件、生成PR、采购/发布服务；两个新SQL只在临时测试DB执行，本会话未执行根迁移。

所需应用接线、12路径/payload、callback/setup注册选项、密钥格式与env已明确。主会话仍须把服务接实际会话/DatabasePort、更新根迁移到最终schema、配置App并验收真实GitHub；定期调用 `PostgresAuthorizationStore.purgeExpiredStates(nowISO)` 清理短期授权state。首次授权成功不等于App仓库安装或写入权限。

## NEEDS_INTERFACE

- M01/主会话：可信网站Actor/session与CSRF/origin接线；本模块现有 `GitHubAuthorizationService` 同时实现 `getUserCredential(actor,target)` 与 `getAuthorizationCredential(actor)`，返回服务器内App用户token。主会话用该实例替换原 `GITHUB_NOT_CONFIGURED` 占位并接12条路由；禁止浏览器提交token，安装令牌不用于个人写入。M06每次验证实际身份、安装、仓库与权限。
- M02/主会话：已有 `ProjectAccessPort.getMembership(projectId,userId)` 每次检查活跃成员。另注入 `DeliveryCapabilityPort.getCapabilities(projectId,userId)` 返回 `saveRepository/verifyDelivery/recordSubmission` 布尔能力；项目管理员绑定仓库，但仍须 GitHub 实际权限。例如已移除成员不能开始写入，manager 只读 GitHub 不能保存。
- M03/主会话：`ConfirmedRequirementsPort.assertConfirmed({projectId,eventId,stageId,requirementsVersion,platformUrl})`，仅接受该项目当前确认的赛事阶段/规则版本与正式提交 URL；例：旧规则版本返回冲突并要求复核。
- 主会话：真实 `DatabasePort`、可信会话 resolver 与 HTTP route 接线。临时文本草稿使用私有 PostgreSQL 表，默认 24 小时过期，并接入定期 `purgeExpired`；Token 不进入该表。
- M03/主会话：交付材料清单与比赛指定分支/公开性核对尚待组合；现有摘要明确返回 `requirements.status=not_loaded` 和 `mergeStatus=not_verified`，不能据独立分支保存或 PR 创建认定交付材料已满足。
- 主会话：页面与受控后台执行/队列尚待组合；已有 handler 工厂与服务可直接接线，未知结果保持 202，不得用演示或内存状态回退为成功。
- M07：调用 M06 `DeliveryService` 写入验收/用户提交，复用本模块三状态摘要；不得维护第二份成功事实。M05 读取保存/验收记录只能建议更新任务。

## 前次已完成记录

- `index.ts` 公共服务端导出；README 含组合示例、17 类 handler action、路由/请求映射与恢复规则。
- `RepositoryBinding` 管理员绑定、版本 CAS 与断开；拒绝额外 DTO 字段及 nested token；OAuth/vault 以服务器 Credential Port 注入。
- manifest 与全文预览：相对路径、NFC/大小写/祖先碰撞、文本/体量/依赖/工作流/疑似密钥、明确删除、远端目录/symlink/submodule、防目录覆盖、执行权限保留。
- `GitOperation` 持久化幂等/CAS/lease；预览 hash 绑定操作、目标、说明、PR 选择与基版本；旧基 head 阻止；一次 tree/commit、独立分支、精确核对；未知结果不盲重写；owner-only 草稿取回。
- GitHub HTTP adapter 固定 GitHub.com + REST `2026-03-10`；live user/App/installation/repository 权限交集、每次写前更新、参数与响应校验、超时/网络/5xx 未知结果、速率限制时间、无敏感 provider error 输出；支持真实 HTTP，但未携凭据调用。
- PR 创建/失败/未知分别保存。查询失败不能把历史未知 POST 降级为失败后再重写；全状态精确 head/base 查找；无合并能力。
- PostgreSQL 操作/草稿/审计适配与私有短期文本；24h TTL，清理提升 SQL/JSON revision 防旧快照恢复过期明文；事务配额 40 草稿/40 MiB。
- `DeliveryVerification` 与 `SubmissionRecord` 唯一事实源，人工验收证据约束、仅 user_reported 提交、确认规则 Port、版本 CAS 追加历史、事实事件与数据同事务。
- 三状态摘要不会由 commit 推断运行/赛事成功；明确合并和规则材料尚未自动核对。
- 集成审查修复：运行摘要仅使用当前 `latestSavedOperation.commitSha` 的最新匹配验收；旧 commit 通过不升级新 commit，无关联/null commit 只保留独立历史。`runtime.currentCommitSha/matchStatus/latestHistoricalVerification/verificationHistory` 显式区分当前依据和历史，没有已保存版本时为 `unknown`。
- 两份模块内 SQL 迁移建议，未执行实际迁移。

## 前次已验证记录

`node scripts/run-module-tests.mjs github`：90/90 通过（约 1.7 秒）。覆盖路径/体量/凭据、四层权限、活跃成员与 manager、跨项目/用户、预览版本、同时确认、明确失败补步骤、分支响应丢失、未知 commit 与 PR 不重写、绑定撤销、草稿过期/篡改、数据库 CAS/事务/审计回滚、TTL 清理修订号、handler 会话/CSRF/envelope 与独立事实摘要。新增 `tests/delivery-summary.test.ts` 的 11 项回归覆盖旧 commit 通过不升级新版本、当前相同 SHA 的三种结论、其他/无关联验收只入历史、缺少已保存 SHA 保持未知、草稿/未知操作不替换已确认版本的真实依据。

公共入口与本轮变更测试的定向严格 TypeScript 检查通过：`node node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --skipLibCheck src/modules/github/index.ts src/modules/github/tests/delivery-summary.test.ts src/modules/github/tests/handlers.test.ts`。

本轮 `npm run typecheck` 报告 M02 同期字段错误：`projects/postgres.ts:113`、`projects/service.ts:461` 缺少 `resourceVersion`，`projects/tests/service.test.ts:499,536` 的资源 Port fixture 缺少 `version`；未报告 M06 错误，本会话未越界修复。初次交付时本会话全局类型检查通过，随后主会话曾报告全局 531 项测试与类型检查通过；这些是之前的验证结果，不替代本轮报告。

本轮按主会话集成审查修改 `delivery-summary.ts`、handler 测试 fixture、README，新增 11 项摘要回归并更新本文；未修改事实实体、数据库迁移或其他模块。`runtime.latestVerification` 现专指当前已保存 commit 的匹配记录，独立历史见新增字段；选择基准沿用现有按操作 `createdAt/id` 排序的 `latestSavedOperation`，不表示默认分支或部署版本。模块及子代理再次停止编辑，主会话可接管；剩余接线事项均已列入 `NEEDS_INTERFACE`。

## 当前模拟边界与未接入

- HTTP测试使用注入fetch，服务测试使用模块fixture；新授权/创建SQL按上述临时PGlite真实执行，旧保存/交付SQL沿用mock，未验证网络PostgreSQL多连接并发。
- GitHub App用户授权/vault/刷新/撤销/发现/创建已实现，尚无本会话的真实App与用户凭据验收；没有实际GitHub写入、PR或赛事提交，也未采购/部署。主会话现有数据库连接由主会话组合，本模块仅注入DatabasePort。
- 主会话仍需组合 App Router、可信会话及 CSRF 策略、M02/M06 能力配置、M03 已确认规则/材料与要求分支检查、数据库迁移、定期 TTL 清理、操作后台执行/队列与页面。handler 已可调用；没有独立初始化应用。
- Webhook、ZIP/二进制/LFS、已有任意空仓库的初始化、完整Git、组织建库、主分支更新、自动合并/部署与自动赛事提交未实现。新个人库支持显式auto_init:true创建并核验初始化。
- 未知 immutable object 且 SHA 未获知、未知 PR 且无远端证据时保持 unknown，提供草稿取回/原生处理路径，不能把模拟成功或用户声明展示成真实/平台确认。

## 环境变量名称

模块自身不读取环境变量；主会话真实PostgreSQL接线使用 `DATABASE_URL`，授权所需名称已在上方本轮接线约定确定。`GITHUB_TOKEN_ENCRYPTION_KEY` 是标准base64 32字节，旧密钥通过 `GITHUB_TOKEN_ENCRYPTION_PREVIOUS_KEYS` 提供。没有环境变量值，也没有凭据写入普通日志/操作记录。

## 集成入口

详见 `src/modules/github/README.md`。M07 通过 `DeliveryService.recordVerification/recordSubmission/updateSubmission` 委托，`listSubmissions` 包含全部历史，当前状态按 ID 取最大 version；`getDeliverySummary` 已处理这一点。M05 只接保存/验收事件作为建议，不自动完成运行任务。

## 网页入口（2026-10-09）

新增独立 `/github` 页面作为新手入口，按“注册 GitHub → 连接本站 → 选择或创建仓库 → 读取基版本/取回草稿 → 预览并保存 commit → PR、运行验收、赛事提交”的顺序讲解。页面用 `main → feature/你的任务 → PR 合并` 图形说明分支关系，并单独解释 Pull、Commit、冲突恢复。公共导航增加 `GitHub` 链接；真实授权与写入仍从项目的“仓库与交付”页触发，页面明确区分本站登录和 GitHub 授权，并列出未知结果、权限不足和冲突的恢复路径。

页面只提供官方注册、Clone、Pull Request 文档的跳转和本站已接入能力说明，不接收密码、验证码或 PAT，也不把教程阅读当作授权成功。首版网页端“拉取”指读取远端基版本和恢复本站本人草稿；需要完整本地工作区仍应按 GitHub 官方 Clone 说明操作。`npm run typecheck` 已通过；本轮未使用真实账号、仓库或外部写入。

官方核对：[Git tree/base_tree](https://docs.github.com/en/rest/git/trees)、[精确 ref](https://docs.github.com/en/rest/git/refs)、[App 权限交集](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)；其余接口链接在 README 与 adapter 文件头。
