import test from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../../shared/contracts.ts";
import { createResourceReviewHandlers } from "./resource-review-handlers.ts";
import { ResourceReviewService } from "./resource-review-service.ts";

const actor: Actor = { userId: "verified-reviewer", platformRoles: ["reviewer"] };
function post(input: unknown): Request { return new Request("https://local.example/api/v1/admin/resources/r1/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }); }
test("resource handler ignores actor and path IDs in JSON, requires expected revisions and invokes CSRF guard", async () => {
  const service = new ResourceReviewService({ repository: { transaction: async () => { throw new Error("unused"); }, listReviews: async () => [] }, resources: { readForReview: async () => null, publishReviewed: async () => { throw new Error("unused"); }, withdraw: async () => { throw new Error("unused"); } }, clock: { now: () => new Date() }, ids: { next: () => "unused" } });
  const calls: unknown[] = []; let guarded = 0;
  service.publish = async (receivedActor, reviewId, input) => { calls.push({ actor: receivedActor, reviewId, input }); return {} as never; };
  const handlers = createResourceReviewHandlers({ service, resolveActor: async () => actor, requestId: () => "req", assertMutationAllowed: async (_request, receivedActor) => { assert.equal(receivedActor, actor); guarded++; } });
  const ok = await handlers.publish("path-review")(post({ actor: { userId: "spoofed", platformRoles: ["admin"] }, reviewId: "spoofed-review", expectedRevision: 2, expectedResourceRevision: 3 }));
  assert.equal(ok.status, 200); assert.deepEqual(calls[0], { actor, reviewId: "path-review", input: { expectedRevision: 2, expectedResourceRevision: 3 } });
  const invalid = await handlers.publish("path-review")(post({ expectedResourceRevision: 3 }));
  assert.equal(invalid.status, 422); assert.equal(calls.length, 1); assert.equal(guarded, 2);
});
