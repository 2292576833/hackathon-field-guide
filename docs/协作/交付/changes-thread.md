# 关键变更确认 · 独立会话交付

依据规划30、宪法v1.19.0。仅编辑 `src/modules/space-changes/**` 与本文件。状态：模块已完成，13/13隔离测试与定向类型检查通过；**STOP，已停止编辑并交还全部本轮文件给主会话**。尚未根接入或生产验收。

## NEEDS_INTERFACE（先登记供根接入）

公开入口 `createSpaceChangesService({ database, clock, ids, authorize, readFacts })`，服务方法 `reconcile(actor, projectId)`、`list(actor, projectId, { beforeVersion?, limit? }?)`、`acknowledge(actor, projectId, { changeId, version, understood: true })`。

`authorize(sql, actor, projectId, write)` 返回 `{ projectId, userId, membershipId, membershipRevision, role: "manager"|"member", archived }`。根可直接将 `authorizeSpaceCollaboration(sql,actor,pid,write,guard)` 映射此 Port；须在该事务中验证活跃账号、当前请求会话、项目与活跃 membership，并锁定权限事实直至提交。GET 不初始化业务记录。归档写入拒绝。模块再次核对身份字段，并在返回前复核当前授权和 membership 身份。

`readFacts(sql, access)` 返回以下已授权的服务器事实，须使用传入事务读取并与根的项目/成员/计划写锁协调；禁止客户端传事实：

```ts
{
  projectId: string;
  projectRevision: number;
  goal: string;
  minimumDeliverable: string;
  deadline: string | null; // 带时区 ISO instant
  members: readonly {
    membershipId: string; userId: string; role: "manager" | "member";
    displayName: string; // 安全称呼，不传邮箱或私人测评
  }[]; // 仅当前 active，包含本人
  currentPlan: null | {
    id: string; revision: number;
    tasks: readonly {
      id: string; title: string;
      ownerUserId: string | null; reviewerUserId: string | null;
    }[];
  }; // 只传当前已生效且未过期的计划；草案/过期/无计划一律 null
}
```

模块保留最近一次观察到的生效任务分配作为不可变历史比较依据。`currentPlan: null` 不清空旧基线、不生成虚假撤职通知，旧值不作为当前执行事实返回。随后新生效计划与该历史比较；首次观察没有计划时，后续首次生效计划中的非空负责人/检查人按从“未安排”到实际人选记录。任务新增/删除、负责人/检查人变化按任务 ID 比较；仅计划版本、标题、任务顺序、成员称呼/入队、职责意愿或测评变化不生成通知。若所有监测值相同，也不轮询写入版本。

建议 API（根统一路由、session guard、CSRF）：

- `POST /api/v1/projects/:projectId/space-changes/reconcile`，JSON `{}`。返回 `{ projectId, baselineCreated, version, changeCount }`。先授权再事务保存；首次只有基线，后续基线/版本/事件/收件快照同事务；冲突返回409，由下一次检查重读。
- `GET /api/v1/projects/:projectId/space-changes?beforeVersion=N&limit=20`。只读，返回 `{ projectId, userId, membershipId, readOnly, checkedAt, pendingCount, items, nextBeforeVersion }`；每项固定原始 `version`、前后值/摘要、来源版本及本人 `acknowledgedAt`，仅当前 membership 的收件项。分页按版本分组，避免同一版本被截断；pendingCount 为本人全部未确认项数。
- `POST /api/v1/projects/:projectId/space-changes/acknowledge`，JSON `{ changeId, version, understood: true }`。不得含任意 userId/membershipId；重复同一确认返回既有回执；返回 `{ projectId, changeId, version, acknowledgedAt, replayed }`。这不表示同意，不改任务/计划/成员事实。

模块提供 `createSpaceChangesHandlers`：依赖 `{ service, resolveActor(request), authorizeMutation(request), requestIds }`；按项目请求上下文创建服务，使 authorize 闭包绑定该请求的 session guard。返回标准 `{data,requestId}` / ErrorEnvelope，private/no-store。

客户端 `SpaceChanges` 从 `./ui.ts` 导出，props `{ projectId, currentUserId, readOnly?: boolean, reloadToken?: number }`。根放紧凑入口；正常可见页每30秒先 POST reconcile 再 GET，隐藏暂停；归档只GET。不依赖根共享样式。不新增AI或外部消息发送。

SQL 建议：模块内 `schema.sql`，由根选递增迁移号；独立会话不执行真实迁移。无需新增环境变量或依赖。

## 完成与验证

- 已实现服务、严格输入HTTP工厂、紧凑客户端/CSS、服务与UI分离导出、SQL建议和README。模块不导入其它模块私有文件、不读写他表。
- 项目全局字段通知全体 active；任务分配变化通知该任务前后 owner/reviewer 中仍 active 的人（包括未换人的协作者）及当前 manager。平台admin身份不替代项目manager或membership。
- 已验证首次基线、去重、版本/完整原文保存、独立确认不改任务、同项目其他账号隔离、跨项目/离队再入、归档、并发同事实与同确认、CAS/收件失败原子回滚、最终授权复核、分页和HTTP防客户端事实/身份注入。
- 隔离测试使用真实新建内存 PGlite 和假 facts/权限 Port，不访问生产库或真实外部服务。PGlite串行并发调用与rowCount故障注入不替代远程多连接PostgreSQL并发验收。
- 定向TypeScript编译检查使用 `createProgram`、`noEmit:true`、`incremental:false`；只以本模块文件与 `next-env.d.ts` 为入口，无全站构建或根tsbuildinfo写入。最终检查通过。
- 未接入：根请求session闭包/权限与事实Port、三个API路由、工作台入口、实际迁移、生产构建/启停、真实浏览器与隔离账号验收。没有新增环境变量、依赖或收费调用。
- 观察边界：只能留存POST检查实际看到的版本；检查间被覆盖的中间变化不能伪造。如要求逐笔通知，根需在原业务变更路径同事务调用reconcile，复用executor适配，或提供原始可信变更流。本模块不自行读取他表历史。

## 最终交还（2026-10-12）

- 最终运行 `node --experimental-strip-types --test src/modules/space-changes/service.test.ts`：13项通过、0失败。追加检查确认写入的rowCount与返回行数不一致会回滚，不能误报确认成功。
- 服务公开类型以 `types.ts` 为准；SQL建议为 `schema.sql`；UI需独立从 `ui.ts` 导入。根按以上 `/api/v1` 路径接入，不需要修改本模块接口。
- 未执行根构建、服务启停、真实迁移、生产库访问、依赖安装、Git操作或外部调用；未创建子代理。
- **STOP：全部本轮文件交还主会话，不再继续修改。**

## 根接入兼容补丁（2026-10-12）

- 按主会话最新精确追加，仅修改 `SpaceChanges.tsx` 的reconcile归档识别：同时接受 `PROJECT_READ_ONLY` 与根权限Port实际抛出的 `PROJECT_ARCHIVED`，继续只读GET。其它异常仍照常处理，未扩大写入权限。
- 补丁后本模块定向TypeScript检查通过；服务、测试、schema.sql及迁移建议均未改动。此前13项服务隔离测试结果仍适用，本轮未新增或重复实现测试；根归档浏览器验收仍待主会话记录。
- 主会话反馈根路由已接、067迁移已准备；此为接入进度，不表示实际迁移或最终生产验收已经完成。
- **再次STOP：停止编辑并交还全部本轮文件，供主会话hash复核与继续接入。**
