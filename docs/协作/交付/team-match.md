# team-match · AI 智能组队大厅（模块层交付）

日期：2026-10-18。依据：`docs/规划/36-AI工作台、组队大厅与全流程效率.md` §2.3、
`docs/规划/34-主办方模块化与选手社区.md` §4、宪法 v1.24.0 原则 XII / XIII / XIV。

## 1. 交付范围

只新增 `src/modules/team-match/`，**未改**任何既有文件、`app/server/components/shared`、根 `migrations`。
模块只含纯逻辑、事实投影与端口契约：没有数据库访问、HTTP handler、React 组件或迁移。

| 文件 | 内容 |
| --- | --- |
| `model.ts` | 三条门槛投影、`TeamMatchOptIn`、opt-in / 邀请 / 解释端口、分组返回结构 |
| `matching.ts` | `isOptInOpen`、`teamMatchGate`、`groupCandidates`、稳定顺序与去重 |
| `guide.ts` | `templateExplanation`、`explanationFacts`、`explainCandidate`、输出校验与降级 |
| `index.ts` | 模块公共导出 |
| `README.md` | 门槛、算法、降级、端口与明确不做 |
| `matching.test.ts` / `guide.test.ts` | 27 项测试 |
| `docs/协作/交付/team-match.md` | 本文件 |

## 2. 已验证

```
node --experimental-strip-types --test src/modules/team-match/*.test.ts
# tests 27 / pass 27 / fail 0

node node_modules/typescript/bin/tsc --noEmit --incremental false
# exit 0（无输出）
```

测试覆盖：三条门槛各自拒绝；opt-in 缺失/关闭按未开启；最后一条 opt-in 生效；
按缺口分组与查看者角色排除；跨招募贴合并；空名片/无职责名片/空招募贴；关闭/撤回/满员贴；
稳定顺序且与输入顺序无关；同一候选不重复；无 score/percent/rank 字段；无简历字段；
无模型降级；模型抛错降级；英文/中文编造技能被拒；评分/百分比/排名被拒；超过 2 句被拒；
合法模型输出；模块无写入口。

**未验证**（如实登记）：真实数据库、真实 HTTP 路由、真实 DSH 模型质量、浏览器走查、
主办方配置与发布版本冻结。这些需要根接入后由主会话验收。

## 3. 三条门槛

| # | 条件 | 判断位置 | 默认 / 失败结果 |
| --- | --- | --- | --- |
| ① | 本场报名 `approved` | `teamMatchGate` 读 `registrationStatus` | 非 approved（含 draft/pending/rejected/withdrawn/none）→ 不出现 |
| ② | 名片已发布 | `teamMatchGate` 读 `cardStatus` 且 `card !== null` | withdrawn/none/投影不一致 → 不出现 |
| ③ | 本人开启「愿意被组队」 | `isOptInOpen` 读 `optIns` | 没有记录、`open: false`、最后一条关闭 → 不出现 |

第三条是本轮**唯一新增事实**：

```ts
interface TeamMatchOptIn { userId: string; eventId: string; open: boolean; updatedAt: string }
```

它不是名片字段，也不是 `EventCommunityConfig`（主办方不能替本人开），只能由本人通过
`TeamMatchOptInPort.setOwn` 写入；没有记录**不得**按开启处理，也不做历史回填。
同一账号同场有多条时，以 `updatedAt` 最新的一条为准（存储层应保证唯一）。

查看者本人也需要本场报名已通过，但查看者自己的 opt-in 只决定"别人能否看到他"，
不决定"他能否看别人"；两条权限在根路由层分别复核。

## 4. 分组算法（为何不是排名）

`groupCandidates({ cards, posts, viewer, optIns })`：

1. 只取 `status === "open"` 且有剩余名额（`seats - takenSeats > 0`）的招募贴。
2. 缺口 = `neededRoles` − `coveredRoles`（来自既有 `recruiting/gap.ts` 的 `gapView` 口径）
   − 查看者本人主/辅角色。查看者自己能补的职责不重复找人，这是"互补"的含义。
3. 候选人必须通过三条门槛，且 `userId !== viewer.userId`。
4. 输入里同一账号的重复投影先按"名片最近更新"合并；结果里同一账号只出现一次。
   归组优先级：名片主角色（按固定职责顺序）→ 辅角色（按固定职责顺序）→ 第一个可补缺口；
   其余能补的缺口放进 `coveringRoles`，信息不丢失，但不重复出现。
5. 组按固定职责顺序排列（product → design → frontend → backend → ai → testing →
   presentation → coordination → other）；组内按 `updatedAt` 降序、再按 `userId` 升序。
6. 每组最多 12 人（`teamMatchGroupLimit`），只是展示上限。
7. 没有候选人的缺口放 `unfilledRoles`，界面只能显示"暂无可展示的人"。

**为什么不是排名**：排序键是名片更新时间与账号标识，二者都不是能力信号；它只保证
同一份数据每次渲染顺序一致，便于核对。模块不产出分数、权重、百分比、名次或"最佳"判定，
也不读取年龄、MBTI、头像、简历。宪法 XII 要求"同一缺口有多人覆盖时使用稳定中性顺序，
并说明这不是能力评价"，这里的 `notice` / `evidence` 就是那句说明，界面必须原文展示。

## 5. 解释与降级

`explainCandidate({ model?, facts })`：

- `facts` 只允许显示名、职责、技能、城市、是否同城、可选招募贴标题；
  `explanationFacts(candidate)` 只从候选人投影挑这些字段。
- 模型未注入 → 模板句，`degraded: true`，`degradedReason: "model_not_injected"`。
- 模型抛错 → 模板句，`degraded: true`，`degradedReason: "model_failed"`。
- 输出校验失败 → 模板句，`degraded: true`，`degradedReason: "model_output_rejected"`：
  - facts 之外的 ASCII 词（如 `Rust`、`Kubernetes`）；
  - 引号内未授权术语、"会/擅长/精通/熟悉/掌握/做过/用过"后的未授权断言、
    "有…经验"里的未授权内容；
  - 最佳/匹配度/推荐指数/得分/评分/排名/百分比/年龄/MBTI/头像/联系方式/简历；
  - 超过 2 句、超过 240 字、空文本、Markdown。
- 成功 → `degraded: false`，`source: "model"`，补句号。

模板句示例（模型不可用时）：

> 小林的名片把「后端开发」列为可补上的职责。名片里写的技能是 TypeScript、React；城市和你相同（杭州）。

已知边界：中文自由文本无法完备证明"没有编造"。当前校验能挡住测试列举的英文技能、
中文"会/擅长/有…经验"断言、评分/排名/年龄等；更口语化的虚构仍可能漏过。
因此根适配必须禁工具、低温、把解释标为「AI 拟句」，且解释不是事实来源；
宁可在不确定时降级为模板，也不透传。

## 6. 端口契约

### 6.1 `TeamMatchOptInPort`（新增事实的唯一读写口）

```ts
readOpen(actor, eventId): Promise<readonly TeamMatchOptIn[]>; // 只返回 open=true
readOwn(actor, eventId): Promise<TeamMatchOptIn | null>;       // 没有记录 null
setOwn(actor, input: { eventId; open: boolean; now: string }): Promise<TeamMatchOptIn>;
```

- 根实现必须使用传入的 `SqlExecutor`/同一事务，不另开连接；写前复核账号有效与本场报名。
- `readOpen` 不得返回关闭记录；"关闭"不能靠调用方过滤，否则容易泄漏/误用。
- `setOwn` 只能写 `actor.userId`；不允许管理员或主办方代改。
- 归档赛事只读；关闭后不再返回新数据（与规划 34 §4.2 一致）。

### 6.2 `TeamMatchInvitePort`（只定义，不调用）

```ts
createApplication(actor, input: {
  eventId; postId; applicantUserId; message; idempotencyKey;
}): Promise<{ applicationId: string }>;
```

- 根适配**既有** `POST /api/v1/recruiting/posts/:postId/applications`，不建第二张邀请表。
- 不变量：`actor.userId === input.applicantUserId`；只能由申请人本人确认后调用。
- 创建的是既有招募申请，不是成员资格；批准/加入仍走既有流程。
- 本模块没有任何调用点；GET / 分组 / 解释都不会创建申请。

### 6.3 `TeamMatchExplainModel`（可选 AI）

```ts
explain(input: { instruction: string; facts: TeamMatchExplanationFacts }): Promise<string>;
```

根可适配共享 `PersonalAiPort`，但必须：禁工具、只读 facts、计入既有 AI 账本
（谁、哪个模块、读了什么范围、花费）、不用于训练（宪法 XII）、失败时明确降级。

### 6.4 读投影（不是端口，由根组合）

`cards` / `posts` 由根从既有事实投影：

- `cards`：本场报名 `approved` 的账号 + 其**已发布**名片（`recruiting_cards` 的当前发布快照）；
  不要带未发布/已撤回卡、私人档案、年龄、MBTI、头像 URL、邮箱。
- `posts`：查看者自己的开放招募贴 + `gapView` 的 `coveredRoles`；
  不要传其他队伍的招募贴。
- `viewer`：本人 userId、eventId、主/辅角色（来自本人资料）、可选城市。

如果根更愿意把两段查询封成端口，可以新增 `TeamMatchDirectoryPort` 并在交付中登记；
当前模块只吃数据，避免把 SQL 带进纯逻辑。

## 7. NEEDS_INTERFACE（根接入）

### 7.1 需要的 Port / 适配

| 需求 | 根需要提供 | 说明 |
| --- | --- | --- |
| opt-in 读写 | `TeamMatchOptInPort` 的 SQL 适配 | 新表，见 7.2；与账号/报名同事务 |
| 邀请复用 | `TeamMatchInvitePort` → recruiting `apply` | 只能本人动作；不自动调用 |
| AI 解释 | `TeamMatchExplainModel` → 共享 DSH | 计入既有账本；禁工具；失败走模板 |
| 候选人投影 | 报名（approved）+ recruiting 已发布名片 | 本场范围；不暴露私人字段 |
| 招募贴投影 | 本人开放贴 + `gapView.coveredRoles` | 不另算覆盖口径 |
| 查看者角色 | 本人 recruiting 主/辅角色 | 只用于互补充判断 |
| 赛事开关 | 本场是否开启组队大厅 | 默认 false；关闭时 403/空，不返回数据 |

### 7.2 opt-in 存储建议

建议新增根迁移（编号由主会话分配；当前最新为 `082`，下一号建议 `083`），**未应用**：

```sql
-- 083 · 组队大厅：本人「愿意被组队」选择（team-match 模块的根增量迁移）
-- 默认关闭；一人一场一行；没有行 = 未开启。主办方不能代改。
CREATE TABLE tmt_team_match_opt_in (
  organization_id text NOT NULL,
  event_id text NOT NULL,
  user_id text NOT NULL REFERENCES auth_users(id),
  open boolean NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, event_id, user_id),
  FOREIGN KEY (event_id, organization_id) REFERENCES organizer_hosted_events(id, organization_id)
);
```

- 不并入 `recruiting_cards`：名片是公开快照，opt-in 是逐场、可撤回的本人选择。
- 不并入 `EventCommunityConfig`：那是主办方配置，不能替本人决定。
- 不做历史回填；没有行即关闭。账号删除按既有外键/清理路径处理。
- 可选审计：写操作记录到既有操作日志（本人、场次、开/关、时间）；若做，复用既有审计表，不新建第二套。

### 7.3 建议路由（根注册；模块不提供 handler）

| 方法 | `/api/v1` 之后路径 | 权限 / 行为 |
| --- | --- | --- |
| GET | `competitions/:eventId/team-match` | 本场报名 approved；赛事开关开启；否则 403/空。只读分组 |
| GET | `competitions/:eventId/team-match/opt-in` | 本人；返回 `{open, updatedAt}` 或 null |
| POST | `competitions/:eventId/team-match/opt-in` | 本人；body `{open: boolean}`；CSRF/origin 走既有 `authorizeMutation` |
| POST | `competitions/:eventId/team-match/explain` | 本人；body `{candidateUserId, postId}`；只对通过三门槛且在当前分组的候选人生成；计入 AI 账本 |

- 所有响应 `Cache-Control: private, no-store`。
- GET 不触发任何写、不调用模型；explain 是显式 POST，且失败降级不阻塞页面。
- 不新增"邀请"端点；接触跳到既有招募申请页，由本人提交。

### 7.4 动作块与界面

- **专属页动作块**：「进入组队大厅」→ 跳转 `/competitions/:eventId/team-match`（动作必须跳转，不内联写）。
- **大厅页**：顶部开关「愿意被组队」（POST opt-in）；说明三门槛与"顺序不代表能力评价"；
  按 `groups` 渲染；`unfilledRoles` 只显示"暂无可展示的人"。
- **候选人卡**：只显示显示名、职责、技能、城市/同城、解释（标「AI 拟句」或模板）；
  动作「查看招募帖 / 去申请」跳到既有招募申请页，不自建私信或邀请弹窗。
- 没有真实招募贴可申请时，不显示接触按钮；不得用 `TeamMatchInvitePort` 代申请人写申请。
- 不展示简历全文、年龄、MBTI、头像、联系方式；不显示任何分数/百分比/名次。

### 7.5 主办方配置

规划 36 要求"是否开启、显示哪些字段、语气（封闭选项）"由主办方配置。本轮模块**未实现**
配置参数；建议根在 `EventCommunityConfig`（共享结构，主会话拥有）新增：

```ts
teamMatch: boolean;            // 默认 false，随正式发布版本冻结
```

关闭时路由 403/空、界面不渲染入口。字段显示可在根投影层裁剪（不传 `skills`/`city` 即不会展示）；
语气若要做，应是封闭枚举（如 `plain | warm | concise`）并只影响模板措辞，不能改变事实或校验。
**不要**把这些配置塞进 `EventModuleFlags`（规划 34 §5 已明确成本）。

### 7.6 验收清单（根接入后）

1. 报名 pending/rejected/withdrawn、名片未发布/已撤回、opt-in 缺失/关闭 → 均不出现。
2. 打开 opt-in 后立刻出现；关闭后立刻消失；没有记录时界面显示"未开启"。
3. 结果里没有 `score`/`percent`/`rank` 字段，没有百分比、"最佳匹配"、名次。
4. 同一候选在整页只出现一次；改变数据库返回顺序不改变渲染顺序。
5. 空名片/空招募贴 → 空分组，不编造候选人。
6. 无模型 → 模板句且标降级；假模型编造技能 → 拒绝并回模板。
7. GET 分组/解释不会新增招募申请；只有既有申请 POST 会写。
8. 赛事开关关闭 → 403/空；非本场或访客 → 403。
9. AI 调用可在既有账本核对；未用于训练。

## 8. 明确不做

- 不评分、不排名、不给百分比或"最佳匹配"；
- 不展示简历全文、年龄、MBTI、头像、联系方式；
- 不新建第二套邀请、私信或通知；
- 不自动邀请、不自动加入队伍、不替本人开 opt-in；
- 不建第二份名片/报名/覆盖事实，不改既有模块；
- 不把主办方配置当成本人选择，不读私人测评或其他模块私有存储。
