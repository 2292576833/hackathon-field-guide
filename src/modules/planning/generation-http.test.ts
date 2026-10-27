import test from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { createPlanningGenerationHandlers } from "./generation-http.ts";
import { manager, member, outsider } from "./testing/fixtures.ts";
import { generationCommand, generationSetup } from "./testing/generation-fixtures.ts";

function request(body: unknown, path = "https://example.test/planning/generation-jobs"): Request {
  return new Request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
function handlersFixture() {
  const c = generationSetup(); let actor: Actor | null = manager; let mutations = 0; let requestSequence = 0;
  const handlers = createPlanningGenerationHandlers({ service: c.service, requestIds: { next: () => `request-${++requestSequence}` }, resolveActor: async () => actor, authorizeMutation: async () => { mutations += 1; } });
  return { ...c, handlers, as: (next: Actor | null) => { actor = next; }, mutations: () => mutations };
}

test("generation HTTP requires verified login and protected mutation before queueing work", async () => {
  const c = handlersFixture(); c.as(null);
  const unsigned = await c.handlers.queueGeneration(request(generationCommand()), { projectId: "p1" });
  assert.equal(unsigned.status, 401); assert.equal((await unsigned.json()).error.code, "UNAUTHENTICATED");
  assert.equal(c.mutations(), 0); assert.equal(c.jobs.jobs.size, 0);
  const blocked = createPlanningGenerationHandlers({ service: c.service, requestIds: { next: () => "csrf" }, resolveActor: async () => manager, authorizeMutation: async () => { throw new DomainError("FORBIDDEN", "同源校验失败。", { status: 403 }); } });
  const rejected = await blocked.queueGeneration(request(generationCommand()), { projectId: "p1" });
  assert.equal(rejected.status, 403); assert.equal(c.jobs.jobs.size, 0);
  const method = await c.handlers.queueGeneration(new Request("https://example.test/planning"), { projectId: "p1" });
  assert.equal(method.status, 405); assert.equal(c.jobs.jobs.size, 0);
});

test("queue returns a durable 202 job without invoking the model, and current project members can inspect it", async () => {
  const c = handlersFixture();
  const response = await c.handlers.queueGeneration(request(generationCommand()), { projectId: "p1" });
  assert.equal(response.status, 202); assert.equal(response.headers.get("cache-control"), "private, no-store");
  const result = await response.json();
  assert.equal(result.data.status, "queued"); assert.equal(result.data.actorId, manager.userId);
  assert.equal(result.requestId, "request-1"); assert.equal(c.mutations(), 1);
  assert.equal(c.provider.calls(), 0); assert.equal(c.repository.state, null);
  c.as(member);
  const detail = await c.handlers.getGenerationJob(new Request("https://example.test/planning/job"), { projectId: "p1", jobId: result.data.id });
  assert.equal(detail.status, 200); assert.equal((await detail.json()).data.id, result.data.id);
  const list = await c.handlers.listGenerationJobs(new Request("https://example.test/planning/jobs"), { projectId: "p1" });
  assert.equal(list.status, 200); assert.equal((await list.json()).data.length, 1); assert.equal(c.mutations(), 1);
  assert.deepEqual(Object.keys(c.handlers).sort(), ["cancelGeneration", "getGenerationJob", "listGenerationJobs", "queueGeneration", "retryGeneration"]);
});

test("HTTP rejects caller identities, model configuration, factual versions, success claims and oversized JSON", async () => {
  const c = handlersFixture();
  for (const extra of [{ userId: manager.userId }, { actorId: manager.userId }, { modelVersion: "fake-model" }, { requirementVersionId: "rv1" }, { status: "succeeded" }, { snapshot: {} }, { resourceContentRefs: [{ resourceId: "tool", version: 1 }] }]) {
    const response = await c.handlers.queueGeneration(request({ ...generationCommand(), ...extra }), { projectId: "p1" });
    assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "INVALID_INPUT");
  }
  const invalidJson = await c.handlers.queueGeneration(new Request("https://example.test/jobs", { method: "POST", body: "{broken" }), { projectId: "p1" });
  assert.equal(invalidJson.status, 400); assert.equal((await invalidJson.json()).error.code, "INVALID_JSON");
  const large = await c.handlers.queueGeneration(new Request("https://example.test/jobs", { method: "POST", headers: { "content-length": "50001" }, body: "{}" }), { projectId: "p1" });
  assert.equal(large.status, 413); assert.equal(c.jobs.jobs.size, 0);
});

test("HTTP refuses member queueing and project outsiders cannot read job snapshots", async () => {
  const c = handlersFixture();
  const queued = await c.service.queueGeneration(manager, "p1", generationCommand());
  c.as(member);
  const forbidden = await c.handlers.queueGeneration(request(generationCommand({ idempotencyKey: "member-call" })), { projectId: "p1" });
  assert.equal(forbidden.status, 403);
  c.as(outsider);
  const hidden = await c.handlers.getGenerationJob(new Request("https://example.test/job"), { projectId: "p1", jobId: queued.id });
  assert.equal(hidden.status, 404); assert.equal((await hidden.json()).error.code, "NOT_FOUND");
  c.as(manager);
  const missingRoute = await c.handlers.getGenerationJob(new Request("https://example.test/job"), { projectId: "p1" });
  assert.equal(missingRoute.status, 400); assert.equal((await missingRoute.json()).error.code, "INVALID_ROUTE");
});

test("HTTP cancellation and retry accept only expectedRevision and preserve concurrent changes", async () => {
  const c = handlersFixture(); const first = await c.service.queueGeneration(manager, "p1", generationCommand());
  const forged = await c.handlers.cancelGeneration(request({ expectedRevision: first.revision, actorId: manager.userId }), { projectId: "p1", jobId: first.id });
  assert.equal(forged.status, 400);
  const conflict = await c.handlers.cancelGeneration(request({ expectedRevision: first.revision + 10 }), { projectId: "p1", jobId: first.id });
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.latestRevision, first.revision);
  assert.equal((await c.jobs.read(first.id))?.status, "queued");
  const cancelled = await c.handlers.cancelGeneration(request({ expectedRevision: first.revision }), { projectId: "p1", jobId: first.id });
  assert.equal(cancelled.status, 200); assert.equal((await cancelled.json()).data.status, "cancelled");
  const second = await c.service.queueGeneration(manager, "p1", generationCommand({ idempotencyKey: "retry-job" }));
  c.provider.setHook(async () => { throw new Error("provider failure"); });
  const failed = await c.service.processGenerationJob(second.id);
  const retry = await c.handlers.retryGeneration(request({ expectedRevision: failed.revision }), { projectId: "p1", jobId: second.id });
  assert.equal(retry.status, 200); assert.equal((await retry.json()).data.status, "queued");
  assert.equal(c.provider.calls(), 1); assert.equal(c.repository.state, null);
});

test("HTTP errors carry request IDs and hide provider or session exception details", async () => {
  const c = generationSetup();
  const handlers = createPlanningGenerationHandlers({ service: c.service, requestIds: { next: () => "safe-request" }, resolveActor: async () => { throw new Error("secret session token and provider credentials"); }, authorizeMutation: async () => {} });
  const response = await handlers.listGenerationJobs(new Request("https://example.test/jobs"), { projectId: "p1" });
  assert.equal(response.status, 500); assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  assert.equal(body.error.code, "INTERNAL_ERROR"); assert.equal(body.requestId, "safe-request");
  assert.equal(JSON.stringify(body).includes("credentials"), false);
});
