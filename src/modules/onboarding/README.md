# 首次登录网站指引

本模块保存每个账号的网站指引步骤与明确完成时间。它不创建参赛项目、不代替报名，不调用模型、GitHub 或私人资料共享。

`OnboardingService(database, clock)` 使用可信 `Actor`：

- `get(actor)` 读取本人状态；无记录返回 `first-login-v1 / stepIndex:0 / revision:0 / completedAt:null`，不初始化数据库。
- `save(actor, {expectedRevision, stepIndex, completed?})` 在同一事务按用户和版本更新；初次写 `ON CONFLICT DO NOTHING`，旧版本返回 `409 ONBOARDING_REVISION_CONFLICT`。
- 步骤范围 `0..5`；只有末步可以明确完成；完成后重看不能清除完成事实。完成只表示用户点击已了解，不证明掌握全部参赛技能。

`schema.sql` 是主会话迁移建议，不会由模块运行。外键为实际的 `auth_users(id text)`。

前端 `FirstLoginGuide` 读取 `/me` 和 `/me/onboarding`，用原生 `dialog` 展示 6 步。不会更改页面 URL。邀请码页面先保留明确接受流程，进入团队空间后继续。未完成进度由服务端保存；`sessionStorage` 仅以账号和版本为键暂缓本标签页，不作为完成状态。`hackathon:replay-first-login-guide` 事件可由账号菜单或导航员触发重看。

运行模块测试：`node --experimental-strip-types --test src/modules/onboarding/service.test.ts`。测试使用独立内存 PGlite；没有打开生产目录或连接第三方。
