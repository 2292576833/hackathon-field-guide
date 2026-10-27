# 私人空间助手与选题检查（R03）

每个账号、每个项目有独立持久对话；不复用导航员聊天表，不创建另一套任务/成员/完成事实。只有明确提问调用模型。GET 状态、读取上下文、刷新和清空不调用模型。

## 根接入

从 `index.ts` 导入服务/类型/HTTP工厂；React组件从 `ui.ts` 导入，避免服务端代码被带入客户端包。

```ts
const assistant = createTeamAssistantService({
  database, clock, ids,
  context: rootContextPort,
  memory: rootMemoryPort,
  runner: rootBudgetedDshRunner,
  personalAi: rootPersonalAi,
  requestLeaseMs: 300000,
});
const handlers = createTeamAssistantHandlers({
  service: assistant, resolveActor, authorizeMutation,
  freshSessionGuard, requestIds: ids,
});
```

`ports.ts` 是稳定注入合同。ContextPort 在传入 transaction 读取根授权事实并产生语义指纹；写入/返回模型前调用 `assertCurrent` 同事务复核本人账号、活跃成员、归档保护和主题/规则/职责/任务/依赖/共享建议的变化。MemoryPort 只检索本人记录，完整历史仍归导航端；`assertCurrent` 检查所选内容版本和来源项目当前权限，不能借旧记忆绕过撤权。

根 DshRunnerPort 必须沿现有固定 DSH 路径执行预算/rate/lease、付费未知hold和fresh session检查，不接受通用HTTP或静态回复降级。`request.finalGuard` **必须在执行器成功保存的同一transaction中调用**；本模块保存聊天前还会再检查一次。根可用个人AI新增 `space_assistant_reply` kind桥接，返回实际 artifact.id 作为 `executionId`；把request.validate与合并后的guard原样传入 `PersonalAiPort.generate`。不可把聊天改为直接调用未预算模型。

`requestIdentity` 固定 `{projectId,message}`：换请求ID、清空、改变资料、换日期不能授权同一问题的未知重放。每次实际模型input仍使用最新授权事实/记忆/对话。安全runner失败可提供 `{code,externalState:'not_sent'|'rejected'|'response_received'|'unknown'}`；未分类异常保守未知。已知失败需要用户明确新请求ID，未知相同问题继续阻止。根hold独立保留。

`schema.sql` 是建议，**不是真实已应用迁移**。根应将其作为递增迁移接入已有 `auth_users` / `projects_project` 后再启用服务。聊天完整留存，默认读取最近100条；本次模型最多10条对话/24000 UTF-8字节、20项本人记忆/16000字节。旧回答的项目上下文或记忆指纹已变化时，旧问答对不会自动回传给模型，避免继续发送已撤回共享内容或来源项目已撤权的派生内容。`requestLeaseMs` 需大于根provider timeout/lease；过期模块请求转未知，不重放模型、不退款、不删除账本hold。

## HTTP合同

handler params为 `{projectId:string}`；所有结果解包 `{data,requestId}`，错误为shared ErrorEnvelope，`private,no-store`。根 `authorizeMutation` 做Origin/CSRF检查，actor与freshSessionGuard只能从真实请求会话产生。

| HTTP | 根建议API路径 | handler | 结果 |
| --- | --- | --- | --- |
| GET | `/api/projects/:id/assistant/conversation` | conversation | AssistantConversation |
| DELETE | 同上 | clearConversation | `{cleared:true,revision}`；body `{expectedRevision}` |
| POST | `/api/projects/:id/assistant/messages` | send | AssistantReply；body `{message,requestId,expectedRevision}` |
| GET | `/api/projects/:id/assistant/context` | context | TeamAssistantContextSnapshot |
| GET | `/api/projects/:id/feasibility-reports` | listFeasibility | FeasibilityReportRecord[]，仅本人、本空间 |
| POST | 同上 | generateFeasibility | FeasibilityReportRecord；body `{idea,expectedContextFingerprint}` |

`conversation.pending` 是最近请求摘要（可能为running/unknown/failed/**succeeded**），包含本人原问题message，便于丢失HTTP回复后只读核查；不是自动重发许可。成功同requestId复用真实保存答案，即使expectedRevision旧也不二次请求模型。清空后不能重放已清空的成功内容，未知requests仍保留。

## UI接入

`TeamAssistantPanel` / `FeasibilityPanel` 的 `projectId` 必填；根应传当前账号ID为 `accountKey`，使账号或空间变化立即卸载旧私人展示。`apiBase` 默认 `/api/projects/${encodeURIComponent(projectId)}`；可注入 `request<T>(path,{method,body,signal})` 兼容根HTTP封装；支持服务器提供initialContext/initialConversation/initialReports、readOnly及onShare回调。根报告slot可传configured状态。

私人聊天支持读取/提问/查看当前事实与记忆覆盖/只读核查/确认清空；失败保留输入，不在GET、轮询或网络恢复时发付费POST。模型未配置不会出现假回答。选题检查先预览当前facts，明确生成并持久保存本人结构化报告，展示规则适配、最小演示、技术待验证点、能力时间、风险和验证任务；报告不是已创建任务，不改目标、职责或生效计划。

`onShare({sourceKind:'space_assistant'|'feasibility',sourceId,fragment})` 只在用户编辑、预览并明确确认分享后调用，实际发布/去重/撤回/采纳由根/R02处理。sourceId来自实际保存的回答/报告。`getShareSource` 可在发布入口验证本人来源并取得文本；`formatFeasibilityForSharing` 产生可核对原文摘录。旧报告指纹不符时禁止通过服务分享源读取，以防旧依据冒充当前结论。导航员来源仍归根处理。

根如果在R02来源resolver直接读取持久metadata（避免context→共享上下文→来源resolver递归），应在**新建分享的POST入口**对feasibility调用本服务`getShareSource`或做等效当前fingerprint检查；不要在读取已发布共享建议时递归读取全context。本模块UI已阻止stale报告分享，服务的当前性复核仍需根发布入口使用。

## 验证与边界

`node --experimental-strip-types --test src/modules/team-assistant/*.test.ts` 使用内存中的隔离PGlite与stub Ports，不读 `.env.local`、生产目录或调用模型。测试验证权限、会话、跨账号/空间、CAS/去重、超时与unknown保留、旧共享资料回传、报告不自动采用、模型schema/依据/链接白名单及HTTP边界。

没有新增依赖或环境变量。真实根路由、持久数据库迁移、DSH预算adapter、手机/桌面页面及真实模型质量由主会话最终接入验收；隔离模拟通过不能作为真实DSH、邮件、GitHub、主办方或多连接PostgreSQL成功声明。
