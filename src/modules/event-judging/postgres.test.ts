import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { HostedEventScope } from "../../shared/organizer-contracts.ts";
import type { IntakeReceipt, JudgingRound, JudgeAssignment, ManualScore, PublishedResults, ResultSummary } from "./model.ts";
import type { JudgingAudit } from "./postgres.ts";
import * as repository from "./postgres.ts";

/** Isolated in-memory SQL verification. Never opens the application's PGlite directory. */
let engine: PGlite;
let database: DatabasePort;
function executor(connection: Pick<PGlite, "query">): SqlExecutor {
  return {
    async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      const result = await connection.query<Row>(statement, [...parameters]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
}
before(async () => {
  engine = new PGlite();
  await engine.exec("CREATE TABLE auth_users(id text PRIMARY KEY); INSERT INTO auth_users(id) VALUES ('captain'),('judge'),('staff');");
  await engine.exec(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
  database = {
    ...executor(engine),
    transaction: work => engine.transaction(transaction => work(executor(transaction))),
  };
});
after(async () => { await engine.close(); });

const time = "2026-10-11T08:00:00.000Z";
function scope(label: string): HostedEventScope {
  return {
    organizationId: `org-${label}`, organizationName: `测试主办方 ${label}`,
    eventId: `event-${label}`, title: `测试比赛 ${label}`, status: "published", revision: 1, publishedRevision: 1,
    timezone: "Asia/Shanghai", startsAt: time, endsAt: "2026-10-12T12:00:00.000Z",
    registrationOpensAt: "2026-10-01T00:00:00.000Z", registrationClosesAt: time,
    submissionClosesAt: "2026-10-12T10:00:00.000Z",
    modules: { registration: true, teams: true, icebreaking: false, judging: true, schedule: true, accommodation: false, mealVouchers: false },
    registration: { reviewRequired: false, capacity: 100 },
    teams: { mode: "free", minSize: 1, maxSize: 5, locksAt: time }, linkedEventId: null,
  };
}
async function seed(label: string, publish = false) {
  const event = scope(label);
  await repository.lockEvent(database, event);
  const receipt: IntakeReceipt = {
    id: `receipt-${label}`, eventId: event.eventId, organizationId: event.organizationId, teamId: `team-${label}`,
    authorUserId: "captain", eventRevision: 1, publishedRevision: 1, teamRevision: 1, previousVersion: 0,
    submissionClosesAt: event.submissionClosesAt!, version: 1, receiptNumber: `REC-${label}`, submittedAt: time,
    ruleVersion: 1, memberUserIds: ["captain"], inputHash: "a".repeat(64), idempotencyKey: `key-${label}`,
    submissionRecordId: null, materials: { title: `正式作品 ${label}`, description: "选手明确提交的正式材料。", links: [{ label: "演示", url: "https://example.com/demo" }], files: [] },
    materialHash: "b".repeat(64), warning: "链接和文件元数据不表示平台已下载或运行作品。",
  };
  await repository.insertReceipt(database, receipt);
  let round: JudgingRound = {
    id: `round-${label}`, eventId: event.eventId, organizationId: event.organizationId, revision: 1, status: "setup",
    config: { title: "首轮评审", criteria: [{ id: "quality", label: "作品质量", weight: 100, min: 0, max: 10 }], minJudges: 1, missingPolicy: "block_publication", tiePolicy: "shared_rank" },
    snapshotIds: [], createdAt: time, startedAt: null, lockedAt: null, lockedSummary: null, publishedResultId: null,
  };
  await repository.insertRound(database, round);
  round = { ...round, revision: 2, status: "open", snapshotIds: [receipt.id], startedAt: time };
  assert.equal(await repository.updateRound(database, event, 1, round), true);
  const assignment: JudgeAssignment = {
    id: `assignment-${label}`, eventId: event.eventId, organizationId: event.organizationId, roundId: round.id,
    snapshotId: receipt.id, judgeUserId: "judge", revision: 1, status: "active", conflictReasons: [], declaration: "clear", createdAt: time,
  };
  await repository.insertAssignment(database, assignment);
  let score: ManualScore = {
    id: `score-${label}`, eventId: event.eventId, organizationId: event.organizationId, assignmentId: assignment.id,
    revision: 1, state: "draft", values: { quality: 8 }, feedback: "演示清楚。", updatedAt: time,
  };
  await repository.insertScore(database, score);
  const summary: ResultSummary = {
    rows: [{ snapshotId: receipt.id, teamId: receipt.teamId, title: receipt.materials.title, submittedJudgeCount: 1, missingJudges: 0, total: 80, rank: 1 }],
    missingPolicy: round.config.missingPolicy, tiePolicy: round.config.tiePolicy, complete: true, hasTies: false,
  };
  const published: PublishedResults = {
    id: `published-${label}`, eventId: event.eventId, organizationId: event.organizationId, roundId: round.id,
    version: 1, visibility: "public", publishedAt: time, publishedBy: "staff", rows: summary.rows,
    approvedFeedback: [{ snapshotId: receipt.id, text: "演示清楚。", visibility: "team" }],
  };
  if (publish) {
    score = { ...score, revision: 2, state: "submitted" };
    assert.equal(await repository.updateScore(database, event, 1, score), true);
    const locked: JudgingRound = { ...round, revision: 3, status: "locked", lockedAt: time, lockedSummary: summary };
    assert.equal(await repository.updateRound(database, event, 2, locked), true);
    await repository.insertPublished(database, published);
    round = { ...locked, revision: 4, status: "published", publishedResultId: published.id };
    assert.equal(await repository.updateRound(database, event, 3, round), true);
  }
  const audit: JudgingAudit = {
    id: `audit-${label}`, eventId: event.eventId, organizationId: event.organizationId, actorUserId: "staff",
    action: publish ? "results_published" : "round_started", subjectId: round.id, reason: "隔离测试记录", createdAt: time,
    details: { receipt, round, score },
  };
  await repository.insertAudit(database, audit);
  return { event, receipt, round, assignment, score, published, audit };
}
const sqlState = (code: string) => (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === code;

test("every read filters both organization and event, including guessed IDs and replay keys", async () => {
  const { event, receipt, round, assignment, score, published, audit } = await seed("read", true);
  const another = await seed("read-other", true);
  assert.deepEqual((await repository.listReceipts(database, another.event)).map(item => item.id), [another.receipt.id]);
  assert.deepEqual(await repository.getReceipt(database, event, receipt.id), receipt);
  assert.deepEqual(await repository.getRound(database, event, round.id), round);
  assert.deepEqual(await repository.getAssignment(database, event, assignment.id), assignment);
  assert.deepEqual(await repository.getScore(database, event, assignment.id), score);
  assert.deepEqual(await repository.getPublished(database, event, published.id), published);
  assert.deepEqual(await repository.findReplay(database, event, receipt.authorUserId, receipt.idempotencyKey), receipt);
  assert.deepEqual(await repository.listAudits(database, event), [audit]);
  for (const foreign of [{ ...event, organizationId: another.event.organizationId }, { ...event, eventId: another.event.eventId }]) {
    for (const read of [repository.listReceipts, repository.listRounds, repository.listAssignments, repository.listScores, repository.listPublished, repository.listAudits]) {
      assert.deepEqual(await read(database, foreign), []);
    }
    assert.equal(await repository.getReceipt(database, foreign, receipt.id), null);
    assert.equal(await repository.getRound(database, foreign, round.id), null);
    assert.equal(await repository.getAssignment(database, foreign, assignment.id), null);
    assert.equal(await repository.getScore(database, foreign, assignment.id), null);
    assert.equal(await repository.getPublished(database, foreign, published.id), null);
    assert.equal(await repository.findReplay(database, foreign, receipt.authorUserId, receipt.idempotencyKey), null);
  }
});

test("SQL injection strings are bound values in receipt, scope and replay queries", async () => {
  const { event, receipt } = await seed("parameterized");
  const attack = "'; DROP TABLE ej_manual_scores;--";
  const calls: { statement: string; parameters: readonly unknown[] }[] = [];
  const observed: SqlExecutor = {
    query<Row>(statement: string, parameters: readonly unknown[] = []) {
      calls.push({ statement, parameters });
      return database.query<Row>(statement, parameters);
    },
  };
  const malicious: IntakeReceipt = { ...receipt, id: attack, version: 2, previousVersion: 1, receiptNumber: "REC-injection", idempotencyKey: attack };
  await repository.insertReceipt(observed, malicious);
  assert.equal((await repository.getReceipt(observed, event, attack))?.id, attack);
  assert.equal((await repository.findReplay(observed, event, receipt.authorUserId, attack))?.id, attack);
  assert.deepEqual(await repository.listReceipts(observed, { ...event, organizationId: attack }), []);
  assert.deepEqual(await repository.listReceipts(observed, { ...event, eventId: attack }), []);
  assert.equal(await repository.getReceipt(observed, event, "x' OR '1'='1"), null);
  for (const call of calls) {
    assert.equal(call.statement.includes(attack), false);
    assert.ok(call.parameters.some(value => value === attack || value === "x' OR '1'='1"));
  }
  assert.equal((await repository.listScores(database, event)).length, 1, "injected DROP did not execute");
});

test("composite foreign keys reject cross-event references and uniqueness preserves receipts and assignments", async () => {
  const a = await seed("fk-a"), b = await seed("fk-b");
  await assert.rejects(() => repository.insertAssignment(database, { ...b.assignment, id: "cross-round", roundId: a.round.id }), sqlState("23503"));
  await assert.rejects(() => repository.insertAssignment(database, { ...b.assignment, id: "cross-receipt", snapshotId: a.receipt.id }), sqlState("23503"));
  await assert.rejects(() => repository.insertScore(database, { ...b.score, id: "cross-assignment", assignmentId: a.assignment.id }), sqlState("23503"));
  await assert.rejects(() => repository.insertPublished(database, { ...b.published, id: "cross-publication", roundId: a.round.id }), sqlState("23503"));
  await assert.rejects(() => repository.insertReceipt(database, { ...a.receipt, id: "duplicate-key", version: 2, receiptNumber: "REC-duplicate-key" }), sqlState("23505"));
  await assert.rejects(() => repository.insertReceipt(database, { ...a.receipt, id: "duplicate-version", idempotencyKey: "fresh-key", receiptNumber: "REC-duplicate-version" }), sqlState("23505"));
  await assert.rejects(() => repository.insertAssignment(database, { ...a.assignment, id: "duplicate-judge" }), sqlState("23505"));
  await assert.rejects(() => repository.insertScore(database, { ...a.score, id: "duplicate-score" }), sqlState("23505"));
});

for (const kind of ["receipt", "published", "audit"] as const) {
  test(`${kind} history rejects update and delete while retaining its original document`, async () => {
    const fixture = await seed(`immutable-${kind}`, true);
    const table = { receipt: "ej_intake_receipts", published: "ej_published_results", audit: "ej_judging_audits" }[kind];
    const value = fixture[kind];
    // Table comes only from the fixed test enum; IDs remain parameterized.
    await assert.rejects(() => database.query(`UPDATE ${table} SET document=document || $2::jsonb WHERE id=$1`, [value.id, JSON.stringify({ tampered: true })]), sqlState("23514"));
    await assert.rejects(() => database.query(`DELETE FROM ${table} WHERE id=$1`, [value.id]), sqlState("23514"));
    const result = await database.query<{ document: unknown }>(`SELECT document FROM ${table} WHERE id=$1`, [value.id]);
    assert.deepEqual(result.rows[0]?.document, value);
  });
}

test("opened rounds freeze criteria, selected snapshots and return to setup", async () => {
  const { event, round } = await seed("frozen");
  assert.equal(round.status, "open");
  for (const after of [
    { ...round, config: { ...round.config, title: "修改后的标准" } },
    { ...round, snapshotIds: [] },
    { ...round, status: "setup" as const },
  ]) {
    await assert.rejects(() => repository.updateRound(database, event, round.revision, { ...after, revision: round.revision + 1 }), sqlState("23514"));
  }
  assert.deepEqual(await repository.getRound(database, event, round.id), round);
});

test("CAS gives one winner for concurrent same-revision round, assignment and score writes", async () => {
  const { event, round, assignment, score } = await seed("cas");
  const roundCandidates: JudgingRound[] = [
    { ...round, revision: round.revision + 1, status: "locked", lockedAt: time },
    { ...round, revision: round.revision + 1, status: "locked", lockedAt: "2026-10-11T08:01:00.000Z" },
  ];
  const assignmentCandidates: JudgeAssignment[] = [
    { ...assignment, revision: 2, status: "recused", declaration: "conflict" },
    { ...assignment, revision: 2, status: "revoked" },
  ];
  const scoreCandidates: ManualScore[] = [
    { ...score, revision: 2, state: "submitted", values: { quality: 9 } },
    { ...score, revision: 2, state: "submitted", values: { quality: 6 } },
  ];
  const roundWins = await Promise.all(roundCandidates.map(value => repository.updateRound(database, event, round.revision, value)));
  const assignmentWins = await Promise.all(assignmentCandidates.map(value => repository.updateAssignment(database, event, assignment.revision, value)));
  const scoreWins = await Promise.all(scoreCandidates.map(value => repository.updateScore(database, event, score.revision, value)));
  assert.equal(roundWins.filter(Boolean).length, 1);
  assert.equal(assignmentWins.filter(Boolean).length, 1);
  assert.equal(scoreWins.filter(Boolean).length, 1);
  assert.deepEqual(await repository.getRound(database, event, round.id), roundCandidates[roundWins.findIndex(Boolean)]);
  assert.deepEqual(await repository.getAssignment(database, event, assignment.id), assignmentCandidates[assignmentWins.findIndex(Boolean)]);
  assert.deepEqual(await repository.getScore(database, event, assignment.id), scoreCandidates[scoreWins.findIndex(Boolean)]);
  await assert.rejects(() => repository.updateScore(database, { ...event, organizationId: "wrong-org" }, 2, { ...score, revision: 3 }), sqlState("EVENT_SCOPE_MISMATCH"));
});

test("transaction rollback restores score, receipt and audit when the final permission check fails", async () => {
  const { event, receipt, assignment, score, audit } = await seed("rollback");
  const nextReceipt: IntakeReceipt = { ...receipt, id: "rollback-receipt-new", version: 2, previousVersion: 1, receiptNumber: "REC-rollback-new", idempotencyKey: "rollback-key-new" };
  await assert.rejects(() => database.transaction(async sql => {
    await repository.lockEvent(sql, event);
    assert.equal(await repository.updateScore(sql, event, score.revision, { ...score, revision: 2, state: "submitted" }), true);
    await repository.insertReceipt(sql, nextReceipt);
    await repository.insertAudit(sql, { ...audit, id: "rollback-audit-new", action: "score_submitted", subjectId: score.id, details: { before: score, after: { ...score, revision: 2 } } });
    throw new Error("request session revoked during transaction");
  }), /request session revoked/);
  assert.deepEqual(await repository.getScore(database, event, assignment.id), score);
  assert.equal(await repository.getReceipt(database, event, nextReceipt.id), null);
  assert.equal(await repository.findReplay(database, event, nextReceipt.authorUserId, nextReceipt.idempotencyKey), null);
  assert.deepEqual(await repository.listAudits(database, event), [audit]);
});

test("indexed identities and revisions cannot diverge from the stored JSON document", async () => {
  const { event, score, assignment } = await seed("document-check");
  await assert.rejects(() => database.query("UPDATE ej_manual_scores SET document=document || $2::jsonb WHERE id=$1", [score.id, JSON.stringify({ eventId: "different-event" })]), sqlState("23514"));
  await assert.rejects(() => database.query("UPDATE ej_manual_scores SET document=document || $2::jsonb WHERE id=$1", [score.id, JSON.stringify({ revision: 99 })]), sqlState("23514"));
  await assert.rejects(() => database.query("UPDATE ej_judge_assignments SET document=document || $2::jsonb WHERE id=$1", [assignment.id, JSON.stringify({ judgeUserId: "staff" })]), sqlState("23514"));
  assert.deepEqual(await repository.getScore(database, event, assignment.id), score);
});

test("assigned event lookup returns only the requested judge's unique active or needs-review events", async () => {
  const judgeUserId = "event-index-owner";
  await database.query("INSERT INTO auth_users(id) VALUES($1)", [judgeUserId]);
  const active = await seed("index-active"), needsReview = await seed("index-needs-review");
  const revoked = await seed("index-revoked"), recused = await seed("index-recused"), other = await seed("index-other-owner");
  for (const [fixture, status, declaration] of [
    [active, "active", "unconfirmed"], [needsReview, "needs_review", "unconfirmed"],
    [revoked, "revoked", "clear"], [recused, "recused", "conflict"],
  ] as const) {
    await repository.insertAssignment(database, { ...fixture.assignment, id: `own-${fixture.assignment.id}`, judgeUserId, status, declaration });
  }
  // A second active assignment in the same event must not create a second entry.
  const secondRound: JudgingRound = { ...active.round, id: "index-second-round", revision: 1, status: "setup", snapshotIds: [], startedAt: null };
  await repository.insertRound(database, secondRound);
  assert.equal(await repository.updateRound(database, active.event, 1, { ...secondRound, revision: 2, status: "open", snapshotIds: [active.receipt.id], startedAt: time }), true);
  await repository.insertAssignment(database, { ...active.assignment, id: "index-duplicate-event", roundId: secondRound.id, judgeUserId });
  await repository.insertAssignment(database, { ...other.assignment, id: "index-other-judge", judgeUserId: "staff" });

  const calls: { statement: string; parameters: readonly unknown[] }[] = [];
  const observed: SqlExecutor = {
    query<Row>(statement: string, parameters: readonly unknown[] = []) {
      calls.push({ statement, parameters });
      return database.query<Row>(statement, parameters);
    },
  };
  const expected = [active.event.eventId, needsReview.event.eventId].sort();
  assert.deepEqual(await repository.listAssignedEventIds(observed, judgeUserId), expected);
  assert.deepEqual(await repository.listAssignedEventIds(database, "staff"), [other.event.eventId]);
  assert.deepEqual(await repository.listAssignedEventIds(database, "not-a-judge"), []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.parameters[0], judgeUserId);
  assert.doesNotMatch(calls[0]!.statement, /\b(document|materials|values|feedback)\b/i, "entry discovery does not read private content");
  assert.match(calls[0]!.statement, /^SELECT\s+DISTINCT\s+event_id\b/i);
});

test("candidate lookup rechecks current assignments, excludes new events and binds candidate IDs safely", async () => {
  const judgeUserId = "event-index-recheck";
  await database.query("INSERT INTO auth_users(id) VALUES($1)", [judgeUserId]);
  const first = await seed("index-recheck-a"), second = await seed("index-recheck-b");
  const firstAssignment: JudgeAssignment = { ...first.assignment, id: "recheck-own-a", judgeUserId, declaration: "unconfirmed" };
  const secondAssignment: JudgeAssignment = { ...second.assignment, id: "recheck-own-b", judgeUserId, status: "needs_review", declaration: "unconfirmed" };
  await repository.insertAssignment(database, firstAssignment); await repository.insertAssignment(database, secondAssignment);
  const initial = await repository.listAssignedEventIds(database, judgeUserId);
  assert.deepEqual(initial, [first.event.eventId, second.event.eventId].sort());
  assert.equal(await repository.updateAssignment(database, first.event, firstAssignment.revision, { ...firstAssignment, revision: 2, status: "revoked" }), true);
  const added = await seed("index-recheck-added-after-list");
  await repository.insertAssignment(database, { ...added.assignment, id: "recheck-own-added", judgeUserId });
  assert.deepEqual(await repository.listAssignedEventIds(database, judgeUserId, initial), [second.event.eventId]);
  assert.deepEqual(await repository.listAssignedEventIds(database, judgeUserId, [first.event.eventId]), []);
  assert.deepEqual(await repository.listAssignedEventIds(database, "staff", initial), []);
  assert.deepEqual(await repository.listAssignedEventIds(database, judgeUserId, [second.event.eventId, "x') OR true --"]), [second.event.eventId]);
  assert.deepEqual(await repository.listAssignedEventIds(database, "x' OR true --", initial), []);
  const failOnQuery: SqlExecutor = { async query<Row>() { assert.fail("empty candidate list must perform no SQL read"); return { rows: [] as Row[], rowCount: 0 }; } };
  assert.deepEqual(await repository.listAssignedEventIds(failOnQuery, judgeUserId, []), []);
});

test("assigned event lookup deterministically caps both initial and candidate reads at 100 actual SQL rows", async () => {
  const judgeUserId = "event-index-bounded", organizationId = "org-index-bounded", count = 105;
  await database.query("INSERT INTO auth_users(id) VALUES($1)", [judgeUserId]);
  const template = await seed("index-bound-template");
  // Generate independent, valid scope/FK facts inside the isolated database.
  await database.query("INSERT INTO ej_event_locks(organization_id,event_id) SELECT $1::text,'event-index-bound-' || lpad(n::text,3,'0') FROM generate_series(0,$2::integer-1) AS sequence(n)", [organizationId, count]);
  await database.query(`INSERT INTO ej_intake_receipts(id,organization_id,event_id,team_id,author_user_id,version,receipt_number,idempotency_key,submitted_at,document)
    SELECT 'bound-receipt-' || lpad(n::text,3,'0'),$1::text,'event-index-bound-' || lpad(n::text,3,'0'),'bound-team-' || lpad(n::text,3,'0'),
      'captain',1,'REC-bound-' || lpad(n::text,3,'0'),'key-bound-' || lpad(n::text,3,'0'),$4::timestamptz,
      $3::jsonb || jsonb_build_object('id','bound-receipt-' || lpad(n::text,3,'0'),'organizationId',$1::text,'eventId','event-index-bound-' || lpad(n::text,3,'0'),
        'teamId','bound-team-' || lpad(n::text,3,'0'),'receiptNumber','REC-bound-' || lpad(n::text,3,'0'),'idempotencyKey','key-bound-' || lpad(n::text,3,'0'))
    FROM generate_series(0,$2::integer-1) AS sequence(n)`, [organizationId, count, JSON.stringify(template.receipt), time]);
  await database.query(`INSERT INTO ej_judging_rounds(id,organization_id,event_id,revision,status,created_at,document)
    SELECT 'bound-round-' || lpad(n::text,3,'0'),$1::text,'event-index-bound-' || lpad(n::text,3,'0'),2,'open',$4::timestamptz,
      $3::jsonb || jsonb_build_object('id','bound-round-' || lpad(n::text,3,'0'),'organizationId',$1::text,'eventId','event-index-bound-' || lpad(n::text,3,'0'),
        'snapshotIds',jsonb_build_array('bound-receipt-' || lpad(n::text,3,'0')))
    FROM generate_series(0,$2::integer-1) AS sequence(n)`, [organizationId, count, JSON.stringify(template.round), time]);
  await database.query(`INSERT INTO ej_judge_assignments(id,organization_id,event_id,round_id,snapshot_id,judge_user_id,revision,status,declaration,created_at,document)
    SELECT 'bound-assignment-' || lpad(n::text,3,'0'),$1::text,'event-index-bound-' || lpad(n::text,3,'0'),'bound-round-' || lpad(n::text,3,'0'),
      'bound-receipt-' || lpad(n::text,3,'0'),$5::text,1,'active','unconfirmed',$4::timestamptz,
      $3::jsonb || jsonb_build_object('id','bound-assignment-' || lpad(n::text,3,'0'),'organizationId',$1::text,'eventId','event-index-bound-' || lpad(n::text,3,'0'),
        'roundId','bound-round-' || lpad(n::text,3,'0'),'snapshotId','bound-receipt-' || lpad(n::text,3,'0'),'judgeUserId',$5::text,'declaration','unconfirmed')
    FROM generate_series(0,$2::integer-1) AS sequence(n)`, [organizationId, count, JSON.stringify(template.assignment), time, judgeUserId]);
  const allIds = Array.from({ length: count }, (_, index) => `event-index-bound-${String(index).padStart(3, "0")}`);
  const firstHundred = allIds.slice(0, 100);
  assert.equal((await database.query<{ count: number }>("SELECT count(*)::integer AS count FROM ej_judge_assignments WHERE judge_user_id=$1", [judgeUserId])).rows[0]!.count, count);
  assert.deepEqual(await repository.listAssignedEventIds(database, judgeUserId), firstHundred);
  assert.deepEqual(await repository.listAssignedEventIds(database, judgeUserId, [...allIds].reverse()), firstHundred);
  assert.deepEqual(await repository.listAssignedEventIds(database, judgeUserId, allIds.slice(100)), allIds.slice(100), "candidate filtering is applied before the 100-row cap");
});
