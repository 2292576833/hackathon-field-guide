# 可信文件控制通道与优雅停服

仅新增 `src/server/graceful-stop.ts/.test.ts`、`scripts/stop-server.mts`。根负责网站启动、请求排空、后台与数据库关闭的组合；没有修改现有路由或配置，没有 HTTP 停服接口。

## 根组合接口

```ts
const control = await installGracefulStop({
  workspace: process.cwd(),
  shutdown: async () => {
    // 必须先同步关闭新请求/新后台工作的入口。
    markStopping();
    await drainHttpRequests();
    await workers.stop();
    await app.database.close();
  },
});
```

`shutdown()` 是全部关闭工作的唯一回调，必须真实完成后才 resolve，失败要 throw。控制器验证签名后立即消费本实例唯一请求，不重复调用；成功回执只在回调完成后发布并同步落盘，然后调用 `process.exit(0)`。没有用 Windows 信号代替关闭。`dispose()` 仅停止控制轮询，不能被当成数据库关闭；不要在 `shutdown()` 内调用它，因为它会等待正在进行的关闭回调。

默认每 250ms 轮询，空闲时仅检查固定请求文件是否存在，不重叠执行。可注入 `exit`、`clock`、`isProcessAlive` 和关闭自动轮询用于隔离测试。默认运行接口全部使用真实时钟/PID/退出机制。

## 本机停服

在项目根目录，以同一服务账号执行：

```powershell
node --experimental-strip-types scripts/stop-server.mts
```

命令没有参数，不读取环境密钥，不打开数据库。完成目录校验与请求发布后，回执等待最多 60 秒，等待中的 Windows ACL 子进程也会被截止信号取消。必须收到与原请求/启动实例一致的签名成功回执、该 PID 已退出，且重新读取的 `current.json` 仍指向原实例，才报告该实例已关闭。失败或超时不会强杀，也不会报告安全停止；冷备前根仍需禁用自动拉起、核对 3000 端口及其它数据库操作进程全部退出。

再次运行时复用同一实例已存在的真实签名请求与 nonce，不覆盖文件、不重复关闭。已过签发期限的请求只能被观察其既有回执，不能由重试重新授权执行；若此前未被服务端接受，只会继续等待并超时。失败回执仍拒绝确认成功，新实例不能接受旧请求或旧回执。

## 保管与限制

- `.runtime/server-control` 必须 owner-only；每次启动创建随机 UUID 子目录，先建立并验证私密 ACL，再以 `wx` 写入新的 32-byte key 和签名启动回执。密钥不进控制台、URL、请求日志或公网。
- 固定 `current.json` 只指向本项目的实际 PID、启动时间和随机实例 ID。请求和回执使用不同签名用途，绑定这些身份字段及 nonce；请求只允许 `shutdown`，拒绝额外字段、错签名、重放和超时。
- 校验目录祖先、文件 canonical 路径、symlink、Windows reparse 与私密 ACL；读取句柄复核且最多读 4097 bytes，超过 4KB拒绝。完整请求/回执通过 NTFS hard link 原子发布，禁止覆盖另一 CLI 请求。
- 启动安装采用排他 `install.lock`；正在运行的旧实例不会被接管。安装进程若崩溃留下锁，只能由管理员先确认原实例/安装进程已退出后处理，程序不会自动夺锁。有效请求失败后保留失败回执与现场，不自动再次关闭。
- 文件控制是同一操作系统账号的受信任运维能力，不能防御已掌握该账号或目录权限的攻击者。未声明它是网络客户端或一般网页可调用的接口。
- 停服回执不能证明此前强停库没有损坏。冷备恢复仍须完成约束、业务事实与正常 close 后重开验证；付费 unknown hold 保留，不自动重发。

## 验证记录

2026-10-11：`node --experimental-strip-types --test src/server/graceful-stop.test.ts` 共 12 项通过，`tsc --noEmit --incremental false` 通过。关键行为使用独立临时目录，不打开任何数据库或真实停服。测试覆盖签名/期限/身份、只执行一次、排空与关闭顺序、失败回执、伪造回执、CLI 超时与竞争、过期原请求观察、当前实例被替换、成功 ACK 但 PID 未退出、路径链接边界及新实例重放。实际网站请求计数、关闭组合和生产停服由根验收；本次没有运行真实 CLI、构建或迁移。

## NEEDS_INTERFACE

根需在真实同一网站进程安装控制器，并提供真实 `shutdown` 回调。服务器应在 stopping 时拒绝新请求/任务，等待所有已进入的业务后关闭数据库。服务脚本应使用本 CLI 作为日常停服；强杀仅用于明确故障处置，不能当作干净关闭。

本轮四个文件已交付并停止修改，临时权限交还主会话。STOP。
