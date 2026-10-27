import test from "node:test";
import assert from "node:assert/strict";
import { createPlanningHandlers } from "./http.ts";
import { parseRestorePlanCommand } from "./restore-command.ts";
import { manager, member, setup } from "./testing/fixtures.ts";
import type { PlanVersion } from "./types.ts";

async function historicalFixture() {
  const c = setup();
  const apply = async (plan: PlanVersion) => c.service.apply(manager, "p1", plan.id, { expectedRevision: plan.revision, acknowledgedIssueCodes: [...new Set(plan.validation?.issues.map(issue => issue.code) ?? [])], idempotencyKey: `apply-${plan.id}` });
  const first = await c.service.createDraft(manager, "p1", c.draft());
  await apply(first);
  const second = await c.service.createDraft(manager, "p1", c.draft({ expectedTasksRevision: c.repository.state!.tasksRevision, basePlanVersionId: first.id, tasks: c.draft().tasks.map(task => task.id === "integration" ? { ...task, title: "新的集成安排" } : task) }));
  await apply(second);
  const command = () => ({ reason: "回到原范围并重新核对", expectedTasksRevision: c.repository.state!.tasksRevision, basePlanVersionId: second.id, idempotencyKey: "restore-original" });
  return { ...c, first, second, command };
}
function request(command: unknown, method = "POST") { return new Request("https://example.test/restore", { method, ...(method === "POST" ? { body: JSON.stringify(command) } : {}) }); }

test("restore parser accepts only baseline and reason; server alone chooses historical tasks", () => {
  const command = { reason: "重新核对", expectedTasksRevision: 2, basePlanVersionId: "p2", idempotencyKey: "restore" };
  assert.deepEqual(parseRestorePlanCommand(command), command);
  for (const extra of [{ tasks: [] }, { buffers: [] }, { userId: "manager" }, { status: "applied" }, { historicalPlanId: "other" }]) assert.throws(() => parseRestorePlanCommand({ ...command, ...extra }), { code: "INVALID_INPUT" });
  assert.throws(() => parseRestorePlanCommand({ ...command, expectedTasksRevision: -1 }), { code: "INVALID_INPUT" });
  assert.throws(() => parseRestorePlanCommand({ ...command, reason: " " }), { code: "INVALID_INPUT" });
});

test("restore HTTP saves a checked new draft without applying, preserving completed evidence", async () => {
  const c = await historicalFixture();
  for (const status of ["in_progress", "review", "done"] as const) {
    const task = c.repository.state!.tasks.find(item => item.id === "t1")!;
    await c.service.updateProgress(manager, "p1", task.id, { expectedRevision: task.revision, status, remainingEstimate: null, blocker: null, evidenceRefs: ["https://example.test/checked-work"], note: "按验收条件核对成果", idempotencyKey: `progress-${status}` });
  }
  const before = structuredClone(c.repository.state!);
  c.facts.availability[0]!.version += 1;
  c.facts.availabilityVersions.pm1 += 1;
  let mutations = 0;
  const handlers = createPlanningHandlers({ service: c.service, resolveActor: async () => manager, requestIds: { next: () => "restore-request" }, authorizeMutation: async () => { mutations += 1; } });
  const response = await handlers.restoreAsDraft(request(c.command()), { projectId: "p1", planId: c.first.id });
  assert.equal(response.status, 201);
  const result = (await response.json()).data as PlanVersion;
  assert.notEqual(result.id, c.first.id);
  assert.notEqual(result.status, "applied");
  assert.equal(result.inputSnapshot.availabilityVersions.pm1, c.facts.availabilityVersions.pm1);
  assert.deepEqual(result.tasks.find(task => task.id === "t1")!.acceptance, before.tasks.find(task => task.id === "t1")!.acceptance);
  assert.equal(result.tasks.find(task => task.id === "t1")!.status, "done");
  assert.equal(c.repository.state!.currentPlanVersionId, c.second.id);
  assert.deepEqual(c.repository.state!.tasks, before.tasks);
  assert.equal(c.repository.state!.tasksRevision, before.tasksRevision);
  assert.equal(mutations, 1);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("restore rejects unauthenticated users, members, GET and forged task definitions", async () => {
  const c = await historicalFixture();
  const before = structuredClone(c.repository.state);
  let actor: typeof manager | null = null;
  let mutations = 0;
  const handlers = createPlanningHandlers({ service: c.service, resolveActor: async () => actor, requestIds: { next: () => "r" }, authorizeMutation: async () => { mutations += 1; } });
  const params = { projectId: "p1", planId: c.first.id };
  assert.equal((await handlers.restoreAsDraft(request(c.command()), params)).status, 401);
  assert.equal((await handlers.restoreAsDraft(request(null, "GET"), params)).status, 405);
  assert.equal(mutations, 0);
  actor = member;
  assert.equal((await handlers.restoreAsDraft(request(c.command()), params)).status, 403);
  actor = manager;
  assert.equal((await handlers.restoreAsDraft(request({ ...c.command(), tasks: [] }), params)).status, 400);
  assert.deepEqual(c.repository.state, before);
});

test("restore checks current task baseline and rolls back when manager permission changes inside lock", async () => {
  const c = await historicalFixture();
  const before = structuredClone(c.repository.state), events = structuredClone(c.repository.events);
  const handlers = createPlanningHandlers({ service: c.service, resolveActor: async () => manager, requestIds: { next: () => "r" }, authorizeMutation: async () => {} });
  const params = { projectId: "p1", planId: c.first.id };
  assert.equal((await handlers.restoreAsDraft(request({ ...c.command(), expectedTasksRevision: 0 }), params)).status, 409);
  c.setLockHook(() => { c.facts.members[0] = { ...c.facts.members[0]!, role: "member" }; });
  assert.equal((await handlers.restoreAsDraft(request(c.command()), params)).status, 403);
  assert.deepEqual(c.repository.state, before);
  assert.deepEqual(c.repository.events, events);
});

test("restore blocks a space archived during fact locking without committing a draft", async () => {
  const c = await historicalFixture();
  const before = structuredClone(c.repository.state), events = structuredClone(c.repository.events);
  c.setLockHook(() => { c.facts.projectArchived = true; });
  const handlers = createPlanningHandlers({ service: c.service, resolveActor: async () => manager, requestIds: { next: () => "r" }, authorizeMutation: async () => {} });
  const response = await handlers.restoreAsDraft(request(c.command()), { projectId: "p1", planId: c.first.id });
  assert.equal(response.status, 409);
  assert.deepEqual(c.repository.state, before);
  assert.deepEqual(c.repository.events, events);
});

test("concurrent duplicate restore requests save one draft and one outbox event", async () => {
  const c = await historicalFixture();
  const plans = c.repository.state!.plans.length, events = c.repository.events.length;
  const command = c.command();
  const handlers = createPlanningHandlers({ service: c.service, resolveActor: async () => manager, requestIds: { next: () => "r" }, authorizeMutation: async () => {} });
  const params = { projectId: "p1", planId: c.first.id };
  const responses = await Promise.all([handlers.restoreAsDraft(request(command), params), handlers.restoreAsDraft(request(command), params)]);
  assert.deepEqual(responses.map(response => response.status), [201, 201]);
  const ids = await Promise.all(responses.map(async response => (await response.json()).data.id));
  assert.equal(ids[0], ids[1]);
  assert.equal(c.repository.state!.plans.length, plans + 1);
  assert.equal(c.repository.events.length, events + 1);
});
