import { test } from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../../shared/errors.ts";
import type { Actor } from "../../../shared/contracts.ts";
import type { GitService } from "../git-service.ts";
import type { DeliveryService } from "../delivery-service.ts";
import { createGitHubHandler } from "../handlers.ts";

function fixture() {
  let actor: Actor | null = { userId: "session-user", platformRoles: ["user"] };
  let blocked = false; let calls = 0;
  let thrown: Error | null = null;
  const git = {
    async createDraft(resolved: Actor) { calls++; assert.equal(resolved.userId, "session-user"); return { status: "draft" }; },
    async getOperation() { calls++; if (thrown) throw thrown; return { status: "unknown" }; },
    async listOperations() { return [{ id: "op-1", createdAt: "2026-10-08T00:00:00Z", status: "saved", commitSha: "a".repeat(40) }]; },
  } as unknown as GitService;
  const delivery = { async listVerifications() { return []; }, async listSubmissions() { return []; } } as unknown as DeliveryService;
  const dependencies = { git, delivery, async resolveActor() { return actor; }, async assertMutationAllowed() { if (blocked) throw new DomainError("ORIGIN_REJECTED", "请求来源无效。", { status: 403 }); }, requestId: () => "request-1" };
  return { dependencies, state: { logout() { actor = null; }, block() { blocked = true; }, throw(error: Error) { thrown = error; }, get calls() { return calls; } } };
}
const draft = () => new Request("https://app.example.test/api/v1/projects/project-1/git-operations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ changes: [{ path: "file.txt", action: "upsert", content: "text" }], message: "save", idempotencyKey: "key-00001" }) });

test("handler obtains actor from verified session and reports draft creation without a success state", async () => {
  const f = fixture(); const response = await createGitHubHandler(f.dependencies, "operations.create")(draft(), { projectId: "project-1" });
  assert.equal(response.status, 201); assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.deepEqual(await response.json(), { data: { status: "draft" }, requestId: "request-1" });
});
test("invalid session and shared origin rejection stop the mutation before service calls", async () => {
  const f = fixture(); f.state.logout(); const handler = createGitHubHandler(f.dependencies, "operations.create");
  assert.equal((await handler(draft(), { projectId: "p" })).status, 401); assert.equal(f.state.calls, 0);
  const g = fixture(); g.state.block(); assert.equal((await createGitHubHandler(g.dependencies, "operations.create")(draft(), { projectId: "p" })).status, 403); assert.equal(g.state.calls, 0);
});
test("unknown response is 202 and injected client identity/token never reaches a service", async () => {
  const f = fixture(); const response = await createGitHubHandler(f.dependencies, "operations.get")(new Request("https://app.example.test/operation"), { projectId: "p", operationId: "op" });
  assert.equal(response.status, 202);
  const invalid = new Request("https://app.example.test/operation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: "other", token: "must-not-return" }) });
  const rejected = await createGitHubHandler(f.dependencies, "operations.create")(invalid, { projectId: "p" }); assert.equal(rejected.status, 422); assert.equal(f.state.calls, 1); assert.doesNotMatch(await rejected.text(), /must-not-return/);
});
test("unexpected exceptions cannot leak credentials or provider bodies", async () => {
  const f = fixture(); f.state.throw(new Error("Authorization: fixture-private-value"));
  const response = await createGitHubHandler(f.dependencies, "operations.get")(new Request("https://app.example.test/operation"), { projectId: "p", operationId: "op" });
  assert.equal(response.status, 500); const body = await response.text(); assert.match(body, /INTERNAL_ERROR/); assert.doesNotMatch(body, /fixture-private-value/);
});
test("repository save does not populate runtime or submission status in the summary", async () => {
  const f = fixture(); const response = await createGitHubHandler(f.dependencies, "summary")(new Request("https://app.example.test/summary"), { projectId: "p" });
  const body = await response.json(); assert.equal(body.data.repository.status, "saved"); assert.equal(body.data.repository.mergeStatus, "not_verified"); assert.equal(body.data.runtime.status, "not_verified"); assert.deepEqual(body.data.submission.records, []); assert.equal(body.data.submission.platformConfirmationAvailable, false);
});
