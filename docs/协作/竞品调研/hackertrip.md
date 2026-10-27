# 竞品调研：HackerTrip（CLI + Skills / Haki 桌面助手 / 线上站）

- 调研日期：2026-10-15（UTC）
- 调研方式：**只读**。未安装依赖、未运行任何目标代码、未执行构建、未 clone、未注册登录、未提交任何表单、未绕过反爬。
- 记号约定：**【源码级】**＝读到制品/仓库源码原文；**【REA 观测】**＝REA 被动观测线上站所得；**【未获取】**＝本次未取得可核对证据，不作任何推断。

---

## 0. 三句话结论

| 对象 | 核心机制一句话 | 与我们最相关的能力 |
| --- | --- | --- |
| **hackertrip-cli（npm `hackertrip@1.3.0`）** | 本地扫仓库算"画像"，服务端取赛事列表做**本地字符串打分**；所有写操作都 POST 到腾讯云 CloudBase 云函数，本地**没有**活动/项目/作品的多文件数据模型 | 单条命令提交活动前的**字段级本地自检 + 一次性列出全部问题**；失败错误码可操作 |
| **HackerTrip Skills** | 只有 2 个 skill（选手发作品 / 主办方提活动），装到 `~/.claude/skills`；"4 道准入门槛"**只存在于 skill 提示词，不在代码里** | 准入/自检规则的**表述方式**；但会与 M10 安装记录冲突 |
| **Haki 桌面助手（`maliuyi63-bot/Haki`）** | Tauri2 无边框悬浮条，读**本机** `~/.claude/projects` 日志算 token、读 git 算 commit、把聚合统计上报到 `hackertrip.space/api/desktop/stats` 换"AI 协作能力"展示 | Token 报告长图是**纯前端 canvas**；但整体涉及"过程数据→能力评分"，与我们禁止项直接冲突 |

**一句话身份结论**：HackerTrip 是"赛事聚合站 + 小程序 + 命令行/桌面客户端"三件套；**官网与云函数源码均未公开**，两条客户端（CLI、Haki）是**开放源码的采集/提交端**，本身不含服务端与数据库实现。

---

## 1. 取证路径（含本机网络限制，重要）

本机网络实测（`Test-NetConnection` 443）：

| 主机 | 结果 |
| --- | --- |
| `github.com` / `raw.githubusercontent.com` / `objects.githubusercontent.com` / `codeload.github.com` | **不可达（连接超时）** |
| `api.github.com` | **不可达** |
| `cdn.jsdelivr.net` / `cdn.statically.io` / `rawcdn.githack.com` | 可建连，但取这两个仓库的文件**全部超时** |
| `registry.npmjs.org` / `npmjs.com` | **可达** |
| `hackertrip.space` | **可达** |
| `gh-proxy.com` / `ghproxy.net` | **可达**（本次主力取证通道） |

因此本次用到的三条真实通道：

1. **npm registry**：`https://registry.npmjs.org/hackertrip` → tarball `https://registry.npmjs.org/hackertrip/-/hackertrip-1.3.0.tgz`
   （`fileCount: 18`、`unpackedSize: 115987`、`shasum: a6d70237178352e5add5ce1623664e602714cce0`）
2. **gh-proxy 转发 raw**：`https://gh-proxy.com/https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>`
3. **gh-proxy 转发 GitHub API**：`https://gh-proxy.com/https://api.github.com/repos/...`（仓库元数据与完整文件树）

REA 仅用于线上站：无头 Edge + CDP `127.0.0.1:9223`（用完已杀，复核残留进程 0、CDP 已关）。

本机留存的可复核证据目录（未提交、属临时材料）：`.runtime/competitor-hackertrip/`
（`v130/`＝npm 1.3.0 解包，`cli/`＋`cli2/`＝GitHub master 取件，`haki/`＝Haki 取件，`fetch.mjs`＝取件脚本）

---

## 2. 数据模型：活动 / 项目 / 作品是一份还是多份文件？

### 2.1 选手与主办方**都没有本地多文件数据模型**【源码级】

`bin/hackertrip.mjs`、`lib/*.mjs` 全文读过：CLI **只碰两个数据文件**，且都不是"活动/项目/作品"实体存储：

| 文件 | 位置 | 作用 | 证据 |
| --- | --- | --- | --- |
| `data/hackathons-bundled.json` | 随包分发（**种子数据**，15 条） | API 与缓存都拿不到时的兜底赛事列表 | `lib/fetch-hackathons.mjs:10,36-39,67-71` |
| `~/.hackertrip/cache/hackathons.json` | 用户目录单文件缓存，**TTL 24 小时** | 缓存 API 结果 | `lib/fetch-hackathons.mjs:6-7,20-34,61-65` |

补充事实：

- **项目画像不落盘**：`scanProject()` 每次现场计算 `{name, techStack[], keywords[], description}` 后直接进内存（`lib/scan.mjs:320-422`、`416-421`），没有"项目"文件。
- **作品不是文件**：作品对象在 `publish-work` 内联构造，只作为一次 POST 的 body（`lib/publish-work.mjs:144-152,173-188`），字段为
  `{name, summary, repo, demo, cover, techStack[], awards, processStats?}`。
- **活动不是文件**：`submit-event` 把字段拼成 `event` 对象后 POST（`lib/submit-event.mjs:105-120,205-212`）。
- **本地唯一"状态"是环境变量**：`HACKERTRIP_API / SYNC_URL / SYNC_TOKEN / SYNC_CODE / EVENT_URL / OPS_URL / OPS_TOKEN`（`bin/hackertrip.mjs:14-17`、`lib/submit-event.mjs:11-14`、`lib/ops.mjs:13-15`）。

**种子数据的活动 schema（15 条记录的字段并集）**【源码级】：

```
name, shortName, startDate, endDate, city, country, mode,
theme, tracks[], techStack[], tags[], prizePool,
website, summary, location, registrationDeadline, isPast
```

两点值得注意（对我们有直接参考价值，均为负面对照）：

1. **没有来源/证据字段**：没有"来源 URL 之外"的任何来源身份、获取时间、原文快照或证据行；`website` 常被填成第三方媒体页（如第 2 条 `https://www.ithome.com/0/931/094.htm`）。
2. **`isPast` 是存量字段而非派生**：`lib/display.mjs:23-33` 的 `statusBadge()` **同时**使用存下来的 `h.isPast` 和现场算的天数，口径不一致；且 15 条 seed 全部 `isPast: true` 但含 2026-06/2026-08 的日期，说明是**静态快照**、不会自更新。

### 2.2 服务端 / API：**两个公开仓库都不含服务端**【源码级】

完整文件树（`git/trees?recursive=1`，均 `truncated: false`）：

| 仓库 | 文件数 | 有无服务端/数据库/迁移 |
| --- | --- | --- |
| `Jayden72Huang/hackertrip-cli` | **28** | 无（`bin/ lib/ data/ packages/` 共 4 个目录） |
| `maliuyi63-bot/Haki` | **54** | 无（`app/ prototype/ scripts/`；Rust 侧只有 Tauri `#[tauri::command]`，全部打向外部 HTTP） |

服务端**只能从客户端代码反推契约**（以下均为【源码级】的客户端侧事实，服务端实现本身属【未获取】）：

| 端点 | 方法 / 头 | 请求体 | 期望响应 | 证据 |
| --- | --- | --- | --- | --- |
| `https://hackertrip.space/api/match?limit=50` | GET，无鉴权 | — | `{hackathons:[...]}` | `bin/hackertrip.mjs:14`；`lib/fetch-hackathons.mjs:41-56` |
| `$HACKERTRIP_SYNC_URL`（pairSync，CloudBase） | POST，`x-sync-token` | `{action:"push", pairCode, scan{source,syncedAt,project{...}}, works?[], card?}` | `{ok:true,...}` | `bin/hackertrip.mjs:55-99,116-128`；`lib/publish-work.mjs:173-203`；`haki/app/src-tauri/src/lib.rs:1320-1345` |
| `$HACKERTRIP_EVENT_URL`（eventSync） | POST，`x-sync-token` | `{action:"submit"\|"status", pairCode, event}` | `submit`→`{ok,id,status}`；`status`→`{ok,items:[{name,status,statusText,submittedAt,missing[],note}]}`；失败→`{ok:false,code,message,missing[]}` | `lib/submit-event.mjs:205-239`；`lib/event-status.mjs:72-112` |
| opsReviewSync（CloudBase） | POST，`x-ops-token` | `{action:"export"\|"apply"\|"getHackathon"\|"findHackathons"\|"updateHackathon", ...}` | 见 ops 各子命令 | `lib/ops.mjs:34-49,75,103,119,126,141` |
| `https://hackertrip.space/api/desktop/stats` | POST，`Authorization: Bearer ht_live_*` | `{periodDays, totals{tokens,output,sessions,activeDays,activeMinutes,edits}, skills[], models[], projects[], clientVersion}` | 任意 JSON | `haki/app/src-tauri/src/lib.rs:1044-1078` |
| `https://hackertrip.space/api/desktop/auth?state=&port=` | GET（浏览器） | — | 回环回调 `?key=ht_live_*&state=` | `lib.rs:1084-1178` |
| `https://hackertrip.space/api/pair/code` | POST，Bearer | `{}` | 6 位绑定码（10 分钟） | `lib.rs:1181-1189`；文档 `haki/MANUAL.md:198` |

两个**默认值里暴露的实现细节**：

- 运营接口默认地址指向**测试环境**：`https://test-1-d8gn28apcbf409627.service.tcloudbase.com/opsReviewSync`（`lib/ops.mjs:13-14`）。
- 后端栈：腾讯云 CloudBase 云函数（pairSync / eventSync / opsReviewSync）+ Vercel 上的 Next.js 站点。

### 2.3 线上站：数据走 Next.js RSC，**未观测到公开 REST 数据 API**【REA 观测】

REA 会话（`capture_browser_scenario`，connect 到既有 target，goto `/explore`，观察 3.5s）：

- 保留 **325** 条网络事件；**没有任何 `/api/*` 请求**。
- 赛事数据来自 Next.js **RSC 预取**：`GET /hackathon/<uuid>?_rsc=...`、`/hackathon/theme/ai?_rsc=...`、`/hackathon/city/suzhou?_rsc=...`、`/hackathon/city/nanjing`、`/hackathon/city/singapore`（响应头含 `x-nextjs-prerender`、`x-vercel-cache`、`x-matched-path`）。
- 封面图在 **Cloudflare R2**：`pub-d7a436bb140a401a98a2b96d1850d970.r2.dev/hackathons/covers/...`
- 站点身份：`Server: Vercel`；存在 Google Analytics `G-7JLBTD2NCG`；字体 `sora` / `spaceMono`（自托管 woff2）。
- 首页 `inspect_web_page`：DOM 1936 节点，localStorage / sessionStorage / IndexedDB **全空**（匿名首访），无 WebSocket、无 WebMCP 工具、无 worker。

路由清单（DOM 链接 + `llms.txt` 声明）：`/`、`/explore`、`/hackathon/<uuid>`、`/hackathon/collections`、`/works`、`/organize`、`/haki`、`/haki-desktop`、`/whitepaper`、`/methodology`、`/docs`、`/guides/2026-ai-hackathon-guide`、`/about`、`/contact`、`/privacy`、`/terms`、`/#skills`、`/#subscribe`、`/llms.txt`。

> `llms.txt` 属**站点自述文本**，本次只取"路由清单"与"它声明了源码仓库"这两个可交叉验证的事实，**不把其中任何功能描述当机制证据**。

### 2.4 官网源码仓库：**声明存在，实测不存在**【未获取】

`llms.txt` 声明 `Source repository: https://github.com/Jayden72Huang/hacker_trip`，实测：

```
GET https://api.github.com/repos/Jayden72Huang/hacker_trip
→ 404 {"message":"Not Found","status":"404"}
```

（对照：同通道下 `Jayden72Huang/hackertrip-cli` 与 `maliuyi63-bot/Haki` 均 200，证明 404 是"真的没有"而不是通道故障。）

因此以下全部**【未获取】**：服务端路由实现、数据库 schema、云端二次校验的真实规则、审核台（小程序「主办方后台」）实现、`/api/match` 的真实响应体、云函数鉴权实现。**本笔记不对这些内容做任何推断。**

---

## 3. CLI 命令清单与校验规则【源码级】

版本口径：下引行号以 **npm `hackertrip@1.3.0`** 为准（`shasum a6d70237…`）。**GitHub `master` 比 npm 1.3.0 旧**：`lib/publish-work.mjs` 5527 B vs npm 7042 B，GitHub 版**没有** `process-stats`（无 `--no-process-stats`）；`bin/hackertrip.mjs` 9980 B vs 10331 B。两侧 `README.md`、两个 `SKILL.md`、`data/hackathons-bundled.json` 字节一致。

`KNOWN_COMMANDS`（`bin/hackertrip.mjs:19`）：`match / publish-work / submit-event / event-status / event / install-skills / ops / help`。

### 3.1 命令总表

| 命令 | 做什么 | 校验什么 | 失败处理 | 证据 |
| --- | --- | --- | --- | --- |
| `match`（默认命令） | 扫本地项目 → 取赛事列表 → 本地打分排序 → 打印 Top 8 | 无必填；`--path` 不存在时 `scanProject` 各读取静默失败（`tryReadFile` 返回 null），得到空画像仍继续 | 赛事列表为空 → 打印提示后 `exit(0)` | `bin:135-161`；`lib/scan.mjs:75-81`；`lib/display.mjs:48-86` |
| `match --sync` | 把扫描结果 + Top5 匹配 + 配对码推到小程序 | `syncUrl` 必填、`syncToken` 必填、`pairCode` 必须 `/^\d{6}$/` | 缺 URL 只**打印提示**并正常返回（不抛）；缺 token/码不合法 → `throw` | `bin:101-133` |
| `publish-work` | 扫项目取默认值 → 采集过程数据（可选）→ 上传作品到个人主页 | `pairCode` 6 位；`syncUrl`、`syncToken` 必填；`checkWork`：名称必填、**repo 或 demo 至少其一**、repo/demo/cover 若给必须以 `http(s)://` 开头 | 收集**全部**问题一次性打印 → `exit(1)`，**不发请求** | `lib/publish-work.mjs:107-115,120-161` |
| `submit-event` | 把活动提交到平台草稿箱 | `pairCode` 6 位；`checkEvent`：必填 `name/city/start/end/website`、日期 `^\d{4}-\d{2}-\d{2}$`、`start ≤ end`、website `^https?://` | 同上：列全问题 → `exit(1)` **不发请求**；服务端码 `BAD_PAIR` / `INVALID_FORM` / `INVALID_FORMAT` 分别给引导 | `lib/submit-event.mjs:123-144,174-193,223-241` |
| `event-status` | 查自己提交过的赛事审核状态 | `pairCode` 6 位；`eventUrl`、`syncToken` 必填 | 逐项 `exit(1)`；服务端 `ok:false` 打印 message/code | `lib/event-status.mjs:48-98` |
| `event status` | 两段式别名 | 同上 | 同上 | `bin:261-264` |
| `install-skills` | 把 `packages/{player,organizer}/skills` 拷到 `~/.claude/skills` | 已存在默认**跳过**，`--force` 覆盖；`--dest` 自定义 | 源目录不存在 → 打警告继续 | `lib/install-skills.mjs:46-85` |
| `ops`（`list/approve/reject/get/find/fix`） | 运营内部：待审队列、过审/拒绝、查赛事、模糊搜、定向改字段 | 必须有 `HACKERTRIP_OPS_TOKEN`，否则 `UNAUTHORIZED` | `call()` 统一抛错 | `lib/ops.mjs:34-49,73-143` |

`ops` 的草稿状态机（`lib/ops.mjs:17-25`）：`pending_review / pending_manual_review / security_review / security_rejected / rejected / resubmitted / approved`。
`ops fix` 的白名单字段（同文件 `:138`）：`website/registrationUrl/registrationQrImage/registrationDeadline/summary/location/prizePool/theme` 等。

### 3.2 选手侧"扫项目"的真实机制【源码级】

`lib/scan.mjs` 共 **10 个输入源**，全部是**本地文件读取 + 正则/查表**，**没有模型调用**：

| # | 输入 | 产出 | 行号 |
| --- | --- | --- | --- |
| 1 | `package.json` 的 deps+devDeps → `TECH_MAP`（约 110 条依赖→技术名） | techStack | `:4-37,83-101` |
| 2 | `requirements.txt` → `PY_TECH_MAP` | techStack（含 `Python`） | `:39-50,103-112,336-340` |
| 3 | `pyproject.toml` `[project.dependencies]` | 同上 | `:114-122,342-346` |
| 4 | `Cargo.toml` / `go.mod` / `Gemfile` / `pubspec.yaml` | Rust / Go / Ruby / Flutter + 少量特征 | `:124-137,349-359` |
| 5 | `CLAUDE.md`（18 组正则技术名 + 关键词） | techStack + keywords | `:206-231,362-367` |
| 6 | `.env.example` / `.env.sample`（按变量名含 STRIPE/OPENAI/AWS…） | 服务集成 | `:233-250,370-373` |
| 7 | `README.md` / `README`（`KEYWORD_PATTERNS` 命中 + 首个非标题段落截 200 字当 description） | keywords + description | `:52-73,200-204,376-383` |
| 8 | 目录信号（`project.config.json`+`miniprogram`、`cloudfunctions`、`contracts`/`hardhat`/`foundry.toml`、`models`/`notebooks`、Dockerfile、`ios`/`android`、`prisma`…） | techStack | `:252-288,386-387` |
| 9 | 入口文件前 40 行 import（**命中第一个文件即 `break`**） | Three.js / Animation / LLM / Web3 / Video | `:290-318,390-391` |
| 10 | 微信小程序（`project.config.json`、`miniprogram/app.json`、`cloudfunctions/`） | WeChat Mini Program / CloudBase / TDesign… | `:147-198,394-408` |

### 3.3 匹配打分的真实算法【源码级】——"AI 语义匹配"的语义部分是**硬编码同义词表**

`lib/match.mjs`：

- **同义扩展** `SEMANTIC_EXPAND`（`:1-30`，约 27 个键，含中文词），例如 `Three.js → [XR,VR,AR,3D,空间计算,元宇宙,WebGL,沉浸式,可视化]`、`LLM → [AI,人工智能,大模型,智能,NLP,GPT,agent,对话]`。
- **重合判定** `setOverlap`（`:36-49`）：归一化（去除非字母数字与汉字）后要求长度 ≥2；完全相等即命中；子串匹配**仅当较短者 ≥3 字符**。
- **打分权重**（`:109-160`）：

| 维度 | 上限 | 规则 |
| --- | --- | --- |
| 技术栈重合 | 50 | 每命中 1 项 +10 |
| 关键词/赛道重合 | 30 | 每命中 1 项 +6 |
| 时间加成 | 10 | 距截止 >30 天 +10；>7 天 +7；>0 天 +3 |
| 奖金加成 | 10 | >10 万 +10；>1 万 +7；>0 +4 |
| 总分 | 100 | `Math.min(score,100)` |

- 过滤 `score > 0`，按分降序 `slice(0,8)`（`:163-166`）。
- **`parsePrize` 的已知缺陷**（`:94-104`）：先判 `includes('万')` 再判 `includes('百万')`，因此 **「百万」分支是死代码**（永远被「万」先截获，`100万` 得到 100×10000 而非 100×1000000）；`$`/`USD` 固定按 ×7 折算人民币。
- **推荐赛道兜底**（`findBestTrack`，`:62-92`）：无重合时先在 `theme` 里找包含赛道名的，再兜底 `tracks[0]`——即**一定给一个赛道**，哪怕毫无依据。

> 结论：官方对外说"AI 语义匹配"，源码里 `match` 路径**没有任何模型调用**，是"同义词表 + 子串重合 + 启发式加分"。这是**营销表述与源码不一致**的实例，也再次印证我们"机制必须源码级取证"的规矩。

### 3.4 主办方"一条命令提交活动"的校验与失败处理【源码级】

**必填四件套 + 配对码**（`lib/submit-event.mjs:16`、`hackertrip-cli/README.md:122`）：`name + start + end + city + website`，外加 `--pair-code`。

本地校验 `checkEvent()`（`:123-144`）逐条产出**人类可读问题字符串**：

1. `REQUIRED = ['name','city','start','end','website']` 任一缺失 → `缺少必填字段：<key>`
2. `DATE_RE = /^\d{4}-\d{2}-\d{2}$/`，`start`/`end` 不符 → 报告当前值
3. `event.start > event.end`（**字符串直接比较**，在 `YYYY-MM-DD` 下等价于日期比较）→ `start 不能晚于 end`
4. `URL_RE = /^https?:\/\//i`，website 不符 → 要求 `http(s)://`

失败处理（`:174-193`、`:223-241`）：

- 校验不过 → **打印全部问题 + 一句规则摘要，`exit(1)`，不发任何请求**（关键设计：不做"提交后再被拒"）。
- 缺 `eventUrl` / `syncToken` → 分别 `exit(1)`。
- 服务端拒绝按码分流：`BAD_PAIR` → 引导回小程序重新生成提交码；`INVALID_FORM` / `INVALID_FORMAT` → 复述同一条字段/格式规则；再打印 `code / message / missing[]`。
- 成功后明确告知语义边界："**已提交到 HackerTrip 草稿箱，平台审核通过后上架**"，并打印 draft id 与 status（`:215-220`）。
- **没有**重试、退避或幂等键；身份就是那次 6 位配对码。

**`--from` 文件解析**（`:78-103`）支持两种格式，属"顺手"设计：
JSON，或"md 友好"的 `key: value` / `key=value`（会剥掉行首 `- *`、`**`，跳过 `#` `//` 注释行）。
合并顺序：文件是基底，命令行同名参数覆盖（`:105-120`）。`tracks` 支持 `,` `\n` `，` `、` 分隔（`:68-75`）。

**注意一处"规则只活在提示词里"**：`packages/organizer/skills/HackerTrip-submit-event/SKILL.md:82-99` 定义了 **4 道准入门槛**（门槛1 必须是真黑客松，排除算法评测/路演/训练营/作品征集/DemoDay/内部赛/长期常驻赛；门槛2 未过期且核对年份；门槛3 数字属实；门槛4 核心字段齐）——这 4 道 **在 CLI 与云函数代码里都不存在**，仅由 skill 提示词要求模型自行执行。

---

## 4. Skills 清单【源码级】

| Skill | 归属包 | 触发语（SKILL.md `description`） | 关键约束 |
| --- | --- | --- | --- |
| `HackerTrip-publish-work` | `packages/player` | "帮我把黑客松作品发到 HackerTrip" | 名称必填 + repo/demo 至少一个 `http(s)`；同步后进「待审核」，**必须用户在小程序预览确认点『发布』才公开**（用户自审）；配对码 30 分钟一次性 |
| `HackerTrip-submit-event` | `packages/organizer` | "帮我把这个黑客松发到 HackerTrip"（可附海报图） | 4 道准入门槛 + 格式自检；提交进"绑账号草稿"由平台人工审核；奖金/日期不确定**如实留空不编造** |

**一个明确的缺口**：主办方 skill 三处声称复用 `HackerTrip-hackathon-intake`（`SKILL.md:11`「批量采集第三方赛事入库（那是平台运营侧的 `HackerTrip-hackathon-intake`）」、`:82`「复用 hackathon-intake 标准」、`:84`「直接引用」），但该 skill **既不在 npm tarball 的 18 个文件里，也不在 GitHub 的 28 项文件树里**（`packages/organizer/skills/` 下只有 `HackerTrip-submit-event`）。即：**被引用的上游标准从未随包分发**，那 4 道门槛目前是"复制粘贴的自述"。

`install-skills` 的安装语义很薄：`cpSync` 递归复制，已存在跳过，`--force` 覆盖（`lib/install-skills.mjs:62-74`）——**没有版本、兼容性、校验或安装回执**。

---

## 5. Haki 桌面助手的真实能力（只从源码看）【源码级】

身份（`api.github.com/repos/maliuyi63-bot/Haki` + `git/trees`）：public、`main`、TypeScript、**0 star / 0 fork**、创建 2026-08-22、最后推送 2026-08-23、体积 334 KB、**54 项文件树**、license `null`。技术栈 Tauri 2（Rust 后端 + vanilla-ts 前端）。`MANUAL.md:3` 自述对应分支 `feat/race-mode-cli-assist`（2026-08-22）。

### 5.1 悬浮窗（配置即事实）

`app/src-tauri/tauri.conf.json`：`productName: "HackerTrip"`、`identifier: com.hackertrip.desktop`、`version 0.1.0`、`macOSPrivateApi: true`、`security.csp: null`，窗口：

```json
{"width":660,"height":380,"resizable":false,"decorations":false,
 "transparent":true,"alwaysOnTop":true,"skipTaskbar":true,"shadow":false}
```

高度靠前端 `fitWindow()` 按 `scrollHeight` 自适应、**上限 620**（`ITERATION.md:176-179`）。`MANUAL.md:235` 说明"不进 Dock 任务栏"。

### 5.2 Token 用量来源（唯一来源：本机 Claude Code 会话日志）

`usage_today()`（`lib.rs:57-…`）：

- 目录 `~/.claude/projects/<项目目录名>`；目录名规则＝项目绝对路径把非字母数字替换成 `-`（`lib.rs:40-42`、`process-stats.mjs:40-42`）。
- 只扫 **mtime ≥ 48 小时前** 的 `.jsonl`；逐行快速跳过不含 `"usage"` 的行。
- 过滤 `type == "assistant"` 且有 `message.usage`；**去重键 `message.id + (requestId | uuid)`**（应对流式重复写入）。
- 累加 `input_tokens / output_tokens / cache_creation_input_tokens / cache_read_input_tokens`；`sessionId` 计会话数。
- "今天"边界＝**本地时区零点换算成 UTC 字符串**后做前缀比较（`lib.rs:42-55`），`MANUAL.md:61` 明确要与 `git --since=midnight` 口径一致。
- `profile_stats(days)`（`lib.rs:1036-1041`、`collect_profile_stats` 起 `:845`）是同一套解析的 N 天版本，另产出：`edits`（数 `Edit/Write/MultiEdit/NotebookEdit` 的 `tool_use`）、`skills`（数 **Skill 工具的调用名**，Top 30，`:913`、`:1002-1007`）、`models`（按 token，`:1009-1013`）、`projects`（按日志里的 `cwd` 聚合，再 `git config --get remote.origin.url` 取仓库名，Top 20，`:979-1000`）、`trend`（按天）。

独立的 `scripts/claude-usage.mjs`（不进应用）另做"按模型/按天/按项目"聚合与**预估费用**，价格表硬编码（`opus 15/75/18.75/1.5`、`sonnet 3/15/3.75/0.3`、`haiku 1/5/1.25/0.1`，未知模型按 opus 估，`:26-36`），自述"仅作参考，不作计费依据"。

**额度（5 小时/每周）不是自己算的**：`rate_limits()` 只读外部 daemon 落下的 `~/.vibe-usage/{claude,codex}-rate-limits.json`（`lib.rs:1361-1381`）。且**该命令没有被前端调用**（见 5.6）。

### 5.3 比赛陪伴（赛程规划 + 现场问答 + 提醒）

机制是**调用用户本机已登录的 `claude` CLI**，不配 API Key：

- `run_claude(prompt)` = `claude -p <prompt>`，且显式 `.stdin(Stdio::null())`——因为不给 stdin 时 CLI 会白等 3 秒（`lib.rs:679-692`，坑记录见 `ITERATION.md:134-136`）。
- `plan_hackathon(name,start,end,doc)`（`lib.rs:709-747`）把主办方文档原文塞进提示词，要求输出**纯 JSON** `{"milestones":[{"at","title","action","critical"}]}`，约束：`at` 落在比赛区间内（报名/材料类可早于开始）、`critical=true` **只给错过无法挽回的硬节点**、**文档里写明的时间原样保留**、6–10 个节点升序、`action` 要具体。返回前用 `extract_json()` 剥 ```json 围栏或截取首 `{` 到末 `}`（`:694-706`），再 `serde_json` 校验，失败时回报"原始输出前 300 字"。
- `ask_hackathon(question,name,doc,milestones)`（`:749-777`）：文档 + 已排节点作上下文，要求"3 句内、文档有就引原文、文档没写就明说『文档里没写』再给建议、不要客套话"。
- 提醒（`MANUAL.md:130-133`、`ITERATION.md:24`）：`critical` 提前 30 分钟、普通节点到点推；**已提醒的按 `at` 存 localStorage 去重**，且只在跨过触发点的 **2 分钟窗口**内触发（避免开机一次性弹全部过期节点）。
- 所有比赛配置、清单勾选存 **localStorage**（`lib.rs:1383-1384` 注释明说"比赛配置、清单勾选等存 localStorage，这里暂不需要"）。

### 5.4 交作品（与本仓库 CLI 同一条链路）

- `extract_work(path)`（`lib.rs:1226-1290`）：拒绝非目录；`git rev-parse --show-toplevel`；`remote get-url origin` 经 `remote_to_https()` 转换（因为小程序端 `isHttpUrl` 硬校验会拒 `git@github.com:...`，见 `ITERATION.md:138-140`）；README 取前 6000 字、`package.json` 前 1500 字、`git log -15 --format=%s`；三者皆空则报错。提示词要求纯 JSON `{name,summary,repo,demo,techStack[],cover}`，**明确"拿不准就留空，不要编造链接"**；返回后**用本地 git remote 覆盖模型给的 repo**（`:1281-1284`），并把 `localPath` 一起塞进返回值。
- `push_work(sync_url,sync_token,pair_code,work)`（`:1297-1359`）：校验三件（url 非空、token 非空、码为 6 位数字），POST pairSync，`source: "hackertrip-desktop"`，成功提示"已上传，去小程序「我的 → 作品」确认发布"。
- 两套配对码**不能混用**（`ITERATION.md:142-147`、`MANUAL.md:164`）：`request_pair_code` → `/api/pair/code` 是**网站账号↔小程序绑定**；交作品用的是**小程序「我的 → Skills 同步」**的 6 位码 + `x-sync-token`。作者自述"一开始接错成前者，作品数据根本没上传"。
- 小红书：**只到文案生成 + 自动复制 + 唤起创作页**，最后一步手动粘贴（`MANUAL.md:171`、`ITERATION.md:64-68`）。

### 5.5 报告长图如何生成（纯前端 canvas）

- 入口 `app/index.html:152-161`：「生成 Token 报告 · 长图」按钮 + `<img id="u-report-img">` 预览 + 「保存长图」。
- 数据：`profile_stats(14)`（前端 `main.ts:506`）；`activeProfile()` 取当前 profile。
- **文案本地规则生成**：`reportInsights(p)`（`main.ts:773-805`）从数据里抽四段（总量/会话/活跃日、峰值日、主要消耗的项目+模型、按输出占比给一条省 token 建议）——**不依赖模型，一键即出**。
- 绘制 `drawTokenReport(p, insights)`（`main.ts:807-1150`）：`canvas` 宽 **1120**、`PADX 96 / PADY 88`，高度由固定板块高预计算（header 200 / metrics 300 / trend 360 / rank 320 / insight 60+n×86 / footer 200）；配色**深色** `BG #060608` + 白系文字 + 点缀色（作者注明"采样自参考图"）：橙 `#f09000`、绿 `#30c080`、蓝 `#6090f0`、紫 `#8b4fe8`、粉 `#e05a8c`；四张指标卡（总 Tokens / 总输出 / 活跃会话 / 代码编辑）＋ 趋势 ＋ 排行 ＋ insights ＋ 页脚"报告编号 `HKT-YYYYMMDD`"。
- **页脚的二维码是占位**：`main.ts:1132-1136` 注释即写"二维码占位（绘制一个简单标识）"，只画了个简单标识，没有真实二维码。
- 导出：`cv.toDataURL("image/png")` → `invoke("save_report_image", {dataUrl, filename})`（`main.ts:1186-1218`）。Rust 侧 `save_report_image`（`lib.rs:1391-1426`）**剥掉 `data:image/png;base64,` 前缀 → base64 解码 → 写 `~/Downloads/<name>.png`**，文件名做白名单过滤（只留字母数字/中文/`-_. `，去行首 `.`，缺省 `haki-token-report.png`）以**防路径穿越**；失败返回明确错误。
- 真实数据快照样例：`prototype/usage-summary.json`（10326 B，脚本产出）。

### 5.6 源码级"说了但没接上"的清单（与描述的重要差异）

`main.ts` 中实际 `invoke` 的后端命令**只有**：`usage_today`、`dev_today`、`running_agents`、`agent_status`、`profile_stats`、`save_report_image`、`extract_work`、`push_work`、`ask_hackathon`、`plan_hackathon`、`github_login`、`request_pair_code`、`sync_profile`（`main.ts:199,200,209,217,506,1206,1704,1759,1782,1815,1852,1875,1910`）。

`lib.rs:1453-1471` 注册但**前端从未调用**的有：

| 命令 | 状态 | 证据 |
| --- | --- | --- |
| `ai_daily_summary` | **"AI 每日总结"是占位**：`generateSummary()` 在 5 条硬编码模板里循环，代码注释明写"等接回真实生成时，把 `generateSummary` 改回 `invoke ai_daily_summary` 即可" | `main.ts:1242-1259` |
| `token_report` | 注册了"把 token 统计交给本地 claude 生成人话报告"的命令，但**前端没接**（长图的文字走本地规则 `reportInsights`） | `lib.rs:1428-1446` vs `main.ts` 无调用 |
| `rate_limits` | 注册了读 `~/.vibe-usage/*` 额度快照，但**前端没接** | `lib.rs:1363-1381` vs `main.ts` 无调用 |
| `app_meta` | 注册，未在 `main.ts` 检出调用 | `lib.rs:1384-1389` |

其它**作者自述的未完成/未验证**（`ITERATION.md:164-179`、`MANUAL.md:254-260`）：拖拽提取**未真机验证**（最后一次构建因**本机磁盘满**中断，`cargo check` 与 `npm run build` 通过）；「使用量」tab 未做；窗口不可缩放。

因此，**仓库描述里的"一键 Token 报告长图"成立（canvas 手动一键、纯本地）**；但 **"比赛陪伴"里的每日 AI 总结是占位**，"赛后数据报告自动生成/可分享"在源码里**没有自动触发、也没有分享或真实二维码**。

### 5.7 身份歧义（必须记录）

站点作者名下另有一个**独立且更大**的桌面应用：`Jayden72Huang/haki-desktop`（**由 `hackertrip-desktop` 改名而来**）——Rust、创建 2026-08-12、最后推送 2026-08-25、体积 **5490 KB**，描述"Haki — 黑客松桌面搭子：像素小人实时播报 agent 状态，比赛倒计时/赛程节点/用量计量/commit 履历一条悬浮条搞定"。官网亦有 `/haki-desktop` 页。

而本次点名的 `maliuyi63-bot/Haki`（另有作者，2026-08-22 创建）描述为"HackerTrip 桌面助手"。**两个"桌面助手"存在**；本笔记第 5 节结论**只对 `maliuyi63-bot/Haki`**，`haki-desktop` 仅取元数据、源码**【未获取】**（超出点名范围）。

---

## 6. 与既有功能的冲突检查（按规划 32 §4.0 吸收闸门三问）

三问＝① 解决我们哪个真实摩擦点 ② 会碰到哪些既有能力 ③ 如何避免重复入口 / 第二份事实 / 第二套写路径。

### 6.1 判定"不做"——与既有功能冲突

| 候选（竞品做法） | ① 我们的真实问题 | ② 碰到的既有能力 | ③ 冲突风险与决定 |
| --- | --- | --- | --- |
| **本机 agent Token 用量 + commit 履历 → "AI 协作能力评估"**（`Haki lib.rs:845-1034`、`sync_profile`→`/api/desktop/stats`） | 我们没有"个人投入度"类数据 | `assessments/scoring-rules.ts` 反分数崇拜条款；`M06 github` 仓库事实；`M10 skills` 技能记录 | **决定：不做**。它把**本机过程数据**变成**能力评分/跨人可比**，直接撞我们禁止项「不透明适配分与跨人排名」与"不给能力百分比/匹配度/排名"；同时新增 commit 时间戳/行数类仓库事实＝与 M06 边界冲突（与规划 32 §11.4 对 TechBurn 的判定同型）。 |
| **Git 提交监控 + 45 分钟未提交告警**（`lib.rs:604 dev_today`、`MANUAL.md:96`） | 我们有"防丢代码"的真实需求 | M06 `CommitData` 只有 `sha/treeSha/parents/message`（规划 32 §11.4 L201 已核实）；M05 持久提醒 + `planning-notifications` | **决定：不做**。要做得先采集提交时间戳＝**第二份仓库事实**；再加一套提醒入口＝**第二套提醒/待办**。 |
| **提交材料清单打勾（4 项，localStorage）**（`MANUAL.md:187`、`lib.rs:1383`） | 新人到截止才发现差东西（＝规划 32 §4.2 已认定摩擦点） | `space-workflow` 待办、`github` 交付与运行验证、`event-judging` 正式收件快照与回执 | **决定：不做"本地打勾清单"**。它正是规划 32 §4.2 已禁止的"第二套完成状态"。要解决同一摩擦点，只能走已定调的**纯派生只读视图**（不新增状态列）。 |
| **CLI 一条命令提交活动到第三方平台**（`submit-event`） | 主办方发布活动要少几步 | O01–O06 已交付的报名/通知/规则能力；宪法禁止项 | **决定：不做**。这是**对外写入型 API + 代提交**，撞两条禁止项（"代提交"、"对外写入型 API"），且绕过我们的正式规则关联与人工审核。 |
| **把 Claude Code skills 装到 `~/.claude/skills`**（`install-skills`） | 用户想在本地用技能 | M10 技能版本/赛道包/兼容证据/安装记录；明文"不能把复制命令视为安装成功" | **决定：不做**。`cpSync` 无版本无校验无回执，接进来立刻变成**第二套安装状态**。若确要做，只能复用 M10 的安装记录写路径，不得另开。 |
| **6 位配对码 + uploadToken 绑定账号**（pairSync/eventSync） | 免密码绑定 | M01 登录会话；O01 组织权限；M02 邀请链接/二维码与有效期撤销 | **决定：不做**。**第二套绑定凭据**，与既有账号/邀请体系并列。 |
| **活动/作品各"一份 JSON 记录"的扁平模型 + 静态 seed** | 数据模型要简单 | M03 赛事事实/证据/规则版本；M08 来源与审核；M09/M02 作品与项目资料 | **决定：不引入**。seed 15 条**无来源身份、无获取时间、无原文快照**，且 `isPast` 口径不一致（§2.1），比我们现有"M03 证据 + M08 人工审核发布 + 未核验线索标记"更弱。这条反过来**印证**我们既有路线，不构成改进项。 |
| **赛事发现不带来源证据**（`/api/match` 返回即展示） | 找比赛要快 | M03/M08 的"来源证据 / 不可变回执 / 人工审核" | **决定：不引入**。同上。 |

### 6.2 真实缺失 / 可做候选（带源码位置）

| 候选 | ① 我们的真实问题 | ② 既有能力 | ③ 落地边界（避免冲突） |
| --- | --- | --- | --- |
| **A. 发布/提交前的字段级自检：一次性列全部问题、不通过就不发请求** 依据：`submit-event.mjs:123-144`（`checkEvent`）+ `:174-182`（打印全部 problems 后 `exit(1)`）、`publish-work.mjs:107-115`（`checkWork`） | 规划 32 §4.2：现在"保存 / 运行验证 / 正式收件 / 正式提交"是四个不同事实，**新人常不知道还差什么** | `github` 交付与运行验证、`event-judging` 正式收件与材料快照、`space-workflow` 待办 | 只做**派生只读**校验函数 + 挂在既有提交入口之前；**不新增状态列、不新增导航、不阻断**（复用规划 32 §4.2 已定调的结论）。这是本次最值得吸收的一条。 |
| **B. 失败返回"可操作错误码 + 缺项清单"** 依据：`submit-event.mjs:223-236`（`BAD_PAIR` / `INVALID_FORM` / `INVALID_FORMAT` 分流 + `missing[]`） | 新人拿到报错不知道下一步 | `src/shared/errors.ts` 既有错误规范 | **待主会话核对**：若既有错误呈现已达同等可操作性则无需动；若不足，属**改善既有错误呈现**，不新增写路径。本笔记不替主会话下结论。 |
| **C. 自检规则的"表述法"（门槛 + 一句话讲清楚）** 依据：`HackerTrip-submit-event/SKILL.md:82-107` | 规则写得太技术，新人读不懂 | `docs/设计/*`、既有 `/library` 原创说明 | 可借鉴**写法**（"哪一条不过、为什么、怎么补"），但**不新增机制**。注意其 4 道门槛**不在代码里**（§3.4），不能当"已实现"引用。 |

### 6.3 视觉：一律用我们自己的，**不建议照搬任何竞品视觉**

- Haki 报告长图：**深色** `#060608` 底 + 采样自"参考图"的橙/绿/蓝/紫/粉点缀（`main.ts:817-831`），是第三方风格采样，**不采用**。
- 线上站：Next.js 自托管 `sora` / `spaceMono` 字体、深色科技风；**不采用**。
- 我们维持既有令牌：**暖白 `#FFFDF8` + 橙红**（依据 AGENTS.md 与 `docs/设计/网页视觉设计.md`）；本次调研不产生任何视觉改动建议。
- 唯一可取的**结构**启发（非视觉）：长图"固定板块高预计算"的做法说明"可离线一键出图"是可行的；若将来我们要出任何长图，配色与版式**必须**从我们自己的令牌与栅格推导，不参考其采样色。

---

## 7. 未获取（明确不做推断）

| 项 | 原因 / 证据 |
| --- | --- |
| **hackertrip.space 服务端源码与数据库 schema** | `llms.txt` 声明的 `https://github.com/Jayden72Huang/hacker_trip` 实测 **404 Not Found**（同通道对照仓库均 200）→ 未公开 |
| **云函数实现（pairSync / eventSync / opsReviewSync）** | 腾讯云 CloudBase，无公开源码 |
| **云端"第二层校验"的真实规则** | 仅有客户端按码分流推断出的语义（`INVALID_FORM`/`INVALID_FORMAT`），**未见规则本体** |
| **小程序端与「主办方后台」审核台** | 微信小程序，未公开；本笔记不读取小程序内部数据 |
| **`/api/match` 真实响应体** | 为避免主动请求第三方 API，本次**未调用**；数据集口径仅由 seed 15 条与客户端代码推知 |
| **`/api/desktop/stats` 的服务端处理与"AI 协作能力评估"算法** | 服务端未公开；**能力评分如何计算完全未知**（这本身也是我们不做的理由之一） |
| **`Jayden72Huang/haki-desktop` 源码** | 超出点名的 `maliuyi63-bot/Haki` 范围，仅取仓库元数据 |
| **HackerTrip 官网首页/`methodology` 全文逐字分析** | `methodology` HTML 706 KB，本次只做 RSC 网络与路由级观测，未逐字比对（属站点自述文本，不作机制证据） |
| **`api.github.com` 直连数据** | 本机不可达；仓库元数据与文件树经 `gh-proxy` 转发取得（结果与 npm 制品交叉一致） |

---

## 8. 一句话给主会话的行动建议

本次**唯一建议吸收**的是 §6.2 的 **A（提交前字段级自检，一次性列全部问题、不通过不发请求，且只做派生只读视图）**，它正好落在规划 32 §4.2 已认定摩擦点与已定调边界内，**不新增状态、不新增入口、不新增写路径**；其余（Token/commit 过程数据→能力评分、git 提交监控告警、本地打勾清单、CLI 对外提交活动、skills 本地安装、配对码）**全部按 §6.1 判为冲突不做**。
