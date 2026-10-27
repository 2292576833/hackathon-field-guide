# team-match · AI 智能组队大厅（规划 36 §2.3）

本模块只做**模块层**：纯逻辑、事实投影与端口契约。它不建表、不写路由、不渲染界面，
也不导入其他模块的私有文件；根接入见 `docs/协作/交付/team-match.md` 的 NEEDS_INTERFACE。

依据：`docs/规划/36-AI工作台、组队大厅与全流程效率.md` §2.3；
`docs/规划/34-主办方模块化与选手社区.md` §4（社区默认关闭、仅同场）；
宪法 v1.24.0 原则 XII（不评分、不排名、不编事实）、XIII（本人选择、默认关闭）、XIV（作品与内容归属）。

## 1. 三条门槛（缺一不可）

| # | 门槛 | 事实来源 | 默认 |
| --- | --- | --- | --- |
| ① | 本场报名已通过 | 既有 `event-registration` 的 `status === "approved"` | 未通过即不出现 |
| ② | 名片已发布 | 既有 `recruiting` 的已发布名片快照 | 未发布/已撤回即不出现 |
| ③ | 本人开启「愿意被组队」 | **本模块唯一新增事实** `TeamMatchOptIn` | **默认关**；没有记录按未开启 |

`TeamMatchOptIn` 只有 `{ userId, eventId, open, updatedAt }`，由根注入的
`TeamMatchOptInPort` 读写。`readOpen` 必须只返回 `open = true` 的记录；
`readOwn` 没有记录返回 `null`；`setOwn` 只能写本人。没有这条记录、记录为
`open: false`、或同一账号同场最后一条为关闭，都按**未开启**处理。

组队大厅的查看者只需要本场报名已通过（由根在路由层复核）；查看者自己的 opt-in 决定
**别人能否在厅里看到他**，不决定他能否查看别人。

## 2. 数据投影（都不是新表）

`groupCandidates({ cards, posts, viewer, optIns })` 接收四组事实：

- `cards: TeamMatchCandidateCard[]`：根从既有报名 + 既有名片合成的候选人投影，
  带 `registrationStatus`、`cardStatus`、已发布名片（职责、技能、城市、更新时间）。
  **刻意没有**年龄、MBTI、头像、简历、邮箱；`TeamMatchPublishedCard` 里也没有这些字段。
- `posts: TeamMatchPostFacts[]`：查看者自己的招募贴投影。`coveredRoles` **必须**
  来自 `recruiting/gap.ts` 的 `gapView` 口径（只统计通过本贴批准/已加入的人），
  本模块不另算第二套覆盖。
- `viewer: TeamMatchViewer`：本人 userId、eventId、主/辅角色、可选城市。
- `optIns: TeamMatchOptIn[]`：本场已开启的记录。

`groupCandidates` 不读取数据库、不校验权限、不调用任何写端口；根负责把数据裁到
本人有权看到的范围（本场、本人招募贴、本场候选人）。

## 3. 分组算法（为什么不是排名）

1. 只考虑**开放中且还有名额**的招募贴；关闭、撤回、名额已满的贴不参与。
2. 缺口 = 招募贴 `neededRoles` − `coveredRoles` − 查看者本人已声明的职责。
   "互补"意味着：查看者自己主/辅角色已经覆盖的职责，不再在这里重复找人。
3. 候选人必须同时通过三条门槛，且不是查看者本人。
4. 同一账号在输入里出现多次时只保留**名片最近更新**的一张；整个结果里同一账号
   **只出现一次**。归组规则：先看名片主角色、再看辅角色，按固定职责顺序取第一个
   能补的缺口；其余能补的缺口放在 `coveringRoles` 里如实列出，不会因此重复出现。
5. 组按固定职责顺序（产品 → 设计 → 前端 → 后端 → AI → 测试 → 演示 → 协作 → 其他）
   排列；组内按 `updatedAt` 最近在前，时间相同再按 `userId` 升序。这只是**稳定中性
   顺序**，不是能力、适配度或推荐顺序。
6. 每个缺口组最多展示 12 人（`teamMatchGroupLimit`），这是展示上限，不是排序依据。
7. 没有候选人的缺口放进 `unfilledRoles`，界面只能提示"暂无可展示的人"，
   不得编造或放宽门槛。

返回值里**没有** `score`、`percent`、`rank`、`rating`、`weight`、`points`
等字段，也没有"最佳匹配/最佳人选"字样。`notice` 与 `evidence` 必须原文展示，
用来说明口径与"顺序不代表能力评价"。

## 4. 解释（可选 AI）

`explainCandidate({ model?, facts })` 生成 1–2 句人话：

- 只接受 `TeamMatchExplanationFacts`：显示名、职责、技能、城市、是否同城、
  可选招募贴标题。`explanationFacts(candidate)` 是唯一推荐的构造方式，它只挑这些字段。
- 模型未注入 → 固定模板句 + `degraded: true`，`degradedReason: "model_not_injected"`。
- 模型抛错 → 模板句 + `degraded: true`，`degradedReason: "model_failed"`。
- 模型输出包含 facts 之外的技能/经历、引号内未授权术语、评分/百分比/排名/年龄/MBTI/
  联系方式、超过 2 句、Markdown、或超过 240 字 → **整段拒绝**，退回模板句，
  `degradedReason: "model_output_rejected"`，绝不透传。
- 模型输出被接受时 `degraded: false`、`source: "model"`，并补上句号。

提示词明确禁止补事实、评分、排名、推荐结论与承诺。中文自由文本无法做到完备验证，
所以根适配必须使用禁工具、低温模型，界面把解释标为「AI 拟句」；解释不是事实来源。
详见 `guide.ts` 顶部边界说明。

## 5. 邀请复用（不新建第二套邀请）

`TeamMatchInvitePort` 只有 `createApplication(actor, input)`，由根适配**既有**
`POST /api/v1/recruiting/posts/:postId/applications`：

- 不变量 `actor.userId === input.applicantUserId`，只能由申请人本人确认后调用；
  平台不代填、不代提交。
- 创建的是既有招募申请，**不是成员资格**；批准与加入仍走既有流程。
- 本模块**没有调用点**，也没有任何导出函数会创建申请、发私信或自动加入队伍。
  组队大厅的动作只是跳转到既有申请页，由本人完成。

## 6. 明确不做

- 不评分、不给百分比/适配度、不排名、不写"最佳匹配"；
- 不展示简历全文、年龄、MBTI、头像或联系方式；
- 不新建邀请表/私信通道/通知系统；
- 不自动邀请、不自动加入队伍、不替本人开启 opt-in；
- 不读未发布名片、不读私人测评、不读其他模块的私有存储。

## 7. 测试

`node --experimental-strip-types --test src/modules/team-match/*.test.ts` → **27 项通过**。

覆盖：三条门槛各自拒绝、opt-in 缺失/关闭、最后一条 opt-in 生效、缺口分组、
查看者角色排除、跨贴合并、空名片/无职责名片/空招募贴、关闭/撤回/满员、稳定顺序与输入顺序无关、
同一候选不重复、无分数字段、无简历字段、模板降级、模型失败、编造技能（英文与中文）、
评分/百分比/排名拒绝、超过 2 句拒绝、合法模型输出、无写入口。

`node node_modules/typescript/bin/tsc --noEmit --incremental false` → exit 0。

## 8. 根接入

见 `docs/协作/交付/team-match.md`：需要的 Port、opt-in 存储建议（含 SQL）、
路由与动作块、主办方配置与验收清单。模块本身**不提供** HTTP handler、迁移或界面。
