import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor, SqlResult } from "../../shared/persistence.ts";
import { createPostgresPlanningGenerationRepository } from "./generation-postgres.ts";
import type { PlanningGenerationJob, PlanningGenerationTransaction } from "./generation-types.ts";

interface StoredRow {
  id: string; project_id: string; actor_id: string; membership_id: string;
  idempotency_key: string; command_fingerprint: string; status: string;
  revision: string; attempts: string; job_json: string;
}
interface Call { transactionId: number | null; statement: string; parameters: readonly unknown[] }

function job(id = "job-1", projectId = "project-1", actorId = "actor-1", key = "generate-once"): PlanningGenerationJob {
  return {
    id, projectId, actorId, membershipId: `member-${actorId}`, idempotencyKey: key, commandFingerprint: "request-fingerprint",
    status: "queued", revision: 1, attempts: 0, createdAt: "2026-10-08T10:00:00Z", startedAt: null,
    finishedAt: null, leaseExpiresAt: null, durationMs: null, errorCode: null, resultPlanId: null,
    modelVersion: "configured-model", promptVersion: "planning-v1", usage: null, providerRequestId: null,
    snapshot: {
      input: { projectId, capturedAt: "2026-10-08T10:00:00Z", projectRevision: 3, requirementVersionId: "rules-1",
        assignmentVersionId: "assignment-2", availabilityVersions: {}, members: [], availability: [], deadlines: [],
        requirements: [], approvedResourceIds: ["approved-resource-1"], assumptions: [], requiredTaskKinds: [] },
      tasks: [], tasksRevision: 2, basePlanVersionId: "plan-base", resourceContentRefs: [{ resourceId: "approved-resource-1", version: 4 }],
      buffers: [], goal: "Prepare a working submission", instructions: "Keep enough time for verification",
    },
  };
}
function running(previous: PlanningGenerationJob): PlanningGenerationJob {
  return { ...previous, status: "running", revision: previous.revision + 1, attempts: previous.attempts + 1,
    startedAt: "2026-10-08T10:00:01Z", leaseExpiresAt: "2026-10-08T10:05:01Z" };
}
function failed(previous: PlanningGenerationJob): PlanningGenerationJob {
  return { ...previous, status: "failed", revision: previous.revision + 1, leaseExpiresAt: null,
    errorCode: "GENERATION_TIMEOUT_UNKNOWN", finishedAt: "2026-10-08T10:05:02Z", durationMs: 301000 };
}
function stored(value: PlanningGenerationJob): StoredRow {
  return { id: value.id, project_id: value.projectId, actor_id: value.actorId, membership_id: value.membershipId,
    idempotency_key: value.idempotencyKey, command_fingerprint: value.commandFingerprint, status: value.status,
    revision: String(value.revision), attempts: String(value.attempts), job_json: JSON.stringify(value) };
}
const errorCode = (code: string) => (error: unknown): boolean => error instanceof DomainError && error.code === code;

/** SQL contract simulation: no PostgreSQL server or production migration is run. */
class SimulatedDatabase implements DatabasePort {
  rows = new Map<string, StoredRow>();
  calls: Call[] = [];
  locks = new Map<string, Promise<void>>();
  commits = 0;
  rollbacks = 0;
  nextTransactionId = 0;
  failOn: string | null = null;
  seed(value: PlanningGenerationJob): void { this.rows.set(value.id, stored(value)); }

  async query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.calls.push({ transactionId: null, statement, parameters });
    assert.ok(statement.startsWith("SELECT"), "Writes must use a transaction executor");
    let rows = [...this.rows.values()];
    if (statement.includes("WHERE id = $1")) rows = rows.filter(row => row.id === parameters[0]);
    if (statement.includes("WHERE project_id = $1")) rows = rows.filter(row => row.project_id === parameters[0]);
    if (statement.includes("WHERE status = 'queued'")) rows = rows.filter(row => row.status === "queued");
    if (statement.includes("WHERE status = 'running'")) rows = rows.filter(row => row.status === "running");
    const direction = statement.includes("created_at DESC") ? -1 : 1;
    rows.sort((left, right) => {
      const a = JSON.parse(left.job_json) as PlanningGenerationJob;
      const b = JSON.parse(right.job_json) as PlanningGenerationJob;
      const leaseOrder = statement.includes("ORDER BY lease_expires_at") ? String(a.leaseExpiresAt).localeCompare(String(b.leaseExpiresAt)) : 0;
      return leaseOrder || direction * (a.createdAt.localeCompare(b.createdAt) || left.id.localeCompare(right.id));
    });
    if (statement.includes("LIMIT")) rows = rows.slice(0, Number(parameters[parameters.length - 1]));
    const summaries = statement.includes("AS created_at");
    return { rows: rows.map(row => summaries ? { id: row.id, project_id: row.project_id, actor_id: row.actor_id,
      revision: row.revision, status: row.status, created_at: (JSON.parse(row.job_json) as PlanningGenerationJob).createdAt } : row) as Row[], rowCount: rows.length };
  }

  async transaction<T>(work: (sql: SqlExecutor) => Promise<T>): Promise<T> {
    const transactionId = ++this.nextTransactionId;
    const staged = new Map<string, StoredRow>();
    let release: (() => void) | undefined;
    let projectLock: string | undefined;
    const executor: SqlExecutor = {
      query: async <Row>(statement: string, parameters: readonly unknown[] = []): Promise<SqlResult<Row>> => {
        this.calls.push({ transactionId, statement, parameters });
        if (this.failOn && statement.includes(this.failOn)) throw new Error("Simulated SQL failure");
        const output = (rows: unknown[] = []): SqlResult<Row> => ({ rows: rows as Row[], rowCount: rows.length });
        if (statement.includes("pg_advisory_xact_lock")) {
          projectLock = String(parameters[0]);
          const previous = this.locks.get(projectLock) ?? Promise.resolve();
          const gate = new Promise<void>(resolve => { release = resolve; });
          this.locks.set(projectLock, previous.then(() => gate));
          await previous;
          return output([{}]);
        }
        assert.ok(projectLock, "Project planning lock must precede job row locks");
        const all = () => [...new Map([...this.rows, ...staged]).values()];
        if (statement.startsWith("SELECT")) {
          assert.match(statement, /FOR UPDATE$/);
          const selected = all().filter(row => row.project_id === parameters[0]
            && (statement.includes("AND id = $2") ? row.id === parameters[1]
              : row.actor_id === parameters[1] && row.idempotency_key === parameters[2]));
          return output(selected);
        }
        if (statement.startsWith("INSERT")) {
          const next = JSON.parse(String(parameters[11])) as PlanningGenerationJob;
          if (all().some(row => row.id === next.id || (row.project_id === next.projectId
            && row.actor_id === next.actorId && row.idempotency_key === next.idempotencyKey))) return output();
          staged.set(next.id, stored(next));
          return output([{ revision: String(next.revision) }]);
        }
        if (statement.startsWith("UPDATE")) {
          const existing = staged.get(String(parameters[0])) ?? this.rows.get(String(parameters[0]));
          if (!existing || existing.project_id !== parameters[1] || Number(existing.revision) !== parameters[7]
            || existing.actor_id !== parameters[8] || existing.membership_id !== parameters[9]
            || existing.idempotency_key !== parameters[10] || existing.command_fingerprint !== parameters[11]) return output();
          const before = JSON.parse(existing.job_json) as PlanningGenerationJob;
          if (Date.parse(before.createdAt) !== Date.parse(String(parameters[12]))
            || JSON.stringify(before.snapshot) !== String(parameters[13])) return output();
          const next = JSON.parse(String(parameters[6])) as PlanningGenerationJob;
          staged.set(next.id, stored(next));
          return output([{ revision: String(next.revision) }]);
        }
        throw new Error(`Unsupported simulated statement: ${statement}`);
      },
    };
    try {
      const result = await work(executor);
      for (const [id, row] of staged) this.rows.set(id, row);
      this.commits++;
      return result;
    } catch (error) { this.rollbacks++; throw error; }
    finally { release?.(); }
  }
}

test("read decodes bigint metadata without initializing jobs or tables", async () => {
  const db = new SimulatedDatabase();
  const repository = createPostgresPlanningGenerationRepository(db);
  assert.equal(await repository.read("missing-job"), null);
  db.seed(job());
  assert.deepEqual(await repository.read("job-1"), job());
  assert.equal(db.commits, 0);
  assert.ok(db.calls.every(call => !/CREATE|ALTER|INSERT/.test(call.statement)));
});

test("project lock precedes scoped row access and all input remains parameterized", async () => {
  const db = new SimulatedDatabase();
  const repository = createPostgresPlanningGenerationRepository(db);
  const attack = "'; DROP TABLE planning_generation_jobs; --";
  const input = job("job-attack", attack, attack, attack);
  await repository.transaction(attack, async tx => {
    assert.equal(await tx.get(input.id), null);
    assert.equal(await tx.findRequest(input.actorId, input.idempotencyKey), null);
    await tx.save(input, null);
    assert.deepEqual(await tx.get(input.id), input);
  });
  assert.deepEqual(db.calls[0]!.parameters, [`planning:${attack}`]);
  assert.ok(db.calls.every(call => call.transactionId === 1 && !call.statement.includes(attack)));
  assert.ok(db.calls.filter(call => call.statement.includes("FOR UPDATE")).every(call => call.parameters[0] === attack));
  assert.equal(db.commits, 1);
});

test("idempotency lookup isolates project and actor while preserving the first request", async () => {
  const db = new SimulatedDatabase();
  const repository = createPostgresPlanningGenerationRepository(db);
  const first = job();
  await repository.transaction(first.projectId, tx => tx.save(first, null));
  await repository.transaction(first.projectId, async tx => {
    assert.deepEqual(await tx.findRequest("actor-1", first.idempotencyKey), first);
    assert.equal(await tx.findRequest("actor-2", first.idempotencyKey), null);
    await tx.save(job("actor-2-job", "project-1", "actor-2"), null);
  });
  await repository.transaction("project-2", async tx => {
    assert.equal(await tx.findRequest("actor-1", first.idempotencyKey), null);
    await tx.save(job("project-2-job", "project-2"), null);
  });
  await assert.rejects(repository.transaction("project-1", tx => tx.save(job("duplicate-id"), null)), errorCode("VERSION_CONFLICT"));
  assert.equal(db.rows.size, 3);
  assert.deepEqual(await repository.read(first.id), first);
});

test("late result cannot overwrite a failed expired lease using its old revision", async () => {
  const db = new SimulatedDatabase();
  const repository = createPostgresPlanningGenerationRepository(db);
  const started = running(job());
  db.seed(started);
  const timedOut = failed(started);
  await repository.transaction(started.projectId, tx => tx.save(timedOut, started.revision));
  const late: PlanningGenerationJob = { ...started, status: "succeeded", revision: started.revision + 1,
    resultPlanId: "late-plan", finishedAt: "2026-10-08T10:05:03Z", leaseExpiresAt: null };
  await assert.rejects(repository.transaction(started.projectId, tx => tx.save(late, started.revision)), errorCode("VERSION_CONFLICT"));
  assert.deepEqual(await repository.read(started.id), timedOut);
  assert.equal((await repository.listQueued(10)).length, 0, "Storage does not automatically retry expired work");
});

test("saving jobs rejects skipped revisions, cross-project writes and changed immutable request scope", async () => {
  const db = new SimulatedDatabase();
  const repository = createPostgresPlanningGenerationRepository(db);
  const first = job();
  db.seed(first);
  await assert.rejects(repository.transaction("project-1", tx => tx.save({ ...first, revision: 3 }, 1)), errorCode("INVALID_REVISION"));
  await assert.rejects(repository.transaction("project-1", tx => tx.save(first, 0)), errorCode("INVALID_REVISION"));
  await assert.rejects(repository.transaction("project-2", tx => tx.save(running(first), 1)), errorCode("PROJECT_MISMATCH"));
  await assert.rejects(repository.transaction("project-1", tx => tx.save({ ...running(first), actorId: "new-actor" }, 1)), errorCode("VERSION_CONFLICT"));
  await assert.rejects(repository.transaction("project-1", tx => tx.save({ ...running(first), idempotencyKey: "different-key" }, 1)), errorCode("VERSION_CONFLICT"));
  await assert.rejects(repository.transaction("project-1", tx => tx.save({ ...running(first), snapshot: { ...first.snapshot, tasksRevision: 50 } }, 1)), errorCode("VERSION_CONFLICT"));
  assert.deepEqual(await repository.read(first.id), first);
});

test("SQL failure and callback failure roll back every staged job", async () => {
  const db = new SimulatedDatabase();
  const repository = createPostgresPlanningGenerationRepository(db);
  const first = job();
  db.seed(first);
  db.failOn = "INSERT INTO";
  await assert.rejects(repository.transaction("project-1", async tx => {
    await tx.save(running(first), 1);
    await tx.save(job("job-2", "project-1", "actor-2"), null);
  }), /Simulated SQL failure/);
  assert.deepEqual(await repository.read(first.id), first);
  db.failOn = null;
  await assert.rejects(repository.transaction("project-2", async tx => {
    await tx.save(job("job-3", "project-2"), null);
    throw new Error("Facts changed before commit");
  }), /Facts changed/);
  assert.equal(await repository.read("job-3"), null);
  assert.equal(db.rollbacks, 2);
});

test("concurrent claims serialize by project and only one expected revision succeeds", async () => {
  const db = new SimulatedDatabase();
  const repository = createPostgresPlanningGenerationRepository(db);
  const first = job();
  db.seed(first);
  let unlock!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { unlock = resolve; });
  const revisions: number[] = [];
  const winner = repository.transaction(first.projectId, async tx => {
    revisions.push((await tx.get(first.id))!.revision);
    entered();
    await gate;
    await tx.save(running(first), 1);
  });
  await ready;
  const loser = repository.transaction(first.projectId, async tx => {
    revisions.push((await tx.get(first.id))!.revision);
    await tx.save(running(first), 1);
  });
  const loserRejected = assert.rejects(loser, errorCode("VERSION_CONFLICT"));
  await Promise.resolve();
  assert.deepEqual(revisions, [1]);
  unlock();
  await Promise.all([winner, loserRejected]);
  assert.deepEqual(revisions, [1, 2]);
  assert.equal((await repository.read(first.id))!.attempts, 1);
});

test("project-scoped get does not leak another project's job", async () => {
  const db = new SimulatedDatabase();
  const repository = createPostgresPlanningGenerationRepository(db);
  db.seed(job("other-job", "other-project"));
  await repository.transaction("project-1", async tx => {
    assert.equal(await tx.get("other-job"), null);
    assert.equal(await tx.findRequest("actor-1", "generate-once"), null);
  });
});

test("worker lists return only minimal summaries without the model input snapshot", async () => {
  const db = new SimulatedDatabase();
  const repository = createPostgresPlanningGenerationRepository(db);
  const queued = job();
  const processing = running(job("running-job", "project-2"));
  db.seed(queued);
  db.seed(processing);
  db.seed(failed(running(job("failed-job", "project-1", "actor-2"))));
  assert.deepEqual(await repository.listQueued(10), [{ id: queued.id, projectId: queued.projectId, actorId: queued.actorId,
    revision: 1, status: "queued", createdAt: queued.createdAt }]);
  assert.deepEqual(await repository.listRunning(10), [{ id: processing.id, projectId: processing.projectId, actorId: processing.actorId,
    revision: 2, status: "running", createdAt: processing.createdAt }]);
  assert.ok(db.calls.every(call => !/UPDATE|INSERT/.test(call.statement)), "Listing expired leases has no state-changing side effects");
  const own = await repository.listForProject("project-1", 1);
  assert.equal(own.length, 1);
  assert.equal(own[0]!.projectId, "project-1");
});

test("invalid list bounds fail before SQL and no caller-supplied limit is interpolated", async () => {
  const db = new SimulatedDatabase();
  const repository = createPostgresPlanningGenerationRepository(db);
  for (const limit of [0, -1, 1.5, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(repository.listQueued(limit), errorCode("INVALID_LIMIT"));
    await assert.rejects(repository.listRunning(limit), errorCode("INVALID_LIMIT"));
    await assert.rejects(repository.listForProject("project-1", limit), errorCode("INVALID_LIMIT"));
  }
  assert.equal(db.calls.length, 0);
  await repository.listQueued(100);
  assert.deepEqual(db.calls[0]!.parameters, [100]);
  assert.match(db.calls[0]!.statement, /LIMIT \$1$/);
});

test("retained transaction methods and SQL cannot execute after commit or rollback", async () => {
  const db = new SimulatedDatabase();
  const repository = createPostgresPlanningGenerationRepository(db);
  let retained!: PlanningGenerationTransaction;
  await repository.transaction("project-1", async tx => { retained = tx; });
  await assert.rejects(retained.get("job-1"), errorCode("PLANNING_GENERATION_TRANSACTION_CLOSED"));
  await assert.rejects(retained.findRequest("actor-1", "key"), errorCode("PLANNING_GENERATION_TRANSACTION_CLOSED"));
  await assert.rejects(retained.save(job(), null), errorCode("PLANNING_GENERATION_TRANSACTION_CLOSED"));
  await assert.rejects(retained.sql.query("SELECT anything"), errorCode("PLANNING_GENERATION_TRANSACTION_CLOSED"));
  assert.equal(db.calls.length, 1);
});

test("invalid persisted metadata and snapshots fail without raw storage details", async () => {
  const db = new SimulatedDatabase();
  const repository = createPostgresPlanningGenerationRepository(db);
  const raw = stored(job());
  db.rows.set(raw.id, { ...raw, job_json: "malformed provider secret" });
  await assert.rejects(repository.read(raw.id), errorCode("PLANNING_GENERATION_PERSISTENCE_INVALID"));
  db.rows.set(raw.id, { ...raw, revision: "999" });
  await assert.rejects(repository.read(raw.id), errorCode("PLANNING_GENERATION_PERSISTENCE_INVALID"));
  const invalid = job();
  invalid.snapshot.input.projectId = "another-project";
  db.rows.set(raw.id, { ...raw, job_json: JSON.stringify(invalid) });
  await assert.rejects(repository.read(raw.id), errorCode("PLANNING_GENERATION_PERSISTENCE_INVALID"));
});

test("inconsistent lifecycle fields are rejected before persistence", async () => {
  const db = new SimulatedDatabase();
  const repository = createPostgresPlanningGenerationRepository(db);
  const invalidJobs: PlanningGenerationJob[] = [
    { ...job(), status: "running" },
    { ...job(), status: "failed", errorCode: "GENERATION_TIMEOUT_UNKNOWN" },
    { ...job(), status: "succeeded", finishedAt: "2026-10-08T10:00:01Z" },
    { ...job(), leaseExpiresAt: "2026-10-08T10:00:01Z" },
    { ...job(), usage: { inputTokens: -1, outputTokens: 0 } },
  ];
  for (const input of invalidJobs) {
    await assert.rejects(repository.transaction("project-1", tx => tx.save(input, null)), errorCode("PLANNING_GENERATION_SERIALIZATION_INVALID"));
  }
  assert.equal(db.rows.size, 0);
  assert.ok(db.calls.every(call => !call.statement.startsWith("INSERT")));
});

async function isolatedSqlDatabase(): Promise<{ engine: PGlite; database: DatabasePort }> {
  const engine = new PGlite();
  await engine.waitReady;
  await engine.exec(await readFile(new URL("./migrations/002-planning-generation.sql", import.meta.url), "utf8"));
  const executor = (query: PGlite["query"]): SqlExecutor => ({
    async query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<SqlResult<Row>> {
      const result = await query<Row>(statement, [...parameters]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  });
  const database: DatabasePort = {
    ...executor(engine.query.bind(engine)),
    transaction: work => engine.transaction(tx => work(executor(tx.query.bind(tx)))),
  };
  return { engine, database };
}

test("isolated PGlite executes the proposed migration and persists explicit timeout recovery", async t => {
  const { engine, database } = await isolatedSqlDatabase();
  t.after(() => engine.close());
  const repository = createPostgresPlanningGenerationRepository(database);
  const first = job();
  await repository.transaction(first.projectId, tx => tx.save(first, null));
  const started = running(first);
  await repository.transaction(first.projectId, tx => tx.save(started, first.revision));
  assert.equal((await repository.listRunning(10))[0]!.revision, 2);
  const timeout = failed(started);
  await repository.transaction(first.projectId, tx => tx.save(timeout, started.revision));
  assert.deepEqual(await repository.read(first.id), timeout);
  assert.deepEqual(await repository.listQueued(10), []);
  const explicitlyRetried: PlanningGenerationJob = { ...timeout, revision: timeout.revision + 1, status: "queued",
    errorCode: null, finishedAt: null, startedAt: null, durationMs: null };
  await repository.transaction(first.projectId, tx => tx.save(explicitlyRetried, timeout.revision));
  const secondAttempt = running(explicitlyRetried);
  await repository.transaction(first.projectId, tx => tx.save(secondAttempt, explicitlyRetried.revision));
  const completed: PlanningGenerationJob = { ...secondAttempt, revision: secondAttempt.revision + 1, status: "succeeded",
    finishedAt: "2026-10-08T10:07:00Z", resultPlanId: "draft-ready-for-review", leaseExpiresAt: null,
    usage: { inputTokens: 1200, outputTokens: 700 }, providerRequestId: "provider-request-2" };
  await repository.transaction(first.projectId, tx => tx.save(completed, secondAttempt.revision));
  const reopenedRepository = createPostgresPlanningGenerationRepository(database);
  assert.deepEqual(await reopenedRepository.read(first.id), completed);
  assert.deepEqual(await reopenedRepository.listQueued(10), []);
  assert.deepEqual(await reopenedRepository.listRunning(10), []);
});

test("isolated PGlite enforces scoped request uniqueness, immutable snapshots, and JSONB-column parity", async t => {
  const { engine, database } = await isolatedSqlDatabase();
  t.after(() => engine.close());
  const repository = createPostgresPlanningGenerationRepository(database);
  const first = job();
  await repository.transaction(first.projectId, tx => tx.save(first, null));
  await assert.rejects(repository.transaction(first.projectId, tx => tx.save(job("duplicate-job"), null)), errorCode("VERSION_CONFLICT"));
  await repository.transaction(first.projectId, tx => tx.save(job("other-actor-job", first.projectId, "actor-2"), null));
  await repository.transaction("project-2", tx => tx.save(job("other-project-job", "project-2"), null));
  await assert.rejects(repository.transaction(first.projectId, tx => tx.save({ ...running(first), snapshot: {
    ...first.snapshot, resourceContentRefs: [{ resourceId: "approved-resource-1", version: 5 }],
  } }, 1)), errorCode("VERSION_CONFLICT"));
  await assert.rejects(engine.query("UPDATE planning_generation_jobs SET body = jsonb_set(body, '{status}', '\"running\"') WHERE id = $1", [first.id]));
  await assert.rejects(engine.query("UPDATE planning_generation_jobs SET lease_expires_at = $2::timestamptz WHERE id = $1", [first.id, "2026-10-08T10:05:01Z"]));
  assert.deepEqual(await repository.read(first.id), first);
  assert.equal((await repository.listForProject(first.projectId, 100)).length, 2);
});
