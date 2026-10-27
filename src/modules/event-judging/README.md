# O04 正式收件与人工评审

独立模块交付，根路由、真实迁移、部署和跨模块验收由主会话接入。生产工厂只接受 `DatabasePort`，没有内存降级。

`index.ts` 导出 `createEventJudgingService`、`createEventJudgingHandlers` 与业务类型；`ui.ts` 导出 `EventSubmissionPanel`、`JudgeWorkspace`、`JudgingManager`、`EventResultsPanel`。客户端独立导入 `ui.ts`，避免把 Node 加密和数据库代码打进浏览器。

## 人工闭环

队长按当前报名与锁定队伍事实预览材料，以赛事版本、队伍版本、上一提交版本和材料哈希确认收件。正式回执及历史版本不可改写。材料是有界文字、HTTPS链接和文件元数据；不下载文件、不执行代码，文件元数据的哈希由提交者提供，材料哈希只证明本站冻结内容一致。

负责人先配置整数评分范围、100%权重、最少评委数、缺评与同分策略，再开轮。开轮冻结本轮每队最新正式快照，之后的新提交不会悄悄替换正在评审的材料。评委须明确指派，通过系统关联核查并本人申报无冲突后才能读材料。未知关联不自动放行；回避即阻断读取与评分。负责人也须成为有效指派评委，才能本人打分。

草稿允许只填部分维度，不进入汇总；正式提交须填齐整数分数。每个维度归一化为0–100分再按权重加总，多名有效评委等权平均，系统用固定整数精度计算。缺评总分和名次为 `null`；缺評阻止公布或明确排除排名。并列可共享名次，人工排序仅允许调整同分顺序。配置/名单开轮冻结，评分锁定后不能修改。

已正式提交分数的纠正必须附说明，并保留修改前后审计。已公布结果须先撤回，再重开评审，纠正分数、重新锁定和人工公布；新的公布有递增版本，旧版本保留。锁定或公布后新发现冲突，评委仍能立即申报回避。当前有效评分与已锁定公布依据变化时，公开/本人结果返回 `needs_review`，暂停分数、名次及反馈展示，仅保留版本、时间、轮名与不含评委/原因的通用提示。负责人从当前汇总核查进入撤回、重开、补评、锁定和再次人工公布。历史公布不被隐式重新计算或改写。

公开接口只展示最近一个**当前可见、仍公布**的轮次，正常时包含轮名、作品名称、队伍标识、总分、名次和人工批准反馈；需要复核时不回退另一轮来冒充本版有效。队伍反馈仅当前队伍成员可见；参与者范围仅当前通过报名的账号可见。评委只得到本人指派、本人分数和该作品的必要正式材料，不得到完整成员名单、重试键、私人AI记忆、其他作品材料或未公布汇总。评委列表读分数后和整份列表返回前再次复核，关联/指派变化会清掉title/score，以 `accessStatus` 明示当前可读性；输出assignment.status可只读派生为needs_review，不能把历史active当授权。

## 评委严格度校准（派生视图，不改变正式结果）

`calibration.ts` 按评委自身的均值和标准差把分数映射到本轮全局分布，用于发现"严评委/松评委"造成的偏差。它是对标竞品实现后的落地版本（竞品源码 `server.ts` L294–382 的 Z-score），但修掉了其三个实测缺陷：

- **只做派生**：`aggregate()` 的原始分与名次是唯一正式结果，校准分单独返回，不进入锁定汇总、公布结果或 `ResultSummary`，因此历史锁定/公布依据的哈希不受影响。
- **样本不足不校准**：本轮每位提交过评分的评委都必须达到 `minScoresPerJudge`（5 份），且至少 `minScoredSnapshots`（3 个）作品获得两位及以上评委评分，否则 `status=insufficient_sample`，不提供任何校准分。竞品在 $N_j{=}1$ 时 $\sigma=0$，$Z$ 恒为 0，会把该评委的评分压成全局平均、抹掉全部区分度。
- **无差异不校准**：本轮有效评分若完全没有差异，返回 `reason=no_variance`，避免用无意义的分布去"校准"。
- **标准差有下限**（0..100 分制取 5 分），避免极小方差把 $Z$ 放大成极端值。
- **打分无区分度只提示**：样本达到 3 份且标准差低于 3 分时标记 `compressionFlagged`，由主办方人工复核，不自动判定分数无效、不自动扣分。
- `excludedScores` 列出"未进入汇总的评分及原因"（尚未提交 / 指派已回避、待复核或已撤销），作为"先校验后聚合"的复核入口。

接口：`service.calibration(principal, eventId, roundId)` → `CalibrationReport`，只读、只限本场 `judging_manage`；HTTP `GET organizer/events/:eventId/judging/rounds/:roundId/calibration`；界面在"人工汇总与公布"下方以折叠面板展示（原始分在前、校准分标注"仅参考"）。

## 越权尝试留痕（评委侧）

评委侧的 `judgeMaterials` / `saveScore` / `submitScore` / `declareConflict` 在被拒绝时（`JUDGE_ACCESS_DENIED`、`JUDGE_CONFLICT`）除返回既有 403 外，还会在 `ej_judging_audits` 追加一条 `judge_access_denied` 记录，写明被拒账号、指派和错误码（竞品源码把"试图读取同侪评分"本身记为审计事件，我们保留同样的证据链，便于主办方发现有人反复试探边界）。审计在**原事务回滚之后**另开事务写入，因此不会随拒绝一起回滚；同一条事务里再锁同一赛事会死锁，这也是它必须独立成事务的原因。留痕失败只影响留痕本身：不会放行、也不会把 403 变成 500，该边界在此登记。留痕不产生任何评分、指派或材料事实（`service.test.ts` 有断言）。界面在既有评审管理记录的"审计与导出"里以"被拒绝的评审访问（越权尝试）"显示。

## 评审隔离一键自检（派生视图，只读）

`integrity.ts` 回答"当前这轮的边界还成立吗"。它是竞品源码 `POST /api/audit/probe`（JUDGELAYER `server.ts` L1157–1213）同一目的的实现：主办方不必逐个入口试错，就能拿到边界结论。五项检查全部只读、只用既有事实：

| 检查 | 含义 | 何时需要处理 |
| --- | --- | --- |
| `conflict_blocked` | 存储里仍是有效指派，但按最新关联核查已被阻断 | 有：评分不会进汇总，需核查关系或撤销/重新指派 |
| `excluded_scores` | 已因回避/待核查/撤销而未计入汇总的评分 | 不需要处理，列为"边界确实生效"的证据 |
| `score_values` | 有效评分是否都落在**冻结**维度与整数范围内 | 有：出现未知维度、越界值或维度数不符 |
| `duplicate_assignments` | 同一评委对同一作品是否只有一条有效指派 | 有：同一意见会被重复计入（写入侧已用 `JUDGE_ALREADY_ASSIGNED` 拒绝，这里是纵深核对） |
| `round_snapshots` | 本轮冻结的作品名单是否都有正式收件材料 | 有：缺材料会让汇总中断 |

注意实现要点：服务层按最新核查修正的是**同一个指派对象**（id 不变、状态可能变成 `recused`/`needs_review`），因此"是否仍有效"必须比较状态，不能用 id 是否出现在有效集合里判断——这一点由 `integrity.test.ts` 的用例固定。

接口：`service.integrity(principal, eventId, roundId) → IntegrityReport`，只读、只限本场 `judging_manage`；HTTP `GET organizer/events/:eventId/judging/rounds/:roundId/integrity`；界面与校准视图并列，放在既有"人工汇总与公布"下方，样式沿用我们自己的组件与配色令牌。自检不改变任何评分、指派、汇总或公布。

## 提交前字段级自检（不通过不发请求）

`preflight.ts` 在正式提交前**一次列出全部问题**（竞品把这一步做成独立机制：HackerTrip CLI `lib/submit-event.mjs` L123–144、`lib/publish-work.mjs` L107–115），而不再"撞到第一个错误就抛"：

- 区分 **需要修正（block）** 与 **提示（warn）**：重复的链接地址、重复的文件哈希只提示、不拦；其余（必填与长度、链接与文件各 ≤12、HTTPS 且不带账号密码、文件大小 ≤1 GB 整数字节、64 位 SHA-256、材料合计 ≤24 KB、控制字符）都会在**发出任何请求之前**列出并阻止提交。
- 规则与 `validation.ts` 的 `materials()` 同口径，**服务器校验仍是唯一权威**；界面写明"这次没有发出任何请求"，不会产生半成品提交或消耗幂等键。

## 评审进度追踪（派生视图，不催办）

`progress.ts` 回答"这一轮还差谁"：`service.workspace()` 早已返回本轮全部集合，但此前**没有任何地方把它聚合**，主办方只能逐个作品点开数。本视图**只用既有事实**，不新增状态、不加表、不加查询。

- **口径与既有实现完全一致**（本文件最重要的约束）：已提交评分的判定与 `aggregate()` 的 `effective` 过滤相同（`status === "active" && declaration === "clear"` 且评分 `state === "submitted"`），输入用的是服务层已按最新关联核查修正过的 `checked`。因此 `rows[].submittedCount` 与 `aggregate()` 的 `submittedJudgeCount` 相等，`judges[].submittedCount` 与 `calibration()` 的 `submittedCount` 相等（`progress.test.ts` 用断言固定）。
- **三层内容**：作品层（已提交数 / `minJudges` / 还差几位）；评委层（已提交数 / 应评数 / 还差几件 / 已排除数）；轮次层（尚未收齐清单，按缺口降序、同缺口按作品标识稳定排序）。
- **`recused` / `revoked` / `needs_review` 的指派计入"已排除"并标注原因，不计入分母**；分母只含有效指派。
- **措辞纪律**：只报"已有 / 还差"，不出百分比、进度条、完成度或"落后"；不把未提交写成"不负责"。无指派时是空态（`status: "empty"`、评委行为空），**不凭空造出评委行**。
- **不做自动催办**：催办会真实发邮件，属规划 33 第 8 节决策点 3，未确认前不做；本视图只呈现事实。
- 接口：`service.progress(principal, eventId, roundId)` → `ProgressReport`，只读、只限本场 `judging_manage`；HTTP `GET organizer/events/:eventId/judging/rounds/:roundId/progress`。
- **界面**：`JudgingPanels.tsx` 的 `JudgingManager` 内新增折叠面板「评审进度（只读，不催办）」，与校准 / 自检 / 公平规则包**并列**（不替换、不合并）。桌面「按作品 / 按评委」两列，`≤620px` 堆叠；每行 `min-height:44px`；计数只用文字（`已提交 3 / 最少 3`、`还差 2 位`、`已收齐`、`已交齐`）。已排除指派单独折叠成组、标注原因、徽标用中性色。空态按 `status:"empty"` 渲染，评委区显示"本轮还没有排定评委指派"，**不造评委行**。`status==="setup"`（尚未开始评分）时按钮禁用并说明原因。切换轮次会清空进度，避免把上一轮的结果当成当前轮。

## 已公布结果导出（留档口径，与内部对账表并存）

`service.exportResults` 产出**作品级**结果，用于交给赞助方、学校或留档。它与既有的 `service.exportScores` **口径不同且不覆盖**：

| 导出 | 用途 | 含评委账号 | 文件名 |
| --- | --- | --- | --- |
| `exportScores`（既有） | 内部对账、核查谁没评 | 是 | `judging-scores.csv` |
| `exportResults`（新增） | 留档、对外交付 | **否** | `judging-results.csv` |

- **只输出主办方已发布过的投影字段**，来源是既有的 `projection(sql, scope, null)`（它已实现 `needs_review` 拦截与 `participants` 可见性复核），因此**不另算一套分数或名次**；只含**公开**反馈，队伍专属反馈不进入留档件。
- 列：作品名称、队伍标识、总分、名次、人工批准反馈；文件头为 `#` 注释行（赛事、评审轮、公布版本、公布时间、生成时间）。
- **不导出**：评委账号或真名、联系人、答卷、私人求助、住宿、申诉正文、内部快照 ID。
- `needs_review` 时**不输出分数与名次**，只输出状态与版本；未公布或**已撤回**时拒绝（`RESULTS_NOT_PUBLISHED`，409）并说明原因。
- 复用既有 `csvCell` 防公式注入；导出动作写既有审计（`results_exported`）。
- **界面**：既有「评分修改、公布记录与导出」折叠区内并列两个按钮，各带一句用途说明以免拿错——`导出分数明细（内部对账）`（含评委账号，不要外发）与 `导出已公布结果（可对外留档）`（作品级结果与公开反馈，不含评委身份与联系人）。后者使用**当前选中轮次**的 `roundId`，未选择轮次时禁用；两者都是 GET，前端沿用既有 `Blob` + 临时 `<a download>` 下发方式，未新造机制。
- 接口：`service.exportResults(principal, eventId, roundId)`；HTTP `GET organizer/events/:eventId/judging/rounds/:roundId/results-export`。

## 相似 / 重复材料待复核（人工线索，不是判定）

`duplicates.ts` 跨队伍比较各自**最新一版**正式材料，只产出可核对的事实线索：同一文件哈希（高）、同一材料地址（中，忽略查询串/片段/结尾斜杠）、同名作品（低，名称归一后比较）。每条线索给出具体依据与四条限制说明；**不做评分、不给百分比、不产出公开分级、不自动通知任何队伍**，超过 50 条明确告知截断。接口 `GET organizer/events/:eventId/judging/duplicates`（仅工作人员），界面在评审管理页折叠面板。

## 公开公平规则包与扣分建议（需人工确认，不自动扣分）

`fairness.ts` 把本轮**已冻结**的评审事实整理成可直接展示给选手的规则声明（维度与权重、最少评委数、缺评与同分处理、材料范围、不计入汇总的评分数量、已提交评分数、申诉时限、更正链路），未填写的一律写"未提供"。另按已有事实（迟交、材料过薄、缺评）列出**需主办方确认**的建议：每条都带具体依据与"需你确认"标记，**系统不自动扣分、不取消资格、不改结果**。接口 `GET organizer/events/:eventId/judging/rounds/:roundId/fairness`（仅工作人员），规则包文本可一键复制，是否公开由主办方决定。

## 赛前自检与赛后只读复用清单（不建立第二套完成状态）

`checklists.ts` 只看本人队伍自己的事实：赛前 7 项只读核对（报名、队伍、人数规则、正式交件、材料齐备、截止、公布状态），只报"已具备/待处理/按规则确认"，**不写入任何打勾记录**、不替主办方判断人数规则、没交件时不编造截止时间；赛后复用清单只列本队的回执、规则版本、链接、文件元数据与本队那一行的已批准反馈，其他队伍内容一律不出现，并写明复用他人素材需自行确认许可与署名。接口 `GET competitions/:eventId/my-checklists?teamId=`。

## 参赛者申诉（公布之后的新事实，不自动改结果）

`appeal.ts` 提供结果公布之后的正式申诉通道：此前只有主办方撤回/重开，选手缺少可留痕的正式渠道（依据竞品源码 Synnovator `.github/workflows/appeal.yml` 把申诉做成公布后独立一步）。它**只新增申诉事实，绝不改变分数、名次或公布**。

- **谁能提**：必须是该公布版本中某件作品的**当前队伍成员**（用正式收件回执的成员快照 + 当前队伍名单双重校验），且本场报名已通过；不能代人提交。
- **能提几次**：一条队伍对**同一版公布结果**只有一条有效申诉（数据库部分唯一索引 + 服务层校验）；撤回后可以重新提交；同一重试标识（`idempotency-key`）幂等返回同一条。
- **时限**：本轮 `JudgingConfig.appealWindowDays`（默认 7 天，范围 1–90，非法值回退默认），以公布时间为起点，到点即关闭。它写在开赛前冻结的轮次配置里，日期随规则一起锁定。
- **状态与处理**：`submitted → accepted / rejected / handled`，另有选手本人可发起的 `withdrawn`。处理只改状态并写审计，**不改动结果**；如需更正分数，仍必须走既有"撤回 → 重新开放 → 补评 → 重新锁定 → 人工公布"。
- **不可改写**：触发器 `ej_protect_appeal_identity` 保证申诉范围、申诉人原始理由/希望结果、时间与重试标识不可改写，版本必须递增，已处理的申诉不能再改。
- **可见性**：选手只看本人提交的、或本人当前仍是所属队伍成员的申诉；公开结果投影不包含任何申诉内容（根路由验收有断言）；主办方按 `judging_manage` 看全量队列与待处理数。

接口：`service.fileAppeal / withdrawAppeal / ownAppeals / eventAppeals / resolveAppeal`；HTTP `POST|GET competitions/:eventId/appeals`、`POST competitions/:eventId/appeals/:appealId/withdraw`、`GET organizer/events/:eventId/judging/appeals`、`POST organizer/events/:eventId/judging/appeals/:appealId/resolve`；界面在本人赛事结果页（提交与查看）与主办方评审管理页（处理队列），样式沿用我们自己的组件与配色令牌。迁移：根 `migrations/071_result_appeals.sql`（与模块 `schema.sql` 保持一致）。

## 作品展示（队伍可选公开，规划 34 C①）

`works.ts` 与服务方法实现规划 34 C①：作品是否公开由**提交的队伍本人**选择，主办方只决定"本场是否允许这件事"；两者同时满足才对他人可见（缺一不公开）。

- **三层开关**：① 赛事级 `community.workShowcase`（主办方配置，默认 false，随正式发布版本冻结，用共享 `eventCommunity(scope)` 读取）；② 队伍级 `scope`（`private` 默认 / `participants` 仅本场参赛者 / `public` 含访客）；③ 个人级点评（规划 34 P5/P7，**本批不做**）。开关关闭时**读取与提交都明确 403**（`WORK_SHOWCASE_DISABLED`）——不返回空数组冒充"没有作品"。
- **唯一新增事实**：`ej_work_disclosures`，一队一条有效记录（部分唯一索引 + 既有赛事写锁串行化）。再次提交会**取代**上一条（旧记录置 `withdrawn`，范围与逐项字段不可改写，保留为可追溯历史）；同一重试标识幂等；撤回后可用新标识重新提交。
- **谁能提交**：**当前队伍成员**且在该队**最新正式收件回执成员快照**内的人（沿用申诉的成员校验口径）。队长不能替其他成员决定；正式交件前不能选择（`WORK_DISCLOSURE_NOT_PARTICIPATED`）。
- **只读投影**：只列队伍本人选择公开的队伍，且只含该队**逐项勾选**的内容（作品名称 / 简介 / 链接 / 文件元数据）；未勾选的键**整体缺失**（不是空串）。**永不包含**联系人、邮箱、答卷、求助、住宿、队伍专属反馈、评委身份与内部快照标识——它们不在投影函数的输入类型里。
- **不改结果**：与 `aggregate()` / `results/preview` / `results-export` / 公开结果投影完全无关，提交披露前后逐字段不变（`service.test.ts` 用断言固定）。写路径只有一条：`ej_work_disclosures` + 既有审计（`work_disclosure_submitted` / `work_disclosure_superseded` / `work_disclosure_withdrawn`）；只读投影不写审计。
- 接口：`service.works / publicWorks / myWorkDisclosure / submitWorkDisclosure / withdrawWorkDisclosure / eventWorkShowcase`；HTTP `GET competitions/:eventId/works`、`GET|POST competitions/:eventId/works/:teamId/disclosure`、`GET organizer/events/:eventId/judging/works`（另有可选撤回与访客公开入口，见交付文档）。迁移建议 `migrations/003-work-disclosure.sql`（由根分配递增编号后应用）。

## 文字留言（与数值互评分列，规划 34 C②）

`comments.ts` 与服务方法实现规划 34 C②：作品被队伍本人选择公开之后，能看到它的人可以留**纯文字**留言。它与数值互评（P7）**分列存放、分列展示**，**不并入**正式汇总、名次、公布或任何导出。

- **三层门禁缺一即 403**（不是空数组）：① 赛事级 `community.workShowcase`；② 赛事级 `community.peerFeedback`；③ 该作品所属队伍的**有效**披露记录且范围不是 `private`。任一不满足时读取与写入都明确拒绝，且**零行落库**。门禁与 `works()` 共用 `comments.ts` 的 `commentGate()`，没有第二套"能不能公开"的口径。
- **谁能看与留**：`participants` 档只有本场报名**已通过**的选手；`public` 档任何**已登录**账号（未登录一律 401，公开档也不例外）。与 P2 作品展示的可读范围同口径——看不到作品的人不能读也不能留言。留言作者**不出现在任何返回面**（视图只给 `isMine`），避免成为报复渠道。
- **只有文字**：长度上限取自 `eventCommunity(scope).commentMaxLength`（异常配置回退共享默认 500，绝不放宽到无界）；本批**不建评分列**、不读不写任何互评数据，也没有"有帮助"计数。提示文案写明"本次只提供文字留言""不计入名次"。
- **绝不进结果**：留言表不出现在 `aggregate()` / `results/preview` / `results-export` / 公开结果投影 / 名次 / 内部对账表里；测试对提交留言前后的 `summary`、`summaryHash`、留档导出与内部对账 CSV 做**逐字节**比较，并在删除留言行后再次比较。
- **评审隔离**：`judgeMaterials`、评委工作台、`eventWorkShowcase`（主办方）以及校准/自检/进度/公平包/重复线索都**不返回**留言正文；既有审计只记留言 ID、队伍与字数（治理说明除外），**不复制正文**。正文只在作品详情页的独立区返回。
- **治理**：**留言作者本人**或**本场 `judging_manage` 工作人员**可隐藏；隐藏后对所有人都不再返回正文（视图 `text=null`），且**同一条只能隐藏一次**（重复隐藏幂等返回原记录，不写第二次、不改版本）。任一**可见者**可举报：只记录"谁举报了哪条 + 可选说明"这一事实，**不裁决、不封禁、不改变留言状态**；同账号同留言只有一条。
- **限频**：同一账号在同一场比赛有 `commentCooldownSeconds`（30 秒）冷却，**已隐藏的留言同样计入**（不能靠隐藏绕过）；他人不受影响。
- **挂载单位**：留言挂在**队伍级作品展示单位**上，`snapshotId` 必须是该队当前正在展示（最新正式收件）的那一版；队伍重新交件后旧版本不再是入口，已写留言仍跟随该队伍的作品。
- 接口：`service.workComments / createWorkComment / hideWorkComment / reportWorkComment`；HTTP `GET|POST competitions/:eventId/works/:snapshotId/comments`、`POST .../comments/:commentId/hide`、`POST .../comments/:commentId/report`。迁移建议 `migrations/004-work-comments.sql`（由根分配递增编号后应用）。
- **工作人员探测只影响展示**：`canHide` 需要知道观看者是不是本场 `judging_manage`；真实根里 organizer 拒绝非工作人员时抛 `ORGANIZER_FORBIDDEN`（模块夹具抛 `STAFF_REQUIRED`），因此探测把**任何 403** 都按"不是工作人员"处理——它绝不能让读留言的 200 变成 403；非 403 仍照常抛出。
- 错误码：`WORK_SHOWCASE_DISABLED` / `WORK_COMMENTS_DISABLED` / `WORK_COMMENTS_NOT_DISCLOSED` / `WORK_COMMENTS_PARTICIPANTS_ONLY`（403）、`WORK_COMMENTS_RATE_LIMITED`（429）、`WORK_COMMENT_NOT_FOUND`（404）、`IDEMPOTENCY_KEY_REUSED`（409）、`IDEMPOTENCY_KEY_MISMATCH`（400）、`JUDGING_INVALID_INPUT`（422）。

## 构造与根接入

`createEventJudgingService({ database, clock, ids, events, participation, conflicts, verifiedSubmissions?, submissionLinkContext? })`。前三项来自 shared；后三个必选 Port 是公共 `HostedEventAccessPort`、`EventParticipationPort`、`EventJudgeConflictPort`。可信M06收件Port与本模块 `SubmissionLinkContextPort` 必须成对提供；阶段、完整字符串规则键和commit来自根可信适配，绝不从HTTP传入。规则键严格为`${linkedEventId}:${rulesVersion}:${confirmationRevision}`，两项版本为正安全整数，一字不改传桥，不转换数字来伪造确认。回执路径是服务端生成的相对URL，由根按可信origin转换及严格确认入口校验；不接受客户端绝对回执URL。M06公开写入口仍仅user_reported，本模块没有修改它。没有明确赛事/项目关联或可信上下文时，仍可独立正式收件，`submissionRecordId=null`，不冒充私人项目平台验证。

所有私人读写在同一事务中先后复核 `OrganizerPrincipal.guard`，工作人员额外先后复核 `judging_manage`。根提供真实账号/请求会话、Origin/CSRF、Port锁定约定与可信关联检查。`getEvent(...,{forUpdate:true})` 是跨模块锁顺序的起点；本模块写操作再锁 `ej_event_locks`，所有CAS更新检查revision。O02报名/队伍变化也须遵循相同事件锁，或提供等价锁定Port，详见交付 `NEEDS_INTERFACE`。

评委赛事入口调用 `service.listAssignedEventIds(principal:OrganizerPrincipal):Promise<string[]>`，不传eventId或userId。只查当前本人active/needs_review指派，待声明保留，recused/revoked排除；赛事ID去重、按ID升序、最多100个。同事务先后复核真实会话，并在返回前按候选集合重新读取本人仍有效指派。不读取作品/评分/材料，发现ID不授予这些读取权限。根负责HTTP入口及通过HostedEventAccessPort投影赛事名称、主办方和状态。

`createEventJudgingHandlers({ service, resolvePrincipal, authorizeMutation, requestIds })` 返回固定方法HTTP处理器，读取JSON最多64KB。前端 `client-api.ts` 自动添加 `/api/v1`。准确路由、方法参数及响应见 [交付说明](../../../docs/协作/交付/event-judging.md)。所有结果响应 no-store，GET不触发模型或采集。

`schema.sql` 仅是根增量迁移建议，含 `ej_*` 表、组织/赛事复合外键、幂等与版本唯一约束、历史不可改触发器和开轮配置冻结触发器。它只引用 `auth_users` 身份，不直接访问其他模块表。根需给迁移分配实际递增编号；不能单独打开生产PGlite。

## 界面与验证

组件共同props：`eventId,eventTitle,organizationName`；收件追加 `teamId,deadline?`；管理追加可信 `judgeOptions?`及可选 `refreshRevision?:number`；结果追加 `scope?:'public'|'mine'`。同账号同赛事的关系核查等外部操作完成后，根增加refreshRevision，只刷新workspace，保留未保存配置草稿，不用改变key重挂管理面板。根按真实账号key渲染，赛事切换前统一提示处理未保存草稿。模块内部key按赛事/队伍重挂载，失败保留输入；期限、公布范围和人工确认可见，高级文件/审计等折叠，移动端单列与44px主要按钮。

运行 `node --experimental-strip-types --test src/modules/event-judging/*.test.ts`，加入校准派生视图后本模块 58 项通过（其中 `calibration.test.ts` 7 项覆盖样本不足不校准、达标后原始分不变、单人评委不校准、分数压缩标记、无差异不校准、缺评与未进入汇总原因、同分名次）；`src/server/organizer-router-acceptance.test.ts` 5 项通过，其中真实根路由验证校准端点对本场工作人员返回 200、对评委与选手 403、匿名 401，且读取后原始汇总仍为 80 分。**加入评审进度与已公布结果导出（2026-10-16，P06）后本模块 110 项通过**，其中 `progress.test.ts` 9 项覆盖：与 `workspace`/`calibration`/`aggregate` 的口径一致且读取前后事实完全不变、无指派空态不造评委行、回避与撤销计入已排除不计入分母、权限拒绝与跨赛事轮次隔离、导出不含评委账号与内部快照 ID 且只含公开反馈、未公布/已撤回拒绝导出、需复核只出状态与版本、防公式注入、只读与审计计数。`node node_modules/typescript/bin/tsc --noEmit` 对本模块无报错。此前本人赛事入口与入口/管理刷新参数的检查仍有效。数据库测试只创建全新内存 PGlite 与受控跨模块 Port。它不代替真实PostgreSQL多连接竞态、根跨角色流程或手机外部试用。**加入作品展示（2026-10-16，规划 34 C①）后本模块 123 项通过**，新增 10 项作品展示服务验收与 3 项 HTTP 路由验收：赛事开关关闭时读取与提交都 403、开启后默认空列表、只列选择公开的队与其逐项勾选字段而他队内容一律不出现、仅参赛者/公开两档按观看者资格区分、提交披露前后 aggregate/结果预览/留档导出/本人投影逐字段不变、同重试标识幂等与取代后旧记录不可改写、撤回后立即消失且可重提、非本队成员（含后加入者）403、未交件不能选择、写既有审计而只读不写。 **加入文字留言（2026-10-16，规划 34 C②/P5）后本模块 144 项通过**（含 1 项"根抛 `ORGANIZER_FORBIDDEN` 时读取照常 200"回归；`src/server/organizer-router-acceptance.test.ts` 5/5），新增 `comments.test.ts` 8 项纯逻辑验收、10 项文字留言服务验收与 2 项 HTTP 路由验收：三层门禁缺一即 403 且零行落库、participants 档仅本场已通过报名者而 public 档含任何已登录账号、长度取自主办方配置且不存在任何评分字段或互评表、提交留言前后预览/哈希/留档导出/公开投影/工作台/评委材料逐字节不变（删除留言行后仍不变）、评委侧与主办方侧及审计都不返回正文、作者本人或工作人员可隐藏且同一条只能隐藏一次、任一可见者可举报且只记录事实、同账号同赛事限频且隐藏不能绕过、同键幂等与触发器不可改写、旧版本快照不再是入口而留言仍跟随该队伍作品。`node node_modules/typescript/bin/tsc --noEmit --incremental false` exit 0（全仓、本模块均无输出）。

AI仅预留 `JudgingSummaryPort`，输入限定当前授权正式材料及已发布规则引用，输出事实摘要和依据，没有评分或晋级字段。当前无AI调用和假摘要，人工功能不依赖DSH。真实适配须由根隔离身份/缓存/检索/队列并纳入既有预算与unknown hold。
