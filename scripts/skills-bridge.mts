import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createSkillsBridge } from "../src/modules/skills/bridge.ts";
const args = process.argv.slice(2);
function argument(name: string): string | undefined { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
const projectRoot = argument("--project-root"); const origin = argument("--origin"); const serverOrigin = argument("--server") ?? origin;
if (!projectRoot || !origin || !serverOrigin || args.includes("--help")) {
  process.stdout.write("用法：node --experimental-strip-types scripts/skills-bridge.mts --project-root <明确授权的项目目录> --origin <网站完整origin> [--server <相同origin>] [--port 0] [--proxy <HTTP(S)代理>] [--install-request <已确认请求JSON文件>]\n仅写入此项目，保留已有技能，不运行正文/脚本。\n");
  process.exit(args.includes("--help") ? 0 : 1);
}
let proxyUrl = argument("--proxy") ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
if (!proxyUrl && process.platform === "win32") {
  // Fixed read-only system-network query; no user text or skill body enters shell code.
  const query = "$p=[Net.WebRequest]::DefaultWebProxy.GetProxy([Uri]'https://raw.githubusercontent.com/'); if($p.Host -ne 'raw.githubusercontent.com'){[Console]::Write($p.AbsoluteUri)}";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(query, "utf16le").toString("base64")], { windowsHide: true, timeout: 5000, encoding: "utf8" });
  if (result.status === 0 && result.stdout.trim()) proxyUrl = result.stdout.trim();
}
const bridge = await createSkillsBridge({ projectRoot, origin, serverOrigin, proxyUrl });
const requestFile = argument("--install-request");
if (requestFile) { try { const request = JSON.parse(await readFile(requestFile, "utf8")); const result = await bridge.install(request); process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); } finally { await bridge.close(); } }
else {
  const port = Number(argument("--port") ?? 0); if (!Number.isInteger(port) || port < 0 || port > 65535) { await bridge.close(); throw new Error("端口需为 0 到 65535 的整数。"); }
  const address = await bridge.listen(port);
  process.stdout.write(`本机技能桥接已启动：${address.url}\n配对令牌（仅填本站当前页面，不发给他人）：${address.pairToken}\n配对到期：${address.pairExpiresAt}\n仅操作你明确授权的项目目录。文件安装、加载、任务效果分别记录。按 Ctrl+C 关闭。\n`);
  let exiting = false; const shutdown = async () => { if (exiting) return; exiting = true; await bridge.close(); process.exit(0); }; process.on("SIGINT", () => void shutdown()); process.on("SIGTERM", () => void shutdown());
}
