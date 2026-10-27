# 观猹官方协议依据

核对日：2026-10-12。用户确认官网 `watcha.cn`。官网公开 `https://watcha.cn/_nuxt/DPg5staz.js`（登录页组件）明确链接：

- [观猹认证接入文档](https://agentuniverse.feishu.cn/wiki/EMYHwT3sIiUYaDkL1ZvcPntGnpb)：wiki 元数据更新时间 2026-08-06。
- [申请接入链接指向的官方文档](https://agentuniverse.feishu.cn/docx/McKCdI70Gols8hxiBVYcMfhCnNc)：完整 token/userinfo 例子可公开读取。

匿名 PowerShell `Invoke-WebRequest -UseBasicParsing` 返回含正文的 HTML。源数据在 `window.DATA.clientVars.data.block_map` 的 `data.text.initialAttributedTexts.text["0"]`；页面 permission 标记允许。普通 Node fetch 或网页工具本次出现跳登录/不可读，不能据此断言文档没有公开正文。

可复核（不需要 Cookie、凭据或本地 env）：

```powershell
$guanchaDoc = Invoke-WebRequest -Uri 'https://agentuniverse.feishu.cn/docx/McKCdI70Gols8hxiBVYcMfhCnNc' -UseBasicParsing -TimeoutSec 20
[regex]::Matches($guanchaDoc.Content, '"text":\{"0":"((?:\\.|[^"\\])*)"\}') |
  ForEach-Object { ('"' + $_.Groups[1].Value + '"') | ConvertFrom-Json } |
  Select-Object -Unique
```

适配采用的事实：授权 GET `/oauth/authorize`；兑换 POST `/oauth/api/token`，表单编码且机密客户端提交 client_secret，S256 时提交 code_verifier；资料 GET `/oauth/api/userinfo?access_token=…`。均固定在 `https://watcha.cn`，不使用前端 `/oauth2-server/` 内部接口。token 成功是顶层 OAuth 字段，userinfo 成功为 `statusCode=200` 的 `data`，以整数 `user_id` 为唯一用户标识。

新版允许 read、email、phone；本次只申请 read。未取得 email_verified 契约，不请求邮箱、不自动合并。新版后半块分页匿名不可读；没有证实 Bearer header 能代替 userinfo query，不猜替代传法。无真实 token 被用于此次文档核验。

`https://watcha.cn` 是本地固定身份 namespace，不宣称观猹返回 OIDC `iss` 或 ID token。真实 OAuth 授权、应用凭据是否有效、回调是否登记及当前站点可信 TLS 均需根另验收。
