# Windows 笔记本服务器部署交接

编写日期：2026-10-10。适用设备：另一台 Windows 11、8GB 内存的闲置笔记本。目标是把当前网站迁过去，由笔记本运行网站、数据库和后台任务，通过内网穿透让手机和其他用户访问。

这份文档是部署交接和操作依据，本次编写没有停止源网站、复制运行数据库、迁移到笔记本或启动目标服务。域名、隧道、证书及目标电脑上的邮件和 DSH，都要由目标部署会话实测并记录结果。

## 1. 给笔记本上的 Codex 的任务

把项目源码、本文件及单独交付的私密材料放到笔记本后，可以把下面一段直接发给笔记本上的 Codex。项目路径和最新冷备名称需要替换为实际值。

```text
请根据本项目 docs/部署/Windows笔记本服务器部署交接.md，在这台 Windows 11、8GB 笔记本完成部署。

项目目录：请先确认实际路径。
数据来源：原开发电脑的最新停服冷备，名称及交付时间请先核对；旧 completion-final041-20261010 只是历史备份，不能默认当作搬迁当天最新数据。
运行方式：Windows 原生 Node.js 24，production 构建，APP_MODE=local，持久 PGlite，一个网站进程承载嵌入后台。不要同时启动独立 worker，不要改技术栈。
公网方式：使用实际可用的内网穿透；域名优先处理用户指定的 HIB / Dynu 方案。文档中没有预先确认最终域名、DNS 或 TLS，不得直接把候选名作为 AUTH_ORIGIN。

先读取 AGENTS.md、package.json、部署文档和最近验收报告，确认源码完整、所有私密文件均走私密交付、源电脑已停服。按文档完成目标恢复验证、配置路径、依赖安装、迁移、构建、单实例启动、隧道及可信 HTTPS、手机真实登录、自启和重启持久化验证。

保留原数据库全部用户、项目、赛事、预算、预留、未知请求 hold、队列和历史。保留有效 AUTH_CODE_PEPPER 来源，不生成新密钥覆盖旧密钥。不要清库、重置预算、删除未知请求状态或自动重发未知付费请求。不要输出任何密钥、邮件授权码、DSH grant、完整私人聊天或数据库正文。

DSH 当前 Desktop 适配严格使用 0.2.0-rc.2；在目标电脑核对完整安装目录和实际运行网站的 Windows 账号授权，使用 NTFS 私人目录权限。npm run dsh:install 不是安装或登录 Desktop 的替代。QQ SMTP 必须实测收到验证码；不要改回公开开发邮箱。

用户已经要求暂缓真实 GitHub 验收，保留未配置说明，不索要 GitHub key、不填假 key、不建仓或写仓库。不要购买域名、服务器、隧道套餐或证书。遇到没有授权的付费操作、缺少私密材料或无法完成有效证书时，先完成其它可做工作，再准确说明阻塞和所需信息。

为网站创建同 Windows 用户的计划任务和有日志、PID、单实例保护的启动方式。工作目录固定为项目根目录；计划任务重复启动策略为 IgnoreNew，执行期限不限制。完成一次可控停机、备份、启动和重启验收，不使用强制结束所有 node.exe 的方式维护网站。

部署后提交一个 Markdown 验收记录，包含真实公网 URL、TLS 检查、实际代码/迁移版本、最新冷备名称、私密材料来源是否保留、网站/隧道自启方式、手机收件和登录、DSH真实调用及费用、后台心跳、数据重启持久化和回滚方法。未验证项直接写未验证，不把配置齐全当成接入成功。
```

## 2. 本次建议的运行结构

```text
用户浏览器 / 手机
        │ 可信 HTTPS：最终主机名和必要端口
        ▼
内网穿透节点
        │ 隧道
        ▼
笔记本上的穿透客户端 / 本地 TLS 终止
        │ HTTP 127.0.0.1:3000
        ▼
唯一 npm run start 实例
        ├─ Next.js 页面、登录和 API
        ├─ 同进程的发现、AI 和维护后台
        ├─ .runtime/postgres-data：持久 PGlite
        └─ 隔离的 DSH 子进程 + 实际账号授权
```

本方案复用当前已经验收的本机结构，适合少量真实队伍试用。PGlite 不能由独立网站和 worker 同时打开；8GB 设备的并发人数、内存峰值和长期稳定性需要目标实测，不能先作承诺。以后需要多网站实例或更多用户时，再单独迁到真正 PostgreSQL 并验收多连接竞争。

`scripts/serve.mjs` 固定监听 `127.0.0.1`。穿透客户端应在这台笔记本上连接 `127.0.0.1:3000`，不用为了手机访问把网站改成 `0.0.0.0`。手机通过公网地址访问，不会直接连接笔记本回环地址。

`db:migrate`、`admin:grant`、`discovery:once`、`resources:catalog` 等会打开实际数据库的管理脚本，必须在本机网站停止且其它 PGlite 操作进程退出后运行。`npm run worker` / `worker:ai` 不能作为这个 PGlite 网站的第二个后台进程；独立 worker 需要实际 PostgreSQL 连接。

网站的生产构建和数据库模式是两件事：执行 `npm run build` 和 `npm run start`，同时明确保留 `APP_MODE=local`。这里的 local 是当前持久 PGlite 试用模式，不表示只能由这台电脑浏览，也不冒称已完成 connected 正式部署。

## 3. 先确认这些信息

由目标 Codex 核查并写进部署记录，秘密字段只记录是否配置，不记录值。

| 内容 | 需要确认 |
| --- | --- |
| 项目路径 | 建议 NTFS 本地磁盘，例如 `C:\HackathonFieldGuide`；示例路径不是已经创建的目录 |
| 运行用户 | 实际运行网站和 DSH 的 Windows 用户；计划任务也使用这个用户 |
| 磁盘 | 有足够空间容纳源码、依赖、构建、实时数据库、冷备和恢复验证副本 |
| Node/npm | Node.js 24 或以上；目标安装的 `node.exe`、`npm.cmd` 实际路径 |
| 最新数据 | 源网站停服后的完整冷备名称、时间、迁移数及传输方式 |
| 网站秘密 | `.env.local` 和实际生效的 pepper 来源均已私密送达 |
| DSH | 兼容版本完整安装，实际目标用户授权可用，绝对路径已更改 |
| SMTP | 发件邮箱、授权码、TLS 配置可用；目标网络可达 |
| 代理 | `SOURCE_HTTP_PROXY` 如保留，目标电脑真的提供这个 loopback CONNECT 代理 |
| 公网 | 最终域名、隧道类型、节点、远程端口、证书取得及续期方式 |
| 切换 | 源电脑后台何时停止，哪个数据库是切换后唯一写入来源 |

8GB 设备应优先原生运行，关闭不必要的开发服务器、Docker/WSL 和大量浏览器标签。首次构建与全量测试不要和网站生产后台同时挤占内存。部署完成后只运行 production 网站、所需代理和穿透客户端；不把开发热更新作为长期服务。

## 4. 文件怎样交接

### 4.1 源码包

可打包的源码与说明包括：

- `src/`、`public/`、`migrations/`、`scripts/`。
- `package.json`、`package-lock.json`、`next.config.ts`、`tsconfig.json` 及项目实际根构建配置。
- `AGENTS.md`、`README.md`、`.specify/`、`docs/`、`.env.example`。
- `tests/`、Playwright 配置可以保留，用于部署后隔离测试。

不要把 `node_modules/`、`.next/`、`out/`、覆盖率、测试报告、日志、`*.tsbuildinfo` 当部署材料。目标按 lockfile 运行 `npm.cmd ci` 并重新构建。依赖有 Windows 平台二进制，不从旧电脑随意复制现成依赖来替代安装。

### 4.2 单独的私密材料

以下内容单独通过用户授权的私密渠道送到笔记本，不放公共源码包或公开仓库：

- `.env.local`，目标 Codex 在本机修改路径和公网配置。
- 实际生效的 `AUTH_CODE_PEPPER` 来源。如果源配置没有明确设置它，需保留 `.runtime/local-secrets.json`。
- 最新完整冷备数据库。它含邮箱、项目、私人 AI、会话、审计及历史，是私有数据。
- 如果曾配置 GitHub，需保留相应加密密钥、版本和旧 keyring；本次不开展真实 GitHub 验收。

不要整包复制 `.runtime/`。只挑必要冷备、密钥文件及明确需要的持久材料；临时 DSH 会话、旧恢复副本、旧备份和测试日志不需要进入目标实时目录。不要把个人 Codex 配置、SSH 私钥、整个个人 DSH 会话目录、带凭据 `.npmrc` 或其它账号目录一并交出去。

安装文件和 DSH 账号授权是两项。优先让实际运行网站的用户在笔记本重新登录 DSH。如果确需私密迁移账号 grant，也要单独授权、保护文件并实测有效性；不宣称授权文件在技术上绝对不可复制，不复制完整个人会话库。

### 4.3 生效 pepper 的确认

配置优先使用 `AUTH_CODE_PEPPER`；local 模式缺少此变量时才读取 `.runtime/local-secrets.json`。只确认哪个来源实际生效，不在聊天、日志或验收文档输出值。

保留原值。不要为了“新电脑初始化”随机生成新值覆盖它。它用于验证码 HMAC、限流和审计游标等；登录会话 token 使用 SHA256，不要把迁移说明写成“pepper 用来解密所有会话”。配置值或文件丢失时先找回对应来源，不清空数据库绕过。

## 5. 数据库冷备和搬迁

可以先在目标安装 Node、准备源码和确认 DSH/隧道路径。真正复制实时数据库前，安排源网站停服；从这个时间点起不得让两台电脑同时成为这份数据的可写服务器。

### 5.1 在源电脑取得搬迁当天最新冷备

1. 暂停入口或告知试用用户停机窗口。
2. 停止源网站以及所有可能打开这份 PGlite 的脚本，禁止自启任务自动拉起。
3. 等待网站与对应子进程退出，检查 3000 没有监听；还要核对实际进程，端口关闭本身不能排除其他数据库脚本。
4. 完整冷复制 `.runtime/postgres-data`，同时保留生效秘密来源。
5. 冷备完成后，源站保持停止，直到目标切换验收完成或明确回滚。

下面是给源电脑部署操作者使用的示例。先替换实际路径和新的冷备名称，**不要在编写交接文档时执行**。

```powershell
$deploySourceRoot = 'F:\黑客松情报局'
$transferBackupName = 'laptop-transfer-20261010-220000' # 示例，按实际时间新建
$sourceDataPath = Join-Path $deploySourceRoot '.runtime\postgres-data'
$sourceBackupParent = Join-Path $deploySourceRoot '.runtime\backups'
$sourceBackupPath = Join-Path $sourceBackupParent $transferBackupName

if ($transferBackupName -notmatch '^[a-z0-9-]+$') { throw '冷备名称只能使用小写字母、数字、连字符。' }
if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) {
    throw '源网站仍监听3000，请先停服。还需人工核对所有PGlite操作进程已退出。'
}
if (!(Test-Path -LiteralPath (Join-Path $sourceDataPath 'PG_VERSION'))) { throw '运行数据目录不正确。' }
if (Test-Path -LiteralPath $sourceBackupPath) { throw '备份名称已存在，不覆盖旧备份。' }
New-Item -ItemType Directory -Path $sourceBackupParent -Force | Out-Null
Copy-Item -LiteralPath $sourceDataPath -Destination $sourceBackupPath -Recurse -ErrorAction Stop
if (!(Test-Path -LiteralPath (Join-Path $sourceBackupPath 'PG_VERSION'))) {
    throw '备份层级不正确，PG_VERSION应直接位于备份名称目录根部。'
}
```

不要热复制正在写入的 PGlite 文件，也不要只导出几张表。不要用同步盘双向实时同步数据库目录。`completion-final041-20261010` 曾通过恢复验证，但只是 2026-10-10 当时的历史快照，可能缺少随后新记录，不能默认代替最新搬迁冷备。

### 5.2 目标备份目录的准确层级

在目标项目下摆放成这样：

```text
C:\HackathonFieldGuide\
├─ package.json
├─ migrations\
├─ scripts\
└─ .runtime\
   ├─ local-secrets.json                 # 仅当这是生效的秘密来源
   └─ backups\
      └─ laptop-transfer-20261010-220000\
         ├─ PG_VERSION                  # 直接位于这个备份目录根部
         └─ 数据库其它实际文件和目录
```

不能多套一层 `postgres-data/`、`.runtime/` 或另一个备份名，不能把整个 `.runtime` 误当数据库文件目录。冷备目录名只允许小写字母、数字、连字符，不能把绝对路径传给 `--backup-name`。

### 5.3 目标先验证备份，再恢复实时目录

目标验证时不运行网站或其它数据库工具。脚本不会加载 `.env.local`、初始化应用、迁移或 seed；它复制到新的独立 `restore-check-*` 目录再打开检查，保留原备份。验证副本会占用额外磁盘空间。

```powershell
Set-Location -LiteralPath 'C:\HackathonFieldGuide' # 改成实际目标目录
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，停止后续步骤。' }

node --experimental-strip-types scripts/verify-local-backup.mts --backup-name laptop-transfer-20261010-220000
if ($LASTEXITCODE -ne 0) { throw '冷备恢复验证失败，不启动目标服务。' }
```

必须传入实际最新名称。脚本无参数的默认值指向旧 `task-mission-20261010-000105`，不能省略参数后误称验收了最新数据库。记录迁移数、表数、约束检查、重开内容一致和原备份未变；不要输出表中私密正文。

验证通过后，完整复制到目标实时目录；拒绝覆盖已有运行库，若目录已存在，先核查它是什么数据，再做独立冷备和明确的恢复方案。

```powershell
$deployTargetRoot = 'C:\HackathonFieldGuide' # 改成实际目录
$transferBackupName = 'laptop-transfer-20261010-220000' # 改成已经验证的名称
$targetBackupPath = Join-Path $deployTargetRoot ('.runtime\backups\' + $transferBackupName)
$targetDataPath = Join-Path $deployTargetRoot '.runtime\postgres-data'

if ($transferBackupName -notmatch '^[a-z0-9-]+$') { throw '名称不合法。' }
if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { throw '目标网站仍运行，请先停服。' }
if (!(Test-Path -LiteralPath (Join-Path $targetBackupPath 'PG_VERSION'))) { throw '备份层级不正确。' }
if (Test-Path -LiteralPath $targetDataPath) { throw '实时目录已存在，先核查并冷备，不直接覆盖。' }
Copy-Item -LiteralPath $targetBackupPath -Destination $targetDataPath -Recurse -ErrorAction Stop
if (!(Test-Path -LiteralPath (Join-Path $targetDataPath 'PG_VERSION'))) { throw '恢复层级不正确。' }
```

随后在停服状态执行 `npm.cmd run db:migrate`。代码核验已应用 SQL 的 hash，只增量执行未应用迁移；当前历史验收为 001–041。若报告 `Applied migration was modified`，核对代码包版本，不能修改数据库记账或删除旧迁移绕过。

## 6. 目标配置逐项核对

不要把下方占位域名或示例绝对路径原样投入运行。已有 `.env.local` 可私密转移后就地修改，正文只提供变量名称和公开配置示例，不提供秘密值。

### 6.1 网站、模式和 Origin

| 变量 | 本次要求 |
| --- | --- |
| `APP_MODE` | 明确设为 `local`。production 启动时遗漏它会默认 connected，并要求真正数据库连接 |
| `AUTH_ORIGIN` | 最终验收的 HTTPS origin，包含实际非标准端口，不含路径、末尾斜杠或多个域名 |
| `AUTH_ALLOW_PUBLIC_LOCAL_ORIGIN` | 公网 PGlite 试用设为 `true` |
| `AUTH_CODE_PEPPER` | 如源站使用此变量，保留原值；否则保留原 local-secrets.json |
| `DATABASE_URL` | 本次继续 PGlite 时不设置。若源配置已有它，先确认实际数据来源，不直接切换为空 |
| `FIELD_GUIDE_EMBEDDED_WORKERS` | 正常目标运行不设 `0`，使用嵌入后台 |

准备阶段若还没有最终 HTTPS 入口，可先把网站 Origin 设为可信 loopback 做本机预检；公网切换时停服更新为真实 HTTPS Origin，再启动。不要把公开本地预览当成无需 HTTPS 的生产替代。

配置齐全之后公网示例形态是：

```dotenv
APP_MODE=local
AUTH_ORIGIN=https://final-host.example:44353
AUTH_ALLOW_PUBLIC_LOCAL_ORIGIN=true
AI_PROVIDER=dsh
```

这一段是示例域名和示例端口，不能直接粘贴进配置。公网 HTTPS 标准 443 端口通常不需要显式写端口；非标准端口必须保留。

### 6.2 DSH Desktop

| 变量 | 需要做的事 |
| --- | --- |
| `AI_PROVIDER` | `dsh` |
| `DSH_DESKTOP_DIRECTORY` | 笔记本上完整 Desktop 安装目录的绝对路径，不沿用源机 `D:\dddsss` 除非目标确实也有同一路径 |
| `DSH_DESKTOP_CREDENTIALS_FILE` | 推荐明确设置为目标运行用户真实授权文件的绝对路径 |
| `DSH_MODEL` | 当前账号真实可用模型，不编造模型名称 |
| `DSH_INPUT_MICRO_USD_PER_MILLION` / `DSH_OUTPUT_MICRO_USD_PER_MILLION` | 账号实际模型的保守 USD 费率，微美元/百万 token；不能因搬迁乱填 0 |
| `DSH_TIMEOUT_MS` / `DSH_MAX_OUTPUT_TOKENS` | 沿用经过核查的有界配置 |
| `DSH_DAILY_NAVIGATOR_CALL_LIMIT` / `DSH_DAILY_NAVIGATOR_BUDGET_MICRO_USD` | 保留原个人/项目额度政策 |
| `DSH_DAILY_SOURCE_CALL_LIMIT` / `DSH_DAILY_SOURCE_BUDGET_MICRO_USD` | 保留独立来源额度政策 |

当前 Desktop 适配严格核验 **`0.2.0-rc.2`**，需要完整 `DeepSeek Harness.exe` 和 `resources/`。安装 latest 后出现版本拒绝不能关校验；另择兼容安装或做独立兼容开发，不把未经验证的新版本直接发布。

默认授权路径取运行用户的 `.dsh/.credentials.yaml`。任务改用 SYSTEM 或另一个用户时，路径、权限和授权都可能不同。配置路径不是授权成功：必须使用真实目标账号，检查过期/退出状态，并通过实际有限调用验收。

会话权限依赖本地 NTFS。运行用户需要创建并保护临时会话目录，代码会校验本人独占且可继承的 ACL；exFAT U 盘、共享盘或不支持 ACL 的目录可能失败。`DSH_SESSION_PRIVACY_UNAVAILABLE` 时修正账号、文件系统及权限，不能取消保护。源 Desktop 授权和新临时目录分别保护，不随便修改原账号凭据。

三种凭据模式只能选一种：Desktop、官方 Node account、API key。当前任务选 Desktop，不混填 `DSH_API_KEY` 或 `DSH_ACCOUNT_CREDENTIALS_FILE`。`npm.cmd run dsh:install` 安装独立官方 Node runtime，不是安装 Desktop 或登录账号，不作为本次 Desktop 搬迁必做步骤。

### 6.3 真实邮箱验证码

无自有发信域名时继续已选择的 QQ SMTP。配置名称：

- `AUTH_EMAIL_PROVIDER=smtp`。
- `SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`。
- `SMTP_USER`、`SMTP_PASSWORD`。
- 可选 `AUTH_EMAIL_FROM`；设置时发件邮箱必须与 `SMTP_USER` 一致。

QQ 常用 465/TLS；项目也接受 587/强制 STARTTLS，端口与 secure 必须匹配。`SMTP_PASSWORD` 是邮箱授权码，不是 QQ 登录密码。授权码只填在笔记本私密配置，不发聊天；目标新 IP 可能触发邮件账号安全检查，需要实际收件。

公网缺少真实邮件凭据时登录不可用，不能暴露开发邮箱作为替代。SMTP 服务受理和收件箱收到是两个事实，目标须从真实手机输入本人邮箱，收到验证码再登录验证。详细操作见 [QQ 邮箱验证码配置](QQ邮箱验证码配置.md)。

### 6.4 页面获取代理和旧路径

`SOURCE_HTTP_PROXY` 只支持目标电脑自身、无凭据、无路径的可信 loopback HTTP CONNECT 代理。源电脑曾有某个 `127.0.0.1` 端口，不表示笔记本也会存在。

保留该项前实际在笔记本配置并核对对应代理；或者在确认公开源直连可达后移除该字段。它只服务于公开页面与 robots 获取，不能假定它同时解决 npm、SMTP 和 DSH 出站问题。不要替换成任意远程代理或带密码 URL，不关闭 TLS、公开 DNS、目标 IP、robots 和 SSRF 限制来提高抓取数量。

逐一核对 `.env.local`、自启脚本和计划任务中的旧盘符、用户名、项目目录、DSH 路径、授权文件、Node 路径、隧道配置及代理端口。不把源机绝对路径当笔记本事实。

### 6.5 GitHub 暂缓

用户明确要求先不验收 GitHub。本次不配置假值、不发起真实授权、建仓、提交或仓库写入。全套为空可保持未配置；只填写部分 GitHub 凭据反而会导致配置加载失败。

若源站确实曾使用 GitHub 凭据，私密保存 `GITHUB_TOKEN_ENCRYPTION_KEY`、`GITHUB_TOKEN_ENCRYPTION_KEY_ID` 和 `GITHUB_TOKEN_ENCRYPTION_PREVIOUS_KEYS`；不丢旧 keyring、不凭空轮换。以后启用时还要调整真实公网回调，但这不是本次网站部署阻塞。

## 7. 安装、检查、迁移、构建和首次启动

以下全部是**在目标笔记本**执行的操作。切到实际项目根目录；本段数据库步骤执行前不能有网站或其它 PGlite 进程。

```powershell
Set-Location -LiteralPath 'C:\HackathonFieldGuide' # 改为实际目标路径
node --version
npm.cmd --version

npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' }

npm.cmd run typecheck
if ($LASTEXITCODE -ne 0) { throw '类型检查失败。' }

npm.cmd run config:check
# 本命令可能因用户主动暂缓 GitHub 而退出1。
# 必须阅读分组缺项；不能把其它缺项一并忽略，也不填假 GitHub 配置。

npm.cmd run db:migrate
if ($LASTEXITCODE -ne 0) { throw '迁移失败，停止发布并保存错误代码。' }

npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw '构建失败。' }

npm.cmd run build:verify
if ($LASTEXITCODE -ne 0) { throw '构建存在私人文件引用或其它校验失败。' }

npm.cmd run start
```

使用 `npm.cmd` 避免 Windows PowerShell 命中 `npm.ps1` 的执行策略差异；不为运行 npm 全局关闭系统脚本策略。首次可在受控终端前台启动，核对启动日志和停机行为，然后再配置正式后台方式。

`npm run start` 的 wrapper 会设置 `FIELD_GUIDE_SERVE=1`，由 Next instrumentation 初始化应用和嵌入后台。不直接改用 `next start`，不通过多个守护进程重复启动。构建本身不设置服务标志，不启动数据库和付费发现；构建追踪校验会检查 `.runtime`、环境文件和凭据没有进入公开构建材料。

`config:check` 只确认配置名称是否满足和本地材料是否存在，不证明 DSH、SMTP、数据库连接或搜索实际成功。当前暂缓的 GitHub 分组缺项可作为预期未配置记录，其余错误逐项修复。

## 8. 免费域名、内网穿透和可信 HTTPS

### 8.1 当前域名事实

本轮优先 HIB / Dynu。`hib.mywire.org` 是主会话正在处理的候选，本文件编写时**尚未确认注册成功、DNS 可用或 TLS 完成**。不要提前写到生产 `.env.local`，不要发给用户当成已上线地址。最终 URL 由主会话或目标部署者实测后填写：

| 交付字段 | 实际完成后填写 |
| --- | --- |
| 最终域名 | 待确认 |
| DNS 类型及目标 | 待确认，应指向实际穿透节点，不能误填家庭公网 IP |
| 隧道节点及类型 | 待确认 |
| 远程端口 | 待确认 |
| 证书签发、到期、续期 | 待确认 |
| 最终 HTTPS URL / AUTH_ORIGIN | 待完成 DNS、隧道和可信 TLS 后确认 |

Dynu 官方论坛记录免费三级域名 TXT 可能需建立满 30 天。那是需要核对当前账号权限的历史说明，不保证当天能通过 DNS-01 发证；域名免费和证书验证方式可用是两件事。[Dynu 官方论坛说明](https://www.dynu.com/Forum/ViewTopic/Enable-TXT-field-for-DDNS/13368)

如当前方案不能完成可信 HTTPS，可与用户确认改用支持的免费选项。Sakura 的 `nyat.app` 子域绑定可作为备选，按实际账户和节点要求核对，不购买服务，也不把备选写成已经创建。[Sakura 子域绑定说明](https://doc.natfrp.com/bestpractice/domain-bind.html)

### 8.2 隧道如何接本项目

Next 提供本机 HTTP `127.0.0.1:3000`。可以采用适配 HTTP 的 TCP 隧道并启用本地 HTTPS 封装，也可以用已有证书的本地反向代理提供 HTTPS，再接支持的 HTTPS 隧道。选定实际方案后，明确谁终止 TLS，不能把普通 HTTP 的 3000 端口直接当成 HTTPS 服务。

TCP 网址通常需保留远程端口；DNS 改名本身不能去掉 `:端口`。若要标准端口入口，需要节点及 HTTP(S) 隧道支持。没有备案的免费子域名应选符合建站要求的非内地节点，并核对节点备注。[Sakura Web 穿透指南](https://doc.natfrp.com/app/http.html)

DNS 解析目标是穿透节点实际域名或公网 IP，不是笔记本内网 IP、`127.0.0.1` 或家里的公网 IP。不要开启自动把 Dynu 名字更新为家庭 IP 的 DDNS 客户端而绕过隧道；节点变化后按实际策略维护解析。

启动器只启动这个网站需要的隧道，并按官方方式配置常驻启动。网站任务、代理和隧道分别记录账号及自启条件；只启动网站不代表公网映射也会恢复。[Sakura 启动器指南](https://doc.natfrp.com/launcher/usage.html)

### 8.3 HTTPS 验收不能省略

自动 HTTPS 封装不等于已经取得受信任域名证书；按最终域名配置证书和链，并确定续期后的加载方式。[自动 HTTPS](https://doc.natfrp.com/frpc/auto-https.html)、[证书配置](https://doc.natfrp.com/frpc/ssl.html)

旧入口 `https://frp-off.com:44353/` 曾在严格 TLS 检查中报 `DEPTH_ZERO_SELF_SIGNED_CERT`。不要复用“浏览器继续访问”结果当完成，也不要用 `NODE_TLS_REJECT_UNAUTHORIZED=0`、curl 跳过证书选项或自定义关闭验证来通过检查。

目标验收至少要确认：域名解析正确、证书覆盖最终主机名、证书链受系统和手机信任、没有混合内容、手机不弹证书警告、续期可以正常执行。最终地址确认后再设置精确 `AUTH_ORIGIN` 并停服重启。

使用公网 Origin 时，本机不同 Origin 的登录请求可能被拒绝，这是正常边界。用公开 HTTPS 地址完成用户登录，不能为解决跨域问题放开任意 Origin。反向代理不随意伪造客户端身份；没有可信签名入口时保留当前保守的全站登录限额。

## 9. 自动启动、单实例、日志和停机

### 9.1 计划任务设置

给目标 Codex 明确要求：在实际部署目录创建用于服务器运行的启动包装脚本，核验后注册计划任务。**当前仓库没有本节示例所假定的现成自启包装脚本**，不要注册一个不存在的文件路径。

| 设置 | 要求 |
| --- | --- |
| 用户 | 和目标 DSH 登录及授权读写使用同一个 Windows 用户；不要默认为 SYSTEM |
| 工作目录 | 实际项目根目录，不依赖任务计划器默认 `System32` |
| 命令 | 实际 Node/npm 路径，调用项目 `npm run start` / `scripts/serve.mjs start`，不绕过 serve wrapper |
| 窗口 | 常驻任务后台、隐藏窗口；首次手工验收可以在终端前台运行 |
| 重复策略 | `IgnoreNew`；不采用 Parallel 或排队启动多个网站 |
| 执行期限 | 不限制运行时长，核对 XML/界面为无限；不能保留默认若干天超时 |
| 失败恢复 | 有界重启次数和间隔，如 1 分钟、3 次；配置错误不能无间隔无限重启 |
| 启动条件 | 实际验证的用户登录触发或同用户开机运行；网络恢复时能正常恢复隧道 |
| 维护条件 | 停服/迁移时能禁用自动拉起，不强杀数据库后立即重启 |

Windows 计划任务支持 `IgnoreNew`、失败重试和执行时限设置，具体使用目标系统上的 ScheduledTasks 模块核对。[微软设置文档](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset)

可供目标 Codex 使用的设置对象示例，不是已经注册完成的任务：

```powershell
$websiteTaskSettings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -RestartCount 3 `
    -StartWhenAvailable
```

在目标核对实际 `ExecutionTimeLimit` 为无限、相同任务启动两次只保留一个实例。登录触发只能说明登录后启动，不能声称无需登录即可开机上线。如需“用户未登录也运行”，用同一账号配置任务并由用户直接在 Windows 界面处理凭据，再实测非交互 DSH、权限、代理及隧道；不把 Windows 密码发聊天或写入启动脚本，也不为了免登录默认启用自动登录。

### 9.2 启动包装脚本应完成什么

- 固定工作目录、可执行路径、所需环境，私密配置只由服务账号读取。
- 既检查目标端口，又使用跨手工启动/计划任务的单实例互斥保护；`IgnoreNew` 只约束同一计划任务，不能单独阻止手工再开一个。
- 私密记录服务根 PID、实际监听 PID、启动时间、代码位置及退出码，识别 Node/Next 子进程链。
- 按日期或体积分割日志，保留有界天数；限制日志访问，不记录密钥、完整环境、邮件正文或私人聊天。
- 若失败退出非零，才能让计划任务识别失败；不要吞掉 exit code 把启动失败记为成功。
- 启动前不运行重置数据库、重置预算、付费发现一次或自动迁移修复命令。

目标交付需要给出实际包装脚本路径、任务名、日志路径和“启动/安全停机/状态查询”的命令，不能只写“设置了自启”。

### 9.3 安全停机

维护前先关闭隧道入口或进入停机窗口，再禁用自启/有界重启，避免刚停网站又被拉起。前台首启可使用 Ctrl+C，让 wrapper 转发信号和后台取消逻辑工作；目标正式后台方案必须实测对应的优雅停机方式，等待网站及 DSH 子进程结束，确认 3000 无监听后才复制数据库。

任务计划器的“结束任务”、`Stop-Process` 或关闭窗口可能是强制终止，不能默认等价于已优雅退出。不要执行“结束所有 node.exe”，可能伤害笔记本上其它工具。真的挂死时，记录根 PID 和监听 PID，核对命令行/项目位置后只处理本服务；保存故障和未知请求事实，下次启动核查数据与 unknown hold，不能强行自动重发。

### 9.4 供电、休眠和硬件

长期插电和稳定网络，优先有线连接；使用系统支持的电池保护/充电上限。保持通风，合盖前核对机型散热和合盖动作，不能堵住出风口。检查电池鼓包或异常发热时停止长期服务器使用并处理硬件。

供电状态下设置合理的屏幕关闭，禁用导致网站断开的自动睡眠/休眠；关闭屏幕不等于让电脑睡眠。核对 Windows 更新的重启窗口、任务恢复及穿透重连。保留低电量安全关机和电池保护，不靠禁用所有保护维持运行。断电、电池耗尽和家庭网络故障会影响可用性，笔记本部署不承诺云服务器的持续在线保证。

## 10. 自动搜索、费用和未知请求

内网穿透和免费域名可以降低服务器费用，但 DSH 推理、原生搜索、邮件和流量政策分别计费或限额，不宣称网站所有运行成本为 0。

沿用经过核对的赛事与灵感预算：历史本机赛事为每 UTC 日 48 次搜索、合计 120 次模型、1 USD；灵感独立为 24 次模型、0.10 USD。这些是已有配置依据，不是新账号供应商实际扣费保证，目标按有效配置和真实计费核对。5 分钟是最短发现间隔，额度不足会停止，不能承诺全天每 5 分钟收费搜索。

必须完整搬迁以下事实：预算 bucket、调用 attempt、预留、usage、未知结果 hold、发现/灵感暂停状态、队列、来源证据及历史。未知付费请求不能因重启、搬迁、换供应商、跨日或增加 attempt 而自动重发。不要删除 hold 让后台“恢复正常”。

切换后只允许目标笔记本运行这一站的付费后台。源电脑的旧数据库和目标数据库是两个独立记账副本，同时开各自后台会各自计算额度却共用供应商账号，增加重复调用和费用风险。旧电脑留作关闭的回滚材料，不继续运营旧库。

首次目标真实 AI 验收用少量明确请求，记录 provider、结果、usage/保守结算、重试和未知状态，不能无限反复点击测试。网页的公开读取不触发付费搜索，不把刷新页面当“立刻联网更新”。

## 11. 验收清单

按顺序验收，失败记录错误代码和实际影响，不虚构成功。

### 11.1 本机启动与数据

- [ ] Node 版本满足要求，`npm.cmd ci` 使用已有 lockfile。
- [ ] 最新搬迁冷备显式验证成功，原备份未变，恢复副本与重开检查一致。
- [ ] 有效 pepper 来源和必要私密配置保留；没有把秘密材料放入公开目录。
- [ ] `db:migrate` 在停服状态完成，迁移数/最后 ID 写进记录，已应用文件未重写。
- [ ] `typecheck`、生产构建和 `build:verify` 通过。
- [ ] 网站只有一个监听实例，使用正确工作目录和 `npm run start`。
- [ ] `GET /api/v1/system/status`、`/api/v1/event-discoveries?limit=60`、`/api/v1/inspiration` 实际可读；事件结果与数据库搬迁时库存相符，不要求未来一直固定 8 张。
- [ ] `/events`、`/inspiration`、`/journey`、`/app` 主要入口可用，不拿虚构赛事补位。
- [ ] 已有用户、团队空间、任务、私有记录和历史保持；只选择用户授权的最少样例查看。

### 11.2 公网和真实手机

- [ ] 域名注册/控制权、DNS、隧道和实际端口记录明确。
- [ ] 系统严格证书验证成功，手机没有安全警告；没有跳过 TLS 检查。
- [ ] 精确 `AUTH_ORIGIN` 等于实际用户访问入口；Secure Cookie 和返回位置正常。
- [ ] 手机用移动网络访问，断开本机 Wi-Fi，证明实际公网映射有效。
- [ ] 本人邮箱收到真实验证码，输入后登录 `/app`，刷新、关闭重开及登出符合预期。
- [ ] 邮件受理、真实收件和用户成功登录分别记录，不用仅接口 200 代替。
- [ ] 新账号注册/首次登录引导以及邀请链接实际主机名正确，不回跳源机 localhost。
- [ ] 375px 手机无横向溢出，主要按钮、表单、邀请链接和导航员可操作。

### 11.3 DSH 和后台

- [ ] 同 Windows 用户的 Desktop 版本、授权和 NTFS ACL 可用。
- [ ] 一次受控真实 DSH 回复成功，标明 DSH provider；用户私有内容不错误进入团队共享。
- [ ] 管理员 `/admin/services` 可见实际服务情况，非管理员访问被拒绝。
- [ ] 已启用 worker 的近期心跳正常；`configured`、`not_started`、`failed`、`stale` 等状态诚实展示。
- [ ] 8 类 worker 按实际启用项核对：`ai`、`source`、`discovery`、`inspiration`、`planning-notifications`、`github-maintenance`、`retention-maintenance`、`resource-links`。
- [ ] 发现/灵感预算与暂停状态保持，不强制触发 unknown 请求；来源代理/robots 与 DNS/TLS 正常。
- [ ] GitHub仍明确暂缓；技能目录和复制命令不冒充八客户端实际加载成功。

### 11.4 重启和恢复

- [ ] 受控重启笔记本后网站、所需代理和隧道按实际自启方式恢复。
- [ ] 重复启动没有第二个网站进程；不会同时打开 PGlite。
- [ ] 重启后用户资料、任务进度、预算、卡片及未知状态持久，不新建空库。
- [ ] 日志有界、可定位失败，不暴露秘密；任务没有默认执行时限导致几天后停止。
- [ ] 已实际演练一次安全停服、最新冷备和恢复验证；记录回滚所需代码、数据库和私密配置位置。

如果只验证登录后自启，明确写“登录后恢复”；没有实际验证非交互开机运行时，不写“无人登录即可自动上线”。

## 12. 日常备份、更新和回滚

### 12.1 备份

针对 PGlite 安排用户可接受的短停机窗口：停入口、禁自启、停网站、核对进程、完整冷备、恢复验证、再启动。日常备份频率按可接受数据损失确定；比赛期间重要变更后补一份。备份放受保护目录，并保留至少一份不在同一块笔记本磁盘上的私密副本。

同名备份不覆盖，写清创建时间、最后迁移、对应源码版本/内容摘要及秘密来源是否匹配。保留政策只清经过确认的旧备份，不删除当前库、原始证据、不可变回执或未知请求事实。涉及递归移动/删除前先核验解析后的绝对路径位于明确目标内，使用 PowerShell `-LiteralPath`，不用字符串拼接后交给另一 shell 处理。

### 12.2 更新

1. 准备新源码和更新说明，确认兼容当前数据与 DSH 版本。
2. 短停机并保留旧源码、最新数据库冷备和对应秘密配置。
3. 更新源码，按 lockfile `npm.cmd ci`，执行必要类型/行为检查。
4. 停服状态下增量 `db:migrate`，生产构建和 `build:verify`。
5. 单实例启动，再检查公网登录、后台和数据。
6. 失败保存错误和数据库状态，不把 `npm update` 或重置数据库作为修复捷径。

### 12.3 回滚

回滚前同样停止服务及自动拉起，保存当前失败现场为新冷备。旧代码与旧数据库 schema 可能不兼容，不能只换回源码就声称恢复；按验证过的成套旧源码、冷备、有效 pepper 及相关 keyring 恢复到独立目录，再核验并切换。已知会丢弃升级后新增记录时，先向用户明确影响，不直接覆盖。

回滚仍只能有一个可写服务器、一个预算事实来源。不要恢复旧快照后清未知标记或重复执行可能已经收费的请求。

## 13. 常见问题定位

| 现象 | 优先检查 |
| --- | --- |
| 启动要求 `DATABASE_URL` | production 模式缺了明确 `APP_MODE=local`，或误用了 connected |
| 迁过去用户/赛事都没了 | 工作目录错误、复制多套一层、没有恢复实际 `.runtime/postgres-data`、意外启动新空库 |
| PGlite 冲突/锁或文件异常 | 是否另跑 worker、数据库脚本、重复网站、同步盘或热复制 |
| 本机可开，手机不行 | 隧道是否真的在笔记本连 `127.0.0.1:3000`，节点/端口/DNS/TLS是否对应 |
| 手机无法登录/回跳 localhost | 最终 Origin、协议端口、Secure Cookie、返回链接及 SMTP真实收件 |
| DSH找不到/授权无效 | 旧绝对路径、严格版本不匹配、任务账号不同、授权过期或文件不可读 |
| `DSH_SESSION_PRIVACY_UNAVAILABLE` | 本地NTFS、服务账号权限、临时目录能否建立独占ACL |
| 自动搜索停止 | 已停机、worker失败、代理不可达、robots拒绝、预算不足、paused或unknown hold；不直接清账本 |
| `config:check` 退出1 | 阅读每组缺项；仅 GitHub 暂缓可以记录预期，不能忽略其它问题 |
| 运行几天自动停止 | 计划任务执行时限、睡眠/休眠、Windows更新、供电、日志/磁盘、后台失败 |
| 自签证书错误 | 为实际域名取得可信证书及完整链并正确加载，不能关验证 |

## 14. 目标部署完成后的交付格式

目标 Codex 最后新建实际部署验收 Markdown，记录以下内容，不含秘密值：

```text
部署日期/时间（北京时间）：
目标 Windows 用户/项目目录：
Node/npm 实际版本：
源码依据/最后迁移：
最新搬迁冷备名称/时间/离线验证结果：
有效 pepper 来源已保留：是/否（不记录值）
生产构建/追踪检查：
网站监听地址/根PID和监听PID识别方法：
网站计划任务/自启包装脚本/日志路径：
穿透客户端/隧道类型/节点/远程端口/自启方法：
最终 HTTPS URL：
DNS及严格TLS结果/证书到期和续期方式：
实体手机真实收件和登录结果：
真实DSH有限调用结果/usage或保守结算/未知状态：
后台启用项和心跳：
刷新及重启数据持久化：
备份路径/恢复命令/回滚方式：
源电脑后台已停止且不再写入：
仍未验证或需用户配合的事项：
```

当前代码与历史验收依据：[后端部署](后端部署.md)、[全规划补齐验收](../协作/验收报告-全规划补齐-2026-10-10.md)、[历史备份恢复记录](../协作/交付/local-backup-restore.md)。这些证明源环境中的部分结果，不证明这台笔记本已经上线；目标部署者应提交本次自己的实际证据。
