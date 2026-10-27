# 竞品调研：HackerMate 与 HackMate

- 调研人：竞品调研员（只读公开页面 / 公开源码）
- 调研日期：2026-10-15
- 方法：`web_search` 找线索 → Node `fetch` / `Invoke-WebRequest` 抓页面并落盘 → `raw.githubusercontent.com` 读公开仓库源码与文档 → `api.github.com` 读仓库元数据。**未安装任何软件、未执行目标站点或仓库代码、未注册、未提交表单、未下载可执行文件。**
- 依据宪法 v1.21.0 原则 XII「对标与公平：机制可以学，事实不能编」，本文件逐条标注证据强度。

**证据强度标记约定**

| 标记 | 含义 |
| --- | --- |
| 【已抓取】 | 我本次实际抓到该页面/该源文件原文，并据此引用 |
| 【代码级】 | 来自公开仓库源码、迁移 SQL、架构文档的原文 |
| 【搜索摘要】 | 只拿到搜索结果标题/摘要，未抓到原文 |
| 【推测】 | 由已抓取事实推导，非原文声明 |
| 【未获取】 | 本次没有拿到，不补写 |

---

## 一、产品身份

### 1.1 HackerMate（hackermate.in）

| 项目 | 结论 | 证据强度 | 证据 |
| --- | --- | --- | --- |
| 官网 | https://hackermate.in | 【已抓取】 | 首页 HTTP 200，194,583 字节 |
| 一句话定位 | "The team operating system for hackathon builders. Find teammates, form a team with every skill covered, and build together until you submit." | 【已抓取】 | 首页 hero + 页脚重复出现 |
| 页面标题 / 描述 | `<title>HackerMate \| Team Operating System</title>`；description = "Find teammates, discover hackathons, and collaborate with builders who share your vision." | 【已抓取】 | 首页 `<head>` 与 JSON-LD |
| 目标用户 | 大学生黑客松参赛者（尤其印度高校） | 【已抓取】 | README："The team-operating system for **college** hackathons."；SIH（Smart India Hackathon）专属工具链；`src/lib/colleges.ts`、`college` 字段贯穿匹配 |
| 作者 / 发布者 | Yash Shah（GitHub `yashshah1211`），印度孟买，Dwarkadas J Sanghvi College of Engineering（DJSCE）二年级 IT 学生 | 【已抓取】 | dev.to 作者资料卡：Location "Mumbai, India"、Education "Dwarkadas J Sanghvi College of Engineering"、Joined Jul 18, 2026；首页证言块署名 "Yash Shah · Founder, 2nd-year CS engineering student" |
| 收费 / 商业模式 | **对学生完全免费**；主办方挂牌也免费 | 【已抓取】 | 首页 "Free for students"；FAQ 折叠面板标题 "Is HackerMate free?"，首页精简答案原文："Yes. Profiles, search, teams and team workspaces are free for students."；主办方区块 "List it for free" |
| 是否开源 | 仓库 README 写 MIT，但**树中没有任何 LICENSE 文件**，README 自身留有未填的注释 `<!-- Confirm this is accurate — add a LICENSE file if one doesn't exist yet. -->` | 【代码级】 | `README.md`；`git/trees/main?recursive=1` 无 LICENSE 项 |
| 上线时间 | 首个公开仓库 `yashshah1211/HackerMate` 建仓 **2026-06-29**；品牌名早期叫 "HackOS" 后改名 | 【代码级】【已抓取】 | GitHub repo `created_at: 2026-06-29T13:54:51Z`；dev.to 原文 "It started life as **HackOS** before I rebranded, and it's now live at hackermate.in" |
| 活跃度 | 仍在高频迭代。主仓库 `HackerMate_Backup` 最后 push **2026-10-15T03:20:06Z**，最近迁移到 `202610120002_team_document_revisions.sql` | 【代码级】 | GitHub repo `pushed_at`；`supabase/migrations/` 约 150 个迁移，时间跨度 2026-07-02 → 2026-10-12 |
| 规模自报数字 | registered builders **499**、teams created **31**、hackathons listed **260** | 【已抓取】 | 首页注入的 RSC payload：`{"builderCount":499,"hackathonCount":260,"teamCount":31,...}` |
| 早期用户量 | 发文时 "~35 early users, mostly friends and people from my network" | 【已抓取】 | dev.to 原文 |
| 条款/隐私版本 | Terms of Service 与 Privacy Policy 均 "Last updated: July 13, 2026" | 【已抓取】 | `/terms`、`/privacy` 正文 |
| 联系与社交 | 邮箱 `contacthackermate@gmail.com`；Instagram `@hackermate.in` | 【已抓取】 | 两处页脚 + 法务页联系段 |
| GitHub 组织（声称） | JSON-LD 声明 `"sameAs":["https://github.com/HackerMate"]`，但 **`api.github.com/orgs/HackerMate` 返回 404** —— 声称的组织不存在 | 【已抓取】 | 首页 JSON-LD；GitHub API 404 响应 |
| Devpost 项目 | 搜索命中 `devpost.com/software/hackermate-3qnw9s`（DecentraHack 2.0，由主会话提供），摘要含 "planned maintenance on Oct 7th" 更新条目；**我未抓到正文（Devpost 对本机返回 403）** | 【搜索摘要】 | 见来源清单 |
| robots.txt / sitemap.xml | 两者均 **404**（非禁止，是不存在） | 【已抓取】 | 两次请求均 HTTP 404，返回的是 Next.js 404 页面 |

**公开仓库（本次实际使用的两个）**

| 仓库 | 说明 | 证据 |
| --- | --- | --- |
| `yashshah1211/HackerMate` | 描述 "Create your perfect hackathon team."，TypeScript，129 KB，2026-06-29 建仓，0 star | 【代码级】GitHub API |
| `yashshah1211/HackerMate_Backup` | **homepage 字段直接写 https://hackermate.in**，TypeScript，6,139 KB，763 个文件，2 star / 1 fork，2026-07-02 建仓，2026-10-15 最后 push | 【代码级】GitHub API + 全树列举 |

> 命名很诚实：`HackerMate_Backup` 是线上 hackermate.in 的公开源码备份，因此**线上产品的架构细节基本全部可核对**，这是本次调研最大的信息优势。

### 1.2 HackMate

> **身份结论：语音匹配归属未能确认。**
> 我找到至少 4 个同名/近名候选，**没有任何一个已抓取页面出现"语音 / voice"相关功能描述**。Product Hunt、Peerlist、Devpost 三个站点对本机全部返回 **Cloudflare 403**（`Just a moment...` 挑战页），因此截图中所称"通过语音对话匹配技能互补队友"**无法验证归属**，本文件按【未获取】处理，不做归因。

**候选清单（按与"AI 黑客松队友匹配"的贴合度排序）**

#### 候选 A：HackMates（Product Hunt 上架产品，最贴合"AI 队友匹配"）

| 项目 | 结论 | 证据强度 |
| --- | --- | --- |
| 名称 | HackMates（注意复数，与 HackerMate 差一个字母） | 【搜索摘要】/【已抓取】 |
| 上架 | Product Hunt 产品页标题 "HackMates: AI-powered team matching for your next hackathon" | 【搜索摘要】 |
| 制造者 | Pavan Mali（`producthunt.com/@pavan_0281`） | 【搜索摘要】 |
| 官网 | **未能确认**（PH 页面对本机 403，未取到官网链接） | 【未获取】 |
| 一句话定位 | "次のハッカソンのためのAI搭載チームマッチング"（为你的下一场黑客松提供 AI 驱动的队友匹配） | 【已抓取，经由 AI Hunt 镜像页】 |
| 功能摘要 | ① AI 相性评估：由 **Gemini AI** 依据技术栈、目标、工作风格匹配；② 信誉徽章：基于实绩反馈的分级 **Newbie → Reliable → Finisher → Legend**；③ 实时协作：私信 / 公告 / 进度追踪在同一平台；卖点是"抑制 ghosting（放鸽子）" | 【已抓取，AI Hunt 镜像页日文摘要】 |
| 技术栈 | 页面自述 "React/Tailwind/Firebase で構築"（React + Tailwind + Firebase 构建） | 【已抓取，AI Hunt 镜像页】 |
| 地域 | "インド発のローカルさとグローバル対応を両立"（兼顾印度本土与全球化） | 【已抓取，AI Hunt 镜像页】 |
| 语音 | 摘要中**无任何语音相关描述** | 【已抓取，AI Hunt 镜像页全文比对】 |

> 证据说明：AI Hunt（`ai-hunt.tech`）是聚合 Product Hunt 上架信息的第三方站点，其 HackMates 条目**内容与 PH 商品页摘要一致**，可作为 PH 页面的二手镜像，但**不等于我读到了 PH 原文**。PH 原始页面未能抓取。

#### 候选 B：HackMate（hackmate.space，swipe 式联创匹配）

| 项目 | 结论 | 证据强度 |
| --- | --- | --- |
| 官网 | 原 `hackmate.app` → 现 `hackmate.space` | 【已抓取】 |
| 定位 | "Find Your Perfect Co-Founder" — swimpe 式匹配平台，连接创始人/开发者/独立黑客 | 【已抓取】 |
| **状态** | **已停止开发**：页面顶部原文 "App development has been paused as the experiment has been completed." | 【已抓取】 |
| 机制 | ① 建轻量资料（技能、经验、目标）② 左滑跳过 / 右滑表达兴趣 ③ 互滑即实时进入共享 match queue ④ 匹配后可查看详情并立刻联系 | 【已抓取，README 原文】 |
| 技术栈 | Next.js + Tailwind（前端）；PostgreSQL + Prisma（数据）；**Redis 做实时缓存与匹配判定**；Clerk 认证；Cloudinary 存图；Vercel 托管；Docker Compose 三服务（app/postgres/redis） | 【代码级，README 原文】 |
| Redis 数据模型 | `likes:<user_id>` SET（防重复滑动）／`matches:<user_id>` LIST（共同匹配队列）／`user:<user_id>` HASH（资料缓存） | 【代码级，README 表格原文】 |
| 开源 | MIT License（README 声明） | 【代码级】 |
| 荣誉 | 站内展示 Product Hunt Daily Winner、Product Hunt Featured、Peerlist 好评 | 【已抓取】 |
| 语音 | **无** | 【已抓取】 |
| AI | **无 AI 描述**；README 的 "Future Development" 里只有角色过滤、时区/地理匹配、pitch card，**没有 AI 也没有语音** | 【代码级】 |
| 是否黑客松专用 | 不是。定位是 founder / co-founder / indie hacker 通用匹配，黑客松只是场景之一 | 【已抓取】 |

#### 候选 C：HackMate（GitamHyd/Hackmate，最接近我们项目的结构对标）

| 项目 | 结论 | 证据强度 |
| --- | --- | --- |
| 仓库 | `Git-HubCommunityGitamHyd/Hackmate`，描述 "A platform to find hackathon teammates + lot more!"，TypeScript，3 star，2026-09-18 建仓，2026-10-07 最后 push | 【代码级】 |
| 演示站 | `hackmate-liart-zeta.vercel.app` | 【代码级，homepage 字段】 |
| 核心机制（值得注意） | **刻意不做匹配百分比**，改为"编成分析"："reports which skill areas the team covers, which ones are missing, and which available people fill those gaps and why" | 【代码级，README 原文】 |
| 工作区 | 实时聊天 + **提交清单（submission checklist）+ 完整度计量（completeness meter）**，直到提交 | 【代码级，README 原文】 |
| AI | **明确不用 AI**："Matching | Deterministic weighted scoring in TypeScript, no AI" | 【代码级，README 表格原文】 |
| 技术栈 | Next.js 16 App Router + TS；Tailwind 4 + shadcn/ui + Lucide；**CockroachDB Serverless**；Drizzle ORM + postgres-js；Auth.js v5（GitHub OAuth + Resend 魔法链接）；**Pusher Channels** 实时；Vercel Blob 存储；Resend 邮件；Vercel Cron；TanStack Query；Zod + React Hook Form | 【代码级，README 表格原文】 |
| 语音 | **无** | 【代码级】 |

#### 候选 D：Devpost 上的两个 HackMate（主会话提供，本机无法验证）

| 项目 | 说明 | 证据强度 |
| --- | --- | --- |
| `devpost.com/software/hackmatch-rnbufk` | 标题「Find Your Perfect Team Instantly」，含 AI Matching（由主会话转述） | 【搜索摘要】 |
| `devpost.com/software/project-draft-kwbj0z` | 标题「ultimate hackathon companion」，含滑卡组队 / AI Chat Bot（由主会话转述） | 【搜索摘要】 |
| 本机验证结果 | `fetch` 与 `web_fetch` 对 devpost.com 均返回 **HTTP 403 + "Just a moment..."**（Cloudflare 挑战） | 【已抓取，403 响应】 |

#### 其他同名噪声（确认非目标，排除）

- `hackmatelabs/hackmate`（302 star，Python）——**黑苹果 OpenCore 启动盘制作工具**，与黑客松无关。
- `hackmates.io` ——**安全研究咨询公司**（Amit Serper / Eliad Kimhy），与黑客松无关。
- `BrainCoder/HackMate` ——马黛茶饮料配方。
- `owengretzinger/hackmate` ——GDG Mac-a-Thon 2025 冠军作品，AI 项目灵感 / README 生成 / pitch 起草，**不是队友匹配**。
- `VishalRaut2106/HackMate_AI` ——AI 把想法转成执行计划，**不是队友匹配**。
- 其余 `themeetshah`、`mujib77`、`Gunpreet08`、`ShelMakar`、`Photon3009`（Tinder 式滑卡）、`Pusparaj99op/Flutter_HackMates`、`a-ma-n/Hackmate-Android-App`、`RohitKhairnar1`、`tms04`、`kichuman28` 等为个人练手/课程项目，star ≤3。

---

## 二、功能清单

### 2.1 HackerMate

来源：首页五段流水线区块 + README + 仓库路由树 + 迁移文件名。以下全部【已抓取】或【代码级】。

**A. 组队与匹配**

1. **Builder 搜索 / 发现**（`/developers`，`/builders` 301 重定向到 `/developers`）：按技能、经验、可用性、院校、年级过滤。首页过滤器原文："Skill, experience, availability, college and year"。
2. **排序原则**（首页原文）："People who **add to your stack** come before people who **duplicate it**"；"Sorted by fit with your team"。
3. **可解释建议**（首页原文）："Every suggestion says why, in plain words"；卡片显示 "Adds Figma and Framer to your stack" 之类具体理由。
4. **匹配分级标签**：Strong fit / Good fit / Discovery suggestion（第三方为 confidence 低时的降级展示）。
5. **连接请求**：带可选留言（迁移 `202608010001_add_connection_request_message.sql`）。
6. **Squad matcher（缺口填充器）**：团队维度的"谁补我这个坑"，不是人维度兼容性。工作区侧栏确有该入口。
7. **推荐队友 RPC**：`20260822120100_get_recommended_teammates_rpc.sql`、`202610090001_squad_matcher.sql`。

**B. 团队**

8. 创建团队 `/teams/create`、团队列表 `/teams`、团队详情 `/teams/[id]`、**团队工作区 `/teams/[id]/workspace`**。
9. **入队申请处理** `/teams/[id]/requests`。
10. 邀请：`/invites`；README 称支持"one-click team invites sent directly in DMs"；迁移 `202607100007_require_signed_invite_tokens.sql`（**签名邀请令牌**）、`202607050002_auto_join.sql`、`202608070003_invite_notification_team_link.sql`。
11. 团队 ↔ 多赛事关联：`202607080007_team_multiple_hackathons.sql`，后又 `202607120003_team_single_active_hackathon.sql`、`202608080004_allow_multi_event_team_hackathons.sql`（**该约束被反复改动，说明产品在这点上摇摆**）。
12. 团队规模与轮次：`202608070001_team_sizes_and_rounds.sql`；赛道：`202608070005_add_track_to_teams.sql`。

**C. 工作区（团队内的"迷你项目 OS"）**

13. 工作区标签页（首页演示 + 组件目录）：**Chat / Tasks / Brainstorm / Resources / GitHub / Deployments / Activity / Pitch review / Squad matcher**。
14. 聊天能力：Supabase Realtime 实时团队聊天与私信、**线程回复**（`202608040003_add_reply_to_id_to_messages.sql`）、**@提及**（`202607090001_mention_notif_deeplink.sql`）、**置顶消息**（"Kickoff notes are in Resources"）、**消息表情回应**（`202608180003_message_reactions.sql`）、**语音消息**（首页演示里有一条 `0:18` 的语音条与麦克风按钮；README 未列，属页面可见事实）、图片与链接预览（`/api/link-preview`）、消息删除 RPC、媒体域名白名单。
15. 任务：`202607120004_task_due_dates.sql`（任务截止日期）。
16. 文档并发：`202610120002_team_document_revisions.sql` + `src/lib/teamDocument.ts`；架构文档 `docs/architecture/workspace-document-concurrency.md`。
17. GitHub 集成：`202607120001_team_github_sync.sql`、`202608080005_hackathon_scoped_github_and_links.sql`（**按赛事隔离的仓库与链接**）、`202607060001_github_stats.sql`。
18. 部署记录：工作区有 Deployments 标签页；`src/lib/r2.ts` + S3 presign 上传。
19. 提交：`202607120002_team_submissions.sql`、`202608080003_team_submissions_composite_pk.sql`、`202608080004`、`202608050005_showcase_submissions.sql`。
20. **Pitch review / PPT 评估**：`/tools/pitch-evaluator`、`/tools/ppt-evaluator`、`/api/teams/[id]/ppt-evaluate`，迁移 `20260813190000_team_ppt_evaluations.sql`、`20260814205000_add_ui_ux_team_columns_to_ppt_evaluations.sql`，架构文档 `docs/PPT-VISUAL-EVALUATION.md`。
21. 活动流：Activity 标签页。
22. 每日访问连续天数：`202608180007_daily_visit_streaks.sql`。

**D. 赛事**

23. 赛事目录 `/hackathons`（页面自报 **260** 场）与详情 `/hackathons/[id]`。
24. 自建赛事：`202607250001_native_hackathon_hosting.sql`、`/hackathons/create`、`202607280003_hackathon_stages.sql`、`202607280004_hackathon_announcements.sql`。
25. 报名：`202607270001_registration_capacity_and_status.sql`（**容量与状态**）、`202608040002_add_metadata_to_hackathon_registrations.sql`、隐私专项 `docs/architecture/registration-privacy.md`。
26. 主办方门户：`/hackathons/[id]/organizer`、`/partners/[slug]`、`/partners/[slug]/organizer`、`/api/organizer/broadcast`；架构文档 `partner-organizer-api.md`、`partner-organizer-workspace.md`、`partner-public-presentation.md`、`partner-read-projections.md`、`partner-admin-configuration.md`。
27. 多赛道报名：`202607260001_axcentra_and_partner_engine.sql`（"partner portal + multi-track support"）。
28. **Smart India Hackathon（SIH）专属工具**：`202607290001_sih_team_builder.sql`（**按院校限定的组队**）、`202608050004_sih_spoc_portal.sql`、`20260809230000_create_sih_spoc_allowlist.sql`（SPOC 白名单）、`202608100002_sih_two_round_stages.sql`、`202608180002_update_sih_team_size.sql`。
29. 主办方线索 CRM：`202607210001_organizer_leads.sql`、`202607240001_add_open_tracking_to_organizer_leads.sql`（**邮件打开追踪**）、`/api/cron/auto-scrape-leads`、`/api/admin/send-organizer-pitch`、`/api/admin/send-outreach-summary-pdf`、`/api/admin/organizer-leads/sync-gmail-replies`（**同步 Gmail 回复**）。
30. 赛事归档：`20261002160000_add_hackathon_archival.sql`。

**E. 通知与邮件**

31. 站内通知 `/notifications`，覆盖连接请求、团队邀请、入队申请三类（README 原文）。
32. 邮件摘要：`202607080005_offline_email_notifications.sql`（离线邮件通知，后被 `202608030002` 重新启用）、`reminders` cron、`/api/webhooks/resend`、`/api/webhooks/email-open`。
33. 定时任务（`vercel.json` 原文）：`/api/cron/database-activity-report` 与 `/api/cron/auto-scrape-leads`，均为 `30 3 * * *`（每日 03:30）。另有 `onboarding-nudge`、`profile-nudges`、`analytics-summary`、`daily-email-report`、`reminders`。
34. **Discord 集成**：`/api/webhooks/discord`、`src/lib/discordCommandHelper.ts`、依赖 `discord-interactions`。

**F. 评分、信誉与激励**

35. **Track record（履历记录）**：hackathon 参与数、**获奖数（win）**、团队数、连接数。首页示例："2 wins / 1 Hackathons / 7 Wins / 2 Teams / 3 Connections"。
36. **Shipped work**：项目条目带 demo / code / slides 链接，并标注对应赛事与结果（Winner / Finalist / Shipped）。
37. **GitHub 同步**：语言占比（Go 38% / TypeScript 29% / Python 21% / Other 12%）、公开仓库数、关注者数；`src/lib/github.ts` 调 `api.github.com/users/{u}` 与 `/repos?sort=updated&per_page=15`。
38. 履历默认公开，可在 Settings 隐藏（首页原文 "Track records are public by default. Anyone can hide theirs in Settings"）；对应迁移 `20260808181000_builder_track_record_privacy_and_slug.sql`。
39. 院校排行榜 `/leaderboard?college=vjti`（跨院校）。
40. 徽章：`/api/admin/issue-badges`、`/api/admin/revoke-badge`。
41. 证书与验证：`/api/certificates`、`/api/certificates/verify/[id]`、`20260827214000_add_certificate_verification_index.sql`。
42. **每周练习挑战**：`202608160001_weekly_practice_challenges.sql` + `/challenges/[slug]` + 排行榜 `challenges/leaderboard`。
43. **E=评估员**：`/evaluator`、`/api/evaluator/evaluate`、`/api/evaluator/history`。
44. **线下 Expo 套件**：`/expo/judge`、`/expo/leaderboard`、`/expo/printables/{builders,challenges,flyer,poster,qr-sign,rules,team-mat}`（**打印物：海报、传单、QR 立牌、桌牌、规则页**）、`20261002233945_expo_leaderboard.sql`。
45. 个人资料完整度评分：`src/lib/profileCompleteness.ts`，5 项（姓名/院校/bio/GitHub/技能）各 20 分，满分 100。

**G. 运营与安全**

46. 管理后台 `/admin` 及大量子 API：封禁用户、删除用户、**删除用户日志审计**（`202608030005_add_deleted_user_logs_audit_trigger.sql`）、挑战管理、赛事管理、合作伙伴配置、邮件分析、DB 活动报表、完成度催办。
47. 举报与拉黑：`202607060002_report_block_tables.sql`、`202607100008_prevent_anonymous_reports_and_spam.sql`。
48. 限流表：`202607180009_create_rate_limits_table.sql`（README 称消息与团队管理端点限流）。
49. 内容审核（AI）：`src/lib/geminiModeration.ts`、`src/lib/safety.ts`、`src/lib/mediaValidation.ts`。
50. Sentry 错误监控（`sentry.{client,edge,server}.config.ts` + `/api/sentry-test`）。
51. 邮件模板与统计：`src/lib/emailTemplate.ts`、`202607280007_daily_email_stats.sql`、`/api/admin/sync-email-stats`。

### 2.2 HackMate（候选）

- 候选 A（HackMates）功能：AI 相性评估 / 信誉徽章四级 / 实时协作（私信·公告·进度）——【已抓取，AI Hunt 镜像页】。
- 候选 B（hackmate.space）功能：滑卡发现 / 实时匹配 / 仅双向可见 / 技能导向资料——【代码级，README】。
- 候选 C（GitamHyd）功能：GitHub 或邮件魔法链接登录 / 资料（技能·角色·可用性·投入度）/ 浏览主办方发布的赛事 / **围绕想法组队 + 编成分析** / 共享工作区（实时聊天 + 提交清单 + 完整度计量）——【代码级，README】。
- 候选 D（Devpost 两个）：滑卡组队 / AI Chat Bot / AI Matching——【搜索摘要】，本机无法验证。

---

## 三、关键机制细节（HackerMate）

主要证据：`docs/architecture/matchmaking-v2/DESIGN.md`、`docs/architecture/matchmaking-v2/SQUAD-MATCHER.md`（两者均为【代码级】原文，合计数万字，以下为忠实摘录与转述）。

### 3.1 匹配是怎么做的：**确定性的七维证据向量，明确不用向量嵌入、不用付费推理**

原文决策表：

> | Curated aliases and seven-dimensional evidence vectors | Embeddings/paid inference | **Deterministic, explainable, inexpensive, auditable.** |

> | SQL is authoritative for scores and explanations | Keep the browser's second scorer | Avoids dashboard/developers disagreement. |

- **技能归一化**：`lower(trim(collapse_whitespace(value)))` + **精确别名查表**。刻意不用子串匹配，因为要把 C、C++、C# 区分开，且避免把 "React Native" 误判成 "React"。别名映射后去重。
- **七维领域固定顺序**（永久索引）：
  1 Frontend（React, Vue, Angular, Svelte, Next.js）／2 Backend（FastAPI, Django, Express, Spring Boot）／3 AI/ML（PyTorch, TensorFlow, scikit-learn）／4 Mobile（Flutter, React Native, Android, iOS）／5 Cloud-DevOps（Kubernetes, Terraform, Docker, CI/CD, AWS）／6 UI-UX（UI design, UX research, Figma, prototyping）／7 Product-Pitch（PM, pitching, market research）。
- **每个 canonical skill 存一个 7 维向量** `W[s] ∈ [0,1]^7`；用户领域向量 `d_u[k] = max(W[s][k])`。文档强调这是 **"evidence specificity, not skill proficiency"**（证据特异性，不是熟练度），`max` 聚合是为了防止十个同义前端工具被算成十种独立能力。
- **基础技能（foundation）键**：Git、JavaScript、TypeScript、Python、SQL、HTTP、REST API、Java、Go、C、C++、C#。定位是"互操作信号"，**不**用来推断沟通能力或英语水平。且**不做工具→语言推断**（用 React 不等于会 TypeScript，用 FastAPI 不等于会 Python）。
- **未知技能保留原样展示**，不发明分类；完全无法映射的技能集产生"unknown role evidence"而不是判为不兼容；未映射键进入聚合维护报表，通过**版本化迁移**补别名。

### 3.2 两套独立打分（关键设计）

文档决策："Two independent scoring functions / One universal compatibility score → **A teammate pair and a person filling a vacancy have different objectives.**"

**Surface A：人对人**

```
Score_A = round(100 * ( 0.55*I(S_comp) + 0.20*I(S_base) + 0.15*I(S_exp) + 0.10*S_context ))
I(x) = x if known else 0.5      # 中性插补
```

- 组件互补性（方向性额外覆盖）：

```
N(a|b) = Σ_k max(d_a[k] - d_b[k], 0) / Σ_k d_a[k]
S_comp = (N(a|b) + N(b|a)) / 2
```

  完全相同向量得 0（含"相同的不完整证据向量"）；强领域完全不相交得 1。文档举例：**React 专精 + 后端专精，比两个完全相同的 React/FastAPI 全栈泛才更互补**。
- 基础重合：`S_base = min(1, |F_a ∩ F_b| / 2)`（共用 Git + TypeScript 即满分，不奖励把技能表灌长）。
- 经验平衡：`E(u) = 0.8*ln(1+min(p,10))/ln(11) + 0.2*ln(1+min(w,3))/ln(4)`，`S_exp = 0.5*(1-|E(a)-E(b)|) + 0.5*min(1,(E(a)+E(b))/0.8)`。文档自陈：**仓库 schema 用 0/false 默认值，无法区分"新号未填"和"确认零经验"，故 v1 把所有全零视为未知**（这是承认的数据模型缺陷）。
- **刻意排除的信号**（原文 "These omissions are deliberate, not missing implementation"）：`year_of_study` 只展示不当技能代理；**GitHub `total_stars` 与 `public_repos` 被排除**（"popularity is not a quality score"）；`top_languages` 在 v1 被排除。
- 上下文：`S_context = A`（未开启院校偏好时），开启时 `0.75*A + 0.25*C`。**不同院校是中性、同院校是加分**；可用性永不作为过滤条件。文档量化："College's same-versus-neutral difference is **1.25 points**"。
- 固定权重、**不做 5–99 截断、不因缺项重新归一化**（防止"只有一个已知加分项就变 100 分"）；排序 = 未四舍五入的总分 → 证据覆盖率 → UUID（保证确定性）。

**Surface B：人对队**

```
Score_B = round(100 * ( 0.60*I(S_role_gap) + 0.30*S_skill_fit + 0.10*S_context ))

readiness(u,r) = min_{k ∈ D_r}(d_u[k])
occupancy(t,r) = mean_{k ∈ D_r}(n_t[k])
V(u,t,r) = readiness(u,r) * (0.85 + 0.15 / (1 + occupancy(t,r)))
S_role_gap = max_{r ∈ roles_needed}(V(u,t,r))
```

- 取**最佳单角色匹配**，不除以全部招募角色数——"A frontend builder should not lose points merely because the team also seeks a designer."
- **Full Stack 要求 frontend 与 backend 同时满足，用 `min` 不是 `max`**。
- 团队领域证据 = `teams.skills` ∪ 现役成员技能；`teams.skills` 被定义为**已具备能力的表达，不是缺口愿望单**。
- 队伍上下文 `T = min(1, m / max(M-1, 1))`，偏向"快满员的成熟队伍"，不奖励大容量或空队。

### 3.3 分数如何呈现（诚实性设计，值得直接借鉴）

- `confidence` = 已观察到输入的权重之和（0–1），文档明确 **"evidence coverage, not statistical confidence"**。
- **confidence < 0.5 或主分量（role/complementarity）为 null 时，UI 必须显示 "Discovery suggestion" 而不是数字分。**
- **禁止措辞**（原文）：`Do not label a score "86% chance of success"`；有依据时显示 `Fit: 86/100`。
- 内部仍做中性插补，以免"缺数据"被误当成"零分"。
- 官方给出的两个示例：React+React → **44**；React+FastAPI → **99**。并自我提醒："The high second score reflects the chosen model, **not demonstrated interpersonal success**."
- 承认可被刷："self-reported skill stuffing across all seven domains can still increase coverage. Alias deduplication and max aggregation address duplicate counting, **not truthful proficiency**."；并明确"不要把自报信号在解释里称为 verified skills"。

### 3.4 检索与性能

- 特征在**写入时**预计算（profile/team 变更触发重建 + feed 刷新 + 触发器维护），请求时不做全量归一化或全表聚合。
- 索引轮转桶 `(bucket, ticket, entity_id)`，`ticket = md5(entity_id)::uuid`，按"viewer/日期派生 pivot"取**稳定的每日环切片**（先取 pivot 之后的索引范围，再取环绕范围），每桶最多读 96 条、最多留 96 条。文档强调 **"This is not `ORDER BY random()` and does not sort an entire population per request."**
- 拉取上限：builder ≤ **960** 个候选 ID；team ≤ **864**。**明确承认是近似检索**："It can miss the global best result"；且**禁止**为了凑数而静默回填不安全候选或全表扫描。池大小是版本化的服务端调参值，不是客户端参数。
- 容量**实时校验**，不用可能陈旧的计数器。
- 目标 **p95 < 50 ms 数据库执行时间 @ 10 万 profile / 2 万 team**，并自我限定"不能保证跨 Supabase 计算档位、连接并发、缓存状态、表膨胀……"。
- 接受度门槛提案：**recall@10 ≥ 0.90**（"this target is a product proposal, not a measured result"）。
- 已知锁风险：多行事务可能因不同基表加锁顺序而**死锁**，要求调用方重试 PostgreSQL `40P01`/`40001`，**不得吞掉失败**。
- 分类法变更要求"同一版本转换内完成受影响特征全量重建 + feed 刷新"；更频繁变更应做**影子特征版本 + 原子切换**，不能返回混合版本分数。

### 3.5 权限与角色

- 两个 RPC 均 `SECURITY DEFINER`，理由原文：**"they must see reverse blocks that blocker-only RLS hides"**。所有关系 schema 限定、`search_path=''`、**无动态 SQL、无客户端可选打分输入**。
- 强制 `auth.uid()` 非空且**严格等于 `p_user_id`**；viewer 必须已完成 onboarding 且未被封禁。
- 结果条数钳制：`least(greatest(coalesce(p_limit,10),1),50)`。
- 候选人排除：本人、未 onboarded、被封禁、**双向拉黑**。
- 队伍排除：非招募中、已满、本人拥有、已加入、存在 viewer 的 pending 申请或邀请、与队长或任一成员存在双向拉黑；队长账号本身必须 onboarded 且未被封禁。
- **被封禁成员不会从容量计数里静默移除**（"membership moderation remains a separate platform responsibility"）。
- 返回列白名单（profile card）：`id, full_name, avatar_url, college, bio, skills, github_url, linkedin_url, year_of_study, is_available`；特征生成另读 `onboarding_completed, is_banned, hackathon_participations, hackathon_wins, has_won_hackathon`。**"It never reads email."**
- 队伍只返回目录安全的卡片数据与打分元数据，**不含成员 ID、拉黑名单、pending 申请细节、内部工作区数据**。
- 明确边界："Safety checks are current to the SELECT transaction snapshot, not a promise that membership stays unchanged after the response."；apply/join/invite 必须在自己的事务锁下重新校验权限与容量。
- 区分 `SECURITY DEFINER` 与 invoker helper；纯算术 invoker 函数允许内联，definer 一律空 search path。
- 架构文档明确"no service-role credential reaches a browser"。

### 3.6 Squad matcher（缺口填充）

- 与 V2 复用而非替换：复用私有技能/角色词表、别名归一化、七维向量、索引轮转候选池、特征维护。
- **队到人**的新 RPC：回答"谁适合本队的空缺角色"；人对人发现继续回答"与某个人的兼容性"。**明确"No universal score"**。
- 内部排序指数：**40** 分相关空缺角色领域证据 + **25** 分必需缺口覆盖 + **10** 分 requested-skill 覆盖 + **15** 分方向性 candidate→roster 领域新颖度 + **5** 分可用性 + 最多 **5** 分公开自报黑客松经验。
- 客户端**保留服务端顺序、不显示数字适配分**；文案措辞受约束，例如只能写 "Lists skills relevant to your open Backend role."
- **性别与院校既不评分也不返回**（原文："Gender and college are neither scored nor returned by this RPC."）。
- 权限：仅 owner/member 可读建议；**仅 owner 可邀请**（与既有 `send_team_invite` 一致）。`send_squad_invite` 先锁团队、重新校验容量/招募中/候选人/pending 状态，再调用既有 `send_team_invite`，**不重写既有邀请、通知与接受流程**。
- 容量取"最小正团队容量"与"关联赛事记录上限"的严格值；未知容量则**禁用建议与邀请**；必须显式 recruiting 开放。
- 前端细节：客户端二次点击保护、被拒邀请移除过期可操作卡片并提供 Refresh、**旧响应不能覆盖新推荐**。
- 性能：沿用 ≤96/桶，返回 8 张卡（硬上限 20），按 team ID 每日轮转。

**被替换掉的旧实现（非常有价值的负面清单，原文记录）**：

> The old Squad Matcher independently fetched 100 profiles, used substring matching, gender/college bonuses, invented verification claims, rejected sparse profiles, assumed six seats and attempted direct invite inserts.

即旧版有 6 个具体错误：① 独立拉 100 条资料 ② 子串匹配 ③ 性别/院校加分 ④ **编造 verification 声明** ⑤ 拒绝稀疏资料 ⑥ 假定 6 席并直接写邀请表。

**另外，文档还记录了"前端另有一套打分器"的问题**：DESIGN.md 要求 `/developers` 页面"retire the independent Jaccard calculator"、`src/lib/matchReasoning.ts` "retire conflicting taxonomies and generated claims such as guaranteed execution"，目的是"避免 dashboard 与 developers 两个页面给出不一致结果"。**这是"第二份事实"危害的真实案例，与我们宪法里反对重复实现的原则完全一致。**

### 3.7 版本演进线索（迁移文件名）

`20260925221500_matchmaking_v2_engine.sql` → `20261001000000_matchmaking_v3_engine.sql` → `20261001000001_matchmaking_v3_vocabulary.sql` → `202610090001_squad_matcher.sql` → `202610120001_builder_profile_search.sql`。

SQUAD-MATCHER.md 记录了一个**部署一致性坑**：本地已有 v3 迁移，但**只读检查生产 PostgREST schema 发现 `get_recommended_teammates_v3` 并未暴露**，于是前端实现"显式缺函数时回退到 V2 `get_recommended_teammates`"的适配器。文档同时诚实标注："This verifies the API surface, not the complete migration ledger or private-schema contents."

### 3.8 AI 用法（HackerMate）

- **匹配本身不用 AI**（见 3.1）。DESIGN.md 原文："No API dependency or hosted vector service is added."；SQUAD-MATCHER.md 原文："No paid AI, dependency, environment variable, new branch or worktree is needed."
- **AI 用在审核、PPT/Pitch 视觉评估等旁路**：
  - `src/lib/ai/geminiClient.ts`（14,201 字节）自述为 "Centralized Gemini AI Gateway"，实现 **6 级模型级联**：`gemini-3.6-flash`（主）→ `gemini-flash-lite-latest` → `gemini-3.7-flash` → `gemini-3.8-flash` → `gemini-flash-latest` → `gemini-3.5-flash`（"Final emergency safety net"）。同时约束 **per-model 超时与全局级联总超时**，以免多次回退超过 Vercel 函数上限（如 `maxDuration 60s`）。另有视觉专用级联 `GEMINI_VISION_CASCADE_MODELS`。密钥读 `GEMINI_API_KEY`。含 `extractJsonFromResponse` 剥离 code fence 与前言。
  - `src/lib/geminiModeration.ts`（内容审核）、`src/lib/safety.ts`。
  - PPT/Pitch 视觉评估：`docs/PPT-VISUAL-EVALUATION.md`、依赖 `unpdf`（解析 PDF）+ Gemini Vision、结果表 `team_ppt_evaluations`。
  - 主办方侧批量邮件文案：`/api/admin/send-organizer-pitch`。

### 3.9 集成清单（HackerMate）

| 第三方 | 用途 | 证据强度 |
| --- | --- | --- |
| **Supabase** | Postgres + Auth + Storage + Realtime（README 表格原文） | 【代码级】 |
| Google / GitHub OAuth | 注册登录（DEVELOPER_GUIDE 步骤 6） | 【代码级】 |
| **Vercel** | 托管 + Cron（`vercel.json`） | 【代码级】 |
| **Resend** | 事务邮件 + webhook 验签（`svix`、`/api/webhooks/resend`） | 【代码级】 |
| **Sentry** | 错误监控（`@sentry/nextjs`） | 【代码级】 |
| **AWS S3 / Cloudflare R2** | 预签名上传（`@aws-sdk/client-s3` + `s3-request-presigner`，`src/lib/r2.ts`） | 【代码级】 |
| **Discord** | webhook 与交互（`discord-interactions`、`/api/webhooks/discord`） | 【代码级】 |
| **Gemini** | 审核 / PPT 视觉评估 | 【代码级】 |
| **Google Analytics 4** | `G-48FYFNGHWQ`，隐私政策明确披露 GA4 | 【已抓取】 |
| **Simple Analytics** | `scripts.simpleanalyticscdn.com/latest.js` | 【已抓取】 |
| **PostHog** | README 声明使用；但**生产首页未见 posthog 脚本**，且 `src/lib/posthog.ts` 存在于仓库 | 【代码级】+【推测：可能未在公开首页启用】 |
| **GitHub API** | 拉取用户资料与仓库语言统计（`src/lib/github.ts`） | 【代码级】 |
| **Devpost** | **未获取**——本机 403，未取得任何 HackerMate↔Devpost 的对接证据 | 【未获取】 |
| **Slack** | **未获取**——未见到任何 Slack 集成证据 | 【未获取】 |

---

## 四、技术栈与架构（HackerMate，代码级）

`package.json`（原文摘录，已抓取）：

```json
{
  "dependencies": {
    "@aws-sdk/client-s3": "^3.1112.0",
    "@aws-sdk/s3-request-presigner": "^3.1112.0",
    "@sentry/nextjs": "^10.75.0",
    "@supabase/ssr": "^0.12.0",
    "@supabase/supabase-js": "^2.108.2",
    "@vercel/analytics": "^2.0.1",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "discord-interactions": "^4.4.0",
    "jspdf": "^4.2.1",
    "lucide-react": "^1.24.0",
    "motion": "^13.1.0",
    "next": "16.3.5",
    "react": "19.2.4",
    "react-dom": "19.2.4",
    "react-markdown": "^10.1.0",
    "svix": "^1.99.1",
    "tailwind-merge": "^3.6.0",
    "tweetnacl": "^1.0.3",
    "unpdf": "^1.8.1"
  },
  "devDependencies": {
    "@playwright/test": "1.64.0", "@tailwindcss/postcss": "^4",
    "@types/node": "^20", "@types/react": "^19", "@types/react-dom": "^19",
    "esbuild": "0.28.2", "eslint": "^9", "eslint-config-next": "16.3.5",
    "jsdom": "26.1.0", "tailwindcss": "^4", "typescript": "^5"
  }
}
```

| 层 | 结论 | 证据强度 |
| --- | --- | --- |
| 框架 | **Next.js 16.3.5 App Router**；React 19.2.4；TypeScript | 【代码级】 |
| 样式 | **Tailwind CSS 4**（`@tailwindcss/postcss`）；首页 class 名可见自定义设计令牌 `canvas / raised / ink / line / accent-soft / selected / sunken / ok / hack`；字体 Instrument Sans + Bricolage Grotesque + JetBrains Mono（`next/font` 模块类名） | 【代码级】+【已抓取】 |
| UI 原语 | lucide-react 图标、`motion`（Framer Motion 后继）、CVA + clsx + tailwind-merge；自研原语名 `Avatar / Panel / Tape / SeatMeter / Button / ButtonLink`（SQUAD-MATCHER.md 原文） | 【代码级】 |
| 后端 | **Supabase**：Postgres + Auth + Storage + Realtime；RLS 为核心安全边界 | 【代码级】 |
| 数据库表与策略 | `supabase/migrations/` **约 150 个迁移**，2026-07-02 → 2026-10-12；含 `migrations/` 与 `rollback/phase1_prestate.sql` | 【代码级】 |
| 私有 schema | 匹配特征放 **`matchmaking` 私有 schema**，**不得加入 PostgREST 暴露的 schema**；仅公开 RPC 供 authenticated 执行 | 【代码级】 |
| 托管 | **Vercel**（`vercel.json`、serverless routes、Vercel Blob 未用但 S3 预签名用于上传） | 【代码级】 |
| 定时任务 | Vercel Cron，`vercel.json` 只登记 2 条（03:30 每日 DB 活动报表 + 自动抓线索）；`.github/workflows/` 另有 2 个（analytics-digest、daily-database-report） | 【代码级】 |
| 邮件 | Resend（`RESEND_API_KEY`），Svix 验签；开发沙箱会把邮件重定向到沙箱收件人防误发 | 【代码级】 |
| 监控 | Sentry（client/edge/server 三配置） | 【代码级】 |
| 分析 | 生产首页 = GA4 + Simple Analytics；仓库内另有 PostHog 客户端 | 【已抓取】+【代码级】 |
| 测试 | `@playwright/test` 三组 project（safety / fixture-desktop / fixture-mobile）+ `live-desktop` / `live-mobile`；`qa/browser/` 含 `support/read-only.ts`、`live-settings.ts`；另用 `node --test` 跑匹配与 PPT 测试；`scripts/test-squad-matching.sql` / `test-squad-matching-local.py` 在**一次性本地 PostgreSQL 集群**里跑真 SQL（文档强调用虚构实体，`finally` 里销毁，不读应用凭据、不连 Supabase） | 【代码级】 |
| CI | `.github/workflows/` 仅 2 个报表类工作流，**未见常规 CI（类型检查/构建/测试）工作流** | 【代码级】+【推测】 |
| 是否开源 | 见 1.1：README 声称 MIT 但**无 LICENSE 文件** | 【代码级】 |
| 目录结构 | `src/app`（路由+API）、`src/components`、`src/context`、`src/lib`、`src/types`、`supabase/`、`docs/`、`qa/`、`scripts/` | 【代码级】 |

**架构文档清单**（`docs/architecture/`，均为代码级证据，说明其工程化程度）：
`matchmaking-v2/{DESIGN.md, SQUAD-MATCHER.md, VALIDATION.md, blueprint.sql}`、`admin-moderation-controls.md`、`builder-search-rollout.md`、`nexhack-release.md`、`partner-admin-configuration.md`、`partner-organizer-api.md`、`partner-organizer-workspace.md`、`partner-public-presentation.md`、`partner-read-projections.md`、`public-event-compatibility.md`、`registration-privacy.md`、`workspace-document-concurrency.md`、`../PPT-VISUAL-EVALUATION.md`。

**值得注意的工程纪律（原文可见）**：
- `DEVELOPER_GUIDE.md` 有明确的迁移警告："Always back up your active staging database before executing a database push. Migrations replace active security policies on tables."
- 迁移历史里**大量安全修复**：`restrict_profiles_read_to_authenticated`、`revoke_anon_from_all_security_definer_functions`、`fix_critical_rls_policies`、`high_severity_rls_fixes`、`is_admin_pin_search_path`、`optimize_rls_initplan`、`sql_security_hardening`、`phase1a_definer_function_privileges`、`phase1b_profiles_update_whitelist`、`fix_profiles_email_privacy_leak`。**这说明其 RLS 是边做边补、曾多次出现严重缺口**（含一次邮箱隐私泄漏修复）。

---

## 五、HackerMate 优点（最多 6 条，每条说明"为什么强"）

1. **匹配是"可解释的确定性算法"而非黑盒嵌入，且公开了完整公式与权重。**
   强在：可审计、可复现、零推理成本、无需外部向量服务；任何一条推荐都能用 `reasons` 说清"你补了我什么"。它还主动限制了话术（不许写"86% 成功率"），把缺数据降级为 "Discovery suggestion"。
   **对我们的直接价值**：我们的规划 32 明确禁止"不透明适配分与跨人排名"——这个设计正好是合规的参考实现。

2. **把"人对人"和"人对队缺口"拆成两套独立打分，而不是一个万能分。**
   强在：`readiness` 用 `min`（全栈必须同时满足前后端）、`occupancy` 只做轻微加权以避免"因为队里还招设计师就扣前端的分"。文档原话解释了动机："A teammate pair and a person filling a vacancy have different objectives."

3. **分数之外还有一层"证据覆盖率"（confidence），并把覆盖率低的结果主动降级展示。**
   强在：把"我不知道"和"他不行"分开。同时对缺失分量做内部中性插补、对外不显示数字。这是**防止用数据缺失冒充结论**的关键机制。

4. **产品闭环长且真实：find → review → merge → build → ship 五段，工作区里 chat/tasks/repo/deploy/pitch review 全在一处。**
   强在：`review` 阶段用真实履历（参赛数、获奖数、shipped work 带 demo/code/slides、GitHub 语言占比）替代自我介绍；`ship` 阶段接提交。同仓库还有 SIH 专用组队 + SPOC 白名单 + 线下 Expo 打印物（海报/QR 立牌/桌牌），说明它真在跑线下场景。

5. **权限与隐私边界写得非常具体，并且是"可执行规格"而不是口号。**
   强在：`SECURITY DEFINER` + `search_path=''` + 强制 `auth.uid() == p_user_id` + 结果条数钳制 + 返回列白名单（明确"never reads email"）+ 队伍返回不含成员 ID/拉黑名单/pending 细节 + 无动态 SQL + 浏览器拿不到 service-role。**双向拉黑排除**还专门解释了为什么必须用 definer（invoker 看不到反向拉黑）。

6. **工程化与自我批判水平远超同类学生项目。**
   强在：有独立架构文档、有 `blueprint.sql` 可执行参考、有一次性本地 PostgreSQL 集群跑真 SQL 的验证脚本、有 recall@10 门槛提案、有死锁重试要求、有影子特征版本切换方案；并且**公开记录了自己旧实现的六个错误**（子串匹配、性别/院校加分、编造验证声明、拒绝稀疏资料、假定 6 席、直接写邀请表）。

---

## 六、HackerMate 弱点与我们可超越的点（最多 6 条）

1. **规模极小，匹配算法的"冷启动"就是它的死穴。**
   自报 499 builders / 31 teams / 260 hackathons（首页 payload）。而匹配设计目标是"10 万 profile / 2 万 team 下 p95<50ms"——**为一个它远未达到的规模做优化**。真实候选池只有几百人时，七维向量的分辨率很低，`S_comp` 很容易恒为 0 或 1。**我们的机会**：在几百人量级上，我们已有的"真实任务/职责/可用时间"事实比七维技能向量信息量大得多，可以做"证据密度更高"的匹配，而不是照抄一个为 10 万人设计的近似检索。

2. **技能全靠自报，且文档自己承认无法防刷。**
   原文："self-reported skill stuffing across all seven domains can still increase coverage... **not truthful proficiency**."，且无法把"新号未填"和"确认零经验"分开（缺 `experience_confirmed_at`）。**我们的机会**：我们的 M06 有 GitHub 仓库/版本保存/运行验证，M10 有兼容证据与安装记录——**用"跑通过的证据"替代"自报的技能标签"**，这正好是对它最大弱点的正面打击，且我们已有基础设施。

3. **把 GitHub 星数和公开仓库数排除，但同时也没有引入任何"作品是否真的能跑"的验证。**
   排除 `total_stars`/`public_repos` 是对的方向，但结果是它只剩自报字段。**我们的机会**：不是去加星数，而是用"可运行证据 + 提交前核对"补上它留下的空档（对应规划 32 的"赛前自检与提交前核对"）。

4. **匹配是纯静态快照，完全没有时间维度，也没有"这个人在我队里现在有没有空"。**
   `S_context` 里的可用性只是一个布尔 `is_available`（1/0/0.5），容量是实时校验但**只校验"满没满"，不校验"还剩多少时间"**。**我们的机会**：我们自有 MemberAvailability 集合 + 版本化更新事实 + 时间窗口校验，可以做"剩余可用工时 vs 剩余赛程"的匹配，这是它结构上做不到的。

5. **架构过度依赖 Supabase RLS，迁移历史显示安全是边做边补、并曾泄漏邮箱。**
   证据：`fix_profiles_email_privacy_leak`、`fix_critical_rls_policies`、`high_severity_rls_fixes`、`revoke_anon_from_all_security_definer_functions`、`restrict_policies_to_authenticated` 等一系列"事后修复"迁移；且 DESIGN.md 承认现有 blocker-only RLS **看不到反向拉黑**，只能靠 definer 绕。**我们的机会**：我们的权限来自活跃 ProjectMembership + 显式 Port，校验点集中在服务层，不把安全正确性押在数据库策略的完备性上。

6. **"第二份事实"问题真实发生过，且它只能靠删代码来修。**
   DESIGN.md 要求删掉 `/developers` 的独立 Jaccard 计算器和 `src/lib/matchReasoning.ts` 里"另一套分类法 + 生成的保证性声明"，目标是"避免 dashboard 与 developers 给出不一致结果"。另外 v3 迁移本地有、生产 PostgREST 未暴露，只能靠前端写回退适配器兜住。**我们的机会**：我们宪法里"不建立第二份权限/完成状态/写路径"的原则本就更严；可以进一步做成**单一打分来源 + 版本化 score_version + 缺函数时明确报错**（不静默回退），避免它这种"本地/生产漂移"。

**另外三条可借鉴但需过吸收闸门的具体机制**

- **值得学**：`confidence`/证据覆盖率与"低覆盖降级为 Discovery suggestion"的呈现规则；禁止百分比成功率的文案约束（正好呼应我们禁止"不透明适配分与跨人排名"）。
- **值得学**：双向拉黑必须在授权边界内可见这一教训——我们的团队/项目权限同样需要"正反两向"的排除校验。
- **明确不该抄**：`ORDER BY random()` 式的近似检索不是为了小规模场景；`SECURITY DEFINER` 绕 RLS 是它被自身策略设计逼出来的补丁；把匹配做成"七维向量 + 别名表"在中文技能语境下（我们的用户写的可能是"前端/后端/算法/视觉"）会立刻遇到它没解决的别名覆盖问题。

---

## 七、HackMate 优点 / 弱点（仅在证据允许范围内）

### 7.1 候选 A：HackMates（最贴合"AI 队友匹配"）

**优点（证据：AI Hunt 镜像页）**
1. **用"信誉分级"解决放鸽子，而不是用算法解决匹配**：`Newbie → Reliable → Finisher → Legend` 四级来自实绩反馈。这是对"匹配对了但人不干活"这一真实痛点的正面回应——比提高匹配精度更接近问题本质。
2. **匹配输入不只看技能栈，还看目标与工作风格**（原文："技术栈・目标・工作风格を考慮"），比纯技能标签更接近"能不能一起干完"。
3. **把匹配后的协作留在同一平台**（私信/公告/进度），减少"匹配成功但没有下文"。

**弱点**
1. **无可核验的官网与源码**（PH 页面对本机 403，未取得官网域名、未找到 GitHub）。技术栈信息只有第三方镜像页的一句 "React/Tailwind/Firebase"，**无法验证**。
2. **信誉分级没有说明如何防止刷分/报复性评价**，AI Hunt 摘要里未提申诉或防刷机制。
3. **热度极低**：AI Hunt 页显示"投票数: 0"。

### 7.2 候选 B：HackMate（hackmate.space）

**优点**
1. **"仅双向可见"（mutual-only visibility）设计**：未被回应的一方看不到对方兴趣，降低社交压力——这是一个可直接借鉴的交互原则。
2. **实时匹配用 Redis 而不是轮询数据库**：`likes:<uid>` SET 防重复、`matches:<uid>` LIST 做队列，工程上简单直接，且 README 把 key 格式都写出来了。
3. 工程完备度对个人项目偏高：MIT、Docker Compose 三服务、健康检查端点、Prisma Studio 指引、CONTRIBUTING.md、Discord 社区。

**弱点**
1. **已停止开发**：站内原文 "App development has been paused as the experiment has been completed." 作为对标对象参考价值有限。
2. **完全不是黑客松产品**，也**完全没有 AI**，"Future Development" 只列到角色/时区过滤与 pitch card。
3. **匹配逻辑未公开**：README 只说 "Other matching logic, such as filtering, exclusions, and scoring, is handled through the backend services."，**具体的过滤/排除/打分规则未获取**。

### 7.3 候选 C：HackMate（GitamHyd/Hackmate）——结构上最接近我们的项目

**优点**
1. **主动放弃"匹配百分比"，改做"编成分析"**：报告团队覆盖了哪些技能领域、缺哪些、**哪些可用的人能补上这些缺口以及为什么**。这与我们禁止"不透明适配分"的立场一致，并且是"缺口互补组队"的一个现成参考。
2. **工作区带"提交清单 + 完整度计量"直到提交**：把"最后能不能交上去"做成了产品内的显式状态——这正是我们规划 32 里的"提交前核对"。
3. **匹配明确不用 AI**（"Deterministic weighted scoring in TypeScript, no AI"），把 AI 预算留给别的功能，工程上更可控。
4. 技术选型干净且可复用参考：Auth.js v5（GitHub OAuth + 邮件魔法链接）、Drizzle + CockroachDB Serverless、Pusher Channels 实时、Vercel Blob/Cron、Zod + RHF + TanStack Query。

**弱点**
1. **极度早期**：3 star，2026-09-18 建仓，2026-10-07 最后 push，**无用户量、无收费、无活跃度证据**；README 自陈"数据库出厂是空的，管理员再发布真实赛事"。
2. **无语音、无 AI**，**未见任何匹配算法细节**（只说"加权打分"，权重与公式【未获取】）。
3. **数据规模与真实运行证据不足**；无测试、无架构文档、无 LICENSE 说明。

### 7.4 关于"语音对话匹配技能互补队友"

- **结论：【未能确认语音匹配归属】。**
- 理由是**证据缺口而非否定**：所有可能相符的页面（Product Hunt、Peerlist、Devpost 的 `hackmatch-rnbufk` 与 `project-draft-kwbj0z`）对本机均返回 **Cloudflare 403**，我无法读取正文；而我**实际抓取成功**的每一个 HackMate 候选页面（hackmate.space 首页+README、GitamHyd README、hackmates.io、ai-hunt.tech 的 HackMates 条目）**全都没有出现语音/voice 相关功能描述**。
- 因此"语音对话匹配"这一条**目前没有可引用的公开证据**。建议后续用可绕过 Cloudflare 的合规方式（例如主会话已有的 REA 浏览器被动观测通道）在真实浏览器里打开 PH / Peerlist / Devpost 页面取证，而不是用抓取脚本硬闯。

---

## 八、证据与来源

**HackerMate（已成功抓取）**

| 来源 | 用途 |
| --- | --- |
| https://hackermate.in/ | 定位、hero、五段流水线、统计数字（499/31/260）、Filters/Ranking/Reasons、Track record、聊天演示、"Free for students"、JSON-LD（含 `sameAs: github.com/HackerMate`）、GA4 `G-48FYFNGHWQ`、Simple Analytics、导航与工作区标签页 |
| https://hackermate.in/faq | 页面标题 "The team operating system for hackathon builders."、免费声明、Instagram 与 `contacthackermate@gmail.com` |
| https://hackermate.in/terms | 法务版本 "Last updated: July 13, 2026"、知识产权归属（用户保留 idea/code 所有权，平台获非独占展示许可） |
| https://hackermate.in/privacy | 收集字段（含 GitHub URL、LinkedIn URL、college）、用途（"To calculate and present builder compatibility metrics."）、明确披露 Supabase / Resend / GA4 |
| https://hackermate.in/partners、/onboarding、/login | 路由存在性（200） |
| https://hackermate.in/robots.txt、/sitemap.xml | 均 404 |

**HackerMate（代码级，`raw.githubusercontent.com` / `api.github.com`）**

| 来源 | 用途 |
| --- | --- |
| `api.github.com/repos/yashshah1211/HackerMate` | 描述、语言、建仓时间、体量 |
| `api.github.com/repos/yashshah1211/HackerMate_Backup` | **homepage = https://hackermate.in**、6,139 KB、2 star / 1 fork、最后 push 2026-10-15 |
| `.../git/trees/main?recursive=1`（两仓库） | 763 文件全树；路由、组件、迁移、文档、qa、scripts 清单 |
| `HackerMate_Backup/README.md` | 定位、功能、Stack 表、路由表、MIT 声明与其自留疑义注释 |
| `HackerMate_Backup/package.json` | 依赖与版本（Next 16.3.5 / React 19.2.4 / Tailwind 4 / Supabase / Sentry / S3 / Resend / Svix / Discord / jspdf / unpdf） |
| `HackerMate_Backup/DEVELOPER_GUIDE.md` | Supabase 迁移与 RLS 流程、Google+GitHub OAuth、`CRON_SECRET`、`RESEND_API_KEY`、沙箱邮件重定向、迁移备份警告 |
| `HackerMate_Backup/vercel.json` | Cron 两条，`30 3 * * *` |
| `HackerMate_Backup/next.config.ts` | 7 条重定向（`/builders`→`/developers` 等）、Sentry 包装、`optimizePackageImports` |
| `.../docs/architecture/matchmaking-v2/DESIGN.md` | 全部匹配公式、决策表、七维分类法、权限边界、检索契约、示例分 44/99、诚实性约束、验证门槛 |
| `.../docs/architecture/matchmaking-v2/SQUAD-MATCHER.md` | Squad matcher 排序指数、权限、容量、旧实现 6 个错误、V3 未暴露与回退、验证记录 |
| `.../src/lib/ai/geminiClient.ts` | Gemini 6 级模型级联、超时约束、密钥变量名 |
| `.../src/lib/github.ts` | GitHub API 拉取与语言占比聚合 |
| `.../src/lib/profileCompleteness.ts` | 资料完整度 5×20 分 |
| `.../supabase/migrations/`（约 150 个文件名） | 功能与安全演进时间线 |
| 说明 | 另确认存在（仅列名未读正文）：`matchmaking-v2/VALIDATION.md`、`matchmaking-v2/blueprint.sql`、`docs/PPT-VISUAL-EVALUATION.md`、13 份 `docs/architecture/*.md`、`qa/browser/*`、`scripts/test-squad-matching.*` |

**HackerMate（搜索摘要，未抓正文）**

- https://devpost.com/software/hackermate-3qnw9s — DecentraHack 2.0 项目页；摘要含 "planned maintenance on Oct 7th 6:00AM UTC" 更新条目（**本机 403，未读正文**）→ 【搜索摘要】
- https://devpost.com/software/hackermate-3qnw9s/updates/839711 → 【搜索摘要】
- https://dev.to/yashshah1211/i-built-hackermate-because-finding-a-hackathon-team-still-sucks-in-2026-2oh2 — **实际已抓取**，见下

**HackerMate（已抓取，独立第三方）**

- https://dev.to/yashshah1211/i-built-hackermate-because-finding-a-hackathon-team-still-sucks-in-2026-2oh2 — 作者 Yash Shah；原文 "It started life as **HackOS** before I rebranded, and it's now live at hackermate.in"；"~35 early users, mostly friends"；列出的赛前/赛中功能；stack 原文 "Next.js (App Router) / Supabase for auth + database / Tailwind CSS with a custom dark design system / TypeScript throughout"

**HackMate（已抓取）**

- https://www.ai-hunt.tech/posts/3ef3f794-f37d-4cc1-8e70-4125e7171361?view_type=weekly — HackMates 条目：定位、Gemini AI 匹配、信誉徽章四级、实时协作、React/Tailwind/Firebase、印度来源、"投票数: 0"
- https://www.hackmate.space/ — "Find Your Perfect Co-Founder"、"App development has been paused as the experiment has been completed."、三条 How it Works、Product Hunt Daily Winner / Featured 证言
- https://raw.githubusercontent.com/dfordp/hackmate-space/main/README.md — 机制、Stack、Redis 键设计、Docker、CONTRIBUTING、MIT
- https://raw.githubusercontent.com/Git-HubCommunityGitamHyd/Hackmate/main/README.md — 定位原文、"composition analysis instead of a match percentage"、工作区、完整技术栈表、"no AI"
- https://hackmates.io/ — 经核实为**安全研究咨询公司**（Amit Serper / Eliad Kimhy），非黑客松产品

**HackMate（403，未获取）**

- https://www.producthunt.com/products/hackmates → 403 `Just a moment...`
- https://www.producthunt.com/products/hackmates/makers → 403
- https://www.producthunt.com/@pavan_0281 → 403
- https://peerlist.io/dfordp/project/hackmate → 403
- https://devpost.com/software/project-draft-kwbj0z → 403
- https://devpost.com/software/hackmatch-rnbufk → 未尝试直接抓取（同域已知 403）

**HackMate（搜索摘要）**

- https://www.producthunt.com/products/hackmates — 标题 "HackMates: AI-powered team matching for your next hackathon" → 【搜索摘要】
- https://www.producthunt.com/p/hackmates/hackmates、https://www.producthunt.com/p/hackmates → 【搜索摘要】
- https://www.producthunt.com/products/hackmates/makers、https://www.producthunt.com/@pavan_0281 — 制造者 Pavan Mali → 【搜索摘要】
- https://github.com/dfordp/hackmate-space?ref=finder.usmans.me、https://peerlist.io/dfordp/project/hackmate — "HackMate \| Peerlist" → 【搜索摘要】
- https://devpost.com/software/hackmate-... / `hackmatch-rnbufk` / `project-draft-kwbj0z` → 【搜索摘要】
- https://www.ijrti.org/papers/IJRTI2504280.pdf — 《Hackomates: Revolutionizing Team Formation Through Skill-Based Test Matching》（**名字不同，为 Hackomates，非 HackMate；未读正文**）→ 【搜索摘要】
- https://github.com/hackmatelabs/hackmate — 302 star 的**黑苹果工具**，非目标 → 【代码级排除】

**GitHub 搜索线索（已成功，用于排除同名噪声）**

- `api.github.com/search/repositories?q=hackermate`、`?q=hackmate&sort=stars`、`?q=hackmate+in:name,description,readme` → 结果清单见 1.2 候选与噪声小节

**未使用的渠道（合规说明）**

- 未使用任何第三方反爬绕过服务（如网页代理/无头浏览器伪装）访问 Cloudflare 403 站点；未登录任何账号；未访问付费或需登录内容。
- `api.github.com` 在会话后段触发**未认证限流（403）**，随后改用 `raw.githubusercontent.com`（不受同一限流）继续取证。

---

## 九、未能确认项

| # | 未能确认的内容 | 原因 / 状态 |
| --- | --- | --- |
| 1 | **"语音对话匹配技能互补队友"属于哪个产品** | **未能确认归属。** PH / Peerlist / Devpost 均对本机 403；所有可抓取的 HackMate 候选页面均无语音描述。**没有证据支持任何归因，不做推测性归属。** |
| 2 | HackMate（用户所指）的官网域名 | 未获取。PH 页面 403，未取得官网链接；`hackmates.io` 已核实为无关的安全公司 |
| 3 | HackMates 的 GitHub / 源码 | 未获取。未找到对应公开仓库 |
| 4 | HackMates 的收费模式与活跃度 | 未获取 |
| 5 | HackMates 的匹配算法细节（权重、模型、数据模型） | 未获取。仅有"由 Gemini AI 依据技术栈/目标/工作风格匹配"一句摘要 |
| 6 | HackMates 信誉徽章（Newbie→Legend）的升级规则与防刷机制 | 未获取 |
| 7 | Devpost `hackmatch-rnbufk` 与 `project-draft-kwbj0z` 的功能正文 | 未获取（403）；仅有主会话转述的标题与功能点 |
| 8 | HackerMate 的 Devpost 项目正文（团队、赛道、技术自述） | 未获取（403）。DecentraHack 2.0 / 作者 Yash Shah / JS·Next.js·Python·Supabase·TypeScript 来自主会话，我未能独立验证 |
| 9 | HackerMate 的 FAQ 各题**答案全文** | 未获取。折叠面板答案未随静态 HTML 下发；我抓到的是首页精简答案（免费那条）与 FAQ 的**问题清单**（含"How does the builder matching & compatibility score work?"），**该题答案正文未获取** |
| 10 | HackerMate 是否已接入 Devpost / Slack | **未获取**。仓库与页面均未见对应集成；Devpost 集成无从验证 |
| 11 | HackerMate 的 `matchmaking-v3` 是否已在生产启用 | 未获取（生产 schema 检查是它的内部记录，我未复现）。SQUAD-MATCHER.md 自述"本地有 V3、生产 PostgREST 未暴露 V3" |
| 12 | HackerMate 的 PostHog 是否真的在生产启用 | 推测**未启用**（首页无 posthog 脚本），但仓库有 `src/lib/posthog.ts`，**未获取**确证 |
| 13 | HackerMate 是否有常规 CI | 推测**没有**（`.github/workflows/` 只有 2 个报表工作流），但**未获取**确证 |
| 14 | HackerMate 的真实用户留存 / 匹配成功率 | 未获取。其 DESIGN.md 明确"clicks alone are not evidence of successful teams"，并建议用随机曝光做无偏校准——**说明连它自己也没有这个数据** |
| 15 | `docs/architecture/matchmaking-v2/VALIDATION.md` 与 `blueprint.sql` 的具体数值与 SQL | 未获取（仅确认文件存在与大小级别，未读正文） |
| 16 | HackerMate 的定价页 / 付费档位 | 不存在可确认的付费档；页面与 FAQ 一致口径为"对学生免费"。**未获取**任何付费证据 |

---

## 十、给主会话的三条直接借鉴（一句话版）

1. **匹配的"诚实性层"照做**：分数 + 证据覆盖率 + 覆盖率低时降级为"探索建议"、禁止百分比成功率措辞、缺数据内部中性插补但对外不显示数字——这条同时满足我们宪法禁止"不透明适配分"的要求。
2. **"缺口互补"用 `min`（全栈 = 前后端同时满足）+ 双向拉黑的正反两向排除 + 返回列白名单（永不返回邮箱）**，这三条是可直接搬的机制；但**不要**抄它的七维向量与 96/桶近似检索（它服务的是 10 万 profile，我们只有几百人，反而该用更硬的真实职责/可用时间事实）。
3. **负面清单优先于正面清单**：它公开的旧实现六大错误（子串匹配、性别/院校加分、编造验证声明、拒绝稀疏资料、假定固定席位数、直接写邀请表）与"前端第二套打分器导致两页不一致"、"本地有迁移但生产未暴露只能靠前端静默回退"，正是我们宪法里"不建立第二份事实/第二套写路径"要防的坑——**把它当作我们评审时的自查清单**。
