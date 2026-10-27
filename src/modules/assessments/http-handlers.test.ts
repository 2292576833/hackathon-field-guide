import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { createAssessmentHttpHandlers } from "./http-handlers.ts";
import type { AssessmentService } from "./service.ts";

const actor: Actor = { userId: "session-author", platformRoles: ["user"] };
function fixture(methods: Partial<AssessmentService> = {}, signedIn = true) {
  let nextId = 0;
  return createAssessmentHttpHandlers({ service: methods as AssessmentService, resolveActor: async () => signedIn ? actor : null, requestIds: { next: () => `request-${++nextId}` } });
}
function request(data: unknown, headers: Record<string, string> = {}) {
  return new Request("https://field.example/api/v1/assessment-attempts/attempt/submit", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(data) });
}
test("handler gets actor from verified session and rejects caller identity fields", async () => {
  let calls = 0;
  const handlers = fixture({ createAttempt: async (resolved, projectId, questionSetId) => {
    calls += 1; assert.equal(resolved, actor); assert.equal(projectId, "project-from-route"); assert.equal(questionSetId, "published-set");
    return { id: "attempt" } as never;
  } });
  const spoof = await handlers.createAttempt(request({ questionSetId: "published-set", userId: "manager", role: "manager" }), { projectId: "project-from-route" });
  assert.equal(spoof.status, 422); assert.equal(calls, 0);
  const result = await handlers.createAttempt(request({ questionSetId: "published-set" }), { projectId: "project-from-route" });
  assert.equal(result.status, 201); assert.equal(calls, 1); assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(await result.json(), { data: { id: "attempt" }, requestId: "request-2" });
});
test("no verified session means no service call", async () => {
  const result = await fixture({}, false).summaries(new Request("https://field.example/api/v1/projects/p/assessment-summaries"), { projectId: "p" });
  assert.equal(result.status, 401); assert.equal((await result.json()).error.code, "UNAUTHENTICATED");
});
test("submit returns queued state with 202 and enforces idempotency header", async () => {
  let calls = 0;
  const handlers = fixture({ submitAttempt: async (resolved, attemptId, expectedRevision, idempotencyKey) => {
    calls += 1; assert.equal(resolved, actor); assert.equal(attemptId, "attempt"); assert.equal(expectedRevision, 2); assert.equal(idempotencyKey, "submit-once");
    return { id: "job", status: "queued" } as never;
  } });
  const missing = await handlers.submitAttempt(request({ expectedRevision: 2 }), { attemptId: "attempt" });
  assert.equal(missing.status, 422); assert.equal(calls, 0);
  const queued = await handlers.submitAttempt(request({ expectedRevision: 2 }, { "Idempotency-Key": "submit-once" }), { attemptId: "attempt" });
  assert.equal(queued.status, 202); assert.equal((await queued.json()).data.status, "queued"); assert.equal(calls, 1);
});
test("errors preserve conflict recovery without disclosing stack/provider output", async () => {
  const conflict = await fixture({ getAssignment: async () => { throw new DomainError("VERSION_CONFLICT", "分工已更新。", { status: 409, latestRevision: 5, recoveryAction: "review_latest_version" }); } }).assignment(new Request("https://field.example/x"), { assignmentId: "a" });
  assert.equal(conflict.status, 409);
  assert.deepEqual((await conflict.json()).error, { code: "VERSION_CONFLICT", message: "分工已更新。", latestRevision: 5, recoveryAction: "review_latest_version" });
  const failure = await fixture({ getAssignment: async () => { throw new Error("provider-token-and-private-answer"); } }).assignment(new Request("https://field.example/x"), { assignmentId: "a" });
  assert.equal(failure.status, 500); assert.ok(!(await failure.text()).includes("provider-token-and-private-answer"));
});
test("invalid JSON, media type and oversized body fail before mutation", async () => {
  const handlers = fixture({ createAttempt: async () => { assert.fail("invalid input reached service"); } });
  const wrongMedia = new Request("https://field.example/x", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
  assert.equal((await handlers.createAttempt(wrongMedia, { projectId: "p" })).status, 415);
  const broken = new Request("https://field.example/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal((await handlers.createAttempt(broken, { projectId: "p" })).status, 422);
  assert.equal((await handlers.createAttempt(request({ questionSetId: "a".repeat(270000) }), { projectId: "p" })).status, 413);
});
