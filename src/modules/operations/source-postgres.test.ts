import test from "node:test";
import assert from "node:assert/strict";
import type { DatabasePort, SqlExecutor, SqlResult } from "../../shared/persistence.ts";
import { PostgreSqlOperationsExecutionRepository } from "./source-postgres.ts";
import { SourceService } from "./source-service.ts";
import { admin, draft, executionFixture, MutableClock, SequenceIds } from "./source-test-fixtures.ts";

interface QueryCall { readonly statement: string; readonly parameters: readonly unknown[]; readonly insideTransaction: boolean }
/** Contract double, not an actual SQL database. */
class RecordingDatabase implements DatabasePort {
  readonly calls: QueryCall[] = [];
  readonly committedCalls: QueryCall[] = [];
  commits = 0;
  rollbacks = 0;
  response: (call: QueryCall) => { rows: readonly unknown[]; rowCount: number } = () => ({ rows: [], rowCount: 1 });
  async query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<SqlResult<Row>> { return this.execute<Row>(statement, parameters, false); }
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const start = this.calls.length;
    const tx: SqlExecutor = { query: async <Row>(statement: string, parameters: readonly unknown[] = []) => this.execute<Row>(statement, parameters, true) };
    try { const result = await work(tx); this.commits += 1; this.committedCalls.push(...this.calls.slice(start)); return result; }
    catch (error) { this.rollbacks += 1; throw error; }
  }
  private async execute<Row>(statement: string, parameters: readonly unknown[], insideTransaction: boolean): Promise<SqlResult<Row>> {
    const call = { statement, parameters, insideTransaction };
    this.calls.push(call);
    const result = this.response(call);
    return { rows: result.rows as readonly Row[], rowCount: result.rowCount };
  }
}

test("PostgreSQL source mutation and audit use one transaction with parameterized data", async () => {
  const db = new RecordingDatabase();
  const repository = new PostgreSqlOperationsExecutionRepository(db);
  const service = new SourceService({ repository, clock: new MutableClock(), ids: new SequenceIds() });
  const maliciousText = "来源 '); DROP TABLE operations_execution_runs; --";
  const source = await service.create(admin, { ...draft, name: maliciousText });
  assert.equal(db.commits, 1);
  assert.equal(db.calls.length, 2);
  assert.equal(db.calls.every((call) => call.insideTransaction), true);
  assert.equal(db.calls.some((call) => call.statement.includes(maliciousText)), false);
  assert.equal(JSON.parse(db.calls[0].parameters[3] as string).name, maliciousText);
  assert.equal(db.calls[1].parameters[4], source.id);
  db.response = (call) => { if (call.statement.startsWith("INSERT INTO operations_execution_audit")) throw new Error("simulated audit failure"); return { rows: [], rowCount: 1 }; };
  await assert.rejects(service.create(admin, draft), /audit failure/);
  assert.equal(db.rollbacks, 1);
  assert.equal(db.committedCalls.length, 2);
});
test("PostgreSQL source and run CAS enforce affected-row count", async () => {
  const fixture = await executionFixture();
  const run = await fixture.runs.enqueueCrawl(admin, { sourceConfigId: fixture.source.id, expectedSourceRevision: fixture.source.revision, targetUrl: draft.sampleUrl, adapterVersion: "v1", idempotencyKey: "adapter-cas" });
  const db = new RecordingDatabase();
  db.response = () => ({ rows: [], rowCount: 0 });
  const repository = new PostgreSqlOperationsExecutionRepository(db);
  await assert.rejects(repository.transaction((tx) => tx.saveSource({ ...fixture.source, revision: fixture.source.revision + 1 }, fixture.source.revision)), { code: "VERSION_CONFLICT" });
  await assert.rejects(repository.transaction((tx) => tx.saveRun({ ...run, revision: run.revision + 1 }, run.revision)), { code: "VERSION_CONFLICT" });
  assert.equal(db.calls[0].parameters.at(-1), fixture.source.revision);
  assert.equal(db.calls[1].parameters.at(-1), run.revision);
  assert.match(db.calls[1].statement, /WHERE id=\$1 AND revision=\$8/);
});
test("source health comes from authoritative columns and system updates check missing source", async () => {
  const fixture = await executionFixture();
  const db = new RecordingDatabase();
  db.response = () => ({ rows: [{ data: fixture.source, next_eligible_at: new Date("2026-10-08T13:00:00Z"), last_success_at: null, last_failure_at: "2026-10-08T12:10:00Z", consecutive_failures: 2 }], rowCount: 1 });
  const repository = new PostgreSqlOperationsExecutionRepository(db);
  const read = await repository.getSource(fixture.source.id);
  assert.equal(read?.health.consecutiveFailures, 2);
  assert.equal(read?.health.nextEligibleAt, "2026-10-08T13:00:00.000Z");
  db.response = () => ({ rows: [], rowCount: 0 });
  await assert.rejects(repository.transaction((tx) => tx.recordSourceHealth("missing", true, fixture.clock.now().toISOString())), { code: "SOURCE_NOT_FOUND" });
  await assert.rejects(repository.transaction((tx) => tx.reserveSourceInterval("missing", fixture.clock.now().toISOString())), { code: "SOURCE_NOT_FOUND" });
});
test("run locking allows FK alias key-share and request hash stays separate from content hash", async () => {
  const fixture = await executionFixture();
  const run = await fixture.runs.enqueueCrawl(admin, { sourceConfigId: fixture.source.id, expectedSourceRevision: fixture.source.revision, targetUrl: draft.sampleUrl, adapterVersion: "v1", idempotencyKey: "adapter-key" });
  const db = new RecordingDatabase();
  db.response = () => ({ rows: [{ data: run, fingerprint: "request-fingerprint" }], rowCount: 1 });
  const repository = new PostgreSqlOperationsExecutionRepository(db);
  await repository.transaction(async (tx) => {
    await tx.acquireLock("quoted'key");
    await tx.getRun(run.id, true);
    const aliased = await tx.findIdempotentRun(admin.userId, "crawl", "quoted'key");
    assert.equal(aliased?.fingerprint, "request-fingerprint");
    assert.equal(aliased?.run.fingerprint, run.fingerprint);
    await tx.bindIdempotencyRun(admin.userId, "crawl", "quoted'key", "request-fingerprint", run.id);
  });
  assert.match(db.calls[1].statement, /FOR NO KEY UPDATE$/);
  assert.equal(db.calls.some((call) => call.statement.includes("quoted'key")), false);
  assert.equal(db.calls[3].parameters[2], "quoted'key");
});
test("watchdog query includes invalidated queued sources as well as expired running leases", async () => {
  const db = new RecordingDatabase();
  const repository = new PostgreSqlOperationsExecutionRepository(db);
  await repository.findExpiredRuns("2026-10-08T12:00:00Z", 20);
  assert.match(db.calls[0].statement, /r.status IN \('queued','running'\)/);
  assert.match(db.calls[0].statement, /s.status <> 'enabled'/);
  assert.match(db.calls[0].statement, /sourceSnapshot/);
  assert.deepEqual(db.calls[0].parameters, ["2026-10-08T12:00:00Z", 20]);
});
