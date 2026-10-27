# R02 团队任务与动态

以同一份 M05 任务和验收事实组织团队协作：草案领取后保留负责人、管理员核对确认后生效；交出成果进入待检查，实际检查通过才点亮。团队建议只有本人明确共享后可见，不建立聊天群或第二任务状态。

## 组合入口

服务端从 `index.ts` 导入 `TeamCollaborationService`、`PostgresTeamCollaborationRepository`、`createTeamCollaborationHandlers` 与公开类型；客户端从 `ui.ts` 导入 `TeamFeed`、`ShareSuggestionPreview`。任务板继续使用 `src/components/team-task-board.tsx` 的 `TeamTaskBoard({detail,current,onSnapshot})`。

```ts
const collaboration = new TeamCollaborationService({
  repository: new PostgresTeamCollaborationRepository(database),
  access, sources, activities, clock, ids,
});
```

- `access.lockAccess(projectId,actor,sql)` 必须以事务内当前会话、账号、M02 活跃成员和项目归档/只读事实授权，锁到事务结束。管理员来源是 membership.role。
- `sources.verifySource({projectId,actor,ownerUserId,source},sql)` 校验真实保存的本人回答/报告，返回来源标签、revision/kind/ID 元数据。写入的 ownerUserId 固定当前 actor；读已有分享的 ownerUserId 固定存储作者，不能当任意私人记录读取接口。根复核当前授权、来源归属、保存成功、撤回/失效及项目范围，保护来源行到提交。人工卡 manual/null 仍复核作者可共享权限，标签固定“成员备注”。
- `activities.readActivities(projectId,actor,sql,limit)` 是 M05 只读进度投影，`checked` 必须依据当前仍有效的真实检查，不以历史完成自报或 AI 建议推断。模块仅排序合并。
- 所有 Port 必须复用传入 SQL executor。通过根已有环境上下文复用 executor 可以嵌套保存点；禁止另借数据库连接造成权限快照与写入分离。

完整跨模块行为和根端点签名见 `docs/协作/交付/team-collaboration.md` 的 NEEDS_INTERFACE。

## 共享规则

`publish` 仅保存本人明确编辑共享的 title/body，不读取或扩散私人回答全文。来源统一 `navigator / space_assistant / feasibility / manual`；AI 来源必须有实际保存的 sourceId，客户端标签不可信。正文最多6000字、标题120字，HTTP流式请求上限32KiB。

`edit / withdraw / adopt` 要求 expectedRevision 和 idempotencyKey。只有作者编辑/撤回，只有当前管理员采纳。编辑已采纳建议使其回到待讨论并清空采纳人/时间，旧版本和审计仍保存；修改建议不会自动修改目标、职责或计划。

撤回清空当前共享正文，仅返回无正文墓碑。来源失效/撤回/版本改变时同样屏蔽正文；本人仍可撤回失效分享。`listSharedContext` 完全排除墓碑和源全文，默认最多10条、上限20条且JSON总量不超过32KiB；根模型组合仍按问题和预算进一步选择。

每个项目串行锁控制建议写入和首次初始化；读取用独立只读事务，不获取feed写头锁，当前M02与来源guard先保护快照，避免从空间AI上下文组合时出现反向锁顺序。只读事务拒绝保存。CAS防止覆盖。幂等以 project+actor+action+suggestion+key 作用域和SHA256内容指纹持久保存，只返回无正文回执。网络结果未知重试原请求；同key改内容拒绝。重放时重新验证当前权限并返回最新状态，因此旧发布请求不能恢复已撤回正文。

## 持久化与升级

`migrations/001-team-collaboration.sql` 是模块内建议，根复制到下一个递增迁移后执行。包含共享建议、不可变版本、元数据审计和幂等回执，不写M02/M05表。当前版本正文撤回清空；历史共享快照只作服务器内部审计，没有公共读取入口，也不进入模型上下文。根保持实际备份、保留策略和账号注销清理。已有迁移不改写；模块内建议不是已经应用的迁移。

模块不直接读取环境变量，不调用收费模型、邮件或GitHub。根持久连接继续沿用 `DATABASE_URL` 或本机单例PGlite配置；不打开生产目录，不把测试内存仓储用于试用。

## 验证

Node内置测试：

```powershell
node --experimental-strip-types --test src/modules/team-collaboration/*.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

权限/CAS/并发/来源失效/幂等使用注入隔离服务夹具；Postgres适配测试仅创建隔离内存PGlite schema，证明参数化存储、JSONB属性顺序不造成冲突、版本/审计和回滚。HTTP验证可信会话、CSRF入口、严格字段、正文上限和回执恢复。它们不替代真正多连接PostgreSQL并发、真实浏览器、模型质量或主办方提交验收。

本轮模块36项、既有M05任务规则15项通过，全局无写入TypeScript检查通过；Edge内存假API界面验证覆盖375px、未知响应恢复、预览后明确分享、账号切换/撤权与轮询。具体模拟及未验收边界见交付说明，真实键盘选区/实体手机选择仍需根实际页面复核。

## Constitution Check

I/IV/X：任务体验复用M05、依赖和真实验收，草案/开始/检查/提交分开；等待可并行、详细说明按需展开。VI：成员/来源事务权限复核、本人明确共享、撤回屏蔽。VII/VIII：独立Port、持久SQL和有意义隔离测试。IX：可见轮询仅读取，未知写入保存原key恢复；不因读页面触发费用。II/III/V：本模块不新增赛事结论、评分或仓库写入，保留来源和任务实际检查边界。
