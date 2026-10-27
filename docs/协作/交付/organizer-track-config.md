# 根官方赛道配置交付

日期：2026-10-11。临时独占仅新 `src/server/organizer-track-config.ts`、`.test.ts`、`organizer-track-schema.sql` 与本交付。未修改O02或其它模块、app/application/router/shared/实际根迁移/配置/依赖，未打开生产库、build、重启、发送模型请求或外部发布。O02可信`getUsedTracks`由主会话实现。

## 已实现

- `createOrganizerTrackConfig` 返回真实持久 `EventTeamTrackPort`，只读取同executor当前赛事/机构限定的根表；未配置返回`configured:false/required:false/revision:0/options:[]`，不生成或猜测官方赛道。
- 当前`event_manage`工作人员GET/PUT配置。变更前先根Origin授权、真实Principal，服务事务前后复核当前账号/请求会话和赛事权限，锁序沿用组织→赛事→赛道配置。GET不写库、不初始化默认记录。
- PUT仅`expectedRevision/required/options`；最多20个固定`{id,title}`，ID唯一且小写字母开头，允许字母、数字、短横线和下划线，最多50字符；标题100字纯文本。不执行HTML、表达式、动态脚本或模型建议，保持调用者选项顺序。
- 默认首次revision0→1，已有配置严格CAS。每次成功配置同事务写不可变版本记录：操作者、时间、before/after、event/organization/revision。共享赛事锁串行化并发首次创建和修改，失败guard或版本冲突整笔回滚。
- 通过O02可信只读`getUsedTracks(sql,eventId)`核对真实形成/锁定队伍。当前被使用的ID不能删除；有空赛道队伍时不能改为必选，保持现有参赛资格。中文错误给出保留已使用赛道/先保持选填的恢复动作。
- 已结束比赛不能修改赛道，既有配置保留。参赛侧选择/校验实际复用同`tracks` Port，不建立另一套赛道或名单状态。
- HTTP精确路径，JSON流16KiB上限、压缩正文拒绝、错误方法405/Allow，安全ErrorEnvelope与private/no-store响应，无额外连接/生产内存回退。

## 根接入

```ts
const trackConfig = createOrganizerTrackConfig({
  database: DatabasePort,
  clock: Clock,
  ids: IdGenerator,
  getEvents: () => organizerIntegration.events,
  getRegistration: () => organizerIntegration.registration,
  resolvePrincipal: rootResolveCurrentPrincipal,
  assertMutationAllowed: rootOriginGuard,
});
// 创建组合时将 trackConfig.tracks 注入 createOrganizerIntegration({ tracks: ... })。
```

循环getter只在实际请求后调用，根可先声明integration，再创建trackConfig后创建integration。`getRegistration()`要求`getUsedTracks(sql,eventId):Promise<string[]>`，必须读取O02原始队伍选择，不能反向调用依赖赛道Port的`team/getTeam`形成递归。

返回`tracks`、`get(principal,eventId)`、`save(principal,eventId,input)`、`handle(request,decodedSegments)`。

| 方法/路径（相对/api/v1） | 输入 | data |
| --- | --- | --- |
| GET /organizer/events/:eventId/tracks | 无 | `{configured,required,revision,options}` |
| PUT 同上 | `{expectedRevision,required,options:[{id,title}]}` | 同上，新revision |

根UI可以使用普通选项行/名称编辑和是否必选开关，用户无需JSON。未匹配路径返回null，根全局request bounding仍负责超时与统一入口；此HTTP再限制16KiB实际读取。

## SQL建议

`src/server/organizer-track-schema.sql`仅为根实际新增递增迁移的输入，尚未在生产库执行：

- `organizer_track_configurations`：event主键、organization范围、revision、required、options。
- `organizer_track_versions`：event/revision唯一、changed_by账号FK、时间、before/after审计；UPDATE/DELETE不可变trigger。
- 赛事/机构组合FK指向O01，确保不会把另一个组织的赛道配置附到当前赛事。

主会话安排实际新编号并迁移，不覆盖已应用SQL。本模块无新环境变量。

## 已隔离验证

```powershell
node --experimental-strip-types --test src/server/organizer-track-config.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

**7/7通过，全仓TypeScript通过。** 使用新内存PGlite、实际O01/O02持久服务和本SQL，O02`getUsedTracks`是主会话实际实现，不复制队伍业务逻辑。测试不读.env、不打开既有PGlite或执行根migrate。

1. 默认未配置GET无写；工作人员保存后O02真实建队选项/校验使用相同配置，编造ID拒绝。
2. 两组织三赛事、普通账号/报名职能/admin无继承、事件范围管理、匿名、Origin、405、当前会话撤销。
3. 同revision并发只一笔成功，另一笔409，唯一版本与before/after审计一致，真实SQL不可变约束。
4. 形成/锁定队已选ID均不能删除，保留已选ID可增选项、更新名称，不降低真实队伍资格。
5. 已有空赛道的锁定队保持选填与有效资格，必选变更409且配置revision不变。
6. 未知字段、重复/坏ID、超20项、必选空列表、最终guard失败均无半笔配置或审计。
7. 比赛结束后冻结编辑并保留既有配置。

PGlite并发为单实例事务演练，不能替代线上多连接PostgreSQL、根认证/router/UI和真实手机验收。真实生产迁移、页面接入、构建重启及公网仍由主会话完成。

**已停止编辑上述新文件并交还主会话；临时授权不继续延伸。**
