# T02 任务与交接交付

日期：2026-10-09。依据宪法 v1.7.0、规划16与 `docs/规划/团队空间/T02-任务与交接.md`。本轮仅使用 T02 临时授权。

## 已完成

- `src/components/team-task-board.tsx`：默认与我有关，本人合法可开始任务优先；无生效计划隐藏空筛选，提供选择职责与填写时间入口，读取失败与归档另作说明。
- 默认卡片显示任务名、负责人、计划时间、状态、交付要求、最近成果与进度和当前主动作。工时、协助者、检查者、检查条件、资源、历史与纠错位于“任务详情、检查与更多操作”。
- 主要动作按当前任务与身份显示：开始、提交成果请队友检查、补充成果说明、检查通过或按条件自检。成果报告仍写 `review`，检查通过仍写 `done`，没有新建完成状态。
- 等待项来自现有 `unmetDependencies`，显示真实前置名称、负责人、当前状态与检查说明。定位切全队和全部状态并聚焦目标；被删减前置会展开已删减区域，缺失前置不会生成空链接。
- 可以先做仅来自当前计划有效、本人负责、活跃成员、已排时间且前置满足的既有 `ready` 任务。计划失效、未排时间、待检查或取消任务不会补造建议；归档空间不建议执行。
- 保留开始条件、验收证据与自检说明、误勾、更正请求、管理员影响确认、历史、10秒可见读取、隐藏时停止/取消、失去权限清除。写入403/404/409后读取最新；版本冲突保留说明、依据和估时，明确采用最新记录后才继续。误勾恢复同时重绑最新报告 `correctionOf`，避免采用新版本却引用旧报告。
- 进行中任务在详情可“更新进度与剩余工时”，不必为了保存阶段进展改报待检查或阻塞。
- `src/modules/planning/task-guidance.ts`：纯展示 helper，直接显式 `.ts` 导入，没有修改共享类型、导出或原任务板规则。按 TaskKind 解释 GitHub 保存运行、审核资料、PPT、路演、灵感、技能、空间资料和提交入口用途；私人材料保留本人及主动采用/分享说明，安装与试做分别说明。
- `src/components/team-task-board.module.css`：独立卡片、等待与详情样式，小屏主动作铺满可用宽度，长文本换行，保持键盘焦点可见。

## 已验证

- `node --experimental-strip-types --test src/modules/planning/task-guidance.test.ts src/modules/planning/task-board.test.ts src/modules/planning/progress-correction.test.ts`：27/27 通过，其中新 helper 11 项。覆盖未检查/已检查、缺失/取消前置、计划失效、未排时间、无合法并行项、资源用途与路由编码，以及现有验收、纠错、权限与并发规则。
- `node node_modules/typescript/bin/tsc --noEmit --incremental false`：本轮核对通过，没有写增量缓存。交付前将新e2e也纳入严格 noEmit 的检查仅报告并行模块 `src/modules/space-workflow/service.test.ts:333`：`"not_saved"` 不能赋给 `GitOperationStatus`；T02 文件无诊断。该共享目录仍由其他会话编辑，未越界修复，此时完整检查不算通过。
- `node node_modules/@playwright/test/cli.js test tests/e2e/team-space-tasks-v2.spec.ts --list`：静态收集7项成功；没有运行测试或浏览器。
- 只读交叉审查核对权限清空、10秒读取、合法 ready、定位过滤和并发输入；发现的更正引用与普通进度入口问题已修复。

## 模拟测试与浏览器验收

新增 `tests/e2e/team-space-tasks-v2.spec.ts`，7个独立用例，复用 `isolated-workspace.ts` 的隔离 PostgreSQL fixture 与真实业务 handler，页面API全部拦截，外网请求阻断。涵盖无计划、375px折叠卡与等待定位、开始/阶段进度/交成果/检查和自检交接、失效计划、八种TaskKind资源、并发说明/依据/估时恢复、误勾重绑最新报告、成员更正请求及管理员验收纠错、可见读取与成员移除。只编写并静态核对，未执行浏览器；不把编译或单元测试视为手机布局和贯通验收。

## 未接入／未验收

- 按本轮约定未 build/start/重启、未实际迁移、未打开生产 PGlite、未收费AI或真实外部写入。生产构建、独立e2e执行、截图和最终整体验收由主会话完成。
- 未做实体手机、公网证书、真实外部服务或新人试用验证。
- 旧 `tests/e2e/ux-space-invitation.spec.ts` 仍精确查找“我已完成”。产品文案按要求改为“提交成果，请队友检查”，todo 的直接提交移到详情，主会话需调整旧用例的展开动作与按钮断言。T02 不修改旧测试。

## NEEDS_INTERFACE

无新增跨模块或后端接口。`TeamTaskBoard` 的既有 props 与所有HTTP写入契约保持可接入；内部直接使用新 helper 的 `buildTaskGuidance`、`dependencyGuidance`、`taskResourceGuidance`。主会话不需新增路由、依赖或迁移。

## 环境变量名称

无新增生产环境变量。浏览器用例沿用 `E2E_BASE_URL`，限制为 loopback 页面服务器；不读取真实模型、邮件或远程数据库凭据。

## 文件交还

交付后停止编辑并交还 T02 所有文件。最终运行与验收记录由主会话补充。
