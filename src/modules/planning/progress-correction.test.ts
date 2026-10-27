import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../shared/errors.ts";
import { diffPlanInputs } from "./diff.ts";
import { parseAcceptanceCorrectionCommand } from "./parse.ts";
import { versionsEqual, type AcceptanceCorrectionCommand, type ProgressCommand } from "./service.ts";
import { createPlanningHandlers } from "./http.ts";
import { manager, member, outsider, setup } from "./testing/fixtures.ts";

function code(expected: string) { return (error: unknown) => error instanceof DomainError && error.code === expected; }
const command = (revision: number, status: ProgressCommand["status"], idempotencyKey: string): ProgressCommand => ({ expectedRevision: revision, status, remainingEstimate: null, blocker: null, note: "真实成果说明", evidenceRefs: ["artifact:result"], idempotencyKey });
async function applied() {
  const c = setup(); const plan = await c.service.createDraft(manager, "p1", c.draft());
  await c.service.apply(manager, "p1", plan.id, { expectedRevision: 0, acknowledgedIssueCodes: plan.validation!.issues.map(issue => issue.code), idempotencyKey: "apply" });
  return c;
}
async function accepted() {
  const c = await applied();
  await c.service.updateProgress(member, "p1", "t1", command(0, "review", "report"));
  const done = await c.service.updateProgress(manager, "p1", "t1", command(1, "done", "accepted"));
  const correction = (changes: Partial<AcceptanceCorrectionCommand> = {}): AcceptanceCorrectionCommand => ({ expectedRevision: 2, expectedTasksRevision: c.repository.state!.tasksRevision, correctionOf: done.id, correctionReason: "演示中发现核心流程未满足原检查条件", status: "review", acknowledgedDependentTaskIds: ["integration", "testing", "submission"], idempotencyKey: "correct", ...changes });
  return { ...c, done, correction };
}
test("starting a dependent task requires acceptance, not the completion report", async () => {
  const c = await applied();
  await c.service.updateProgress(member, "p1", "t1", command(0, "review", "report"));
  await assert.rejects(c.service.updateProgress(member, "p1", "integration", command(0, "in_progress", "early")), code("DEPENDENCY_NOT_ACCEPTED"));
  assert.equal(c.repository.state!.tasks.find(value => value.id === "integration")?.status, "todo");
  await c.service.updateProgress(manager, "p1", "t1", command(1, "done", "accept"));
  await c.service.updateProgress(member, "p1", "integration", command(0, "in_progress", "start"));
  assert.equal(c.repository.state!.tasks.find(value => value.id === "integration")?.status, "in_progress");
});
test("review requires a result description or evidence", async () => {
  const c = await applied();
  await assert.rejects(c.service.updateProgress(member, "p1", "t1", { ...command(0, "review", "empty"), note: "", evidenceRefs: [] }), code("DELIVERABLE_REQUIRED"));
  await c.service.updateProgress(member, "p1", "t1", { ...command(0, "review", "description"), evidenceRefs: [] });
  assert.equal(c.repository.state!.tasks[0]?.status, "review");
});
test("manager correction keeps old acceptance, revokes downstream checks and blocks active work", async () => {
  const c = await accepted();
  await c.service.updateProgress(member, "p1", "integration", command(0, "review", "integration_report"));
  await c.service.updateProgress(manager, "p1", "integration", command(1, "done", "integration_done"));
  await c.service.updateProgress(member, "p1", "testing", command(0, "in_progress", "testing_start"));
  const before = structuredClone(c.repository.state!);
  const update = await c.service.correctAcceptance(manager, "p1", "t1", c.correction());
  assert.deepEqual(update.acceptanceCorrection?.previousAcceptance, c.done.acceptance);
  assert.equal(update.acceptanceCorrection?.impactedTasks.length, 3);
  assert.equal(c.repository.state!.tasks.find(value => value.id === "integration")?.status, "review");
  assert.equal(c.repository.state!.tasks.find(value => value.id === "integration")?.acceptance, null);
  assert.equal(c.repository.state!.tasks.find(value => value.id === "testing")?.status, "blocked");
  assert.deepEqual(c.repository.state!.progressUpdates.slice(0, before.progressUpdates.length), before.progressUpdates);
  assert.equal(c.repository.state!.tasksRevision, before.tasksRevision + 1);
  assert.deepEqual(await c.service.correctAcceptance(manager, "p1", "t1", c.correction({ expectedTasksRevision: before.tasksRevision })), update);
  await assert.rejects(c.service.updateProgress(manager, "p1", "integration", command(3, "done", "early_recheck")), code("DEPENDENCY_NOT_ACCEPTED"));
});
test("correction requires manager, final writable facts, current record and complete impact acknowledgement", async () => {
  const c = await accepted(); const before = structuredClone(c.repository.state);
  await assert.rejects(c.service.correctAcceptance(member, "p1", "t1", c.correction()), code("FORBIDDEN"));
  await assert.rejects(c.service.correctAcceptance(outsider, "p1", "t1", c.correction()), code("NOT_FOUND"));
  await assert.rejects(c.service.correctAcceptance(manager, "p1", "t1", c.correction({ correctionOf: "old-record" })), code("INVALID_CORRECTION"));
  await assert.rejects(c.service.correctAcceptance(manager, "p1", "t1", c.correction({ acknowledgedDependentTaskIds: ["integration"] })), code("CORRECTION_IMPACT_UNACKNOWLEDGED"));
  c.setLockHook(() => { c.facts.projectArchived = true; });
  await assert.rejects(c.service.correctAcceptance(manager, "p1", "t1", c.correction()), code("PROJECT_READ_ONLY"));
  assert.deepEqual(c.repository.state, before);
});
test("simultaneous correction and progress serialize; stale revisions preserve every accepted record", async () => {
  const c = await accepted(); const input = c.correction();
  const results = await Promise.allSettled([c.service.correctAcceptance(manager, "p1", "t1", input), c.service.correctAcceptance(manager, "p1", "t1", { ...input, idempotencyKey: "second" })]);
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
  const rejected = results.find(value => value.status === "rejected");
  assert.equal(rejected?.status === "rejected" && code("VERSION_CONFLICT")(rejected.reason), true);
  assert.equal(c.repository.state!.progressUpdates.filter(value => value.acceptanceCorrection).length, 1);
});
test("official track and member intention revisions stale a plan without rewriting its history", async () => {
  const c = await applied(); const original = structuredClone(c.repository.state!.plans[0]!.inputSnapshot);
  c.facts.trackSelectionRevision = 2; c.facts.memberIntentionRefs = [{ membershipId: "pm2", revision: 3 }];
  const view = await c.service.getCurrent(member, "p1");
  assert.equal(view.inputVersionsChanged, true); assert.equal(view.staleInputs, true);
  assert.deepEqual(c.repository.state!.plans[0]!.inputSnapshot, original);
  const fields = diffPlanInputs(original, c.facts, view.tasks).flatMap(value => value.fields);
  assert.equal(fields.includes("trackSelectionRevision"), true); assert.equal(fields.includes("memberIntentionRefs"), true);
  const left = { ...c.facts, memberIntentionRefs: [{ membershipId: "pm1", revision: 1 }, { membershipId: "pm2", revision: 2 }] };
  assert.equal(versionsEqual(left, { ...left, memberIntentionRefs: [...left.memberIntentionRefs].reverse() }), true);
});
test("HTTP correction rejects caller identity and runs mutation authorization", async () => {
  const c = await accepted(); let protectedMutations = 0;
  assert.throws(() => parseAcceptanceCorrectionCommand({ ...c.correction(), actorId: "manager" }), DomainError);
  const handlers = createPlanningHandlers({ service: c.service, requestIds: { next: () => "request" }, resolveActor: async () => manager, authorizeMutation: async () => { protectedMutations++; } });
  const response = await handlers.correctAcceptance(new Request("https://example.test/correct", { method: "POST", body: JSON.stringify(c.correction()) }), { projectId: "p1", taskId: "t1" });
  assert.equal(response.status, 201); assert.equal(protectedMutations, 1); assert.equal(response.headers.get("cache-control"), "private, no-store");
});
test("a saved owner correction request is idempotent and changes no task acceptance, revision or dependency", async () => {
  const c = await accepted(); const before = structuredClone(c.repository.state!);
  const input = { expectedRevision: 2, acceptanceProgressId: c.done.id, reason: "发现遗漏了检查条件，请管理员复核", idempotencyKey: "request" };
  const result = await c.service.requestAcceptanceCorrection(member, "p1", "t1", input);
  assert.equal(result.correctionRequest?.acceptanceProgressId, c.done.id);
  assert.equal(result.acceptance, null);
  assert.deepEqual(c.repository.state!.tasks, before.tasks);
  assert.deepEqual(c.repository.state!.plans, before.plans);
  assert.equal(c.repository.state!.tasksRevision, before.tasksRevision);
  assert.deepEqual(await c.service.requestAcceptanceCorrection(member, "p1", "t1", input), result);
  assert.equal(c.repository.state!.progressUpdates.length, before.progressUpdates.length + 1);
  const correction = await c.service.correctAcceptance(manager, "p1", "t1", c.correction());
  assert.equal(correction.correctionOf, c.done.id);
  assert.equal(c.repository.state!.tasks[0]?.status, "review");
});
test("correction requests refuse unrelated active members, stale tasks, unrelated records and archived writes", async () => {
  const c = await accepted(); const input = { expectedRevision: 2, acceptanceProgressId: c.done.id, reason: "请复核", idempotencyKey: "request" };
  c.facts.members.push({ userId: "other", membershipId: "pm3", projectId: "p1", status: "active", role: "member" });
  await assert.rejects(c.service.requestAcceptanceCorrection({ userId: "other", platformRoles: ["user"] }, "p1", "t1", input), code("FORBIDDEN"));
  await assert.rejects(c.service.requestAcceptanceCorrection(member, "p1", "t1", { ...input, expectedRevision: 1 }), code("VERSION_CONFLICT"));
  await assert.rejects(c.service.requestAcceptanceCorrection(member, "p1", "t1", { ...input, acceptanceProgressId: "different-task" }), code("INVALID_CORRECTION"));
  c.setLockHook(() => { c.facts.projectArchived = true; });
  await assert.rejects(c.service.requestAcceptanceCorrection(member, "p1", "t1", input), code("PROJECT_READ_ONLY"));
  assert.equal(c.repository.state!.progressUpdates.length, 2);
});
test("a member removed during final facts lock cannot request a correction", async () => {
  const c = await accepted();
  c.setLockHook(() => { c.facts.members = c.facts.members.filter(value => value.userId !== member.userId); });
  await assert.rejects(c.service.requestAcceptanceCorrection(member, "p1", "t1", { expectedRevision: 2, acceptanceProgressId: c.done.id, reason: "请复核", idempotencyKey: "removed" }), code("NOT_FOUND"));
  assert.equal(c.repository.state!.progressUpdates.length, 2);
});
test("an active helper can request correction without acquiring manager permissions", async () => {
  const c = setup(); const helper = { userId: "helper", platformRoles: ["user"] as const };
  c.facts.members.push({ userId: helper.userId, membershipId: "pm3", projectId: "p1", role: "member", status: "active" });
  c.facts.availabilityVersions.pm3 = 1;
  c.facts.availability.push({ ...structuredClone(c.facts.availability[0]!), membershipId: "pm3", windows: c.facts.availability[0]!.windows.map(window => ({ ...window, membershipId: "pm3", id: "helper-window" })) });
  const tasks = c.draft().tasks; tasks[0]!.helperEfforts = [{ membershipId: "pm3", durationEstimate: { optimisticMinutes: 5, likelyMinutes: 10, pessimisticMinutes: 15, basis: "协助检查" } }];
  const plan = await c.service.createDraft(manager, "p1", c.draft({ tasks }));
  await c.service.apply(manager, "p1", plan.id, { expectedRevision: 0, acknowledgedIssueCodes: plan.validation!.issues.map(issue => issue.code), idempotencyKey: "apply" });
  await c.service.updateProgress(member, "p1", "t1", command(0, "review", "report"));
  const accepted = await c.service.updateProgress(manager, "p1", "t1", command(1, "done", "accept"));
  const request = await c.service.requestAcceptanceCorrection(helper, "p1", "t1", { expectedRevision: 2, acceptanceProgressId: accepted.id, reason: "协助时发现遗漏", idempotencyKey: "helper-request" });
  assert.equal(request.actorId, helper.userId); assert.equal(c.repository.state!.tasks[0]!.status, "done");
  await assert.rejects(c.service.correctAcceptance(helper, "p1", "t1", { expectedRevision: 2, expectedTasksRevision: c.repository.state!.tasksRevision, correctionOf: accepted.id, correctionReason: "不能自行更正", status: "review", acknowledgedDependentTaskIds: ["integration", "testing", "submission"], idempotencyKey: "forbidden" }), code("FORBIDDEN"));
});
test("current plan and saved private histories recheck membership after reading", async () => {
  for (const operation of ["getCurrent", "listHistory", "listProgress"] as const) {
    const c = await applied(); const read = c.repository.read.bind(c.repository);
    c.repository.read = async projectId => { const state = await read(projectId); c.facts.members = c.facts.members.filter(value => value.userId !== member.userId); return state; };
    await assert.rejects(c.service[operation](member, "p1"), code("NOT_FOUND"));
  }
});
