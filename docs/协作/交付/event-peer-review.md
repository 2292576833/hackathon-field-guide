# P7 · 选手数值互评（event-peer-review）交付

日期：2026-10-16。依据：`docs/规划/34-主办方模块化与选手社区.md` §3（3.2 两种点评分列、3.4 验收）、§6 P7、
`.specify/memory/constitution.md` 原则 XIII「作品公开与点评」（v1.23.0）、共享契约 `src/shared/organizer-contracts.ts`
（`EVENT_COMMUNITY_SCALES` / `eventCommunity(scope)`）。参照实现口径：`src/modules/event-judging/comments.ts`
（P5 文字留言的三层门禁与治理文案）与 `src/modules/event-closure/`（独立模块 + 迁移建议 + 只读来源端口的结构）。

授权文件范围：**仅新增** `src/modules/event-peer-review/` 与本文件。
未编辑 `src/app`、`src/server`、`src/components`、`src/shared`、`src/modules/event-judging/`、根 `migrations/`
或任何其他模块；未跑构建/迁移/重启/安装/git 写操作。

## 1. 已实现

### 1.1 三层门禁（硬性要求 1）

`peerReviewGate(community, disclosure)`，**顺序固定**，缺一即明确 403（不是空数组），调用方事务内零行落库：

1. `community.workShowcase`（主办方，默认 false）→ `WORK_SHOWCASE_DISABLED`
2. `community.peerReview`（主办方，默认 false）→ `PEER_REVIEW_DISABLED`
3. 该作品所属队伍的**当前有效**披露记录且 scope ≠ `private`（队伍本人的选择）→ `PEER_REVIEW_NOT_DISCLOSED`
   另加观看者资格：`participants` 档只有本场报名**已通过**者（`PEER_REVIEW_PARTICIPANTS_ONLY`）。

作品定位与 event-judging 的作品展示**同口径**：`snapshotId` 必须是该队当前展示（`latestReceiptOf`）的版本，
否则 `PEER_REVIEW_WORK_NOT_CURRENT`——避免出现"作品列表里没有、却有互评区"的第二套可见性。

### 1.2 量纲与维度由主办方配置（硬性要求 2）

- 量纲只接受 `peerReviewScale ∈ EVENT_COMMUNITY_SCALES`（`1-5` / `0-10` / `yes-no`）；否则 `PEER_REVIEW_SCALE_INVALID`。
- 维度只接受 `community.peerReviewDimensions` 里已冻结的 `{id,label}`；`peerReviewDimensionsOf()` 只做防御性归一
  （丢弃畸形、去重、截断到 12 项），**不补默认维度、不按顺序编号**。
- `peerReviewValues()`：必须是对象；未知键、缺失维度、非对象 → `PEER_REVIEW_DIMENSION_INVALID`（422）；
  非整数或超出量纲取值 → `PEER_REVIEW_VALUE_OUT_OF_RANGE`（422）。yes-no 用 0/1 表示否/是。
- 每条评分必须是**每个维度一个整数**，不提供任何"缺维度用默认分补"的路径。

### 1.3 去自评（硬性要求 3）

`peerReviewSelfReview(work.memberUserIds, reviewer)`：依据**正式收件时的成员快照**（不是当前队伍名单），
本队成员评本队作品 → `PEER_REVIEW_SELF_REVIEW`（403）。提交互评还要求评分者是本场报名已通过者，
否则 `PEER_REVIEW_PARTICIPANT_REQUIRED`（访客可读公开作品，但不能评）。

### 1.4 参与率门槛（硬性要求 4）

- 分子：本场**至少有一条有效（active）互评、且仍在报名已通过名单里**的参赛者数（`submittedReviewerCount()`）。
- 分母：本场报名已通过人数（来源端口 `approvedParticipantIds`，直接复用既有 `approvedParticipantIds` 读路径）。
- 门槛：`peerReviewPassRateOf()` 只接受 0.1–1 的有限数，非法配置回退共享默认 0.3（不放大、不缩小到 0）。
- **未达门槛**：`threshold = { code: "PEER_REVIEW_THRESHOLD_NOT_MET", met: false, requiredRate, message }`，
  `summary = null`；**不返回** `passRate` / 人数 / 任何平均分 / 逐条分值。没有报名已通过人数时同样视为未达门槛。
- **达标**：`summary` 只按**作品**给出 `dimensions[{id,label,average|null,count}]` 与 `reviewCount`；
  平均值按当前冻结维度计算，没有评分时 `average = null`（不是 0）。**没有**人名、没有名次、没有百分比排名。
- 门槛是**赛事级**判定，但汇总是**按作品**的：同一场里每件作品只汇总自己那份互评。

### 1.5 与评审分列（硬性要求 5）

- 本模块**不导入** `src/modules/event-judging/` 的任何文件（聚合、导出、私有 store 都没有），也**不写任何评审表**。
- 写路径只有 `postgres.ts` 里对 `epr_peer_reviews` / `epr_review_reports` 的 INSERT/UPDATE。
- 视图类型里没有任何 `total` / `rank` / `percent` 字段；投影 JSON 不含评审分与名次。

### 1.6 评委不可见（硬性要求 6）

- 本模块**没有**任何评委侧入口：handler 工厂只有 4 个选手侧成员，`handlers.test.ts` 断言键集合恰为
  `["reportPeerReview","submitPeerReview","withdrawPeerReview","workPeerReview"]` 且不含 `judge|score|result|aggregate|export`。
- `ui.ts` 只导出选手侧组件 `PeerReviewPanel`。
- 评分期间评委读到的仍是既有 `judgeMaterials` 等路径，其中不含本模块任何数据。

### 1.7 治理（硬性要求 7）

- **修改**：已有一条有效互评时，修改必须给 `expectedRevision`，不给 → `PEER_REVIEW_REVISION_REQUIRED`（409），
  不符 → `PEER_REVIEW_VERSION_CONFLICT`（409，带 `latestRevision` 与 `recoveryAction: "reload"`）。
  修改不原地改分值，而是把旧行标 `superseded`（分值行冻结、revision 不变）并新增一条 active 行（revision 加一）。
- **撤回**：本人对本人那条 → `active → withdrawn`（revision 加一）；撤回后可重提（版本继续加一）。
  撤回是撤回自己的数据：不要求作品此刻仍公开、也不要求仍是参赛者，只要求作者是本人。
- **举报**：任一**能看到这件作品**的人都能举报（participants 档只对本场通过者；public 档任何已登录账号）；
  只记录 `{ 谁、何时、哪条互评、举报时刻的分值快照 }`，**不改互评状态、不裁决、不封禁**；同账号同一条只记一条（幂等）。
- **匿名**：评分者身份不对参赛者展示。参赛者只看得到按作品汇总的各维度平均与份数，以及**不含评分者身份**的
  匿名逐条分值（`anonymousReviews[{reviewId, values}]`，按 reviewId 排序，**不按分值**，避免形成变相排名）。
  之所以保留匿名逐条：否则"任一可见者举报一条评分"没有可见的举报对象，治理要求落不了地。

### 1.8 其余（硬性要求 8）

- **幂等键**：`(organization_id, event_id, reviewer_user_id, idempotency_key)` 唯一；同键同输入返回当前视图，
  同键不同输入 → `PEER_REVIEW_IDEMPOTENCY_KEY_REUSED`。
- **跨赛事读不到**：所有 SQL 都以 `organization_id + event_id` 为界；`postgres.test.ts` 断言跨 scope 读不到。
- **归档只读**：`status === "archived"` 时 `submit` / `withdraw` / `report` → `PEER_REVIEW_EVENT_READ_ONLY`（403），GET 照常。

## 2. 架构决定：独立模块（对规划 34 §6 P7 的**有意偏离**）

规划 34 §6 把 P7「数值互评」的会话范围写成 `event-judging` / 助手模块。本交付**没有**放进 `event-judging`，
而是新建 `src/modules/event-peer-review/`。理由：

| 维度 | 放进 event-judging | 独立模块（本次选择） |
| --- | --- | --- |
| 名次/公布/导出隔离 | 靠"不要调 aggregate()/results-export"的人为纪律 | **结构上不存在**通往这些写路径的代码：模块不导入 event-judging 任何文件 |
| 评委不可见 | 需要在评审模块里新增入口白名单并逐一排除 | 模块**没有**评委侧入口，白名单问题不存在 |
| 单一事实来源 | 互评表与评审表同库同模块，容易被后续改动"顺手"混算 | 两张 `epr_` 表 + 一个只读来源端口，边界写死在 `model.ts` |
| 另一会话冲突 | 规划外会话正在改 `event-judging` | 零冲突 |

代价（如实登记）：root 需要注入一个**只读来源端口** `EventPeerReviewSourcePort`（见 §8.2），
而放进 event-judging 时这些事实已在模块内。这是用"一次注入"换"结构上不可能并名次"，符合宪法 XIII 的硬约束。

## 3. 吸收闸门三问（规划 32 §4.0 / 宪法 XII）

| 问题 | 答案 |
| --- | --- |
| **① 解决我们哪个真实问题** | 规划 34 裁定「文字留言与数值互评都要」。P5 已交付文字留言；选手之间没有任何**可配置量纲与维度**的数值互评入口，主办方也无法为一场比赛独立配置量纲/维度/参与率门槛。这是用户六条裁定之一，不是"竞品有所以要有"。 |
| **② 会碰到哪些既有能力** | `event-judging` 的正式收件回执（作品版本 + 成员快照）、队伍公开披露（P2 `ej_work_disclosures`）、`event-registration` 的报名已通过名单、`organizer` 持有的 `EventCommunityConfig`（`eventCommunity(scope)`）、既有的 `authorizeMutation`/principal 解析、既有 `Idempotency-Key` 约定。 |
| **③ 如何避免重复入口 / 第二份事实 / 第二套写路径** | ① 三块点评事实**分列**：文字留言在 event-judging 的 `ej_work_comments`（P5）；数值互评在本模块的 `epr_peer_reviews`；评委分在 `aggregate()`。三者不共表、不共投影、不共写路径。② 本模块**只读**其他模块事实，通过端口注入，不建第二份作品/披露/报名事实。③ 只有 2 张自己的表、1 个写入服务；主办方"公开与社区"配置仍由 organizer 持有，本模块只读取，**不新增配置入口**。④ 界面挂在既有作品展示区（既有 `work-showcase` 的公开作品条目内），不新增一级导航。 |

## 4. 「没有第二份事实 / 没有通往名次的写路径」证据

| 声明 | 可复核证据 |
| --- | --- |
| 没有第二份事实 | 只新增 2 张表（`epr_peer_reviews`、`epr_review_reports`）；`grep -n "ej_\|epr_" src/modules/event-peer-review/*.ts` 只出现 `epr_*`（生产代码），无 `ej_`。作品/披露/报名事实全部来自注入端口。 |
| 不导入评审模块 | `grep -n "event-judging" src/modules/event-peer-review/*.ts` 只命中**注释**，没有任何 `import`；模块内不存在 `aggregate`、`results`、`results-export`、`projection` 的调用。 |
| 没有第二套写路径 | 生产代码里全部 INSERT/UPDATE/DELETE 只出现在 `postgres.ts`，且目标表都是 `epr_*`；`service.test.ts` 用**记录型 executor** 断言每条写语句匹配 `^\s*(INSERT INTO\|UPDATE\|DELETE FROM)\s+epr_`。 |
| 评审侧原始汇总逐字段不变 | `service.test.ts` 在同一 PGlite 里放 `fake_judging_scores`（`snap-a2: 80/rank 1`、`snap-b1: 72/rank 2`）；提交互评前后对整表 `SELECT` 结果做 `deepEqual`，断言不变。 |
| 公开/参与者投影里没有评审分 | 视图类型与实现里没有 `total`/`rank`/`percent` 字段；`service.test.ts` 断言投影 JSON 不含 `"total"`、`"rank"`，也不含评分者账号。 |
| 评委不可见 | handler 键集合恰为 4 个选手侧成员（无 judge/score/result/aggregate/export）；`ui.ts` 只导出 `PeerReviewPanel`。 |

## 5. 端点契约

| 工厂成员 | 方法 | `/api/v1` 之后路径 | 权限 |
| --- | --- | --- | --- |
| `workPeerReview` | GET | `competitions/:eventId/works/:snapshotId/peer-review` | 已登录 + 三层门禁 + 观看者资格 |
| `submitPeerReview` | POST | `competitions/:eventId/works/:snapshotId/peer-review` | 已登录 + 三层门禁 + 本场报名已通过 + 非本队 |
| `withdrawPeerReview` | POST | `competitions/:eventId/works/:snapshotId/peer-review/withdraw` | 已登录 + 本条互评作者本人 |
| `reportPeerReview` | POST | `competitions/:eventId/works/:snapshotId/peer-review/:reviewId/report` | 已登录 + 能看到该作品 |

返回形状：

```ts
WorkPeerReviewView = {
  eventId, snapshotId, teamId, scope: "participants" | "public", enabled: true,
  scale: "1-5" | "0-10" | "yes-no", dimensions: [{id,label}], valueRange: {min,max},
  myReview: { id, values:[{dimensionId,value}], revision, updatedAt } | null,
  canReview: boolean, canReviewReason: string | null,
  threshold: { code, met, requiredRate, message, passRate?, submittedReviewerCount?, approvedParticipantCount? },
  summary: { state: "met", reviewCount, dimensions:[{id,label,average|null,count}],
             anonymousReviews:[{reviewId, values:[{dimensionId,value}]}],
             requiredRate, passRate, submittedReviewerCount, approvedParticipantCount } | null,
  notices, limitations[]
}
// POST 提交/修改返回 WorkPeerReviewView；撤回返回 { reviewId, snapshotId, revision, withdrawnAt }；
// 举报返回 { reportId, reviewId, reportedAt, reportedCount, alreadyReported }
```

请求体（POST 提交/修改）：`{ values: { <dimensionId>: <integer>, ... }, expectedRevision?: number, idempotencyKey: string }`，
支持 `Idempotency-Key` 头（与正文不一致 → 400）。撤回：`{ expectedRevision: number }`。举报：`{ reason?: string }`。

### 5.1 错误码清单

HTTP 错误：

| 码 | 状态 | 触发 |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | 未登录 |
| `WORK_SHOWCASE_DISABLED` | 403 | 未开启作品展示 |
| `PEER_REVIEW_DISABLED` | 403 | 未开启数值互评 |
| `PEER_REVIEW_NOT_DISCLOSED` | 403 | 队伍本人未选择公开 / 不公开 / 已撤回 |
| `PEER_REVIEW_PARTICIPANTS_ONLY` | 403 | 观看者不是本场报名已通过者（participants 档） |
| `PEER_REVIEW_PARTICIPANT_REQUIRED` | 403 | 非参赛者提交互评 |
| `PEER_REVIEW_SELF_REVIEW` | 403 | 本队成员评本队作品 |
| `PEER_REVIEW_WORK_NOT_FOUND` | 404 | 没有这份正式作品 |
| `PEER_REVIEW_WORK_NOT_CURRENT` | 403 | 该版本不是该队当前展示的作品 |
| `PEER_REVIEW_DIMENSION_INVALID` | 422 | 维度非法（未知/缺失/非对象/未配置） |
| `PEER_REVIEW_VALUE_OUT_OF_RANGE` | 422 | 量纲越界（非整数或超出取值） |
| `PEER_REVIEW_SCALE_INVALID` | 422 | 量纲不是已冻结取值 |
| `PEER_REVIEW_REVISION_REQUIRED` | 409 | 修改未给 `expectedRevision` |
| `PEER_REVIEW_VERSION_CONFLICT` | 409 | 版本不符（带 `latestRevision` / `recoveryAction: reload`） |
| `PEER_REVIEW_IDEMPOTENCY_KEY_REUSED` | 409 | 同键不同输入 |
| `PEER_REVIEW_NOT_FOUND` | 404 | 互评不存在/不属于本作品/已非有效记录 |
| `PEER_REVIEW_EVENT_READ_ONLY` | 403 | 赛事已归档 |
| `PEER_REVIEW_INVALID_INPUT` | 422 | 重试标识/版本号/举报说明格式错误 |
| `IDEMPOTENCY_KEY_MISMATCH` | 400 | 头与正文不一致 |
| `INVALID_ROUTE` | 400 | 缺少有效标识 |
| `JSON_REQUIRED` / `PAYLOAD_TOO_LARGE` / `INVALID_JSON` | 415 / 413 / 400 | 正文格式 |
| `METHOD_NOT_ALLOWED` | 405 | 方法不符 |

业务状态码（HTTP 200，在 `threshold.code`）：

| 码 | 含义 |
| --- | --- |
| `PEER_REVIEW_THRESHOLD_NOT_MET` | **未达门槛**：`summary = null`，只给 `requiredRate` 与说明（不出平均分、不出百分比排名） |
| `PEER_REVIEW_SUMMARY_READY` | 达标：按作品给各维度平均与份数、匿名逐条分值 |

## 6. 迁移建议（不改既有表）

只新增本模块自己的两张表，前缀 `epr_`。完整 SQL 见
`src/modules/event-peer-review/migrations/001-event-peer-review.sql`。风格与 `072_event_closure.sql` 一致
（JSONB `document` + 索引化身份列 + 文档一致性 CHECK + 不可变触发器 + 部分唯一索引）。

`epr_peer_reviews`：

| 列 | 说明 |
| --- | --- |
| `id` text PK | 记录标识 |
| `organization_id` / `event_id` / `snapshot_id` / `team_id` | 范围；FK → `organizer_hosted_events(id, organization_id)`、`event_registration_teams(event_id, id)` |
| `reviewer_user_id` | 评分者；FK → `auth_users(id)` |
| `scale` | `1-5` / `0-10` / `yes-no`（CHECK） |
| `status` | `active` / `withdrawn` / `superseded`（CHECK） |
| `revision` | 从 1 起；撤回 +1，被取代保持（触发器） |
| `created_at` / `updated_at` / `withdrawn_at` / `superseded_at` | 时间；与状态一致（CHECK） |
| `idempotency_key` | 1–120；`(organization_id, event_id, reviewer_user_id, idempotency_key)` 唯一 |
| `document` jsonb | 与索引列逐字段一致（CHECK，含 `dimensions` / `values` 必须是数组） |

**唯一约束**：`epr_peer_reviews_one_active` 部分唯一索引
`(organization_id, event_id, snapshot_id, reviewer_user_id) WHERE status='active'`
→ **一队一件作品一个评分者一条有效记录**。

**守卫触发器** `epr_protect_peer_review`（BEFORE UPDATE）：冻结 `organization_id / event_id / snapshot_id / team_id /
reviewer_user_id / scale / created_at / idempotency_key / document.dimensions / document.values`（**正文与分值不可改写**）；
只允许 `active → withdrawn`（`revision = old + 1`）或 `active → superseded`（`revision` 不变）。

`epr_review_reports`：`id`、范围列、`review_id`（FK → `epr_peer_reviews`）、`reporter_user_id`、
`reason`、`created_at`、`document`；`(organization_id, event_id, review_id, reporter_user_id)` 唯一；
触发器 `epr_review_reports_frozen`（BEFORE UPDATE OR DELETE）禁止改写——**举报只增不改**。

## 7. 验证（真实执行）

```
node --experimental-strip-types --test src/modules/event-peer-review/*.test.ts
ℹ tests 32
ℹ pass 32
ℹ fail 0
```

明细：`policy.test.ts` 11、`service.test.ts` 12、`postgres.test.ts` 4、`handlers.test.ts` 5。

```
node node_modules/typescript/bin/tsc --noEmit --incremental false
(event-peer-review diagnostics: 0)
(whole repo: exit 0, 0 lines)
```

本次运行 **全仓 tsc 0 报错**（执行时另外两个会话的 `event-judging` / `event-community` 改动也不产生诊断）；
本模块自身 0 报错。

### 7.1 硬性要求 → 测试映射

| 要求 | 测试 |
| --- | --- |
| 1 三层门禁 / 明确 403 / 零落库 | `service.test.ts` 第 1、2 例；`policy.test.ts` 第 1、2 例；`postgres.test.ts`（跨 scope 读） |
| 2 量纲与冻结维度 / 未知键与越界 422 | `policy.test.ts` 第 4、6 例；`service.test.ts` 第 2 例 |
| 3 去自评 | `policy.test.ts` 第 3 例；`service.test.ts` 第 2 例 |
| 4 参与率门槛 / 未达门槛不出汇总 / 只按作品 | `policy.test.ts` 第 5、7、8、9 例；`service.test.ts` 第 4、7、8 例 |
| 5 与评审分列 / 评审侧逐字段不变 / 只写自己的表 | `service.test.ts` 第 11 例（`fake_judging_scores` 前后 deepEqual + 记录型 executor） |
| 6 评委不可见 / ui 只导出选手侧 | `handlers.test.ts` 第 1 例 |
| 7 修改 revision / 撤回 / 举报 / 匿名 | `service.test.ts` 第 4、5、6、8、12 例；`policy.test.ts` 第 9 例 |
| 8 幂等 / 跨赛事 / 归档只读 | `service.test.ts` 第 5、9、10 例；`postgres.test.ts` 第 1、2 例 |

## 8. 根接入 NEEDS_INTERFACE

以下全部**未接入**，需主会话组合。本模块不提供根组合代码。

### 8.1 迁移编号与执行

- 建议编号：**`077_event_peer_review.sql`**（仓库现有最大为 `076_work_comments.sql`）。
- 内容：本模块 `migrations/001-event-peer-review.sql`（2 张表 + 3 条索引/部分唯一索引 + 2 个触发器）。
- 依赖：`auth_users`、`organizer_hosted_events(id, organization_id)`、`event_registration_teams(event_id, id)` 已存在。
- **未执行迁移**；由主会话写入根 `migrations/` 并应用。

### 8.2 只读来源端口 `EventPeerReviewSourcePort` 的实现

在 `src/server/organizer-integration.ts`（或新的根适配）注入，**必须复用既有读逻辑**、与调用方同一个 `SqlExecutor`：

| 方法 | 建议实现 | 硬性语义 |
| --- | --- | --- |
| `intakeWorks(sql, eventId)` | 复用 event-judging 既有 `judging.closureIntakeReceipts(sql, scope)`（P09 已存在），投影为 `{id, teamId, version, submittedAt, memberUserIds}` | 只读本场；`memberUserIds` 必须是**该回执冻结时**的成员快照；含历史版本（本模块用 `latestWorkOf` 判当前版本） |
| `workDisclosures(sql, eventId)` | **需要 event-judging 新增一个只读桥**：仿 `closureIntakeReceipts` 增加 `closureWorkDisclosures(sql, scope)`，返回 `{teamId, scope, status}`（`store.listWorkDisclosures` 的只读投影）；本模块只按队伍取 `status='active'` 的那条 | 只读；不写披露；撤回后必须立刻返回 `withdrawn`，否则互评区会与作品展示不一致。若主会话选择在根适配里直接查 `ej_work_disclosures`，必须与 event-judging 的 `findActiveWorkDisclosure` 同口径（同表同筛选），不得另立可见性规则 |
| `approvedParticipantIds(sql, eventId)` | 直接复用 `registration.approvedParticipantIds(sql, eventId)`（已有公共方法，event-communication 名录也在用） | 只读；返回本场报名 `approved` 的账号。其**长度**就是参与率门槛的分母 |

> 注：把 `closureWorkDisclosures` 加到 event-judging 会动另一个会话正在维护的模块，因此本交付**只登记需求，未改其文件**。

### 8.3 路由注册

在 `src/server/organizer-integration.ts` 的 `JUDGING_ROUTES` / `CLOSURE_ROUTES` 之后新增一组
`PEER_REVIEW_ROUTES`（或等价分发），并实例化
`createEventPeerReviewHandlers({ service: peerReview, resolvePrincipal, authorizeMutation, requestIds })`：

| 工厂成员 | 方法 | 模式 | 参数 |
| --- | --- | --- | --- |
| `workPeerReview` | GET | `^competitions/([^/]+)/works/([^/]+)/peer-review$` | `["eventId","snapshotId"]` |
| `submitPeerReview` | POST | `^competitions/([^/]+)/works/([^/]+)/peer-review$` | `["eventId","snapshotId"]` |
| `withdrawPeerReview` | POST | `^competitions/([^/]+)/works/([^/]+)/peer-review/withdraw$` | `["eventId","snapshotId"]` |
| `reportPeerReview` | POST | `^competitions/([^/]+)/works/([^/]+)/peer-review/([^/]+)/report$` | `["eventId","snapshotId","reviewId"]` |

与既有作品路由的关系：`competitions/:eventId/works/:snapshotId/comments...`（P5）与
`.../disclosure`（P2）已经注册；`peer-review` 是新的末段，四条正则各自锚定 `$`，不会互相吞掉。
写请求经既有 `authorizeMutation`（Origin/CSRF）；全部响应 `private, no-store`。

### 8.4 权限

- 全部 4 条端点都要求真实登录账号（未登录 401）；写请求经既有 `authorizeMutation`。
- 提交/修改互评要求本场报名已通过 **且** 不属于被评作品的队伍（去自评）；
- 读取按队伍披露范围（`participants` 只对本场通过者）；
- **不要**为本模块注册任何 `judging_manage` / 评委侧路由或界面（宪法 XIII「评分期间评委不可见」）。
- **不要**把本模块的读写路径并入 `aggregate()`、`results/preview`、`results-export`、公开结果投影或任何导出。

### 8.5 界面挂载落点

- 组件：`PeerReviewPanel({ eventId, snapshotId })`，从 `src/modules/event-peer-review/ui.ts` 导入（客户端组件）。
- 建议落点：既有作品展示条目内，紧邻既有 `WorkComments`（`src/components/work-showcase.tsx` 第 127 行附近），
  即 `<PeerReviewPanel eventId={eventId} snapshotId={entry.snapshotId}/>`。
  **与文字留言分列**：两个独立区块，各自标题写明"不计入名次"，**不合并**成一张点评列表；
  不新增一级导航或第二个作品页面。
- 服务端 403（三层门禁/未公开）时组件应像 `WorkComments` 一样**不渲染空壳**；
  未达门槛时只渲染 `threshold.message`（含门槛百分比），不渲染任何统计。
- 视觉只用 `globals.css` 既有令牌（模块自带 `event-peer-review.module.css`，无字面色值、无进度条/百分比排名徽章）。

### 8.6 所需环境变量

**无新增**。共用既有 `DATABASE_URL` / 本机单实例 PGlite 配置，不含任何密钥值。

## 9. 未做与边界（如实登记）

- **未接入根**：迁移、来源端口、路由注册、界面挂载全部待主会话组合（见 §8）。
- **未跑真实外部验收**：未执行迁移、未构建、未重启、未做真实浏览器/多连接 PostgreSQL 并发验收；
  测试均为隔离内存 PGlite 与受控端口。
- **未做主办方举报处理台**：任务给定 4 条端点，没有主办方读取举报的路由；本模块只把举报记为事实
  （`epr_review_reports`，只增不改）。若主会话需要处理面，请另行决定只读路由——本模块不自行加面。
- **未做通知**：本模块不发任何消息，不调用通知端口。
- **未做隐藏/删除互评**：治理只提供"本人撤回/修改"与"任何人举报"；没有第三方隐藏入口（避免成为报复渠道）。
- **量纲只支持共享枚举**：`peerReviewScale` 的三种取值；若要新增量纲，属共享契约 `EVENT_COMMUNITY_SCALES` 变更（登记为潜在 NEEDS_INTERFACE，未实施）。
- **匿名逐条分值的解释**：见 §1.7；这是为保证"任一可见者可举报"可落地而保留的最小匿名投影，
  已在 `policy.test.ts` 断言不含账号、名次字段，且按 reviewId 而非分值排序。
- 未导入其他模块私有文件；未修改共享契约。
