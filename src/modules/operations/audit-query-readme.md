# C07 运营审计查询

只读管理员查询组合已有 M08 审计事实，不建立第二套审计写入或私人信息索引。根入口仍由主会话接入。

## 使用

从 `audit-query-index.ts` 导入 `createAuditQueryService`、`PostgresAuditQueryPort` 和 `createAuditQueryHandlers`。组件单独从 `audit-query-panel.tsx` 导入 `AdminAuditPanel`。

```ts
const audit = createAuditQueryService({
  database,
  query: new PostgresAuditQueryPort(),
  authorization: { assertCurrentAdmin: async (tx, actor) => { /* 当前账号、当前请求会话和管理员角色 */ } },
  clock,
  cursorSecret, // 服务器专用 >=32 字节，轮换会使旧游标失效
});
const handlers = createAuditQueryHandlers({ service: audit, resolveActor, requestId, assertMutationAllowed });
// 根 GET /api/v1/admin/operations/audit -> handlers.list
```

`authorization.assertCurrentAdmin(tx, actor)` 必须真正复核当前会话及权限；空函数不满足接入要求。读取前后在同一事务调用，锁顺序复用根身份实现。模块首先拒绝缓存角色为普通用户/审核员的 Actor，但缓存管理员标记不能替代 Port。

`list(actor,{actorId?,action?,objectKind?,objectId?,revision?,stream?,from?,to?,limit?,cursor?})` 返回 `{items,nextCursor,window:{from,to}}`。单页 1–100 条，默认 50；默认最近 7 天，最大 31 天，不允许未来结束时间。时间输入为带 `Z` 的 ISO UTC，PostgreSQL 微秒保留到游标；排序采用 C 字符序，避免相同时间重复/漏页。游标 HMAC 签名绑定账号、筛选、固定窗口，15 分钟有效；下一页需要保留全部非时间筛选，未填写时间时由游标恢复。新增记录晚于窗口结束时须重新查询才能看到。

后台只返回 ID、身份种类、固定动作分类、对象种类/ID、版本和时间。未识别动作统一 `unrecognized`，不回传任意 action 文本；不读取或返回 reason、payload 正文、日志、URL、邮箱、会话凭据或私人项目。`revision` 为来源/任务/审核/纠错/调度版本；资源无审核版本的撤下记录回退到资源版本。`contentVersion` 为赛事候选或资源修订；未记录则 null，不补造正式发布版本。

SQL 适配包括 `operations_execution_audit`、`operations_event_review_audit`、`operations_resource_review_audit`、`operations_correction_transitions`、`operations_discovery_control_audit`。根角色授权审计和 C06 技能审核审计需要各自公开、安全的查询 Port 接入后扩展；不能通过任意表名或任意 JSON 路径查询。

`AdminAuditPanel({endpoint?,loadPage?,initialPage?,initialInput?})` 默认 GET 根 API，`loadPage(input,signal)` 可由已存在后台客户端注入，`initialPage` 必须是管理员专用安全 DTO；预载页带筛选时必须同时传入 `initialInput`，表单和后续分页将保留服务器原筛选。组件只读，提供筛选、空结果、错误、取消旧请求及下一页；失败会清除页面的旧审计数据，不自动重试。无轮询、收费或模型动作。移动表格可横向滚动，表单可逐项操作。实际页面视觉/键盘/浏览器验收由根集成执行。

## 验证与配置

`node --experimental-strip-types --test src/modules/operations/audit-query.test.ts src/modules/operations/audit-query-postgres.test.ts`

11 项测试：角色隔离/撤销、微秒及同时间游标、防伪/绑定/过期、有界筛选、微秒时间边界、Unicode业务对象ID、脱敏、异常 Port、HTTP 及内存 PGlite SQL。PGlite 测试不读取 `.env.local`、生产路径或真实迁移。`audit-query-indexes.sql` 仅为根后续新增迁移建议；此任务未执行迁移。

建议根环境名 `OPERATIONS_AUDIT_CURSOR_SECRET`；本模块只接收字节 key，不读取环境变量。不新增依赖，不修改现有 operations/index.ts，根可自行组合新导出。
