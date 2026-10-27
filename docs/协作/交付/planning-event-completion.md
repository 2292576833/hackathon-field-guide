# C03 计划提醒、赛事纠错与恢复草案

2026-10-10；已完成并停止编辑，文件交还主会话。旧 R 轮已停止；本轮只修改 planning/events 模块、此交付及追加授权的 `src/components/planning-client.tsx`。根组合、实际迁移和运行进程由主会话负责。

## NEEDS_INTERFACE（先登记）

- 真实 M05 outbox：`PlanningEvent.type = PlanDraftGenerated | PlanApplied | ProgressUpdated | PlanRiskDetected`，字段 `id,type,projectId,aggregateId,revision,occurredAt`；持久表 `planning_outbox`。它没有现有派送 worker；不将 `published_at` 当唯一消费游标，新增本消费者 receipts 以免抢占其他消费者。
- 真实 M02 fact：`ProjectCreated | ProjectScopeChanged | ProjectMemberJoined | ProjectMemberLeft | ProjectMemberRoleChanged | MemberAvailabilityChanged | ProjectStageChanged | ProjectResourceBookmarked | MemberIntentionChanged | ProjectTrackSelectionChanged`；真实 M03 outbox：`EventPublished | EventRulesChanged | ProjectRequirementsConfirmed | EventCorrectionSubmitted`。本模块不直接读写 M02/M03 表；根按这些变更或周期选择项目调用下面方法。
- 已完成公共工厂：`createPostgresPlanningNotificationRepository(database)`；`new PlanningNotificationService({repository,projects,snapshots,clock,ids})`；worker `createPlanningNotificationWorker(service).runOnce({projectIds?,limit?})`。方法 `reconcileProject(projectId)` 在单事务消费 M05 outbox，并核对当前确定性风险快照；`listOwn(actor,{limit?,projectId?})`、`markRead(actor,id,{expectedRevision})`、`dismissResolved(actor,id,{expectedRevision})` 只写通知状态。worker 返回 `{projects:[{projectId,events,created,recipients,resolved}],errors:[{projectId,code}],modelRequests:0}`；根复用同实例，传当前有计划/关联变更项目作周期检查，内部以 keyset 走完整 pending 队列并保留未选中的候选；错误不抛出私人消息。
- 根注入 `PlanningNotificationProjectPort.lockProject(projectId,sql)`，返回 `{projectId,archived,members: ProjectMembershipAccess[]}`，只含活跃且仍可登录的当前项目成员；须同 executor 保护项目、成员和账号状态。不可以 Team captain 替代 Project manager。**锁序注意：模块先取得 planning advisory，然后调用此 Port；现有 facts.ts 保护路径是 assignment head → project，不能先 project 锁后再调用带 head 锁的 getCurrent/readInput。根应用专用只读通知快照，后置 assignment head 读取用普通 SELECT；或在此 Port 先保护必要 head 再 project，且 GET 不能初始化 head。完整全站锁序与多连接验证由根核对。**
- 根注入 `PlanningNotificationSnapshotPort.readSnapshot(projectId,sql,now)` 返回 `{facts: PlanningNotificationFact[]}`，每项 `{cause,sourceRevision,taskId?,label?,requiresAction?}`。`cause` 精确联合为 `deadline_risk | owner_changed | availability_changed | rules_changed | input_changed | deliverable_review | task_blocked | acceptance_correction_requested`。`sourceRevision` 是真实字段版本/任务版本的确定性字符串，不能包含读取时间或模型生成文字；requiresAction 默认 true，已生效负责人安排告知为 false。可用 `derivePlanningNotificationFacts({current,input,progress?})` 从已安全构造的当前评估与当前 M02/M03 输入生成。快照只能确定性只读并保护事实直到提交，禁止调用 AI/生成/应用计划。公开新版尚未被项目确认时，根另从真实 M03 公开/确认版本差异加 rules_changed，不自动改确认。根 scheduler 可周期传当前有计划项目（期限流逝没有 outbox）及 M02/M03/M06 变更关联的 projectIds。
- 建议根 GET `/api/v1/me/planning-notifications?limit=50&projectId=...`，POST `/api/v1/me/planning-notifications/:id/read` 和 `/dismiss`，payload `{expectedRevision}`；工厂 `createPlanningNotificationHandlers({service,resolveActor,requestIds,authorizeMutation})` 方法 `listOwn(request)`、`markRead(request,id)`、`dismissResolved(request,id)`。GET 数组返回 `OwnPlanningNotification`：`id,projectId,cause,sourceRevision,title,message,href,taskId,requiresAction,createdAt,updatedAt,resolvedAt,revision,readAt,dismissedAt,status(active|resolved|archived)`；内部 keyset 继续扫描撤权引用，项目筛选在服务器执行。GET 不消费、不初始化、不写库、不产生收费任务。归档项目保留有权本人的历史，停止新派送；归档恢复/真实风险复发重开同 group 并更新未撤权 receipts；撤权不返回任何通知，重新加入不恢复已撤销记录。已读只写个人 receipt，仍在触发的 action 风险不能收起；已生效安排告知可个人知悉收起，不影响队友。UI `PlanningNotificationsPanel({viewerId:string|null,projectId?:string})` 经 planning/components.tsx 导出，已在 planning-client 挂载。
- SQL 只提供模块建议 `src/modules/planning/migrations/003-planning-notifications.sql`，根用新的递增迁移组合；不可重写已应用根文件。
- 赛事纠错复用根现有 POST `/api/v1/corrections`、GET `/api/v1/me/corrections[/id]`，`target:{kind:'event',entityId,version},field,message,evidenceUrls`，M08 为唯一队列/处理事实；不新增另一套 M03 状态。
- 追加恢复：根 POST `/api/v1/projects/:projectId/plan-versions/:planId/restore` 接 `createPlanningHandlers.restoreAsDraft(request,{projectId,planId})`；payload `{reason,expectedTasksRevision,basePlanVersionId,idempotencyKey}`，201 返回新 PlanVersion。服务器读取历史版本，manager/当前事实/任务基线/归档重新验证，保存新草案、保留已验收成果；应用仍走现有人工确认。`PlanChangesPanel({plan:PlanVersion,baseline:PlanVersion|null,memberNames?:Readonly<Record<string,string>>,timeZone?:string})` 展示原始不可变基线和草案真实逐项差异，经 planning/components.tsx 导出。已挂在追加授权的 planning-client；parseRestorePlanCommand/RestorePlanCommand 与差异纯helper由 planning/index.ts 导出。
- events/components.tsx 导出 `EventCorrectionPanel({eventId:string,currentEvent:PublicEvent,viewerId:string|null})`、`RuleChangesPanel({comparison:ProjectRuleChanges,currentRules?:EventRuleVersion|null,latestRules?:EventRuleVersion|null,timeZone?:string})`。ProjectRuleChanges 由 events/index.ts 公共导出，准确字段 `{confirmation:ProjectRuleConfirmation|null,latestVersion:number|null,changes:RuleChange[],needsConfirmation:boolean,publicationUnavailable?:boolean}`；RuleChange `{path,before,after}`。`EventRulesPanel` 新 timeZone/localTimeLabel（`账号时间|浏览器时间|北京时间`），兼容 userTimeZone；缺失或非法明确北京时间。根规则页接现有 GET `/api/v1/projects/:projectId/rules/changes`；另反馈代理独占 root discovery-client，C03不编辑。

## 追加授权：M05 可选技能引用

2026-10-10 主会话追加最小 optional `PlanningTask.skillRefs`，M10 公共引用/纯helper，lookup 经注入 Port，旧缺省/[]兼容；仅 planning 模块，不改 M10/M07/root。

NEEDS_INTERFACE：`PlanningReviewedSkillsPort.get(reference:FixedSkillReference,transaction:SqlExecutor):Promise<ReviewedSkillOption>`；`PlanningServiceDependencies.reviewedSkills?:PlanningReviewedSkillsPort`。主会话在同一 executor 复用/构造 M10 `createReviewedSkillLookupPort`，返回完整已审核固定版本 option。新选/新用途/环境/学习分钟变化/历史恢复新采用时校验；应用再核对新采用引用；完全相同的生效历史引用保留，done 引用不可修改。学习分钟总和以公共 `assertTaskSkillLearningIncluded(refs,task.durationEstimate.likelyMinutes)` 核对，不能创造第二份容量或安装成功。

已完成 `PlanningTask.skillRefs?: TaskSkillReference[]`、解析/服务/模型可选 schema、固定版本 lookup 及实际差异展示。缺省沿用已有任务引用，`[]` 显式清空；新采用不能替换成最新版本或另一条引用。已生效历史完全相同引用即使后来撤回也保留，仍为 cancelled 的历史不阻断无关新操作；cancelled 恢复为活动任务属于新采用，重新审核。done 引用不可修改，旧调用省略引用仍保留完成事实。模型仅可使用当前任务中实际存在的固定版本候选，不构造新技能或安装成功。新增技能规则 14 项、技能差异 2 项测试通过，覆盖 lookup 权限/固定身份、创建与应用再核对、学习分钟、兼容缺省和历史恢复。

## 已完成 / 已验证

- 持久站内通知、独立 outbox 消费 receipt、确定性风险检查、本人权限/CAS、撤权与归档/复发处理、轮换 worker、HTTP 和 UI 已完成。只修改通知收件状态，不修改任务或触发模型。
- 正式赛事纠错 UI 复用 M08 唯一队列；本人处理记录、未知提交结果核对、登录隔离、逐项规则差异和明确时区已完成。
- 历史计划恢复为新草案、当前事实校验、真实逐项差异、可选固定技能引用及学习工时校验已完成。
- 最终回归命令：`node --experimental-strip-types --test --test-concurrency=2 <planning/events 全部 .test.ts> src/modules/operations/correction-service.test.ts src/modules/operations/correction-handlers.test.ts`。**384/384 通过，0 失败、0 跳过**。覆盖权限、并发/CAS、事务回滚、重复消费、风险复发、归档恢复、队列公平性、项目筛选、固定技能和既有验收成果保留。
- 最终 `npm run typecheck` **通过**。之前根测试误从 types.ts 导入 TaskProposal 的错误已由主会话修复；本轮不再存在已知类型阻塞。

## 模拟测试与真实边界

服务测试使用注入时钟/Ports、模拟外部接口与隔离 PGlite 数据库；持久化约束、原子回滚和同 executor 行为有测试证据，但不替代线上多连接 PostgreSQL 锁竞争验收。未调用真实模型、邮件、GitHub 或其他外部服务；未运行网站真实数据库迁移、build、重启或浏览器验收。

## 根接入 / 待根验收

按最后只读检查及主会话确认，根已组合 `reviewedSkills` 同 SqlExecutor、通知专用 `facts.readInputForNotifications`、后台 worker、通知 HTTP/UI 和恢复路由。C03 没有编辑这些根文件。真实迁移采用模块 `003-planning-notifications.sql` 建议的新递增文件，执行、备份、构建、启动、全站锁序、浏览器和真实队伍验收均由主会话完成；本交付不宣称这些步骤已经成功。

## 文件与环境

本轮新增通知文件 `notification-types.ts`、`notification-facts.ts`、`notification-postgres.ts`、`notifications.ts`、`notification-http.ts`、`PlanningNotificationsPanel.tsx`、两组通知测试及模块 SQL 建议；新增恢复/差异文件 `restore-command.ts`、`restore-http.test.ts`、`diff-presentation.ts`/测试、`PlanChangesPanel.tsx`、`plan-changes.module.css`、`skill-refs.test.ts`、`skill-diff.test.ts`。规划模块已有 types/ports/parse/service/generation-model/diff/http/index/components/README 与授权 planning-client 完成接入。

赛事模块新增 `EventCorrectionPanel.tsx`、`correction-client.ts`/测试、`RuleChangesPanel.tsx`、`rule-display.ts`/测试、`event-completion.module.css`；修改 EventRulesPanel/model/index/components/README。所有修改均在本轮授权范围内。

无新增环境变量；数据库连接沿用根 `DATABASE_URL`，模块不读取或输出凭据。四个内部代理均已交付停止，本会话此记录完成后停止编辑，全部临时所有权交还主会话。
