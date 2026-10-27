import test from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../../../shared/contracts.ts";
import { createRetrospectiveHandlers } from "../handlers.ts";
import { alice, bob, charlie, content, fixture, manualAnswers, ref } from "./fixtures.ts";

const request = (body: unknown, method = "POST") => new Request("https://local.test/api/v1", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
test("handlers reject unauthenticated requests and actor spoofing", async () => {
  const f = fixture();
  const anonymous = createRetrospectiveHandlers({ service: f.service, authenticate: async () => null, requestId: () => "request-1" });
  assert.equal((await anonymous.createRetrospective(request({ scope: "personal", content }), { projectId: "p1" })).status, 401);
  const authenticated = createRetrospectiveHandlers({ service: f.service, authenticate: async () => alice, requestId: () => "request-2" });
  const spoofed = await authenticated.createRetrospective(request({ userId: "bob", scope: "personal", content }), { projectId: "p1" });
  assert.equal(spoofed.status, 422);
  const response = await authenticated.createRetrospective(request({ scope: "personal", content }), { projectId: "p1" });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).data.ownerId, "alice");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});
test("malformed bodies and unsupported methods return stable errors", async () => {
  const f = fixture(), handlers = createRetrospectiveHandlers({ service: f.service, authenticate: async () => alice, requestId: () => "request-1" });
  const malformed = new Request("https://local.test", { method: "POST", headers: { "content-type": "application/json" }, body: "{broken" });
  assert.equal((await handlers.createRetrospective(malformed, { projectId: "p1" })).status, 422);
  assert.equal((await handlers.getRetrospective(request({}), { id: "hidden" })).status, 405);
});

const getRequest = () => new Request("https://local.test/api/v1", { method: "GET" });
const handlersFor = (f: ReturnType<typeof fixture>, actor: Actor) => createRetrospectiveHandlers({ service: f.service, authenticate: async () => actor, requestId: () => `request-${actor.userId}` });
const generatedAnswers = { ...manualAnswers, nextChange: "提前确定材料负责人并试上传" };
const generatedOutput = { answers: generatedAnswers, evidenceRefs: [ref], resourceIds: [], modelVersion: "test-model" };

test("HTTP generate persists a queued job without calling the model or confirming the retrospective", async () => {
  let modelCalls = 0;
  const f = fixture({ model: { async generate() { modelCalls += 1; return generatedOutput; } } });
  const handlers = handlersFor(f, alice);
  const created = await handlers.createRetrospective(request({ scope: "personal", content }), { projectId: "p1" });
  assert.equal(created.status, 201);
  const doc = (await created.json()).data;

  const queued = await handlers.generate(request({ expectedRevision: doc.revision }), { id: doc.id });
  assert.equal(queued.status, 202);
  assert.equal(queued.headers.get("cache-control"), "private, no-store");
  const job = (await queued.json()).data;
  assert.equal(job.kind, "generation_job");
  assert.equal(job.status, "queued");
  assert.equal(job.attempts, 0);
  assert.equal(job.ownerId, "alice");
  assert.equal(job.retrospectiveId, doc.id);
  assert.equal(job.inputRevision, doc.revision + 1);
  assert.deepEqual(await f.repository.get(job.id), job);
  assert.equal(modelCalls, 0);

  const queuedRetro = await f.repository.get(doc.id);
  assert.ok(queuedRetro?.kind === "retrospective");
  assert.equal(queuedRetro.status, "generating");
  assert.equal(queuedRetro.activeJobId, job.id);
  assert.deepEqual(queuedRetro.content.answers, manualAnswers);
  assert.equal(queuedRetro.generatedDraft, undefined);
  assert.equal(queuedRetro.confirmedBy, undefined);
  const polledQueued = await handlers.getGenerationJob(getRequest(), { id: job.id });
  assert.equal(polledQueued.status, 200);
  assert.equal((await polledQueued.json()).data.status, "queued");

  assert.equal((await f.service.runGeneration(job.id)).status, "succeeded");
  assert.equal(modelCalls, 1);
  const finished = await handlers.getGenerationJob(getRequest(), { id: job.id });
  assert.equal(finished.status, 200);
  assert.equal((await finished.json()).data.status, "succeeded");
  const reviewResponse = await handlers.getRetrospective(getRequest(), { id: doc.id });
  assert.equal(reviewResponse.status, 200);
  const review = (await reviewResponse.json()).data;
  assert.equal(review.status, "review_required");
  assert.deepEqual(review.document.content.answers, manualAnswers);
  assert.deepEqual(review.document.generatedDraft.answers, generatedAnswers);
  assert.equal(review.document.confirmedBy, undefined);
  assert.equal(review.document.confirmedAt, undefined);
  assert.equal(f.repository.events.some(event => event.type === "RetrospectiveConfirmed"), false);
});

test("HTTP personal generation jobs are hidden from other members and the platform admin", async () => {
  const f = fixture({ model: { async generate() { return generatedOutput; } } });
  const doc = await f.service.createRetrospective(alice, "p1", { scope: "personal", content });
  const queued = await handlersFor(f, alice).generate(request({ expectedRevision: doc.revision }), { id: doc.id });
  assert.equal(queued.status, 202);
  const job = (await queued.json()).data;
  assert.equal((await handlersFor(f, alice).getGenerationJob(getRequest(), { id: job.id })).status, 200);
  for (const actor of [charlie, bob]) {
    const hidden = await handlersFor(f, actor).getGenerationJob(getRequest(), { id: job.id });
    assert.equal(hidden.status, 404);
    const envelope = await hidden.json();
    assert.equal(envelope.error.code, "NOT_FOUND");
    assert.equal(envelope.data, undefined);
    assert.doesNotMatch(JSON.stringify(envelope), /generation_job|queued|最小演示/);
  }
});

test("HTTP sharing a source later does not expose the original private generation job", async () => {
  const f = fixture({ model: { async generate() { return generatedOutput; } } });
  const owner = handlersFor(f, alice);
  const doc = await f.service.createRetrospective(alice, "p1", { scope: "personal", content });
  const queued = await owner.generate(request({ expectedRevision: doc.revision }), { id: doc.id });
  assert.equal(queued.status, 202);
  const job = (await queued.json()).data;
  await f.service.runGeneration(job.id);
  const current = await f.repository.get(doc.id);
  assert.ok(current?.kind === "retrospective");
  const shared = await owner.updateRetrospective(request({ expectedRevision: current.revision, scope: "project" }, "PATCH"), { id: doc.id });
  assert.equal(shared.status, 200);
  assert.equal((await shared.json()).data.scope, "project");
  assert.equal((await f.repository.get(job.id))?.scope, "personal");
  for (const actor of [charlie, bob]) {
    const handlers = handlersFor(f, actor);
    assert.equal((await handlers.getRetrospective(getRequest(), { id: doc.id })).status, 200);
    const hidden = await handlers.getGenerationJob(getRequest(), { id: job.id });
    assert.equal(hidden.status, 404);
    assert.equal((await hidden.json()).error.code, "NOT_FOUND");
  }
  const ownJob = await owner.getGenerationJob(getRequest(), { id: job.id });
  assert.equal(ownJob.status, 200);
  assert.equal((await ownJob.json()).data.status, "succeeded");
});

test("HTTP project generation jobs become unreadable when a member or the job owner leaves", async () => {
  const f = fixture({ model: { async generate() { return generatedOutput; } } });
  const doc = await f.service.createRetrospective(alice, "p1", { scope: "project", content });
  const queued = await handlersFor(f, alice).generate(request({ expectedRevision: doc.revision }), { id: doc.id });
  assert.equal(queued.status, 202);
  const job = (await queued.json()).data;
  for (const actor of [charlie, alice]) {
    const handlers = handlersFor(f, actor);
    assert.equal((await handlers.getGenerationJob(getRequest(), { id: job.id })).status, 200);
    f.memberships.set(`p1:${actor.userId}`, { ...f.memberships.get(`p1:${actor.userId}`)!, status: "left" });
    const denied = await handlers.getGenerationJob(getRequest(), { id: job.id });
    assert.equal(denied.status, 403);
    const envelope = await denied.json();
    assert.equal(envelope.error.code, "FORBIDDEN");
    assert.equal(envelope.data, undefined);
  }
  assert.equal((await handlersFor(f, bob).getGenerationJob(getRequest(), { id: job.id })).status, 200);
});

test("HTTP generate strictly rejects impersonated actor fields without creating a job", async () => {
  let modelCalls = 0;
  const f = fixture({ model: { async generate() { modelCalls += 1; return generatedOutput; } } });
  const doc = await f.service.createRetrospective(alice, "p1", { scope: "personal", content });
  const handlers = handlersFor(f, alice);
  const eventsBefore = f.repository.events.length;
  for (const extra of [{ actor: bob }, { userId: "bob" }, { ownerId: "bob" }, { platformRoles: ["admin"] }, { scope: "project" }]) {
    const rejected = await handlers.generate(request({ expectedRevision: doc.revision, ...extra }), { id: doc.id });
    assert.equal(rejected.status, 422);
    assert.equal((await rejected.json()).error.code, "INVALID_INPUT");
  }
  assert.equal(f.repository.documents.size, 1);
  assert.deepEqual(await f.repository.get(doc.id), doc);
  assert.equal(f.repository.events.length, eventsBefore);
  assert.equal(modelCalls, 0);
});

test("HTTP generate requires a current expectedRevision and stale retries do not enqueue twice", async () => {
  let modelCalls = 0;
  const f = fixture({ model: { async generate() { modelCalls += 1; return generatedOutput; } } });
  const doc = await f.service.createRetrospective(alice, "p1", { scope: "personal", content });
  const handlers = handlersFor(f, alice);
  for (const body of [{}, { expectedRevision: "1" }, { expectedRevision: 0 }]) {
    const invalid = await handlers.generate(request(body), { id: doc.id });
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).error.code, "INVALID_INPUT");
  }
  assert.equal(f.repository.documents.size, 1);
  const queued = await handlers.generate(request({ expectedRevision: doc.revision }), { id: doc.id });
  assert.equal(queued.status, 202);
  const firstJob = (await queued.json()).data;
  const retry = await handlers.generate(request({ expectedRevision: doc.revision }), { id: doc.id });
  assert.equal(retry.status, 409);
  assert.equal((await retry.json()).error.code, "VERSION_CONFLICT");
  assert.equal([...f.repository.documents.values()].filter(document => document.kind === "generation_job").length, 1);
  assert.deepEqual(await f.repository.get(firstJob.id), firstJob);
  assert.equal(modelCalls, 0);
});
