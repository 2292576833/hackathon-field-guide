import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installGracefulStop, requestGracefulStop, type GracefulStopControl } from "./graceful-stop.ts";

const initialTime = Date.parse("2026-10-11T08:00:00.000Z");
async function fixture(shutdown?: () => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "graceful-stop-fixture-"));
  let time = initialTime, alive = true, calls = 0, exits = 0;
  const control = await installGracefulStop({ workspace, automaticPolling: false, clock: () => time,
    shutdown: async () => { calls++; await shutdown?.(); }, exit: code => { assert.equal(code, 0); exits++; alive = false; }, isProcessAlive: () => alive });
  const directory = join(workspace, ".runtime", "server-control", control.receipt.startId);
  const key = Buffer.from((await readFile(join(directory, "control.key"), "utf8")).trim(), "base64url");
  function request(changes: Record<string, unknown> = {}, useKey = key) {
    const value = { ...control.receipt, action: "shutdown", nonce: randomBytes(32).toString("base64url"), issuedAt: time, expiresAt: time + 60_000, ...changes };
    const payload = JSON.stringify(["hackathon-server-control", "request", value.version, value.workspace, value.pid, value.startId, value.startedAt, value.action, value.nonce, value.issuedAt, value.expiresAt]);
    return { ...value, signature: createHmac("sha256", useKey).update(payload).digest("base64url") };
  }
  return { workspace, control, directory, request, key, clock: () => time, isProcessAlive: () => alive,
    get calls() { return calls; }, get exits() { return exits; },
    advance(ms: number) { time += ms; },
    async write(value: unknown) { await writeFile(join(directory, "request.json"), JSON.stringify(value), { mode: 0o600 }); },
    async cleanup() { await control.dispose(); key.fill(0); assert.equal(dirname(workspace), tmpdir()); await rm(workspace, { recursive: true, force: true }); },
  };
}
/**
 * 等待发布出的文件出现。
 *
 * 注意：`requestGracefulStop` 在写出 request.json **之前**要串行拉起约 10 个
 * powershell.exe（边界校验与多次 readSmall），实测空闲约 3.3s，并发负载下可达 16–18s。
 * 因此这里必须用**真实截止时间**而不是固定次数，否则同一套件并发时会因为
 * "还没写出来"而误判失败（曾经就是 300×10ms＝3s 的固定预算）。
 */
const waitForFile = async (path: string, budgetMs = 90_000) => {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try { await lstat(path); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (Date.now() >= deadline) throw new Error("fixture file unavailable");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

test("authenticated control waits for request draining and database close before ACK and exit, then cannot replay", async () => {
  const order: string[] = []; let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async () => { order.push("reject-new-requests"); await barrier; order.push("drained-workers-and-http"); order.push("database-close"); });
  try {
    await f.write(f.request());
    const first = f.control.poll(), second = f.control.poll();
    assert.equal(first, second);
    for (let i = 0; i < 300 && f.calls === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.calls, 1); assert.deepEqual(order, ["reject-new-requests"]);
    await assert.rejects(lstat(join(f.directory, "ack.json")), { code: "ENOENT" });
    assert.equal(f.exits, 0);
    release(); assert.equal(await first, "closed");
    assert.deepEqual(order, ["reject-new-requests", "drained-workers-and-http", "database-close"]);
    const ack = JSON.parse(await readFile(join(f.directory, "ack.json"), "utf8"));
    assert.equal(ack.status, "completed"); assert.equal(ack.pid, process.pid); assert.equal(ack.startId, f.control.receipt.startId);
    assert.equal(f.exits, 1); assert.equal(await f.control.poll(), "closed"); assert.equal(f.calls, 1);
  } finally { release(); await f.cleanup(); }
});

test("wrong signature, expired or future request, wrong boot identity, extra fields and oversized input cannot trigger shutdown", async () => {
  const f = await fixture();
  try {
    const malformed = [
      f.request({}, randomBytes(32)), f.request({ issuedAt: initialTime - 60_001, expiresAt: initialTime - 1 }),
      f.request({ issuedAt: initialTime + 5001, expiresAt: initialTime + 65_001 }),
      f.request({ expiresAt: initialTime + 60_001 }), f.request({ action: "reset" }),
      f.request({ pid: process.pid + 1 }), f.request({ startId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }),
      f.request({ workspace: dirname(f.workspace) }), f.request({ startedAt: initialTime - 1 }),
      f.request({ extra: "ignored-field-not-allowed" }), f.request({ issuedAt: 1.5 }),
      { content: "x".repeat(4097) },
    ];
    for (const value of malformed) { await f.write(value); assert.equal(await f.control.poll(), "rejected"); }
    assert.equal(f.calls, 0); assert.equal(f.exits, 0);
    await assert.rejects(lstat(join(f.directory, "ack.json")), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

test("shutdown failure produces signed failed ACK without exit or a repeated close", async () => {
  const f = await fixture(async () => { throw new Error("fixture-private-failure-do-not-serialize"); });
  try {
    await f.write(f.request()); assert.equal(await f.control.poll(), "failed");
    const text = await readFile(join(f.directory, "ack.json"), "utf8");
    assert.equal(JSON.parse(text).status, "failed"); assert.equal(text.includes("fixture-private-failure"), false);
    assert.equal(f.exits, 0); assert.equal(await f.control.poll(), "failed"); assert.equal(f.calls, 1);
  } finally { await f.cleanup(); }
});

test("CLI only confirms signed completed ACK after original PID exit and sends no signal", async () => {
  const f = await fixture();
  try {
    const stopped = requestGracefulStop({ workspace: f.workspace, timeoutMs: 10_000, clock: f.clock, isProcessAlive: f.isProcessAlive });
    // 先挂一个空 handler：`stopped` 在 waitForFile 期间就可能 reject，
    // 若等到下面才 await，测试提前结束时它会变成"测试结束后仍有异步活动"的误导报错。
    stopped.catch(() => {});
    await waitForFile(join(f.directory, "request.json")); assert.equal(await f.control.poll(), "closed");
    assert.deepEqual(await stopped, { pid: process.pid, startId: f.control.receipt.startId, completedAt: initialTime });
    assert.equal(f.calls, 1); assert.equal(f.exits, 1);
  } finally { await f.cleanup(); }
});

test("CLI timeout and competing CLI cannot report success or overwrite the first request", async () => {
  const f = await fixture();
  try {
    const first = requestGracefulStop({ workspace: f.workspace, timeoutMs: 100, clock: f.clock, isProcessAlive: f.isProcessAlive });
    const rejection = assert.rejects(first, /GRACEFUL_STOP_UNCONFIRMED/);
    // 同上：assert.rejects 包出来的 Promise 也要先挂 handler，避免游离 rejection。
    rejection.catch(() => {});
    await waitForFile(join(f.directory, "request.json"));
    const original = await readFile(join(f.directory, "request.json"), "utf8");
    await assert.rejects(requestGracefulStop({ workspace: f.workspace, timeoutMs: 100, clock: f.clock, isProcessAlive: f.isProcessAlive }));
    await rejection;
    assert.equal(await readFile(join(f.directory, "request.json"), "utf8"), original);
    assert.equal(f.calls, 0); assert.equal(f.exits, 0);
  } finally { await f.cleanup(); }
});

test("a timed-out CLI observes the original signed request and ACK without a second shutdown", async () => {
  const f = await fixture();
  try {
    await assert.rejects(requestGracefulStop({ workspace: f.workspace, timeoutMs: 100, clock: f.clock, isProcessAlive: f.isProcessAlive }), /GRACEFUL_STOP_UNCONFIRMED/);
    const original = await readFile(join(f.directory, "request.json"), "utf8");
    f.advance(60_001);
    // An already accepted operation may finish after the first observer's deadline.
    f.advance(-60_001); assert.equal(await f.control.poll(), "closed"); f.advance(60_001);
    const result = await requestGracefulStop({ workspace: f.workspace, timeoutMs: 10_000, clock: f.clock, isProcessAlive: f.isProcessAlive });
    assert.equal(result.startId, f.control.receipt.startId); assert.equal(f.calls, 1);
    assert.equal(await readFile(join(f.directory, "request.json"), "utf8"), original);
  } finally { await f.cleanup(); }
});

test("an old successful ACK cannot confirm shutdown after current points to a different boot", async () => {
  let newer: GracefulStopControl | undefined;
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(async () => {
    // Independent liveness injection models a replacement boot appearing before observer confirmation.
    newer = await installGracefulStop({ workspace: f.workspace, shutdown: async () => {}, automaticPolling: false,
      isProcessAlive: () => false, exit: () => {} });
  });
  try {
    const stopped = requestGracefulStop({ workspace: f.workspace, timeoutMs: 20_000, clock: f.clock, isProcessAlive: f.isProcessAlive });
    const rejected = assert.rejects(stopped, /GRACEFUL_STOP_UNCONFIRMED/);
    await waitForFile(join(f.directory, "request.json")); assert.equal(await f.control.poll(), "closed");
    await rejected;
    assert.notEqual(newer?.receipt.startId, f.control.receipt.startId);
    assert.equal(JSON.parse(await readFile(join(f.directory, "ack.json"), "utf8")).status, "completed");
  } finally { await newer?.dispose(); await f.cleanup(); }
});

test("even authentic completed ACK does not confirm cold backup while its PID is still alive", async () => {
  const f = await fixture();
  try {
    const stopped = requestGracefulStop({ workspace: f.workspace, timeoutMs: 2500, clock: f.clock, isProcessAlive: () => true });
    const rejected = assert.rejects(stopped, /GRACEFUL_STOP_UNCONFIRMED/);
    await waitForFile(join(f.directory, "request.json")); assert.equal(await f.control.poll(), "closed");
    await rejected;
    assert.equal(JSON.parse(await readFile(join(f.directory, "ack.json"), "utf8")).status, "completed");
  } finally { await f.cleanup(); }
});

test("forged ACK and a close failure never authorize the CLI to confirm a cold backup", async () => {
  for (const failure of [false, true]) {
    const f = await fixture(failure ? async () => { throw new Error("fixture close failure"); } : undefined);
    try {
      const stopped = requestGracefulStop({ workspace: f.workspace, timeoutMs: 10_000, clock: f.clock, isProcessAlive: f.isProcessAlive });
      const rejected = assert.rejects(stopped);
      await waitForFile(join(f.directory, "request.json"));
      if (failure) assert.equal(await f.control.poll(), "failed");
      else await writeFile(join(f.directory, "ack.json"), JSON.stringify({ ...f.control.receipt, nonce: "x".repeat(43), status: "completed", completedAt: initialTime, signature: "x".repeat(43) }), { mode: 0o600 });
      await rejected; assert.equal(f.exits, 0);
      if (failure) await assert.rejects(requestGracefulStop({ workspace: f.workspace, timeoutMs: 10_000, clock: f.clock, isProcessAlive: f.isProcessAlive }), /GRACEFUL_STOP_CLOSE_FAILED/);
    } finally { await f.cleanup(); }
  }
});

test("server refuses a linked request and ACK publication failure cannot exit as successful", async () => {
  const f = await fixture();
  try {
    const outside = join(f.workspace, "outside.json"); await writeFile(outside, JSON.stringify(f.request()));
    // Windows file symlinks may require privileges; a junction still verifies the reparse boundary.
    const requestPath = join(f.directory, "request.json");
    if (process.platform === "win32") await symlink(f.workspace, requestPath, "junction"); else await symlink(outside, requestPath, "file");
    assert.equal(await f.control.poll(), "rejected"); assert.equal(f.calls, 0);
    await unlink(requestPath); await f.write(f.request());
    await mkdir(join(f.directory, "ack.json"));
    assert.equal(await f.control.poll(), "failed"); assert.equal(f.calls, 1); assert.equal(f.exits, 0);
  } finally { await f.cleanup(); }
});

test("a junction or workspace alias is rejected and installing over a live receipt is refused", async () => {
  const f = await fixture();
  const aliasRoot = await mkdtemp(join(tmpdir(), "graceful-stop-alias-"));
  try {
    const alias = join(aliasRoot, "workspace"); await symlink(f.workspace, alias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(requestGracefulStop({ workspace: alias, timeoutMs: 10 }));
    await assert.rejects(installGracefulStop({ workspace: f.workspace, shutdown: async () => {}, automaticPolling: false, isProcessAlive: () => true }));
    assert.equal(f.calls, 0);
  } finally { await f.cleanup(); assert.equal(dirname(aliasRoot), tmpdir()); await rm(aliasRoot, { recursive: true, force: true }); }
});

test("a new boot rotates its receipt and secret so the old signed request cannot stop it", async () => {
  const f = await fixture(); let newer: GracefulStopControl | undefined;
  try {
    const old = f.request(); await f.control.dispose();
    let calls = 0;
    newer = await installGracefulStop({ workspace: f.workspace, shutdown: async () => { calls++; }, automaticPolling: false, isProcessAlive: () => false, exit: () => {} });
    assert.notEqual(newer.receipt.startId, f.control.receipt.startId);
    const current = join(f.workspace, ".runtime", "server-control", newer.receipt.startId);
    await writeFile(join(current, "request.json"), JSON.stringify(old), { mode: 0o600 });
    assert.equal(await newer.poll(), "rejected"); assert.equal(calls, 0);
    assert.notEqual((await readFile(join(current, "control.key"), "utf8")).trim(), f.key.toString("base64url"));
  } finally { await newer?.dispose(); await f.cleanup(); }
});
