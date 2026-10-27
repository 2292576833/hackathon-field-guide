# 主办方与赛事登录返回路径交付

日期：2026-10-11。内部代理 `organizer_auth_context`，主会话临时授权仅覆盖 `src/modules/auth/service.ts`、`src/server/auth-return-context.test.ts` 与本文件。已完成并停止编辑，文件交还主会话。

## 已完成

- 登录/注册使用的 `safeAuthReturnTo` 保留 `/organizers`、`/organizers/workspace`、`/competitions`、`/admin/organizers`。
- 保留 `/competitions/:eventId`，以及该赛事下的 `register`、`teams`、`help`、`schedule`、`services`、`submit`、`results`；保留 `/judging/:eventId`。
- 新赛事 ID 限定为 1–128 个 ASCII 字母、数字、下划线或连字符，精确匹配已登记页面；不增加任意子路由通配。
- 新入口不保留任何 query/hash，包括 token、pairToken、returnTo、next、额外赛事 ID。原有技能、资源、演示、GitHub、参赛画像等白名单行为不变。
- 拒绝外部绝对 URL、协议相对 URL、编码路径、双重编码、反斜杠、控制字符、路径穿越及多余子路径，统一回退 `/app`。路径本身只选择目的地，不赋予主办方、评委或赛事权限。

## 已验证

运行：

```powershell
node --experimental-strip-types --test src/server/auth-return-context.test.ts src/modules/auth/return-to.test.ts src/modules/auth/service.test.ts src/modules/auth/registration.test.ts
```

47 项通过，0 失败。新增用例覆盖全部规划入口、不同赛事目的地保持、128/129 字符边界、跨 URL/编码绕过、敏感/未知参数及任意子页面；既有注册、登录、会话与返回路径用例同时通过。

## 验证范围与未接入

本次是纯返回路径函数和既有依赖注入账号服务的 Node 测试，没有连接实际数据库、发送验证码、构建或重启站点。新页面/API、当前赛事角色复核、移动端登录后进入原赛事的浏览器验收由主会话组合完成，不能把本次测试视为页面已挂载或真实账号登录成功。

## NEEDS_INTERFACE

无新增 Port、数据库迁移或环境变量。根页面若以后需要通过 query 保留正式业务上下文，应另行明确允许的字段和值域，不能直接放宽返回 URL。当前规划目的地均通过稳定路径表达。
