# 主办方四模块根后端组合交付

日期：2026-10-11。临时独占文件仅 `src/server/organizer-integration.ts`、`src/server/organizer-integration.test.ts` 及本文件。未修改其他模块、application/router/app/shared/根配置/实际迁移，未打开生产数据库、加载环境变量、构建、重启或外部发布。

## 已完成

- `createOrganizerIntegration` 将 O01→O02→O03→O04 的实际持久服务和 HTTP 工厂组合到一个注入的 `DatabasePort`；O01 的有效发布/当前授权 Port 和 O02 的当前正式参与 Port 复用同一 `SqlExecutor`。
- 精确路径入口 `handle(request,decodedSegments)` 和 `match(decodedSegments)`，不在此文件注册 app 路由。覆盖 O01/O03 的固定解析器及 O02全部27个、O04全部23个 handler。实际 UI 的正式提交路径为 `POST /competitions/:eventId/submissions/submit`，已挂接。
- 每次私有服务仍使用根传入 `OrganizerPrincipal` 的当前账号/会话 guard。变更在正文读取前调用根 `assertMutationAllowed`；同一 Request 的模块重复检查不会再次执行该回调。全局流读取时间/体积上限由既有 root router 负责，模块保留自身更小正文上限。
- 服务级加强目标账号核查：组织批准、工作人员授权、负责人交接和评委指派在外层事务提交前调用根 `requireActiveTarget(sql,userId)`。其失败回滚刚写入的授权、指派、版本及审计，不以存在 FK 代替活跃且已验证邮箱的真实账号。该检查发生在模块范围授权之后，未授权调用者不能借目标检查枚举账号。
- 实际 M02 空间关联桥通过现有 `ProjectsRepository.withProject` 公共 Port 核对当前管理员、项目 revision、非归档状态、当前队长确实参加该空间，以及已显式提供的赛事关联范围。仅授权 O02 保存正式队伍→私人空间关联；不新增 ProjectMembership、不让主办方读取空间内容。预览与确认是分开的 Port，GET 不调用写确认。
- 关联桥要求 M02 Port 返回的 executor 与外层同一对象，防止私自取另一条连接读权限。跨模块锁序为当前账号/会话→组织→赛事→模块赛事行→项目，不从项目反向请求赛事。
- 评委关联核查先读取实际当前正式队伍及其实际关联空间成员，当前正式成员或空间当前/历史成员为 `conflict`，不可被可选人工 `clear` 覆盖。无法确认关联返回 `needs_review`；无已知站内关联也仍需真实受控人工核查，不能仅凭“没查到”宣称无冲突。
- M06 可信收件 Bridge 必须成对注入；未注入仍可运行赛事独立正式收件，但 `submissionRecordId:null`，不能造出私人空间 `platform_verified`。完整规则版本使用共享 Port 的字符串键，不在组合中截断或猜造。
- 评审 AI 当前没有注入与调用，`judgingAi:false`；人工评分/汇总/锁定/公布无需 AI 可用。公告未同时配置真实收件人 Port 与持久通知 outbox 时为 `unconfigured`，只代表站内发布。
- `capabilities` 明确反映注入状态，不能用这些布尔值宣称第三方投递、真实模型或公网验收成功。没有生产内存降级、额外 worker、静态 AI 成功或公共 GET 自动写库。

## 根接入签名

```ts
createOrganizerIntegration({
  database: DatabasePort,
  clock: Clock,
  ids: IdGenerator,
  requestIds?: IdGenerator,
  resolvePrincipal(request): Promise<OrganizerPrincipal | null>,
  assertMutationAllowed(request): Promise<void>,
  requireActiveTarget(sql,userId): Promise<void>,
  projectRepository?: Pick<ProjectsRepository,"withProject">,
  relationshipReviews?: EventJudgeConflictPort,
  tracks?: EventTeamTrackPort,
  notification?: EventNotificationPort,
  announcementAudience?: { listRecipientUserIds(sql,eventId): Promise<readonly string[]> },
  verifiedSubmissions?: VerifiedEventSubmissionPort,
  submissionLinkContext?: SubmissionLinkContextPort,
})
```

返回 `organizer`、`events`、`registration`、`projectLinks`、`projectLinkPreview`、`conflicts`、`communication`、`schedule`、`logistics`、`judging`、`handlers`、`capabilities`、`match`、`handle`。`handlers` 按 organizer/registration/communication/judging 分组，以模块自己的导出名称保持准确。

`handle` 接 `/api/v1` 后已经解码的完整 segment 数组；未知路径返回 `null` 交给现有根路由，已知路径的错误返回安全 ErrorEnvelope。根可在通用 request bounding 后先调用它；不要让未经流读取限制的外部 Request 跳过 root 边界。`match` 返回模块方法保护的 handler 或 `null`，供逐项根装配。无效空 segment、分隔符、控制字符或过长 segment 被拒绝。

## 已隔离验证

命令：

```powershell
node --experimental-strip-types --test src/server/organizer-integration.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

集成 **6/6通过**。测试用全新内存 PGlite、O01–O04 自有 SQL 建议及真实 M02 Postgres repository，root account/session/Origin/人工核查 Port 使用明确隔离夹具。没有读取 `.env.local`、打开已有 PGlite 目录或执行根实际迁移。

覆盖内容：

1. 两组织两赛事中报名→名单锁定→私人主办方求助→真实正式回执→`needs_review`→受控人工关系核查→本人无冲突申报→人工评分→锁定→人工公布，跨赛事/机构猜 ID 拒绝。
2. 公开目录/比赛/报名表/队伍/公告/结果 GET 没有 INSERT/UPDATE/DELETE/DDL；精确路由、405/Allow、Origin拒绝与非法路径。
3. 失活申请人不能获得批准，失活工作人员不能获得授权，失活评委指派全事务回滚；当前会话撤销后缓存 Principal 私读拒绝。
4. 真实 M02 管理员/版本复核，未授权主办方不能确认，关联不授其空间会员；实际历史空间参与者触发回避，公开招募不暴露私有项目 ID/目标。
5. 未配置项目关联/人工关系核查/M06/AI/通知/官方赛道时保留明确未接状态。
6. O02 报名撤回后其真实锁定名单资格失效，O04 使用旧预览无法正式收件，且无半笔回执留下。

全仓 TypeScript 已通过；没有编写或执行 build。内部只读 API 路由核对代理已结束，发现的 `/submissions/submit` 差异已经修正。PGlite 的单实例事务/CAS演练不代替真实 PostgreSQL 多连接死锁/竞态或生产会话的根验收。

## NEEDS_INTERFACE / 主会话剩余组合

1. **真实 Principal**：root 提供同 executor 当前 `auth_users(active,email_verified_at,platform_roles)`→当前请求 `auth_sessions(未撤销/未过期/userId)` 的前后 guard；捕获 Actor 角色必须与当前角色一致。此组合不会自行解析、记录或暴露认证令牌。
2. **活跃目标账号**：root 实现 `requireActiveTarget`，按同事务锁真实活跃且已验证邮箱的目标账号，失效抛共享 DomainError。受限邮箱/已知同事选取由根负责，不能公开全站邮箱或用户目录。
3. **人工关系核查**：root 提供有权限、事件/队伍/评委精确限定、保存事实与审计的 `relationshipReviews`。未接时指派可以保存待核查，但不能激活/读取/评分；O04 `reviewAssignment(reason)` 本身不能替代真实 Port 把未知关系改成 clear。已知正式/私人关联始终优先。
4. **M06成对桥**：可信当前 M02/M03正式规则/完整版本/commit/stage 与正式回执→现有 M06唯一提交事实映射由 root 另做，公开 `user_reported` 方法不得放宽。当前组合只传入已有公共 Port，不假造关联。
5. **官方赛道/公告 outbox**：未配置分别保持官方赛道未接/通知未配置。出入有效发布变化→官方公告桥、收件人名单与真实邮件 outbox/投递还需根接入。通知 Port 不可在未提交事务直接发邮件或模型请求。
6. **我的比赛身份**：O01 `/me/competition-identities` 仍为本人当前工作人员事实，O02 `/me/competitions` 为本人报名事实；全站评委入口需要 O04本模块明确导出的本人指派赛事列表 Port 或根受控组合，不能靠平台角色或公开目录猜测权限。
7. 根 application/router、页面、可信账号标签候选、auth returnTo、实际递增迁移/备份/构建重启、手机全链路、真实pg并发以及公网域名由主会话完成。本交付不表示已部署或域名验收成功。

## 状态与交还

后端组合与6项隔离集成已完成；根实际接入、迁移、构建/重启、真实账号/人工关系核查、生产公网及外部验收尚未完成。无新增环境变量，也未输出任何密钥值。

交付后停止编辑这三个临时文件，所有权交还主会话。

## 第二轮：主会话根控制接口的隔离验收

2026-10-11追加授权仅新增 `src/server/organizer-root-controls.test.ts` 与更新本交付；没有继续修改原组合源码或主会话控制接口。上面的 `NEEDS_INTERFACE` 是首次组合交付时状态：主会话随后实际实现了 `organizer-root-controls.ts` 的精确邮箱账号选择、append-only人工关系核查、只读核查目标和后勤参赛人选 Port；本轮验收这些**实际源码与SQL**，不复制业务逻辑或用静态回复替代。

```powershell
node --experimental-strip-types --test src/server/organizer-root-controls.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

根控制接口测试 **9/9通过**，全仓 TypeScript通过。测试使用新内存PGlite、根042–046/048迁移SQL、当前O04模块schema、真实O01/O02/O04服务与M02 Postgres repository，账号/会话/Origin使用受控夹具。没有加载`.env.local`、打开生产库、执行根`migrate`或发送邮件/模型请求。

- 精确邮箱查找仅当前赛事 `event_manage` 或 `judging_manage`，普通参赛者、仅报名管理、别赛staff、平台admin无继承；返回只有`userId/label`，不返回邮箱、私人画像、答卷或其他账号资料。失活/未验证账号不存在于选择结果。
- 匿名、跨Origin、错误method/Allow、8KB正文限制、未知字段与未匹配路径；不留下关系核查记录。
- 人工核查仅该赛 `judging_manage`；本人不能审核本人，错误队伍/旧名单revision/失活目标拒绝，当前正式队员不能`clear`。
- 真实O02名单重开改变revision后旧人工核查自动失效；新的核查只对当前revision有效，到期边界精确变回`needs_review`。
- 实际关联M02空间的当前和历史成员不能被人工`clear`覆盖；拒绝后无证据记录，主办方没有因此获得私人空间会员。
- 同毫秒先写`z-old-review:clear`、再写`a-new-review:conflict`，最新真实插入优先；主会话已将048读取改为单调`sequence`，随机ID字典序不再决定结论。UPDATE/DELETE证据均被真实SQL不可变trigger拒绝。
- `relationship-targets` GET只返回当前`teamId/title/revision`，取同队最新正式提交`version`的标题，不携带作品正文、链接、评委、私人空间资料；没有数据变更或初始化。
- 最后一次当前会话guard失败时，已INSERT的关系证据整笔回滚；会话撤销后不能复用账号选择或关系核查。
- `logistics-participants` GET仅 `logistics_manage`，只含本场approved且当前active/verified账号的`userId/label`；排除草稿报名、另赛人员、失活/未验证账号，不显示邮箱/画像/答卷，不写库。

只读审查提出了“同毫秒随机ID顺序”和“核查目标显示旧作品标题”两项问题，主会话负责源码修复；本轮测试对修复后的真实实现保留回归。没有改写主会话源码来让测试通过。实际应用路由/会话适配、生产迁移、真实PostgreSQL多连接、手机及公网仍以主会话最终验收记录为准。

本轮测试和本交付已停止编辑并交还；不延续旧授权。

## 第三轮：持久公告邮件与主办方入选通知

2026-10-11主会话追加授权仅新 `src/server/organizer-notifications.ts`、`.test.ts`、`organizer-notifications-schema.sql` 及本交付。不修改 application/router/worker/模块/公共契约/真实迁移/配置，不加载环境或现有数据库，不发送真实邮件，不构建或重启。

### 已完成

- `createOrganizerNotifications` 返回真实 `EventNotificationPort.notification`、`announcementAudience`、模板/发布/本人列表/主办方列表服务、精确HTTP `handle`、有界 `drain` 与只读 `counts`。收件人目录由真实O02 `listApprovedUserIds`读取并筛选当前active且verified账号；公告源由真实O03 `getNotificationAnnouncement`核对精确当前公开版本。不会直接读取O02/O03私有表。
- 公告发布事务内只保存公告/版本/收件人引用与不可变排队事实，唯一赛事/源版本/收件人。邮箱和邮件正文不进入outbox或错误日志，不在GET/模板预览内发送。未注入真实transport及from时明确 `unconfigured`，不把开发邮箱记录当真实发送。
- 一条入选通知对应本场本人已approved的报名ID/revision；当前主办方 `registration_manage`、本人当前账号/session、目标active/verified与报名版本均在同事务复核。站内正文为当时真实称呼/赛事/机构替换后的不可变快照，邮件未配置仍可查看。
- 模板subject/body纯文本，只支持 `{name}`、`{event}`、`{organizer}`。有限 `accent:orange|blue|green|slate` 与 `theme:simple|letter`；没有任意HTML/CSS/模型解释执行。邮件HTML由代码escape所有动态文字，配色均服务器常量；同时发送纯文本。
- 首发 `expectedNoticeVersion:0`幂等。模板修改后重放首发不能冒充新内容；再次发布需 `confirmNewVersion:true`、准确 `expectedNoticeVersion` 与 `newOperationKey`。同操作标识/模板版本/前置通知版本才重放，换key不会绕过当前版本核对。不可变历史有SQL trigger。
- worker每批1–10条：读取候选→组织/赛事锁优先→领取lease→另事务复核当前组织批准、exact公告版本或入选报名revision、发布者当下对应职能、收件资格与账号→持久提交sending→真实transport。网络调用期间没有持有数据库事务。当前资格/职能撤回将未发项取消。
- 仅transport接受请求记录 `accepted`，没有 `delivered` 或“收件人已收到”。异常/超时统一 `unknown_hold`；过期sending同样hold，不自动重试，重启/跨日/新worker不重放。未进入sending的过期lease可以重新领取。配置消失时暂停待发项，仍保守处理过期sending。状态统计只读，有queued/accepted/held/failed/cancelled/sending。

### 根接入签名与路由

```ts
createOrganizerNotifications({
 database, clock, ids,
 getEvents(): HostedEventAccessPort,
 getRegistration(): {
  getRegistration(sql,eventId,userId): Promise<EventRegistrationSnapshot|null>,
  listApprovedUserIds(sql,eventId): Promise<readonly string[]>,
 },
 getCommunication(): {
  getNotificationAnnouncement(sql,{eventId,announcementId,revision}): Promise<{
   id,eventId,organizationId,revision,title,body,important,publishedAt,updatedBy,
   publisherCapability?: 'event_manage'|'communication_manage',
  }|null>,
 },
 resolvePrincipal(request): Promise<OrganizerPrincipal|null>,
 assertMutationAllowed(request): Promise<void>,
 transport?: {send({from,to,subject,text,html?},{signal}):Promise<void>},
 from?: string, origin?: string, timeoutMs?: number, leaseMs?: number,
})
```

循环组合通过getter解决：先创建本适配，给根integration注入 `notification` / `announcementAudience`，getter后续读取真实integration的events/registration/communication。transport只由root配置真实供应商闭包，SMTP凭据不会进入模型或新模块；`from`为现有真实发件人，`origin`为本站固定origin（不用请求Host）。默认超时10秒、lease60秒；worker是root现有后台任务的一项，不能另进程并行打开本机嵌入式目录。

| 路径 | 方法/权限 | 参数与结果 |
| --- | --- | --- |
| `/organizer/events/:eventId/selection-notice-template` | GET，当前registration_manage | 模板及 `{preview:{subject,body}}`；未保存revision0说明默认预览 |
| 同上 | PUT，当前registration_manage+Origin | `{expectedRevision,subject,body,accent,theme}`；返回已保存模板与预览 |
| `/organizer/events/:eventId/selection-notices?recipientUserId=...` | GET，当前registration_manage | 当前实际approved行，`{items:最多5条当前报名revision的通知,recipient:{userId,label},registrationRevision}`，不含邮箱/答卷/个人画像 |
| `/organizer/events/:eventId/selection-notices` | POST，当前registration_manage+Origin | `{recipientUserId,expectedRegistrationRevision,templateRevision,expectedNoticeVersion,confirmNewVersion?,newOperationKey?}`；返回SelectionNotice |
| `/competitions/:eventId/selection-notices` | GET，当前本人账号/session | `{items:最多100条本人通知,registrationStatus,registrationRevision}`；其他query中的userId不会改变本人范围 |

`SelectionNotice` 精确字段：`id,eventId,registrationId,registrationRevision,version,templateRevision,subject,body,accent,theme,publishedAt,mailState`。`mailState`为 `unconfigured|queued|leased|sending|accepted|unknown_hold|failed|cancelled`。UI应把旧报名版本/已撤回或拒绝后的入选通知标为历史，始终以当前实际报名状态为准；`accepted`可称“邮件服务已接受”，不能称“邮件已送达”。GET不初始化模板/账本、不发送。请求读取上限64KiB，错误消息不回显供应商正文/邮箱/密钥。

### 已验证与真实边界

```powershell
node --experimental-strip-types --test src/server/organizer-notifications.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

隔离测试 **17/17通过**，全仓TypeScript通过。使用全新内存PGlite执行实际根042/043/044 schema与本轮SQL建议、真实O01/O02/O03服务；transport全部mock。覆盖：同事务公告排队/重复/跨赛事拒绝、真实收件资格与未配置状态、最终guard失败全回滚、职能/Origin/当前session、模板有限输入与CAS、报名审核与版本、显式新版及幂等、GET最小投影/无写无发送、安全HTML、发布者撤权/报名撤回/组织暂停、超时未知防重放、lease/send恢复边界、并行worker唯一领取、领取后发送前撤权复核、批次上限与流式JSON上限、占位词展开后32K正文上限。未访问持久目录或实际邮件供应商；PGlite并行演练不替代真实PostgreSQL多连接验收。

### NEEDS_INTERFACE / 尚未接入

1. root复制SQL建议为新递增051（或当时最新编号），完成备份/真实迁移，再接application/router/既有worker/后台状态与O05前端。SQL建议存在不表示生产已应用。
2. root真实账号/session guard与统一Origin检查仍由root注入；新适配只在root身份层读取auth_users的当前active/verified、邮箱、称呼和角色，不提供公开邮箱目录。
3. O03可信getter需精确区分普通communication_manage公告和根event_manage规则变更消息，不能通过客户端前缀给普通公告赋予另一职能的发送许可。已发现服务器保留规则ID后续普通编辑可能误标权限的边界，向root提交准确proof，由root修O03，未越界修改。
4. 不提供投递webhook、无限重试或unknown_hold一键重发。当前hold/accepted表示真实边界。需要新入选通知只能显式核对并确认新版本；模板/邮件服务接入不表示已完成QQ/Resend真实投递或手机/公网验收。

本轮无新增必填环境变量名，复用root既有邮件transport/from与本站origin。独立只读安全审查未发现可确认的重大问题，未运行数据库/构建/网络或修改文件；审查代理已停止。所有源码/测试/SQL建议/本交付已停止并交还主会话。**STOP**；真实051迁移、application/router/后台任务/O05接入由主会话继续。

## 第四轮：主办方自己的发信账号

2026-10-11追加授权只新 `src/server/organizer-mail-accounts.ts`、`.test.ts`、`organizer-mail-accounts-schema.sql` 和本交付。未修改上一轮通知源码、application/shared/实际迁移/配置。主会话负责通知按组织优先选择sender、网站fallback、O01公共Port、实际053迁移和UI。

### 已完成与接口

```ts
createOrganizerMailAccounts({
 database, clock, ids,
 encryptionKey: Uint8Array, // 严格32字节，root用稳定codePepper派生独立用途key
 requireOrganizationManager(sql,actor,organizationId): Promise<{id,status}>,
 getOrganization(sql,organizationId): Promise<{id,status}|null>,
 resolvePrincipal(request): Promise<OrganizerPrincipal|null>,
 assertMutationAllowed(request): Promise<void>,
 verifyCredentials(config,{signal}): Promise<boolean>, // actual nodemailer.verify()===true
 createSmtpMailTransport(config): TransactionalEmailTransportPort,
 verificationTimeoutMs?: number, // 默认9秒，最多15秒
})
```

SMTP `config`精确字段 `{host,port:465,secure:true,user,password}`。只允许固定QQ/163/126/Gmail的官方SMTPhost；客户端输入不允许host/port/TLS/replyTo字段。[Google官方说明](https://support.google.com/mail/answer/185833)要求应用专用密码且账号需支持此功能。[Outlook官方说明](https://support.microsoft.com/en-gb/outlook/pop-imap-and-smtp-settings-for-outlook-com)要求Modern Auth/OAuth2，本轮没有相应OAuth接入，因此没有伪造Outlook密码登录支持。

`requireOrganizationManager`复用实际O01公共方法，不能用单赛事event_manage/registration_manage或平台admin替代机构管理员身份；当前组织必须approved。root的getOrganization最小投影来自已公开O01 repository，模块不读取organizer私表来复制权限。

| 路径 | 方法 | 输入/返回 |
| --- | --- | --- |
| `/organizer/organizations/:id/mail-account` | GET | 当前机构管理员可读取安全metadata及profiles；不查询credential，不写库或网络验证 |
| 同上 | PUT+Origin | `{expectedRevision,provider:'qq'|'163'|'126'|'gmail',email,authorizationCode}`；成功返回已验证metadata |
| 同上`/disable` | POST+Origin | `{expectedRevision}`；保留revision墓碑，清除现存密文，返回disabled metadata |

返回metadata精确为 `{organizationId,revision,state:'unconfigured'|'verified'|'disabled',provider:null|id,maskedEmail:null|string,verifiedAt:null|ISO,updatedAt:null|ISO,profiles:[{id,label,note}]}`。默认未配置revision0，无数据库初始化。页面显示maskedEmail（如p***@qq.com），输入框邮箱/授权码不从服务器复回；没有完整邮箱、plaintext凭据、ciphertext、SMTP供应商错误详情或服务器密钥。

### 持久化、验证和发送边界

- 邮箱与授权码一起AES-256-GCM加密，随机96-bit IV和128-bit tag，AAD绑定用途、机构、设置revision、provider与masked身份。数据库只保存masked metadata和当前密文；审计不可变且不存凭据。停用后当前密文清除，历史审计只保留事实metadata，不长期保留旧授权码。
- 保存分成第一次当前principal/approved机构管理员/设置revision事务→真实SMTP登录验证（无数据库事务）→记录实际attempt结果→第二次权限/revision事务。只有`verifyCredentials(...)===true`才保存；false或异常/超时不给“验证成功”，旧可用账号保持原样。最终guard失败时新密文和设置审计整笔回滚，已经发生的验证attempt事实不删除。
- `organizer_mail_verification_attempts`持久机构/actor/attemptID/time/state：至少60秒一次，UTC日最多10次，重启或并行请求不能绕过。异常/超时记录unknown_hold，明确false记录failed；遗留verifying照样占次数；没有后台自动重试，不记录完整邮箱、授权码或供应商错误。限频返回429与明确下一次时间。
- `getSender(sql,organizationId):Promise<{from,transport}|null>`只给可信后台消费；当前组织非approved、未配置/disabled返回null，root可选网站fallback。密文损坏/错误密钥抛安全503，不能静默改用网站邮箱掩盖问题。SMTP登录user与From始终是解密的同一邮箱。
- 返回的transport.send再复核当前组织approved、设置verified和相同revision，改号/停用/机构暂停后缓存的旧sender不能继续发；From不匹配或请求已abort拒绝。provider原始send错误包装为安全未确认错误，root保持unknown_hold，不能称已送达。发送前检查与SMTP调用之间的短时撤权竞态需要根实际环境验证，已发出的请求无法追回。
- `countConfigured():Promise<number>`只读当前verified且机构approved的数量，不查密文、不返回机构邮箱目录；通过公开组织Port逐项核对，最多5000机构一次，有界超出明确503，不返回截断的错误数字。root管理员后台可用此值判断组织sender是否配置。
- 请求正文按流严格限制16KiB，全部 mutation需要root Origin与当前账号/session双重guard。没有测试发信按钮，没有给模型发送SMTP凭据，没有运行真实SMTP登录或发送。

### 根接入与环境

root按独立用途从现有稳定 `AUTH_CODE_PEPPER`/codePepper派生32-byte key并注入；保持迁移/备份时的key一致，换key后旧密文不可读。不能使用客户端输入key，也不能在交付或日志输出派生值。没有新增必填环境变量。本模块不导入root SMTP私有实现，仅由root注入实际createSmtpMailTransport与verifyCredentials；verify实现须固定profilehost、TLS证书校验、关闭debug/logger，使用signal超时并关闭连接，绝不sendMail。

根通知每次准备当前组织邮件时读取getSender，优先使用本组织账号；返回null才采用明示网站fallback。必须沿用既有已提交sending→transport→accepted/unknown_hold队列，不在PUT配置或GET时发送公告。平台登录验证码仍由root认证邮件服务负责，本模块只配置组织赛事通知的sender。

### 已验证与交还

```powershell
node --experimental-strip-types --test src/server/organizer-mail-accounts.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

隔离测试**16/16通过**，全仓TypeScript通过。测试用全新内存PGlite、实际根042 schema和本SQL建议、真实O01公共权限Port；SMTPverify/send全部mock。覆盖：匿名/跨机构/普通staff/平台admin/未批准组织、GET无写且不取credential、固定profile/SSRF输入拒绝、真实加密与最小回传、验证失败保留旧配置、验证期间会话或grant撤销、网络外事务与并发CAS、停用墓碑与inflight保存失效、跨机构/版本密文绑定与损坏拒绝、缓存sender改号/停用/暂停失效、持久60秒/10UTC日限频与未知attempt、最终guard回滚、Origin/method/16KiB/角色变化、只读脱敏configured数量、provider错误不泄漏。初次一个夹具遗漏O01 grant的eventId:null导致校验失败，已修夹具，未改业务源码绕过权限。独立只读审查未发现可确认的重大问题，未写文件或调用真实网络，审查代理已停止。

真实053迁移、root notification/application/router/background/页面接入以及实际各供应商SMTP登录、发信接受、手机/公网验收尚由主会话完成。本轮不表示任何主办方邮箱已经配置成功或邮件已送达。

**STOP**：本轮三个新server文件和本交付已停止编辑并交还主会话，不延续以前授权。
