# 团队AI协作护航

本模块只处理本人的护航偏好、自动调用回执和规则提示。它不拥有成员、职责、计划、任务完成或交接状态。

根注入 `SupervisionFactsPort`、`DatabasePort`、`Clock` 和原 `teamAssistant.conversation/send`。读取现有授权事实的SQL由根提供；本模块只查询 `team_supervision_settings/runs`。`schema.sql` 是迁移建议，不能独立打开生产库或执行真实迁移。

`get` 是只读：默认返回revision0/关闭，不初始化设置或助手、不清hold、不收费。`settings` 是本人明确的CAS操作，绑定当前membership；重新加入后不能继承旧成员的开启授权。`check` 仅由POST调用：先核对本人职责和当前生效计划，再读取原私人对话状态；事务内复核、锁定本人设置并认领唯一事实，事务外调用原预算内DSH，原调用guard与最终事务均再次复核。

同一事实只自动尝试一次（包括已知失败），每账号每空间至少10分钟、24次/UTC日，所有已认领尝试计数。指纹包含根语义版本、本人职责、计划、任务/有效检查和时间风险跨阈值，排除读取时间；稳定排序避免任务或JSONB字段排序误触发。请求ID由账号、成员、项目和事实SHA256生成。原助手预算和未知请求账本继续生效，不存在第二套模型或降级回复。

未知/超时持久hold覆盖账号+空间，而非单个事实；新事实、关闭再开启、新成员身份、跨日或重启均不能重发。原助手running暂停，unknown持久hold。崩溃留下running回执，不回收重发；过期后只读派生hold，迟到回复不能解除暂停。没有清hold或清对话API；核查入口指向原空间AI。权限撤回后内部仅结算原认领回执，不保存或向用户返回旧正文。

认领回执和last_started_at在同一事务提交；更新必须匹配当前成员、设置revision、enabled、无hold及10分钟冷却条件，零行会报错并回滚回执。结算按“设置行→请求行”加锁，成功还须匹配设置revision、成员和未过期认领；所有结算仅允许running转出，hold/finish均核对实际rowCount。零行不视为结算成功，unknown、failed或succeeded回执不会被晚到的重复结算覆盖，已有hold使用COALESCE保留最初核查入口。

真实回复继续保存在原私人空间对话。本模块保存同一messageId及受限正文投影供只读显示，provider固定校验为dsh；事实版本变更、计划失效或职责未确认时旧建议标待核对。共享到团队须走原助手由本人明确选择，护航不自动共享、改职责/计划、接受成果或完成任务。

规则提示只派生真实阻塞、等待有效检查、前置成果已检查后可开始及记录时间风险。没有更新不能推断未工作，done缺有效检查仍为待检查。规则提示与provider:dsh结果使用不同文案。

组件从 `ui.ts` 导出 `TeamSupervisionPanel`，props为projectId、accountKey、archived、可注入client及onOpenAssistant。首次/刷新/重新可见读取GET；30秒可见tick才对明确开启、符合条件的状态POST检查。隐藏/归档停止；running/hold只读核查，网络结果不明先GET。读取失败保留上次记录并标待核对，账号/空间变化清旧显示。

HTTP工厂需注入真实会话actor、CSRF/同源mutation授权、freshSessionGuard和requestIds；建议GET/PUT `/projects/:id/team-supervision`，POST `/projects/:id/team-supervision/check`。PUT仅接受enabled与expectedRevision，POST仅接受空JSON对象，不接收客户端事实/指纹/用户身份。

环境变量：无新增。沿用原空间AI的DSH与预算配置。隔离测试使用真实内存PGlite和注入假助手，不调用实际模型，不替代多连接PostgreSQL、根权限接入、生产发布或实体触屏验收。
