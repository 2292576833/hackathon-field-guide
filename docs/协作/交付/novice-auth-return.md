# 萌新全流程：登录回跳上下文修复

交付日期：2026-10-09。仅修改获授权的 `src/modules/auth/service.ts`、`src/modules/auth/return-to.test.ts` 和本交付文档。交付后停止编辑，文件交还主会话。

## 已完成

- 资源目录及详情页的登录回跳保留合法筛选与分页：`search`、`type`、`stage`、`stack`、`prerequisite`、`use`、`costType`、`sort`、`limit`、`cursor`。
- 枚举、搜索长度、分页范围对应 `src/modules/resources/navigation.ts` 的公开地址契约；不跨模块导入私有文件，避免把资源服务依赖带进客户端。
- GitHub 图形教程回跳允许 `/github?projectId=<安全 ID>`，保留所属团队空间。
- 选比赛到空间的明确导航允许 `/app?event=<安全 ID>` 与 `/app/projects/<安全 ID>/rules?discovery=<安全 ID>`；三个 ID 均为 1–128 个字母、数字、下划线或连字符。这两种赛事导航要求未编码 ID。
- 未知 query、重复字段（含编码后的同名字段）、不合法枚举/分页值、控制字符、外站、路径编码/穿越、额外 `next`/`returnTo` 参数回退到 `/app`。
- 合法资源搜索按 query 数据处理，中文、空格、`&` 等以 `URLSearchParams` 规范编码；不会把搜索内容作为跳转目的地。
- 保留既有登录、注册、邀请、技能、路演/PPT 等回跳行为；不改身份验证、凭据、用户或会话操作。

## 已验证

执行：

```text
node --experimental-strip-types --test src/modules/auth/return-to.test.ts src/modules/auth/service.test.ts src/modules/auth/registration.test.ts
```

结果：41 项通过，0 项失败。新增 4 个回跳测试分别覆盖资源上下文、无效资源字段、安全赛事/GitHub 上下文、重复/编码/外站绕过拒绝；既有注册验证与认证服务测试继续通过。

## 验证边界

- 使用 Node 内置测试与认证测试夹具，无外部邮件、DSH 或生产数据库调用。
- 未构建、启动、重启或发布网站；浏览器真实验证码回跳由主会话整体验收。
- 首次登录导览由另一任务处理，本修复只保证导览/登录后可返回用户原本的合法目的地，不创建导览完成状态。

## NEEDS_INTERFACE

无新增服务接口、迁移或环境变量。若资源筛选契约未来新增字段或枚举，需要同步该精确白名单及回跳测试。
