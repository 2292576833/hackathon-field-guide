# T03 阶段与提交清单交付

日期：2026-10-09。依据宪法 v1.7.0、规划 16 与 T03 授权。仅修改新 `space-workflow` 模块、`space-lifecycle.tsx`/独立 CSS、授权隔离 e2e 和本交付说明。

## 已完成

- 新纯展示模块：model/catalog/service/index/README，阶段、下一步、计划读取状态、截止来源、当前规则阶段与提交记录分别组合。
- 导出 `SpaceLifecycle({detail,current,planningLoading?,planningError?})` 与 `SpaceSubmissionChecklist({detail})`，props 与主会话接入一致。
- 五阶段只切本地展示，不改 Project.stage；支持方向键、Home/End 和关联 tabpanel。归档明确只读。
- 首页突出真实下一步与本人相关当前任务，目标和可选工具折叠。单人可继续，自选职责、可选测评/AI、GitHub 均无强制前置。
- 清单分别展示保存、同 commit 运行、规则材料和各阶段正式提交；旧规则/确认/阶段保留历史，每个记录 ID 最高版本覆盖旧报告。成员报告、未提交和拒绝/撤回语义明确，不汇总整场成功。
- 阶段与清单里的路演/PPT入口均带 `?projectId=`，进入已有页面时保留当前空间；采用资料、生成和共享仍由本人确认。
- 只读既有 GET；规则、赛道、交付读取失败均为未知，有超时与手动恢复。没有读取本人画像/行程/讲稿/PPT，没有写请求、自动生成、收费或仓库操作。

## 已验证

- `npm run typecheck -- --incremental false`：最终通过（2026-10-09，包含本模块纯测试与主会话正在组合的全站 TypeScript；没有越界修复其它文件）。
- `node --experimental-strip-types --test src/modules/space-workflow/service.test.ts`：31/31 通过，无跳过。
- `node --experimental-strip-types --check tests/e2e/team-space-lifecycle-v2.spec.ts`：通过。
- `npx playwright test tests/e2e/team-space-lifecycle-v2.spec.ts --list`：成功收集 6 个用例；仅收集，未启动浏览器或执行夹具。
- 接入处只读检查：主会话已将工作台放在首页当前计划读取处，将提交清单放在提交页首部，未自行修改这些共享文件。
- 静态读取检查：组件只有 rules/official-tracks/delivery-summary 读取，不重复获取 plans/current，不写本地完成状态。

## 模拟测试

纯模型 31 项已执行，覆盖阶段与归档、未读/加载/失败/无计划、输入版本变更、真实任务关联与角色、单人继续、截止来源、保存与运行 SHA 匹配、空摘要、成员报告和拒绝/撤回、逐阶段与旧规则/确认历史、安全 URL、工具上下文和输入不变性。纯数据与注入夹具不调用数据库或任何外部服务。

隔离 e2e 6 项已编写和静态收集，尚未执行：375px 空空间与五阶段只展示、计划读取 503、旧 commit 不能认证当前版本、多阶段/撤回更正/旧规则记录与成员只读、交付读取失败的 GET 重读恢复、归档空间只读。均审计请求、阻断外网、不读取本人画像/行程/稿件，并断言无写入和空间上下文链接。运行时使用现有 isolatedWorkspace 内存 PostgreSQL 与真实 handler，必要错误/历史 DTO 仅为夹具；不代表真实平台或真实手机验收。

## 未接入 / 未验证

- 本会话不 build/start/重启，不运行浏览器测试或访问生产 PGlite；构建、375px 实际布局和隔离浏览器统一交主会话验收。
- 官网报名、环境、PPT、视频、讲稿、出行、天气无合法共享完成事实，仅说明待核对与本人入口。
- 平台核验当前未接入；`reported/user_reported` 仅为成员报告。GitHub 实际写入、外部提交、公网证书、实体手机未在本次执行。
- 当前 commit 特指本站最新保存版本，不能认定 GitHub HEAD、已经合入主分支或符合全部赛事要求。手动运行与外部保存可在原操作页记录。
- 摘要仅提供每条提交记录的最新版本；清单保留旧规则/阶段的各条当前记录，全部不可变更正历史继续由原 M06 接口/页面提供，不建立第二份历史。

## NEEDS_INTERFACE

无阻塞的新接口需求。主会话继续通过既有 ProjectDetail 和 CurrentPlanningView 传入权限范围内的数据。若后续要展示报名/环境/PPT/出行完成，必须先由对应所有者提供真实权限、版本与事实端口，不能从当前字段推断。

类型说明：`getDeliverySummary` 的数组索引在现有编译选项下推导时遗漏实际可返回的 `latestOperation=null`、`latestHistoricalVerification=null` 与 `status=not_saved`。本模块的 `SpaceDeliverySummary` 仅扩展这几个真实空结果分支来匹配既有 wire DTO；未修改 M06 方法、接口行为或数据库。真实空摘要已有专门测试。

## 所需环境变量

无新增。复用既有网站登录、项目权限与 GET 路由配置，不读取或输出环境变量值。

## 文件交还

2026-10-09 已完成授权代码、文档与静态/纯模型验证。所有辅助检查与测试代理已明确停止编辑；本 T03 会话现停止编辑并交还全部授权文件，主会话统一构建、运行隔离浏览器并补最终真实验收。

## 追加修复：保存入口定位

2026-10-09 主会话走查指出清单的“查看保存操作与恢复方式”原来指向同页顶部。已改为 `/app/projects/:id/delivery#repository-save`，直接定位已有 `RepositoryPanel` 的保存区；该区包含草稿、差异预览、写入确认、未知结果核对、历史与草稿取回。复用现有锚点，未修改仓库组件或增加新区域。

授权隔离 e2e 的旧 commit 用例已补断言：入口 href 带正确空间与 `#repository-save`，点击后 URL hash 正确、保存区域进入视口、真实保存标题存在。最终 typecheck、spec 语法检查及 6 用例收集通过；未运行浏览器、构建或启动服务。本次追加修复已停止编辑，文件再次交还主会话。
