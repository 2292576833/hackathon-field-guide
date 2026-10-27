# 首次登录网站指引交付

交付日期：2026-10-09。所有临时授权文件交付后停止编辑；实际应用接入、迁移、构建、启动与最终浏览器验收归主会话。

## 已完成

- 新增 `src/modules/onboarding/` 纯模块：6 步内容、状态契约、PostgreSQL 读写、服务、索引、SQL 建议、README、Node 测试。
- 新增 `src/components/first-login-guide.tsx` / CSS。首次登录且未完成自动展示，明确 1/6 至 6/6；上一步、下一步、末步“了解了，继续刚才的操作”；手机布局、原生模态键盘约束、返回焦点、Escape/稍后继续。
- 未完成状态按账号持久化，GET 无初始写；初始并发仅一个 revision0 写入成功；旧版本不能覆盖；完成后只手动重看，不清除完成事实。
- 关闭未完成导览只暂缓当前标签页，账号/版本隔离。邀请码页先处理明确接受，再进入空间继续，不修改 URL、token 或 `returnTo`。
- 保存失败保留本地当前步骤并提供明确重试；409 重新读取版本；401/403 清除指引状态；读取/保存 12 秒超时，避免按钮持续无反馈。
- 新增 `tests/e2e/first-login-guide.spec.ts` 覆盖首登完整流程、原去向不变、换设备不重复、重看无写入、手机键盘/暂停恢复、换账号隔离、邀请优先、保存失败和登录失效清空。

## 已验证

- Node 模块测试 7/7 通过（隔离内存 PGlite）：只读初始、跨实例恢复、账号隔离、初始并发、更新冲突、末步完成和不可撤销完成、非法输入拒绝。
- `npm run typecheck` 通过（包含最终新增 e2e）。

## 模拟测试与未接入边界

模块测试为真实 SQL 引擎的隔离测试。主会话已接入并真实执行浏览器组：六步、跨设备、账号隔离、邀请优先、失败恢复首轮通过；375px Tab 循环首轮发现浏览器焦点可经过 body，交付代理已补显式首尾循环，等待主会话重构建后复验。以主会话最终验收为准。e2e 需设置 `FIRST_LOGIN_GUIDE_READY=1`；未设置时是等待而非验收通过。交付代理没有启动服务、build、真实迁移、邮件、DSH、仓库或生产 PGlite。

## NEEDS_INTERFACE

1. 主会话复制 `src/modules/onboarding/schema.sql` 到新实际迁移 027（后续序号若变化以根为准），保持已应用迁移不变。
2. 应用组合 `onboarding: new OnboardingService(database, clock)`。
3. `GET /api/v1/me/onboarding` 返回 `OnboardingState`，必须复核登录，取可信 Actor；不可使用 query/body 用户 ID 选择目标用户。
4. `POST /api/v1/me/onboarding` 读取 `{expectedRevision,stepIndex,completed?}`，同事务复核会话和活跃账号再保存；遵循现有同源检查/错误 envelope。客户端不传 version/userId。
5. 在 SiteShell 挂载 `<FirstLoginGuide/>`；已登录时停止旧 Navigator 自动介绍，保持手动导航员和公开介绍。导览不会主动收起别的 dialog，所以根需要避免双弹窗。
6. 如账号菜单需要“网站指引”入口，`window.dispatchEvent(new Event("hackathon:replay-first-login-guide"))`；组件自身已有可达重看按钮。
7. 旧独立 fixture 默认 rememberIntroduction=true 时，可把该测试账号的导览状态明确标为完成，避免旧回归被新 modal 阻挡；首登测试自行 `attach(context,false)` 并真实点击六步。

## 浏览器合同

- dialog accessible name：`第一次参赛，先认识网站`。
- 连点 5 次 `下一步`，最后 `了解了，继续刚才的操作`；保存中显示 `保存进度…` 且禁用。
- 重看按钮：`重新看网站指引`；暂缓后按钮：`继续网站指引`。
- 邀请路径 `/app/join/[token]` 不自动弹，显示 `先处理队友邀请，进入团队空间后会继续网站指引。`。

## 环境变量

生产模块无新增环境变量。独立浏览器测试的就绪开关为 `FIRST_LOGIN_GUIDE_READY`，页面服务地址复用 `E2E_BASE_URL`；均不包含密钥。
