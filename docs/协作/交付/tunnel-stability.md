# 内网穿透稳定性诊断与交付

状态：已交付，STOP。2026-10-12 单隧道稳定性修复已保存并复核；16 项隔离测试通过。全部临时文件交还主会话，不继续修改。

## 14:37：单隧道修复已完成，根可按正常流程维护网站

- 经 SakuraFrp 官方启动器“编辑隧道 #29448466 hackathon_guide → 自动 HTTPS 高级设置”现场确认，原工作模式为“自动检测”。
- 已记录修改字段及回滚信息到 `.runtime/tunnel-health-mode-before-20261012.json`（不含令牌/私钥）。仅将 `auto_https_mode` 从空值/自动检测改成 `http`/反代 HTTP，点击保存。
- 保存后启动器自动重启了这一条隧道：frpc 从 `5844` 变为 `33480`，创建时间 `2026-10-12 14:35:52 +08:00`，父服务仍为 `21220`。没有停止网站进程。
- 已关闭并重新打开官方编辑窗口，持久读取显示“反代 HTTP”；本地仍 `127.0.0.1:3000`，自动 HTTPS 域名仍 `hib.mywire.org`，证书策略仍“允许自动加载和回退”。DNS、证书、域名、AUTH_ORIGIN、其他隧道均未改。
- 保存后保留 hib 域名/SNI、指定原真实节点的严格 HTTPS `/events` 200，TLS 验证结果 0。正式普通域名的 DNS 干扰与 frp-off 自签边界仍存在，没有声称全部外网恢复。
- 此配置去除 frpc 启动时对本地 HTTP 的自动探测依赖：网站停机窗口应表现为后端暂不可用，恢复后仍按 HTTP 反代。**根可正常进行签名停机/构建/重启，不需要为本次配置再等待或停止隧道。** 网站停机与恢复实测尚待根实际维护窗口；本会话没有制造停站来测试。
- 官方依据：[SakuraFrp frpc 手册 auto_https_mode](https://doc.natfrp.com/frpc/manual.html#auto-https-mode)。`http` 只固定本地回源协议，不取消公网 TLS。

## DNS 补充：回复根查询，不能误改 Dynu

- 实际公网节点 `60.215.128.117:44353`；frpc 到节点控制/工作连接为 `60.215.128.117:80`；本地唯一网站监听 `127.0.0.1:3000`。没有独立 HTTPS 代理监听端口，TLS 终止在 frpc 内部。
- 系统 DNS 首次 A=`108.160.165.53`；指定阿里普通 DNS `223.5.5.5` 查询 A=`128.242.240.244`；指定 `1.1.1.1` 普通 DNS 查询 A=`174.37.175.229`。这些是普通查询返回值，不能当作 Dynu 权威配置。
- 本轮严格 HTTPS 查询 `https://dns.google/resolve?name=hib.mywire.org&type=A` 与 `https://cloudflare-dns.com/dns-query?name=hib.mywire.org&type=A`，两家均 Status=0、A=`60.215.128.117`、TTL=120。
- 不存在的 `does-not-exist-tunnel-probe-20261012.mywire.org` 普通 DNS 也返回 `65.49.68.152`，支持普通 DNS 查询链路被干扰的判断。具体干扰位置尚未确定。
- `hib.mywire.org` 证书 SAN=`DNS:hib.mywire.org`，ZeroSSL RSA DV SSL CA 2 签发，有效至 `2027-01-09 23:59:59 UTC`（北京时间 2027-01-10 07:59:59）。`frp-off.com` SAN=`DNS:frp-off.com`，自签，有效至 `2027-10-08 21:27:18 UTC`；有效期正常不能弥补信任失败。
- 当前未发现名称/动作含 Dynu、DDNS、hib 的 Windows 计划任务，也无 Dynu/DDNS 运行进程或服务；项目已知域名目录是证书签发/验收资料，尚未发现 DDNS 更新脚本。历史部署说明也明确 HTTPS DNS 与官方查询记录本来正确、用户暂停域名处理。
- **具体方案：无需把 Dynu 再指向节点，因为两家 HTTPS DNS 已读到正确 A；不应改成当前本机公网地址。** 应由根决定是否在用户当前授权下处理域名在实际客户端网络的解析问题，或建立另一条已验证可信域名入口。若要切换 AUTH_ORIGIN 与观猹回调，须等普通客户端严格 HTTPS 真正可用后统一切换；本会话不改应用配置或其他域名。
- 为预防历史网站停机触发自动 HTTPS 误判，可在确认当前单隧道具体配置后考虑 `auto_https_mode=http`（保持公网 TLS，仅固定到已确认 HTTP 的本地 3000）；尚未修改，当前启动器本地只保存账户/自启列表，单隧道配置由远端获取，不能猜测新增本地 ini 会被采用。

## 已确认的故障与范围

- 本站为 `hackathon_guide`，SakuraFrp 自动启动隧道 ID `29448466`；节点 `frp-off.com / 60.215.128.117`，公网 TCP `44353` 映射 `127.0.0.1:3000`，自动 HTTPS 由 frpc 内置处理，没有独立 nginx/caddy/本地 HTTPS 监听。
- 本地生产 Next PID `25136`、wrapper PID `40976`，启动于 14:01:17；`http://127.0.0.1:3000/events` 200。未停止、重启或修改网站与数据库。
- frpc PID `5844`，父服务 `21220`、启动器 `14480`，均自 10-11 21:55 运行；到节点 `60.215.128.117:80` 有 Established 连接。
- `https://frp-off.com:44353` 严格 TLS 失败 `DEPTH_ZERO_SELF_SIGNED_CERT`。本机现存对应公钥证书是自签，不能当作可信入口。
- `hib.mywire.org` 系统 DNS 解析为 `108.160.165.53`，正常严格 HTTPS 超时。仅对本次诊断请求指定真实节点 `60.215.128.117`，保留原域名/SNI、严格证书验证，`/events` 实测 200；不是修改 DNS/hosts，也不是跳过 TLS。已有 hib 证书由 ZeroSSL 签发，有效期至 2027-01-09。
- 因此本次现场无需协调重启网站或隧道：当前主要阻塞是前一入口自签证书、后一入口 DNS/路由异常。用户此前暂停域名处理，本会话不改 DNS、不改证书、不改 `.env.local`。
- 历史 10-10 日志另有真实问题：网站停服期间 frpc 自动探测失败后 HTTPS 被禁用，重启单隧道才恢复。10-11 日志多次出现 3000 拒绝连接，属于本地网站停机窗口。二者不能混称为网络断线。
- Windows 系统日志 10-11 21:52 记录 Kernel-Power 41 与 EventLog 6008（非正常关机）；最近两天未查询到睡眠/唤醒事件。没有证据认定本次掉线由睡眠导致；未更改电源/防火墙/全局网络。

## 分层健康检查

新文件 `scripts/tunnel-health.mjs`，无需依赖安装，不读 `.env.local`、启动器 token、证书私钥或生产数据库，不会自动重启任何进程。检查本站 `/events` 的 HTML 身份与 `/api/v1/system/status` 的结构；端口/进程存在不代表健康。该公开状态接口只证明应用 API 能响应，不宣称完成实际数据库读写或付费供应商验收。

```powershell
# 单次检查；只输出安全 JSON 元数据
node scripts/tunnel-health.mjs

# 明确有限次数：三轮，每轮后间隔十秒，每个网络请求最多五秒
node scripts/tunnel-health.mjs --count 3 --interval-seconds 10 --timeout-ms 5000
```

- `--count` 1–60；间隔 10–60 秒；每请求 1000–15000ms；响应最大 1MiB；重定向、非本站 200、证书失败、超时均不算健康。
- `publicHealthy` 明确对应普通 DNS 下的 `https://hib.mywire.org:44353`，须页面与 API 都通过严格证书校验和内容校验。固定节点 `pinned*` 仅诊断，永不替代这个结果。
- `legacyPage` 单列 `frp-off.com` 原入口的严格 TLS 状态，当前仍自签失败；脚本没有更改根的 AUTH_ORIGIN。
- DNS 可分别显示系统结果及两家 HTTPS DNS 结果；HTTPS DNS 不可达也诚实返回 TIMEOUT/ECONNRESET，不虚报已确认 DNS 正确。
- 不自动重启：证书、DNS、网站主动停机不能靠隧道重启解决。现有启动器的异常退出后重启功能沿用，本轮没有添加无限重启层、计划任务或 Codex 自动化。
- 退出码：全部轮次本地及 hib 普通入口健康为 0；任一轮失败为 1；参数/脚本错误为 2。

## 修复后现场验证

- 启动器日志：14:35:51 “隧道重启中”；14:35:52 “frpc 已退出 / 开始加载隧道配置 / 连接节点成功 / 为 hib.mywire.org 加载证书 / 隧道启动成功”。没有其他隧道变化记录。
- 新进程 33480 到 `60.215.128.117:80` 与本地 `127.0.0.1:3000` 的连接存在；Next 25136、wrapper40976 创建时间保持 14:01:17。
- 14:38:58、14:39:13、14:39:28 三轮：本地页面/API 全通过；保留 hib SNI、连接当前真实节点的 TLSv1.3 严格校验及页面/API全通过；普通 hib 仍 TIMEOUT；frp-off 仍 `DEPTH_ZERO_SELF_SIGNED_CERT`。脚本正确返回退出码 1。证据 `.runtime/tunnel-health-after-20261012.jsonl`。
- 此次测试从当前本机访问公网节点；实体手机/独立移动网络未验收。未通过持续断网/网络睡眠测试。正常网站停机后恢复的实测需根实际维护窗口复核；不以配置保存代替该场景的真实演练。

## 其余已排除或边界

- Windows 全部计划任务的名称和执行动作均按 DDNS/Dynu/Sakura/FRP/项目路径做过只读匹配，未发现对应 DDNS 或周期公网健康检查任务；不输出动作参数。没有新增任务。
- 既有网站历史输出管道阻塞问题已由根改用日志文件重定向启动；本轮没有改变网站启动方式。历史报告不能作为当前根因，当前本地 HTTP 实测健康。
- 最新日志最初为 0 字节，启动器界面检查后日志已落盘；不能因初始空日志声称没有异常。只保留了脱敏结论。

## 测试、交付与 STOP

- `node --check scripts/tunnel-health.mjs` 通过。
- `node --test scripts/tunnel-health.test.mjs`：16/16 通过。使用临时本机 HTTP fixture，覆盖有限参数、继承属性参数拒绝、固定节点成功不得冒充公网健康、本地与隧道故障分层、非本站 200、非 HTML、错误状态/重定向、超时、超大响应、脱敏输出及诊断 pin 限制。没有访问生产数据库或调用付费服务。
- 新增交付文件：`scripts/tunnel-health.mjs`、`scripts/tunnel-health.test.mjs`、本交付说明；运行证据仅 `.runtime/tunnel-health-*`。
- 未安装新的系统服务、计划任务或常驻重启程序。本次实际修复是官方单隧道固定 HTTP 回源模式；既有启动器的重连/重启职责继续保留。
- 用户在设置保存并重新打开复核后按实体 Esc 停止 Computer Use。本会话立即停止全部后续启动器 UI 操作；没有再修改设置。
- NEEDS_INTERFACE：无代码接口依赖。若根进行正常维护，建议启动后运行本脚本确认本地恢复与固定节点严格 HTTPS 恢复，并单独记录普通域名结果。固定模式下真实停机恢复场景尚未由本会话制造或完成，不推定通过。
- 回滚：仅将该隧道“自动 HTTPS 工作模式”改回备份记录的“自动检测”，保存由启动器重载；应保证本地 HTTP 已健康。回滚不需要改域名/证书/DNS。没有本轮凭据或环境变量需求。

**STOP：隧道与三个交付文件均交还主会话；无遗留后台健康检查进程。**

## 第二轮只读复核（2026-10-12 15:10–15:20，已完成，STOP）

本轮重新授权仅追加本交付说明。未操作电脑 UI，未改代码、域名、DNS、证书、隧道、系统设置；以下新证据覆盖前文“维护恢复尚未实测”的历史边界。

### 维护窗口后已恢复，无需重启隧道

- 主会话新 Next PID `27744`，创建于 14:45:48，父进程 `41336`；frpc 仍为 14:35:52 创建的 `33480`。
- frpc 日志在 14:44–14:45 网站维护窗口记录本地 3000 拒绝连接；15:10 本地 `/events` 200，固定节点、保留 hib Host/SNI 的严格 HTTPS 也 200。说明实际网站停机/恢复后，此隧道已恢复回源且没有额外重启 frpc。
- 普通 hib 域名仍在 8 秒连接超时；frp-off 严格证书仍 `SEC_E_UNTRUSTED_ROOT`。模式修复没有被误当作 DNS/证书修复。

### 性能初步证据（15:13–15:16）

| 请求 | 本地 TTFB / 总耗时 | 固定节点严格 TLS TTFB / 总耗时 | 普通 hib 入口 |
| --- | --- | --- | --- |
| `/events`，各 3 次 | 1.334–1.829ms / 1.372–1.868ms | 67.618–77.654ms / 71.662–95.370ms | 3 次均约 8 秒超时，TCP 未建立，0 字节 |
| `/api/v1/event-discoveries?limit=60` | 4.827ms / 4.980ms | 84.799ms / 122.415ms | 普通入口连接阻断，未把缓存/固定节点当普通入口通过 |
| `/api/v1/event-discoveries/live` | 6.278ms / 6.355ms | 85.762ms / 97.734ms | 同上 |

赛事 HTML 的节点 TLS 完成累计为 44.854–49.572ms；普通域名 DNS 完成仅 11.881–35.611ms，随后连不上返回的地址。当前样本不支持“本机 HTML 渲染慢”或“隧道必然多秒延迟”的判断。

**可网站服务侧优化：** 列表 JSON 在客户端 `--compressed` 协商 gzip/deflate 后，本地和节点均仍为 **117345 字节、无 Content-Encoding、chunked、private/no-store**；而现有 JS/CSS 已有 gzip 和一年 immutable 缓存。建议主会话审查大 JSON 响应的压缩与列表投影/首屏加载，保留权限和未知请求规则；不能用全局缓存私人 API 的方式解决。本会话仅报告，不修改网站代码。

真实页面引用的静态资源进一步量化如下（不是把整个构建目录大小冒充首屏下载量）：

| 资源 | 未压缩正文 | gzip 传输正文 | 指定节点总时长：未压缩 / gzip |
| --- | --- | --- | --- |
| `/_next/static/chunks/3dmm3v_fq28gc.js` | 229820 B | 71969 B | 129.650ms / 106.575ms |
| `/_next/static/chunks/31eyq4w8u8nzm.css` | 117339 B | 21809 B | 108.010ms / 93.929ms |

本地与节点的静态资源都返回 `public, max-age=31536000, immutable` 与 `Vary: Accept-Encoding`；gzip 响应使用 chunked。JS ETag=`W/"381bc-1a12edbab6d"`，CSS ETag=`W/"1ca5b-1a12edbabbd"`。当前没有证据需要重复修改这些缓存策略。浏览器 JavaScript 执行、真实首屏内容绘制和实体手机性能没有通过 curl 验收；仅凭 HTML 的 200/TTFB 不能代替。

### DNS 记录与委派：没有发现应当由本站重写的错误

所有下述 HTTP 查询均校验证书；没有修改客户端 DNS/hosts、没有使用跳过 TLS 选项、没有写入 Dynu 账户。查询公共域名所用诊断入口不携带账户密钥。

| 项目 | 本轮证据 |
| --- | --- |
| `.org` 注册局登记的委派 | 从 IANA RDAP bootstrap 获取 `.org` 官方端点，再查询 [PIR 的 mywire.org RDAP](https://rdap.publicinterestregistry.org/rdap/domain/mywire.org)：NS 为 `ns0/ns1/ns3/ns4/ns5/ns6.dynu.com`，`delegationSigned=false`。未输出注册人资料。 |
| 区域 NS | Google 和 Cloudflare 的 HTTPS DNS 返回完全相同的六个 Dynu NS，与注册局登记一致。 |
| `hib.mywire.org A` | Google、Cloudflare HTTPS DNS 都返回 `60.215.128.117`，TTL=120；Dynu 官方 DNSLookup 默认查询也是同一地址。 |
| 六台权威端点交叉查询 | 通过 [Dynu 官方 DNSLookup](https://www.dynu.com/en-US/NetworkTools/DNSLookup)，选择 Other 并分别指定 ns0 `66.85.159.14`、ns1 `72.51.58.2`、ns3 `162.251.164.146`、ns4 `108.181.159.122`、ns5 `216.105.169.98`、ns6 `173.0.55.138`；工具全部返回 `hib.mywire.org A=60.215.128.117, TTL=120`。这些 NS 地址先由 HTTPS DNS 读取。 |
| `hib.mywire.org AAAA` | 两家 HTTPS DNS 都是 NOERROR/NODATA，没有 IPv6 地址；指定 ns1 的 Dynu 查询同样无记录。 |
| `hib.mywire.org CNAME` | 两家 HTTPS DNS 都是 NOERROR/NODATA，没有 CNAME 跳转或链；指定 ns1 的 Dynu 查询同样无记录。 |
| `hib.mywire.org NS` | HTTPS DNS 无单独子区 NS、返回 `mywire.org` SOA；它作为父区内主机记录存在，这本身不是错误。 |
| DNSSEC | 两家 HTTPS DNS 的 `mywire.org DS` 均无记录，注册局也记录未签名；没有观察到 DNSSEC SERVFAIL。`AD=false` 不是本次 DNS 故障的证据。 |
| `frp-off.com` | HTTPS DNS A=`60.215.128.117`、AAAA 无记录；SOA 为 DNSPod。该入口 TCP/TLS 可连接，但证书不可信。 |
| 不存在的测试子域 | HTTPS DNS 对 `does-not-exist-tunnel-probe-20261012.mywire.org` 返回 NXDOMAIN；本机普通 DNS 却返回 `98.159.108.57`。 |
| 本机普通解析 | 15:10 `hib.mywire.org` 返回 IPv4 `104.244.43.231` 和 IPv6 `2001::1f0d:5f30`，均不属于上述真实 A/AAAA 结果。早先还返回过其他不同地址。 |

Google/Cloudflare/Dynu 的结果属于本次公开查询观测，不能保证将来一直不变。SOA serial 在不同查询/缓存中有差异；但本轮六台指定端点的目标 A 一致，未发现某台把 hib 指到错误公网地址的证据。本机向六台权威服务器发起 TCP/53、非递归查询均报未明确错误，故没有把这条不可靠路径作为权威反证；Dynu DNSLookup 对父区服务器的 NS 查询未展示 referral，也没有把“无 Answer”误写成“没有委派”。注册局与递归解析的交叉证据才用于委派结论。

**判断：证据强烈支持当前普通 DNS 查询路径存在干扰/替换，尚不能定位是本机、网关、运营商还是上游哪一段。没有证据支持重写 Dynu A、删除本不存在的 AAAA、改变 CNAME 或自动更新到家庭公网地址。** 域名后缀的普通查询结果已经被替换时，当前 Next/frpc 服务器收不到这些连接；修改网站代码或再次重启隧道不能使客户端连接到正确地址。

### 保留两个现有域名时，服务侧可执行边界

| 现有入口 | 当前服务侧事实 | 可执行方向与限制 |
| --- | --- | --- |
| `hib.mywire.org:44353` | 现有 A、委派、证书链和回源均可通过上述诊断；现有证书 SAN 覆盖 hib，过期时间仍为 2027-01-09 23:59:59 UTC。 | 继续使用已有可信证书与 HTTP 固定回源；网站侧优化数据压缩。要让受影响的普通解析路径恢复，需由实际 DNS/网络责任方修复错误应答；当前没有一个已证实可由本站隧道参数解决的服务侧改动。不建议反复写相同 A 或凭空增加 AAAA。本轮没有联系第三方或改任何设置。 |
| `frp-off.com:44353` | 当前自动证书自签；它是共享节点域名，不是 hib 证书覆盖的名字。 | Sakura 官方未提供普通租户为这个共享名字一键取得可信证书的文档方案。若必须保留完全相同的 URL，只有域名控制方提供匹配证书或官方支持的 TLS 终止服务才可能满足要求；其可用性/授权尚未核实，不能承诺现成可执行。 |

官方依据（本轮重新核对）：

- [frpc 手册](https://doc.natfrp.com/frpc/manual.html#auto-https)：`auto_https=auto` 默认使用节点域名生成自签证书；配置了子域绑定才加载对应绑定域名的服务端证书。把当前选项改成 `auto` 不等于修好 frp-off 信任。
- [子域绑定](https://doc.natfrp.com/bestpractice/domain-bind.html)：官方免费受信任证书配套 `nyat.app` 子域；这会使用不同访问主机名，不符合本轮保留现有域名的限制，未操作。
- [SSL 证书配置](https://doc.natfrp.com/frpc/ssl.html)：自备证书要求拥有相应域名并部署匹配的证书链及私钥；hib 或 nyat.app 证书不能用于验证 frp-off。
- [Web 应用穿透](https://doc.natfrp.com/app/http.html)：TCP 隧道可以用节点域名加端口访问，但这不是对共享域名可信证书的承诺。TLS 校验在 HTTP 响应之前完成，故重定向也不能修复访问 frp-off 时最初的证书错误。

结论：**已证实可直接优化的是网站大 JSON 的传输与前端加载；已修复的 HTTP 固定回源成功跨过一次真实网站维护。普通 hib 解析错误、frp-off 共享域名可信证书不应包装成“再改一个本机参数即可完成”。** 在“不改客户端 DNS/hosts、不新增域名、不弱化 TLS、不改现有域名/证书/隧道”的边界内，未发现另一个可立即执行的服务侧修复。此结论不排除 DNS/网络供应商纠正应答，或共享域名所有者提供合法证书后的后续方案。

第二轮 STOP：只修改本交付说明，无新增常驻进程、无 UI 操作、无配置变更。所有证据交还根；网站性能代码由主会话完成。

