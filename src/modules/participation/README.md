# 个人参赛计划

本模块用服务器读取的赛事线索、本人 `ParticipantProfile` 和真实天气 Port 生成个人计划草案。业务生成只通过注入的 `PersonalAiPort`；本模块没有模型 HTTP、静态 AI 降级、数据库连接或后台采集。

## 公开工厂

```ts
createParticipationService({ ai, profiles, events, weather, clock })
```

- `ai: PersonalAiPort`：主会话提供账号隔离、DSH、预算、未知请求 hold、存储及生成前/采用前会话校验。
- `profiles.get(actor, guard?) -> Promise<ParticipantProfile>`：读取本人画像。需要本地持久实现，并支持在 AI 校验事务中嵌套读取。
- `events.get(id) -> Promise<ParticipationEvent | null>`：主会话从真实保存的赛事 discovery 快照适配；不可由前端提交赛事对象。
- `weather.getForecast({city,eventStartAt,now}) -> Promise<WeatherSnapshot>`：主会话提供城市解析和 Open-Meteo 真实预报。这里只校验，不能生成天气。
- `clock.now() -> Date`：用于快照时间和建议日期。

方法：`getContext(actor,eventId,guard?)`、`generate(actor,{eventId,projectIdea?,supplement?},guard?)`、`list(actor,guard?)`、`get(actor,id,guard?)`。最后两者直接委托私有 AI 存储，list 固定 `participation_plan`。个人记录 get 不额外重定义存储权限或 kind 过滤。

所有字段类型从 `index.ts` 导出。浏览器只导入 `types.ts`、`markdown.ts`，避免把服务工厂打入前端。

## 事实和建议

- `event.eventDate` 是原始文字，绝不解析成精确开赛时刻。精确 `eventStartAt`、结束、提交、报名时刻仅接受带 `Z` 或偏移的完整合法 ISO。
- `supplement` 只支持 `city`、`eventStartAt`、`mode`，只影响本份 `facts`，标记 `user_supplement`；原始 event 不改写。
- context 仍可在画像不完整时读取；生成前必须具备 `firstHackathon`、`developmentExperience`、非空 `city`、大于 0 且不超过 24 的 `availableHoursPerDay`。错误含缺项和 `/app/account#participant-profile` 补全入口。其他字段由模型结合实际值或明确未知处理。
- 所有模型建议经过严格字段白名单；五阶段顺序固定，每阶段 1–12 项，总数最多 40。任务时长 5–480 整数分钟、建议偏移 0–90 整数天，按服务器生成日和规划时区计算日期，负责人固定本人。所有任务同日估时合计不得超过画像声明容量；不声称核对了具体空闲窗口或任务依赖。
- 模型不能输出赛事或天气对象、事实日期、URL、金额或量化天气。文本对精确/模糊/中文数字日期、URL、温度、百分比、金额、资格/场地陈述及定性天气断言作确定性拦截。叙述建议每句需明确以建议、请、若、如或待核对/待确认开头；自由文字的完整语义不能靠正则证明，因此页面持续标明建议与待核实。官方资格、费用和报名从不被自动确认。
- 报名、费用、入场、规则和提交有五项独立核实动作；链接固定由服务器来源/报名入口提供。作品截止未知时必须显示核实提醒，不能用报名截止、开赛或结束日期替代。
- 日期均是建议安排，工时均为估算；没有自动创建 M05 团队计划、应用计划、报名、订票或提交。

## 天气

线上赛不强制出行，天气不获取，模型出行数组必须为空。缺城市、缺精确时间或绝对相差大于 17 天/早于 2 天时不调用天气 Port；临界范围由真实城市解析后的地点时区判断，避免用上海显示时区拒绝外国城市的有效预报。采用的预报仅限地点的今天至第十五天；远期或过去的日期显示范围不足。请求失败、过期六小时、异常地点/时区、非官方来源、错误指标或未覆盖开赛当天，返回 `unavailable`，不把其他日期或气候均值替代为预报。

官方资料（2026-10-09 查阅）：[Open-Meteo Forecast API](https://open-meteo.com/en/docs) 支持最多 16 天的预报，日统计需时区；[城市解析文档](https://open-meteo.com/en/docs/geocoding-api) 支持多个城市候选和行政区限定。城市歧义由根适配器返回 `ambiguous_city`，不得仅以第一个搜索结果认定地点。服务仍对根适配结果复核边界。

## 前端组合

授权组件 `src/components/participation-client.tsx` 导出 `ParticipationClient({eventId?:string})`，由根页面从 `/participation?event=<id>` 取值。

API 均有既有 `/api/v1` 前缀与 `{data,requestId}` 包装：

| 方法与路径 | 返回 |
| --- | --- |
| GET `/me/participation/context?eventId=...` | `ParticipationContext` |
| POST `/me/participation/plans` | `PersonalArtifact<ParticipationPlan>` |
| GET `/me/artifacts?kind=participation_plan` | `PersonalArtifact[]` |
| GET `/me/artifacts/<id>` | `PersonalArtifact` |

读取只读不生成。明确生成按钮会 POST；赛事卡片真实点击写 `sessionStorage('participation:generate-event',eventId)` 时，页面可消费该一次性授权，在登录且画像齐全后 POST 一次。直接 URL、刷新或失败不自动生成；缺画像时消费授权并要求补全后明确点击。页面提供加载/空/错误/登录态、历史快照、复制失败可选文本、打印和 Markdown 下载。

## 验证与持久化

```powershell
node --experimental-strip-types --test src/modules/participation/*.test.ts
npm run typecheck
```

68 项 Node 测试使用内置框架和注入夹具；没有调用真实 DSH、天气、数据库或实际运行目录。全局 `npm run typecheck` 通过。根 `021_personal_dsh_workspaces.sql` 已定义 `personal_ai_artifacts.kind='participation_plan'` 和账号索引，本模块无需第二张计划表。模块 `migrations/001_participation_storage_contract.sql` 仅为组合建议，不能当成已执行迁移。

生成前与采用前经 `PersonalAiPort` 执行包裹 guard：校验请求会话并重读本人的画像 revision，画像变化拒绝采用旧资料。原始 profile get 在采用事务内应锁定当前 revision，或提供同事务的版本检查；本模块不直接读取其他模块表。

提示词版本为 `participation-plan-v2`：已根据主会话首轮真实 DSH 返回的 priority 错误，明确 `must/optional` 等全部枚举、数组和字段白名单；严格校验保留。此修订尚需主会话的新一轮真实 DSH 验收。

本模块无独立环境变量。主会话应提供既有 DSH、数据库配置及真实天气适配，并完成真实调用、HTTP 与页面贯通验收。采用期画像行锁及稳定未知请求身份见 `docs/协作/交付/participation.md` 的 NEEDS_INTERFACE。
