# Linux 官方 Node 账号适配交付

状态：2026-10-12 已完成，源码冻结，STOP 交还主会话。仅修改本次明确授权文件。未读取生产凭据、未调用真实模型、未构建或部署。

## NEEDS_INTERFACE

- 复用已有 `DeepSeekHarnessConfiguration.accountCredentialsFile`、`runtimePackageDirectory`、`workingDirectory`；不新增环境变量。根配置须保证 Desktop、Node account、API key 三选一，路径为服务器绝对路径。
- 根 `createServerDshAdapter` 在无 Desktop 路径时已经委托 `createDeepSeekHarnessAdapter`，本次在后者内部选择 Node account；无需更改 `dsh-runtime.ts`。
- `createDshNativeSearchRuntime` 已在存在非空 `accountCredentialsFile` 时选择固定官方 Node 包；其结果、usage、错误 externalState 和调用接口保持不变，根 `createNativeDiscoverySearch` 不需改签名。空的未选模式配置项保留兼容，非空的混合模式拒绝。
- 新本地前置失败码 `DSH_ACCOUNT_CREDENTIAL_INVALID`（尚未启动子进程、未发送请求）：根 `src/server/dsh-model.ts` 的 `unsent` 列表及其它根费用分类器需登记为 `not_sent`，避免对本地无效授权误记 unknown hold。已经派发后的异常继续按原规则保守处理，不能扩大该白名单到供应商拒绝或超时。
- 根部署须只读挂载私密 grant 文件，保证服务 UID 可读且无其他账号访问；保留临时 HOME 私有目录、原预算及未知请求 hold。仅配置路径不代表授权有效。
- Compose 的 `.runtime/server-control` 可写挂载、Docker 上下文排除 `.next-*`、实际账号登录/迁移、目标 Linux 真实推理/搜索验收仍由根负责。

## 已完成

- `src/modules/operations/deepseek-harness.ts`：Node account 分支使用固定 `@deepseek-ai/dsh@0.2.1-alpha.1` CLI、账号 profile、`deepseek-account` provider；不注入 `DEEPSEEK_API_KEY`，分析仍无工具，供应商 retry 为 0。
- 同文件公开 `inspectDshNodeAccountRuntime`、`readDshNodeAccountGrant`、`probeDshNodeAccount`，供搜索复用；没有引入模块反向依赖 server 的结构，也不需要新 `dsh-account-runtime.ts`。
- 必要账号插件名称、版本和入口必须匹配固定安装包；YAML parser 只能来自同一安装的 node_modules。源授权仅以只读方式打开，限制 1 MiB、拒绝路径别名/符号链接及读取期间替换，Unix 要求当前 UID 所有且无 group/other 权限。严格解析唯一键，不接受 YAML alias、非官方 issuer、mock grant、无效 token 或错误版本。
- 每次请求在已保护的临时目录创建 HOME，仅写 `deepseek-account-platform/default` 的 `kind/version/issuer/token`；其它 grant、device、无关字段不复制。官方包即使在 401 后删除临时 grant，也不会修改源授权。
- `src/server/dsh-search-runtime.ts`：Node 模式使用 `process.execPath`，同版官方账号及搜索插件，`desktopPlatform:null`（官方 Linux/非 Desktop 配置，不伪造 win32）；Desktop 仍走原 exe/probe。一次请求只能访问固定官方 Messages 端点一次，固定原生 web_search 工具；仅采用真实结构化搜索块和 cited_text，保留缺失 usage 为 null、发出后失败为 unknown、取消/超时/清理原规则。
- 仅改上述两个实现、各自 `.test.ts` 和本交付。未修改根 config、dsh-runtime、dsh-model、Docker/Compose、依赖、迁移、数据库或其它文件。

## 官方接口核对

核对来源为本机已安装 `.runtime/dsh-runtime/node_modules` 的官方包源码，未猜测 HTTP 或 CLI 接口：

- `dsh-credentials-local` 使用 YAML、`$DSH_HOME/.credentials.yaml`、`watch:false`；其账户记录名由 `credentialKey("deepseek-account-platform", "default")` 确认。
- `dsh-deepseek-account-platform` 的 grant 为 `{version:1,issuer,token}`；`resolveToken` 用于官方推理 origin。`desktopPlatform` 的 schema 仅接受 darwin、win32、null，故 Node 采用 null。
- `dsh-llm-deepseek-account` provider 为 `deepseek-account`，实际用 `x-dsh-auth-token`，不接受把 grant 当作 API key。
- `dsh-web-search-deepseek` 通过账号 provider 的会话上下文取 token，发固定 `web_search_20250305` 请求；账户路由的完整搜索已用官方模块和测试传输验证。
- CLI 没有据此确认独立 `dsh login` 命令；核对到官方 `web` profile 及 `--host`、`--port`、`--no-open` 参数，登录使用该官方界面。

## 已验证

在当前 Windows 开发环境，以 Node 24、模拟 grant 和隔离临时目录运行：

```text
node --experimental-strip-types --test src/modules/operations/deepseek-harness.test.ts src/server/dsh-search-runtime.test.ts src/server/dsh-runtime.test.ts src/server/native-discovery.test.ts src/server/dsh-model.test.ts src/server/dsh-lifecycle-audit.test.ts
```

65 项：64 通过，1 项跳过（原有真实 Desktop 安装 opt-in 测试未设置开关）。Desktop 模拟回归、API key 模拟回归和官方 API key profile 离线握手已通过。

新增验证包括：最小 grant 提取/原文件不变、版本和混合模式拒绝、空配置项兼容、恶意/重复 YAML/alias、限制和清理、账号 RPC provider、无工具及零重试 profile、真实官方 Node profile 离线握手、官方账号完整 Messages SSE 推理、官方 401 单次请求且不改源授权、官方 Node 原生搜索完整映射、缺 usage/无原生块/泄露片段/取消/超时的保守失败。

所有官方模块执行测试都只用模拟 grant；完整推理与搜索由测试替换整个网络传输，握手测试先阻断 fetch 并在发 prompt 前取消。没有对真实账号发出收费请求。

四个修改的 TypeScript 文件通过独立 `tsc --noEmit --strict --skipLibCheck --allowImportingTsExtensions --target es2022 --module nodenext --moduleResolution nodenext`；没有运行全局构建。

## 根部署与登录说明

1. Linux ECS 使用已固定的 Node runtime，不复制 Windows exe 或已有 Windows node_modules。安装包存在与账号登录是两件事。
2. 首选在实际服务 UID 下使用专用 DSH HOME 登录；也可由根经用户授权安全迁移原 Desktop grant。只迁移必要 grant，不传整份个人会话目录，不打印内容，不写 Docker build args/镜像。
3. 容器中的授权路径例如 `/run/secrets/dsh-account.yaml`，仅作为路径示例。宿主文件应归运行容器的实际 UID 所有（当前 Dockerfile 的 node 用户通常为 1000），0400 或 0600，只读挂载。临时会话目录继续使用原独占挂载。源授权到期需要重新登录或重新安全迁移，不在一次模型调用里自动登录。
4. 登录可在隔离的管理终端使用官方 web profile；以下是给根在目标服务器按实际路径替换后的操作示例，本次没有执行：

```sh
# 在实际服务 UID 下；专用 HOME 须预先建立且仅本人可访问。
DSH_HOME=/srv/field-guide-private/dsh-account \
  node /srv/field-guide/.runtime/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile web --host 127.0.0.1 --port 8765 --no-open
```

通过 SSH 本地转发访问该 loopback 管理界面，在官方页面完成登录，之后退出管理进程。不要开放 8765 到公网。启动终端给出的管理入口可能含临时访问令牌，不能粘贴聊天或验收日志。登录界面与授权流程尚未在目标 ECS 实测。

5. 服务器配置只保留 Node account 模式的非空字段：`DSH_ACCOUNT_CREDENTIALS_FILE`、`DSH_RUNTIME_PACKAGE_DIRECTORY`、`DSH_MODEL`、`AI_PROVIDER=dsh`，以及原费率/超时/预算/搜索配置；不新增配置名。当前是否还有独立 API key 未检查，不假定存在。
6. 本地探测函数只返回安全元数据，不启动模型：

```js
import { probeDshNodeAccount } from "./src/modules/operations/deepseek-harness.ts";
console.log(await probeDshNodeAccount({
  runtimePackageDirectory: process.env.DSH_RUNTIME_PACKAGE_DIRECTORY,
  accountCredentialsFile: process.env.DSH_ACCOUNT_CREDENTIALS_FILE,
}));
// { version: "0.2.1-alpha.1", grantConfigured: true, remoteVerified: false }
```

`grantConfigured:true` 只证明本地结构与权限；不证明 grant 未过期或供应商接受。根仍需完成一次受预算约束的真实推理、一次真实搜索、失败不重放与费用账本核对。新错误码的根分类接入见 NEEDS_INTERFACE。

## 验证边界

未做 ECS 实体 Linux/容器验证、真实账号登录、grant 跨平台迁移、真实模型费用或真实公网搜索验证。Unix owner/mode 拒绝分支保留条件测试，当前 Windows 运行不等于该分支实测。DSH 仍遵循原未知请求 hold；无迁移、无预算重置、无配置值输出。

STOP：文件交还主会话，不沿用本次权限继续修改。
