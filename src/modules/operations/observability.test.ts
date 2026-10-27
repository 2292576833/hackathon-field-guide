import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import { createOperationsObservabilityService } from "./observability-service.ts";
import { createPostgresOperationsObservabilityQueryPort } from "./observability-postgres.ts";
import { createOperationsObservabilityHandlers } from "./observability-handlers.ts";
import type { ObservabilityRunRecord, SourceObservabilityQuery, SourceObservabilityRecord } from "./observability-types.ts";

const admin: Actor = { userId: "fixture-admin", platformRoles: ["admin"] };
const at = "2026-10-10T08:00:00.000Z";
const secret = "fixture-only-cursor-signing-key-32-bytes";
const baseSource: SourceObservabilityRecord["source"] = { id: "source-a", revision: 3, status: "enabled", nextEligibleAt: null, lastSuccessAt: null, lastFailureAt: at, consecutiveCrawlFailures: 4 };
function run(id = "run-z", createdAt = "2026-10-10T07:50:00.000Z"): ObservabilityRunRecord {
  return { id, revision: 5, kind: "crawl", status: "failed", step: "fetching", attempt: 1, createdAt,
    availableAt: createdAt, firstStartedAt: "2026-10-10T07:51:00.000Z", lastAttemptAt: "2026-10-10T07:51:00.000Z", finishedAt: "2026-10-10T07:51:10.000Z",
    latestFailure: { category: "timeout", occurredAt: "2026-10-10T07:51:10.000Z", attempt: 1 } };
}
function fixture() {
  let milliseconds = Date.parse(at);
  let permission = true;
  let authCalls = 0;
  let reads = 0;
  let onRead = () => {};
  let record: SourceObservabilityRecord = { source: baseSource, runs: [run()], counts: [{ status: "failed", count: "1" }], failures: [{ category: "timeout", count: "1" }] };
  let received: SourceObservabilityQuery | null = null;
  const sql: SqlExecutor = { query: async () => ({ rows: [], rowCount: 0 }) };
  const repository = { database: { transaction: async <T>(work: (executor: SqlExecutor) => Promise<T>) => work(sql) },
    read: async (executor: SqlExecutor, query: SourceObservabilityQuery) => { assert.strictEqual(executor, sql); reads++; received = query; onRead(); return record; } };
  const authorization = { async assertCurrentAdmin(actor: Actor, executor: SqlExecutor) { assert.strictEqual(executor, sql); authCalls++; if (!permission || !actor.platformRoles.includes("admin")) throw new DomainError("CURRENT_ADMIN_REQUIRED", "管理员会话已失效。", { status: 403 }); } };
  const deps = { repository, authorization, clock: { now: () => new Date(milliseconds) }, cursorSecret: secret };
  return { deps, service: createOperationsObservabilityService(deps), revoke: () => { permission = false; }, onRead: (work: () => void) => { onRead = work; }, set: (value: SourceObservabilityRecord) => { record = value; }, advance: (duration: number) => { milliseconds += duration; }, authCalls: () => authCalls, reads: () => reads, received: () => received };
}

test("ordinary/reviewer actors are denied before source reads; cached admin must pass current authorization", async () => {
  const f = fixture();
  for (const platformRoles of [["user"], ["reviewer"]] as const) await assert.rejects(f.service.source({ userId: "other", platformRoles }, { sourceId: "source-a" }), { status: 403 });
  assert.equal(f.reads(), 0); assert.equal(f.authCalls(), 0);
  f.revoke(); await assert.rejects(f.service.source(admin, { sourceId: "source-a" }), { code: "CURRENT_ADMIN_REQUIRED" });
  assert.equal(f.reads(), 0);
});

test("authorization revoked during reads withholds the whole response", async () => {
  const f = fixture(); f.onRead(f.revoke);
  await assert.rejects(f.service.source(admin, { sourceId: "source-a" }), { code: "CURRENT_ADMIN_REQUIRED" });
  assert.equal(f.authCalls(), 2);
});

test("safe projections classify unknown errors and omit URLs, logs, actor IDs and secret fields", async () => {
  const f = fixture();
  const unsafeCategory = "https://example.test/?token=DO_NOT_RETURN_SECRET";
  f.set({ source: { ...baseSource, ownerUserId: "DO_NOT_RETURN_SECRET" }, runs: [{ ...run(), latestFailure: { category: unsafeCategory, occurredAt: at, attempt: 1 }, log: "DO_NOT_RETURN_SECRET", targetUrl: unsafeCategory, lease: { token: "DO_NOT_RETURN_SECRET" } }], counts: [{ status: "failed", count: "1" }], failures: [{ category: unsafeCategory, count: "2" }, { category: "raw body DO_NOT_RETURN_SECRET", count: "3" }] } as unknown as SourceObservabilityRecord);
  const report = await f.service.source(admin, { sourceId: "source-a" });
  assert.equal(JSON.stringify(report).includes("DO_NOT_RETURN_SECRET"), false);
  assert.deepEqual(report.failures, [{ category: "unknown", code: "SOURCE_FAILURE_UNKNOWN", count: "5" }]);
  assert.equal(report.runs[0]!.latestFailure?.code, "SOURCE_FAILURE_UNKNOWN");
  assert.equal(report.runtime, null);
});

test("timings distinguish actual first wait, latest attempt duration and current eligibility delay", async () => {
  const f = fixture();
  const failed = await f.service.source(admin, { sourceId: "source-a" });
  assert.equal(failed.runs[0]!.initialQueueWaitMs, 60_000); assert.equal(failed.runs[0]!.latestAttemptDurationMs, 10_000); assert.equal(failed.runs[0]!.durationBasis, "finished");
  f.set({ source: baseSource, counts: [], failures: [], runs: [{ ...run(), status: "queued", finishedAt: null, availableAt: "2026-10-10T08:01:00.000Z" }] });
  const queued = await f.service.source(admin, { sourceId: "source-a" });
  assert.equal(queued.runs[0]!.durationBasis, "latest_failure"); assert.equal(queued.runs[0]!.latestAttemptDurationMs, 10_000); assert.equal(queued.runs[0]!.eligibleQueueWaitMs, 0); assert.equal(queued.runs[0]!.queuedAgeMs, 600_000);
  f.set({ source: baseSource, counts: [], failures: [], runs: [{ ...run(), status: "running", finishedAt: null }] });
  const running = await f.service.source(admin, { sourceId: "source-a" });
  assert.equal(running.runs[0]!.latestAttemptDurationMs, 540_000); assert.equal(running.runs[0]!.durationBasis, "running_elapsed");
});

test("query rejects oversized/future/invalid windows, unlimited pages and free-text IDs", async () => {
  const f = fixture();
  for (const input of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { since: "2026-08-01T08:00:00Z" }, { until: "2026-10-11T08:00:00Z" }, { until: "2026-10-10T08:00:00.000001Z" }, { since: "2026-09-09T07:59:59.999999Z" }, { since: "2026-02-31T00:00:00Z" }, { kind: "private_project" }, { status: "unknown" }, { failureCategory: "raw exception" }, { sourceId: "https://a.test/?key=secret" }]) {
    await assert.rejects(f.service.source(admin, { sourceId: "source-a", ...input } as never), { code: "INVALID_OBSERVABILITY_QUERY" });
  }
  assert.equal(f.reads(), 0);
  const microWindow = await f.service.source(admin, { sourceId: "source-a", since: "2026-10-10T07:50:00.000000Z", until: "2026-10-10T07:50:00.000001Z" });
  assert.equal(microWindow.runs[0]!.createdAt, "2026-10-10T07:50:00.000000Z");
});

test("signed keyset cursors retain window, bind admin/filter/source and expire; tampering is rejected", async () => {
  const f = fixture(); f.set({ source: baseSource, runs: [run("run-z"), run("run-y")], counts: [], failures: [] });
  const first = await f.service.source(admin, { sourceId: "source-a", limit: 1, status: "failed" }); assert.ok(first.nextCursor);
  const cursor = first.nextCursor!;
  f.set({ source: baseSource, runs: [run("run-y")], counts: [], failures: [] }); f.advance(1000);
  const second = await f.service.source(admin, { sourceId: "source-a", cursor });
  assert.equal(second.runs[0]!.id, "run-y"); assert.equal(second.window.until, first.window.until); assert.equal(f.received()?.before?.id, "run-z");
  for (const input of [{ sourceId: "source-b", cursor }, { sourceId: "source-a", cursor, status: "queued" }, { sourceId: "source-a", cursor: `${cursor.slice(0, -2)}AA` }]) await assert.rejects(f.service.source(admin, input as never), { code: "INVALID_OBSERVABILITY_QUERY" });
  await assert.rejects(f.service.source({ ...admin, userId: "another-admin" }, { sourceId: "source-a", cursor }), { code: "INVALID_OBSERVABILITY_QUERY" });
  f.advance(30 * 60_000); await assert.rejects(f.service.source(admin, { sourceId: "source-a", cursor }), { code: "INVALID_OBSERVABILITY_QUERY" });
});

test("source mismatch, unbounded output and reordered page are withheld", async () => {
  const f = fixture();
  for (const record of [{ source: { ...baseSource, id: "source-b" }, runs: [run()], counts: [], failures: [] }, { source: baseSource, runs: [run("run-a"), run("run-b")], counts: [], failures: [] }, { source: baseSource, runs: [run("run-z"), run("run-y"), run("run-x")], counts: [], failures: [] }]) {
    f.set(record); await assert.rejects(f.service.source(admin, { sourceId: "source-a", limit: 1 }), { code: "OBSERVABILITY_DATA_INVALID" });
  }
});

test("optional runtime port strips extras and retains scope, unknown request and incomplete pricing", async () => {
  const f = fixture(); let queries = 0;
  const service = createOperationsObservabilityService({ ...f.deps, runtime: { async readSourceRuntime(input, _sql) { queries++; assert.equal(input.sourceId, "source-a"); return { measuredAt: at, worker: { scope: "all_sources", status: "running", lastSeenAt: at, log: "DO_NOT_RETURN_SECRET" }, model: { quotaDay: "2026-10-10", quotaTimezone: "UTC", calls: 2, pendingReservations: 1, unknownRequests: 1, completeCostMicroUsd: null, reservedMicroUsd: "100", admission: "unknown_request", rawResponse: "DO_NOT_RETURN_SECRET" } } as never; } } });
  const report = await service.source(admin, { sourceId: "source-a" });
  assert.equal(report.runtime?.worker?.scope, "all_sources"); assert.equal(report.runtime?.model?.completeCostMicroUsd, null); assert.equal(report.runtime?.model?.unknownRequests, 1); assert.equal(JSON.stringify(report).includes("DO_NOT_RETURN_SECRET"), false); assert.equal(queries, 1);
});

test("GET handler authenticates, rejects duplicate/injected parameters and uses private no-store envelope", async () => {
  const f = fixture(); let actor: Actor | null = null;
  const handlers = createOperationsObservabilityHandlers({ service: f.service, resolveActor: async () => actor, requestId: () => "request-safe" });
  const route = handlers.source("source-a");
  assert.equal((await route(new Request("https://site.test/observability"))).status, 401);
  actor = admin;
  assert.equal((await route(new Request("https://site.test/observability?limit=1&limit=2"))).status, 422);
  assert.equal((await route(new Request("https://site.test/observability?actorId=victim"))).status, 422);
  assert.equal((await route(new Request("https://site.test/observability", { method: "POST" }))).status, 405);
  const response = await route(new Request("https://site.test/observability"));
  assert.equal(response.status, 200); assert.match(response.headers.get("cache-control")!, /no-store/); assert.equal((await response.json()).requestId, "request-safe");
});

test("PostgreSQL adapter executes real bounded source projection, full-window counts and timestamp/id pagination", async () => {
  // A temporary PGlite engine tests SQL shape only; no app data or network.
  const engine = new PGlite(); await engine.waitReady;
  const calls: { statement: string; parameters: readonly unknown[] }[] = [];
  const executor = (connection: Pick<PGlite, "query">): SqlExecutor => ({ async query<Row>(statement: string, parameters: readonly unknown[] = []) { calls.push({ statement, parameters }); const result = await connection.query(statement, [...parameters]); return { rows: result.rows as Row[], rowCount: result.affectedRows ?? result.rows.length }; } });
  const direct = executor(engine);
  const database: DatabasePort = { ...direct, transaction: work => engine.transaction(sql => work(executor(sql))) };
  try {
    await engine.exec(`CREATE TABLE operations_source_configs(id text PRIMARY KEY,revision integer,status text,next_eligible_at timestamptz,last_success_at timestamptz,last_failure_at timestamptz,consecutive_failures integer,data jsonb);
      CREATE TABLE operations_execution_runs(id text PRIMARY KEY,revision integer,kind text,status text,source_config_id text,created_at timestamptz,available_at timestamptz,data jsonb);`);
    await database.query("INSERT INTO operations_source_configs VALUES($1,3,'enabled',NULL,NULL,$2::timestamptz,4,$3::jsonb)", ["source-a", at, JSON.stringify({ ownerUserId: "DO_NOT_RETURN_SECRET", sampleUrl: "https://source.test/?token=DO_NOT_RETURN_SECRET" })]);
    await database.query("INSERT INTO operations_source_configs VALUES('source-b',1,'enabled',NULL,NULL,NULL,0,'{}'::jsonb)");
    for (const item of [run("run-z"), run("run-y"), { ...run("run-x"), kind: "analysis" as const, status: "succeeded" as const }, run("old", "2026-09-01T00:00:00.000Z")]) {
      await database.query("INSERT INTO operations_execution_runs VALUES($1,$2,$3,$4,$5,$6::timestamptz,$6::timestamptz,$7::jsonb)", [item.id, item.revision, item.kind, item.status, "source-a", item.createdAt, JSON.stringify({ ...item, history: [{ attempt: 1, occurredAt: item.firstStartedAt }], failures: [item.latestFailure], requestedBy: "DO_NOT_RETURN_SECRET", log: "DO_NOT_RETURN_SECRET" })]);
    }
    const repository = createPostgresOperationsObservabilityQueryPort(database);
    const f = fixture(); const service = createOperationsObservabilityService({ ...f.deps, repository, authorization: { async assertCurrentAdmin(actor) { assert.ok(actor.platformRoles.includes("admin")); } } });
    const first = await service.source(admin, { sourceId: "source-a", limit: 1, kind: "crawl", failureCategory: "timeout" });
    assert.equal(first.runs[0]!.id, "run-z"); assert.ok(first.nextCursor); assert.deepEqual(first.counts, [{ status: "failed", count: "2" }]); assert.equal(first.failures[0]!.count, "2"); assert.equal(first.runs[0]!.initialQueueWaitMs, 60_000);
    const second = await service.source(admin, { sourceId: "source-a", cursor: first.nextCursor!, limit: 1 });
    assert.equal(second.runs[0]!.id, "run-y"); assert.equal(second.nextCursor, null); assert.equal(JSON.stringify(first).includes("DO_NOT_RETURN_SECRET"), false);
    await database.query("UPDATE operations_execution_runs SET data=jsonb_set(data,'{failures,0,category}',to_jsonb($2::text)) WHERE id=$1", ["run-x", "DO_NOT_RETURN_SECRET"]);
    const rawProjection = await database.transaction(sql => repository.read(sql, { sourceId: "source-a", since: "2026-10-03T08:00:00.000Z", until: at, kind: "analysis", status: null, failureCategory: null, limit: 1, before: null }));
    assert.equal(rawProjection!.runs[0]!.latestFailure!.category, "unknown"); assert.equal(JSON.stringify(rawProjection).includes("DO_NOT_RETURN_SECRET"), false);
    assert.deepEqual((await service.source(admin, { sourceId: "source-b" })).runs, []);
    await assert.rejects(service.source(admin, { sourceId: "source-missing" }), { code: "SOURCE_NOT_FOUND" });
    const queries = calls.filter(call => call.statement.startsWith("WITH selected_runs"));
    assert.equal(queries.length, 5); assert.ok(queries.every(call => call.parameters[6] === 2 || call.parameters[6] === 51));
    assert.ok(queries.every(call => !call.statement.includes("source-a") && !/\b(?:INSERT|UPDATE|DELETE)\b/.test(call.statement)));
    assert.ok(queries.every(call => !/auth_|ai_usage|backend_worker/.test(call.statement)));
    for (const item of [run("micro-a", "2026-10-10T07:50:00.123001Z"), run("micro-z", "2026-10-10T07:50:00.123002Z"), run("micro-y", "2026-10-10T07:50:00.123002Z")]) {
      await database.query("INSERT INTO operations_execution_runs VALUES($1,$2,$3,$4,$5,$6::timestamptz,$6::timestamptz,$7::jsonb)", [item.id, item.revision, item.kind, item.status, "source-b", item.createdAt, JSON.stringify({ ...item, history: [{ attempt: 1, occurredAt: item.firstStartedAt }], failures: [item.latestFailure] })]);
    }
    const seen: string[] = [];
    const seenTimes: string[] = [];
    let microCursor: string | undefined;
    do {
      const page = await service.source(admin, { sourceId: "source-b", limit: 1, cursor: microCursor });
      seen.push(...page.runs.map(item => item.id)); seenTimes.push(...page.runs.map(item => item.createdAt));
      microCursor = page.nextCursor ?? undefined;
    } while (microCursor);
    assert.deepEqual(seen, ["micro-z", "micro-y", "micro-a"]);
    assert.deepEqual(seenTimes, ["2026-10-10T07:50:00.123002Z", "2026-10-10T07:50:00.123002Z", "2026-10-10T07:50:00.123001Z"]);
  } finally { await engine.close(); }
});
