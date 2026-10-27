# 空间助手实际上下文与导航记忆适配交付

日期：2026-10-09。依据宪法 v1.10.0、总体规划 19 与 R03 规划。本轮只新增 `src/server/team-assistant-context.ts`、同名测试和本交付说明，未修改模块、根路由、应用组合、共享契约、迁移或生产数据。

## 已完成

- `createTeamAssistantContextPorts(deps)` 提供与 R03 结构兼容的 `context` 和 `memory`。只通过注入的现有服务 Port 读取 M02/M03/M05、本人画像、R01 私人参赛资料与 R02 有效共享建议；直接 SQL 仅用于活跃账号核对和本人持久导航消息读取，没有导航消息写入或清理。
- 当前空间目标、最小成果、官方确认要求与选择赛道、本人职责、队友明确共享的意愿、本人任务、待本人检查的任务、前置与负责人、相关进度及检查事实进入有界快照。没有生效计划、任务依据已变、职责待确认、依赖缺失和检查依据不足均明确说明，不将未知当待办或完成。
- 私人参赛画像只读取当前本人，扩展资料只投影主要/辅助职责、目的、简历与作品链接。年龄、MBTI、头像字节和邮箱不进入模型上下文，也不进入这份投影的能力分析。
- 本人导航记忆取最新 20 条与最多 40 条实际关键词相关的较旧消息；无有效关键词时取最多 60 条最近消息。查询只针对当前账号，全文留存在原数据库，每次最多选择 12 条、16 KiB 的消息对象，每条正文最多 1,200 UTF-8 字节。关键词检索可以命中最近 60 条之外的已保留记录，不发送全部历史。
- 历史项目来源使用当前活跃成员权限；主会话提供现有 M02 `getMembership` 与 `listProjects` 时，其他空间的读取不获取写锁。来源成员被移除、角色改变、空间归档变化、导航原文修改或删除，在回复提交前复核中都会拒绝旧依据。本人全局导航记录不产生其他账号可见权限。
- 上下文 SHA-256 指纹包括原始事实身份与真实版本，排除本次读取时间与临时求值时间；长文本没有展示的尾部也参与相应记录的校验。有效共享建议撤回、取消共享意愿、任务/私人资料变化会阻止旧回复成为当前答案。
- 读取串行执行并复用根 DatabasePort 的 ambient 事务；账号、请求 guard 和当前空间权限在读取前后检查。Port 失败会抛错，不被替换成空内容；允许明确无权的历史项目候选被排除，并返回覆盖说明。
- 空间快照序列化上限 48 KiB。额外列表按上限/字节缩减时保留说明与原页面入口；工具只提供根固定合法站内入口，不由模型构造地址。

## 准确接口

```ts
const ports = createTeamAssistantContextPorts({
  database, clock,
  projects, // getProject; 建议同时提供已有 getMembership 和 listProjects
  planning, // getCurrent / listProgress
  collaboration, // getMyIntention / getSharedIntentions / getOfficialTracks
  officialRules: officialTrackRules, // getProjectTrackRules(projectId, sql)
  participantProfiles, // get(actor, guard?)
  recruiting: {
    getPrivateProfile: async (actor, guard) => {
      // 根将 R01 的私人公开接口投影为以下结构，不能拷入头像字节等内容。
      return /* PrivateAssistantProfileSource | null */;
    },
  },
  teamCollaboration: {
    readShared: async (actor, projectId, guard) => {
      // 根投影来源仍有效、当前空间可读的建议；撤回的记录可保留 metadata，正文不带入。
      return /* readonly SharedAssistantAdviceSource[] */;
    },
  },
});
```

`ports.context`：

```ts
read(actor: Actor, projectId: string, sql: SqlExecutor,
     guard?: FreshSessionGuard): Promise<SpaceAssistantContextSnapshot>
assertCurrent(actor: Actor, snapshot: SpaceAssistantContextSnapshot,
              sql: SqlExecutor, guard?: FreshSessionGuard): Promise<void>
```

快照为 `{projectId,fingerprint,facts,sources,missing,links,capturedAt}`，直接结构兼容 R03 的 `TeamAssistantContextSnapshot`。`facts` 只含本次实际投影；`sources` 是服务器指定的来源说明；`links` 是固定站内入口。`capturedAt` 不参与指纹。

`ports.memory`：

```ts
select(actor: Actor, input: {
  projectId: string; question: string; maxItems: number; maxBytes: number;
}, sql: SqlExecutor, guard?: FreshSessionGuard): Promise<SpaceAssistantMemorySnapshot>
assertCurrent(actor: Actor, snapshot: SpaceAssistantMemorySnapshot,
              sql: SqlExecutor, guard?: FreshSessionGuard): Promise<void>
```

快照为 `{fingerprint,items,coverage,sources,missing}`，直接结构兼容 R03 的 `TeamAssistantMemorySnapshot`。记录 ID 为真实 `navigator:<数据库消息ID>`，保留来源项目、实际创建时间和提问/回复标识。接受 R03 的 `maxItems:20,maxBytes:16000`，实际输出由本适配进一步限制至最多 12 条，不以较大的调用参数放大边界。

另提供方便主会话调用的 `ports.read(actor,projectId,question,guard?)`，在同一根事务顺序返回 `{context,memory}`；此方法不触发模型。

可选 R01 输入：

```ts
interface PrivateAssistantProfileSource {
  userId: string; revision: number; updatedAt?: string | null;
  primaryRoles?: readonly string[]; supportingRoles?: readonly string[];
  purposes?: readonly string[]; purposeNote?: string; resume?: string;
  workLinks?: readonly {title:string;url:string}[];
}
```

可选 R02 输入：

```ts
interface SharedAssistantAdviceSource {
  id: string; projectId: string; authorUserId: string; revision: number;
  title: string; body: string; status: 'discussion'|'adopted'|'withdrawn';
  updatedAt: string; sourceKind?: string; sourceId?: string|null;
  sourceRevision?: number;
}
```

真实签名及完整已存在服务的结构 Port 在 `team-assistant-context.ts` 中；主会话直接注入实际服务，并对 R01/R02 做上述投影即可。没有可选 Port 时 `missing` 明确标示未提供；已接入 Port 抛错不能当“无记录”。

## NEEDS_INTERFACE 与接入提示

1. 根把 `ports.context`、`ports.memory` 注入 R03，并让请求 FreshSessionGuard 在整个准备和最终保存事务前后执行。R03 Port 方法未声明 guard 参数时，可以保留上层当前请求 guard；本适配也支持可选 guard 直接传入。
2. R01 已出现的 `getProfile()` 会在资料行缺失时创建空行，并返回头像状态。若要求助手 context GET 严格只读，R01 应提供纯 `readPrivateProfile`：缺失返回 `null`，不建行，不返回头像字节；根只投影本文字段。
3. R02 `readShared` 必须只返回当前有效的共享建议。分享来源核验不能循环调用 R03 `getShareSource` 的完整上下文路径，否则会形成“读取上下文→读取团队建议→核验助手来源→重新读取上下文”的递归。应使用独立只读来源 metadata resolver 或 R03 不读取上下文的来源核验 Port。
4. R03 的允许地址需接受真实 `/app/projects/:id/...` 与带相同 `projectId` 的 `/github`、`/roadshow`、`/ppt`；不能把它们误过滤为旧 `/projects` 路由。本适配没有修改 R03 代码。
5. 根已通知移除导航 append 中自动清理至 200 条的逻辑。新历史可完整保留；过去已经删除的历史不能由本适配重建。用户主动清空的实际记录仍会使相应引用失效。
6. 根实际 DatabasePort 必须复用 ambient executor。可选其他空间权限使用只读公共 Port，最终重新检查；多连接 PostgreSQL 在高并发下的跨空间权限变化与锁行为仍须目标环境验收，不把单连接 PGlite 测试当成该环境的并发证明。

## 验证

命令：`node --experimental-strip-types --test src/server/team-assistant-context.test.ts`。测试使用新的内存 PGlite PostgreSQL 引擎、实际账号/导航消息 SQL 和注入的隔离业务 Port，不打开生产目录，不调用模型。

覆盖账号与空间隔离、账号/请求撤权、读取后成员检查、归档保护、属性顺序与时间稳定、共享撤回、取消意愿分享、私人画像和任务变化、未知计划和历史检查事实、跨项目记忆权限/角色/归档变化、230 条留存而只带入有界内容、旧相关记录与最新记录选择、超出最近 60 条的历史检索、导航删除/修改/尾部变化、无关新记录不使旧引用失效、读取失败不当空、UTF-8 与大项目字节上限、空记忆和无效范围、同事务组合读取。

结果及日志：`.runtime/mission-assistant-context-test.log`，最终 **21 项通过**。`npm run typecheck` 本文件与测试没有类型错误；当次全局失败来自并行编辑中的任务板、R03 两处 catch 与 router 的筛选参数，已反馈主会话，未越界修改。日志为 `.runtime/mission-assistant-context-typecheck.log`，最终全局检查由主会话负责。

## 真实边界与交还

已完成适配代码与隔离测试；没有执行生产迁移、构建/重启、外部模型、邮件、GitHub 或真实用户读写验收。实际应用组合、R01/R02 公共方法与 R03 路由/界面验收由主会话接入。无需新增环境变量。

本次授权的三个文件交还主会话；交付后停止编辑，不沿用临时授权。
