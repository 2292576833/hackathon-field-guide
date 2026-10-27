# module-assistants · 主办方流程模块专属助手框架

依据：`docs/规划/34-主办方模块化与选手社区.md` §2.1/§2.2、宪法 v1.23.0 原则 XIII「模块专属助手（AI 边界）」、
原则 XI「评审 AI 隔离」、原则 IX「外部依赖失败时仍可继续工作」、规划 32 §4.0 吸收闸门。

本模块只有框架与运行时，不含任何业务写入：它把 7 个主办方流程模块各配一个只读助手，
只产出草稿 / 核对清单 / 摘要 / 去重提示，每次调用计入注入的既有 AI 账本。

## 公共接口

```ts
import { createModuleAssistantService, MODULE_ASSISTANT_REGISTRY } from "../module-assistants/index.ts";

const assistants = createModuleAssistantService({ scope, facts, model, ledger, clock });
const catalog = assistants.catalog();
const result = await assistants.run(actor, { assistantKey: "registration", eventId, instruction: "整理待审报名的处理优先级" });
// result.status === "draft" | "degraded"
```

- 注册表：`MODULE_ASSISTANT_REGISTRY`（**12 条**：7 个主办方环节 + 5 个选手端环节；每条声明 key、标签、受众、所需权限或参赛状态、可读事实键、允许产出、挂载 sectionPath）。
- 注入 Port：`ModuleAssistantScopePort`（授权范围只读）、`ModuleAssistantFactsPort`（每模块一个只读方法）、
  `ModuleAssistantModelPort`（模型，模块不接网络）、`ModuleAssistantLedgerPort`（既有 AI 账本）。
- 独立上下文：`moduleAssistantNamespace()` = 机构 + 赛事 + 模块 + 账号；不共享全局缓存。

## 硬性边界

1. 只读：事实全部来自注入 Port，模块内没有 SQL、没有数据库句柄、不导入其他模块私有文件。
2. 只出草稿：产出类型只有 `draft` / `checklist` / `summary` / `dedup_hint`，服务端固定 `requiresHumanAction: true`。
3. 无写路径：没有发布、发信、扣分、改结果、改权限调用。
4. 可核对：每次调用写账本（谁、哪个模块、读了什么范围、花费），界面可展示 `usage`。
5. 不限次数：平台不设强制次数上限；主办方显式额度由账本 Port 负责，不静默限流。
6. 可降级：模型不可用 / 失败 / 产出不合格 / 记账失败都返回 `status: "degraded"`，人工流程照常。

## 测试

`node scripts/run-module-tests.mjs module-assistants`

```
node node_modules/typescript/bin/tsc --noEmit --incremental false
```
