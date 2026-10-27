# event-peer-review · 选手数值互评（规划 34 P7）

依据：`docs/规划/34-主办方模块化与选手社区.md` §3（尤其 3.2 两种点评分列、3.4 验收）、
`.specify/memory/constitution.md` 原则 XIII「作品公开与点评」、共享契约 `src/shared/organizer-contracts.ts`。
交付说明见 `docs/协作/交付/event-peer-review.md`。

> 本模块是**独立模块**，不是 event-judging 的一部分：规划 34 把"作品展示与点评"放在一起，
> 但宪法 XIII 要求互评「MUST NOT 并入名次、公布或对外导出」且「评分期间评委不可见」。
> 放进**独立模块**后，结构上就不存在任何通往 `aggregate()` / `results` / `results-export` / 名次的写路径，
> 也天然没有评委侧入口——这比"放在评审模块里靠纪律约束"更强。偏离理由见交付文档 §2。

## 1. 边界（写死在 model.ts / policy.ts 里）

1. **三层门禁**：赛事 `community.workShowcase` + 赛事 `community.peerReview` + 该作品所属队伍**本人**有效的公开披露（scope 为 `participants` 或 `public`）。任一不满足 → 明确 403（**不是空数组**），且零行落库。
2. **量纲与维度由主办方配置**：只接受 `peerReviewScale`（`EVENT_COMMUNITY_SCALES`：`1-5` / `0-10` / `yes-no`）与已冻结的 `peerReviewDimensions`；不在冻结维度里的键、缺失维度、非对象一律 422，**不自行补默认维度**。每条评分必须每个维度一个整数且落在量纲取值内。
3. **去自评**：依据**正式收件时的队伍成员快照**，本队成员不能评本队作品（403 `PEER_REVIEW_SELF_REVIEW`）。
4. **参与率门槛**：本场「至少有一条有效互评且仍是报名已通过者的人数 ÷ 本场报名已通过人数」低于 `peerReviewPassRate` 时，**不展示任何汇总**，只返回「样本不足 / 未达门槛」与门槛值本身（不返回参与率、人数、平均分）。达标后**只按作品**给各维度平均与份数，**绝不给任何人排名**。
5. **与评审分列**：本模块不导入 event-judging 的聚合/导出/私有文件，不写任何评审表；只有 `epr_peer_reviews` 与 `epr_review_reports` 两张自己的表。
6. **评委不可见**：本模块没有评委侧入口；`ui.ts` 只导出选手侧组件。
7. **治理**：本人可修改（有 revision，`expectedRevision` 不给就 409）与撤回自己的互评；任一可见者可举报一条互评（只记事实、不裁决、不改分数）；评分者身份对参赛者**不展示**（匿名投影，只按作品聚合）。
8. **幂等键**；**跨赛事读不到**（所有读写都以 `organization_id + event_id` 为界）；**归档赛事只读**（写操作 403 `PEER_REVIEW_EVENT_READ_ONLY`，读取照常）。

## 2. 端点（模块 handler；路径由主会话接根）

| 工厂成员 | 方法 | `/api/v1` 之后路径 |
| --- | --- | --- |
| `workPeerReview` | GET | `competitions/:eventId/works/:snapshotId/peer-review` |
| `submitPeerReview` | POST | `competitions/:eventId/works/:snapshotId/peer-review` |
| `withdrawPeerReview` | POST | `competitions/:eventId/works/:snapshotId/peer-review/withdraw` |
| `reportPeerReview` | POST | `competitions/:eventId/works/:snapshotId/peer-review/:reviewId/report` |

GET 返回 `WorkPeerReviewView = { eventId, snapshotId, teamId, scope, enabled, scale, dimensions[], valueRange{min,max}, myReview|null, canReview, canReviewReason, threshold, summary|null, notices, limitations[] }`；
POST 提交/修改返回同一个 `WorkPeerReviewView`；撤回返回 `{ reviewId, snapshotId, revision, withdrawnAt }`；举报返回 `{ reportId, reviewId, reportedAt, reportedCount, alreadyReported }`。

## 3. 错误码

HTTP 错误（`error.code`，均为明确拒绝，不是空结果）：

| 码 | 状态 | 含义 |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | 未登录（含公开作品：互评一律要求已登录） |
| `WORK_SHOWCASE_DISABLED` | 403 | 本场未开启作品展示（第一层） |
| `PEER_REVIEW_DISABLED` | 403 | 本场未开启数值互评（第二层） |
| `PEER_REVIEW_NOT_DISCLOSED` | 403 | 队伍本人未选择公开 / 选择不公开 / 披露已撤回（第三层） |
| `PEER_REVIEW_PARTICIPANTS_ONLY` | 403 | 作品是「仅本场参赛者」，观看者不是报名已通过者 |
| `PEER_REVIEW_PARTICIPANT_REQUIRED` | 403 | 非本场报名已通过者不能提交互评（访客可读公开作品但不能评） |
| `PEER_REVIEW_SELF_REVIEW` | 403 | 本队成员不能评本队作品（去自评） |
| `PEER_REVIEW_WORK_NOT_FOUND` | 404 | 没有这份正式作品 |
| `PEER_REVIEW_WORK_NOT_CURRENT` | 403 | 该版本已不是该队当前展示的作品 |
| `PEER_REVIEW_DIMENSION_INVALID` | 422 | 维度非法：未知键 / 缺维度 / 非对象 / 未配置维度 |
| `PEER_REVIEW_VALUE_OUT_OF_RANGE` | 422 | 量纲越界：非整数或不在该量纲取值内 |
| `PEER_REVIEW_SCALE_INVALID` | 422 | 本场量纲不是已冻结取值 |
| `PEER_REVIEW_REVISION_REQUIRED` | 409 | 已有互评但修改未给 `expectedRevision` |
| `PEER_REVIEW_VERSION_CONFLICT` | 409 | 版本不符（带 `latestRevision` 与 `recoveryAction: "reload"`） |
| `PEER_REVIEW_IDEMPOTENCY_KEY_REUSED` | 409 | 同一重试标识已用于另一次互评 |
| `PEER_REVIEW_NOT_FOUND` | 404 | 互评不存在 / 不属于本作品 / 已不是有效记录 |
| `PEER_REVIEW_EVENT_READ_ONLY` | 403 | 赛事已归档，只能读 |
| `PEER_REVIEW_INVALID_INPUT` | 422 | 重试标识、版本号、备注等格式错误 |
| `IDEMPOTENCY_KEY_MISMATCH` | 400 | `Idempotency-Key` 头与正文不一致 |
| `INVALID_ROUTE` | 400 | 缺少有效的事件/作品/互评标识 |
| `JSON_REQUIRED` / `PAYLOAD_TOO_LARGE` / `INVALID_JSON` | 415/413/400 | 正文格式 |
| `METHOD_NOT_ALLOWED` | 405 | 方法不符 |

业务状态码（HTTP 200，出现在 `threshold.code`）：

| 码 | 含义 |
| --- | --- |
| `PEER_REVIEW_THRESHOLD_NOT_MET` | 参与率未达门槛：`summary` 为 `null`，只给 `requiredRate` 与说明 |
| `PEER_REVIEW_SUMMARY_READY` | 达标：给出按作品的各维度平均与份数、匿名逐条分值 |

## 4. 数据表（迁移建议）

`migrations/001-event-peer-review.sql`（建议主会话编号 **077**）：

- `epr_peer_reviews`：一队一件作品一个评分者一条**有效**记录（partial unique index `WHERE status='active'`）；`(organization_id, event_id, reviewer_user_id, idempotency_key)` 唯一。
  触发器 `epr_protect_peer_review` 冻结赛事/作品/队伍/评分者/量纲/维度/分值/提交时间/重试标识；只允许 `active → withdrawn`（revision 加一）或 `active → superseded`（revision 不变，分值在本行不可改写）。
- `epr_review_reports`：举报只增不改（`WHERE` 触发器禁止 `UPDATE/DELETE`），`(organization_id, event_id, review_id, reporter_user_id)` 唯一。

## 5. 测试

```
node --experimental-strip-types --test src/modules/event-peer-review/*.test.ts
```

`policy.test.ts`（11）、`service.test.ts`（12）、`postgres.test.ts`（4）、`handlers.test.ts`（5），共 **32** 项。
覆盖三层门禁零落库、去自评、维度与量纲、门槛与匿名投影、修改/撤回/幂等/版本冲突、跨赛事隔离、归档只读、
举报事实、以及「提交互评前后评审侧原始汇总逐字段不变 + 只写 epr_ 表」。

## 6. NEEDS_INTERFACE

根接线（迁移编号、来源端口、路由注册、权限、界面挂载）全部见
`docs/协作/交付/event-peer-review.md` §8。要点：需要 root 注入只读的 `EventPeerReviewSourcePort`
（`intakeWorks` / `workDisclosures` / `approvedParticipantIds`），本模块不直接读其他模块的表。
