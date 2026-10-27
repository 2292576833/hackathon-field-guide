# U02 赛道分工与任务进度交付

日期：2026-10-09。依据宪法 v1.5.0、体验整合规划与最新多人邀请要求。当前状态：U02 模块与组件交付完成，已停止编辑，全部授权文件交还主会话。只修改 U02 授权清单与追加授权的 invitation-client.tsx / space-invitation.tsx。根接口、实际迁移、应用组合和整站验收由主会话负责；本次交付不表示这些根接入已经完成。

## 已实现 / 已验证

### 已实现

- 每次参赛以“团队空间”组织，底层仍是 Project / ProjectMembership。空间概览与计划页面复用同一个 TeamTaskBoard，优先看自己的任务、等待项和最近任务截止；固定队伍仍是可选长期设置。
- 官方赛道 stable ID、名称、资格/评分重点、正式提交要求引用及对应官方证据；`unknown/none/conflict/confirmed` 分开。旧规则无字段时保持未知；规则更新产生赛道差异，不从工具或技能包分类补造赛道。
- 项目选择引用 eventId / rulesVersion / confirmationRevision，管理员修改采用选择自身 revision，当前和历史分别持久保存。新公开规则或项目规则改变只提示复核，不静默改团队已确认安排。
- 成员本人独立多选职责、经验与希望获得的帮助；四个共享字段显式 opt-in。管理员不能代改本人意愿，退出后排除、重新加入或角色变化后旧共享暂停；保存意愿、赛道都推进项目 revision 和同事务脱敏活动/outbox。
- 自选不要求评分；三个私有问题可请求真实模型帮助。持久排队、本人结果、幂等键、派发前后权限及输入核对、严格结构校验、未知结果不自动重发已实现。点击建议仅填本人草稿，手动保存和明确共享后才能进入团队分工输入。
- 分工模型使用当前官方要求、主动共享意愿与确认可用时间，角色可多选；正式任务有一个主负责人。队列和历史快照仅保存意愿版本引用，不保留撤回后的私有正文。首次未知/未细分可确认通用准备；既有赛道选择改变必须复核。
- 任务板显示“我现在能做 / 等待队友 / 正在做 / 待检查 / 已完成”，等待时显示前置任务、负责人和可先做的任务。复用既有容量、循环、时间与缓冲规则，不固定串行 demo→UI→视频。
- “我已完成”提交成果到 review；验收才 done 并释放依赖。本人/协助者可提交已验收更正请求（不改状态）；管理员明确核对全部后继后更正，保留原验收、理由、操作者、时间及后继影响。普通 progress 仍不能回退 done。
- 可见时每 10 秒只读 current/progress 和当前空间权限；隐藏或卸载停止并取消任务板请求。输入按任务 ID 保留，revision 从开始编辑时固定，新版本提示并发冲突。赛道/意愿保存事件仅刷新已保存数据，不触发模型或替换编辑输入。
- 邀请默认普通成员，人数默认 1、快捷 1/3/5、自定义 1–50；链接与主会话提供的本地二维码共用额度。真正新加入才消费，重复/活跃成员不耗额不提权，原消费者退出或被移除不能复用旧邀请、不返还名额。消费记录唯一且不可改，范围锁/CAS/审计/成员/quota 原子提交。旧单人 accepted 回填保持已用状态。
- 已加入且仍活跃的成员，可通过撤销、过期或关闭范围的旧邀请进入自己已有空间；不耗额、不改变角色、不恢复邀请。非成员仍受原有效期/撤销/范围/邮箱规则约束，原消费者离队或被移除仍不能借旧邀请恢复。两种范围的六项补充测试覆盖该入口与匿名失效预览。
- 游客先看持 token 的最小公开说明，登录/注册保留原 returnTo；仅明确 POST 接受才加入。过期/撤销/满额、限定邮箱、已加入、网络结果未知分别有下一步；公开预览不返回成员、邮箱、目标、hash 或接受人。

### 文件

- `src/components/projects-client.tsx`：团队空间创建/概览、SpaceTaskSummary、官方赛道选择；`project-client.tsx`：组合职责/赛道/协作流程；`project-workflow.tsx`：连贯导航与通俗文案。
- `src/components/assessment-client.tsx`：本人意愿、共享 projection、三个私有问题及实际持久 job 读取/选择；原正式测评保留可选入口。
- `src/components/planning-client.tsx`、`planning-ai.tsx`、新增 `team-task-board.tsx`：复用分工/计划和任务进度；自动读取、更正与输入保留。
- 新增 `src/components/space-invitation.tsx`、调整 `invitation-client.tsx`：人数/链接/二维码、游客最小预览、登录上下文和接受结果恢复。未修改 root QR 文件、共享 CSS 或 client-api.ts。
- M03：新增 `official-tracks.ts`、`official-tracks-postgres.ts`、`official-tracks.test.ts`，增强 domain 与 index / README。
- M02：新增 `collaboration.ts` / `collaboration-postgres.ts` / `collaboration-handlers.ts`、`invitation-usage.ts`、两份 SQL 建议、协作/名额测试；增强 model / ports / service / postgres / handlers / index / README 及既有测试夹具。
- M04：新增 `role-help.ts` / `role-help-model.ts` / 测试 / SQL 005；增强 types / ports / assignment-rules / model-assignment / service / index / README 及快照相关测试。
- M05：新增 `task-board.ts` / `progress-correction.test.ts` / `task-board.test.ts`；增强 types / service / rules / diff / parse / http / index / README。
- 未修改根 app/server/shared/migrations、依赖、公共规划、实际运行数据或 discovery-client.tsx；授权文件 `assignment-plan.ts`、`assessment-catalog.tsx` 本轮无需改动。

### 已验证

| 范围 | Node 测试 | 说明 |
| --- | --- | --- |
| events + projects | 233 / 233 通过 | 包含 27 项新增赛道/意愿/邀请行为；独立内存 PGlite 执行建议 SQL 和真实持久适配；最终联合回归含已加入成员入口修复 |
| assessments | 197 / 197 通过 | 私有模型夹具、原子队列、权限/共享撤回/输入新鲜度/未知恢复与 SQL 约束 |
| planning | 153 / 153 通过 | 并行依赖、容量、完成/验收/更正请求/后继影响、归档/退出/revision 与严格 HTTP |
| 全局 TypeScript | `npm run typecheck` 通过 | 组件组合及新增 DTO 编译通过，邀请最后修复后重新核对 |

UI 未用虚构结果填补缺接口；404/503 会明确显示暂时不能读取或模型未接入，手动分工仍可继续。测试未向 DSH 发送真实付费请求。

## NEEDS_INTERFACE

### 1. 实际增量迁移

主会话为以下建议分配新根编号，不重写已应用 SQL：

1. `src/modules/projects/sql/ux-official-tracks-intentions.sql`：四张本人意愿/项目赛道当前及历史表，扩展 `projects_change_fact_type_check` 接受 `MemberIntentionChanged/ProjectTrackSelectionChanged`。
2. `src/modules/projects/sql/ux-invitation-capacity.sql`：邀请 `max_uses/used_uses`，唯一不可改 `projects_invitation_acceptance`，旧 accepted 单人事实回填，deferred 实际消费计数约束。**新 M02 仓储必须在此迁移后运行。** 不增加第二份 Workspace 表。
3. `src/modules/assessments/sql/005-assessment-role-help.sql`：私有 durable job 表、CAS/唯一幂等/输入与终态不可改约束。
4. M05 增量 SQL 为 0；输入版本和更正 metadata 复用现有 `planning_states.state_json`、幂等与 outbox。

### 2. 官方赛道与本人意愿路由

由公共入口组合：

```ts
new ProjectCollaborationService({
  projects: projectRepository,
  repository: new PostgresProjectCollaborationRepository(),
  officialRules: new PostgresOfficialTrackRulesPort(),
  clock, ids,
});
createProjectCollaborationHandlers({service, resolveActor, authorizeMutation});
```

以下均在 `/api/v1` 下，handle descriptor 带 `projectId`：

| 方法/路径 | kind | 数据 |
| --- | --- | --- |
| GET `/projects/:id/official-tracks` | officialTracks | `{projectId,projectRevision,canManage,readonly,rules,selection,needsReview,history}` |
| PUT `/projects/:id/track-selection` | trackSelection | 输入 `{expectedRevision,eventId,rulesVersion,confirmationRevision,trackId,reason}`；返回同 GET view |
| GET/PUT `/projects/:id/my-intention` | myIntention | GET `{projectId,projectRevision,membershipRevision,readonly,needsConfirmation,intention}`；PUT 下例 |
| GET `/projects/:id/shared-intentions` | sharedIntentions | `{projectId,projectRevision,intentions:[{userId,revision,membershipRevision,updatedAt,...显式共享字段}]}` |

赛道仅活跃 manager 写、归档只读；初次 expectedRevision=0，以选择 revision 而非 Project.revision 防覆盖；none 用 trackId:null，unknown/conflict 拒绝正式选择。意愿仅本人写，例：`{expectedRevision:0,duties:["design","development"],experience:"本人描述",wantsAiHelp:false,helpQuestion:"",share:{duties:true,experience:false,wantsAiHelp:false,helpQuestion:false}}`。职责固定八值详见 `PROJECT_DUTIES`。正文最长 2000，选择理由最长 1000。

同事务检查当前账号、请求会话、活跃 ProjectMembership 和项目归档；传同一 executor/ambient transaction。409 保留输入，GET 新版本并由用户明确核对，不自动重试覆盖。GET 严格只读/no-store，不初始化收费任务。

### 3. 分工与排期输入事实

- M04 `AssignmentContextPort.getSnapshot(projectId,sql?)` 增加 `officialTracks`（当前规则身份/catalog/selectedTrackId/needsReview/官方证据）、`trackSelectionRevision`、`confirmedRequirements:[{id,text,evidenceIds}]`、`memberIntentionRefs:[{membershipId,revision}]`。
- members 增加 `availableMinutes:number|null` 和 `sharedIntention:{revision,membershipRevision,duties?,experience?,wantsAiHelp?,helpQuestion?}`。仅本人当前 opt-in 字段，未确认时间为 null；不读取私人测评/画像替代当前意愿。退出成员排除、旧 membershipRevision 的共享与时间排除，撤回共享仍传当前引用 revision。
- `getCollaborationContext(actor,projectId)` 返回 `{project,members,officialTracks,intentions,availability}`，配合当前 ambient 事务。根内部事实适配也可调用 M02 公共 `PostgresProjectCollaborationRepository` 的读取方法，并以 `sharedIntention` 公共函数严格投影当前有效共享字段，勿直接传 private body。官方规则用 M03 公共 Port，模块不能直接互写表。
- 持久快照只有引用，派发时读取当前共享正文；采用前再次比对输入。根 `facts.ts` 的重复手写分工 fingerprint 需换成公共 `contextFingerprint`（或相同规范化方法），否则新字段可能被漏掉。旧快照的新字段只能保持未知，不能回填今天的状态为历史事实。
- M05 `PlanningFactsPort.readInput/lockVersions` 同时映射 `trackSelectionRevision/memberIntentionRefs`；当前 `inputVersionsChanged` 与普通进度造成的 `staleInputs` 分开。沿用既有 M04 head→M02→M03 锁顺序和同 executor，不另外开连接。

### 4. 私有 AI 职责帮助

公共 `createRoleHelpService({database,assignmentContext,clock,ids,model,modelTimeoutMs,assertActor})`，model 用 `createModelRoleHelp({model:现有budgetedJsonModel})`；`createRoleHelpHttpHandlers` 提供 queue/job/latest。

| 方法/路径 | handler | 请求/结果 |
| --- | --- | --- |
| POST `/projects/:id/role-help-jobs` | queue | `{answers:{experience,interests,constraints}}` + Idempotency-Key；202 本人 job |
| GET `/role-help-jobs/:jobId` | job | 仅本人 view，含 idempotencyKey/result/freshness，不回原 answers |
| GET `/projects/:id/role-help/latest` | latest | `{job:view或null}`；不派发 |

答案每条最多 2000，至少一条非空；本人可用，manager不能代读。HTTP POST 必须 Origin/CSRF guard，`assertActor(actor,sql)` 同事务重查账号与请求会话；worker 根据服务器持久作者身份重查账号。`createRoleHelpRegistration(service)` 的 `kind:"m04_role_help"` 接通用 AI worker、同一预算/usage 结算、lease 与未知结果 hold。不要在 HTTP 中调用 execute，不用普通未受预算 model 绕过账本。未知终态 failed 带 `execution:{status:"unknown",canRetry:false}`；客户端按 key 匹配最近记录，不能拿另一个旧 job 当成请求成功，也不能换 key 绕过 hold。

### 5. 两条更正路由

- POST `/projects/:id/tasks/:taskId/acceptance-correction-request` → `createPlanningHandlers.requestAcceptanceCorrection`，`{expectedRevision,acceptanceProgressId,reason,idempotencyKey}`。当前 owner/helper，归档禁止；只追加请求，不改任务 revision/状态/依赖。409 旧验收或版本，403 无权限。
- POST `/projects/:id/tasks/:taskId/acceptance-correction` → `correctAcceptance`，`{expectedRevision,expectedTasksRevision,correctionOf,correctionReason,status:"review"|"in_progress",acknowledgedDependentTaskIds,idempotencyKey}`。仅当前 manager；精确当前验收和全部活跃传递后继 ID，原验收保留，后继 done→review / in_progress→blocked。全部事务提交。GET current/progress 自动返回新增兼容字段，不派发模型。

### 6. 多人邀请与匿名说明

- 既有 POST `/projects/:id/invitations`、`/teams/:id/invitations` 增加 `maxUses?:number`，省略=1，整数 1–50；原 `expectedRevision/role?/invitedEmail?/expiresAt?` 保留，省略 role 默认 member，旧显式 manager/captain 兼容。创建响应依旧 `{invitation,token,projectRevision或teamRevision}`，只在此返回原 token。
- `PublicInvitation` / 认证 `InvitationPreview` 增加 `maxUses/usedUses/remainingUses`；公开接受人和消费记录绝不返回。旧 accept 路由不变，活跃成员重复不占额不提权，消费后 left/removed 拒绝原链接恢复，末位 scope 锁保护，失败原子回滚。
- GET `/invitations/:token/public-preview` → `createProjectsHttpHandlers.handle` kind `publicInvitationPreview`（独立匿名只读）。有效 pending 返回 scopeType/scopeName/eventName/inviterDisplayName/requestedRole/expiresAt 和匿名名额。expired/revoked/used/unavailable 时私有上下文为空；已满可保留匿名额度。没有 scopeId/目标/邮箱/名单/hash/acceptances。
- 根向 `ProjectsService` 注入 `PublicInvitationDetailsPort`：`getPublicEventName({projectId,initialEventId},sql?)` 和 `getPublicDisplayName(userId,sql?)`。仅实际可公开读取的比赛名和昵称，优先本空间正式规则确认；未接时明确 null，不能从邮箱猜名字或编造比赛。
- 旧认证 GET preview 与 POST accept 对真正新加入者保留限定邮箱验证和会话权限，不以匿名预览替代认证。当前活跃成员根据已有成员关系进入，即使旧邀请撤销、过期或范围关闭；该路径不消费、不提权、不增加审计或 revision。原消费者当前离队/被移除则仍拒绝原邀请恢复。页面已保留同一 `/app/join/:token` 的 login/register returnTo；只读打开不会加入。root保持邀请页面 no-referrer/no-store、token 不进入日志，二维码继续使用已有 root 组件。

## 未接入 / 真实验收边界

以上根路由、事实映射、实际迁移和 budget worker 组合尚未由 U02 接入；本地已有存储不能先运行新邀请仓储而漏执行 quota 迁移。新规则字段不会自动为现有比赛补造官方赛道，真实缺字段仍显示待核对。

未构建/重启/发布、未打开运行中的 `.runtime/postgres-data`、未读取 `.env.local`、未发真实验证码/付费 DSH/真实 GitHub 写入、未改 root dependencies/CSS/QR/app/server/shared。没有新增环境变量；根复用 `DATABASE_URL`、`AI_PROVIDER` 及现有 DSH/预算配置，仅记录名称不含值。

隔离 Node/PGlite 与模型/身份夹具不代表线上 PostgreSQL 多连接、两个真实浏览器账号、手机扫码/登录/微信QQ复制、新人实际可用性或真实模型验收。主会话还需完成根组合后按 375px/1280px、真实两账号并发、未知调用和权限撤回脚本验收。空间名/中文长文本/表单冲突与同一邀请返回登录上下文请重点检查。
