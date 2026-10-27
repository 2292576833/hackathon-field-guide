# 竞品调研：CraftStadium Organize / HackathonOS / Brightidea Hackathon 6

- 调研日期：2026-10-12（本机时间）
- 调研人：竞品调研员（只读调研，未注册、未提交表单、未执行目标站点代码、未安装软件）
- 立场：**偏主办方 / 企业侧**，重点看"主办方视角的主流程"与"关键机制细节"
- 证据强度分级（全文统一使用）：
  - **【已抓取】** = 用 web_fetch 成功取得页面正文，引用为原文摘录
  - **【仅搜索摘要】** = 只在 web_search 结果列表/摘要里出现，未打开正文
  - **【推测】** = 由已抓取事实推断，不当作官方宣称
  - **【未获取】** = 公开渠道无法确认，不编造

> 关于搜索失败的说明：本机 pwsh 直连（`Invoke-WebRequest` 到 craftstadium.com / google.com / duckduckgo.com）全部超时，因此没有本地 HTML 存档；所有正文均来自 web_fetch 的抓取结果。少数页面中英日文混排，日语引文为人工要点转述。

---

## 0. 一句话结论

| 竞品 | 主办方侧最强的能力 | 对我们的威胁 |
| --- | --- | --- |
| CraftStadium Organize | **团队编成 + 成果物收集 + 参与者分析**三段闭环，且集客与运营在同一平台；免费档就能跑完一整场 | 高（同类定位、同类客群、已有 76 场真实运营） |
| HackathonOS | **未获取**（公开渠道无法确认该产品身份，见第 2 节） | 未知 |
| Brightidea Hackathon 6 | **企业级全生命周期闭环**：全球时区调度、评审门户、活动后商业价值/ROI 仪表盘、把获奖想法推入持续管道 | 低-中（只服务大企业，价格与门槛极高） |

---

## 1. CraftStadium Organize

### 1.1 产品身份

| 项 | 内容 | 证据强度 |
| --- | --- | --- |
| 官网（主办方侧） | https://www.organize.craftstadium.com/ | 【已抓取】 |
| 官网（参与者侧，同一平台导流） | https://www.craftstadium.com/ | 【已抓取】 |
| 定价页 | https://www.organize.craftstadium.com/pricing | 【已抓取】 |
| 公司 | 株式会社 CoPalette（CoPalette Inc.），京都府京都市下京区，2023年5月设立，代表取締役 山本新，资本金 710万2000円（含资本准备金，2024-07-22 时点） | 【已抓取】 https://www.copalette.org/news/craftstadium-organize-alpha-release |
| 融资 | East Ventures 投资的京都系创业公司 | 【已抓取】 https://ascii.jp/elem/000/004/380/4380545/ |
| 定位一句话 | ハッカソンの集客・参加者管理・チーム編成・連絡・成果物収集・分析までの全工程をワンストップで実現するハッカソン専用プラットフォーム（把黑客松从招募、参与者管理、团队编成、联络、成果物收集到分析的全流程一站化） | 【已抓取】 同上 ASCII STARTUP 转载 PR TIMES |
| 目标客户 | IT企业（人才发掘）、开发者工具企业、地方自治体、教育机构（大学/PBL）、大企业内部黑客松、学生社群 | 【已抓取】 官网 use-cases 区块与 FAQ |
| 里程碑 | 2024-11-25 α版发布 → 2026-03-12 正式公开（此前为 private beta） | 【已抓取】 同上两个来源 |
| 规模自述 | 累計開催数 76件、登録ユーザー数 800名以上（2026-03-12 时点） | 【已抓取】 ASCII STARTUP 转载 PR TIMES |

官网上关于自身定位的原话（日文原文，可核对）：
> 「CraftStadiumは、ハッカソンで本気のものづくりを実現するためのオールインワンプラットフォームです。NotionやFigmaのように、どなたでもアカウントを作成してすぐに使い始めることができます。イベントページの作成と募集、参加者管理、チーム編成、メール配信、成果物の収集、審査結果の公開、参加者分析までをひとつのツールで完結できます。」
> 来源：https://www.organize.craftstadium.com/ 【已抓取】

### 1.2 定价（公开价格页要点）

来源：https://www.organize.craftstadium.com/pricing 【已抓取】

- **Free：¥0/月**。含：ハッカソン作成・公開、参加者管理、成果物管理、結果発表・賞管理、全参加者へのメール送信、提出フォームのカスタム項目（**1つまで**）
- **Pro：¥20,000/月（税別）**。在 Free 之上追加：
  - チーム選択メール送信（按队伍选择性群发）
  - メールCC設定
  - 応募フォームのカスタム項目（最大20個）
  - 提出フォームのカスタム項目（最大20個）
  - 参加者CSV（含自定义字段）
  - 成果物CSV（含自定义字段）
  - **Webhook通知**
- 重要细节：
  - 「参加者数やイベント規模による従量課金はありません」（**不按人数/规模阶梯计费**）
  - 按月计费，**不做按日折算**
  - 支付：信用卡（Visa/Mastercard/JCB/Amex）+ 发票，走 Stripe
  - 学生社群与教育机构有特别价格（邮件申请）
  - 可随时 Free→Pro 升级；解约后降到 Free，已建活动与数据保留
  - 是否按年签约可询价；Pro 无自助免费试用，需单独商谈
- 另有**付费人工选项**（非软件功能）：咨询与项目管理、法务/奖品授予、评委支持、撰稿、摄影师派遣、专业主持、Demo Day 支持。来源：官网「さらに手厚いサポートが必要な方へ」区块 【已抓取】

### 1.3 典型客户与案例（均为官方公开案例页）

| 案例 | 关键数字（官方口径） | 证据 |
| --- | --- | --- |
| KYOTO PLATEAU HACK 2025（京都市・京都産業大学） | 11 所大学 27 人参加、满意度 94% | 【已抓取】官网 FAQ |
| DDASH Hacks 2025（同志社大学，全学型正课外语教育） | 报名 109 人、实际参加 98 人、28 支队伍 | 【已抓取】官网用例区块 |
| GDGoC Japan Hackathon 2026（Google Developer Groups on Campus Japan） | **全国 7 会场、331 人、88 支队伍**，仅靠学生运营团队；参与者问卷 5 分制均分 4.23 | 【已抓取】https://www.organize.craftstadium.com/case-study/gdgoc-japan-hackathon-2026 |
| 同志社ローム記念館プロジェクト（高中生×大学生混合 Ideathon） | 约 40 人、7 支队伍、满意度 90% | 【已抓取】https://www.organize.craftstadium.com/case-study/doshisha-rohm |
| 株式会社ストライク（M&A 企业做技术招聘渠道） | 官方称通过赞助关西 Beginners Hackathon 建立高效工程师招聘渠道 | 【已抓取】案例索引页 |
| SPAJAM 実行委員会 | 事务局长证言：靠 CraftStadium 触达"此前不知道 SPAJAM"的人群，扩宽参赛者基数 | 【已抓取】ASCII STARTUP 转载 PR TIMES |
| CoPalette 自办宿泊型黑客松 3 次 | 累计 128 人、参与者满意度 92.6%、赞助商满意度 88.1% | 【已抓取】官网资源页 |

### 1.4 主办方视角功能清单

| 环节 | CraftStadium Organize 的实际状态 | 证据强度 |
| --- | --- | --- |
| 活动创建与配置 | 有。可设置主题、使用技术、目标技能集（AI/IoT/Web3，SDGs/医疗等社会课题）。有**分步向导式 planner**，新手按顺序填即可建活动 | 【已抓取】官网 FAQ + 首页功能区块 |
| 报名表单与资格审核 | 有。応募フォーム可加自定义字段（Free 0 个 / Pro 最多 20 个）。**选考方式可选"先着顺"或"抽选（随机选考）"**，并支持取消名额再抽选、与人工选考组合；可按**职种限制、毕业年份限制**做「学生限定」「工程师限定」定向。多会场场景可为每个会场建独立活动页，再用**组织仪表盘横断查看** | 【已抓取】官网 FAQ、pricing、ASCII STARTUP 转载 PR TIMES |
| 团队编成规则 | 有，且是它的核心卖点。**三种模式**：① 参与者建队+主办方调整 ② 参与者自由建队 ③ 主办方编成。任何模式下主办方都可改成员位置、跨队移动。**队伍状态 4 段**：募集中→调整中→確定→ロック。UI 为拖拽式；参与者档案里的技能会自动带入编成视图 | 【已抓取】ASCII STARTUP 转载 PR TIMES + 官网首页功能区块 |
| 人数上下限 / 跨赛道 | 团队人数上限、单队最少数、跨赛道组队规则**未在公开页说明**；公开的《Common Hackathon Rules》只说「チーム参加の場合の人数制限は、各ハッカソンで個別に設定されます」 | **【未获取】**（需登录后台才能确认） |
| 通知与邮件 | 有。**内置 Markdown 兼容的 HTML 邮件编辑器**，支持插入图片与 `{name}` `{team_name}` 等变量做个性化；Free 仅能发给全体参与者，Pro 可按队伍选择发送 + 设置 CC | 【已抓取】官网首页 + pricing |
| 材料/成果物收集 | 有。**GitHub App 联动**：参与者从下拉里选仓库即完成提交；平台统一收集"项目名・说明・GitHub 仓库"。Pro 可加最多 20 个自定义提交字段 | 【已抓取】官网首页 + pricing |
| 评审流程与评分 | **部分有**。有：评审基准作为活动信息公开、评委登录、按奖项登记受奖队伍/成果物/**评委评语**、公开时机由主办方切换。**没有**：评委端打分界面、自动汇总计分 | 【已抓取】官方自述「審査・採点」为 △：「審査基準の掲示と審査員の登録には対応している一方、審査員が点数を入力して自動集計する機能は搭載していない」来源 https://www.organize.craftstadium.com/resources/hackathon-tool-comparison-luma-connpass-craftstadium |
| 结果发布 | 有。按奖项登记受奖队伍+成果物+评委评语，主办方控制公开时机，生成面向参与者的结果页 | 【已抓取】同上 |
| 活动后数据分析 | 有，**8 种图表自动可视化**：年龄分布、职种分布、经验水平、期望角色、技能排行、地域分布、状态分布、报名时间线。官方强调可直接转用于赞助商报告、自治体议会/厅内成果报告、委托方实绩报告 | 【已抓取】官网首页 + pricing + ASCII STARTUP 转载 PR TIMES |
| 长期影响评估 | **弱**。官方路线图把"成果物分析"列为未来项，未见"长期影响/ROI/后续培育"类功能 | 【已抓取】ASCII STARTUP 转载 PR TIMES「今後の展望」 |
| 明确的缺口（官方自认） | ① 无签到（check-in）功能，当天受理需另想办法 ② **不支持参赛费支付** ③ 社区功能相对 connpass/Doorkeeper 仍发展途中，长期社区运营建议并用他工具 | 【已抓取】官方对比文章 |

### 1.5 关键机制细节

**（a）评审打分模型（公开规则页，非产品功能）**
来源：https://www.craftstadium.com/en/help/penalty-rules 【已抓取】

- 基准分：**一般满分 100 分**，`Base Score = (Judge Evaluation × 0.75) + (Player Peer Evaluation × 0.25)`
  → 即**评委 75% + 选手互评 25%** 的混合模型
- 递减扣分制（按累计扣分决定扣分率）：<5 分 0%（仅警告）；5–10 分 5%；11–20 分 10%；21–30 分 20%；31 分以上**失格**
- 最终分：`Final Score = Base Score × (1 - Deduction Rate)`

**（b）反作弊 / 惩罚规则（这一段是本竞品最"硬"的机制细节）**
同上一来源 【已抓取】

- **提交类**：迟到 15 分钟内 2 分；15 分钟–1 小时 5 分；超过 1 小时 10 分。提交不完整：轻微 1 分/重大 3 分。完全未提交 15 分
- **开发前违规（基于 GitHub 活动历史判定）**：开赛前轻微准备仅警告；开赛前 1 天开始写代码 5 分、2–3 天 10 分、4 天以上 20 分或失格；**复用既有项目 → 直接失格**
- **其他**：盗用创意/侵犯著作权 → 失格；使用非官方工具 轻微 3 分/重大 10 分；违反组队规则 5 分
- **主题偏离**：无 0 分 / 中等 3 分 / 重大 5 分 / 完全无关 → 失格
- 明确写了「公平性を保つため、審査に関わる不正行為は禁止します」
- 资格与合规：《Common Hackathon Rules》规定年龄限制、居住地域限制、禁止使用非公开数据（企业机密/个人信息）、成果物 IP 原则上归参与者、个人信息仅用于活动运营+CraftStadium 服务改善+**向赞助商提供**

**（c）评委分配与回避/冲突处理**
**【未获取】**。公开页只提到"评委登录""评委支持（付费人工服务）"，没有关于评委分配算法、回避（利益冲突）声明的公开说明。官方路线图里列了"審査・投票機能の拡充"和"審査員のサポート"，说明该领域尚未产品化。
旁证：2026-05-21 的 release note 提到「内部監視: 不正利用や設定漏れを管理者側で検知できる仕組み」【已抓取】https://www.craftstadium.com/releases/organize/no-12

**（d）白标 / 多租户**
- 多租户：**有**。有"组织账号"概念、组织仪表盘横断多活动；GDGoC 案例中 7 个会场各建独立活动页 + 组织级横断查看。【已抓取】
- 白标：**【未获取】**。未见自定义域名/品牌白标说明。

**（e）SSO / 企业集成**
- SSO（SAML/OIDC）：**【未获取】**，公开页未见。
- Slack / Teams：**直接集成未见**。官网集成面只有 GitHub App；社区侧是自家 Discord（クラスタ Discord）与 X。【已抓取】
- GitHub：**有**，GitHub App 方式选仓库提交。【已抓取】

**（f）API 与 Webhook**
- **Webhook：有，Pro 功能**。且是"客户提需求→2 天上线"的产物：GDGoC 案例中官方称「相談受領から2日で新機能としてリリース」，**首版即含"按会场分离 Webhook URL"与"签名验证（HMAC）"**，上线首日即生产质量。运营方用 GAS 接收 → 自动写 Google Sheets + 自动回信。【已抓取】案例页
- **API：弱**。官方对比表里 CraftStadium 的「API連携」自评为 **△（制限付き）**。【已抓取】

**（g）数据导出**
- **CSV 导出：有，Pro 功能**，且**带自定义字段**：参加者 CSV、成果物 CSV。【已抓取】

**（h）合规亮点（值得注意）**
2026-05-21 release：为对应日本**职业安定法第 43 条之 2 / 特定募集情报等提供事业**，上线"招聘程序"合规功能：主办方规约同意流程（按组织账号记录）、应募者"向企业提供信息"同意的可见与撤回状态、主办方可自定义最多 5 条规约 URL、内部监控防滥用。【已抓取】https://www.craftstadium.com/releases/organize/no-12

### 1.6 技术栈推断

| 维度 | 判断 | 依据 |
| --- | --- | --- |
| 前端框架 | **Next.js（App Router）+ React** | 【已抓取】HTML 中出现 `/_next/image?url=...&w=1080&q=75` 形态的图片优化 URL、`/_next%2Fstatic%2Fmedia/...` 构建产物路径 |
| 内容/托管 | 静态内容走 **Sanity CDN**（`cdn.sanity.io/images/3b6f9fen/...`），用户素材走自建 `assets.craftstadium.com` | 【已抓取】 |
| 形态 | **多租户 SaaS**（自助注册 `/api/auth/signup`、`/api/auth/login`），非私有化部署 | 【已抓取】 |
| 客户端 | 有 **iOS 原生 App**（App Store id6792485189，参与者向） | 【已抓取】 |
| 第三方组件 | **Stripe** 支付与发票、**GitHub App** 代码提交 | 【已抓取】 |
| 前端框架深层版本 / 后端语言 / 数据库 / 云厂商 | **【未获取】** | 无公开技术博客与招聘 JD 抓到 |
| 迭代节奏 | 用 **GitHub Releases 做公开 release note**（`github.com/copalette/craftstadium-organize-releases`、`craftstadium-user-releases`），且把 issue 公开在 GitHub | 【已抓取】 |

---

## 2. HackathonOS

### 2.1 结论：公开渠道无法确认该产品身份

按任务描述（"全栈的黑客松协作平台，帮助发现黑客松、寻找队友、组建团队并管理申请"）进行了多轮定向搜索：

- 查询词覆盖：`HackathonOS`、`"HackathonOS" platform`、`hackathonos.com`、`hackathonos.dev/.io/.app`、`"Hackathon OS" startup platform team formation applications`、`HackathonOS product hunt`、`HackathonOS github`、以及中文 `HackathonOS 黑客松 平台 组队`
- 直接域名探测（本机 pwsh，DNS 解析）：`hackathonos.com`、`www.hackathonos.com`、`hackathonos.io` → **DNS 无法解析**；`hackathon-os.com` → **连接超时**（非"存在"证据）
- **没有找到任何官方网站、定价页、公司主体或客户案例。**

命中的同名/近名对象，均与任务描述不符或不是主办方侧产品：

| 命中对象 | 实际是什么 | 是否吻合 |
| --- | --- | --- |
| https://www.notion.com/templates/hackathon-os | Notion 模板市场里一个**个人创作者模板**（作者 Mannaswini，Student Developer，github.com/imannaswini），非软件产品、无定价、无公司 | 否 |
| https://devpost.com/software/cat-hackathon-os 、`/hackos` | Devpost 上的**黑客松参赛作品**（项目提交页），不是可采购产品 | 否 |
| https://read.gethalfbaked.com/p/startup-ideas-488-hackathon-os | 一份创业点子 Newsletter 里的"Hackathon OS"**点子条目**（页面返回 403 Cloudflare 拦截，仅有搜索标题） | 否，且【仅搜索摘要】 |
| GitHub `nst-sdc/-H-ckollab`、`harsh3dev/DevMatchups`、`GDGoC-GLAU/ThonHub` 等 | 学生/个人开源项目，"找队友/组队"方向接近，但非"HackathonOS"，无企业主体、无定价 | 否 |

**证据强度：【未获取】（含可复核的否定证据：域名不解析 + 多轮搜索无官网）**

### 2.2 对本次调研的影响

- 本笔记第 2 节的所有条目（产品身份/定价/功能清单/机制细节/技术栈/优缺点）**全部标记为"未获取"**，不编造、不推测填充。
- 如果内部对该竞品有更准确的线索（正确域名、所属公司、Product Hunt 链接、App Store 链接），请提供，我可以再做一轮定向取证。

---

## 3. Brightidea Hackathon 6

### 3.1 产品身份

| 项 | 内容 | 证据强度 |
| --- | --- | --- |
| 官网 | https://www.brightidea.com/ ；产品页 https://www.brightidea.com/solution/hackathon/ | 【已抓取】 |
| 功能全清单 | https://www.brightidea.com/solution/hackathon/features/ | 【已抓取】 |
| 公司 | Brightidea，**1999 年创立**，2000 年推出"业界第一个在线创新平台"；总部 San Francisco（25 Pacific Avenue），另有 New York（1040 Avenue of the Americas, Suite 18A）；自称服务 **300+ 全球品牌** | 【已抓取】https://www.brightidea.com/company/ |
| 产品定位一句话 | 企业级创新管理平台上的 **Hackathon 6** 方案：从规划、参与、评审、度量到长期影响的全生命周期（官方原文：「a pragmatic, purpose-built platform designed to support the full lifecycle of innovation, from planning and participation to judging, measurement, and long-term impact」） | 【已抓取】https://www.brightidea.com/blog/spring-release-2026/ |
| 版本节奏 | Hackathon 6 于 **2026 年 3 月**发布（"launched in March with the most ambitious update to our hackathon solution to date"）；2026 Spring Release 为其演进，2026 Summer Release 继续打磨 | 【已抓取】Spring Release 2026 + Summer Release 2026 |
| 目标客户 | 大型企业 / Fortune 500 的内部创新与员工黑客松。官方原话：「Built from years of running successful events for Fortune 500 companies」；「eliminate guesswork」 | 【已抓取】产品页 |
| 典型客户 | 客户 logo 区：**Adobe、Amazon、Dell、Mastercard、Nike、LinkedIn、Merck**。客户证言：**HP Enterprise**（Ahi Gvirtsman, Head of Innovation）、**Mastercard**（Tobias Puehse, Global Head）、**Discovery**（Avi Saxena, CTO）。公司页另点名 Accenture、Bayer、Cisco、GE、MasterCard；招聘页列 Southwest、Nielsen、Autoliv、Stanley Black & Decker、HP、BT、Cathay Pacific、Cisco、GE | 【已抓取】产品页、公司页、招聘页 |

### 3.2 定价（公开价格页要点）

- **官方站没有价格页，也无免费试用/免费版**：全站均为「Request Demo / Contact Us」线索收集。产品页明确 "Not a Brightidea customer yet? Sign up for a free trial" 只针对 Idea Box 试用（`/start-ideabox-trial/`），Hackathon 6 本身走销售。
- 第三方估算（**非官方，仅作量级参考，不可当价格承诺**）：ITQlick「Brightidea Pricing (2026)」称 **起价约 $99/user/月**，10 用户约 $899/月；实施/上线费 **$1,000（SMB）～$10,000+（企业）**；50 用户年度许可约 **$20,000–$50,000**；三年 TCO 约 **$75,000–$150,000**；隐藏成本包括数据存储超量、额外用户许可、高级分析、专属支持。**该页明确写 "Brightidea offers tailored pricing, making exact figures unavailable without direct consultation"**。
  来源：https://www.itqlick.com/brightidea/pricing 【已抓取】（第三方，非官方）
- 补充：升级与新功能（含 MCP Server）通过 Customer Success Manager 开启，官方称 MCP "for now, it's included at no additional cost"（限已有 AI 足迹的客户优先 onboarding）。【已抓取】Summer Release 2026

### 3.3 主办方视角功能清单

官方 Spring Release 2026 把全生命周期切成 **8 段**，这是一份现成的"主办方流程骨架"，对我们极有参考价值。
来源：https://www.brightidea.com/blog/spring-release-2026/ 【已抓取】

| 阶段 | 官方列出的能力 |
| --- | --- |
| **PLAN** 规划 | 干系人对齐与目标定义；全球项目的结构化时间线；议题与激励配置；赞助与内部干系人对齐；提升员工沟通的 engagement blueprint |
| **SETUP** 配置 | 面向管理员与参与者的**现代化单一 microsite**；自定义设计与配置；**Global Event Scheduler（按每位参与者本地时区自动开赛，一程序一次配置）——标注为 Enterprise License 功能**；自动化工作流与 **Rules Engine** |
| **INCUBATE** 孵化 | 引导式交互式 onboarding；**基于专长与目标的智能组队**；灵活的队伍规模与参与规则；临时 + 定时的沟通工具 |
| **BUILD** 构建 | 专属 **Project Room**（虚拟协作 + 任务跟踪）；白板式工作区（头脑风暴、business case、启动 AI 应用）；**GitHub 与 Jira 等集成** |
| **JUDGE** 评审 | 定性与定量评审工具（保证评估一致性）；**评委实时重排序与对比工具**；按类别查看 Top 想法；完整视频上传与观看 |
| **AWARD** 颁奖 | 专属获奖者页面与内容区块；平台内 + 组织内的表彰与证书 |
| **CLOSE-OUT** 收尾 | **Business impact tracking（跟踪后续增长与支出）**；**Value analysis dashboard（参与度、部门影响等）**；复盘模板为下一届取信号 |
| **REVIEW** 复盘 | 分析提交与参与；用动态标签+自动化识别活动内高价值想法并决定下一步；向全组织讲清活动影响的故事与结果 |
| **TRANSITION** 转化 | 治理跟踪与汇报（read out）；把想法移入**持续工作流**避免判定后停滞；识别新赞助者与新想法 owner；规划并排期下一届黑客松 |

官方 Hackathon 6 功能页按**四类角色**分组（这是很好的产品信息架构参考）：
来源：https://www.brightidea.com/solution/hackathon/features/ 【已抓取】

- **参与者**：报名（收集关键信息、可按专长与可用性搜索参与者）、Onboarding Wizard、**组队（按技能/兴趣/可用时间找队友）**、项目提交视图（实时浏览与互动数据）、**参与者投票**、AI 白板（自动生成 sticky notes）、自动生成 Bio 页、项目提交（定制字段）、聊天与消息（含 emoji 反应）、自定义队名与队徽、黑客松移动 App、项目画廊（浏览/排序/投票）、Project Room、证书（管理员激活后向所有用户发放）、获奖者页面
- **主办方**：可自定义活动站点（日程、评审标准、FAQ）、**Automated Event Scheduler**、可编辑 HTML 邮件模板、**Advanced Judging Management（评委分配、进度跟踪、自动化评估工作流）**、**Timezone Configuration（自动按参与者时区调整活动时间）**、**Advanced Analytics Dashboard（参与度、参与情况、ROI、业务影响）**
- **评委**：**音频评语**（用 iPad/平板录音反馈）、平板评审体验、**Top Proposals Dashboard（按类别分档排名）**
- **平台级**：**Secure Single Sign-On (SSO)**、SOC 2 合规安全、**ISO 56000 合规**、**25+ 集成**

### 3.4 关键机制细节

**（a）评审打分模型**
- 有"定性与定量评审工具"以保持评估一致性、有 scorecard（Spring Release 配图名为 `Reorder_Scorecards_Evaluation.png`）、有评委侧 Top Ideas 与按类别分档、有音频评语与视频提交。【已抓取】
- **具体分值权重、是否加权平均/去极值/标准化：公开文档未见，【未获取】。**

**（b）评委分配与回避/冲突处理**
- 官方宣称 **"Streamlined judge assignments, progress tracking, and automated evaluation workflows"**（评委分配、进度跟踪、评估流程自动化）。【已抓取】
- **回避/利益冲突（COI）声明机制：公开页未见，【未获取】。** 尝试打开 support.brightidea.com（Cloudflare 403）与 developer.brightidea.com（登录门）均无法核对细则。

**（c）反作弊**
- 公开面向客户的页面**没有**反作弊/降级/失格类机制描述。【未获取】（这一点明显弱于 CraftStadium 的公开惩罚规则）

**（d）白标 / 多租户**
- **白标/品牌化：强**。"Customizable Event Site"、"Custom design and configuration capabilities"、自定义 CSS 支持、HTML 自定义 widget（夏季发布明确支持把 AI 生成的 HTML 直接注入自家站点）。【已抓取】
- **多租户/多层级：强**。**Department Idea Box** 让每个部门/事业部在同一平台下跑自己的项目（动态 idea/user 列表、附加 sub-pipeline、setup wizard 逻辑、左侧导航统一）；并有 **access group 层面的负载均衡**（"Load balancing across access groups, improving performance and reliability for large-scale enterprise deployments"）。【已抓取】Summer Release 2026

**（e）SSO / 企业集成**
- **SSO：有**，产品页明确 "Secure Single Sign-On (SSO)"；安全页写 "Clients can easily manage access policies with authentication and Single Sign-On (SSO) options"。【已抓取】
- **Azure AD / Entra ID：有**（集成清单列 Azure Active Directory："Sync your Azure Active Directory with Brightidea via the Azure AD Sync"），并有微软官方 Entra ID SaaS 应用教程（`learn.microsoft.com/.../saas-apps/brightidea-tutorial`，页面本身未抓取成功）。【已抓取集成页 / 微软教程为【仅搜索摘要】】
- **Slack：有**（Brightidea ↔ Slack App，可从 Slack 直接送想法进 Brightidea）。【已抓取】
- **Microsoft Teams：有**（Brightidea ↔ Teams App，同样方向）。【已抓取】
- 其他集成（官方清单，共 25+）：Jira（Cloud/Data Center，可把想法推进去并在 Brightidea 内监控 ticket）、Asana、ServiceNow（双向）、Zapier、Monday.com、Airtable（双向）、SharePoint、Google Drive/Docs、Microsoft 365/Word、Zendesk、Anaqua（IP/专利）、YouTube/Vimeo/Unsplash（内容增强）、Google Analytics、**Power BI**、**Webhooks**、Google Home/Alexa（语音收集想法）、**Azure DevOps（夏季新增）**。【已抓取】

**（f）API 与 Webhook**
- **Webhook：有**。官方页写「You can configure webhooks and Brightidea to push your data to any app endpoint that allows for webhooks」，并给出 Rules Engine 触发外发 HTTP 的配置文档链接（support.brightidea.com/hc/en-us/articles/1500003594882）。【已抓取】
- **API：强，且已"全开放"**。2026 夏季发布原文：「**We've opened our API for full 'headless' access — anything you can do through the browser, you can now do via the API.**」【已抓取】
- **开发者门户存在但需登录**：`developer.brightidea.com` 会跳转到登录页（ct_login），页脚联系邮箱 developer@brightidea.com，且提示支持 **two-factor authentication code**。→ 结论：有正式开发者门户，但**接口目录本身不对未登录者开放**。【已抓取】
- **MCP Server：有（2026 夏季新增）**。基于 Model Context Protocol，可接 Claude、ChatGPT、Microsoft Copilot、AWS Bedrock 及任何 MCP 兼容 agent，让管理员操作配置、终端用户操作想法；需通过 CSM 开启。【已抓取】Summer Release 2026
- **BYOM（Bring Your Own Model）**：可把平台 AI 工作流路由到客户自己的模型端点（Azure OpenAI / AWS Bedrock / 自建防火墙内模型），保持数据驻留与治理。【已抓取】
- **Power BI Connector v4.4**：新增用户名/密码认证、改善数据加载韧性。【已抓取】

**（g）数据导出**
- Power BI Connector（报表/可视化）、CSV 类导出在 release 中被提及（"Comment type added to exports"）、**Project Room Audit Log 可导出用于合规与治理审查**、Business impact / value analysis 仪表盘。【已抓取】Spring + Summer Release 2026

**（h）安全与合规（企业侧的护城河）**
来源：https://www.brightidea.com/security/ 【已抓取】

- 托管在 **AWS**（美国与欧盟区域），AWS 本身有 ISO 27001 / SOC 2 / ISO 27017 / CSA 认证
- **SOC 2 Type II** 认证（页脚徽标 + Cloud Security Alliance STAR 注册）
- 传输 **TLS 1.2+**，静态 **AES-256**，KMS 管钥并**年度轮转**
- 7×24 安全团队、WAF、IDS/IPS、SIEM、DDoS 缓解（AWS Shield/WAF）、DLP、反恶意软件、威胁情报共享、**员工访问生产网络强制 MFA**、每年第三方渗透测试、静态代码扫描、动态 OWASP Top 10 扫描、开发/测试/预发与生产物理逻辑隔离且**非生产不使用客户数据**
- 官网徽标另称 **ISO 56000 合规**（产品页）、G2 Idea Management 领导者、Capterra 评价、**公开状态页 status.brightidea.com**

### 3.5 技术栈推断

| 维度 | 判断 | 依据 |
| --- | --- | --- |
| 形态 | **多租户企业 SaaS**，托管于 AWS（美国/欧盟区域），非本地部署优先 | 【已抓取】安全页 |
| 前端 | 官网为 **WordPress 系**（路径 `/wp-content/uploads/`、`/blog/`、`javascript:liShare(...)` 分享脚本）→ **仅代表营销站，不代表产品前端** | 【已抓取】（营销站证据，非产品栈） |
| 产品前端框架 | 官方写「Brightidea utilizes a modern application framework and prepared statements for all queries」——**只说"现代框架"+预编译语句，未点名** | 【已抓取】安全页；具体框架 **【未获取】** |
| 后端语言/数据库 | **【未获取】**（招聘页在本次抓取中未渲染出职位列表，只有文化宣传） | — |
| AI 基础设施（重要趋势信号） | MCP Server + BYOM（Azure OpenAI / Bedrock / 自建）+ AI 生成 HTML widget 注入 + ChatGPT 集成 | 【已抓取】 |
| 可编程性方向 | 「anything you can do through the browser, you can now do via the API」= 全面 headless 化 | 【已抓取】 |
| 集成工程 | 用 Zapier + Webhooks + Rules Engine 做长尾集成，用专用连接器做头部集成（Slack/Teams/Jira/ServiceNow/Power BI） | 【已抓取】 |

---

## 4. 三家横向对比（主办方视角）

| 能力 | CraftStadium Organize | HackathonOS | Brightidea Hackathon 6 |
| --- | --- | --- | --- |
| 公开定价 | ✅ Free ¥0 / Pro ¥20,000 月，**不按人数计费** | 未获取 | ❌ 全站"联系销售"，第三方估 ~$99/user/月起 |
| 自助开通 | ✅ 邮箱注册即可 | 未获取 | ❌ 必须 demo + 合同 |
| 集客（参赛者来源） | ✅ **自有参赛者池 + 技能推荐 + 关注者通知**（800+ 注册） | 未获取 | ❌ 面向企业内部员工，无外部流量 |
| 报名/资格审核 | ✅ 先着/抽选 + 职种/毕业年限制 | 未获取 | ✅ 报名 + 按专长与可用时间搜索 |
| 团队编成 | ✅✅ 3 模式 + 4 状态 + 拖拽 + 技能自动带入 | 未获取 | ✅ 智能组队（按专长与目标）+ 灵活队规 |
| 通知/邮件 | ✅ 内置 HTML 邮件编辑器 + 变量 + 按队伍发送 | 未获取 | ✅ 可编辑 HTML 邮件模板 + 定时/临时沟通 |
| 成果物收集 | ✅ **GitHub App 选仓库即提交** | 未获取 | ✅ 项目提交 + 视频 + Project Room + GitHub/Jira |
| 评委端打分与自动汇总 | ❌ **没有**（只有评审基准展示 + 评委登记 + 评语登记） | 未获取 | ✅ 有评审门户、scorecard、实时重排序、音频评语、平板评审 |
| 反作弊/惩罚规则 | ✅✅ **公开、可量化、可执行**（扣分表 + 递减扣分 + 失格） | 未获取 | ❌ 公开面未见 |
| 结果发布 | ✅ 按奖项 + 公开时机开关 + 评委评语 | 未获取 | ✅ 获奖者页 + 证书 + 表彰 |
| 活动后分析 | ✅ 8 种图表（属性/技能/时间线） | 未获取 | ✅✅ 参与度 + **ROI + 业务影响 + 长期价值分析 + 复盘模板 + 想法转入持续管道** |
| 多时区 | 未获取（有多会场横断视图，非时区引擎） | 未获取 | ✅✅ **Global Event Scheduler 按参与者本地时区自动开赛**（企业许可） |
| SSO | 未获取 | 未获取 | ✅ SSO + Azure AD/Entra 同步 |
| Slack/Teams | ❌（只有自家 Discord） | 未获取 | ✅✅ 双向 Slack App + Teams App |
| API | △ 官方自评"受限" | 未获取 | ✅✅ 全面 headless API + 开发者门户 + MCP Server |
| Webhook | ✅ Pro，**含 HMAC 签名 + 按会场分 URL** | 未获取 | ✅ Rules Engine 触发外发 HTTP |
| 数据导出 | ✅ Pro，参与者/成果物 CSV（带自定义字段） | 未获取 | ✅ Power BI Connector + 导出 + 可导出审计日志 |
| 白标/多租户 | 多租户✅ / 白标未获取 | 未获取 | ✅✅ 品牌自定义 + HTML widget + Department Idea Box |
| 支付/签到 | ❌ 两者都没有 | 未获取 | 未见（企业内部活动通常不需要） |
| 中文/日文界面 | 日英双语，**无中文** | 未获取 | 英文为主 |
| 合规侧重 | 日本职业安定法 43-2（招聘信息提供） | 未获取 | SOC 2 Type II / ISO 56000 / GDPR 向 |

---

## 5. CraftStadium Organize：优点与可超越点

### 5.1 优点（为什么强 / 我们能不能做）

1. **"团队编成"做成了产品级的可操作对象，而不是一个表单字段。**
   3 种编成模式 + 4 段状态机（募集中→调整中→確定→ロック）+ 拖拽 + 参与者技能自动带入 + 跨队移动。
   *为什么强*：黑客松运营最痛、最耗时、最容易出错的就是编队，且它有天然的状态流转与并发冲突（有人退赛、有人加人），是个真问题、真机制。
   *我们能不能做*：**能，而且我们的 M02（项目/团队/成员/邀请）已经有 ProjectMembership 与名额/接受的同事务持久化。** 差距是我们没有"队伍状态机 + 编成视图"，这是纯业务层增量。

2. **成果物收集走 GitHub App"选仓库即提交"，把提交成本压到最低。**
   *为什么强*：直接消灭"填表 + 贴链接 + 传压缩包"的流失；同时天然拿到 commit 时间线，为反作弊判定提供数据源。
   *我们能不能做*：**能。** 我们已有 M06（仓库、版本保存、运行验证、提交记录）与 GitHub App 用户授权 + 加密凭据库，是最接近的既有资产。

3. **把"活动后分析"当一等公民，并且明确指向"向外汇报"。**
   8 种图表 + 官方话术"可直接转用于赞助商报告、自治体议会/厅内报告、委托方实绩报告"。
   *为什么强*：它卖的不是效率，是**主办方的向上交付能力**——这是自治体/大学/大企业真正付费的理由。
   *我们能不能做*：**能，但要注意口径。** 我们能做的是真实派生统计（按我们的原则：真实任务/检查派生，不造第二份完成状态）。

4. **反作弊规则是公开的、可计算的、有层级递进的。**
   扣分表 + `Base = Judge×0.75 + Peer×0.25` + 递减扣分率 + 31 分失格 + 用 GitHub 活动历史判定"开赛前就写代码"。
   *为什么强*：这是**规则即产品**。公开规则降低了争议与人工裁量，也让"公平"变成可审计的数字。
   *我们能不能做*：**能，而且这是最容易被低估的高价值项。** 我们 M03 已有"规则版本"，M06 有 commit 记录——把两者接起来就是"基于仓库事实的赛前违规检测"。

5. **Webhook 的工程态度：需求到生产 2 天，首版就带按会场分 URL + HMAC 签名验证。**
   *为什么强*：证明团队把"可集成性"当作一等需求；HMAC 签名说明他们对伪造回调有真实威胁模型。
   *我们能不能做*：**能。** 我们已有服务端组装与通知桥接，加签名/重放保护是明确可实现的工程量。

6. **合规前置：为日本《职业安定法》第 43 条之 2 做了完整同意-撤回-规约-监控链路。**
   *为什么强*：这是"企业/自治体敢不敢用"的门槛项，一般小团队不会想到；一旦做了，就是行业准入证。
   *我们能不能做*：**能，但要注意本地法域。** 中国场景对应的是个人信息保护法与"向第三方提供个人信息"的单独同意 + 撤回机制——机制同构，我们可以直接借这个骨架。

### 5.2 弱点与我们可超越的点

1. **评委端打分与自动汇总是空的——这是最大的功能缺口。**
   官方自评"審査・採点 △"，明文承认"審査員が点数を入力して自動集計する機能は搭載していない"；主办方仍要在表格里评审再回填。
   *我们可以超越*：做**在线评分卡 + 自动汇总 + 去极值/加权规则 + 评委进度看板**。权重模型可直接参考它公开的"评委 75% + 互评 25%"作为默认模板（并允许主办方改）。**这是我们最明确的一击。**

2. **API 受限（自评 △），没有 SSO、没有 Slack/Teams。**
   大企业和大学 IT 部门常把 SSO 列为硬性采购条件；它目前答不上来。
   *我们可以超越*：至少有清晰的对外 API 契约 + Webhook 事件目录（已有 Pro Webhook 作参照），并把"企业集成"列入路线图而不是事后补。

3. **完全不做中文。** 双语只有日/英（`/en` 与根路径日语切换）。
   *我们可以超越*：中文原生 + 中文主办方话术/模板（评审基准模板、时间表模板、奖项与赞助设计）。这正是我们的主场。

4. **价格台阶偏陡：Free→Pro 直接 ¥20,000/月（约合人民币千元级），中间没有档位。**
   而且**按队伍群发邮件、CSV 导出、Webhook、报名表单自定义字段（Free 为 0 个！）这些"运营刚需"全被锁在 Pro**。
   *我们可以超越*：把"报名表单自定义字段 + CSV 导出 + 按队伍通知"放进免费或低价层；用**按场次/按活动计费**或"免费基础 + 用量付费"替代刚性月费。对学生社群与小主办方，¥20,000/月 是硬门槛。

5. **没有支付、没有签到、社区功能自认"发展途中"。**
   官方路线图才把"決済機能の統合""審査・投票機能の拡充"列为未来项。
   *我们可以超越*：不追求全都要，但**"评审+投票"是我们可以在它之前做完的**；另外"当天签到/受付"与"参赛费"是清晰可插拔的模块，适合做集成而非自研。

6. **它是"工具+人工服务"的混合体，边际成本不低。**
   大量能力靠付费人工选项（咨询、法务、评委支持、撰稿、摄影、主持、Demo Day）与专属 CSM；案例页也坦白"运营团队仍主导数据录入"（导入流程 step 5：現段階では、運営チームが主体となって入力）。
   *我们可以超越*：把"数据录入"变成**自助 + 导入向导 + 模板**，让主办方零服务依赖跑完第一场；把人工服务做成可选增值而不是事实上的必经之路。

---

## 6. Brightidea Hackathon 6：优点与可超越点

### 6.1 优点

1. **它把"活动后"做成了产品，而不是报表。**
   CLOSE-OUT（business impact tracking、value analysis、复盘模板）→ REVIEW（用动态标签+自动化识别高价值想法）→ TRANSITION（把想法移入**持续工作流**、找新 sponsor 与新 owner、排期下一届）。
   *为什么强*：竞品普遍在"结果公布"就结束，它回答了大企业真正的问题——**"这场活动到底值多少钱，下一步怎么办"**。
   *我们能不能做*：**部分能。** 我们能做"从赛事沉淀到项目/经验复用"的链路（我们已有 M07 复盘与选择性复用、M03 规则版本）——这正是它 TRANSITION 段的等价物，而且我们不需要企业级 ROI 模型就能做出真实价值。

2. **Global Event Scheduler：按每位参与者本地时区自动开赛，一次配置。**
   *为什么强*：跨时区全球员工活动里，这是最容易出错、也最难手工维护的部分；把它做成引擎而不是"排期表"是真正的工程投入。
   *我们能不能做*：**能，成本可控。** 我们的时间窗口/计划模块（M05）已经是版本化时间事实，加"本地时区渲染 + 自动开赛触发"是明确增量。

3. **角色化信息架构非常干净：参与者 / 主办方 / 评委 / 平台级 四组。**
   *为什么强*：评委被当成**一等用户**（专属门户、平板体验、音频评语、Top Proposals 分档），这让"评委体验"成为可交付物。
   *我们能不能做*：**能，而且应该照抄这个结构。** 我们的 M04（提问/评分/共享摘要/分工）已经有评分骨架，欠的是一个真正的"评委视角"页面与进度跟踪。

4. **开放的 headless API + MCP Server + BYOM。**
   官方原话"anything you can do through the browser, you can now do via the API"；MCP 可接 Claude/ChatGPT/Copilot/Bedrock；AI 工作流可路由到客户自己的模型。
   *为什么强*：这是把"平台"变成"基础设施"的姿态，而且尊重企业的数据驻留与治理要求。
   *我们能不能做*：**能，且我们已有 DSH 结构化任务链路与"AI 队列+预算"控制。** 关键差距不是能力而是**对外契约的稳定性与文档化**。

5. **企业级安全与合规是实打实的资产。**
   SOC 2 Type II、AWS 美/欧区域、TLS1.2+/AES-256/KMS 年轮转、7×24 安全、年度三方渗透、DLP、生产网络强制 MFA、非生产不使用客户数据、公开状态页。
   *为什么强*：这是大企业采购的"入场券"，不是营销词。
   *我们能不能做*：**短期不能照搬（认证成本高）**，但可以做**结构对齐**：明确数据驻留说明、凭据加密、审计日志（它 2026 才补 Project Room Audit Log —— 我们可以一开始就有）、权限最小化。

6. **集成广度：25+，且头部集成是双向的。**
   Slack/Teams 双向、Jira Cloud + Data Center、ServiceNow 双向、Airtable/Monday 双向、Power BI、Azure DevOps、Zapier、Webhooks、Rules Engine。
   *为什么强*：大企业不会为工具改变工作方式，集成就是采纳率。
   *我们能不能做*：**渐进能做。** 优先做 Webhook 出站 + Slack/飞书/企业微信的**单向推送**（通知与结果），比追求双向同步更划算。

### 6.2 弱点与我们可超越的点

1. **价格与门槛：没有公开价格、没有免费版、必须 demo 与合同；第三方估算 ~$99/user/月起、实施费 $1,000–$10,000+、三年 TCO 可达 $75,000–$150,000。**
   *我们可以超越*：**透明定价 + 自助开通 + 免费档能跑完一整场**。这一条直接复制 CraftStadium 的 Free 档策略（并被市场验证有效）。

2. **它只服务大企业，中小企业、学生社群、地方社群基本无解。**
   官方话术全部围绕 "enterprise"、"Fortune 500"、"global programs"、"workforce"；参赛者是**自家员工**，不解决"从哪找参赛者"。
   *我们可以超越*：**我们同时供给"找比赛"和"办比赛"两侧**，这是它结构上做不到的（内部员工活动不需要外部流量）。

3. **反作弊/公平性在公开面完全缺失。**
   没有惩罚规则、没有赛前违规检测、没有失格机制；而 CraftStadium 有一整套量化规则。
   *我们可以超越*：把 CraftStadium 的扣分表思路 + 我们的 GitHub 提交事实结合，做成**可配置的公平性规则包**，并默认开启基础项（如"提交截止后仓库变更记录"）。

4. **同一平台里塞了太多东西，黑客松只是其中一个 app。**
   Idea Box / Program / Lab / Ecosystem / Transformation / Whiteboard / Memo / Department Idea Box……2026 夏季发布里 Hackathon 只占一节，其余是部门 Idea Box 与平台级改造。
   *我们可以超越*：**专注黑客松一条主线**，把"从找比赛到赛后复用"做深，而不是做通用创新管理系统。专注度就是我们的差异化。

5. **AI 能力的开启方式仍受销售流程约束。**
   MCP Server 要"Contact your Customer Success Manager to enable it"，且"优先 onboarding 已有 AI 足迹的客户"。
   *我们可以超越*：**AI 能力默认内置、默认可用、可自助开关**，并用我们已有的成本上限与 hold 机制给出"每场活动 AI 花费上限"的可承诺数字（这是它公开材料里没有的透明度）。

6. **它是"专家服务 + 软件"的组合，实施重，迭代以季度 Release 计。**
   "Coaching & Support"、"innovation consultants who work as an extension of your team"、按季度 Spring/Summer/Fall Release。
   *我们可以超越*：**自助上手 + 周级迭代 + 公开变更日志**。它对大企业是优点（稳定），对中小主办方是"太重、太慢"。

---

## 7. 证据与来源

### 7.1 CraftStadium Organize

| # | URL | 用途 | 强度 |
| --- | --- | --- | --- |
| C1 | https://www.organize.craftstadium.com/ | 定位、六大功能、8 种图表、案例索引、FAQ（定价口径、自治体/教育/企业适配） | 【已抓取】 |
| C2 | https://www.organize.craftstadium.com/pricing | Free/Pro 价格与功能对照表、Stripe/发票、教育优惠、解约规则 | 【已抓取】 |
| C3 | https://www.organize.craftstadium.com/about/flow | 导入 6 步流程；关键句"运营团队仍主导数据录入" | 【已抓取】 |
| C4 | https://www.organize.craftstadium.com/case-study/gdgoc-japan-hackathon-2026 | 7 会场 / 331 人 / 88 队；Webhook 2 天上线含 HMAC 与按会场分 URL；GAS+Sheets 自动化；运营方提出的待实现需求清单 | 【已抓取】 |
| C5 | https://www.organize.craftstadium.com/case-study/doshisha-rohm | 40 人 / 7 队 / 满意度 90%；CraftStadium 的流程设计与评委指南支持 | 【已抓取】 |
| C6 | https://www.organize.craftstadium.com/resources/hackathon-tool-comparison-luma-connpass-craftstadium | 13 项功能对比表（含"審査・採点 △"的自认缺口、API △）；与 Luma/connpass/TECH PLAY/Peatix/Doorkeeper 的价格与手续费对比 | 【已抓取】 |
| C7 | https://www.craftstadium.com/en/help/penalty-rules | 扣分表、主题偏离、递减扣分率、`Base = Judge×0.75 + Peer×0.25`、最终分公式 | 【已抓取】 |
| C8 | https://www.craftstadium.com/en/help/common-rules | 参赛资格、团队规模"由各活动自定"、数据与 IP 规定、个人信息向赞助商提供 | 【已抓取】 |
| C9 | https://www.craftstadium.com/overview | 参与者侧数据（SPAJAM 各场次报名/容量、JPHACKS 容量 ∞） | 【已抓取】 |
| C10 | https://www.craftstadium.com/releases/organize/no-12 | 2026-05-21 发布：职业安定法 43-2 招聘程序合规功能（组织级同意、同意撤回可见、最多 5 条规约 URL、内部监控） | 【已抓取】 |
| C11 | https://www.copalette.org/news/craftstadium-organize-alpha-release | 公司概要（京都、2023-05、资本金 710.2 万日元、代表山本新）、α 版 2024-11-25、Roadmap | 【已抓取】 |
| C12 | https://ascii.jp/elem/000/004/380/4380545/ | 正式公开 2026-03-12（转载 PR TIMES）、三种编队模式、队伍 4 状态、先着/抽选、{name}/{team_name} 变量、GitHub App、8 图表、累计 76 场/800+ 注册、East Ventures 投资、未来展望 | 【已抓取】 |
| C13 | https://www.craftstadium.com/en/help | 帮助中心结构（词汇表、通用规则、惩罚规则、选手政策、条款、隐私、招聘程序条款、账号删除） | 【已抓取】 |

### 7.2 HackathonOS

| # | URL | 用途 | 强度 |
| --- | --- | --- | --- |
| H1 | https://www.notion.com/templates/hackathon-os | 搜索结果中唯一的同名条目；实为个人 Notion 模板（作者 Mannaswini / Student Developer / github.com/imannaswini），非主办方软件 | 【已抓取】（判定：不吻合） |
| H2 | https://read.gethalfbaked.com/p/startup-ideas-488-hackathon-os | 创业点子 Newsletter 中的"Hackathon OS"条目；**页面返回 403（Cloudflare 拦截），正文未取得** | 【仅搜索摘要】+ 抓取失败 |
| H3 | https://devpost.com/software/cat-hackathon-os | Devpost 上的参赛作品（非产品） | 【仅搜索摘要】 |
| H4 | https://devpost.com/software/hackos | 同上，"HackOS" | 【仅搜索摘要】 |
| H5 | https://github.com/topics/hackathon-platform | 开源项目集合，未见名为 HackathonOS 的商业产品 | 【仅搜索摘要】 |
| H6 | 域名探测（本机 pwsh） | hackathonos.com / www.hackathonos.com / hackathonos.io → DNS 无法解析；hackathon-os.com → 连接超时 | 【已实测】 |

**结论：未能确认 HackathonOS 的产品身份；该竞品全部条目记为"未获取"。**

### 7.3 Brightidea Hackathon 6

| # | URL | 用途 | 强度 |
| --- | --- | --- | --- |
| B1 | https://www.brightidea.com/blog/spring-release-2026/ | **全生命周期 8 段骨架**（PLAN/SETUP/INCUBATE/BUILD/JUDGE/AWARD/CLOSE-OUT/REVIEW/TRANSITION）原文；Global Event Scheduler 标注 Enterprise License；Rules Engine | 【已抓取】 |
| B2 | https://www.brightidea.com/solution/hackathon/ | 定位、客户 logo（Adobe/Amazon/Dell/Mastercard/Nike/LinkedIn/Merck）、能力卡片、HPE/Mastercard/Discovery 证言、"Fortune 500"话术 | 【已抓取】 |
| B3 | https://www.brightidea.com/solution/hackathon/features/ | 参与者/主办方/评委/平台级 四组功能全清单；SSO、SOC 2、ISO 56000、25+ 集成 | 【已抓取】 |
| B4 | https://www.brightidea.com/company/ | 1999 创立、2000 首个在线创新平台、300+ 全球品牌、SF+NY 办公室、Accenture/Bayer/Cisco/GE/MasterCard | 【已抓取】 |
| B5 | https://www.brightidea.com/security/ | AWS（美/欧）、SOC 2 Type II、CSA STAR、TLS1.2+/AES-256/KMS 年轮转、7×24、IDS/IPS、SIEM、DLP、生产网络 MFA、年度三方渗透、环境隔离 | 【已抓取】 |
| B6 | https://www.brightidea.com/integrations/ | 25+ 集成清单（Slack/Teams/Jira/ServiceNow/Asana/Zapier/Airtable/Monday/SharePoint/Google/Power BI/Webhooks/Azure AD/Azure DevOps…） | 【已抓取】 |
| B7 | https://www.brightidea.com/integrations/webhooks/ | Webhook 能力描述与外发 HTTP 配置文档链接 | 【已抓取】 |
| B8 | https://www.brightidea.com/blog/summer-release-2026/ | **"opened our API for full headless access"**、**MCP Server**、BYOM、AI Vibe Widgets、Department Idea Box、Global Event Scheduler、Project Room Audit Log、Power BI Connector v4.4、Azure DevOps | 【已抓取】 |
| B9 | https://www.brightidea.com/careers/ | 客户 logo（Southwest/Nielsen/Autoliv/Stanley Black & Decker/HP/BT/Cathay Pacific/Cisco/GE）；职位列表未渲染 | 【已抓取】（职位列表【未获取】） |
| B10 | https://www.itqlick.com/brightidea/pricing | **第三方**定价估算：~$99/user/月起、实施费 $1,000–$10,000+、50 用户年许可 $20k–$50k、3 年 TCO $75k–$150k、无免费试用/免费版 | 【已抓取】（第三方，非官方） |
| B11 | https://support.brightidea.com/hc/en-us/articles/52426663484179-Brightidea-MCP-Overview | 搜索结果显示存在 MCP Overview 与 MCP Authentication & Access 文档 | 【仅搜索摘要】+ 抓取失败（Cloudflare 403） |
| B12 | https://developer.brightidea.com/ | **开发者门户存在，但跳转登录页**（含 2FA 提示、developer@brightidea.com） | 【已抓取】 |
| B13 | https://developer.brightidea.com/PowerBIConnector | 同上，需登录 | 【已抓取】 |
| B14 | https://learn.microsoft.com/en-us/entra/identity/saas-apps/brightidea-tutorial | 微软官方有 Brightidea 的 Entra ID SSO 配置教程 → SSO/Azure AD 集成存在 | 【仅搜索摘要】（抓取失败） |

---

## 8. 未能确认项（不编造，逐条列出）

### 8.1 HackathonOS（全部未确认）

1. 官方域名与官网内容 —— **未获取**（域名不解析、多轮搜索无官网）
2. 公司主体、成立时间、融资 —— **未获取**
3. 定价页与价格数字 —— **未获取**
4. 目标客户与任何客户案例 —— **未获取**
5. 全部主办方视角功能（活动创建/报名/团队编成/通知/成果物/评审/结果/分析）—— **未获取**
6. 评审打分模型、评委分配与回避、反作弊 —— **未获取**
7. 白标/多租户、SSO、Slack/Teams、API/Webhook、数据导出 —— **未获取**
8. 技术栈（框架、托管、是否多租户 SaaS）—— **未获取**
9. 甚至连"它是一个真实可采购产品"这一点也**未能确认**

> 建议：请内部提供正确域名/公司名/Product Hunt 或 App Store 链接，我可再做一轮定向取证。

### 8.2 CraftStadium Organize

1. **团队人数上下限的具体配置能力**（单队最小/最大人数、跨赛道组队规则）—— 公开页无，需登录后台 —— **未获取**
2. **评委分配算法与利益冲突/回避机制** —— 公开页无 —— **未获取**
3. **SSO / SAML / OIDC** —— 公开页无 —— **未获取**
4. **白标 / 自定义域名 / 品牌定制** —— 公开页无 —— **未获取**
5. **公开 API 契约与文档**（官方自评 API 为"受限"）—— 文档未获取
6. **技术栈深层信息**：Next.js 版本、后端语言、数据库、云厂商、是否容器化 —— **未获取**（无技术博客、招聘 JD 未抓到）
7. **Free 档报名表单自定义字段为 0 个**（价格页表中 Pro 才有"应募フォームのカスタム項目（最大20個）"，而 FAQ 只提到 Free 含"提出フォーム"1 个）—— 已抓取到该表述，但**免费档是否真的连一个自定义报名字段都不能加，建议以后台实测确认**
8. **长期影响评估类功能** —— 官方未做，路线图仅列"成果物分析" —— 记为**未提供**
9. 价格页未给出**年付折扣具体数字** —— **未获取**

### 8.3 Brightidea Hackathon 6

1. **官方价格**：官网无定价页、无免费版/自助试用 —— **未获取**（第三方估算不可作为价格承诺）
2. **评审打分模型的具体权重与汇总算法**（是否去极值/标准化/加权）—— **未获取**
3. **评委利益冲突/回避（COI）机制** —— **未获取**
4. **反作弊/公平性机制** —— 公开面完全未见 —— **未获取**（倾向"没有"）
5. **团队人数上下限的具体配置界面**（官方只说"Flexible team size and participation rules"）—— 细节 **未获取**
6. **Hackathon 6 的独立定价与许可层级**：Global Event Scheduler 标注 "Enterprise License"，但完整许可矩阵 —— **未获取**
7. **产品前端框架、后端语言、数据库** —— 安全页仅写"modern application framework" —— **未获取**
8. **support.brightidea.com 与 developer.brightidea.com 的具体文档内容** —— 403 / 登录门 —— **未获取**
9. **MCP Server 的实际工具清单与鉴权方式** —— 文档未能打开 —— **未获取**
10. **是否支持中文界面/中文文档** —— 未见 —— 记为**未提供**

---

## 9. 给我们的三条可落地借鉴（机制级，非口号）

1. **做"评委台"这个竞品都缺/都重的产品面。**
   CraftStadium 明确没有评委打分与自动汇总；Brightidea 有但只卖给大企业。
   可实现的默认机制（可直接采用 CraftStadium 公开的模型作为模板）：
   `Base = 评委均分 × 0.75 + 选手互评 × 0.25`，叠加**递减扣分率**（<5→0%、5–10→5%、11–20→10%、21–30→20%、≥31→失格），`最终分 = Base × (1 − 扣分率)`；扣分项公开可配（迟到、提交不全、未提交、赛前违规、复用旧项目、主题偏离、组队违规）。
   配套：评委进度看板、按奖项/赛道分档、评委回避声明（勾选"本队与我存在利益关系"后自动排除）。

2. **把"提交"做成选中仓库即完成，并把 commit 事实接进公平性规则。**
   CraftStadium 用 GitHub App 选仓库提交，Brightidea 把 GitHub 放进 Project Room 集成。
   我们已有 M06 仓库与提交记录、以及 GitHub App 用户授权与加密凭据 —— 可直接做：
   提交 = 选择本队仓库（含分支/commit 固定）+ 可选提交表单字段；
   公平性 = 用 commit 时间线自动标记"截止后变更""开赛前提交"，输出可审计的扣分建议（人工确认后生效，避免误判）。

3. **把"活动后"做成真实复用链路，而不是报表。**
   Brightidea 的 TRANSITION 段（把想法移入持续工作流、找新 owner、排下一届）与 CraftStadium 的"8 图表直接用于上报"都可以压缩成一个我们能做的闭环：
   活动结束 → 结果与评语归档 → 参与队伍/成果物一键转为**项目/复盘条目**（复用我们 M07 复盘与选择性复用）→ 自动生成"下一届可复用清单"（评审基准版本、时间表、奖项与赞助结构）。
   关键红线：不新建第二份完成状态，全部从既有真实事实派生。

---

*本笔记为只读调研产物，未注册任何账号、未提交任何表单、未执行目标站点代码。所有引用以原始 URL 为准；标注【未获取】处请勿当作事实使用。*
