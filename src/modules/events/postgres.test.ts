import test from "node:test";
import assert from "node:assert/strict";
import type { DatabasePort, SqlExecutor, SqlResult } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import { PostgresEventsRepository } from "./postgres.ts";

class RecordingDatabase implements DatabasePort {
  calls: { statement: string; parameters: readonly unknown[] }[] = [];
  rowCount = 1;
  transactionCount = 0;
  async query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.calls.push({ statement, parameters });
    return { rows: [], rowCount: this.rowCount };
  }
  async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactionCount++;
    return work(this);
  }
}
test("public filtering binds input and only joins the published version", async () => {
  const db = new RecordingDatabase();
  const repository = new PostgresEventsRepository(db);
  const attack = "' OR 1=1; --";
  await repository.listPublished({ query: attack, region: attack, format: "online", cursor: attack }, new Date("2026-10-08T00:00:00Z"));
  const call = db.calls[0]!;
  assert.ok(!call.statement.includes(attack));
  assert.deepEqual(call.parameters, [attack, attack, attack, "online"]);
  assert.match(call.statement, /publishedVersion/);
  assert.match(call.statement, /publicationStatus.*archived/);
});
test("private mutation uses the same transaction executor and row locks", async () => {
  const db = new RecordingDatabase();
  const repository = new PostgresEventsRepository(db);
  await repository.transaction(async tx => {
    assert.equal(tx.executor, db);
    await tx.getConfirmation("project-1");
    await tx.getRun("run-1");
  });
  assert.equal(db.transactionCount, 1);
  assert.ok(db.calls.every(call => call.statement.endsWith("FOR UPDATE")));
});
test("CAS refuses stale writes and rules are inserted without replacement", async () => {
  const db = new RecordingDatabase();
  db.rowCount = 0;
  const repository = new PostgresEventsRepository(db);
  await assert.rejects(() => repository.saveEvent({ id: "event-1", revision: 3, publicationStatus: "draft", candidateVersion: 2, publishedVersion: 1, lastVerifiedAt: null }, 2), (error: unknown) => error instanceof DomainError && error.code === "VERSION_CONFLICT");
  assert.match(db.calls[0]!.statement, /WHERE id = \$1 AND revision = \$4/);
});
