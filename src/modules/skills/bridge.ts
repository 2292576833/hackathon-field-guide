import { createServer } from "node:http";
import type { Server } from "node:http";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, realpath, mkdir, open, readFile, unlink, rmdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, dirname, parse } from "node:path";
import { adapter } from "./adapters.ts";
import { hash, safeRelative } from "./domain.ts";
import { proxyRequest } from "./network.ts";
import type { InstallationManifest, InstallationReceipt, ManifestItem, SkillFile } from "./domain.ts";

interface InstallRequest { planId: string; manifestHash: string; bridgeToken: string }
interface LocalJournal { receipt: InstallationReceipt; createdDirectories: readonly string[] }
export interface BridgeOptions {
  projectRoot: string; origin: string; serverOrigin: string; pairToken?: string; now?: () => Date;
  authorize?: (input: InstallRequest) => Promise<{ manifest: InstallationManifest; manifestHash: string }>;
  report?: (input: InstallRequest, receipt: InstallationReceipt) => Promise<void>;
  fetchBytes?: (file: SkillFile) => Promise<Uint8Array>;
  /** Local code integration/test fault injection only; never accepted from HTTP. */
  onFileWritten?: (relativePath: string) => Promise<void>;
  /** Explicit local configuration only. Credentials never appear in receipts or the website. */
  proxyUrl?: string;
}
function sha(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function siteOrigin(value: string): string { const url = new URL(value); if (url.origin !== value || url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new Error("网站需精确 HTTPS origin；本机开发允许 loopback HTTP。"); return url.origin; }
async function boundedResponse(response: Response, max: number): Promise<Uint8Array> { if (!response.ok || !response.body) throw new Error(`远程请求未完成（${response.status}）。`); const chunks = []; let size = 0; for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) { size += chunk.byteLength; if (size > max) throw new Error("下载超过体积限制。"); chunks.push(chunk); } return Buffer.concat(chunks); }
export async function createSkillsBridge(options: BridgeOptions) {
  const origin = siteOrigin(options.origin); const serverOrigin = siteOrigin(options.serverOrigin);
  if (origin !== serverOrigin) throw new Error("网站 origin 与授权服务器必须相同。");
  const inputRoot = resolve(options.projectRoot); if (inputRoot === parse(inputRoot).root || (await lstat(inputRoot)).isSymbolicLink()) throw new Error("请选择实际项目目录，不能是磁盘根目录或符号链接。");
  const projectRoot = await realpath(inputRoot); if (!(await lstat(projectRoot)).isDirectory()) throw new Error("项目目录不存在。");
  const pairToken = options.pairToken ?? randomBytes(32).toString("hex"); const now = options.now ?? (() => new Date()); const pairExpiresAt = now().getTime() + 30 * 60_000;
  const stateDirectory = join(projectRoot, ".hackathon-skills");
  async function checked(path: string): Promise<void> {
    const pathRelative = relative(projectRoot, path); if (isAbsolute(pathRelative) || pathRelative === ".." || pathRelative.startsWith(`..${sep}`)) throw new Error("路径超出已授权项目。");
    let current = projectRoot;
    for (const part of pathRelative.split(sep).filter(Boolean)) { current = join(current, part); try { const stat = await lstat(current); if (stat.isSymbolicLink()) throw new Error("目标路径含符号链接或 junction，已拒绝写入。"); const resolved = await realpath(current); const rel = relative(projectRoot, resolved); if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("目标路径离开授权项目。"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; } }
  }
  await checked(stateDirectory); try { await mkdir(stateDirectory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await lstat(stateDirectory)).isDirectory()) throw error; }
  const lockPath = join(stateDirectory, "bridge.lock"); await checked(lockPath); const lock = await open(lockPath, "wx", 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: now().toISOString() })); await lock.close();
  const keyPath = join(stateDirectory, "journal.key"); await checked(keyPath);
  let journalKey: Uint8Array;
  try { journalKey = await readFile(keyPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; journalKey = randomBytes(32); const keyFile = await open(keyPath, "wx", 0o600); try { await keyFile.writeFile(journalKey); } finally { await keyFile.close(); } }
  if (journalKey.byteLength !== 32) throw new Error("本地回执完整性密钥无效。");
  let closed = false; let busy = false;
  const active = new Map<string, InstallRequest>();
  const completed = new Map<string, InstallationReceipt>();
  async function network(url: string, method: string, maxBytes: number, headers?: Record<string, string>, body?: string): Promise<Uint8Array> {
    const target = new URL(url); if (options.proxyUrl && target.protocol === "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) { const result = await proxyRequest({ url, proxyUrl: options.proxyUrl, method, headers, body, maxBytes }); if (result.status < 200 || result.status >= 300) throw new Error(`远程请求未完成（${result.status}）。`); return result.bytes; }
    return boundedResponse(await fetch(url, { method, headers, body, redirect: "error", signal: AbortSignal.timeout(30_000) }), maxBytes);
  }
  async function remote(path: string, value: unknown): Promise<unknown> { const bytes = await network(`${serverOrigin}/api/v1/${path}`, "POST", 512 * 1024, { "Content-Type": "application/json", Origin: origin }, JSON.stringify(value)); const envelope = JSON.parse(new TextDecoder().decode(bytes)); if (envelope.error || !("data" in envelope)) throw new Error(envelope.error?.message ?? "授权服务器响应无效。"); return envelope.data; }
  const authorize = options.authorize ?? (async (input: InstallRequest) => await remote("skill-bridge/authorize", input) as { manifest: InstallationManifest; manifestHash: string });
  const report = options.report ?? (async (input: InstallRequest, receipt: InstallationReceipt) => { await remote("skill-bridge/receipts", { ...input, receipt }); });
  const fetchBytes = options.fetchBytes ?? (async (file: SkillFile) => { let failure: unknown; for (let attempt = 0; attempt < 3; attempt++) { try { return await network(file.downloadUrl, "GET", file.bytes); } catch (error) { failure = error; } } throw failure; });
  function validate(manifest: InstallationManifest, request: InstallRequest): void {
    const target = adapter(manifest.agentId);
    if (!target || manifest.schemaVersion !== "1" || manifest.adapterVersion !== "1" || manifest.scope !== "project" || manifest.planId !== request.planId || hash(manifest) !== request.manifestHash || Date.parse(manifest.expiresAt) <= now().getTime() || !Array.isArray(manifest.items) || !manifest.items.length || manifest.items.length > 12) throw new Error("清单身份、版本、工具或有效期不正确。");
    const directories = new Set<string>(); let total = 0;
    for (const item of manifest.items) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.name) || item.targetDirectory !== `${target.projectDirectory}/${item.name}` || directories.has(item.targetDirectory.toLowerCase()) || !/^[a-f0-9]{40}$/.test(item.commit) || !/^[\w.-]+\/[\w.-]+$/.test(item.repository) || !Array.isArray(item.files) || !item.files.length || item.files.length > 160 || !item.files.some((file: SkillFile) => file.relativePath === "SKILL.md") || !item.files.some((file: SkillFile) => file.relativePath === item.license.filePath && file.sha256 === item.license.sha256) || !["MIT", "Apache-2.0"].includes(item.license.spdx)) throw new Error("技能清单路径、固定来源或许可缺失。");
      directories.add(item.targetDirectory.toLowerCase()); const names = new Set<string>();
      for (const file of item.files) { safeRelative(file.relativePath); safeRelative(file.repositoryPath); const url = `https://raw.githubusercontent.com/${item.repository}/${item.commit}/${file.repositoryPath.split("/").map(encodeURIComponent).join("/")}`; if (file.downloadUrl !== url || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 2 * 1024 * 1024 || names.has(file.relativePath.toLowerCase())) throw new Error("文件来源、哈希或路径不正确。"); names.add(file.relativePath.toLowerCase()); total += file.bytes; }
    }
    if (total > 16 * 1024 * 1024) throw new Error("整包文件超过 16 MiB。");
  }
  async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
  async function writeNew(path: string, bytes: Uint8Array): Promise<void> { await checked(path); const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600); try { await file.writeFile(bytes); await file.sync(); } catch (error) { const original = await file.stat(); await file.close(); await checked(path); const latest = await lstat(path); if (latest.ino === original.ino && latest.dev === original.dev) await unlink(path); throw error; } finally { await file.close().catch(() => {}); } }
  function signedJournal(value: LocalJournal): string { return JSON.stringify({ ...value, mac: createHmac("sha256", journalKey).update(hash(value)).digest("hex") }); }
  async function readJournal(path: string): Promise<LocalJournal> { await checked(path); const stored = JSON.parse(await readFile(path, "utf8")) as LocalJournal & { mac: string }; const value = { receipt: stored.receipt, createdDirectories: stored.createdDirectories }; const mac = createHmac("sha256", journalKey).update(hash(value)).digest("hex"); if (typeof stored.mac !== "string" || stored.mac !== mac) throw new Error("本机回执被改动，拒绝按此回执删除文件。"); return value; }
  async function journal(value: LocalJournal): Promise<void> { const path = join(stateDirectory, `${value.receipt.id}.json`); await writeNew(path, Buffer.from(signedJournal(value))); }
  async function loadJournal(id: string): Promise<LocalJournal> { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("本机回执 ID 无效。"); return readJournal(join(stateDirectory, `${id}.json`)); }
  async function serial<T>(work: () => Promise<T>): Promise<T> { if (closed || busy) throw new Error("桥接正忙或已关闭，请稍后重试。"); busy = true; try { return await work(); } finally { busy = false; } }
  async function install(request: InstallRequest) {
    return serial(async () => {
      if (!request || typeof request.planId !== "string" || typeof request.manifestHash !== "string" || typeof request.bridgeToken !== "string") throw new Error("缺少精确安装授权。");
      const earlier = completed.get(request.planId); const earlierAuthorization = earlier && active.get(earlier.id);
      if (earlier && earlierAuthorization && earlier.manifestHash === request.manifestHash && earlierAuthorization.bridgeToken === request.bridgeToken) { let serverRecorded = true; try { await report(request, earlier); } catch { serverRecorded = false; } return { receipt: earlier, serverRecorded }; }
      const authorized = await authorize(request); const manifest = authorized.manifest; if (authorized.manifestHash !== request.manifestHash) throw new Error("授权清单哈希不一致。"); validate(manifest, request);
      for (const item of manifest.items) { const path = join(projectRoot, ...item.targetDirectory.split("/")); await checked(path); if (await exists(path)) throw new Error(`同名技能 ${item.name} 已存在；不覆盖任何已有文件。`); }
      const staged: { item: ManifestItem; file: SkillFile; bytes: Uint8Array }[] = [];
      for (const item of manifest.items) for (const file of item.files) { const bytes = await fetchBytes(file); if (bytes.byteLength !== file.bytes || sha(bytes) !== file.sha256) throw new Error(`文件 ${file.relativePath} 大小或 SHA256 不一致，未写入。`); staged.push({ item, file, bytes }); }
      // A withdrawal during download invalidates execution immediately before writes.
      const finalAuthorization = await authorize(request); if (finalAuthorization.manifestHash !== request.manifestHash || hash(finalAuthorization.manifest) !== request.manifestHash) throw new Error("清单在下载过程中已变化。"); validate(finalAuthorization.manifest, request);
      const createdDirectories: string[] = []; const written: { path: string; sha256: string; bytes: number }[] = [];
      const id = randomUUID();
      try {
        for (const item of manifest.items) {
          const target = join(projectRoot, ...item.targetDirectory.split("/")); await checked(target); if (await exists(target)) throw new Error(`技能 ${item.name} 在下载期间出现同名冲突。`);
          const parts = item.targetDirectory.split("/"); let path = projectRoot;
          for (const part of parts) { path = join(path, part); await checked(path); if (!await exists(path)) { await mkdir(path); createdDirectories.push(relative(projectRoot, path).split(sep).join("/")); } else if (path === target) throw new Error("目标技能目录已存在。"); }
        }
        for (const entry of staged) {
          const pathRelative = `${entry.item.targetDirectory}/${entry.file.relativePath}`; const path = join(projectRoot, ...pathRelative.split("/"));
          let parent = projectRoot; for (const part of relative(projectRoot, dirname(path)).split(sep)) { parent = join(parent, part); await checked(parent); if (!await exists(parent)) { await mkdir(parent); createdDirectories.push(relative(projectRoot, parent).split(sep).join("/")); } }
          await writeNew(path, entry.bytes); written.push({ path: pathRelative, sha256: entry.file.sha256, bytes: entry.file.bytes }); await options.onFileWritten?.(pathRelative);
        }
        for (const file of written) { const path = join(projectRoot, ...file.path.split("/")); await checked(path); if (sha(await readFile(path)) !== file.sha256) throw new Error("写入后文件核验失败。"); }
        const receipt: InstallationReceipt = { id, planId: manifest.planId, manifestHash: request.manifestHash, agentId: manifest.agentId, status: "installed", fileStatus: "written", loadStatus: "not_verified", taskStatus: "not_verified", evidenceSource: "local_bridge_reported", items: manifest.items.map(item => ({ skillVersionId: item.skillVersionId, files: item.files.map(file => ({ path: `${item.targetDirectory}/${file.relativePath}`, sha256: file.sha256, bytes: file.bytes })) })), createdAt: now().toISOString(), note: null };
        await journal({ receipt, createdDirectories }); active.set(id, request); completed.set(request.planId, receipt);
        let serverRecorded = true; try { await report(request, receipt); } catch { serverRecorded = false; }
        return { receipt, serverRecorded };
      } catch (error) {
        const retained: string[] = [];
        for (const file of [...written].reverse()) { const path = join(projectRoot, ...file.path.split("/")); try { await checked(path); if (sha(await readFile(path)) !== file.sha256) { retained.push(file.path); continue; } await unlink(path); } catch { retained.push(file.path); } }
        for (const directory of [...createdDirectories].reverse()) { try { const path = join(projectRoot, ...directory.split("/")); await checked(path); await rmdir(path); } catch { /* Never recursively remove user changes. */ } }
        if (retained.length) throw new Error(`安装未完成，用户已改动的文件保留：${retained.join("、")}。请人工核对。`);
        const receipt: InstallationReceipt = { id, planId: manifest.planId, manifestHash: request.manifestHash, agentId: manifest.agentId, status: "failed", fileStatus: "rolled_back", loadStatus: "not_verified", taskStatus: "not_verified", evidenceSource: "local_bridge_reported", items: [], createdAt: now().toISOString(), note: "文件写入失败，已按哈希回滚本次写入。" };
        await journal({ receipt, createdDirectories: [] }); active.set(id, request); completed.set(request.planId, receipt); let serverRecorded = true; try { await report(request, receipt); } catch { serverRecorded = false; }
        return { receipt, serverRecorded, error: error instanceof Error ? error.message : "安装失败并已回滚。" };
      }
    });
  }
  async function revoke(id: string) { return serial(async () => {
    const revocationPath = join(stateDirectory, `${id}.revoked.json`); await checked(revocationPath);
    if (await exists(revocationPath)) return { receipt: (await readJournal(revocationPath)).receipt, serverRecorded: false };
    const value = await loadJournal(id); const { receipt } = value; if (receipt.status !== "installed") throw new Error("仅能撤销本桥接记录的已安装文件。");
    const files = receipt.items.flatMap(item => item.files);
    for (const file of files) { safeRelative(file.path); const path = join(projectRoot, ...file.path.split("/")); await checked(path); if (!await exists(path) || sha(await readFile(path)) !== file.sha256) throw new Error(`文件 ${file.path} 已改变或缺失，未删除任何文件。`); }
    for (const file of files) { const path = join(projectRoot, ...file.path.split("/")); await checked(path); if (sha(await readFile(path)) !== file.sha256) throw new Error("撤销期间文件变化，已停止。已移除文件可根据回执核对。"); await unlink(path); }
    for (const directory of [...value.createdDirectories].reverse()) { try { const path = join(projectRoot, ...safeRelative(directory).split("/")); await checked(path); await rmdir(path); } catch { /* Keep nonempty and modified directories. */ } }
    const updated: InstallationReceipt = { ...receipt, status: "revoked", fileStatus: "removed", loadStatus: "not_verified", taskStatus: "not_verified", note: "仅移除了本次回执中的未改动文件。" };
    // Preserve the original immutable receipt and append an action journal.
    await writeNew(join(stateDirectory, `${id}.revoked.json`), Buffer.from(signedJournal({ receipt: updated, createdDirectories: [] })));
    completed.set(receipt.planId, updated);
    let serverRecorded = false; const request = active.get(id); if (request) { try { await report(request, updated); serverRecorded = true; } catch { /* Local result remains truthful. */ } }
    return { receipt: updated, serverRecorded };
  }); }
  async function verify(input: { receiptId: string; loadStatus: InstallationReceipt["loadStatus"]; taskStatus: InstallationReceipt["taskStatus"]; note: string }) { return serial(async () => {
    if (!["not_verified", "user_reported_loaded", "user_reported_failed"].includes(input.loadStatus) || !["not_verified", "user_reported_passed", "user_reported_failed"].includes(input.taskStatus) || typeof input.note !== "string" || input.note.length > 2000) throw new Error("只能记录明确的用户自报加载/任务结果。");
    if (await exists(join(stateDirectory, `${input.receiptId}.revoked.json`))) throw new Error("技能已撤销。");
    const value = await loadJournal(input.receiptId); if (value.receipt.status !== "installed") throw new Error("文件尚未安装。");
    const receipt = { ...value.receipt, loadStatus: input.loadStatus, taskStatus: input.taskStatus, note: input.note };
    completed.set(receipt.planId, receipt);
    let serverRecorded = false; const request = active.get(receipt.id); if (request) { try { await report(request, receipt); serverRecorded = true; } catch { /* Remains user-reported. */ } }
    await writeNew(join(stateDirectory, `${receipt.id}.verification-${randomUUID()}.json`), Buffer.from(signedJournal({ receipt, createdDirectories: value.createdDirectories })));
    return { receipt, serverRecorded };
  }); }
  let server: Server | null = null;
  async function listen(port = 0): Promise<{ url: string; pairToken: string; pairExpiresAt: string }> {
    if (server) throw new Error("桥接已启动。");
    server = createServer(async (request, response) => {
      const actualPort = (server!.address() as { port: number }).port;
      const headers = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Private-Network": "true", Vary: "Origin", "Cache-Control": "no-store", "Content-Type": "application/json" };
      function respond(code: number, data: unknown) { response.writeHead(code, headers); response.end(JSON.stringify(data)); }
      try {
        if (request.socket.remoteAddress !== "127.0.0.1" || request.headers.host !== `127.0.0.1:${actualPort}` || request.headers.origin !== origin) return respond(403, { error: "来源、Host 或连接不在授权范围。" });
        if (request.method === "OPTIONS") return respond(204, null);
        const supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? ""; const a = Buffer.from(supplied); const b = Buffer.from(pairToken);
        if (now().getTime() >= pairExpiresAt || a.length !== b.length || !timingSafeEqual(a, b)) return respond(403, { error: "配对令牌无效或已过期。" });
        if (request.method === "GET" && request.url === "/status") return respond(200, { paired: true, scope: "project", expiresAt: new Date(pairExpiresAt).toISOString(), busy });
        if (request.method !== "POST" || !["/install", "/revoke", "/verify"].includes(request.url ?? "")) return respond(405, { error: "仅支持受控安装、撤销与自报验证。" });
        if (request.headers["content-type"]?.split(";", 1)[0] !== "application/json") return respond(415, { error: "需 JSON 请求。" });
        const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > 16 * 1024) { respond(413, { error: "请求过大。" }); request.destroy(); return; } chunks.push(chunk); }
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = request.url === "/install" ? await install(input) : request.url === "/revoke" ? await revoke(input.receiptId) : await verify(input);
        respond(200, result);
      } catch (error) { respond(422, { error: error instanceof Error ? error.message : "本机操作未完成。" }); }
    });
    server.requestTimeout = 10_000; server.headersTimeout = 10_000;
    await new Promise<void>((resolveListen, reject) => { server!.once("error", reject); server!.listen(port, "127.0.0.1", resolveListen); });
    return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, pairToken, pairExpiresAt: new Date(pairExpiresAt).toISOString() };
  }
  async function close() { closed = true; while (busy) await new Promise(done => setTimeout(done, 25)); if (server) await new Promise<void>((done, reject) => server!.close(error => error ? reject(error) : done())); await checked(lockPath); await unlink(lockPath); }
  return { install, revoke, verify, listen, close };
}
