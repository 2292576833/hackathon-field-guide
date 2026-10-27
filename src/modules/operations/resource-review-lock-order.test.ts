import test from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { ResourceReview, ResourceReviewAudit, ResourceReviewRepository, ResourceReviewSnapshot, ResourceReviewTransaction, ResourceVerification } from "./resource-review-types.ts";
import { ResourceReviewService } from "./resource-review-service.ts";

const actor: Actor = { userId: "reviewer", platformRoles: ["reviewer"] };
const at = "2026-10-08T08:00:00Z";
const verification: ResourceVerification = {
  link: { status: "available", checkedUrl: "https://tools.example/tool" },
  fees: { status: "unknown", sourceUrl: null }, license: { status: "unknown", sourceUrl: null },
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Independent transactions with exclusive row locks and a wait-for cycle detector. */
class RowLocks {
  readonly owners = new Map<string, number>();
  readonly waiting = new Map<number, string>();
  readonly queues = new Map<string, Array<{ transactionId: number; resume: () => void }>>();
  async acquire(transactionId: number, key: string): Promise<boolean> {
    const owner = this.owners.get(key);
    if (owner === transactionId) return false;
    if (owner === undefined) { this.owners.set(key, transactionId); return true; }
    this.waiting.set(transactionId, key);
    let cursor: number | undefined = owner;
    const visited = new Set<number>();
    while (cursor !== undefined && !visited.has(cursor)) {
      if (cursor === transactionId) {
        this.waiting.delete(transactionId);
        throw new Error("row-lock deadlock detected");
      }
      visited.add(cursor);
      const nextKey = this.waiting.get(cursor);
      cursor = nextKey === undefined ? undefined : this.owners.get(nextKey);
    }
    await new Promise<void>(resume => {
      const queue = this.queues.get(key) ?? [];
      queue.push({ transactionId, resume }); this.queues.set(key, queue);
    });
    this.waiting.delete(transactionId);
    return true;
  }
  release(transactionId: number): void {
    for (const [key, owner] of this.owners) {
      if (owner !== transactionId) continue;
      const next = this.queues.get(key)?.shift();
      if (next) { this.owners.set(key, next.transactionId); next.resume(); }
      else this.owners.delete(key);
    }
  }
}

type LockTransaction = ResourceReviewTransaction & { transactionId: number; publishedResource?: ResourceReviewSnapshot };
function fixture(status: ResourceReview["status"] = "pending", pauseFirstResource = true) {
  const firstHasResource = deferred(); const releaseFirst = deferred(); const secondWantsResource = deferred();
  const locks = new RowLocks(); const traces = new Map<number, string[]>();
  let transactionId = 0; let id = 0; let publishCalls = 0;
  const resource: ResourceReviewSnapshot = { resourceId: "resource", revision: 1, contentHash: "hash", recordedBy: "editor",
    officialUrl: "https://tools.example/tool", publicationStatus: "draft", validationErrors: [],
    fees: { state: "unknown", sourceUrl: null }, license: { state: "unknown", sourceUrl: null }, publishedVersion: null };
  let review: ResourceReview = { id: "review", resourceId: "resource", resourceRevision: 1, contentHash: "hash", recordedBy: "editor",
    revision: status === "pending" ? 1 : status === "approved" ? 2 : 3, status, createdAt: at, updatedAt: at,
    reviewedBy: status === "pending" ? null : actor.userId, reviewedAt: status === "pending" ? null : at,
    verification: status === "pending" ? null : verification, reason: status === "pending" ? null : "已核对",
    publishedVersion: status === "published" ? 1 : null, publishedAt: status === "published" ? at : null };
  const audits: ResourceReviewAudit[] = [];
  const lock = async (txId: number, key: string) => {
    if (await locks.acquire(txId, key)) traces.get(txId)!.push(key);
  };
  const repository: ResourceReviewRepository = {
    async transaction<T>(work: (tx: ResourceReviewTransaction) => Promise<T>): Promise<T> {
      const txId = ++transactionId; traces.set(txId, []);
      let changed: ResourceReview | undefined; const pendingAudits: ResourceReviewAudit[] = [];
      const tx: LockTransaction = {
        transactionId: txId, query: async () => ({ rows: [], rowCount: 0 }),
        getReview: async (reviewId, shouldLock = true) => {
          if (shouldLock) await lock(txId, `review:${reviewId}`);
          else traces.get(txId)!.push(`peek:${reviewId}`);
          const current = changed ?? review;
          return current.id === reviewId ? structuredClone(current) : null;
        },
        findReview: async (resourceId, revision) => {
          const current = changed ?? review;
          if (current.resourceId !== resourceId || current.resourceRevision !== revision) return null;
          await lock(txId, `review:${current.id}`);
          return structuredClone(changed ?? review);
        },
        insertReview: async value => { await lock(txId, `review:${value.id}`); changed = value; },
        saveReview: async (value, expectedRevision) => {
          await lock(txId, `review:${value.id}`);
          if ((changed ?? review).revision !== expectedRevision) throw new DomainError("VERSION_CONFLICT", "已更新", { status: 409 });
          changed = structuredClone(value);
        },
        appendAudit: async audit => { pendingAudits.push(audit); },
        findWithdrawal: async () => null, lockWithdrawal: async () => {},
      };
      try {
        const result = await work(tx);
        if (changed) review = changed;
        if (tx.publishedResource) Object.assign(resource, tx.publishedResource);
        audits.push(...pendingAudits);
        return result;
      } finally { locks.release(txId); }
    },
    listReviews: async () => [structuredClone(review)],
  };
  const service = new ResourceReviewService({ repository, clock: { now: () => new Date(at) }, ids: { next: () => `id-${++id}` },
    resources: {
      readForReview: async (sql, resourceId) => {
        const tx = sql as LockTransaction;
        if (tx.transactionId === 2) secondWantsResource.resolve();
        await lock(tx.transactionId, `resource:${resourceId}`);
        if (pauseFirstResource && tx.transactionId === 1) { firstHasResource.resolve(); await releaseFirst.promise; }
        return resourceId === resource.resourceId ? structuredClone(resource) : null;
      },
      publishReviewed: async (sql, input) => {
        const tx = sql as LockTransaction;
        await lock(tx.transactionId, `resource:${input.resourceId}`);
        // The M09 adapter reads M08 approval after locking its resource row.
        const approved = await tx.getReview("review");
        assert.equal(approved?.status, "approved"); assert.equal(approved?.contentHash, input.expectedContentHash);
        publishCalls++;
        tx.publishedResource = { ...resource, revision: resource.revision + 1, publicationStatus: "published", publishedVersion: 1 };
        return { resourceId: input.resourceId, publishedVersion: 1 };
      },
      withdraw: async () => { throw new Error("not used"); },
    } });
  return { service, traces, firstHasResource, releaseFirst, secondWantsResource, audits,
    holdResource: () => repository.transaction(async sql => {
      const tx = sql as LockTransaction;
      await lock(tx.transactionId, "resource:resource"); firstHasResource.resolve(); await releaseFirst.promise;
    }),
    getReview: () => review, replaceReview: (next: ResourceReview) => { review = next; }, publishCalls: () => publishCalls };
}

test("the concurrent row-lock fixture rejects a resource/review wait-for cycle", async () => {
  const locks = new RowLocks();
  await locks.acquire(1, "resource"); await locks.acquire(2, "review");
  const waiting = locks.acquire(2, "resource");
  await assert.rejects(locks.acquire(1, "review"), /row-lock deadlock detected/);
  locks.release(1); await waiting; locks.release(2);
});

for (const action of ["detail", "decide", "publish"] as const) {
  test(`concurrent resource registration and ${action} finish with resource-before-review locks`, { timeout: 5000 }, async () => {
    const f = fixture(action === "publish" ? "approved" : "pending");
    const registration = f.service.register(actor, { resourceId: "resource", expectedResourceRevision: 1 }, "register");
    await f.firstHasResource.promise;
    const other = action === "detail" ? f.service.getDetail(actor, "review")
      : action === "decide" ? f.service.decide(actor, "review", { expectedRevision: 1, expectedResourceRevision: 1, decision: "approved", reason: "已核对", verification }, "decide")
      : f.service.publish(actor, "review", { expectedRevision: 2, expectedResourceRevision: 1 }, "publish");
    await f.secondWantsResource.promise;
    f.releaseFirst.resolve();
    await Promise.all([registration, other]);
    assert.deepEqual(f.traces.get(1), ["resource:resource", "review:review"]);
    assert.deepEqual(f.traces.get(2), ["peek:review", "resource:resource", "review:review"]);
    assert.equal(f.getReview().status, action === "detail" ? "pending" : action === "decide" ? "approved" : "published");
    assert.equal(f.publishCalls(), action === "publish" ? 1 : 0);
  });
}

test("a review rebound after the nonlocking peek cannot approve the previously locked resource", { timeout: 5000 }, async () => {
  const f = fixture();
  const holding = f.holdResource();
  await f.firstHasResource.promise;
  const decision = f.service.decide(actor, "review", { expectedRevision: 1, expectedResourceRevision: 1, decision: "approved", reason: "已核对", verification }, "decide");
  const rejected = assert.rejects(decision, error => error instanceof DomainError && error.code === "VERSION_CONFLICT");
  await f.secondWantsResource.promise;
  f.replaceReview({ ...f.getReview(), resourceId: "different-resource" });
  f.releaseFirst.resolve();
  await Promise.all([holding, rejected]);
  assert.equal(f.getReview().status, "pending"); assert.equal(f.audits.some(audit => audit.action === "resource_approved"), false);
});

test("a decision checks the latest locked revision after waiting for the resource", { timeout: 5000 }, async () => {
  const f = fixture();
  const registration = f.service.register(actor, { resourceId: "resource", expectedResourceRevision: 1 }, "register");
  await f.firstHasResource.promise;
  const decision = f.service.decide(actor, "review", { expectedRevision: 1, expectedResourceRevision: 1, decision: "approved", reason: "已核对", verification }, "decide");
  const rejected = assert.rejects(decision, error => error instanceof DomainError && error.code === "VERSION_CONFLICT" && error.latestRevision === 2);
  await f.secondWantsResource.promise;
  f.replaceReview({ ...f.getReview(), revision: 2, status: "rejected", reason: "另一审核人先完成" });
  f.releaseFirst.resolve();
  await Promise.all([registration, rejected]);
  assert.equal(f.getReview().status, "rejected"); assert.equal(f.audits.length, 0);
});

test("a committed historical publication retry only reads immutable review metadata", async () => {
  const f = fixture("published", false);
  const published = await f.service.publish(actor, "review", { expectedRevision: 2, expectedResourceRevision: 1 }, "retry");
  assert.equal(published.status, "published"); assert.deepEqual(f.traces.get(1), ["peek:review"]);
  assert.equal(f.publishCalls(), 0); assert.equal(f.audits.length, 0);
});
