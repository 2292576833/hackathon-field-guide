# 首次登录指引：根 API 隔离集成验收

日期：2026-10-09。临时授权仅新增 `src/server/onboarding.integration.test.ts` 与本交付文档。交付后停止编辑，文件交还主会话。

## 已完成与已验证

测试实际 `createApplication`、迁移 027、`OnboardingService` 和 `dispatch` 的组合。每项使用 `createDatabase({})` 创建独立、真实的内存 PGlite 数据库，并在结束时关闭；账号及短期会话为显式测试夹具。没有使用生产嵌入式目录、环境变量或外部服务。

六项集成测试覆盖：

1. 根应用确实应用 `027_user_onboarding.sql`；匿名 GET/POST 均返回 401。首次及重复 GET 返回初始步骤，不创建导览记录，响应保持 `private, no-store`。
2. Alice、Bob 分别保存自己的步骤。请求 query/body 伪造另一账号 `userId` 不能读写他人指引。后续 GET 不修改导览步骤、完成时间、版本或更新时间；DTO 不携带账号或会话内部字段。
3. 未到最后一步不能标记完成；最后一步完成后重复确认及尝试退回第一步均保留原完成事实，不改变完成时间、revision 或步骤，另一账号仍未完成。
4. 旧 revision 写入返回 409 和当前 `latestRevision`。错误 Origin 返回 403；非法步骤、revision、完成标记返回 422，错误方法返回 405，全部不覆盖既有进度。
5. 已撤销的会话和停用账号不能读取或写入指引，已有记录保持不变。
6. 在最初解析到有效 Actor 后注入会话撤销/账号停用，根 `authenticatedResponse` 的事务复核仍返回 401，不初始化或完成指引。

## 执行结果

```text
node --experimental-strip-types --test src/server/onboarding.integration.test.ts
```

结果：6 项通过，0 项失败，约 5.6 秒。

与已有模块测试联合执行：

```text
node --experimental-strip-types --test src/server/onboarding.integration.test.ts src/modules/onboarding/service.test.ts
```

结果：13 项通过，0 项失败；同时保留模块级并发首写唯一胜者、跨服务实例续看等验证。

## 边界与未验证

- 本任务没有修改认证原文件、导览实现、路由、迁移或页面。
- “GET 不写”针对导览状态；认证原有最后活动时间刷新继续保留。
- 测试不发送真实验证码邮件，不调用 DSH，不产生外部费用，不启动/重启生产网站。
- 界面首次自动出现、键盘/手机交互及真实浏览器跨页面续看，由主会话执行最终体验验收。
- PGlite 的真实 SQL/事务验收不代替远程多连接 PostgreSQL 并发验收。

## NEEDS_INTERFACE

无新增接口、迁移或环境变量需求。
