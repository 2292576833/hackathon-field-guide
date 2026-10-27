# 技能/包固定版本审核

独立入口 `skill-review.ts` 提供 types、PostgreSQL repository、service 与 HTTP factories；不修改既有来源 worker、event/resource service 或 index。M08拥有审核和审计，M10 `SkillPublicationPort` 使用同一SqlExecutor拥有内容发布/撤回。

根必须接真实 `assertActorCurrent(tx,actor,requestId)` 事务内当前会话/角色校验、HTTP mutation/Origin hook，并将 `skill-review.sql` 放进 M10候选表之后的新递增迁移。审核精确绑定 kind/id/versionId/candidateRevision/contentHash/manifestHash，兼容未知需确认，任何确认不会升级证据。

接线/DTO、模拟与外部验收边界见 `docs/协作/交付/skills-completion.md`。本模块无网络、模型、本机安装或新环境变量。

```powershell
node --experimental-strip-types --test src/modules/operations/skill-review-service.test.ts src/modules/operations/skill-review-handlers.test.ts
```
