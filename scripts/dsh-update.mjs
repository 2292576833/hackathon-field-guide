#!/usr/bin/env node
/**
 * 跟随上游 DeepSeek Harness 更新（不依赖 git）。
 *
 * 用法：
 *   node scripts/dsh-update.mjs --check   只检查上游是否有新提交（默认）
 *   node scripts/dsh-update.mjs --apply   拉取 → 解压 → 安装 → 构建 → 写就绪标记
 *
 * 安全原则：任何一步失败都**不覆盖**当前就绪版本，只把失败写进日志与状态文件；
 * 后端只认「就绪标记里 commit 与产物都存在」的版本，失败自动沿用旧版。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const RUNTIME = join(ROOT, ".runtime");
const STATE = join(RUNTIME, "dsh-source.json");
const LOG = join(RUNTIME, "dsh-update.log");
const REPO = "deepseek-ai/deepseek-harness";
const BRANCH = "master";
const PNPM = "11.28.5";

mkdirSync(RUNTIME, { recursive: true });
const now = () => new Date().toISOString();
function log(line) {
  const text = "[" + now() + "] " + line;
  appendFileSync(LOG, text + "\n", "utf8");
  console.log(text);
}
function readState() {
  try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return { commit: null, builtAt: null, status: "none" }; }
}
function writeState(value) { writeFileSync(STATE, JSON.stringify(value, null, 2), "utf8"); }

async function upstream() {
  const response = await fetch("https://api.github.com/repos/" + REPO + "/commits/" + BRANCH, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "hackathon-field-guide-updater" },
  });
  if (!response.ok) throw new Error("GITHUB_COMMITS_" + response.status);
  const body = await response.json();
  return { commit: String(body.sha ?? ""), date: String(body.commit?.committer?.date ?? "") };
}

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const state = readState();
log("检查上游 " + REPO + "@" + BRANCH + "（当前就绪 " + (state.commit ?? "无") + "）");
const remote = await upstream();
log("上游最新 " + remote.commit.slice(0, 12) + " · " + remote.date);
if (remote.commit === state.commit) {
  log("已是最新，不动。");
  process.exit(0);
}
if (!apply) {
  log("发现新提交；加 --apply 才会拉取与构建。");
  writeState({ ...state, latestSeen: remote.commit, checkedAt: now() });
  process.exit(0);
}

const work = join(RUNTIME, "dsh-src-" + remote.commit.slice(0, 12));
const zip = work + ".zip";
log("下载 " + zip);
const download = await fetch("https://codeload.github.com/" + REPO + "/zip/refs/heads/" + BRANCH);
if (!download.ok) { log("下载失败 " + download.status); process.exit(2); }
writeFileSync(zip, Buffer.from(await download.arrayBuffer()));

if (existsSync(work)) rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
log("解压");
execFileSync("powershell", ["-NoProfile", "-Command",
  "Expand-Archive -LiteralPath '" + zip + "' -DestinationPath '" + work + "' -Force"], { stdio: "inherit" });
const inner = join(work, "deepseek-harness-" + BRANCH);
if (!existsSync(inner)) { log("解压目录结构不符合预期"); process.exit(3); }

// 已知坑：xlsx 只在 sheetjs 的 CDN 上，国内网络常超时。放了本地 tgz 就用本地包替代。
const localXlsx = join(RUNTIME, "xlsx-0.20.3.tgz");
if (existsSync(localXlsx)) {
  log("用本地 xlsx 包改写依赖");
  const pkgPath = join(inner, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.pnpm = pkg.pnpm ?? {};
  pkg.pnpm.overrides = { ...(pkg.pnpm.overrides ?? {}), xlsx: "file:" + localXlsx.replace(/\\/g, "/") };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), "utf8");
}

function run(command, cwd) {
  log("执行 " + command);
  try {
    execFileSync("cmd", ["/c", command], { cwd, stdio: "inherit", env: { ...process.env } });
    return true;
  } catch (error) { log("失败 " + (error?.status ?? "?")); return false; }
}
if (!run("npx --yes pnpm@" + PNPM + " install --frozen-lockfile --reporter=append-only", inner)) {
  writeState({ ...state, status: "install_failed", failedAt: now(), attempted: remote.commit });
  log("安装失败：保持旧版本，不切换。");
  process.exit(4);
}
if (!run("npx --yes pnpm@" + PNPM + " run build:lib", inner)) {
  writeState({ ...state, status: "build_failed", failedAt: now(), attempted: remote.commit });
  log("构建失败：保持旧版本，不切换。");
  process.exit(5);
}
writeState({ commit: remote.commit, builtAt: now(), status: "ready", directory: inner });
log("构建完成，已写就绪标记；**下次重启**才会切到新版。");
