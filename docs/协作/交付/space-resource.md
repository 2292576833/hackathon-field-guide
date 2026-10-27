# 交付说明 · S2 倒计时与资源（纯计算）

- 会话：S2（规划27 第 4.2 项「倒计时 + 资源组件」的纯计算部分）
- 授权来源：`docs/协作/规划27后续分会话分工-2026-10-12.md` 第 2 节 S2
- 日期：2026-10-12
- 状态：**已完成，未接入**；交付后立即停止，不再修改任何文件

## 1. 改了哪些文件

全部为**新增**文件，未修改任何既有文件、未新增迁移、未写库、未做 UI、未运行构建或重启服务。

| 文件 | 内容 |
| --- | --- |
| `src/modules/space-resource/model.ts` | 全部类型与标签常量：`SpaceResourceInput` / `SpaceDeadlineInput` / `SpaceResourceResult` / `SpacePhase` / `SpaceBudgetView` 等 |
| `src/modules/space-resource/compute.ts` | 纯函数：`computeSpaceResource`、`computePhase`、`parseUtcInstant`、`isValidUtcInstant`、`phaseBasisLabel`、`formatMicros` |
| `src/modules/space-resource/compute.test.ts` | node:test 行为测试，29 项 |
| `src/modules/space-resource/index.ts` | 公共导出（只导出纯函数与类型，不导入 TSX / DB / React） |
| `src/modules/space-resource/README.md` | 输入输出契约、边界定义、阶段规则、已知取舍 |
| `docs/协作/交付/space-resource.md` | 本文件 |
| `.runtime/s2-space-resource.log` | 测试日志（本人专属，未污染他人文件） |

## 2. 已完成

- 输入契约按要求实现：`{ now, deadlines[{id,label,instantUtc,sourceText,verified,kind?}], budget? }`。
  未读取赛事存储、报名存储、项目存储或任何账号权限。
- 输出契约按分工文档实现，并**只增不改**原有字段名与含义：
  `next?{id,label,at,remainingMs,verified}`、`overdue[]`、`phase`、`budget?`。
  新增的只读字段：`sourceText`/`kind`（沿用输入事实）、`phaseBasis`、`phaseLabel`、
  `now`、`deadlineCount`、`skippedDeadlines`、`unclassifiedDeadlineIds`、`issues`、
  以及顶层判别字段 `ok`。
- 纯函数、无副作用、无 `Date.now()`、无 I/O；非法时间字符串安全拒绝，不抛未处理异常、不产出 `NaN`。
- 不产生任何完成百分比或完成状态。
- `tsc --noEmit` 全库通过（exit 0，0 行输出），其中包含本模块。

## 3. 已验证（真实执行，非推断）

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| 模块自带测试 | `node --experimental-strip-types --test src/modules/space-resource/compute.test.ts` | **29 项，通过 29，失败 0** |
| 仓库测试入口 | `node scripts/run-module-tests.mjs space-resource` | 同上：29 / 29 通过 |
| 时区无关复跑 | 同上，分别设 `TZ=Pacific/Kiritimati`、`TZ=Etc/GMT+12`、`TZ=Asia/Shanghai` | 三种时区均 29 / 29 通过，结果一致 |
| 类型检查 | `node node_modules/typescript/bin/tsc --noEmit` | exit 0，无诊断 |

测试日志：`.runtime/s2-space-resource.log`（最后一次运行是 `TZ=Asia/Shanghai` 前的同命令输出；
三次时区复跑的结果已记录在本节表格中）。

### 逐项测试清单（29 项，全部通过）

1. UTC 解析：接受 Z 与显式偏移，并归一到同一瞬间
2. UTC 解析：拒绝缺少时区标记、日历上不存在的日期与非法值
3. 同一瞬间的三种写法给出相同倒计时，且回显规范化 UTC 时刻
4. 跨时区：偏移描述同一瞬间时结果完全一致，不同瞬间则不同
5. 恰好等于 now：算已到点、未过期，remainingMs 为 0 且不进 overdue
6. 相差 1 毫秒：前一毫秒算过期，后一毫秒算还剩 1 毫秒
7. next 取最早未过期项；overdue 按时间升序且带原始标记
8. verified: false 全程原样保留，绝不被提升为官方确认
9. verified 缺省或非布尔时按未核验处理
10. 没有任何未来截止时 next 为 undefined，不用 0 冒充
11. 全部截止未分类且已过期：next 仍为 undefined，phase 不猜成赛后
12. 没有截止数据：next 与 phase 都不猜，issues 说明缺什么
13. 缺预算返回 undefined，绝不回落为 0
14. 预算正常：remainingMicros 为差额，over 为 false
15. 预算超额：remainingMicros 为负数并标记 over，不夹到 0
16. 预算非法：按缺数据处理并记录 issue，不产出 NaN 或 0
17. 阶段：赛前 / 赛中 / 赛后 及边界
18. 阶段：没有开赛时刻但有提交截止，只在过期后判赛后并对依据留痕
19. 阶段：只有开赛时刻时无法判定，返回 unknown 而不是赛前
20. 阶段：未分类截止参与倒计时但不参与阶段边界
21. computePhase 独立可调用，边界收在函数契约上
22. 非法截止时刻被安全拒绝：不抛异常、不产出 NaN，并列入 skippedDeadlines
23. 重复 ID 只保留第一个并记录冲突，保证 next/overdue 不自相矛盾
24. 整体非法输入返回 ok: false，不抛未处理异常
25. 纯函数：不改动输入对象，同输入同输出
26. 输出不包含完成状态或百分比字段
27. 倒计时数值只用整数毫秒，负数只出现在 overdue 之外的语义里
28. 顺序无关：打乱输入顺序不改变倒计时结果
29. 同一天不同偏移的截止按瞬间排序，不按字符串排序

## 4. 模拟测试

**不适用。** 本模块是纯函数，没有外部服务、没有数据库、没有时间源、没有网络。
全部测试都是对真实实现的直接断言，没有 mock、没有内存夹具、没有替身。

## 5. 未接入

- 没有路由、页面、React 组件、CSS、数据库迁移、持久化或后台任务。
- 没有读取或写入任何既有模块的表；没有 import 其他模块的私有文件（只 import Node 内置与自身文件）。
- 画布上的「倒计时 / 资源」卡片（分工文档 R4）由主会话装配；本模块只提供上面列出的纯函数与类型。
- 需要环境变量：**无**。

## 6. NEEDS_ROOT

| # | 需要主会话做的事 | 原因 |
| --- | --- | --- |
| N1 | 为每条截止映射 `kind`（`registration` / `start` / `submission` / `other`） | 本模块不读赛事存储，`kind` 只能由调用方给。**优先从主办方报名配置或 `HostedEvent` 的明确字段映射**，不要在根服务里用 `sourceText` 关键词猜——猜错会直接改变 `phase`，而 `phase` 会被界面当成事实展示。 |
| N2 | 判定 `deadline.verified` 的真实来源 | 本模块只做原样传递。谁有权把某条截止标成已核验（人工审核记录？主办方配置？）属于根权限范畴，本模块不参与，也不能替它决定。 |
| N3 | 提供 `now` | 本模块没有时钟，禁止 `Date.now()`。根组件需要注入当前 UA 时刻（例如已有的 `Clock` 契约），并在客户端刷新时重新计算。 |
| N4 | 决定毫秒到界面文案的换算 | 「还剩 3 天」这类自然日表达依赖显示地时区与取整习惯，属于界面决策。本模块只给毫秒，不替界面决定切天口径。 |
| N5 | 未分类截止占多数时的界面兜底 | 当 `phase === "unknown"` 时，界面必须显示"时间未知"，不能回退显示"赛前"。建议同时展示 `unclassifiedDeadlineIds` 对应的来源文字，让用户看到缺口。 |
| N6 | `budget` 的数据来源与展示口径 | 本模块不知道额度来自赛事、项目还是账号；也不建议界面在 `budget === undefined` 时显示"0 元"或"未使用"。 |

## 7. 边界处理的已知取舍（重点）

### 7.1 「恰好到点」

统一口径：**恰好等于 `now` = 已到点、未过期**。

- `next.remainingMs === 0`，该截止仍在 `next` 里，不进入 `overdue`；晚 1 毫秒才算过期。
- 阶段同理：`now` 恰好等于结束边界仍为 `during`；`now = 结束边界 + 1ms` 才为 `after`。
- 理由：界面需要在"还剩 0 毫秒"这一刻仍显示"就是现在/正在截止"，而不是提前宣布已过期。
  这是明确定义并写进测试（第 5、6、17、21 项）的选择，**不是**隐含行为。
- 代价：在恰好等于截止时刻的那 1 毫秒窗口内，界面会同时显示"还剩 0"和"未过期"。
  如果主会话希望改成"到点即过期"，只需把 `compute.ts` 里的 `<` 改成 `<=`（两处：`overdue` 判定与
  `computePhase` 的 `nowMs <= endMs`），并同步改这 4 项测试的期望值。

### 7.2 跨时区

- 全部比较使用**绝对瞬间**（epoch 毫秒），不使用 `getFullYear`/`getMonth`/`getDate`/`getHours` 等
  按本机时区解释的 API，因此结果与运行机器的 `TZ` 无关（已在三个差异极大的时区下复跑验证）。
- **只接受带显式时区标记的字符串**。`"2026-10-12T09:00:00"`（无 `Z`、无偏移）被拒绝，
  因为 `Date` 会把它按本机时区解释——时区依赖正是从这里泄漏的。调用方必须传 UTC 或带偏移的时刻。
- `2026-10-12T09:00:00Z`、`2026-10-12T11:00:00+02:00`、`2026-10-12T04:00:00-05:00` 三者等价，
  输出统一规范化为 `2026-10-12T09:00:00.000Z`。
- **本模块不产出自然日**。不返回"还剩几天"，因为"一天"取决于用哪个时区的午夜切分；
  这属于界面决策（见 N4）。

### 7.3 缺数据不用 0 冒充（三重保障）

- 没有未来截止 → `next` 键**不存在**（不是 `{ remainingMs: 0 }`）。
- 没有预算或预算非法 → `budget` 键**不存在**（不是 `{ remainingMicros: 0 }`）。
- 没有可用截止 → `phase: "unknown"`、`phaseBasis: "no_deadline"`（不是 `"before"`）。
- 整体无法计算（`now` 非法、输入不是对象、`deadlines` 不是数组）→ `{ ok: false, issues }`，
  **没有** `result` 字段，调用方无法把"算不出来"当成"没有剩余"。

### 7.4 阶段是推论，不是记录

赛事存储里没有结构化的"开赛/结束"字段，所以 `phase` 由调用方给的 `kind` 推得，
输出同时给出 `phaseBasis`、`phaseLabel`、`unclassifiedDeadlineIds` 作为可复核依据。
**未分类的截止不参与阶段边界**：它们会出现在 `next` / `overdue` 里，但不会把阶段拽到
`"during"`，也不会（在存在可分类截止时）把阶段拽到 `"unknown"`。
如果一条可分类截止都没有，则返回 `"unknown"`，不假装"赛前"。

### 7.5 其他明确定义的选择

- **超额不夹零**：`remainingMicros = total - used`，超额为负数、`over: true`。
  夹到 0 会让"超了 75 万"和"刚好用完"看起来一样。
- **预算用非负安全整数微单位**：小数、负数、`NaN`、`Infinity` 一律按缺数据处理并记 `issues`，
  不四舍五入替调用方下决定。
- **非法单项只丢单项**：非法 `instantUtc`、空 `id`/`label` 记入 `skippedDeadlines`
  （`reason: "invalid_instant"`），不因为一条脏数据放弃整个倒计时。
- **重复 ID 保留首个**：重复 ID 会让 `next` 与 `overdue` 对同一 `id` 给出矛盾结论。
  保留输入顺序中的第一条并记 `duplicate_id`。
- **`sourceText` 原样透传**：不裁剪、不改写、不总结；`verified: false` 在任何输出位置都保持 `false`。

## 8. 无法确定

- **`kind` 的真实来源无法确定**：本会话无权读赛事/报名模块，无法判断根侧能否从
  `HostedEvent` 或主办方报名配置里拿到结构化的开赛/提交时刻。若拿不到而必须靠 `sourceText`
  关键词推断，则 `phase` 的准确度取决于推断质量，应在界面注明依据（`phaseBasis`）。
- **`verified` 的授权规则无法确定**：谁能把截止标为已核验属于根权限设计，本模块不做假设。
- **毫秒到自然日文案的换算口径无法确定**：取决于产品决定用哪个时区切天，本模块有意不实现。
- **生产数据中的 `budget` 单位与来源无法确定**：本模块按"非负安全整数微单位"实现，
  若根侧实际存的是分或小数美元，需要调用方在传入前转换（见 N6）。

## 9. 停止声明

本会话在写完本文件与 `README.md` 后**立即停止**，不再修改任何文件（包括自己的模块）。
上文所有 `NEEDS_ROOT` 项交主会话统一处理；若需要调整「恰好到点」口径或扩展输出字段，
请由主会话明确指派后再改。旧授权不延续。
