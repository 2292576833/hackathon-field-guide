import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEEPSEEK_HARNESS_PACKAGE, DEEPSEEK_HARNESS_VERSION, DEEPSEEK_HARNESS_NPM_INTEGRITY } from "../src/modules/operations/deepseek-harness.ts";

const REGISTRY = "https://registry.npmjs.org/";
const TARBALL = "https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.1-alpha.1.tgz";
const NODE_MODULE_KEY = "node_modules/@deepseek-ai/dsh";
const OUTPUT_LIMIT = 4 * 1024 * 1024;
type JsonObject = Record<string, unknown>;
function fail(code: string): never { throw new Error(code); }
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("DSH_INSTALL_INVALID_MANIFEST");
  return value as JsonObject;
}
function contained(root: string, path: string): boolean {
  const value = relative(root, path);
  return value !== "" && !isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`);
}

/** Verify the exact downloaded artifact independently of npm's registry metadata and unpacking. */
export function verifyDshTarball(bytes: Uint8Array): void {
  if (bytes.byteLength < 1 || bytes.byteLength > 50 * 1024 * 1024) fail("DSH_INSTALL_TARBALL_SIZE_INVALID");
  const actual = Buffer.from(createHash("sha512").update(bytes).digest("base64"));
  const expected = Buffer.from(DEEPSEEK_HARNESS_NPM_INTEGRITY.slice("sha512-".length));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail("DSH_INSTALL_INTEGRITY_MISMATCH");
}

/** Top-level version and tarball integrity are pinned; the generated lock records transitive versions. */
export function verifyDshLock(value: unknown): void {
  const lock = object(value);
  if (lock.lockfileVersion !== 3) fail("DSH_INSTALL_LOCK_INVALID");
  const packages = object(lock.packages);
  const root = object(packages[""]);
  if (object(root.dependencies)[DEEPSEEK_HARNESS_PACKAGE] !== DEEPSEEK_HARNESS_VERSION) fail("DSH_INSTALL_VERSION_NOT_PINNED");
  const direct = object(packages[NODE_MODULE_KEY]);
  if (direct.version !== DEEPSEEK_HARNESS_VERSION || direct.integrity !== DEEPSEEK_HARNESS_NPM_INTEGRITY || direct.resolved !== TARBALL) fail("DSH_INSTALL_LOCK_INTEGRITY_MISMATCH");
  for (const [name, entry] of Object.entries(packages)) {
    if (name === "") continue;
    const item = object(entry);
    let url: URL;
    try { url = new URL(String(item.resolved)); } catch { fail("DSH_INSTALL_DEPENDENCY_SOURCE_INVALID"); }
    if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || url.username || url.password || url.search || url.hash || item.link === true || typeof item.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(item.integrity)) fail("DSH_INSTALL_DEPENDENCY_SOURCE_INVALID");
  }
}

export function cleanInstallerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  // The installer does not inherit application credentials, npm auth, NODE_OPTIONS or project npmrc.
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "PATHEXT", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

async function npmCli(): Promise<string> {
  const paths = [process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  for (const path of paths) {
    if (!path || basename(path) !== "npm-cli.js") continue;
    try { await access(path); return await realpath(path); } catch { /* Try the next bundled npm location. */ }
  }
  fail("DSH_INSTALL_NPM_UNAVAILABLE");
}

async function runNpm(cli: string, directory: string, args: readonly string[]): Promise<string> {
  const configFile = join(directory, ".installer-empty.npmrc");
  const globalConfigFile = join(directory, ".installer-global-empty.npmrc");
  return new Promise((resolveOutput, reject) => {
    const child = spawn(process.execPath, [cli, ...args, "--ignore-scripts", "--no-audit", "--no-fund", "--registry", REGISTRY,
      "--cache", join(directory, ".installer-cache"), "--userconfig", configFile, "--globalconfig", globalConfigFile], {
      cwd: directory, env: cleanInstallerEnvironment(process.env), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = []; let bytes = 0; let exceeded = false; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10 * 60_000);
    const consume = (chunk: Buffer, capture: boolean) => {
      bytes += chunk.byteLength;
      if (bytes > OUTPUT_LIMIT) { exceeded = true; child.kill(); return; }
      if (capture) chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => consume(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, false));
    child.once("error", () => { clearTimeout(timer); reject(new Error("DSH_INSTALL_NPM_START_FAILED")); });
    child.once("close", code => {
      clearTimeout(timer);
      if (exceeded || timedOut || code !== 0) reject(new Error(exceeded ? "DSH_INSTALL_NPM_OUTPUT_LIMIT" : timedOut ? "DSH_INSTALL_NPM_TIMEOUT" : "DSH_INSTALL_NPM_FAILED"));
      else resolveOutput(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

async function readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(path, "utf8")); }
async function verifyInstalled(directory: string): Promise<void> {
  const lock = await readJson(join(directory, "package-lock.json"));
  verifyDshLock(lock);
  const packageDirectory = join(directory, "node_modules", "@deepseek-ai", "dsh");
  for (const path of [join(directory, "node_modules"), join(directory, "node_modules", "@deepseek-ai"), packageDirectory]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) fail("DSH_INSTALL_RUNTIME_PATH_UNSAFE");
  }
  const manifest = object(await readJson(join(packageDirectory, "package.json")));
  if (manifest.name !== DEEPSEEK_HARNESS_PACKAGE || manifest.version !== DEEPSEEK_HARNESS_VERSION || object(manifest.bin).dsh !== "lib/bin.js") fail("DSH_INSTALL_RUNTIME_MISMATCH");
  const executable = join(packageDirectory, "lib", "bin.js");
  if (!(await lstat(executable)).isFile() || !contained(await realpath(packageDirectory), await realpath(executable))) fail("DSH_INSTALL_EXECUTABLE_INVALID");
}

async function runtimeParent(workspace: string): Promise<string> {
  const root = await realpath(workspace);
  const runtime = join(root, ".runtime");
  try { await mkdir(runtime, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = await lstat(runtime);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(runtime) !== runtime) fail("DSH_INSTALL_RUNTIME_PATH_UNSAFE");
  return runtime;
}

/** Installs only a new direct child of this workspace's .runtime; existing directories are retained. */
export async function installDsh(input: { directory?: string; check?: boolean; workspace?: string } = {}): Promise<{ directory: string; version: string; status: "installed" | "verified" }> {
  if (Number(process.versions.node.split(".")[0]) < 24) fail("DSH_INSTALL_REQUIRES_NODE_24");
  const workspace = await realpath(input.workspace ?? process.cwd());
  const parent = await runtimeParent(workspace);
  const directory = resolve(workspace, input.directory ?? join(parent, "dsh-runtime"));
  if (dirname(directory) !== parent || !/^dsh-runtime(?:-[A-Za-z0-9_-]{1,64})?$/.test(basename(directory))) fail("DSH_INSTALL_DIRECTORY_OUTSIDE_WORKSPACE");
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("DSH_INSTALL_RUNTIME_PATH_UNSAFE");
    await verifyInstalled(directory);
    return { directory, version: DEEPSEEK_HARNESS_VERSION, status: "verified" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Do not repair a partially existing installation in-place.
    try { await access(directory); fail("DSH_INSTALL_EXISTING_DIRECTORY_INCOMPLETE"); } catch (existsError) { if ((existsError as NodeJS.ErrnoException).code !== "ENOENT") throw existsError; }
  }
  if (input.check) fail("DSH_INSTALL_RUNTIME_NOT_FOUND");
  const lockPath = join(parent, `.${basename(directory)}.install-lock`);
  const lock = await open(lockPath, "wx", 0o600);
  let staging: string | undefined;
  try {
    // A second installer may have completed before we obtained the exclusive lock.
    try { await access(directory); fail("DSH_INSTALL_DIRECTORY_ALREADY_EXISTS"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    staging = await mkdtemp(join(parent, ".dsh-install-"));
    await writeFile(join(staging, ".installer-empty.npmrc"), "", { flag: "wx", mode: 0o600 });
    await writeFile(join(staging, ".installer-global-empty.npmrc"), "", { flag: "wx", mode: 0o600 });
    await writeFile(join(staging, "package.json"), `${JSON.stringify({ name: "field-guide-dsh-runtime", private: true, type: "module", dependencies: { [DEEPSEEK_HARNESS_PACKAGE]: DEEPSEEK_HARNESS_VERSION } }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const cli = await npmCli();
    const artifacts = join(staging, ".installer-artifacts"); await mkdir(artifacts);
    const packed = JSON.parse(await runNpm(cli, staging, ["pack", `${DEEPSEEK_HARNESS_PACKAGE}@${DEEPSEEK_HARNESS_VERSION}`, "--json", "--pack-destination", artifacts])) as unknown;
    if (!Array.isArray(packed) || packed.length !== 1) fail("DSH_INSTALL_PACK_INVALID");
    const artifact = object(packed[0]);
    if (artifact.name !== DEEPSEEK_HARNESS_PACKAGE || artifact.version !== DEEPSEEK_HARNESS_VERSION || artifact.integrity !== DEEPSEEK_HARNESS_NPM_INTEGRITY || typeof artifact.filename !== "string" || artifact.filename !== basename(artifact.filename) || !/^[A-Za-z0-9._-]+\.tgz$/.test(artifact.filename)) fail("DSH_INSTALL_PACK_IDENTITY_MISMATCH");
    const tarball = join(artifacts, artifact.filename);
    if ((await stat(tarball)).size > 50 * 1024 * 1024) fail("DSH_INSTALL_TARBALL_SIZE_INVALID");
    verifyDshTarball(await readFile(tarball));
    await runNpm(cli, staging, ["install", "--package-lock-only", "--save-exact"]);
    verifyDshLock(await readJson(join(staging, "package-lock.json")));
    await runNpm(cli, staging, ["ci", "--omit=dev"]);
    await verifyInstalled(staging);
    const lockHash = createHash("sha256").update(await readFile(join(staging, "package-lock.json"))).digest("hex");
    await writeFile(join(staging, "runtime-receipt.json"), `${JSON.stringify({ package: DEEPSEEK_HARNESS_PACKAGE, version: DEEPSEEK_HARNESS_VERSION,
      integrity: DEEPSEEK_HARNESS_NPM_INTEGRITY, lockSha256: lockHash, ignoreScripts: true }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    for (const entry of [".installer-artifacts", ".installer-cache", ".installer-empty.npmrc", ".installer-global-empty.npmrc"]) {
      const owned = join(staging, entry);
      if (!contained(staging, owned)) fail("DSH_INSTALL_CLEANUP_PATH_UNSAFE");
      await rm(owned, { recursive: true, force: true });
    }
    await rename(staging, directory); staging = undefined;
    return { directory, version: DEEPSEEK_HARNESS_VERSION, status: "installed" };
  } finally {
    if (staging) {
      if (dirname(staging) !== parent || !basename(staging).startsWith(".dsh-install-") || !contained(workspace, staging)) fail("DSH_INSTALL_CLEANUP_PATH_UNSAFE");
      await rm(staging, { recursive: true, force: true });
    }
    await lock.close(); await rm(lockPath, { force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write("安装后端 DSH 固定版本（Node.js 24+，不读取应用密钥）。\n用法: node scripts/install-dsh.mts [--check] [--directory .runtime/dsh-runtime[-名称]]\n既有目录只验证，不覆盖；--check 不下载或安装包。\n");
    return;
  }
  let directory: string | undefined; let check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--check" && !check) check = true;
    else if (args[i] === "--directory" && directory === undefined && args[i + 1] && !args[i + 1].startsWith("--")) directory = args[++i];
    else fail("DSH_INSTALL_ARGUMENT_INVALID");
  }
  const result = await installDsh({ directory, check });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    const message = error instanceof Error && /^DSH_INSTALL_[A-Z0-9_]+$/.test(error.message) ? error.message : "DSH_INSTALL_FAILED";
    process.stderr.write(`${message}\n`); process.exitCode = 1;
  });
}
