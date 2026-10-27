# M06 GitHub 助手与赛事交付

本模块提供服务器端业务服务、GitHub REST HTTP 适配、PostgreSQL 适配及可由主会话接线的 HTTP handler 工厂。没有真实凭据接入记录；没有创建或修改任何实际仓库。

## 公共入口

`index.ts` 导出业务类型与以下实现。整个入口用于服务端，客户端仅可使用类型或经过服务端投影的 JSON，不得把凭据提供者、适配器或数据库对象打包到浏览器。

| 导出 | 用途 |
| --- | --- |
| `GitService` | 项目仓库绑定/断开、草稿、预览、确认保存、未知结果核对、草稿取回与 PR 继续入口 |
| `validateManifest / buildPreview / hashInput` | 文本/路径/凭据校验、基版本差异、稳定内容哈希 |
| `GitHubHttpAdapter / GitHubHttpError` | 固定 GitHub.com REST API、服务器用户令牌、限时请求与安全错误 |
| `PostgresGitRepositoryStore / PostgresDraftStore` | 参数化 SQL、幂等唯一键、修订号 CAS、短期私有文本草稿 |
| `DeliveryService / PostgresDeliveryStore` | 唯一的人工运行验收与用户提交事实；不可变提交历史和事务事实事件 |
| `getDeliverySummary` | 三类事实分别返回，按当前确认规则和保存commit汇总真实材料/分支核对 |
| `DeliveryMaterialsService / PostgresDeliveryMaterialsStore` | 正式规则Port、事务内权限锁、版本CAS、幂等与不可变逐项核对历史 |
| `createGitHubMaintenance / GITHUB_MAINTENANCE_INTERVAL_MS` | 根后台每5分钟清过期正文与授权state，不调用GitHub |
| `createGitHubHandler` | 可信会话 + 必需 CSRF/来源策略 + 中文错误 envelope，未知结果返回 202 |
| `GitHubAuthorizationService` | App 用户授权、一次性 PKCE/state、当前身份核对、令牌刷新/撤销、安装与仓库发现；实现两个服务器凭据 Port |
| `GitHubAppAuthorizationHttpAdapter` | 固定 GitHub.com OAuth/REST 的 expiring App 用户令牌与个人建库 HTTP 实现 |
| `AesGcmCredentialCipher / PostgresAuthorizationStore` | AES-256-GCM 密钥轮换、加密 token/verifier、用户/App/身份绑定、CAS/刷新与撤销门禁 |
| `RepositoryCreationService / PostgresRepositoryCreationStore` | 明确个人 owner/可见性的 15 分钟创建预览、确认、已知 ID 的初始化核对 |
| `createGitHubAuthorizationHandler(action,deps)` | 12 个授权/安装/发现/创建动作，HttpOnly 浏览器校验与可信会话/CSRF |

## GitHub App 接线

只接 GitHub App 用户令牌。GitHub App 当前支持 PKCE S256；`scope=offline_access` 要求返回 expiring `ghu_` access token 和 `ghr_` refresh token，它不扩大 App 仓库权限。注册 App 设置 callback `${origin}/api/v1/github/authorization/callback` 与 installation setup `${origin}/api/v1/github/installation/callback`；本流程先独立用户授权再安装，因此关闭“Request user authorization (OAuth) during installation”（该选项会禁用独立 setup URL），启用 setup 的“Redirect on update”方便用户更新选定仓库后返回。安装 URL 携 state，回调 installation_id 仍必须核查实际用户可访问的 App 安装。保存需 Contents write，PR 需 Pull requests write；个人建库需 Repository creation write 或 GitHub 支持的 Administration write。OAuth App、PAT、installation token 均不作为本站用户令牌的替代。

```ts
import {
  GitHubAuthorizationService, GitHubAppAuthorizationHttpAdapter,
  AesGcmCredentialCipher, PostgresAuthorizationStore,
  RepositoryCreationService, PostgresRepositoryCreationStore,
  createGitHubAuthorizationHandler,
} from "./index.ts";

const authorizationHttp = new GitHubAppAuthorizationHttpAdapter(options, { clock });
const credentials = new GitHubAuthorizationService({
  options, access: projectAccess, clock, ids, http: authorizationHttp,
  store: new PostgresAuthorizationStore(database),
  cipher: new AesGcmCredentialCipher({
    activeKeyId: keyId, keyring: { ...previousKeys, [keyId]: credentialKey },
  }),
});
const creation = new RepositoryCreationService({
  appId: options.appId, http: authorizationHttp, credentials,
  access: projectAccess, capabilities,
  store: new PostgresRepositoryCreationStore(database), clock, ids,
});
const start = createGitHubAuthorizationHandler("authorization.start", {
  authorization: credentials, creation, resolveActor: sessionResolver,
  assertMutationAllowed: csrfPolicy, requestId: () => ids.next(),
});
// GitService 的既有 credentials 参数直接使用上述 credentials。
```

`options` 为 `GitHubAppOptions {appId,clientId,clientSecret,appSlug,origin,callbackUrl,stateTtlSeconds?,refreshSkewSeconds?}`；state 默认600秒（60–900），刷新提前60秒（0–300）。origin/callback 同源，生产 HTTPS，HTTP 仅 loopback。主会话配置使用 `GITHUB_APP_ID`、`GITHUB_APP_CLIENT_ID`、`GITHUB_APP_CLIENT_SECRET`、`GITHUB_APP_SLUG`、`GITHUB_TOKEN_ENCRYPTION_KEY`，可选 `GITHUB_TOKEN_ENCRYPTION_KEY_ID`（默认v1）和 `GITHUB_TOKEN_ENCRYPTION_PREVIOUS_KEYS`（JSON keyring），origin 复用 `AUTH_ORIGIN`。每个密钥是32字节的标准带 padding base64；保存受控持久化密钥，轮换时保留旧 keyring 解密已有数据。模块不读取环境变量，不自动生成临时生产密钥。

| `/api/v1` 路由与方法 | action | 关键输入/结果 |
| --- | --- | --- |
| `POST /github/authorization/start` | `authorization.start` | `{projectId?:string}` → `{authorizationUrl,expiresAt}` + HttpOnly cookie，前端跳转 |
| `GET /github/authorization/callback` | `authorization.callback` | `code/state`；当前网站 Actor + 发起浏览器 cookie；303 回项目delivery或 `/app/account` |
| `GET /github/authorization` | `authorization.status` | `bound/not_connected/refreshing/reauthorize_required`、身份、expiry，无凭据 |
| `DELETE /github/authorization` | `authorization.revoke` | 无 body；`{status:'revoked',remoteStatus:'revoked'|'unknown'|'not_attempted'}` |
| `POST /github/installation/start` | `installation.start` | `{projectId?:string}` → `{installationUrl,expiresAt}` + cookie |
| `GET /github/installation/callback` | `installation.callback` | `state/installation_id`；实际当前用户/App 安装发现核验后303 |
| `GET /github/installations` | `installations.list` | 当前用户可见、App ID相符且未暂停的安装 |
| `GET /github/repositories?installationId=<id>` | `repositories.list` | 先核验安装可访问，再返回仓库/权限白名单 DTO |
| `POST /projects/:projectId/repository-creations/preview` | `creation.preview` | `{name,description?,private:boolean,idempotencyKey}` → owner、操作、confirmationHash |
| `GET /projects/:projectId/repository-creations/:operationId` | `creation.get` | 本人且有项目访问权的操作状态 |
| `POST /projects/:projectId/repository-creations/:operationId/confirm` | `creation.confirm` | `{confirmationHash}`；仅此步创建 initialized 个人仓库 |
| `POST /projects/:projectId/repository-creations/:operationId/reconcile` | `creation.reconcile` | 无 body，只读核对，不重发建库 |

每个授权流程独立随机 state、PKCE verifier、浏览器 nonce，数据库仅存 state/nonce SHA-256 和加密 verifier。cookie 动态名称支持多标签，HttpOnly/SameSite=Lax/HTTPS Secure。回调的状态记录在正确网站用户、浏览器、flow 和 expiry 下原子消费；错误用户或安装/授权用途互换不消费合法记录。回调不回显 code/token，不接受任意 returnTo。GitHub ID 已绑定时换账号须先解除；SQL 限制同一 App/GitHub ID 不能同时绑定两个网站账号。

refresh token 单次使用，CAS 先领取刷新；超时/结果未知、过期 lease 均清空本地凭据并要求重新授权，不重放旧 refresh。撤销先清本地密文与待处理 state、递增 epoch，阻止旧回调恢复绑定。远端 grant 撤销执行期间，epoch 门禁阻止新授权，同时保留该身份唯一占用；finish 只释放相同 epoch 的门禁，不持有网络数据库长事务。进程在 finish 前退出会留下门禁，用户可再次执行撤销恢复。

`remoteStatus=unknown` 表示远端解除未确认；完成本次本地撤销后允许重新连接。如果超时的远端删除迟到，新授权仍可能失效。`bound` 表示本站绑定记录，不证明当前 GitHub 权限；每次获取服务器凭据都实际请求 `/user` 核对，401 会转为重新授权，既有保存 HTTP 适配仍核查安装/仓库/权限交集。测试覆盖此未知边界，不把重新连接标为远端撤销已确认。

建库仅 active Project manager + `saveRepository` 能力 + 真实 GitHub 用户身份。预览固定 owner、description、明确公开/私有与 `auto_init:true`；用户确认后 CAS 领取才 POST `/user/repos`。201 已可信确认 ID 但初始化 readback 失败时保存 ID、保持 unknown；只读核对同 ID 且 initialized 后才成功。没有创建确认 ID 时，出现同名仓库仍不能证明由该操作创建。新库不自动绑定、更新 App 范围或保存文件；用户安装范围更新、刷新发现后再明确绑定和进行文件预览/保存确认。

官方依据：[App 用户令牌与 PKCE](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)、[单次 refresh](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)、[用户安装发现](https://docs.github.com/en/rest/apps/installations)、[注册选项](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)、[安装 state](https://docs.github.com/en/apps/sharing-github-apps/sharing-your-github-app)、[setup ID 核验](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)、[token/grant 撤销](https://docs.github.com/en/rest/apps/oauth-applications)、[个人仓库创建与权限](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user)。

## 主会话组合

下面的依赖变量由主会话提供真实实现；不是独立应用或演示数据回退。

```ts
import {
  GitService, GitHubHttpAdapter, PostgresGitRepositoryStore, PostgresDraftStore,
  DeliveryService, PostgresDeliveryStore, createGitHubHandler,
} from "./index.ts";

const git = new GitService({
  access: projectAccess, capabilities, credentials,
  github: new GitHubHttpAdapter(),
  store: new PostgresGitRepositoryStore(database),
  drafts: new PostgresDraftStore(database), clock, ids,
});
const delivery = new DeliveryService({
  access: projectAccess, capabilities, requirements,
  store: new PostgresDeliveryStore(database), clock, ids,
});
const confirm = createGitHubHandler({
  git, delivery, resolveActor: sessionResolver,
  assertMutationAllowed: csrfPolicy, requestId: () => ids.next(),
}, "operations.confirm");
// Next App Router wrapper passes await context.params to confirm(request, params).
```

`GitHubCredentialPort.getUserCredential(actor,target)` 只接受已完成安全绑定的网站用户与 GitHub 身份；返回 `tokenKind=github_app_user` 的短期用户令牌，数据库只保存认证加密密文，明文不进入审计、JSON 或错误。每次写 endpoint 会重新核查用户 ID、App ID、安装是否暂停、指定仓库 ID 与当前用户/App 权限交集。OAuth callback/state、加密 vault、令牌刷新与撤销使用上述服务接线。

`DeliveryCapabilityPort` 显式给出 `saveRepository/verifyDelivery/recordSubmission`；活跃项目成员资格始终同时检查，平台角色、项目 manager 和 Team captain 均不替代 GitHub 写权限。绑定/断开另要求活跃 Project manager。

`ConfirmedRequirementsPort.assertConfirmed` 校验项目确认的赛事、阶段、规则版本与提交 URL。M07 使用 `DeliveryService` 委托写事实并读摘要，不新增验收/提交表；M05 不由保存事件直接完成运行任务。

## 请求接线表

前缀 `/api/v1/projects/:projectId`；动作由路由模块固定，不能由请求 JSON 决定。服务方法均以服务器 Actor 为首参数。

| 路由与方法 | 工厂 action | 关键输入 |
| --- | --- | --- |
| `GET /repository-binding` | `binding.get` | 无 |
| `PUT /repository-binding` | `binding.put` | `target` 六字段；初次 `expectedRevision:null`，后续当前修订号 |
| `DELETE /repository-binding` | `binding.delete` | `expectedRevision`；仅断开本站项目绑定 |
| `POST /git-operations` | `operations.create` | `changes[] / idempotencyKey / message / wantsPullRequest?` |
| `GET /git-operations` | `operations.list` | 最近 100 个操作 |
| `GET /git-operations/:operationId` | `operations.get` | 状态、清单、预览、已确认 SHA 与 PR 结果 |
| `GET /git-operations/:operationId/draft` | `operations.draft` | 草稿原内容，仅上传者且仍有项目访问权可取回 |
| `POST /git-operations/:operationId/preview` | `operations.preview` | 无；生成确认哈希 |
| `POST /git-operations/:operationId/confirm` | `operations.confirm` | `previewHash` |
| `POST /git-operations/:operationId/reconcile` | `operations.reconcile` | 无；仅核对，不写 GitHub |
| `POST /git-operations/:operationId/pull-request` | `operations.pull-request` | 无；已保存版本的可选 PR 继续/核对 |
| `GET/POST /delivery-verifications` | `verifications.list/create` | `RecordVerificationInput`；通过需环境、步骤、证据，无阻塞 |
| `GET/POST /submission-records` | `submissions.list/create` | `RecordSubmissionInput`；按赛事阶段，已提交需时间与证据 |
| `PATCH /submission-records/:recordId` | `submissions.update` | `expectedVersion` + 完整可编辑输入，新版本追加 |
| `GET /delivery-summary` | `summary` | 三种独立事实与各自依据 |
| `GET/PUT /delivery-materials` | `materials.get/save` | `DeliveryMaterialsView` / 完整`SaveDeliveryMaterialsInput`，PUT返回`DeliveryMaterialChecklist` |
| `GET /delivery-materials/history` | `materials.history` | 当前授权项目全部不可变清单版本 |

预览/核对/PR 动作可以无 body；其他 mutation 接受 JSON。请求最大 6 MiB，可信身份字段由服务器填写。handler 需放在 Node runtime，主会话若使用队列应让受控 worker 调用同一服务；本模块未提供后台任务队列或浏览器直连令牌方案。

## 保存与恢复规则

- 绑定入口要求仓库已初始化；新个人仓库可先走创建预览/确认及安装发现流程。全部文件保存写入独立 `hackathon/<operation digest>` 分支。只创建 ref，不更新主分支、不强推、不自动合并。
- 只支持普通 UTF-8 文本和显式删除；单次 100 文件、单文件 1 MiB、总量 5 MiB，路径最多 1024 UTF-8 字节。拒绝 Git 内部文件、依赖/构建输出、工作流、凭据路径、疑似密钥、非法路径、大小写/NFC/祖先冲突、符号链接及子模块。检测通过不保证不存在所有密钥。
- `previewHash` 绑定操作 ID、完整操作输入（说明、PR 选择、绑定版本）、目标分支/仓库、内容与基版本。未明确指定执行权限时保留远端 regular executable mode。
- 确认时重查权限与基分支 head。使用 `base_tree` 创建所选变化的一棵 tree，再创建单 parent 的一次 commit；未选文件保留，目录覆盖拒绝。查询精确 ref、commit parent/tree/message 后才保存 `saved`。
- Actor/项目/幂等键作用域有唯一约束，相同键不同输入返回 409；已存在操作在占用草稿配额前返回。外部请求前 CAS 领取操作，保存 SHA 与步骤，不把 GitHub I/O 放在长数据库事务内。
- `saving` 有 5 分钟恢复 lease，存活 lease 期间核对入口不启动第二个写入。明确失败且已有 tree/commit 可读取核对，转回待确认，用户再次确认后只补缺失步骤。
- 分支响应丢失：先读精确分支和已知 commit 核对；commit/树创建响应丢失且 SHA 未获知时保持 `unknown`，不盲目重复创建。上传者可在有效期内取回草稿，使用原生流程处理或明确建立新操作。
- 已保存版本的 PR 失败不撤销保存事实。PR 创建结果未知时查所有状态的精确 head/base；查询失败或查不到仍保留 `unknown`，不因一次失败查询重发 POST。可由用户使用 GitHub 比较页人工继续。
- 初始 draft 24 小时过期；可安全清理的草稿及预览正文由 `PostgresDraftStore.purgeExpired(nowISO)` 同事务删除/置空、递增CAS，保留manifest/hash/commit；执行中与结果未知等必要恢复正文保持，具体条件见C04补完。根接定期maintenance，旧请求不能写回已清正文。项目活跃草稿上限40个、40 MiB JSON（单份JSON 6 MiB），事务锁保护配额。

保存成功仅表示独立分支已有版本；是否公开及是否满足比赛要求仍需核对。根注入材料服务后`getDeliverySummary`返回实际规则与逐项状态；未接入材料服务时保留`requirements.status=not_loaded`及人工核对入口。M03当前没有结构化要求分支时保持未知，不拿默认分支、PR或操作分支冒充达标。

运行摘要以 `repository.latestSavedOperation.commitSha` 为当前已保存版本，返回 `runtime.currentCommitSha`。`runtime.latestVerification` 只选相同 commit 的最新验收，其 outcome 才决定当前运行状态；当前版本没有验收时为 `not_verified`，没有已保存 commit 时为 `unknown`。`matchStatus` 分别为 `matched/no_matching_verification/no_saved_commit`。`latestHistoricalVerification` 与 `verificationHistory` 保留其他版本及无 commit 关联的独立演示记录，不能用这些历史结论升级当前版本。

## PostgreSQL 与验证

`sql/git.sql`、`sql/delivery.sql`、`sql/authorization.sql`、`sql/repository-creation.sql` 都是迁移建议，主会话将其纳入实际迁移并连接项目/用户/赛事外键。本模块不执行根迁移。验收与提交事件分别追加 `DeliveryValidationRecorded/SubmissionRecorded`；消费者按 event ID/aggregate version 去重，事件不含文件、证据全文或 token。授权事件只记身份/状态/修订等元数据，密文和 verifier 不进入事件；私有授权表不能对浏览器查询。不可变历史触发器的维护/数据清除需主会话统一保留策略与维护路径。

```powershell
node scripts/run-module-tests.mjs github
npm run typecheck
```

2026-10-08：本轮授权/创建补完后 **194项 node:test 通过**，比前次90项新增104项。授权SQL12项与创建SQL4项使用临时PGlite实际执行SQL/CAS/PLpgSQL回滚触发器（单连接fixture），其余crypto/业务/fetch与SQL错误测试使用注入夹具。未验证网络PostgreSQL多连接、真实App权限、分支ruleset、GitHub写入或赛事平台提交。生产持久化只提供PostgreSQL适配，无生产内存回退。

模块严格检查：`node node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --skipLibCheck` 加本模块全部 `.ts` 文件。全局 `npm run typecheck` 本轮曾通过；最后检查因主会话同期 `src/server/background.ts` 的 `dshBackend` 接线类型失败，未报告本模块错误，未越界修改。

模块不直接读取环境变量。组合层env与密钥格式见上方GitHub App接线；数据库复用 `DATABASE_URL`/既有DatabasePort。本模块不需要installation token或App private key代替个人写入。主会话按下述maintenance工厂清理短期state与正文；旧密钥保留到存量密文完成轮换。

## C04 材料清单与正文清理补完（2026-10-10）

`ConfirmedDeliveryRequirementsPort.readConfirmed(actor,projectId,executor?)` 读取当前 M03 确认快照：赛事/确认版本、材料required/optional/unknown、规则证据、要求分支specified/not_required/unknown、阶段真实提交截止及未知项。不从自动发现、仓库默认分支或PR猜正式要求；缺字段保持未知。`DeliveryMaterialsWriteAccessPort.assertWritable(actor,projectId,executor)` 必须在材料CAS的同一事务锁当前账号/请求会话、活跃项目manager/能力与非归档事实；规则Port在同一executor锁确认版本。

```ts
const materials = new DeliveryMaterialsService({
  access: projectAccess, writeAccess: liveTransactionalWriteAccess,
  requirements: confirmedDeliveryRequirements,
  store: new PostgresDeliveryMaterialsStore(database), database, clock, ids,
});
// createGitHubHandler({ ...existingDependencies, materials }, "materials.get" / "materials.save" / "materials.history")
// getDeliverySummary(actor, projectId, { git, delivery, materials })
```

清单完整替换并追加版本，保存真实位置/HTTPS链接、修订、commit、每项核对结论/记录人/时间/证据与分支核对。同一project/actor/幂等键只能用于同一规范化输入；旧expectedVersion不能覆盖最新。通过需真实位置、修订、完整SHA和证据，服务不读取或执行用户位置。未更改核对保留原记录人；缺必交、历史commit、分支不匹配、未知必交性质及未加载规则都不能为ready。ready仅为材料的成员自报核对，不表示运行、合并或主办方正式提交。

根M07将摘要`requirements.materials`投影为`{id,label,status}`，failed/outdated映射unknown，不再固定空列表。`mergeStatus=matched`附`branchVerificationSource:user_reported`，表示用户核对要求分支包含关联版本，不是GitHub API确认合并；要求分支未知时`mergeStatus=not_verified`、`requirements.branch=unknown`并给人工规则入口。

`sql/delivery-materials.sql`为新增增量建议：材料head/不可变version/metadata事件在同事务保存，根决定实际迁移编号、外键与维护政策。本会话不执行真实迁移。清单与maintenance无需新增环境变量，复用DatabasePort和现有权限/时钟。

页面提供多选普通文本、fatal UTF-8解码、有界路径/体积/依赖目录/密钥早期检查及可编辑README。每次仍走草稿、真实差异预览、用户明确确认；服务器manifest最终决定可保存内容。页面与服务器拒绝压缩包/二进制附件扩展及Git LFS指针，显式删除旧附件仍允许。README只引用当前已保存目标/计划范围；技术/运行缺失时留人工填写位置，不虚构完成或资格。没有ZIP/二进制/LFS上传或自动执行能力。

`createGitHubMaintenance({drafts,authorization,clock})`不创建timer、数据库连接或网络调用；根现有后台每`GITHUB_MAINTENANCE_INTERVAL_MS=300000`（5分钟）调用`run()`。返回`{checkedAt,expiredDraftsRemoved,expiredStatesRemoved}`，重叠run合并、共用服务器时间。两个purge各自执行/事务，一方失败另一方仍运行；失败统一安全`GITHUB_MAINTENANCE_FAILED`，下次可幂等重试。

清正文同事务推进revision列/JSON，保留manifest/hash/previewHash/baseHead/tree/commit/operation/audit；无preview的draft也增CAS版本，旧请求不能恢复正文。保护saving/unknown、非空lease（含过期）、PR未知/执行、未saved但已有tree/commit的必要恢复材料；明确reconcile结算后后续清理才允许。draftRef保护同时匹配project/actor。保留恢复正文不延长用户TTL，不撤销授权、不清Token/epoch/未知hold；授权purge仅删过期state。

本轮模块214项node:test通过；新增材料/maintenance使用临时内存PGlite实际SQL验证规则变化、撤权/归档、版本CAS、幂等、回滚、隔离及旧CAS失败，其余外部HTTP/能力为注入夹具。按照用户最新确认，暂不验收真实GitHub；真实授权/仓库写入、生产迁移、网络PostgreSQL并发与运行中UI均留根统一安排。没有npm install、build/start/重启或付费模型调用。

## 官方接口核对

核对日期 2026-10-08，固定 `X-GitHub-Api-Version: 2026-03-10`。实现依据：[App 权限交集](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)、[用户安装与仓库](https://docs.github.com/en/rest/apps/installations)、[Git trees](https://docs.github.com/en/rest/git/trees)、[Git commits](https://docs.github.com/en/rest/git/commits)、[Git refs](https://docs.github.com/en/rest/git/refs)、[Git blobs](https://docs.github.com/en/rest/git/blobs)、[PR](https://docs.github.com/en/rest/pulls/pulls)。没有把官方文档核对或模拟通过当成实际测试仓库验收。
