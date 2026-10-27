import test from "node:test";
import assert from "node:assert/strict";
import type { DatabasePort, SqlExecutor, SqlResult } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import { PostgresResourceReviewRepository } from "./resource-review-postgres.ts";
import type { ResourceReview } from "./resource-review-types.ts";

function database() {
  const calls: { statement: string; parameters: readonly unknown[] }[] = [];
  let rowCount = 1;
  let transactions = 0;
  const db: DatabasePort = {
    async query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<SqlResult<Row>> {
      calls.push({ statement, parameters }); return { rows: [], rowCount };
    },
    async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> { transactions++; return work(db); },
  };
  return { db, calls, count: () => transactions, failCas: () => { rowCount = 0; } };
}
const review: ResourceReview = { id: "review-'quoted", resourceId: "resource-'quoted", resourceRevision: 7, contentHash: "hash", recordedBy: "editor", revision: 2,
  status: "approved", createdAt: "2026-10-08T08:00:00Z", updatedAt: "2026-10-08T08:00:00Z", reviewedBy: "editor", reviewedAt: "2026-10-08T08:00:00Z",
  verification: { link: { status: "available", checkedUrl: "https://example.test/" }, fees: { status: "unknown", sourceUrl: null }, license: { status: "unknown", sourceUrl: null } }, reason: "待确认费用和许可", publishedVersion: null, publishedAt: null };

test("resource review PostgreSQL metadata adapter locks rows and parameterizes resource/version/JSON", async () => {
  const { db, calls, count } = database(); const repository = new PostgresResourceReviewRepository(db);
  await repository.transaction(async tx => {
    await tx.getReview(review.id); await tx.findReview(review.resourceId, 7); await tx.insertReview(review); await tx.saveReview(review, 1);
    await tx.lockWithdrawal("reviewer-'quoted", "operation-'quoted"); await tx.findWithdrawal("reviewer-'quoted", "operation-'quoted");
    await tx.query("SELECT $1", ["M09-port-shares-transaction"]);
  });
  assert.equal(count(), 1);
  assert.match(calls[0]!.statement, /FOR UPDATE$/); assert.match(calls[1]!.statement, /resource_revision = \$2 FOR UPDATE$/);
  assert.ok(calls.every(call => !call.statement.includes("'quoted")));
  assert.equal(calls[2]!.parameters[6], JSON.stringify(review));
  assert.match(calls[3]!.statement, /revision = \$6/); assert.deepEqual(calls[3]!.parameters.slice(5), [1, review.resourceId, 7]);
  assert.match(calls[4]!.statement, /pg_advisory_xact_lock/);
  assert.equal(calls[4]!.parameters[0], JSON.stringify(["resource-withdraw", "reviewer-'quoted", "operation-'quoted"]));
  assert.deepEqual(calls.at(-1)?.parameters, ["M09-port-shares-transaction"]);
});
test("resource metadata CAS miss returns 409 and list does not interpolate status", async () => {
  const { db, calls, failCas } = database(); const repository = new PostgresResourceReviewRepository(db);
  failCas();
  await assert.rejects(repository.transaction(tx => tx.saveReview(review, 1)), error => error instanceof DomainError && error.code === "VERSION_CONFLICT" && error.status === 409);
  await repository.listReviews("approved", 20);
  assert.deepEqual(calls.at(-1)?.parameters, ["approved", 20]);
});

test("resource review ID lookup can peek without a row lock before the default locked reread", async () => {
  const { db, calls } = database(); const repository = new PostgresResourceReviewRepository(db);
  await repository.transaction(async tx => { await tx.getReview(review.id, false); await tx.getReview(review.id); });
  assert.doesNotMatch(calls[0]!.statement, /FOR UPDATE/);
  assert.match(calls[1]!.statement, /FOR UPDATE$/);
  assert.deepEqual(calls.map(call => call.parameters), [[review.id], [review.id]]);
  assert.ok(calls.every(call => !call.statement.includes("'quoted")));
});
