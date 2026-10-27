# 规划 34 · B1 模块助手框架 + 收件与评审、报名管理两个助手（module-assistants）交付

日期：2026-10-16。依据：`docs/规划/34-主办方模块化与选手社区.md` §2.1 助手注册表、§2.2 运行与边界、§5.1 配置面清单、
§6 分期 P4；宪法 v1.23.0 原则 XIII「模块专属助手（AI 边界）」、原则 XI「评审 AI 隔离」、原则 IX「外部依赖失败时仍可继续工作」；
设计 `docs/设计/主办方工作台布局.md` 的 section 页与"一屏一个 .primary"约定。

授权文件范围：**仅新增** `src/modules/module-assistants/` 与本交付说明。
**未编辑** `src/app/`、`src/server/`、`src/components/`、`src/shared/`、`migrations/` 或任何其他模块的文件。
未运行 build / 迁移 / 重启 / npm install / git 写操作；**没有自己接 DSH 网络调用**，模型经注入 Port。

分期口径：本次是 **P4 = B1 框架 + 2 个助手**（收件与评审、报名管理事实最结构化）。框架一次做齐 7 条注册表，
其余 5 个助手只差根的只读事实适配，不需要重写运行时（对应规划 34 §2.3 P-B2）。

---

## 1. 已实现

### 1.1 注册表（7 个主办方流程模块各一条）

`MODULE_ASSISTANT_REGISTRY` 逐条声明 key、标签、所需既有 `EventStaffCapability`、可读的既有事实键、
允许的产出类型、所属既有工作台 section。默认全开、可逐模块关（开关由注入的 scope Port 提供）。

| key | 标签 | 所需能力（与 `competition-workspace.tsx` 逐字一致） | 可读既有事实键（只读） | 允许产出 | 落点（既有 page） |
| --- | --- | --- | --- | --- | --- |
| `overview` | 本场概览 / 比赛设置 | `event_manage` | readiness、publishBlockers、rulesVersion、versionChanges、status、startsAt、endsAt | 摘要 / 清单 / 草稿 | `/organizers/workspace/{eventId}/settings` |
| `registration` | 报名管理 | `registration_manage` | pendingReviewCount、approvedCount、rejectedCount、withdrawnCount、draftCount、formVersion、capacity、registrationWindow、pendingRows | 摘要 / 清单 / 草稿 / 去重提示 | `/organizers/workspace/{eventId}/registration` |
| `teams` | 队伍管理 | `teams_manage` | confirmedTeamCount、formingTeamCount、withdrawnTeamCount、teamSizeRules、eligibilityIssues、proposedGrouping | 摘要 / 清单 / 草稿 | `/organizers/workspace/{eventId}/teams` |
| `communication` | 通知与答疑 | `communication_manage` | announcementCount、publishedFaqCount、openTicketCount、recentQuestions、templateCount、draftAnnouncements | 草稿 / 摘要 / 去重提示 | `/organizers/workspace/{eventId}/communication` |
| `schedule` | 行程管理 | `schedule_manage` | draftSessionCount、publishedSessionCount、sessions、timeConflicts、timezone | 摘要 / 清单 / 草稿 | `/organizers/workspace/{eventId}/schedule` |
| `services` | 现场服务 | `logistics_manage` | accommodationAssignedCount、accommodationUnassignedCount、mealVoucherIssuedCount、icebreakingGroupCount、unassignedPeople | 清单 / 摘要 / 草稿 | `/organizers/workspace/{eventId}/services` |
| `judging` | 收件与评审 | `judging_manage` | receiptCount、roundStatus、assignmentCount、progress、calibration、integrity、fairness、disclosureGate | 摘要 / 清单 / 草稿 | `/organizers/workspace/{eventId}/judging` |

产出类型只有四种：`draft` / `checklist` / `summary` / `dedup_hint`（`MODULE_ASSISTANT_OUTPUT_KINDS`）。
**评审助手刻意不含任何 comment / message / peer / feedback / review 键**——评分期间评审侧不返回选手点评内容（宪法 XIII「评审隔离」），
注册表测试直接断言这一点。

### 1.2 独立上下文与命名空间

`moduleAssistantNamespace()` 显式生成 `org:{机构}:event:{赛事}:module:{模块}:user:{账号}`，四段任一变化都是不同命名空间。
`run()` 把它同时传给只读事实 Port、模型请求与账本条目；模块内没有任何模块级可变状态、全局缓存或队列。
选手备赛 AI、全站聊天、团队助手各有自己的上下文，本框架不读取它们、也不向它们写入。

### 1.3 只读事实 + 注入 Port

`ModuleAssistantFactsPort` 每模块一个方法（`overview/registration/teams/communication/schedule/services/judging`），
返回结构化事实 `{ moduleKey, organizationId, eventId, namespace, capturedAt, fingerprint, values, sources, missing }`。
模块内没有 SQL、没有数据库句柄、没有 `SqlExecutor`，也不导入其他模块的私有文件；
`values` 出现任何未在注册表声明的键都会被 `MODULE_ASSISTANT_CONTEXT_INVALID` 拒绝，**不发送给模型**。

### 1.4 只出草稿

`run()` 成功只返回 `status: "draft"` + `draft`，字段严格为 `kind/title/body/items/notes`，
服务端固定 `requiresHumanAction: true`；`kind` 必须属于该模块 `allowedOutputs`，
`items[].sourceKeys` 只能引用声明过的事实键，出现任何多余字段（例如 `approve: true`）即判为无效产出。
服务内没有任何发布、发信、扣分、改结果、改权限调用。

### 1.5 不限次数 + 可核对 + 可降级

- 平台**不设强制次数上限**：注册表条目没有 limit/quota/maxCalls 字段，测试连续 50 次调用全部到达模型并各自记账。
- 每次调用写注入的 `ModuleAssistantLedgerPort`：谁（actorUserId）、哪个模块（assistantKey/label）、
  读了什么范围（eventId、organizationId、factKeys、sources、missing、capturedAt、fingerprint）、花费（usage + 账本 cost）、
  结果（succeeded/degraded）、namespace、providerRequestId、errorCode。`run()` 返回可展示的 `usage`。
- 降级：`model_unavailable` / `model_failed` / `model_result_invalid` / `ledger_unavailable` /
  `sponsor_budget_exceeded`（仅当注入账本以 `AI_BUDGET_EXCEEDED` 明确拒绝时），都返回 `status: "degraded"` +
  `manualWorkflowUnaffected: true`，**不抛未处理异常**。记账失败时**丢弃草稿**（AI 产出必须可核对），不静默展示。

---

## 2. 吸收闸门三问（宪法 XII / 规划 32 §4.0）

| 问题 | 答案 |
| --- | --- |
| **① 解决我们哪个真实问题** | 主办方每场要在 7 个流程模块之间来回核对（报名待审计数、评审进度、发布阻塞项等），现在只有原始列表与计数，没有"下一步核对什么"的草稿与缺项清单。规划 34 §2.2 记录的摩擦点是"人手整理"，不是"竞品有 AI 所以要做"。 |
| **② 会碰到哪些既有能力** | 既有 7 项 `EventStaffCapability` 与 section 路由、`HostedEventScope`/`EventModuleFlags`、既有 AI 账本与 DSH 管道与预算（宪法 IX）、event-judging 的收件/轮次/指派/校准/自检/公平包只读视图、organizer 的 readiness/发布门槛、报名计数、队伍名单、沟通与行程与现场服务既有事实。 |
| **③ 如何避免重复入口 / 第二份事实 / 第二套写路径** | ① 不新增任何业务事实：本模块**没有数据库、没有迁移、没有 INSERT/UPDATE/DELETE**；事实全部经注入 Port 只读转发。② 不新增入口：注册表 `sectionPath` 只指向既有 section 页，`safeModuleAssistantSectionHref()` 只拼接既有路径。③ 不新增写路径：没有发布会/发信/扣分/改结果/改权限调用；唯一写入是"把这次调用记进既有账本"。④ 不新增第二套权限：复用既有 capability 枚举，授权由根 Port 复核。⑤ 不设第二套预算：账本与模型都用既有 AI 账本/DSH 管道。 |

---

## 3. "没有第二套入口 / 状态 / 写路径"证据

| 声明 | 可复核证据 |
| --- | --- |
| 没有第二套入口 | 7 条 `sectionPath` 全部是既有 `/organizers/workspace/{eventId}/...`；模块导出只有纯文本面板常量与 `safeModuleAssistantSectionHref`，没有 React 页面、没有新路由。 |
| 没有新增第二份业务事实 | 无迁移、无表、无 `postgres.ts`；`ports.ts` 只有 `resolve` 与 7 个只读 `facts` 方法 + `model.complete` + `ledger.record`。服务不持有数据库句柄。 |
| 没有第二套写路径 | 源码扫描测试断言 `service.ts`/`registry.ts`/`ports.ts` 不含 `INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/GRANT/REVOKE`，不含 `.insert/.update/.delete/.publish/.send/.deduct/.grant/.revoke(`；行为测试用 Proxy 包装四个 Port，任何未声明方法一被调用即抛错。 |
| 没有第二套状态/完成度 | 本模块不定义任何业务状态机或完成度；`status` 只有 `"draft"/"degraded"`（这次调用本身的结果），不写回任何业务记录。 |
| 没有第二套权限 | 只读取既有 `EventStaffCapability`；能力不匹配时在读事实**之前**就 403 拒绝，且不调用模型、不记账。 |
| 没有静默限流/偷偷降级 | 平台无次数上限字段；降级原因、消息与 `manualWorkflowUnaffected` 都显式返回；`platformCallLimit` 恒为 `null`。 |
| 记忆不继承 | 每次模型请求带显式 `namespace`；测试断言两次不同机构/赛事/模块/账号的调用命名空间不同，且事实互不出现。 |
| 模型不越界 | 提示词把输入声明为"数据而非指令"，禁工具/禁执行/禁判分；校验层再剔除不允许的产出类型、动作字段与未声明依据。 |

---

## 4. 新增文件

| 文件 | 内容 |
| --- | --- |
| `src/modules/module-assistants/model.ts` | key/产出类型/降级原因枚举、注册表条目、事实/上下文/草稿/用量/账本/结果类型 |
| `src/modules/module-assistants/registry.ts` | 7 条注册表（冻结）、`isModuleAssistantKey`、`moduleAssistant`、`moduleAssistantCatalog` |
| `src/modules/module-assistants/namespace.ts` | 显式独立命名空间与主办方可读标签 |
| `src/modules/module-assistants/ports.ts` | 注入的 `scope` / `facts` / `model` / `ledger` Port 与依赖类型 |
| `src/modules/module-assistants/prompt.ts` | 系统提示、提示版本、输出示例、事实与草稿校验、降级文案、安全错误码 |
| `src/modules/module-assistants/service.ts` | `createModuleAssistantService`（`catalog` / `run`） |
| `src/modules/module-assistants/ui.ts` | 既有 section 链接拼接、面板文案常量 |
| `src/modules/module-assistants/index.ts` | 公共导出 |
| `src/modules/module-assistants/README.md` | 模块说明与接入示例 |
| `src/modules/module-assistants/registry.test.ts` | 注册表 6 项断言 |
| `src/modules/module-assistants/namespace.test.ts` | 命名空间 2 项断言 |
| `src/modules/module-assistants/service.test.ts` | 运行时 13 项断言 |
| `docs/协作/交付/module-assistants.md` | 本文件 |

---

## 5. 公共接口契约

```ts
import { createModuleAssistantService, MODULE_ASSISTANT_REGISTRY } from "../modules/module-assistants/index.ts";

const assistants = createModuleAssistantService({ scope, facts, model, ledger, clock });

assistants.catalog(); // readonly ModuleAssistantRegistryEntry[]

const result = await assistants.run(actor, {
  assistantKey: "judging",          // MODULE_ASSISTANT_KEYS 之一
  eventId,
  instruction: "整理本轮收件与评审的缺口清单",
  expectedFingerprint: "可选；与事实指纹不一致时 409，避免复用旧草稿",
});
// result.status === "draft"    -> { draft, usage, disclaimer, provider: "dsh" }
// result.status === "degraded" -> { reason, message, usage, manualWorkflowUnaffected: true, provider: "dsh" }

safeModuleAssistantSectionHref(eventId, key); // 只拼既有 section 页；非法 eventId 返回 null
moduleAssistantNamespace({ organizationId, eventId, assistantKey, userId });
```

Port 契约：

```ts
interface ModuleAssistantScopePort {
  resolve(input: { actor: Actor; eventId: string }): Promise<{
    organizationId: string; eventId: string;
    capabilities: readonly EventStaffCapability[];
    enabledAssistants?: readonly ModuleAssistantKey[]; // 缺省 = 全开
  }>;
}
interface ModuleAssistantFactsPort { // 每模块一个只读方法
  overview(i): Promise<ModuleAssistantFacts>; registration(i): Promise<ModuleAssistantFacts>;
  teams(i): Promise<ModuleAssistantFacts>;    communication(i): Promise<ModuleAssistantFacts>;
  schedule(i): Promise<ModuleAssistantFacts>; services(i): Promise<ModuleAssistantFacts>;
  judging(i): Promise<ModuleAssistantFacts>;
}
interface ModuleAssistantModelPort { // 模块自己不接网络
  readonly available: boolean; readonly modelVersion: string;
  complete(request: ModuleAssistantModelRequest): Promise<ModuleAssistantModelResult>;
}
interface ModuleAssistantLedgerPort { // 写既有 AI 账本
  record(entry: ModuleAssistantLedgerEntry): Promise<{ ledgerId: string; cost: ModuleAssistantCost | null }>;
}
```

稳定错误码（`DomainError`）：`UNAUTHENTICATED`(401)、`MODULE_ASSISTANT_INVALID_INPUT`(422)、
`MODULE_ASSISTANT_FORBIDDEN`(403)、`MODULE_ASSISTANT_DISABLED`(403)、`MODULE_ASSISTANT_CONTEXT_CHANGED`(409)、
`MODULE_ASSISTANT_CONTEXT_INVALID`(503)、`MODULE_ASSISTANT_SCOPE_INVALID`(503)。
提示版本：`MODULE_ASSISTANT_PROMPT_VERSION = "module-assistant-v1"`。供应商标识：`provider: "dsh"`。

---

## 6. 测试与验证

| 项 | 结果 |
| --- | --- |
| 模块测试 `node scripts/run-module-tests.mjs module-assistants` | **21/21 通过**（registry 6 + namespace 2 + service 13），exit 0 |
| 类型检查 `node node_modules/typescript/bin/tsc --noEmit --incremental false` | **exit 0，全文无输出**；本模块 0 条诊断 |

覆盖的必答断言：

1. 越权模块不可用：能力不匹配 → `MODULE_ASSISTANT_FORBIDDEN`，读事实/调用模型/记账次数都为 0；本场关闭 → `MODULE_ASSISTANT_DISABLED`。
2. 上下文只含声明的键：多一个 `peerComments` 即 503；命名空间或 moduleKey 不一致即 503；模型调用次数 0。
3. 产出只有草稿：`kind: "publish"`、多余 `approve: true`、引用未声明依据都降级为 `model_result_invalid`；成功结果字段与 `requiresHumanAction: true` 固定。
4. 调用被记账：账本条目的账号、模块、只读范围、结果、花费、`platformCallLimit: null` 逐一断言，`usage` 可展示。
5. 模型失败降级：`available: false` / 抛普通错误 / 抛 `AI_BUDGET_EXCEEDED` 分别得到 `model_unavailable` / `model_failed` / `sponsor_budget_exceeded`，均不抛未处理异常，且不泄露 provider 正文。
6. 记账失败 fail-closed：返回 `ledger_unavailable` 且不返回 `draft`。
7. 不存在写调用：Proxy 包装 Port（未声明方法即抛错）+ 三个源文件扫描（无 SQL 写动词、无写方法调用、无 `globalThis/process.env/new Map/new Set`）。
8. 不限次数：连续 50 次调用全部成功且各自记账。
9. 独立命名空间：机构/赛事/模块/账号不同 → 命名空间不同、事实不共享、账本命名空间一致。

### 已完成 / 已验证 / 模拟测试 / 未接入（如实区分）

- **已完成**：框架、7 条注册表、独立命名空间、四个注入 Port 契约、只出草稿的校验与降级、账本记账、UI 文案与落点常量、测试。
- **已验证**：模块测试 21/21；`tsc --noEmit --incremental false` exit 0。
- **模拟测试**：本模块用**假模型 Port 与假只读 Port**完成全部断言（测试内注入），**没有真实 DSH 调用**、没有真实数据库。
- **未接入**：根尚未提供 `scope` / `facts` / `model` / `ledger` 适配器，也没有 HTTP 路由或界面面板；界面落点见 §8。
- **新增环境变量**：无。沿用既有 DSH 配置（`AI_PROVIDER=dsh`、`DSH_DESKTOP_DIRECTORY` 等），本模块不读取任何环境变量。

### 明确不做（规划 34 §7 / 宪法 XIII）

AI 判分/晋级/获奖；自动发布、发信、扣分、改结果、改权限；读取选手私人点评/互评/留言（评审期评审隔离）；
读取未提交草稿或私人 AI 记忆；把助手做成第二个通知系统；平台静默限流或偷偷降级；新增第二套权限或第二份业务事实。

---

## 7. 与既有模块的关系

- 不导入任何其他模块的私有文件；跨模块只经注入 Port。
- 不新增业务事实、表、迁移、状态机或完成度。
- 与规划 24/33 的预算体系对齐：助手调用纳入既有 AI 账本，不另开付费通道。

---

## 8. NEEDS_INTERFACE（根接入所需；本模块不改根文件）

> 以下全部由主会话在 `src/server/`、`src/app/`、`src/components/` 内接线；模块侧契约已在 `ports.ts` 冻结。

### NEEDS_INTERFACE-1 · `ModuleAssistantScopePort`（根适配既有授权）

- **方法**：`resolve({ actor, eventId }) → { organizationId, eventId, capabilities, enabledAssistants? }`。
- **行为**：必须用**服务端当前**授权事实（既有 `HostedEventAccessPort` / `StaffGrant` / 机构管理员规则）解析，
  **禁止**从请求 JSON 取 capabilities 或 organizationId；对无本场权限者返回错误（模块会以 503 关闭）。
- **赛事级助手开关**：`enabledAssistants` 缺省表示全开（规划 34 §5.1）。共享 `EventCommunityConfig` **没有** assistants 字段且本次严禁改 `src/shared/`，
  因此由根把"比赛设置 → 模块助手"存为赛事级内部运营配置（即时生效、写既有审计），再经本 Port 传入；不要新增第二套权限表。
- **权限**：`EventStaffCapability` 既有 7 项；示例：`{ capabilities: ["registration_manage"], enabledAssistants: ["registration"] }`。

### NEEDS_INTERFACE-2 · `ModuleAssistantFactsPort`（每模块一个只读方法）

- 统一请求：`{ actor, organizationId, eventId, namespace }`；统一返回：`{ moduleKey, organizationId, eventId, namespace, capturedAt, fingerprint, values, sources, missing }`。
- `values` **只能**出现 §1.1 表里该模块声明的键；`namespace` 必须原样回显；`fingerprint` 必须随该模块事实版本稳定变化。
- 建议的既有读取来源（只读转发，不改规则、不复制事实）：
  - `overview`：organizer 的 readiness / 发布阻塞项 / 正式规则版本与变化回执；
  - `registration`：既有 `registrationCounts()` 与报名表版本/时间窗；`pendingRows` 只给分页摘要，不含答卷正文；
  - `teams`：既有正式名单与组队状态、名额规则、资格待核对项；
  - `communication`：既有公告、公开 FAQ、求助工单**计数与标题**；
  - `schedule`：既有行程草稿/已发布行程与同人时间重叠；
  - `services`：既有住宿/餐券/破冰分组的计数与未分配清单；
  - `judging`：既有 event-judging `workspace()`/进度/校准/自检/公平包只读视图；**MUST NOT** 含选手点评、留言或互评数据。
- **权限**：仍需按既有 staff 授权复核；Port 内部读失败应抛错（模块会以 503 显式提示，不静默）。

### NEEDS_INTERFACE-3 · `ModuleAssistantModelPort`（注入 DSH，模块不接网络）

- `available` 反映当前 DSH 是否配置；`complete(request)` 把 request 映射到既有 `JsonModelPort.completeJSON`
  （`{ systemPrompt, input, promptVersion, outputExample, maxOutputTokens }`），返回 `{ content, usage, modelVersion, requestId }`。
- 应复用既有 `createBudgetedModel`（预算 reserve/settle）与 DSH 会话；`AI_BUDGET_EXCEEDED` 等错误按原码抛出即可。
- **发现的接口缺口**：既有 `withAiExecutionContext` 需要 `projectId`，而主办方助手不是项目维度。
  请根决定一个稳定键（例如 `event:<eventId>`）或为模块助手增加一个 AI job kind；本模块不假定键的形态。
- 模型/预算由根负责超时、租约、未知 hold 与重试限制（宪法 IX）；模块只做降级与记账。

### NEEDS_INTERFACE-4 · `ModuleAssistantLedgerPort`（写既有 AI 账本）

- `record(entry)` 把"谁 + 哪个模块 + 读了什么范围 + 花费 + 结果"写进既有 AI 账本/审计，返回 `{ ledgerId, cost }`。
- `cost` 由账本按既有费率得出（`{ microUsdEstimated, note }`）；无法定价时返回 `microUsdEstimated: null` + 说明，**不得显示为免费**。
- **不限次数**：账本 MUST NOT 平台静默限流；如主办方显式设额，超额请以 `AI_BUDGET_EXCEEDED` 抛出，模块会返回 `sponsor_budget_exceeded`。
- `record` 抛错时模块 fail-closed 丢弃草稿——这是有意的：AI 产出必须可核对。

### NEEDS_INTERFACE-5 · 界面落点（不新增导航）

- 面板挂在**既有** 7 个 section 页内（`OrganizerSectionPage` 的对应 section），标题用 `MODULE_ASSISTANT_PANEL_TITLE`，
  并**逐字**展示：
  - `MODULE_ASSISTANT_PANEL_READS`（它读了什么：仅本场本模块的授权只读事实，只读范围逐次列出）；
  - `MODULE_ASSISTANT_PANEL_COPY_HINT`（只生成草稿/清单/摘要/去重提示，请自行复制或采用）；
  - `MODULE_ASSISTANT_PANEL_MANUAL_NOTE`（助手不可用时人工流程照常，平台不设强制次数上限）；
  - `MODULE_ASSISTANT_DISCLAIMER`（AI 身份 + "建议不构成执行授权"）。
- 界面须把 `usage.readScope`（读了哪些键、来源、缺失、读取时间）与 `usage.ledgerId/cost` 列出，做到可核对。
- 每个 section 只保留一个 `.primary`；助手按钮为次要动作，不抢主行动（布局文档 §一屏一个 .primary）。
- 建议路由（根实现，模块不提供 handler）：
  `POST organizer/events/:eventId/module-assistants/:assistantKey`（`run`）与
  `GET organizer/events/:eventId/module-assistants`（`catalog` + 本场开关状态）。
  匿名 401、越权 403、`MODULE_ASSISTANT_CONTEXT_CHANGED` 409。

### NEEDS_INTERFACE-6 · 赛事级助手开关

- 位置：`比赛设置 → 模块助手`（规划 34 §5.1），默认全开、可逐模块关，属**内部运营项**（即时生效并写既有审计，不随发布版本冻结）。
- 传参路径：经 NEEDS_INTERFACE-1 的 `enabledAssistants` 传入；关掉后 `run` 返回 `MODULE_ASSISTANT_DISABLED`，
  界面不渲染该 section 的助手入口，人工流程完全不受影响。

---

## 9. 根接入验收建议（供主会话补根测试时用）

1. 匿名 `POST` → 401；只有 `registration_manage` 的账号访问 `judging` → 403，且 `MODULE_ASSISTANT_FORBIDDEN`。
2. 只勾选"报名管理"助手时访问 `judging` → 403 `MODULE_ASSISTANT_DISABLED`。
3. 一次成功调用后：`GET` 账本/审计能看到账号、模块、只读键集合与花费；返回 `usage.ledgerId` 非空。
4. 同一赛事同一模块在两个账号下命名空间不同；与全站聊天/选手 AI 的会话记录互不出现。
5. 断开模型：接口返回 `status: "degraded"` 与 `reason: "model_unavailable"`，HTTP 仍为 200/明确错误码，人工流程接口照常 200。
6. 调用助手前后，既有报名/评审各只读汇总（含 `aggregate()`、`results-export`、公开投影）逐字段不变。

---

# 主会话 · P4 根接线决定与阻塞（2026-10-16，goal round 4）

已独立复核本模块：`node --experimental-strip-types --test src/modules/module-assistants/*.test.ts` → **21/21**；`tsc --noEmit` **exit 0**。

根接线**尚未实施**，因为有两个必须先定的问题（子会话已如实标出，这里给出主会话的处置方案）：

| # | 问题 | 现状事实 | 处置方案（下一轮执行） |
| --- | --- | --- | --- |
| 1 | 既有 AI 管道是**作业/租约**制：`withAiExecutionContext` 需要 `executionId`/`leaseToken`/`projectId`；账本 `PostgresAiLedger` 的额度桶与用量尝试挂在 `ai_execution_jobs`（`ai_budget_buckets` / `ai_usage_attempts`）上 | 模块助手是**同步请求**、且不是项目维度 | 采用**稳定的合成键**（与既有 `navigator-user:<actor>` 同法）：`organizer-assistant:<eventId>:<assistantKey>` 作为 `projectId`，`executionId` 用一次性 `requestIds.next()`，`leaseToken` 用同一次请求的随机标识；**不新增 AI job kind、不新增额度表**。若运维上更希望走后台作业，再单独立项——本轮先用合成键把同步路径打通 |
| 2 | `ModuleAssistantLedgerPort.record` 需要一个**可返回 `ledgerId` 且失败即 fail-closed** 的落点 | 既有账本只接受作业上下文；凭空写 `ai_usage_attempts` 会缺 `execution_id` | 让处置 1 的合成 `executionId` 同时作为账本尝试行的外键：先创建一条最薄的 `ai_execution_jobs` 行（kind = 模块助手）承载这次同步调用，再复用 `PostgresAiLedger` 的 `reserve`/`settle`。这样**复用既有账本**而不是第二套记账；若该行创建失败，助手按模块约定返回 `degraded` 并**丢弃草稿**（fail-closed 已由模块测试固定） |

**已定、无需再议的部分**：Scope Port 用服务端既有授权解析（`HostedEventAccessPort` + 有效 `StaffGrant`），**禁止**取自请求 JSON；非本场工作人员在**路由层**先返回 403（模块把 scope 解析失败统一映射为 503，所以 403 必须在根前置判定）；Facts Port 七个方法全部只读、`values` 只含注册表声明键（缺的键写进 `missing`，不 503）；界面挂既有 7 个 section 页，每页只保留一个 `.primary`。

**已完成（2026-10-16 主会话）**：

1. 根运行时 `src/server/module-assistant-runtime.ts`：Scope/Facts/Model/Ledger 四个 Port 适配落地。模型调用先落一条最薄的 `ai_execution_jobs` 行（`kind=module_assistant`、合成 `projectId=organizer-assistant:<eventId>:<assistantKey>`），在 `withAiExecutionContext` 内走既有 `createBudgetedModel` 的 reserve/settle；**没有模型调用就不伪造 `ledgerId`**。
2. **B1+B2 共 7 个助手全部接线**（`WIRED_MODULE_ASSISTANTS`）：概览（赛事状态/就绪清单/阻塞计数）、报名（状态计数/待审分页/报名表版本）、队伍（正式队伍数/分组线索）、通知答疑（公告/工单/公开 FAQ 计数与近期条目）、行程（草稿与已发布场次）、现场服务（住宿/餐券/破冰分组计数）、评审（收件/轮次/指派/进度）。**读不到的键一律写进 `missing`，绝不编造**（例如 capacity、时间冲突、模板数、校准/自检等本批未接的来源）。
3. 路由（根，`organizer-integration.ts`）：`GET organizer/events/:eventId/module-assistants`（目录，按能力过滤，匿名 401 / 非本场工作人员 403 / 非 GET 405）与 `POST organizer/events/:eventId/module-assistants/:assistantKey`（运行；未配置模型时 `degraded/model_unavailable`，B1 之外 403）。
4. 根验收已追加并通过：匿名 401、参赛者 403、B1 之外 403、`GET` 405、`POST` 返回 `degraded` 且 `manualWorkflowUnaffected: true`、调用前后原始汇总仍为 80。

**仍未完成**

- 7 个 section 页的助手面板（界面）；
- 赛事级助手开关（内部运营项、即时生效并写既有审计、不随发布版本冻结）；
- ~~B2 其余 5 个助手的事实适配~~ —— **已完成**（见上）。

**原清单（保留备查）**：① Scope/Facts/Model/Ledger 四个 Port 适配；② `GET|POST organizer/events/:eventId/module-assistants…` 路由；③ 7 个 section 页的助手面板；④ 赛事级助手开关（内部运营项、即时生效并写既有审计、**不随发布版本冻结**）；⑤ 根路由验收（匿名 401、无该能力 403、关闭的助手 403、降级仍 200 且人工流程照常）。
