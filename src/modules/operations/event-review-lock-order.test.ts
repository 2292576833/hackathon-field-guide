import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { EventReviewService } from "./event-review-service.ts";
import { PostgresEventReviewRepository } from "./event-review-postgres.ts";
import { criticalFieldKeys } from "./event-review-types.ts";
import type { EventCandidatePublicationPort, EventCandidateSnapshot, EventReview, EventReviewAudit, EventReviewRepository, EventReviewTransaction } from "./event-review-types.ts";

const actor: Actor = { userId: "reviewer", platformRoles: ["reviewer"] };
const copy = <T>(value: T): T => structuredClone(value);
const conflict = (error: unknown) => error instanceof DomainError && error.code === "VERSION_CONFLICT";
function sampleCandidate(): EventCandidateSnapshot {
  return { eventId: "event-1", candidateId: "candidate-1", revision: 1, contentHash: "hash-1", schemaVersion: "schema-1",
    createdBy: actor.userId, lastModifiedBy: actor.userId, origin: "manual", validationErrors: [],
    criticalFields: criticalFieldKeys.map(key => ({ key, state: "known", evidenceIds: [`evidence-${key}`], summary: key })),
    currentPublishedVersion: null, currentPublishedCriticalFields: null };
}
function sampleReview(): EventReview {
  return { id: "review-1", eventId: "event-1", candidateId: "candidate-1", candidateRevision: 1, contentHash: "hash-1", schemaVersion: "schema-1",
    revision: 1, status: "pending", submittedBy: actor.userId, lastEditedBy: actor.userId,
    createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z", reviewedBy: null, reviewedAt: null,
    checkedKeys: [], acknowledgedUnknownKeys: [], reason: null, publishedVersion: null, publishedAt: null };
}
/** Test-only metadata/content ports; every content call checks the supplied transaction. */
function fixture() {
  let review = sampleReview();
  let candidate = sampleCandidate();
  const calls: string[] = [];
  const audits: EventReviewAudit[] = [];
  let onPeek: (() => void) | undefined;
  let sequence = 0;
  const tx: EventReviewTransaction = {
    async query() { throw new Error("No database in fixture"); },
    async getReview(id, lock = true) {
      calls.push(lock ? `review:${id}` : `peek:${id}`);
      const result = id === review.id ? copy(review) : null;
      if (!lock) { const callback = onPeek; onPeek = undefined; callback?.(); }
      return result;
    },
    async findByCandidate(id, lock = true) {
      calls.push(`${lock ? "review-by-candidate" : "peek-by-candidate"}:${id}`);
      return id === review.candidateId ? copy(review) : null;
    },
    async insertReview(value) { calls.push("insert"); review = copy(value); },
    async saveReview(value, expected) { assert.equal(review.revision, expected); calls.push("save"); review = copy(value); },
    async appendAudit(value) { calls.push("audit"); audits.push(copy(value)); },
  };
  const repository: EventReviewRepository = { transaction: async work => work(tx), listReviews: async () => [copy(review)] };
  const events: EventCandidatePublicationPort = {
    async getCandidate(transaction, id) { assert.equal(transaction, tx); calls.push(`content:${id}`); return id === candidate.candidateId ? copy(candidate) : null; },
    async createManualCandidate(transaction) { assert.equal(transaction, tx); return copy(candidate); },
    async reviseManualCandidate(transaction, input) {
      assert.equal(transaction, tx); calls.push("revise-content"); assert.equal(input.expectedRevision, candidate.revision);
      candidate = { ...candidate, revision: candidate.revision + 1, contentHash: "hash-2" }; return copy(candidate);
    },
    async publishCandidate(transaction, input) {
      assert.equal(transaction, tx); calls.push("publish-content"); assert.equal(input.expectedRevision, candidate.revision);
      assert.equal(input.expectedContentHash, candidate.contentHash);
      return { eventId: candidate.eventId, publishedVersion: 1 };
    },
    async withdrawEvent() { throw new Error("Unused"); },
  };
  const service = new EventReviewService({ repository, events, ids: { next: () => `id-${++sequence}` }, clock: { now: () => new Date("2026-10-08T00:00:00Z") } });
  return { service, tx, calls, audits, patchReview(patch: Partial<EventReview>) { review = { ...review, ...patch }; },
    patchCandidate(patch: Partial<EventCandidateSnapshot>) { candidate = { ...candidate, ...patch }; },
    afterPeek(callback: () => void) { onPeek = callback; }, get review() { return copy(review); } };
}
type Fixture = ReturnType<typeof fixture>;
const actions = ["detail", "revise", "refresh", "approve", "decide", "publish"] as const;
type Action = typeof actions[number];
function prepare(f: Fixture, action: Action): void {
  if (action === "publish") f.patchReview({ status: "approved", reviewedBy: actor.userId, reviewedAt: "2026-10-08T00:00:00Z", checkedKeys: [...criticalFieldKeys] });
  if (action === "refresh") f.patchCandidate({ revision: 2, contentHash: "hash-2" });
}
function execute(f: Fixture, action: Action): Promise<unknown> {
  const input = { expectedRevision: 1, expectedCandidateRevision: 1, reason: "核验" };
  if (action === "detail") return f.service.getDetail(actor, "review-1");
  if (action === "revise") return f.service.reviseManual(actor, "review-1", { ...input, content: {} }, "request");
  if (action === "refresh") return f.service.refreshCandidate(actor, "review-1", { ...input, expectedCandidateRevision: 2 }, "request");
  if (action === "approve") return f.service.approve(actor, "review-1", { ...input, checkedKeys: [...criticalFieldKeys], acknowledgedUnknownKeys: [] }, "request");
  if (action === "decide") return f.service.decide(actor, "review-1", { ...input, decision: "changes_requested" }, "request");
  return f.service.publish(actor, "review-1", { ...input, expectedPublishedVersion: null }, "request");
}

test("every review entry locks content before its locked review reread in the same transaction", async () => {
  for (const action of actions) {
    const f = fixture(); prepare(f, action); await execute(f, action);
    assert.deepEqual(f.calls.slice(0, 3), ["peek:review-1", "content:candidate-1", "review:review-1"], action);
  }
});
test("candidate or event ownership changing after the peek prevents all actions", async () => {
  for (const action of actions) for (const change of ["candidate", "event", "both-event"] as const) {
    const f = fixture(); prepare(f, action);
    f.afterPeek(() => {
      f.patchReview(change === "candidate" ? { candidateId: "candidate-2" } : { eventId: "event-2" });
      // Both locked records now agree with each other, but differ from the unlocked peek.
      if (change === "both-event") f.patchCandidate({ eventId: "event-2" });
    });
    const label = `${action}:${change}`;
    await assert.rejects(execute(f, action), conflict, label);
    assert.equal(f.calls.includes("save"), false, label);
    assert.equal(f.calls.includes("revise-content"), false, label);
    assert.equal(f.calls.includes("publish-content"), false, label);
    assert.equal(f.audits.length, 0, label);
  }
});
test("locked reread checks expected revision and approval checks the locked hash and schema", async () => {
  const changedReview = fixture(); changedReview.afterPeek(() => changedReview.patchReview({ revision: 2 }));
  await assert.rejects(execute(changedReview, "approve"), conflict);
  for (const patch of [{ contentHash: "new-hash" }, { schemaVersion: "new-schema" }]) {
    const f = fixture(); f.afterPeek(() => f.patchCandidate(patch));
    await assert.rejects(execute(f, "approve"), conflict);
    assert.equal(f.calls.includes("save"), false);
  }
});
test("registration locks content first and preserves existing published or stale review metadata", async () => {
  for (const status of ["approved", "published"] as const) {
    const f = fixture(); f.patchReview({ status, revision: 3 }); f.patchCandidate({ revision: 2, contentHash: "hash-2" });
    const result = await f.service.registerCandidate(actor, "candidate-1", "retry-request");
    assert.deepEqual(f.calls, ["content:candidate-1", "review-by-candidate:candidate-1"]);
    assert.deepEqual(result, f.review);
    assert.equal(result.contentHash, "hash-1");
    assert.equal(f.audits.length, 0);
  }
});
test("published review cannot be revised or refreshed after content-before-review locking", async () => {
  for (const action of ["revise", "refresh"] as const) {
    const f = fixture(); prepare(f, action); f.patchReview({ status: "published" });
    await assert.rejects(execute(f, action), (error: unknown) => error instanceof DomainError && error.code === "INVALID_STATE");
    assert.equal(f.calls.includes("save"), false);
    assert.equal(f.calls.includes("revise-content"), false);
  }
});
test("Postgres review reads default to locking and explicitly support parameterized peeks", async () => {
  const calls: { statement: string; parameters: readonly unknown[] }[] = [];
  const database: DatabasePort = {
    async query<Row>(statement: string, parameters: readonly unknown[] = []) { calls.push({ statement, parameters }); return { rows: [] as Row[], rowCount: 0 }; },
    transaction: work => work(database),
  };
  const id = "candidate'; --";
  await new PostgresEventReviewRepository(database).transaction(async tx => {
    await tx.getReview(id); await tx.getReview(id, false); await tx.findByCandidate(id); await tx.findByCandidate(id, false);
  });
  assert.deepEqual(calls.map(call => /FOR UPDATE$/.test(call.statement)), [true, false, true, false]);
  assert.ok(calls.every(call => !call.statement.includes(id)));
  for (const call of calls) assert.deepEqual(call.parameters, [id]);
});

/** A test-only row-lock coordinator; no production persistence or content adapter. */
class RowLocks {
  private readonly held = new Map<string, { owner: string; waiting: { owner: string; resolve: () => void }[] }>();
  async acquire(owner: string, key: string): Promise<void> {
    const lock = this.held.get(key);
    if (!lock) { this.held.set(key, { owner, waiting: [] }); return; }
    if (lock.owner === owner) return;
    await new Promise<void>(resolve => lock.waiting.push({ owner, resolve }));
  }
  release(owner: string): void {
    for (const [key, lock] of this.held) if (lock.owner === owner) {
      const next = lock.waiting.shift();
      if (next) { lock.owner = next.owner; next.resolve(); } else this.held.delete(key);
    }
  }
}
test("concurrent M03 content-first writer and M08 approval finish without inverted row locks", { timeout: 2000 }, async t => {
  const locks = new RowLocks();
  let candidate = sampleCandidate();
  const review = sampleReview();
  let firstRead!: () => void;
  const read = new Promise<void>(resolve => { firstRead = resolve; });
  let writes = 0;
  await locks.acquire("M03", "content");
  t.after(() => { locks.release("M03"); locks.release("M08"); });
  const tx: EventReviewTransaction = {
    async query() { throw new Error("No database in fixture"); },
    async getReview(_id, lock = true) { if (lock) await locks.acquire("M08", "review"); firstRead(); return copy(review); },
    async findByCandidate() { throw new Error("Unused"); },
    async insertReview() { throw new Error("Unused"); },
    async saveReview() { writes++; }, async appendAudit() { writes++; },
  };
  const repository: EventReviewRepository = {
    listReviews: async () => [],
    async transaction(work) { try { return await work(tx); } finally { locks.release("M08"); } },
  };
  const events: EventCandidatePublicationPort = {
    async getCandidate(transaction) { assert.equal(transaction, tx); await locks.acquire("M08", "content"); return copy(candidate); },
    async createManualCandidate() { throw new Error("Unused"); }, async reviseManualCandidate() { throw new Error("Unused"); },
    async publishCandidate() { throw new Error("Unused"); }, async withdrawEvent() { throw new Error("Unused"); },
  };
  const service = new EventReviewService({ repository, events, ids: { next: () => "unused" }, clock: { now: () => new Date("2026-10-08T00:00:00Z") } });
  const writer = (async () => {
    await read; await locks.acquire("M03", "review");
    candidate = { ...candidate, revision: 2, contentHash: "hash-2" };
    locks.release("M03");
  })();
  const approval = assert.rejects(service.approve(actor, review.id, { expectedRevision: 1, expectedCandidateRevision: 1,
    checkedKeys: [...criticalFieldKeys], acknowledgedUnknownKeys: [], reason: "核验" }, "request"), conflict);
  await Promise.all([writer, approval]);
  assert.equal(writes, 0);
});
