# home-next · 首页"下一步"

规划27 第 2 期 2.1 的**纯逻辑**部分：由登录态与本人只读事实，推出"我现在该干吗"。

首页本身此前是**纯静态**的（`src/app/page.tsx` 不读任何状态），对"回来继续参赛的人"等于什么都没说。
流程说明已经由 `/journey` 承担，所以这里的职责只有一件事：**给出下一步，并且指向具体动作**。

- 计划依据：`docs/规划/27-团队空间操作空间与主页主路径.md` 第 7 节（主页主路径）
- 分工依据：`docs/协作/规划27后续分会话分工-2026-10-12.md` 第 2 节 S3
- 交付说明：`docs/协作/交付/home-next.md`

## 本模块做什么 / 不做什么

**做**：纯函数判定 + 站内路径。无副作用、无网络、无 `Date.now()`、不读库、不写状态。

**不做**：

- 不改 `src/app/page.tsx`，不做 UI 组件（首页装配由主会话按 R3 接入）
- 不调 API、不新增迁移、不产生完成百分比
- 不替用户断言"你已经完成了 X%"，不新增第二套完成状态（宪法 v1.16.0 原则 X）

## 输入契约

```ts
interface HomeNextInput {
  signedIn: boolean;
  hasStartedJourney: boolean;               // 本人是否走过一次参赛指引
  selectedEventId: string | null;           // 已选定的比赛；null 表示还没选
  projects: readonly HomeProjectFacts[];    // 本人当前可见空间；尚未读取传 []
}

interface HomeProjectFacts {
  id: string;
  name: string;
  stage: string;                            // 取值同 M02 ProjectStage
  goal: string;
  minimumDeliverable: string;
  pendingTasks?: number;                    // undefined = 尚未读取（不等于 0）
  blockedTasks?: number;                    // 同上
  reviewingTasks?: number;                  // 同上
}
```

**`undefined` 与 `0` 必须严格区分**：`undefined` 是"还没读到"，`0` 是"读到了，确实没有"。
本模块不会把 `undefined` 当成 0，也不会因为 `undefined` 就编一个推荐。

## 输出契约

```ts
interface NextStep {
  kind: "sign_in" | "find_event" | "create_space" | "set_goal"
      | "do_tasks" | "wrap_up" | "read_results" | "unread";
  title: string;   // 一句话：现在做什么
  why: string;     // 为什么是这一步（只用已读取的事实，含具体件数）
  href: string;    // 站内真实路径
}
```

`kind: "unread"` 由本轮任务书指定（"返回 `kind: "unread"` 或退回到不依赖这些数字的结论"）。
它表示**读取状态**，不是一种"完成状态"，因此不违反原则 X。

## 判定顺序（`buildHomeNextStep`）

| # | 条件 | 输出 | href |
| --- | --- | --- | --- |
| 1 | 未登录 | `sign_in` | `/login` |
| 2 | 已登录、没有任何可用空间、**已开始过参赛** | `create_space` | `/app` |
| 3 | 已登录、没有任何可用空间、**首次到访**、已选比赛 | `create_space` | `/app` |
| 4 | 已登录、没有任何可用空间、**首次到访**、没选比赛 | `find_event` | `/events` |
| 5 | 有空间、`goal` 为空（含 `minimumDeliverable` 为空） | `set_goal` | `/app/projects/<id>#project-goal` |
| 6 | 空间已到收尾阶段（`finalizing`/`submitted`/`retrospective`） | `wrap_up` | `/app/projects/<id>/delivery` 或 `/retrospective` |
| 7 | 任务三个数字**没有全部读到**（任意一个 `undefined`） | `unread` | `/app/projects/<id>/plan` |
| 8 | 三个数字都读到：有卡住 → 有等检查 → 有待办 | `do_tasks` | `/app/projects/<id>/plan` |
| 9 | 三个数字都读到且都是 0 | `do_tasks`（去确认任务安排） | `/app/projects/<id>/plan` |

补充：

- **第 2 与第 3 的先后**：先看"是否已开始过参赛"。空间全归档但本人从未开始参赛，仍算首次到访（去 `/events`）。
- **第 5 与第 6 的先后**：目标没写清时先补目标，即使项目已经到收尾阶段——目标是最上游的事实。
- **归档空间**（`stage === "archived"`）是只读的，不作为推荐目标。
- 多个空间时优先收尾中的那个；同阶段保持接入方给的顺序（本模块不排序用户数据）。
- `selectedEventId` 必须是单段路径参数（`[A-Za-z0-9._~-]`、非空、≤200 字符）；否则按"还没选定比赛"处理，**不会拼出坏链接**。

## 另外两个导出

- `buildUnreadNextStep(reason)`：接入方在"读取中/读取失败"时使用，明确说"现在说不准"，
  而不是先给一个可能错的推荐。
- `buildResultsNextStep(input)`：赛事结果入口。只有空间处于 `submitted`/`retrospective` 时返回；
  有可用比赛 id 时指向 `/competitions/<eventId>/results`，否则退回自己空间的交付页；不适用时返回 `null`。

## 使用示例（接入方视角，约等于主会话 R3 要写的东西）

```ts
import { buildHomeNextStep, buildResultsNextStep } from "../modules/home-next/index.ts";

// 1) 读登录态（未登录也要给结论：sign_in）
const next = buildHomeNextStep({
  signedIn: Boolean(me),
  hasStartedJourney: Boolean(journeySeen),
  selectedEventId: detail?.project.eventId ?? null,
  projects: (spaces ?? []).map(({ project, counts }) => ({
    id: project.id, name: project.name, stage: project.stage,
    goal: project.goal, minimumDeliverable: project.minimumDeliverable,
    // 尚未读取就传 undefined，不要传 0
    pendingTasks: counts?.pending, blockedTasks: counts?.blocked, reviewingTasks: counts?.reviewing,
  })),
});
```

**推荐做法：只为"你要推荐的那个空间"读任务数字。** 其余空间传 `undefined` 更安全——
如果首页只读了 2 号空间的任务，却给 1 号空间填 0，就会得到一个建立在猜测上的推荐。

三个数字的真实算法（主会话在 R3 里接现有计划视图，不新增接口）：

```ts
import { missionTaskChecked } from "../modules/space-workflow/mission-workbench.ts";

const mine = tasks.filter(task => task.projectId === project.id && task.status !== "cancelled");
const pendingTasks = mine.filter(task => !missionTaskChecked(task)).length;
const blockedTasks = mine.filter(task => task.status === "blocked").length;
const reviewingTasks = mine.filter(task => task.status === "review" && !missionTaskChecked(task)).length;
// 计划本身没读到（current === null / 读取失败）→ 三个都传 undefined，
// 让首页走 kind: "unread"，而不是显示"0 件待办"。
```

渲染时建议：`kind` 决定样式与去向，`title` 是主文案，`why` 是次级说明，`href` 是唯一出口。
**不要**把 `why` 里的件数改成百分比或进度条。

## 测试

```
node --experimental-strip-types --test src/modules/home-next/next-step.test.ts
```

日志：`.runtime/s3-home-next.log`。
覆盖：未登录、已登录无空间（首次到访 / 继续参赛）、有空间目标为空、有任务（待办/卡住/等检查）、
任务数未读取（`undefined`）、收尾阶段、结果入口、以及"kind 合法 + href 站内真实 + 无百分比"的通用不变量。
