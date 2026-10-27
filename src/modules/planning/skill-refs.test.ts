import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../shared/errors.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { FixedSkillReference, ReviewedSkillOption, TaskSkillReference } from "../skills/index.ts";
import { PLANNING_TASK_OPTIONAL_OUTPUT_SCHEMA, createPlanningModelAdapter, validateGeneratedPlanningOutput } from "./generation-model.ts";
import type { PlanningGenerationSnapshot, PlanningJsonModelPort } from "./generation-types.ts";
import { parseTaskProposal } from "./parse.ts";
import { PlanningService } from "./service.ts";
import type { DraftCommand } from "./service.ts";
import { manager, member, NOW, setup, taskProposal } from "./testing/fixtures.ts";
import { generatedProposal } from "./testing/generation-fixtures.ts";

const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
const fixed = (overrides: Partial<FixedSkillReference> = {}): FixedSkillReference => ({ kind: "skill", id: "document-demo", version: "1.0.0", versionId: "document-demo@abc123", contentHash: "a".repeat(64), revision: 1, ...overrides });
const selection = (overrides: Partial<TaskSkillReference> = {}): TaskSkillReference => ({ reference: fixed(), purpose: "整理参赛作品运行说明", learningMinutes: 30, environment: { agentId: "codex" }, ...overrides });

function fixture() {
  const c = setup(); let sequence = 0; let available = true; let actual = fixed(); let beforeLookup = () => {}; let returned: FixedSkillReference | null = null;
  const calls: { reference: FixedSkillReference; sql: SqlExecutor }[] = []; const locked: SqlExecutor[] = [];
  const service = new PlanningService({ repository: c.repository,
    access: { async getMembership(projectId, userId) { return c.facts.members.find(item => item.projectId === projectId && item.userId === userId && item.status === "active") ?? null; } },
    facts: { async readInput() { return structuredClone(c.facts); }, async lockVersions(_projectId, sql) { locked.push(sql); return structuredClone(c.facts); } },
    reviewedSkills: { async get(reference, sql): Promise<ReviewedSkillOption> {
      calls.push({ reference: structuredClone(reference), sql }); beforeLookup();
      if (!available) throw new DomainError("SKILL_REFERENCE_UNAVAILABLE", "固定版本已撤回。", { status: 409 });
      if (JSON.stringify(reference) !== JSON.stringify(actual)) throw new DomainError("SKILL_REFERENCE_STALE", "固定版本已变化。", { status: 409 });
      return { reference: structuredClone(returned ?? actual), title: "作品运行说明", summary: "准备演示", prerequisites: [], compatibility: [], requiredSkillVersions: [], optionalSkillVersionIds: [], limitations: ["需本队实际试用"] };
    } }, clock: { now: () => new Date(NOW) }, ids: { next: () => `skill-plan-${++sequence}` },
  });
  const draft = (overrides: Partial<DraftCommand> = {}) => { const command = c.draft(); command.tasks[0].skillRefs = [selection()]; return { ...command, ...overrides }; };
  const apply = (plan: Awaited<ReturnType<PlanningService["createDraft"]>>, idempotencyKey = `apply-${plan.id}`) => service.apply(manager, "p1", plan.id, { expectedRevision: plan.revision, acknowledgedIssueCodes: plan.validation!.issues.map(issue => issue.code), idempotencyKey });
  return { ...c, service, draft, apply, calls, locked, unavailable: () => { available = false; }, publish: (ref: FixedSkillReference) => { actual = ref; }, onLookup: (work: () => void) => { beforeLookup = work; }, wrongReturn: (ref: FixedSkillReference) => { returned = ref; } };
}

test("legacy task parsing and optional output schema accept omitted/empty skillRefs", async () => {
  assert.equal(parseTaskProposal(taskProposal()).skillRefs, undefined);
  assert.deepEqual(parseTaskProposal(taskProposal("t1", { skillRefs: [] })).skillRefs, []);
  assert.equal("required" in PLANNING_TASK_OPTIONAL_OUTPUT_SCHEMA, false);
  assert.equal(PLANNING_TASK_OPTIONAL_OUTPUT_SCHEMA.properties.skillRefs.maxItems, 12);
  const c = setup(); const draft = c.draft(); draft.tasks[1].skillRefs = [];
  const plan = await c.service.createDraft(manager, "p1", draft);
  const applied = await c.service.apply(manager, "p1", plan.id, { expectedRevision: plan.revision, acknowledgedIssueCodes: plan.validation!.issues.map(issue => issue.code), idempotencyKey: "legacy-apply" });
  assert.equal(applied.status, "applied"); assert.equal(applied.tasks[0].skillRefs, undefined); assert.deepEqual(applied.tasks[1].skillRefs, []);
});

test("task parser rejects latest, forged publication claims and paths in optional skillRefs", () => {
  for (const item of [selection({ reference: fixed({ version: "latest" }) }), { ...selection(), installed: true }, selection({ environment: { os: "C:\\private\\local-file" } }), selection({ reference: fixed({ contentHash: "wrong" }) })]) {
    assert.throws(() => parseTaskProposal({ ...taskProposal(), skillRefs: [item] }), code("INVALID_SKILL_REFERENCE"));
  }
});

test("new skill selection requires an injected reviewed lookup and rolls back draft/outbox", async () => {
  const c = setup(); const command = c.draft(); command.tasks[0].skillRefs = [selection()];
  await assert.rejects(c.service.createDraft(manager, "p1", command), code("SKILL_REFERENCE_LOOKUP_UNAVAILABLE"));
  assert.equal(c.repository.state, null); assert.deepEqual(c.repository.events, []);
});

test("new selection is validated on the same executor at draft and apply without extra capacity", async () => {
  const c = fixture(); const command = c.draft(); const plan = await c.service.createDraft(manager, "p1", command);
  assert.deepEqual(plan.tasks[0].skillRefs, [selection()]); assert.equal(plan.tasks[0].durationEstimate.likelyMinutes, 60);
  assert.equal(c.calls.length, 1); assert.equal(c.calls[0].sql, c.locked.at(-1));
  assert.deepEqual(await c.service.createDraft(manager, "p1", command), plan); assert.equal(c.calls.length, 1);
  const applied = await c.apply(plan); assert.equal(c.calls.length, 2); assert.equal(c.calls[1].sql, c.locked.at(-1));
  await c.apply(plan); assert.equal(c.calls.length, 2); assert.deepEqual(applied.tasks[0].skillRefs, [selection()]);
  assert.equal(c.repository.events.filter(event => event.type === "PlanApplied").length, 1);
});

test("sum of skill learning minutes must fit the existing likely estimate", async () => {
  const c = fixture(); const command = c.draft(); command.tasks[0].skillRefs = [selection({ learningMinutes: 40 }), selection({ reference: fixed({ id: "debug-demo", versionId: "debug-demo@def456" }), learningMinutes: 30 })];
  await assert.rejects(c.service.createDraft(manager, "p1", command), code("SKILL_LEARNING_NOT_IN_TASK_ESTIMATE"));
  assert.equal(c.calls.length, 0); assert.equal(c.repository.state, null); assert.deepEqual(c.repository.events, []);
});

test("retained skill choices cannot hide their learning cost by reducing the task estimate", async () => {
  const c = fixture(); const initial = await c.service.createDraft(manager, "p1", c.draft()); await c.apply(initial); c.unavailable();
  const before = structuredClone(c.repository.state); const command = c.draft({ basePlanVersionId: initial.id, expectedTasksRevision: 1 });
  delete command.tasks[0].skillRefs;
  command.tasks[0].durationEstimate = { optimisticMinutes: 5, likelyMinutes: 10, pessimisticMinutes: 20, basis: "漏掉了既有技能学习时间" };
  await assert.rejects(c.service.createDraft(manager, "p1", command), code("SKILL_LEARNING_NOT_IN_TASK_ESTIMATE"));
  assert.deepEqual(c.repository.state, before);
});

test("stale exact version cannot apply and keeps the saved draft and live plan unchanged", async () => {
  const c = fixture(); const plan = await c.service.createDraft(manager, "p1", c.draft()); const before = structuredClone(c.repository.state);
  c.publish(fixed({ revision: 2 }));
  await assert.rejects(c.apply(plan), code("SKILL_REFERENCE_STALE"));
  assert.deepEqual(c.repository.state, before); assert.equal(c.repository.events.filter(event => event.type === "PlanApplied").length, 0);
  const command = c.draft(); command.tasks[0].skillRefs = [selection({ reference: fixed({ revision: 2 }) })];
  const edited = await c.service.editDraft(manager, "p1", plan.id, { ...command, expectedRevision: plan.revision });
  assert.equal((await c.apply(edited)).tasks[0].skillRefs![0].reference.revision, 2);
});

test("a lookup adapter cannot substitute latest or another version", async () => {
  const c = fixture(); c.wrongReturn(fixed({ version: "2.0.0", versionId: "document-demo@def456" }));
  await assert.rejects(c.service.createDraft(manager, "p1", c.draft()), code("SKILL_REFERENCE_STALE"));
  assert.equal(c.repository.state, null); assert.deepEqual(c.repository.events, []);
});

test("membership revoked during reviewed lookup cannot save a draft", async () => {
  const c = fixture(); c.onLookup(() => { c.facts.members = c.facts.members.filter(item => item.userId !== manager.userId); });
  await assert.rejects(c.service.createDraft(manager, "p1", c.draft()), code("NOT_FOUND"));
  assert.equal(c.repository.state, null); assert.deepEqual(c.repository.events, []);
});

test("withdrawal keeps applied history and unchanged references, while new uses must be reviewed", async () => {
  const c = fixture(); const first = await c.service.createDraft(manager, "p1", c.draft()); await c.apply(first); c.unavailable(); const calls = c.calls.length;
  assert.deepEqual((await c.service.getCurrent(manager, "p1")).tasks[0].skillRefs, [selection()]);
  assert.deepEqual((await c.service.listHistory(manager, "p1"))[0].tasks[0].skillRefs, [selection()]);
  const command = c.draft({ tasks: c.draft().tasks.map(task => { const { skillRefs: _ignored, ...legacy } = task; return legacy; }), basePlanVersionId: first.id, expectedTasksRevision: 1 });
  const retained = await c.service.createDraft(manager, "p1", command); assert.deepEqual(retained.tasks[0].skillRefs, [selection()]); await c.apply(retained);
  assert.equal(c.calls.length, calls);
  for (const item of [selection({ purpose: "采用该技能做新的用途" }), selection({ learningMinutes: 31 }), selection({ environment: { agentId: "claude-code" } })]) {
    const next = c.draft({ basePlanVersionId: retained.id, expectedTasksRevision: 2 }); next.tasks[0].skillRefs = [item];
    await assert.rejects(c.service.createDraft(manager, "p1", next), code("SKILL_REFERENCE_UNAVAILABLE"));
  }
  const newTask = c.draft({ basePlanVersionId: retained.id, expectedTasksRevision: 2 }); newTask.tasks[1].skillRefs = [selection()];
  await assert.rejects(c.service.createDraft(manager, "p1", newTask), code("SKILL_REFERENCE_UNAVAILABLE"));
  assert.equal(c.repository.state!.currentPlanVersionId, retained.id);
});

test("completed tasks retain references for legacy callers and cannot clear or alter them", async () => {
  const c = fixture(); const first = await c.service.createDraft(manager, "p1", c.draft()); await c.apply(first);
  await c.service.updateProgress(member, "p1", "t1", { expectedRevision: 0, status: "review", remainingEstimate: null, blocker: null, evidenceRefs: ["demo-record"], note: "准备检查", idempotencyKey: "review" });
  await c.service.updateProgress(manager, "p1", "t1", { expectedRevision: 1, status: "done", remainingEstimate: null, blocker: null, evidenceRefs: ["demo-record"], note: "按标准验收通过", idempotencyKey: "accept" });
  c.unavailable(); const before = structuredClone(c.repository.state);
  for (const refs of [[], [selection({ learningMinutes: 1 })], [selection({ reference: fixed({ revision: 2 }) })]]) {
    const command = c.draft({ basePlanVersionId: first.id, expectedTasksRevision: 3 }); command.tasks[0].skillRefs = refs;
    await assert.rejects(c.service.createDraft(manager, "p1", command), code("COMPLETED_TASK_CHANGED"));
    assert.deepEqual(c.repository.state, before);
  }
  const command = c.draft({ basePlanVersionId: first.id, expectedTasksRevision: 3 }); delete command.tasks[0].skillRefs;
  const next = await c.service.createDraft(manager, "p1", command); assert.deepEqual(next.tasks[0].skillRefs, [selection()]); assert.equal(next.tasks[0].status, "done");
});

test("restoring a cancelled historical task is a new adoption and cannot use a withdrawn version", async () => {
  const c = fixture(); const initial = c.draft(); const extra = taskProposal("extra", { priority: "optional", requirementRefs: [], skillRefs: [selection()] }); initial.tasks.push(extra);
  const first = await c.service.createDraft(manager, "p1", initial); await c.apply(first);
  const second = await c.service.createDraft(manager, "p1", c.draft({ tasks: [...initial.tasks.slice(0, -1), { ...extra, cancel: true, cancellationReason: "先做好必交部分" }], basePlanVersionId: first.id, expectedTasksRevision: 1 })); await c.apply(second); c.unavailable();
  const before = structuredClone(c.repository.state);
  await assert.rejects(c.service.restoreAsDraft(manager, "p1", first.id, { basePlanVersionId: second.id, expectedTasksRevision: 2, reason: "恢复此前可选任务", idempotencyKey: "restore-withdrawn" }), code("SKILL_REFERENCE_UNAVAILABLE"));
  assert.deepEqual(c.repository.state, before); assert.deepEqual((await c.service.listHistory(manager, "p1"))[0].tasks.find(task => task.id === "extra")!.skillRefs, [selection()]);
});

test("unchanged cancelled historical references do not block unrelated manual work after withdrawal", async () => {
  const c = fixture(); const initial = c.draft(); const extra = taskProposal("extra", { priority: "optional", requirementRefs: [], skillRefs: [selection()] }); initial.tasks.push(extra);
  const first = await c.service.createDraft(manager, "p1", initial); await c.apply(first);
  const second = await c.service.createDraft(manager, "p1", c.draft({ tasks: [...initial.tasks.slice(0, -1), { ...extra, cancel: true, cancellationReason: "先完成必交作品" }], basePlanVersionId: first.id, expectedTasksRevision: 1 })); await c.apply(second); c.unavailable();
  const calls = c.calls.length; const command = c.draft({ basePlanVersionId: second.id, expectedTasksRevision: 2 }); command.tasks[1].title = "根据真实进展更新集成范围";
  const next = await c.service.createDraft(manager, "p1", command); const cancelled = next.tasks.find(task => task.id === "extra")!;
  assert.equal(cancelled.status, "cancelled"); assert.deepEqual(cancelled.skillRefs, [selection()]);
  await c.apply(next); assert.equal(c.calls.length, calls); assert.equal(c.repository.state!.tasks.find(task => task.id === "extra")!.status, "cancelled");
});

test("model skillRefs remain optional, bounded to supplied versions and included in original work estimates", async () => {
  const c = fixture(); const plan = await c.service.createDraft(manager, "p1", c.draft()); await c.apply(plan);
  const state = c.repository.state!;
  const snapshot: PlanningGenerationSnapshot = { input: c.facts, tasks: state.tasks, tasksRevision: state.tasksRevision, basePlanVersionId: state.currentPlanVersionId, resourceContentRefs: [], buffers: c.draft().buffers, goal: "补齐作品演示材料", instructions: "" };
  const valid = generatedProposal(); valid.tasks[0].skillRefs = [selection()]; valid.tasks.find(task => task.kind === "material")!.skillRefs = [selection()];
  assert.deepEqual(validateGeneratedPlanningOutput(valid, snapshot).tasks[0].skillRefs, [selection()]);
  const unknown = structuredClone(valid); unknown.tasks[0].skillRefs![0].reference.revision = 2;
  assert.throws(() => validateGeneratedPlanningOutput(unknown, snapshot), code("INVALID_GENERATED_PLAN"));
  const missingEstimate = structuredClone(valid); missingEstimate.tasks[0].skillRefs![0].learningMinutes = 61;
  assert.throws(() => validateGeneratedPlanningOutput(missingEstimate, snapshot), code("INVALID_GENERATED_PLAN"));
  const inherited = structuredClone(valid); delete inherited.tasks[0].skillRefs; inherited.tasks[0].durationEstimate = { optimisticMinutes: 1, likelyMinutes: 10, pessimisticMinutes: 10, basis: "遗漏学习成本" };
  assert.throws(() => validateGeneratedPlanningOutput(inherited, snapshot), code("INVALID_GENERATED_PLAN"));
  let request: Parameters<PlanningJsonModelPort["completeJSON"]>[0] | undefined;
  await createPlanningModelAdapter({ modelVersion: "test-only", async completeJSON(value) { request = value; return { content: valid, modelVersion: "test-only", usage: null, requestId: null }; } }).generate(snapshot, new AbortController().signal);
  assert.deepEqual((request!.input as { optionalTaskFieldsSchema: unknown }).optionalTaskFieldsSchema, PLANNING_TASK_OPTIONAL_OUTPUT_SCHEMA);
  const generated = await c.service.createGeneratedDraft(manager, "p1", c.draft({ tasks: valid.tasks, reason: valid.reason, basePlanVersionId: state.currentPlanVersionId, expectedTasksRevision: state.tasksRevision }), snapshot, { jobId: "fixture-job", modelVersion: "test-only", promptVersion: "fixture", assumptions: [], usage: null, providerRequestId: null });
  assert.ok(generated.tasks.some(task => task.kind === "material" && task.skillRefs?.length));
  assert.equal(c.calls.length, 3); assert.equal(c.repository.state!.currentPlanVersionId, plan.id); assert.ok(!c.repository.state!.tasks.some(task => task.kind === "material"));
});
