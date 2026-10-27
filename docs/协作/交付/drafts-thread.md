# 私人草稿保护 · 独立会话交付

2026-10-12，宪法v1.19.0 / 规划30。**本轮已交付，STOP，停止编辑并交还文件。** 下列记录区分模块验证和主会话后续根验收，不表示已迁移或发布。

## 授权文件与完成行为

- 本轮只修改 `src/components/space-documents.tsx/.module.css`、新 `src/modules/document-drafts/**` 和本交付；上一轮C03的tests/e2e文件没有沿用修改权限。没有子代理、根配置/依赖修改、实际数据库、实际迁移、构建、启停或外发请求。
- 文档保持正文一层边框和角落菜单，新增明确 `#fff` 白底，textarea透明继承白底、自动延长、可选择复制；标题表单和多余容器未恢复。
- 私人草稿按服务器Actor账号、空间和文档槽存储，新文档有独立new槽。650ms去抖并串行保护；输入不发布团队正文。刷新/返回自动读取本人草稿，恢复完整正文与原共享版本。
- 私稿与共享保存分别反馈；手动保存先等待最新私稿保护，再由服务器协调真实文档写入。分享权限、原正文复制、作者删除、私人备忘和文档位置复制继续使用真实服务。
- 双窗口私稿CAS冲突保留屏幕输入，停止自动覆盖，提供恢复已保护稿或明确覆盖私稿的选择；共享正文版本变化也保留私稿，并需明确核对后继续编辑。未保护、失败或发布中离开有保护/复制提示。
- 账号/空间变化同步重挂载编辑实例；GET响应带ownerId证明，错账号响应不显示。私稿写入再带expectedOwnerId，Cookie已换账号时拒绝旧实例写入；离队/401/403清空屏幕输入，旧异步回执不回灌。归档/撤回共享编辑/原正文删除时仍可恢复、复制本人私稿，不能发布。
- 私稿移除保留revision墓碑；未知发布保留持久pending/unknown和稳定key，不删除、不自动重发、不换key重建。较新输入只继续原可信文档，不重复新建。

## 根接入契约（已确定）

公共服务导出在 `src/modules/document-drafts/index.ts`；浏览器入口 `client.ts`，不引入服务端依赖。类型在 `model.ts` / `ports.ts`，SQL建议在 `schema.sql`，接入说明在模块README。

`createDocumentDrafts({ database: DatabasePort, clock: Clock, authorize, writer, classifyFailure? })`。

根提供 `authorize(sql, actor, projectId, write, guard): Promise<void>`：在同一事务锁定/复核当前活跃账号、请求会话、空间及活跃成员；必须调用 `guard(sql)`，write=true拒绝归档。本模块仅访问自己的 `document_drafts` 表，不直接读账号、项目、成员或共享文档表。所有方法需要当前请求的 `guard: (sql: SqlExecutor) => Promise<void>`，不能省略或从JSON取Actor。

服务方法：`list/get/save/remove/publish/getPublication`，签名见 `ports.ts`。documentId=null表示每账号每空间的唯一新文档槽；现有文档用真实ID。所有请求严格拒绝未知字段，不接受ownerId/projectId等身份伪造字段。

建议根路由（前端按这些地址实现）：

| 方法 | 路径 | 输入/返回 |
| --- | --- | --- |
| GET | `/projects/:pid/document-drafts` | `DocumentDraftCollection {ownerId,projectId,items}`，包含已有墓碑，不写初始化 |
| GET | `/projects/:pid/document-drafts/:slot` | `DocumentDraft`；不存在返回revision=0/body=null，不写初始化 |
| PUT | 同上 | `{expectedRevision,body,baseDocumentRevision,continuePublicationAttemptId?:string}` →真实保存的`DocumentDraft` |
| POST | 同上`/remove` | `{expectedRevision}` →带新revision的body=null墓碑 |
| POST | 同上`/publish` | `{expectedRevision,attemptId,retryFailed?:boolean}` →`{receipt,draft}`，必须按receipt.status判断实际结果 |
| GET | `/projects/:pid/document-draft-publications/:attemptId` | `DraftPublication|null`，查原尝试回执，不写、不重放 |

`:slot`为`new`或`encodeURIComponent(真实documentId)`；根将new转为null。内部键加document前缀，防止新槽和真实ID碰撞。

**依据主会话最新追加，已覆盖早先客户端publish-start/settle方案，不提供那两个路由。** 前端先串行保护最新私稿，再调用服务器publish。根注入 `writer.write(sql,actor,pid,{documentId,title,body,expectedRevision},guard)`：documentId=null映射原真实 `spaceDocuments.create`，否则映射原 `spaceDocuments.update`；返回原结果 `{id,revision}`。必须复用传入sql或同一个DatabasePort的ambient事务，不开第二连接、不走HTTP。根现成 `authorizeSpaceCollaboration` 可以用async适配器await后返回void。

服务先持久记录冻结正文/版本与稳定attemptId，再由创建该尝试的调用进入实际写入事务；**正文写入、可信回执与有条件私稿清理同一事务提交**。网络未知时原attemptId可GET查询，客户端不能伪造成功或清稿。已成功的同key请求只返回原回执，pending/unknown不重放。

pending/unknown持久保留并禁止新尝试/remove；自动保存可以继续保护新输入但不能重放团队发布。成功发布只清contentRevision未更新的对应私稿；有更新则保留，并记录原API返回的documentId/revision，让新槽剩余输入下一次编辑同一文档而非重复新建。私稿删除永远保留revision墓碑，旧页面expectedRevision=0不能复活它。

可选continuePublicationAttemptId只用于原新文档已成功、鲜私稿已清理，但本页还有较新输入的恢复：服务验证它等于当前本人新槽的真实succeeded回执，才把后续私稿绑定该回执的真实documentId。不能用客户端documentId伪造绑定；正常新文档输入不带此字段。

save/remove/publish另接受可选expectedOwnerId，前端始终带当前编辑实例的账号ID。它只能与服务器Actor一致，否则403且不写入，防止旧页面在Cookie换成另一账号时把旧输入保护到新账号。该字段是身份一致性断言，不产生授权；内部可信调用可以不带，所有owner仍取服务器Actor。GET返回ownerId，前端不匹配时立即清屏。

默认只将DomainError视为已知事务回滚；其它错误保守记unknown。根可注入 `classifyFailure(error)`，只有能够证明事务回滚时返回known_failed，连接/提交结果不明必须unknown。failed允许显式同key加retryFailed=true重试原冻结正文；不会自动换key重建。

SQL建议已在模块 `schema.sql`，根选择递增实际迁移号。未知发布不提供“盲目重试/清除”入口；待根/用户核对实际回执，原输入可复制。

## NEEDS_INTERFACE

根需要组合以上路由、真实请求guard/authorize、原真实文档writer和实际迁移。主会话已通知其路由、权限适配与writer准备完成；本会话只读看到了 `space-collaboration.ts` 与router组合，类型检查通过，但**未代替主会话执行实际迁移、浏览器或根跨角色验收**。

接口路径已与根约定一致，尤其回执GET为 `/projects/:pid/document-draft-publications/:attemptId`。无需客户端成功声明/settle接口，无新增其它模块表写入。根用模块schema选实际迁移号（此前064已存在），本会话不选用/执行生产迁移。

## 实际验证与模拟边界

实际执行：

1. `node --experimental-strip-types --test src/modules/document-drafts/service.test.ts src/modules/document-drafts/protection.test.ts`：**28/28通过**（服务16项、保护控制12项）。
2. 控制层最后小修后单独再跑 `node --experimental-strip-types --test src/modules/document-drafts/protection.test.ts`：12/12通过。
3. `node node_modules/typescript/bin/tsc --noEmit --incremental false`：全项目类型检查通过，未使用或修改依赖shim/配置。

服务测试使用真正隔离内存PGlite及本模块SQL；根writer Port用独立夹具表的真实SQL验证共享写入、回执与清稿同事务提交/回滚，权限Port模拟当前账号/会话/成员/归档状态。没有加载.env、生产目录或外部服务；**该夹具writer不等于实际原space-documents服务的根整合验收**。

服务16项覆盖：GET不初始化、身份/位置隔离、CAS与墓碑、当前guard及权限失效、归档只读、同key不重放、零行清稿回滚真实共享SQL、失败显式重试、未知hold与新服务实例重读、并发最多一份新文档、共享版本冲突、较新私稿保留且后续编辑同文档、可信回执继续输入、删除后旧尝试不可复活、提交应答未知后实际回执核实、写入后会话撤销回滚及严格字段/身份校验。

控制12项是注入传输、延迟与错误的模拟状态测试，覆盖输入早于GET、串行合并和旧回执、新窗口CAS、保护失败/离开风险、恢复/归档、身份变更清屏、明确手动发布、未知查询不重建、401/403、发布前已知拒绝、恢复期间新输入和删除期间新输入。

## 未验证与交还

本会话没有运行浏览器、截图、实体手机、生产持久库、远程多连接PostgreSQL或真实冷启动恢复验收。没有新增/运行本轮tests/e2e（未获授权）；主会话接回后应验收刷新/返回恢复、共享权限撤回、双窗口、账号切换、离队、白底长文与移动端、网络未知回执和原文档writer原子性。

未知崩溃留下pending或unknown，不提供自动重试；若原回执仍不能确认，私稿可复制并保留。此安全边界不能当作发布失败后可以直接换key新建。

无新增环境变量或密钥；沿用主会话已有服务配置，模块和测试无需读取.env。

**STOP。从本交付写入后停止编辑，本轮授权文件全部交还主会话。实际迁移、浏览器跨角色验收、公共文档同步、构建和服务切换由主会话完成。**
