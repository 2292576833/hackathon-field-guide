# O06 正式规则关联交付

2026-10-11，按规划22、宪法v1.12.0和主会话当次授权。仅修改新 `src/modules/event-official-links/` 与本文件；已交付并停止编辑，所有本轮文件交还主会话。

## NEEDS_INTERFACE

精确类型先登记于 `src/modules/event-official-links/model.ts`，根无需修改公共契约即可注入：

- `getHostedEvent(sql,id,{forUpdate?}) -> HostedEventScope|null`：注入**未装饰**的O01 `eventAccess.getEvent`，当前组织未通过/停用返回null；写入锁顺序沿用O01组织→赛事。所有调用复用传入executor。
- `rulesPort.getPublished(sql,eventId,options?:{forUpdate?:boolean}) -> {eventId,title,publishedVersion,status:'published',sourceUrl?}|null`：根读取M03当前人工审核发布版本；不得接受已审核但未发布/历史发布/DSH线索。默认只读；保存映射和可信写入强校验传`forUpdate:true`，根必须锁定M03当前head直到事务结束。可用 `PostgresEventsRepository.scoped(sql,Boolean(options?.forUpdate))`；二参始终false的adapter不足以保证写事务并发一致性。
- `rulesPort.listPublished(sql,{query,limit}) -> PublishedOfficialRules[]`：管理员候选列表，仅当前已发布正式规则，最多100条。未注入则明确503，不用虚构候选。
- `OrganizerPrincipal.guard(sql)`：根由真实请求会话建立，同事务复核账号、会话和当前platformRoles；本模块在操作前后调用，只有admin可管理。Origin用handlers `authorizeMutation(request)`根注入。
- 官方规则变更公告桥由主会话已实现的 `rootIntegration.publishEvent` 和O03可信 `publishRuleChange` 负责。本模块按主会话追加消息只实现正式规则映射，不另建公告事实或重复触发通知。
- 根 `getEventAccess` 全局装饰器调用两参 `getLinkedEventId(sql,scope)` 默认只读投影，只当组织/Hosted正式版/M03正式版匹配才填ID，缺失/撤回/过期返回null，复读当前映射防止读取途中撤回。禁止全局透传forUpdate：O02多赛事listMine相反遍历顺序会累积组织锁；可信交付桥若先锁M03再锁项目，与M03规则确认的项目→M03顺序会形成死锁。
- 根可信交付最后额外调用 `getLinkedEventId(sql,scope,{forUpdate:true})`，需同事务先锁O01组织/Hosted→M02项目→M03项目确认，再强校验映射(FOR SHARE)/M03当前head，返回ID仍匹配初始预览才写M06。该写入校验解决读取之后关联被撤回的竞态；PGlite不代表远程多连接验收。本模块不越界改root bridge，请根组合必须接入最后强校验。

已提供HTTP工厂（根最终挂载，前缀`/api/v1`）：GET/PUT/DELETE `/admin/organizer/events/:id/rule-link`，GET同路径`/candidates?query=...`及`/history`。body白名单及响应类型已在README精确登记。

## 已完成

- `model.ts/index.ts`公共类型和导出，`createEventOfficialLinksService(options)`实际SQL服务，`createEventOfficialLinksHttpHandlers`和精确路由parser。
- CAS设置/撤回、墓碑、真实当前组织/Hosted发布版/M03发布版校验、管理态过期原因、不可变历史；跨组织关系由Hosted+组织双字段FK约束。所有管理行为前后同事务复核真实principal.guard和platform admin；没有生产内存降级。
- 候选目录使用注入listPublished，每个候选复核当前M03发布版，不靠名称推断对应关系。安全来源链接只展示，不进行远程抓取。
- `EventOfficialLinksPanel.tsx/event-official-links.module.css/ui.ts`：props仅hostedEventId。真实候选搜索下拉、版本与来源预览、备注、就地明确关联/撤回、过期说明、409及未知操作结果要求刷新核对、保留输入、异步旧赛事结果隔离。无JSON操作或客户端自报身份角色。
- `schema.sql`仅增量迁移建议，当前关联与不可变历史两张表；无重复公告或邮件表。README列出根装配、权限、HTTP、错误恢复、锁顺序和验证边界。

## 已验证与模拟边界

- `node --experimental-strip-types --test src/modules/event-official-links/*.test.ts`：最终23/23通过（服务14、HTTP9）。
- `node node_modules/typescript/bin/tsc --noEmit --incremental false`：最终全局检查退出0，无错误。
- 真实隔离PGlite SQL引擎、实际SQL账号/session/role guard、同事务失败回滚与不可变触发器。测试事实为自建组织/Hosted/M03当前版本夹具，未冒充生产O01/M03集成或远程多连接并发。
- 覆盖两组织同名仍须明确关联、角色/会话/账号撤销、末尾guard失败回滚、CAS一胜、正式版本过期、草稿/结束/归档/停用、读取不写/不自动升版、scope身份/组织/版本伪造、重试/撤回墓碑、历史禁止UPDATE/DELETE、Port中途事实变化回滚、候选重新核验、Origin先于body、JSON16KiB/字段/ID/方法/查询白名单、未知异常不暴露详情。强锁getter在同事务调用的有效结果也已验证。
- 第二轮只读审查确认默认GET/两参getter不累积组织或M03锁；强锁仅显式开启。远程多连接锁竞争与根可信桥最终强校验仍待根验收，不拿PGlite串行CAS测试充当此证明。
- UI完成定向类型检查和源代码响应式/可访问边界检查；未挂根页面，未执行真实浏览器或390px截图验收。

## 未接入 / 环境变量

根需挂路由和平台admin页面、实际M03 options读锁适配、普通eventAccess装饰器及可信交付最终强校验，并将schema建议复制为新真实迁移。尤其不能只在原交付桥初始Hosted读取中填ID就直接写M06：须在项目/确认锁后再强校验，非空且和初始ID/确认规则一致才提交；失配终止事务。

无新增环境变量。本会话未读取.env密钥，未运行生产库、外部AI/邮件、实际迁移、安装依赖、构建、重启、git操作或发布；公共规划与根文件未修改。生产部署与根路由/页面验收由主会话完成。

## 交还

已停止全部编辑，子代理也已停止。本轮完整授权目录及本交付文档交还主会话；后续修改须由主会话重新授权。
