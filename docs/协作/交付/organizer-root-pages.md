# 主办方与正式赛事根页面交付

日期：2026-10-11。主会话临时授权根页面组合代理，仅新增本文件、`src/components/competition-workspace.tsx` / `.module.css`、主办方/正式赛事/评审页面及指定的两个辅助页面。未修改 SiteShell、router、application、共享契约、模块代码、真实迁移、配置或依赖；未构建、重启、打开实际数据库或操作外部服务。

## 已完成

- 20 个 Next App Router 页面组合既有 O01–O04 UI，模块组件没有嵌套 SiteShell；每个页面只由根组合包一层网站布局。
- 正式赛事目录明确主办方发布，与 DSH 搜索线索提供相互入口。登录用户可看真实本人报名记录；另有实际评委指派入口。
- 比赛当前名称、主办方、当前视图身份、切换入口与重要作品截止常驻页面顶部。参赛模块按已发布公开投影开启，工作人员按本人真实能力列表筛选管理入口。
- 比赛概览的下一步来自本人报名、审核和本场队伍事实。报名草稿、等待审核、需补充、组队、名单锁定和正式收件分别说明，不从浏览或进入页面推断完成。
- 报名、队伍、求助、行程、现场服务、作品提交和结果接现有真实模块 UI/API。未登录保持目的地；不自动报名、加入队伍或提交。失败有重试和可执行返回入口。
- 非队长只读本队实际收件回执；当前队长只有名单锁定、资格有效、未到截止且比赛仍开放时才显示正式提交表单，避免填完才被权限或期限拒绝。
- 公开访客可读实际官方通知和 FAQ。O03 目前只允许报名通过的选手发求助，根按真实报名状态展示可写模块，其他身份看到公开答复与报名入口。
- 当前账号和赛事 ID 给私人组件分开 React key；私有身份/关联读取失败直接停下对应视图，不以公开数据替代私有失败，也不把另一赛事草稿转投。
- 工作人员/评委按精确已验证邮箱查询当前赛事可选账号，无公开用户目录。现场服务读取最小本场名册供 O03 账号选择，不要求工作人员自行寻找 UUID。
- 人工评委关系复核表单读取当前队伍 revision，保留失败输入；保存后以 `refreshRevision` 重读评审数据，保留下方评审配置草稿，不重挂整个 JudgingManager。
- 主办方官方赛道折叠表单按一行一个正式名称、是否必选配置，无 JSON。稳定同名 ID，原位置更名明确展示“旧名 → 新名、已有选择保留”的保存影响，新 ID 用 `track-UUID`。失败和版本冲突不覆盖本地输入，核对新版本后再保存。跨赛事切换分别保留本页赛道草稿，隐藏其他赛事表单，离开前提示未保存输入。
- 暖白/橙红样式，导航可换行、按钮和输入至少 44px、清楚键盘焦点；手机主要动作无需横向滚动。

## 文件与路由

根组件：`src/components/competition-workspace.tsx`、`src/components/competition-workspace.module.css`。

| 页面 | 对应 UI |
| --- | --- |
| `/organizers` | OrganizerEntry |
| `/organizers/workspace` | OrganizerWorkspace；真实选择回调后显示官方赛道/账号查询 |
| `/organizers/workspace/[eventId]/registration` | RegistrationManager |
| `/organizers/workspace/[eventId]/teams` | RosterTeamManager |
| `/organizers/workspace/[eventId]/communication` | CommunicationManager |
| `/organizers/workspace/[eventId]/schedule` | ScheduleManager |
| `/organizers/workspace/[eventId]/services` | LogisticsManager + 最小名册 |
| `/organizers/workspace/[eventId]/judging` | JudgingManager + 关系核查 |
| `/competitions` | CompetitionDirectory + 本人报名列表 |
| `/competitions/[eventId]` | 真实下一步 + CompetitionOverview + 官方通知 |
| `/competitions/[eventId]/register` | RegistrationPanel |
| `/competitions/[eventId]/teams` | RosterTeamsPanel |
| `/competitions/[eventId]/help` | 本人允许范围沟通 / 公开通知 FAQ |
| `/competitions/[eventId]/schedule` | EventSchedulePanel |
| `/competitions/[eventId]/services` | OwnEventServices |
| `/competitions/[eventId]/submit` | 当前队长正式提交 / 当前成员只读回执 |
| `/competitions/[eventId]/results` | 本人允许范围结果；访客公开投影 |
| `/judging/[eventId]` | JudgeWorkspace；本人指派先读取，空/撤权有说明 |
| `/admin/organizers` | 当前平台 admin 确认后 AdminOrganizationReview |
| `/me/competitions` | MyCompetitions + 当前账号正式评委入口 |

所有路由页面文件在对应 `src/app/` 目录，动态 params 按现有 Next 基线使用 Promise 并 await。不存在原文件覆盖；指定 admin 页面开始时确认不存在。

## 根接口登记与接入情况

模块已有公开 UI/API 按各自交付使用；额外根接口均已经由主会话确认实现并提供准确形状：

| 接口 / 契约 | 本页面使用 |
| --- | --- |
| O01 `onEventSelected?(HostedEvent|null)` | `useCallback` 读取当前真实赛事，加载/失败时清当前查询上下文 |
| O04 `JudgingManager.refreshRevision?:number` | 关系核查后只读刷新，保留配置草稿 |
| POST `/organizer/events/:id/account-lookup` `{email}` → `{userId,label}` | 当前赛事工作人员/评委选项 |
| GET `/organizer/events/:id/logistics-participants` → `{items:{userId,label}[]}` | 现场安排本人选择 |
| GET `/organizer/events/:id/judging/relationship-targets` → `{items:{teamId,title,revision}[]}` | 精确当前队伍版本 |
| POST `/organizer/events/:id/judging/relationship-review` `{teamId,judgeUserId,status,note,expectedTeamRevision}` | 非本人工作人员实际关系复核 |
| GET/PUT `/organizer/events/:id/tracks` | `{configured,required,revision,options}`；PUT `{expectedRevision,required,options}` |
| GET `/me/judging-competitions` → `{items:{eventId,title,organizationName,status}[]}` | 明确本场评委工作入口 |

根 auth returnTo 白名单、公共 GET 缓存/会话失效监听边界、网站导航入口、数据库和服务组合仍由主会话独占执行。本代理未自行创建后端端点或给予用户权限。

## 验证

- 定向 TypeScript 通过：20 个新页面、根组合及其真实模块递归依赖，使用 `tsc --noEmit --incremental false`，没有修改全站配置或写 tsbuild 缓存。
- 11 个受控 SSR 情景通过：访客概览/目的地、未登录组队、当前账号队伍组件、非队长只读回执、队长锁定后表单、未锁定无表单、限沟通工作人员入口、拒绝其他管理模块、私有权限失败不回退、未启用作品模块、本人评委入口。
- 5 个实际赛道 helper 情景通过：同名重排保留 ID、原位置更名保留 ID、前插新项不占用已有同名 ID、末尾新增不改变旧选项、不修改原输入且 ID 符合根约束；另断言评审刷新不重挂 Manager。
- SSR 使用受控 `useApi` 与模块 UI stub，没有网络/数据库/真实浏览器；赛道 helper 从实际源代码提取后运行，不复制实现。这些检查不能证明实际授权锁、后台路由、真实赛事操作或实体手机通过。
- 未运行全站 build、真实迁移、网站重启、公网 TLS 或实际手机验收。根统一完成最终跨角色浏览器/服务联调。

## 已知边界 / NEEDS_INTERFACE

无新增阻塞公共接口，以上已与主会话确认。当前人工服务本轮边界仍适用：求助仅本场报名通过选手可写；附件是已托管链接及说明，未做根受控上传；真实主办方和 PostgreSQL 多连接验收另列。

主办方内部选择器已有保存/保留/放弃逻辑；赛道表单另外按事件保留本页草稿。新增外部切赛事 URL 链接不得绕过离开提示，尤其不能用 query 变化悄悄携带旧私有输入。根验收应覆盖浏览器前进/后退和 query 切换，实际 URL 导航行为不由静态 SSR 冒充。

本组件不读取环境变量，不输出密钥，不调用模型或发邮件，站内显示不能冒充邮件投递或评审成功。

**交付并停止点：2026-10-11，已停止编辑并交还所有上述临时文件给主会话。主会话可开始全量类型检查、隔离构建和实际联调；本代理不继续改文件。**

## 后续补充：主办方报名分享与准确下一步

2026-10-11 主会话重新临时授权本代理仅修改根组合组件、其 CSS 和本交付说明；未重开 app 页面、O01–O04 模块、server/shared 或公共文档的编辑权限。追加授权包含 `OwnProgress` 的真实报名时间与官方安排判断。

- 工作台选定真实赛事后，顶部显眼显示“报名链接”。草稿提示先配置并发布报名表，再预览并正式发布赛事，不伪称保存等于公开报名。
- 独立只读 GET `/competitions/:id/registration-form` 取得当前正式 `event` 与实际已发布报名表。分享状态、日期、模块、审核规则及容量只取该响应，不用 O01 未发布草稿字段。读失败或赛事/机构不匹配时不提供报名邀请，给出重试。
- 只有正式 `published` 且网站报名开启，才生成当前页面 `window.location.origin` 下的 `/competitions/:id/register` 只读链接；未从用户字段或配置文本拼 origin。结束、归档或关闭模块不显示复制输入。
- 缺报名表、尚未开放、已截止、满额或时间待确认时准确说明；尚未发布报名表明确“先发布报名表，再对外开放报名”。可分享的非开放页面标为“报名信息与记录页链接”，复制按钮为“复制查看链接”，不称可提交报名。
- 文案明确可复制到微信、公众号、小红书等平台，选手通过链接回本站报名，主办方在本站集中处理。公开浏览无需邀请，正式提交需注册/登录；人工审核按实际 `reviewRequired` 显示，关闭审核不声称等待人工审核。
- 按真实 `registration_manage` 能力显示“查看报名与审核”，另有“查看报名页”或“查看报名信息与记录”、“刷新报名状态”。不添加社交自动发布、二维码或新依赖。
- 复制成功显示状态反馈；浏览器拒绝或没有剪贴板 API 时选中只读输入并明确长按/右键手动复制。链接在浏览器 effect 中生成，SSR 不读取 window。刷新报名状态不会重挂 Manager 或覆盖赛道草稿。
- 概览下一步读取当前正式报名 scope/form：尚未开始、已截止、缺表、满额的未报名者只看说明，避免诱导登录后提交失败；已提交待审核、通过、撤回、未通过及草稿保留相应记录入口。已通过且关闭组队时转向官方行程/通知。机构暂停时不读取私人报名，不邀请新报名。
- 原赛道离开提示与稳定 `JudgingManager.refreshRevision` 接法保留。此次仍未构建、重启、迁移或读写真实数据库。

验证：定向 TypeScript 通过；23 项受控检查通过，覆盖正式日期边界、未发布/关闭/结束状态、草稿与正式规则分离、缺表、容量、权限失败/错赛事拒绝分享、真实审核配置、访客/本人截止判断、待审核与撤回记录、单人赛事安排、机构暂停、只用当前 origin，以及剪贴板成功/拒绝/缺失时的回退。检查执行实际源代码 helper、受控 SSR 与 React/浏览器对象夹具，没有真实浏览器、API 或数据库操作；真实剪贴板权限、手机与根服务联调仍由主会话验收。

**本轮补充交还：2026-10-11，已停止编辑以上三个文件，交还主会话进行根构建与真实浏览器验收。入选通知 UI 是后续新任务，需另行明确授权，不沿用本轮权限覆盖模块。**
