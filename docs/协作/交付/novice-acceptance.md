# P04 新人入口隔离验收

日期：2026-10-11。依据规划23、宪法 v1.14.1 与主会话当次临时授权。状态：交付完成，STOP；测试文件交还主会话。

## 本轮文件

- `tests/e2e/journey.spec.ts`：更新四主导航、辅助资源先关闭再展开、完整用途与键盘链接、正式赛事 `/competitions` 去向。资源数量动态读取，未写死新增后的数量。
- `tests/e2e/first-login-guide.spec.ts`：更新标题；完成指引从账号菜单“网站使用指引”重看；未完成保留全局入口；保留六步持久化、暂停、换账号、邀请原去向与错误恢复；新增真实正式报名表的登录/注册优先返回及手动指引保存行为。
- 新 `tests/e2e/novice-entry.spec.ts`：320/390/1280px 访客首页三去向、四导航、醒目主办方入口、无需自动弹出介绍；320px 无空间创建和单个真实备赛空间继续；读取失败保留错误并重试；未保存创建输入不得被收起，明确清空后才折叠。

## 已验证

主会话提供新版页面服务 `http://127.0.0.1:3012/` 后运行授权的三文件，共 **24/24 通过，0 跳过**，最终运行 43.6 秒。测试文件直接 TypeScript 严格检查通过；Playwright `--list` 收集 24 个用例。

最终浏览器命令：

```powershell
$env:E2E_BASE_URL = 'http://127.0.0.1:3012'
$env:JOURNEY_READY = '1'
$env:FIRST_LOGIN_GUIDE_READY = '1'
$env:NOVICE_ENTRY_READY = '1'
& 'C:\Program Files\nodejs\node.exe' node_modules/@playwright/test/cli.js test tests/e2e/journey.spec.ts tests/e2e/first-login-guide.spec.ts tests/e2e/novice-entry.spec.ts --output=.runtime/novice-entry-results
```

首轮 21/24 通过的三处失败为测试准备/选择器问题，均修正后复跑：预建登录账号触发验证码冷却；鼠标展开后的程序焦点尚未进入键盘模式；全页 alert 选择器匹配 Next 路由播报。前者只将该目标邮箱在自有 fixture 的 rate row 时间回退61秒以表示已冷却账户；保留真实账号、限流记录与登录处理器。键盘检查先经原生 Shift+Tab/Tab，再检查每条链接的可见焦点。错误提示限定 main，不降低业务错误断言。

## 隔离和事实边界

复用 `isolated-workspace.ts`：每用例独立内存 PGlite，运行真实迁移、账户、组织审核/发布、报名表、项目与指引根处理器；浏览器全部 `/api/v1/*` 由 fixture 接管，跨 origin 请求一律拦截。无生产连接、外部邮件、付费模型或后台 worker。验证码只读 fixture 开发邮箱。未构建、启停服务、执行生产迁移或访问生产库。

正式报名用例真实创建并发布比赛/表单，验证登录与注册保留 `returnTo`；手动下一步只写网站指引，报名仍未提交、没有额外团队空间，未保存报名文字保留。创建用例只在本人 fixture 中真实创建首空间并进入对应路由。继续用例通过真实 `draft → preparing` 规则准备单个未归档空间。

读取失败仅对 GET `/projects` 注入503，再交回真实 fixture 验证显式重试。默认完成指引的工作区回归由 fixture 预置其已完成事实；首登/正式报名用例明确关闭该预置并实际操作未完成指引。

公开指引仍校验无私人项目选择、无私人项目详情读取、无额外写操作及数据库业务指纹不变。现有全局导航员读取本人可访问空间列表用于明确分享，白名单允许其 GET `/projects`；主页面不展示私人目标/其他队伍事实，不允许项目定向对话或详情读取。

## 产物与未覆盖

- `.runtime/novice-entry-browser.log`：最终24通过的标准输出。
- `.runtime/novice-entry-results/`：独立测试输出目录，避免与根其他回归覆盖。
- `.runtime/previews/novice-home-320.png`、`novice-home-390.png`、`novice-home-1280.png`：页首访客截图，无私人数据。已目视320px和桌面截图；主要操作无横向溢出，顶部主办方入口可见。
- 现有 `.runtime/previews/journey-*`、`first-login-guide-375.png` 和 `.runtime/journey-layout-*` 在适用用例中生成。

本轮结果为隔离浏览器与源码测试验收，不代表生产部署、公网DNS、实体手机、远程PostgreSQL或真实邮件/模型已经通过。私人材料/空间导航的其他回归及部署最终结论由主会话组合。主办方入口可见不增权限，原权限测试由根保留，不重复镜像。

NEEDS_INTERFACE：无。新增环境变量仅为测试 readiness 与页面地址，不新增生产配置。

STOP：不再修改已交还组件、内容、公共文件或本轮测试；文件所有权交还主会话。
