# AI 技能与资源包

目录按“正在使用的 AI 工具”和“想完成的任务”筛选；作品方向是资源分类，与主办方的官方赛道分别说明。`catalog-view.ts` 提供浏览器可用的筛选上下文读写与固定版本筛选，不引入安装执行或 Node 加密代码。

公开结果只包含已发布且具有所选工具路径/格式依据的版本。这些依据仍是安装器声明，客户端版本与任务效果尚未实测。创建、确认及桥接授权时都重新核对固定版本的工具声明、发布状态、完整文件和许可；不会替用户改选另一个版本。

详情保留工具、任务、方向及关键词查询参数；从资源包进入技能详情额外携带 `versionId`，该参数不是目录筛选。固定版本不可用时，页面要求用户明确重选。前置条件、完整 commit、许可、写入目录与兼容限制直接可见，教程、文件明细与哈希可展开。

复制启动命令只记录在当前网页内存；服务器计划、文件写入回执、本人加载报告和本人示例任务报告分别保存，任一状态均不推定下一状态。桥接安装只处理明确授权的项目目录、精确文件清单与未修改的自有文件；本轮没有新增实际安装、客户端实测或外部账号接入。

安装器与历史记录按可信账号 ID 挂载，账号变更时卸载旧表单、口令、凭证和回执。窗口重新获得焦点及安装/确认/验证/撤销动作前读取当前身份；计划响应必须属于当前账号。本轮组件生命周期与账号切换浏览器流程仍需根集成验收，服务权限测试不能代替这一项。

验证命令：

```powershell
node --experimental-strip-types --test src/modules/skills/catalog-view.test.ts src/modules/skills/skills.test.ts
```

测试使用独立内存 PGlite、临时目录与无害文件夹具，不读取正在运行的数据库或服务凭据。临时文件桥接行为不等于真实 AI 客户端加载与示例任务验收。

## 固定版本运营审核

`createSkillCandidateService` 持久保存一个技能或一个包的确切候选、内容修订历史和许可/行为/兼容证据。技能只允许当前两个官方仓库 `anthropics/skills`、`github/awesome-copilot`；完整 commit、原始路径、逐文件 SHA256/大小、许可与通知均沿用现有清单校验。录入是结构化元数据操作，不获取候选链接或执行脚本。未知许可和未审阅行为可以保存草稿，不能发布。

M08 独立公共入口 `../operations/skill-review.ts` 保存审核和审计，通过 `createSkillPublicationPort` 在同一 SQL 事务内按 `kind/id/versionId/revision/contentHash/manifestHash` 发布或撤回。已发布/撤回固定版本不能编辑或用旧审核恢复；新技能 commit 合并为新版本，新包存为 `bundleId@version`，旧行与旧项目引用保留。兼容证据记录各阶段与真实环境，不把模型或用户自报升级为平台实测。发布目录仍保留原有 `not_tested`/`not_live_tested` 声明，附加 `compatibilityEvidence` 供详情展示。

根应将 `candidate-schema.sql` 和 M08 `skill-review.sql` 接入新的递增迁移，不重写已应用文件；可在已初始化目录后调用 `importPublishedSkillCandidates` 保留初始精选的运营快照，重复执行不恢复撤回版本。初始化导入不伪造本轮行为审核或客户端测试。发布/撤回变化不递增内容修订，草稿内容修改才递增；M08 审核本身有独立 revision。

根必须向候选服务/M08 审核服务注入事务内 `assertActorCurrent`，并向 HTTP 工厂提供真实会话与 mutation/Origin hook。`createSkillCandidateHandlers` 提供 list/detail/save，M08 提供 list/detail/register/decide/publish/withdraw；管理员浏览器组件从 `ui.ts` 导入 `SkillReviewPanel`，避免把服务器代码带入浏览器。

## 可选项目与任务引用

`createReviewedSkillLookupPort` 返回固定版本引用和兼容证据；`parseTaskSkillReferences`/`TASK_SKILL_REFS_JSON_SCHEMA` 定义可选 M05 `Task.skillRefs`。没有该字段或空列表的旧任务仍合法；引用独立于 Resource。用途、环境、学习分钟不能携带本机路径/凭据。学习、配置、试用和排错计入任务原有工时，根可以用 `assertTaskSkillLearningIncluded(refs, task.durationEstimate.likelyMinutes)` 复核，不能增加第二套容量。

`createProjectSkillSelectionService` 注入 M02/root 所有的 `ProjectSkillSelectionPort`，只读当前活跃成员可访问空间，修改要求活跃管理员且空间可写。选择/清除用 revision CAS，清除保留墓碑。根需让选择存储、当前会话/成员、项目与已审核技能查询复用同一事务 executor 并持锁至提交；本模块不直接写 Project/Task 表。`project-selection-schema.sql` 仅为根/M02 选择存储建议。

追加授权提供 `src/server/project-skills.ts` 根适配及 `src/server/project-skills.sql` 真实外键/不可变历史 SQL；应使用该根 SQL，不同时执行通用选择表建议。适配通过 `withRequest` 和包装好的 handlers 复用请求事务，当前账号/session、M04 heads、M02 项目/成员、选择与 M10 查询共同持锁；缺失当前请求作用域会拒绝私有服务操作。根客户端包装层 `ProjectSkillSelectionClient`、`SkillsAdministrationClient` 绑定实际 HTTP API 并在账号变化时卸载旧稿。路由、迁移和运行服务的最终接入由主会话负责。

客户端从 `ui.ts` 导入 `ProjectSkillSelection`，以可信账号与项目为 key 卸载旧稿。复制选择与 `createSkillReuseSnapshot` 不生成安装计划或回执；`validateSkillUseFeedback` 用于当前合法引用的本人反馈，`parseSkillUseFeedback` 可解析历史反馈，但 M07/root 必须先对照本人可读的已保存项目/任务引用，不能用它采纳未知或撤回的新依赖。反馈始终 `user_reported`，不推定客户端加载或作品验收。

```powershell
node --experimental-strip-types --test src/modules/skills/catalog-view.test.ts src/modules/skills/skills.test.ts src/modules/skills/publication.test.ts src/modules/skills/project-selection.test.ts src/modules/operations/skill-review-service.test.ts src/modules/operations/skill-review-handlers.test.ts
```

详细接线与真实验证边界见 `docs/协作/交付/skills-completion.md`。八客户端真实安装/加载/示例仍需各目标环境，目录夹具通过不代表 K5 实测完成。
