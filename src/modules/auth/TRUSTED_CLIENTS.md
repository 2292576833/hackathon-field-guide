# 连接模式的可信客户端限流

生产 Next.js 从 `trusted-client.server.ts` 导入 provider。入口使用 `import "server-only"` 阻止进入客户端组件；Node 测试或服务 CLI 使用 `client-key.ts`，其实现依赖 Node 内置库且工厂拒绝浏览器运行时。模块不读取环境变量，密钥由 root 服务端注入，不能传给 UI。

## 模式与配置 Port

`AuthClientKeyPort.getClientKey(request): Promise<string>` 只提供限流归属，不授予 Actor、项目或仓库权限。HTTP 工厂用 `clientKeys` 注入；旧 `getClientKey` 回调保留过渡，两者不能同时配置。

| 模式 | 配置与行为 |
| --- | --- |
| `shared-budget` | `createClientKeyProvider({mode,budgetId})`，显式稳定的全体共享预算，忽略所有转发头 |
| `direct` | 注入 `ClientConnectionPort.getPeerAddress(request)`，真实 TCP/socket 或受信平台元数据；忽略所有转发头 |
| `trusted-proxy` | 同一 Port + 非空 `trustedProxyCidrs` IP/CIDR allowlist；未受信 peer 拒绝，只在受信 peer 上解析指定转发头 |
| 签名代理 | `createSignedProxyClientKeyProvider({proxies,origin,clock})`，登记 proxyId 与私密 signingKey，校验专用签名头 |

TCP 代理模式默认读取 `x-forwarded-for`，从右向左跳过受信代理，取最近的不受信客户端；客户端填的最左项不能越过该边界。可指定单值 `x-real-ip`。缺真实连接元数据、缺头、全代理链、地址/端口/zone 无效、超过默认 16 跳或 2048 字节头，均返回脱敏 `AUTH_CLIENT_SOURCE_UNAVAILABLE`（503），不会改变模式。IPv4、映射 IPv6 和压缩 IPv6 归一；原生 IPv6 网段不会隐式信任 IPv4。

Web/Next `Request` 没有真实 TCP socket。禁止将 `x-proxy-peer` 等客户端可填头实现为 `getPeerAddress`。若 root 通过 WeakMap 等容器附着连接元数据，`boundedRequest` 创建新 Request 时必须传递这些受信元数据；不能因元数据丢失改读任意头。

root 目前连接模式的固定共享预算可明确保留，待部署策略具备后再选择独立客户端模式。不要用随机 key、Cookie、客户端自报 ID 或关闭限额来替代证明。

## Next.js 的私有代理证明

`proxies` 是显式 allowlist：每项 `{id,signingKey}`，代理 ID 唯一、独立随机密钥至少 32 字节；构造时复制配置。只读取默认专用头 `x-hackathon-client-attestation`，不读取任意 XFF。缺失、重复合并头、未知代理、错误 HMAC、过期或方法/路径/查询不符都返回 503。

代理必须覆盖客户端同名头，并从真实 socket 或已验证代理链产生 clientAddress。代理至应用需要 TLS 或受控链路。默认证明有效 30 秒，未来偏差最多 5 秒；短期重放仍进入同一客户端预算，不能产生新身份，协议不承诺一次性。

可在受信 ingress 使用 `signProxyClientAttestation(input, origin, signingKey)`。输入字段为：

```ts
interface ProxyClientAttestation {
  proxyId: string;
  clientAddress: string;
  issuedAt: number; // Unix 毫秒
  method: string;   // 应用收到的方法，例 POST
  target: string;   // 应用收到的 pathname + search
}
```

签名消息固定为 UTF-8 的 JSON 数组：

```text
["hackathon-client-key",1,固定AUTH_ORIGIN,proxyId,原始clientAddress,issuedAt,method,target]
```

签名是 HMAC-SHA256 小写十六进制 64 字符。以上五个输入字段与 `signature` 构成仅六个字段的 JSON 对象，再 canonical base64url 编码为专用头。应用先按原始字段验签，再归一地址。固定 public Origin 绑定签名 audience，不信任 Host 或 forwarded-proto；请求 URL 在 Next 内部为 HTTP/loopback 时仍可验证，方法/路径/查询保持一致即可。

这是私有的限流归属证明，不是 Actor、网站会话或 RFC 9421 实现。原始 IP 与证明头不写入 profile/session/audit；AuthService 使用现有 HMAC 将客户端 key 变为持久限流标识。

## 给 root 的配置建议

建议新增配置名称：`AUTH_CLIENT_KEY_MODE`、`AUTH_TRUSTED_PROXY_CIDRS`、`AUTH_TRUSTED_PROXY_IDS`、`AUTH_PROXY_ATTESTATION_KEYS`（服务端秘密映射）、`AUTH_PROXY_ATTESTATION_HEADER`。没有 TCP metadata 的 Next 部署若采用签名模式，root 必须在实际 ingress 安装签名适配；只填写应用环境变量不会让任意头变可信。

主会话本轮已选择 `AUTH_PROXY_SIGNERS_JSON` → `config.authProxySigners: [{id,signingKey}]`，该显式列表同时决定受信代理 ID 和秘密密钥。签名模式或保守共享预算使用此 root 配置即可；上面的其他名称仅可选 TCP 策略建议，不要求重复配置。root 不记录秘密 JSON 的值。`index.ts` 已导出 provider 给 Node 服务/CLI；Next 生产 server-only 入口也可直接使用。

实例只保存已明确登记的代理，不接受 `true`、跳数信任或从请求动态决定 allowlist。推荐最小实际代理网段；拒绝 `/0`。签名 mode 的 ID/key 须一一对应，不能记录配置值、签名包或私密 key。

独立客户端模式保留默认每客户端发送 20/验证 50 次额度。root 当前 `AUTH_GLOBAL_SEND_LIMIT/AUTH_GLOBAL_VERIFICATION_LIMIT` 用于共享 budget；切到独立客户端后，全站 200/500 等总预算应另行组合，不能把全站额度直接当作每客户端上限。`shared-budget` 继续保持保守全站预算时无此切换。

主会话同时需要把 `002_session_last_seen.sql` 纳入新的根迁移，并绑定 `GET /me/account-settings`、`GET /me/session` 路由；不能重写已应用初始迁移。页面会话动作按 receipt 的 `currentSessionRevoked` 决定返回登录页，服务端已负责相应清 Cookie。

官方依据：[Express 代理信任](https://expressjs.com/en/guide/behind-proxies/)、[Node socket.remoteAddress](https://nodejs.org/api/net.html#socketremoteaddress)、[NextRequest](https://nextjs.org/docs/app/api-reference/functions/next-request)、[签名字段与 TLS 的安全考虑](https://www.rfc-editor.org/rfc/rfc9421.html#section-7)。
