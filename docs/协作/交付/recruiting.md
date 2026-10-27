# R01 参赛名片与招募交付

状态：2026-10-09 模块交付完成并停止编辑，全部文件交还主会话。仅修改 `src/modules/recruiting/` 与本文件；没有安装依赖、构建/启动/重启、生产迁移、生产PGlite或真实付费模型/邮件调用。

## 已完成

- 私人主要/辅助职责、参赛目的及补充、简历、作品链接、选填MBTI/年龄与本地头像，读取既有ParticipantProfile且不改原画像事实。
- 独立公开快照、本人与资料/头像/发布revision校验、明确发布和撤回、公开职责/目的/文本筛选、非公开默认、失活账号过滤。MBTI/年龄/系统字段不参与检索，昵称及正文邮箱不能公开。
- DSH名片请求使用本人已保存事实与语义requestIdentity；真实输出须校验，前后资料/画像/头像/请求会话复核。预览可编辑，敏感选填字段默认不公开，不自动发布；无模型/未知结果不假成功、不自动重发。
- 活跃空间管理员明确填写招募帖、关闭/撤回与CAS；申请人提交/撤回/重新申请，管理员批准/拒绝和说明；批准占用明确名额但不自动加入，申请人明确加入时同事务调用M02 Port，只授member，已使用申请不在退出后重入。
- 模块SQL建议、不可变历史、服务/index/README、HTTP工厂/路由映射、三个可组合客户端组件和真实API客户端。头像本体512KB、2048×2048，PNG/JPEG/静态WebP，格式/结构/真实像素解码；公开图片独立复制、当前发布状态/revision复核，撤回后旧图不可读。
- 根助手上下文纯SELECT接口`readPrivateProfile`，不创建资料行，不返回年龄/MBTI/图片。

## 已验证（隔离/模拟）

- 最终 `node --experimental-strip-types --test src/modules/recruiting/handlers.test.ts src/modules/recruiting/service.test.ts src/modules/recruiting/validation.test.ts`：48项通过，0失败。含32项服务子测试、9项校验、6项HTTP与服务测试父项。
- 最终 `node node_modules/typescript/bin/tsc --noEmit --incremental false`：完整工作区通过（不写tsbuild缓存）。
- 独立内存PGlite执行本模块SQL，证明参数化查询、CAS、发布隔离、头像复制/撤回、申请/批准/名额、明确加入、防重复、撤权与同事务回滚；模拟Port复核调用使用同一个executor。
- HTTP覆盖全部建议路由、方法限制、登录/fresh guard/CSRF传播、415/400/413/405、安全错误返回、图片no-store/nosniff/sandbox、公开GET无模型调用。
- 三种真实有效小图片都实际完整解码通过；伪造WebP头、损坏PNG压缩像素、SVG/外链/超限/类型不符/尾部附加内容被拒。测试不代表处理用户生产图片。
- UI代理完成8组隔离API客户端检查及三个组件静态渲染检查；暖白/橙红、44px主要操作、键盘focus、减少动效、错误保留输入、登录失效清除私人响应。未进行本模块真实浏览器交互验收。

## UI exports

从`src/modules/recruiting/ui.ts`导入（不通过服务index加载客户端）：

- `RecruitingProfileEditor({client?,initialView?:RecruitingProfileView,loginHref?,onPublished?})`；ProfileView包含服务器`displayName`用于发布前昵称预览。
- `RecruitingLobby({client?,signedIn?,loginHref?,profileHref?,onJoined?})`；默认公共读取，可注入真实登录状态。
- `RecruitingPostManager({projectId,isAdministrator,client?,onChanged?})`。
- `createRecruitingClient({baseUrl?:string,fetch?:typeof fetch})`，默认`/api/v1`；`RecruitingClient`/组件Props导出。

## NEEDS_INTERFACE

准确类型以 `src/modules/recruiting/ports.ts` 为准，所有 SQL Port 必须复用调用方传入的 `SqlExecutor`；身份 → 项目/成员 → 本模块记录的锁顺序，不能另开连接。

- `RecruitingIdentityPort.requireActive(sql, actor): Promise<{ displayName: string }>`：以`FOR SHARE`锁定活跃且邮箱已验证账号（不能用`FOR UPDATE`），返回服务器身份显示名；失活/无账号报401。`isActive(sql,userId): Promise<boolean>`：公开列表/头像必须过滤失活账号，同样用`FOR SHARE`。
- `RecruitingParticipantPort.readOwn(sql,actor): Promise<ParticipantProfile>`：仅本人既有参赛画像，保留原字段和 revision；读取并锁定当前版本，以便发布/AI前后版本复核。
- `RecruitingProjectsPort.inspect(sql,projectId,userId): Promise<RecruitingProjectState|null>`：返回 `{projectId,archived,membership:{membershipId,role:"manager"|"member",status:"active"|"left"|"removed"}|null}`，先`FOR UPDATE`锁项目再`FOR SHARE`成员事实；批量读取按projectId稳定排序。公共查询允许无会员读最小状态，不返回私人名称/目标/规则。
- `RecruitingProjectsPort.joinApproved(sql,{actor,projectId,approvedBy,applicationId}): Promise<{membershipId,role:"member",status:"active"}>`：根组合M02，同事务复核申请人、批准者仍是活跃管理员、项目非归档，只授member；加入失败必须回滚申请，不能创建第二份成员事实。
- `ai: PersonalAiPort`（直接注入共享接口），使用根已扩展的`kind: "profile_summary"`。`recruitingSummaryRequest(profile,participant)`提供系统约束、服务端校验和真实本人已保存资料`requestIdentity`；根复用持久DSH/预算/未知结果hold，仅用户明确生成动作触发。profile仅传revision/职责/目的/简历/作品；头像、MBTI、年龄不进入模型。模块生成前后复核会话和本人资料版本，模型结果只预览，不自动保存/发布。
- 每个私有服务方法最后一个参数为已有 `FreshSessionGuard = (sql) => Promise<void>`，HTTP根必须传入当前请求会话复核，不能只信请求开始的Actor。

例如：Bob申请→管理员Alice审核approve（不产生membership）→Bob明确join→同事务根M02返回member事实→申请记录joined。Alice退出或空间归档后join必须失败。

服务现已可接入：`createRecruitingService({database,identity,participant,projects,ai,clock,ids})`；准确方法均在`service.ts`的返回对象。HTTP可直接组合`createRecruitingHttpHandlers({service,resolveSession,authorizeMutation})`，`resolveSession(request)`必须返回已核验`{actor,guard:FreshSessionGuard}`或null。`recruitingHttpRoute(pathAfterApiV1)`识别所有建议路由，不修改根app文件。UI从独立`ui.ts`导入，避免客户端引用服务端。

根助手上下文用`service.readPrivateProfile(actor: Actor, guard?: FreshSessionGuard): Promise<PrivateRecruitingContext|null>`。纯SELECT，缺失返回null、不创建初始资料行；仅userId/revision/primaryRoles/supportingRoles/purposes/purposeNote/resume/workLinks/updatedAt，无MBTI/年龄/头像，前后复核当前账号/请求会话。不是公开接口。

## 根接入与未验收边界

主会话已通知服务/路由代码正在接入，账号页/大厅/空间招募由根页面组合。本模块未检验根实际迁移、API根会话适配、身份/画像/项目Port、DSH预算与M02邀请/加入的真实应用结果；模块内SQL仅建议，不代表生产已应用。实际数据库迁移/备份、生产构建与trace、375px/桌面完整浏览器流程、真实DSH输出质量、远程PostgreSQL多连接并发和公众试用由主会话统一验收。内存PGlite的并行Promise测试不等价于多连接PostgreSQL并发。

本模块不新增环境变量，复用根已配置的`AI_PROVIDER`（该自由名片路径仍固定DSH）、`DSH_DESKTOP_DIRECTORY`或根DSH账号/API配置，以及`DATABASE_URL`或根本机PGlite单例；没有写入任何值。无外部招募/邮件/聊天发送，不虚构公开人数或模型质量。

头像真实解码使用本机已安装的Next.js依赖`sharp`（未安装/修改根依赖）。根请确认生产打包包含sharp；模块在保存时实际解码，拒绝伪造文件头/坏图，公开固定MIME/nosniff/no-store。测试PNG需使用真实有效CRC/压缩数据。
