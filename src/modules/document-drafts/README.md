# 私人文档草稿

规划30 / 宪法v1.19。保护正文属于本人，发布仍由真实团队文档服务执行。模块不读取账号、项目、成员或共享文档表，也不创建任务/完成状态。

## 接入

服务公共入口 `index.ts`；浏览器安全入口 `client.ts`（只有纯状态控制与类型，无服务端依赖）。模块的 `schema.sql` 为SQL建议，实际递增迁移由根执行。

```ts
const drafts = createDocumentDrafts({
  database, clock,
  async authorize(sql, actor, projectId, write, guard) {
    await authorizeSpaceCollaboration(sql, actor, projectId, write, guard);
  },
  writer: {
    async write(sql, actor, projectId, input, guard) {
      // Root rechecks current document edit permission and request session.
      // create/update must share sql or this database's ambient transaction.
      const saved = input.documentId === null
        ? await spaceDocuments.create(actor, projectId, { title: input.title, body: input.body })
        : await spaceDocuments.update(actor, projectId, input.documentId, {
          body: input.body, expectedRevision: input.expectedRevision,
        });
      return { id: saved.id, revision: saved.revision };
    },
  },
});
```

`authorize`必须在同一事务复核活跃账号、当前请求会话、空间、活跃成员和写入时归档状态，并执行传入guard。根writer还要在写入前后复核session和真实文档作者/共享编辑权限。不得使用HTTP写正文或另一数据库连接，否则无法原子提交回执与清稿。服务会在事务结束前再次authorize。

## API

所有方法接受服务端Actor和当前请求guard，不接受客户端身份字段。`documentId=null`表示本人在本空间的新文档槽；真实文档ID表示现有文档槽。内部slot用new或document:前缀区分。

| 方法 | 前端路由 | 行为 |
| --- | --- | --- |
| list | GET `/projects/:pid/document-drafts` | 返回 `{ownerId,projectId,items}`，仅本人；包括墓碑，不初始化 |
| get | GET `/projects/:pid/document-drafts/:slot` | 不存在时虚拟revision0/body=null，不写 |
| save | PUT同上 | expectedRevision、body、baseDocumentRevision；真实CAS |
| remove | POST同上`/remove` | expectedRevision；清正文但保留版本墓碑 |
| publish | POST同上`/publish` | expectedRevision、attemptId、可选retryFailed；服务器协调真实发布 |
| getPublication | GET `/projects/:pid/document-draft-publications/:attemptId` | 原回执或null；只读，不执行writer |

`:slot`为new或URL编码真实documentId。save可选continuePublicationAttemptId只允许绑定当前本人新槽的真实成功回执，用于较新输入在清稿后继续编辑原发布文档；客户端不能传入目标documentId伪造绑定。

正文为20000字内纯文本，保留所有空行；空字符串是草稿，null是已清理墓碑。所有未知字段、错误版本、控制字符和伪造身份字段被拒绝。

前端的save/remove/publish始终带expectedOwnerId；只校验它与服务器Actor一致，不用它选择/授权账号。Cookie已换账号而旧编辑实例仍在发送时，服务立即403且不写入；GET身份不匹配也清屏。内部可信调用可省略该一致性断言。

## 发布协议

先持久冻结已保护私稿的正文、源版本、内容版本和稳定attemptId；仅创建/显式重新领取失败尝试的调用执行writer。writer、可信结果、成功回执以及有条件私稿清理在同一事务内提交。成功回执是共享文档原服务的事实，不是客户端声明。

- 相同key成功请求只返回原结果；pending/unknown绝不重放，也不能删除对应私稿或换key新建。
- 进程在冻结后崩溃会留下pending，可GET核对；没有后台自动重发。
- DomainError默认代表已知事务回滚，保留私稿并记录failed。其它错误保守记unknown，原始异常不进入回执。根可提供classifyFailure，只能将确知回滚的错误分类known_failed。
- failed可以显式以同key、同源版本及retryFailed=true重试原冻结正文；私稿已删除或不再指向该尝试时拒绝，旧窗口不能借重试复活。
- 当前私稿内容版本未更新才清理为墓碑；有较新私稿则保留。新槽保留下来的输入绑定原真实documentId，下一次写edit，不重复create。
- 归档后只允许当前成员读取/复制已有私稿和回执，不新发起发布；已接受操作的失败/unknown回执可以用当前只读授权记录，不改变团队正文。

## 浏览器保护

DraftProtection按ownerId/projectId独立实例，组件以账号/空间为React key；无localStorage或公共浏览器正文缓存。650ms去抖、全实例单队列串行保护，期间的新输入不被旧回执清掉。异步GET不覆盖已经输入的文字；CAS冲突停止自动覆盖并提供明确恢复/覆盖私稿选择。

保护成功不调用publish。只有用户保存才发布，并先等待最新保护完成；发布期间当前编辑器只读，避免临时输入丢失。网络未知只查同一key回执。401/403和身份不匹配立即清空屏幕输入并废弃旧异步回执；归档/撤回编辑权限保留可复制私稿。未保护、失败或发布中离开时触发真实离开提示。

## 验证边界

`service.test.ts`使用真实隔离内存PGlite和模块SQL，writer Port通过独立夹具表的真实SQL测试原子提交/回滚，授权Port模拟当前身份状态；不替代根原文档服务与真实账号session的整合验收。`protection.test.ts`是注入传输/延迟的纯状态测试。两个文件均用Node内置node:test，不读.env，不发送邮件/模型，不写生产目录。

```powershell
node --experimental-strip-types --test src/modules/document-drafts/service.test.ts src/modules/document-drafts/protection.test.ts
```

没有新增环境变量。根负责实际迁移、浏览器隔离整合、构建和切换。
