# DSH 赛事发现：单关键词轮换与真实作业统计交付

本轮根授权范围仅 `src/server/dsh-backend.ts`、对应测试、新 `discovery-coverage.ts/.test.ts` 与本交付文档。配置、055 迁移、API、界面、实际环境和部署由主会话接入。保留赛事发现每天 1 美元上限。

## 只读审计结论

- 常驻后端每 10 秒检查发现任务，账本最短每 5 分钟准入一轮；刷新网页不触发付费调用。原生默认 2 个关键词一轮、8 组轮换，覆盖官网、公众号和公开社交平台线索。
- 现有 `beginCycle` 同事务先预留整轮最大费用，按 UTC 日限额准入。成功且有真实 usage 时结算实际费用；搜索结果已知但 usage 缺失仍按完整预留计费。结果未知保留完整费用和持久 hold，不能通过重启、跨日或增加次数自动重发。
- 只读取本机非敏感限额与费率：原配置 48 次搜索、120 次模型、1,000,000 microUSD。原生搜索每次保守预留 317,031 microUSD，分析每次 49,152 microUSD；2 搜索＋3 分析整轮预留 781,518 microUSD。次数提升不能独立解决费用准入问题。
- 安装的 Desktop 官方 `dsh-web-search-deepseek` 0.2.0-rc.2 源码，以及本机官方 0.2.1-alpha.1 类型声明只提供 `maxTokens` 输出上限和 `maxUses` 工具次数，未找到可执行的更小输入上下文硬上限。因此没有降低 1M 输入上下文的保守费用预留。
- 已有 `.runtime/native-search-live-result.json` 历史记录有真实 usage（5275 输入、688 输出），证明原生成功不一定缺少 usage；这不是本轮实际请求，也不保证后续都有 usage。
- 单关键词＋单页把整轮预留降为 366,183 microUSD，没有缩小每次原生搜索的安全上界。若 usage 缺失，1 美元预算仍可能只支持两轮，费用不足时必须暂停。配置 5 小时目标不能保证每天真实模型工作 5 小时。

## 已实现

1. `createDiscoveryRoundWorker` 接收可选 `nativeQueriesPerCycle`。每轮从持久搜索次数与实际批大小计算位置；1 关键词使用根提供的 `defaultNativeEventQueryBatch`，16 批完整轮换原先 8 组的全部关键词；旧 2 关键词配置继续 8 组。显式自定义查询保持固定。
2. wrapper 每次作业生成独立 UUID，捕获开始和完成时间。仅非 `skipped` 且 `searched>0` 或 `fetched>0` 的报告进入统计。未知结果且没有已返回搜索/已取得页面的报告不计为成功作业。
3. 新 `createDiscoveryCoverage({database,clock,targetHours?})` 提供 `record({attemptId,startedAt,completedAt,report})` 和无参数 `summary()`。默认目标 5 小时，合法范围为整数 1–24。
4. `record` 先向 `operations_discovery_coverage_cycles` 写入唯一 `(scheduler_id,attempt_id)` 记录，再更新 `operations_discovery_coverage` 日汇总，全程同一个数据库事务。重复提交、重启、同 ID 大小写变化不会重复计数，汇总失败会回滚该轮去重标记。
5. `summary` 只执行 SELECT，默认读取服务器当前 UTC 日，不接收客户端日期，不初始化账本、不创建作业记录。跨午夜完成的轮次按开始的 UTC 日归属。
6. `dshBackend` 暴露 `coverage`；后台 `status()` 添加 `coverage` 与 `coverageRecordingError`。统计写入失败只产生固定告警 `DISCOVERY_COVERAGE_RECORD_FAILED`，不改变已经结算的 worker 报告、费用或 hold，也不会重发模型。后续成功统计可清除此内存告警。

## 界面和读取契约

`summary()` 返回 `quotaDay/targetHours/firstStartedAt/lastCompletedAt/cycles/searchCalls/fetchedPages/savedCards/activeMs/spanMs`。

- `targetHours`：配置的每日持续发现目标，仅目标。
- `cycles`：有真实返回搜索或抓取事实并已记录的作业轮数。
- `searchCalls`：报告中的已返回搜索数量，不是未知结果请求的计费次数；计费次数仍以原账本为准。
- `activeMs`：逐轮开始到完成的处理时间之和，包括必要抓取、模型响应等待等，不包括轮与轮之间的待机时间，也不是纯模型推理时间。
- `spanMs`：首次已记录轮次开始到最后已记录轮次完成的跨度，包含间隔和可能的离线，不证明连续健康运行。
- 本服务没有 `completed` 或 `targetReached` 状态。不得仅因为跨度达 5 小时显示“已持续搜索 5 小时”。心跳健康覆盖、每天固定运行窗口和预算均摊调度若需要，应由根另行实现。
- `coverageRecordingError` 是当前进程的统计告警，不是新的持久费用/权限状态。若历史作业写入遗漏，不能倒推出已完成时间。

## 验证

已执行隔离测试命令：

```powershell
node --test src/server/dsh-backend.test.ts src/server/discovery-coverage.test.ts
```

11 项通过，0 失败。使用全新内存 PGlite 与根 055 迁移，搜索/抓取为注入夹具，无真实外网与模型调用。

全项目 `tsc --noEmit --incremental false` 已通过，退出码 0。

覆盖：16 批完整轮换与重启/UTC 跨日；旧 2 关键词轮换及自定义查询；并行去重、事务回滚、读操作不写入；跨度超过 5 小时但累计处理仅 5 秒；待机/未知结果不计作业；非法时间、计数与标识被拒绝；统计失败不改变已付费成功结果或触发重发。

未在本代理执行生产迁移、构建、启停、修改真实配置或实际付费搜索。主会话负责公网/手机展示与真实持续运行观察。

## STOP

本代理代码与说明完成后交还所有本轮临时文件，停止编辑。根负责整合与真实部署验收。

## 追加：配置与后台读取验收

根追加临时授权仅 `src/server/config-discovery.test.ts` 与 `src/server/backend-dashboard.test.ts`，没有修改实现或其他文件。

- 配置验证 8 项全部通过：单关键词批次完整覆盖 16 个词并跨年更新日期；每天 144 搜索／360 模型／1,000,000 microUSD 被准确读取；拆批不降低单次保守预留；非法批大小和目标小时数提前拒绝。
- 后台验证 18 项全部通过：真实日报仅投影当前服务器 UTC 日；未配置为 null，已配置且无记录时目标默认为 5 小时、计数为零；一次授权 SELECT 与一次汇总 WITH 在同一事务读取，无写操作；跨度 5 小时但累计处理 5 秒分别返回；跨日读取不初始化账本或创建日报。
- 验证预算临界差 1 microUSD、搜索／模型次数不足显示 `limited`；未知请求持久 hold 和诊断在 UTC 跨日后保留，读操作不清除；当前人工暂停和运行中的租约优先呈现对应状态。
- 首轮后台测试发现根新增 SQL 将 text 型 `quota_day` 与已推断为 date 的 `$1` 直接比较，导致读取失败。根已改为 `$1::text`，独立内存数据库探针与全部 18 项重跑均通过。
- 追加测试后的全项目 `tsc --noEmit --incremental false` 通过，退出码 0。

仅使用全新内存 PGlite、夹具环境子进程和假数据，没有真实数据库、邮件、搜索或模型调用。追加测试完成后文件再次 STOP 交还。

## 追加：单页面槽的新赛事与旧卡轮换

本轮临时授权仅 `src/modules/operations/discovery-worker.ts`、对应测试与本交付文档，未改网络、robots、预算或账本实现。

- 原问题：`maxPagesPerCycle=1` 时，每轮固定把已存卡片放到第一位，唯一抓取/分析名额总被旧卡占用。即使 DSH 搜到了新赛事，也不能生成新卡。
- 修复：单槽付费搜索按持久 `searchCalls` 计算 `globalRound`，偶数轮优先本次搜索结果，奇数轮优先旧卡；非 `interleave` 的付费单槽同样读取持久轮次。重建 worker 对象不会重置顺序。没有搜索结果时仍可复查旧卡。
- native 优先轮将原旧卡优先项放回 supplemental；同 URL 合并保留本次真实引用，以及由已知官网 URL 重新建立的受限重定向策略。旧卡说明或历史引用不能成为本次证据。
- 两页及以上既有顺序不变。每轮仍最多一页，真实费用结算、每日 1 美元、冷却、未知请求 hold 和来源证据限制沿用原逻辑。

验证命令：

```powershell
node --test src/modules/operations/discovery-worker.test.ts src/modules/operations/discovery-existing-candidates.test.ts src/modules/operations/discovery-native-worker.test.ts
```

52 项通过，0 失败。新增真实 PGlite 场景验证两种搜索排序跨新 worker 的四轮公平性、旧卡真实版本更新、同 URL 新引用合并、无搜索结果仍回退且不复用旧摘要、官网相同赛事 www 重定向策略保留。已有多槽排序、付费费用结算及未知请求跨重启/跨日 hold 回归全部通过。测试仅使用独立数据库和注入搜索、网络、模型夹具；没有生产数据库、真实搜索、构建或服务启停。

全项目 `tsc --noEmit --incremental false` 已通过，退出码 0。

本轮实现与测试完成后 STOP，交还以上文件，主会话负责构建部署和真实新赛事观察。

## 追加：避开持久未知搜索批次

根最新临时授权仅 `src/server/dsh-backend.ts`、对应测试和本交付文档。没有迁移或修改费用/hold 账本。

- 默认查询轮换原先只读取已结算 `searchCalls`。如果当前候选请求已经 held，`claimSearch=false` 不计作实际请求，整轮预留被退回，轮换位置可能一直停在同一批。
- 新 `createNativeDiscoveryQuerySelector` 根据实际搜索 provider 的同一个 `requestIdentity`，对当前默认 16 个单词批或 8 个双词批计算与 worker 完全相同的 `SHA256(identity + '\n' + query)`。一次参数化 SELECT 读取该调度器的未知请求标记，从计数起点环选首个没有 held 成员的完整批次。
- 原生 provider 只构建一次并复用给 worker 和 selector；不改 identity、查询内容或给请求加随机盐。双词批任一成员 held 时整批跳过，保持既有两词组配置。
- 所有默认批次均 held 时明确返回 `failed / DISCOVERY_SEARCH_REQUIRES_REVIEW`，不调用 worker、不预留/结算假费用、不增加调用计数，不记录虚假的 coverage。读取标记失败同样在付费请求前返回明确失败。
- `claimSearch` 仍是实际发送前的事务护栏，预检不会代替它。旧 hold 原样保留，包括 UTC 跨日；当前日期自然形成的独立查询同样检查自身真实 hash。显式 custom 查询保持固定语义，不能静默换成默认查询。

定向验收：

```powershell
node --test src/server/dsh-backend.test.ts src/server/native-discovery.test.ts src/modules/operations/discovery-native-worker.test.ts
```

30 项通过，0 失败。新增真实 PGlite 验证：实际未知请求原费用保留；跨新 wrapper 跳过持久 held 起点；双词批任一 held 跳整批；实际 identity 精确匹配；全 held 只读、不启动 worker、日报不计假进度；SELECT 故障不发费；UTC 跨日仍保留旧 hold 并检查新日期池；custom 固定请求不绕过 hold。没有生产数据库、实际 DSH、构建或服务启停。

本轮全项目 `tsc --noEmit --incremental false` 通过，退出码 0。实现、测试和说明完成后 STOP，交还三个临时文件。
