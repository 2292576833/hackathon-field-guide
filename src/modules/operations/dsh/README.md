# DeepSeek Harness 固定运行适配

本模块通过官方 `dsh` CLI 的 SDK profile / stdio JSON-RPC 实际执行模型推理。官方 TypeScript 客户端确实存在：`@deepseek-ai/dsh-sdk-client` 导出 `DeepSeekHarness` 和 `HarnessClient`；本适配直接实现同一个已核对的固定协议，避免向网页进程加载整个 Harness 或更改根依赖。

固定发布版本：`@deepseek-ai/dsh@0.2.1-alpha.1`。核对源码：`5badb15009ae1756c3afe0ae0cef1faafc290ccc`。npm 发布 integrity：`sha512-DJ8pwG/XqzwDrYQTgJXuIga6ku153Z4vJI/B3MzNtudVCkDaOf4O2pUQh1ToroLHPPe4mxhhFeNJ7ttNculqMw==`。运行时拒绝其他 package 名称或版本；部署者需要按该精确版本安装，并保留部署 lockfile。

官方依据（2026-10-08 核对）：

- [TypeScript SDK API](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/sdk/client/README.md)
- [固定 SDK wire types](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/sdk/protocol/src/types.ts)
- [CLI profiles 与配置层](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/apps/cli/README.md)
- [官方默认最小 profile](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/bundle/sdk-minimal/cordis.patch.yml)
- [模型端点与配置](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/llm/llm-deepseek/src/config.ts)
- [assistant/message usage 与 turn/end](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/session/src/types.ts)

采集器先通过已批准的搜索和网络访问实现获得公开网页证据；DSH 对传入证据进行无工具推理，输出严格 JSON。这里没有把普通 DeepSeek HTTP 请求误称为 DSH 搜索。`event_discovery`、`event_extraction`、`event_analysis` 和 `navigator` 均无 shell、文件、skills、MCP、子代理、Web 工具。每次调用使用全新隔离 home 和 session，固定空 bundle profile 只插入 SDK、模型和 agent 核心行。

适配器导出 `createDeepSeekHarnessAdapter(config, dependencies?)`，返回 `generate(request)` 和根 navigator 所需的 `request({task:'discovery'|'navigator',prompt,input,signal})`。初始化携带部署固定 model/maxTokens。网页任务不能选择可执行程序、配置、provider、插件或模型。`runtimePackageDirectory` 是部署者提供的绝对安装目录；本模块不自动安装包、不运行 npx、不执行任意命令。

官方模型插件当前使用 **Messages-compatible** 端点，默认 `https://api.deepseek.com/anthropic`。配置其他端点时必须是部署批准的 HTTPS 根，不能将 OpenAI `/v1` 端点直接当作相同协议。凭据从构造配置读取，只进入最小子进程环境 `DEEPSEEK_API_KEY`，不进入命令参数、任务 JSON 或错误文本。

usage 从官方 `assistant/message.data.usage` 汇总；总输入含 uncached/cacheRead/cacheWrite，不能把缺失 usage 当作 0。费用按部署者配置的每百万 token 费率估算，币种固定配置。未配置、版本不符、启动失败、协议错误、无 usage、非 JSON、超时和取消均是明确失败，不返回模拟成功。真实凭据推理、Messages 端点连通和生产 worker 并发取消仍需部署集成验收。

## 已验证（2026-10-08）

- `node --test src/modules/operations/deepseek-harness.test.ts`：23/23 通过，无跳过。
- 其中 22 项使用明确标记的本地子进程夹具验证协议、实际进程终止、字节/时间/输入上限、固定模型版本、JSON 与 usage 约束、秘密脱敏、无工具及配置拒绝规则。
- 1 项使用主会话精确安装的真实官方包 `.runtime/dsh-runtime/node_modules/@deepseek-ai/dsh`：`[lib/bin.js, --profile, m08-json, --dump-config]` 成功，实际配置没有工具/shell/MCP/skills/目录指令；`[lib/bin.js, --profile, m08-json]` 的 SDK `initialize` 返回 `deepseek-harness-sdk-runtime` / `0.0.1`。
- 离线检验在收到 `initialize` 响应后同步取消，早于 `session/prompt`，没有发送付费模型任务。它验证安装与启动协议，不验证实际模型凭据。
- 两个 TypeScript 文件的严格 NodeNext 类型检查通过。全局类型检查仍有 M06 测试与 `src/server/navigator.test.ts` 的并行集成错误；未越界修改。

已完成并停止修改上述适配、测试与本说明。业务发现卡片、证据校验、持久化、重试/取消 run 事实及人工审核由主会话的 M08 executor 和 M03 Port 组合；本适配不自动发布内容。
