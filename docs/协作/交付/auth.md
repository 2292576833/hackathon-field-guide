# M01 账号登录与身份交付

## 2026-10-09 本轮注册与画像接入补充

- 临时授权编辑范围：`src/modules/auth/`、`src/components/login-client.tsx`；画像服务与独立表单分别位于 `src/modules/participant/`、`src/components/participant-profile.tsx`，详细契约见 [participant 交付](participant.md)。未改根迁移、应用路由、共享契约或其他组件。
- `AuthService.requestRegistrationChallenge({email,displayName},trustedClientKey): Promise<LoginChallengeReceipt>`；`verifyRegistrationChallenge({challengeId,code,returnTo?},trustedClientKey): Promise<SessionGrant>`。发送前校验姓名，挑战保存 unverified 姓名；验证成功创建新账号时原子使用此姓名。未验证不更新 `auth_users`；已有邮箱账号姓名、时区、revision、角色、状态保持原样。新账号继续固定 `user`，未增加密码字段。
- `createAuthHandlers` 新增 `requestRegistrationChallenge` 与 `verifyRegistration`，复用精确 Origin、字节限制、未知字段拒绝、固定 Cookie、no-store 和跨 bundle `isDomainError` 边界。映射 POST `/api/v1/auth/registration-challenges`（`{email,displayName}`）与 POST `/api/v1/auth/registration-challenges/verify`（`{challengeId,code,returnTo?}`）。原有 handler/mock 契约兼容；未注入注册方法时新入口返回明确 503，不能冒充成功。
- `src/modules/auth/migrations/003_registration_display_name.sql` 已提供可复制新增迁移建议，只增加 `auth_login_challenges.registration_display_name`。主会话已复制本建议与画像建议到根 `022_registration_and_participant_profiles.sql`；复制后建议 SQL 未改动。实际执行由主会话负责，不能重写已应用根迁移。
- `LoginClient({mode?: "login" | "register"})` 保留默认登录；注册输入姓名/昵称与邮箱，明确无需设置密码。登录/注册链接保留回跳，已登录显示本人状态与继续入口，验证码冷却/过期/重发/编辑状态完整。真实邮箱是否可达只由根邮件运输及实际验收决定；preview 文案明确内容仅在本地预览，未发真实邮件。
- `safeAuthReturnTo` 新增 `/participation`、`/participation?event=<安全ID>`、`/roadshow`、`/ppt`、`/register`、`/inspiration`、`/github`。event 只接受 1–128 位原文 `[A-Za-z0-9_-]`，不能注入任意查询、编码或重复参数。
- 环境变量沿用根 `AUTH_CODE_PEPPER`、固定 `AUTH_ORIGIN`、邮件运输、可信客户端和 `DATABASE_URL`；本轮不新增密码、模型或邮件供应商配置。未读取/输出密钥、验证码，未打开实际 `.runtime/postgres-data`，未重启服务。

本轮认证 86 项、画像 17 项，联合 **103 项测试全部通过**：`node --experimental-strip-types --test --test-reporter=dot src/modules/auth/*.test.ts src/modules/participant/*.test.ts`。含新增 14 项注册行为/HTTP 测试，以及真实一次性 PGlite 注册姓名、会话写入失败回滚、已有账号资料保护；画像冲突回传前也复核会话。Auth + Participant 联合严格模块类型检查通过，最终全局 `npm run typecheck -- --incremental false` **通过**。此前其他模块组合过程的临时错误已由负责人修复，本任务未越界修改。前端沿用既有暖白橙红样式及移动端布局；个人画像表单局部输入/冲突/响应/初始 SSR 检查通过，未作实机浏览器视觉验收。

主会话已接注册两个 handler、`/register` 页面、画像 GET/PATCH 与账号页表单，并配置根 Resend 变量入口，真实值仍等待用户填写；本站正文未宣称真实邮件已发送。生产根迁移执行、真实邮件投递、手机/浏览器流程与连接式 PostgreSQL 多连接竞争仍由主会话验收。

状态：本轮可信代理与账号设置补齐已交付，模块测试通过；待主会话组合新增迁移、路由与 ingress 配置。日期：2026-10-08。范围仅 `src/modules/auth/` 与本文。

## NEEDS_INTERFACE

### 连接模式补齐（本轮）

- 已提供 `AuthClientKeyPort.getClientKey(request)` 与 HTTP 的 `clientKeys` 配置；和旧 getClientKey 回调互斥。TCP/平台连接元数据由受信 `ClientConnectionPort.getPeerAddress(request)` 提供；代理模式必须显式 IP/CIDR allowlist，X-Forwarded-For 从右向左跳过受信代理，不采用客户端可填的最左项。Next 原生 Request 没有 TCP peer 时使用 `trusted-client.server.ts` 的签名代理头适配，只有显式登记的 proxyId/独立密钥、未过期且绑定固定 Origin audience/当前方法/路径/查询的证明可用。未知来源返回脱敏 503，无任意头回退。root 根据实际 ingress 选择模式；完整签名格式、Port 与配置建议见 `src/modules/auth/TRUSTED_CLIENTS.md`。
- 已新增 `getAccountSettings`（GET `/api/v1/me/account-settings`）和 `getCurrentSession`（GET `/api/v1/me/session`）handler。本人设置字段：profile/currentSession/sessions/recentAuthenticationUntil/canLogoutAll。会话包含 lastSeenAt 但无原始 IP/浏览器指纹/凭据；有效访问更新活动时间，不延長过期或认证窗口。`revokeSession` 现在返回 `{revoked,currentSessionRevoked}`，实际撤销当前设备清 Cookie；他人/不存在/过期/已撤销目标均 false,false。UI 由其他会话完成，主会话组合新路由。
- 本轮追加 `auth/migrations/002_session_last_seen.sql` 建议；主会话纳入新的根迁移并执行，不能重写已应用初始迁移。已有账号/会话 backfill；权限/会话令牌无变更。Resend 沿用 root provider，不重复接入。
- root 后续确定：`config.authProxySigners: [{id,signingKey}]` 来自 `AUTH_PROXY_SIGNERS_JSON` 的显式登记列表，选择签名代理或保守共享预算；已通过 `index.ts` 导出相关工厂供 Node 服务/CLI，Next 生产边界仍提供 server-only 入口。主会话已复制为 root `010` 新迁移，执行状态由 root 记录。新增路由建议为 `GET /api/v1/me/account-settings`、`GET /api/v1/me/session`，已有 me/sessions/revoke 路径保留。

1. **主会话组合认证查询**：`AuthQueryPort.getActor(sessionToken): Promise<Actor|null>` 与 `requireActor(sessionToken): Promise<Actor>` 已在模块 `ports.ts` 定义。服务端从 HttpOnly Cookie 提取本站会话令牌后调用，不接受 JSON 中的 userId/roles/Actor。返回仅含稳定 userId 与数据库现行 platformRoles；每次检查会话撤销/过期和账号 active 状态。例：已退出会话再次请求项目，返回 null/401，不能沿用页面缓存 Actor。项目权限仍由 M02 `ProjectAccessPort` 检查。
2. **主会话真实基础设施**：注入 shared `DatabasePort`（事务同连接、结果 commit、异常 rollback）、`Clock`、`IdGenerator`、受信服务端客户端限流标识、固定站点 Origin；同一 Clock 注入 AuthService 和 PostgresAuthStore。认证 SQL 建议由主会话迁移。其他模块用户外键请统一引用 `auth_users(id)` 或由主会话迁移时统一重命名，不能各自产生身份表。
3. **邮件供应商适配**：`TransactionalEmailTransportPort.send({from,to,subject,text},{signal}): Promise<void>` 必须使用 AbortSignal，并在供应商受理后 resolve；失败 reject。主会话已有 Resend provider 与 pg/PGlite 组合路径，本轮沿用，不重复实现、不读取秘密。
4. **尚未提供的跨模块工作**：账号删除/导出、邮箱更换、管理员暂停入口与角色管理、GitHub 断开入口需由主会话协调 M02/M04/M06/M07 的实际数据影响。当前不伪造完成接口、不自动赋项目权限、不会撤销或扩大 GitHub 授权。

## 已完成

- 邮箱挑战与原子单次消费、会话生成/查询/撤销、本人资料版本更新的服务与 PostgreSQL 适配。
- 邮箱/客户端发送限流、每挑战及跨重发邮箱验证限额；发送失败/pending 不可验证。
- 本人设备列表/单设备撤销、近期邮箱验证后退出全部设备；原始凭据仅服务端使用。
- 8 位安全随机验证码、challengeId 绑定 HMAC、安全随机会话与单向摘要；新账号平台角色固定 `user`，登录只恢复本站身份。
- `createAuthHandlers` 提供十个框架无关 Request/Response handler，方法与路由映射见 README。包含精确 Origin 校验、Secure/HttpOnly/SameSite Cookie、字节级请求体限制、未知字段拒绝与 no-store 脱敏响应。
- `createLoginEmailAdapter` 提供中文邮件模板、默认 10 秒超时及 AbortSignal；供应商响应不会进入普通错误。
- `index.ts`、README、`migrations/001_auth.sql` 建议与关键行为测试均已提供；测试内存夹具不从公共 index 导出。
- 事务锁等待后重新校验验证码/会话过期和近期认证窗口；新账号阶段若等待至过期，以 savepoint 回滚账户创建并保留限流事实。
- `createClientKeyProvider` 提供显式共享预算、真实连接/direct、受信代理 CIDR 策略；`createSignedProxyClientKeyProvider` 提供 Next 场景签名代理证明。安全入口 server-only，浏览器拒绝，代理 allowlist 构造时固定。IPv4/映射 IPv6/压缩 IPv6 统一限流 key，地址族隔离防止 `::/80` 意外信任全部 IPv4。
- `002_session_last_seen.sql` 是新增迁移建议；旧会话 backfill、默认值兼容已有受控插入。SQL 适配更新使用 user→session 锁序列，lastSeenAt 单调但不改变认证/失效时刻。设置快照本人范围内原子读取。
- 登录回跳白名单补充 `/app/account`、`/app/teams` 与单队伍详情、`/library` 与单资源详情、`/skills` 与单技能详情；保留现有管理页、邀请及项目路径。编码字符、双编码、外部 URL、路径穿越、额外子路径或查询仍回退 `/app`。

## 验证

- `npm test -- auth`：71 项通过，0 失败。包括回跳白名单/编码拒绝、代理信任/签名/IPv4-IPv6边界、账户完整元数据、近期认证、当前设备撤销 Cookie、真实 SQL 引擎新增迁移兼容和原有认证行为。
- 模块独立严格类型检查：通过。执行 PowerShell：`$authTypeFiles = @(Get-ChildItem -LiteralPath 'src/modules/auth' -Filter '*.ts' | ForEach-Object { $_.FullName }); & node 'node_modules/typescript/bin/tsc' --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --skipLibCheck @authTypeFiles`。
- 验证包括：同邮箱身份恢复、12 次并发验证只产生一份会话、错误计数/限流窗口/重发与旧码、邮件发送 pending/失败/过期、本人设备隔离、账号禁用、会话失效/退出全部、资料版本冲突、敏感数据回传/审计参数排除、恶意回跳、Cookie/Origin/JSON 防护及实际 handler+service 组合登录到退出。
- 模拟测试：服务与 HTTP 组合流程使用明确 test-only 内存夹具/邮件捕获，代理 proof/连接元数据采用隔离注入；脚本化 SqlExecutor 覆盖事务合同与锁等待边界。
- 实际引擎验证：`persistence.integration.test.ts` 使用一次性 PGlite PostgreSQL 引擎，执行本模块初始+新增 SQL、backfill 既有会话、邮箱身份恢复、活动时间持久保存、本人/他人/过期设备撤销、近期认证失效和审计脱敏。不是生产迁移、外部 pg 多连接竞争或真实邮件发送证据。
- 本轮全局 `npm run typecheck` 执行时失败来自 github/operations/planning 正在开发的类型错误，auth 无错误。主会话合并后需重跑全局门禁，本模块未越界修改。

## 未接入

主会话已有邮件/PostgreSQL 服务，本轮模块不重复供应商接入。新增根迁移、账号设置路由与实际代理部署配置由主会话组合，设置 UI 由指定会话完成。连接式 PostgreSQL 多连接竞争、真实 ingress 证明链路与邮件/浏览器端到端验证继续由主会话记录；本轮未使用外部凭据或执行实际环境迁移。账号删除/导出、邮箱更换及跨模块数据影响仍需主会话协调。

## 安全设计参考与边界

按 [OWASP OTP 处理](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html#one-time-password-otp-handling-and-storage)、[会话管理](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) 与 [登录 CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#possible-csrf-vulnerabilities-in-login-forms) 核对单次消费、次数限制和 Cookie/Origin。此邮箱登录是首版本站认证路径，不宣称供应商真实接入、认证保证等级或整站安全认证。

## 环境变量名称

- `DATABASE_URL`：主会话连接池。
- `AUTH_CODE_PEPPER`：至少 32 字节随机秘密；服务启动注入，禁止日志记录。
- `AUTH_ORIGIN`：固定完整站点 Origin。
- `AUTH_EMAIL_FROM`：供应商允许的发件人。
- `RESEND_API_KEY`：主会话已有 provider 使用，本模块不读取/打印值。
- 建议 root 新增 `AUTH_CLIENT_KEY_MODE`、`AUTH_TRUSTED_PROXY_CIDRS`、`AUTH_TRUSTED_PROXY_IDS`、`AUTH_PROXY_ATTESTATION_KEYS`（服务端秘密）、`AUTH_PROXY_ATTESTATION_HEADER`；具体 root 解析和 ingress 注入由主会话完成，不能仅配置头名即信任转发头。
- root 已选 `AUTH_PROXY_SIGNERS_JSON` 作为显式 proxyId/密钥列表来源；此项为秘密配置，不记录值。上述独立名称仅模块备选模式的建议，不要求重复配置。
