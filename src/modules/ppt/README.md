# PPT 大纲与原创结构模板

本模块为黑客松新人提供三套原创、逐页可编辑的结构框架，以及由账号专属 DSH 生成的私人 PPT 大纲。它输出 Markdown 和可打印 HTML 预览；不生成或声称生成 `.pptx`。

## 使用与服务组合

```ts
import { createPptService } from "./src/modules/ppt/index.ts";

const ppt = createPptService({ ai: personalWorkspace, profiles: participantProfiles });
const artifact = await ppt.generate(actor, {
  templateId: "demo-3",
  durationMinutes: 3,
  projectName: "任务小助手",
  projectIdea: "帮新人把参赛任务列清楚",
  targetUsers: "第一次参赛的小队",
  completed: ["本地任务列表已实现"],
  planned: ["多人同步待实现"],
  evidence: ["本机手动验证过增删任务"],
}, freshSessionGuard);
```

相对导入采用 `.ts` 后缀。模块只调用注入的 `PersonalAiPort`，不直接访问模型 HTTP、数据库或其他模块存储。可选 `profiles.get(actor, guard?)` 仅使用本人项目想法与演讲经验；不向模型发送整份参赛资料。

- `generate(actor, input, guard?) → Promise<PersonalArtifact<PptOutline>>`：校验输入，调用预算和持久化由主会话负责的 DSH Port，将受信任输入快照与事实清单绑定到结果。
- `list(actor, guard?) → Promise<PersonalArtifact[]>`：代理读取本账号 `ppt` 记录。
- `get(actor, id, guard?) → Promise<PersonalArtifact<PptOutline>>`：经本人 getter 读取，再验证记录类型和完整大纲。
- `PPT_TEMPLATES`、`getPptTemplate`、`templateMarkdown`：公开原创框架，无需登录、模型调用或数据库写入。
- `outlineMarkdown`、`outlinePrintHtml`：导出当前大纲，保留每页时长、来源标签、讲者备注和演示备用建议；HTML 全转义、无脚本并设置 CSP。
- `parseStoredPptOutline`：历史完整性与边界检查。页面本地改写事实要点时转为 `suggestion`，避免继续标为原始事实。

## 路演继承

`artifactId` 只能标识服务器经 `ai.get(actor, id, guard)` 读取的本人 `roadshow` 记录；客户端不能提交路演内容或指定 owner。选定继承后，服务端覆盖浏览器项目事实，只保留当前模板和分钟时长选择。

当前真实 `RoadshowDocument={input,script}` 的映射：

| 路演输入 | PPT 输入 |
| --- | --- |
| `projectIdea` / `targetUsers` | 保留原值 |
| `completedCapabilities` | 分行，较长段分为不超过 550 字的片段，作为用户自报完成 |
| `facts` | 分行，作为用户提供资料 |
| `pendingValidation` / `assumptions` | 仅放在服务器来源上下文；不写入 `planned` 或已验证证据 |
| `plannedCapabilities` | 新路演独立计划字段，分行保留为 `planned`；旧稿缺字段保持 `[]` |
| `problem` / `technicalApproach` / `differentiation` | 来源输入上下文，仍属用户陈述 |

兼容带 `inputSnapshot` 的显式 `completed` / `planned` 数组记录。来源原始输入只由 owner getter 获取，最多 60 KB；不会读取其他人的 ID、浏览器快照或跨模块私有文件。生成快照保留 `artifactId` 以便回溯来源。

## 校验和权限边界

输入仅允许已声明字段；1–15 整数分钟；想法 2000 字、用户 1000 字、项目名 120 字；已完成/待实现/证据各最多 12 项、每项 600 字；JSON 最多 32 KB。至少填写一项已完成或待实现范围。输出 3–12 页、每页 1–5 条要点，页码连续、秒数为整数且全页合计等于输入时长；演示已计在对应页内。

`provided` 要点只能逐字引用服务器事实列表并使用对应 `factId`；改写只能成为建议或待补证据。讲者备注等字段另有长度限制，并保守拒绝输入未支持的用户规模、效果指标、测试成功、上线与获奖声明。此检查不能证明自然语言的全部语义，也不独立核验用户自报资料；提示和导出仍要求人工复核。没有完成项时拒绝现场或录制演示安排。

当前身份必须由 root 会话鉴权获得；账号隔离、事务内 fresh guard、DSH 预算、未知请求 hold 和实际持久化由 `PersonalAiPort` 负责。模块透传同一个 guard，失败不降级为静态结果，不重试未知请求。

## 生成协议 v2

root 实际 DSH 验收报告 v1 返回 `PPT_OUTPUT_INVALID`。可独立复现的旧契约问题是：想法/用户允许超过 600 字，但示例要求将它们逐字放入最多 600 字的事实要点；模型还需要复制事实 ID、填写枚举并计算各页总秒数。未获得该次原始响应，不能把这处复现问题认定为那次调用的唯一原因。

`personal-ppt-copy-v2` 将结构移到服务器：模板固定 5/7/7 页，按模板权重分配整数秒并补齐余数；逐字事实要点、页码、模板 ID、时长和演示页均由服务器绑定。仅不超过 600 字的事实进入事实要点，长输入完整保留于快照与模型上下文；缺少短事实的位置明确显示 `needs_evidence`。模型必须实际返回每页文案、视觉与备注，不能用静态框架填充缺失模型结果。演示安排固定为讲解建议，不声明现场运行或录屏已经成功。

模型原始响应只允许以下字段，全部必需，不能出现未声明字段：

| 字段 | 类型与边界 |
| --- | --- |
| `title` | 非空文本，最多 120 字 |
| `slides` | 按模板顺序的 5 或 7 个对象 |
| `slides[].title` | 非空文本，最多 100 字 |
| `slides[].suggestions` | 0–2 条非空文本数组，每条最多 250 字 |
| `slides[].visualSuggestion` | 非空文本，最多 800 字 |
| `slides[].speakerNotes` | 非空文本，最多 2200 字；提示建议约 60–160 字 |
| `demonstration.steps` | 1–3 条非空文本数组，每条最多 300 字 |
| `demonstration.fallback` | 非空文本，最多 600 字 |
| `rehearsalChecklist` | 1–10 条非空文本数组，每条最多 400 字 |
| `warnings` | 0–8 条非空文本数组，每条最多 500 字 |

返回无需 `schemaVersion/templateId/durationMinutes/number/keyPoints/durationSeconds/mode/factId`。服务器合成后仍调用原 `validatePptOutline`，保留逐字事实和未支持数字/成功声明检查；最终持久化仍为 `PptOutline.schemaVersion=1`，旧历史读取兼容。完整示例在付费请求前预检。失败通过 `recoveryAction=PPT_SCHEMA:<固定字段路径>` 提供安全诊断，不输出原文或输入；最后的内容约束失败为 `PPT_SCHEMA:final.content_or_bounds`。

本轮修复只完成代码与替身验证，真实 v2 DSH 是否成功仍以 root 下一次验收为准，不自动重发既有失败或未知请求。

## U03 项目来源与 NEEDS_INTERFACE

`createPptService({ai, profiles?, projectContext?})` 增加与路演公共导出相同的 `PresentationProjectContextPort`。精确字段、限额、错误及事务要求见 `src/modules/roadshow/README.md` 的 U03 NEEDS_INTERFACE；本模块只通过路演 `index.ts` 公共导出复用来源契约，不读取其他模块私有存储。

本人明确选择项目时，POST 私人输入旁增加 `projectSource:{projectId,revision}`。服务复读服务器快照、严格比对当前事实 revision，生成前后组合原会话 guard 与 `assertCurrent`；快照保存于 `PptOutline.sourceProject`，编辑后的私人生成内容独立保存于 `inputSnapshot`。模型不能输出或替换 sourceProject。planned 和 completed 分开；快照里的计划不能逐字放入输入完成字段。无 Port 的项目引用返回 503，不静态伪造接通。

`artifactId` 与 `projectSource` 互斥。本人明确继承旧路演时，只读取 owner-scoped 保存记录，继承其中 plannedCapabilities → planned，并把服务器保存的 sourceProject 原样放入新 PPT。其旧版本不被当前项目事实静默覆盖；新生成仍必须通过 `assertCanGenerate(actor,projectId,sql)` 复核当前会话、活跃成员、账号有效及未归档，允许明确选择的历史 revision。缺此根适配时项目来源旧稿无法生成 PPT；本人旧稿本身仍可读取，不强制重新生成。

本模块的输入快照/来源元数据仍使用现有个人 artifact JSON 存储，无模块迁移需求。`get/list` 会检查 sourceProject 结构和数据边界；旧无来源的 PPT 历史兼容。Markdown 和 HTML 预览增加项目名/ID、事实版本、读取时间及历史不会随项目改写的说明，仍不输出 PPTX。

有项目来源的生成协议为 `personal-ppt-copy-project-v4`，无项目来源保持 `personal-ppt-copy-v3`。`requestIdentity` 排除 sourceProject.capturedAt，防止同版本重复读取用新时间戳改变未知付费请求身份；实际 hold、预算及持久化仍由根服务负责。没有新增环境变量。

新增模拟验证：`node --experimental-strip-types --test src/modules/roadshow/project-context.test.ts`。验证直接来源的版本冲突、生成前后权限变化、旧路演计划与来源继承、旧历史读取和请求身份；不代表根 API、真实 PGlite/线上 PostgreSQL、DSH 或浏览器已接通验收。

## UI 和接入

`src/components/ppt-client.tsx` 公开 `PptClient`，根会话组合 `/ppt` 页面。请求使用现有 `client-api.ts`，API 路径：

- `POST /api/v1/me/ppt/outlines` → `ppt.generate(current.actor, await request.json(), current.guard)`。
- `GET /api/v1/me/artifacts?kind=ppt` 与 `GET /api/v1/me/artifacts/:id` → 既有 owner-scoped `personalWorkspace`；记录点击恢复时页面验证 `kind/provider/data`。
- `GET /api/v1/me/artifacts?kind=roadshow` → 本人路演列表；继承仅传 ID。

现有迁移 `021_personal_dsh_workspaces.sql` 已覆盖 `kind='ppt'` 与 owner 索引。本模块不需要独立表；模块内迁移建议说明复用方式，由主会话决定实际迁移。

## 验证

```powershell
node --experimental-strip-types --test src/modules/ppt/ppt.test.ts src/modules/ppt/templates.test.ts
npm run typecheck -- --incremental false
```

Node 测试使用注入的假 Port，仅验证规则、guard 透传、账号与来源边界、未知结果不重发、导出转义及框架时间；不代表真实 DSH、数据库、浏览器和打印已完成验收。没有新增环境变量；真实 DSH 与预算使用根服务配置。

## 工具官网核验

2026-10-09 实际读取并核验官方产品页：[Microsoft PowerPoint](https://www.microsoft.com/en-us/microsoft-365/powerpoint)、[Google Slides](https://workspace.google.com/products/slides/)、[Canva Presentations](https://www.canva.com/presentations/)、[Gamma](https://gamma.app/)。卡片只介绍可确认功能及适用场景，不承诺免费额度、套餐可用性或素材许可。详情以官网当前说明为准。
