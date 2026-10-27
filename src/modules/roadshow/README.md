# 路演讲稿模块

私人路演生成由 `createRoadshowService({ ai, profiles?, projectContext? })` 组合。`ai` 使用共享 `PersonalAiPort`，负责预算控制的 DSH、账号隔离、生成记录持久化及请求会话复核；本模块没有模型 HTTP 客户端、数据库连接或内存生产存储。可选 `profiles.get(actor, guard?)` 仅读取同账号的首次参赛、开发/路演经历和技能；空画像可直接生成。

`generate(actor, unknown, guard?)` 校验项目想法、目标用户、问题、已完成能力及选填计划能力、技术、差异、事实、假设、待验证。`plannedCapabilities` 最多 3000 字，省略时为空；它不进入已完成/数字声明的肯定依据。输入字段上限见 `ROADSHOW_INPUT_LIMITS`，时长为 60–900 整数秒，未知字段、控制字符、错误类型和过长输入拒绝。返回 `PersonalArtifact<RoadshowDocument>`，`data` 为 `{ input, script, sourceProject? }`；input 和来源快照由服务端闭包固定，不接受模型返回的输入。

中文输出包含开场、2–8 段讲稿、1–6 个演示建议与失败备选、结尾、3–10 个问答及 1–12 项待核实事项。各段秒数之和精确等于输入时长；问答另计，演示与切屏包含在段落时间里。每段至少五秒，开场和结尾各最多占四分之一；字数上限用于排除明显超时，实际语速仍需彩排。严格校验嵌套字段、数组数量、中文及整体体积。模型提示和保守规则检查全部展示文本（包括段落标题），拒绝输入未支持的市场、奖项、用户、测试数字、中文访谈人数/付费意愿与已执行演示声明。仅使用事实/已完成能力中的肯定短句作为依据；否定、假设或待验证句不能通过子串匹配变为肯定事实。否定/验证措辞只修饰紧邻声明，不跨标点、转折或另一主题。这些保守规则无法独立证实用户自述，也不能完整理解任意自然语言；不明确的事实需补充清晰表述，输出始终为待核实草稿。

`list(actor, guard?)` 与 `get(actor, id, guard?)` 通过个人 Port 读取，校验 `kind=roadshow`、`provider=dsh` 和文档，其他种类返回 404。`roadshowToMarkdown(document)` 导出完整私人讲稿、输入、备选、问答和待核实事项，并转义 HTML/Markdown 控制内容。

HTTP 工厂 `createRoadshowHandlers` 需要 `service`、`resolveActor(request)`、`authorizeMutation(request, actor)`、`freshSessionGuard(request, actor)` 及 `requestIds`。服务端必须从真实登录请求建立 guard；不可从 JSON 建立 Actor。返回：

- `generate(request)` → POST `/me/roadshow/scripts`，201，`{ data: PersonalArtifact<RoadshowDocument>, requestId }`。
- `list(request)` → GET `/me/artifacts?kind=roadshow`，200，`{ data: RoadshowArtifact[], requestId }`。组合层负责种类分派。
- `get(request, { id })` → GET `/me/artifacts/:id`，200，相同记录格式。通用路由可直接使用个人 Port 并对路演数据调用 validator。

HTTP 使用有界流读取、UTF-8/JSON 校验、会话与变更来源检查、私有 no-store 响应和共享错误封装。未知异常不会输出堆栈或模型内容。

`content.ts` 是本站原创教育内容，案例均明确标注为虚构练习项目。`/ppt?roadshowId=id` 只传记录 ID；PPT 服务须经当前账号的个人 Port 读取，不得把私人想法或完整讲稿放入 URL。

测试：`node --experimental-strip-types --test src/modules/roadshow/*.test.ts`。所有 AI、画像和存储用测试替身；不代表真实 DSH、线上数据库、预算或外部并发已验收。根路由、应用组合及真实账号持久化验收由主会话接入。本模块无新增环境变量。

## U03 项目资料复用与 NEEDS_INTERFACE

本轮已实现可注入 `PresentationProjectContextPort`、输入/历史来源校验、生成 guard 组合与请求身份固定。根适配和只读 API 尚未由本模块接入；未注入 Port 时，选择项目生成返回 `PROJECT_CONTEXT_UNAVAILABLE`（503），独立手动填写继续使用。没有新增模型调用、数据库连接或迁移。

本人明确确认使用项目后，生成请求在原有私人字段旁只增加 `projectSource: { projectId, revision }`；不接受浏览器传 `sourceProject`、owner 或成员信息。服务再次读取服务器快照并比对 revision，随后将快照独立保存到 `RoadshowDocument.sourceProject`。私人输入仍可编辑、仍为用户陈述；服务器项目快照不会为私人新增声明背书。`sourceProject.planned` 不能逐字放入 completed 字段；此保守检查不能独立理解所有自然语言或验证用户成果。

公共契约经 `src/modules/roadshow/index.ts` 导出：

```ts
interface PresentationProjectSelection { projectId: string; revision: number }
interface PresentationProjectSnapshot extends PresentationProjectSelection {
  schemaVersion: 1;
  projectName: string; projectIdea: string; targetUsers: string; problem: string;
  completed: string[]; planned: string[]; evidence: string[];
  capturedAt: string;
}
interface PresentationProjectContextPort {
  readSnapshot(actor: Actor, projectId: string, guard?: FreshSessionGuard): Promise<PresentationProjectSnapshot>;
  assertCurrent(actor: Actor, selection: PresentationProjectSelection, sql: SqlExecutor): Promise<void>;
  assertCanGenerate(actor: Actor, projectId: string, sql: SqlExecutor): Promise<void>;
}
```

- `projectId` 为 1–128 位字母/数字/下划线/连字符；revision 为大于零的安全整数。项目名不为空且最多 120 字；想法/问题最多 2000 字，目标用户最多 1000 字，可为空表示未提供。completed/planned/evidence 各最多 12 项、每项为非空 600 字以内文本；capturedAt 为服务器 UTC ISO 毫秒时间。snapshot 不得含完整私人画像、完整规则、完整代码或其他人的讲稿。
- `readSnapshot` 必须在一个根数据库事务内以真实请求 Actor 在读取前和返回前复核当前账号、传入 session guard 和活跃 ProjectMembership，读取所用 M02/M05/M06 公开事实。captain 不能替代 project manager；普通活跃成员可读本人材料所需有限项目信息。已完成成果由其所有者的现有事实定义，不能从计划、AI 建议、保存代码或未检查任务推定；不新增第二份交付成功状态。
- revision 必须随任何被带入的目标/范围/成果/计划/证据变化而改变，不能只比一个与所用事实无关的项目表 revision。`assertCurrent` 在传入同一个 `SqlExecutor` 上复核账号/成员、未归档和所有相关事实版本；会话失效、退出/移除、归档、旧版本均阻止本次生成保存。不得另开事务读取后把检查当作当前事务的结果。
- 服务组合 guard 先调用原 `FreshSessionGuard(sql)`，再调用 `assertCurrent`。实际 `PersonalAiPort.generate` 必须在模型请求前及结果落库事务内执行此 guard；队列等待、重试/租约也保留这一 guard，不能把闭包转成客户端权限字段。预算/未知请求 hold 由根保持；sourceProject 的 capturedAt 被排除在 `requestIdentity` 外，同版本重复读取不能通过时间戳绕过 hold。新增选填 plannedCapabilities 为空时也从语义请求身份中去掉，维持旧无计划请求的身份，不能借 schema 默认值变化重放未知结果。
- 历史 `get/list` 仍通过本人 `PersonalAiPort` 读取自己的私人快照；项目改版不自动覆盖历史，旧无 sourceProject、无 plannedCapabilities 的文档仍可读。重新以历史 sourceProject revision 直接生成会被严格版本校验拒绝，用户可重新读取或明确解除来源、转成手动自述。PPT 明确选旧路演时则用继承专用 `assertCanGenerate`（见 PPT README）。
- 根需提供一个登录只读、private/no-store 的 `GET <projectContextApi.basePath>/:projectId`，返回 `{data: PresentationProjectSnapshot, requestId}`；读取不生成材料、不收费、不写预算。根页面显式注入组件 API basePath；缺少 API/Port 时显示真实未接入状态。
- 建议稳定错误：`UNAUTHENTICATED` 401；无活跃项目权限 403 或隐去存在性的 404；`PROJECT_ARCHIVED` 409；`PROJECT_CONTEXT_CHANGED` 409 + latestRevision；`PROJECT_CONTEXT_INVALID` 502；`PROJECT_SOURCE_INVALID` 422；`PROJECT_COMPLETION_NEEDS_REVIEW` 422；`PROJECT_CONTEXT_UNAVAILABLE` 503。错误不得含私人快照、模型响应或凭据。

例：读取版本 3 后用户确认，提交只带 `{projectId:"project-1",revision:3}`。排队期间队友把所用计划更新到版本 4，落库 guard 返回 `PROJECT_CONTEXT_CHANGED`，不保存旧生成；已保存的本人版本 3 讲稿保持不变。模块测试 `project-context.test.ts` 使用假 SQL executor/AI，覆盖上述并发变化与两模块继承，不代表真实事务或付费服务验收。
