import { dirname, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { requestGracefulStop } from "../src/server/graceful-stop.ts";

async function main() {
  try {
    const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const normalize = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
    if (process.argv.length !== 2 || normalize(await realpath(process.cwd())) !== normalize(await realpath(workspace))) throw new Error();
    const result = await requestGracefulStop({ workspace });
    process.stdout.write(`该网站实例已完成数据库关闭并退出（PID ${result.pid}）。冷备前仍须确认没有自动重启、3000 端口监听或其它数据库进程。\n`);
  } catch {
    process.stderr.write("未确认网站已安全停止。请检查服务控制目录权限、服务状态或关闭失败记录；本命令没有强杀进程，请勿开始冷备。\n");
    process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
