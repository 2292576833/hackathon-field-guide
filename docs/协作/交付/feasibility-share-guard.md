# 新发布选题报告校验 · 交付

日期：2026-10-10。临时授权：`src/server/team-mission.ts`、新增根测试、`team-collaboration/ports.ts` 和 `service.ts` 的最小 hook、必要新增模块测试。本轮没有修改 router、application、postgres repository、依赖、迁移或生产数据。

## 已完成

- 新发布 `feasibility` 分享在来源元数据确认后、写入前读取本人报告和当前空间依据，复用真实 `teamAssistant.getShareSource`。过期报告被拒绝，不可通过直接 POST 绕过页面禁用状态。
- 两次新发布检查均在同一根数据库事务内、建议插入之前执行。第二次检查覆盖异步间隔内的规则、目标、成员权限及共享依据变化；外层请求会话 guard 仍在最终提交前复核。
- 成功 receipt 优先恢复，跳过新发布校验；新分享本身导致 context fingerprint 改变、或后来调整目标，不会使已成功操作变成重复发布。当前成员、可写状态和请求会话依然必须有效；同一 key 更换正文仍冲突。
- 选题来源进一步核对 artifact/session 本人、正确空间、`personal_artifact` job 的 actor/module/account scope 与 succeeded 状态。真实 assistant 入口还检查 `provider:dsh`。不复制私人完整报告，只保存用户明确选择、可编辑的摘录。
- 已发布历史分享继续展示生成时快照说明。`verifySource` 和 `readShared/listFeed` 保持轻量元数据读取，不调用完整 context/getShareSource，避免共享上下文递归和因历史报告过期而自动隐藏有效分享。
- 所有团队动态 publish/edit/adopt/withdraw 统一进入根 mutation scope：当前账号 → planning advisory/M04 facts → M02 project/membership → feed writer。嵌套模块事务使用同一 DatabasePort 的 executor/savepoint；只读 feed/context 不取 feed 写锁。
- 校验不创建模型任务、不修改预算或未知请求 hold、不清理账号 DSH busy session。

## NEEDS_INTERFACE

已实现并由根组合使用两个可选 Port，不需要其它模块新增模型或根路由改动：

1. `TeamCollaborationAccessPort.withMutationScope<T>(projectId, actor, work): Promise<T>`：根打开 ambient 事务并预先取得规划/项目权限锁，再执行原 repository 事务。读操作不进入此 scope。
2. `TeamShareSourcePort.validateNewPublication({projectId, actor, source}, transaction): Promise<void>`：只在新 publish 的 receipt 未命中后调用两次，均在 insert 前。必须只读、无收费调用。不可用于通用来源 resolver、历史读取、成功回执重放或编辑/采纳。

## 已验证

- `node --experimental-strip-types --test src/modules/team-collaboration/publication-guard.test.ts src/modules/team-collaboration/service.test.ts src/modules/team-collaboration/postgres.test.ts src/modules/team-collaboration/http.test.ts`：**39/39 通过**。包含新发布两次校验、最终变更回滚、成功重放/只读不调新发布 hook、四类写操作统一 scope，及既有 CAS/撤回/来源失效/权限/SQL/HTTP 回归。
- `node --experimental-strip-types --test src/server/feasibility-share-guard.test.ts`：当时已有的 **8/8 通过**。真实根 createApplication/router 与内存 PGlite、实际根迁移覆盖旧报告直接 POST 409 无写入、有效分享及重放、历史快照非递归读取、确认规则/共享撤回、伪 owner/scope/type/job/provider、写前最后复核、四类写操作实际 SQL 锁顺序和同一 executor、只读无 feed 写锁、未知请求与预算完全保留。
- 随后追加第九项，单独运行 `node --experimental-strip-types --test --test-name-pattern="membership, shared-advice" src/server/feasibility-share-guard.test.ts`：**1/1 通过**。分别在两次新发布检查之间撤销成员、撤回共享建议和撤销本次会话，验证整个请求无新分享写入，嵌套写入也回滚。没有将此记录写成最终九项单轮全通过。
- 原 `src/server/team-mission-integration.test.ts` 的 **13 项均通过**；与新根测试的组合运行最初为 20/21，新锁顺序测试将“此前身份查询事务”误算成写事务 executor 后失败。修正测试使其只核对同一写事务的受保护锁和实际持久写入，随后上述 8 项全部通过，生产逻辑没有为此改变。
- 第一轮根测试在 fixture 邀请接受处因根缺少 `membership_id` 列而失败，尚未执行到发布逻辑。主会话组合 032/033 后重新执行上述隔离根测试；没有在测试里临时补 DDL、绕过 M02 或打开运行数据库。

## 验证边界

测试中保存报告是显式夹具，不是实际 DSH 成功声明；没有模型、邮件、网络或真实用户仓库调用。PGlite 能验证事务、回滚、同 executor 和可观测锁调用顺序，不能代替远程 PostgreSQL 多连接并发/死锁验收。本轮未执行全站 typecheck/build、实际迁移、服务重启或部署，由主会话整合后验证。

所需新增环境变量：无。没有读取或记录配置值、密钥和真实用户数据。

本轮交付后停止编辑，以上文件交还主会话。
