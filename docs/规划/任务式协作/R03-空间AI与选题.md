# R03 空间 AI 与选题

依据规划19与宪法v1.10.0。只负责新 `src/modules/team-assistant/` 与 `docs/协作/交付/team-assistant.md`，不得修改导航员/root/app/shared/实际迁移。

每个账号每个空间独立私有对话，保留现有站内导航员。通过根MemoryPort继承本人导航历史/个人记忆，完整历史留存，每次选择有界相关记录；本人身份和其他项目来源访问权限由根复核，私人对话不自动共享。通过ContextPort读当前目标/官方要求/已共享职责/本人实际任务/依赖/团队有效建议，说明上下文依据与未提供部分。

给可执行下一步、要找的队友、交付/检查与合法站内工具入口；无需重复聊天说职责。请求明确发起，固定DSH，不工具执行、不自动重新分工或发布。私有对话服务注入根预算模型运行Port，参考现有PersonalWorkspace防未知重复与final guard，不自己绕过ledger。公开模型/运行状态由根提供。

选题检查提供结构化私有报告：规则适配、最小演示、技术待验证点、能力时间、风险、验证任务；区分已知/待验证，不保证真实API、资格或获奖。通过根PersonalAiPort（新增kind project_feasibility）生成保存，其他队友只能读主动分享的摘录。主题/规则/计划/共享输入改变时阻止旧结果当当前事实。

导出model/service/ports、SQL建议、README/测试、前端私有助手组件（独立入口，能查看/提问/清空本空间对话）、选题检查组件（预览、请求、保存报告、共享回调）。通用分享由R02组件承担，通过回调传sourceId/sourceType/片段。

API建议：GET/DELETE `/projects/:id/assistant/conversation`、POST `/projects/:id/assistant/messages`、GET `/projects/:id/assistant/context`、POST `/projects/:id/feasibility-reports`，GET本人报告列表。来源/输入是数据而非执行指令，链接白名单，模型信息缺口明确。测试私有跨账号/空间隔离、记忆继承、权限/资料变更、未知状态防重发和报告不自动采用；不要真实模型请求或服务重启。
