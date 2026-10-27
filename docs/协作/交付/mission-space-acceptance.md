# 任务式空间浏览器验收

准备日期：2026-10-09。实际浏览器执行：2026-10-10（北京时间）。主会话新授权仅新增 `tests/e2e/team-mission-space.spec.ts` 与本交付文件，不沿用此前工作台组件所有权。

## 完成结果

收到主会话 `BUILD_READY`（新版生产构建成功并重启在 `http://localhost:3000`）后执行：

```text
npx playwright test tests/e2e/team-mission-space.spec.ts --output .runtime/e2e-mission-space-results
```

结果：**4/4通过，9.0秒，退出码0，没有重试**。日志：`.runtime/mission-space-e2e.log`。没有因构建后的UI更改而放宽断言或删除用例。

## 已验证用例

1. 375px三工作区键盘切换（方向键、Home/End）、44px tab、邀请入口、未生效计划下草案任务词条池、检查条件说明、单人准备、375/1280无横向溢出、浏览不写项目或任务状态。
2. 空间AI与导航员分别打开/关闭、空间草稿保留、UI回复与有界记忆覆盖、私人回复没有自动发布到团队动态、没有向导航员发送同一问题。
3. 未知DSH请求结果可见、输入保留、同一问题禁发、显式核对仅GET保存状态、关闭再打开仍保持未知提示，不自动重试或假称成功。
4. 本人等待队友Demo时，唯一可并行任务被作为主要下一步展示；等待区不能同时误称没有并行任务。

使用既有 `isolatedWorkspace` 的独立内存PGlite与真实认证/项目处理器，浏览器全部API被隔离拦截，外部请求被阻止。任务池为界面草案投影夹具；助手对话GET、context和messages均为明确UI夹具，未知结果也是503注入。没有调用真实DSH、发送真实邮件、访问生产PGlite或写入真实用户项目。

第4项的当前计划/规则/赛道为明确UI投影，管理员和成员加入事实来自隔离真实处理器；此项只检查任务依赖和并行提示在工作台中的呈现，不冒充真实比赛或已生效生产计划。测试准备时发现原等待区用剩余次要行动数量判“无并行工作”，若唯一可做任务已放主卡片会出现矛盾；已报告主会话修正为检查全部合法行动，测试保留此回归断言。

本用例只验证浏览器工作区与独立助手UI的组合，不验证真实模型质量、真实导航记忆继承的后端覆盖、成员撤权并发或真实主办方交付；这些需要根和对应模块验收。

四项均验证没有外部网络请求。第1与第4项页面操作只发送GET，项目/计划事实未被浏览改变；第2与第3项没有自动团队分享POST，AI使用账本仍空（人工回复/故障API被拦截，不是真模型）。未知请求只发送一次，通过保存状态核对、关闭再打开仍阻止同问重发；独立导航员没有收到空间提问。测试仅在隔离内存数据库准备账号、项目与成员，未写生产数据。

截图关闭默认自动捕获，只主动输出隔离项目的工作台、私人夹具回答、故障夹具对话截图到本次Playwright结果目录；截图没有真实验证码、邮箱授权码、邀请令牌或个人信息。已用本地 `view_image` 查看手机工作台、唯一并行任务、私人回答与未知请求四张截图：内容可读，无横向截断，弹窗关闭按钮固定可见，长对话可正常滚动。桌面和手机无横向溢出也有浏览器断言。

给主会话视觉复核的同内容副本（原始PNG未编辑）：

- [.runtime/previews/mission-workbench-375.png](F:/黑客松情报局/.runtime/previews/mission-workbench-375.png)
- [.runtime/previews/mission-workbench-1280.png](F:/黑客松情报局/.runtime/previews/mission-workbench-1280.png)
- [.runtime/previews/mission-parallel-375.png](F:/黑客松情报局/.runtime/previews/mission-parallel-375.png)
- [.runtime/previews/mission-private-assistant-375.png](F:/黑客松情报局/.runtime/previews/mission-private-assistant-375.png)
- [.runtime/previews/mission-unknown-assistant-375.png](F:/黑客松情报局/.runtime/previews/mission-unknown-assistant-375.png)

已报告的“唯一并行任务放到主卡片后误称没有并行任务”由主会话修正，第4项新构建实际通过。分享按钮已改明确确认发布、收到成功提示；本套用例只证明私人回答未自动共享，不把按钮文案复核当作真实来源分享/采纳验收。真实DSH调用与记忆后端验收由主会话另行记录。

环境变量新增：无。未build/start、迁移、安装依赖或修改其它文件。

本任务交付完成并停止编辑，两个授权文件交还主会话。
