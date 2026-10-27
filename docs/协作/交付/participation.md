# participation · 个人参赛计划交付

日期：2026-10-09。临时授权范围：`src/modules/participation/`、`src/components/participation-client.tsx`、`src/components/participation.module.css` 和本文。未修改其他模块、根 app/server/shared、实际迁移、配置或依赖；未启动/重启服务器、打开实际 `.runtime/postgres-data` 或输出凭据。

## 已完成

- `index.ts` 公开工厂与类型；README、关键 Node tests、模块迁移建议。
- `createParticipationService({ai,profiles,events,weather,clock})`；画像必需项、原始赛事/本人补充/建议的来源区分、纯 JSON 输出校验、固定本人负责人、日工时合计、阶段建议日期、风险和备选、报名/费用/入场/规则/提交五项核实、路演与 PPT 准备。
- 线上赛不安排旅行；真实天气对象由根 Port 获取后校验；模糊日期、远期或失败无生成天气。临界预报范围按解析城市时区核对，不能按上海显示时区误判外国城市。
- 暖白橙红、手机可用页面组件，登录/加载/空/错误态，DSH 等待文字，私有历史读取、打印、复制失败可选文本和 Markdown 下载。
- 赛事卡片一次性点击授权：消费 `sessionStorage('participation:generate-event',eventId)`，仅登录且画像齐全后生成一次。直接打开 URL/GET/刷新不会收费；缺资料或失败不自动重试。StrictMode 与微任务、同步 ref 锁防重复发送。
- 修正主会话首轮真实 DSH priority 失败：当前 `promptVersion = participation-plan-v2` 明确所有字段类型和枚举，特别是 `priority: "must" | "optional"`、`acceptance: string[]`；没有放宽校验。画像入口已改为 `/app/account#participant-profile`（根表单已含该 section id）。

## 工厂及依赖

`createParticipationService(deps: ParticipationDependencies): ParticipationService`

| 注入 | 方法/含义 |
| --- | --- |
| `ai: PersonalAiPort` | root 提供预算控制的 DSH、账号隔离、生成前/采用前 guard 和私有 artifact 持久化。模块没有直接 HTTP 或静态生成。 |
| `profiles` | `get(actor:Actor,guard?:FreshSessionGuard):Promise<ParticipantProfile>`，画像由当前账号读取；与 AI 采用事务复用同一 executor。 |
| `events` | `get(id:string):Promise<ParticipationEvent|null>`，root 适配服务器真实读取的 discovery 快照；不接受客户端赛事对象。 |
| `weather: WeatherPort` | `getForecast({city:string,eventStartAt:string,now:string}):Promise<WeatherSnapshot>`，root 提供真实城市解析/Open-Meteo；模块校验固定。 |
| `clock: Clock` | `now():Date`，用于读取时刻与建议日期。 |

服务方法：

| 方法 | 返回/行为 |
| --- | --- |
| `getContext(actor,eventId,guard?)` | `Promise<ParticipationContext>`；只读，画像不完整仍返回缺项。远程读取前后均通过 profiles.get 复核权限。 |
| `generate(actor,{eventId,projectIdea?,supplement?},guard?)` | `Promise<PersonalArtifact<ParticipationPlan>>`；缺必需画像或已过的已知作品提交截止在 AI 前拒绝。AI 包裹 guard 重读画像 revision，变化拒绝采用。 |
| `list(actor,guard?)` | `Promise<PersonalArtifact[]>`，直接 `ai.list(actor,'participation_plan',guard)`。 |
| `get(actor,id,guard?)` | `Promise<PersonalArtifact>`，直接 ai.get；私有账号隔离由 Port 执行。 |

## 完整数据契约

精确类型在 `src/modules/participation/types.ts`，下面列出全部公开数据字段。

`ParticipationEvent` 必需字段：`id,title,summary,eventDate,location,sourceUrl,registrationUrl,status`。`eventDate/location/registrationUrl` 可为 null；eventDate 是原始来源文字。
可选字段：`city,eventStartAt,eventEndAt,submissionDeadline,registrationDeadline,timeZone,mode,registrationStatus,fetchedAt,evidence`。日期时刻需含 Z/偏移；不从日期文字猜测。`mode` 为 `online/offline/hybrid/unknown`；`evidence` 为文字数组。未知可省略或 null；root 不得拿报名、开赛或结束时间代替作品提交截止。

`GenerateParticipationInput`：`eventId`；可选 `projectIdea`（最多 4000 字）；可选 `supplement:{city?,eventStartAt?,mode?}`。补充开赛时间需完整 ISO 含时区，mode 限 online/offline/hybrid。服务器只覆盖有效 facts，原始 event 不改写；所有补充持久标明 `user_supplement`。

`ParticipationContext`：

- `event:ParticipationEvent`，归一化来源快照。
- `profile:ParticipantProfile`，本人生成输入快照，含共享契约的全部字段及 revision。
- `weather:WeatherSnapshot`，仅真实根 Port 返回并通过校验的预报，或明确无预报状态。
- `currentTime:string`（服务器 ISO）、`planningTimeZone:string`（来源有效时区或明确说明的 Asia/Shanghai 显示 fallback）。
- `profileHref:string`，当前固定 `/app/account#participant-profile`。
- `missingProfileFields:('firstHackathon'|'developmentExperience'|'city'|'availableHoursPerDay')[]`；availableHours 要大于 0 且不超过 24。首次参赛 false 也是已填。
- `facts:{city,eventStartAt,mode,submissionDeadline}`；各项为 `{value:T|null,origin:'event_source'|'user_supplement'|'unknown',note:string}`。
- `notices:string[]`，未知开赛/截止/方式、来源未核验、用户补充、显示时区及其他上下文说明。

`WeatherSnapshot`：`status,provider:'open-meteo',requestedCity:string|null,location:WeatherLocation|null,days:WeatherDay[],fetchedAt:string|null,sourceUrl,note`。
status 为 `available/outside_forecast_window/date_unknown/city_unknown/ambiguous_city/unavailable/not_needed`。
`WeatherLocation` 全字段：`name,country,admin1:string|null,latitude,longitude,timeZone`。
`WeatherDay` 全字段：`date,weatherCode,temperatureMinC,temperatureMaxC,precipitationProbabilityMax:number|null,windSpeedMaxKmh:number|null`。采用时只保存开赛当天、地点时区下今天至第十五天的有效预报，不用其他日期或气候均值替代。

`ParticipationPlan`：

- `schemaVersion:1,status:'draft',title,projectIdea,context:ParticipationContext`。
- `phases:ParticipationPhase[]`，五阶段按 prepare/build/roadshow/submit/review 顺序。
- phase 全字段：`kind,title,startDate,endDate,tasks`；日期为服务器依据 dayOffset 计算的建议安排。
- task 全字段：`id,title,owner:'本人',ownerUserId,durationMinutes,dayOffset,plannedDate,deliverable,acceptance:string[],priority:'must'|'optional'`。时长 5–480 整数分钟，offset 0–90 整数天，每日全任务相加不超过本人声明小时。
- `travel:{required:boolean,reason,suggestions:string[],checklist:string[],weatherAdvice:string[]}`；required 由有效参赛方式固定，online 三数组必须为空。
- `risks:{risk,mitigation,fallback}[]`。
- `verification:{kind:'registration'|'fees'|'entry'|'rules'|'submission',action,status:'needs_confirmation',sourceUrl}[]`；链接由服务端来源固定。
- `roadshow:{suggestions:string[],pptChecklist:string[],rehearsalChecklist:string[]}`。
- `assumptions:string[],notices:string[],estimatedTotalMinutes:number,scheduleBasis:'suggested_dates'`。

外层 `PersonalArtifact<ParticipationPlan>` 遵守共享契约：`id,kind:'participation_plan',title,data,createdAt,provider:'dsh',sessionId`。JSON 校验函数同步、无 DB/网络/函数值返回；context 和最终保存数据均为纯 JSON 快照。

## root API 与页面组合

保留既有 `/api/v1` 前缀、`{data,requestId}` 包装、no-store、可信 Actor、FreshSessionGuard 和 mutation Origin 边界。

| 路径 | 服务/结果 |
| --- | --- |
| GET `/me/participation/context?eventId=...` | getContext -> context，无模型收费。 |
| POST `/me/participation/plans` | 请求 GenerateParticipationInput，generate -> PersonalArtifact<ParticipationPlan>。 |
| GET `/me/artifacts?kind=participation_plan` | 既有 PersonalAiPort.list -> 数组。 |
| GET `/me/artifacts/<id>` | 既有 PersonalAiPort.get -> 单记录，按账号隔离。 |

页面 `ParticipationClient({eventId?:string})` 由 `/participation?event=<id>` 的 root 路由传 query。root 已告知页面/API、赛事卡片入口和真实点击标记完成组合；此模块未修改这些根文件。
浏览器只导入 `types.ts` 和 `participationPlanMarkdown(plan)`，没有服务工厂或密钥。计划永远是个人草案，不写 M05 团队生效计划、M03 确认、M06 提交状态。

重要错误：`PARTICIPANT_PROFILE_INCOMPLETE` 422、`PARTICIPANT_PROFILE_CHANGED` 409、`PARTICIPATION_EVENT_NOT_FOUND` 404、`PARTICIPATION_DEADLINE_PASSED` 422、`INVALID_PARTICIPATION_INPUT` 422、`INVALID_PARTICIPATION_OUTPUT` 502。未核实请求/预算/DSH 不可用错误由 Port 原样上抛；前端不自动重试未知请求。

## 已验证、模拟与未接入

- 68 项 Node 测试通过：画像缺项不收费、长读取与采用前会话复核、画像改变拒绝采用、跨账号记录隔离、用户补充与旧来源保存、线上无旅行、真实数据形状/远期/临界跨时区天气、模型事实覆写/中英文日历日期/资格与天气断言拒绝、日容量合计、截止未知与已过校验。
- `npm run typecheck` 全局通过。
- UI 子代理在隔离浏览器夹具完成 StrictMode 单次生成、刷新不收费、缺画像禁生成、未知结果不重试、401 清除已选计划、复制失败恢复、手机无横向溢出和打印检查。均为模拟 API，不是实际 DSH/持久化成功记录。
- 本模块没有运行真实数据库、DSH、天气网络、容器或在线多连接 PostgreSQL。主会话已反馈首轮隔离账号/内存 DB 的真实 DSH smoke 失败（priority 不正确），已修 v2 提示词；v2 新一轮真实验收需主会话完成，不把 v1 失败当成功。
- 根 `021` 已定义私有 artifacts 与 participation_plan 枚举，`022` 定义画像。模块迁移建议文件无 DDL、未执行，无重复表或内存生产存储。
- 日期与工时是建议，未完成具体空闲窗口、休息、跨项目占用和任务依赖的排程证明；页面明确说明，不能宣称保证完成。

## NEEDS_INTERFACE

1. **画像采用期原子 revision 保护（root/participant 所有权）**：现有 `profiles.get(actor)` 在 generationGuard 中检查 revision，但实际 participant 的 SQL 只 SELECT、不锁画像行。在线 PostgreSQL 另一连接可在检查后、artifact INSERT/COMMIT 前改画像。请由 owner 将采用事务内的读取保持画像行 `FOR SHARE` 至最终 artifact commit，或提供 `assertRevision(actor,expectedRevision,sql)` 等同事务校验 Port。完整画像才能生成，所以正常生成不会采用空 revision=0；如扩大范围到空画像，还需保护首次插入。例：生成快照 revision=2，期间改为 3，则采用必须 409，不持久化旧结果。模块未越界直接读 participant 表。
2. **未知付费请求的稳定身份（root PersonalAiPort 所有权）**：当前根请求 hash 对完整 input JSON 做 hash；context.currentTime、天气 fetchedAt 每次都会变化。同赛事/画像/想法重新点击会形成不同 hash，可能绕过旧 unknown 防重放。请根 Port 按账号、kind、真实赛事内容版本、画像 revision、想法和用户补充建立稳定语义身份，排除瞬时读取时间；promptVersion/跨日变化也不能解除原未知 hold。此模块页面不会自动重试，但仅客户端保护不能替代服务器 unknown hold。例：同赛事同输入请求未知，刷新或再次点击后仍拒绝自动派发，需管理员明确核查/授权新尝试。
3. **最终真实验收**：root 已有真实 weather.getForecast 和 discovery 适配；需用 v2 进行一次真实 DSH 计划生成/私有保存/读取与页面显示，并验证多连接采用期画像并发。根据实际源字段仅传精确时间；未知城市/方式保持未知，让用户补充，不从 summary 猜测。

## 环境变量名称

本模块新增环境变量：无。依赖 root 既有配置，名称为 `DATABASE_URL`（连接部署）、`AI_PROVIDER`（此个人 Port 固定 DSH 的组合由 root 控制）、`DSH_DESKTOP_DIRECTORY`（本机 Desktop 模式）或 root 的 DSH API/容器配置。没有记录任何值；天气免费/商业使用资格和额度由 root 依据官方资料配置，本模块不采购服务。

交付时已停止子代理编辑；主会话可接管授权文件。后续未收到新的明确修复任务前不沿用本次授权修改根或其他模块。

## 2026-10-09 v6 输出投影修复

主会话本次临时授权修改 `validation.ts`、`service.ts`、`service.test.ts` 与本交付文档。旧负责会话已交还文件。

- 原校验器遇到 DSH 附加阶段日期、任务负责人或核实状态字段，会在核对实际建议前拒绝整份结果。现只投影各边界明确需要的建议字段，额外模型元数据不采用、不展示、不保存；服务器仍固定本人身份、任务 ID、规划日期、来源链接、真实天气、核实状态与总工时。
- 必需字段使用 own-property 校验，不从原型继承，不把 `items` 等别名变成任务。整个响应先核对 JSON 可编码性与 100 KB 上限，再做投影，不能借丢弃元数据接纳过大或循环结构。
- 保持五阶段顺序、每阶段一至十二项任务、总任务上限、单任务分钟和相对天数范围、每日容量、已知提交截止、线上出行空数组与保留文本事实校验。模型空任务、缺字段、非法类型或超时估算均拒绝，不静态补造任务。
- 提示词升级 `participation-plan-v6`：明确 tasks 必须非空，不输出服务器保存结构；赛事信息不完整或冲突时给出核对动作与建议任务，不能用空阶段和解释字段替代计划。
- 本轮 `service.test.ts` **129/129** 通过，属于注入模型/天气/存储的模拟测试。覆盖所有层次的额外身份/事实元数据不采用、五种空阶段、别名/必需字段缺失、大响应/循环 JSON 和既有权限、天气、容量行为。
- 全局 typecheck 本轮尚未完成：仅报告主会话正在接入邮件模块时 `config.ts` 和 `email-config.ts` 找不到 `smtp-mail.ts`，没有修改其他模块来消除该错误。
- 没有运行真实 DSH。本轮实际 v5 日志 taskCount 为 0，确为返回了空 tasks；投影不会把该失败变成有效结果。v6 真实生成与采用仍由主会话验收，不能称已完成真实计划验收。

既有 `NEEDS_INTERFACE` 中画像采用事务 revision 锁与稳定未知请求语义身份，主会话已反馈根实现完成；本轮不改共享 Port 或根持久化。完成后停止编辑，授权文件交还主会话。

## 2026-10-09 v7 未来验收条件语义修复

主会话反馈真实 v6 已产生十九项非空任务，但任务验收中的未来完成标准被通用事实校验误判。原日志只包含结构诊断，没有打印用户输入或模型原文。

- `acceptance` 现使用专用目标校验，仍检查有效字符串/数组数量、日期、链接、金额、天气数值与天气断言；只把核对要求、规则、材料、地点信息等的完成语态视为未来检查目标。原始文字保留，不擅自改写成用户已经做过。
- 可接纳“已核实比赛地点信息并记录官方说明”“已确认是否收费并记录核对结果”“报名规则核对已完成”等标准。直接资格确认/资格符合、报名/支付/订票/提交成功以及真实天气结论仍拒绝；相邻的成功断言不能借前面的核对问题得到豁免。
- 其他建议字段仍使用原事实校验。计划保持 draft，核实事项保持 needs_confirmation，新增 notice 明确验收条件供任务完成后检查，完成语态不表示本人已执行或网站已核实。
- 提示词升级 `participation-plan-v7`，显式区分未来验收标准与现有完成事实。没有更改共享类型、任务预算、时间、来源、画像或未知请求逻辑。
- 模块模拟测试 **157/157** 通过；全局 `npm run typecheck` 通过。没有运行真实 DSH，v7 实际生成、私有保存与页面展示由主会话继续验收。

本轮修改文件交还主会话，停止编辑。
