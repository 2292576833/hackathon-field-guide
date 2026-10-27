# O06 主办方赛事与正式规则关联

管理员明确选择本站已人工审核发布的M03赛事，将其当前规则版本与已发布HostedEvent对应。名称相同不会形成关联；主办方工作人员、reviewer和普通用户不能管理。根仍负责实际路由/页面、账号会话、Origin、实际迁移和生产验收。

## 装配

服务从 `index.ts` 导出 `createEventOfficialLinksService`，前端从 `ui.ts` 导出 `EventOfficialLinksPanel`（props：`hostedEventId: string`）。服务不导入O01/M03私有文件、不直接写其他模块表，没有生产内存降级或外部调用。

```ts
const officialLinks = createEventOfficialLinksService({
  database, clock, ids,
  // Use rootIntegration.rawEvents or the original O01 eventAccess, never the decorator.
  getHostedEvent: (sql, id, options) => rawEvents.getEvent(sql, id, options),
  rulesPort: {
    getPublished: (sql, id, options) => readCurrentPublishedM03(sql, id, options),
    listPublished: (sql, input) => listCurrentPublishedM03(sql, input),
  },
});
const decoratedAccess: HostedEventAccessPort = {
  async getEvent(sql, id, options) {
    const scope = await rawEvents.getEvent(sql, id, options);
    return scope ? { ...scope, linkedEventId: await officialLinks.getLinkedEventId(sql, scope) } : null;
  },
  async requireStaff(sql, actor, id, capability) {
    const scope = await rawEvents.requireStaff(sql, actor, id, capability);
    return { ...scope, linkedEventId: await officialLinks.getLinkedEventId(sql, scope) };
  },
};
```

根M03读取Port `getPublished(sql,eventId,options?:{forUpdate?:boolean})`返回 `{eventId,title,publishedVersion,status:'published',sourceUrl?}|null`，必须同时证实赛事当前发布状态、当前publishedVersion及该版正式规则存在。不得选历史版、未发布草稿、自动发现或名称推断。所有Port使用调用方executor；`forUpdate:true`时需锁定当前M03头记录直到事务结束，普通读取默认不锁。可注入 `PostgresEventsRepository.scoped(sql,Boolean(options?.forUpdate))`的当前赛事和规则读取。组织和Hosted写锁顺序由原O01 Port负责，映射随后锁定。

`getLinkedEventId(sql,scope)`默认只读投影，复读映射和当前版本，但不持锁，不可把返回值跨事务缓存后当可信交付依据。仅当组织、Hosted正式版、M03正式版和active映射匹配才返回M03 ID；停用组织、草稿/结束/归档、版本变化、撤回或缓存scope不符返回null。纯Hosted草稿revision变化不改变已发布版，因此不使关联过期。

可信写入使用 `getLinkedEventId(sql,scope,{forUpdate:true})`。该模式须用正在执行事务的executor，依次锁定组织→Hosted→映射(`FOR SHARE`)→M03当前head，保留到根事务结束。涉及私人项目时，根必须先在同事务锁定O01组织/Hosted，再锁M02项目及M03确认记录，然后调用此强校验并确认返回ID仍等于初始预览ID；最后才写M06收件。普通全局`getEvent`装饰器使用两参默认投影，**不应透传forUpdate给关联getter**，防止多赛事GET累积不同组织锁，以及先M03后项目的锁顺序与规则确认冲突。根已有可信交付桥初始Hosted读取在项目锁之前，最终强校验应移到项目/确认锁之后。所有getter均不执行写入或偷更新映射。

公告桥由主会话根 `rootIntegration.publishEvent` 同事务读取实际O01发布快照和changeSummary，再调用O03可信 `publishRuleChange`。本模块不另存公告/邮件事实。

## 服务与HTTP

`createEventOfficialLinksHttpHandlers({service,resolvePrincipal,authorizeMutation,requestId?})`提供 `.handle(request,route)`。`eventOfficialLinksHttpRoute`接收根解码后的 `/api/v1` 后路径段并精确匹配。Origin/CSRF由根 `authorizeMutation` 在PUT/DELETE读body前校验；GET不调用它、不写记录。

| 路径（前缀 `/api/v1`） | 方法 | 输入 | 返回data |
| --- | --- | --- | --- |
| `/admin/organizer/events/:id/rule-link` | GET | 无 | `OfficialRuleLinkView` |
| 同上 | PUT | `{expectedRevision,expectedHostedPublishedRevision,linkedEventId,rulesVersion,auditNote}` | 当前view |
| 同上 | DELETE | `{expectedRevision,auditNote}` | withdrawn view，保留墓碑 |
| 同上`/candidates` | GET | 可选唯一`query`，最多200字符 | 当前正式规则候选数组，最多100条 |
| 同上`/history` | GET | 无 | 最新200个不可变关联快照，revision倒序 |

响应为 `{data,requestId}`，失败为共享错误envelope。私有`no-store`与`Vary: Cookie`。未知body/查询字段、身份/组织伪造字段、重复query、非JSON、无效ID、非法版本均拒绝；JSON流总上限16KiB，备注最多2000字符。ID仅允许字母数字及`._:-`，最多200字符。`expectedRevision=0`只用于首次关联；撤回后重新关联必须使用墓碑的真实revision。

读取view状态为`unlinked/active/withdrawn/stale`，stale含`staleReason/staleMessage`及实际可读的`currentRules`。已暂停组织的旧映射仍可由平台管理员查看和撤回，但不能新建/重新关联。候选未注入返回503；候选会逐项通过当前发布Port复核，不把旧列表快照当当前证据。

CAS冲突返回409、`OFFICIAL_LINK_REVISION_CONFLICT`及latestRevision；Hosted/M03正式版不符返回409 `OFFICIAL_LINK_STALE_VERSION`。相同旧revision重复设置/撤回不产生新记录；已撤回且用当前revision再撤回只返回原墓碑。每次成功设置及首次撤回产生新不可变历史，包含组织、两个正式版本、当前规则标题/来源、备注、操作者、时间。

## SQL与验证

`schema.sql`仅为增量迁移建议，根复制成新的真实迁移；应用前必须有O01表和auth_users。正式规则ID不直接跨模块设FK，M03发布存在性和版本通过Port验证。Hosted+组织双字段FK防止关系串场，history触发器禁止UPDATE/DELETE。

模块测试使用隔离PGlite PostgreSQL与真实SQL会话/角色guard，不读取`.env.local`、真实数据库或后台worker。运行：

```powershell
node --experimental-strip-types --test src/modules/event-official-links/*.test.ts
```

这些测试证明隔离事务/版本/权限行为；PGlite不替代远程PostgreSQL多连接并发验收。根路由/页面、实际迁移、生产浏览器和可信交付装配由主会话验证。无新增环境变量。
