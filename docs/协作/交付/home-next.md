# S3 · home-next 交付说明

日期：2026-10-12。会话：**S3**（规划27 第 2 期 2.1「首页输出下一步」的纯逻辑部分）。
依据：宪法 **v1.16.0 原则 X**（第 8 条"站内路径收敛"、第 9 条"主页下一步按状态指向具体动作"）、
`docs/规划/27-团队空间操作空间与主页主路径.md` 第 7 节（主页主路径）、
`docs/协作/规划27后续分会话分工-2026-10-12.md` 第 2 节 S3 与第 0 节总规则。

一句话：首页此前**完全是静态的**，对"回来继续参赛的人"等于什么都没说；
本模块只提供**纯逻辑**，由登录态与本人只读事实推出"我现在该干吗"，并指向站内真实路径。

## 已完成

| 文件 | 内容 |
| --- | --- |
| `src/modules/home-next/model.ts` | 类型契约：`NextStepKind`（8 种，含任务书指定的 `unread`）、`NextStep`、`HomeProjectFacts`、`HomeNextInput`；`isNextStepKind()` 运行时白名单 |
| `src/modules/home-next/next-step.ts` | **纯函数** `buildHomeNextStep(input): NextStep`，按 9 条判定顺序输出下一步；另导出 `buildUnreadNextStep(reason)` 与 `buildResultsNextStep(input)` |
| `src/modules/home-next/next-step.test.ts` | node:test，**29 项**，覆盖任务书要求全部场景 |
| `src/modules/home-next/index.ts` | 公共导出（模块约定"每个模块交付 index.ts 公共导出"） |
| `src/modules/home-next/README.md` | 契约、判定顺序表、接入示例与"三个数字怎么算" |

判定顺序（详见 README）：

1. 未登录 → `sign_in`（`/login`）
2. 已登录、无可用空间、**已开始过参赛** → `create_space`（`/app`）
3. 已登录、无可用空间、**首次到访**、已选比赛 → `create_space`（`/app`）
4. 已登录、无可用空间、**首次到访**、没选比赛 → `find_event`（`/events`）
5. 有空间、目标或最小成果为空 → `set_goal`（`/app/projects/<id>#project-goal`）
6. 空间到收尾阶段（`finalizing`/`submitted`/`retrospective`）→ `wrap_up`（`/delivery` 或 `/retrospective`）
7. 任务三个数字**未全部读到** → `unread`（指向 `/plan`，把用户送到能自己看的地方）
8. 三个数字都读到 → `do_tasks`（卡住 → 等检查 → 待办，依次优先；都是 0 则去确认任务安排）
9. 其他导出：`buildResultsNextStep` 给 `read_results`（`/competitions/<id>/results`），不适用时返回 `null`

硬约束落实情况：

- **区分首次到访与继续参赛**：第 2/3/4 条按 `hasStartedJourney` 分流；同一条路径下"首次到访"去 `/events`，"继续参赛"去 `/app`。
- **未读取不得伪造推荐**：`pendingTasks`/`blockedTasks`/`reviewingTasks` 任一为 `undefined` 时**不当作 0**。
  能给出不依赖这些数字的结论就给（补目标、wrap_up）；需要数字才能推荐时返回 `kind: "unread"` 并指向 `/plan`。
  "读到的三个 0" 与 "未读取" 走的是不同分支，有专门测试。
- **不产生完成百分比**：所有分支的 `title`/`why` 都不含 `%`/`％`/`完成度` 等表达，通用不变量测试逐条检查。
- **纯函数**：无副作用、无网络、无 `Date.now()`、不读库、不写状态；测试用 `Object.freeze` 验证入参不被改动、同输入两次结果一致。
- **href 只用站内真实路径**：`/login`、`/events`、`/app`、`/app/projects/<id>`、`/app/projects/<id>#project-goal`、
  `/app/projects/<id>/plan`、`/delivery`、`/retrospective`、`/competitions/<id>/results`；
  已只读核对 `src/app/` 下对应路由存在，锚点 `#project-goal` 与既有模块（`space-workflow`、`project-workflow`、`projects-client`）用法一致。
  比赛 id 不是单段路径参数（含 `/`、空格、空串、超长）时按"还没选定比赛"处理，**不拼坏链接**。

## 已验证

1. **单元测试**：`node --experimental-strip-types --test src/modules/home-next/next-step.test.ts`
   → **tests 29 / pass 29 / fail 0**（日志：`.runtime/s3-home-next.log`）。覆盖任务书强制要求：
   - 未登录（含"未登录但有比赛与空间"仍先登录）
   - 已登录无空间（首次到访 → `find_event`；继续参赛 → `create_space`；已选比赛 → `create_space`）
   - 有空间目标为空（`set_goal`；最小成果为空同样 `set_goal`；目标空且数字未读取仍 `set_goal`）
   - 有任务（待办 / 卡住优先 / 等检查优先 / 三个 0 → 确认安排）
   - 任务数未读取（`undefined`；只缺 `blockedTasks` 也 `unread`；未读取时不出现数字）
   - 收尾阶段（`finalizing` / `submitted` / `retrospective`；未读取数字也照样 `wrap_up`）
   - 另有：结果入口、归档空间、多个空间的优先级、非法比赛 id、纯函数性、通用不变量
2. **类型检查**：`node node_modules/typescript/bin/tsc --noEmit --strict` 只针对本模块三个文件 → **退出码 0，零输出**。
   （按总规则未运行仓库级 `npm run typecheck`、未 build。）

测试过程中由测试本身抓到的两个真实缺陷，均已修正：

1. **测试夹具把显式 `null` 当成"没传"**：`over.selectedEventId ?? "e1"` 让
   `selectedEventId: null` 被替换成 `"e1"`，于是"首次到访且没选比赛"错判为 `create_space`。
   已改为用 `undefined` 判断（`pick()`），并在注释里写明本契约里 `null` / `undefined` / 有值 是三种不同意思。
2. **"空间全归档 + 从未开始参赛"被归到继续参赛**：原条件是
   `hasStartedJourney || projects.length > 0`，把"有归档空间"也算成继续参赛。
   已改为只看 `hasStartedJourney`（归档空间只读，不构成"已经开始参赛"）。

## 模拟测试

本轮测试全部是**纯函数夹具**：输入是手写事实对象，没有 mock 任何内部实现，没有访问数据库、HTTP、模型或邮件。
测试里的 `破壁者战队`、`p1`、`e1` 都是夹具，不是真实账号或赛事。

## 未接入

- **首页装配未做**：`src/app/page.tsx` 仍是纯静态，**没有**引入本模块。按分工属主会话 R3。
- **没有数据读取**：本模块不读 `/me`、不读空间列表、不读计划，因此不会自己发起任何请求。
- **没有 UI 建议的组件化**：只给 `kind`/`title`/`why`/`href`，样式与呈现由主会话决定。
- 未新增迁移、未改公共契约、未改共享文件、未安装依赖、未构建、未重启服务。

## NEEDS_ROOT

1. **`hasStartedJourney` 的数据来源尚未确定（最重要的一项）**。
   现状：仓库里**没有**"本人是否走过参赛指引"的现成事实。
   最接近的是 `src/modules/onboarding/`（首登指引 `OnboardingState.completedAt` / `stepIndex`），
   但那是"网站使用指引"，不等于"开始参赛"。**无法确定**主会话打算用哪一个。
   建议（二选一，我倾向 B）：
   - A：`hasStartedJourney = onboarding.stepIndex > 0`（简单，但语义偏"看过网站指引"）
   - B：`hasStartedJourney = current === null ? false : true`（即"是否读到过任何本人参赛事实"）——
     语义更贴"继续参赛"，且不新增任何完成状态。
   **不要把 `hasStartedJourney` 传成常量 `true`**，否则首次到访的人永远看不到"找比赛"这一步。
2. **任务三个数字的读取时机**：建议只为"将要推荐的那个空间"读计划，
   其余空间传 `undefined`。不要在未读取时填 0（那就是本模块要防的伪造推荐）。
   具体算法与 `missionTaskChecked` 的用法已写在 `README.md`。
3. **`primary: boolean` 字段的取舍**：规划27 文档第 2 节 S3 的输出契约里写了 `primary`，
   而本轮任务书给我的输出契约只有 `kind/title/why/href` 四个字段。
   我按**任务书**执行，没有输出 `primary`。若首页需要它，属主会话决定（例如按 `kind` 派生即可，无需本模块提供）。
4. **`kind: "unread"` 与规划27 的措辞不一致**：规划27 第 2 节的硬约束写的是
   "返回 `kind: "sign_in"` 或明确的'待读取'"，而本轮任务书明确要求 `kind: "unread"`。
   我按**任务书**实现（`unread` 也确实是 8 种之一）。若主会话要收回，改 `model.ts` 一处即可，测试会同步失败提醒。
5. **页面 href 的最终归属**：`read_results` 建议指向 `/competitions/<eventId>/results`（该路由已存在）。
   若主会话认为赛后归宿应是空间内的交付/复盘页，改 `buildResultsNextStep` 一处即可。
6. **中文文案**：`title`/`why` 是可直接渲染的人话，但首页若已有统一措辞规范（例如"空间"还是"项目"），
   需要主会话统一；本模块一律用"空间"。

## 环境变量

无新增。数据库迁移：无。依赖：无新增。

## 文件交还

本轮仅新增/修改：`src/modules/home-next/model.ts`、`next-step.ts`、`next-step.test.ts`、`index.ts`、`README.md`
与本交付文档 `docs/协作/交付/home-next.md`。
未触碰 `src/app/page.tsx`、任何 `src/components/`、任何共享文件、根配置、迁移或其他模块目录。
S3 交付完成并**停止编辑**，以上文件交还主会话；不得沿用本轮授权继续覆盖。
