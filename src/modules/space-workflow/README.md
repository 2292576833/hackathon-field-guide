# 团队空间阶段与提交展示

T03 对应宪法 v1.7.0、规划 16。这里只组合已有事实和准备入口，不拥有任务、成员权限、报名、材料完成或提交状态。

## 公共出口

`index.ts` 导出纯类型、`spacePhaseGuides(projectId)`、`initialSpacePhase(stage)`、`buildSpaceLifecycle(input)`、`buildSubmissionChecklist(rules, delivery)`、`submissionRecordLabel(record)`、`publicHttpLink(value)`。

`SpaceDetail` 与现有 `ProjectDetail` 结构兼容。其他模块仅经公共出口做 `import type` 引用；运行时没有数据库、模型、GitHub 或跨模块存储依赖。

## 前端组合

`src/components/space-lifecycle.tsx` 导出：

```tsx
<SpaceLifecycle
  detail={detail}
  current={current.data}
  planningLoading={current.loading}
  planningError={current.error}
/>
<SpaceSubmissionChecklist detail={detail} />
```

首页父组件拥有当前计划的读取、刷新和轮询。组件不会再读取 `plans/current`。`current === null` 默认为未读取，只有成功读取的 `current.plan === null` 才表示无生效计划。错误、加载和 `inputVersionsChanged` 优先于旧数据，不能将旧任务推荐为已核对的当前安排。

工作台初始阶段来自 `Project.stage`：draft→组队选方向，preparing→赛前准备，active→比赛进行中，finalizing→演示提交，submitted/retrospective/archived→赛后复盘。切换仅使用 React 展示状态，无写请求、localStorage 或完成勾选。阶段页提供主要动作，行动说明和可选工具默认折叠；有当前计划时先提供本人相关任务。任务入口是“查看条件”，不另行推断 ready、解除依赖或修改状态。实际开始、完成、检查与纠错仍由 M05 的原操作页处理。

## 读取与事实

组件的只读 API：

| 位置 | 既有 GET | 用途 |
| --- | --- | --- |
| 工作台 | `/projects/:id/rules` | 已确认规则是否可读取 |
| 工作台 | `/projects/:id/official-tracks` | 官方赛道选择与复核提示 |
| 提交清单 | `/projects/:id/rules` | 实际材料、阶段、官方入口与原始日期 |
| 提交清单 | `/projects/:id/delivery-summary` | 本站已保存版本、同 commit 运行与各条提交记录的最新版本 |

通过既有 `useApi` 读取，15 秒超时、错误优先、手动重读；按项目和本人身份重新挂载，避免换空间时沿用旧数据。摘要接收仓库保存事件刷新，不额外轮询。GET 不触发生成、收费或仓库写入。个人画像、行程、讲稿和 PPT 只链接到本人页面，不读取或共享个人内容。路演与 PPT 链接带 `?projectId=` 保留当前空间；仍由本人确认采用哪些空间资料，导航不自动生成或共享私人稿件。

`Project.deadline` 始终称团队安排；计划中的 `verified` 截止标明来自计划快照。官方规则日期保留原文、原时区和 dateOnly，只有明确的精确 UTC 才转换为北京时间。

提交清单将代码保存、运行、材料和正式提交分开：

- 本站最新保存 commit 不等同于 GitHub HEAD、指定分支合并或赛事提交。
- 运行必须匹配该保存 commit；旧版、未填写 commit 的通过记录只属历史。所有实际运行记录目前是成员自报。
- 当前材料与阶段来自匹配的 `confirmation.eventId/rulesVersion` 和规则；入口缺失、非法或规则不一致时待核对。
- 按记录 ID 取最高版本，分别展示当前规则的各阶段。`requirementsVersion` 使用既有 `${eventId}:${rulesVersion}:${confirmationRevision}`，旧规则、旧确认或其它阶段单列历史。
- 同阶段不同 ID 仍是独立记录，不选取一条 reported 汇总为成功。`user_reported` 即使带 verified 状态也只称成员报告；未提交、拒绝/撤回不会显示为成功。
- `/delivery-summary` 只返回每条记录最新版本，不包含全部更正版本。清单明确该范围，完整历史仍在 M06 的原交付页面/GET `/submission-records`。无需新增历史存储。
- 不以 Project.stage、访问官网、AI 生成或浏览资源推断报名、环境、PPT、出行或正式提交成功。

## 验证与边界

纯模型使用 Node 内置 `node:test`，31 项通过；最终 `npm run typecheck -- --incremental false` 通过。隔离 e2e 位于 `tests/e2e/team-space-lifecycle-v2.spec.ts`，6 项通过静态语法与 Playwright 收集，尚未运行浏览器。主会话统一运行构建及浏览器验收，本模块不启动服务或打开生产 PGlite。

`SpaceDeliverySummary` 保留 M06 wire DTO，仅显式放宽现有函数推导遗漏的真实空分支：`latestOperation=null`、`latestHistoricalVerification=null` 和 `status=not_saved`。没有改变 M06 运行行为；真实空摘要已测试。

无新增环境变量、依赖、迁移、公共契约或收费服务。服务端仍负责每次读取的真实会话与项目权限。没有平台自动核验端口，不承诺主办方已接受提交或材料整体完成。
