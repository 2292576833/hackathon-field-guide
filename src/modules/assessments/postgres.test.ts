import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor, SqlResult } from "../../shared/persistence.ts";
import { PostgresAssessmentRepository, PostgresAssessmentTransaction, PostgresQuestionCatalog } from "./postgres.ts";
import type { AssessmentAttempt, AssessmentEvent, AssessmentScore, AssignmentVersion, QuestionSet, RubricVersion, ScoringJob } from "./types.ts";

interface QueryCall { readonly statement: string; readonly parameters: readonly unknown[] }
interface RecordedReply { readonly rows: readonly unknown[]; readonly rowCount: number }

/** SQL recording fixture only: does not execute SQL or simulate a PostgreSQL server. */
class RecordingSql implements SqlExecutor {
  readonly calls: QueryCall[] = [];
  readonly replies: RecordedReply[];

  constructor(replies: readonly RecordedReply[] = []) { this.replies = [...replies]; }

  async query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.calls.push({ statement: statement.replace(/\s+/g, " ").trim(), parameters });
    const reply = this.replies.shift();
    if (!reply) throw new Error("Unexpected SQL query in recording fixture");
    return { rows: reply.rows as readonly Row[], rowCount: reply.rowCount };
  }
}

class RecordingDatabase implements DatabasePort {
  readonly connection: RecordingSql;
  transactions = 0;
  commits = 0;
  rollbacks = 0;

  constructor(connection: RecordingSql) { this.connection = connection; }

  async query<Row>(): Promise<SqlResult<Row>> { throw new Error("Query escaped transaction connection"); }

  async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactions += 1;
    try {
      const result = await work(this.connection);
      this.commits += 1;
      return result;
    } catch (error) {
      this.rollbacks += 1;
      throw error;
    }
  }
}

const now = "2026-10-08T12:00:00.000Z";
const rubric: RubricVersion = {
  id: "rubric_1", version: 1,
  criteria: [{ id: "c1", dimension: "testing", label: "验证步骤", weight: 1, maxScore: 3, anchors: ["未说明", "基本步骤", "异常路径", "复现依据"] }],
  missingEvidencePolicy: "exclude_from_denominator", limitations: ["仅本次任务量规"],
};
const questionSet: QuestionSet = {
  id: "questions_1", version: 1, rubricVersionId: rubric.id, status: "published", difficultyLabel: "入门小任务",
  allowedTools: ["可以使用 AI 并说明用途"], maxFollowUps: 1, limitations: ["未覆盖全部能力"],
  questions: [{ id: "q1", taskTemplateId: "test_small_flow", prompt: "写出验证步骤", criterionIds: ["c1"], required: true }],
};
const attempt: AssessmentAttempt = {
  id: "attempt_1", projectId: "project_1", membershipId: "membership_1", userId: "author_1",
  questionSetId: questionSet.id, rubricVersionId: rubric.id, questionSetSnapshot: questionSet, rubricSnapshot: rubric,
  profile: { experience: "刚开始", tools: [], preferredTasks: ["testing"], memberAvailabilityVersionId: null },
  answers: [{ questionId: "q1", text: "私人答案 don't expose", aiUsage: "未使用", evidence: [] }],
  followUps: [], sharing: { criterionIds: [], confirmedTasks: [] }, status: "draft", revision: 1,
  latestScoreId: null, activeJobId: null, scoringRuns: 0, createdAt: now, updatedAt: now, submittedAt: null,
};
const job: ScoringJob = {
  id: "job_1", attemptId: attempt.id, projectId: attempt.projectId, userId: attempt.userId,
  idempotencyKey: "request_1", inputFingerprint: "fingerprint_1", status: "queued", revision: 1, runNumber: 1,
  correctionReason: null, createdAt: now, startedAt: null, finishedAt: null, durationMs: null, failureCode: null, resultScoreId: null,
};
const score: AssessmentScore = {
  id: "score_1", attemptId: attempt.id, rubricVersionId: rubric.id,
  criterionScores: [{ criterionId: "c1", state: "insufficient_evidence", score: null, evidenceRefs: [], reason: "此项尚无证据", unverified: [] }],
  limitations: ["本次量规"], modelVersion: "test-only", promptVersion: "test-only", provenance: "test_fixture", status: "published",
  supersedesScoreId: null, correctionReason: null, validatedAt: now,
};
const assignment: AssignmentVersion = {
  id: "assignment_1", projectId: attempt.projectId, baseVersionId: null,
  inputSnapshot: { projectId: attempt.projectId, projectRevision: 1, membershipRevision: 1, requirementVersionId: null, members: [], sharedSummaryRefs: [] },
  assignments: [], gaps: [], assumptions: [], changes: [], validationIssues: [], status: "draft", revision: 1,
  createdBy: attempt.userId, createdAt: now, updatedAt: now, appliedBy: null, appliedAt: null,
};
const event: AssessmentEvent = {
  eventId: "event_1", type: "AssignmentApplied", aggregateId: assignment.id, projectId: attempt.projectId,
  version: 1, occurredAt: now, payload: { assignmentVersionId: assignment.id, headRevision: 1 },
};
const reply = (rows: readonly unknown[] = [], rowCount = rows.length): RecordedReply => ({ rows, rowCount });

test("repository passes the same transaction SQL executor through mutations and outbox", async () => {
  const sql = new RecordingSql([reply([{ revision: 1 }]), reply([], 1)]);
  const database = new RecordingDatabase(sql);
  const result = await new PostgresAssessmentRepository(database).transaction(async (tx) => {
    assert.equal(tx.sql, sql);
    await tx.saveAttempt(attempt, null);
    await tx.appendEvent(event);
    return "saved";
  });
  assert.equal(result, "saved");
  assert.equal(database.transactions, 1);
  assert.equal(database.commits, 1);
  assert.equal(database.rollbacks, 0);
  assert.match(sql.calls[1].statement, /^INSERT INTO assessments_outbox/);
  assert.deepEqual(JSON.parse(sql.calls[1].parameters[6] as string), event.payload);
  assert.ok(!sql.calls[1].statement.includes(attempt.answers[0].text));
});

test("CAS conflict propagates to transaction owner without an apparent commit", async () => {
  const sql = new RecordingSql([reply(), reply([{ revision: 7 }])]);
  const database = new RecordingDatabase(sql);
  await assert.rejects(new PostgresAssessmentRepository(database).transaction((tx) => tx.saveAttempt(attempt, null)), (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, "VERSION_CONFLICT");
    assert.equal(error.status, 409);
    assert.equal(error.latestRevision, 7);
    return true;
  });
  assert.equal(database.commits, 0);
  assert.equal(database.rollbacks, 1);
  assert.match(sql.calls[0].statement, /ON CONFLICT DO NOTHING/);
  assert.ok(!sql.calls[0].statement.includes("DO UPDATE"));
});

test("private answers, identifiers and SQL-like text are parameters, never interpolated", async () => {
  const injection = "attempt'; DROP TABLE assessments_attempts; --";
  const value = { ...attempt, id: injection };
  const sql = new RecordingSql([reply([{ revision: 1 }])]);
  await new PostgresAssessmentTransaction(sql).saveAttempt(value, null);
  assert.equal(sql.calls[0].parameters[0], injection);
  assert.deepEqual(JSON.parse(sql.calls[0].parameters[12] as string), value);
  assert.match(sql.calls[0].statement, /\$13::jsonb/);
  assert.ok(!sql.calls[0].statement.includes(injection));
  assert.ok(!sql.calls[0].statement.includes(value.answers[0].text));
});

test("CAS update predicates include the expected revision and stable identity", async () => {
  const cases = [
    { name: "attempt", row: attempt, table: "assessments_attempts", expectedSlot: 13,
      save: (tx: PostgresAssessmentTransaction) => tx.saveAttempt({ ...attempt, revision: 2 }, 1) },
    { name: "job", row: job, table: "assessments_scoring_jobs", expectedSlot: 12,
      save: (tx: PostgresAssessmentTransaction) => tx.saveJob({ ...job, revision: 2 }, 1) },
    { name: "assignment", row: assignment, table: "assessments_assignment_versions", expectedSlot: 9,
      save: (tx: PostgresAssessmentTransaction) => tx.saveAssignment({ ...assignment, revision: 2 }, 1) },
  ];
  for (const item of cases) {
    const sql = new RecordingSql([reply([{ revision: 2 }])]);
    await item.save(new PostgresAssessmentTransaction(sql));
    const call = sql.calls[0];
    assert.ok(call.statement.startsWith(`UPDATE ${item.table}`), item.name);
    assert.match(call.statement, /WHERE id = \$1 AND/);
    assert.ok(call.statement.includes(`revision = $${item.expectedSlot + 1}`), item.name);
    assert.equal(call.parameters[item.expectedSlot], 1);
    assert.equal(call.parameters[0], item.row.id);
  }
});

test("attempt/job/assignment stale writes return latestRevision and never rewrite latest data", async () => {
  const writes = [
    (tx: PostgresAssessmentTransaction) => tx.saveAttempt({ ...attempt, revision: 2 }, 1),
    (tx: PostgresAssessmentTransaction) => tx.saveJob({ ...job, revision: 2 }, 1),
    (tx: PostgresAssessmentTransaction) => tx.saveAssignment({ ...assignment, revision: 2 }, 1),
  ];
  for (const write of writes) {
    const sql = new RecordingSql([reply(), reply([{ revision: 9 }])]);
    await assert.rejects(write(new PostgresAssessmentTransaction(sql)), (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "VERSION_CONFLICT");
      assert.equal(error.latestRevision, 9);
      return true;
    });
    assert.equal(sql.calls.length, 2);
    assert.match(sql.calls[1].statement, /^SELECT revision/);
  }
});

test("job insert detects scoped idempotency uniqueness as a recoverable conflict", async () => {
  const sql = new RecordingSql([reply(), reply([{ revision: 3 }])]);
  await assert.rejects(new PostgresAssessmentTransaction(sql).saveJob(job, null), (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.latestRevision, 3);
    return true;
  });
  assert.match(sql.calls[0].statement, /ON CONFLICT DO NOTHING/);
  assert.match(sql.calls[1].statement, /attempt_id = \$2 AND user_id = \$3 AND idempotency_key = \$4/);
  assert.deepEqual(sql.calls[1].parameters, [job.id, job.attemptId, job.userId, job.idempotencyKey]);
});

test("getHead creates zero pointer idempotently, then locks it before first application", async () => {
  const sql = new RecordingSql([reply([], 1), reply([{ project_id: attempt.projectId, version_id: null, revision: 0 }]), reply([{ revision: 1 }])]);
  const tx = new PostgresAssessmentTransaction(sql);
  assert.deepEqual(await tx.getHead(attempt.projectId), { projectId: attempt.projectId, versionId: null, revision: 0 });
  await tx.saveHead({ projectId: attempt.projectId, versionId: assignment.id, revision: 1 }, 0);
  assert.match(sql.calls[0].statement, /VALUES \(\$1, NULL, 0\) ON CONFLICT \(project_id\) DO NOTHING/);
  assert.match(sql.calls[1].statement, /FOR UPDATE$/);
  assert.match(sql.calls[2].statement, /WHERE project_id = \$1 AND revision = \$4/);
  assert.deepEqual(sql.calls[2].parameters, [attempt.projectId, assignment.id, 1, 0]);
});

test("head CAS conflict reports current revision", async () => {
  const sql = new RecordingSql([reply(), reply([{ revision: 4 }])]);
  await assert.rejects(new PostgresAssessmentTransaction(sql).saveHead({ projectId: attempt.projectId, versionId: assignment.id, revision: 2 }, 1), (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.latestRevision, 4);
    return true;
  });
});

test("history reads return an empty or existing head without creating a database row", async () => {
  const sql = new RecordingSql([reply(), reply([{ project_id: attempt.projectId, version_id: assignment.id, revision: 2 }])]);
  const tx = new PostgresAssessmentTransaction(sql);
  assert.deepEqual(await tx.getHead(attempt.projectId, false), { projectId: attempt.projectId, versionId: null, revision: 0 });
  assert.deepEqual(await tx.getHead(attempt.projectId, false), { projectId: attempt.projectId, versionId: assignment.id, revision: 2 });
  assert.equal(sql.calls.length, 2);
  assert.ok(sql.calls.every((call) => call.statement.startsWith("SELECT ")));
});

test("reads use transaction locks and decode both native JSONB and JSON text", async () => {
  const sql = new RecordingSql([
    reply([{ data: JSON.stringify(attempt) }]), reply([{ data: attempt }]), reply([{ data: score }]),
    reply([{ data: JSON.stringify(job) }]), reply([{ data: job }]), reply([{ data: assignment }]),
  ]);
  const tx = new PostgresAssessmentTransaction(sql);
  assert.deepEqual(await tx.getAttempt(attempt.id), attempt);
  assert.deepEqual(await tx.listAttempts(attempt.projectId), [attempt]);
  assert.deepEqual(await tx.getScores(attempt.id), [score]);
  assert.deepEqual(await tx.getJob(job.id), job);
  assert.deepEqual(await tx.findJob(attempt.id, attempt.userId, job.idempotencyKey), job);
  assert.deepEqual(await tx.getAssignment(assignment.id), assignment);
  for (const index of [0, 3, 4, 5]) assert.match(sql.calls[index].statement, /FOR UPDATE$/);
  assert.match(sql.calls[1].statement, /ORDER BY id FOR SHARE$/);
  assert.deepEqual(sql.calls[4].parameters, [attempt.id, attempt.userId, job.idempotencyKey]);
});

test("missing entities return null/empty lists without leaking existence through invalid parsing", async () => {
  const sql = new RecordingSql([reply(), reply(), reply(), reply(), reply(), reply()]);
  const tx = new PostgresAssessmentTransaction(sql);
  assert.equal(await tx.getAttempt("missing"), null);
  assert.deepEqual(await tx.listAttempts("missing"), []);
  assert.deepEqual(await tx.getScores("missing"), []);
  assert.equal(await tx.getJob("missing"), null);
  assert.equal(await tx.findJob("missing", "user", "key"), null);
  assert.equal(await tx.getAssignment("missing"), null);
});

test("score writes append only, preserve JSON and reject reuse of immutable score ID", async () => {
  const sql = new RecordingSql([reply([{ id: score.id }]), reply()]);
  const tx = new PostgresAssessmentTransaction(sql);
  await tx.insertScore(score);
  assert.deepEqual(JSON.parse(sql.calls[0].parameters[5] as string), score);
  assert.match(sql.calls[0].statement, /^INSERT INTO assessments_scores/);
  assert.match(sql.calls[0].statement, /ON CONFLICT DO NOTHING RETURNING id$/);
  await assert.rejects(tx.insertScore(score), (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, "SCORE_ALREADY_EXISTS");
    assert.equal(error.status, 409);
    return true;
  });
});

test("revision gaps and invalid insert revisions are rejected before issuing SQL", async () => {
  const sql = new RecordingSql();
  const tx = new PostgresAssessmentTransaction(sql);
  await assert.rejects(tx.saveAttempt({ ...attempt, revision: 3 }, 1), { code: "INVALID_REVISION" });
  await assert.rejects(tx.saveJob({ ...job, revision: 2 }, null), { code: "INVALID_REVISION" });
  await assert.rejects(tx.saveAssignment(assignment, -1), { code: "INVALID_REVISION" });
  await assert.rejects(tx.saveHead({ projectId: attempt.projectId, versionId: null, revision: 0 }, 0), { code: "INVALID_REVISION" });
  assert.equal(sql.calls.length, 0);
});

test("malformed persisted JSON returns a safe diagnostic without private raw content", async () => {
  const secret = "PRIVATE_RAW_ANSWER_invalid_json";
  const sql = new RecordingSql([reply([{ data: secret }]), reply([{ data: [] }]), reply([{ data: null }])]);
  const tx = new PostgresAssessmentTransaction(sql);
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(tx.getAttempt(attempt.id), (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "PERSISTENCE_INVALID_DATA");
      assert.equal(error.status, 500);
      assert.ok(!error.message.includes(secret));
      return true;
    });
  }
});

test("catalog reads immutable body with current retirement status and handles missing entries", async () => {
  const sql = new RecordingSql([reply([{ data: JSON.stringify(questionSet), status: "retired" }]), reply([{ data: rubric }]), reply(), reply()]);
  const catalog = new PostgresQuestionCatalog(sql);
  assert.deepEqual(await catalog.getQuestionSet(questionSet.id), { ...questionSet, status: "retired" });
  assert.deepEqual(await catalog.getRubric(rubric.id), rubric);
  assert.equal(await catalog.getQuestionSet("missing"), null);
  assert.equal(await catalog.getRubric("missing"), null);
  for (const call of sql.calls) {
    assert.match(call.statement, /^SELECT /);
    assert.ok(!call.statement.includes("FOR UPDATE"));
  }
});

test("migration proposal declares scoped uniqueness, same-aggregate relations and immutable history guards", async () => {
  const migration = await readFile(new URL("./sql/001-assessments.sql", import.meta.url), "utf8");
  assert.match(migration, /UNIQUE \(attempt_id, user_id, idempotency_key\)/);
  assert.match(migration, /CREATE TABLE assessments_assignment_heads \(\s+project_id text PRIMARY KEY/);
  assert.match(migration, /FOREIGN KEY \(result_score_id, attempt_id\) REFERENCES assessments_scores\(id, attempt_id\)/);
  assert.match(migration, /FOREIGN KEY \(attempt_id, project_id, user_id\) REFERENCES assessments_attempts\(id, project_id, user_id\)/);
  assert.match(migration, /CREATE TRIGGER assessments_score_immutable BEFORE UPDATE OR DELETE/);
  assert.match(migration, /CREATE TRIGGER assessments_question_version_guard BEFORE UPDATE OR DELETE/);
  assert.match(migration, /CREATE TRIGGER assessments_applied_assignment_guard BEFORE UPDATE OR DELETE/);
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(migration, /SENSITIVE full author profile/);
});
