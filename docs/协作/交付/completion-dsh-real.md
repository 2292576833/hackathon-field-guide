# 名片摘要与项目可行性真实 DSH 验收

状态：两项真实调用均通过并保存；脚本与本文交还主会话，停止编辑。验收日期：2026-10-10。

## 脚本与边界

`scripts/verify-completion-dsh-real.mts` 使用现有 `loadConfig` 读取实际 DSH 接入；不打印配置、凭据、文件路径、虚构用户资料或完整模型正文。

组合采用 `createDatabase({})` 的全新内存 PGlite，并将该数据库显式传入 `createApplication`；实际 databaseUrl/localDatabasePath 均被清除。仅保留现有 DSH 模型配置，关闭邮件、GitHub、发现、灵感及来源代理配置，不启动 worker，不发送验证码，不调用搜索或导航聊天。资料使用虚构账号与明确标注的隔离测试项目，不读取真实用户聊天或生产资料，不发布名片、不共享团队建议。

脚本缺省及 `--dry-run` 只做零请求准备检查；`--run` 是明确的真实调用入口。每个功能只调用一次：

1. R01 `recruiting.generateSummary` → `profile_summary` → 当前真实 DSH 结构校验 → 本人私人生成记录。
2. R03 `teamAssistant.generateFeasibility` → `project_feasibility` → 当前上下文指纹与来源校验 → 本人私人选题检查记录。

根现有 `createDshPersonalWorkspace` 采用 `maxAttempts=1`。脚本额外限制可调用的两个 kind 和总调用数，限制本次隔离账号账本为 2 次、最多 100,000 微美元（0.10 USD）；输入不超过 65,536 字节、输出不超过 4096 tokens、单次超时不超过 90 秒。若现有配置更严格，保留更严格输入/费用/超时限制；输出限制不能支持 4096 时在真实调用前明确失败。

不得通过重复执行脚本隐性重发未知请求。invalid、超时、未知结果仅记录安全错误码；不改模型结果为通过、不用 mock 或静态回复补位。本次真实运行只有一轮，共两次模型请求。

## 实际结果

| 功能 | 真实 DSH 与 SQL 保存 | 安全输出元数据 |
| --- | --- | --- |
| 参赛名片摘要 | passed，`provider:dsh`，写入 `profile_summary`，本人读回一致，另一虚构账号读取 404 | 461 字节；headline + introduction 共 38 字；年龄/MBTI/头像默认未展示，城市/每日时间与原资料一致 |
| 项目可行性 | passed，`provider:dsh`，写入 `project_feasibility`，本人读回/列表一致，另一虚构账号读取 404 | 7,722 字节；summary 94 字；14 个 finding；4 个验证任务；明确未知事项；当前上下文指纹一致且不 stale |

最终账本：

- `serviceInvocations: 2`，`modelRequests: 2`，`budgetReservations: 2`。
- `usageVerified: 2`：两次均使用实际 runtime 测得的 token 用量结算。
- `chargedMicroUsd: 2326`，即 0.002326 USD；未输出配置费率。
- `remainingReservedMicroUsd: 0`，`unknownHolds: 0`。
- `artifactKinds: ["profile_summary", "project_feasibility"]`。
- `publicCards: 0`，`sharedSuggestions: 0`，`automaticallyShared: false`，`automaticRetries: 0`。
- 真实运行退出码 0；结束后关闭并销毁隔离数据库。

保存验证走实际根服务、业务校验和 SQL Port，不仅检查模型打印的 JSON。但测试数据库是内存隔离环境，退出后不保留这些虚构内容；本轮不声称已验证生产账号、远程 PostgreSQL 或跨重启磁盘保留，也不代表选题在真实比赛中已可行或可获奖。

## 费用、未知状态和隐私检查

调用前读取本人的 execution、usage、budget，确认均无已有调用；生成前确认没有公开名片与团队共享建议。调用后再次检查：所有 usage 已 settled、费用与账本合计相等、剩余预留为零、调用次数未超两次、执行不残留 running。若没有实测 usage 且结果未知/已响应，脚本要求完整预留保守记账；unknown 必须对应未知执行 hold，不允许伪造零费用或重发。本次无 unknown，未以人工故障注入冒充真实未知故障验收。

成功结果同时核对当前规则校验、实际私有保存、本人读回、他人 404、未自动公开/共享。完整正文没有写到日志或交付文档。没有实际用户删除、生产迁移、网站重启或配置文件修改。

## 运行方式

准备检查（零模型请求）：

```powershell
node --env-file-if-exists=.env.local --experimental-strip-types scripts/verify-completion-dsh-real.mts --dry-run
```

真实调用（会消耗现有 DSH 账号费用；必须作为新的明确验收执行，不自动重跑）：

```powershell
node --env-file-if-exists=.env.local --experimental-strip-types scripts/verify-completion-dsh-real.mts --run
```

本轮准备检查已通过，唯一真实一轮已通过。最终 `npm run typecheck` 退出码 0，全局类型检查通过。中途其他会话的公共类型导出阻断由对应负责人完成，本脚本没有越权修改。

NEEDS_INTERFACE：无新增模块接口、环境变量、依赖或迁移。后续类型导出/全局构建及生产部署由主会话统筹。
