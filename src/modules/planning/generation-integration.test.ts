import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Clock, IdGenerator, ProjectAccessPort } from "../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor, SqlResult } from "../../shared/persistence.ts";
import { createPlanningGenerationService } from "./generation.ts";
import { createPostgresPlanningGenerationRepository } from "./generation-postgres.ts";
import type { PlanningGenerationModelPort } from "./generation-types.ts";
import { createPostgresPlanningRepository } from "./postgres.ts";
import { PlanningService } from "./service.ts";
import type { PlanningInput } from "./types.ts";
import { inputFixture, manager, member, NOW } from "./testing/fixtures.ts";
import { generatedProposal, generationCommand } from "./testing/generation-fixtures.ts";

interface SqlCall { transactionId: number | null; statement: string; parameters: readonly unknown[] }
interface TestContext { executor: SqlExecutor; transactionId: number; savepoint: number }

/** Isolated real SQL engine; no application database, provider or credentials are used. */
async function integrationFixture() {
  const engine = new PGlite();
  await engine.waitReady;
  for (const path of ["./migrations/001-planning.sql", "./migrations/002-planning-generation.sql"]) {
    await engine.exec(await readFile(new URL(path, import.meta.url), "utf8"));
  }
  const ambient = new AsyncLocalStorage<TestContext>();
  const calls: SqlCall[] = [];
  let transactionSequence = 0;
  let failSucceededSave = false;
  let succeededSaveFailures = 0;
  let nestedTransactions = 0;
  let rolledBackTransactions = 0;
  const wrap = (query: PGlite["query"], transactionId: number | null): SqlExecutor => ({
    async query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<SqlResult<Row>> {
      calls.push({ transactionId, statement, parameters });
      if (failSucceededSave && statement.startsWith("UPDATE planning_generation_jobs") && parameters[2] === "succeeded") {
        failSucceededSave = false;
        succeededSaveFailures++;
        throw new Error("Injected failure while recording generated draft completion");
      }
      const result = await query<Row>(statement, [...parameters]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  });
  const direct = wrap(engine.query.bind(engine), null);
  const database: DatabasePort = {
    query: (statement, parameters) => (ambient.getStore()?.executor ?? direct).query(statement, parameters),
    async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
      const current = ambient.getStore();
      if (current) {
        nestedTransactions++;
        const name = `planning_test_nested_${++current.savepoint}`;
        await current.executor.query(`SAVEPOINT ${name}`);
        try {
          const result = await work(current.executor);
          await current.executor.query(`RELEASE SAVEPOINT ${name}`);
          return result;
        } catch (error) {
          await current.executor.query(`ROLLBACK TO SAVEPOINT ${name}`);
          await current.executor.query(`RELEASE SAVEPOINT ${name}`);
          throw error;
        }
      }
      const transactionId = ++transactionSequence;
      try {
        return await engine.transaction(async tx => {
          const executor = wrap(tx.query.bind(tx), transactionId);
          return ambient.run({ executor, transactionId, savepoint: 0 }, () => work(executor));
        });
      } catch (error) { rolledBackTransactions++; throw error; }
    },
  };

  const input: PlanningInput = inputFixture();
  const access: ProjectAccessPort = {
    async getMembership(projectId, userId) {
      return input.members.find(entry => entry.projectId === projectId && entry.userId === userId) ?? null;
    },
  };
  const clock: Clock = { now: () => new Date(NOW) };
  let idSequence = 0;
  const ids: IdGenerator = { next: () => `sql-planning-${++idSequence}` };
  const planningRepository = createPostgresPlanningRepository(database);
  const generationRepository = createPostgresPlanningGenerationRepository(database);
  const planning = new PlanningService({
    repository: planningRepository, access, clock, ids,
    facts: {
      async readInput(projectId) {
        assert.equal(projectId, input.projectId);
        return structuredClone(input);
      },
      async lockVersions(projectId, executor) {
        assert.equal(projectId, input.projectId);
        assert.ok(ambient.getStore(), "Final fact reads must run inside the outer SQL transaction");
        await executor.query("SELECT 1 AS planning_fact_lock_probe");
        return structuredClone(input);
      },
    },
  });
  let modelCalls = 0;
  const model: PlanningGenerationModelPort = {
    modelVersion: "test-configured-json-model", promptVersion: "planning-sql-test-v1",
    async generate(snapshot, signal) {
      modelCalls++;
      assert.equal(ambient.getStore(), undefined, "The network adapter must run outside the SQL transaction");
      assert.equal(signal.aborted, false);
      assert.equal(snapshot.input.requirementVersionId, input.requirementVersionId);
      return { ...generatedProposal(), usage: { inputTokens: 123, outputTokens: 456 },
        requestId: "test-provider-request", modelVersion: "test-configured-json-model" };
    },
  };
  const generation = createPlanningGenerationService({
    planning, repository: generationRepository, access, model, clock, ids,
  });
  return {
    engine, database, calls, input, planning, generation, planningRepository, generationRepository,
    modelCalls: () => modelCalls, nestedTransactions: () => nestedTransactions,
    rolledBackTransactions: () => rolledBackTransactions, succeededSaveFailures: () => succeededSaveFailures,
    injectSucceededSaveFailure: () => { failSucceededSave = true; },
  };
}

test("isolated PGlite: queued revision one becomes a durable checked draft without applying it", async t => {
  const fixture = await integrationFixture();
  t.after(() => fixture.engine.close());
  const command = generationCommand();
  const queued = await fixture.generation.queueGeneration(manager, "p1", command);
  assert.equal(queued.status, "queued");
  assert.equal(queued.revision, 1);
  assert.equal(queued.attempts, 0);
  assert.equal(queued.snapshot.input.requirementVersionId, "rv1");
  assert.deepEqual(await fixture.generation.queueGeneration(manager, "p1", command), queued);
  assert.equal(fixture.modelCalls(), 0);

  const completed = await fixture.generation.processGenerationJob(queued.id);
  assert.equal(completed.status, "succeeded", completed.errorCode ?? "Expected a successful draft generation");
  assert.equal(completed.revision, 3);
  assert.equal(completed.attempts, 1);
  assert.ok(completed.resultPlanId);
  assert.equal(fixture.modelCalls(), 1);
  const state = await fixture.planningRepository.read("p1");
  assert.equal(state!.currentPlanVersionId, null, "Generated plans always await manual application");
  assert.equal(state!.tasksRevision, 0);
  assert.deepEqual(state!.tasks, []);
  assert.equal(state!.plans.length, 1);
  const draft = state!.plans[0]!;
  assert.equal(draft.id, completed.resultPlanId);
  assert.equal(draft.status, "ready");
  assert.equal(draft.validation!.structuralValid, true);
  assert.equal(draft.appliedAt, null);
  assert.equal(draft.appliedBy, null);
  assert.equal(draft.generation!.jobId, completed.id);
  assert.ok(draft.validation!.issues.some(issue => issue.code === "UNCONFIRMED_ASSUMPTIONS"));
  const events = await fixture.database.query<{ event_type: string }>("SELECT event_type FROM planning_outbox ORDER BY event_id");
  assert.deepEqual(events.rows.map(row => row.event_type), ["PlanDraftGenerated"]);
  const generatedKeys = await fixture.database.query<{ idempotency_key: string }>("SELECT idempotency_key FROM planning_idempotency");
  assert.deepEqual(generatedKeys.rows.map(row => row.idempotency_key), [`generation:${completed.id}`]);

  const reconnectedJobs = createPostgresPlanningGenerationRepository(fixture.database);
  const reconnectedPlanning = createPostgresPlanningRepository(fixture.database);
  assert.deepEqual(await reconnectedJobs.read(completed.id), completed);
  assert.deepEqual(await reconnectedPlanning.read("p1"), state);
  assert.deepEqual(await fixture.generation.processGenerationJob(completed.id), completed);
  assert.equal(fixture.modelCalls(), 1, "Worker redelivery cannot launch a second model request");

  const completion = fixture.calls.find(call => call.statement.startsWith("UPDATE planning_generation_jobs") && call.parameters[2] === "succeeded")!;
  const savedDraft = fixture.calls.find(call => call.statement.startsWith("UPDATE planning_states"))!;
  const emittedDraft = fixture.calls.find(call => call.statement.startsWith("INSERT INTO planning_outbox"))!;
  assert.ok(completion.transactionId);
  assert.equal(savedDraft.transactionId, completion.transactionId);
  assert.equal(emittedDraft.transactionId, completion.transactionId);
  assert.ok(fixture.nestedTransactions() >= 1);
});

test("isolated PGlite: completion-write failure rolls back the generated draft, event and key while retaining manual work", async t => {
  const fixture = await integrationFixture();
  t.after(() => fixture.engine.close());
  const output = generatedProposal();
  const manual = await fixture.planning.createDraft(manager, "p1", {
    tasks: output.tasks, buffers: generationCommand().buffers, reason: "队伍已手动确认的计划",
    expectedTasksRevision: 0, basePlanVersionId: null, idempotencyKey: "manual-draft",
  });
  await fixture.planning.apply(manager, "p1", manual.id, {
    expectedRevision: manual.revision, acknowledgedIssueCodes: manual.validation!.issues.map(issue => issue.code), idempotencyKey: "manual-apply",
  });
  await fixture.planning.updateProgress(member, "p1", "t1", {
    expectedRevision: 0, status: "in_progress", remainingEstimate: null, blocker: null,
    evidenceRefs: ["manual-artifact-1"], note: "已经提交手动工作记录", idempotencyKey: "manual-start",
  });
  const baseline = (await fixture.planningRepository.read("p1"))!;
  const priorEvents = await fixture.database.query<{ event_id: string; event_type: string }>("SELECT event_id, event_type FROM planning_outbox ORDER BY event_id");
  const priorKeys = await fixture.database.query<{ idempotency_key: string }>("SELECT idempotency_key FROM planning_idempotency ORDER BY idempotency_key");
  const queued = await fixture.generation.queueGeneration(manager, "p1", generationCommand({
    expectedTasksRevision: baseline.tasksRevision, basePlanVersionId: baseline.currentPlanVersionId,
  }));
  fixture.injectSucceededSaveFailure();
  const failed = await fixture.generation.processGenerationJob(queued.id);
  assert.equal(fixture.succeededSaveFailures(), 1, "Fault injection must occur after the generated draft was saved");
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "MODEL_FAILED");
  assert.equal(failed.revision, 3);
  assert.equal(failed.attempts, 1);
  assert.equal(failed.resultPlanId, null);
  assert.equal(fixture.modelCalls(), 1);
  assert.equal(fixture.rolledBackTransactions(), 1);
  assert.deepEqual(await fixture.planningRepository.read("p1"), baseline);
  assert.equal(baseline.tasks.find(task => task.id === "t1")!.status, "in_progress");
  assert.equal(baseline.progressUpdates[0]!.evidenceRefs[0], "manual-artifact-1");
  assert.deepEqual(await fixture.database.query("SELECT event_id, event_type FROM planning_outbox ORDER BY event_id"), priorEvents);
  assert.deepEqual(await fixture.database.query("SELECT idempotency_key FROM planning_idempotency ORDER BY idempotency_key"), priorKeys);
  assert.deepEqual(await createPostgresPlanningGenerationRepository(fixture.database).read(failed.id), failed);
  assert.equal((await fixture.generation.listQueuedAIJobs()).length, 0);
  assert.equal((await fixture.generation.listRunningAIJobs()).length, 0);
  const generatedKey = await fixture.database.query("SELECT idempotency_key FROM planning_idempotency WHERE idempotency_key = $1", [`generation:${failed.id}`]);
  assert.equal(generatedKey.rowCount, 0);
});
