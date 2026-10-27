# 观猹登录服务端边界

本模块为观猹（用户确认官网 `watcha.cn`）登录接入提供独立安全边界与官方 OAuth 适配。客户端 ID / Secret 只由根配置；本模块不读取环境变量。根未完成配置时省略 `provider`，服务明确不可用。

## 已有能力

- `GuanchaLoginService` 发起时生成独立 256-bit state 与 browser cookie，数据库仅存 hash，原子单次消费成功后才调用外部 provider。错误、取消、兑换超时都不能重放原 state。
- `PostgresGuanchaAttemptStore` 仅写自身 state 表；绑定 cookie、issuer、configurationId、redirectUri、创建时间与期限必须同时匹配。消费会清除加密的 PKCE verifier / nonce。
- `createNodeGuanchaCrypto` 用服务器注入秘密经独立域 HKDF 派生 AES-GCM key，密文 AAD 绑定 state hash，不能交换其他登录记录的 verifier。PKCE 只允许 S256 或官方明确不支持；未确认不能启用。没有 plain 降级。
- 第三方身份仅投影精确 `issuer + subject` 与可选显示昵称。未验证邮箱、角色、本站 userId 和 token 全部不传入账号 Port。没有第三方邮箱自动合并。
- 回跳由根注入既有 `safeAuthReturnTo`，在发起时固定；回调不能提供替代回跳。第三方错误正文不会回显。

## 根组合

公共导出见 `index.ts`。根桥接在另行授权的 `src/server/guancha-auth.ts`，管理既有 M01 会话与显式绑定；本模块不直接写 `auth_users/auth_sessions`。SQL 仅是 `schema.sql` 建议，实际增量迁移由根执行。

```ts
const service = new GuanchaLoginService({
  attempts: new PostgresGuanchaAttemptStore(database),
  crypto: createNodeGuanchaCrypto(serverSecret),
  identity: createGuanchaAuth({ database, crypto: authCrypto, clock, ids }),
  provider: createGuanchaProvider({ clientId, clientSecret, origin, redirectUri }),
  clock,
  safeReturnTo: safeAuthReturnTo,
});
```

根必须把上述实例放在服务端，采用同源 POST 发起与确认绑定，限频、拒绝重复 query/cookie。`begin()` 返回的 browserBinding 仅设置 HttpOnly / Secure / SameSite=Lax / Path=/ Cookie。`complete()` 必须从该 Cookie 取值，不能从 query/JSON 中取 browserBinding。调用 state consume 的执行器必须已提交，不能跨第三方网络持有可回滚事务。

已有绑定且本地账号 active 时，根按原 M01 规则签发会话（并初始化本人空间）。没有绑定时，根设置短期 pending Cookie，保留 browser cookie，让用户完成本站邮箱登录或注册，展示绑定确认，然后用当前近期认证会话调用 `confirmLink`。pending 不是本站登录 session，不授权任何项目读取。绑定成功/失败与取消时清理短期 Cookie；原始 Cookie 不进 JSON、URL、日志。

正式 callback 建议 `https://frp-off.com:44353/api/v1/auth/guancha/callback`，须与官方后台实际登记精确匹配。`https://frp-off.com:44353/events` 是网站介绍地址，不据此假定回调已登记。根名称：`GUANCHA_CLIENT_ID`、`GUANCHA_CLIENT_SECRET`、`GUANCHA_REDIRECT_URI`。

根后续发现当前证书不可信，用户明确保留域名，只修穿透稳定性；该 TLS 问题仍是实际验收限制。callback 采用根确认的固定 origin 并同步到观猹应用；禁止关闭 TLS 校验进行真实授权测试。

## 官方协议

`createGuanchaProvider` 固定官方授权码端点：`https://watcha.cn/oauth/authorize`、`https://watcha.cn/oauth/api/token`、`https://watcha.cn/oauth/api/userinfo`，请求只用 `scope=read` 与 S256。token 用表单提交 client_secret 和 code_verifier；userinfo 按官方示例用 access_token 查询参数。仅取成功响应的正整数 `data.user_id`，与固定 `https://watcha.cn` namespace 组成身份，昵称仅显示。此协议是 OAuth；不解码 JWT 或伪称验证 OIDC。

官网公开 `/login` 组件 `/_nuxt/DPg5staz.js` 明确指向 [登录说明](https://agentuniverse.feishu.cn/wiki/EMYHwT3sIiUYaDkL1ZvcPntGnpb) 和 [申请接入](https://agentuniverse.feishu.cn/docx/McKCdI70Gols8hxiBVYcMfhCnNc)。两者公开 SSR 正文已通过匿名 PowerShell 请求核实；读取路径与契约差异见 `protocol-notes.md`。

适配固定可信 HTTPS endpoint，拒绝 HTTP 跳转，默认10秒超时、64KiB响应上限，不重试 token 兑换，不持久化 access/refresh token。默认原生 Node HTTPS 绕过框架 patched fetch 的 tracing/cache，TLS 校验开启。官方目前明确示例是 userinfo 查询参数，因此这个服务器私有 URL 不得写日志、进入浏览器或通用抓取缓存；根应关闭对该请求的完整 URL tracing。模块所有异常均脱敏且不记录日志，不能推定尚未确认的 Bearer header 支持。登录权限不使用第三方邮箱字段弥补身份缺失。

## 验证

`node --experimental-strip-types --test src/modules/guancha-login/*.test.ts`

测试涵盖 state 单次消费/错误浏览器/到期/配置变动、取消与失败不可重放、PKCE/nonce 加密、回跳保护、精确 issuer 与身份字段过滤，以及隔离内存 PGlite 真实 SQL。隔离 PGlite 不代表远程 PostgreSQL 多连接验收。provider 使用测试桩，无真实第三方登录成功声明。
