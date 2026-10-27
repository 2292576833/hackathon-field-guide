# 主办方正式收件 → M03/M06 可信桥交付

日期：2026-10-11。首轮文件范围仅 `src/server/organizer-delivery-bridge.ts`、同名测试及本文；后续根授权新增 `src/server/organizer-router-acceptance.test.ts`，仅追加隔离验收，不修改功能源码。

## 已完成

- `createOrganizerDeliveryBridge` 返回必须同时接入 O04 的 `submissionLinkContext` 与 `verifiedSubmissions` 两个 Port。
- HostedEvent 必须明确配置 `linkedEventId`，正式队伍必须明确关联 `projectId`；没有任意一项时 `resolve` 返回 `null`，不阻断 O04 独立的正式收件，也不伪造 M03/M06 记录。
- 真实关联存在时，重新读取当前主办方赛事与正式队伍；锁定 M02 项目，核对当前活跃成员及只读状态；读取 M03 真实确认指针与当前公开规则版本。完整要求版本使用根 `confirmedRequirementVersionId`：`eventId:rulesVersion:confirmationRevision`，不会退化为数值规则版本。
- 正式规则中须有且只有一个 submission/pitch 阶段，入口精确对应可信服务器 origin 下的 `/competitions/:eventId/submit`。赛事或阶段不对应、公开版本已更新、确认缺失、历史规则不可用时拒绝平台核验。
- `recordReceipt` 再次读取上述事实，不能接受另一个赛事、空间、规则确认、阶段或未经证明的 commit SHA。
- M06 `platformUrl` 来自真实确认规则的 `submissionUrl`；回执只接受相同正式收件入口的唯一 `receipt` 参数，作为 `evidenceRefs` 保存。不是外部链接，也没有虚构 `/submissions/:receiptId` 页面。
- 用 M06 公共 `PostgresDeliveryStore` 写 `platform_verified` / `verified`；未修改用户公开 `DeliveryService` 的 `user_reported` 限制。代码未下载/执行项目或调用 GitHub。
- 回执采用稳定 M06 ID `hosted-intake:<receiptId>`。同事实重放复用已有记录，不同材料/时间/关联事实拒绝覆盖。
- M03/M06 适配器绑定调用方传入的 `SqlExecutor`，不会借另一条连接。外层 O04 事务负责提交/回滚，失败不会遗留 M06 头、版本或事实事件。

## 根接入

```ts
const bridge = createOrganizerDeliveryBridge({
  projectsRepository: projectRepository,
  hostedEvents: { getEvent: (...args) => integration().events.getEvent(...args) },
  participation: { getTeam: (...args) => integration().registration.getTeam(...args) },
  clock,
  origin: config.authOrigin,
});
// 将 bridge 的两个 Port 同时交给 createOrganizerIntegration。
```

示例中的 `integration()` 是根持有的延迟 getter；实际属性名以根集成对象为准。不得通过客户端 Host/转发头推断可信 origin。工厂要求 HTTPS origin；固定 HTTPS 公网地址用于正式平台核验。

M03/M06 默认适配器在每次调用中使用传入事务的受限 DatabasePort。测试/根可选传入 `createEventsRepository(database)` 与 `createDeliveryStore(database)` 工厂，但必须绑定收到的 database；不得用独立连接池替代。

## 验证

- `node --experimental-strip-types --test src/server/organizer-delivery-bridge.test.ts`：7/7 通过，含参数化子场景：未映射、错赛事、陈旧公开版本/确认、归档/撤权、歧义阶段、错误回执地址、重放冲突、最终会话失效回滚。
- 使用实际隔离 PGlite、M02/M03/M06 公共持久适配器和根迁移，验证 M06 头/版本/事实事件同事务写入、正式收件后续失败回滚以及公开用户伪造 `platform_verified` / `verified` 仍拒绝。
- `node node_modules/typescript/bin/tsc --noEmit --incremental false`：通过。未生成新的构建产物。
- 根已新增 `049_verified_hosted_submissions.sql` 后，隔离数据库验证通过；本代理没有修改迁移或访问生产数据库。

## 实际边界与未验收

- 网站路由、O04 根组合、真实数据库迁移和公网体验由主会话执行。本交付只证明隔离测试中的可信桥行为，不宣称已有线上正式收件。
- `repositoryCommitSha` 保留 `null`：近期保存的 Git commit 不能证明它是本次提交链接代表的代码版本。正式收件不等于代码运行或文件已下载核验。
- 没有新增环境变量或秘密。依赖现有可信服务器 `AUTH_ORIGIN`。

## NEEDS_INTERFACE

无新增公共接口要求。依赖已存在 M02 `getPlanningContextForUpdate(sql)`、HostedEvent `getEvent(sql)`、正式队伍 `getTeam(sql)` 与 O04/M06 公共契约。

已交付并停止编辑，三个文件交还主会话。

## 追加：真实根路由验收

`src/server/organizer-router-acceptance.test.ts` 使用 `createDatabase({})` 的全新内存 PGlite，以及实际 `createApplication`、`dispatch`、根全部迁移（包括 042–050）。配置显式为本地 loopback、夹具 pepper、开发邮箱；不读取 `.env.local`，不打开真实数据库。测试显式禁止 `fetch` 外部请求。

2/2 场景通过：

1. 实际邮箱注册挑战 → 私有开发邮箱取验证码 → 注册验证与真实 Cookie 会话 → 机构申请 → 平台管理员审核 → 创建发布比赛 → 官方报名 → 建队锁定名单 → 私人求助与官方回复 → 正式收件预览/确认/幂等回执 → 根评委账号查询 → 根人工关系核查 → 指派复核 → 评委本人无关联申报 → 人工评分 → 锁定预览 → 公布结果。验证 `/me/competitions`、`/me/judging-competitions` 及公开结果；没有关联 M03/M02 的正式收件真实成功，而 M06 记录为 `null`。
2. 多机构、多赛事隔离；匿名与错误 Origin 拒绝；私人问题不被公开或跨机构读取；本赛事权限不扩展到其他比赛；员工授权撤回立即失效；已停用目标账号的授权追加及机构 revision 一起回滚；缓存的平台管理员 Principal 在当前角色移除后被事务 guard 拒绝；停用账号及撤销的真实会话不能继续访问私有赛事内容。

执行：`node --experimental-strip-types --test src/server/organizer-router-acceptance.test.ts`。TypeScript 全局检查通过。只验证实际应用组合在隔离环境中的行为，没有构建、重启或生产数据库操作。

本轮追加验收已完成并停止编辑，测试文件和本文交还主会话。
