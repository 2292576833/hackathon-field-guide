# 资源入口维护与来源可观测状态根适配交付

日期：2026-10-10。仅新增本次授权的 `src/server/resource-link-maintenance.ts/.test.ts/.sql`、`src/server/operations-observability.ts/.test.ts`、`src/components/source-observability.tsx`，并修改 `source-manager.tsx` 接入管理员组件。没有修改 application/router/background、根迁移、模块代码、配置或依赖，没有打开生产数据库。

## 已完成

### 当前审核资源的有界后台 HEAD 检查

- `createResourceLinkMaintenance` 从 M09 当前公开快照及实际 M08 已发布审核读取精确 URL：资源已发布、外链未阻止、审核属于该资源、已发布内容版本一致、实际审核链接一致。待审核草稿、下架/阻止外链、缺失真实审核的种子条目和审核地址不匹配的条目不能进入白名单。
- 每轮最多读取 100 个批准入口，优先未检查/较旧记录；默认每轮最多 3 个网站，可配置 1–5 个。每轮检查间隔最少 60 秒，同一网站至少 24 小时。跳转目标也必须属于本次精确批准 URL 集合，跨网站跳转先持久预占目标站间隔。
- `resource_link_maintenance_state` 保存周期与有截止时间的令牌租约；`resource_link_maintenance_sites` 在请求前保存网站下一次允许检查时间。超时、失败、取消、进程重启都不能重置该网站间隔。网络期间不持有数据库事务。
- 每次 HEAD 和内容跳转之前使用真实 `assertRobotsAllowed`，配合原生 `createNodeNetworkPorts` 的公开 DNS、固定连接 IP、TLS、同源 robots 跳转、体积及时间限制；随后复用 M09 DNS 固定的 HEAD 传输和完整 URL 白名单。不会读取页面正文、发送 Cookie/鉴权头、调用模型或使用不受限 fetch 降级。
- 默认单入口总超时 8 秒，允许 100–15000 毫秒。租约在每次操作及保存前复核；资源 revision、公开 version 或批准入口在检查中变化，旧结果不写入。租约过期结果也不写入。
- 结果独立保存于 `resource_link_check_results`。HEAD 2xx 为 available，明确 404/410 为 unreachable；超时、网络错误、访问限制、不支持 HEAD、robots 无法确认/禁止以及跳转限制均为 unknown。任何结果都不修改 M09 linkStatus、publicationStatus 或审核状态。
- 管理员 GET 只读当前 revision/version 的已保存结果及周期摘要，不初始化状态、不调度、不检查网络。输出资源 ID、公开版本、hostname、时间、固定原因码和 HTTP 状态；不输出原始 URL/query、租约令牌、原文或配置。检查失败的周期不能标为已完成。

### C07 来源可观测状态的真实根组合

- 复用 C07 `createOperationsObservabilityService`、真实 SQL QueryPort 和 GET handler，不建立第二份来源、任务或完成状态。原有有界窗口、签名游标、失败归类、真实排队/执行耗时及敏感字段投影规则保持一致。
- 活跃且已验证的管理员账号在同一事务读取前、读取后都重新锁定核对；同时调用根传入的当前请求会话 guard，顺序为账号 → 会话。缓存 Actor admin 标记不能代替当前数据库权限，普通用户、停用账号、失效会话均不能读取。
- 真实 `backend_worker_heartbeats.kind='source'` 选取仍存活的服务实例优先于新停机记录；120 秒无心跳视为 stale。固定 `scope:'all_sources'`，缺记录明确 not_started，不冒称每个来源都有独立执行服务。
- 模型查询仅限该来源真实 `source:<sourceId>` 账本。调用与金额属于当日 UTC；未结预留及 unknown execution/usage、过期运行请求查询覆盖全部历史。跨日、刷新不会解除旧请求 hold。未知/不完整或未配置价格的费用为 null，不能表示免费。
- source-manager 选中来源后显示 `AdminSourceObservabilityPanel`。后台通用资源维护区显示最近检查、空状态、读取错误、版本及人工核对说明，刷新按钮只读记录。管理员条件控制组件挂载，API 仍独立复核权限。
- 来源面板下明确说明：调用与费用为 UTC 当日，预留/未知请求跨全部历史保存。

## NEEDS_INTERFACE：主会话组合

本次没有接入根路由、实际迁移或启动 worker。主会话应完成下列组合，不能将本报告的隔离通过表述为已经上线运行。

### 当前请求身份

两项工厂复用同一个导出类型：

```ts
interface OperationsAdminPrincipal {
  actor: Actor;
  guard(sql: SqlExecutor): Promise<void>;
}
```

`resolvePrincipal(request)` 必须从已验证网站会话读取 actor，并提供在当前 executor 上复核同账号当前 session、未撤销和未过期的 guard。现有 router 的 `principal(request)` 返回 `{actor,guard}`，结构可以直接使用。不能传空 guard 或从 query/body 接收 actor。

### 来源查询工厂

```ts
createOperationsObservability({
  database: DatabasePort,
  clock: Clock,
  cursorSecret: string, // 32–4096 字节，只在服务端
  sourceModelConfigured: boolean,
  sourceBudget?: AiBudgetPolicy,
  resolvePrincipal: (request: Request) => Promise<OperationsAdminPrincipal | null>,
  requestId: (request: Request) => string,
})
```

返回：

```ts
{
  service: { source(principal, input: SourceObservabilityInput): Promise<SourceObservabilityReport> },
  handlers: { source(sourceId: string): (request: Request) => Promise<Response> }
}
```

路由：`GET /api/v1/admin/sources/:sourceId/observability` → `handlers.source(sourceId)(request)`。cursorSecret 可用现有服务端 codePepper 加命名空间派生，sourceBudget 传真实 `config.dsh.sourceBudget`。已有 C07 管理员面板默认读取该路径，组件包装导出 `AdminSourceObservabilityPanel({sourceId,endpoint?})`。

### 资源维护工厂与 SQL

```ts
createResourceLinkMaintenance({
  database: DatabasePort,
  clock: Clock,
  network?: {dns: PublicDnsPort, transport: PinnedFetchPort},
  headTransport?: ResourceLinkTransport, // 隔离测试可注入；生产默认真实 HEAD
  userAgent?: string,
  proxyUrl?: string, // 只用于已有可信 loopback robots CONNECT 网络
  batchSize?: number,
  timeoutMs?: number,
  resolvePrincipal?: (request: Request) => Promise<OperationsAdminPrincipal | null>,
  requestId?: (request: Request) => string,
})
```

返回：

```ts
{
  runOnce({signal?} = {}): Promise<{
    status: 'completed' | 'waiting' | 'busy' | 'cancelled',
    cycle: string | null, checked: number, skippedChanged: number
  }>,
  status(principal, {limit?} = {}): Promise<ResourceLinkMaintenanceStatus>,
  handlers: {status(request: Request): Promise<Response>}
}
```

- 根新递增迁移复制 `src/server/resource-link-maintenance.sql` 三表/索引建议；运行时没有 DDL。
- 根后台循环显式调用 `runOnce({signal})`。建议每 60 秒检查一次状态；持久表控制实际周期/站点间隔。多进程必须共享真实 PostgreSQL，不能两个进程同时打开 PGlite 目录。
- `GET /api/v1/admin/resources/link-checks` → `handlers.status(request)`，唯一可选参数为 limit（1–100，默认30）。没有 POST 启动入口，也没有公开 GET。
- `AdminResourceLinkMaintenancePanel()` 已接到 source-manager，默认读取上述 GET；API 未组合时会显示真实读取错误。
- 缺少真实审核记录的资源即使存在公开种子卡片也不会被后台当作已批准入口，不能为了填充检查列表补造审核。

## 已验证与边界

- 11/11 新增测试通过（约9.96秒），日志 `.runtime/operations-root-completion-final.log`。
- 测试使用根 `createDatabase({})` 创建全新内存 PGlite，执行根已有迁移及本次三表建议；真实 SQL、持久租约、账号/会话权限及 C07 真实 QueryPort，无 production 路径或业务数据库读写。
- 资源7项覆盖：admin GET无副作用、真实审核白名单、发布快照不变、factory重建后24小时间隔、小批处理、每跳 robots 与目标站间隔、私网拒绝、精确100 URL上限、版本变化拒绝旧结果、租约过期、并发领取、超时 unknown。
- 来源4项覆盖：当前账号/会话前后核对、全部历史未知/预留的来源隔离和跨UTC日、费用/调用日范围、真实心跳选择/stale、预算限额、参数限制、GET无写入，以及查询中会话撤销拒绝响应。
- 网络 DNS/robots/HEAD 均为明确注入的夹具，测试未发起真实外网 HEAD、DNS、模型、邮件或 GitHub 请求。并发测试是同一 PGlite 实例内两个工厂，不能代替线上多连接 PostgreSQL 并发验收。
- 独立严格服务 TypeScript 检查退出0；全项目 `node node_modules/typescript/bin/tsc --noEmit --incremental false` 退出0，日志 `.runtime/operations-root-completion-typecheck.log`。
- 未执行 build/start/restart、实际迁移、根浏览器验收、真实 worker 网络或远程部署验收。UI沿用既有后台样式和 C07 独立组件，键盘/375px实际显示由根组合后确认。

## 环境与交还

工厂不读取环境变量。不需要新增密钥，使用根既有配置显式注入。可沿用 `SOURCE_HTTP_PROXY`、现有 DSH source budget 和服务端游标签名材料；这里仅列名称与来源，无值。

本次授权文件已完成。2026-10-10停止编辑并全部交还主会话，根负责组合、迁移、构建与实际验收。
