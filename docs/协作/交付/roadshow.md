# roadshow · 交付说明

日期：2026-10-09。临时文件范围：`src/modules/roadshow/`、`src/components/roadshow-client.tsx`、`src/components/roadshow.module.css` 与本交付文件。未修改根路由、共享接口、实际迁移、依赖或配置；主会话在开发期间已组合 `/roadshow` 页面与个人 API。

## 已完成

- 暖白橙红的完整客户端页面：两份本站原创虚构案例（明确不是获奖作品）、可随时间变化的分配图、注意事项、演示失败备选、常见评委 Q&A。
- 项目想法、目标用户、问题、已完成能力四项必填，技术、差异、事实、假设、待验证选填；演讲时间 1–15 分钟。不会强制先填写画像。服务可选读取本人画像中的首次参赛、开发/路演经验与技能，不发送城市、兴趣等无关私人字段。
- 固定通过注入 `PersonalAiPort` 调用 `kind: "roadshow"`，无模型 HTTP、静态生成降级或独立存储。模型输出是中文开场、分段讲稿和秒数、演示步骤及备选、结尾、问答与待核实事项。
- 服务端固定 `RoadshowDocument.input`，模型不得替换用户输入。严格未知字段、类型、长度、控制字符、数组与字数限制；各段时间精确合计输入时长。演示时间包含在段落，问答另计。提示和保守校验共同限制无依据奖项、用户/访谈/测试/市场结果，以及已执行 Demo 声明；用户自述仍不是独立核验。
- 登录读取、真实等待与经过秒数、错误/空态、历史数组读取、恢复输入与讲稿、Markdown 复制及下载。读取/恢复历史不会发起 AI 生成。
- 网络或不可读响应、明确未知请求均进入待核查状态，不自动重发；恢复旧记录不会解除该状态。付费未知请求的持久禁止重发依赖根 PersonalAiPort，前端状态不替代服务端 hold。
- 会话失效清除该账号的输入、讲稿和历史；异步返回通过当前 owner/epoch 复核。初次匿名访问的安全 `?idea=` 文本可带入（最多 1200 字、拒绝重复参数和控制字符），未修改共享 `safeAuthReturnTo`。
- 下一步链接已对齐当前 PPT 客户端：`/ppt?roadshowId=<artifact id>`。URL 只包含记录 ID，私人想法、讲稿和事实须由 PPT 使用当前账号的 owner-checked API 读取。

## 服务与 API 接入合同

`createRoadshowService({ ai: PersonalAiPort, profiles?: { get(actor, guard?): Promise<ParticipantProfile> } })` 返回：

| 方法 | 返回与行为 |
| --- | --- |
| `generate(actor, input: unknown, guard?)` | `Promise<PersonalArtifact<RoadshowDocument>>`；校验输入，传画像最小上下文，经 `ai.generate` 校验并保存。Actor 只来自登录会话。 |
| `list(actor, guard?)` | `Promise<RoadshowArtifact[]>`；经 `ai.list(actor, "roadshow", guard)`，校验种类、DSH 与文档。 |
| `get(actor, id, guard?)` | `Promise<RoadshowArtifact>`；经 owner-checked `ai.get`，错误种类隐藏为 404。 |

输入：`projectIdea`(2000)、`targetUsers`(1000)、`problem`(2000)、`completedCapabilities`(3000) 必填；`technicalApproach`(3000)、`differentiation`(1500)、`facts`(3000)、`assumptions`(2000)、`pendingValidation`(2000) 字符串选填；`durationSeconds` 整数 60–900。括号为字符上限；未知字段拒绝。

`RoadshowDocument = { input, script }`。`script` 的 `opening`/`closing` 是 `{ text, durationSeconds }`，`segments` 是 `{ title, text, durationSeconds }[]`，`demoSteps` 是 `{ action, expectedResult, fallback }[]`，`qa` 是 `{ question, answer }[]`，另有 `verificationItems: string[]`、`totalDurationSeconds`。

客户端实际消费：

- `POST /api/v1/me/roadshow/scripts`：body 直接为上述输入，201，`data: PersonalArtifact<RoadshowDocument>`。
- `GET /api/v1/me/artifacts?kind=roadshow`：200，`data: PersonalArtifact[]`，**直接数组**。
- `GET /api/v1/me/artifacts/:id`：200，`data: PersonalArtifact`，客户端再次验证路演文档才显示/恢复。

可选 `createRoadshowHandlers` 工厂需要 `service`、`resolveActor(request)`、`authorizeMutation(request, actor)`、`freshSessionGuard(request, actor)` 和 `requestIds`，返回 `generate/list/get`。包括有界 JSON 流、来源检查注入、guard 透传、共享错误与 private no-store；根已用现有路由组合服务，可以不重复挂工厂。

公开导出在 `src/modules/roadshow/index.ts`，包括 service、types、validators、Markdown 和原创内容。迁移建议在本模块 `migrations/README.md`：复用共享个人 artifact 存储，不新增第二张路演成功表，不运行根迁移。

## 已验证与模拟测试

- `node --experimental-strip-types --test src/modules/roadshow/*.test.ts`：17 项通过，覆盖输入/输出严格校验、私人 Port/guard 调用、画像归属/最小上下文、个人记录隔离、时长边界与超长讲稿、防编造（包括否定证据、段落标题、转折与访谈付费声明）、模型不得替换输入、导出转义、HTTP 登录/来源/流体积/错误不泄露、URL 与时间图。
- `npm run typecheck -- --incremental false`：2026-10-09 本轮通过；之后主会话新增修改需自行复核。
- `node --experimental-strip-types src/modules/roadshow/browser-check.mts`：使用本机无头 Edge、真实组件和样式、模拟 Next 链接与 API。验证匿名安全想法参数、390px 手机与1280px桌面无横向溢出、生成忙态、历史**数组**与恢复、Markdown 下载、PPT 仅记录 ID、不可读响应/未知结果不重发、恢复旧记录不解除未知限制、会话失效清除私人输入/结果/历史。**未访问真实模型或数据库**。
- 浏览器生成的 `roadshow-mobile-preview.png`、`roadshow-desktop-preview.png` 已查看；画面中记录是模拟夹具，不是实际 DSH 成功证明。编译临时文件在本模块中生成并清理。

## 未接入 / 真实验收边界

页面和根服务/API 已在源码组合，但此模块没有重启现有服务器、开启本机数据库目录或发起真实付费请求。本轮探测时，运行中的服务器访问 `/roadshow` 返回404，因此浏览器验证使用隔离夹具；主会话仍需在它管理的新版服务完成真实登录、DSH 预算/未知 hold、持久保存与跨账号禁止读取验收。

下一步 PPT 的 owner-checked 读取和服务端继承属于其模块/主会话；本模块已按当前实际 `roadshowId` 参数提供链接。没有独立确认当前客户端/模型能完成 PPT 生成。

## NEEDS_INTERFACE

无新增共享契约。已使用 `src/shared/personal-ai.ts` 的 `PersonalAiPort/FreshSessionGuard/PersonalArtifact` 与 `src/shared/participant.ts` 的 `ParticipantProfile`。主会话负责在真实个人 Port 中复核当前账号和请求会话、限制预算、持久保存、保守结算未知请求；通用 GET 不能触发生成。

## 环境变量

本模块无新增环境变量，不读取密钥。已有 DSH 配置由主会话的个人 Port 使用（本机 `DSH_DESKTOP_DIRECTORY`，具体后端模式按根部署文档）；测试无需外部环境变量。未输出任何凭据。
