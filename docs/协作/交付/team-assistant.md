# R03 空间 AI 与选题交付

状态：R03模块已完成、已验证并停止编辑，交还主会话；范围仅 `src/modules/team-assistant/` 与本文。2026-10-09。根最终组合/迁移/真实验收不由本交付代替。

## NEEDS_INTERFACE

稳定签名先登记于 `src/modules/team-assistant/ports.ts` 与 `model.ts`，根可从这两处实现适配。不会导入根私有文件或直接读取导航/M02/M05表。

```ts
interface TeamAssistantContextPort {
  read(actor: Actor, projectId: string, sql: SqlExecutor): Promise<TeamAssistantContextSnapshot>;
  assertCurrent(actor: Actor, snapshot: TeamAssistantContextSnapshot, sql: SqlExecutor): Promise<void>;
}
interface TeamAssistantMemoryPort {
  select(actor: Actor, input: { projectId: string; question: string; maxItems: number; maxBytes: number }, sql: SqlExecutor): Promise<TeamAssistantMemorySnapshot>;
  assertCurrent(actor: Actor, snapshot: TeamAssistantMemorySnapshot, sql: SqlExecutor): Promise<void>;
}
interface TeamAssistantDshRunnerPort {
  readonly configured: boolean;
  run<T>(actor: Actor, request: TeamAssistantDshRequest<T>, guard?: FreshSessionGuard): Promise<{ executionId: string; provider: 'dsh'; data: T }>;
}
```

`TeamAssistantContextSnapshot = {projectId,fingerprint,facts,sources,missing,links,capturedAt}`；facts 为根生成的当前安全对象，指纹只覆盖语义事实（含官方要求/目标/职责/本人任务/共享有效建议），不含读取时间。`links = [{id,label,href}]` 仅站内白名单。`sources = [{id,label,href?}]` 用于依据说明。根 `read/assertCurrent` 在传入 transaction 复核本人账号、活跃成员、归档保护及当前事实。

`TeamAssistantMemorySnapshot = {fingerprint,items,coverage,sources,missing}`；`items = [{id,kind:'navigator'|'personal_memory',content,projectId:string|null,createdAt}]`，只读本人历史/记忆；`coverage = {retainedCount,selectedCount,description}`。根 `assertCurrent` 同事务复核所选内容版本及来源项目当前权限，撤权/共享撤回后禁止旧答案提交。历史完整保留在导航端；空间聊天独立存储。模型最多收到20项/16000 UTF-8字节，本模块也再裁剪；不能以旧记忆绕过撤权。

`TeamAssistantDshRequest<T>` 包含 `projectId,requestIdentity,systemPrompt,input,promptVersion,outputExample,maxOutputTokens,validate,finalGuard`。根 runner 必须走 `createDshWebsiteChat` 同一路径的固定 DSH 预算执行器，持久 lease/rate/unknown hold；**必须在成功落账的同一事务调用 finalGuard**，并执行传入 FreshSessionGuard。模块另一次最终事务复核再保存私有回答。任何未知异常均保守标未知，不自动重发。根已扩展 `PersonalAiPort` 的 `project_feasibility`，报告直接注入该Port；用合并 guard 在生成前/保存前复核项目事实。

共享回调统一 `{sourceKind:'space_assistant'|'feasibility',sourceId,fragment}`；`sourceId` 只能实际保存的本人回答或个人报告 ID。导航来源仍由根传 `'navigator'`。R03 不发布、不采纳、不变更计划，通用片段编辑/预览/确认/撤回由R02及根处理。

根已使用直接持久metadata的来源resolver以避免context/shared循环；**新建feasibility分享的POST仍需复核报告contextFingerprint当前性**（可在发布入口调用`getShareSource`，不要放进读取既有sharedContext的resolver）。UI已拒绝stale，R03服务也会拒绝stale源读取；仅SQL校验artifact属于本人/空间/成功，不等于依据仍当前。根slot还需将当前actor.userId传给两个组件`accountKey`。

## 已完成

已实现类型/Ports、`createTeamAssistantService`、参数化PostgreSQL持久层与模块SQL建议、HTTP工厂、严格模型输出/证据/链接校验、完整私人助手及结构化选题UI。服务不导入其他模块私有文件；聊天以user+project隔离，完整存储与最近100条读取分离。

服务方法：`getContext(actor,projectId,guard?)`、`conversation(actor,projectId,guard?)`、`clearConversation(actor,projectId,expectedRevision,guard?)`、`send(actor,projectId,{message,requestId,expectedRevision},guard?)`、`generateFeasibility(actor,projectId,{idea,expectedContextFingerprint},guard?)`、`listFeasibility(actor,projectId,guard?)`、`getShareSource(actor,projectId,sourceKind,sourceId,guard?)`。

聊天输入最多6000 UTF-8字节，模型历史最多10条/24000字节，记忆最多20项/16000字节；根完整历史不裁存。未知identity固定project+message，不含上下文/时间/历史，清空/换ID/更新资料/跨日不会绕过hold。终态requests不可重写；请求lease默认5分钟，根应保证其大于runner timeout/lease。历史回传同时要求contextFingerprint与memoryFingerprint当前：撤回共享输入或来源项目撤权后，旧成对问答不再自动发给模型，不能借旧回答绕过记忆权限。

Conversation.pending为最近请求摘要，包括succeeded；成功复用实际保存sourceId、未知仅查状态；清空只影响本人本空间聊天，不删除请求hold/导航历史/根个人记忆/已明确共享记录。分享源解析检查本人来源及空间权限，选题报告过期阻止分享源读取；报告只在PersonalAiPort final guard成功后保存，不改目标/职责/任务/完成事实。

根集成例子、API表、UI props和边界详见模块README；服务器用index.ts，客户端用ui.ts。根需传当前userId作为组件accountKey，切账号/空间立即卸载旧私人展示。

## 已验证 / 模拟测试

2026-10-09：`node --experimental-strip-types --test src/modules/team-assistant/*.test.ts` **28/28通过**（模型4、HTTP3、持久层7、服务14）。只用独立内存PGlite及stub模型/Memory/Context/PersonalAi：

- 不同账号/空间读取、分享源与报告隔离；仅本人记忆继承，站内白名单。
- 同requestId重放成功不调用模型；payload变化/CAS冲突拒绝；忙时不能清空/双发，lease过期保守未知。
- 回答期间退出/撤权、归档、资料/记忆变化及fresh session失效均阻止保存成功。
- 来源项目后续撤权但本空间facts未变时，旧回答及问题也不回传；新选择只包含当前有权记忆。
- 本人记忆修订但当前context仍相同时，也不回传基于旧记忆的问答；根追加审查要求已分别覆盖撤权和修改两条回归。
- 网络未知在清空、换ID、更新事实/记忆、跨日后保持hold；不同的新明确问题允许；明确not_sent可另起新请求。
- 根个人AI kind报告私有/本空间过滤，输入变化标stale，旧报告拒绝分享；生成报告不变更目标/分工/计划。
- 无模型不假成功；GET读取不计费；JSON体积/编码/Origin/登录和错误不泄露边界。

`npm run typecheck -- --incremental false` 全局检查通过。UI代理完成SSR夹具及隔离Edge模拟交互：跨空间/转义/unsafe链接/unknown恢复/过期报告不分享，375px与1024px无横向溢出、44px操作目标、键盘焦点与减少动效检查通过。均为模块夹具，不是根网站完整端到端或真实DSH调用。

## 未接入与真实边界

主会话已告知根服务/路由和SpaceAiAssistant slot组合，并在代码中可见；实际DSH预算执行、导航记忆/项目facts、根迁移及最终页面由主会话负责真实验收。本文不把根组合代码或模块SQL建议视为已应用生产迁移/真实模型成功。根仍需复核上文两处接入要求：accountKey及新分享POST的选题报告当前性。未安装依赖、build/start/重启、生产写入、真实付费模型或外部发送。

内部UI/持久化/只读终审代理均已停止，本会话交付后停止修改全部授权文件，不沿用本轮权限继续编辑。

## 环境变量

模块无独立环境变量；根沿用 `DSH_DESKTOP_DIRECTORY`、`DSH_API_KEY`、`DATABASE_URL` 及既有DSH预算配置。不得把值写入文档。
