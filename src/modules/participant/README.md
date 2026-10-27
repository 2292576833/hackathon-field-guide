# Participant · 个人参赛画像

保存本人填写的参赛经验、城市、技能、兴趣、想法、每日可用工时、出行与演讲偏好。画像可以保持空白或不完整，账号登录不依赖画像完整度。生成计划所需信息由计划入口引导填写，本模块不调用模型，不建立第二份 AI 产物。

同轮 `src/components/participant-profile.tsx` 导出 `ParticipantProfileForm({onSaved?,requireForPlan?})`，独立 GET/PATCH `/api/v1/me/participant-profile`，可用于账号页与计划页。`onSaved(profile)` 可通知父页面刷新；`requireForPlan` 仅提供首次参赛、开发经验、城市、每日时间大于 0 的填写引导，允许部分保存。版本冲突保持本地输入，读取最新版作对照后才允许重新保存；组件不发送 owner 字段。组件及实际组合验收边界见 `docs/协作/交付/participant.md`。

## 服务接口

```ts
import { createParticipantService } from "./index.ts";
import type { ParticipantProfileUpdate } from "./index.ts";

const service = createParticipantService({ database, clock });
const current = await service.get(actor, freshRequestSessionGuard);
const next = await service.update(actor, input satisfies ParticipantProfileUpdate, freshRequestSessionGuard);
```

- `createParticipantService({ database: DatabasePort, clock: Clock }): ParticipantService`。
- `get(actor: Actor, guard?: FreshSessionGuard): Promise<ParticipantProfile>`。未保存时返回服务器提供的空画像：`revision: 0`、`updatedAt: null`，不执行 INSERT。
- `update(actor: Actor, input: ParticipantProfileUpdate, guard?: FreshSessionGuard): Promise<ParticipantProfile>`。输入包含 `expectedRevision` 和全部可编辑字段；完整替换。首次保存预期版本为 0，成功版本为 1，后续每次成功加 1。
- `validateParticipantProfileUpdate(value: unknown): ParticipantProfileUpdate`。HTTP 和服务均使用此运行时校验，返回已 trim 的字段与独立标签数组。

`ParticipantProfileUpdate` 为 `Omit<ParticipantProfile, "userId" | "revision" | "updatedAt"> & { expectedRevision: number }`。其余类型来自主会话的 `src/shared/participant.ts`；本人身份始终由服务器 Actor 决定，不允许输入 owner、userId、revision、updatedAt 等额外字段。

每次读写使用 `database.transaction`，先锁定当前活跃且已验证的 `auth_users`，再调用传入会话 guard；读取或写入之后在同一事务再次检查。身份锁顺序与现有服务保持一致。HTTP 集成必须提供绑定当前请求的 guard，不能复用另一请求的 Actor/guard。失效会话导致事务回滚。

无画像账户以 revision 0 参与乐观锁。首次 INSERT 使用 `ON CONFLICT DO NOTHING RETURNING`，后续 UPDATE 使用 `WHERE user_id=$1 AND revision=$expected RETURNING`。过期版本返回 409 `PARTICIPANT_PROFILE_CHANGED`，附本人 `latestRevision` 与 `recoveryAction: reload_profile`。

## 字段与边界

| 字段 | 输入 |
| --- | --- |
| `expectedRevision` | 0 至 2,147,483,646 的安全整数 |
| `firstHackathon` | boolean 或 null |
| `developmentExperience` | none / beginner / project / experienced / null |
| `city` | 字符串，最多 80 个字符；可以为空 |
| `skills`, `interests` | 各最多 30 项，每项 1–80 个字符；trim 后不能重复 |
| `projectIdea` | 字符串，最多 4,000 个字符；允许换行，可以为空 |
| `availableHoursPerDay` | 有限数字 0–24 或 null，单位小时；允许小数 |
| `travelPreference` | undecided / rail / flight / local |
| `presentationExperience` | none / some / confident / null |

字符串拒绝控制字符与无配对代理字符；城市和标签为单行。数组稀疏项、非字符串、缺失字段和未知字段均拒绝。清空画像使用这些字段的空值与当前版本保存，不删除账号或重置版本。

## 独立 HTTP 工厂

```ts
const handlers = createParticipantHandlers({
  service,
  origin: configuredPublicOrigin,
  resolvePrincipal: async request => {
    // Main server reads its verified cookie and creates a session-bound SQL guard.
    return { actor, guard };
  },
  requestIds,
});
```

- `getProfile(request)` 仅 GET；`patchProfile(request)` 仅 PATCH；`handle(request)` 接受 GET/PATCH。
- 建议挂载 `/api/v1/me/participant-profile`。成功为 `{ data: ParticipantProfile, requestId }`；失败沿用共享 ErrorEnvelope。
- PATCH 严格要求 Origin 等于配置的完整 HTTP(S) origin。禁止从 Host、转发头或请求 JSON 推导允许源。
- `resolvePrincipal` 返回 `ParticipantPrincipal | null`，Principal 中 `actor` 和 `guard` 均由服务器提供；guard 必填。
- 默认 JSON 字节上限 65,536，可用 `maxJsonBytes` 下调。拒绝压缩体、错误 Content-Type、非法 UTF-8/JSON，并在流读取期间执行上限。
- 响应 `Cache-Control: private, no-store`；使用共享 `isDomainError` 保留跨 bundle 的领域错误状态；未知异常不透出内部详情。

## 持久化与验证

`migrations/001_participant_profiles.sql` 是供主会话编排的迁移建议，不曾执行到实际数据库。仅增加 `participant_profiles`，主键/FK 为 `auth_users.id`；已有账号无需补行。

运行 `npm test -- participant`：17 项测试使用 Node `node:test`。服务测试在无 dataDir 的临时 PGlite PostgreSQL 引擎运行实际 SQL；HTTP 测试用注入服务验证请求边界。失败版本比较也会在回传 latestRevision 前执行最终 guard。测试不打开 `.runtime/postgres-data`，不启动服务器，也不调用真实邮件、模型或第三方服务。

PGlite 的同引擎竞争测试证明版本比较与 SQL 路径，不能替代线上 PostgreSQL 多连接并发/锁验收。模块无需新增环境变量；数据库、公开 origin、会话解析与请求 ID 由主会话注入。
