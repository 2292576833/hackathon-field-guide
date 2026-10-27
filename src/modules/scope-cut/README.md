# scope-cut · 「做不完怎么砍」退路

> 归属：规划27 第 4.3 项（[27-团队空间操作空间与主页主路径.md](../../../docs/规划/27-团队空间操作空间与主页主路径.md) 第 8 节）
> 授权：[规划27后续分会话分工-2026-10-12.md](../../../docs/协作/规划27后续分会话分工-2026-10-12.md) 第 2 节 S1

## 这个模块解决什么

新手在黑客松最常见的处境不是"做不出来"，是**做不完**。全站之前没有任何地方教他如何砍范围保交付。
本项目已有「最小成果」（`minimumDeliverable`）概念，正好是这件事的支点：**最小成果就是"砍到哪里为止"的那条线**。

本模块把调用方**已经读到的只读事实**，翻译成一句判断 + 一组可执行的取舍建议。它只回答一个问题：

> 按现在知道的事实，还来不来得及？如果来不及，先砍什么、守住什么、对队友怎么说。

## 不是完成状态，不产生完成百分比

本模块**不产生**任何完成状态、完成度、百分比或"还剩 N% 工作"（宪法原则 X、规划27 第 9 节第 10 条）。
它引用的事实只有两类：

- 调用方传入的剩余毫秒（真实的时间预算）；
- 调用方传入的任务计数（原样引用，例如"总数 12、已完成 5"）。

从不把计数换算成"完成了 42%"，也不替团队判断"你们做到哪一步了"。
输出里的 `notice` 会明确写出"本模块不推算完成度、不给完成百分比"。

## 输入契约

```ts
interface ScopeCutFacts {
  goal: string;                 // 当前目标，团队自己写的一句话
  minimumDeliverable: string;   // 最小成果：交付底线
  remainingMs: number;          // 距下一个真实截止的剩余毫秒；当前时刻由调用方算好传入
  stage: string;                // 阶段文本，例如 "开发" / "提交" / "路演"；不认识也不报错
  tasks: {
    total: number;              // 任务总数
    done: number;               // 由真实记录判定为完成的任务数
    blocked: number;            // 被阻塞的任务数
    inProgress: number;         // 正在做的任务数
  };
}
```

调用方约束（**由主会话在装配时保证**）：

- `remainingMs` 必须由调用方用真实截止时刻减去当前时刻算出来。本模块**没有 `Date.now()`**，也不做时区换算，
  所以同一输入永远同一输出，测试不依赖运行时间。
- `stage` 传空字符串表示"不知道阶段"，不要传 `"undefined"` 这类字符串。
- 计数必须是数字，不是字符串；单位是"条"。

## 输出契约

```ts
interface ScopeCutAdvice {
  verdict: "on_track" | "at_risk" | "must_cut" | "unknown";
  keep: readonly string[];   // 必须守住的（含最小成果本身、阻塞处理）
  cut: readonly string[];    // 可以砍/降级的，每条都是具体动作
  sayToTeam: string;         // 给队友的一句话：平和、可执行、不指责
  notice: string;            // 依据说明；事实不足时说明缺什么
}
```

## 判断规则（全部可由 `SCOPE_CUT_WINDOWS` 复现）

| 条件 | verdict |
| --- | --- |
| 任一事实不可用或缺 `minimumDeliverable` | `unknown` |
| 剩余 < 6 小时 **且** 有未结算任务 | `must_cut` |
| 剩余 < 24 小时 **且**（有未结算任务 或 有在办/阻塞） | `at_risk` |
| 有阻塞 **且** 剩余 < 48 小时 | `at_risk` |
| 未开始的任务超过总数的 1/3 **且** 剩余 < 72 小时 | `at_risk` |
| 其余 | `on_track` |

- `SCOPE_CUT_WINDOWS = { criticalMs: 6h, riskMs: 24h, blockedRiskMs: 48h }`，导出便于主会话复用与调参。
- 全部任务已结算（无未结算、无阻塞、无在办）时，即使只剩 1 小时也不会判 `must_cut`：没有未结算工作就没有"砍"的对象。
- 边界是"严格小于"：剩余正好 6 小时 → `at_risk`，正好 24 小时 → `on_track`。

### 事实不足时返回 `unknown`

`unknown` 覆盖以下情况，`notice` 会逐项写出缺什么（字段名 + 原因）：

| 情况 | notice 里的字段 |
| --- | --- |
| `remainingMs` 是 `NaN` / `Infinity` / 缺失 | `remainingMs` |
| `remainingMs` 为负（截止时刻已过） | `remainingMs`（说明"本模块不知道那之后发生了什么"，不代替团队下结论） |
| `tasks` 整块缺失 | `tasks.total`、`tasks.done`、`tasks.blocked`、`tasks.inProgress` |
| 任一计数为负 / 非有限数字 | 对应字段 |
| `done + blocked + inProgress > total`（计数自相矛盾） | `tasks`（不猜哪一项对） |
| `total === 0`（一条任务都没登记） | `tasks.total` |
| `minimumDeliverable` 为空 | `minimumDeliverable` |

`unknown` 时 `keep` / `cut` / `sayToTeam` **仍然有内容**，但只做两件事：说明缺什么、建议先补齐或先冻结新增范围。
绝不推测当前进度，也不建议删代码。

## 用法

```ts
import { adviseScopeCut } from "./index.ts";

const advice = adviseScopeCut({
  goal: project.goal,
  minimumDeliverable: project.minimumDeliverable,
  remainingMs: new Date(deadline.instantUtc).getTime() - clock.now().getTime(),
  stage: "开发",
  tasks: { total: 12, done: 5, blocked: 1, inProgress: 3 },
});
```

纯函数：不读库、不写库、不导入其它模块、不调 `Date.now()`、无随机、无 I/O。返回的数组是新建的，
调用方随便改都不会影响下一次调用。

## 边界（明确不做）

- **不做 UI**：主会话在画布上装配"范围调整"组件。
- **不读任何存储**：赛事、项目、任务、报名、提交都与我无关，事实由调用方传入。
- **不落库**：本模块没有 migrations、没有 SQL 建议、没有持久化。
- **不替团队决定**：`cut` 是建议清单，删不删由团队定；`notice` 里会写明这一点。
- **不建立第二套完成状态**：不写标记、不写勾选、不改任务或项目事实。

## 测试

```bash
node --experimental-strip-types --test src/modules/scope-cut/advice.test.ts
```

覆盖：四态各返回合法契约；纯度与无副作用；**禁用词表**（百分比 / 完成度 / 完成率 / 「还剩 N」）在全部四态下都不出现；
`unknown` 的七类事实缺口逐一断言 notice 缺什么；时间边界（5.99h/6h/23.99h/24h/0h/负值/NaN/Infinity）；
计数矛盾与总数为 0；阶段识别（中文、英文大小写、未识别、空串）；`sayToTeam` 的语气与长度；输出不为空话。
