# J03 参赛路线图浏览器验收

日期：2026-10-09。负责人：路线图｜浏览器贯通验收（J03）。依据：AGENTS.md、宪法 v1.6.0、参赛树状路线图规划、J03 验收规划与本轮并行登记。

## 当前状态：验收完成，已停止编辑并交还

J00 已明确本轮新版生产页面 ready，地址 `http://localhost:3000/journey`；J03 随后运行 10 项隔离浏览器场景并保存/检查实际截图。首轮 7 项通过、3 项因测试白名单漏列全站导航员本人历史读取而失败；复核实现并修正 J03 白名单后，只重跑这 3 项，全部通过。当前 10 个场景均有实际通过记录，**不是同一轮无失败的 10/10 记录**。

J00 随后明确 **compact ready**。J03 仅重跑游客树结构及 375px 布局两个受影响场景，2 passed，5.1 秒；截图已覆盖为压缩版，初版截图另外保留。**10 个场景经首轮及定向复测均通过，最终 compact 只实跑了这两项，其余 8 项没有再次执行**。阶段快速定位在首屏，阶段正文标题仍在 900px 首屏下方，坐标详见下表；没有把该项写成已进入首屏。

仅新增以下授权文件：

- `tests/e2e/journey.spec.ts`
- 本交付文件 `docs/协作/交付/journey-acceptance.md`

没有修改组件、路由、共享夹具、配置、依赖、迁移或运行库；没有构建、重启、安装、发送真实邮件、调用付费 DSH、操作真实仓库或向其它会话发消息。内部只读复核代理已经结束，未编辑文件。

## 已完成的测试准备

10 个 Playwright 场景覆盖：

1. 游客 1280px 浏览树根、三个阶段、阶段内行动及嵌套资源；逐个资源检查可读用途；展开并读取阶段注意事项。
2. 375px、减少动效模式下检查换行与横向溢出；根动作至少 44px；实际 Tab 到每个行动/资源链接，检查可见焦点；Enter 激活三个阶段锚点并检查目标进入视口。
3. 首页、比赛、我的参赛、工具与资料的正文入口实际点击到路线图（4 个场景）；主导航保持三项。
4. 路线图正文每个不同内部目的地实际点击、读取标题、检查无 404；至少包含 events/app/participation/resources/inspiration/skills/github/roadshow/ppt，复盘先到真实空间选择入口；不制造 projectId。
5. 路线图账号入口保留 `/journey`，分别完成隔离登录与注册后返回（2 个场景）。仅显式验证码流程允许 auth POST；返回后刷新另行断言只读。
6. 已登录账号和另一账号各有夹具空间，浏览/刷新指南不选取或查询项目、不展示私人目标、不生成或写入业务数据。

每个场景使用现有 `isolated-workspace.ts`：无持久目录的内存 PostgreSQL、真实迁移、真实 application/router handlers；所有 `/api/v1/*` 在已 attach 的 context 内分派。额外阻断未来出现的非 v1 API；外部浏览器请求全部阻断。没有 `page.request` 绕过拦截。

路线图读取只允许 `GET me`、`GET me/permissions`、`GET system/status`、`GET navigator/intro`、`GET navigator/conversation`。最后一项来自既有全站 Navigator，读取本人的已有 DSH 对话，不发起模型调用；额外阻断带 `projectId` 的 conversation 请求。请求记录区分指南阅读和明确登录行为。业务表用行数与内容指纹前后核对，避免仅用静态假结果或不变行数证明未写入；不输出数据库内容、验证码、邀请或会话令牌。

浏览器拦截不覆盖页面服务器自行访问外部服务。准备及最终 compact 阶段均静态复核 `src/app/(site)/journey/page.tsx` 只组合公开目录、JourneyTree 与 SiteShell，不读取运行库、不调用 getApplication。夹具服务未配置真实模型、邮件或 GitHub 传输，也不启动 worker。

## 已验证与实际结果

- **已验证（准备检查）**：`node node_modules/@playwright/test/cli.js test tests/e2e/journey.spec.ts --list --output=.runtime/journey-results` 成功发现 10 个测试；仅为解析/枚举，不是浏览器运行。
- **首轮实际浏览器**：Edge（Playwright `channel: msedge`、headless），10 项，7 passed / 3 failed，20.5 秒。日志 `.runtime/journey-acceptance-2026-10-09.log`。
- **登录场景复测**：修正测试白名单后仅执行 login/register/signed-in 三项，3 passed，6.5 秒。日志 `.runtime/journey-acceptance-recheck-2026-10-09.log`。
- **最终 compact 定向复测**：仅执行 guest reads / 375px tree 两项，2 passed，5.1 秒。日志 `.runtime/journey-acceptance-compact-2026-10-09.log`。折叠的规则说明默认关闭，实际展开后读取依赖/进度/私人材料边界再收起；阶段注意事项默认关闭、展开正文可读。没有无必要重跑其它 8 项。
- **三项失败的原因与修正**：断言 `assertGuideReadOnly` 收到 `GET navigator/conversation`，原准备白名单只含四项。静态复核 `src/components/navigator.tsx` 与 `src/server/router.ts` 确认来源为既有本人对话历史；修正仅在 J03 的测试中增加该 GET，同时拒绝项目作用域参数，保留对所有生成、写入与项目读取的拒绝。没有修实现来通过测试。
- **请求与数据结果**：游客及已登录指南读取无生成/写接口、无项目接口、无外网请求；入口与全部目的地继续仅发 GET；显式隔离登录/注册分别仅允许对应 auth challenge/verify POST；读取前后业务表行数与内容指纹一致，未新增空间、个人计划、AI 执行/费用、仓库或提交事实。验证码保存在夹具 development mailbox，未发送真实邮件。
- **功能结果**：树根/三阶段/行动/逐项资源说明、注意事项实际展开、四个入口、所有不同内部目的地、复盘空间准备路径、三主导航、登录/注册返回、私人目标不泄露、无虚构 ID 与进度控件全部通过。
- **交互结果**：375 与 1280px 均无横向溢出；375 下根按钮至少 44px、原生 Tab 到每个指南链接、可见焦点、三个锚点 Enter 激活及目标入视口均通过；减少动效模式通过。
- **类型检查/20 项 Node 回归/生产构建**：J00 ready 消息报告已通过；J03 未自行运行或重启，不把这个消息等同于 J03 重复独立验证。
- **真实服务**：本轮测试隔离服务，不证明真实 DSH、邮件、GitHub 或远程 PostgreSQL 并发。

## 首版截图视觉检查

两种视口均在 `scrollY=0` 保存首屏及全页，图片内容只包含公开指南与游客调试提示：

| 图 | 实际观察 |
| --- | --- |
| `journey-initial-desktop-1280-top.png` / `-full.png` | 居中树根下接横向分叉，再连接赛前/赛中/赛后三枝；行动纵向主干和进一步缩进的资源连接线清楚。中文正常换行，无明显裁切、重叠或溢出。首屏 900px 仅到树根，阶段分枝位于下方。 |
| `journey-initial-mobile-375-top.png` / `-full.png` | 左侧纵向主干连接起点和阶段；行动节点、资源子枝缩进可辨。说明、并行提示与资源用途可读，未见横向拖拽需要；三阶段注意事项入口分别标注 4/4/3 条。全页约 10967px，首部仍较长。 |

截图未展示键盘焦点和展开的提醒正文，这两项由实际浏览器断言证明。首部浏览成本由 J00 接手改善，J03 没有越界改组件。

## 最终 compact 截图与首屏坐标

最终顶部及全页截图：

- `.runtime/previews/journey-desktop-1280-top.png`
- `.runtime/previews/journey-desktop-1280-top-full.png`
- `.runtime/previews/journey-mobile-375-top.png`
- `.runtime/previews/journey-mobile-375-top-full.png`

坐标在 `scrollY=0`、所有 4 个说明/注意事项 details 关闭时测量，视口高度均为 900px。坐标为标题边框左上角 `(x, y)`，单位 CSS px；原始记录分别在 `.runtime/journey-layout-desktop-1280-top.log` 和 `.runtime/journey-layout-mobile-375-top.log`。

| 视口 | 树根标题 | 赛前正文标题 | 赛中正文标题 | 赛后正文标题 |
| --- | --- | --- | --- | --- |
| 1280×900 | (335, 587.75) | (86, 946.34) | (474, 946.34) | (862, 946.34) |
| 375×900 | (59, 667.97) | (56, 1061.42) | (56, 4794.77) | (56, 8811.05) |

实际视觉复核：桌面树根完整进入首屏，根到三枝的横向连接线可见，三阶段顶部边缘接近首屏下沿；**阶段标题仍在首屏外**。手机首屏已能读到简化介绍、折叠规则入口、三个阶段定位、树根和根动作，首个正文阶段仍需向下滚动。手机全页约 10824px，较初版减少约 143px；整体仍是长指南，不记录为大幅缩短。

完整截图继续显示桌面横向三枝和手机左侧纵向主干，行动与资源通过连接线、节点、缩进关联，**是树状父子层级，不是互不关联的卡片网格**。中文换行正常、用途和可并行提示清楚，未见裁切、重叠或横向溢出。精确溢出、键盘、锚点、默认折叠与展开正文由两项浏览器断言再次验证通过。

## Ready 后运行约定

测试默认跳过，避免旧版服务器被误判；跳过不视作通过。主会话明确 ready 后，在同一 PowerShell 会话设置 `JOURNEY_READY=1`，以实际 loopback 页面服务设置 `E2E_BASE_URL`（若不是默认 `http://localhost:3000`），执行：

```powershell
$env:JOURNEY_READY = '1'
node node_modules/@playwright/test/cli.js test tests/e2e/journey.spec.ts --output=.runtime/journey-results
```

运行日志写 `.runtime/journey-*.log`；页面截图写 `.runtime/previews/journey-desktop-1280-top.png`、`journey-desktop-1280-top-full.png`、`journey-mobile-375-top.png`、`journey-mobile-375-top-full.png`。截图前断言 `scrollY=0`。认证场景不截图，关闭 trace、video 与自动截图，防止记录夹具验证码或会话。

最终压缩版实际使用如下定向命令，结果已补充；未执行全 10 项重跑：

```powershell
$env:JOURNEY_READY = '1'
node node_modules/@playwright/test/cli.js test tests/e2e/journey.spec.ts --grep 'guest reads|375px tree' --output=.runtime/journey-results
```

未发现需要越界修复的功能或安全失败；首屏阶段正文尚在下方作为实际布局观察保留。没有扩大真实外部调用、服务重启或数据库操作。最终 `git diff --check` 两个授权文件通过（仅 Git 提示 Windows 后续将 LF 转为 CRLF）。

## 未接入与验收边界

公网证书已有 `UntrustedRoot` 限制；受信任公网 HTTPS、实体手机登录/扫码仍未验收。375px 是真实桌面浏览器视口，不能代替实体手机或公网证书通过。

## NEEDS_INTERFACE

无新增业务接口需求或待执行依赖。J00 已给出 ready 与 compact ready，两次均沿用其 loopback 地址；J03 没有主动启动或重启服务。

## 环境变量名称

仅 `JOURNEY_READY`、可选 `E2E_BASE_URL`。不读取 `.env.local`，不需要数据库、模型、邮件、GitHub 的真实密钥。

## 编辑与交还

最终定向复测、截图视觉检查及报告已完成。**已停止编辑** `tests/e2e/journey.spec.ts` 与 `docs/协作/交付/journey-acceptance.md`，两文件交还主会话；本轮 J03 临时授权结束，不继续沿用。内部只读截图代理也已结束，未编辑文件。
