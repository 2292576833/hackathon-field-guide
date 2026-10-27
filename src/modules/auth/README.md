# M01 账号登录与身份

显式注册/登录的邮箱验证码规则、真实 PostgreSQL 适配、邮件模板/超时适配和可组合 HTTP handler。无需设置密码。此目录没有真实数据库连接池、邮件供应商凭据，也不会在运行时退回测试内存存储。

## 主会话组合

1. 初始迁移已由主会话组合；新增 `migrations/002_session_last_seen.sql` 须纳入新的根迁移，在新版服务运行前执行，不能重写已应用初始迁移。已有会话 backfill 为创建时间。用户表继续为 `auth_users`。
   本轮 `migrations/003_registration_display_name.sql` 为新增注册姓名迁移建议，主会话已与个人画像建议复制到根 `022_registration_and_participant_profiles.sql`；复制后本建议未改动。必须先部署新增列再运行新版认证适配。此模块未执行根迁移。
2. 提供 shared `DatabasePort`。`transaction` 必须同连接执行全部 SQL，返回时提交、异常时回滚；失败验证以结果返回，保留失败计数。建议 PostgreSQL 默认 READ COMMITTED；模块采用 advisory/行锁、唯一约束与乐观版本校验。
3. 创建 `createNodeAuthCrypto(AUTH_CODE_PEPPER)`。生产 pepper 使用至少 32 字节随机秘密；轮换会使未消费验证码与既有邮箱限流 HMAC 键失效，须协调窗口/部署。会话摘要不依赖 pepper。
4. 为 `createLoginEmailAdapter({transport, from})` 注入真实供应商的 `TransactionalEmailTransportPort`。传输实现必须接受 AbortSignal，设置自己的网络超时，不打印完整消息/验证码。模块默认 10 秒超时；超时/异常挑战不能验证，响应不含供应商报错。
5. 给 `PostgresAuthStore(database, ids, clock)` 与 `new AuthService({store, crypto, email, clock, ids})` 注入同一个可信 Clock。SQL 锁等待后再次读取 Clock 检查过期；会话有效期从实际消费时开始。
6. 组合模块 HTTP handler 与 App Router，注入固定 `origin` 和 `clientKeys: AuthClientKeyPort`。旧 `getClientKey(request)` 回调可过渡，两者二选一。可信连接与签名代理策略见 [配置说明](./TRUSTED_CLIENTS.md)，不能直接信任请求 JSON 或任意 X-Forwarded-For。

```ts
const store = new PostgresAuthStore(database, ids, clock);
const crypto = createNodeAuthCrypto(environment.AUTH_CODE_PEPPER);
const email = createLoginEmailAdapter({ transport: realEmailTransport, from: environment.AUTH_EMAIL_FROM });
const auth = new AuthService({ store, crypto, email, clock, ids });
const handlers = createAuthHandlers({ service: auth, origin: environment.AUTH_ORIGIN, clientKeys: trustedClientKeys, requestIds: ids });
// 在服务端从安全 Cookie 提取令牌后：
const actor = await auth.requireActor(sessionToken);
// 私有项目模块还必须通过 M02 的 ProjectAccessPort 检查当前成员资格。
```

`AuthQueryPort.getActor` / `requireActor` 是身份查询契约。Actor 仅从有效会话与 active 账号投影；新账号的平台角色固定为 `user`。本模块不会替 M02 赋项目/团队权限，也不会创建或撤销 M06 的 GitHub 授权。

| 建议 App Router 路由 | 方法 | Handler |
| --- | --- | --- |
| `/api/v1/auth/login-challenges` | POST | requestLoginChallenge |
| `/api/v1/auth/login-challenges/verify` | POST | verify |
| `/api/v1/auth/registration-challenges` | POST | requestRegistrationChallenge，JSON `{email,displayName}` |
| `/api/v1/auth/registration-challenges/verify` | POST | verifyRegistration，JSON `{challengeId,code,returnTo?}` |
| `/api/v1/auth/logout` | POST | logout |
| `/api/v1/auth/logout-all` | POST | logoutAll |
| `/api/v1/me` | GET / PATCH | getMe / patchMe |
| `/api/v1/me/account-settings` | GET | getAccountSettings，data 为本人设置完整 DTO |
| `/api/v1/me/session` | GET | getCurrentSession，data.session 为当前设备元数据 |
| `/api/v1/me/sessions` | GET | listSessions |
| `/api/v1/me/sessions/revoke` | POST | revokeSession，JSON `{sessionId}` |

工厂返回 `readSessionToken(request)`，供其他路由与 `auth.requireActor` 组合。默认 Cookie 为 `__Host-hackathon_session`、Secure/HttpOnly/SameSite=Lax、Path=/，无 Domain。必须配置 HTTPS Origin；显式 `secure:false` 仅允许 loopback HTTP 开发 Origin，Cookie 改为无安全前缀的 `hackathon_session`。

所有写入口，包括发送/验证登录，要求 Origin 与固定配置精确一致；缺失、null、其他来源拒绝。JSON 限制按实际读取字节计算，默认 4096 字节，拒绝未支持字段与压缩 body；退出可提交空 body。接口一律 `Cache-Control: no-store`，原始令牌仅 Set-Cookie；成功正文以显式白名单再次投影。此接口未直接挂载页面或路由，由主会话接入。

`AccountSettings` 包含 `profile/currentSession/sessions/recentAuthenticationUntil/canLogoutAll`。会话字段仅 id、createdAt、authenticatedAt、expiresAt、lastSeenAt、current；不包含凭据、原始 IP 或浏览器指纹。有效本人会话访问刷新单调 lastSeenAt，不延长有效期或近期认证资格；退出全部仍由服务端重校验。

单设备撤销返回 `{revoked,currentSessionRevoked}`。他人、不存在、已过期或已撤销目标都返回 `false,false`；实际撤销当前设备时清 Cookie，撤销其他本人设备保留当前 Cookie。资料写入沿用昵称/时区/expectedRevision 白名单。

## 登录与恢复

- 接受 ASCII 邮箱地址，首版将整段邮箱 trim/lowercase 为稳定登录标识；不合并点号或加号别名，不用 GitHub 名称合并账号。邮箱更换必须另做验证，资料更新不能改邮箱/角色/状态。
- `/login` 使用邮箱验证码；`/register` 明确收集姓名/昵称和邮箱。`LoginClient({mode?: "login" | "register"})` 默认登录，注册由 App 页面传 `mode="register"`。两个模式都说明无需设置密码；个人画像不是登录前置条件。
- `requestRegistrationChallenge({email,displayName},trustedClientKey)` 校验 1–60 字符姓名后，只写入验证码挑战的 `registration_display_name`，不查询或修改已有账号。`verifyRegistrationChallenge({challengeId,code,returnTo?},trustedClientKey)` 复用同一个原子认证消费流程。
- 新用户姓名来自挑战中已保存的输入，只在成功验证与创建会话的同一个事务内插入。已有邮箱 `ON CONFLICT DO NOTHING`，姓名、时区、revision、角色及状态不被注册请求覆盖。验证 JSON 不接受姓名、密码或调用方身份字段。
- 注册和登录使用相同响应形状、限流与认证结果，不暴露邮箱是否已有账号。登录首次验证仍可创建默认姓名的账号，保留既有邀请/恢复路径兼容。请求验证码时不查询账号是否存在。
- 验证码为 8 位数字，使用安全随机源；服务端仅保存绑定 challengeId 的 HMAC 摘要。挑战默认 10 分钟，在邮件供应商受理后才从 pending 变 ready。
- 重发会撤销同邮箱未消费挑战，包括还在发送中的旧挑战。旧发送回调不会恢复其可用性。邮件失败也会消耗发送额度/冷却，避免通过失败重试无限发信。
- 同一事务中消费验证码、取得/创建用户、写会话与必要审计。错误验证码计数会提交；重复/过期/已撤销/账号停用返回统一验证失败。成功消耗后不能重放。
- 会话原始令牌为 32 随机字节，数据库只保存 SHA-256 摘要；会话默认固定 7 天过期。每次查询检查 active、revokedAt、expiresAt，不依赖页面角色缓存。
- 当前退出幂等；设备列表和单设备退出只对本人开放。退出全部设备要求 5 分钟内完成邮箱验证；需重新认证时获取新验证码登录后再执行。
- 本人资料只有昵称/时区可更新，携带 expectedRevision；冲突返回最新版 revision，不能静默覆盖。回跳允许预设站内路径，未知/外部/编码路径退到 `/app`。
- 本轮新增回跳 `/participation`、`/participation?event=<1–128位字母数字下划线短横线ID>`、`/roadshow`、`/ppt`、`/register`、`/inspiration` 与 `/github`。参赛入口查询只接受单个原文安全 event ID，不接受编码、重复字段或其他参数。
- 前端按 `/system/status.email` 区分真实供应商受理、本地开发邮箱预览与未配置；本地预览明确说明未发送到真实邮箱。冷却倒计时、验证码过期、错误重试和已登录状态均有明确动作。

## 默认限额

| 规则 | 默认 |
| --- | --- |
| 同邮箱发送冷却 | 60 秒 |
| 同邮箱发送 | 3 次 / 15 分钟 |
| 同受信客户端发送 | 20 次 / 15 分钟 |
| 单挑战错误验证码 | 最多 5 次 |
| 同邮箱验证（跨重发） | 10 次 / 15 分钟 |
| 同受信客户端验证 | 50 次 / 15 分钟 |

使用事务性固定窗口计数；重发不会清零邮箱猜测额度。固定窗口在边界可有相邻两窗的请求，发送冷却仍独立生效。匿名客户端键和邮箱限流键以 HMAC 保存；原始客户端 IP 不进入模块审计。

## 敏感数据边界

`SessionGrant` 仅供服务端使用，含需要写入 HttpOnly Cookie 的原始会话令牌，不能直接 `Response.json(grant)`。本人 `/me` 只返回 id、本人邮箱、昵称、时区、验证时间与 revision；会话列表仅元数据。HTTP handler 应统一 no-store，状态码/错误采用 shared `DomainError`，隐藏未知异常。普通审计仅保存 actor/object IDs、动作、结果和时刻。

资料写入、会话撤销都在事务中重查会话；没有 API 从客户端接收 Actor 或目标 userId。账号状态发生 suspended/deletion_pending/deleted 后，现有会话身份查询立刻拒绝；其管理入口需由主会话后续组合。

## 验证与限制

运行 `npm test -- auth`。测试使用 Node `node:test`；`test-fixtures.ts` 只用于测试，不从 `index.ts` 导出。脚本化 SQL 测试覆盖锁等待/参数化/事务契约；另有一次性 PGlite PostgreSQL 引擎执行初始+新增迁移、既有会话兼容、登录与本人元数据/撤销验证，不替代连接式 PostgreSQL 多连接竞争验证。

本轮沿用主会话已有的 Resend 与 pg 路径，没有重复实现供应商或使用其秘密。主会话需组合新增迁移、路由及 ingress 策略，继续验证邮件可达性、连接式 PostgreSQL 并发与浏览器设置页流程。邮箱登录安全设计参考 [OWASP OTP](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html#one-time-password-otp-handling-and-storage)、[会话管理](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) 和 [登录 CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#possible-csrf-vulnerabilities-in-login-forms)；不宣称达到任何认证保证等级。

账号自助导出、删除申请与邮箱更换已在本轮模块实现，接入见下节；管理员支持访问、长期资料保留政策与 GitHub 断开仍由根协调。历史 `auth.md` 保留此前交付事实，最新见 `account-completion.md`。

## 本人数据和邮箱自助操作（C01）

`AccountCompletionService`、`PostgresAccountStore`、`createAccountCompletionHandlers` 和 `createAccountEmailAdapter` 从 `index.ts` 导出；React `AccountDataControls` / `AccountEmailChange` 与 Props/API 类型从独立 `ui.ts` 导出。Node 测试不会加载 TSX。

```ts
const accountService = new AccountCompletionService({
  store: new PostgresAccountStore(database, ids, clock), crypto,
  email: createAccountEmailAdapter({ transport: realEmailTransport, from: configuredFrom }),
  ownData: rootOwnDataExportPort, deletionImpact: rootDeletionImpactPort, clock, ids,
});
const accountHandlers = createAccountCompletionHandlers({
  service: accountService, origin: configuredOrigin, requestIds: ids, clientKeys: trustedClientKeys,
  readSessionToken: authHandlers.readSessionToken, clearSessionCookie: authHandlers.clearSessionCookie,
});
```

新增 SQL 建议 `migrations/004_account_completion.sql` 只由根复制为递增迁移并执行，不重写已应用迁移。精确路由/DTO/组件 API 见 [account-completion 交付](../../../docs/协作/交付/account-completion.md)。根提供两个 Port，必须复用传入 `SqlExecutor`，不能偷偷改成另一个连接/事务：

- `OwnDataExportPort.collectOwnData(actor,executor,{maxRecords,maxBytes})` 只读本人原始资料、对话、生成、测评、复盘与收藏。每项记录为 `{id,userId,data}`，服务拒绝他人主体与安全字段；项目只有当前授权摘要。`assertProjectAccess(actor,projectIds,executor)` 在生成完成和下载前复核/锁定成员事实，撤权后拒绝旧下载。必须选择安全列，不能整行导出凭据/验证码或队友原始资料；`data` 是 JSON，不接受 Date/特殊对象。采集在有界数据库事务内完成，不调用邮件、模型或 GitHub。推荐根设置 SQL 查询超时。
- `AccountDeletionImpactPort.inspectOwnDeletion(actor,executor)` 按 M02 的一致锁序读取/锁定最后管理员事实，返回阻塞项目和处理说明。成员变化/转交必须使用相同并发规则，避免检查后新增最后管理员责任。保留共享成果与外部仓库，实际删除/去标识化由根另行处理。

导出先创建持久 queued 请求，再显式 `prepareExport(token,id,expectedRevision)` 整理；只进行有界数据库读取，无额外付费调用。失败单独事务保存错误编号，允许有限重试；默认最多 5000 条/5 MiB、3 次请求/24 小时、每请求最多 3 次整理、固定 24 小时失效。重试不延长原截止，过期访问清除该文件正文。根维护任务应定期调用 `PostgresAccountStore.clearExpiredExportDocuments(maximum=100):Promise<number>`：支持 1–1000 条批次、清除全部账号过期正文/大小并保留请求元数据；不暴露 HTTP、重复执行幂等。下载只认本人当前有效会话，不发 bearer 下载链接；项目撤权会阻止旧摘要下载。GET 状态不生成文件。

删除申请要求 5 分钟内重新认证，保存 pending 或 blocked；重复申请保留原请求，进入处理前可版本化取消/重新检查。申请不改账号状态、不撤当前会话。根可信 worker 调用 `beginDeletionProcessing(userId,id,expectedRevision)` 时重查最后管理员阻塞，通过才写 processing、账号 deletion_pending 并同事务撤销所有会话。此方法不挂 HTTP，处理状态不等于物理删除完成。本轮不提供虚假 completed 状态或自动删队友/GitHub 的操作。

邮箱更换要求近期认证与当前资料版本，并分别验证当前和新邮箱的 8 位验证码；挑战 HMAC 绑定独立目的与 ID，默认 10 分钟。邮件只有两封都受理才 ready，任何失败/未知结果保存 unknown，不自动重发或恢复旧挑战；冷却后用户明确新建挑战才可再次请求。发送按本人/目标邮箱/受信客户端限流，验证按本人/客户端和单挑战失败次数持久限制，重发不重置本人猜测额度。更换使用邮箱 advisory 锁、唯一约束与 revision CAS，同事务稳定 userId、增加版本、撤销旧会话与旧/新邮箱未消费登录码；HTTP 成功清同一 Cookie 并明确重新登录。不输出验证码、摘要或邮件供应商异常。
