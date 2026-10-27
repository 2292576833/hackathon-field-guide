# PPT · 交付说明

## 已完成

- 新 `src/modules/ppt/`：公开 `index.ts`、数据契约、生成服务、严格输入/输出校验、原创模板、官网工具卡、Markdown/HTML 导出、README、Node 测试与模块内迁移建议。
- 原创三套逐页模板：3 分钟 Demo（5 页）、5 分钟产品（7 页）、5 分钟技术 Agent（7 页）；每页写作/讲述/避坑/视觉提示，合计含演示 180/300/300 秒。
- `createPptService({ai, profiles?})` 只调用 root 注入的 `PersonalAiPort`，绑定输入快照、校验每页要点及精确合计时长、保守拒绝虚构结果与数字、不自动重发或用静态模板假装 AI。
- 当前真实路演 `RoadshowDocument={input,script}` 已适配：`completedCapabilities` 为用户自报已完成、`facts` 为用户资料，`planned=[]`；`pendingValidation/assumptions` 只在原始 owner 来源上下文，不冒充已规划功能。模板和时长来自当前表单。来源 ID 必须经 `ai.get(actor,id,guard)`。
- 页面组件 `PptClient`、独立样式 `ppt.module.css`：公开手动框架、登录后 DSH、忙/空/加载/错态、本账号历史恢复、本人路演继承、逐页本地编辑、Markdown 和 HTML 预览导出；本地编辑不称服务器保存，`.md`/HTML 不称 `.pptx`。
- 官网卡片经实际浏览核验：PowerPoint、Google Slides、Canva、Gamma；不作价格/免费/许可承诺。
- 真实失败后的修复：`personal-ppt-copy-v2` 将固定页数、时长、页码、事实要点与演示页交由服务器，模型只返回逐页标题/建议/视觉/备注及演示建议；完整字段与长度规则已明确在提示和 README。模型文案依然必须实际生成，原事实和数字校验不放宽，最终 schemaVersion=1 与旧历史兼容。PPT 页面区分已完成/待实现/用户依据标签。

## NEEDS_INTERFACE / 主会话组合

1. 工厂：`createPptService({ ai: application.personalWorkspace, profiles?: participantProfileService })`，对外服务方法：
   - `generate(actor:Actor, input:unknown, guard?:FreshSessionGuard):Promise<PersonalArtifact<PptOutline>>`。
   - `list(actor,guard?):Promise<PersonalArtifact[]>`（本人 `kind=ppt`）。
   - `get(actor,id,guard?):Promise<PersonalArtifact<PptOutline>>`（本人 getter，类型/大纲复核）。
   - `profiles?.get(actor,guard?):Promise<ParticipantProfile>`；若启用，仅取项目想法/演讲经验，并检查返回 `userId` 与 Actor 一致。
2. 根页面 `/ppt` 导入并呈现 `PptClient`（已经按此名导出），路由及导航由 root 所有。
3. `POST /api/v1/me/ppt/outlines`：root `principal(request)` 获取 Actor 和事务内 fresh-session guard，执行 `application.ppt.generate(current.actor, await request.json(), current.guard)`。必须使用现有变更来源检查及请求体限制，返回现有 `{data,requestId}`/错误 envelope。
4. 复用已存在的 `GET /me/artifacts?kind=ppt`、`GET /me/artifacts/:id`、`GET /me/artifacts?kind=roadshow`，全部 root owner-scoped personalWorkspace。列表不从客户端接受 owner，获取记录前后由 root Port 校验当前身份；页面接收历史时检查记录类型、`provider=dsh` 和数据。
5. 输入示例：`{templateId:'demo-3',durationMinutes:3,projectIdea:'任务列表',targetUsers:'新人',completed:['本地列表已完成'],planned:['待实现同步'],evidence:['用户提供测试记录']}`。路演继承可仅提交 `{templateId:'demo-3',durationMinutes:3,artifactId:'本人路演ID'}`，root getter 失败即禁止生成；浏览器不传已保存路演正文。
6. 模块建议 SQL 不含新 DDL；实际持久化复用 root `021_personal_dsh_workspaces.sql`。不得建立内存唯一存储或第二份 PPT 表。无需新增环境变量。

## 已验证 / 模拟测试

- `node --experimental-strip-types --test src/modules/ppt/ppt.test.ts src/modules/ppt/templates.test.ts`：23 项通过（测试替身，非真实 DSH）；包含结构与长度、UTF-8 总字节、事实引用、虚构指标、精确合计、概念演示、guard 透传、本账号继承、真实 RoadshowDocument 字段、未知结果不重发、资料隔离、历史类型、导出转义、三套模板时间、全部模板在时长上下限的模型 JSON 示例兼容。新增45个模板×1–15分钟组合、601/2000字想法与1000字用户说明、缺字段/错类型/超长/伪造固定常量、原事实检查回归、安全路径诊断、付费前完整示例预检与旧历史兼容。
- 四个工具的官方产品页于 2026-10-09 实际浏览核验，来源保留在 `tools.ts` 与 README。
- `npm run typecheck -- --incremental false`：全局通过。仅检查，不修改其他模块。

## 未接入 / 真实验收边界

- 本模块任务不编辑 root 路由、应用组合、实际迁移、配置或依赖，不启动/重启服务器，不开启真实数据库。
- 本轮只读核对已见 root 应用创建 `ppt` 服务、路由绑定 `POST /me/ppt/outlines` 与 `/ppt` 页面；这属于代码组合证据，未执行真实请求验收。
- root 已报告真实 v1 DSH 生成返回 `PPT_OUTPUT_INVALID`。本模块复现了一处长事实与示例长度矛盾，但未获得该响应，不能认定它是该次失败唯一原因。v2 真实请求尚待 root 验收，不能以本轮替身通过声称真正生成已成功；仍未执行持久化重启恢复、真实双账号/失效会话、浏览器手机及打印视觉验收。
- 主会话下一轮诊断可读取错误 `recoveryAction` 的固定 `PPT_SCHEMA` 路径；不会含模型原文、输入或密钥。新提示版本 `personal-ppt-copy-v2`，不能清除既有未知 hold 或在读取/刷新中重放。
- 本地逐页编辑只影响当前显示和下载；不提供新持久化编辑 API。刷新可从服务器恢复原生成记录，未下载的本地修改不会成为服务器记录。
- 事实检查是保守语法与引用约束，不是完整语义证明或用户数据独立核验。HTML 打印保留文字，过长页可能分纸，应先精简内容。
- 输出为 Markdown 大纲和 HTML 幻灯片预览；没有安装 PPTX 库，也不承诺工具导入后的排版保真。

## Constitution Check

- 参赛价值：新人可按已完成/待实现范围构建逐页表达与演示节奏。
- 真实性：原创框架与真实 DSH 分开；时间计算为服务端规则，用户陈述标明来源，未知保持待验证。
- 私密性：所有私人访问只走 root 账号 Port，fresh guard 透传；浏览器 ID 不代表读取权限。
- 可恢复性：生成记录采用 root 持久化，未知不重发；本地修改与服务器记录区分。
- 成本：不从页面读取或模板下载触发付费调用；真实模型、预算、未知 hold 由 root 专属服务负责。
- 外部边界：官网只核验产品功能；不购买、发布、发送消息或连接第三方账号。
