import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { protectPrivateDirectory } from "../shared/private-directory.ts";

const run = promisify(execFile);
const MAX_BYTES = 4096;
const WINDOW_MS = 60_000;
const normalized = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
const refused = () => new Error("GRACEFUL_STOP_REJECTED");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const token = /^[A-Za-z0-9_-]{43}$/;

export interface ServerStopReceipt {
  version: 1; workspace: string; pid: number; startId: string; startedAt: number;
}
interface StopRequest extends ServerStopReceipt {
  action: "shutdown"; nonce: string; issuedAt: number; expiresAt: number;
}
interface StopAck extends ServerStopReceipt {
  nonce: string; status: "completed" | "failed"; completedAt: number;
}
type Signed<T> = T & { signature: string };
type PollResult = "idle" | "rejected" | "closed" | "failed";
interface Boundary { workspace: string; root: string; instance?: string; signal?: AbortSignal }

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)));
}
function identity(value: unknown): value is ServerStopReceipt {
  const item = value as ServerStopReceipt;
  return Boolean(item && item.version === 1 && typeof item.workspace === "string" && isAbsolute(item.workspace)
    && Number.isSafeInteger(item.pid) && item.pid > 0 && uuid.test(item.startId)
    && Number.isSafeInteger(item.startedAt) && item.startedAt > 0);
}
const receiptKeys = ["version", "workspace", "pid", "startId", "startedAt", "signature"];
const requestKeys = [...receiptKeys, "action", "nonce", "issuedAt", "expiresAt"];
const ackKeys = [...receiptKeys, "nonce", "status", "completedAt"];
function payload(kind: "receipt" | "request" | "ack", value: ServerStopReceipt | StopRequest | StopAck): string {
  const fields: unknown[] = ["hackathon-server-control", kind, value.version, value.workspace, value.pid, value.startId, value.startedAt];
  if (kind === "request") { const r = value as StopRequest; fields.push(r.action, r.nonce, r.issuedAt, r.expiresAt); }
  if (kind === "ack") { const a = value as StopAck; fields.push(a.nonce, a.status, a.completedAt); }
  return JSON.stringify(fields);
}
function signed<T extends ServerStopReceipt>(kind: "receipt" | "request" | "ack", value: T, key: Buffer): Signed<T> {
  return { ...value, signature: createHmac("sha256", key).update(payload(kind, value)).digest("base64url") };
}
function authentic(kind: "receipt" | "request" | "ack", value: Signed<ServerStopReceipt>, key: Buffer): boolean {
  if (!token.test(value.signature)) return false;
  const expected = Buffer.from(signed(kind, value, key).signature, "base64url"), actual = Buffer.from(value.signature, "base64url");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function sameInstance(a: ServerStopReceipt, b: ServerStopReceipt): boolean {
  return a.version === b.version && normalized(a.workspace) === normalized(b.workspace)
    && a.pid === b.pid && a.startId === b.startId && a.startedAt === b.startedAt;
}
function trustedRequest(raw: unknown, receipt: ServerStopReceipt, key: Buffer, stamp: number): raw is Signed<StopRequest> {
  const request = raw as Signed<StopRequest>;
  return exactObject(raw, requestKeys) && identity(raw) && sameInstance(receipt, request)
    && request.action === "shutdown" && token.test(request.nonce)
    && Number.isSafeInteger(request.issuedAt) && Number.isSafeInteger(request.expiresAt)
    && request.expiresAt > request.issuedAt && request.expiresAt - request.issuedAt <= WINDOW_MS
    && request.issuedAt <= stamp + 5000 && authentic("request", request, key);
}

/** All names are fixed or generated UUIDs; no request field can choose a filesystem path. */
async function safePaths(paths: readonly string[], privatePaths: readonly string[] = [], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  for (const path of paths) {
    signal?.throwIfAborted();
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || normalized(await realpath(path)) !== normalized(resolve(path))) throw refused();
    if (privatePaths.includes(path) && process.platform !== "win32"
      && ((metadata.mode & 0o077) !== 0 || typeof process.getuid === "function" && metadata.uid !== process.getuid())) throw refused();
  }
  if (process.platform !== "win32") return;
  if (!process.env.SystemRoot || !isAbsolute(process.env.SystemRoot)) throw refused();
  const code = "$ErrorActionPreference='Stop'; try { $owner=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; foreach($p in (ConvertFrom-Json $env:STOP_CHECK_PATHS)) { $item=Get-Item -LiteralPath $p -Force; if(($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'path' } }; foreach($p in (ConvertFrom-Json $env:STOP_PRIVATE_PATHS)) { $acl=Get-Acl -LiteralPath $p; $rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])); if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $owner.Value -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $owner.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl') { throw 'privacy' } }; [Console]::Write('clear') } catch { exit 1 }";
  const { stdout } = await run(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")],
    { windowsHide: true, shell: false, timeout: 8000, maxBuffer: 1024, signal,
      env: { NODE_ENV: "production", SystemRoot: process.env.SystemRoot, STOP_CHECK_PATHS: JSON.stringify(paths), STOP_PRIVATE_PATHS: JSON.stringify(privatePaths) } });
  if (stdout !== "clear") throw refused();
  signal?.throwIfAborted();
}
async function boundary(workspace: string, create: boolean): Promise<Boundary> {
  const rootWorkspace = resolve(workspace);
  // Refuse an aliased workspace, including a junction in any ancestor.
  const ancestors: string[] = []; let cursor = rootWorkspace;
  while (true) { ancestors.unshift(cursor); const parent = dirname(cursor); if (parent === cursor) break; cursor = parent; }
  await safePaths(ancestors);
  const runtime = join(rootWorkspace, ".runtime"), root = join(runtime, "server-control");
  if (create) { try { await mkdir(runtime, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
  await safePaths([...ancestors, runtime]);
  if (create) {
    let fresh = false;
    try { await mkdir(root, { mode: 0o700 }); fresh = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (fresh) await protectPrivateDirectory(root);
  }
  await safePaths([...ancestors, runtime, root], [root]);
  return { workspace: rootWorkspace, root };
}
async function checkFile(base: Boundary, path: string): Promise<void> {
  const allowed = base.instance ?? base.root;
  if (normalized(dirname(path)) !== normalized(allowed)) throw refused();
  const ancestors = [base.workspace, join(base.workspace, ".runtime"), base.root, ...(base.instance ? [base.instance] : [])];
  await safePaths([...ancestors, path], [base.root, ...(base.instance ? [base.instance] : []), path], base.signal);
  if (!(await lstat(path)).isFile()) throw refused();
}
async function readSmall(base: Boundary, path: string): Promise<Buffer> {
  await checkFile(base, path);
  const file = await open(path, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > MAX_BYTES) throw refused();
    const bytes = Buffer.alloc(MAX_BYTES + 1), result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > MAX_BYTES) throw refused();
    await checkFile(base, path);
    const after = await lstat(path);
    if (metadata.dev !== after.dev || metadata.ino !== after.ino) throw refused();
    return bytes.subarray(0, result.bytesRead);
  } finally { await file.close(); }
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function publish(base: Boundary, name: string, value: unknown, replace = false): Promise<void> {
  const directory = base.instance ?? base.root, target = join(directory, name);
  if (await exists(target)) { await checkFile(base, target); if (!replace) throw refused(); }
  await safePaths([base.root, ...(base.instance ? [base.instance] : [])], [base.root, ...(base.instance ? [base.instance] : [])]);
  const temporary = join(directory, `.publish-${randomUUID()}.tmp`), content = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(content) > MAX_BYTES) throw refused();
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(content, "utf8"); await file.sync(); } finally { await file.close(); }
  try {
    await checkFile(base, temporary);
    // A hard-link publishes a complete file atomically without replacing another CLI's request.
    if (replace) await rename(temporary, target); else await link(temporary, target);
  } finally { if (await exists(temporary)) await unlink(temporary); }
}
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
async function readCurrent(base: Boundary): Promise<{ receipt: Signed<ServerStopReceipt>; instance: Boundary; key: Buffer }> {
  const raw: unknown = JSON.parse((await readSmall(base, join(base.root, "current.json"))).toString("utf8"));
  if (!exactObject(raw, receiptKeys) || !identity(raw) || normalized(raw.workspace) !== normalized(base.workspace)) throw refused();
  const instance: Boundary = { ...base, instance: join(base.root, raw.startId) };
  await safePaths([instance.instance!], [instance.instance!], base.signal);
  const stored = (await readSmall(instance, join(instance.instance!, "control.key"))).toString("utf8").trim();
  if (!token.test(stored)) throw refused();
  const key = Buffer.from(stored, "base64url");
  const receipt = raw as unknown as Signed<ServerStopReceipt>;
  if (key.length !== 32 || !authentic("receipt", receipt, key)) throw refused();
  const own: unknown = JSON.parse((await readSmall(instance, join(instance.instance!, "server.json"))).toString("utf8"));
  if (!exactObject(own, receiptKeys) || !identity(own) || !sameInstance(receipt, own)
    || !authentic("receipt", own as unknown as Signed<ServerStopReceipt>, key)) throw refused();
  return { receipt, instance, key };
}

export interface GracefulStopOptions {
  workspace: string;
  /** Must synchronously block new work, then await all in-flight HTTP/workers and database.close(). */
  shutdown(): Promise<void>;
  exit?: (code: number) => void;
  clock?: () => number;
  pollIntervalMs?: number;
  automaticPolling?: boolean;
  isProcessAlive?: (pid: number) => boolean;
}
export interface GracefulStopControl {
  receipt: Readonly<ServerStopReceipt>;
  poll(): Promise<PollResult>;
  /** Do not call from shutdown(): disposal waits for an in-progress stop callback. */
  dispose(): Promise<void>;
}

/** No network listener, SQL, model, email, signal-based kill, or public issuer. */
export async function installGracefulStop(options: GracefulStopOptions): Promise<GracefulStopControl> {
  const now = options.clock ?? Date.now, exit = options.exit ?? (code => process.exit(code));
  const alive = options.isProcessAlive ?? processAlive, interval = options.pollIntervalMs ?? 250;
  if (!Number.isInteger(interval) || interval < 25 || interval > 2000) throw refused();
  const base = await boundary(options.workspace, true), lock = join(base.root, "install.lock");
  // A crash during installation leaves a lock for explicit operator diagnosis; never steal it.
  const lockFile = await open(lock, "wx", 0o600);
  try {
    await lockFile.writeFile(JSON.stringify({ pid: process.pid, installingAt: now() }) + "\n", "utf8"); await lockFile.sync();
    if (await exists(join(base.root, "current.json"))) {
      const previous = await readCurrent(base);
      if (alive(previous.receipt.pid)) throw refused();
      previous.key.fill(0);
    }
    const receipt: ServerStopReceipt = { version: 1, workspace: base.workspace, pid: process.pid, startId: randomUUID(), startedAt: now() };
    if (!identity(receipt)) throw refused();
    const key = randomBytes(32), instance: Boundary = { ...base, instance: join(base.root, receipt.startId) };
    await mkdir(instance.instance!, { mode: 0o700 }); await protectPrivateDirectory(instance.instance!);
    await safePaths([base.root, instance.instance!], [base.root, instance.instance!]);
    const keyFile = await open(join(instance.instance!, "control.key"), "wx", 0o600);
    try { await keyFile.writeFile(key.toString("base64url") + "\n", "utf8"); await keyFile.sync(); } finally { await keyFile.close(); }
    await publish(instance, "server.json", signed("receipt", receipt, key));
    await publish(base, "current.json", signed("receipt", receipt, key), true);
    let status: PollResult = "idle", consumed = false, disposed = false, pending: Promise<PollResult> | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    async function check(): Promise<PollResult> {
      if (consumed || disposed) return status;
      const requestPath = join(instance.instance!, "request.json");
      if (!await exists(requestPath)) return "idle";
      let raw: unknown;
      try { raw = JSON.parse((await readSmall(instance, requestPath)).toString("utf8")); } catch { return "rejected"; }
      const stamp = now();
      if (!trustedRequest(raw, receipt, key, stamp) || stamp > raw.expiresAt || stamp - raw.issuedAt > WINDOW_MS) return "rejected";
      const request = raw;
      // Consume before any await: neither replay nor overlapping polls can close twice.
      consumed = true; if (timer) clearInterval(timer);
      let success = false;
      try { await options.shutdown(); success = true; } catch { /* Preserve failure without secrets. */ }
      const ack: StopAck = { ...receipt, nonce: request.nonce, status: success ? "completed" : "failed", completedAt: now() };
      try { await publish(instance, "ack.json", signed("ack", ack, key)); }
      catch { status = "failed"; return status; }
      status = success ? "closed" : "failed";
      if (success) exit(0);
      return status;
    }
    const control: GracefulStopControl = {
      receipt,
      poll() {
        if (!pending) pending = check().catch(() => "rejected" as const).finally(() => { pending = null; });
        return pending;
      },
      async dispose() { disposed = true; if (timer) clearInterval(timer); await pending; key.fill(0); },
    };
    if (options.automaticPolling !== false) { timer = setInterval(() => { void control.poll(); }, interval); timer.unref(); }
    return control;
  } finally {
    await lockFile.close(); await checkFile(base, lock); await unlink(lock);
  }
}

/** Observes one signed request; confirms its ACK, original PID exit, and unchanged boot receipt. */
export async function requestGracefulStop(options: {
  workspace: string; timeoutMs?: number; clock?: () => number; isProcessAlive?: (pid: number) => boolean;
}): Promise<{ pid: number; startId: string; completedAt: number }> {
  const timeout = options.timeoutMs ?? WINDOW_MS, now = options.clock ?? Date.now, alive = options.isProcessAlive ?? processAlive;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > WINDOW_MS) throw refused();
  const base = await boundary(options.workspace, false), { receipt, instance, key } = await readCurrent(base);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const requestPath = join(instance.instance!, "request.json");
    const existing = async (): Promise<Signed<StopRequest>> => {
      const raw: unknown = JSON.parse((await readSmall(instance, requestPath)).toString("utf8"));
      // A retry observes the original operation, even after its issue window; it never reissues it.
      if (!trustedRequest(raw, receipt, key, now())) throw refused();
      return raw;
    };
    let request: StopRequest;
    if (await exists(requestPath)) request = await existing();
    else {
      if (!alive(receipt.pid)) throw refused();
      const stamp = now();
      request = { ...receipt, action: "shutdown", nonce: randomBytes(32).toString("base64url"), issuedAt: stamp, expiresAt: stamp + WINDOW_MS };
      try { await publish(instance, "request.json", signed("request", request, key)); }
      catch { if (!await exists(requestPath)) throw refused(); request = await existing(); }
    }
    const deadline = performance.now() + timeout;
    timer = setTimeout(() => controller.abort(new Error("GRACEFUL_STOP_UNCONFIRMED")), timeout);
    const observedBase = { ...base, signal: controller.signal }, observedInstance = { ...instance, signal: controller.signal };
    while (performance.now() < deadline) {
      controller.signal.throwIfAborted();
      const ackPath = join(instance.instance!, "ack.json");
      if (await exists(ackPath)) {
        const raw: unknown = JSON.parse((await readSmall(observedInstance, ackPath)).toString("utf8"));
        const ack = raw as Signed<StopAck>;
        if (!exactObject(raw, ackKeys) || !identity(raw) || !sameInstance(receipt, ack) || ack.nonce !== request.nonce
          || !["completed", "failed"].includes(ack.status) || !Number.isSafeInteger(ack.completedAt) || ack.completedAt < request.issuedAt - 5000
          || !authentic("ack", ack, key)) throw refused();
        if (ack.status !== "completed") throw new Error("GRACEFUL_STOP_CLOSE_FAILED");
        if (!alive(receipt.pid)) {
          const current: unknown = JSON.parse((await readSmall(observedBase, join(base.root, "current.json"))).toString("utf8"));
          if (!exactObject(current, receiptKeys) || !identity(current) || !sameInstance(receipt, current)
            || !authentic("receipt", current as unknown as Signed<ServerStopReceipt>, key)) throw new Error("GRACEFUL_STOP_UNCONFIRMED");
          controller.signal.throwIfAborted();
          if (performance.now() >= deadline || alive(receipt.pid)) throw new Error("GRACEFUL_STOP_UNCONFIRMED");
          return { pid: receipt.pid, startId: receipt.startId, completedAt: ack.completedAt };
        }
      }
      await delay(Math.min(100, Math.max(1, deadline - performance.now())), undefined, { signal: controller.signal });
    }
    throw new Error("GRACEFUL_STOP_UNCONFIRMED");
  } catch (error) {
    if (controller.signal.aborted) throw new Error("GRACEFUL_STOP_UNCONFIRMED");
    throw error;
  } finally { if (timer) clearTimeout(timer); key.fill(0); }
}
