# M02 项目与团队交付

状态：本轮团队管理补全已完成，79/79模块测试和独立strict类型检查通过（2026-10-08）。修改范围为 `src/modules/projects/` 与本文。模块会话及本轮子代理均已停止修改，可由主会话接手；新增五个根路由与网页接入仍由主会话完成。

## 已完成

- `index.ts` 公共导出、业务模型、注入 Port、服务端 HTTP handler 工厂和 README。
- 个人/团队项目、显式队伍关联、项目目标/截止/时区的乐观锁编辑、显式阶段变更、选择性复制、项目活动。
- Team captain 与 Project manager 分域，权限只依赖活跃成员；createdBy 不额外授权；退出队伍不连带退出项目，解散保留项目成果。
- 邀请限定范围、角色、有效期、邮箱；随机令牌只持久化摘要，支持撤销、过期、单次消费、重复接受幂等；旧邀请不能恢复离队关系，不暗中提升既有成员角色。
- 最后管理员和最后队长保护；成员退出/移除保留作者历史，并原子写待重分配/复核事实。
- MemberAvailability 集合、子窗口、确认时间及版本唯一存储；绑定 membershipRevision，重入和角色变化需重新确认；本人可加载旧集合版本恢复编辑。
- 项目共享资料只保存审核资源 ID 或成员 HTTP(S) 参考；个人收藏不被读取、不自动共享，移除项目引用不删除来源。
- 参数化 PostgreSQL 仓储、范围锁、嵌套同事务保存点、差异保存、事务活动/事实；模块内 `sql/001-projects.sql` 建表/约束/回滚建议，未执行迁移。
- PostgreSQL `getMembership` 是共享 ProjectAccessPort 实现；额外提供 `getMembershipForUpdate(executor,projectId,userId)` 与 `getPlanningContextForUpdate(executor,projectId,userId)`，供其他模块同事务检查当前成员、锁项目版本及读取历史成员/集合。

## 已验证

首轮 `node --test src/modules/projects/tests/*.test.ts`：48/48 通过（29项服务规则、7项HTTP/令牌安全、12项模拟SQL契约）。主会话后续补到51项；本轮最终结果见文末“团队管理补全”。

已覆盖权限、邀请双用户竞争/重复消费/精确过期/撤销/邮箱身份、离队重入、最后管理员并发退出与降级、旧版本拒绝、持久失败回滚、可用时间冲突/角色失效、复制重置、阶段未接入与不自动成功、资料审核/越权和HTTP安全边界。

PostgreSQL模拟检查覆盖参数绑定、先锁项目再查成员、只保存变更行、Date/JSON/非整数分钟映射、同事务活动与事实、写入事实失败整体回滚、嵌套保存点、外部事务权限与规划上下文、集合/子窗口原子更新。未执行真实SQL迁移或真实数据库并发。

模块独立严格类型检查 exit 0：

```powershell
$projectTypeFiles = @(rg --files src/modules/projects | Where-Object { $_ -like '*.ts' })
node node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module esnext --moduleResolution bundler --allowImportingTsExtensions --skipLibCheck --types node @projectTypeFiles
```

首轮最终 `npm run typecheck`：exit 0。当前正在全模块补全，全局检查的本轮结果见文末；其他模块错误不在M02越界修复。

## 模拟测试边界

服务测试只使用 `tests/memory-repository.ts` 事务夹具与注入的假身份/窗口/提交/资源 Port。PostgreSQL 适配检查使用 SqlExecutor 模拟，不代表真实 PostgreSQL 锁、迁移、约束或外部接入已验收。

## 首版规则选择

邀请默认72小时，最长30天；未知赛事人数限制不被当硬性禁入。归档项目仍保留至少一位活跃管理员，避免无法恢复。窗口集合存当前快照，M05 的计划持有历史输入快照；outbox ack 为全局确认，需统一 dispatcher 完成所有下游幂等处理后再确认。

项目初选 eventId 不开放独立PATCH修改，权威赛事关联及规则指针归 M03；成员手填 deadline 标为 member_entered，不能代替官方条款截止。

一次角色更新可能在同一Project.revision产生多种事实；dispatcher以eventId去重并核对版本，不能只按project revision相同丢弃第二条。

## NEEDS_INTERFACE

实现采用 `src/modules/projects/ports.ts` 的注入 Port，均不直接读写其他模块私有表。

| 所有者 | 方法与字段 | 权限与行为示例 |
| --- | --- | --- |
| M01 | `VerifiedIdentityPort.getVerifiedEmail(userId): Promise<string \| null>` | userId 来自已验证 Actor；限定邮箱邀请只能由对应已验证邮箱接受。未接入时限定邮箱邀请接受返回 503，不接受请求 JSON 邮箱。 |
| M05 | `AvailabilityValidationPort.validate({projectId,userId,timezone,windows,nextRevision,previous})` → `{windows,effectiveMinutes}`；窗口输入 `id,startsAt,endsAt,effectiveMinutes`，输出增加 `revision` | M02 在项目锁内校验本人活跃身份、expectedRevision，调用校验后同事务写一次集合。无此接口返回 503；M02 不自行重复计算容量。窗口校验应为本地确定性规则，不能开启另一份独立窗口存储事务。 |
| M05/M06 | `ProjectWorkflowPort.hasConfirmedPlanOrManualTasks(projectId)` / `hasSubmissionRecord(projectId)` → boolean | 进入 active 需要 M05 已确认计划或手动任务；submitted 需要 M06 的实际提交记录。阶段不建立第二份提交成功事实。未注入时相关阶段变更返回 503。 |
| M09 | `ReviewedResourcePort.getReviewedResource(resourceId,transaction?,expectedVersion?)` → `{id,title,version} \| null`；`ProjectsService.addReviewedResource(actor,input)` | 在M02项目锁内锁M09发布行，校验当前审核版本；共享资料持久化resourceVersion，按项目+resource幂等合并。手动HTTP(S) URL无资源版本，仍是未核验参考；个人收藏不会被自动公开。 |
| M03 | `getProjectRules(actor,projectId)`（由M03提供）；M02 PostgreSQL类提供 `getMembershipForUpdate(executor,projectId,userId)` | 项目manager确认规则时在同一SqlExecutor锁Project，与离队/降级串行。赛事关联/规则生效指针归M03；M02创建时eventId只是未确认初选且不开放PATCH，界面/规划读M03已确认指针，不能把M02手填deadline当核验截止。 |
| M03（可选） | `ProjectAdmissionPort.check({actor,project,activeUserIds,invitation})` | 在项目锁内依据已核验赛事资格/名额检查，未知限制不被当作硬性人数常数。 |
| 主会话/M04/M05 | `ProjectsRepository.listPendingFacts(limit)` / `acknowledgeFact(eventId)` | 与成员/可用时间更新同事务保存 `ProjectMemberJoined/ProjectMemberLeft/MemberAvailabilityChanged/ProjectMemberRoleChanged/ProjectScopeChanged`，包含 eventId、projectId、actorId、version、occurredAt、差异 ID。需幂等消费，离队后标未完任务待重分配和计划待复核，完成成果保留。角色改变使时间确认失效时同时发 `MemberAvailabilityChanged`（collection revision不变，membership revision改变，confirmationRequired=true）；消费者不能只按collection revision跳过。 |

`ProjectAccessPort` 由 PostgreSQL 仓储的 `getMembership(projectId,userId)` 实现；调用方必须检查 `status === 'active'` 与所需角色。项目 `createdBy` 和 Team captain 不额外授权。

## 未接入

主会话已在 `src/server/` 组合本机持久化PGlite、pg连接模式、实际迁移、会话/CSRF路由及M05/M06/M09 Port，见下文主会话验收记录。邀请链接由调用者复制；M02不发送邮件。

本轮模块PGlite实际SQL约束/回滚与根层既有事实测试分别记录；独立PostgreSQL多连接竞争、统一dispatcher全消费者投递及真实小队创建/邀请/退出/恢复贯通仍需集成验收。阶段不会代写M06提交记录，原始测评与仓库授权不会被复制或扩权。

## 所需环境变量

`DATABASE_URL`（由主会话真实连接池读取）；M02本身不直接读取环境变量，无邮件、模型或GitHub凭据需求。本文与代码不包含任何环境变量值。

## 主会话验收修复（2026-10-08）

主会话确认原模块会话 idle 后接管了 M02，以下为集成验收追加，未改写原始 48 项模拟验证结论。

- HTTP 超限流读取不等待 transport.cancel 完成，立即返回 413。新增取消 Promise 永不结束的回归，保证不调用业务写入。
- M02 在调用 M05 前保留用户原始 offset-bearing 字符串，先核对 IANA 时区，再转 UTC 保存。Asia/Shanghai +07:00 输入拒绝且回滚；+08:00 输入保存规范 UTC。
- 项目资源新增 `resourceVersion`、SQL `resource_version`，审核 ID 必须有正整数版本，成员 URL 必须无版本。受控 M09 分享方法重查审核事实、版本与活跃成员，忽略外部名称/URL，按项目+资源合并；Postgres withProject 提供事务内 SqlExecutor，发布行与项目在同一连接中保持锁。
- 模块 `node scripts/run-module-tests.mjs projects`：51/51 通过。新增根层 `node --test src/server/facts.test.ts`：5/5 真实 PGlite 内存引擎通过，覆盖统一迁移、同连接锁序、原始时区、M09分享版本、确认规则版本、八类复盘证据的项目/版本/隐私边界与M07最终事实复查。

PGlite验证使用真实PostgreSQL引擎语义，但未替代独立PostgreSQL多连接竞争、真实邮件、模型或GitHub服务验收。根层实际新增字段迁移由主会话独占管理；模块SQL只是提案。`src/server/facts.ts` 提供 M04/M05/M06/M07 统一事实适配，要求所有仓储共享支持 AsyncLocalStorage 当前事务复用的 DatabasePort；外部配置及端到端浏览器验收仍由主会话负责。

`finalFactsLock.lock(request,executor)` 专供M07最终确认/复用/生成落盘前调用，始终只使用传入executor。先取得与M05相同的排序规划协调advisory锁，再按M04 head→M02项目/当前成员→M03确认指针→证据及M09发布行取锁，持续至外层提交；不调用嵌套transaction、模型/网络或写M07文档。匿名/停用身份拒绝，已移除成员、归档、最新提交撤回和资源下架都从当前数据库投影；证据只返回元数据，JSONB属性顺序不导致分工误判过期。PGlite集成测试验证这些新鲜度边界及没有额外嵌套事务。

## 团队管理补全（2026-10-08）

### 已完成

- 只读核验根 router：原有团队创建/列表/详情/改名/解散、成员升降级/移除、本人退出、邀请创建/列表/撤销/接受已映射。没有修改根 router、应用、组件、共享契约或实际迁移。
- `getTeam` 现在返回 `{team,membership,members,projects}`。当前网页读取 `membership.role` 判断队长，此返回值补齐了实际接入缺口；projects 仍只含本人有活跃项目成员关系的关联项目。
- 新增 `transferTeamCaptain(actor,teamId,{expectedRevision,targetUserId})` 与 `transferProjectManagement(actor,projectId,{expectedRevision,targetUserId})`。目标先升管理角色、操作者降member，范围版本一次，成员版本仅对实际角色变更者增加；其他管理者不变，交接后操作者仍是活跃成员，不自动退出。
- 项目交接允许归档项目，保留stage、历史活动/事实、成员作者、共享资料与可用时间集合。变化角色各有 `ProjectMemberRoleChanged`，已有时间集合各有 `MemberAvailabilityChanged` 需重新确认；另记 `project_management_transferred` 活动。队伍交接只允许活跃队伍，不扩大项目权限。
- 新增 `previewInvitation(actor,token)`，登录后只读且不消费邀请。限定邮箱先核对已验证身份；只输出最小preview DTO，不含邮箱、token/hash、创建者/接受者、成员名单、项目目标或原始报告。失效/撤销/已被其他人接受、原接受者已离队均拒绝。正式接受继续重查当前资格与到期时间。
- 新增 `getProjectMembers/getTeamMembers(actor,scopeId,includeHistory=false)`，只授权本范围活跃成员。默认活跃成员，`history=true` 包含当前left/removed关系快照；这不是完整团队审计时间线，不含邮箱或私人资料。
- 不需新增SQL字段或实际迁移；现有规范化成员表、项目活动/事实与延迟约束承载上述行为。

### NEEDS_INTERFACE：主会话根路由与前端

新增公开导出沿用 `index.ts`。下列五个descriptor已实现，**根 router 尚需由主会话映射**：

| 方法与路径 | 精确descriptor | 请求 | `data` |
| --- | --- | --- | --- |
| GET `/api/v1/invitations/{token}` | `{kind:'invitationPreview',token}` | 无JSON；需登录 | `{scopeType,scopeId,scopeName,requestedRole,currentRole,expiresAt,alreadyMember,alreadyAccepted}` |
| GET `/api/v1/projects/{projectId}/members` | `{kind:'projectMembers',projectId}` | `?history=true`可选，仅true/false有效 | `{membership,projectRevision,members}` |
| POST `/api/v1/projects/{projectId}/management-transfer` | `{kind:'projectManagementTransfer',projectId}` | `{expectedRevision,targetUserId}` | `{projectRevision,previousManager,targetManager,availabilityConfirmationRequiredUserIds,otherManagersUnchanged:true}` |
| GET `/api/v1/teams/{teamId}/members` | `{kind:'teamMembers',teamId}` | `?history=true`可选，仅true/false有效 | `{membership,teamRevision,members}` |
| POST `/api/v1/teams/{teamId}/captain-transfer` | `{kind:'teamCaptainTransfer',teamId}` | `{expectedRevision,targetUserId}` | `{teamRevision,previousCaptain,targetCaptain,projectMembershipsUnchanged:true}` |

转交要求Actor是本范围活跃manager/captain，目标是同范围另一位活跃成员；目标已有管理角色时仍可交接。`previousManager/previousCaptain` 是交接后的member关系。使用一次POST，不串联两次PATCH；成功后重载详情和成员名单，旧管理者按钮随membership.role隐藏。交接不自动离开，退出再用本人的 `/leave` 与最新范围revision。最后项目manager不可退出/移除/降级（包含归档）；最后活跃captain需交接或解散后才能离开。

完整既有团队HTTP和payload见模块 README 的“团队管理请求与响应”。特别注意：DELETE队伍是解散且保留项目；DELETE成员/邀请也带JSON `{expectedRevision}`。根实际阶段路径为 `/projects/{id}/stage`，README已同步。

前端接入说明：

1. 团队详情用新返回的 `membership.role/status`，展示 `projects` 中本人有权访问的项目。队伍解散后仍提供本人退出；改名、邀请、角色编辑和交接禁用。
2. 邀请页先读preview，显示team/project范围、名称、到期和实际/请求角色；明确接受才POST `/invitations/{token}/accept`。接受响应 `{scopeType,scopeId,membership,revision,alreadyAccepted}`，team跳 `/app/teams/{scopeId}`，project跳 `/app/projects/{scopeId}`，避免一律跳项目列表。已是活跃成员时以currentRole为实际角色，不能宣称邀请自动升权。
3. 项目成员页接现有 `projectMember` DELETE、`projectLeave` POST、`projectInvitation` DELETE、`projectTeam` PUT；队伍关联payload `{expectedRevision,teamId,confirmNoAutomaticMembers:true}`。项目manager和teamcaptain按钮按各自membership判断。
4. 409 VERSION_CONFLICT 返回latestRevision，加载最新内容后让用户重新确认，不用旧输入自动覆盖。邮箱不匹配、过期、撤销等preview失败不得显示前一次缓存的名称/角色；邀请页及链接保持no-store/no-referrer，不记录原始token。

可选M01展示接口：若需要真实姓名而非userId，请由主会话协调 `getMemberDisplayNames(actor,{scopeType,scopeId,userIds}) -> [{userId,displayName}]`，限已授权范围成员与最小展示字段，禁止返回邮箱、会话或报告；M02当前不读取账号私表、不推测身份。

### 已验证与边界

最终 `node --test src/modules/projects/tests/*.test.ts`：79/79通过（31服务、8原有HTTP/令牌安全、12模拟SQL、21新增团队HTTP、7新增PGlite实际SQL）。模块独立strict TypeScript检查exit0。新增用例覆盖当前成员身份、成员历史权限、最小邀请预览/邮箱隐私/有效期/撤销/重放、原子交接/旧版本/并发交接与退出/提交失败回滚、两人角色和可用时间事实同Project.revision、归档交接及历史保留。

`tests/team-postgres.test.ts`在内存PGlite实际执行模块当前完整SQL提案并调用公开service/repository：真实建表/延迟约束、团队CRUD/邀请/成员/退出、两个范围原子交接、旧版本/越权拒绝、第二次角色UPDATE成功后注入失败的整体回滚、归档交接/历史和解散保留项目。

这些SQL测试不修改生产数据库或根实际迁移、不导入server私有文件。PGlite只有单连接；独立PostgreSQL多连接锁竞争仍未验证。`team-http.test.ts`使用真实Request/Response与handler/service、事务内存夹具，覆盖HTTP边界；它不证明根router已新增上述路径或浏览器已贯通。

当前全局 `npm run typecheck` 失败点在其他模块：M06 `authorization-vault.ts/repository-creation.ts` 的String.isWellFormed库版本，M08 `deepseek-harness.ts` 的ProcessEnv缺NODE_ENV，M10 `bridge.ts` 两个隐式any参数。未越界修改；M02独立strict检查通过。全局结果随其他会话变化，主会话应在集成收口时复查。
