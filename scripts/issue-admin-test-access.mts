import { createConnection } from "node:net";
import { execFile } from "node:child_process";
import { lstat, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "../src/server/config.ts";
import { createDatabase, type ApplicationDatabase } from "../src/server/database.ts";
import { issueAdminTestAccess, type AdminTestAccess } from "../src/server/admin-test-access.ts";
import { protectPrivateDirectory } from "../src/shared/private-directory.ts";

const normalizePath = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
const unavailable = () => new Error("ADMIN_TEST_ACCESS_CLI_REJECTED");
const run = promisify(execFile);

async function rejectWindowsReparsePaths(paths: readonly string[]): Promise<void> {
  if (process.platform !== "win32") return;
  if (!process.env.SystemRoot || !isAbsolute(process.env.SystemRoot)) throw unavailable();
  const script = "$ErrorActionPreference='Stop'; try { foreach($path in (ConvertFrom-Json -InputObject $env:ADMIN_TEST_ACCESS_CHECK_PATHS)) { $entry=Get-Item -LiteralPath $path -Force; if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe' } }; [Console]::Write('clear') } catch { exit 1 }";
  const { stdout } = await run(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, shell: false, timeout: 8000, maxBuffer: 1024,
      env: { SystemRoot: process.env.SystemRoot, NODE_ENV: "production", ADMIN_TEST_ACCESS_CHECK_PATHS: JSON.stringify(paths) } });
  if (stdout !== "clear") throw unavailable();
}

/** Fixed production port; an optional port only enables disposable unit tests. */
export async function assertEmbeddedServerStopped(port = 3000): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw unavailable();
  for (const host of ["127.0.0.1", "::1"]) {
    await new Promise<void>((resolveCheck, reject) => {
      const socket = createConnection({ host, port });
      const finish = (error?: Error) => { socket.destroy(); error ? reject(error) : resolveCheck(); };
      socket.once("connect", () => finish(unavailable()));
      socket.once("error", error => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ECONNREFUSED" || host === "::1" && code === "EAFNOSUPPORT") finish();
        else finish(unavailable());
      });
      socket.setTimeout(1500, () => finish(unavailable()));
    });
  }
}

/** Require an existing, root-prepared directory and a new single-layer file. */
export async function validateAdminTestOutput(workspace: string, output: string): Promise<string> {
  if (typeof output !== "string" || !output || /[\u0000-\u001f\u007f]/.test(output)) throw unavailable();
  const root = resolve(workspace), runtime = resolve(root, ".runtime"), directory = resolve(runtime, "admin-test-access");
  const target = resolve(root, output), filename = relative(directory, target);
  if (normalizePath(dirname(target)) !== normalizePath(directory) || isAbsolute(filename)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.json$/.test(filename)
    || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(filename)) throw unavailable();
  for (const path of [root, runtime, directory]) {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || normalizePath(await realpath(path)) !== normalizePath(path)) throw unavailable();
  }
  await rejectWindowsReparsePaths([root, runtime, directory]);
  try { await lstat(target); throw unavailable(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return target;
}

/** Protect the owned directory before a credential can reach the filesystem. */
export async function reserveAdminTestOutput(workspace: string, output: string): Promise<{ path: string; file: FileHandle }> {
  const path = await validateAdminTestOutput(workspace, output);
  await protectPrivateDirectory(dirname(path));
  // Re-check after the ACL operation; do not overwrite or follow a target link.
  await validateAdminTestOutput(workspace, output);
  const file = await open(path, "wx", 0o600);
  return { path, file };
}

export function adminTestAccessDocument(access: AdminTestAccess, origin: string): string {
  const publicUrl = new URL(origin);
  if (publicUrl.origin !== origin || !["http:", "https:"].includes(publicUrl.protocol)) throw unavailable();
  return JSON.stringify({ purpose: "管理员短时一次性测试登录", ...access,
    delivery: "本机保管，未发送真实邮件",
    loginLinks: { local: "http://localhost:3000/login?test=1&returnTo=%2Fadmin", configured: `${origin}/login?test=1&returnTo=%2Fadmin` },
    instructions: "打开网站登录链接，在测试凭证输入框粘贴 credential。不要点击获取邮箱验证码，它会使本凭证失效。",
    sessionPolicy: "凭证默认 10 分钟有效且只能使用一次；兑换后的普通登录会话仍按网站现有规则最长 7 天，可从账号菜单退出。",
  }, null, 2) + "\n";
}

/** Direct CLI invocation only; importing helpers in tests never loads secrets. */
async function main() {
  const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let stage = "arguments", database: ApplicationDatabase | null = null;
  let reserved: { path: string; file: FileHandle } | null = null, issued: AdminTestAccess | null = null, saved = false;
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== "--email" || args[2] !== "--output") throw unavailable();
    if (normalizePath(await realpath(process.cwd())) !== normalizePath(await realpath(workspace))) throw unavailable();
    stage = "output-boundary";
    reserved = await reserveAdminTestOutput(workspace, args[3]!);
    stage = "configuration";
    try { process.loadEnvFile(resolve(workspace, ".env.local")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const config = await loadConfig();
    if (!config.databaseUrl) {
      stage = "server-still-running";
      await assertEmbeddedServerStopped();
      if (!config.localDatabasePath) throw unavailable();
    }
    stage = "database";
    database = await createDatabase({ connectionString: config.databaseUrl, localPath: config.localDatabasePath });
    // No migrate, seed, role grant or createApplication in this offline command.
    stage = "issue";
    issued = await issueAdminTestAccess({ database, codePepper: config.codePepper, email: args[1], globalSendLimit: config.globalSendLimit });
    stage = "save";
    await reserved.file.writeFile(adminTestAccessDocument(issued, config.origin), "utf8");
    await reserved.file.sync(); await reserved.file.close(); saved = true;
    process.stdout.write(`管理员测试凭证已写入 ${relative(workspace, reserved.path).split(sep).join("/")}\n到期时间：${issued.expiresAt}\n未发送真实邮件。\n`);
  } catch {
    // Failed local custody must not leave a usable unsaved challenge behind.
    if (database && issued && !saved) {
      try { await database.query("UPDATE auth_login_challenges SET revoked_at=$2 WHERE id=$1 AND consumed_at IS NULL AND revoked_at IS NULL", [issued.challengeId, new Date().toISOString()]); }
      catch { /* Never print a database/provider exception or credential. */ }
    }
    process.stderr.write(`管理员测试凭证未签发完成（${stage}）。请检查参数、目录权限、现有管理员身份及本机网站是否已停止。\n`);
    process.exitCode = 1;
  } finally {
    if (reserved && !saved) {
      await reserved.file.close().catch(() => {});
      // Only the newly created, already boundary-checked file is removed.
      await unlink(reserved.path).catch(() => {});
    }
    if (database) { try { await database.close(); } catch { process.stderr.write("数据库关闭未能确认，请先检查数据库状态再重新启动网站。\n"); process.exitCode = 1; } }
  }
}

if (process.argv[1] && normalizePath(resolve(process.argv[1])) === normalizePath(fileURLToPath(import.meta.url))) await main();
