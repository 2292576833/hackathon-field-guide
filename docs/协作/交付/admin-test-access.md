# 管理员短时一次性测试凭证 · 服务与离线 CLI 交付

日期：2026-10-11。执行会话：event_disclosure_acceptance。状态：服务与 CLI 已交付并 STOP，文件交还主会话。

## 已完成

本轮只新增：

- `src/server/admin-test-access.ts`
- `src/server/admin-test-access.test.ts`
- `scripts/issue-admin-test-access.mts`
- 本交付文档

`issueAdminTestAccess({database,codePepper,email,clock?,ids?,globalSendLimit?})` 返回：

```typescript
{
  credential: `${challengeId}.${code}`,
  challengeId,
  email,
  issuedAt,
  expiresAt,
}
```

仅供受信任离线 CLI 使用，不注册 HTTP 签发接口、不创建用户、不授予角色、不返回会话 token。服务复用现有 `AuthService`、`PostgresAuthStore` 与同一 `codePepper`，使用既有随机 8 位码、10 分钟期限、重发冷却、邮箱/客户端预算与 auth 审计。

事务遵循 M01 的邮箱 advisory lock → 用户行锁顺序，核对已有 active、邮箱已验证且有 admin 权限的账号，再签发。捕获端仅本机保管，未联系真实邮件供应商；输出文案明确不发邮件。返回前核对捕获的 email/code/expiry 与已保存的 ready 挑战及其 HMAC 摘要相符，附加 `trusted_cli_test_challenge` / `issued_locally` 审计。审计没有邮箱、验证码、凭证、pepper 或 session token；审计失败整次签发回滚。

**凭证期限与登录会话期限不同**：凭证默认 10 分钟且一次消费；经既有公共验证器兑换后的普通会话仍按网站现有规则最长 7 天。凭证不会恢复被移除的管理员角色；后续后台入口仍复核当前账号与角色。未新增签名 metadata 机制或第二套身份权限。

## CLI 调用与本机保管

主会话完成身份确认、停服、独占数据库确认和冷备后调用：

```powershell
& 'C:\Program Files\nodejs\node.exe' --env-file-if-exists=.env.local --experimental-strip-types scripts/issue-admin-test-access.mts --email <已有管理员邮箱> --output .runtime/admin-test-access/<新文件名>.json
```

根会话需预先建立自己拥有的 `.runtime/admin-test-access` 目录。CLI 要求从本项目根目录执行，读取同一 `.env.local` 和现有服务配置，不 migrate、不 seed、不创建完整应用、不启动后台任务。嵌入式数据库打开前必须确认 IPv4/IPv6 loopback 的 3000 端口都无监听；不确定、超时、监听时均拒绝。连接 `DATABASE_URL` 时沿用实际连接和事务。

输出只允许 `.runtime/admin-test-access` 下新的单层 `.json` 文件。拒绝越界、保留设备名称、现存文件、symlink/junction，以及 Windows ReparsePoint；检查目录 `lstat` / `realpath`，Windows 追加原生属性检查。复用现有 owner-only 私密目录保护，文件 `wx` + `0600` 创建，再继承 NTFS 限制权限。标准输出只含相对文件名、到期时间和未发邮件说明；失败只输出固定阶段说明，不打印异常、凭证或配置值。若本机文件保管失败，尽力撤销本次已签发挑战并清除本次新建文件。

文件包含实际凭证、生成/到期事实、普通登录链接与操作说明。链接只含 `test=1` 和 `/admin` 返回地址，**不把凭证、code 或 challengeId 放入 URL**。本机链接是 `http://localhost:3000/login?test=1&returnTo=%2Fadmin`，配置链接使用当前 `AUTH_ORIGIN`；公网部署的严格 Origin/安全 Cookie 仍由现有登录接口执行。本机 URL 不表示可绕过公网 Origin 验证。

目录文件不放入站内索引、网页目录或发布包。打开文件取得凭证，交给用户指定的测试登录密码框，提交原 `POST /auth/login-challenges/verify` 即可。不要点击“获取邮箱验证码”，它会撤销本次旧挑战。

## 已验证

`node --experimental-strip-types --test src/server/admin-test-access.test.ts`：**10/10 通过，0 失败、0 跳过**。最后一轮 Windows ReparsePoint 检查加入后的测试通过，约 9 秒。

覆盖：

- 真实独立内存 PostgreSQL 兼容 SQL 的签发、捕获 metadata 与保存事实一致、账号及角色不变、审计不泄露秘密。
- 无账号、普通账号、暂停账号拒绝；未验证账号使用明确 SQL Port 夹具防御检查，未修改生产 NOT NULL 约束。
- 原验证器一次消费、并发重复消费只有一次成功、10 分钟到期、错误码 5 次锁定、普通 7 天会话、主动退出。
- 60 秒重发限制、邮箱 3 次/15 分钟预算、新码撤销旧码、角色撤销不能借测试凭证恢复。
- 审计写入失败使挑战、预算和 auth 审计整体回滚。
- 临时文件夹具的越界、目录链接、覆盖拒绝、无秘密的登录 URL；独立随机端口监听检查。

日志：`.runtime/admin-test-access-tests.log`。全局 TypeScript `--noEmit --incremental false` 检查通过，日志 `.runtime/admin-test-access-typecheck.log`。

## 真实验收边界与 NEEDS_INTERFACE

未运行实际签发 CLI、未读取真实 env 值、未打开生产 PGlite、未构建、迁移或重启。测试使用独立内存数据库和明确夹具身份；文件与端口检查也使用拥有的临时目录与随机端口。PGlite 测试不证明远程 PostgreSQL 多连接并发；3000 监听检查不替代主会话确认没有其他进程打开同一嵌入式目录。

由主会话完成普通登录 `test=1` 粘贴入口、根 package 命令、隔离 E2E、真实管理员身份检查、单实例停服签发和最终浏览器登录。CLI 不会自动授予权限；若账号缺角色，需要主会话在用户既有授权下复用 `grantVerifiedRole`，不在本服务偷偷提权。

新增环境变量：无。使用现有 `AUTH_CODE_PEPPER` / 本机 retained pepper、`APP_MODE`、`AUTH_ORIGIN`、`DATABASE_URL` 与当前邮件/模型配置的正常加载规则；值不出现在本交付。

本轮全部文件已 STOP 交还，旧比赛折叠测试权限未恢复。
