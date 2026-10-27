# WaytoAGI Events 竞品调研笔记

- 调研对象：<https://events.waytoagi.com/>（页面标题「WaytoAGI Events · 发现身边的 AI 活动」）
- 调研时间：2026-10-15（UTC，站点页脚 `today` 字段同为 2026-10-15）
- 调研员：竞品调研会话（只读取证）
- 取证方式：**只用源码**（站点自身发布的 HTML / Next.js RSC 内联负载 / 公开静态 JS chunk / `robots.txt` / `sitemap.xml` / `llms.txt`）**与 REA 被动观测**（无头 Edge 155.0.4283.45，CDP `http://127.0.0.1:9224`）
- 边界声明：未注册、未登录、未提交任何表单、未绕过反爬、未安装依赖、未运行目标代码；`robots.txt` 明确 Disallow `/console` `/host` `/me` `/api` `/login` `/forms` `/join/home` `/join/form`，本次**不抓取这些路径的正文**（`/host` 曾因一次误取而落盘，已删除并且下文不引用其内容）；`llms.txt` 明确「报名、票券、个人资料等能力需要手机号登录，请勿抓取或自动提交」，故 `/api/events` **只作为站点自述的接口路径记录，不实际请求**。

标注约定：**【源码级】**＝来自站点已发布的 HTML/负载/JS/文本；**【REA 观测】**＝CDP 被动观测证据；**【未获取】**＝未取得可核对证据。

---

## 0. 一句话结论

WaytoAGI Events 是 **WaytoAGI 社区官方运营的「AI 活动聚合 + 导流/站内报名」单站**（Next.js App Router，腾讯 EdgeOne 托管），**未发现开源仓库**；它的核心能力是「**多城市 / 多形态活动的发现与筛选 + 外部报名导流 + 主办方自助投稿（平台审核）**」，并把「附近」做成**高德地图 + GeoJSON 的视野内列表**。与我们的既有能力对照后：**真正可吸收的缺失机制只有三条**（城市/地点维度的可信呈现、单场活动日历导出、公开页 JSON-LD 结构化投影），**其余大多数机制与我们既有能力冲突或重复**（详见第 3、4 节）。

---

## 1. 身份与形态

### 1.1 谁办的、覆盖什么活动 【源码级】

| 事实 | 证据 |
| --- | --- |
| 出品方：WaytoAGI 社区（通往 AGI 之路） | 页脚 `WaytoAGI Events · 内容由主办方提供，平台审核后发布`；`<meta name="description">`「社区里的 AI 聚会、黑客松、工作坊，在这里发现、报名、拿票入场。WaytoAGI 社区出品。」 |
| 备案 | 页脚 `浙ICP备2023022291号`（链接 `https://beian.miit.gov.cn/`） |
| 联系 | `mailto:contact@waytoagi.com`；页脚 `关于我们 / 联系我们 / 隐私与数据说明`（`/privacy`） |
| 生态 | `https://www.waytoagi.com/zh`、`https://articles.waytoagi.com/`、`/zh/prompts`、`/zh/agents`、X/Twitter、B 站、小红书 |
| 活动规模（首页快照） | 首页 RSC 负载含 **82 条活动记录**；`sitemap.xml` 含 **143 个 URL**：118 个 `/events/...` 详情页 + 19 个 `/organizers/u_...`（**主办方公开主页**）+ 1 个 `/collections/qiecuo1024`（系列活动合集）+ `/` `/tonglu` `/tonglu/skills` `/join` `/join/skills` |
| 内容来源构成 | 82 条中 `origin` = `imported` 43 / `hosted` 39（**平台收录的外部活动 vs 主办方自行发布**，两种来源并存） |
| 活动形态构成 | `eventKind`：meetup 40、conference 16、hackathon 12、other 11、workshop 2、livestream 1 |
| 线上/线下构成 | `eventMode`：offline 70、online 8、hybrid 4 |
| 城市分布 | 上海 48、北京 6、成都 4、深圳 3、杭州 2、大理 2、苏州 1，另有「杭州/宁波/温州」「北京、上海、广州等全国多城」「伦敦」等文本值；**11 条城市为空** |
| 主题标签 Top | WAIC 16、AIGC 11、AI Agent 10、WAIC2026 10、开发者 9、具身智能 9、Side Event 9、AI活动 9、人工智能 8、创业 7、社交 7、黑客松 6 |

结论：覆盖范围是「**AI 活动**」而不只是黑客松——聚会/大会/工作坊/直播都在内，2026 年 7 月 WAIC 期间有大量 Side Event，2026 年 10 月有「切磋大会」全国 30+ 城市分会场合集。

### 1.2 技术栈与托管 【源码级】

| 维度 | 证据 |
| --- | --- |
| 框架 | Next.js App Router（RSC）：`/_next/static/chunks/...`、`self.__next_f.push(...)` 内联负载、路由组 `app/(site)/...`、`app/(campaign)/layout-*.js`；响应头 `x-powered-by: Next.js`、`vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch` |
| 页面类型 | 服务端渲染 + 客户端组件混合；`/events/map` 是纯客户端取数（SSR 负载里没有活动数据） |
| 托管/CDN | 响应头 `server: TencentEdgeOne`、`eo-cache-status: MISS`、`eo-log-uuid`、`nel → https://nel.teo-rum.com/eo-cgi/nel`（腾讯云 EdgeOne Pages） |
| 图片 CDN | `https://cdn-waic.waytoagi.com/covers/*.webp?x-oss-process=image/resize,w_640/format,webp/quality,q_80`（阿里云 OSS + `x-oss-process` 实时处理），且存在服务端图片代理 `/api/images/proxy?url=...`（用于把公众号 `mmbiz.qpic.cn` 图片转成自有域） |
| 统计 | GA4：`https://www.googletagmanager.com/gtag/js?id=G-861F9YGB8L`；自建统计脚本 `https://a.waytoagi.com/script.js`，参数 `data-website-id=f07f9963-13e7-4f6a-92e1-a801eb30962a`、`data-domains=events.waytoagi.com`（Umami 风格） |
| 第三方 SaaS | `https://voice.onenorthdev.com/widget.js` 与 `https://feedlog.onenorthdev.com/widget.js?v=1`，站点级 `businessKey=ovk_…`（反馈/客服类挂件的公开前端标识，已按不得输出密钥的要求打码）；REA 观测确认这些脚本在首页实际加载 |
| 地图 | CSP `script-src` 允许 `https://webapi.amap.com`、`https://*.amap.com`；`connect-src` 允许 `restapi.amap.com`、`vdata.amap.com` → **高德地图 JS API** |
| 无 Cookie 依赖 | REA 存储清单：`local_storage_keys: []`、`session_storage_keys: []`、`indexed_db_names: []`、`cache_names: []`、`usage_bytes: 0`（匿名浏览不落本地存储） |
| CSS 规模 | `/_next/static/css/aa5b69b5bfda6042.css` = 125 077 B（单文件，工具类风格 + `brand-*` 变量、`bg-canvas`） |

### 1.3 登录与身份 【源码级】

- 站点级配置：`{"waytoagiLogin":true,"waytoagiPrimary":true,"waytoagiOnly":true}` → **只允许 WaytoAGI 统一账号登录**，无独立账号体系。
- 登录文案：`手机号登录`、`使用 WaytoAGI 统一账号登录，一次登录通行社区各站`、`输入手机号获取验证码，未注册的号码会自动创建账号`。
- 匿名可用：浏览、筛选、搜索、地图、详情；需要登录：`我的票券`（`/me/tickets`）、`/host`、`/me`、`/inbox`、`/support`。
- 小程序：「同路人」小程序承担**报名、票券、活动提醒**（`/join` 与 `/tonglu` 页给出小程序码入口）。

### 1.4 是否开源 【未获取】

按任务要求先用 GitHub 搜索接口找源码仓库，结果如下（均为 `api.github.com/search/repositories`，只读）：

| 查询 | 结果 |
| --- | --- |
| `q=waytoagi+events` | 1 条，`leopaul29/waytoagi-25102025`（某次黑客松 1.5 小时做的活动提醒小工具，**不是本站**） |
| `q=waytoagi+discover` | 0 条 |
| `q=waytoagi+site` | 0 条 |
| `q=events.waytoagi.com` | 0 条 |
| `q=waytoagi-events` | 0 条 |
| `q=waytoagi`（89 条）/ `q=waytoagi+in:name`（73 条） | 均为社区成员个人练习、CLI、视频模板、知识库 Skill 等，**无本站源码** |
| `q=org:waytoagi` | 仅 1 条：`WayToAGI/WayToAGI_Documents`，许可 **GPL-3.0**，是学习文档库，与本站无关 |
| `q=org:WayToAGI-Community` | 该次请求返回 403（未取得结果，【未获取】） |
| Gitee 搜索 `waytoagi` | 返回 `[]` |
| 页面/JS 内 `github.com` 引用 | 仅出现在 1 条外部活动的报名链接（`https://github.com/M-China-Official/mcd-developer-innovation-challenge`，即麦当劳赛事的官方报名页）和 `polyfills` 脚本注释中，**不含源码仓库地址** |

**结论：没有取得任何可核对的源码仓库或许可证据，按「未开源」处理**；`github.com` 与 `raw.githubusercontent.com` 直连在本机网络超时（`UND_ERR_CONNECT_TIMEOUT`），仅 `api.github.com` 可达，因此也无法用仓库 HTML 进一步排查。【未获取】

REA 观测证据（本次唯一一次 Web 观测，用于交叉核对路由与脚本来源）：
- `list_browser_targets` → `ev_5021cb984d57afe7f63688d80424ab14200eee5920a3f22d968e7d138c62ecff`
- `inspect_web_page`（`include_script_sources:false`，`observation_ms:1200`）→ `ev_165bcd494e80833546c1799c54689696693a14eb02681089b434070bc3ae15ff`
- 观测到的可访问路由（DOM href，`destination_scope: approved`）：`/`、`/host`、`/host/new`、`/me/tickets`、`/events/map`、`/collections/qiecuo1024`、`/privacy`、`/llms.txt`、`#discover`

---

## 2. 活动发现的字段与机制

### 2.1 活动卡片字段（首页 RSC 负载，82 条记录逐字段取值）【源码级】

| 字段 | 含义 | 取值/示例 | 备注 |
| --- | --- | --- | --- |
| `id` | 活动 ID | `e_8f4b2bb4ca` | 稳定短 ID |
| `title` | 活动标题 | `Anker 首届黑客松挑战赛` | |
| `city` | 城市 | 上海/北京/成都/深圳/杭州/大理/苏州；**11 条为空** | 城市值不完全规范化（有「杭州/宁波/温州」「杭州市」） |
| `date` | 开始日期 | `2026-09-07` | 日期型，无时区 |
| `endDate` | 结束日期 | `2026-10-17` 或空 | 多日活动 |
| `time` | 具体时段文本 | `晚上`、`16:30-18:30`、`18:30 till late`、`13:30 - 17:30` | **自由文本**，不是结构时间 |
| `venue` | 场馆/地址文本 | `深圳BREWTOWN雪花啤酒小镇` | 可与 `city` 拼接展示（详情页做 `城市 · 场馆`） |
| `lat` / `lng` | 经纬度 | 33/82 条有值，如 `22.582982,113.921748` | 仅用于地图 |
| `slug` | 语义化别名 | 多数为空 | 详情 URL 生成用 |
| `createdAt` | 录入时间 | `2026-09-07T07:13:12.440Z` | |
| `displayPriority` | 置顶 | `pinned`（1 条） | 人工置顶 |
| `featured` | 精选 | 82 条全为 `$undefined` | 字段存在但未使用 |
| `eventKind` | 活动类型 | meetup / conference / hackathon / workshop / livestream / other | 6 值枚举 |
| `eventMode` | 线上线下 | offline / online / hybrid | 3 值枚举 |
| `tags` | 标签数组 | `["黑客松","AI Native","安克创新","硬件创新","WaytoAGI","开发者"]` | 自由标签 |
| `capacity` | 名额 | `100`、`30`…；57 条为空 | 空即不限/未知 |
| `organizerName` | 主办方 | `麦当劳 × WorkBuddy`；多数为空 | |
| `full` | 是否满员 | 82 条全 `false` | 卡片显示「已满员」「限 N 人」 |
| `externalRegUrl` | 外部报名链接 | 飞书表单、GitHub 仓库页、峰会官网 | 直接外跳 |
| `externalMpLink` / `externalMpQrImage` | 公众号原文链接 / 二维码图 | | 用于「查看活动原文」 |
| `origin` | 来源 | `imported`（平台收录）/ `hosted`（主办方发布） | 与「平台审核后发布」呼应 |
| `regMode` | 报名模式 | `external` 57 / `display_only` 14 / `station` 10 / `external_mp` 1 | **核心机制字段** |
| `cover` / `coverFallback` / `coverFit` / `coverCrop` / `coverOrigin` / `coverCard` | 封面与裁切参数 | `cover` 带 OSS 处理参数 | 仅展示 |

**没有发现的字段（重要）**：`费用 / 价格 / 票价 / price / offer` **在卡片、详情页 JSON-LD、详情 HTML 中均不存在**（全站抓取样本内 0 命中）；**没有报名截止字段在卡片上**（报名截止只在详情页展示）；**没有嘉宾/speaker 结构化字段**（「嘉宾」只出现在搜索框占位文案里）。

### 2.2 活动详情页字段与机制 【源码级】

同一详情页（`/events/{slug}-{id}`，旧 `{id}` 链接 301/重定向）包含：

1. **schema.org/Event JSON-LD**（每页 1 个 `application/ld+json` 块）：

```json
{"@context":"https://schema.org","@type":"Event",
 "name":"ClawHunt 上海黑客松",
 "description":"…（长文，保留 Markdown 记号）",
 "startDate":"2026-10-30","endDate":"2026-11-01",
 "eventAttendanceMode":"https://schema.org/OfflineEventAttendanceMode",
 "eventStatus":"https://schema.org/EventScheduled",
 "location":{"@type":"Place","name":"36 SPACE · 上海市徐汇区","address":"上海 36 SPACE · 上海市徐汇区"},
 "image":["https://cdn-waic.waytoagi.com/covers/336af0b85996074b.jpg"],
 "url":"https://events.waytoagi.com/events/clawhunt-上海黑客松-e_68f515d808"}
```

主办方发布的场次（`hosted`）额外带 `"organizer":{"@type":"Organization","name":"WaytoAGI 杭州站"}`；平台收录的场次没有 `organizer`。**JSON-LD 不含 `offers`/价格**。

2. 详情页可见字段：`活动时间`（`周二 · 14:00-16:00`，日期换算成周几）、`活动地点`（`杭州 · 云谷中心 B1 梦想启航港`）、`报名截止`（如「已截止」）、`主办方`、`议程`（分段日程）、`活动介绍`（长正文 + 图片）、标签条（`工作坊 / 线下 / 视频 / 开源模型 / 内容创作 / 多模态`）。
3. 地点外跳：`在高德地图搜索该地址`、`在 Apple 地图搜索`、`打开位置地图`、`导航到这里：高德 · 百度`（**只是把 `venue` 文本丢给地图站搜索，不是官方坐标**）。
4. 日历导出：详情页负载含 `icsHref`、`googleHref`（**.ics 下载 + 加入 Google 日历**，未见站内文案）。
5. 分享：`copyPayload`、`sharePagePath`、`channel`（分享渠道参数）。
6. 站内报名场次（`regMode=station`）额外字段：`requireApproval`（主办方人工审核）、`full`、`isOnline`、`nextStepAvailable`、`registrationCollection`。

### 2.3 三种报名模式的实际文案（决定「报名还是只导流」）【源码级】

| `regMode` | 条数 | 详情页原文/机制 |
| --- | --- | --- |
| `station`（站内报名） | 10 | 站内报名 + `requireApproval` 人工审核 + 名额 + 我的票券（门票归小程序/`/me/tickets`） |
| `external`（外部报名） | 57 | `本活动使用主办方自有渠道报名，点击按钮前往主办方报名页` → `去报名` 外跳（飞书表单、官网、GitHub 仓库页） |
| `display_only`（只展示） | 14 | `本活动为平台收录的外部活动，报名方式请见活动原文（如原文中的报名二维码/链接）或联系主办方，本站不提供站内报名与票券` → `查看活动原文` |
| `external_mp`（公众号导流） | 1 | 结合 `externalMpLink` / `externalMpQrImage` 指向公众号原文/二维码 |

**结论：主体是导流（57 + 14 + 1 = 72/82 ≈ 88%），站内报名只占 10 条**，且站内报名有主办方审核与票券/核销闭环。

### 2.4 筛选与排序维度 【源码级】

首页（`chunk-site-page.js` 内的 UI 字符串与 aria-label）提供：

| 维度 | 选项 | 证据 |
| --- | --- | --- |
| 活动时间 | `活动时间筛选` 选项卡：`推荐 / 即将开始 / 进行中 / 已结束`、`往期 / 全部` | aria-label `活动时间筛选`、`role="tablist"` |
| 日期 | `按日期筛选` 日历：`上个月 / 下个月 / 清除日期` | aria-label `按日期筛选` |
| 城市 | `按城市筛选`（`全部城市` + 每城计数） | aria-label `按城市筛选`；`options: cities.map(([name,count])=>...)` |
| 活动类型 | `按活动类型筛选`：`全部类型 / 聚会 / 黑客松 / 工作坊 / 大会 / 直播 / 其它` | 同 chunk 中文字符串 |
| 活动形式 | `按活动形式筛选`：`线上/线下`、`不限形式` | 同上 |
| 标签 | 侧栏 `标签` 多选按钮 + `全部标签` | 首页 HTML `标签` 面板 |
| 排序 | `排序方式`：`按日程`（默认）/ `最新添加` | `allLabel:"按日程", options:[{value:"newest",label:"最新添加"}]` |
| 搜索 | `搜索活动`，占位 `搜活动名称 / 城市 / 场地 / 主办方 / 嘉宾`；实现是 `fetch("/api/events")` 后**客户端过滤** | `layout-*.js`：`fetch("/api/events").then(...).then(e=>{e.ok&&v(e.items)})` |
| 分页 | `加载更多活动`、`显示更多（剩余 N 场）` | 首页 chunk 中文字符串 |
| 视图 | `列表视图 / 网格视图 / 日历视图 / 地图` | 首页 chunk 中文字符串 |

注意：**筛选、排序、搜索都在客户端完成**（全量事件一次性取到前端），服务端只提供列表 JSON。

### 2.5 地理维度（「附近/城市」）【源码级】

这是本站最完整的地理机制，分两层：

1. **城市层**：卡片 `city` 字段 + 「按城市筛选」+ 详情页 `活动地点`。粒度是**城市名文本**，不是坐标。
2. **地图层**：`/events/map`（`活动地图`），页面副标题 `按位置发现值得见面的活动，拖动地图即可更新附近列表。`
   - 客户端逻辑（`app/(site)/events/map/page-83c25caac4973904.js`）：
     - `fetch("/api/amap/js-config")` → 若 `configured:false` 显示「地图暂未启用」；否则注入高德 JS API 脚本（`key` + `securityCode` 由服务端下发）
     - `fetch("/api/events/geojson")` → `GeoJSON FeatureCollection`（`features`）
     - 用高德建图 → **按当前视野 bounds 过滤**，显示「视野内 N 场」
     - 地图内筛选：`时间筛选（全部时间/即将开始/往期）`、`城市筛选（全部城市）`、`标签筛选（全部标签）`、`重置`
     - 空态/降级文案：`暂无带地理位置的已发布活动`、`地图加载失败…网络或地图服务暂不可用，活动列表仍可浏览`、`重新加载`、`当前视野内没有匹配的活动`、`仍可使用列表视图浏览全部活动`
     - 卡片缺时间/地点时显示 `时间待定 / 地点待定`
   - **经纬度只覆盖 33/82 条**（有坐标才能上图）。

### 2.6 API 路径清单

| 路径 | 来源 | 说明 |
| --- | --- | --- |
| `GET /api/events` | `llms.txt` 自述 + `layout-*.js` 实调用 | 已发布活动结构化列表（无需鉴权）。**本次未请求**（`robots.txt` Disallow `/api`，`llms.txt` 要求勿抓取） |
| `GET /api/events/{id}` | `llms.txt` 自述 | 单场活动 JSON。**本次未请求** |
| `GET /api/events/geojson` | 地图 chunk 实调用 | 地图用 GeoJSON。**未请求**（同属 `/api`） |
| `GET /api/amap/js-config` | 地图 chunk 实调用 | 下发高德 key/securityCode；`configured:false` 表示未配置。**未请求** |
| `GET /api/images/proxy?url=` | 首页/详情 HTML | 站内图片代理（把公众号图片转自有域）；在 `display_only` 场次的 JSON-LD `image` 中出现 |
| `POST /api/support-tickets`、`/api/support-tickets/`、`POST /api/auth/logout`、`POST /api/csp-report` | `layout-*.js`、响应头 `reporting-endpoints` | 反馈工单、登出、CSP 上报 |

### 2.7 公开数据与 AI 友好层 【源码级】

`/llms.txt`（1845 B，站点自发布文本，本次完整读取）要点：

```
WaytoAGI（通往 AGI 之路）社区的 AI 活动平台：发现、报名、主办线下/线上的 AI 活动（聚会、黑客松、工作坊、大会、直播）。
活动内容由主办方提供、平台审核后发布。
本站对 AI 阅读友好：已发布活动数据公开可浏览，活动详情页内嵌 schema.org/Event JSON-LD。
报名、票券、个人资料等能力需要手机号登录，请勿抓取或自动提交。
- 发现活动: 全部已发布活动，支持按城市、日期、类型、标签筛选
- 活动地图: 按地理位置浏览附近活动
- 发布活动 (/host/new): 主办方提交活动，粘贴文宣可由 AI 自动生成活动草稿
- 管理活动 (/host): 主办方的报名审核、数据概况与现场核销工作台
- 公开数据: /api/events（GET，无需鉴权）、/api/events/{id}
```

另有 `robots.txt`（Allow `/`，Disallow 见边界声明，声明 Sitemap）与 `sitemap.xml`（143 URL = 118 活动 + 19 主办方主页 + 1 合集页 + 5 个其它页）。其它路由：`/tonglu`（同路人计划）、`/tonglu/skills`（AI 技能图鉴）、`/join`、`/join/skills`、`/forms/cobuild`（共建报名）、`/forms/partner`（合作洽谈）、`/forms/opc`（一人公司意向登记）、`/organizers/{u_...}`（**主办方公开主页**，sitemap 收录 19 个）、`/collections/{slug}`（系列活动合集页，如 `/collections/qiecuo1024` --- 切磋大会全国 30+ 会场 + 六大赛道 + 城市/会场选择器 + `/collections/{slug}/register`）、`/privacy`。**`/forms/*` 与 `/collections/*/register` 正文未取**（`/forms` 被 robots Disallow；合集页只读了 `/collections/qiecuo1024` 的公开正文）。

### 2.8 主办方侧（发布与核销）【源码级，仅站点自述】

- `/host/new`：`主办方提交活动，粘贴文宣可由 AI 自动生成活动草稿`（**AI 生成草稿**能力，正文未取）。
- `/host`：`主办方的报名审核、数据概况与现场核销工作台`（正文未取，robots Disallow）。
- 页脚统一声明：`内容由主办方提供，平台审核后发布` → **投稿 + 平台审核**是明确的产品承诺。

---

## 3. 与我们既有能力的对照

### 3.1 我们已有的（对照时逐条核对过的代码位置）

| 能力 | 我们的实现 |
| --- | --- |
| 赛事自动发现 + 来源证据 | `src/server/discovery.ts`（`sources[{url,title,excerpt,fetchedAt,sourceKind}]`、`registrationWindow{status,closesAt,closesOn,evidence,checkedAt}`、`eventWindow`）、`src/modules/operations/discovery-worker.ts`、`src/server/dsh-backend.ts`；卡片字段另有 `analysis{fit,risks,preparation,unknowns}`、`registration`、`participation` |
| 公开赛事页 | `src/app/(site)/events/page.tsx` → `src/components/event-discoveries.tsx`（`EventDiscoveryFeed`：报名状态（`报名已结束/报名未截止/报名时间需重新确认`）、报名截止、开赛时间、来源折叠、未读全文标注、游标分页；**无城市/类型/形式筛选，无地图/日历视图**） |
| 已发布规则与筛选 | `src/modules/events/service.ts`（`listEvents({query, region, format, phase, ...})`，`format ∈ online/offline/hybrid/unknown`）、`metadata{name, organizer, format, region, officialUrl}`（`domain.ts`）→ **地域/形式在既有数据模型里已有，只是公开发现页没有用起来** |
| 树状路线图 | `/journey`（`src/modules/journey/`） |
| 灵感/资源库 | `/inspiration`（`src/server/inspiration.ts`、`inspiration-catalog`）、`/resources`（M09）、`/library`、`/skills`（M10） |
| 团队空间 | M02 `projects` + 团队空间画布/任务/文档（`src/modules/space-*`、`src/components/space-*.tsx`） |
| 主办方入驻/多赛事 | M01–… `src/modules/organizer/`（`createEvent`、模板 `online/onsite/practice`、模块开关 `registration/teams/icebreaking/judging/schedule/accommodation/mealVouchers`）、`src/server/organizer-claims.ts`（**认领需授权材料核验**） |
| 报名与审核 | `src/modules/event-registration/`（报名表、人工审核、名额、名单/队伍） |
| 通知与沟通 | `src/modules/event-communication/`（公告/通知/私人求助、行程 `schedule`、住宿 `accommodation`、**餐券发放/凭证/人工核销**，凭证只存 SHA-256、幂等键、操作员回执） |
| 评审 | `src/modules/event-judging/`（指派、开轮冻结、校准与隔离自检、越权留痕、人工公布） |
| 社区纠错入口 | `src/modules/operations/correction-*.ts`：`target.kind ∈ "event" \| "resource"`、`field/message/evidenceUrls`、状态 `triaging/resolved`、`EventCorrectionPanel`；**社区成员已经可以提交带证据的赛事纠错并进入运营队列** |
| 站内检索 | `src/server/site-search.ts` / `site-search-sources.ts`（discoveries + resources + skills + inspiration 聚合检索）；导航员讲解 `navigator` |
| 来源路径排除规则 | `src/server/discovery-sources.ts` L92：来源 URL 路径含 `/collections`、`/month`、`/city`、`/resources` 等**列表/合集页直接跳过**（不能证明单场赛事） |

### 3.2 真实缺失、且不冲突的机制候选（建议吸收）

#### 候选 A：公开赛事页的「城市 / 地点」维度（城市级，不含地图）【证据：源码级】

- 竞品位置：卡片 `city` + 「按城市筛选」+ 详情 `活动地点` + `在高德地图搜索该地址 / 在 Apple 地图搜索`（`chunk-site-page.js`、`event-station.html`、`event-clawhunt.html` 站内字符串）；`llms.txt`「支持按城市、日期、类型、标签筛选」。
- 我们的真实摩擦点：公开赛事页**完全无法按地点筛选**，而线下赛事的地点是新人第一筛选项；`event-discoveries.tsx` 只展示报名/开赛字段。我们的 `participation` 模块里已经有 `city`（个人参赛计划/天气）与 `location` 概念（`service.test.ts`: `location:"北京", city:"北京"`），说明地点是我们需要但**没有呈现在发现层**的事实。
- 为什么不重复：不新增事实表，也不新增入口——把**已抓取正文中出现的城市/场馆文本**作为带证据字段（与 `registrationWindow` 同一套 `evidence` 证据模式），缺证据就显示「地点待确认」，绝不由模型补写；筛选复用既有列表控件与我们自己的样式。
- 落地要点：`discovery.ts` 卡片增加 `location{ city, venue, evidence[] }` 一类字段（证据来自 `sources[].excerpt`），`registrationWindow` 的校验模式可整体复用；公开页加「城市」下拉（`全部城市` + 计数）。
- 证据要求：城市/场馆必须能在 `sources[].excerpt` 里逐字命中；只允许外层地图**查询链接**（`https://www.amap.com/search?query=<venue文本>`）且仅在 `venue` 有证据时展示，并标注「在外部地图搜索该地址」，不得声称是官方坐标。
- 风险控制：不要引入 `lat/lng`（见 3.3-C）。

#### 候选 B：单场赛事的日历导出（.ics / 加入日历）【证据：源码级】

- 竞品位置：详情页负载字段 `icsHref`、`googleHref`（`event-station.html`、`event-clawhunt.html` 的 detail payload keys）。
- 我们的真实摩擦点：我们有大量时间事实（报名截止 `registrationWindow`、开赛 `eventWindow`、`stages[]`、行程 `schedule`），但用户只能回到站内看；本机已有明确时区处理（`useRuleDisplayTimeZone`、`reg/plan` 的时区换算），生成 ICS 的条件已具备。全仓 `grep "\.ics|text/calendar|加入日历"` **0 命中** → 确实缺失。
- 为什么不冲突：ICS 是**只读派生文件**，不是第二份事实、不写库、不新增入口（对比 3.3-D 判不做的日历**视图**）。
- 证据要求（硬约束）：只在 `registrationWindow.status` 有证据且不是 `unknown` 时导出对应时刻；`unknown` 时**不生成**（宁可不导出，也不导出未经核验的时间）；文件里带上来源链接与「以主办方公告为准」。

#### 候选 C：公开赛事页输出 schema.org/Event JSON-LD【证据：源码级】

- 竞品位置：每个活动详情页 1 个 `application/ld+json`（`@type: Event`、`name/description/startDate/endDate/eventAttendanceMode/eventStatus/location/image/url/organizer`）+ `llms.txt` 明示「活动详情页内嵌 schema.org/Event JSON-LD 结构化数据，可直接解析」。
- 我们的真实摩擦点：全仓 `grep "ld\+json|schema\.org"` **只命中 JSON-Schema（AI 输出 schema），没有页面级结构化数据**；我们公开页大量内容对搜索/AI 不可解析。
- 为什么不冲突：纯投影，用**已核验字段**（`metadata.name/officialUrl/format/region`、已发布 `stages`、有证据的报名/开赛窗口），未知字段直接省略（`eventStatus` 只输出 schema 允许的语义，报名状态不要硬塞进 `eventStatus`）。不新增事实、不新增写路径、不影响视觉。
- 证据要求：只输出 `evidence` 能支撑的字段；`unknown` 一律省略而不是填默认值。

### 3.3 冲突／不做（每条写明碰到了哪些既有能力）

| 竞品机制 | 证据位置 | 碰到的既有能力 | 判定 |
| --- | --- | --- | --- |
| **A. 活动地图（高德 + GeoJSON + 视野内列表 + 经纬度）** | `map/page-*.js`（`/api/amap/js-config`、`/api/events/geojson`）；CSP 允许 `webapi.amap.com`；卡片 `lat/lng` 33 条 | ①AGENTS「不采购或发布外部服务」——高德 JS API 需 key/securityCode 与域名备案；②新增 `lat/lng` 事实需要地理编码，属"第二份事实/编造"高风险；③把访客位置送第三方地图 | **不做**（只保留候选 A 的**城市文本**维度；城市筛选不需要地图与坐标） |
| **B. 站内报名 + 主办方审核 + 票券 + 现场核销** | `regMode=station` 字段 `requireApproval/full/isOnline/nextStepAvailable/registrationCollection`；`/me/tickets`；`llms.txt`「报名审核、数据概况与现场核销工作台」 | `src/modules/event-registration/`（报名表/人工审核/名额/名单）＋ `src/modules/event-communication/logistics.ts`（餐券类型/发放/凭证哈希/人工核销/幂等键/操作员回执）＋ `organizer` 模块开关 ＋ `schedule` 行程；AGENTS 已明确「场馆三件套判为不做」 | **冲突，不做**（我们更强：凭证只存哈希、核销幂等、留操作员记录） |
| **C. 任何登录用户发布活动（`/host/new` 自助投稿）** | 首页 CTA `发布活动`；页脚「内容由主办方提供，平台审核后发布」；`origin=hosted` 39 条 | `organizer.createEvent` + `organizer-claims.ts`（认领须授权材料核验）＋ M03 人工审核发布（`publicationStatus`）＋ 纠错队列边界；开放任意账号发布 = 绕过主办方资格与 M03 审核 | **冲突，不做**（可吸收的部分见 3.4） |
| **D. 日历视图（第三种列表视图）** | 首页 chunk：`列表视图 / 网格视图 / 日历视图 / 地图` | `/journey` 树状路线图 + M05 时间窗口/规划 + 报名/开赛窗口；AGENTS「多时区调度已判不做」 | **冲突，不做**（第二套时间入口；只保留候选 B 的一次性 ICS 导出） |
| **E. AI 从粘贴文宣生成活动草稿** | `llms.txt`「粘贴文宣可由 AI 自动生成活动草稿」 | `operations/deepseek-harness.ts` 的固定 `purpose` 白名单（`event_discovery/event_extraction/event_analysis/navigator`）、无工具受限子进程、只做抽取并要求逐字 `evidence`；宪法「事实不能编」；主办方录入已有规则确认流程 | **冲突，不做**（要新增模型任务类型与"AI 生成事实"写入路径） |
| **F. 活动类型枚举（聚会/黑客松/工作坊/大会/直播/其它）** | `eventKind` 6 值 + `按活动类型筛选` | 产品范围是"黑客松/赛事发现"（M03 已有 `stageType`、`format`）；引入全类型会改变产品边界与首页语义 | **不做**（若要扩范围须先改产品边界，不是本轮机制吸收） |
| **G. 站内搜索（名称/城市/场地/主办方/嘉宾）与 `/api/events` 全量客户端筛选** | `layout-*.js` 占位文案 + `fetch("/api/events")` | `site-search.ts`（discoveries/resources/skills/inspiration 聚合检索）＋ 导航员；新增搜索入口 = 第二搜索入口、第二份检索口径 | **冲突，不做**（可考虑在既有检索里补已核验字段，不新建入口） |
| **H. 反馈工单 + 消息收件箱（分类/未读/上限/对话）** | `layout-*.js`：`/api/support-tickets`、`/inbox`、`/support`、`意见反馈（建议/活动问题/报名问题/其他）` | 资源反馈能力 ＋ M08 `corrections`（`kind=event/resource`、证据 URL、`triaging/resolved`）＋ 主办方通知/公告 ＋ 审计与导出 | **冲突，不做**（重复入口；纠错队列已覆盖"用户反馈事实错误"） |
| **I. 手机号登录 / WaytoAGI 统一账号 SSO** | `waytoagiLogin/waytoagiPrimary/waytoagiOnly:true`、登录文案 | 我们已有登录（观猹 OAuth + 邮箱关联页、`GUANCHA_LOGIN_ENABLED` 服务端配置）；新增身份 provider = 新凭据与外部依赖 | **不做** |
| **J. 微信小程序（报名、票券、活动提醒）** | `/join`、`/tonglu` 的小程序码入口 | AGENTS「不采购或发布外部服务」 | **不做** |
| **K. 系列活动合集 + 多城分会场（`/collections/{slug}`、城市/会场选择器、`/collections/{slug}/register`）** | `collections/qiecuo1024` 正文：30+ 城市会场、六大赛道、`我要参加`、`collections/qiecuo1024/register`；`sitemap.xml` **已收录该路径** | `discovery-sources.ts` L92 **已明确把 `/collections` 这类列表/合集路径排除**在来源之外；我们已有「官方赛道 `officialTracks`」「多赛事同机构」「行程」三套语义，再加一层"合集/会场"分组即是第二套分组事实；且 `/collections/{slug}/register` 会是第二套报名入口 | **不做**（作为来源已被排除是明确的既有决定） |
| **M. 主办方公开主页（`/organizers/{u_...}`，sitemap 19 个）** | `sitemap.xml`；首页/详情页 `主办：…` | 我们已有 `src/app/(site)/organizers` 与 `organizers/workspace`（主办方主页 + 工作台）＋ `organizer-claims` 认领核验 | **已有，不做**（最多核对既有主页是否展示同一套已核验字段） |
| **L. 视觉与信息密度层：hero 轮播（`data-hero-showcase`）、多列瀑布流（`data-discovery-col`）、`brand-*` 色彩与 Tailwind 工具类外观、卡片圆角/阴影/动效** | 首页 HTML `data-hero-showcase-count="5"`、`data-discovery-col`、`aa5b69b5bfda6042.css`（125 KB） | 我们的暖白 #FFFDF8 + 橙红令牌与既有组件体系 | **不照搬（视觉一律用我们自己的）** |

### 3.4 专项：它是否把「活动发现」做成社区众包/投稿？（对应任务第 4 问）

| 问题 | 结论（含证据） |
| --- | --- |
| 是否有"社区成员发布活动"的路径？ | **有，但发布者身份是"主办方"而不是任意社区成员**：首页导航 CTA `发布活动 → /host/new`，页脚声明 `内容由主办方提供，平台审核后发布`；`origin` 字段区分 `hosted`（39 条，主办方提交）与 `imported`（43 条，平台收录）。`/host/new`、`/host` 正文因 `robots.txt` Disallow 未取 → 是否仅需登录即可提交【未获取】，但站点把入口文案写成"主办方提交活动"。 |
| 社区成员的真实贡献入口是什么？ | 不是活动条目，而是：`/forms/cobuild`（共建报名）、`/forms/partner`（合作洽谈）、`/forms/opc`（一人公司意向登记）、`/join`（同路人注册/小程序/日报）、`意见反馈`。即**"共建/合作表单"**，与"发布一场活动"是两条不同路径。 |
| 活动发现本身是众包的吗？ | **不是**。发现的供给来自两处：主办方投稿（审核后发布）＋ 平台/运营收录外部活动（`imported`，84% 的活动是外部渠道导流）。**没有看到"用户提交某场外部活动线索 → 审核 → 收录"的公开路径**（未取得 `/console` 等后台路径证据，robots Disallow）。 |
| 与我们的差异 | 我们是 **DSH 自动发现 + 人工审核**；他们更偏 **人工收录 + 主办方自助投稿**。我们比他们多一条"社区纠错"（`corrections`，带证据 URL，`kind=event`）——注意这已经是一条**受控的众包路径**，只是用途是"纠错"而不是"投稿新活动"。 |

**判定**：把"任意用户发布活动"引入 = **不做**（见 3.3-C）。若要吸收众包的部分，正确做法是**复用既有纠错队列**（`corrections`，`kind=event`，要求证据 URL，运营 triage），把入口文案从"纠错"扩到"提供线索/纠错"，**不新增发布权限、不新增第二份赛事事实、不新增第二个审核队列**。

---

## 4. 视觉声明（硬约束）

- 本次调研**不建议、也不会照搬任何竞品视觉**：不引入其 `brand-*` 色阶、Tailwind 工具类外观、hero 轮播、多列瀑布流密度、卡片圆角/阴影/动效参数、深色模式切换逻辑。
- 若采纳候选 A（城市维度）与候选 B（ICS 导出），实现一律使用**我们自己的暖白 `#FFFDF8` 与橙红令牌**、既有表单控件/列表密度/折叠面板与文案口吻（「…待确认」而非「未知」）。
- 竞品的 `列表/网格/日历/地图` 视图切换属于视觉与信息架构层，**已判不做**（见 3.3-D、3.3-A）。

---

## 5. 未获取项（明确列出，避免当成已核实）

1. **源码仓库与许可**：GitHub 搜索无果，直连 `github.com`/`raw.githubusercontent.com` 超时 → **无法确认是否开源**；按未开源处理。
2. **`/api/events`、`/api/events/{id}`、`/api/events/geojson`、`/api/amap/js-config` 的真实响应结构**：`robots.txt` Disallow `/api`，`llms.txt` 要求勿抓取 → 只记录路径与用途。
3. **`/host`、`/host/new`、`/me`、`/login`、`/forms/*`、`/console` 页面正文**：robots Disallow → 「AI 生成活动草稿」「现场核销工作台」的**具体字段与流程未取证**，仅为站点自述。
4. **服务端实现**：数据库 schema、服务端语言细节、EdgeOne 的构建产物来源（GitHub/Gitee/其它 CI）未取得。
5. **小程序内部**：报名/票券/提醒的数据结构与核销流程未取得。
6. **`q=org:WayToAGI-Community`**：该次 GitHub 搜索请求返回 403，未取得结果。
7. **报名表单实际内容**：未打开任何飞书表单（只记录其 URL 出现在 `externalRegUrl`）。

---

## 6. 给主会话的决策建议（一句话版）

1. **可吸收（低风险、纯派生、无新事实）**：候选 A 城市/地点维度（带 `sources[].excerpt` 证据 + 外层地图搜索链接）、候选 B 报名/开赛 .ics 导出（未知状态不导出）、候选 C 公开页 schema.org/Event JSON-LD（只输出已核验字段）。
2. **明确不做（冲突或已有）**：地图与经纬度、站内报名/票券/现场核销、任意用户发布活动、AI 生成活动草稿、日历视图、活动类型枚举扩张、第二搜索入口、反馈工单/收件箱、手机号登录/统一账号 SSO、小程序、系列活动合集与多城会场、主办方公开主页（已有 `/organizers`）。
3. **若要吸收"众包"成分**：只把入口文案从"纠错"扩展到"提供线索/纠错"，**复用既有 `corrections` 队列**（`kind=event`，强制证据 URL，运营 triage），不新增发布权限与第二份事实。

---

## 附：本次全部只读请求清单（可复核）

| 请求 | 结果 |
| --- | --- |
| `GET https://events.waytoagi.com/` | 200，220 269 B（含 RSC 负载，`.runtime/waytoagi/home.html`） |
| `GET /robots.txt` | 200，247 B |
| `GET /sitemap.xml` | 200，36 927 B，143 个 `<loc>`（118 活动 + 19 主办方主页 + 1 合集 + 5 其它） |
| `GET /llms.txt` | 200，1 845 B |
| `GET /events/map` | 200，53 684 B |
| `GET /collections/qiecuo1024` | 200，174 873 B |
| `GET /join`、`GET /tonglu` | 200，43 086 B / 57 938 B |
| `GET /events/<clawhunt 上海黑客松>` | 200，85 116 B（JSON-LD 取证） |
| `GET /events/e_4f35845c7d`（`station` 样本） | 200，98 746 B |
| `GET /events/e_fb161a5869`（`display_only` 样本） | 200，88 800 B |
| `GET /_next/static/chunks/**`（22 个 chunk，含 `app/(site)/page`、`app/(site)/layout`、`app/(site)/events/map/page`） | 全部 200 |
| GitHub `search/repositories`（10 次查询，见 1.4） | 见 1.4 表 |
| Gitee `api/v5/search/repositories?q=waytoagi` | 200，`[]` |
| REA：`list_browser_targets` + `inspect_web_page`（CDP 9224，无头 Edge 155.0.4283.45） | 见 1.4 证据 ID |
| 其它 | 一次性响应头探测、`HEAD`-级请求头检查 |

原始落盘缓存（本地，未纳入版本控制）：`.runtime/waytoagi/`（`home.html`、`map.html`、`collections.html`、`join.html`、`tonglu.html`、`event-*.html`、`rt_*.txt`、`llms.txt`、`chunks/`）。
