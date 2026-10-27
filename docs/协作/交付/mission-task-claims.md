# M05 草案任务池与原子认领交付

日期：2026-10-09。依据宪法 v1.10.0、规划19及R02。主会话本次临时授权仅 `src/modules/planning/service.ts`、新增 `src/modules/planning/claims.test.ts` 与本交付文档；未修改其它模块、共享契约、页面、路由、迁移、依赖或生产数据。

## 已完成

- `getTaskPool` 只读返回最新可编辑草案及全部任务。已领取任务仍保留并显示原负责人，不创建第二份任务池或完成状态；没有可编辑草案时返回空结果，不初始化存储。
- `claimDraftTask` 从认证 Actor 的当前活跃 ProjectMembership 取得负责人；客户端不能指定“本人”身份。已有负责人不能直接被接走。
- `releaseDraftTask` 仅本人负责人或当前空间管理员可退回；`assignDraftTask` 仅管理员可转交到本空间活跃成员，也可设为待领取。
- 三种操作使用原 M05 项目事务锁，比较草案 revision 与任务 revision，同时复核生效计划基线、任务集版本、规则/赛道/成员意愿/时间/项目事实、资源固定公开内容版本。
- 原子重新计算任务结构、容量、依赖、规则与资源校验，更新草案 changes、validation、status、revision 和任务 revision。待领取任务仍属于未完善草案；领取不会自动确认计划、开始任务或生成完成事实。
- 只允许 `todo` 且无 acceptance 的草案任务变更归属。已开始、阻塞、待检查、检查通过、已删减任务及已生效/被替代历史计划不可通过任务池更改。
- 操作和幂等回放均先复核当前成员及归档/只读保护；保存前再次复核权限，管理员降权不能退回他人任务。
- 原有 planning_idempotency 保存每个操作不可覆盖的结果快照；原 outbox 的 `PlanDraftGenerated` 记录经校验草案编辑的修订号。该类别沿用既有草案编辑语义，不代表又调用 AI。

## NEEDS_INTERFACE

方法均为 `PlanningService` 公共方法，服务类型通过已有 `index.ts` 的 `export * from "./service.ts"` 可读取，不需新增模块导出文件。

```ts
interface DraftTaskOwnershipCommand {
  expectedRevision: number;      // plan.revision
  expectedTaskRevision: number;  // plan.tasks 中这项任务的 revision
  idempotencyKey: string;
}
interface AssignDraftTaskCommand extends DraftTaskOwnershipCommand {
  ownerMembershipId: string | null;
}
interface DraftTaskPool {
  plan: Pick<PlanVersion,
    "id" | "status" | "revision" | "reason" | "createdAt" |
    "basePlanVersionId" | "baseTasksRevision"
  > | null;
  tasks: PlanningTask[];
  inputVersionsChanged: boolean;
}

getTaskPool(actor, projectId): Promise<DraftTaskPool>;
claimDraftTask(actor, projectId, planId, taskId, command): Promise<PlanVersion>;
releaseDraftTask(actor, projectId, planId, taskId, command): Promise<PlanVersion>;
assignDraftTask(actor, projectId, planId, taskId, command): Promise<PlanVersion>;
```

主会话接入 GET `/projects/:projectId/task-pool` 与 POST `/projects/:projectId/plan-versions/:planId/tasks/:taskId/claim|release|assign`，请求边界继续负责已登录会话、Origin/CSRF、输入解析和同事务账号有效性复核。R02 任务板通过现有 ProjectDetail 映射成员名称。

最新可编辑草案按原 plans 的追加顺序选择，允许 `draft`、`ready`、`needs_changes`、`stale`，不选择 `applied`、`superseded`、`validating`、`generation_failed`。`inputVersionsChanged` 也包括生效任务基线与资源依据变化；为 true 时不得点击领取，而应提示管理员重新编辑校验。GET 显示原草案状态，不写入新的失效状态。

错误码与恢复提示：

| 错误码 | 行为 |
| --- | --- |
| `TASK_POOL_STALE` | 依据或生效任务已变化；管理员先重新校验草案 |
| `VERSION_CONFLICT` | 草案或单项任务已被队友更新；刷新后对照最新版本 |
| `TASK_ALREADY_CLAIMED` | 保留现负责人；选择其它待领取任务或联系管理员转交 |
| `TASK_NOT_CLAIMED` / `TASK_OWNER_UNCHANGED` | 当前归属已是目标状态；不重复保存 |
| `TASK_OWNERSHIP_LOCKED` | 已开始/交付/检查/删减的工作不可通过领取入口退回 |
| `TASK_OWNER_INACTIVE` | 目标必须是当前空间活跃成员 |
| `INVALID_TASK_HELPER` | 不把负责人重复计作协助者，不允许重复协助身份；管理员先编辑协助安排 |
| `PLAN_IMMUTABLE` / `PLAN_NOT_READY` | 历史已生效计划或尚无可编辑草案不可领取 |
| `PROJECT_READ_ONLY` / `NOT_FOUND` / `FORBIDDEN` | 归档、撤权或缺少当前空间权限时拒绝，并由页面清理旧私有内容 |
| `IDEMPOTENCY_CONFLICT` | 同操作键内容不同，不能覆盖首个结果 |

例如成员领取未分配的 `todo`：草案及任务修订号各加1，owner 变为本人 membershipId，validation 重算；原生效任务集、tasksRevision、进度记录和 currentPlanVersionId 均不变。管理员仍须确认最新草案；未分配者、容量不足、缺少规则等问题仍显示原校验结论。

未知响应时保持相同操作键及相同请求内容，先刷新任务池核对，再按原请求重试；不要更换键自动发起另一项领取。精确回放允许在草案后来已生效时返回原成功快照，但不会再修改任何状态；撤权和归档仍在回放前拒绝。

## 已验证

- Node 内置测试新增 **24/24** 通过。其中3项使用独立内存 PGlite、真实模块SQL和原 PostgreSQL repository，验证 JSONB 对象键排序、连接到同库重新建立服务后的幂等回放、并发领取唯一胜者，以及 outbox 写失败时状态/事件/幂等快照同事务回滚。
- 全 M05 模块回归 **193/193** 通过，含原169项及新增24项。命令：`node --experimental-strip-types --test src/modules/planning/*.test.ts`。
- 日志：`.runtime/mission-task-claims-planning-regression.log`。首轮23项独立日志 `.runtime/mission-task-claims-tests.log`；最终新增管理员降权回归已经包含在193项日志中。
- `npm run typecheck` 已执行。本模块无诊断；当时全局失败来自并行中的 `src/components/team-task-board.tsx`（DraftTaskPool 临时未声明、onAccessLost 参数类型），未越权修改。日志 `.runtime/mission-task-claims-typecheck.log`，主会话/R02完成接入后统一复核。

## 未接入与真实边界

- 本子任务没有组合 HTTP 路由、UI 按钮、团队动态聚合或实际应用数据库迁移，由主会话接入；无需新增表或环境变量。
- 测试未打开生产 PGlite 数据目录，未调用模型、邮件或 GitHub，未重启、构建、安装依赖或发布服务。
- 独立 PGlite 的事务回归不替代远程 PostgreSQL 多连接锁验收。根应用应继续遵循共享 executor、项目事实保护与请求会话锁契约。
- `plan.changes` 保持对当前生效基线的变更比较；单次领取快照保存在原幂等记录，事件记录修订号。没有新增独立的领取历史页面或第二套审计状态。

交付完成，已停止编辑三个授权文件，所有权交还主会话。
