# 空间倒计时与资源（纯计算）

S2 交付。把「还剩多少时间 / 还剩多少额度」算清楚，并且在数据缺失时说"不知道"，而不是说"还剩 0"。

本模块**只做纯计算**：没有 I/O、没有数据库、没有 UI、没有 `Date.now()`、没有副作用、没有完成百分比。
它不读取赛事或报名存储，全部事实由调用方传入。

## 公共接口

```ts
import { computeSpaceResource, computePhase, parseUtcInstant } from "./index.ts";
import type { SpaceResourceInput, SpaceResourceResult } from "./index.ts";

const outcome = computeSpaceResource({
  now: "2026-10-12T09:00:00.000Z",
  deadlines: [
    { id: "reg", label: "报名截止", instantUtc: "2026-10-12T00:00:00Z", sourceText: "官网原文", verified: true, kind: "registration" },
    { id: "start", label: "开赛", instantUtc: "2026-10-16T00:00:00Z", sourceText: "群公告截图转述", verified: false, kind: "start" },
    { id: "submit", label: "提交截止", instantUtc: "2026-10-25T00:00:00Z", sourceText: "官网原文", verified: true, kind: "submission" },
  ],
  budget: { totalMicros: 5_000_000, usedMicros: 1_250_000 },
});

if (outcome.ok) {
  outcome.result.next;     // { id, label, at, remainingMs, verified, sourceText, kind } 或 undefined
  outcome.result.overdue;  // 已过期截止，按时间升序
  outcome.result.phase;    // "before" | "during" | "after" | "unknown"
  outcome.result.budget;   // { totalMicros, usedMicros, remainingMicros, over } 或 undefined
}
```

- `computeSpaceResource(input)` 是唯一的计算入口，纯函数。
- `computePhase(nowMs, classified[])` 单独导出，便于根组件只重算阶段。
- `parseUtcInstant(value)` / `isValidUtcInstant(value)` 是严格 UTC 解析与校验。
- `formatMicros(micros)` 只做显示格式化，不参与计算。
- `model.ts` 是全部类型的唯一来源；`index.ts` 只导出纯函数与类型。

## 输入契约

```ts
{
  now: string;                        // ISO 8601，必须带 Z 或 ±HH:MM
  deadlines: {
    id: string;
    label: string;
    instantUtc: string;               // ISO 8601，必须带 Z 或 ±HH:MM
    sourceText: string;               // 原样带出
    verified: boolean;                // 只有调用方核验过才为 true
    kind?: "registration" | "start" | "submission" | "other" | null;  // 可选来源类别
  }[];
  budget?: { totalMicros: number; usedMicros: number };   // 非负安全整数（微单位）
}
```

`kind` 是调用方传入的**来源事实**，本模块不猜。缺省或非法值一律按"未分类"处理，
该截止仍参与 `next` / `overdue`，但不参与阶段边界。

## 输出契约

在分工文档的基础字段之外，结果里增加了三项**面向界面诚实性**的只读字段：

| 字段 | 用途 |
| --- | --- |
| `phaseBasis` | 阶段判定的可见依据（如 `after_submission`、`no_deadline`），界面可以解释"为什么现在算赛后"。 |
| `phaseLabel` | 阶段中文标签（赛前 / 赛中 / 赛后 / 时间未知）。 |
| `skippedDeadlines` | 被排除的截止（`invalid_instant` / `duplicate_id`），含原始 `id`/`label`/`instantUtc`。 |
| `unclassifiedDeadlineIds` | 未分类、因而不参与阶段边界的截止 ID。 |
| `issues` | 缺数据与非法输入的说明，正常结果为空数组。 |
| `now` | 传入时刻的规范化 UTC 形式，便于界面与日志对齐。 |
| `deadlineCount` | 参与计算的合法截止数量。 |

整体无法计算时返回 `{ ok: false, issues }`，**没有** `result` 字段。这样调用方无法把
"算不出来"误读成"没有剩余"。

## 边界定义（都有测试覆盖）

1. **恰好到点**：`instantUtc === now` 算**已到点、未过期**：`next.remainingMs === 0`，
   不进入 `overdue`。晚 1 毫秒才算过期。阶段同理：恰好等于结束边界仍算 `during`，
   晚 1 毫秒才算 `after`。
2. **跨时区**：所有比较都用绝对瞬间（epoch 毫秒）。`2026-10-12T09:00:00Z`、
   `2026-10-12T11:00:00+02:00`、`2026-10-12T04:00:00-05:00` 完全等价；
   计算结果与 `TZ` 环境变量无关（已在 `TZ=Pacific/Kiritimati`、`Etc/GMT+12`、`Asia/Shanghai` 下复跑）。
3. **拒绝无时区字符串**：`"2026-10-12T09:00:00"` 被拒绝。它会被 `Date` 按本机时区解释，
   时区依赖就是这样泄漏进来的。`2026-02-30`、`24:00`、`09:60` 等日历/时钟非法值同样被拒绝。
4. **缺数据**：没有未来截止 → `next` 为 `undefined`（键不存在）；没有预算 → `budget` 为 `undefined`；
   没有可用截止 → `phase: "unknown"` 且 `phaseBasis: "no_deadline"`。任何一处都不用 `0` 顶替。
5. **`verified: false` 原样保留**：`next` 与 `overdue` 都带出 `verified` 与 `sourceText`，
   本模块从不把未核验提升为官方确认，也从不因为未核验就丢弃该截止。
6. **非法单项**：单个非法 `instantUtc`、空 `id`/`label`、重复 `id` 只排除该项并记入
   `skippedDeadlines`，不抛异常、不产出 `NaN`。
7. **预算超额**：`remainingMicros = total - used` **不夹到 0**，超额时为负数，`over: true`。
   夹到 0 会让"超了 75 万"和"刚好用完"看起来一样。
8. **不产生百分比**：没有任何完成率、进度、`percent` 字段（宪法原则 X）。测试会扫描输出键与文本。

## 阶段判定规则

`phase` 由传入的 `kind` 推导，规则公开可复核：

- 结束边界 = 所有 `registration` / `submission` / `other` 中最晚的一个。
- 开赛边界 = 所有 `start` 中最早的一个。
- `now < 结束边界` 时：有开赛边界且 `now >= 开赛` → `during`；没有开赛边界但有 `submission` → `during`；
  否则 → `before`。
- `now >= 结束边界` 时：结束边界是 `submission` → `after`（`after_submission`）；否则 → `after`（`after_latest`）。
- 没有任何可分类截止 → `unknown`（`no_deadline`）。

## 已知取舍

- **阶段是推论，不是事实**。赛事存储里没有结构化的"开赛/结束"字段，所以阶段由调用方给的
  `kind` 推得。如果根会话用 `sourceText` 关键词猜 `kind`，猜错会直接改变阶段；`phaseBasis`
  与 `unclassifiedDeadlineIds` 就是为了让这种不确定性可见。更稳的做法是根会话从主办方配置
  或 `HostedEvent` 明确字段映射 `kind`（见交付文档 `NEEDS_ROOT`）。
- **`kind` 缺省即不参与阶段**。未分类截止会影响下一截止与过期列表，但不会把 `phase` 拽到
  `unknown`——除非一条可分类的都没有。
- **没有时区本地化的日历天**。"还剩 3 天"这类按自然日表达的口径不在本模块：本模块只给毫秒，
  因为"按谁的午夜切一天"取决于显示地时区，属于界面决策，不属于纯计算。
- **重复 ID 保留首个**。重复 ID 会让 `next` 与 `overdue` 对同一条记录给出矛盾结论；
  保留输入顺序中的第一条是可预测的选择，并记入 `skippedDeadlines`。
- **毫秒取整**：`instantUtc` 的小数秒不足 3 位时按毫秒左侧补零（`.5Z` → `.500`）。

## 测试与验证

```powershell
node --experimental-strip-types --test src/modules/space-resource/compute.test.ts
node scripts/run-module-tests.mjs space-resource
node node_modules/typescript/bin/tsc --noEmit
```

日志：`.runtime/s2-space-resource.log`。更新记录见 `docs/协作/交付/space-resource.md`。

## 未接入

本模块没有路由、页面、组件、迁移或持久化，也不读写任何既有模块的表。
界面装配（画布上的倒计时与资源卡片）与 `kind` 映射由主会话完成。
