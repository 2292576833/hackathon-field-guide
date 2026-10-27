# 观猹登录模块交付（完成，STOP）

授权范围仅 `src/modules/guancha-login/` 和本文件；不读取 `.env.local`，不改现有认证、根组合、配置、实际迁移与其他会话文件。

根后续追加授权新 `src/server/guancha-auth.ts/.test.ts`，用于桥接既有账号/会话与明确确认绑定。该桥接不改现有公共文件，不创建伪邮箱或验证时间。

## NEEDS_INTERFACE（实现前登记）

1. 根注入 `GuanchaIdentityPort.completeLogin({ identity, now, returnTo })`。`identity` 只能来自已按官方协议验证的服务端 provider，主键为精确 `issuer + subject`。根在同事务中锁定绑定、复核账号 active、决定新用户/待验证邮箱流程并签发既有 M01 会话。不得把第三方邮箱或昵称作为账号 ID，不自动按第三方邮箱合并既有账号（即使字段声称已验证）；绑定既有账号须本人现有登录并近期重新认证。根不得读取请求 JSON 的 actor 作为绑定依据。本模块不写 `auth_users` / `auth_sessions`。
2. 根注入现有 `safeAuthReturnTo` 作为回跳规范化函数，发起时存入受保护 state，回调不接受新回跳地址。根 HTTP 发起请求需验证同源和频率；浏览器绑定只能取本模块产生的独立随机 HttpOnly / Secure / SameSite=Lax / Path=/ Cookie，回调不从查询或 JSON 取绑定值。根清除绑定 cookie 并用既有会话 Cookie 规则发送 `completeLogin` 的服务器私有结果，不把 token 返回页面/JSON。
3. 根提供真实 `DatabasePort`，并组合本模块 SQL 建议的递增迁移；state 单次原子消费提交后才执行第三方兑换。根提供稳定服务端加密密钥（至少 32 字节），只加密短期 PKCE/nonce。模块不读取环境变量。
4. 已实现 `createGuanchaProvider`，根注入正式配置。使用已核实官方 OAuth 授权码 + S256，校验 HTTPS、超时、响应上限、禁止重定向，身份只能来自换取 token 后读取的官方 userinfo。provider 返回已验证的 `issuer/subject` 和可选昵称，不把原始响应、access token、secret 或未验证邮箱传给身份 Port。官方明确示例用 userinfo 查询参数传 access_token，因此这个私有服务器请求 URL 必须排除请求日志；不猜尚未证实的 Bearer header 传法。

示例：首次授权返回 subject=A，当前无绑定，根返回需邮箱验证的受保护续接；已有 A→user-1 绑定且 user-1 active，根签发现有会话；subject=B 资料碰巧与 user-1 邮箱相同，不能视为 A 或自动写 user-1 绑定。

## 端点依据

用户确认站点为 `https://watcha.cn/@10139804`。官网公开登录组件 `https://watcha.cn/_nuxt/DPg5staz.js` 明确链接：

- “了解更多关于使用观猹账号登录”：<https://agentuniverse.feishu.cn/wiki/EMYHwT3sIiUYaDkL1ZvcPntGnpb>
- “申请接入”：<https://agentuniverse.feishu.cn/docx/McKCdI70Gols8hxiBVYcMfhCnNc>

公开飞书 HTML（PowerShell 匿名 `Invoke-WebRequest -UseBasicParsing` 返回 200，SSR permission 标记允许）已读取《观猹认证接入文档》正文，wiki 文档更新标记 2026-08-06。正文来源为 `window.DATA.clientVars.data.block_map` 各块 `data.text.initialAttributedTexts.text["0"]`；并非依赖登录页、搜索摘要或猜测端点。普通 Node/web 获取可能重定向登录；上述公开读取已复核。

| 项目 | 已核实并采用 |
| --- | --- |
| 身份命名空间 | 固定 `https://watcha.cn`，本地 provider namespace，不伪装 OIDC iss |
| 授权 | GET `https://watcha.cn/oauth/authorize`，`response_type=code`，`scope=read`，S256 |
| Token | POST `https://watcha.cn/oauth/api/token`，表单 `grant_type=authorization_code`、`code`、`redirect_uri`、`client_id`、`client_secret`、`code_verifier` |
| Token 返回 | 顶层 `access_token`、`token_type`、`expires_in`、`scope`；refresh_token 不保存、不使用 |
| Userinfo | 官方 docx 明确 GET `https://watcha.cn/oauth/api/userinfo?access_token=…`；服务器私有、绝不回浏览器或日志 |
| 用户返回 | `{statusCode:200,data:{user_id:number,nickname:string,avatar_url?:string}}`；只取安全正整数 user_id→string 与可选昵称 |
| 邮箱/手机 | 新版明确需额外用户授权；本次不请求、不用于合并。没有 email_verified 假设 |

新版 wiki 后半分页匿名不可读，故不声称 Bearer 请求头或其他传参方式已获确认；已读官方 docx 明确 query 方式。官网 `/oauth2-server/authorize/info`、`/oauth2-server/authorize` 是前端内部接口，不用于本实现。登记的网站 `https://frp-off.com:44353/events` 不自动等于 OAuth callback。

## 已完成

- 官方 OAuth 授权码 + S256 适配，只申请 read，稳定整数 user_id 与固定 issuer 绑定；不读第三方邮箱，不自动合并。
- 独立随机 state/browser cookie、短时限、配置/回调绑定、AES-GCM 加密 verifier/nonce、PostgreSQL 原子单次消费，错误/取消/未知结果不可重放。
- 根桥接已绑定账号签发 M01 会话；首次第三方身份进入短期单次 pending，用户完成本站邮箱登录并明确确认后关联。重查 active / session / 最近认证，冲突不覆盖，最终写入间过期也回滚。
- 公共导出、README、协议依据、模块内迁移建议、根接入 API 和验收边界。

## 已验证

- 37 项定向测试全部通过：13 项服务/持久化、13 项 provider、11 项账号桥接。
- 命令：`node --experimental-strip-types --test src/modules/guancha-login/service.test.ts src/modules/guancha-login/postgres.test.ts src/modules/guancha-login/provider.test.ts src/server/guancha-auth.test.ts`。
- 较早两次 `node node_modules/typescript/bin/tsc --noEmit --incremental false` 全项目通过。最终与根并行检查时仅报告 `src/server/guancha-http.test.ts:43/44` 缺少第二参数（TS2554），根已报告正在调整该新HTTP夹具；本会话不越界修改，不将该次全局检查记为通过。
- 独立只读安全复核发现的“最后 audit 等待期间近期认证过期”边界已修复并增加测试，账号禁用错误保持固定脱敏403语义。

## 模拟测试与真实边界

- provider 测试仅注入 fetch 桩，未使用 Client Secret、真实 token 或发起真实授权。
- state/账号桥接使用独立内存 PGlite 执行真实 SQL，验证事务回滚、状态消费、唯一约束；不代表远程 PostgreSQL 多连接锁验收。
- 本会话没有读取 `.env.local`、写真实配置、执行实际迁移、构建或重启。根后续组装的路由、页面、配置、068迁移和HTTP验收由根单独记录。

## 根接入 API（当前）

- `new GuanchaLoginService<Result>({attempts,crypto,identity,provider?,clock,safeReturnTo})`：`begin(returnTo)` 返回仅供服务器使用的 `{authorizationUrl,browserBinding,expiresAt}`；`complete({state,browserBinding,code?,error?})` 返回身份 Port 结果；`enabled` 反映是否注入已确认协议。省略 provider 时拒绝发起，不构造猜测端点。
- `createGuanchaProvider({clientId,clientSecret,origin,redirectUri,fetch?,timeoutMs?,maximumResponseBytes?})`：固定上述官方端点、scope read、S256、OAuth（不用OIDC nonce）；构造时要求 `redirectUri === origin + '/api/v1/auth/guancha/callback'` 且 origin 是精确 HTTPS origin。根配置用三个 GUANCHA 环境变量和既有 AUTH_ORIGIN；不把端点设为可由请求任意输入。默认每请求10秒、JSON最多64KiB、无重试、无重定向、无缓存；默认原生 Node HTTPS 避免框架 patched fetch 对 userinfo token URL 的 tracing/cache，TLS 校验保持开启。fetch 注入仅供受控测试或等价私密传输。
- `new PostgresGuanchaAttemptStore(database)`：只能注入根提交执行器，不能在跨第三方网络请求的外层事务里消费 state。状态消费必须在交换前提交；失败无重试。
- `createNodeGuanchaCrypto(secret)`：根可注入现有至少 32 字节的服务器秘密，本模块用 HKDF 独立域派生 AES-GCM key。不会读 env。
- 新根桥接已实现 `createGuanchaAuth({database,crypto,clock,ids,pendingLifetimeMs?,sessionLifetimeMs?,recentAuthenticationMs?})`，`crypto` 为既有 M01 `AuthCryptoPort`；返回 `completeLogin` 与 `confirmLink`。后者输入仅 cookie 读取的 `{pendingToken,browserBinding,sessionToken}`，成功返回 `{success:true,returnTo}`。
- 桥接 `GuanchaAuthResult`：`{status:'authenticated',grant:SessionGrant}` 或 `{status:'link_required',pendingToken,expiresAt,returnTo}`。pendingToken 只放 HttpOnly Cookie，保留 begin 的 browserBinding cookie至确认；不要把它们序列化给客户端。已有账号的绑定需要当前近期认证和明确确认。签发成功仍由根触发既有 `personalWorkspace.session` 后处理。
- 回调固定建议 `/api/v1/auth/guancha/callback`；根确认正式 origin 为 `https://frp-off.com:44353`，完整 callback 必须精确验证，`/events` 只是应用网站地址。正式 provider 不使用 `http://localhost:3000` 回调。
- 根 HTTP 需要拒绝重复 query/cookie（尤其 state/code/error），同源 POST 发起/确认；回调响应 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`，成功后 303 至已存站内路径；不在日志保留 callback 查询或第三方原文。
- 根最新确认用户要求保留 `frp-off.com:44353` 不改域名，只修穿透稳定性；当前证书不可信仍是实际验收限制。callback 采用该固定 origin 并与观猹后台一致；不得跳过 TLS 验证做真实授权测试。

## 未接入 / 待验收

根已报告正在接入路由/登录按钮/明确关联页、启用开关及068迁移，但其最终验证不在本模块37项测试内。真实数据库迁移、真实观猹授权、手机 Cookie 回跳和账号绑定尚未由本会话验收。既有邮箱验证码保留。根需避免全局 HTTP tracing/debug 输出 userinfo 查询参数 access_token；模块自身没有日志并将所有请求异常替换为固定错误。观猹控制台精确callback登记尚未确认，frp-off严格TLS仍不可信，根计划保存配置但保持启用开关false，不能宣称真实登录成功。

## 环境变量

模块不自行读取环境变量。根已选名称 `GUANCHA_LOGIN_ENABLED`、`GUANCHA_CLIENT_ID`、`GUANCHA_CLIENT_SECRET`、`GUANCHA_REDIRECT_URI`（等于 `AUTH_ORIGIN` + `/api/v1/auth/guancha/callback`）。服务器加密 key 可由根注入现有秘密并独立域派生；禁止任何 `NEXT_PUBLIC_` 密钥字段。本文不记录值。

## STOP / 交还

本轮授权文件 `src/modules/guancha-login/`、`src/server/guancha-auth.ts/.test.ts` 和本交付文档已完成。现在停止编辑并全部交还主会话；不沿用本轮授权继续修改。根可统一检查、构建和安排实际验收。

STOP 后根追加建议：`confirmLink` 对绑定已提交但 HTTP 响应丢失的同账号重试，提供精确 issuer/subject/browser/pending/近期有效会话限定的幂等恢复。该追加建议尚未在本交付实现，代码已交还，由根接续；目前已消费 pending 的重试明确失败，不会误给其他账号成功。

## 2026-10-12 追加只读核对：注册与 callback 规则（完成，STOP）

本轮新授权仅核对官方公开文档/客户端代码、查询当前应用公开元数据并追加本文件。只按字段读取 `GUANCHA_CLIENT_ID` 供官方查询，未读取或打印 Secret，未发起授权/换令牌/绑定，未改代码、配置、迁移或启用开关。以下替代任何“authorize/info 返回200即可证明callback被允许”的推断。

### 官方文档能证实的规则

重新匿名 GET 官方 docx 链接成功（HTTP200），SSR提取95个文本块，相关条款本轮再次核实：

- 登记字段是 `domain`，说明指向回调的 URI Schema，示例带协议和端口、没有路径。
- 授权的 `redirect_uri` 要匹配登记的 `domain`。
- 换令牌时的 `redirect_uri` 必须与授权请求保持一致。

文档没有进一步说明“匹配”究竟比较完整 URL、origin、hostname、端口还是路径前缀，不能据此断言同域任意回调都允许，也不能要求用户仅凭猜测把 `/events` 当回调处理端点。登记示例倾向 origin，但这是推断，不是已验证算法。

### 官方客户端的实际元数据接口

本轮直接读取官方 `/_nuxt/qwY6jfPL.js` 与 `/_nuxt/DPg5staz.js`：前者 `sde()` 返回 `/api/v2`，`getAuthorizeInfo` 调 GET `/oauth2-server/authorize/info`；后者把 query 中的 `client_id`、`redirect_uri`、`response_type`、`scope`、`state`、`code_challenge`、`code_challenge_method` 传入。由此核实完整接口为：

`GET https://watcha.cn/api/v2/oauth2-server/authorize/info`

这是官网授权弹窗使用的读取接口，不是生成授权码的 POST `/oauth2-server/authorize`。本轮只调用前者，未附 Cookie/Authorization、Secret 或 token，未发送 `skip_consent`。参数采用当前 Client ID、`response_type=code`、`scope=read`、一次性随机查询state和S256 challenge。

### 当前应用的真实只读结果

| 查询的 redirect_uri | HTTP / 业务状态 | 返回名称 / 地址 |
| --- | --- | --- |
| `https://frp-off.com:44353/api/v1/auth/guancha/callback` | 200 / 200 | 黑客松情报局 / 原样回显 |
| `https://frp-off.com:44353/events` | 200 / 200 | 黑客松情报局 / 原样回显 |
| `https://frp-off.com/api/v1/auth/guancha/callback`（省略非默认端口的对照） | 200 / 200 | 黑客松情报局 / 原样回显 |
| `https://example.invalid/api/v1/auth/guancha/callback`（保留无效域名对照，未访问该域名） | 200 / 200 | 黑客松情报局 / 原样回显 |

返回字段只有 `client_id`、`client_name`、`redirect_uri`、`scope`、`state`、`allowed_scopes`；允许scope为 `read email phone`。没有登记 `domain`、redirect白名单、匹配布尔值或回调校验结论。

**结论：Client ID确实对应“黑客松情报局”，公开metadata支持读取且本应用允许read scope；该接口对明显不同域名同样返回成功，故不能证明计划callback已登记/获准。** 不推断该表现为最终授权接口存在开放重定向，也不把metadata成功算作登录成功。

### 根可执行方案与剩余验收

1. 保留固定完整callback `https://frp-off.com:44353/api/v1/auth/guancha/callback`，发起和兑换始终同值；不改为 `/events`，不因metadata结果去掉端口，不放宽本站回跳规则。
2. 当前应用名称/Client ID对应关系和read scope已得到只读证据。若官方应用配置可读取，核实登记 `domain` 对应 `https://frp-off.com:44353`，按官方界面实际字段确认是否另有精确回调项；公开metadata不能替代该核对。本轮未进入管理控制台。
3. 根处理现有域名的TLS限制后，下一项有效验收是由用户在真实浏览器完成明确授权，检查最终授权服务器是否回到固定callback，随后本服务端按同一redirect_uri兑换；若官方拒绝域名/地址，按其真实错误和控制台配置修正，不自动尝试其他callback。
4. 在没有上述真实证据前，启用开关与任何“登录已验证”声明仍由根依据实际边界决定。本次只读操作没有消除原TLS限制，也没有证明回调登记已通过。

本轮只读核对结束，STOP；仅本文件增加记录，代码/配置/迁移继续由主会话独占。
