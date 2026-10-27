# M06 GitHub 助手与赛事交付：模块实施规划

日期：2026-10-08｜版本：0.1｜状态：接口技术验证前的规划草案

关联：[产品构想](../../../草根黑客松情报局-产品想法与问题分析.md) · [项目宪法](../../../.specify/memory/constitution.md) · [赛事规则](03-赛事聚合与证据分析.md)

跨模块字段、角色与响应沿用 [数据与接口协作约定](../10-数据与接口协作约定.md)；宪法检查依据当前 v1.1.0。

## 1. 目标与需求性质

把“不会使用 GitHub”的参赛者带到可核对的成果保存与交付流程：知道作品存在哪个仓库、这次改了哪些文件、是否已保存、是否能运行，以及是否完成赛事正式提交。

| 性质 | 内容 |
| --- | --- |
| 用户已明确 | 网站让 GitHub 更简单顺手，辅助黑客松作品交付 |
| 宪法约束 | 登录与仓库授权分开；最小权限；预览变更；处理并发与失败；三类完成状态独立 |
| 默认建议 | 第一版连接已有且已初始化的仓库；多文件一次保存；使用独立分支与可选 PR；不自动合并 |
| 待确认 | 创建仓库、ZIP 上传、文件上限、成员授权方式、提交平台适配与冲突支持深度 |

网页可以简化操作，但不承诺替代完整 Git 客户端或修复所有环境问题。没有 GitHub 账号的成员仍可做测评、计划、测试和文档；真正进行仓库操作时再接入授权。

## 2. 第一版范围与非目标

### 第一版闭环

1. 说明连接范围 → 完成 GitHub App 安装/用户授权 → 绑定指定仓库。
2. 选择文件 → 检查路径、体量、依赖及疑似密钥 → 展示新增/修改/明确删除列表。
3. 确认目标仓库和分支 → 保存为一次 commit → 展示 commit/分支链接及真实结果。
4. 完善 README 草案 → 用户编辑与确认后按相同写入流程保存。
5. 按 M03 的赛事规则核对代码、视频、文档、演示等要求。
6. 打开官方提交入口；由用户记录提交结果和凭据，标明用户自报来源。

### 第一版后置

创建仓库、导入任意 ZIP、网站内合并 PR、自动解冲突、自动修改工作流、在线执行任意代码、自动部署、多平台自动报名及提交。创建仓库可先提供官方网页引导；不能因为后置该能力而阻断已有仓库闭环。

## 3. 用户故事

| ID | 用户动作 | 成功结果 |
| --- | --- | --- |
| G-01 | 项目管理员连接一个指定仓库 | 能看见授权范围，其他仓库不自动可用 |
| G-02 | 有权限成员保存多份文件 | 一次可追踪版本包含所选变更，未选文件不消失 |
| G-03 | 队友在预览后更新同一分支 | 系统阻止静默覆盖，保留本次草稿供重新检查 |
| G-04 | 新人确认 README 内容 | 写入前预览，写入后显示实际 commit 链接 |
| G-05 | 队员勾选材料并演示验收 | 仓库保存、运行验收、正式提交状态分别可见 |
| G-06 | 提交过程中断网 | 返回后可核对上次操作，不重复创建相同版本 |

## 4. 页面与关键状态

| 页面区域 | 建议路由 | 主要动作 |
| --- | --- | --- |
| 仓库连接 | `/app/projects/{id}/delivery` 的仓库区 | 查看连接、安装/授权、选择已有仓库、断开 |
| 作品保存向导 | 同页分步区域 | 选文件、校验、预览、确认、结果与恢复 |
| 版本记录 | 同页页签 | commit、分支、操作者、写入结果、PR 链接 |
| 提交清单 | `/app/projects/{id}/delivery` | 核对规则、记录演示、打开官方入口、记录提交 |

项目根页 `/app/projects/{id}` 用于概览；仓库与交付是同一 delivery 子页中的分区，不另建会产生两份状态的项目首页。`/projects` 在本文仅用于 API 路径。

连接状态：`unbound → authorizing → bound / failed`，以及 `permission_changed / revoked`。连接失败不会退出网站账号。

保存状态：`draft → validating → ready_for_preview → confirmed → saving → saved / blocked / failed / unknown`。网络超时后不能直接标失败并重写；进入 `unknown`，先用 operation ID、branch 与 commit 核对远端结果。

交付状态独立存储：

- **仓库保存：**未保存 / 保存中 / 已保存 / 需处理。
- **作品验收：**未验收 / 验收失败 / 人工验收通过，附验收人、时间和依据。
- **赛事提交：**未提交 / 用户标记已提交 / 平台确认已提交；第一版若没有官方确认 API，不展示平台确认成功。

PR 已创建不等于变更已合入目标分支。交付清单必须核对比赛要求的分支与对应 commit；需要主分支时，仍待有权限者合并并复查，不能拿尚未合并的版本标为交付完成。

## 5. 授权设计

### 四层权限分别检查

1. 用户的网站登录与有效会话。
2. 该用户活跃的 `ProjectMembership` 及项目允许的仓库操作能力；项目管理动作要求 `status=active, role=manager`，成员保存自身成果还需经过 M06 的明确操作能力检查。
3. GitHub App 的安装范围与当前仓库权限。
4. 操作人在 GitHub 的实际身份与仓库写权限；项目管理员和团队队长身份均不创造 GitHub 写权限，`TeamMembership.role=captain` 也不替代 `ProjectMembership.role=manager`。

**默认候选：**用户直接触发的写操作使用 GitHub App user access token，在服务端调用；installation token 用于经过限定的安装信息/仓库同步，不用 App 的安装权限代替成员本人的权限。令牌加密保存于受控服务端，短期缓存，支持失效、撤销和账户解绑。前端只拿连接状态和内部 binding ID。

官方文档说明 App 默认没有权限，应申请最小权限；user access token 的能力同时受用户与 App 权限限制，而 installation token 只受 App 权限限制。因此实施必须明确调用身份。[GitHub App 权限说明](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)

### 权限候选矩阵

| 能力 | 候选权限 | 第一版处理 |
| --- | --- | --- |
| 读取已授权仓库、分支、内容 | 所需元数据/Contents read | 逐 endpoint 验证 |
| 创建 tree/commit/普通分支并保存文件 | Contents write | 本模块最小核心，仍需遵守分支规则 |
| 创建 PR | Pull requests write | 可选入口；不足时提供比较页面引导 |
| 修改 `.github/workflows` | Workflows write 等 | 默认不申请，并拒绝本助手修改此路径 |
| 创建仓库 | 单独的创建仓库权限与适用 token | 后置；不推断 Contents write 足够 |
| 删除仓库、改权限、管理组织 | 不申请 | 不提供操作 |

GitHub 当前权限文档提到 Repository creation 可用于更细的创建能力；具体个人/组织 endpoint、token 类型、安装范围和规则支持必须在技术验证时核实。创建已有仓库闭环不依赖这项能力。[GitHub 仓库 API](https://docs.github.com/en/rest/repos/repos)

## 6. 多文件保存方案

不能逐文件调用上传 API 后就声称一次整体保存成功。第一版建议通过 Git 数据库 API 为所选文件创建一个 tree 和一个 commit，保留未修改的基树内容。GitHub 文档明确：省略 `base_tree` 会使未列出的旧文件在新 commit 中表现为删除。[Git tree API](https://docs.github.com/en/rest/git/trees#create-a-tree)

建议执行步骤：

1. 服务端核查四层权限，获取当前目标基分支的 head 和 tree；保存 `baseHeadSha`。
2. 上传内容放临时对象存储；规范化相对路径，拒绝绝对路径、`..`、重复路径和大小写碰撞。
3. 排除 `.git`、`node_modules`、构建输出等；识别疑似凭据并展示原因。检测通过不等于绝对无密钥。
4. 比较所选文件和远端，展示新增、修改、用户明确选择的删除；没有选择的文件保持原样。
5. 用户确认仓库、分支模式、内容差异、说明和当前基版本；确认绑定内容哈希与版本，之后改内容必须重新预览。
6. 再次核查 head；若已变化，重新生成差异并让用户复核，不悄悄将旧预览应用到新版本。
7. 基于 `base_tree` 与所选内容创建 tree，创建以已验证 `baseHeadSha` 为 parent 的 commit。
8. 默认建立唯一操作分支 `hackathon/:operationId` 指向该 commit；可创建 PR，由有权限者审核。分支名称以真实 API 验证结果定稿。
9. 若未来允许更新已有目标分支，只允许 `force:false` 的 ref 更新；最后一次检查后的竞态必须由远端非强制更新保护，冲突时保留草稿，不强推。
10. 查询远端 branch/ref，确认 commit 可达后记录 `saved`；PR 创建失败可保留“分支已保存、PR 待创建”，不能把整次版本抹掉。

官方 ref 更新接口的 `force:false` 检查 fast-forward，可阻止覆盖不在当前新 commit 祖先链上的队友成果；它不是一个携带 expected SHA 的通用 CAS，因此仍需版本预览、独立分支和错误恢复。[Git reference API](https://docs.github.com/en/rest/git/refs#update-a-reference)

空仓库无可用基分支，第一版提示先按官方引导初始化 README，再重新绑定；不在未验证的空仓库 API 行为上承诺“一键首次保存”。二进制、超大文件、符号链接和子模块需单独验证；默认仅保存支持的普通文件，超出限制明确提示其他路径。

## 7. 核心数据

| 实体 | 关键字段与约束 |
| --- | --- |
| `RepositoryBinding` | 项目 ID、GitHub repository ID、owner/name、安装 ID、默认分支、授权状态、连接操作者、权限快照、最近核查时间；不向客户端返回 token |
| `GitOperation` | operation ID、项目/仓库、操作者、幂等键、输入哈希、预览版本、base/head/tree/commit SHA、目标分支、PR URL、步骤、状态、错误分类 |
| `DeliveryVerification` | M06 唯一所有者；`id, projectId, repositoryCommitSha?, verifierId, verifiedAt, environmentSummary, steps, outcome, blockers, evidenceRefs, version`；`outcome=passed/failed/inconclusive`，只记录运行/演示验收，不表示正式赛事提交 |
| `SubmissionRecord` | M06 唯一所有者；`id, projectId, eventId, stageId, requirementsVersion, platformUrl, submittedAt?, verificationSource, repositoryCommitSha?, status, evidenceRefs, recordedBy, version`；仅赛事提交，不承载运行验收；`verificationSource=user_reported/platform_verified`，`status=not_submitted/reported/verified/rejected_or_withdrawn` |
| `ProjectMembership`（引用） | M02 所有；`role=manager/member, status=active` 为有效项目权限依据，仓库操作能力由 M06 额外校验；移除成员立即停止新写请求 |
| `AuditEvent` | 授权、绑定变化、预览确认、真实写入与提交状态修改；不记录密钥和上传文件全文 |

上传草稿为短期文件引用和 manifest；规定有效期、配额和删除机制。已保存版本保留 commit 元数据即可，不无限复制完整私人仓库。提交凭据可能含私人资料，访问沿用项目权限，公开分享另行确认。

## 8. API 草案

统一 `/api/v1`。所有写操作校验项目关系，操作 ID 与该项目绑定。

| 方法与路径 | 作用 |
| --- | --- |
| `POST /github/authorization/start` | 建立用户授权流程，state/PKCE 按选定官方方案实现 |
| `GET /github/authorization/callback` | 核验回调、关联网站用户；拒绝复用过期 state |
| `GET /github/repositories` | 列出当前用户可用于该动作且 App 已授权的仓库 |
| `PUT /projects/:id/repository-binding` | 活跃项目管理员指定仓库，重新检查权限 |
| `DELETE /projects/:id/repository-binding` | 断开网站项目绑定；撤销 GitHub App 安装另提供明确入口 |
| `POST /projects/:id/git-operations` | 建立草稿与短期上传凭证，不立即写 GitHub |
| `POST /projects/:id/git-operations/:opId/preview` | 校验内容，生成绑定版本的 diff |
| `POST /projects/:id/git-operations/:opId/confirm` | 用户明确确认输入哈希与目标；执行前再校验权限 |
| `GET /projects/:id/git-operations/:opId` | 状态、恢复动作和真实远端链接 |
| `POST /projects/:id/git-operations/:opId/reconcile` | 结果未知时核对远端，不盲目重试写入 |
| `GET /projects/{id}/delivery-summary` | M06 汇总规则材料、GitOperation、DeliveryVerification 与 SubmissionRecord 的三类状态，M07 复用读取；标明来源/时间/未知项 |
| `POST /projects/{id}/delivery-verifications` | M06 写入运行/演示验收及依据，校验活跃项目成员和验收能力；M07 通过此接口委托，不另建验收表 |
| `GET /projects/{id}/delivery-verifications` | M06 返回可访问的验收历史与对应 commit |
| `GET /projects/{id}/submission-records` | 按赛事阶段返回正式提交状态历史 |
| `POST /projects/{id}/submission-records` | 建立某阶段的用户提交声明/未提交记录，附规则版本、代码版本和证据；第一版无平台确认接口时只能 user_reported |
| `PATCH /projects/{id}/submission-records/{recordId}` | 更新该提交记录，携带 expectedVersion；不得在此写运行验收或把用户声明改成平台确认 |

Webhook 接口单独接收安装权限/仓库事件；核验签名、delivery ID 去重，payload 不直接授予任何写权限。是否首版接入 push webhook 取决于测试成本，可先在操作前刷新与页面显式同步，不以提交次数推断任务完成。

## 9. 异常恢复

| 情况 | 处理 |
| --- | --- |
| 权限不足、安装撤销 | 阻止写入，草稿保留；显示重新授权/选择仓库，不自动申请更多权限 |
| 分支保护或 ruleset 拒绝 | 保留分支/草稿，说明需要有权限者审核；不绕过规则 |
| 队友并发更新 | 阻止旧预览，展示差异；重新预览或创建独立分支，不静默覆盖 |
| 网络超时、结果未知 | 查询已记录 SHA、分支与 PR；核对后续做缺失步骤，保持幂等 |
| 多步骤部分成功 | 显示“版本已保存、PR 创建失败”等真实状态，提供继续动作 |
| 速率限制 | 尊重服务返回等待时间，有限重试；截止临近提示官方网页替代入口 |
| 文件受限或疑似密钥 | 保存其余草稿但不写入被阻止内容，给出排除/修正路径 |
| 复杂冲突 | 保留双方版本并给官方比较/本地处理引导，不承诺自动修复 |

## 10. 依赖与事件

依赖 M01 身份授权、M02 项目权限、M03 确认规则，读取 M05 的交付任务。输出 `RepositoryBound`、`GitSaveSucceeded`、`GitSaveBlocked`、`DeliveryValidationRecorded`、`SubmissionRecorded`，附来源和版本。其中 `DeliveryValidationRecorded` 对应唯一的 `DeliveryVerification` 新版本，`SubmissionRecorded` 对应唯一的 `SubmissionRecord` 新版本；实体名称和事件名称不必完全相同，但不得建立两个验收事实源。M05 接收事件后只能建议更新相关任务；保存 commit 不自动完成“演示能运行”。M07 委托 M06 写入验收、复用三状态汇总与提交记录，用于复盘，不直接维护第二套运行验收或提交实体。

DSH 采集 Worker 不调用本模块写接口，不持有 GitHub token；AI 可以生成 README 草案，但写入必须由有权限用户确认。

## 11. 可实施任务与发布门禁

| 任务 | 交付与验证 |
| --- | --- |
| G-T01 权限技术验证 | 测试个人/组织仓库、用户与 App 权限交集、ref/tree/commit/PR endpoint、撤销与分支规则；输出最小权限矩阵 |
| G-T02 连接与绑定 | 网站登录和 GitHub 授权分离、连接状态、绑定/断开、跨项目权限验证 |
| G-T03 草稿与校验 | 文件 manifest、短期存储、路径/大小/依赖/密钥检查、过期恢复提示 |
| G-T04 变更预览 | 支持文本 diff、明确删除、基版本与输入哈希、修改后重新确认 |
| G-T05 一次版本保存 | base_tree、一次 commit、独立分支、可选 PR、幂等与结果核对 |
| G-T06 交付清单 | 规则映射、仓库/演示/正式提交状态分离、用户声明来源 |
| G-T07 README | 模板和可编辑草案、预览写入；模型失效时可手写 |
| G-T08 故障验证 | 并发、断网、超时、撤销、PR 部分失败、文件限制、真实测试仓库贯通记录 |

关键写入要在可丢弃测试仓库验证；模拟 API 测试不能代替真实权限、分支保护和并发验证。真实试用前，不允许存在静默覆盖、错误成功状态或 token 泄露。

## 12. Given / When / Then 验收

1. **Given** 用户已登录网站但未授权 GitHub，**When** 保存文件，**Then** 引导授权而非报保存成功。
2. **Given** 成员为项目管理员但 GitHub 仅只读，**When** 点击保存，**Then** 拒绝写入并保留草稿。
3. **Given** 仓库含 20 个文件，用户只修改 2 个，**When** 保存版本，**Then** 一次 commit 包含这 2 个变更，其余 18 个保留。
4. **Given** 预览后的目标 head 发生变化，**When** 确认保存，**Then** 旧预览不能直接更新共享分支；需重新复核或使用明确独立分支。
5. **Given** ref 更新成功后响应丢失，**When** 用户重新进入，**Then** 核对远端同一操作，不能重复创建版本。
6. **Given** commit 已保存但 PR 创建失败，**When** 展示结果，**Then** 保存成功和 PR 失败分别可见。
7. **Given** 文件已保存但项目未运行，**When** 查看交付页，**Then** 作品仍是未验收，赛事仍是未提交。
8. **Given** 用户自行标记已提交，**When** 团队查看，**Then** 显示“用户标记已提交”、声明人/时间与凭据，而非平台确认。
9. **Given** 比赛要求主分支公开代码但最新版本只在未合并 PR，**When** 核对材料，**Then** 指出目标分支未就绪，不将仓库链接当作完整交付。

## 13. Constitution Check

| 原则 | 处理 |
| --- | --- |
| I 新人流程 | 向导使用任务语言，显示下一步与恢复动作 |
| II 事实追溯 | 提交要求带规则版本；平台确认与用户声明不同 |
| III 测评 | 不用 GitHub 活跃度推断能力，适用范围有限 |
| IV 时间 | 提交失败回馈 M05；提供官方入口保留截止缓冲 |
| V 可靠授权 | 四层权限、预览、一次 commit、并发保护、三状态独立是门禁 |
| VI 隔离 | 服务端凭据、项目权限、采集 Worker 分离、撤销机制 |
| VII 可维护 | GitHub adapter 与业务流程分离，步骤状态持久化 |
| VIII 真实验证 | 真实测试仓库与模拟分开；核心写入需行为检查 |
| IX 恢复 | 草稿保留，结果未知先核对；模型失败可手写 README |

## 14. 风险与待决策

- **最难的不是按钮，而是可靠写入。** 必须优先完成 G-T01 和并发验证，再估算 UI 工作量。
- **直接写主分支有协作成本。** 默认独立分支较稳妥，但增加合并步骤；需要真实队伍验证是否应提供受限直写模式。
- **新手可能只有空仓库或不会创建仓库。** 首版初始化引导是否足够，要观察试用；如不足再单独加入创建/初始化能力。
- **网页难以确认任意代码可运行。** 第一版以明确的人工验收记录为主，不能拿上传成功包装“一键可用”。
- **待决定：**上传格式/体量/保存期限、哪些成员可写、是否支持 PR、测试组织环境、年龄与 GitHub 账号要求、正式提交凭据和平台 API 范围。

外部接口以实施时的官方文档和真实测试结果定稿，锁定 API 版本；本规划未安装 App、未创建仓库、未进行实际写入或赛事提交。
