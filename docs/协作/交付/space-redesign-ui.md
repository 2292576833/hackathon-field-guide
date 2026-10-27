# S1 · 团队空间协作界面重设计

日期：2026-10-12。依据规划28与本轮精确临时授权。状态：**已交付，STOP，文件交还主会话**。

## 文件

- `src/components/space-canvas-board.tsx`
- `src/components/space-canvas-board.module.css`
- `src/components/space-assistant-float.tsx`
- `src/components/space-assistant-float.module.css`

## 已实现

1. 默认正常流式协作视图：常驻空间名称、身份、成员数、返回入口、邀请/权限提示、私人空间AI入口；本人待办与团队概览、紧凑流程、队友状态、全宽空间文档。倒计时与范围调整按需展开。
2. 自由画布作为独立可选视图；只记本人视图偏好，不自动改写服务器旧坐标、尺寸和缩放。卡片内流程用紧凑 steps，避免再次套大画布。
3. 手机所有画布组件按单列流式展示，不保存桌面坐标调整；卡片内容正常滚动、选择和复制，不对整张卡设置touch-action:none。
4. 只有显式“调整布局”才能抓手拖动、方向键移动和Alt滚轮缩放。普通wheel没有布局保存操作；输入框、按钮、链接、弹窗等不会被Alt缩放劫持。折叠、移除、宽度、留白、100%缩放均有可见按钮或原生summary入口。
5. 布局PUT串行；新手势可合并为最新待保存预览，每次使用最近确认的revision。保存失败/版本冲突保留当前画面；“检查保存状态，再重试”只有服务器版本未变才继续保存，已保存相同内容则确认成功，另一个窗口的新版本不同则不覆盖。“放弃本次调整，读取已保存摆放”明确告知放弃的是布局偏好。
6. ResizeObserver按组件真实正文高度估算画布范围和新组件落位；“整理成不重叠的单列”必须由本人主动点击。最新用户追加的文档形态已落实：协作文档独立全宽，无新增外层框；画布文档去外框/底色/阴影，正文自然撑开，没有固定height或overflowhidden裁正文。
7. 空间AI唯一稳定宿主独立画布卡片；assistant卡只是用途说明与同一弹窗的打开入口。移除说明卡不会丢失空间AI。弹窗关闭将焦点返回稳定入口，原本人/项目隔离与分享权限不变。
8. 当前任务快照每15秒可见只读刷新，隐藏标签暂停轮询；重新可见时读取。不生成AI、不提交、不改业务状态。待办onOpenNode接S3同一流程处理句柄；共享组件锚点可切回协作视图，避免接收队友未添加卡片而找不到入口。

## 实际验证

- 两个修改TSX的TypeScript语法转换诊断：0错误。
- `node node_modules/typescript/bin/tsc --noEmit --incremental false`：退出0，完整类型检查通过。
- `node --experimental-strip-types --test src/modules/space-workflow/canvas-board.test.ts src/modules/space-workflow/canvas-layout.test.ts`：40/40通过。验证旧布局纯函数的坐标、缩放、折叠、账号/项目隔离及容错保持；不等于新浏览器交互已验收。
- 未build、未重启、未开生产库、未迁移、未修改其他会话文件。

## 根整体验收仍需验证

- 375px真实/模拟手机首屏、全文正常滚动、键盘操作、弹窗焦点与辅助入口。
- 对布局API制造慢响应、断网/未知成功和409后核对串行请求与保留预览；普通wheel网络记录不得出现PUT。
- 两成员执行/交接更新后15秒快照同步，S3主线开合和Root待办/概览使用相同事实。
- 新源码生产构建、追踪清理、单实例安全启停与公网/实体手机结果由主会话负责。

## NEEDS_INTERFACE

已按约定接入 `SpaceCollaborationOverview` 的 detail/current/planningLoading/planningError；S3的 `SpacePathCanvas` presentation与onReady已落地并通过完整typecheck。无新增依赖或环境变量。

## 追加浏览器验收脚本（2026-10-12）

按主会话新增精确授权，仅新增 `tests/e2e/space-redesign.spec.ts`，其他UI文件未继续修改；状态：**测试脚本已交付，STOP**。

脚本使用 `ux-test` / `isolated-workspace`，真实应用handlers、已迁移内存PostgreSQL、浏览器API拦截。页面服务仅供应静态资产；不加载真实凭据、不启动worker、不使用真实模型、不外发邮件、不写生产库。六项场景：

1. 375px默认协作、无全页水平overflow；名称、邀请与单一空间AI可见；Enter/Space打开步骤/助手，关闭焦点返回。
2. 先让项目版本变化，再从就地时间窗表单保存；实查PUT的timezone/windows/本人revision与真实持久90分钟，防止回归为只发effectiveMinutes或项目revision。
3. 只读队友直接阅读48行长文的末行，全文可选、无内部滚动/裁剪，实际clipboard复制；“记入我的待办”就地出现且作者账号看不到该私人备忘。
4. 作者在浏览器允许共享编辑后，队友真实保存新正文；重新查询和作者刷新都得到revision3的新内容，保留原作者。
5. 先种下私人旧坐标/尺寸/scale；普通wheel不发布局PUT、阅读及手机切换不改旧布局；只有打开调整模式并点击“宽一点”才保存，而且仅目标width变化。
6. 归档仍能阅读/复制正文；文档新增/编辑/共享/删除、私人备忘修改、邀请入口不出现；本人时间表单禁用，浏览不发业务写。

定位词来自当前源码：`协作视图`、`我的自由画布`、`空间 AI 助手`、`#space-path-line`、`#space-todos`、`#space-documents`、`#space-document-<id>`、`我能投入的时间`、`复制全文`、`记入我的待办`、`允许队友编辑`、`调整布局`、`空间文档操作`、`宽一点`。

真实已检查：`playwright ... --list`退出0并列出6项；完整 `tsc --noEmit --incremental false`退出0。**未运行浏览器场景**：按主会话要求当前3000仍为旧版，等待根构建与安全重启后运行。建议根命令：`node node_modules/@playwright/test/cli.js test tests/e2e/space-redesign.spec.ts`。复制场景会对当前loopback origin申请浏览器clipboard-read/write权限；浏览器结果和实体手机不能混同。
