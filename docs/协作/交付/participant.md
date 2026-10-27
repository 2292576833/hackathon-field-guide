# Participant · 个人画像交付

日期：2026-10-09。授权范围仅 `src/modules/participant/` 和本文件；未修改 root 路由、共享类型、实际迁移、配置或其他模块。

## 已完成

- 公共 `index.ts` 导出持久化 `createParticipantService`、运行时校验、服务/输入类型、独立 `createParticipantHandlers` 与共享画像类型。
- 个人画像保存到 `participant_profiles`；服务只读取当前 Actor 本人的画像，平台管理员也无额外读取范围。
- 允许空画像与不完整画像，不给账号登录增加填写门槛；GET 首次返回 revision 0/updatedAt null，完全只读。
- 每次读写同一事务检查当前活跃、已验证账号，锁定账号后调用请求 guard，数据操作后再次检查。会话在最终检查失败时回滚保存。
- 首次保存与后续保存均采用数据库版本条件写入，拒绝旧版本覆盖，409 回传本人最新版本。失败版本比较路径在回传 latestRevision 前也再次检查请求会话。
- 输入完整替换校验：`expectedRevision` + 全部可编辑字段；额外字段、缺失字段、异常枚举、数组和字符、非有限工时均拒绝。边界与画像 UI 对齐：城市 80；技能/兴趣各 30 × 80；想法 4000；工时 0–24/null。
- HTTP GET/PATCH 工厂完成登录、Origin、JSON/UTF-8/流字节上限、方法与错误封装边界。成功 data 为直接 ParticipantProfile；响应 private/no-store。
- 建议迁移：`src/modules/participant/migrations/001_participant_profiles.sql`。只添加画像表，引用 auth_users，不需要给既有账号填默认行。

## 已验证

`npm test -- participant`：17/17 通过。实际 SQL 在独立无 dataDir 的 PGlite 内存 PostgreSQL 引擎执行，覆盖迁移、空读取不写入、服务器时间和 trim、持久化重读、本人隔离、管理员仍只能访问本人、首次和后续竞争写入、版本冲突、空字段允许、账号禁用/删除、会话撤销、最终 guard 回滚和冲突回传前再次认证。

HTTP 注入测试覆盖直接画像响应、guard 传递、Origin 缺失/不匹配、登录拒绝、方法拒绝、未知 owner 字段、Content-Type/压缩体、流和声明长度上限、非法 JSON、版本冲突、跨 bundle DomainError 与脱敏异常。

最终 `npm run typecheck` 通过。此前组合过程中的其他模块临时错误由各负责人处理；本模块未跨界修改。

## 同轮画像表单交付

本任务授权的 `src/components/participant-profile.tsx` 已由并行 UI 子代理交付并停止编辑。`ParticipantProfileForm({ onSaved?: (profile: ParticipantProfile) => void, requireForPlan?: boolean })` 可直接在账号与计划页面复用，独立 GET/PATCH `/api/v1/me/participant-profile`；成功 envelope 的 `data` 为直接画像。完整 PATCH 只发送 `expectedRevision` 和九项可编辑字段，不发送 Actor、userId、revision 或 updatedAt。

表单使用现有暖白橙红样式与移动端布局，覆盖初始加载、首次空画像、读取错误/重试、401 登录、保存中与版本冲突。409 读取最新版仅作对照，原有输入保留；用户明确采用最新版或保留本页输入后，才允许以最新 revision 再保存。网络或不完整响应导致保存结果未知时，也先读取已保存结果作对照。

`requireForPlan` 引导填写首次参赛、开发经验、城市和每日可投入时间（大于 0），支持先保存部分画像，账号登录不增加门槛。`onSaved` 在保存成功后通知父页面，可刷新计划入口；主会话已将表单组合到账号页。

局部 Node 检查覆盖字段边界、去重、计划必填指导、无身份 PATCH、latestRevision、无效响应、401 归一化与初始 loading SSR。最终 auth + participant Node 测试 **103/103** 通过，全局 `npm run typecheck -- --incremental false` 通过。未作实际浏览器/手机视觉验收。

## 模拟测试与未接入

- HTTP 使用注入服务替身，只验证请求边界；服务使用真实 PGlite SQL，但数据库为测试内存实例。
- 未打开本机 `.runtime/postgres-data`，未执行根迁移、启动/重启网站、连接远程 PostgreSQL 或发起模型/邮件请求。
- 主会话已告知建议 SQL 已复制到根 022 迁移，画像服务路由与账号表单已组合。模块会话未执行该根迁移或验收这些组合；运行时、浏览器与外部环境事实由主会话补充。生产 PostgreSQL 多连接锁与并发、真实请求会话组合仍待真实验收。
- 本模块服务不实现注册或个人 AI 生成；同轮画像 UI 已在以上授权组件交付，注册由 auth 模块交付。画像读写不发起模型请求，生成由主会话注入的 PersonalAiPort 负责。

## NEEDS_INTERFACE · 主会话组合

无缺失的共享字段；当前直接使用主会话已有 `Actor`、`Clock`、`DatabasePort`、`SqlExecutor`、`FreshSessionGuard` 与 `ParticipantProfile`。

服务工厂及返回：

```ts
createParticipantService({ database: DatabasePort, clock: Clock }): ParticipantService

get(actor: Actor, guard?: FreshSessionGuard): Promise<ParticipantProfile>
update(actor: Actor, input: ParticipantProfileUpdate, guard?: FreshSessionGuard): Promise<ParticipantProfile>

type ParticipantProfileUpdate = Omit<ParticipantProfile, "userId" | "revision" | "updatedAt"> & {
  expectedRevision: number;
};
```

API 接入：

| API | 方法/输入 | 返回/权限 |
| --- | --- | --- |
| `/api/v1/me/participant-profile` | GET；无客户端 owner | `{ data: ParticipantProfile, requestId }`；活跃已验证账号及当前有效请求会话，仅本人 |
| `/api/v1/me/participant-profile` | PATCH；完整 ParticipantProfileUpdate | 同上；严格同源 Origin；版本冲突为 409 并提供 latestRevision |

独立 HTTP 工厂可选择使用：

```ts
createParticipantHandlers({
  service: ParticipantService,
  origin: string,
  resolvePrincipal(request: Request): Promise<{ actor: Actor; guard: FreshSessionGuard } | null>,
  requestIds: IdGenerator,
  maxJsonBytes?: number,
}): { getProfile; patchProfile; handle }
```

必须从已验证 cookie 创建 Actor 和绑定当前请求的 SQL guard，不能从 body、参数或其他请求取得身份。guard 使用服务传入的同一事务 executor，复核会话 owner、有效期和撤销状态，按现有主会话锁顺序保留锁至提交。HTTP 工厂强制 principal 包含 guard；直接服务调用省略 guard 仅适合已有可信内层授权的内部操作。

行为示例：新账号 GET 返回 revision 0，可暂时离开；完整 PATCH expectedRevision 0 保存到 revision 1；旧表单再次 PATCH expectedRevision 0 被拒绝并提示读取 revision 1。清空可编辑字段以 expectedRevision 1 保存得到 revision 2；不重置账号、不要求重新注册。

## 环境变量

模块没有新增环境变量。数据库、公开 Origin、认证 cookie/会话解析、Clock、请求 ID 从根应用注入；此处不记录任何配置值或密钥。

## 交还

完成交付后停止编辑 participant 模块与本文件；根迁移、应用组合与最终真实验收交还主会话。
