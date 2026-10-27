# M10 技能库、赛道包与本地桥接交付

日期：2026-10-08。代码所有者目录 `src/modules/skills/`，开发 CLI `scripts/skills-bridge.mts`。无新增依赖，无安装第三方 skill 到真实用户目录。所有写入测试仅使用独立系统临时项目。

## 根接线

1. 将 `src/modules/skills/schema.sql` 加入下一条根迁移（SQL 可在根既有事务执行；不修改旧迁移）。它创建技能、套餐、安装计划、回执与审计表。
2. 初始化持久化仓库，首次启动写入已审查的固定版本初始目录；幂等初始化不会恢复被撤回的技能。
3. 创建服务和 HTTP 工厂，按下表接路由。根继续执行真实会话、Origin、方法映射、请求超时和体积限制。M10 工厂也校验私有会话与写操作，公开 bridge 路由以短期安装凭证验证授权。

```ts
import { createPostgresSkillsRepository, seedInitialSkills,
  createSkillsService, createSkillsHttpHandlers } from "../modules/skills/index.ts";

const skillsRepository = createPostgresSkillsRepository(database);
await seedInitialSkills(skillsRepository);
const skills = createSkillsService({ repository: skillsRepository, clock, ids });
const skillHandlers = createSkillsHttpHandlers({ service: skills,
  resolveActor, assertMutationAllowed, requestId: () => ids.next() });
```

所有普通接口响应为 `{ data, requestId }`；错误为 `{ error:{code,message}, requestId }`。下载接口直接返回独立 JavaScript 附件。

| HTTP 路由（前缀 `/api/v1`） | 工厂 handler | 结果 / 输入 |
| --- | --- | --- |
| GET `/skill-agents` | `agents` | `{items: AgentAdapter[]}`，八工具及真实证据级别 |
| GET `/skills` | `list` | `agentId/track/category/search` 筛选，`{items:Skill[],nextCursor:null}` |
| GET `/skills/:id` | `detail(id)` | `Skill`，含中文教程、版本、许可与兼容证据 |
| GET `/skill-bundles` | `bundles` | `{items:TrackBundle[],nextCursor:null}` |
| GET `/skill-bundles/:id` | `bundle(id)` | 固定版本套餐与必需/可选项 |
| POST `/me/skill-installation-plans` | `createPlan` | `{agentId,scope:"project",bundleId}` **或** `skillVersionIds`；另需 `acknowledgeUnverifiedCompatibility:true` |
| GET `/me/skill-installation-plans/:id` | `plan(id)` | 本人计划，ID 字段为 `planId` |
| GET `/me/skill-installation-plans/:id/manifest` | `manifest(id)` | 精确清单；下载不等于安装 |
| POST `/me/skill-installation-plans/:id/confirm` | `confirm(id)` | 输入 `{manifestHash,confirm:true}`；返回 `{plan,bridgeToken}` |
| GET `/me/skill-installations` | `installations` | 本人的 `{plans,receipts}` |
| POST `/skill-bridge/authorize` | `authorizeBridge` | `{planId,manifestHash,bridgeToken}`；返回 `{manifest,manifestHash}` |
| POST `/skill-bridge/receipts` | `bridgeReceipt` | 同上凭证加 `receipt`；返回保存的回执 |
| GET `/skill-bridge/download` | `downloadBridge` | 下载 `hackathon-skills-bridge.mjs`，无第三方运行依赖 |
| POST `/admin/skills/:id/versions/:versionId/withdraw` | `withdraw(id,versionId)` | 运营角色，`{reason}`；阻止尚未执行的对应计划 |

`bridgeToken` 是随机 256 位短期执行授权，只在确认时返回，数据库仅保存 SHA256。再次确认会轮换凭证。网页仅在内存保存，不能放 URL、日志或 LocalStorage；它不是登录或通用 API token。服务器从可信计划确定用户、工具、版本和清单，忽略请求中伪造的用户身份。计划 15 分钟有效；桥接在下载前与真正写入前重新查询未撤回状态。更新已存在的同一回执允许其用户自报结果或撤销同步，不能借此新建过期安装。

## 网站与本机连接

用户不需要克隆整站源码。从真实下载入口获得独立 `.mjs` 文件，准备 Node.js 24+ 后，在自己的终端运行：

```powershell
node .\hackathon-skills-bridge.mjs --project-root 'D:\我的参赛项目' --origin 'https://实际网站域名'
```

本地开发用实际 origin，如 `http://127.0.0.1:3000`。`--server` 可省略，若提供必须与 origin 完全相同。`--port 0` 默认选择空闲端口。只接受 HTTPS 或明确 loopback HTTP，不接受任意服务器 URL、路径、shell 文本。

网络代理可用 `--proxy <HTTP(S)代理地址>` 或 `HTTPS_PROXY/HTTP_PROXY` 明确指定。Windows 未指定时，CLI 会用一条固定的只读系统查询获取访问 GitHub 的系统代理；没有技能或网页文本进入该查询。HTTPS 使用 CONNECT 并继续验证目标证书，代理地址及凭据不会进入网页、回执或日志。loopback 网站授权请求直接连接。本机直连 GitHub 曾实际超时，系统代理方式已完成一次真实固定上游文件下载、校验、安装与撤销验证。

终端打印 `http://127.0.0.1:<port>` 和 30 分钟有效的随机配对令牌。用户在本站安装表单填写端口与令牌，在精确清单确认后点击本机安装。浏览器可能要求本地网络权限；被浏览器阻止时不能显示安装成功，可下载请求 JSON 后用 CLI 明确执行。

本机 HTTP 端口仅绑定 IPv4 loopback，要求精确本站 `Origin`、对应 `Host`、`Authorization: Bearer <本机配对令牌>`。预检允许该 Origin 与必要请求头；没有跨网站通配 CORS。请求体限制 16 KiB；它只含结构化参数，不携带技能正文。

| 本机路由 | 请求 | 响应 |
| --- | --- | --- |
| GET `/status` | 本机配对 Authorization | `{paired:true,scope:"project",expiresAt,busy}` |
| POST `/install` | `{planId,manifestHash,bridgeToken}` | `{receipt,serverRecorded,error?}` |
| POST `/verify` | `{receiptId,loadStatus,taskStatus,note}` | 同上；只记录用户自报 |
| POST `/revoke` | `{receiptId}` | 同上；仅删除自己完整性校验通过的未改动文件 |

`loadStatus` 为 `not_verified/user_reported_loaded/user_reported_failed`；`taskStatus` 为 `not_verified/user_reported_passed/user_reported_failed`。安装回执 `evidenceSource=local_bridge_reported`，不声称平台独立验证了本机行为。`serverRecorded=false` 表示本机已有结果但回传未成功，页面需如实说明。

若浏览器连接受限，用户可自行保存已确认的 `{planId,manifestHash,bridgeToken}` 为请求 JSON，再执行：

```powershell
node .\hackathon-skills-bridge.mjs --project-root 'D:\我的参赛项目' --origin 'https://实际网站域名' --install-request .\已确认安装请求.json
```

该动作仍需在执行前联网向固定网站确认，不能用过期下载清单绕过撤回。不要把含执行凭证的请求文件提交到 GitHub。

## 真实安装与恢复边界

安装器自行计算工具目录，不信任网页给的任意目标路径。Codex、Cursor、Copilot、Gemini CLI、OpenCode、Cline 使用 `.agents/skills`；Claude Code 使用 `.claude/skills`；Windsurf 使用 `.windsurf/skills`。这是当前锁定安装器的声明路径，不能当作任何客户端版本必定加载的证明。[固定适配定义](https://github.com/vercel-labs/skills/blob/87a266971d9460a3d2606075b8e91edc83325472/src/agents.ts)

桥接逐文件从 `raw.githubusercontent.com/<官方仓库>/<40位commit>/<固定路径>` 获取，无重定向；校验字节数、SHA256、完整清单与许可文件。限制单文件 2 MiB、整包 16 MiB、1–12 个技能。拒绝遍历、绝对路径、Windows 特殊路径、大小写同名、symlink/junction、离开授权根目录的路径。已有同名技能一律拒绝，不静默跳过或覆盖。写入采用独占新文件，失败按本次回执哈希回滚；遇到用户已改动文件会保留并准确报告，目录只在空且属本次创建时移除。

`.hackathon-skills/` 保存本机完整性签名的回执、归属目录和桥接进程锁；不含平台登录 cookie 或模型/GitHub 密钥。可将该目录人工加入项目 `.gitignore`，安装器不会修改既有 `.gitignore`。撤销先核对所有记录文件的现存哈希，任何修改先拒绝；不会递归删除整棵目录或顺带删除用户新文件。配对失效可关闭重启。若系统强制中断留下 `bridge.lock`，先按其中 PID 检查进程确已退出，再人工移除该锁；不自动解除活跃锁。

没有供网页调用的 shell 执行入口。不会运行 SKILL.md、第三方 Python/JS 脚本、依赖安装命令或外部账号授权；Windows CLI 的固定只读系统代理查询是本地网络配置动作。安装后首次使用技能时，第三方执行动作由用户与自己的 AI 工具另行决定。

## 首批内容与评价

8 项来自 Anthropic / GitHub 的实际开源技能：frontend-design、mcp-builder、webapp-testing、game-engine、agent-architecture、create-readme、create-specification、transloadit-media-processing。总计 59 个文件已读取核验，固定 commit、逐文件 SHA256 和适用 MIT/Apache-2.0 许可与上游 NOTICE 均在 `catalog-lock.ts`。源码内容不被写入本项目的用户 agent 目录，也不会运行。

- [Anthropic 固定目录](https://github.com/anthropics/skills/tree/683bc88e56f3e09ba94f7055977f3d3aa499f202/skills)：逐技能检查 LICENSE.txt，保留第三方通知；不把无根许可的整个仓库统一称作一个许可。
- [GitHub 固定目录](https://github.com/github/awesome-copilot/tree/7cce7cfb4b61196c36d7e8eb8475ae84b356b126/skills)：目录许可优先，否则使用明确的根 MIT 许可，并将适用原文随技能保留。
- [Agent Skills 规范](https://agentskills.io/specification)：文件格式与发现能力不等于行为兼容。
- [skills.sh 目录说明](https://www.skills.sh/docs)：榜单安装数据不能作为任务正确率。本站不生成伪星级、排名或“全网最好”。

每项有中文用途、适合条件、依赖、三步教程、示例请求、产物检查与恢复说明。套餐包含游戏、影视、AI Agent：影视包明确是制作规格与交付准备，不提供视频生成；媒体处理是需账号与成本核查的可选项。可选技能不会默默加入默认清单，可从目录另行选择固定版本。

当前精选是编辑推荐和来源/许可核验；真实客户端加载和任务质量仍为 `not_tested`。八个目录的文件安装测试是在 Windows 隔离 fixture 里通过，不是八款真实客户端 live 测试。界面需保持这种区别，并在计划创建前要求明确接受待验证的兼容状态。不得将这一轮目录交付表述为完整实现了规划中八款客户端的示例任务实测。

## 维护与验证

`prepare-catalog.mts` 只读维护脚本重新核查固定上游文件元数据；网络环境应允许 Node fetch 访问官方 GitHub。`prepare-bridge.mts` 用开发依赖 TypeScript 编译成导出的独立 JS 字符串，修改 bridge/domain/adapters/CLI 后必须重新生成。它不会把第三方技能正文合并到可执行桥接。

```powershell
node --experimental-strip-types src/modules/skills/prepare-bridge.mts
node --experimental-strip-types --test src/modules/skills/skills.test.ts
```

测试涵盖真实 PGlite 持久化、本人权限、确认哈希、过期/撤回、未伪造身份、回执与文件清单一致性、八工具独立目录写入与撤销、Origin/Host/配对、junction、同名冲突、编辑后保留、部分失败回滚和本机回执完整性，以及下载版无依赖实际启动。没有测试访问真实 `$CODEX_HOME`、Claude/Cursor 用户技能目录。

另外真实联网下载了固定上游 `create-readme` 的 SKILL.md 与 MIT 许可，在隔离临时项目完成字节数/SHA256 校验、写入与撤销。仅证明这个下载/文件流程可运行；未启动任何真实客户端，`loadStatus` 仍为 `not_verified`。

后续运营导入新技能版本须新增明确 M08 skill/bundle 审核契约；当前 M08 原资源模型只支持 event/resource，不把技能假装成资源审核通过。当前目录是代码中可复查的初始精选，运营撤回已可执行；动态上传任意新包与对外发布新版本没有开放端点。外部账号依赖、第三方客户端任务实测以及持续更新需要真实环境与操作授权。
