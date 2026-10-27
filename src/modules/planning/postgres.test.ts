import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor, SqlResult } from "../../shared/persistence.ts";
import { createPostgresPlanningRepository } from "./postgres.ts";
import type { PlanningTransaction } from "./ports.ts";
import type { PlanningEvent, PlanningState, PlanVersion, ProgressUpdate } from "./types.ts";

interface StoredState { revision: number; stateJson: string }
interface StoredResult { fingerprint: string; resultJson: string }
interface Call { transactionId: number | null; statement: string; parameters: readonly unknown[] }

function initial(projectId: string, revision = 0): PlanningState {
  return { projectId, currentPlanVersionId: null, tasksRevision: 0, tasks: [], plans: [], progressUpdates: [], revision };
}
function event(projectId: string, revision: number): PlanningEvent {
  return { id: `event-${projectId}-${revision}`, type: "ProgressUpdated", projectId, aggregateId: "task-1", revision, occurredAt: "2026-10-08T10:00:00Z" };
}
function matchesError(code: string, latestRevision?: number): (error: unknown) => boolean {
  return (error) => error instanceof DomainError && error.code === code && (latestRevision === undefined || error.latestRevision === latestRevision);
}

/** SQL contract simulation only: no PostgreSQL server or migration is run. */
class SimulatedDatabase implements DatabasePort {
  readonly states = new Map<string, StoredState>();
  readonly results = new Map<string, StoredResult>();
  readonly events = new Map<string, PlanningEvent>();
  readonly calls: Call[] = [];
  readonly locks = new Map<string, Promise<void>>();
  commits = 0;
  rollbacks = 0;
  failOn: string | null = null;
  nextTransactionId = 0;

  seed(state: PlanningState): void { this.states.set(state.projectId, { revision: state.revision, stateJson: JSON.stringify(state) }); }

  async query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.calls.push({ transactionId: null, statement, parameters });
    assert.ok(statement.startsWith("SELECT"), "Adapter may only read outside transactions");
    const projectId = String(parameters[0]);
    const state = this.states.get(projectId);
    return { rows: state ? [{ project_id: projectId, revision: String(state.revision), state_json: state.stateJson } as Row] : [], rowCount: state ? 1 : 0 };
  }

  async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    const transactionId = ++this.nextTransactionId;
    const stagedStates = new Map<string, StoredState>();
    const stagedResults = new Map<string, StoredResult>();
    const stagedEvents = new Map<string, PlanningEvent>();
    let release: (() => void) | undefined;
    let projectLock: string | undefined;
    const executor: SqlExecutor = {
      query: async <Row>(statement: string, parameters: readonly unknown[] = []): Promise<SqlResult<Row>> => {
        this.calls.push({ transactionId, statement, parameters });
        if (this.failOn && statement.includes(this.failOn)) throw new Error("Simulated SQL failure");
        const output = (rows: unknown[] = [], rowCount = rows.length): SqlResult<Row> => ({ rows: rows as Row[], rowCount });
        if (statement.includes("pg_advisory_xact_lock")) {
          projectLock = String(parameters[0]);
          const previous = this.locks.get(projectLock) ?? Promise.resolve();
          const gate = new Promise<void>((resolve) => { release = resolve; });
          this.locks.set(projectLock, previous.then(() => gate));
          await previous;
          return output([{}]);
        }
        assert.ok(projectLock, "Transaction must lock before even first-use initialization");
        const projectId = String(parameters[0]);
        const stored = stagedStates.get(projectId) ?? this.states.get(projectId);
        if (statement.startsWith("INSERT INTO planning_states")) {
          if (!stored) stagedStates.set(projectId, { revision: 0, stateJson: String(parameters[1]) });
          return output([], stored ? 0 : 1);
        }
        if (statement.startsWith("SELECT project_id")) {
          return output(stored ? [{ project_id: projectId, revision: String(stored.revision), state_json: stored.stateJson }] : []);
        }
        if (statement.startsWith("SELECT revision")) return output(stored ? [{ revision: String(stored.revision) }] : []);
        if (statement.startsWith("UPDATE planning_states")) {
          if (!stored || stored.revision !== parameters[1]) return output();
          stagedStates.set(projectId, { revision: Number(parameters[2]), stateJson: String(parameters[3]) });
          return output([{ revision: String(parameters[2]) }]);
        }
        const resultKey = JSON.stringify(parameters.slice(0, 3));
        if (statement.startsWith("SELECT fingerprint")) {
          const saved = stagedResults.get(resultKey) ?? this.results.get(resultKey);
          return output(saved ? [{ fingerprint: saved.fingerprint, result_json: saved.resultJson }] : []);
        }
        if (statement.startsWith("INSERT INTO planning_idempotency")) {
          if (stagedResults.has(resultKey) || this.results.has(resultKey)) return output();
          stagedResults.set(resultKey, { fingerprint: String(parameters[3]), resultJson: String(parameters[4]) });
          return output([{ idempotency_key: parameters[2] }]);
        }
        if (statement.startsWith("INSERT INTO planning_outbox")) {
          const emitted = JSON.parse(String(parameters[6])) as PlanningEvent;
          if (stagedEvents.has(emitted.id) || this.events.has(emitted.id)) throw new Error("Duplicate outbox event");
          stagedEvents.set(emitted.id, emitted);
          return output([], 1);
        }
        throw new Error(`Unsupported simulated statement: ${statement}`);
      },
    };
    try {
      const result = await work(executor);
      for (const [key, value] of stagedStates) this.states.set(key, value);
      for (const [key, value] of stagedResults) this.results.set(key, value);
      for (const [key, value] of stagedEvents) this.events.set(key, value);
      this.commits += 1;
      return result;
    } catch (error) { this.rollbacks += 1; throw error; }
    finally { release?.(); }
  }
}

test("read returns null before first use and decodes bigint revision without creating tables", async () => {
  const database = new SimulatedDatabase();
  const repository = createPostgresPlanningRepository(database);
  assert.equal(await repository.read("project-1"), null);
  database.seed(initial("project-1", 3));
  assert.deepEqual(await repository.read("project-1"), initial("project-1", 3));
  assert.equal(database.commits, 0);
  assert.ok(database.calls.every((call) => !/CREATE|ALTER|DROP/.test(call.statement)));
});

test("first-use locks before initialization; state, event and idempotency write share one transaction", async () => {
  const database = new SimulatedDatabase();
  const repository = createPostgresPlanningRepository(database);
  const projectId = "project'; DROP TABLE planning_states; --";
  await repository.transaction(projectId, async (state, transaction) => {
    assert.deepEqual(state, initial(projectId));
    await transaction.save({ ...state, revision: 1 }, 0);
    await transaction.emit(event(projectId, 1));
    await transaction.putIdempotent("actor-1:apply", "key-1", "fingerprint-1", { revision: 1 });
  });
  assert.equal(database.commits, 1);
  assert.equal(database.events.size, 1);
  assert.equal(database.results.size, 1);
  assert.ok(database.calls[0]!.statement.includes("pg_advisory_xact_lock"));
  assert.deepEqual(database.calls[0]!.parameters, [`planning:${projectId}`]);
  assert.ok(database.calls.every((call) => call.transactionId === 1 && !call.statement.includes(projectId)));
  assert.equal((await repository.read(projectId))!.revision, 1);
});

test("optimistic revision conflict reports latest revision and retains the previous state", async () => {
  const database = new SimulatedDatabase();
  database.seed(initial("project-1", 4));
  const repository = createPostgresPlanningRepository(database);
  await assert.rejects(repository.transaction("project-1", async (state, transaction) => {
    await transaction.save({ ...state, revision: 3 }, 2);
  }), matchesError("VERSION_CONFLICT", 4));
  assert.equal((await repository.read("project-1"))!.revision, 4);
  assert.equal(database.events.size, 0);
});

test("invalid revision and cross-project writes cannot alter saved state", async () => {
  const database = new SimulatedDatabase();
  database.seed(initial("project-1"));
  const repository = createPostgresPlanningRepository(database);
  await assert.rejects(repository.transaction("project-1", (state, transaction) => transaction.save({ ...state, revision: 2 }, 0)), matchesError("INVALID_REVISION"));
  await assert.rejects(repository.transaction("project-1", (_state, transaction) => transaction.save(initial("project-2", 1), 0)), matchesError("PROJECT_MISMATCH"));
  await assert.rejects(repository.transaction("project-1", (_state, transaction) => transaction.emit(event("project-2", 1))), matchesError("PROJECT_MISMATCH"));
  assert.equal((await repository.read("project-1"))!.revision, 0);
  assert.equal(await repository.read("project-2"), null);
});

test("same scoped idempotency returns original JSON result; actor, action and project scopes are isolated", async () => {
  const database = new SimulatedDatabase();
  const repository = createPostgresPlanningRepository(database);
  await repository.transaction("project-1", async (_state, transaction) => {
    assert.equal(await transaction.getIdempotent("actor-1:apply", "key", "fp"), null);
    await transaction.putIdempotent("actor-1:apply", "key", "fp", { applied: "old", revision: 1 });
    await transaction.putIdempotent("actor-1:apply", "key", "fp", { applied: "new", revision: 2 });
    assert.deepEqual(await transaction.getIdempotent("actor-1:apply", "key", "fp"), { applied: "old", revision: 1 });
    assert.equal(await transaction.getIdempotent("actor-2:apply", "key", "fp"), null);
    assert.equal(await transaction.getIdempotent("actor-1:draft", "key", "fp"), null);
  });
  await repository.transaction("project-2", async (_state, transaction) => {
    assert.equal(await transaction.getIdempotent("actor-1:apply", "key", "fp"), null);
    await transaction.putIdempotent("actor-1:apply", "key", "fp", "a primitive JSON string");
    assert.equal(await transaction.getIdempotent("actor-1:apply", "key", "fp"), "a primitive JSON string");
  });
});

test("reusing an idempotency key for a different fingerprint rejects both read and put", async () => {
  const database = new SimulatedDatabase();
  const repository = createPostgresPlanningRepository(database);
  await repository.transaction("project-1", (_state, transaction) => transaction.putIdempotent("actor:apply", "key", "first", { id: "saved" }));
  await assert.rejects(repository.transaction("project-1", (_state, transaction) => transaction.getIdempotent("actor:apply", "key", "different")), matchesError("IDEMPOTENCY_CONFLICT"));
  await assert.rejects(repository.transaction("project-1", (_state, transaction) => transaction.putIdempotent("actor:apply", "key", "different", { id: "replacement" })), matchesError("IDEMPOTENCY_CONFLICT"));
  assert.equal(database.results.size, 1);
});

test("SQL failure rolls back state, idempotency and outbox together", async () => {
  const database = new SimulatedDatabase();
  database.seed(initial("project-1", 1));
  const repository = createPostgresPlanningRepository(database);
  database.failOn = "INSERT INTO planning_outbox";
  await assert.rejects(repository.transaction("project-1", async (state, transaction) => {
    await transaction.save({ ...state, revision: 2 }, 1);
    await transaction.putIdempotent("actor:apply", "key", "fp", { revision: 2 });
    await transaction.emit(event("project-1", 2));
  }), /Simulated SQL failure/);
  assert.equal((await repository.read("project-1"))!.revision, 1);
  assert.equal(database.results.size, 0);
  assert.equal(database.events.size, 0);
  assert.equal(database.rollbacks, 1);
});

test("callback failure rolls back first-use initialization and an already staged event", async () => {
  const database = new SimulatedDatabase();
  const repository = createPostgresPlanningRepository(database);
  await assert.rejects(repository.transaction("project-1", async (state, transaction) => {
    await transaction.save({ ...state, revision: 1 }, 0);
    await transaction.emit(event("project-1", 1));
    throw new Error("Permission changed");
  }), /Permission changed/);
  assert.equal(await repository.read("project-1"), null);
  assert.equal(database.events.size, 0);
});

test("concurrent first-use writers observe committed revisions in project lock order", async () => {
  const database = new SimulatedDatabase();
  const repository = createPostgresPlanningRepository(database);
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const firstReady = new Promise<void>((resolve) => { firstEntered = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const revisions: number[] = [];
  const first = repository.transaction("project-1", async (state, transaction) => {
    revisions.push(state.revision);
    firstEntered();
    await firstGate;
    await transaction.save({ ...state, revision: 1 }, 0);
  });
  await firstReady;
  const second = repository.transaction("project-1", async (state, transaction) => {
    revisions.push(state.revision);
    await transaction.save({ ...state, revision: 2 }, 1);
  });
  await Promise.resolve();
  assert.deepEqual(revisions, [0]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(revisions, [0, 1]);
  assert.equal((await repository.read("project-1"))!.revision, 2);
});

test("transaction executor cannot be used after commit", async () => {
  const database = new SimulatedDatabase();
  const repository = createPostgresPlanningRepository(database);
  let retained!: PlanningTransaction;
  await repository.transaction("project-1", async (_state, transaction) => { retained = transaction; });
  await assert.rejects(retained.getIdempotent("scope", "key", "fp"), matchesError("PLANNING_TRANSACTION_CLOSED"));
  await assert.rejects(retained.sql.query("SELECT anything"), matchesError("PLANNING_TRANSACTION_CLOSED"));
});

test("corrupt or mismatched stored snapshots fail without exposing raw storage details", async () => {
  const database = new SimulatedDatabase();
  const repository = createPostgresPlanningRepository(database);
  database.states.set("project-1", { revision: 1, stateJson: "invalid JSON from provider" });
  await assert.rejects(repository.read("project-1"), matchesError("PLANNING_PERSISTENCE_INVALID"));
  database.states.set("project-1", { revision: 1, stateJson: JSON.stringify(initial("another-project", 1)) });
  await assert.rejects(repository.read("project-1"), matchesError("PLANNING_PERSISTENCE_INVALID"));
});

test("saving a new revision retains historical plan snapshots and progress corrections intact", async () => {
  const database = new SimulatedDatabase();
  const repository = createPostgresPlanningRepository(database);
  const oldPlan: PlanVersion = {
    id: "plan-old", projectId: "project-1", basePlanVersionId: null, baseTasksRevision: 0,
    inputSnapshot: {
      projectId: "project-1", capturedAt: "2026-10-08T10:00:00Z", projectRevision: 2,
      requirementVersionId: "rules-1", assignmentVersionId: null, availabilityVersions: { "member-1": 4 },
      members: [], availability: [{ membershipId: "member-1", version: 4, confirmedAt: "2026-10-08T09:00:00Z", windows: [{
        id: "window-1", projectId: "project-1", membershipId: "member-1", startsAt: "2026-10-08T19:00:00+08:00",
        endsAt: "2026-10-08T22:00:00+08:00", sourceTimeZone: "Asia/Shanghai", purpose: "work", version: 4,
      }] }], deadlines: [], requirements: [], approvedResourceIds: [], assumptions: [], requiredTaskKinds: [],
    },
    tasks: [], buffers: [], validation: null, changes: [], status: "superseded", reason: "Preserve prior plan",
    createdBy: "user-1", createdAt: "2026-10-08T10:00:00Z", appliedBy: "user-1", appliedAt: "2026-10-08T10:01:00Z",
    acknowledgedIssueCodes: [], revision: 2,
  };
  const original: ProgressUpdate = {
    id: "progress-original", projectId: "project-1", taskId: "task-1", actorId: "user-1", status: "blocked",
    remainingEstimate: null, blocker: "Missing test environment", evidenceRefs: ["evidence-1"], note: "Investigating",
    correctionOf: null, correctionReason: null, acceptance: null, createdAt: "2026-10-08T11:00:00Z",
  };
  const correction: ProgressUpdate = { ...original, id: "progress-correction", status: "in_progress", blocker: null,
    correctionOf: original.id, correctionReason: "Environment is now available", createdAt: "2026-10-08T11:30:00Z" };
  database.seed({ ...initial("project-1", 4), plans: [oldPlan], progressUpdates: [original] });
  await repository.transaction("project-1", (state, transaction) => transaction.save({
    ...state, revision: 5, progressUpdates: [...state.progressUpdates, correction],
  }, 4));
  const saved = (await repository.read("project-1"))!;
  assert.deepEqual(saved.plans, [oldPlan]);
  assert.deepEqual(saved.progressUpdates, [original, correction]);
  assert.equal(saved.revision, 5);
});
