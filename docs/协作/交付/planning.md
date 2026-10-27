# M05 规划模块交付

日期：2026-10-08。仅修改 `src/modules/planning/` 与本文；无 npm install、全局 Git 操作或实际迁移。

## 已完成

- `index.ts` 公共导出、README、实体与 Ports、HTTP handler 工厂和严格输入解析。服务端会话提供 Actor，拒绝 JSON 中的身份、角色、验收状态等额外字段；cookie 写操作要求主会话注入同源/CSRF保护。
- 版本化多截止、IANA来源时区、UTC实际时刻；重叠工作窗口并集、休息/占用扣除、当前时间裁剪；M02集合适配不重复加 effectiveMinutes。
- 工时三点区间、依赖DAG与具体环链、同项目与当前负责人、must/optional、规则材料与审核资源ID、连续任务/分段恢复成本、外部等待、helper真实容量、集成/测试/学习等明确阶段、独立提交缓冲的确定性规则。
- 常规与保守估算分别排程，输出 unknown/feasible/at_risk/infeasible 和缺口/受影响任务/建议。稳定贪心算法不声称最优，不保证按时。提交缓冲留给对应submission任务，其他工作不能侵占。
- 手动创建/编辑草案、基线及输入快照、重大差异（包含正式来源截止改变、窗口、要求、排程和风险）、新鲜度查询、manager确认与原子应用、旧版本保留与恢复为新草案。
- 进度追加记录及有理由的修正、负责人/验收人权限、review→done证据检查、前置成果验收检查、明确自检来源。新进度使草案stale，旧草案应用冲突并保留新成果。恢复已删减可选任务需显式reopenCancelled，已验收任务保持事实。
- PostgreSQL 参数化repository：首次写入项目事务锁、revision乐观更新、分项目/actor/action幂等键及fingerprint、事务outbox、数据失败回滚；`migrations/001-planning.sql` 仅迁移建议。
- 资源 ID 保持原 UI 输入；服务端固定 M09 公开内容版本 `resourceContentRefs`，快照记录 `resourceContentVersions`。新选择/显式ID刷新在草案和应用事务中调用 `validateResourceRefs`；标题编辑保留固定版本和待审核来源，版本变更不能通过风险确认绕过新引用审核。
- 已应用历史引用保留原版本，同ID内容改版/下架/不可查询使实时评价与差异过期并提示复核；保留旧依据需要新草案明确确认。旧字符串记录不回填当前版本，可信恢复来源单独记录，移除后重新加入和取消的新任务仍按新引用审核。超过50项引用按全局ID排序分批读取/锁定后复核；无引用时手动规划不依赖资源provider。
- 最终锁定事实支持可选 `projectArchived/projectReadOnly`，归档/只读拒绝创建、编辑、恢复、应用与进度变更并保留可读历史；最终事实锁后重查活跃权限。可选资源与项目状态字段兼容既有JSONB；AI生成job另有002新增迁移建议。
- `createPlanningWorkflowReader` 为M02提供已确认计划/实际任务事实查询，供M02自身授权后的流程组合使用。
- `createPlanningModelAdapter` 对接根统一 `PlanningJsonModelPort`，可配置供应商model（包含DeepSeek），不导入server或负责网络调用/重试。提示词保留实际事实层与不可信文本边界；只接受 `{tasks,reason,assumptions}`，拒绝模型身份、状态、固定资源版本、正式截止或替换缓冲声明。默认输出token上限由根transport选择，显式可传adapter第二参 `{maxOutputTokens}`。
- 实际持久 `planning_generation_jobs` repository、HTTP 202排队/列表/状态/显式重试/取消和受控worker处理/租约恢复。作用域幂等、任务基线和M02/M03/M04/资源公开依据固定，发送前与落库前锁后复核；manager关系撤销、版本改变、归档与资源改版拒绝保存。默认30秒/最多2次尝试，超时未知不自动重试，迟到结果拒绝。
- AI专用约束：所有必交要求维持原截止及must；必须集成/测试/材料/提交阶段、每截止正数确认缓冲和独立提交，依赖链等待同截止必须工作；已有任务不得因AI遗漏取消，已验收事实保留。容量不可行的合法草案可供讨论，未确认AI假设持续参与评价/应用/恢复，生成成功仅产draft，不自动apply。
- job完成与草案/outbox/幂等保存使用根同executor事务；失败或最终锁等待租约到期回滚全部新成果。新增 `migrations/002-planning-generation.sql` 仅建议（新表、队列/运行索引、JSONB一致性约束），未执行根/实际项目迁移。

## 已验证与模拟测试

- 模块测试：`node --test src/modules/planning/*.test.ts` → **137/137通过**，0失败。其中原80项＋生成34、生成HTTP6、生成SQL仓库15、生成事务集成2。
- 独立严格类型检查：按 README PowerShell 命令枚举本模块 .ts 文件后传给 tsc（Windows 上不依赖 tsc 展开通配符）→ **通过，exit 0**。
- 最近一次全局 `npm run typecheck -- --incremental false` → M05无错误；M06 `authorization-vault.test.ts:65` 的keyring空对象联合类型、`repository-creation.test.ts:65` 缺revokeToken，以及M08 `deepseek-harness.ts:361` 环境对象缺NODE_ENV，共3项外部类型错误。已报告，未越界修改。
- 服务与规则使用注入事实和测试夹具；SQL适配有12项模拟DatabasePort测试，覆盖项目锁初始化、并发顺序、乐观冲突、参数化、幂等隔离、事件/状态/结果同事务、失败回滚、历史保留和事务关闭后禁用。
- 已进行只读模块审核，修复取消任务恢复、锁等待后的服务器时间、正式截止变化遗漏、历史资源下架边界、草案编辑丢失固定依据、历史ID重新加入审核绕过、取消任务藏新引用、旧历史恢复来源与幂等指纹边界。
- 持久回归测试覆盖新引用固定/客户端伪造/改版与锁等待竞态、标题编辑保留pin、显式刷新重大差异、历史风险确认、旧无版本引用/恢复不回填、移除与取消审核绕过、超过50项分批锁顺序、恢复来源幂等隔离，以及最终锁期间manager降级拒绝应用。
- 生成测试覆盖实际transport输入、根输出预算默认、严格模型字段/阶段/缓冲/提交依赖、权限/上下文/任务进度/资源改版、并发worker只一次调用、取消/租约恢复晚结果、bounded timeout+显式attempt上限、供应商失败去敏、手工兜底、人工确认和AI来源/假设恢复。
- 4项测试在全新内存PGlite执行模块迁移：2项生成表约束/保存/重建读取，2项实际两个SQL repository与service组合（测试ALS复用executor+savepoint）。验证queue revision1→running2→succeeded3只产生待确认草案；故障注入最终job UPDATE时，生成草案、outbox、幂等key与状态一起回滚，旧applied手动计划及in_progress证据保留，job单独记录failed。
- 只读审核发现并修复final facts锁等待期间租约过期仍接受结果、固定12000输出token与根默认8192预算冲突；其余审核未发现必修问题。所有协助代理已停止。
- 这些包含隔离本机PGlite实际SQL验证，但不是多连接PostgreSQL锁竞争验收、真实供应商生成或真实队伍试用。

## 未接入

- 实际根迁移执行、PostgreSQL多连接并发、备份恢复演练及真实队伍验收，由主会话负责。
- M02/M03/M04事实聚合与同事务事实锁、M09当前发布行锁、Next.js页面/路由/会话与CSRF组合由主会话负责；本模块不以模拟测试证明这些真实接入成功。
- 本模块已实现模型adapter、持久生成job/worker、超时和显式重试。实际供应商配置/调用、预算ledger、中央队列调度与Next.js路由/前端接线由主会话负责验证；未真实调用DeepSeek或其他provider。手动草案201与真实排队202独立，模型永不直接应用。
- 站内事件派送/风险提醒合并、M03/M04/M06事件消费、跨项目时间冲突、真实队伍估算/缓冲参数校准。
- M06运行与正式提交事实仍由M06唯一所有，M05没有第二份SubmissionRecord，也不把Git保存视为done。

## 集成限制

- 首版少量队伍用每项目JSONB聚合，历史增长会增加整聚合读写成本；应在实际测量后拆表。不可将testing夹具作为真实试用唯一存储。
- helperEfforts按独立工作段消耗每人容量，不提供同步会议/多人同时协作优化；需要同步时必须建立明确约束后再集成。
- M02当前简化窗口不含purpose字段，表示已排除休息的work时间；有效分钟应等于实际窗口长度。部分自报小时不能映射为未知位置的精确容量，要求拆成有效工作窗口。原始offset需在M02 canonical化之前用M05窗口校验检查，不能从已丢失的原值判断矛盾。
- 应用时必须传全部未解决issue代码作为明确确认；applied与feasibility独立，页面应展示evaluation与checkedAt，不把旧快照feasible当实时保证。

## NEEDS_INTERFACE

- 本轮 AI transport 已按根契约固定：`PlanningJsonModelPort.modelVersion` 与 `completeJSON({systemPrompt,input,promptVersion,outputExample?,maxOutputTokens?}, signal)` 返回 `{content,usage|null,requestId|null,modelVersion}`。M05 只做提示、领域校验与草案持久化，不导入server、不负责网络重试或预算ledger；model可由根配置DeepSeek等实现。
- AI公共入口已导出：`createPlanningModelAdapter(model, {maxOutputTokens?}?)`、`createPostgresPlanningGenerationRepository(database)`、`createPlanningGenerationService({planning,repository,access,model,clock,ids,timeoutMs?,maxAttempts?})`。服务提供 `queueGeneration(actor,projectId,command)`、`getGenerationJob(actor,projectId,jobId)`、`listGenerationJobs(actor,projectId,limit?)`、`processGenerationJob(jobId)`、`recoverExpiredGenerationJob(jobId)`、`listQueuedAIJobs(limit)`、`listRunningAIJobs(limit)`；worker方法不作为公共HTTP路由。`createPlanningGenerationHandlers` 提供排队202、活跃项目成员状态查询、原manager本人显式重试和取消（service后两方法第4参为expectedRevision:number）。
- 推荐路由：`POST/GET /projects/:projectId/planning/generation-jobs`；`GET /projects/:projectId/planning/generation-jobs/:jobId`；`POST .../:jobId/retry|cancel`。排队payload：`{goal,instructions?,resourceIds,buffers,expectedTasksRevision,basePlanVersionId,idempotencyKey}`，不接收Actor、模型、事实版本或生成成功状态。资源候选由服务器按已审核公开内容固定；模型只可引用候选exact ID。
- 生成job与计划完成写入需共用DatabasePort事务（根已采用executor复用/保存点）；外层job事务先锁`planning:<projectId>`再读job，完成时嵌套调用PlanningService只创建draft。固定排队时的M02/M03/M04版本、任务基线和资源公开版本；发模型前及保存前复核。model返回不能自动apply，当前计划指针不变。迁移建议为模块`migrations/002-planning-generation.sql`，由根编号并执行。

- M02 可用时间：`MemberAvailability` 为唯一集合事实；M05 导出 `AvailabilityWindow` 与窗口校验函数。M02 在本人权限及 `expectedRevision` 检查后原子更新集合与窗口，读取时提供 `membershipId/version/confirmedAt/windows`；不使用 `effectiveHours` 再加容量。
- 集成层 `PlanningFactsPort.readInput(projectId, now, actor)` 返回活跃/历史项目关系、版本化 M02 窗口、M03 截止与必交项、M04 已确认分工版本和已审核资源 ID；可提供 `resourceContentVersions: Record<resourceId, publicVersion|null>` 与 `projectArchived/projectReadOnly`。权限由 PlanningService 经共享 ProjectAccessPort 检查；actor来自验证会话，该port只接收服务端事实。
- `PlanningFactsPort.lockVersions(projectId, transaction, actor)` 使用同一 SqlExecutor 按 M04 head → M02 context → M03 pointer 顺序保护事实直至提交，返回 `InputVersions`，包括最终加锁项目的归档/只读标记。可组合M02已提供`getPlanningContextForUpdate(executor, projectId, actor.userId)`。例如草案读到窗口 v3，应用时已为 v4，返回冲突并保留成员新时间。成员退出、角色和归档修改也需保护相同事实；主会话的数据库事务组合需要复用传入executor。
- M09 adapter 保留 `getDisplayableApprovedIds(ids, transaction?)` 兼容签名，并实现可选 `getReviewedResources(ids, transaction?) → readonly {id,version}[]` 与 `validateResourceRefs(refs, transaction?) → readonly {resourceId,version}[]`。版本必须来自公开内容而非工作草稿revision；提供SqlExecutor时保护发布行至提交，未知/下架/版本不匹配的新引用返回 `RESOURCE_REFS_UNAVAILABLE` 等错误。M05单批最多50项并先锁全部排序ID。只有旧方法时不虚构新引用固定成功，返回503；没有新资源引用可继续手动工作。
- M06/M07 可通过授权的 `PlanningService.getCurrent/listHistory/listProgress` 读取生效计划与验收事实。Git 保存、运行、赛事提交不互相替代；M05 不生成第二份 SubmissionRecord。
- M02可注入`createMemberAvailabilityValidator(access)`匹配已实现AvailabilityValidationPort；返回窗口revision及并集effectiveMinutes，存储仍由M02负责。M02工作流可组合`createPlanningWorkflowReader(repository).hasConfirmedPlanOrManualTasks(projectId)`，仅在自身项目授权后的服务路径使用。
- 模块已检查最终加锁的归档/只读字段；事实adapter必须提供这些标记，项目/成员修改必须与lockVersions采用兼容锁顺序。缺少真实adapter验收前，不宣称跨模块并发安全已完成验证。

## 所需环境变量

实际 PostgreSQL 连接由主会话管理，预计 `DATABASE_URL`。模型配置、API凭据及AI预算变量由根transport管理；本模块不直接读取这些变量，没有邮件/GitHub凭据依赖。

## 交接状态

本模块代码与验证记录已完成，所有协助代理已停止修改；本会话交付后停止修改，可由主会话开始集成。未接入项仍按上述边界保留，不等同于实际网站贯通或发布就绪。
