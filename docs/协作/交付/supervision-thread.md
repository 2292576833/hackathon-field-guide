# 团队AI护航 · 交付

2026-10-12，本轮仅新 `src/modules/team-supervision/**` 与本说明；旧画布文件已STOP交还，不再编辑。

状态：**STOP，完成本模块及接入审阅补充，重新停止编辑，文件交还主会话。** 没有构建、重启、真实迁移、安装依赖或访问生产数据库，也没有调用实际DSH。

## 已完成

- 新模块包含model/ports、纯派生规则、PostgreSQL持久适配、服务、HTTP工厂、可注入客户端、透明紧凑组件/CSS、index/ui公共导出、README、SQL建议及服务/浏览器测试。
- 默认关闭，明确开启使用CAS并绑定当前成员身份。职责未确认、计划草案/缺失/过期、归档或离队不自动发模型；重新加入不能继承旧成员的开启授权。
- GET不初始化设置、不调用assistant.conversation、不收费、不清hold。每次检查先复核授权事实；读原私人对话状态后，事务内再次复核并锁本人设置/认领；原send在事务外执行，原调用guard与最终保存再次检查会话、成员、职责、计划、偏好版本、事实指纹及认领期限。
- 同一事实只尝试一次；账号+空间至少10分钟、最多24次/UTC日，所有认领尝试计数。UTC日按00:00Z至24小时后统计；稳定排序不受对象/任务排列影响。原空间助手的DSH、预算、私人导航记忆与保存继续使用，不提供替代模型或静态回复。
- 请求ID基于账号、成员、空间、事实SHA256。未知/超时持久hold覆盖账号+空间，换事实、关闭再开启、成员重新加入、跨日、重启或清空原对话均不能自动重发。running回执不回收重放，过期只读派生hold，迟到回复不能解除暂停；没有清hold API。
- 原私人对话running暂停、unknown持久hold。已知未发送/拒绝/收到结果的失败保留失败回执，同一事实不自动重试，也不会显示已分析完成。内部结算只更新本模块原认领回执；权限失效不保存或返回旧正文。
- 校验真实结果provider及message.provider为dsh、assistant角色、requestId和有效正文，复用原空间对话的messageId。本模块保存受限正文投影供只读显示；版本变化、计划失效或职责未确认时标待核对。没有自动共享、改分工/计划、完成任务或接受成果。
- 规则提示纯派生真实阻塞、待有效检查、有效前置成果后的可开始和时间风险；done但没有有效检查仍为待检查，记录未更新不推断没工作。规则提示与provider:dsh结果明确区分。
- 紧凑UI使用注入client：首次/刷新/重新可见仅GET；可见30秒tick对明确开启且符合条件的状态POST。隐藏及归档停止；running/hold只读核查，网络结果不明先GET；账号/空间切换清旧显示。读取失败保留上次记录并标待核对，设置和原AI入口收进小菜单。

## 验证

1. `node --experimental-strip-types --test src/modules/team-supervision/service.test.ts src/modules/team-supervision/ui.test.ts`：接入审阅补充后最终20项全部通过。
   - 19项服务/规则/HTTP测试使用真实独立内存PGlite schema，验证GET零写入/零助手调用、CAS竞争、职责/计划、并发唯一认领、跨用户/空间隔离、10分钟和24次/UTC日、同事实一次、版本过时、未知跨重启/换事实/跨日/重新入队保留、原助手running/unknown、离队/归档、迟到结果、已知失败、请求中关闭/变更、会话guard、派生检查事实、确定性ID及HTTP严格字段。新增4项覆盖认领CAS零行回滚、冷却CAS与hold零行、结算零行/旧设置版本/unknown不可覆盖、助手运行途中已标unknown后的晚回复拒绝成功结算。
   - 1项本机Edge headless隔离组件测试实际加载本模块TSX/CSS和真实React，注入API夹具并控制30秒tick/页面可见性。验证启动GET、明确开启才允许POST、隐藏/归档停止、恢复可见只GET、hold只读、读失败标上次记录、账号切换及375px无整页横溢。没有启动开发站点或写测试产物。
2. 模块独立类型检查通过：对team-supervision所有TS/TSX与next-env.d.ts运行noEmit/strict/ES2022/bundler/react-jsx、allowImportingTsExtensions、esModuleInterop、skipLibCheck；未写增量缓存。
3. 首次交付的全量 `tsc --noEmit --incremental false` 当时被根正在组合的两处错误阻塞，未越界修改：
   - `src/server/space-collaboration.ts:27`：document-drafts authorize期望Promise<void>，根直接传了返回access对象的方法。
   - `src/server/space-collaboration.ts:32`：根调用spaceDocuments.edit，实际类型公共方法名为update。
   当次输出没有team-supervision类型错误。本次接入审阅只重跑模块独立类型检查且通过；按根要求没有修根文件或重复全量编译，上述错误是首次交付记录，不断言它们仍存在。

## 接入审阅补充与最终schema

2026-10-12根要求核对claimRun、hold、finish的rowCount/CAS，已完成：

- claimRun插入唯一回执后，last_started_at更新必须匹配账号/项目/当前成员、设置revision、开启状态、无hold及10分钟冷却，实际rowCount必须为1；不匹配抛SUPERVISION_CLAIM_CONFLICT，同事务回滚回执，不调用助手。唯一回执冲突的0行只表示未认领，不是成功。
- hold使用RETURNING核对实际rowCount=1；设置行不存在抛SUPERVISION_HOLD_CONFLICT。已有hold使用COALESCE保留，不用后来的requestId覆盖。
- finish统一先锁设置行再更新请求行，减少认领/hold/结算间锁顺序冲突。成功还必须匹配原设置revision、当前成员、enabled、无hold和有效认领期限；状态只能从running转出。实际rowCount不是1时抛SUPERVISION_SETTLEMENT_CONFLICT，不假报结算成功。
- 已经unknown的回执不能被晚成功、晚失败或重复unknown结算改写；服务层竞争测试确认返回冲突、仍为hold、没有报告正文且新事实不会重发。
- **schema最终确定，SQL建议本轮未修改DDL**：仍为team_supervision_settings、team_supervision_runs及recent索引；本次补核只增强事务/CAS逻辑，根无需因此变更已准备的表结构。`schema.sql` SHA256：`D4D719DF87BE68879A7526D32C5B15B839C1DE60D1FF1C23DB7435B12D8B55B4`。真实迁移仍由根执行。

## 模拟与未验证

真实内存PostgreSQL存储/事务已验证；权限事实Port、原assistant.conversation/send及DSH回应均为注入夹具，未消耗真实模型调用。本模块测试不替代根真实成员/职责/计划Port、原助手账本、现有模型预算、实际接口/迁移和跨角色组合验收。PGlite不替代远程多连接PostgreSQL并发验收。

375px视口和控制可见性/tick不是实体触屏或30秒实际等待实测。实际DSH建议质量、生产保存、实体手机、构建、服务切换由主会话另验收，不推定通过。

## NEEDS_INTERFACE：根接入

契约先于实现写入 `model.ts` 与 `ports.ts`；现已交付。根文件已出现对应组合，但本会话没有把该组合当作实际迁移或运行验收通过。

- 注入 `SupervisionFactsPort.authorize(sql, actor, projectId, write, guard)`：复核真实账号/会话、活跃ProjectMembership及项目；write拒绝归档，按根正常锁顺序读取/锁定事实。
- 同executor注入 `readFacts(sql, actor, projectId, guard)` 返回 `SupervisionFacts`：projectId/projectName/archived、membershipId/userId/membershipStatus、responsibility {confirmed,version,summary}、plan {id,version,status:active|missing|draft|stale}、semantic version、tasks。tasks字段见model：id/title/status/ownerMembershipId/reviewerMembershipId/dependencyTaskIds/accepted/blocker/deadlineAt/scheduledFinishAt。accepted必须从有效检查事实派生，不能仅依据status=done。
- 根用真实记录计算semantic version，纳入目标/范围/规则/成员/分工/任务与检查关键版本，排除读取时间。本人职责未确认或计划过期应明确返回，不能用草案冒充执行计划。
- 注入原 `assistant.conversation/send` 的结构子集 `SupervisionAssistantPort`，原服务继续负责DSH、预算、私人导航记忆、上下文权限与保存；不得提供静态或通用HTTP降级。
- 已提供 `createTeamSupervisionService` 的 `get/settings/check` 及 `createTeamSupervisionHandlers`。建议根路径：GET `/projects/:id/team-supervision`，PUT同路径（CAS设置），POST `/projects/:id/team-supervision/check`。GET不初始化设置、不调用assistant.conversation、不收费、不清hold。POST只接受空JSON对象，不接受客户端事实、指纹或身份。HTTP工厂还需根注入真实actor、mutation授权、freshSessionGuard与requestIds。
- `ui.ts` 导出 `TeamSupervisionPanel`，props为projectId/accountKey/archived、可注入 `SupervisionApiClient` 和onOpenAssistant；根放入空间常驻入口或现有紧凑区域。
- `schema.sql` 只为建议，实际递增迁移由根执行。无需新增环境变量；沿用原空间助手DSH及预算配置。

未知结果保留账号+项目级hold，不因换事实、关闭再开启、成员再加入、清空原助手对话或重启解除；模块没有清hold API。根最终整合与实际DSH/实体手机验收另记。

新增环境变量：无。**STOP：不再修改本轮目录或交付说明，由主会话接回。**
