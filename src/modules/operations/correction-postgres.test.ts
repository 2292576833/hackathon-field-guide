import test from "node:test";
import assert from "node:assert/strict";
import type { DatabasePort, SqlExecutor, SqlResult } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import { PostgresCorrectionRepository } from "./correction-postgres.ts";
import type { Correction } from "./correction-types.ts";

const record: Correction = { id: "correction-'quote", submittedBy: "owner-'quote", original: { target: { kind: "event", entityId: "e1", version: 3 }, field: "截止日期", message: "公告日期发生变更", evidenceUrls: ["https://events.example/rules"], submittedAt: "2026-10-08T08:00:00Z" }, revision: 2, status: "triaging", response: "核查官方公告中", relatedVersion: null, updatedAt: "2026-10-08T08:00:00Z" };
function database() {
  const calls: { statement: string; parameters: readonly unknown[] }[] = [];
  let rowCount = 1;
  const { original, submittedBy, ...current } = record;
  const db: DatabasePort = {
    async query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<SqlResult<Row>> {
      calls.push({ statement, parameters });
      return { rows: statement.startsWith("SELECT owner_id") ? [{ owner_id: submittedBy, original, state: current } as Row] : [], rowCount };
    },
    transaction: <T>(work: (tx: SqlExecutor) => Promise<T>) => work(db),
  };
  return { db, calls, failCas: () => { rowCount = 0; } };
}
test("correction PostgreSQL adapter never assigns immutable original or owner when processing", async () => {
  const { db, calls } = database(); const repository = new PostgresCorrectionRepository(db);
  await repository.transaction(async tx => {
    assert.deepEqual(await tx.getCorrection(record.id), record);
    await tx.insertCorrection(record); await tx.saveCorrection(record, 1);
    await tx.appendTransition({ id: "transition", correctionId: record.id, revision: 2, actorId: "reviewer", fromStatus: "received", toStatus: "triaging", reason: "开始核查", relatedVersion: null, occurredAt: record.updatedAt, requestId: "req" });
  });
  assert.match(calls[0]!.statement, /FOR UPDATE$/);
  assert.equal(calls[1]!.parameters[5], JSON.stringify(record.original));
  const update = calls[2]!;
  assert.ok(!update.statement.split("WHERE")[0]!.includes("original"));
  assert.ok(!update.statement.split("WHERE")[0]!.includes("owner_id"));
  assert.match(update.statement, /revision = \$6 AND owner_id = \$7/);
  assert.deepEqual(update.parameters.slice(5), [1, record.submittedBy]);
  assert.ok(calls.every(call => !call.statement.includes("'quote")));
  assert.equal(calls[3]!.parameters[1], record.id);
});
test("correction owner lists use owner predicate and failed optimistic update is 409", async () => {
  const { db, calls, failCas } = database(); const repository = new PostgresCorrectionRepository(db);
  const own = await repository.listOwn(record.submittedBy, 20);
  assert.deepEqual(own, [record]); assert.match(calls[0]!.statement, /WHERE owner_id = \$1/);
  assert.deepEqual(calls[0]!.parameters, [record.submittedBy, 20]);
  failCas();
  await assert.rejects(repository.transaction(tx => tx.saveCorrection(record, 1)), error => error instanceof DomainError && error.code === "VERSION_CONFLICT" && error.status === 409);
});
