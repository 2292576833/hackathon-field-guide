# Space changes · 关键变更确认

依规划30，观察已授权的作品目标、最小交付范围、截止和当前生效任务分配。首次 POST 建立基线，GET 永远只读；之后每一批观察到的变化按版本留存，不覆盖原通知。

## 接入

从 `index.ts` 导入 `createSpaceChangesService`、`createSpaceChangesHandlers` 与类型；从 `ui.ts` 导入客户端 `SpaceChanges`。UI 与服务分开导出，服务端入口不加载客户端/CSS。

服务注入 `DatabasePort`、`Clock`、`IdGenerator`、`authorize(sql, actor, projectId, write)` 和 `readFacts(sql, access)`。精确形状见 `types.ts`，根接入说明见 `docs/协作/交付/changes-thread.md`。模块只读写自己的五张表，根 Port 在同一事务复核当前账号、请求会话、项目和 active membership，并协调项目/成员/生效计划的锁；不能将客户端事实或另一个项目的事实注入此 Port。

`schema.sql` 只是迁移建议，根指定新迁移号并应用。SQL 使用参数化查询；基线更新使用 revision CAS 并检查 rowCount。变更、收件快照与版本同事务插入，SQL trigger 禁止改写或删除历史；本人了解记录单独写入且不可改写，唯一键负责重复回执。

建议根路由：

| 方法 | `/api/v1` 下的路径 | 输入 |
| --- | --- | --- |
| GET | `/projects/:projectId/space-changes` | 可选 `beforeVersion`、`limit`（版本组数，默认20，最多50） |
| POST | `/projects/:projectId/space-changes/reconcile` | `{}` |
| POST | `/projects/:projectId/space-changes/acknowledge` | `{ changeId, version, understood: true }` |

所有路由 private/no-store；写路由由根验证 same-origin/CSRF。HTTP 工厂严格拒绝额外字段，不接受替别人确认的 userId/membershipId。解析正文最多2048字节。GET 列表只返回当前 membership 的收件项，分页不截断同一版本；总未确认数包括分页之外的旧变更。

## 业务语义

- 目标、最小范围、截止通知观察时全体活跃成员。某任务的负责人或检查人变化，通知该任务前后负责人、前后检查人中仍活跃的人以及当前项目管理员；未涉及的普通成员不收件。
- 一次观察的多个字段可以产生多条通知，每条分别了解。只记录明确点击者的当前 membership，不表示同意方案，不改项目、计划、任务、完成或检查状态。重复点击返回首次确认时间。
- 离队立刻无权读取；新 membership 不继承旧收件或了解权限。重新加入后，仅能收到新变化对应的新收件记录。归档可读，所有业务写入及确认重试均拒绝。
- `currentPlan` 仅接受根确认的当前生效且未过期计划。传 `null` 时保留历史分配用于下次比较，但不制造撤职通知或把历史计划宣称为当前执行。首次基线若无计划，后来实际任命从“未安排”比较。任务新增/移除按 task ID 比较；移除相当于该旧任务不再安排负责人/检查人。
- 仅版本号、任务顺序、标题、称呼、入队人数变化不通知；意愿和私人测评不是输入字段，也不会保存。相同监测值不写新版本，A→B→A 则分别保留两个真实观察到的变化。
- 保留完整前后值与最多140字加省略号的摘要。截止规范为 ISO UTC，界面按北京时间显示。来源版本是对应已保存观察的 M02 revision 与最近生效计划 id/revision，不把轮询时间当业务修改时间。

## 客户端

`<SpaceChanges projectId={projectId} currentUserId={userId} readOnly={archived} reloadToken={reloadToken} />` 默认只有一行待确认数量，点开显示原文和“我已了解”；没有大卡片边框。可见页约30秒先 POST reconcile 后 GET，隐藏页停止网络读取并中止在途轮询；归档只GET。账号/项目切换重建组件，401/403/404或全站登录失效事件清除私有内容。失败显示待核对，读取不会自动确认。确认收到真实回执后才更新显示。

## 验证及边界

运行 `node --experimental-strip-types --test src/modules/space-changes/service.test.ts`。测试使用新建内存 PGlite，未打开生产目录；涵盖只读GET、首次基线、完整原文/不可变历史、相关收件、计划失效、确认幂等、跨账号/项目/离队再入、归档、并发提交与 CAS/收件失败回滚、最终授权复核和HTTP边界。

依赖注入的假事实和权限只用于测试。并发调用在内存 PGlite 内串行执行，不能代替多连接 PostgreSQL 并发验收。根路由/页面组合、实际递增迁移、375px/桌面浏览器以及真实隔离账号验收由主会话完成。无新依赖或环境变量。

轮询只能保存实际观察到的版本；两次观察之间发生又被覆盖的中间版本无法从当前事实还原。如必须逐笔保存，根应在权威变更事务提交路径调用同一 reconcile（并保持同事务 executor），或提供可信原始变更流，不能让本模块编造历史。
