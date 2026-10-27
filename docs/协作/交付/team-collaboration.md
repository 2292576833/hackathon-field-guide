# R02 团队任务与动态交付

状态：R02授权范围已完成，2026-10-09已交付并停止编辑，所有授权文件交还主会话。仅修改 team-collaboration 模块、team-task-board 两文件及本文；未修改M05服务或根代码。后续根组合/迁移/网站启动与整体验收由主会话执行。

## 已完成

- 草案任务词条池：所有词条保留负责人、未生效说明与管理员核对入口；本人领取/退回、管理员分配/转交走M05端点。当前生效任务不借领取改归属；详情按需展开、真实等待与可并行、检查通过才高亮。必做成果齐只在当前计划依据有效时提示，仍需运行/正式提交。
- 团队动态：M05只读进度与当前有效共享建议合并；待讨论/采纳分开、本人CAS编辑/撤回、当前管理员采纳。编辑已采纳内容回待讨论；撤回/失效不返回旧正文，也不再进模型。
- 通用分享预览：导航回答、空间助手、选题报告或人工备注；选择片段、编辑、预览、明确发送。来源服务器校验，私人完整原文不存入团队卡。再次分享可重新选片段。
- 同事务权限/来源复核、持久版本与审计、CAS、带内容指纹的幂等回执。未知写入保留原请求与key；草案切换/任务不显示时仍保留任务板顶部恢复入口，来源变墓碑时隐藏正文但保留只为恢复回执的隐藏请求；账号/空间撤权清除输入与请求。
- visible轮询10秒、隐藏暂停，最近读取与失败状态明确；375px布局/44px操作、键盘焦点、减少动效。服务端index与客户端ui分别导出。

文件：types.ts/ports.ts/repository.ts/service.ts/postgres.ts/http.ts/index.ts、TeamFeed.tsx/ShareSuggestionPreview.tsx/collaboration.module.css/ui.ts、README、模块SQL建议、service/postgres/http测试与testing夹具，以及授权的team-task-board两文件。

## NEEDS_INTERFACE

公开类型见 `src/modules/team-collaboration/types.ts` 与 `ports.ts`。已导出 `TeamCollaborationService`、`PostgresTeamCollaborationRepository`、`createTeamCollaborationHandlers`，UI 从 `ui.ts` 导出（避免服务端 index 导出 TSX）。构造依赖 `{repository,access,sources,activities,clock,ids}`；Postgres repository 构造传 `DatabasePort`。

- `TeamCollaborationAccessPort.lockAccess(projectId, actor, transaction): Promise<{membership:ProjectMembershipAccess,readOnly:boolean}>`：根在同一 SQL executor 中复核请求会话、账号、项目归档/只读及活跃 M02 成员，锁定到事务结束。调用前后都会复核；必须重用已有根 executor，不能新开独立事务。manager 以 M02 membership.role 为准。
- `TeamShareSourcePort.verifySource({projectId,actor,ownerUserId,source:{sourceKind:'navigator'|'space_assistant'|'feasibility'|'manual',sourceId:string|null}},transaction): Promise<VerifiedShareSource|null>`：返回服务器 label/revision/kind/ID；发布者只能是 actor 本人，读取时 ownerUserId 是已经保存的作者，不是请求输入。根核对真实保存回答/报告、作者、project 范围、成功模型结果、撤回和当前可共享权限，并锁定来源直到提交。只返回元数据，不返回私人全文。人工卡只允许 manual/null，标签固定“成员备注”。无效来源返回 null，团队读取不返回旧正文。
- `TeamTaskActivityPort.readActivities(projectId,actor,transaction,limit): Promise<readonly TaskActivity[]>`：授权的 M05 进度投影，字段 `id/taskId/title/actorUserId/occurredAt/status/note/evidenceRefs/checked`；kind 固定 task，checked 仅当前真实检查记录成立时为 true。R02 合并排序，不写 M05 状态。
- 服务签名：`listFeed(actor,projectId,{limit?})`、`listSharedContext(actor,projectId,{limit?})`、`publish(actor,projectId,PublishSuggestionCommand)`、`edit(actor,projectId,id,EditSuggestionCommand)`、`withdraw(actor,projectId,id,SuggestionActionCommand)`、`adopt(actor,projectId,id,SuggestionActionCommand)`。写返回无正文的 `SuggestionReceipt`，CAS 与持久幂等；actor 由根会话取得。
- 根 HTTP 建议：GET/POST `/projects/:id/team-feed`；PATCH `/projects/:id/team-feed/:suggestionId`；POST 同路径 `/withdraw`、`/adopt`。根解析 Idempotency-Key，响应 SuccessEnvelope；所有返回 no-store。
- M05 根提供 GET `/projects/:id/task-pool`，返回 `{plan:{id,status,revision,reason,createdAt,basePlanVersionId,baseTasksRevision}|null,tasks:PlanningTask[],inputVersionsChanged:boolean}`；POST `/projects/:id/plan-versions/:planId/tasks/:taskId/claim`、`/release`、`/assign`；body `expectedRevision`（草案）、`expectedTaskRevision`、`idempotencyKey`，assign 额外 `ownerMembershipId:string|null` 仅经理；返回 PlanVersion。草案领取保留负责人，后续管理员重新校验确认，不自动开始。
- UI 保持 `TeamTaskBoard({detail,current,onSnapshot})`；`TeamFeed({projectId,currentUserId,authorLabels?,reloadToken?})`；`ShareSuggestionPreview({projectId,sourceKind,sourceId,initialTitle?,initialBody,onShared?})`，onShared 接收 SuggestionReceipt。来源沿用根统一 kind，与模块 types 一致。
- handler 工厂传 `{service,resolveActor,authorizeMutation,requestIds}`，导出 listFeed/publish/edit/withdraw/adopt，handler 参数 `(request,{projectId,suggestionId?})`；解析严格字段和32KiB流式上限，Idempotency-Key可来自头或正文，两处不一致拒绝。根仍负责绑定路径与当前会话锁定。

行为例：本人空间AI回答 → 编辑片段 → 预览 → POST。SourcePort拒绝他人回答；成员可读有效卡，只有本人可编辑/撤回，管理员采纳；撤回后只返回元数据墓碑，模型上下文完全排除。旧版本操作返回409，未知响应重试同一key可恢复，不重复发布。

## 验证与边界

服务/持久化/HTTP 36项隔离测试已通过：30项服务规则、4项隔离内存PGlite schema/SQL回滚与只读锁顺序测试、2项HTTP边界测试。既有M05 task-board/task-guidance 15项回归已通过，交付前最后一次全局`tsc --noEmit --incremental false`已通过。本会话未应用SQL建议、未运行实际迁移；根路由/实际数据库/完整网站由主会话组合验收。本模块不调用模型、邮件或GitHub，不安装依赖/build/start/真实迁移。

模拟浏览器：独立内存Edge + mock fetch，TeamFeed/ShareSuggestionPreview通过375px无横向溢出/44px按钮、实际检查高亮、CAS输入保留、unknown编辑/采纳/撤回同key恢复、来源失效墓碑撤回、来源失效后旧正文隐藏仍恢复回执、登录/空间权限失效清输入；DOM选区+selectionchange→编辑→预览（0 POST）→明确POST→unknown原key恢复、成功后收起再开恢复原回答/默认标题。无实际网站服务/生产请求。

任务板6项隔离Edge +真React/组件/CSS、内存假API验证通过：claim未知响应在草案生效/池消失后同body/key重放；检查未知响应在done被“与我有关”隐藏后同body/key重放；inputVersionsChanged不报阶段齐；可见10秒轮询/隐藏停止/显示即读取；账号切换后旧pending POST的403不清新视图；403清任务/进度/池/恢复UI。375px无横向溢出，无浏览器runtime错误。内层Panel按projectId:userId:membershipId隔离，卸载回调和撤权迟到请求不保留。

视觉适当检查：输入边界对白4.44:1、次按钮边界对暖白3.90:1、主按钮白字5.91:1；操作44px，清楚文字配检查高亮，不依赖颜色单独判断。

未验收：真实页面根接入与路由/数据库贯通、真正多连接PostgreSQL并发、实体手机长按选区与有界面浏览器键盘选区、真实模型/邮件/GitHub/主办方提交。headless已安装Edge收到Shift+方向键事件但未移动readonly textarea原文选区，故只报告DOM选区处理通过，不能声称真实键盘选择通过。模拟界面不等同于实际网站验收。

环境变量：模块不直接读取环境变量；根沿用`DATABASE_URL`或既有本机单例PGlite设置，DSH等由主会话统一组合。未配置不能以测试夹具作真实存储或AI来源。

Postgres已分出`readTransaction`：读取不初始化/锁feed写头，不锁建议行；先走当前M02/source guard，写服务仍在修改前获取同M02锁，从而保护读取且避免空间AI上下文已锁project再等feed、feed读取反等project的反序。只读adapter拒绝insert/replace/putReceipt。内存仓储仅测试可回退串行事务，不能作为实际存储。

### 根组合复核提示（不修改根文件）

- `src/server/team-mission.ts` activities 当前读取历史 ProgressUpdate 的 `item.status==='done' && item.acceptance`。Port契约的 checked 指“当前仍有效的实际检查”：更正检查后旧done动态不能仍作为当前任务亮起。根应比对当前任务status/acceptance与该历史记录（或明确改动态文案为“当时检查通过”，避免当成当前完成），更正请求本身不改变检查事实。
- SourcePort读取跨空间导航来源时，除了锁原消息/会话，也需以同executor对原始`projects_project_membership`的作者成员记录`FOR SHARE`并验证active直到提交；只调用不锁行的getMembership不能保护读后被撤权。无需按任意顺序新增第二个project独占锁，避免交叉来源项目的新死锁。当前请求会话仍由authenticatedResponse前后复核保护。根助手上下文回读有效共享列表也需沿用当前请求guard。
- 根上下文 `readShared` 的 authorUserId/body/discussion|adopted/sourceKind/sourceRevision 字段已见主会话修正；R02未修改根文件。
