# S4 · 检查条件细化（规划27 第 3.5 项）交付说明

> 会话：S4 ｜ 依据：`docs/协作/规划27后续分会话分工-2026-10-12.md` 第 2 节 S4、`docs/规划/27-团队空间操作空间与主页主路径.md` 第 8 节第 3.5 项
> 交付日期：2026-10-12 ｜ 本会话交付后立即停止，不再修改任何文件

## 1. 已完成

只新增两个文件，**没有修改 `src/modules/planning/` 下任何既有文件**：

| 文件 | 内容 |
| --- | --- |
| `src/modules/planning/acceptance-detail.ts` | 纯函数 `detailAcceptance`：校验 + 合并 + 留痕；导出的常量、类型与 16 个 `reasonCode` |
| `src/modules/planning/acceptance-detail.test.ts` | `node:test` 行为测试 **22 项** |

未接入 `index.ts` 公共导出（既有文件不许改），因此根装配需要显式按路径导入，见第 4 节 `NEEDS_ROOT`。

### 1.1 输入与输出契约

```ts
detailAcceptance(input: {
  existing: readonly string[];
  proposed: readonly { text: string; byUserId: string; at: string; void?: boolean; voidReason?: string }[];
  actorUserId: string;
  actorMayRefine?: boolean;   // 根服务核对完“当前用户能否细化这只任务”后传 true
}) => {
  criteria: string[];                 // 合并后的完整条件（已有按原顺序原文 + 新增追加在末尾）
  added:   { text; byUserId; at }[];  // 被接受的新增，保留提交人/时刻
  voided:  { text; reason; byUserId; at }[];  // 作废标注，原文与理由都在
  rejected:{ text; reason; reasonCode }[];    // 逐条拒绝原因，中文可直接展示
  trace:   ({action:"added"|"voided"; applied:true; ...} | {action:"rejected"; applied:false; reasonCode; reason; ...})[];
  summary: string;                    // 例：`检查条件共 3 条，本次新增 2 条：“…”、“…”；拒绝 1 条：“…”。`
}
```

### 1.2 行为规则（与硬约束逐条对应）

1. **不得删除或篡改已有条件**：`criteria` 恒以 `[...existing]` 开头，**原文、原顺序、甚至非法旧条目都原样保留**（测试覆盖两边带空格、重复原文、空字符串、超长旧条目）。停用只能走 `void: true` 的**标注作废**，`criteria` 不变，`voided[]` 同时带走原文与理由。
2. **可追溯**：每条被接受的 `added`/`voided` 原样保留提交的 `byUserId` 与 `at`；`trace` 是追加式审计轨迹（含被拒绝的提交：“提交过什么、为什么没生效”也能复查）。
3. **空输入返回原样**：只传 `existing` 时 `criteria` 等于原数组，`added/voided/rejected/trace` 全为空，`summary` 说明保持原样。
4. **重复识别**：比较键折叠多余空白与全角空格（`"  A  "`、`"A　"` 与 `"A"` 视为同一条），同批内重复只接受第一条，其余进 `rejected` 并给理由。
5. **输入校验不抛异常**：任何非法输入都变成 `rejected` 条目（带 `reasonCode` + 中文 `reason`），**从不 throw**。覆盖：空/纯空白、控制字符与零宽字符、超长、缺提交人、缺时刻、时刻格式非法、非法 `void` 值、未知字段、非对象条目、整批不是数组、条数超限。
6. **无副作用**：不读库、不写库、不改状态、不调 `Date.now()`，也不修改传入的数组或对象。测试用冻结（`Object.freeze`）输入 + 替换 `Date.now` 计数器断言。

### 1.3 自定上限（README 要求说明）

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `ACCEPTANCE_DETAIL_MAX_TEXT_LENGTH` | **500 字** | 单条条件正文上限（折叠空白后按 UTF-16 长度计）。比 `/planning` 既有 `parse.ts` 的通用文本上限 4000 更严：条件是要一眼看懂的短句，超长应拆条 |
| `ACCEPTANCE_DETAIL_MAX_CRITERIA` | **200 条** | 一只任务的条件总数上限；已达上限只拒绝新追加，**不动**已有条目 |
| `ACCEPTANCE_DETAIL_MAX_PROPOSALS` | **200 条** | 单次提交条数上限；超过则**整批拒绝**并说明，不静默丢弃后面的条目 |
| `ACCEPTANCE_DETAIL_MIN_VOID_REASON_LENGTH` | **8 字** | 作废理由最短长度，防止“作废”变成无据操作 |

### 1.4 文本规范化与拒绝口径（重要，界面文案需一致）

- **可折叠空白**（制表、换行、不换行空格、全角空格、行/段分隔符 U+2028/2029）：折叠成一个空格并**保留内容**。例如 `"两行\u2028分开"` → `"两行 分开"`、`"制表\t符"` → `"制表 符"`。理由：这些字符是正常排版输入，内容可读，整条拒绝会误伤。
- **拒绝的不可见字符**：C0/C1 控制字符、零宽字符（U+200B–U+200F）、方向隔离符（U+202A–U+202E、U+2060–U+2064、U+2066–U+2069）、U+FFF9–U+FFFB → `TEXT_CONTROL_CHARACTER`。
- **纯空白或只有零宽字符** → `TEXT_MISSING`。
- **`at` 必须是带时区的 ISO-8601**（如 `2026-10-12T03:00:00.000Z`、`2026-10-12T11:00:00+08:00`）。宽松处：允许省略秒/毫秒、允许小写 `t`/`z`；`2026-10-12`、`2026/10/12 03:00`、无时区、月份越界一律拒绝。
- **作废原文按比较键匹配**，命中的原文以 `existing` 里的**原字符串**记录（不会把旧格式提纯）。已知边界：若已有条件本身含零宽字符，作废时读不出该条原文，会被报成 `VOID_TARGET_NOT_FOUND`（无法确定线上是否真有这种旧数据，**无法确定**）。

### 1.5 16 个 `reasonCode`

`TEXT_MISSING` `TEXT_TOO_LONG` `TEXT_CONTROL_CHARACTER` `AUTHOR_MISSING` `TIME_MISSING` `TIME_INVALID` `NOT_OBJECT` `INVALID_OPERATION` `VOID_REASON_MISSING` `VOID_TARGET_NOT_FOUND` `VOID_TARGET_ALREADY_VOIDED` `DUPLICATE_CRITERION` `CRITERIA_LIMIT_REACHED` `PERMISSION_NOT_CONFIRMED` `INPUT_NOT_ARRAY` `PROPOSALS_LIMIT_REACHED`

判定顺序（可预测，已由测试固定）：字段白名单/`void` 类型 → 内容（空/控制字符/超长）→ 作废目标 → 作废理由 → 重复 → 提交人 → 时刻 → 权限 → 条数上限。

## 2. 已验证

**测试命令**（本会话实际执行）：

```
node --experimental-strip-types --test src/modules/planning/acceptance-detail.test.ts
```

**结果：tests 22 / pass 22 / fail 0**（日志：`.runtime/s4-acceptance-detail.log`）

22 项测试逐条覆盖：

| # | 测试 | 断言要点 |
| --- | --- | --- |
| 1 | 空输入原样返回 | `criteria` 深等于原数组，四个变更数组为空，`summary` 说明保持原样 |
| 2 | 完全没有条件也不报错 | `criteria` 为空、`summary` 固定文案 |
| 3 | 追加保留原文顺序并可追溯 | 已有在前、新增按提交顺序在后；`added` 带 `byUserId`/`at`；输入数组未被改写 |
| 4 | 重复识别（多余空白/全角空格） | 4 条全部 `DUPLICATE_CRITERION`，逐条留痕 |
| 5 | 同批内重复只接受第一条 | 1 条入 `added`，1 条进 `rejected` |
| 6 | 空/纯空白/缺字段 | 3 条 `TEXT_MISSING`，合法条目仍生效 |
| 7 | 超长上限 | 恰好 500 字接受，501 字 `TEXT_TOO_LONG`，理由带上限数字 |
| 8 | 控制字符与零宽字符 | 4 条 `TEXT_CONTROL_CHARACTER`；制表符与 U+2028 折叠后接受 |
| 9 | 作者与时刻 | `AUTHOR_MISSING`×2、`TIME_MISSING`、`TIME_INVALID`×3；带 `+08:00` 偏移的合法时间被接受 |
| 10 | 非当前操作人 | `PERMISSION_NOT_CONFIRMED` 且保留原文，不静默丢弃 |
| 11 | 未核对权限（未传/false） | 一律拒绝，不记录无据作者 |
| 12 | 作废保留原文与理由 | `criteria` 完全不变，`voided` 含原文/理由/作者/时刻，`trace` 有 `voided` |
| 13 | 作废的四类拦截 | `VOID_REASON_MISSING`、`VOID_TARGET_NOT_FOUND`、`VOID_TARGET_ALREADY_VOIDED`×2，成功的只有 1 条 |
| 14 | 作废也要核对权限 | 条件与 `voided` 都不动 |
| 15 | 非法操作/非法字段 | `void:"true"`、未知字段 `action`/`extra` 被拒；合法 `void:false` 等价追加 |
| 16 | 整批不是列表 | `undefined/null/字符串/对象/数字` 五种输入都不抛异常，`INPUT_NOT_ARRAY` |
| 17 | 列表混入非对象 | 逐条 `NOT_OBJECT`，其余正常生效 |
| 18 | 单次提交超限 | 201 条整批 `PROPOSALS_LIMIT_REACHED`，不静默丢弃 |
| 19 | 条件总数上限 | 200 条后拒绝追加，已有 200 条一条不动 |
| 20 | 不改写已有条目 | 空格原文、重复原文、空字符串、超长旧条目全部原样保留 |
| 21 | 纯函数 | 冻结输入不抛错（严格模式下写入会抛）、`Date.now` 调用次数为 0、返回新数组/新对象 |
| 22 | 摘要 | 三种情形下 `summary` 非空，且不含 `%`/百分比/完成率/进度 |

**没有验证的边界**（明确说明）：
- 未跑全仓 `npm run typecheck`（分工第 0 节第 2 条：分会话不运行构建/类型检查命令；本会话只跑自己文件的行为测试）。文件只用 Node 类型剥离可解析的语法（无 enum / 无参数属性 / 无装饰器）。
- 未接数据库、未接 HTTP、未做浏览器验收（本条只做纯逻辑，持久化与审计归主会话）。

## 3. 模拟测试 / 未接入

- **未接入**：`src/modules/planning/index.ts` 未导出本文件（既有文件不许改），根服务与界面都还没调用它。
- **模拟测试**：无 mock。测试只调用真实纯函数，不需要夹具、时钟或数据库。
- **未使用的真实事实**：真实任务的条件内容、真实成员 ID、真实当前时刻都来自主会话；本函数不接触它们。

## 4. NEEDS_ROOT（主会话要做的持久化与审计改动）

> 本会话**没有**也无法修改下列文件；以下为具体到“文件 + 加什么”的建议，最终以主会话的根装配为准。

### R1. 持久化：把 `voided` 落到任务状态（`service.ts` + `types.ts`）

- `src/modules/planning/types.ts`：`PlanningTask` 增加**可选**字段（旧 JSON 无此字段仍可读）：
  - `acceptanceCriteriaVoided?: { text: string; reason: string; byUserId: string; at: string }[]`
  - `acceptanceCriteriaDetailTrace?: { action: "added" | "voided"; text: string; byUserId: string; at: string; reason?: string }[]`
- `src/modules/planning/service.ts`：新增一个只改条件的命令（建议 `refineAcceptanceCriteria`，与既有 `updateProgress` 同风格）：
  1. 事务内 `authorize` + `facts.lockVersions` + `assertWritable`（沿用既有写法），并核对 `expectedTasksRevision` / `task.revision`，旧版本返回 `VERSION_CONFLICT`。
  2. 权限判定必须由根服务做完再传 `actorMayRefine: true`：负责人可细化**本人负责**的任务；manager 可细化本空间任务；其他人 `false`（**必须显式传，不传即拒绝**）。
  3. 调 `detailAcceptance({ existing: task.acceptanceCriteria, proposed, actorUserId: actor.userId, actorMayRefine })`。
  4. `rejected.length > 0` 时**整批不写入**并返回 422（附 `rejected`），避免“部分生效”难以解释；若主会话想部分生效，则只写 `added`/`voided` 并把 `rejected` 一并回传前端。
  5. 写入：`task.acceptanceCriteria = result.criteria`（**只追加，绝不重排/删除**）、合并 `acceptanceCriteriaVoided`、追加 `acceptanceCriteriaDetailTrace`、`task.revision += 1`、`state.tasksRevision += 1`、`state.revision += 1`。
  6. 幂等与 outbox 沿用既有机制（`getIdempotent` + 现有事件枚举，不要新增枚举类型）。
- `src/modules/planning/parse.ts`：新增对应的严格入参解析（白名单字段 `expectedRevision`、`expectedTasksRevision`、`items[{text, void?, voidReason?}]`、`idempotencyKey`），**`byUserId`/`at` 由服务端用 `actor.userId` 与 `this.now()` 填**，不能由客户端指定。
- SQL 迁移：**建议为 0**。上述字段放既有 `planning_states.state_json`，与既有做法一致；若主会话偏要独立列，再由主会话决定并写递增迁移（本会话不新增迁移）。

### R2. 审计可追溯：作废不能只进 JSON

- `src/modules/planning/notification-facts.ts`（或既有 outbox/通知产物）：建议让细化/作废**顺带产生一条队友可见的事实**（谁在何时加了什么条件、作废了什么、为什么），否则“留审计”只对读 JSON 的人可见。
- 需要保证：作废是**追加记录**，历史 `PlanVersion.inputSnapshot.tasks` 与既有 `ProgressUpdate` 的历史**不被改写**（与既有“历史快照不改写”一致）。

### R3. HTTP 路由与界面

- 新路由（建议 `POST /projects/:projectId/tasks/:taskId/acceptance-criteria`，接 R1 的 handler）：`403` 非负责人/管理员、`409` 旧 revision、`422` 含被拒绝条目并回传中文理由。
- 界面：任务检查条件区域允许负责人追加与作废；作废后**原件仍然显示**并标“已作废 + 理由”，不得只显示新列表。`rejected[].reason` 可直接展示。

### R4. 需要主会话确认的口径（本会话按下列默认实现，若不认可需改根文档）

1. `actorMayRefine` **未传 = 拒绝**（宁可拒绝一条也不记无据作者）。
2. 单次提交超限 / 整体不是数组 → **整批不动**并说明（不静默丢弃）。
3. 上限值 500 字 / 200 条 / 200 条 / 8 字（见 1.3）；界面提示文案应与这些数字一致。
4. 可折叠空白 vs 拒绝字符的口径（见 1.4）；`TEXT_MISSING` 与 `TEXT_CONTROL_CHARACTER` 的区分会影响前端提示。

### R5. 并发与审计要点（持久化时必须保证）

1. **读-改-写必须在同一事务里锁住**：`existing` 必须是事务内刚读到的 `task.acceptanceCriteria`，不能用在事务外读到的旧数组去合并，否则两个负责人并发细化会**互相覆盖**（谁后写谁赢）。
2. **版本校验要双重**：`task.revision`（单任务）与 `tasksRevision`（全计划）都要核对；细化只影响本任务，但仍要走全局 revision 以保证与 `updateProgress`/`correctAcceptance` 的既有冲突语义一致。
3. **幂等键域要隔离**：建议 `scope = ${actor.userId}:acceptance-detail:${taskId}`，避免与 `progress`/`acceptance-correction` 的幂等结果互相串。
4. **完成门槛不受影响**：`updateProgress` 里 `if (!task.acceptanceCriteria.length)` 的完成前置仍成立；**细化不是验收**，不得因此把任务状态改成 `done`，也不得清除既有 `acceptance`。作废最后一条条件时该任务将无法完成（`ACCEPTANCE_REQUIRED`），服务端应允许但要在界面提醒。
5. **已验收任务**：既有规则是已 `done` 任务不可被普通进度覆盖（`COMPLETED_TASK_IMMUTABLE`）。细化是否允许改已验收任务的条件**无法确定**，建议按既有保守口径拒绝，并在交付/界面说明；若要允许，必须同时保留原条件原文与作废理由。
6. **归档/只读复核**：与既有一样，事务内最终 `assertWritable` 复核项目归档/只读，防止细化绕过只读保护。
7. **不可变历史**：`criteria` 只增不减这一条要在服务端强制（写库前再断言新数组前 N 项与 `existing` 完全一致），不要只依赖前端。

### R6. 既有文件未改动确认

`service.ts`、`postgres.ts`、`types.ts`、`index.ts`、`rules.ts`、`parse.ts`、`http.ts`、`README.md` 等**全部未被本会话修改**（目录内最新修改时间只有本会话新增的两个文件）。

## 5. 需要的环境变量

无。本交付不读取 `.env.local`，不访问外部服务，不新增环境变量名。
