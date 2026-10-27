import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../shared/errors.ts";
import { createPlanningHandlers } from "./http.ts";
import { parseDraftCommand, parseDurationEstimate } from "./parse.ts";
import { manager, setup } from "./testing/fixtures.ts";

test("request parsers reject caller identity, fake accepted progress and unordered estimates", () => {
  const c = setup();
  assert.throws(() => parseDraftCommand({ ...c.draft(), userId: "manager" }), DomainError);
  const draft = c.draft();
  assert.throws(() => parseDraftCommand({ ...draft, tasks: draft.tasks.map(task => ({ ...task, acceptance: { acceptedByUserId: "manager" } })) }), DomainError);
  assert.throws(() => parseDurationEstimate({ optimisticMinutes: 30, likelyMinutes: 20, pessimisticMinutes: 50, basis: "估算" }), DomainError);
});
test("HTTP factory binds verified session and requires mutation protection", async () => {
  const c = setup(); let counter = 0; let authenticated = false; let mutations = 0;
  const handlers = createPlanningHandlers({ service: c.service, requestIds: { next: () => `request-${++counter}` }, resolveActor: async () => authenticated ? manager : null, authorizeMutation: async () => { mutations += 1; } });
  const unauthorized = await handlers.getCurrent(new Request("https://example.test/plan"), { projectId: "p1" });
  assert.equal(unauthorized.status, 401); assert.equal((await unauthorized.json()).error.code, "UNAUTHENTICATED");
  authenticated = true;
  const response = await handlers.createDraft(new Request("https://example.test/plan", { method: "POST", body: JSON.stringify(c.draft()) }), { projectId: "p1" });
  assert.equal(response.status, 201); assert.equal(mutations, 1);
  assert.equal((await response.json()).data.status, "ready");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});
test("HTTP errors retain requestId and never expose unknown exception details", async () => {
  const c = setup();
  const handlers = createPlanningHandlers({ service: c.service, requestIds: { next: () => "req" }, resolveActor: async () => { throw new Error("private database credentials"); }, authorizeMutation: async () => {} });
  const response = await handlers.getCurrent(new Request("https://example.test/plan"), { projectId: "p1" });
  assert.equal(response.status, 500); assert.equal((await response.text()).includes("credentials"), false);
});
