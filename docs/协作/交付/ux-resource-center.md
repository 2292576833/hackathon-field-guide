# U04 · 资源中心与新手教程交付

日期：2026-10-09。依据宪法 v1.4.0、`docs/规划/13-体验优先与协作整合.md`、U04 规划及本轮临时授权。沿用首轮资源场景入口和教程链接白名单，没有新建应用、重复顶部菜单或改动赛事/规则/项目线索。

## 已完成

- `/resources` 用四个任务入口解释工具、灵感、AI 技能与新手教程；GitHub 仍可直接访问。工具用途筛选在主操作区，阶段/栈/费用保留更多条件。来源分别标示为人工审核外部资料、DSH 官网分析与本站原创说明。
- 工具详情、登录返回、浏览器历史、上一页/下一页/返回第一页保留受控筛选、排序、每页数量和分页位置。空目录与无匹配结果分别给下一步，不填造资源。
- shadcn/ui、Radix、Ant Design、Awwwards 的同站身份和官网主地址由纯映射连接；审核详情可跳到既有灵感搜索（待分析项也可匹配）。原资源 ID、产品名、审核版本和产品文档 URL 保留；Radix Primitives 的许可不会扩大成 Radix 全站许可。撤回或阻断外链时不提供绕行同站入口。
- 私人收藏按现有 API 继续读取分页，第 51/101 条也可查到；目标齐全可提前停止，末页之前不推断未收藏。读取错误/非前进 cursor/身份错配/中止不会产生伪造未收藏结果。页面按当前账号和目标资源绑定私人请求，拒绝旧响应，保留已挂载编辑器的草稿及反馈。
- 资源分享使用“分享到团队空间”的页面名称，仍引用现有参赛项目、权限和 `ProjectResourceBookmark`。本人显式选择空间及确认后才分享；私人收藏不会自动共享，归档项目不出现在新的分享选项中。
- 教程接入既有分类/关键词 API，详情和返回保留筛选；安全站内下一步可见，无效链接给替代说明。GitHub 两篇保留原创摘要与补充正文，主要操作统一跳 `/github`。
- AI 技能以当前工具和具体任务为主筛选，作品方向及关键词按需展开；资源包说明它是通用作品分类，不是比赛官方赛道。固定版本深链、来源、许可、前置条件、兼容声明和精确清单仍可核对；未知固定版本不静默替换为可安装的其他版本。
- 技能的工具筛选实际限制到该工具已声明的已发布固定版本；预览、确认、桥接授权复核对应声明。命令复制、文件写入、客户端加载、示例验证分别显示，路径/格式声明不会显示为客户端实测成功。
- 技能安装器及本人历史按可信账号 ID 挂载；账号变更会卸载旧计划、短期执行 token、配对口令和回执并重读当前身份。页面恢复焦点/可见时复核身份，创建、确认及本机安装/验证/撤销前再次检查当前账号；返回计划检查 `plan.userId`。

## 修改文件

组件：

- `src/components/resource-hub.tsx`
- `src/components/discovery-client.tsx`（仅资源组合、私人读取及资源辅助部分；赛事/规则逻辑未修改）
- `src/components/library-client.tsx`
- `src/components/skills-client.tsx`

资源模块：

- `src/modules/resources/components.tsx`
- `src/modules/resources/components.module.css`
- `src/modules/resources/README.md`
- `src/modules/resources/index.ts`
- `src/modules/resources/navigation.ts`、`navigation.test.ts`
- `src/modules/resources/bookmark-lookup.ts`、`bookmark-lookup.test.ts`
- `src/modules/resources/site-identity.ts`、`site-identity.test.ts`
- `src/modules/resources/tutorial-links.ts`、`tutorial-links.test.ts`

技能模块：

- `src/modules/skills/catalog-view.ts`
- `src/modules/skills/catalog-view.test.ts`
- `src/modules/skills/service.ts`
- `src/modules/skills/skills.test.ts`
- `src/modules/skills/index.ts`
- `src/modules/skills/README.md`

交付说明：`docs/协作/交付/ux-resource-center.md`。没有编辑 SiteShell、共享 CSS、github-guide、app/server/shared、实际迁移、依赖、宪法或公共规划。

## 已验证与模拟测试

- `npm test -- resources`：84/84 通过。覆盖原发布/撤回、审核证据、私人权限、收藏并发、主动分享和事务复核，以及新增分页查找、URL 筛选往返、同站身份、教程链接安全。
- `node --experimental-strip-types --test src/modules/resources/site-identity.test.ts`：最后一次同站映射修复后 2/2 通过。
- 教程现有 17 个链接已通过安全检查；协议相对地址、反斜杠、控制字符、非 HTTP(S)、凭据及非白名单站内路径有边界测试。
- `npm test -- skills`：24/24 通过。覆盖精确版本/许可、工具声明过滤、计划预览与再次授权检查、私人 HTTP/CSRF、回执、八工具隔离文件夹具、冲突/回滚/撤销和受限 loopback 桥接。未调用真实客户端；临时目录中按八种目录声明写入无害夹具不能当客户端加载/任务成功。
- 全局 `npm run typecheck` 中途通过一次。最后一次复核失败仅涉及其他并行文件：`src/components/invitation-client.tsx:85` 的 `InvitationPreview` 尚缺 `usedUses` / `remainingUses`；`src/modules/projects/service.ts:712` 的 membership 状态比较触发 TS2367。U04 文件没有类型错误，未越界修改这些文件；主会话统一接入后再次检查。
- 资源 SQL 集成使用独立内存 PGlite；网络与共享失败使用注入夹具。未打开运行中的 `.runtime/postgres-data`，不能把内存测试当线上 PostgreSQL 并发或真实外站验证。

## 未接入 / 未真实验收

- 下述服务器原创教程文案未修改，仍需主会话统一同步；不改既有持久 DSH 分析或固定候选数据。
- 尚未执行本轮生产构建、服务替换、桌面/375px 浏览器、实际账号切换及真实手机验收；主会话负责统一贯通检查。
- 未触发模型付费、验证码、真实安装写入、GitHub 写入、外站抓取或新审核发布。八种客户端加载及示例任务没有新增真实验收记录。
- 本轮不新增环境变量、依赖、根迁移、共享契约或后台预算配置。

## NEEDS_INTERFACE

本轮资源/技能筛选与教程 UI 均复用现有接口，没有必须新增的根 API。以下为主会话独占服务器内容的精确建议，普通公开读取仍只读，改文案不触发分析/安装/分享：

1. `src/server/library.ts` 的 `skill-pack-guide`：
   - `summary`：`按正在使用的 AI 工具和要完成的任务选择少量技能，安装前检查来源与范围。`
   - `body[1]`：`先选择正在使用的 AI 工具，再查看任务套餐中每项技能的用途、固定版本、许可证与兼容证据。套餐分类不代表比赛主办方官方赛道。`
   - `steps[0]`：`选择正在使用的 AI 工具和想完成的事。`
   - 指向 `/skills` 的首链接标题：`AI 技能与任务套餐`。
2. 两篇 `github-first-repository`、`github-team-workflow` 的 `links` 增加 `{ title: "打开 GitHub 教程", url: "/github" }`；公开文章无额外权限，完整操作仍在项目代码与提交流程中核权。
3. `start-here` 同步三入口及团队空间名称：
   - `body[1]`：`在“我的参赛”创建参赛项目（团队空间），邀请队友后填写可投入时间。每个人可先选愿意承担的任务，不确定时再用 AI 帮助；分工与计划由团队核对并确认。`
   - `body[3]`：`“工具与资料”按任务连接工具、找灵感、AI 技能、新手教程和 GitHub 教程。工具保留人工审核及私人收藏；分享到团队空间须单独确认。灵感官网说明由 DSH 更新，未完成时标明等待；新手教程是本站原创说明。`
   - `steps` 与 `links` 使用 `找比赛 / 我的参赛 / 工具与资料` 为主要三步，保留 `/inspiration`、`/skills`、`/github` 和准备材料的直达链接；不要把旧“赛道技能包”写成官方比赛赛道。

## 交还状态

U04 及内部代理已完成并停止编辑，以上文件交还主会话。本轮临时授权至此结束；主会话可统一组合、同步服务器教程文案、构建与浏览器验收。
