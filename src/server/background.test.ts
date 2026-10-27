import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase } from "./database.ts";
import { readBackgroundStatus, startBackgroundWorkers } from "./background.ts";
import { createDshBackend } from "./dsh-backend.ts";
import { createDiscoveryService } from "./discovery.ts";
import { PostgreSqlOperationsExecutionRepository, SourceService, RunService, WorkerRunService, SOURCE_CRAWL_ADAPTER_VERSION, type SourceDraft } from "../modules/operations/index.ts";
import type { ApplicationConfig } from "./config.ts";

async function databaseFixture() { const database = await createDatabase({}); await database.migrate(); return database; }
async function eventually(predicate: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(10); }
  assert.fail(message);
}
async function boundedStop(workers: ReturnType<typeof startBackgroundWorkers>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([workers.stop(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("background stop exceeded the test deadline")), 1000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
const configuration: ApplicationConfig = { mode: "local", origin: "http://localhost:3000", codePepper: "fixture-only-pepper-at-least-32-bytes", emailFrom: "fixture@localhost.invalid" };
function appFixture(database: Awaited<ReturnType<typeof databaseFixture>>, input: {
  ai?: () => Promise<unknown>; source?: (signal: AbortSignal) => Promise<unknown>;
  discovery?: (signal: AbortSignal) => Promise<unknown>; recover?: () => Promise<unknown>; inspiration?: (signal: AbortSignal) => Promise<unknown>;
}) {
  // Public loop-port fixtures only. Real persistence and heartbeat SQL are used;
  // no live model/search/provider config is loaded by these tests.
  return { database, config: { ...configuration, ai: { workerPollMs: 60_000 } },
    aiWorker: input.ai ? { runOnce: input.ai } : null,
    inspirationWorker: input.inspiration ? { runOnce: ({ signal }: { signal: AbortSignal }) => input.inspiration!(signal) } : null,
    dshBackend: { sourceQueue: input.source ? { runOnce: ({ signal }: { signal: AbortSignal }) => input.source!(signal) } : null,
      discoveryWorker: input.discovery ? { runOnce: ({ signal }: { signal: AbortSignal }) => input.discovery!(signal) } : null,
      recoverSources: input.recover ?? (async () => []),
    },
  } as unknown as Parameters<typeof startBackgroundWorkers>[0];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

test("inspiration starts independently and a skipped website check does not claim an analysis completion", async () => {
  const database = await databaseFixture(); let calls=0;
  const workers = startBackgroundWorkers(appFixture(database,{inspiration: async () => { calls++; return {status:"skipped",reason:"no_due",searched:0,fetched:0,saved:0,unchanged:0,rejected:0,errors:[]}; }}));
  try {
    await eventually(async () => (await readBackgroundStatus(database)).some(row => row.kind === "inspiration" && row.status === "idle"),"inspiration did not start without a browser request");
    const row=(await readBackgroundStatus(database)).find(row=>row.kind==="inspiration")!;
    assert.equal(calls,1); assert.equal(row.lastCompletedAt,null);
    await boundedStop(workers);
    assert.equal((await readBackgroundStatus(database)).find(row=>row.kind==="inspiration")!.status,"stopped");
  } finally {await workers.stop(); await database.close();}
});
type HeartbeatWrite = { kind: string; status: string; completed: boolean; errorCode: string | null };
function heartbeatFixture(beforeWrite: (write: HeartbeatWrite) => Promise<void> = async () => {}) {
  const writes: HeartbeatWrite[] = [];
  const database = { async query(_statement: string, parameters: readonly unknown[]) {
    const write = { kind: String(parameters[1]), status: String(parameters[2]), completed: Boolean(parameters[3]), errorCode: parameters[4] as string | null };
    await beforeWrite(write); writes.push(write);
    return { rows: [], rowCount: 1 };
  } } as unknown as Awaited<ReturnType<typeof databaseFixture>>;
  return { database, writes };
}
const flushTasks = () => new Promise<void>(resolve => setImmediate(resolve));

test("discovery checks again after ten seconds, remains serial during slow work, and does not mark a skipped ledger check completed", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { database, writes } = heartbeatFixture();
  const first = deferred<{ status: string; reason: string }>(); let calls = 0;
  const workers = startBackgroundWorkers(appFixture(database, { discovery: async () => {
    calls++; return calls === 1 ? first.promise : { status: "skipped", reason: "not_due" };
  } }));
  try {
    await flushTasks(); assert.equal(calls, 1);
    t.mock.timers.tick(30_000); await flushTasks();
    assert.equal(calls, 1, "scheduler time cannot overlap an in-flight search cycle");
    first.resolve({ status: "skipped", reason: "not_due" }); await flushTasks();
    t.mock.timers.tick(9999); await flushTasks(); assert.equal(calls, 1);
    t.mock.timers.tick(1); await flushTasks(); assert.equal(calls, 2, "the next ledger check starts at the ten-second boundary");
    assert.ok(writes.some(write => write.kind === "discovery" && write.status === "idle"));
    assert.ok(writes.every(write => !write.completed), "not_due polls never report a completed discovery cycle");
  } finally { first.resolve({ status: "skipped", reason: "not_due" }); await workers.stop(); }
});

test("infrequent maintenance keeps failed heartbeats until a successful cycle and stops without waiting five minutes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { database, writes } = heartbeatFixture(); let calls = 0;
  const app = {...appFixture(database, {}), githubMaintenance:{ async run() { calls++; throw {code:"GITHUB_MAINTENANCE_FAILED"}; } }};
  const workers = startBackgroundWorkers(app);
  try {
    await flushTasks(); assert.equal(calls, 1);
    t.mock.timers.tick(60_000); await flushTasks();
    assert.equal(calls, 1, "heartbeat refresh must not start another cleanup cycle");
    assert.equal(writes.at(-1)?.status,"failed"); assert.equal(writes.at(-1)?.errorCode,"GITHUB_MAINTENANCE_FAILED");
    assert.ok(writes.filter(row=>row.status === "failed").length >= 2);
    await workers.stop(); assert.equal(writes.at(-1)?.status,"stopped");
  } finally {await workers.stop();}
});

test("stop while the first heartbeat is pending prevents any work claim", async () => {
  const initialWrite = deferred<void>(); let firstWrite = true, calls = 0;
  const { database, writes } = heartbeatFixture(async () => { if (firstWrite) { firstWrite = false; await initialWrite.promise; } });
  const workers = startBackgroundWorkers(appFixture(database, { discovery: async () => { calls++; return { status: "completed" }; } }));
  await flushTasks(); const stopping = workers.stop(); initialWrite.resolve(); await stopping;
  assert.equal(calls, 0, "aborting before the initial SQL write settles cannot dispatch a search");
  assert.deepEqual(writes.map(write => [write.status, write.completed]), [["running", false], ["stopped", false]]);
});

test("slow progress writes settle before stopped, and cancellation does not claim a completed result", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const progressWrite = deferred<void>(); let runningWrites = 0, calls = 0;
  const { database, writes } = heartbeatFixture(async write => { if (write.status === "running" && ++runningWrites === 2) await progressWrite.promise; });
  const workers = startBackgroundWorkers(appFixture(database, { discovery: signal => new Promise(resolve => {
    calls++; signal.addEventListener("abort", () => resolve({ status: "completed" }), { once: true });
  }) }));
  await flushTasks(); assert.equal(calls, 1);
  t.mock.timers.tick(15_000); await flushTasks(); assert.equal(runningWrites, 2);
  const stopping = workers.stop(); await flushTasks();
  assert.equal(writes.length, 1, "stopped cannot overtake a progress heartbeat still in flight");
  progressWrite.resolve(); await stopping;
  assert.deepEqual(writes.map(write => [write.status, write.completed]), [["running", false], ["running", false], ["stopped", false]]);
  t.mock.timers.tick(60_000); await flushTasks(); assert.equal(writes.length, 3, "a stopped ticker cannot overwrite its terminal heartbeat");
  assert.equal(calls, 1);
});

test("stop during source supervision does not claim another source after recovery finishes", async () => {
  const recovery = deferred<void>(); let sourceCalls = 0;
  const { database, writes } = heartbeatFixture();
  const workers = startBackgroundWorkers(appFixture(database, { recover: () => recovery.promise,
    source: async () => { sourceCalls++; return { processed: true }; } }));
  await flushTasks(); const stopping = workers.stop(); recovery.resolve(); await stopping;
  assert.equal(sourceCalls, 0);
  assert.deepEqual(writes.map(write => [write.kind, write.status, write.completed]), [["source", "running", false], ["source", "stopped", false]]);
});

test("discovery failure is a failed heartbeat, while a skipped poll does not claim a new completed cycle", async () => {
  for (const report of [{ status: "failed", errors: [{ code: "FETCH_TIMEOUT" }] }, { status: "skipped", reason: "not_due", errors: [] }]) {
    const database = await databaseFixture();
    const workers = startBackgroundWorkers(appFixture(database, { discovery: async () => report }));
    try {
      const expected = report.status === "failed" ? "failed" : "idle";
      await eventually(async () => (await readBackgroundStatus(database)).some(row => row.kind === "discovery" && row.status === expected), "discovery report did not reach its truthful heartbeat");
      const result = (await readBackgroundStatus(database))[0]!;
      assert.equal(result.lastCompletedAt, null);
      assert.equal(result.errorCode, report.status === "failed" ? "FETCH_TIMEOUT" : null);
    } finally { await boundedStop(workers); await database.close(); }
  }
});

test("background persists healthy completion and stop interrupts an idle sixty-second wait without another claim", async () => {
  const database = await databaseFixture(); let calls = 0;
  const workers = startBackgroundWorkers(appFixture(database, { ai: async () => { calls++; return { processed: false }; } }));
  try {
    await eventually(async () => (await readBackgroundStatus(database)).some(row => row.kind === "ai" && row.status === "idle" && row.lastCompletedAt !== null), "healthy work did not publish its completion heartbeat");
    await boundedStop(workers); assert.equal(workers.signal.aborted, true); await delay(25);
    assert.equal(calls, 1, "stopping an idle worker cannot claim a second job");
    const result = await readBackgroundStatus(database);
    assert.equal(result.length, 1); assert.equal(result[0]!.status, "stopped"); assert.notEqual(result[0]!.lastCompletedAt, null);
  } finally { await workers.stop(); await database.close(); }
});

test("stop propagates abort to running source and discovery loops and supervision precedes source work", async () => {
  const database = await databaseFixture(); const order: string[] = []; let sourceCalls = 0, discoveryCalls = 0, cancellations = 0;
  const cancellable = (kind: "source" | "discovery", signal: AbortSignal) => new Promise<void>(resolve => {
    if (kind === "source") sourceCalls++; else discoveryCalls++;
    order.push(kind);
    signal.addEventListener("abort", () => { cancellations++; resolve(); }, { once: true });
  });
  const workers = startBackgroundWorkers(appFixture(database, { recover: async () => { order.push("recover"); return []; },
    source: signal => cancellable("source", signal), discovery: signal => cancellable("discovery", signal) }));
  try {
    await eventually(async () => sourceCalls === 1 && discoveryCalls === 1, "both configured loops failed to start");
    assert.ok(order.indexOf("recover") < order.indexOf("source"), "expired sources must be supervised before another source claim");
    await boundedStop(workers); assert.equal(cancellations, 2); assert.equal(sourceCalls, 1); assert.equal(discoveryCalls, 1);
    const statuses = await readBackgroundStatus(database);
    assert.deepEqual(statuses.map(row => [row.kind, row.status]), [["discovery", "stopped"], ["source", "stopped"]]);
    assert.ok(statuses.every(row => row.lastCompletedAt === null), "cancelled work cannot create a completion timestamp");
  } finally { await workers.stop(); await database.close(); }
});

test("one failing worker records only a safe error code while another loop remains healthy", async () => {
  const database = await databaseFixture(); let calls = 0;
  const workers = startBackgroundWorkers(appFixture(database, { ai: async () => { throw new Error("FAKE_SECRET_AND_PRIVATE_PROVIDER_BODY"); }, source: async () => { calls++; return { runs: [], errors: [] }; } }));
  try {
    await eventually(async () => {
      const rows = await readBackgroundStatus(database);
      return rows.some(row => row.kind === "ai" && row.status === "failed") && rows.some(row => row.kind === "source" && row.status === "idle");
    }, "a failed loop prevented independent healthy work or lost its heartbeat");
    const rows = await database.query<{ kind: string; error_code: string | null }>("SELECT kind,error_code FROM backend_worker_heartbeats");
    assert.equal(rows.rows.find(row => row.kind === "ai")!.error_code, "WORKER_FAILED");
    assert.doesNotMatch(JSON.stringify(rows.rows), /FAKE_SECRET|PRIVATE_PROVIDER_BODY/); assert.equal(calls, 1);
    await boundedStop(workers);
  } finally { await workers.stop(); await database.close(); }
});

test("background health distinguishes stale execution from a stopped process and a normal discovery polling interval", async () => {
  const database = await databaseFixture();
  try {
    const now = Date.now();
    for (const row of [
      { id: "lost-source", kind: "source", status: "running", seen: now - 180_000 },
      { id: "intentional-stop", kind: "ai", status: "stopped", seen: now - 180_000 },
      { id: "normal-discovery-wait", kind: "discovery", status: "idle", seen: now - 65_000 },
    ]) await database.query("INSERT INTO backend_worker_heartbeats(worker_id,kind,status,last_seen_at) VALUES($1,$2,$3,$4::timestamptz)", [row.id, row.kind, row.status, new Date(row.seen).toISOString()]);
    const result = await readBackgroundStatus(database);
    assert.equal(result.find(row => row.kind === "source")!.status, "stale");
    assert.equal(result.find(row => row.kind === "ai")!.status, "stopped");
    assert.equal(result.find(row => row.kind === "discovery")!.status, "idle", "a sixty-second discovery poll plus small scheduling delay is not a dead worker");
  } finally { await database.close(); }
});

test("one freshly stopped instance does not hide another currently healthy instance of the same worker kind", async () => {
  const database = await databaseFixture();
  try {
    const now = Date.now();
    await database.query("INSERT INTO backend_worker_heartbeats(worker_id,kind,status,last_seen_at) VALUES('serving-instance','ai','running',$1::timestamptz),('newly-stopped-instance','ai','stopped',$2::timestamptz)", [new Date(now - 1000).toISOString(), new Date(now).toISOString()]);
    const result = await readBackgroundStatus(database);
    assert.equal(result.length, 1); assert.equal(result[0]!.status, "running");
  } finally { await database.close(); }
});

test("real source supervision closes a crashed lease without requeueing model work and preserves another current lease", async () => {
  const database = await databaseFixture(); let time = Date.parse("2026-10-08T10:00:00Z");
  const clock = { now: () => new Date(time) }, ids = { next: randomUUID };
  try {
    const repository = new PostgreSqlOperationsExecutionRepository(database);
    const sources = new SourceService({ repository, clock, ids }), runs = new RunService({ repository, clock, ids });
    const actor = { userId: "supervision-fixture-operator", platformRoles: ["admin"] as const };
    const draft: SourceDraft = { name: "人工批准的监督测试来源", ownerUserId: actor.userId, type: "official_rules", acquisitionMethod: "restricted_http", sampleUrl: "https://example.com/rules", minimumIntervalSeconds: 300,
      networkPolicy: { version: 1, rules: [{ hostname: "example.com", pathPrefix: "/rules" }], maxRedirects: 1, maxBytes: 1024, timeoutMs: 1000, acceptedContentTypes: ["text/plain"] } };
    const worker = new WorkerRunService({ repository, clock, ids, leaseDurationMs: 1000,
      identities: { async authenticate() { return { id: "former-source-process", kind: "operations_worker" as const, capabilities: ["crawl", "analysis"] as const, sourceConfigIds: (await repository.listSources(50)).map(row => row.id) }; } },
      validation: { async validateCrawl() { assert.fail("supervision must not validate provider content"); }, async validateAnalysis() { assert.fail("supervision must not validate provider content"); } } });
    const createClaim = async () => {
      let source = await sources.create(actor, draft);
      source = await sources.transition(actor, source.id, { expectedRevision: source.revision, status: "verifying", reason: "测试验证来源" });
      source = await sources.transition(actor, source.id, { expectedRevision: source.revision, status: "enabled", reason: "测试明确人工批准", verification: { termsUrl: "https://example.com/terms", allowedUses: ["规则摘要"], minimumRetainedFields: ["来源"], notes: "测试夹具，无网络采集" } });
      const run = await runs.enqueueCrawl(actor, { sourceConfigId: source.id, expectedSourceRevision: source.revision, targetUrl: source.sampleUrl, adapterVersion: SOURCE_CRAWL_ADAPTER_VERSION, idempotencyKey: randomUUID() });
      return worker.claim("internal-test-fixture", run.id);
    };
    const expired = await createClaim(); time += 2000; const current = await createClaim();
    const backend = createDshBackend({ config: configuration, database, clock, ids, candidates: { async getCandidate() { return null; } }, discoveries: createDiscoveryService(database, clock) });
    assert.equal(backend.adapter, null, "supervision must work without starting a DSH runtime");
    assert.deepEqual(await backend.recoverSources(), [expired.runId]); assert.deepEqual(await backend.recoverSources(), []);
    const ended = await repository.getRun(expired.runId), retained = await repository.getRun(current.runId);
    assert.equal(ended!.status, "failed"); assert.equal(ended!.lease, null); assert.notEqual(ended!.finishedAt, null);
    assert.equal(retained!.status, "running"); assert.equal(retained!.lease!.token, current.leaseToken);
    const audits = await database.query("SELECT id FROM operations_execution_audit WHERE action='RunLeaseReclaimed' AND entity_id=$1", [expired.runId]);
    assert.equal(audits.rowCount, 1, "recovery is idempotent and leaves an audit trail rather than silently reissuing model work");
  } finally { await database.close(); }
});
