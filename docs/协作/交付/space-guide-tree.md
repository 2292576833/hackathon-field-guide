# 团队空间详细指引树交付

## 授权与文件

仅新增 `src/modules/space-workflow/guide-tree.ts`、`guide-tree.test.ts`，`src/components/space-guide-tree.tsx`、`space-guide-tree.module.css` 和本报告。既有 index、root 路由、SpaceLifecycle、组件共享样式、真实迁移、构建与启动由主会话负责。本轮完成后停止编辑并交还文件。

## 已完成

- 6 主段：目标与可选邀请 → 报名/官方赛道/要求截止 → 职责/本人时间/分工/计划确认 → 实际依赖/交成果/检查 → 代码/运行/展示/正式提交 → 复盘/复用/归档。
- 16 个详细行动节点，每项包含何时做、具体动作、完成或核对条件、真实入口、下一步；工具就近折叠。
- `buildSpaceGuideTree(input: LifecycleInput)` 纯展示模型，暴露 `currentStepId` 与 `next`。推荐依真实目标、匹配规则/官方选择、已应用计划、任务有效检查记录；不能按空间阶段推断整场成功。
- 原生 details 单主段展开，默认推荐分支，手动浏览后不因后台数据更新抢回分支；无 checkbox、可写勾选、百分比或第二份进度。
- 单人可继续；成员邀请入口联系管理员，归档只读回顾；丢失/失败读取不当空数据。
- 报名、环境、PPT/视频、主办方接受、复盘确认没有读取事实时明确自行核对；任务接受需当前 done 和有效检查记录，待检查、重开、删减和无记录 done 不解除依赖。
- 路演/PPT/GitHub 保留安全编码的 projectId；其他公开入口保留原合法路径，空间共享资料仍在本空间；邀请用原 `#space-invitation` 弹窗。

## 已验证与边界

模型单测 13/13 通过，`npm run typecheck` 通过。测试覆盖单人、只读权限、所有空间阶段未知事项、读取失败、规则/赛道/计划版本不一致、任务检查真假、外空间隔离、公开/私人链接上下文与输入不变。浏览器由 auth_return_context 创建独立 fixture 的专用 `tests/e2e/space-guide-tree.spec.ts`，等待主会话 `GUIDE_TREE_READY=1` 后执行；未运行或 skip 均不算通过。不读取生产数据库，不调用 DSH/邮件/GitHub，不 build/start/restart。

## NEEDS_INTERFACE

1. 根 `SpaceLifecycle` 将已经读取的 `{detail,current,planningLoading,planningError,rules:readState(rules),tracks:readState(tracks)}` 传给 `<SpaceGuideTree input={...}/>`；不要新增付费读取或写入。
2. 模型和组件直接从新文件导入。根如需要公共导出，自行在 space-workflow/index.ts 增加，代理不越权修改。
3. 原 “空间设置与历史记录” details 当前没有 id；新增树使用 `${base}#space-settings`，请根添加此锚点并支持链接定位到折叠内容时展开。作品目标 `#project-goal` 与邀请 `#space-invitation` 复用已有行为。
4. 已与主会话确认：主界面仅展示新树 `currentStepId/next`，旧五阶段说明折叠作补充。旧 `buildSpaceLifecycle.next` 在未读规则但 finalizing/submitted 时可能先推荐交付/复盘，在规划未读时先推荐计划；与新树真实前提优先顺序不同，不应同时展示。新树浏览不会改变 Project.stage，也不按单纯阶段切换误判输入变动。

## 浏览器结构合同

- section accessible name：`团队空间指引树`；顶层树为 `ol > li > details`。
- 六段 summary 主标题以 1. 至 6. 开始，分别为目标邀请、报名赛道要求、职责时间计划、任务成果检查、演示正式提交、复盘复用归档。
- 每个节点具 `何时做`、`具体怎么做`、`完成或核对条件`、`下一步`；工具 summary 为 `需要时用这些工具`。
- 状态通过 `data-state=recorded/prepare/check/unknown/loading/error/review` 与文字显示，不以成功勾选冒充完成事实。

无新增环境变量，真实浏览器验收就绪变量由主会话使用 `GUIDE_TREE_READY`。
