# DeepSeek Harness 原生集成说明

本项目的所有网站聊天、赛事发现与赛事分析都通过后端的 DSH 适配层执行。浏览器不会直接调用模型，也不会把 DSH 凭据下发到浏览器。

## 官方来源与固定版本

- 官方源码：[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- 许可证：[MIT License](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE)
- 官方安全边界：[SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)
- Node 运行包：`@deepseek-ai/dsh@0.2.1-alpha.1`
- 源码提交：`5badb15009ae1756c3afe0ae0cef1faafc290ccc`

版本、源码提交和 npm integrity 在 `src/modules/operations/deepseek-harness.ts` 中固定；`npm run dsh:install -- --check` 会验证安装目录、包名、版本、入口和 lockfile 完整性。部署时不要使用 `latest`、浮动 alpha 标签或未核对的桌面版本。

## 项目适配边界

`src/modules/operations/deepseek-harness.ts` 是官方 CLI/SDK 的服务端适配层：每次请求启动一个固定 profile 的独立 stdio JSON-RPC 子进程，并只注入本次任务需要的系统提示、公开证据和有限项目摘要。导航员、赛事发现、赛事提取和赛事分析共用这个入口，统一记录实际 token 用量与费用。

适配层为本项目增加了以下约束：

1. 固定任务类型、模型版本、提示版本和 JSON 输出格式；导航员只接受服务器提供的链接 ID，未知链接会被拒绝。
2. profile 不加载个人 skills、MCP、shell、文件系统工具、子代理或数据库；模型输出中的页面内容按不可信证据处理。
3. 每次调用使用临时隔离 home、工作目录、超时、输入/输出/传输字节上限；结束后清理临时目录。
4. 缺少实际 usage、超时、凭据拒绝、协议错误或未知结果都会失败并按账本规则处理，不返回静态假成功。
5. DSH Desktop 模式只读取已安装桌面程序自己的账号授权，API key/容器模式只读取服务端显式配置；两者都不会把凭据写入网页响应、日志或项目文件。

## 两种运行方式

### 本机 Desktop

配置 `AI_PROVIDER=dsh` 和 `DSH_DESKTOP_DIRECTORY`，服务端通过 `src/server/dsh-runtime.ts` 调用已安装的 `DeepSeek Harness.exe`。桌面程序及授权目录属于部署机，不复制到项目，也不提交凭据。当前适配的桌面版本为 `0.2.0-rc.2`，升级前必须重新做协议和账号验收。

### Node/API 运行时

先执行 `npm run dsh:install` 安装精确锁定的官方 npm 包，再配置 `DSH_RUNTIME_PACKAGE_DIRECTORY` 和服务端 DSH 凭据。该方式适合 Linux、容器和没有桌面程序的服务器；它仍然经过同一适配层和同一安全限制。

## 验收命令

```powershell
npm run dsh:install -- --check
node --experimental-strip-types --test src/modules/operations/deepseek-harness.test.ts src/server/navigator.test.ts src/server/dsh-chat.test.ts
npm run typecheck
npm run build
```

这些检查只能证明固定包、协议适配和网站组合正确；真实模型调用还需要部署机保持 DSH 登录状态或配置服务端 API 凭据，并在不输出密钥的前提下做一次导航员和赛事分析验收。

## 不复制完整桌面源码的原因

项目已经直接集成官方可分发 npm 运行包和固定源码提交，并在适配层实现项目所需的受限协议。桌面安装目录包含账号授权、运行时文件和平台相关 Electron 资源；把 `D:\dddsss` 整目录或账号文件复制进仓库会扩大凭据和供应链风险，也无法替代服务器上的隔离、配额和权限检查。因此“源码集成”在项目中体现为可复现的官方包锁定、完整性校验和服务端适配，而不是把桌面程序或个人账号文件打包进网站。
