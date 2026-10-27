# HackBuddy 与 TechBurn 竞品调研笔记

- 调研日期：2026-10-15（UTC）
- 调研范围：只读公开页面与公开源码；未安装软件、未安装依赖、未执行任何目标代码、未注册账号、未提交表单
- 抓取工具：Node 内置 fetch（浏览器 UA）、web_search、web_fetch。GitHub 匿名 API 额度耗尽后改用 GitHub 页面 HTML 与 `raw.githubusercontent.com`；GitLab 使用公开 REST API
- 本笔记的定位：这是**原始笔记**。主会话已在 `docs/协作/竞品拆解-2026-10-15.md` 第 2.2 / 2.3 节给出结论性拆解，本文件只补**新的、可核对的一手证据**，并区分证据强度
- 本笔记不含任何密钥值；环境变量只列名称

## 证据强度分级（全文沿用）

| 级别 | 含义 |
| --- | --- |
| **A｜代码级（本会话抓取）** | 本会话直接抓到源码/仓库元数据，可逐行核对 |
| **B｜官方页面自述** | 官方项目页全文自述，由主会话抓取并转述；本会话直接抓取被 Cloudflare 403 拒绝 |
| **C｜登记/检索摘要** | 搜索接口返回的计数与字段，不含正文 |
| **D｜推测** | 由已有证据推断，未被任何一手材料确认 |
| **未获取** | 尝试过但没拿到，明确留空，不补写 |

---

# 一、HackBuddy

## 1.1 产品身份

| 项目 | 结论 | 级别 |
| --- | --- | --- |
| 已知页面 | <https://devpost.com/software/hackbuddy-uyxs83> | B |
| Devpost 更新页 | <https://devpost.com/software/hackbuddy-uyxs83/updates/763907> | C（本会话一次请求曾返回 HTTP 200 / 116,601 字节，随后所有重试均 403，未取得正文） |
| 官网 | **未获取**。候选已尝试全部失败：`hackbuddy.dev`、`hackbuddy.app`、`hackbuddy.tech`、`hackbuddy-uyxs83.vercel.app`（DNS/fetch failed） | 未获取 |
| GitHub 仓库 | **未获取（未发现）**。见下方 1.5 检索记录 | C |
| 发布者 / 团队 | 作者 Max Chen / Alvin Moy / Matthew Martin / Sayam Gupta，时间线自 2026-04-12 起 | B |
| 定位一句话 | 选手端黑客松助手，**同时把同一份部署暴露成 MCP 服务**，网页 UI 与 IDE 内（Claude Code / Cursor）共用 | B |
| 目标用户 | 黑客松参赛选手（主）+ 赛事主办方（副，另一套 dashboard） | B |
| 是否开源 | **未获取**。未找到公开仓库；无法判断是否开源 | 未获取 |
| 收费/商业模式 | **未获取**（项目页未提收费） | 未获取 |
| 活跃度 | **未获取**（无仓库即无 star / 提交记录可查） | 未获取 |
| Hackathon 参赛背景 | Devpost 项目页（参赛作品级） | B |

### 关键提醒：`hackbuddy.com` 是**另一个同名产品**，不要混淆

本会话实际抓取 <https://hackbuddy.com/> 得到（**A**，HTTP 200，6,740 字节，页面标题 `HackBuddy`）：

> Become A Better Software Engineer … Learn from the best engineers in the tech industry! Videos on YouTube - Subscribe! … Hackbuddy is your place on the web to level up with your tech career.

外链为 `youtube.com/hackbuddyorg`、`discord.gg/9f97rHzzYE`、`meetup.com/javascriptla`、`github.com/team-hack`、`facebook.com/hackbuddyorg`、`twitter.com/hackbuddyorg`、`instagram.com/hackbuddyorg/`、`linkedin.com/company/hackbuddy`。

`github.com/team-hack` 实测 HTTP 200，标题 `Team Hack · GitHub`（**A**）。

结论：`hackbuddy.com` 是一个**技术内容/YouTube 媒体品牌（Team Hack 组织）**，与 Devpost 上的 `hackbuddy-uyxs83` 选手端 MCP 工具**不是同一个产品**。任何以 "HackBuddy" 为名的对标都必须先锁定来源站点，否则会把媒体品牌的能力与口碑误算到竞品头上。

## 1.2 功能清单（全部为 B 级：官方项目页自述）

| # | 功能 | 自述细节 | 级别 |
| --- | --- | --- | --- |
| 1 | 赛事自动识别 | 从 Devpost URL 自动识别赛事 | B |
| 2 | 队伍注册 | 在应用内注册队伍 | B |
| 3 | 仓库关联 | 关联 GitHub 仓库 | B |
| 4 | **练习评审（practice-judge）** | 用**真实量规**做 agentic 评审；迭代读代码，每次最多 10 次工具调用；**引用具体文件** | B |
| 5 | **对手进度热力图** | **SSE + 后台 30 秒轮询 GitHub API**，展示对手仓库提交热力图 | B |
| 6 | 倒计时与里程碑 | 倒计时与里程碑提示 | B |
| 7 | 相似度检测 | 标记重叠项目 | B |
| 8 | 材料生成 | 生成 pitch deck（pptxgenjs）/ README / 提交草稿 | B |
| 9 | **自动填表提交** | Puppeteer 浏览器自动化自动填满 Devpost 提交表单，**人类只负责过验证码** | B |
| 10 | 主办方 dashboard | 创建赛事 / 从 Devpost 导入赛事；向选手分享 MCP 配置；实时看队伍注册、练习分、提交 | B |
| 11 | 多智能体编排 | orchestrator 委派 organizer / participant / judge 子智能体 | B |
| 12 | 数据获取手段（自述） | **为翻取分页参赛者数据，逆向了 Devpost 的会话 cookie / Referer / X-Requested-With 组合** | B |
| 13 | GitHub 速率限制应对（自述） | 多 token 轮换、限制 8 仓库 | B |

## 1.3 关键机制细节

| 问题 | 结论 | 级别 |
| --- | --- | --- |
| 对手进度追踪的**数据来源** | GitHub API，由后台每 30 秒轮询一次，经 SSE 推给前端 | B |
| AI 评委的**维度与权重** | **未获取**。自述为"真实量规"评审，但**未给出维度名称、数量或权重** | 未获取 |
| AI 评委的 **prompt** | **未获取**（无公开仓库，无代码级证据） | 未获取 |
| AI 评委的**可信度设计** | 自述两点可迁移设计：① **展示 agent 的调查轨迹让分数显得可信**；② **绝不相信 LLM 的算术，加权总分一律在服务端重算** | B |
| 防作弊/限制 | 自述"相似度检测标记重叠项目"；**未给出阈值或算法** | B / 部分未获取 |
| 提交格式 | **未获取**（自述生成提交草稿并自动填 Devpost 表单） | 未获取 |
| 与 Devpost 集成方式 | ① 从 Devpost URL 识别赛事；② Puppeteer 浏览器自动化填表；③ 自述**逆向 Devpost 会话 cookie / Referer / X-Requested-With** 取分页数据 | B |
| 与 Devfolio 集成 | **未获取**（全部材料只提 Devpost） | 未获取 |
| 是否需要账号或 token | 需要 GitHub OAuth + Clerk（Clerk + GitHub OAuth）；GitHub token 需**多 token 轮换**；是否要求用户自带 Devpost 会话凭证 **未获取** | B / 部分未获取 |
| 是否可核验 | **不可核验**：无公开仓库、无演示地址，全部为项目页自述 | — |

## 1.4 技术栈与架构（B 级，官方自述）

- Next.js 14 全栈应用；**同一份部署同时是实现了 JSON-RPC 2.0 的 MCP 服务**
- 评审主模型：Gemini 2.5 Flash；降级链：Groq / Llama-3.3-70B
- 认证：Clerk + GitHub OAuth
- 浏览器自动化：Puppeteer；抓取解析：Cheerio
- UI：Material UI；文档生成：pptxgenjs；邮件：nodemailer
- 多智能体：orchestrator → organizer / participant / judge

**仓库目录结构：未获取**（未发现公开仓库，无法给出文件清单）。

## 1.5 HackBuddy 仓库检索记录（本会话实际执行，全部为 C 级或 未获取）

| 检索 | 结果 |
| --- | --- |
| GitHub 仓库搜索 `hackbuddy` | 43 个结果，**无一个匹配**所述技术栈（Next.js 14 + MCP + Gemini + Puppeteer）。可见者多为个人练习/无关项目，最高 1 star（`Franklivania/hackbuddy`，TypeScript，描述 "Hackbuddy hackathon personal executions assistant"，2026-03-23 更新） |
| GitHub 仓库搜索 `hackbuddy MCP` | **result_count = 0** |
| GitHub 仓库搜索 `hackbuddy devpost` | 未取得结果（请求被中断） |
| GitLab 项目搜索 `hackbuddy` | 仅 1 条：`KushalBhanot/hackbuddyfinder`（2021-02-14，无关） |
| npm registry 搜索 `hackbuddy` | `{"objects":[],"total":0}` |
| 候选域名探测 | `hackbuddy.dev` / `hackbuddy.app` / `hackbuddy.tech` / `hackbuddy-uyxs83.vercel.app` 全部 fetch failed |
| Devpost 正文抓取 | `web_fetch` 403（Cloudflare "Just a moment..."）；Node 直连 403（8 次重试）；`api.allorigins.win` / `api.codetabs.com` 代理失败或超时（已中止）；`r.jina.ai` 代理 fetch failed |

**结论**：HackBuddy **没有可核验的公开代码或演示**。其一功能主张目前只能按"官方自述"采信，无法做代码级复核。

## 1.6 优点（最多 6 条，说明为什么强）

1. **"服务端重算加权总分，绝不信 LLM 算术"** —— 抓住了 AI 评分最真实的失效点（模型算术不可靠）。这条是工程上正确且可直接照搬的做法，我们已按固定整数精度在服务端归一并加权。
2. **要求评审逐条引用具体文件** —— 把"分数"变成"分数 + 依据"，是可解释性的关键；直接对治"AI 评分不可信"。
3. **展示 agent 的调查轨迹** —— 用过程可见性换取结果可信度，是很聪明的信任设计（比只给一个分数强得多）。
4. **同一份代码既做网页又做 MCP 服务** —— 零重复地同时服务"网页用户"和"IDE 内 agent 用户"，架构上很省。
5. **练习评审与正式评审明确分离（practice-judge）** —— 定位是"赛前自检"而非正式评分，这个边界划得对，也是我们唯一可以照搬的评分类功能形态。
6. **在页面上主动写出自己的坑**（逆向 cookie、GitHub 限流、Gemini 安全过滤误拦） —— 诚实的工程复盘，反而让自述更可信。

## 1.7 弱点与我们可超越的点（最多 6 条）

1. **【合规红线】"自动提交 / 代提交"不可照搬。** 它用 Puppeteer 自动填满 Devpost 表单、人类只过验证码。风险有三层：① **归属存疑** —— 提交行为由自动化而非本人完成，"这是本人提交的作品"这一事实基础被削弱；② **平台条款风险** —— Devpost 未见公开授权第三方自动化代填其提交表单；③ **不可撤销** —— 提交是单向动作，误提交、错赛道、错材料都会直接产生后果，而自动化没有"本人确认"这一闸门。我们的边界应是**核对清单 + 材料清单 + 提交回执**，正式投递必须本人确认。
2. **【反作弊/合规红线】逆向第三方站点的反爬保护（伪造会话 cookie / Referer / X-Requested-With 取分页数据）不可照搬。** 这与我们"遵守 robots、限定公开网络范围"的既定约束直接冲突；而且这种手段**随时会被平台封堵**，是脆弱的技术债，不是能力。
3. **【公平红线】"对手仓库提交热力图"不可照搬。** 未经同意持续轮询他人仓库进度，既是越权读取，也把产品价值建立在**竞争焦虑**上；更重要的是它**无法判断对方是否同意被观察**。我们只做**队内进度**，把同样的算力用在"自己队伍的差距与阻塞"。
4. **AI 评委不可信的核心证据：它自己没给出任何可核验的评分维度或权重。** 一个"模拟评委给分"的产品，如果连维度名称、数量、权重都不公开，那它的分数就**无法被检验、也无法被申诉**。这正好是我们能做得更好的地方：维度、权重、依据、机器可读的规则版本全部落库并公开。
5. **无公开代码、无演示地址、无价格、无活跃度** —— 作为竞品它**不可评估**：既不能验证能力，也不能判断是否还在维护。我们对标的应当是它的**做法**，不是它的**战绩**。
6. **【证据级】它的自述里有一条明显可疑的技术选择：依赖多 GitHub token 轮换来绕速率限制。** 这既要求用户贡献多个 token（实际使用门槛极高），也说明它把"绕过配额"当成了架构，而不是把请求量降下来。

---

# 二、TechBurn

## 2.1 产品身份（本会话完成身份确认）

**身份已确认，证据为 A 级（代码级）**：

| 项目 | 结论 | 级别 |
| --- | --- | --- |
| **GitLab 仓库（真实身份锚点）** | <https://gitlab.com/Jerryblessed/techburn> | **A** |
| 发布者 | Jeremiah Ope（`jeremiah.ope@stu.cu.edu.ng`，Covenant University 学生邮箱域） | **A**（commit author/committer 字段） |
| Devpost 页面 | <https://devpost.com/software/techburn>；更新页 `/updates/783777` | B / C |
| 官网 | **无独立官网。** `techburn.dev` 实测 fetch failed；仓库 README 无 homepage 字段；GitHub 上 `techburn` 仓库搜索 **result_count = 0** | **A / C** |
| 定位一句话 | README 首行：**"🔥 TechBurn — Hackathon OS"** —— "Autonomous hackathon management powered by Gemini 3.1 Flash Lite (Vertex AI) + GitLab MCP" | **A** |
| 参赛背景 | README：**"Built for the *Google Cloud Rapid Agent Hackathon*"** | **A** |
| 目标用户 | 两类角色：**Hosts**（赛事主办方）+ **Participants**（选手） | **A** |
| 是否开源 | **是，MIT License**，`LICENSE`：`MIT License / Copyright (c) 2026 Jeremiah Ope` | **A** |
| 收费/商业模式 | **未获取**（仓库与 README 全无收费内容） | 未获取 |
| 活跃度 | **单日项目，已停滞。** 仓库创建 `2026-06-11T16:20:16Z`；项目最后活动 `2026-06-11T21:02:44Z`；最新 commit `2026-06-11T21:03:26Z`。**0 star / 0 fork**；提交全部集中在 2026-06-11 当天，commit message 形如 `Edit app.py` / `Edit style.css` / `Edit main.js` / `Edit index.html`（与 GitLab Web IDE 直接编辑一致） | **A** |
| 贡献者 | 1 人（全部 commit 为 Jeremiah Ope） | **A** |
| 语言构成 | CSS 29.78% · JavaScript 25.21% · Python 24.91% · HTML 15.39% · Shell 2.67% | **A** |

**身份确认的推理链（可复核）**：README 自述技术栈（Gemini 3.1 Flash Lite + GitLab MCP + Google ADK + Flask + Cloud Run）与主会话从 Devpost 项目页取得的自述**逐项吻合**，且仓库 README 自述参赛赛事与 Devpost 提交语境一致。故确认 GitLab `Jerryblessed/techburn` 即 Devpost `techburn`。

> 注：`techburn.dev` 不可达这一点**不能**推断"仓库不存在"——真实仓库在 GitLab 而非 GitHub，且 GitHub 全局搜索 `techburn` 结果为 0。

## 2.2 功能清单（A 级，逐条来自 `agent_prompt.py` 的 SYSTEM_PROMPT）

TechBurn 的全部业务逻辑就是**一段系统提示词 + GitLab MCP 工具集**，共 5 个工作流：

### 主办方（Host）工作流

| # | 工作流 | 触发语 | 实际步骤（原文摘要） | 级别 |
| --- | --- | --- | --- | --- |
| 1 | **一键建赛题脚手架** | "set up a challenge" / "create a hackathon for X" / "scaffold a project" | Step 1 创建以赛题命名的 GitLab 仓库；Step 2 提交详细 `README.md`（赛题标题与描述、目标与成功标准、要求技术栈、**提交格式：仓库根目录的 `SUBMISSION.md`**、**评审权重：Innovation 30% / Execution 40% / Presentation 30%**）；Step 3 创建**正好 5 个** GitLab Issue 作为里程碑清单（① Project Setup & Environment ② Core Feature Implementation ③ UI/UX Polish ④ Testing & Error Handling ⑤ Final Submission Prep）；Step 4 返回仓库 URL 与 issue 汇总表 | **A** |
| 2 | **防作弊 / 原创性扫描** | "scan submissions" / "check for cheating" / "originality audit" | Step 1 列出命名空间下所有仓库；Step 2 逐仓分析 commit 历史（**数量、时间戳、diff 体积**）；Step 3 标记可疑模式（见 2.3）；Step 4 返回表格 `Team \| Commits \| Risk (LOW/MEDIUM/HIGH) \| Reason` | **A** |
| — | 查看提交 | "View submissions" | 列出所有带 `submission` 标签的 issue | **A**（README） |

### 选手（Participant）工作流

| # | 工作流 | 触发语 | 实际步骤（原文摘要） | 级别 |
| --- | --- | --- | --- | --- |
| 3 | **AI 结对开发 / 代码导师** | "fix issue #N" / "I'm stuck on X" / "help me implement Y" | Step 1 读取 Issue #N 详情；Step 2 读取相关源码文件；Step 3 创建分支 `fix-issue-N` 或 `feature-Y`；Step 4 **写代码修复并 commit 到该分支**；Step 5 **开 Merge Request 并回链 issue**；Step 6 总结改了什么与**为什么**，然后问"要不要我也写 CI/CD 流水线？"。原文强调：**"⚠ Actually perform the fix — don't just give advice."** | **A** |
| 4 | **自动 CI/CD 流水线生成** | "add a pipeline" / "set up CI/CD" / "automate deployment" | Step 1 读仓库文件识别语言（`package.json`→Node.js / `requirements.txt`→Python / `pom.xml`→Java）；Step 2 生成对应 `.gitlab-ci.yml`（Python→flake8 + pytest + Docker build；Node→`npm ci` / `npm test` / `npm run build`；Java→`mvn package` + test；兜底→build + test）；Step 3 **提交 `.gitlab-ci.yml` 到默认分支**；Step 4 展示流水线阶段 | **A** |
| 5 | **最终提交处理** | "submit my project" / "I'm done" / "log my submission" | Step 1 缺字段则询问：项目名、队员、演示 URL、描述；Step 2 **写 `SUBMISSION.md` 到仓库根目录**；Step 3 **创建标题为 `FINAL SUBMISSION — [TeamName]`、带 `submission` 标签的 GitLab Issue**；Step 4 确认并返回全部链接 | **A** |

## 2.3 关键机制细节（A 级，可为我们的规则设计提供直接参照）

### AI 评审的维度与权重 —— 有明文的权重，但**没有评分实现**

`agent_prompt.py` 在"建赛题脚手架"工作流里写死了一行评审权重：

> `- Judging: Innovation 30%, Execution 40%, Presentation 30%`

**关键判断（A 级 + 代码级否定证据）**：
- 这 3 个维度与 30/40/30 权重**只作为文本被写进它替主办方生成的 `README.md` 里**；
- 全仓库**没有任何评分代码**：`app.py` 只有 `/`（渲染页面）、`/chat`（转发给 agent）、`/tts`（语音合成）、`/health` 四个路由，**不存在 score / evaluate / rubric / judge 相关实现**；
- 仓库里**唯一**带完整权重表的评分文件是 `.claude/agents/kfc/spec-judge.md`（**已补读，A 级**）。它评的**不是黑客松项目，而是 spec 文档**（requirements / design / tasks），属 Kiro 风格规格工作流的评审 agent。其"General Evaluation Criteria"为 **4 项各 25 分、满分 100**：

  | 维度 | 分值 | 判据（原文） |
  | --- | --- | --- |
  | Completeness | 25 | Whether all necessary content is covered / Whether there are any important aspects missing |
  | Clarity | 25 | Whether the expression is clear and explicit / Whether the structure is logical and easy to understand |
  | Feasibility | 25 | Whether the solution is practical and feasible / Whether implementation difficulty has been considered |
  | Innovation | 25 | Whether there are unique insights / Whether better solutions are provided |

  另有按文档类型追加的判据（requirements：EARS 格式符合、验收标准可测、边界情况、**与用户需求一致**；design：架构合理性、技术选型恰当、可扩展性、**覆盖全部需求**；tasks：任务分解合理、依赖清晰、可增量实施、**与需求与设计一致**）。
  其"Evaluation Process"是一段 **Python 伪代码**，其中 `'total': sum(scores)` **有明显缺陷**（`scores` 是字典列表，`sum()` 不能这样汇总）—— 说明这段评分逻辑并未被真正执行过。

**结论**：TechBurn 的"AI 评委"是**声明而非实现**——权重写在文档里，但没有任何机器可执行的评分、汇总或申诉路径。仓库中唯一写明维度与权重的量规，评的是**规格文档而非参赛作品**，而且是**伪代码**。此条同时构成"黑客松评分无实现"这一结论的**穷尽性证据**（唯一候选文件已读完）。这恰恰是我们能明确超越的地方。

### 产品形态：就是一个**聊天框 + 预设提示词侧栏**（A 级，`templates/index.html` 实证）

- 整个前端只有两块：Landing（两张角色卡 **Host** / **Participant**）与主界面（**顶栏 + 侧栏预设按钮 + 聊天列**）。
- 角色切换 `App.enter('host')` / `App.enter('participant')` 是**纯客户端按钮**，只切换侧栏按钮组与一个 `role-badge` 徽章；**没有任何身份或授权含义**（与 2.3 的无鉴权结论一致）。
- 侧栏全部是**预设提示词注入**（`App.inject(...)`），例如 `Set up a new Python web-app hackathon challenge`、`Scan all repositories for originality and flag suspicious commit patterns`、`Read the open issues in my repo and autonomously fix issue #1`、`I am done building. Help me submit my project to the hackathon`。
- 界面**不存在任何评分、量规、评审或结果视图**——进一步佐证"AI 评委"没有实现。
- **模型标识自相矛盾（第三处）**：前端状态栏硬编码 `gemini-2.5-flash · vertex ai`，`app.py` 头注释也写 Gemini 2.5 Flash，但 `app.py` 实际 `model="gemini-3.1-flash-lite"`，README 亦写 3.1 Flash Lite。**同一个模型标识在 4 处出现 2 种说法。**
- Host 角色卡宣称能力含 "**Team analytics**"，但侧栏与后端**均无对应实现**（只有建仓、原创性扫描、列提交三个）。

### 防作弊 / 限制（有**可核对的数值阈值**——本笔记最可直接借鉴的部分）

原文列出的可疑模式（`agent_prompt.py` WORKFLOW 2 Step 3）：

| # | 规则（原文） | 阈值是否可执行 |
| --- | --- | --- |
| 1 | Single massive commit (**>5,000 lines**) near deadline | 是（明确行数阈值） |
| 2 | **Zero activity for >20 h** followed by a massive dump | 是（明确时长阈值） |
| 3 | **Identical commit messages across multiple teams** | 是（跨队比对） |

输出为 `Team | Commits | Risk (LOW/MEDIUM/HIGH) | Reason`。

我们的做法应当**吸收机制、改造结论**：用 commit 活动事实（时间戳、体积、历史）生成**可解释的公平性提示**，但**只进人工复核队列（`needs_review`），不自动判定作弊、不自动产出"风险等级"给他人看**——理由是 LOW/MEDIUM/HIGH 这种分级一旦公开，就是"不透明适配分/跨人排名"，与我们已定约束冲突。

### 提交格式与"自动打包提交"的**真实实现**

| 问题 | 结论 | 级别 |
| --- | --- | --- |
| 提交格式 | 仓库根目录的 `SUBMISSION.md` + 一个带 `submission` 标签的 GitLab Issue（标题 `FINAL SUBMISSION — [TeamName]`） | **A** |
| **是否与 Devpost / Devfolio 集成** | **完全没有。** 全仓库无 Devpost、Devfolio、表单自动化或浏览器自动化相关代码；`requirements.txt` 中无 selenium / playwright / puppeteer 类依赖；源码级依赖清单里也没有任何 HTTP 表单提交逻辑 | **A（否定证据）** |
| "自动打包提交"的实际含义 | 是**在 GitLab 内部**产出 `SUBMISSION.md` + 开一个 issue，**不是**投递到第三方赛事平台。主会话转述的"自动贴到主办方的集中提交串"在代码层面即"创建 submission issue" | **A** |
| 是否需要账号或 token | **需要**：① Google Cloud 项目 + Vertex AI + Cloud TTS + ADC（`gcloud auth application-default login`）；② **一个 GitLab fine-grained PAT**，`GITLAB_PRIVATE_TOKEN` | **A** |
| PAT 权限范围（README 明列） | Project 增删改查/fork；Repository/Code push+read+download；Branch 增删；Commit 建读；**Merge Request 建/读/批准/合并**；Issue 建读改；CI/CD Pipeline 读建；CI Config 读+校验 | **A** |

### 【新增，A 级】安全与鉴权问题：这是 TechBurn 最严重的结构性缺陷

以下全部来自本会话对 `app.py` / `start.sh` / `.env.example` 的逐行阅读：

1. **`/chat` 路由完全没有认证。** `chat()` 直接取 `request.get_json()` 的 `message` / `role` / `session_id` 就转发给 agent，没有任何身份校验、没有 token 校验、没有权限判定。
2. **而 agent 手里握着一把全权限 GitLab PAT。** `app.py` 用**全局环境变量** `GITLAB_PRIVATE_TOKEN` 构造 `McpToolset`；`start.sh` 把同一个 token 传给 MCP server。**所有用户共用同一个 token**，没有按队/按用户隔离。
3. **部署时把鉴权关掉。** `start.sh` 里 `export REMOTE_AUTHORIZATION="true"`；README 的部署命令含 **`--allow-unauthenticated`**。
   → **合成后果**：任何知道 Cloud Run URL 的人，都能通过 `/chat` 用自然语言指挥一个持有"建仓/删仓/push/建删分支/建合并 MR"权限的 agent。这是典型的 **confused deputy（混淆代理）**：agent 的权限远大于调用者的权限。
4. **会话状态纯内存且可被客户端指定。** `InMemorySessionService` + `session_id = data.get("session_id", "default")`：session_id 由**客户端**提供，缺省全是 `"default"` → 用户之间可能**共用/串味会话上下文**；重启即丢失。
5. **无法横向扩展。** `start.sh` 用 `gunicorn --workers 1 --threads 4`；配合内存会话，多实例会各自持有互不相通的上下文。
6. **模型标识在 4 处出现 2 种说法。** `app.py` 头注释写 `Vertex AI (Gemini 2.5 Flash)`、前端状态栏硬编码 `gemini-2.5-flash · vertex ai`，但 `app.py` 实际 `model="gemini-3.1-flash-lite"`、README 亦写 3.1 Flash Lite。连"用的是哪个模型"都无法自洽，说明提交前未做过一致性核对。
7. **没有数据库的代价被低估了。** README 把这当卖点（"No database"），但实测后果是：没有多机构、没有权限模型、没有持久会话、没有审计、没有评审记录。

## 2.4 技术栈与架构（A 级，文件级）

### 仓库文件清单（`git/trees?recursive=1`，共 31 个路径）

```
techburn/
├── app.py                    # Flask app + ADK runner（216 行）
├── agent_prompt.py           # SYSTEM_PROMPT，全部 5 个工作流（89 行）
├── requirements.txt
├── Dockerfile
├── start.sh                  # Cloud Run 入口
├── .env.example
├── .gitignore
├── LICENSE                   # MIT, Copyright (c) 2026 Jeremiah Ope
├── README.md
├── templates/index.html      # 单页 UI（Landing → Host/Participant）
├── static/css/style.css
├── static/js/main.js         # App controller + voice input + markdown
└── .claude/
    ├── agents/kfc/{spec-design,spec-impl,spec-judge,spec-requirements,
    │               spec-system-prompt-loader,spec-tasks,spec-test}.md   ← spec-judge.md 已读（评的是 spec 文档，非参赛作品）
    ├── settings/kfc-settings.json
    └── system-prompts/spec-workflow-starter.md
```

### 架构（README ASCII 图 + `app.py` 实证）

```
Browser (HTML/CSS/JS) ── POST /chat ──▶ Flask (app.py)
                                          │  vertexai.init()
                                          ▼  Google ADK Runner
                                     Gemini 3.1 Flash Lite (Vertex AI)
                                          │  tool calls
                                          ▼
                     GitLab MCP Server (@zereight/mcp-gitlab, port 3002)
                                          │
                                     GitLab REST API (gitlab.com/api/v4)
```

| 层 | 技术 | 级别 |
| --- | --- | --- |
| LLM | Gemini 3.1 Flash Lite via Vertex AI（`model="gemini-3.1-flash-lite"`） | **A** |
| Agent 框架 | Google ADK 2.1.0（`Agent` / `Runner` / `McpToolset` / `StreamableHTTPConnectionParams`） | **A** |
| MCP server | `@zereight/mcp-gitlab`，Streamable HTTP，`http://127.0.0.1:3002/mcp` | **A** |
| 后端 | Python 3.11+ · Flask 3.1.3 · gunicorn（1 worker / 4 threads / timeout 300） | **A** |
| 会话 | `InMemorySessionService`（**无数据库**） | **A** |
| 语音输入 | Web Speech API（前端） | **A**（README/主会话） |
| 语音输出 | Google Cloud TTS v1，`en-US-Neural2-D`，MP3，服务端先剥离 Markdown 再合成，截断 4800 字符 | **A** |
| 前端 | 原生 HTML/CSS/JS，无框架 | **A** |
| 部署 | Docker → Google Cloud Run（`--allow-unauthenticated`，1Gi，timeout 300） | **A** |
| 密钥 | Google Secret Manager（README 建议） | **A** |
| 关键依赖 | `google-adk==2.1.0`、`google-cloud-aiplatform==1.154.0`、`google-cloud-texttospeech==2.36.0`、`google-genai==1.75.0`、`mcp==1.27.2`、`litellm==1.83.14`、`openai==2.24.0`、`Flask==3.1.3` | **A** |

## 2.5 优点（最多 6 条，说明为什么强）

1. **把"黑客松运营"整条链路用一段提示词 + 一个 MCP 工具集打通了** —— 建赛题、发里程碑 issue、写 CI、修 bug 开 MR、收提交，全部落在 GitLab 的既有原语上。**代码量极小（后端约 300 行）却能演示完整闭环**，是"用平台原语代替自建后端"的极佳示范。
2. **防作弊规则带了可核对的数值阈值**（>5,000 行单次提交、>20 小时间隔后大爆发、跨队相同 commit message）。这在同类产品里少见——多数只喊"AI 查重"，它给了**可复算的数**。我们可以直接把这些阈值当作"公平性提示"的默认参数。
3. **里程碑 issue 化（固定 5 个阶段）** —— 把赛程变成 5 个可见、可勾选、可评论的 issue，和我们"任务与计划"天然同构，可直接作为**导入模板**（注意：不要变成第二套完成状态）。
4. **提交格式明确且机器可读**（`SUBMISSION.md` + 带标签的 issue）—— 比"填一个网页表单"更利于事后审计与版本追溯。我们的 M06 提交记录可以吸收"结构化提交说明 + 回执"这一形态。
5. **AI 结对开发是"真做"而不是"给建议"**（原文 `⚠ Actually perform the fix — don't just give advice.`，且流程要求"总结改了什么与**为什么**"）—— 强制解释变更原因是很好的产品约束。
6. **完全无状态、无数据库的部署**在同一维度上确实省事：一个容器、一个 token 就跑起来；作为黑客松 48 小时作品，这个取舍可以理解。

## 2.6 弱点与我们可超越的点（最多 6 条）

1. **【安全/架构·最严重】全用户共用一把全权限 GitLab PAT，且入口无认证 + `--allow-unauthenticated`。** 详见 2.3 的 7 条实证。这不是"简化"，而是**把 agent 的权限当成了调用者的权限**（confused deputy）。我们的对应做法必须坚持：**每个用户/每个项目用自己的授权凭证（已有 GitHub App 用户授权 + 加密凭据库），agent 永远不能获得超出当前调用者的权限**，并且任何写入都要在当前权限事务内复核。
2. **【合规红线】"AI 自动开 MR / 自动 commit"有归属与评审资格问题。** 谁写的代码、AI 生成的部分算不算本人作品，它**没有任何说明、没有标注机制**。我们必须保留"本人确认 + 如实标注"（例如提交物标注 AI 参与程度），且**不得让 AI 的产出绕开本人的确认动作**。
3. **"AI 评委"只有权重文本、没有实现，更没有校准与申诉。** 30/40/30 被写进 README 就结束了：没有评分代码、没有服务端汇总、没有可申诉路径、没有留痕。我们若做评分类 AI 功能，正确形态是**"练习自检 / 规则核对"**：按本赛道已锁定规则逐项输出"项 → 依据（文件/链接/记录）→ 缺口 → 下一步"，**明确标注非正式、不进入正式评分，不给分数、不给名次、不判断能否获奖**。
4. **无数据库 = 无权限模型、无多机构、无审计、无持久会话、无法横向扩展**（`--workers 1` + 内存会话 + 客户端可指定 `session_id` 造成串味风险）。我们是带登录、有权限、可核验的网站，这一点上**不是"比功能"，而是"它有结构性缺口"**。
5. **单日停滞、0 star、1 名贡献者、无官网。** 2026-06-11 当天完成全部 8 次提交后再无活动；README 无 homepage；GitHub 上无同名仓库。**它是黑客松参赛作品，不是运营中的产品** —— 对标价值在做法，不在战绩，也不应引用它的"用户量/口碑"。
6. **强绑定 GitLab + 全英文语音环境，中国新人门槛高。** 需要 GitLab 账号 + **fine-grained PAT（含删仓、合并 MR 等高风险权限）** + Google Cloud 项目 + ADC 登录。让新人交出一把能删仓库的 token，本身就是我们应当避免的设计；我们已有邮箱验证码 + 观猹 OAuth 的低门槛路径。

---

# 三、横向对比（只列可核对项）

| 维度 | HackBuddy | TechBurn |
| --- | --- | --- |
| 平台 | 服务端（Next.js 14）+ MCP 双形态 | 服务端（Flask）+ MCP（GitLab） |
| 代码可核验 | **否**（无公开仓库） | **是**（GitLab，MIT，31 个路径） |
| 模型 | Gemini 2.5 Flash（降级 Groq/Llama-3.3-70B） | Gemini 3.1 Flash Lite（Vertex AI） |
| AI 评审 | 自述 agentic 练习评审，**≤10 次工具调用、引用文件**；维度/权重**未获取** | 只在生成的 README 里写 `Innovation 30 / Execution 40 / Presentation 30`；**无评分实现** |
| 计分可信性措施 | 自述"服务端重算加权总分、不信 LLM 算术"、"展示调查轨迹" | **无** |
| 防作弊 | 自述相似度检测（**无阈值**） | **有可核对阈值**：>5,000 行单次提交 / >20h 静默后大爆发 / 跨队相同 message → LOW/MEDIUM/HIGH |
| 提交去向 | **Devpost**，Puppeteer 自动填表（人过验证码） | **GitLab 内部**（`SUBMISSION.md` + submission issue） |
| 第三方平台集成 | Devpost（含自述逆向其反爬） | **无** |
| 对手数据 | 自述轮询 GitHub 取**对手**仓库进度（SSE 30s） | 主办方扫描**本命名空间内**全部仓库（同一赛事内的参赛仓，用途是查重） |
| 鉴权 | Clerk + GitHub OAuth；需多 GitHub token 轮换 | **无鉴权**；单一全局 GitLab PAT；`--allow-unauthenticated` |
| 数据持久化 | —（未获取细节） | **无数据库**（内存会话，状态在 GitLab） |
| 开源/许可 | 未获取 | MIT（Copyright 2026 Jeremiah Ope） |
| 活跃度 | 未获取 | 0 star / 0 fork / 单日 8 次提交 / 1 贡献者 / 已停滞约 4 个月 |

**共同的天花板**：两家都**没有把"可核验事实"贯穿到评审与结果**——HackBuddy 的评分不可核验（无维度、无权重、无代码），TechBurn 的评分根本没有实现。**这正是我们最应该占领的位置。**

---

# 四、"AI 评委评分"与"AI 结对开发"能不能安全地做进我们平台

## 4.1 结论

- **AI 评委评分：可以做，但只能做成"练习自检 / 规则核对"，不能做成"正式评分"。**
- **AI 结对开发：可以做，但必须"本人确认 + 如实标注"，且 agent 权限不得超出当前调用者。**

## 4.2 AI 评委评分的安全边界（逐条有竞品反证）

| 允许 | 不允许 | 竞品反证 |
| --- | --- | --- |
| 按**本赛道已锁定规则**逐项自检，输出"项 → 依据（文件/链接/记录）→ 缺口 → 下一步" | 给出分数、百分制、名次或"能否获奖" | HackBuddy 的分数**无维度无权重**，无法检验；TechBurn 的 30/40/30 只是文档 |
| 明确标注"**非正式、不进入正式评分**" | 让练习自检结果流入正式评分或晋级 | HackBuddy 用 practice-judge 命名把边界划对了，值得学 |
| 每条结论**引用具体证据**（文件级/链接级） | 只给结论不给依据 | HackBuddy 的"引用具体文件"要学 |
| **服务端用固定整数精度重算与汇总**，不信模型算术 | 采信模型自报的加权总分 | HackBuddy 自述的这条经验是对的 |
| 展示 agent 的**调查轨迹**（读了哪些文件、得出什么） | 黑箱给分 | 同上 |
| 相似/重复**提示**进人工复核队列 | 用相似度**自动判定作弊** | HackBuddy 无阈值；TechBurn 的 LOW/MEDIUM/HIGH 一旦公开即"不透明分级 + 跨人排名" |
| 评分维度、权重、规则版本**落库并公开可查** | 不透明适配分、可随时暗改的权重 | 两家都没有可公开核对的规则版本 |

## 4.3 AI 结对开发的安全边界

| 允许 | 不允许 | 竞品反证 |
| --- | --- | --- |
| 让 AI 读**本项目**仓库、给出修改建议与补丁草案 | 让 AI 用一把全局 token 去写**任何人的**仓库 | TechBurn 全用户共用全局 PAT，且入口无鉴权 |
| 由 AI 生成补丁、**由本人在预览/确认后提交** | AI **自动 commit / 自动开 MR** 而无人确认 | TechBurn WORKFLOW 3 Step 4–5 直接 commit 并开 MR |
| 每步写入都**在当前用户/项目权限事务内复核** | 依赖"平台权限兜底"或"agent 权限代行" | TechBurn 形成 confused deputy |
| **如实标注** AI 参与程度 | 让 AI 产出冒充本人独立完成 | TechBurn 无任何标注机制 |
| 会话状态落库、按用户隔离 | 客户端可指定 `session_id`、内存会话、`--workers 1` | TechBurn 的 `session_id` 由客户端提供，缺省全为 `"default"` |
| 只读**本项目**仓库的提交/健康度 | 读取他人/他队仓库进度 | HackBuddy 的对手热力图 = 越权 + 竞争焦虑 |
| 提供**核对清单 + 材料清单 + 提交回执** | **代提交**（浏览器自动化填第三方平台表单） | HackBuddy 的 Puppeteer 自动填 Devpost 表单 |

## 4.4 顺带发现：一个更值得学的"AI 评委"可核验范本（非本次两个目标）

本会话在检索中命中一个**独立、真实、MIT 许可、可文件级核对**的 AI 评委实现，比上述两家都具体，建议单列跟进：

- 仓库：<https://github.com/MAGA2010/hackathon-run>（产品名 **Hackathon Run**，与本笔记两个目标**无关**，是相邻参照物）
- 技能文件原文：<https://raw.githubusercontent.com/MAGA2010/hackathon-run/8a10cc566d3b0405d8fde1be795bcf16c7d1425a/docs/skills/judge-sim.md>
- 其 `judge-sim` 的**明确规则**（**A** 级）：`panel_size` 3..7（默认 5，"one judge per dimension"，即**一维一评委**）；输出 `.hackathon/state/review.json`；**恰好 5 个维度**：`demo_clarity` / `technical_depth` / `novelty` / `polish` / `feasibility`；总分 **0..5 一位小数**；`fix_priorities` 分 `fix_now` / `fix_last_10_min` / `do_not_touch`，且**仅当总分 ≥ 4.5 时 `fix_now` 才可为空**；后端可用 `HACKATHON_JUDGE_BACKEND` 指向 HTTP LLM judge，**失败回退启发式**；`Missing demo.json` 时**拒绝执行**；"团队不接受该分数"时**展示推理并允许换 seed 重判**。
- **一处内部矛盾（真实、可核对）**：其 `README.md` 写 `judge-sim` 输出 "0-5 rating across **7 dimensions**"，而 `judge-sim.md` 的验收标准写 "**Exactly 5 dimensions**"。→ 说明**连做了显式验收标准的项目也会出现规则与文档不一致**；这正是我们必须把"维度/权重/规则版本"落库并做一致性检查的直接理由。

---

# 五、证据与来源

## 5.1 TechBurn（A 级，本会话抓取，可逐行复核）

| 内容 | URL |
| --- | --- |
| 仓库主页 | <https://gitlab.com/Jerryblessed/techburn> |
| README（全文 235 行） | <https://gitlab.com/Jerryblessed/techburn/-/raw/main/README.md> |
| **系统提示词（5 个工作流 + 30/40/30 权重 + 反作弊阈值）** | <https://gitlab.com/Jerryblessed/techburn/-/raw/main/agent_prompt.py> |
| Flask 应用（路由、模型、MCP 接入） | <https://gitlab.com/Jerryblessed/techburn/-/raw/main/app.py> |
| 环境变量清单（只读名称，无值） | <https://gitlab.com/Jerryblessed/techburn/-/raw/main/.env.example> |
| 启动脚本（`--workers 1`、`REMOTE_AUTHORIZATION`） | <https://gitlab.com/Jerryblessed/techburn/-/raw/main/start.sh> |
| 依赖清单 | <https://gitlab.com/Jerryblessed/techburn/-/raw/main/requirements.txt> |
| 许可证 | <https://gitlab.com/Jerryblessed/techburn/-/raw/main/LICENSE> |
| 文件树（31 个路径，recursive） | <https://gitlab.com/api/v4/projects/Jerryblessed%2Ftechburn/repository/tree?recursive=true&per_page=100> |
| 提交历史（全部 2026-06-11） | <https://gitlab.com/api/v4/projects/Jerryblessed%2Ftechburn/repository/commits?per_page=20> |
| 语言构成 | <https://gitlab.com/api/v4/projects/Jerryblessed%2Ftechburn/languages> |
| 项目元数据（创建/最后活动/star/fork） | <https://gitlab.com/api/v4/projects?search=techburn&per_page=50> |
| **单页 UI（产品形态、角色切换无授权、模型标识矛盾）** | <https://gitlab.com/Jerryblessed/techburn/-/raw/main/templates/index.html> |
| **仓库内唯一带权重的评分量规（评 spec 文档，4×25=100）** | <https://gitlab.com/Jerryblessed/techburn/-/raw/main/.claude/agents/kfc/spec-judge.md> |
| `.claude` 规格工作流其余文件 | <https://gitlab.com/Jerryblessed/techburn/-/raw/main/.claude/agents/kfc/spec-design.md> · <https://gitlab.com/Jerryblessed/techburn/-/raw/main/.claude/settings/kfc-settings.json> |

关键原文片段（`agent_prompt.py`）：

> `- Judging: Innovation 30%, Execution 40%, Presentation 30%`
> `Step 3: FLAG suspicious patterns:` / `- Single massive commit (>5 000 lines) near deadline` / `- Zero activity for >20 h followed by a massive dump` / `- Identical commit messages across multiple teams`
> `Step 4: Return a table: Team | Commits | Risk (LOW / MEDIUM / HIGH) | Reason.`
> `Step 2: WRITE SUBMISSION.md to the repo root with structured details.`
> `Step 3: CREATE a GitLab Issue titled "FINAL SUBMISSION — [TeamName]" labelled "submission".`

关键原文片段（`README.md`）：

> `> **Autonomous hackathon management powered by Gemini 3.1 Flash Lite (Vertex AI) + GitLab MCP**`
> `> Built for the *Google Cloud Rapid Agent Hackathon*`
> `**No database** — conversation state lives in `InMemorySessionService`; all persistent data (repos, issues, MRs, files) lives on GitLab.`

## 5.2 HackBuddy（B 级，主会话抓取的官方项目页；本会话直接抓取被 Cloudflare 拒绝）

| 内容 | URL |
| --- | --- |
| Devpost 项目页 | <https://devpost.com/software/hackbuddy-uyxs83> |
| Devpost 更新页 | <https://devpost.com/software/hackbuddy-uyxs83/updates/763907> |
| 同名但不同产品（**勿混**） | <https://hackbuddy.com/> · <https://github.com/team-hack> |

## 5.3 检索与否定证据（C 级，本会话执行）

| 检索 | 结果 |
| --- | --- |
| GitHub 仓库搜索 `hackbuddy` | result_count = **43**，无匹配项 |
| GitHub 仓库搜索 `hackbuddy MCP` | result_count = **0** |
| GitHub 仓库搜索 `techburn` | result_count = **0** |
| npm registry `hackbuddy` / `techburn` | 均 `total: 0` |
| GitLab 项目搜索 `techburn` | 1 条 → `Jerryblessed/techburn`（即目标） |
| GitLab 项目搜索 `hackbuddy` | 1 条 → `KushalBhanot/hackbuddyfinder`（2021，无关） |
| Devpost 直连抓取 | `web_fetch` → 403 Cloudflare；Node 直连 → 403（8 次重试）；`api.allorigins.win` / `api.codetabs.com` 代理失败；`r.jina.ai` → fetch failed |

## 5.4 相邻参照物（A 级）

| 内容 | URL |
| --- | --- |
| Hackathon Run 仓库 | <https://github.com/MAGA2010/hackathon-run> |
| `judge-sim` 技能原文 | <https://raw.githubusercontent.com/MAGA2010/hackathon-run/8a10cc566d3b0405d8fde1be795bcf16c7d1425a/docs/skills/judge-sim.md> |
| README（"7 dimensions" 处） | <https://raw.githubusercontent.com/MAGA2010/hackathon-run/main/README.md> |

---

# 六、未能确认项（明确留空，不补写）

## HackBuddy

1. **GitHub / 开源仓库：未获取。** 43 个同名仓库无一匹配；`hackbuddy MCP` 搜索为 0；npm 为 0；GitLab 只有 2021 年的无关项目。
2. **官网与演示地址：未获取。** `hackbuddy.dev` / `hackbuddy.app` / `hackbuddy.tech` / `hackbuddy-uyxs83.vercel.app` 全部 fetch failed。
3. **演示视频：未获取**（未在搜索或页面外链中取得 YouTube 链接）。
4. **AI 评委的维度与权重：未获取。** 页面自述"真实量规"，但**未给出任何维度名称、数量或权重**。
5. **AI 评委的 prompt：未获取。**
6. **评分维度权重/汇总公式：未获取**（仅自述"服务端重算加权总分"）。
7. **相似度检测的阈值或算法：未获取。**
8. **提交格式（字段清单）：未获取。**
9. **商业模式与收费：未获取。**
10. **活跃度（star、最近提交）：未获取**（无仓库可查）。
11. **与 Devfolio 的集成：未获取**（所有材料只提 Devpost）。
12. **是否要求用户提供 Devpost 会话凭证：未获取。** 页面自述的是**开发者自己逆向** Devpost 的 cookie/Referer/X-Requested-With 组合，**不等于**用户被要求交出自己的 Devpost 凭证——这一点必须区分，不可扩大解释。
13. **全部功能主张均无代码级复核。** Devpost 正文被 Cloudflare 403 拒绝，本会话只能引用主会话抓取的页面自述。

## TechBurn

1. **官网：确认无独立官网。** `techburn.dev` 不可达；仓库 README 无 homepage 字段；GitHub 上无 `techburn` 仓库。**唯一身份锚点是 GitLab 仓库。**
2. **商业模式与收费：未获取**（仓库无任何收费内容）。
3. **GitLab 之外的部署地址（Cloud Run URL）：未获取。** README 部署命令用占位符，未记录实际服务 URL。
4. **`.claude/agents/kfc/spec-judge.md`：已补读，该线索已关闭。** 结论：它是 Kiro 风格规格工作流的评审 agent，**评的是 spec 文档（requirements / design / tasks），不是黑客松参赛作品**；权重为 4×25=100（Completeness / Clarity / Feasibility / Innovation），且评分逻辑仅是一段 `sum(scores)` 有缺陷的 Python 伪代码。→ **不构成黑客松评分机制证据**；"TechBurn 无黑客松评分实现"的结论**已被穷尽性验证**（唯一候选文件已读完）。
5. **`.claude/` 其余文件（spec-design / spec-impl / spec-requirements / spec-tasks / spec-test / spec-system-prompt-loader / kfc-settings.json / spec-workflow-starter.md）内容未读。** 已读 `spec-design.md` 头部与 `kfc-settings.json`（363 字节，为工作流配置）；判断其同属该规格工作流模板，与黑客松评分无关，**未逐份精读**。
6. **Devpost 项目页全文：未直接抓取**（Cloudflare 403）；本笔记中 TechBurn 的 Devpost 侧信息均来自主会话转述。
7. **"无数据库/去中心化"是否也意味着评审记录不可追溯：属于推论**，按 **D 级**处理——`InMemorySessionService` + 无数据库 + `--workers 1` 是**A 级事实**，由其推出"无持久评审记录"是合理但未被明文确认的结论。
8. **运行时行为未验证**：`/chat`、`/tts`、`/health` 三个路由只做了静态阅读，**未实际发起请求**（不执行目标代码的约束）；"无鉴权""agent 持有全局 PAT"是由源码结构得出的结论，未做黑盒验证。
9. **实际危害面未量化**：Cloud Run 服务 URL 未获取，故**未确认该服务当前是否仍在线、是否仍可被匿名访问**。因此 2.3 的安全问题应表述为"**源码与部署配置所允许的风险**"，不是"已被利用的事实"。

## 通用

1. **本笔记未对任何目标执行代码**，因此所有"行为"结论都来自静态源码阅读与官方自述，**没有运行时验证**。
2. **Devpost 站点的直连抓取在本会话被 Cloudflare 全量拦截**（`web_fetch`、Node 直连 8 次重试、两个公共 CORS 代理、`r.jina.ai` 代理均失败）。这是取证边界，不是"页面不存在"。
3. **GitHub 匿名 API 额度耗尽**（`core: 0/60`），改用页面 HTML 与 `raw.githubusercontent.com` 后仍取得所需证据；本笔记中所有"未发现仓库"的结论均基于**多个渠道的否定证据**（GitHub 页面搜索、GitLab API、npm registry），而非单一 API 的 403。

---

# 七、一句话总结

**HackBuddy 强在"AI 评审的可信度设计"（引用文件、展示轨迹、服务端重算）但踩了三条红线（窥探对手、逆向反爬、代提交），且完全不可核验；TechBurn 强在"用平台原语拼出完整闭环 + 防作弊带数值阈值"但只值一天工期、0 star、无鉴权、无数据库、评分只有一行文档。**

**对我们最有价值的结论**：这两家**都没有把"可核验事实"贯穿到评审与结果**——HackBuddy 的评分不可检验，TechBurn 的评分根本没实现。我们只要把"**规则版本 + 维度权重 + 逐条依据 + 服务端重算 + 人工复核队列 + 本人确认提交**"这六件事同时做扎实，就能在不碰任何红线的前提下，在"AI 评分的可信度"这一维度上明确超过两者。
