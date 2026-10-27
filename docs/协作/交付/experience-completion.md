# C05 · 个人经验与复盘自动草稿补全

状态：已完成并交还，2026-10-10。仅修改 M07、retrospective-client.tsx、experience-client.tsx 和本交付；本会话及内部代理交付后停止编辑，不沿用临时授权。

## NEEDS_INTERFACE

- 根挂 `/app/experience`，渲染 `PersonalExperiencePanel`（`src/components/experience-client.tsx`）。全账号页面只列本人私人经验、私人复盘和复用草案；项目共享记录仍走已有项目权限入口。可在离队后按来源项目标识筛选本人记录，不能用此入口读取原项目事实或他人记录。
- `createRetrospectiveHandlers` 已追加 `listPersonalExperienceCards`、`listPersonalRetrospectives`、`listReuseDrafts`、`getPersonalReuseDraft`；建议 GET `/experience-cards`、GET `/retrospectives`、GET `/experience-reuses`，以及 GET `/projects/:projectId/experience-reuses`。草案找回只给作者元数据，无法访问来源时正文为空并标明原因；DELETE `/experience-reuses/:id` 复用现有 `deletePersonal`。GET `/experience-cards/:id/history?revision=…` 复用现有 `historyVersion`。原严格 getReuseDraft 保持兼容。
- 自动草稿已提供独立 `RetrospectiveEditDraftService`、PostgreSQL 仓储与 HTTP 工厂，模块内增量 SQL 仅为建议，实际递增迁移由根执行。草稿固定本人私有，`requestedScope` 仅保存意图；不会写已共享复盘、确认事件、AI 队列、交付状态。使用现有 `FinalFactsLockPort` 锁所属项目当前成员/归档根，同一 SQL 事务复核。离队或归档后禁止新写，但已有本人草稿仍可读取、导出、删除。
- 绑定既有复盘使用 `PostgresOwnerRetrospectivePort(database)`（已从 index 导出）或注入 `OwnerRetrospectivePort.readIdentity({actor,projectId,documentId},sql?)`，仅 SELECT 本人正式复盘 id/projectId/ownerId/revision，写入时使用提供的同一 SQL executor `FOR UPDATE`。不读取队友记录或源事实，正式保存/分享仍用原 M07 接口。
- M06 materials/交付事实仍由 C04/root 的现有 `DeliveryFactsPort` 只读提供，C05 不建第二份成功状态。
- 追加技能经验 DTO：RetrospectiveContent/ExperienceContent 可选 `skillUsage?:{reference:FixedSkillReference,purpose:string,feedback:string,limitations:string}[]`（max12、文字各2000）。`FixedSkillReference` 类型来自 M10 public index，M07 仅保留精确历史 kind/id/version/versionId/contentHash/revision 与成员自报文字，不新增当前发布、安装或兼容事实。`ReusableField` 新增 skillUsage，具体复制预览与 requiredRechecks 要重核当前版本可获取性、客户端/环境、许可、学习时间和赛事允许范围；不会安装。
- `parseSkillUsage` 是 browser-safe M07 parser，type-only 引用 M10 public index、结构校验与其 public parseFixedSkillReference 做20样本 parity 测试。M10 public index 及 project-selection 的 runtime 引入 node:crypto，现有 M07 validation 被浏览器调用，故避免 runtime 跨入该服务入口；没有修改 M10。

## 已完成

- `listPersonalRecords` 本人私人经验/复盘按项目、可见文字和状态筛选，bounded search/cursor；SQL personalOnly 防止 former project 筛选带出他人项目记录。撤权前后都复核证据权限，隐藏正文不会进入搜索。
- 本人历史读取、脱敏文本导出、删除、条件与字段具体预览；复用草案账户列表、安全元数据找回与删除。原严格复用 getter 保持兼容。
- `PersonalExperiencePanel`（experience-client.tsx）账户组件含经验、私人复盘、复用草案、自动编辑草稿四入口。项目经验面板新增历史和私人删除，项目可访问时可回项目编辑。
- 自动草稿后端独立私有输入、SQL CAS、persistent mutation receipt、正式版本身份锁、权限/归档停写；不调用模型、不写确认事件或交付事实。增量 SQL 位于模块 `migrations/002_edit_drafts.sql`，旧 Retrospective 正式完整回答/分享/确认语义保留。
- 800ms debounce 控制器、晚到响应保护、序列写、失败保留输入、未知结果同 key 原 payload 恢复、明确冲突对照、撤权停写及 dispose。
- UI 已组合私有草稿恢复、保存状态、正式/私有版本对照、显式采用或保留输入、失效登录停写和未知结果同 key 恢复。正式保存与确认使用实际返回 revision 更新缓冲基线；晚到读取/响应不能覆盖当前输入。
- 可选技能反馈已接入复盘与经验编辑、账号查看、历史、自动编辑草稿、脱敏 JSON/Markdown 导出和字段具体预览。固定历史引用不会因为目录撤回而重写；只保留本人用途、反馈、限制，不查安装状态、不建第二套兼容或成功事实。
- 历史/当前正文在资源、证据和源复盘异步读取后复核当前共享指针、成员与证据；撤回或撤权正文不得透过账户列表、历史或导出重新打开。账号筛选/切页/退出登录时使旧选中读取失效。
- 主会话已在根源码组合 `/app/experience`、原经验 history/草案列表与自动草稿 routes/service，并将建议 SQL 复制为 `migrations/037_retrospective_edit_drafts.sql`（只读源码确认）；真实迁移、重启和浏览器结果仍由主会话验收。

## 已验证 / 模拟测试

- 最终 `npm test -- retrospectives`：183/183 通过，0 fail/skip。包括自动草稿 14 个内存 PGlite SQL 测试、8 个 HTTP 边界、17 个控制器测试、owner identity 投影、本人筛选跨页、共享/证据撤回期间读取、技能反馈历史/导出/复用及与 M10 引用合同一致性。
- 内存 PGlite 使用临时 memory engine，只执行模块 SQL fixture，不读 .env/生产目录，验证 SQL 约束/事务/CAS；既有普通 Port 测试为模拟依赖。没有实际迁移、付费模型或生产数据库操作。
- 最终 `npm run typecheck`：全仓通过。前一轮根集成测试的 TaskProposal 导入错误随后已由其它负责会话修复；本会话未修改根测试或 M05。

## 根验收边界

根页面、路由、服务及 037 迁移源码已存在；源码存在不代表已部署。真实递增迁移执行、构建/重启、远程 PostgreSQL 多连接并发以及浏览器手机/键盘/断网恢复验收由主会话负责。本会话未运行 build/start、生产 DB、真实迁移、付费模型或外部服务。未新增实际安装、技能兼容或交付成功声明。

删除本人私人记录会删除该记录及全部不可变历史；不提供删除单个历史快照来改写既有版本。自动草稿删除保留防重放的 hash/身份回执，无正文；M01 完全注销账号时须按 owner 清除 drafts/roots/receipts 元数据。

## 环境变量

本模块不新增环境变量；数据库连接由根现有 `DATABASE_URL` 或 PGlite 配置提供，不读取或输出凭据。
