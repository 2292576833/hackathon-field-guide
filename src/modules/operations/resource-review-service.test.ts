import test from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { ResourceReview, ResourceReviewAudit, ResourceReviewRepository, ResourceReviewSnapshot, ResourceReviewTransaction, ResourceVerification } from "./resource-review-types.ts";
import { ResourceReviewService } from "./resource-review-service.ts";

const reviewer: Actor = { userId: "editor", platformRoles: ["reviewer"] };
const otherReviewer: Actor = { userId: "another-editor", platformRoles: ["reviewer"] };
const user: Actor = { userId: "user", platformRoles: ["user"] };
const verified: ResourceVerification = {
  link: { status: "available", checkedUrl: "https://tools.example/tool" },
  fees: { status: "unknown", sourceUrl: null },
  license: { status: "verified", sourceUrl: "https://tools.example/LICENSE" },
};
type FixtureTransaction = ResourceReviewTransaction & { resource: ResourceReviewSnapshot };
function fixture() {
  let id = 0;
  const store = {
    resource: { resourceId: "r1", revision: 1, contentHash: "hash1", recordedBy: "editor",
      officialUrl: "https://tools.example/tool", publicationStatus: "draft", validationErrors: [],
      fees: { state: "unknown", sourceUrl: null }, license: { state: "known", sourceUrl: "https://tools.example/LICENSE" }, publishedVersion: null } as ResourceReviewSnapshot,
    reviews: new Map<string, ResourceReview>(), audits: [] as ResourceReviewAudit[],
    publishCalls: 0, withdrawCalls: 0, failAudit: false, publishResultVersion: 1,
  };
  let tail = Promise.resolve();
  const repository: ResourceReviewRepository = {
    async transaction<T>(work: (tx: ResourceReviewTransaction) => Promise<T>): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      const reviews = structuredClone(store.reviews);
      const audits = structuredClone(store.audits);
      const tx: FixtureTransaction = {
        resource: structuredClone(store.resource), query: async () => ({ rows: [], rowCount: 0 }),
        getReview: async reviewId => reviews.get(reviewId) ?? null,
        findReview: async (resourceId, version) => [...reviews.values()].find(r => r.resourceId === resourceId && r.resourceRevision === version) ?? null,
        insertReview: async review => { reviews.set(review.id, review); },
        saveReview: async (review, expected) => {
          if (reviews.get(review.id)?.revision !== expected) throw new DomainError("VERSION_CONFLICT", "冲突", { status: 409 });
          reviews.set(review.id, review);
        },
        appendAudit: async audit => {
          if (store.failAudit && audit.action === "resource_published") throw new Error("audit failure");
          audits.push(audit);
        },
        findWithdrawal: async (actorId, operationId) => audits.find(a => a.actorId === actorId && a.operationId === operationId) ?? null,
        lockWithdrawal: async () => {},
      };
      try {
        const result = await work(tx);
        store.reviews = reviews; store.audits = audits; store.resource = tx.resource;
        return result;
      } finally { release(); }
    },
    listReviews: async status => [...store.reviews.values()].filter(r => !status || r.status === status),
  };
  const service = new ResourceReviewService({ repository, clock: { now: () => new Date("2026-10-08T08:00:00Z") }, ids: { next: () => `id-${++id}` },
    resources: {
      readForReview: async (tx, resourceId) => resourceId === "r1" ? (tx as FixtureTransaction).resource : null,
      publishReviewed: async (tx, input) => {
        const current = (tx as FixtureTransaction).resource;
        assert.equal(input.expectedRevision, current.revision); assert.equal(input.expectedContentHash, current.contentHash);
        assert.equal(input.reviewOperationId, `resource-review:${[...store.reviews.values()][0]!.id}:publish`);
        store.publishCalls++;
        (tx as FixtureTransaction).resource = { ...current, revision: current.revision + 1, publicationStatus: "published", publishedVersion: 1 };
        return { resourceId: current.resourceId, publishedVersion: store.publishResultVersion };
      },
      withdraw: async (tx, input) => {
        const current = (tx as FixtureTransaction).resource;
        assert.equal(input.expectedRevision, current.revision); assert.equal(input.expectedPublishedVersion, current.publishedVersion);
        store.withdrawCalls++;
        (tx as FixtureTransaction).resource = { ...current, revision: current.revision + 1, publicationStatus: "withdrawn" };
        return { resourceId: current.resourceId, publishedVersion: current.publishedVersion! };
      },
    } });
  async function approve() {
    const registered = await service.register(reviewer, { resourceId: "r1", expectedResourceRevision: 1 }, "req");
    return service.decide(reviewer, registered.id, { expectedRevision: 1, expectedResourceRevision: 1, decision: "approved", reason: "链接与许可已核对，费用未说明", verification: verified }, "req");
  }
  return { store, service, approve };
}
function code(expected: string) { return (error: unknown) => error instanceof DomainError && error.code === expected; }

test("resource audit records a single operator's recording and approval; unknown fees remain allowed", async () => {
  const { store, service, approve } = fixture();
  const approved = await approve();
  assert.equal(approved.verification?.fees.status, "unknown");
  const audit = store.audits.find(a => a.action === "resource_approved")!;
  assert.equal(audit.recordedBy, "editor"); assert.equal(audit.reviewedBy, "editor"); assert.equal(audit.selfReviewed, true);
  const published = await service.publish(reviewer, approved.id, { expectedRevision: 2, expectedResourceRevision: 1 }, "req");
  assert.equal(published.status, "published"); assert.equal(store.resource.publicationStatus, "published");
});
test("ordinary users cannot register, inspect review queues, publish or withdraw", async () => {
  const { service, approve } = fixture();
  const approved = await approve();
  await assert.rejects(service.register(user, { resourceId: "r1", expectedResourceRevision: 1 }, "req"), code("OPERATIONS_FORBIDDEN"));
  await assert.rejects(service.list(user), code("OPERATIONS_FORBIDDEN"));
  await assert.rejects(service.publish(user, approved.id, { expectedRevision: 2, expectedResourceRevision: 1 }, "req"), code("OPERATIONS_FORBIDDEN"));
  await assert.rejects(service.withdraw(user, { resourceId: "r1", expectedResourceRevision: 1, expectedPublishedVersion: 1, operationId: "withdraw", reason: "失效" }, "req"), code("OPERATIONS_FORBIDDEN"));
});
test("unsupported known fees cannot become approved even if reviewer claims verified", async () => {
  const { store, service } = fixture();
  store.resource = { ...store.resource, fees: { state: "known", sourceUrl: null } };
  const review = await service.register(reviewer, { resourceId: "r1", expectedResourceRevision: 1 }, "req");
  await assert.rejects(service.decide(reviewer, review.id, { expectedRevision: 1, expectedResourceRevision: 1, decision: "approved", reason: "免费", verification: { ...verified, fees: { status: "verified", sourceUrl: "https://tools.example/pricing" } } }, "req"), code("EVIDENCE_REQUIRED"));
  assert.equal(store.reviews.get(review.id)?.status, "pending");
});
test("link and exact version license source are required for approval", async () => {
  const { service } = fixture();
  const review = await service.register(reviewer, { resourceId: "r1", expectedResourceRevision: 1 }, "req");
  await assert.rejects(service.decide(reviewer, review.id, { expectedRevision: 1, expectedResourceRevision: 1, decision: "approved", reason: "核验", verification: { ...verified, link: { status: "unavailable", checkedUrl: "https://tools.example/tool" } } }, "req"), code("LINK_NOT_VERIFIED"));
  await assert.rejects(service.decide(reviewer, review.id, { expectedRevision: 1, expectedResourceRevision: 1, decision: "approved", reason: "核验", verification: { ...verified, license: { status: "verified", sourceUrl: "https://unrelated.example/LICENSE" } } }, "req"), code("EVIDENCE_REQUIRED"));
  await assert.rejects(service.decide(reviewer, review.id, { expectedRevision: 1, expectedResourceRevision: 1, decision: "rejected", reason: " " }, "req"), code("INVALID_INPUT"));
});
test("concurrent reviewers cannot overwrite the prior review", async () => {
  const { store, service } = fixture();
  const review = await service.register(reviewer, { resourceId: "r1", expectedResourceRevision: 1 }, "req");
  const input = { expectedRevision: 1, expectedResourceRevision: 1, decision: "approved" as const, reason: "核验完成", verification: verified };
  const results = await Promise.allSettled([service.decide(reviewer, review.id, input, "req1"), service.decide(otherReviewer, review.id, input, "req2")]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const failure = results.find(r => r.status === "rejected");
  assert.equal(failure?.status === "rejected" && failure.reason.code, "VERSION_CONFLICT");
  assert.equal(store.audits.filter(a => a.action === "resource_approved").length, 1);
});
test("editing a reviewed resource makes publishing fail before M09 writes", async () => {
  const { store, service, approve } = fixture();
  const approved = await approve();
  store.resource = { ...store.resource, revision: 2, contentHash: "new-content" };
  await assert.rejects(service.publish(reviewer, approved.id, { expectedRevision: 2, expectedResourceRevision: 1 }, "req"), code("VERSION_CONFLICT"));
  assert.equal(store.publishCalls, 0);
});
test("publication and audit roll back together; retry of committed publish makes no second write", async () => {
  const { store, service, approve } = fixture();
  const approved = await approve();
  store.failAudit = true;
  await assert.rejects(service.publish(reviewer, approved.id, { expectedRevision: 2, expectedResourceRevision: 1 }, "req"), /audit failure/);
  assert.equal(store.resource.publicationStatus, "draft"); assert.equal(store.reviews.get(approved.id)?.status, "approved");
  store.failAudit = false;
  await service.publish(reviewer, approved.id, { expectedRevision: 2, expectedResourceRevision: 1 }, "req");
  const calls = store.publishCalls;
  const retry = await service.publish(reviewer, approved.id, { expectedRevision: 2, expectedResourceRevision: 1 }, "req");
  assert.equal(retry.status, "published"); assert.equal(store.publishCalls, calls);
});
test("withdraw preserves history, replays the same operation and rejects key reuse with different reason", async () => {
  const { store, service, approve } = fixture();
  const approved = await approve();
  await service.publish(reviewer, approved.id, { expectedRevision: 2, expectedResourceRevision: 1 }, "req");
  const input = { resourceId: "r1", expectedResourceRevision: 2, expectedPublishedVersion: 1, operationId: "withdraw-1", reason: "官方链接失效" };
  await service.withdraw(reviewer, input, "req");
  await service.withdraw(reviewer, input, "req");
  assert.equal(store.withdrawCalls, 1); assert.equal(store.resource.publicationStatus, "withdrawn");
  assert.equal(store.reviews.get(approved.id)?.publishedVersion, 1);
  await assert.rejects(service.withdraw(reviewer, { ...input, reason: "不同理由" }, "req"), code("IDEMPOTENCY_CONFLICT"));
});
test("an old M09 publication result cannot mark a new reviewed resource published", async () => {
  const { store, service, approve } = fixture();
  store.resource = { ...store.resource, publishedVersion: 4, publicationStatus: "needs_recheck" };
  store.publishResultVersion = 4;
  const approved = await approve();
  await assert.rejects(service.publish(reviewer, approved.id, { expectedRevision: 2, expectedResourceRevision: 1 }, "req"), code("INVALID_PUBLICATION_RESULT"));
  assert.equal(store.reviews.get(approved.id)?.status, "approved");
  assert.equal(store.resource.publishedVersion, 4);
});
test("mandatory expected revisions cannot be bypassed by undefined runtime values", async () => {
  const { service, approve } = fixture();
  const approved = await approve();
  await assert.rejects(service.publish(reviewer, approved.id, { expectedRevision: undefined as unknown as number, expectedResourceRevision: 1 }, "req"), code("INVALID_INPUT"));
});
