import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../shared/errors.ts";
import type { EventsService } from "./service.ts";
import { createEventsHandlers } from "./handlers.ts";

function request(body: unknown) { return new Request("https://local.test/api/v1/projects/project-1/event", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
function handlers(service: Partial<EventsService>, user = true) {
  return createEventsHandlers({ service: service as EventsService, resolveActor: async () => user ? { userId: "session-user", platformRoles: ["user"] } : null, requestIds: { next: () => "request-1" } });
}
test("client cannot forge the actor in project confirmation JSON", async () => {
  let called = false;
  const response = await handlers({ confirmProjectRules: async () => { called = true; throw new Error(); } }).confirm(request({ eventId: "e1", rulesVersion: 1, expectedRevision: 0, userId: "manager" }), "project-1");
  assert.equal(response.status, 422);
  assert.equal(called, false);
});
test("private handlers require a trusted session and sanitize unknown failures", async () => {
  const unsigned = await handlers({}, false).projectRules(request({}), "project-1");
  assert.equal(unsigned.status, 401);
  const failed = await handlers({ getProjectRules: async () => { throw new Error("secret database password"); } }).projectRules(request({}), "project-1");
  const body = JSON.stringify(await failed.json());
  assert.equal(failed.status, 500);
  assert.ok(!body.includes("password"));
  assert.ok(body.includes("request-1"));
});
test("queue response is 202 and project ID must match the route", async () => {
  let calls = 0;
  const http = handlers({ queueAnalysis: async () => { calls++; return { id: "run-1", status: "queued" } as never; } });
  const accepted = await http.queueAnalysis(request({ input: { projectId: "project-1" }, idempotencyKey: "key-1" }), "project-1");
  assert.equal(accepted.status, 202);
  const rejected = await http.queueAnalysis(request({ input: { projectId: "project-2" }, idempotencyKey: "key-1" }), "project-1");
  assert.equal(rejected.status, 422);
  assert.equal(calls, 1);
});
test("domain conflict keeps recovery fields and does not cache private responses", async () => {
  const response = await handlers({ getProjectRules: async () => { throw new DomainError("VERSION_CONFLICT", "已变化", { status: 409, latestRevision: 3, recoveryAction: "review_latest_version" }); } }).projectRules(request({}), "project-1");
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal((await response.json()).error.latestRevision, 3);
});
