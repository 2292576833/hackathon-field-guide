# C06 M10 技能审核发布与项目沉淀

日期：2026-10-10。C06 代码交付，范围为 M10、新增 M08 skill-review 文件及本文；主会话后续追加授权新增 `src/server/project-skills.ts/.test.ts/.sql`、`src/components/project-skill-selection.tsx`、`src/components/skills-admin.tsx`。不执行真实迁移、服务重启、网络/模型或用户目录安装。最终交还以本会话结尾为准。

最终状态：内部实现、测试和只读审查代理均已停止；C06 授权文件全部交还主会话，不沿用本轮临时授权继续编辑。

## NEEDS_INTERFACE（先行登记）

- M08 新增独立 SkillReviewService，通过 M10 `SkillPublicationPort` 使用同一 SqlExecutor，按 `{kind,id,versionId,expectedRevision,expectedContentHash,expectedManifestHash}` 审核、发布或撤回。根实例化两侧 factory，接管理员页面与 HTTP 工厂。不得使用独立提交的远程 adapter。
- M02 所有 `ProjectSkillSelectionPort`：根提供持久选择容器、当前项目状态、事务内权限/CAS；M10 只校验与呈现，不写 project/planning 表。活跃成员可读、活跃管理员可写、归档禁止写。选择固定 skillVersion 或 bundleVersion、用途、学习分钟、环境；没有绝对路径或密钥，不自动安装。
- M05 可选 `Task.skillRefs`：缺省/空列表合法，固定引用独立于 Resource；采用 M10 ReviewedSkillLookupPort 及 schema/验证 helper。学习/配置分钟作为实际任务估计的一部分，不另造容量。根增加最小 DTO 并在采用/确认时服务器校验固定引用。
- M07 选择性复制固定引用和明确标记的本人使用反馈；复制/复用不产生安装计划、回执或兼容通过状态。根组合当前授权读取与持久事实。

### M10 固定内容与审核端口

公开服务器入口 `src/modules/skills/index.ts`：

- `createSkillCandidateService({database,clock,ids,assertActorCurrent})`：`list(actor)`、`get(actor,target)`、`save(actor,{expectedRevision,document,evidence})`。新候选 expectedRevision=0，草稿更新使用当前修订；已发布/撤回不可编辑。每候选只含一个 SkillVersion 或一个包版本。
- `SkillPublicationTarget={kind:'skill'|'bundle',id,versionId}`。技能 versionId 为 `skillId@40位commit`，包 versionId 为 `bundleId@version`。`contentHash` 是候选正文与证据的 canonical SHA256；`manifestHash` 是固定文件/许可或包内固定项与服务器锁定子项文件/许可 hash。它们不同于 SkillVersion 自身的文件 `contentHash`。
- `createSkillPublicationPort()` 的 `readForReview(tx,target)`、`publishReviewed(tx,input)`、`withdraw(tx,input)` 使用 M08 提供的同一 SqlExecutor。input 是 target 加 `actor/expectedRevision/expectedContentHash/expectedManifestHash/reviewOperationId/reviewedBy/reviewedAt/reason/requestId`。这些是受信审核调用，不开放成任意公开发布 API。
- 发布与撤回只改变 state，不递增内容 revision；修改草稿才递增。技能的新 commit 追加到原 Skill，旧版本留存。新包以 `id=bundleId@version` 的固定目录行发布并附 `bundleId/versionId`，旧初始行保持原 id；既有计划/项目不会改选最新包。
- 包候选要求必需与可选项的每个固定 SkillVersion 已发布，按同一 skillId 排除多个 commit，保存子项文件和许可 hash。许可核验 sha256 用 `bundleLicenseReviewHash(versions)` 汇总全部必需/可选项许可。发布再次复核，不把不同环境的单项成功拼为整包通过。
- `importPublishedSkillCandidates({database,clock,ids})` 可在根启动初始化目录后执行，幂等导入旧精选快照供运营读取/撤回。初始 behavior=unknown，compatibility=installer_declared，不能冒充新审核或实测；旧撤回不恢复，旧包子项撤回也不导致整个初始化失败。

`SkillCandidateEvidence` 分开保存 license（verified/unknown）、behavior（reviewed/unknown）与 compatibility。兼容等级包含 unknown/installer_declared/command_verified/file_install_verified/client_load_verified/task_verified/failed；实测级别只接受 platform_test，并要求具体客户端版本、系统、日期、证据，task_verified 另要求任务。user_reported 或 model 不能申报平台 verified，M08 还有二次防护。本文测试中的平台证据只是隔离 fixture，未写入实际目录。

当前 source 白名单固定为 `anthropics/skills`、`github/awesome-copilot`，候选不能更改成任意仓库。只允许固定 raw.githubusercontent.com commit/path/文件，沿用大小、路径、完整 hash、SKILL.md、许可与通知校验。录入/审核/发布不下载文件，不执行 SKILL.md、脚本、shell 或安装；许可/行为未知只能草稿，未知兼容可在逐工具明确确认后发布证据说明，仍不可显示“已验证兼容”。

### M08 审核记录

新增独立公开入口 `src/modules/operations/skill-review.ts`，未改 M08 旧 worker/service/index：

```ts
import { createSkillCandidateService, createSkillPublicationPort,
  createSkillCandidateHandlers } from "../modules/skills/index.ts";
import { createPostgresSkillReviewRepository, createSkillReviewService,
  createSkillReviewHandlers } from "../modules/operations/skill-review.ts";

const candidates = createSkillCandidateService({ database, clock, ids,
  assertActorCurrent: (tx, actor) => assertCurrentSessionAndRoles(tx, actor) });
const reviews = createSkillReviewService({
  repository: createPostgresSkillReviewRepository(database),
  skills: createSkillPublicationPort(), clock, ids,
  assertActorCurrent: (tx, actor, requestId) => assertCurrentSessionAndRoles(tx, actor, requestId),
});
```

示例的 `assertCurrentSessionAndRoles` 是根必须提供的实际适配，代码没有静态“已登录”替代品。需在同事务锁定/复核当前会话、账号与角色，提交前复核；不使用独立连接。平台 reviewer/admin 才可读写运营；HTTP 工厂必需可信 `resolveActor` 与 `assertMutationAllowed`，保持根 Origin/CSRF/session 限制。

M08 记录包括 `reviewId/target/candidateRevision/contentHash/manifestHash/evidence/recordedBy/revision/status/reviewedBy/reviewedAt/verification/reason/publicationRevision`，审核人的自审情况在 audit 明示。`status=published` 是历史审核事实；当前上架以候选 state 和实际目录为准。旧审核不能发布新修订，撤回后的旧 publish 重试拒绝；撤回 operationId 按 actor 持久化，重复同参数返回原结果，不同参数冲突。内容、发布 operation、审核、审计同事务回滚。

| 建议根路由（前缀 `/api/v1/admin`） | Handler | 正文 |
| --- | --- | --- |
| GET `/skill-candidates` | candidateHandlers.list | 无正文，已保存快照 |
| GET `/skill-candidates/:kind/:id/:versionId` | candidateHandlers.detail(target) | 无正文 |
| POST `/skill-candidates` | candidateHandlers.save | `{expectedRevision,document,evidence}` |
| GET `/skill-reviews` | reviewHandlers.list | 可选 status/limit；根适配另支持完整 kind/id/versionId/limit 过滤 |
| GET `/skill-reviews/:reviewId` | reviewHandlers.detail(reviewId) | 无正文，返回 `{review,candidate}` |
| POST `/skill-candidates/:kind/:id/:versionId/reviews` | reviewHandlers.register(target) | exact 字段 |
| POST `/skill-reviews/:reviewId/decide` | reviewHandlers.decide(reviewId) | exact 加审核 `expectedRevision/decision/reason/verification` |
| POST `/skill-reviews/:reviewId/publish` | reviewHandlers.publish(reviewId) | exact 加审核 `expectedRevision` |
| POST `/skill-candidates/:kind/:id/:versionId/withdraw` | reviewHandlers.withdraw(target) | exact 加 `operationId/reason` |

M08 exact 字段为 `expectedCandidateRevision/expectedContentHash/expectedManifestHash`。通过审核的 verification 为 `{licenseChecked:true,behaviorChecked:true,acknowledgedCompatibility:AgentId[]}`，须覆盖没有本站 task_verified 的所有八工具；这只确认限制，不升级兼容。候选服务输入证据的 checkedBy 必须是当前录入人，未来核验日期被拒绝。

浏览器入口 `src/modules/skills/ui.ts` 导出 `SkillReviewPanel({api})`。API 回调由根 HTTP adapter 实现：面板 `expectedRevision` 是候选 revision，映射 M08 `expectedCandidateRevision`；面板 `expectedReviewRevision` 映射 M08 `expectedRevision`。新候选 adapter 调用 save(expectedRevision:0)。`listReviews(target)` 可以读取管理员队列并按 kind/id/versionId 筛选；结果超过100条时根应提供目标专用查询或分页，不声称队列已完整读取。发布/撤回固定内容不可覆盖，面板可从当前内容起草新版本，核验字段重置未知。

### M02 项目选择 / M05 可选引用 / M07 使用经验

`FixedSkillReference={kind,id,version,versionId,contentHash,revision}`；id 是当前发布目录行ID，version 明确为 skillVersion 或 bundleVersion。技能 hash 是文件清单 hash；包的 `projectBundleReferenceHash` 锁定包声明与必需子项固定文件 hash，不采用 candidate 整体 hash。必需子项不可用时拒绝新选择，原选择保留并显示 availability=false。可选项不自动选择/安装，单独选用时另查合法固定技能引用。

`TaskSkillReference={reference,purpose,learningMinutes,environment:{agentId?,clientVersion?,os?}}`。用途文字有界；未知环境可留空；拒绝额外字段、本机绝对路径、常见凭据形态、任意工具和安装命令 DTO。M05 添加 `skillRefs?: readonly TaskSkillReference[]`，JSON Schema 使用 `TASK_SKILL_REFS_JSON_SCHEMA`，不加入 required。采用/确认由服务器 `validateTaskSkillReferences` 核验固定引用，再 `assertTaskSkillLearningIncluded(refs, task.durationEstimate.likelyMinutes)`，学习分钟包含在现有估计内。旧任务没有该字段仍可生成、确认与执行。资源 Resource 引用保持独立。

根实现 `ProjectSkillSelectionPort.transaction(work(tx))`，tx 方法为：

- `getProject(projectId,lock?) -> {id,archived,readOnly}|null`。
- `get(projectId,lock?) -> {projectId,revision,selections,updatedBy,updatedAt}|null`。
- `save(state,expectedRevision)`：CAS，0表示此前不存在；清除保留空 selections 与新 revision，保留不可变历史。最初 `project-selection-schema.sql` 是通用存储建议；追加授权后提供的 `src/server/project-skills.sql` 包含真实项目/用户外键及历史不可修改触发器，应以该根 SQL 为准，不同时执行两份选择表建议。

`createProjectSkillSelectionService({selections,projectAccess,reviewedSkills,clock})`：`read(actor,projectId)`、`catalog(actor,projectId)`、`save(actor,projectId,{expectedRevision,selections})`、`copy(actor,sourceProjectId,targetProjectId,expectedRevision)`。活跃成员读、活跃 manager 写；platform admin/captain 不绕过空间权限，归档/只读拒写。跨项目复制同时复核来源可读与目标可写，引用不升级，不产生安装计划或回执。

`createProjectSkillSelectionHttpHandlers` 建议根接 GET `/projects/:id/skills`（read）、GET `/projects/:id/skills/catalog`（catalog）、PUT `/projects/:id/skills`（save）、POST `/projects/:id/skills/copy`（copy 输入 sourceProjectId/expectedRevision）。上述选择存储、ProjectAccessPort、ReviewedSkillLookupPort 必须复用根当前事务 executor，并在写入期间持有当前账号/session/membership/project保护至commit；独立连接组合不满足并发权限验收。

浏览器 `ProjectSkillSelection` props 为 `{state,catalog,onSave,onRefresh}`，onSave 输入 expectedRevision/selections，返回重新 read 的 ProjectSkillSelectionView；onRefresh 返回 `{state,catalog}`。根按可信 userId+projectId 设置 key，账号/空间更换卸载旧本地稿。选择、配置工时、撤回警告、未知环境和版本依据可见；没有安装按钮或安装副作用。

M07/root 可使用 `createSkillReuseSnapshot(lookup,refs)` 得到 `{schemaVersion:'1',skillRefs,installationAction:'none'}`；采用前仍校验当前合法引用。`validateSkillUseFeedback` 输入固定 reference/environment/purpose/learningMinutes/outcome/note/evidenceSource，outcome=helped/partial/did_not_help/not_used，evidenceSource只能 user_reported。历史版本被撤回后仍可保存真实使用说明：先由 M07/root 复核反馈引用确实来自当前用户可读的已存项目/任务事实，再调用 `parseSkillUseFeedback`；不能用历史解析绕过新依赖的当前查询。这里没有新增复盘成功状态或平台兼容结论。

### 追加授权的根适配与客户端包装层

`src/server/project-skills.ts` 导出 `createProjectSkillsIntegration({database,projectRepository,skillsRepository?,clock,ids,resolveActor,assertMutationAllowed})`。`projectRepository` 只要求 M02 公开 `getMembershipForShare`；受保护 M10 查询由公开 PostgreSQL factory 在请求作用域重建，确保所有查询使用同一 executor。返回：

- `initialize()`：在根迁移及目录初始化后幂等导入旧精选候选。
- `reviewedLookup`：固定版本查询，可供 M05 采用/确认注入；不要求管理员请求作用域。
- `selectionService`、`candidateService`、`reviewService`、`selections`：需在 `withRequest(request,work)` 内调用，裸私有服务操作拒绝缺失会话作用域。
- `handlers.selection.{read,catalog,save,copy}(projectId)`、`handlers.candidates.{list,save,detail(target)}`、`handlers.reviews.{list,detail,register,decide,publish,withdraw}`：已包装实际请求事务，沿用根身份及 mutation hook。非成功 HTTP 响应也回滚外层事务。

根适配在同一事务内重复解析实际请求会话、锁定当前活跃且邮箱已验证账号并核对角色；项目操作先按排序锁定全部 M04 assignment heads，再锁定全部 M02 项目，然后以 M02 公开方法锁定成员。空间选择 CAS、不可变历史、M10 查询和权限复核共用 executor，反向复制使用相同项目排序；不插入第二份 M04 分工事实。实际根 DatabasePort 的 ambient transaction 让 auth 的账号/session 锁定也复用此事务。

`ProjectSkillSelectionClient({projectId,actor?})` 与 `SkillsAdministrationClient({actor?})` 是新增根客户端包装层。前者绑定上述项目 API，保存/复制后重新读取视图；后者绑定候选及审核 API，并按完整目标过滤审核。两者读取实际 `/me` 与 `/me/permissions`，窗口聚焦/可见时刷新身份，以可信账号/项目 key 卸载旧稿。包装层不自动填入平台实测证据，不下载或安装技能。管理员人工录入仍须填入当前录入账号对应的 checkedBy。

主会话已接入 `createApplication` 实例化与 `initialize()`，并复制 SQL 为根递增迁移 038/039/040；这些根文件的组合、实际迁移、路由挂载和部署由主会话负责，本交付不自行执行。

## 已完成

- 持久候选、草稿修订与历史、服务器子项hash锁定、严格来源/manifest/许可/证据校验。
- M08 固定版本审核记录、单独发布/撤回、幂等操作与原子审计；独立 factory/HTTP 工厂/公共入口。
- 管理员 React 审核面板与项目技能选择组件，错误保留输入，原版本保留。
- K6 可选DTO/schema/lookup/项目选择端口与学习时间校验；M07 可复用固定引用和真实使用反馈。
- 增量 SQL 建议与模块公共导出/README；追加授权的根项目选择适配、会话事务保护及两个客户端包装层。
- 未修改 app/shared、M02/M05/M07、现有 server 文件、根配置/依赖或实际迁移。根 `application` 与路由组合由主会话修改。

## 已验证与模拟范围

- Node 内置 node:test，独立无目录 PGlite 验证持久化/事务/回滚；K6 内存Port夹具验证权限、版本、无安装副作用。
- 覆盖旧审核、revision/hash/manifest冲突、未知许可/行为、模型/用户报告不能冒充平台实测、未知工具须确认、篡改/不受信下载源、包内撤回、同技能多commit冲突、非法版本标签、发布后权限撤回全回滚、撤回不能复活、跨项目权限与复制不安装。
- 旧M10桥接测试仍只运行临时目录和无害fixture，不接真实客户端。没有读取或写入正在运行的PGlite目录、.env密钥、真实用户技能目录或网络服务。
- 内部只读交叉审查修复了版本标签runtime校验、同skill多commit包两处一致性问题。未发现可复现锁环；多连接 PostgreSQL 的并发不是本轮PGlite证明范围。
- 根适配隔离测试覆盖同 executor、M04 heads 先于 M02 项目锁、跨项目排序、活跃成员/管理员权限、归档、CAS/空选择墓碑、会话撤销后的事务回滚、选择历史外键与不可变触发器、固定候选审核/撤回及目标过滤。
- 实际 `createApplication` 启动测试使用无路径纯内存 `createDatabase({})`，执行根真实迁移 038/039/040、导入 11 个旧精选候选，以真实 auth cookie 和 router dispatch 验证项目创建/选择/管理员读取撤回。再次创建应用保留撤回，旧选择保留并标不可用；fetch 被拦截且调用数为 0，AI/inspiration worker 为空，安装计划为 0。这里的真实迁移仅指隔离库执行实际 SQL，不表示部署数据库已迁移。

测试命令：

```powershell
node --experimental-strip-types --test src/modules/skills/catalog-view.test.ts src/modules/skills/skills.test.ts src/modules/skills/publication.test.ts src/modules/skills/project-selection.test.ts src/modules/operations/skill-review-service.test.ts src/modules/operations/skill-review-handlers.test.ts
node --experimental-strip-types --test src/server/project-skills.test.ts
npm run typecheck -- --incremental false
```

模块六个测试文件 61/61 通过；新增根适配/实际应用启动测试 11/11 通过，合计 72/72。最后 `npm run typecheck` 通过（exit 0）。`project-skills.ts` 另经 Node strip-types 直接导入验证通过。测试未运行真实客户端、付费模型或部署数据库。

## 未接入 / 外部验收

- 根持久项目选择适配、当前会话/角色事务 hook 及客户端 API 包装层已经提供。实际迁移、管理员页与 HTTP 路由挂载、M05 Task.skillRefs、M07 事实复用仍由主会话组合；不得把模块测试当作已运行服务的验收。
- 组件类型检查不代替登录/账号更换/窄屏/管理员完整浏览器联调。本轮没有 build/start/服务重启。
- 8客户端真实安装、发现/加载、示例任务及整包共同环境验收仍未运行；来源metadata与夹具不能代替真实测试。新平台证据必须由实际日志产生并经人工核验。
- 增量建议 `candidate-schema.sql`、`operations/skill-review.sql`、`src/server/project-skills.sql` 未由 C06 在真实数据库执行，已应用迁移不改写。选择表采用根 SQL 的真实外键及不可变历史触发器；审核审计/候选历史建议授予应用SELECT/INSERT而非UPDATE/DELETE，worker无发布权限，实际grants由根按部署角色配置。
- 没有新增环境变量；复用根既有 DatabasePort / 时钟 / ID / 会话，外部客户端环境独立记录。
