import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { HostedEventScope, EventRosterTeamSnapshot, EventRegistrationSnapshot, OrganizerPrincipal, HostedEventAccessPort, EventParticipationPort, EventJudgeConflictPort, VerifiedEventSubmissionPort, EventCommunityConfig } from "../../shared/organizer-contracts.ts";
import { DEFAULT_EVENT_COMMUNITY } from "../../shared/organizer-contracts.ts";
import { createEventJudgingService } from "./service.ts";
import type { JudgingConfig, JudgingRound, IntakeReceipt, JudgeAssignment, SubmissionMaterials, SubmissionInput, ScoreInput, WorkDisclosure, WorkComment } from "./model.ts";
import type { SubmissionLinkContextPort } from "./ports.ts";

const currentTime = "2026-10-11T08:00:00.000Z";
const deadline = "2026-10-12T08:00:00.000Z";
const userIds = ["alice", "member", "bob", "staff", "staff-b", "judge-1", "judge-2", "judge-3", "outsider"];
const baseConfig: JudgingConfig = {
  title: "正式评审", criteria: [{ id: "idea", label: "想法", weight: 60, min: 0, max: 10 }, { id: "build", label: "实现", weight: 40, min: 0, max: 10 }],
  minJudges: 1, missingPolicy: "block_publication", tiePolicy: "shared_rank",
};
const material = (title = "作品甲"): SubmissionMaterials => ({ title, description: "明确提交的作品说明", links: [{ label: "演示", url: "https://example.org/demo" }], files: [] });
const errorCode = (code: string) => (error: unknown): boolean => error instanceof DomainError && error.code === code;

function eventScope(eventId: string, organizationId: string): HostedEventScope {
  return { eventId, organizationId, organizationName: `机构${organizationId}`, title: `赛事${eventId}`, status: "published", revision: 1, publishedRevision: 1,
    timezone: "Asia/Shanghai", startsAt: currentTime, endsAt: deadline, registrationOpensAt: null, registrationClosesAt: null, submissionClosesAt: deadline,
    modules: { registration: true, teams: true, judging: true, schedule: false, accommodation: false, mealVouchers: false, icebreaking: false },
    registration: { reviewRequired: false, capacity: null }, teams: { mode: "free", minSize: 1, maxSize: 4, locksAt: currentTime }, linkedEventId: null };
}

/** Each fixture is an isolated temporary PGlite; no runtime directory or production data is opened. */
async function fixture(t: TestContext, linked = false) {
  const pg = new PGlite(); t.after(() => pg.close()); await pg.waitReady;
  await pg.exec("CREATE TABLE auth_users(id text PRIMARY KEY); CREATE TABLE test_verified_receipts(id text PRIMARY KEY, document jsonb NOT NULL);");
  for (const userId of userIds) await pg.query("INSERT INTO auth_users(id) VALUES($1)", [userId]);
  await pg.exec(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
  function executor(query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>): SqlExecutor {
    const sql: SqlExecutor = { async query<Row>(statement: string, params: readonly unknown[] = []) {
      const result = await query(statement, [...params]); await hooks.query?.(statement, params, sql);
      return { rows: result.rows as Row[], rowCount: result.affectedRows ?? result.rows.length };
    } };
    return sql;
  }
  const database: DatabasePort = { ...executor((sql, params) => pg.query(sql, params)), transaction: work => pg.transaction(tx => work(executor((sql, params) => tx.query(sql, params)))) };
  const scopes = new Map([ ["event-a", eventScope("event-a", "org-a")], ["event-b", eventScope("event-b", "org-b")], ["event-c", eventScope("event-c", "org-a")] ]);
  const teams = new Map<string, EventRosterTeamSnapshot>();
  const registrations = new Map<string, EventRegistrationSnapshot>();
  const addTeam = (eventId: string, teamId: string, captain: string, members: readonly string[]) => {
    teams.set(`${eventId}:${teamId}`, { id: teamId, eventId, organizationId: scopes.get(eventId)!.organizationId, captainUserId: captain, memberUserIds: members,
      revision: 1, status: "locked", eligible: true, projectId: linked && eventId === "event-a" ? `private-${teamId}` : null });
    for (const userId of members) registrations.set(`${eventId}:${userId}`, { id: `registration-${eventId}-${userId}`, eventId, userId, status: "approved", revision: 1 });
  };
  addTeam("event-a", "team-a", "alice", ["alice", "member"]); addTeam("event-a", "team-two", "bob", ["bob"]); addTeam("event-b", "team-b", "bob", ["bob"]);
  if (linked) scopes.set("event-a", { ...scopes.get("event-a")!, linkedEventId: "m03-event-a" });
  const staffGrants = new Set(["event-a:staff", "event-b:staff-b", "event-c:staff"]), revokedSessions = new Set<string>();
  const conflictStatuses = new Map<string, "clear" | "conflict" | "needs_review">();
  const hooks: {
    staff?: () => void;
    /** 真实根里 organizer 的 eventAccess.requireStaff 拒绝非工作人员时抛 ORGANIZER_FORBIDDEN；用于复现该合同。 */
    staffDenial?: (eventId: string, userId: string) => Error | null;
    /** Controlled state change after a real SQL read, before the service can return it. */
    query?: (statement: string, params: readonly unknown[], sql: SqlExecutor) => Promise<void> | void;
    conflict?: (input: Parameters<EventJudgeConflictPort["inspect"]>[1], status: "clear" | "conflict" | "needs_review") => "clear" | "conflict" | "needs_review";
    team?: (eventId: string, teamId: string, value: EventRosterTeamSnapshot | null) => EventRosterTeamSnapshot | null;
    registration?: (eventId: string, userId: string, value: EventRegistrationSnapshot | null) => EventRegistrationSnapshot | null;
  } = {};
  const principal = (userId: string, platformRoles: Actor["platformRoles"] = ["user"]): OrganizerPrincipal => ({ actor: { userId, platformRoles }, guard: async sql => {
    const user = await sql.query("SELECT id FROM auth_users WHERE id=$1", [userId]);
    if (!user.rows.length || revokedSessions.has(userId)) throw new DomainError("SESSION_REVOKED", "会话已撤销。", { status: 401 });
  } });
  const events: HostedEventAccessPort = {
    async getEvent(_sql, eventId, options) { assert.equal(options?.forUpdate, true); return scopes.get(eventId) ?? null; },
    async requireStaff(_sql, actor, eventId, capability) {
      assert.equal(capability, "judging_manage");
      hooks.staff?.();
      const denial = hooks.staffDenial?.(eventId, actor.userId);
      if (denial) throw denial;
      if (!staffGrants.has(`${eventId}:${actor.userId}`)) throw new DomainError("STAFF_REQUIRED", "没有这场比赛的评审管理权限。", { status: 403 });
      return scopes.get(eventId)!;
    },
  };
  const participation: EventParticipationPort = {
    async getTeam(_sql, eventId, teamId) { const value = teams.get(`${eventId}:${teamId}`) ?? null; return hooks.team ? hooks.team(eventId, teamId, value) : value; },
    async getRegistration(_sql, eventId, userId) { const value = registrations.get(`${eventId}:${userId}`) ?? null; return hooks.registration ? hooks.registration(eventId, userId, value) : value; },
  };
  const conflicts: EventJudgeConflictPort = { async inspect(_sql, input) { const initial = conflictStatuses.get(`${input.eventId}:${input.teamId}:${input.judgeUserId}`) ?? "clear", status = hooks.conflict ? hooks.conflict(input, initial) : initial; return { status, reasons: status === "clear" ? [] : ["受控的已知辅导或待核查关联"] }; } };
  const bridgeCalls: { sql: SqlExecutor; receipt: Parameters<VerifiedEventSubmissionPort["recordReceipt"]>[2] }[] = [];
  const verifiedSubmissions: VerifiedEventSubmissionPort = { async recordReceipt(sql, _principal, receipt) {
    bridgeCalls.push({ sql, receipt }); await sql.query("INSERT INTO test_verified_receipts(id,document) VALUES($1,$2::jsonb)", [receipt.id, JSON.stringify(receipt)]);
    return { submissionRecordId: `m06-${receipt.id}` };
  } };
  let nextId = 0, nextKey = 0;
  const time = { value: currentTime };
  const context: { value: unknown } = { value: { stageId: "verified-stage", requirementsVersion: "m03-event-a:7:2", repositoryCommitSha: "a".repeat(40) } }, contextExecutors: SqlExecutor[] = [];
  const service = createEventJudgingService({ database, clock: { now: () => new Date(time.value) }, ids: { next: () => `ej-${++nextId}` }, events, participation, conflicts,
    ...(linked ? { verifiedSubmissions, submissionLinkContext: { async resolve(sql: SqlExecutor) { contextExecutors.push(sql); return context.value as Awaited<ReturnType<SubmissionLinkContextPort["resolve"]>>; } } } : {}) });
  const prepare = async (teamId = "team-a", userId = "alice", eventId = "event-a", materials = material()): Promise<SubmissionInput> => {
    const preview = await service.previewSubmission(principal(userId), eventId, { teamId, materials });
    return { teamId, materials: preview.materials, expectedEventRevision: preview.eventRevision, expectedTeamRevision: preview.teamRevision,
      expectedPreviousVersion: preview.previousVersion, expectedMaterialHash: preview.materialHash, idempotencyKey: `retry-${++nextKey}` };
  };
  const submit = async (teamId = "team-a", userId = "alice", title = "作品甲") => service.submit(principal(userId), "event-a", await prepare(teamId, userId, "event-a", material(title)));
  const staff = principal("staff", ["admin"]);
  const start = async (overrides: Partial<JudgingConfig> = {}): Promise<JudgingRound> => { const setup = await service.saveConfig(staff, "event-a", { expectedRevision: 0, config: { ...baseConfig, ...overrides } }); return service.startRound(staff, "event-a", setup.id, setup.revision); };
  const assign = async (round: JudgingRound, receipt: IntakeReceipt, judgeUserId = "judge-1"): Promise<JudgeAssignment> => {
    const assignment = await service.assignJudge(staff, "event-a", { roundId: round.id, snapshotId: receipt.id, judgeUserId, expectedRoundRevision: round.revision });
    return service.declareConflict(principal(judgeUserId), "event-a", assignment.id, { expectedRevision: assignment.revision, hasConflict: false, reason: "已核对正式作品与关系" });
  };
  const scoreInput = (assignment: JudgeAssignment, expectedScoreRevision = 0, values: Readonly<Record<string, number>> = { idea: 8, build: 8 }): ScoreInput => ({ expectedAssignmentRevision: assignment.revision, expectedScoreRevision, values, feedback: "人工评语" });
  return { pg, database, service, scopes, teams, registrations, hooks, staffGrants, revokedSessions, conflictStatuses, principal, staff, bridgeCalls, time, context, contextExecutors, prepare, submit, start, assign, scoreInput };
}

test("formal receipt freezes materials, same-input retry is identical and altered retry cannot replace history", async t => {
  const f = await fixture(t), input = await f.prepare();
  const receipt = await f.service.submit(f.principal("alice"), "event-a", input);
  assert.equal(receipt.version, 1); assert.equal(receipt.submissionRecordId, null); assert.equal(receipt.ruleVersion, 1);
  assert.match(receipt.warning, /不表示平台已下载/);
  assert.deepEqual(await f.service.submit(f.principal("alice"), "event-a", input), receipt);
  await assert.rejects(f.service.submit(f.principal("alice"), "event-a", { ...input, materials: material("另一个作品") }), errorCode("IDEMPOTENCY_KEY_REUSED"));
  const second = await f.submit("team-a", "alice", "第二版"); assert.equal(second.version, 2);
  const history = await f.service.mySubmissions(f.principal("member"), "event-a", "team-a");
  assert.equal(history.items.length, 2); assert.deepEqual(history.items[0], receipt);
  await assert.rejects(f.database.query("DELETE FROM ej_intake_receipts WHERE id=$1", [receipt.id]), /immutable/);
});

test("deadline, roster versions, eligibility, captain and organization/event scope are checked before intake", async t => {
  const f = await fixture(t), input = await f.prepare();
  f.scopes.set("event-a", { ...f.scopes.get("event-a")!, revision: 2 });
  await assert.rejects(f.service.submit(f.principal("alice"), "event-a", input), errorCode("JUDGING_VERSION_CONFLICT"));
  f.scopes.set("event-a", { ...f.scopes.get("event-a")!, revision: 1 });
  f.teams.set("event-a:team-a", { ...f.teams.get("event-a:team-a")!, revision: 2 });
  await assert.rejects(f.service.submit(f.principal("alice"), "event-a", input), errorCode("JUDGING_VERSION_CONFLICT"));
  await assert.rejects(f.service.previewSubmission(f.principal("member"), "event-a", { teamId: "team-a", materials: material() }), errorCode("SUBMISSION_CAPTAIN_REQUIRED"));
  await assert.rejects(f.service.submit(f.principal("alice"), "event-b", input), errorCode("TEAM_ACCESS_DENIED"));
  f.teams.set("event-a:team-a", { ...f.teams.get("event-a:team-a")!, eligible: false });
  await assert.rejects(f.prepare(), errorCode("TEAM_NOT_ELIGIBLE"));
  f.time.value = deadline; await assert.rejects(f.prepare(), errorCode("SUBMISSION_CLOSED"));
  assert.equal((await f.database.query<{ count: number }>("SELECT count(*)::int AS count FROM ej_intake_receipts")).rows[0]!.count, 0);
  await assert.rejects(f.service.workspace(f.principal("staff", ["admin", "reviewer"]), "event-b"), errorCode("STAFF_REQUIRED"));
});

test("session revoked at the final transaction guard rolls back both intake and the trusted M06 bridge", async t => {
  const f = await fixture(t, true), input = await f.prepare(), base = f.principal("alice"), guards: SqlExecutor[] = [];
  const revoked: OrganizerPrincipal = { actor: base.actor, guard: async sql => { guards.push(sql); await base.guard(sql); if (guards.length === 2) throw new DomainError("SESSION_REVOKED", "会话已撤销。", { status: 401 }); } };
  await assert.rejects(f.service.submit(revoked, "event-a", input), errorCode("SESSION_REVOKED"));
  assert.equal(guards[0], guards[1]); assert.equal(guards[0], f.bridgeCalls[0]!.sql);
  assert.equal((await f.database.query<{ count: number }>("SELECT count(*)::int AS count FROM ej_intake_receipts")).rows[0]!.count, 0);
  assert.equal((await f.database.query<{ count: number }>("SELECT count(*)::int AS count FROM test_verified_receipts")).rows[0]!.count, 0);
  const receipt = await f.service.submit(base, "event-a", input);
  assert.equal(receipt.submissionRecordId, `m06-${receipt.id}`); assert.equal(f.bridgeCalls[1]!.receipt.linkedEventId, "m03-event-a");
  assert.equal(f.bridgeCalls[1]!.receipt.projectId, "private-team-a"); assert.equal(f.bridgeCalls[1]!.receipt.requirementsVersion, "m03-event-a:7:2");
  await f.service.submit(base, "event-a", input); assert.equal(f.bridgeCalls.length, 2);
});

test("concurrent intake has one version winner and repeated identical keys never create a second receipt", async t => {
  const f = await fixture(t), input = await f.prepare();
  const writes = await Promise.allSettled([f.service.submit(f.principal("alice"), "event-a", input), f.service.submit(f.principal("alice"), "event-a", { ...input, idempotencyKey: "different-key" })]);
  assert.equal(writes.filter(item => item.status === "fulfilled").length, 1);
  assert.equal((writes.find(item => item.status === "rejected") as PromiseRejectedResult).reason.code, "SUBMISSION_PREVIEW_STALE");
  const next = await f.prepare();
  const replay = await Promise.all([f.service.submit(f.principal("alice"), "event-a", next), f.service.submit(f.principal("alice"), "event-a", next)]);
  assert.deepEqual(replay[0], replay[1]); assert.equal(replay[0]!.version, 2);
  assert.equal((await f.service.mySubmissions(f.principal("alice"), "event-a", "team-a")).items.length, 2);
});

test("a roster revoked after the initial check cannot leave an intake receipt or bridge record", async t => {
  const f = await fixture(t, true), input = await f.prepare(); let reads = 0;
  f.hooks.team = (eventId, teamId, value) => eventId === "event-a" && teamId === "team-a" && ++reads > 1 ? null : value;
  await assert.rejects(f.service.submit(f.principal("alice"), "event-a", input), errorCode("TEAM_ACCESS_DENIED"));
  assert.equal((await f.database.query<{ count: number }>("SELECT count(*)::int AS count FROM ej_intake_receipts")).rows[0]!.count, 0);
  assert.equal((await f.database.query<{ count: number }>("SELECT count(*)::int AS count FROM test_verified_receipts")).rows[0]!.count, 0);
});

test("starting a round freezes standards and the latest receipt selection without absorbing later versions", async t => {
  const f = await fixture(t), original = await f.submit(), round = await f.start();
  assert.deepEqual(round.snapshotIds, [original.id]);
  await assert.rejects(f.service.saveConfig(f.staff, "event-a", { roundId: round.id, expectedRevision: round.revision, config: { ...baseConfig, title: "静默替换" } }), errorCode("JUDGING_CONFIG_FROZEN"));
  const later = await f.submit("team-a", "alice", "开轮后第二版");
  await assert.rejects(f.service.assignJudge(f.staff, "event-a", { roundId: round.id, snapshotId: later.id, judgeUserId: "judge-1", expectedRoundRevision: round.revision }), errorCode("JUDGING_ASSIGNMENT_INVALID"));
  assert.deepEqual((await f.service.workspace(f.staff, "event-a")).rounds[0]!.snapshotIds, [original.id]);
  await assert.rejects(f.service.saveConfig(f.staff, "event-a", { expectedRevision: 0, config: { ...baseConfig, criteria: [{ id: "__proto__", label: "危险维度", weight: 100, min: 0, max: 10 }] } }), errorCode("JUDGING_INVALID_INPUT"));
});

test("unassigned managers, known members, pending conflicts, recused and revoked judges cannot read or score", async t => {
  const f = await fixture(t), receipt = await f.submit(), round = await f.start();
  await assert.rejects(f.service.assignJudge(f.staff, "event-a", { roundId: round.id, snapshotId: receipt.id, judgeUserId: "alice", expectedRoundRevision: round.revision }), errorCode("JUDGE_CONFLICT"));
  const assignment = await f.assign(round, receipt);
  await assert.rejects(f.service.saveScore(f.staff, "event-a", assignment.id, f.scoreInput(assignment)), errorCode("JUDGE_ACCESS_DENIED"));
  await assert.rejects(f.service.judgeMaterials(f.principal("judge-1"), "event-b", assignment.id), errorCode("JUDGE_ASSIGNMENT_NOT_FOUND"));
  f.conflictStatuses.set("event-a:team-a:judge-2", "needs_review");
  const pending = await f.assign(round, receipt, "judge-2"); assert.equal(pending.status, "needs_review");
  await assert.rejects(f.service.judgeMaterials(f.principal("judge-2"), "event-a", pending.id), errorCode("JUDGE_ACCESS_DENIED"));
  await assert.rejects(f.service.reviewAssignment(f.staff, "event-a", pending.id, { expectedRevision: pending.revision, reason: "不能覆盖待核查" }), errorCode("JUDGE_CONFLICT_UNRESOLVED"));
  f.conflictStatuses.set("event-a:team-a:judge-2", "clear");
  const cleared = await f.service.reviewAssignment(f.staff, "event-a", pending.id, { expectedRevision: pending.revision, reason: "可信来源已核查清楚" });
  await f.service.judgeMaterials(f.principal("judge-2"), "event-a", cleared.id);
  f.conflictStatuses.set("event-a:team-a:judge-2", "conflict");
  await assert.rejects(f.service.submitScore(f.principal("judge-2"), "event-a", cleared.id, f.scoreInput(cleared)), errorCode("JUDGE_CONFLICT"));
  const recused = await f.service.declareConflict(f.principal("judge-2"), "event-a", cleared.id, { expectedRevision: cleared.revision, hasConflict: true, reason: "新发现辅导关联" });
  await assert.rejects(f.service.judgeMaterials(f.principal("judge-2"), "event-a", recused.id), errorCode("JUDGE_ACCESS_DENIED"));
  const revoked = await f.service.revokeAssignment(f.staff, "event-a", assignment.id, { expectedRevision: assignment.revision, reason: "撤销指派" });
  await assert.rejects(f.service.judgeMaterials(f.principal("judge-1"), "event-a", revoked.id), errorCode("JUDGE_ACCESS_DENIED"));
  await assert.rejects(f.service.saveScore(f.principal("judge-1"), "event-a", revoked.id, f.scoreInput(revoked)), errorCode("JUDGE_ACCESS_DENIED"));
});

test("score compare-and-swap rejects stale drafts and submitted corrections preserve the original audit", async t => {
  const f = await fixture(t), receipt = await f.submit(), round = await f.start(), assignment = await f.assign(round, receipt), judge = f.principal("judge-1");
  const draft = await f.service.saveScore(judge, "event-a", assignment.id, f.scoreInput(assignment, 0, { idea: 8 })); assert.equal(draft.state, "draft");
  assert.deepEqual(draft.values, { idea: 8 });
  await assert.rejects(f.service.submitScore(judge, "event-a", assignment.id, f.scoreInput(assignment, draft.revision, { idea: 8 })), errorCode("JUDGING_INVALID_INPUT"));
  const changes = await Promise.allSettled([f.service.saveScore(judge, "event-a", assignment.id, f.scoreInput(assignment, draft.revision, { idea: 7, build: 7 })), f.service.saveScore(judge, "event-a", assignment.id, f.scoreInput(assignment, draft.revision, { idea: 9, build: 9 }))]);
  assert.equal(changes.filter(item => item.status === "fulfilled").length, 1);
  assert.equal((changes.find(item => item.status === "rejected") as PromiseRejectedResult).reason.code, "JUDGING_VERSION_CONFLICT");
  const submitted = await f.service.submitScore(judge, "event-a", assignment.id, f.scoreInput(assignment, 2));
  await assert.rejects(f.service.submitScore(judge, "event-a", assignment.id, f.scoreInput(assignment, submitted.revision)), errorCode("JUDGING_INVALID_INPUT"));
  await assert.rejects(f.service.saveScore(judge, "event-a", assignment.id, f.scoreInput(assignment, submitted.revision)), errorCode("SCORE_ALREADY_SUBMITTED"));
  const corrected = await f.service.submitScore(judge, "event-a", assignment.id, { ...f.scoreInput(assignment, submitted.revision, { idea: 9, build: 9 }), correctionReason: "核对原材料后纠正录入" });
  const audit = (await f.database.query<{ document: { reason: string; details: { before: { revision: number; values: unknown }; after: { revision: number } } } }>("SELECT document FROM ej_judging_audits WHERE action='score_corrected'")).rows[0]!.document;
  assert.equal(audit.reason, "核对原材料后纠正录入"); assert.equal(audit.details.before.revision, submitted.revision); assert.deepEqual(audit.details.before.values, submitted.values); assert.equal(audit.details.after.revision, corrected.revision);
  await f.service.lockRound(f.staff, "event-a", round.id, round.revision);
  await assert.rejects(f.service.submitScore(judge, "event-a", assignment.id, { ...f.scoreInput(assignment, corrected.revision), correctionReason: "锁后不得改" }), errorCode("JUDGING_NOT_OPEN"));
});

test("staff permission revoked before return rolls back writes and suppresses private reads", async t => {
  const f = await fixture(t); let checks = 0;
  f.hooks.staff = () => { if (++checks === 2) f.staffGrants.delete("event-a:staff"); };
  await assert.rejects(f.service.saveConfig(f.staff, "event-a", { expectedRevision: 0, config: baseConfig }), errorCode("STAFF_REQUIRED"));
  assert.equal((await f.database.query("SELECT id FROM ej_judging_rounds")).rows.length, 0);
  assert.equal((await f.database.query("SELECT id FROM ej_judging_audits")).rows.length, 0);
  f.staffGrants.add("event-a:staff"); checks = 0;
  await assert.rejects(f.service.workspace(f.staff, "event-a"), errorCode("STAFF_REQUIRED"));
});

test("missing scores remain null, ties share rank, publication checks its hash and team feedback stays private", async t => {
  const f = await fixture(t), first = await f.submit(), second = await f.submit("team-two", "bob", "作品乙"), round = await f.start();
  const missing = await f.service.previewResults(f.staff, "event-a", round.id);
  assert.equal(missing.summary.complete, false); assert.ok(missing.summary.rows.every(row => row.total === null && row.missingJudges === 1));
  await assert.rejects(f.service.lockRound(f.staff, "event-a", round.id, round.revision), errorCode("JUDGING_MISSING_SCORES"));
  const a = await f.assign(round, first), b = await f.assign(round, second);
  await f.service.submitScore(f.principal("judge-1"), "event-a", a.id, f.scoreInput(a)); await f.service.submitScore(f.principal("judge-1"), "event-a", b.id, f.scoreInput(b));
  const locked = await f.service.lockRound(f.staff, "event-a", round.id, round.revision), preview = await f.service.previewResults(f.staff, "event-a", round.id);
  assert.equal(preview.summary.hasTies, true); assert.ok(preview.summary.rows.every(row => row.total === 80 && row.rank === 1));
  assert.equal((await f.service.publicResults("event-a")).status, "waiting_publication");
  const judgeView = await f.service.judgeMaterials(f.principal("judge-1"), "event-a", a.id);
  assert.equal("memberUserIds" in judgeView.receipt, false); assert.equal("idempotencyKey" in judgeView.receipt, false); assert.equal("lockedSummary" in judgeView.round, false);
  assert.ok((await f.service.judgeAssignments(f.principal("judge-1"), "event-a")).items.every(item => !("lockedSummary" in item.round)));
  await assert.rejects(f.service.publishResults(f.staff, "event-a", round.id, { expectedRevision: locked.revision, expectedSummaryHash: "stale", visibility: "public", approvedFeedback: [] }), errorCode("JUDGING_PREVIEW_STALE"));
  const result = await f.service.publishResults(f.staff, "event-a", round.id, { expectedRevision: locked.revision, expectedSummaryHash: preview.summaryHash, visibility: "public",
    approvedFeedback: [{ snapshotId: first.id, text: "只向本队公开", visibility: "team" }, { snapshotId: first.id, text: "公开反馈", visibility: "public" }] });
  assert.equal((await f.service.publicResults("event-a")).rows.find(row => row.teamId === first.teamId)!.feedback, "公开反馈");
  assert.equal((await f.service.myResults(f.principal("alice"), "event-a")).rows.find(row => row.teamId === first.teamId)!.feedback, "只向本队公开");
  assert.equal((await f.service.myResults(f.principal("outsider"), "event-a")).rows.find(row => row.teamId === first.teamId)!.feedback, "公开反馈");
  let reads = 0; f.hooks.team = (_eventId, teamId, value) => teamId === "team-a" && ++reads > 1 && value ? { ...value, memberUserIds: [] } : value;
  assert.equal((await f.service.myResults(f.principal("alice"), "event-a")).rows.find(row => row.teamId === first.teamId)!.feedback, "公开反馈");
  await f.service.withdrawResults(f.staff, "event-a", round.id, { expectedRevision: locked.revision + 1, reason: "人工撤回后核查" });
  assert.equal((await f.service.publicResults("event-a")).status, "waiting_publication");
  assert.equal((await f.database.query("SELECT id FROM ej_published_results WHERE id=$1", [result.id])).rows.length, 1);
});

test("participants-only results recheck registration before returning and never enter public projection", async t => {
  const f = await fixture(t), receipt = await f.submit(), round = await f.start(), assignment = await f.assign(round, receipt);
  await f.service.submitScore(f.principal("judge-1"), "event-a", assignment.id, f.scoreInput(assignment));
  const locked = await f.service.lockRound(f.staff, "event-a", round.id, round.revision), preview = await f.service.previewResults(f.staff, "event-a", round.id);
  await f.service.publishResults(f.staff, "event-a", round.id, { expectedRevision: locked.revision, expectedSummaryHash: preview.summaryHash, visibility: "participants", approvedFeedback: [] });
  assert.equal((await f.service.publicResults("event-a")).rows.length, 0); assert.equal((await f.service.myResults(f.principal("outsider"), "event-a")).rows.length, 0);
  assert.equal((await f.service.myResults(f.principal("alice"), "event-a")).rows.length, 1);
  let reads = 0; f.hooks.registration = (_eventId, userId, value) => userId === "alice" && ++reads > 1 && value ? { ...value, status: "withdrawn" } : value;
  const withdrawn = await f.service.myResults(f.principal("alice"), "event-a"); assert.equal(withdrawn.status, "waiting_publication"); assert.equal(withdrawn.rows.length, 0);
});

test("multiple published rounds expose only the latest visible round without mixing rankings", async t => {
  const f = await fixture(t), receipt = await f.submit();
  const publish = async (title: string, visibility: "public" | "participants") => {
    const round = await f.start({ title }), assignment = await f.assign(round, receipt);
    await f.service.submitScore(f.principal("judge-1"), "event-a", assignment.id, f.scoreInput(assignment));
    const locked = await f.service.lockRound(f.staff, "event-a", round.id, round.revision), preview = await f.service.previewResults(f.staff, "event-a", round.id);
    await f.service.publishResults(f.staff, "event-a", round.id, { expectedRevision: locked.revision, expectedSummaryHash: preview.summaryHash, visibility, approvedFeedback: [] });
    return round;
  };
  const first = await publish("初赛", "public"), second = await publish("决赛", "participants");
  const publicView = await f.service.publicResults("event-a"), ownView = await f.service.myResults(f.principal("alice"), "event-a");
  assert.equal(publicView.roundId, first.id); assert.equal(publicView.roundTitle, "初赛"); assert.equal(publicView.rows.length, 1);
  assert.equal(ownView.roundId, second.id); assert.equal(ownView.roundTitle, "决赛"); assert.equal(ownView.rows.length, 1); assert.equal(ownView.version, 2);
});

test("nonzero score ranges aggregate deterministically and manual tie policy cannot reverse different totals", async t => {
  const f = await fixture(t), first = await f.submit(), second = await f.submit("team-two", "bob", "作品乙");
  const round = await f.start({ tiePolicy: "manual_order", criteria: [{ id: "idea", label: "想法", weight: 50, min: 10, max: 13 }, { id: "build", label: "实现", weight: 50, min: 0, max: 6 }] });
  const a = await f.assign(round, first), b = await f.assign(round, second);
  await f.service.submitScore(f.principal("judge-1"), "event-a", a.id, f.scoreInput(a, 0, { idea: 11, build: 2 }));
  await f.service.submitScore(f.principal("judge-1"), "event-a", b.id, f.scoreInput(b, 0, { idea: 12, build: 4 }));
  const locked = await f.service.lockRound(f.staff, "event-a", round.id, round.revision), preview = await f.service.previewResults(f.staff, "event-a", round.id);
  assert.deepEqual(preview.summary.rows.map(row => row.total), [66.67, 33.33]);
  const input = { expectedRevision: locked.revision, expectedSummaryHash: preview.summaryHash, visibility: "public" as const, approvedFeedback: [] };
  await assert.rejects(f.service.publishResults(f.staff, "event-a", round.id, { ...input, orderedSnapshotIds: [first.id, second.id] }), errorCode("JUDGING_INVALID_INPUT"));
  const result = await f.service.publishResults(f.staff, "event-a", round.id, { ...input, orderedSnapshotIds: [second.id, first.id] });
  assert.deepEqual(result.rows.map(row => row.rank), [1, 2]);
});

test("a late conflict immediately recuses a locked judge and invalidates publication of the frozen aggregate", async t => {
  const f = await fixture(t), receipt = await f.submit(), round = await f.start(), assignment = await f.assign(round, receipt), judge = f.principal("judge-1");
  await f.service.submitScore(judge, "event-a", assignment.id, f.scoreInput(assignment));
  const locked = await f.service.lockRound(f.staff, "event-a", round.id, round.revision), preview = await f.service.previewResults(f.staff, "event-a", round.id);
  const recused = await f.service.declareConflict(judge, "event-a", assignment.id, { expectedRevision: assignment.revision, hasConflict: true, reason: "锁定后才发现线下关系" });
  assert.equal(recused.status, "recused"); await assert.rejects(f.service.judgeMaterials(judge, "event-a", assignment.id), errorCode("JUDGE_ACCESS_DENIED"));
  await assert.rejects(f.service.publishResults(f.staff, "event-a", round.id, { expectedRevision: locked.revision, expectedSummaryHash: preview.summaryHash, visibility: "public", approvedFeedback: [] }), errorCode("JUDGING_PREVIEW_STALE"));
  assert.equal((await f.service.publicResults("event-a")).status, "waiting_publication");
});

for (const changedStatus of ["conflict", "needs_review", "revoked"] as const) {
  test(`judge assignment list redacts title and score when ${changedStatus} arises during the score read`, async t => {
    const f = await fixture(t), receipt = await f.submit("team-a", "alice", "不得在撤权后返回的作品标题"), round = await f.start(), assignment = await f.assign(round, receipt), judge = f.principal("judge-1");
    await f.service.submitScore(judge, "event-a", assignment.id, { ...f.scoreInput(assignment), feedback: "不得在撤权后返回的私人评语" });
    let changes = 0;
    f.hooks.query = async (statement, params, sql) => {
      if (!statement.startsWith("SELECT document FROM ej_manual_scores") || !statement.includes("assignment_id=$3") || params[2] !== assignment.id || changes) return;
      changes++;
      if (changedStatus === "revoked") {
        await sql.query("UPDATE ej_judge_assignments SET revision=revision+1,status='revoked',document=jsonb_set(jsonb_set(document,'{status}','\"revoked\"'::jsonb),'{revision}',to_jsonb(revision+1)) WHERE id=$1", [assignment.id]);
      } else f.conflictStatuses.set("event-a:team-a:judge-1", changedStatus);
    };
    const list = await f.service.judgeAssignments(judge, "event-a"), item = list.items.find(value => value.assignment.id === assignment.id)!;
    assert.equal(changes, 1, "the change must occur after the real current-score SQL query");
    assert.equal(item.accessStatus, changedStatus === "revoked" ? "revoked" : "needs_review");
    assert.equal(item.assignment.status, changedStatus === "revoked" ? "revoked" : "needs_review");
    assert.equal(item.score, null); assert.notEqual(item.title, receipt.materials.title);
    assert.equal(JSON.stringify(item).includes("不得在撤权后返回"), false);
    await assert.rejects(f.service.judgeMaterials(judge, "event-a", assignment.id), errorCode(changedStatus === "revoked" ? "JUDGE_ACCESS_DENIED" : "JUDGE_CONFLICT"));
  });
}

test("published late recusal withholds current results, preserves history and requires the complete manual recovery chain", async t => {
  const f = await fixture(t), receipt = await f.submit(), round = await f.start(), assignment = await f.assign(round, receipt), judge = f.principal("judge-1");
  await f.service.submitScore(judge, "event-a", assignment.id, f.scoreInput(assignment));
  const locked = await f.service.lockRound(f.staff, "event-a", round.id, round.revision), preview = await f.service.previewResults(f.staff, "event-a", round.id);
  const original = await f.service.publishResults(f.staff, "event-a", round.id, { expectedRevision: locked.revision, expectedSummaryHash: preview.summaryHash, visibility: "public", approvedFeedback: [{ snapshotId: receipt.id, text: "原先公开反馈", visibility: "public" }] });
  assert.equal(original.rows[0]!.total, 80);
  await f.service.declareConflict(judge, "event-a", assignment.id, { expectedRevision: assignment.revision, hasConflict: true, reason: "不应公开的线下辅导关系" });
  for (const view of [await f.service.publicResults("event-a"), await f.service.myResults(f.principal("alice"), "event-a")]) {
    assert.equal(view.status, "needs_review"); assert.equal(view.reviewRequired, true); assert.equal(view.rows.length, 0);
    assert.equal(view.version, original.version); assert.equal(view.publishedAt, original.publishedAt); assert.equal(view.roundId, round.id);
    assert.ok(view.reviewNotice); assert.equal(JSON.stringify(view).includes("judge-1"), false); assert.equal(JSON.stringify(view).includes("线下辅导"), false);
  }
  const workspace = await f.service.workspace(f.staff, "event-a"), review = workspace.publicationReviews.find(value => value.roundId === round.id)!;
  assert.equal(review.required, true); assert.equal(review.publishedResultId, original.id);
  assert.deepEqual(review.nextSteps, ["preview_results", "withdraw_results", "reopen_round", "review_assignments", "lock_round", "preview_results", "publish_results"]);
  const managerPreview = await f.service.previewResults(f.staff, "event-a", round.id); assert.equal(managerPreview.publicationReview.required, true);
  await assert.rejects(f.service.reopenRound(f.staff, "event-a", round.id, { expectedRevision: locked.revision + 1, reason: "必须先撤回" }), errorCode("JUDGING_STATE_INVALID"));
  const withdrawn = await f.service.withdrawResults(f.staff, "event-a", round.id, { expectedRevision: locked.revision + 1, reason: "公布后新发现冲突，人工撤回" });
  const reopened = await f.service.reopenRound(f.staff, "event-a", round.id, { expectedRevision: withdrawn.revision, reason: "更换评委并补评分" });
  await assert.rejects(f.service.lockRound(f.staff, "event-a", round.id, reopened.revision), errorCode("JUDGING_MISSING_SCORES"));
  const replacement = await f.assign(reopened, receipt, "judge-2");
  await f.service.submitScore(f.principal("judge-2"), "event-a", replacement.id, f.scoreInput(replacement, 0, { idea: 9, build: 9 }));
  const relocked = await f.service.lockRound(f.staff, "event-a", round.id, reopened.revision), rechecked = await f.service.previewResults(f.staff, "event-a", round.id);
  const revised = await f.service.publishResults(f.staff, "event-a", round.id, { expectedRevision: relocked.revision, expectedSummaryHash: rechecked.summaryHash, visibility: "public", approvedFeedback: [] });
  const restored = await f.service.publicResults("event-a");
  assert.equal(restored.status, "published"); assert.equal(restored.reviewRequired, false); assert.equal(restored.reviewNotice, null);
  assert.equal(revised.version, 2); assert.equal(restored.version, 2); assert.equal(restored.rows[0]!.total, 90);
  const oldDocument = (await f.database.query<{ document: unknown }>("SELECT document FROM ej_published_results WHERE id=$1", [original.id])).rows[0]!.document;
  assert.deepEqual(oldDocument, original, "the old published 80-point receipt remains immutable");
  assert.equal((await f.database.query("SELECT id FROM ej_published_results")).rows.length, 2);
  assert.equal((await f.service.workspace(f.staff, "event-a")).publicationReviews.some(value => value.required), false);
});

test("participants-only publication review exposes no notice or publication metadata to outsiders or withdrawn entrants", async t => {
  const f = await fixture(t), receipt = await f.submit(), round = await f.start(), assignment = await f.assign(round, receipt);
  await f.service.submitScore(f.principal("judge-1"), "event-a", assignment.id, f.scoreInput(assignment));
  const locked = await f.service.lockRound(f.staff, "event-a", round.id, round.revision), preview = await f.service.previewResults(f.staff, "event-a", round.id);
  const original = await f.service.publishResults(f.staff, "event-a", round.id, { expectedRevision: locked.revision, expectedSummaryHash: preview.summaryHash, visibility: "participants", approvedFeedback: [{ snapshotId: receipt.id, text: "不得公开的队内反馈", visibility: "team" }] });
  f.conflictStatuses.set("event-a:team-a:judge-1", "needs_review");
  const own = await f.service.myResults(f.principal("alice"), "event-a");
  assert.equal(own.status, "needs_review"); assert.equal(own.reviewRequired, true); assert.equal(own.version, original.version); assert.equal(own.rows.length, 0);
  f.registrations.set("event-a:alice", { ...f.registrations.get("event-a:alice")!, status: "withdrawn" });
  for (const hidden of [await f.service.publicResults("event-a"), await f.service.myResults(f.principal("outsider"), "event-a"), await f.service.myResults(f.principal("alice"), "event-a")]) {
    assert.equal(hidden.status, "waiting_publication"); assert.equal(hidden.reviewRequired, false); assert.equal(hidden.reviewNotice, null);
    assert.equal(hidden.version, null); assert.equal(hidden.publishedAt, null); assert.equal(hidden.roundId, null); assert.equal(hidden.roundTitle, null); assert.equal(hidden.rows.length, 0);
    assert.equal(JSON.stringify(hidden).includes("judge-1"), false); assert.equal(JSON.stringify(hidden).includes("不得公开"), false);
  }
});

test("trusted bridge rejects shortened, foreign or malformed confirmed-rule version keys before creating any receipt", async t => {
  const f = await fixture(t, true);
  const invalidVersions: readonly unknown[] = [7, "7", "other-event:7:2", "m03-event-a:0:2", "m03-event-a:7:0", "m03-event-a:7:-2", "m03-event-a:9007199254740992:2", " m03-event-a:7:2", "m03-event-a:7:2 ", `m03-event-a:${"1".repeat(201)}:2`, undefined];
  for (const requirementsVersion of invalidVersions) {
    f.context.value = { stageId: "verified-stage", requirementsVersion, repositoryCommitSha: null };
    await assert.rejects(f.service.submit(f.principal("alice"), "event-a", await f.prepare()), errorCode("TRUSTED_REQUIREMENTS_VERSION_INVALID"));
  }
  f.context.value = { stageId: "verified-stage", rulesVersion: "m03-event-a:7:2", repositoryCommitSha: null };
  await assert.rejects(f.service.submit(f.principal("alice"), "event-a", await f.prepare()), errorCode("TRUSTED_REQUIREMENTS_VERSION_INVALID"));
  assert.equal(f.bridgeCalls.length, 0); assert.equal((await f.database.query("SELECT id FROM ej_intake_receipts")).rows.length, 0);
  assert.equal((await f.database.query("SELECT id FROM test_verified_receipts")).rows.length, 0);
});

test("trusted confirmed-rule key is preserved exactly and client URL/version extras cannot alter the M06 bridge", async t => {
  const f = await fixture(t, true), input = await f.prepare();
  const adversarial = { ...input, receiptUrl: "https://attacker.example/injected", requirementsVersion: "m03-event-a:999:999", linkedEventId: "other-event", stageId: "client-stage" };
  const receipt = await f.service.submit(f.principal("alice"), "event-a", adversarial), bridge = f.bridgeCalls[0]!;
  assert.equal(bridge.receipt.requirementsVersion, "m03-event-a:7:2"); assert.equal(bridge.receipt.linkedEventId, "m03-event-a"); assert.equal(bridge.receipt.stageId, "verified-stage");
  assert.equal(bridge.receipt.receiptUrl, `/competitions/event-a/submit?receipt=${encodeURIComponent(receipt.id)}`);
  assert.equal(bridge.receipt.receiptUrl.startsWith("/"), true); assert.equal(bridge.sql, f.contextExecutors[0]);
  assert.equal(receipt.submissionRecordId, `m06-${receipt.id}`); assert.equal(f.bridgeCalls.length, 1);
});

for (const finalAssociation of ["clear", "conflict"] as const) {
  test(`participants revoked during the final ${finalAssociation} association summary receive no private publication metadata`, async t => {
    const f = await fixture(t), receipt = await f.submit(), round = await f.start(), assignment = await f.assign(round, receipt);
    await f.service.submitScore(f.principal("judge-1"), "event-a", assignment.id, f.scoreInput(assignment));
    const locked = await f.service.lockRound(f.staff, "event-a", round.id, round.revision), preview = await f.service.previewResults(f.staff, "event-a", round.id);
    await f.service.publishResults(f.staff, "event-a", round.id, { expectedRevision: locked.revision, expectedSummaryHash: preview.summaryHash, visibility: "participants", approvedFeedback: [{ snapshotId: receipt.id, visibility: "team", text: "不得向撤权账号展示的反馈" }] });
    let inspections = 0;
    f.hooks.conflict = (input, status) => {
      if (input.judgeUserId !== "judge-1" || input.teamId !== "team-a") return status;
      if (++inspections === 2) { f.registrations.set("event-a:alice", { ...f.registrations.get("event-a:alice")!, status: "withdrawn" }); return finalAssociation; }
      return status;
    };
    const hidden = await f.service.myResults(f.principal("alice"), "event-a");
    assert.equal(inspections, 2, "withdrawal occurs during the final association summary after the initial access check");
    assert.equal(hidden.status, "waiting_publication"); assert.equal(hidden.reviewRequired, false); assert.equal(hidden.reviewNotice, null);
    assert.equal(hidden.version, null); assert.equal(hidden.publishedAt, null); assert.equal(hidden.roundId, null); assert.equal(hidden.roundTitle, null); assert.equal(hidden.rows.length, 0);
  });
}

async function pendingEventAssignment(f: Awaited<ReturnType<typeof fixture>>, eventId = "event-a", teamId = "team-a", ownerUserId = "alice", judgeUserId = "judge-1"): Promise<JudgeAssignment> {
  if (!f.scopes.has(eventId)) f.scopes.set(eventId, eventScope(eventId, "org-a"));
  if (!f.teams.has(`${eventId}:${teamId}`)) {
    f.teams.set(`${eventId}:${teamId}`, { id: teamId, eventId, organizationId: f.scopes.get(eventId)!.organizationId, captainUserId: ownerUserId,
      memberUserIds: [ownerUserId], revision: 1, status: "locked", eligible: true, projectId: null });
    f.registrations.set(`${eventId}:${ownerUserId}`, { id: `registration-${eventId}-${ownerUserId}`, eventId, userId: ownerUserId, status: "approved", revision: 1 });
  }
  const managerId = eventId === "event-b" ? "staff-b" : "staff"; f.staffGrants.add(`${eventId}:${managerId}`);
  const manager = f.principal(managerId), receipt = await f.service.submit(f.principal(ownerUserId), eventId, await f.prepare(teamId, ownerUserId, eventId));
  const setup = await f.service.saveConfig(manager, eventId, { expectedRevision: 0, config: baseConfig }), round = await f.service.startRound(manager, eventId, setup.id, setup.revision);
  return f.service.assignJudge(manager, eventId, { roundId: round.id, snapshotId: receipt.id, judgeUserId, expectedRoundRevision: round.revision });
}

test("assigned event lookup uses only the current principal and reads no work materials or scores", async t => {
  const f = await fixture(t); await pendingEventAssignment(f);
  const assignmentQueries: unknown[][] = []; const reads: string[] = [];
  f.hooks.query = (statement, params) => {
    reads.push(statement);
    if (statement.includes("ej_judge_assignments")) assignmentQueries.push([...params]);
    assert.equal(/ej_intake_receipts|ej_manual_scores|ej_judging_rounds/.test(statement), false);
  };
  f.hooks.team = () => { throw new Error("event lookup must not load roster or submission context"); };
  f.hooks.conflict = () => { throw new Error("event lookup must not read material conflict context"); };
  assert.deepEqual(await f.service.listAssignedEventIds(f.principal("judge-1")), ["event-a"]);
  assert.deepEqual(await f.service.listAssignedEventIds(f.principal("judge-2")), []);
  assert.deepEqual(await f.service.listAssignedEventIds(f.principal("staff", ["admin", "reviewer"])), []);
  const requestWithOtherUser = { ...f.principal("outsider", ["admin"]), userId: "judge-1" };
  assert.deepEqual(await f.service.listAssignedEventIds(requestWithOtherUser), []);
  assert.deepEqual(assignmentQueries.map(params => params[0]), ["judge-1", "judge-1", "judge-2", "staff", "outsider"]);
  assert.ok(reads.every(statement => statement.includes("auth_users") || statement.includes("ej_judge_assignments")));
});

test("被拒绝的评审访问与评分尝试留下审计，且不产生任何评分或指派事实", async t => {
  const f = await fixture(t), receipt = await f.submit(), round = await f.start();
  const assignment = await f.assign(round, receipt);
  // 无指派的工作人员、非本人的其他评委、以及已被撤销的指派都各尝试一次。
  await assert.rejects(f.service.saveScore(f.staff, "event-a", assignment.id, f.scoreInput(assignment)), errorCode("JUDGE_ACCESS_DENIED"));
  await assert.rejects(f.service.judgeMaterials(f.principal("judge-2"), "event-a", assignment.id), errorCode("JUDGE_ACCESS_DENIED"));
  const revoked = await f.service.revokeAssignment(f.staff, "event-a", assignment.id, { expectedRevision: assignment.revision, reason: "撤销指派" });
  await assert.rejects(f.service.submitScore(f.principal("judge-1"), "event-a", revoked.id, f.scoreInput(revoked)), errorCode("JUDGE_ACCESS_DENIED"));
  const audits = (await f.service.auditHistory(f.staff, "event-a")).items;
  const denied = audits.filter(item => item.action === "judge_access_denied");
  assert.equal(denied.length, 3);
  assert.deepEqual([...new Set(denied.map(item => item.actorUserId))].sort(), ["judge-1", "judge-2", "staff"]);
  assert.ok(denied.every(item => item.subjectId === assignment.id));
  assert.ok(denied.every(item => item.reason.includes("JUDGE_ACCESS_DENIED")));
  // 留痕只说明有人尝试越权：评分事实没有任何变化。
  const workspace = await f.service.workspace(f.staff, "event-a");
  assert.equal(workspace.scores.length, 0);
  assert.equal(workspace.assignments.find(item => item.id === assignment.id)?.status, "revoked");
});

test("assigned event lookup deduplicates sorted events, retains pending review and excludes only recused/revoked events", async t => {
  const f = await fixture(t), first = await pendingEventAssignment(f), duplicate = await pendingEventAssignment(f);
  assert.equal(first.declaration, "unconfirmed"); assert.equal(duplicate.declaration, "unconfirmed");
  f.conflictStatuses.set("event-b:team-b:judge-1", "needs_review");
  const pending = await pendingEventAssignment(f, "event-b", "team-b", "bob"); assert.equal(pending.status, "needs_review");
  const recused = await pendingEventAssignment(f, "event-c", "team-c", "alice");
  await f.service.declareConflict(f.principal("judge-1"), "event-c", recused.id, { expectedRevision: recused.revision, hasConflict: true, reason: "赛事内回避" });
  const revoked = await pendingEventAssignment(f, "event-d", "team-d", "alice");
  await f.service.revokeAssignment(f.staff, "event-d", revoked.id, { expectedRevision: revoked.revision, reason: "赛事内撤销" });
  assert.deepEqual(await f.service.listAssignedEventIds(f.principal("judge-1")), ["event-a", "event-b"]);
});

test("assigned event lookup guards initial and mid-query session revocation within the same transaction", async t => {
  const f = await fixture(t); await pendingEventAssignment(f); let assignmentReads = 0;
  f.hooks.query = statement => { if (statement.includes("ej_judge_assignments")) assignmentReads++; };
  f.revokedSessions.add("judge-1");
  await assert.rejects(f.service.listAssignedEventIds(f.principal("judge-1")), errorCode("SESSION_REVOKED")); assert.equal(assignmentReads, 0);
  f.revokedSessions.delete("judge-1");
  const guarded = f.principal("judge-1"), guardExecutors: SqlExecutor[] = [], readExecutors: SqlExecutor[] = [];
  const principal: OrganizerPrincipal = { actor: guarded.actor, guard: async sql => { guardExecutors.push(sql); await guarded.guard(sql); } };
  f.hooks.query = (statement, _params, sql) => { if (statement.includes("ej_judge_assignments")) { readExecutors.push(sql); f.revokedSessions.add("judge-1"); } };
  await assert.rejects(f.service.listAssignedEventIds(principal), errorCode("SESSION_REVOKED"));
  assert.equal(guardExecutors.length, 2); assert.equal(guardExecutors[0], guardExecutors[1]); assert.ok(readExecutors.every(sql => sql === guardExecutors[0]));
});

for (const anotherValidAssignment of [false, true]) {
  test(`assigned event lookup ${anotherValidAssignment ? "retains an event with another valid assignment" : "drops an event whose last valid assignment was revoked"} during its query`, async t => {
    const f = await fixture(t), assignment = await pendingEventAssignment(f); if (anotherValidAssignment) await pendingEventAssignment(f);
    let revocations = 0;
    f.hooks.query = async (statement, _params, sql) => {
      if (!/^SELECT DISTINCT event_id\s+FROM ej_judge_assignments/.test(statement) || revocations) return;
      revocations++;
      await sql.query("UPDATE ej_judge_assignments SET revision=revision+1,status='revoked',document=jsonb_set(jsonb_set(document,'{status}','\"revoked\"'::jsonb),'{revision}',to_jsonb(revision+1)) WHERE id=$1", [assignment.id]);
    };
    assert.deepEqual(await f.service.listAssignedEventIds(f.principal("judge-1")), anotherValidAssignment ? ["event-a"] : []);
    assert.equal(revocations, 1);
  });
}


/* ------------------------------------------------------------------------------------------------
 * 规划 34 C①「作品展示（队伍可选公开）」验收（2026-10-16）
 *
 * 三层开关缺一不公开：赛事级 community.workShowcase（主办方，默认 false）+ 队伍级 scope（本批唯一
 * 新增事实，private 默认）+ 个人级点评（P5/P7，不在本批）。以下断言全部是行为断言，不是目测。
 * ---------------------------------------------------------------------------------------------- */
/** 只把 `community.workShowcase` 打开；其余社区能力保持默认关闭。 */
function showcaseOn(f: Awaited<ReturnType<typeof fixture>>, community: Partial<EventCommunityConfig> = {}): EventCommunityConfig {
  const value: EventCommunityConfig = { ...DEFAULT_EVENT_COMMUNITY, workShowcase: true, ...community };
  f.scopes.set("event-a", { ...f.scopes.get("event-a")!, community: value });
  return value;
}
const workDisclosureCount = async (f: Awaited<ReturnType<typeof fixture>>): Promise<number> =>
  (await f.database.query<{ count: number }>("SELECT count(*)::int AS count FROM ej_work_disclosures")).rows[0]!.count;

test("作品展示门禁：赛事开关未开启时读取与提交都明确 403，开启后默认没有任何作品", async t => {
  const f = await fixture(t);
  // 关时不是"空数组"，而是明确拒绝（规划 34 §3.1 / 宪法 XIII）。
  await assert.rejects(f.service.works(f.principal("alice"), "event-a"), errorCode("WORK_SHOWCASE_DISABLED"));
  await assert.rejects(f.service.myWorkDisclosure(f.principal("alice"), "event-a", "team-a"), errorCode("WORK_SHOWCASE_DISABLED"));
  await assert.rejects(f.service.submitWorkDisclosure(f.principal("alice"), "event-a", "team-a", { scope: "participants", fields: { title: true }, idempotencyKey: "gate-1" }), errorCode("WORK_SHOWCASE_DISABLED"));
  await assert.rejects(f.service.withdrawWorkDisclosure(f.principal("alice"), "event-a", "team-a", { expectedRevision: 1 }), errorCode("WORK_SHOWCASE_DISABLED"));
  await assert.rejects(f.service.eventWorkShowcase(f.staff, "event-a"), errorCode("WORK_SHOWCASE_DISABLED"));
  await assert.rejects(f.service.publicWorks("event-a"), errorCode("WORK_SHOWCASE_DISABLED"));
  assert.equal(await workDisclosureCount(f), 0, "关时不产生任何披露行");
  // 开启但还没有队伍选择公开：列表为空（这是"默认不公开"，不是错误）。
  const community = showcaseOn(f);
  assert.equal(community.workShowcase, true);
  const empty = await f.service.works(f.principal("alice"), "event-a");
  assert.equal(empty.showcaseEnabled, true); assert.equal(empty.items.length, 0); assert.equal(empty.visibleCount, 0);
  assert.equal((await f.service.eventWorkShowcase(f.staff, "event-a")).items.length, 0);
});

test("作品展示只列本人选择公开的队的勾选字段，他队内容与未勾选内容一律不出现", async t => {
  const f = await fixture(t); showcaseOn(f);
  const privateFile = { name: "team-a-未勾选文件.bin", url: "https://files.example.org/a.bin", sizeBytes: 7, sha256: "b".repeat(64), mediaType: "application/octet-stream" };
  await f.service.submit(f.principal("alice"), "event-a", await f.prepare("team-a", "alice", "event-a", { title: "作品甲", description: "甲队愿意公开的简介", links: [{ label: "演示", url: "https://example.org/demo" }], files: [privateFile] }));
  await f.service.submit(f.principal("bob"), "event-a", await f.prepare("team-two", "bob", "event-a", { title: "队伍二的私人作品", description: "队伍二的私人说明", links: [{ label: "私人", url: "https://private.example.org/team-two" }], files: [] }));
  await f.service.submitWorkDisclosure(f.principal("alice"), "event-a", "team-a", { scope: "participants", fields: { title: true, links: true }, idempotencyKey: "only-1" });
  const list = await f.service.works(f.principal("alice"), "event-a");
  assert.equal(list.items.length, 1);
  const entry = list.items[0]!;
  assert.equal(entry.teamId, "team-a"); assert.equal(entry.scope, "participants");
  assert.deepEqual(entry.disclosedFields, ["title", "links"]);
  assert.equal(entry.title, "作品甲");
  assert.equal(entry.description, undefined, "未勾选的简介不出现");
  assert.equal(entry.files, undefined, "未勾选的文件不出现");
  assert.deepEqual(entry.links, [{ label: "演示", url: "https://example.org/demo" }]);
  const json = JSON.stringify(list);
  const forbidden = ["队伍二的私人作品", "队伍二的私人说明", "private.example.org", "team-two", privateFile.name, "sha256", "receiptId"];
  for (const secret of forbidden) assert.ok(!json.includes(secret), "公开投影不应包含 " + secret);
  // 未选择公开的队完全不在列表里：既不出现其字段，也不出现其队伍标识。
  assert.ok(!json.includes("队伍二"));
});

test("仅本场参赛者与公开（含访客）两档按观看者资格区分，且一队只有一条有效记录", async t => {
  const f = await fixture(t); showcaseOn(f); await f.submit();
  await f.service.submitWorkDisclosure(f.principal("alice"), "event-a", "team-a", { scope: "participants", fields: { title: true }, idempotencyKey: "aud-1" });
  assert.equal((await f.service.works(f.principal("alice"), "event-a")).items.length, 1, "本场报名已通过的选手可见");
  assert.equal((await f.service.works(f.principal("outsider"), "event-a")).items.length, 0, "非本场参赛者看不到仅参赛者档");
  assert.equal((await f.service.publicWorks("event-a")).items.length, 0, "访客入口看不到仅参赛者档");
  // 重新提交为 public 会取代上一条；访客与外部账号都能看到，且列表里仍然只有一条。
  const replaced = await f.service.submitWorkDisclosure(f.principal("alice"), "event-a", "team-a", { scope: "public", fields: { title: true }, idempotencyKey: "aud-2" });
  assert.equal(replaced.scope, "public");
  assert.equal((await f.service.works(f.principal("outsider"), "event-a")).items.length, 1);
  assert.equal((await f.service.publicWorks("event-a")).items.length, 1);
  assert.equal((await f.service.works(f.principal("alice"), "event-a")).items.length, 1);
  assert.equal(await workDisclosureCount(f), 2, "旧选择保留为历史，但只有一条 active");
});


test("提交公开范围前后 aggregate、结果预览、留档导出与本人结果投影逐字段不变", async t => {
  const f = await fixture(t); showcaseOn(f);
  const first = await f.submit(), second = await f.submit("team-two", "bob", "作品乙");
  const round = await f.start();
  const a1 = await f.assign(round, first, "judge-1"), a2 = await f.assign(round, second, "judge-2");
  await f.service.submitScore(f.principal("judge-1"), "event-a", a1.id, f.scoreInput(a1, 0, { idea: 8, build: 8 }));
  await f.service.submitScore(f.principal("judge-2"), "event-a", a2.id, f.scoreInput(a2, 0, { idea: 6, build: 6 }));
  await f.service.lockRound(f.staff, "event-a", round.id, round.revision);
  const locked = (await f.service.workspace(f.staff, "event-a")).rounds[0]!;
  const lockedPreview = await f.service.previewResults(f.staff, "event-a", locked.id);
  await f.service.publishResults(f.staff, "event-a", locked.id, { expectedRevision: locked.revision, expectedSummaryHash: lockedPreview.summaryHash, visibility: "participants", approvedFeedback: [] });
  // 基线在"已公布"之后取：这样前后差异只可能来自唯一新增事实（公开范围选择），而不是公布本身。
  const previewBefore = await f.service.previewResults(f.staff, "event-a", locked.id);
  const exportBefore = await f.service.exportResults(f.staff, "event-a", locked.id);
  const projectionBefore = await f.service.myResults(f.principal("alice"), "event-a");
  const materialsBefore = await f.service.judgeMaterials(f.principal("judge-1"), "event-a", a1.id);
  // 唯一新增事实：队伍本人的公开范围选择。
  const disclosure = await f.service.submitWorkDisclosure(f.principal("alice"), "event-a", "team-a", { scope: "public", fields: { title: true, description: true, links: true, files: true }, idempotencyKey: "inv-1" });
  assert.equal(disclosure.scope, "public");
  assert.equal((await f.service.works(f.principal("outsider"), "event-a")).items.length, 1, "披露生效");
  // 既有汇总、预览、留档导出与本人结果一口径未变。
  const previewAfter = await f.service.previewResults(f.staff, "event-a", locked.id);
  assert.deepEqual(previewAfter.summary, previewBefore.summary); assert.equal(previewAfter.summaryHash, previewBefore.summaryHash);
  assert.deepEqual(previewAfter.round, previewBefore.round); assert.deepEqual(previewAfter.publicationReview, previewBefore.publicationReview);
  assert.deepEqual(previewAfter.summary.rows.map(row => [row.teamId, row.total, row.rank]), [["team-a", 80, 1], ["team-two", 60, 2]]);
  const exportAfter = await f.service.exportResults(f.staff, "event-a", locked.id);
  assert.equal(exportAfter.csv, exportBefore.csv); assert.equal(exportAfter.filename, exportBefore.filename);
  const projectionAfter = await f.service.myResults(f.principal("alice"), "event-a");
  assert.deepEqual(projectionAfter, projectionBefore);
  assert.deepEqual(await f.service.judgeMaterials(f.principal("judge-1"), "event-a", a1.id), materialsBefore);
  // 披露内容不进入结果投影、留档导出与评委读取面。
  const surfaces: readonly (readonly [string, string])[] = [["本人结果投影", JSON.stringify(projectionAfter)], ["留档导出", exportAfter.csv], ["评委材料", JSON.stringify(materialsBefore)]];
  for (const [label, value] of surfaces) {
    assert.ok(!value.includes("disclosedFields"), label + "不应包含披露元数据");
    assert.ok(!value.includes("作品展示"), label + "不应包含作品展示内容");
  }
  assert.ok(!exportAfter.csv.includes("work_disclosure"));
});

test("公开范围选择：同重试标识幂等，再次提交取代上一条，旧记录的范围与字段不可改写", async t => {
  const f = await fixture(t); showcaseOn(f); await f.submit();
  const input = { scope: "participants" as const, fields: { title: true, description: true }, idempotencyKey: "idem-1" };
  const created = await f.service.submitWorkDisclosure(f.principal("alice"), "event-a", "team-a", input);
  assert.deepEqual(await f.service.submitWorkDisclosure(f.principal("alice"), "event-a", "team-a", input), created, "同一重试标识重放返回同一条");
  assert.equal(await workDisclosureCount(f), 1);
  await assert.rejects(f.service.submitWorkDisclosure(f.principal("alice"), "event-a", "team-a", { ...input, scope: "public" }), errorCode("IDEMPOTENCY_KEY_REUSED"));
  const replaced = await f.service.submitWorkDisclosure(f.principal("alice"), "event-a", "team-a", { scope: "public", fields: { title: true }, idempotencyKey: "idem-2" });
  assert.notEqual(replaced.id, created.id);
  const rows = (await f.database.query<{ document: WorkDisclosure }>("SELECT document FROM ej_work_disclosures ORDER BY id")).rows.map(row => row.document);
  const old = rows.find(row => row.id === created.id)!;
  assert.equal(old.status, "withdrawn"); assert.equal(old.revision, 2);
  assert.equal(old.scope, "participants", "原始范围不可改写");
  assert.deepEqual(old.fields, { title: true, description: true, links: false, files: false });
  // 触发器：已经撤回的记录不能回到 active，也不能跳版本。
  await assert.rejects(f.database.query("UPDATE ej_work_disclosures SET status='active',revision=revision+1,withdrawn_at=NULL,document=jsonb_set(document,'{status}',to_jsonb('active'::text)) WHERE id=$1", [created.id]), /only move from active to withdrawn/);
  await assert.rejects(f.database.query("UPDATE ej_work_disclosures SET revision=revision+5,updated_at=updated_at WHERE id=$1", [replaced.id]), /revision must increase by one/);
  assert.equal((await f.service.works(f.principal("alice"), "event-a")).items[0]!.scope, "public");
});

test("只有当前队伍成员且在该作品最新收件成员快照内的人可以提交或查看公开范围", async t => {
  const f = await fixture(t); showcaseOn(f); await f.submit();
  await assert.rejects(f.service.submitWorkDisclosure(f.principal("bob"), "event-a", "team-a", { scope: "participants", fields: { title: true }, idempotencyKey: "who-1" }), errorCode("WORK_DISCLOSURE_ACCESS_DENIED"));
  await assert.rejects(f.service.myWorkDisclosure(f.principal("bob"), "event-a", "team-a"), errorCode("WORK_DISCLOSURE_ACCESS_DENIED"));
  await assert.rejects(f.service.submitWorkDisclosure(f.principal("bob"), "event-a", "team-b", { scope: "public", fields: { title: true }, idempotencyKey: "who-2" }), errorCode("WORK_DISCLOSURE_ACCESS_DENIED"));
  // 后加入的成员：当前名单包含，但不在最新正式收件回执的成员快照里 → 不能提交（与申诉同口径）。
  f.teams.set("event-a:team-a", { ...f.teams.get("event-a:team-a")!, memberUserIds: ["alice", "member", "outsider"] });
  await assert.rejects(f.service.submitWorkDisclosure(f.principal("outsider"), "event-a", "team-a", { scope: "public", fields: { title: true }, idempotencyKey: "who-3" }), errorCode("WORK_DISCLOSURE_ACCESS_DENIED"));
  const ok = await f.service.submitWorkDisclosure(f.principal("member"), "event-a", "team-a", { scope: "participants", fields: { title: true }, idempotencyKey: "who-4" });
  assert.equal(ok.teamId, "team-a"); assert.equal(ok.authorUserId, "member");
});


test("未正式交件的队伍不能选择公开范围；撤回后作品立即消失且可以用新标识重新提交", async t => {
  const f = await fixture(t); showcaseOn(f);
  const view = await f.service.myWorkDisclosure(f.principal("alice"), "event-a", "team-a");
  assert.equal(view.hasFormalReceipt, false); assert.equal(view.canSubmit, false); assert.equal(view.active, null);
  assert.match(view.reason!, /正式交件/);
  await assert.rejects(f.service.submitWorkDisclosure(f.principal("alice"), "event-a", "team-a", { scope: "participants", fields: { title: true }, idempotencyKey: "wd-1" }), errorCode("WORK_DISCLOSURE_NOT_PARTICIPATED"));
  const receipt = await f.submit();
  const created = await f.service.submitWorkDisclosure(f.principal("alice"), "event-a", "team-a", { scope: "public", fields: { title: true }, idempotencyKey: "wd-2" });
  assert.equal(created.receiptId, receipt.id); assert.equal(created.receiptVersion, receipt.version);
  assert.equal((await f.service.works(f.principal("outsider"), "event-a")).items.length, 1);
  // 撤回可以由本队任一仍在收件快照内的成员发起（撤回是隐私保护方向，不要求必须是提交人）。
  const withdrawn = await f.service.withdrawWorkDisclosure(f.principal("member"), "event-a", "team-a", { expectedRevision: created.revision });
  assert.equal(withdrawn.status, "withdrawn"); assert.equal(withdrawn.revision, 2);
  assert.equal((await f.service.works(f.principal("outsider"), "event-a")).items.length, 0, "撤回后立即不再展示");
  await assert.rejects(f.service.withdrawWorkDisclosure(f.principal("alice"), "event-a", "team-a", { expectedRevision: withdrawn.revision }), errorCode("WORK_DISCLOSURE_NOT_FOUND"));
  const again = await f.service.submitWorkDisclosure(f.principal("member"), "event-a", "team-a", { scope: "public", fields: { title: true }, idempotencyKey: "wd-3" });
  assert.equal(again.status, "active"); assert.equal(again.revision, 1);
  assert.equal((await f.service.works(f.principal("outsider"), "event-a")).items.length, 1);
});

test("主办方侧作品展示只列已选择公开的作品，未公开只计数量且不暴露身份", async t => {
  const f = await fixture(t); showcaseOn(f);
  await f.submit(); await f.submit("team-two", "bob", "作品乙");
  await f.service.submitWorkDisclosure(f.principal("alice"), "event-a", "team-a", { scope: "participants", fields: { title: true }, idempotencyKey: "org-1" });
  const view = await f.service.eventWorkShowcase(f.staff, "event-a");
  assert.equal(view.visibleCount, 1); assert.deepEqual(view.items.map(item => [item.teamId, item.scope]), [["team-a", "participants"]]);
  assert.equal(view.notDisclosedTeamCount, 1, "有正式收件但未选择公开的队伍只计数量");
  assert.ok(!JSON.stringify(view).includes("team-two"), "未公开队伍的身份不出现");
  assert.ok(!JSON.stringify(view).includes("作品乙"));
  await assert.rejects(f.service.eventWorkShowcase(f.principal("alice"), "event-a"), errorCode("STAFF_REQUIRED"));
  await assert.rejects(f.service.eventWorkShowcase(f.staff, "event-b"), errorCode("STAFF_REQUIRED"), "没有本场权限就看不到本场作品");
});

test("公开范围写既有审计，只读的作品展示不产生任何写入", async t => {
  const f = await fixture(t); showcaseOn(f); await f.submit();
  const actions = async (): Promise<string[]> => (await f.database.query<{ document: { action: string } }>("SELECT document FROM ej_judging_audits")).rows.map(row => row.document.action);
  const base = (await actions()).length;
  await f.service.works(f.principal("alice"), "event-a");
  await f.service.myWorkDisclosure(f.principal("alice"), "event-a", "team-a");
  await f.service.eventWorkShowcase(f.staff, "event-a");
  assert.equal((await actions()).length, base, "只读投影不写审计、不写任何事实");
  const created = await f.service.submitWorkDisclosure(f.principal("alice"), "event-a", "team-a", { scope: "public", fields: { title: true }, idempotencyKey: "au-1" });
  assert.equal((await actions()).length, base + 1);
  assert.ok((await actions()).includes("work_disclosure_submitted"));
  await f.service.withdrawWorkDisclosure(f.principal("alice"), "event-a", "team-a", { expectedRevision: created.revision });
  assert.ok((await actions()).includes("work_disclosure_withdrawn"));
});

test("公开范围与逐项选择只接受明确值，private 不保留任何字段选择", async t => {
  const f = await fixture(t); showcaseOn(f); await f.submit();
  await assert.rejects(f.service.submitWorkDisclosure(f.principal("alice"), "event-a", "team-a", { scope: "everyone" as never, idempotencyKey: "val-1" }), errorCode("JUDGING_INVALID_INPUT"));
  await assert.rejects(f.service.submitWorkDisclosure(f.principal("alice"), "event-a", "team-a", { scope: "public", fields: { contact: true } as never, idempotencyKey: "val-2" }), errorCode("JUDGING_INVALID_INPUT"));
  await assert.rejects(f.service.submitWorkDisclosure(f.principal("alice"), "event-a", "team-a", { scope: "public", fields: { title: "yes" } as never, idempotencyKey: "val-3" }), errorCode("JUDGING_INVALID_INPUT"));
  await assert.rejects(f.service.submitWorkDisclosure(f.principal("alice"), "event-a", "team-a", { scope: "public", fields: { title: true }, idempotencyKey: "  " }), errorCode("JUDGING_INVALID_INPUT"));
  const record = await f.service.submitWorkDisclosure(f.principal("alice"), "event-a", "team-a", { scope: "private", fields: { title: true, links: true }, idempotencyKey: "val-4" });
  assert.deepEqual(record.fields, { title: false, description: false, links: false, files: false });
  assert.equal((await f.service.works(f.principal("alice"), "event-a")).items.length, 0, "明确选择不公开时不产生投影");
});

test("assigned event lookup returns at most 100 distinct sorted event identifiers", async t => {
  const f = await fixture(t); await pendingEventAssignment(f);
  // Use the real schema and an existing valid document as an isolated fixture source.
  await f.database.query("INSERT INTO ej_event_locks(organization_id,event_id) SELECT 'org-bounded','bounded-' || lpad(n::text,3,'0') FROM generate_series(0,100) AS n");
  await f.database.query("INSERT INTO ej_intake_receipts(id,organization_id,event_id,team_id,author_user_id,version,receipt_number,idempotency_key,submitted_at,document) SELECT 'bounded-receipt-' || n,'org-bounded','bounded-' || lpad(n::text,3,'0'),'bounded-team-' || n,'alice',1,'bounded-rec-' || n,'bounded-retry-' || n,submitted_at,document || jsonb_build_object('id','bounded-receipt-' || n,'organizationId','org-bounded','eventId','bounded-' || lpad(n::text,3,'0'),'teamId','bounded-team-' || n,'version',1,'receiptNumber','bounded-rec-' || n,'idempotencyKey','bounded-retry-' || n) FROM ej_intake_receipts CROSS JOIN generate_series(0,100) AS n WHERE event_id='event-a'");
  await f.database.query("INSERT INTO ej_judging_rounds(id,organization_id,event_id,revision,status,created_at,document) SELECT 'bounded-round-' || n,'org-bounded','bounded-' || lpad(n::text,3,'0'),revision,status,created_at,document || jsonb_build_object('id','bounded-round-' || n,'organizationId','org-bounded','eventId','bounded-' || lpad(n::text,3,'0'),'snapshotIds',jsonb_build_array('bounded-receipt-' || n)) FROM ej_judging_rounds CROSS JOIN generate_series(0,100) AS n WHERE event_id='event-a'");
  await f.database.query("INSERT INTO ej_judge_assignments(id,organization_id,event_id,round_id,snapshot_id,judge_user_id,revision,status,declaration,created_at,document) SELECT 'bounded-assignment-' || n,'org-bounded','bounded-' || lpad(n::text,3,'0'),'bounded-round-' || n,'bounded-receipt-' || n,judge_user_id,revision,status,declaration,created_at,document || jsonb_build_object('id','bounded-assignment-' || n,'organizationId','org-bounded','eventId','bounded-' || lpad(n::text,3,'0'),'roundId','bounded-round-' || n,'snapshotId','bounded-receipt-' || n) FROM ej_judge_assignments CROSS JOIN generate_series(0,100) AS n WHERE event_id='event-a'");
  const ids = await f.service.listAssignedEventIds(f.principal("judge-1"));
  assert.equal(ids.length, 100); assert.equal(new Set(ids).size, 100); assert.equal(ids[0], "bounded-000"); assert.equal(ids[99], "bounded-099"); assert.deepEqual(ids, [...ids].sort());
});


/* ------------------------------------------------------------------------------------------------
 * 规划 34 C②「文字留言」（P5）验收（2026-10-16）
 *
 * 与数值互评（P7）**分列**：本轮只做纯文字，不建评分字段、不读写任何互评数据，也绝不进入结果。
 * 以下断言全部是行为断言（含数据库行数、触发器与逐字节比较），不是目测。
 * ---------------------------------------------------------------------------------------------- */
/** 只把「作品展示 + 文字留言」两层赛事开关打开；其余社区能力保持默认关闭。 */
function commentsOn(f: Awaited<ReturnType<typeof fixture>>, community: Partial<EventCommunityConfig> = {}): EventCommunityConfig {
  return showcaseOn(f, { peerFeedback: true, ...community });
}
const commentRows = async (f: Awaited<ReturnType<typeof fixture>>): Promise<number> =>
  (await f.database.query<{ count: number }>("SELECT count(*)::int AS count FROM ej_work_comments")).rows[0]!.count;
const reportRows = async (f: Awaited<ReturnType<typeof fixture>>): Promise<number> =>
  (await f.database.query<{ count: number }>("SELECT count(*)::int AS count FROM ej_work_comment_reports")).rows[0]!.count;
const advance = (f: Awaited<ReturnType<typeof fixture>>, seconds: number): void => {
  f.time.value = new Date(Date.parse(f.time.value) + seconds * 1000).toISOString();
};
const rejected = (code: string, status = 403) => (error: unknown): boolean =>
  error instanceof DomainError && error.code === code && error.status === status;
/** 队伍本人对 team-a 的作品选择公开范围（唯一新增事实）。 */
const disclose = (f: Awaited<ReturnType<typeof fixture>>, scope: "private" | "participants" | "public", key: string) =>
  f.service.submitWorkDisclosure(f.principal("alice"), "event-a", "team-a", { scope, fields: { title: true }, idempotencyKey: key });

test("文字留言门禁：赛事文字留言开关与队伍本人公开缺一即 403，且不落任何行", async t => {
  const f = await fixture(t);
  const receipt = await f.submit();
  const input = { text: "第一条留言", idempotencyKey: "cm-0" };
  // ① 作品展示关闭：读、写、隐藏、举报四个入口全部明确 403（不是空数组）。
  for (const call of [
    () => f.service.workComments(f.principal("alice"), "event-a", receipt.id),
    () => f.service.createWorkComment(f.principal("alice"), "event-a", receipt.id, input),
    () => f.service.hideWorkComment(f.principal("alice"), "event-a", receipt.id, "missing", { reason: "" }),
    () => f.service.reportWorkComment(f.principal("alice"), "event-a", receipt.id, "missing", { reason: "" }),
  ]) await assert.rejects(call(), rejected("WORK_SHOWCASE_DISABLED"));
  // ② 作品展示开、文字留言关：报 WORK_COMMENTS_DISABLED，而不是"还没有留言"。
  showcaseOn(f);
  await assert.rejects(f.service.workComments(f.principal("alice"), "event-a", receipt.id), rejected("WORK_COMMENTS_DISABLED"));
  await assert.rejects(f.service.createWorkComment(f.principal("alice"), "event-a", receipt.id, input), rejected("WORK_COMMENTS_DISABLED"));
  // ③ 两层开关都开，但队伍本人没有选择公开。
  commentsOn(f);
  await assert.rejects(f.service.workComments(f.principal("alice"), "event-a", receipt.id), rejected("WORK_COMMENTS_NOT_DISCLOSED"));
  await assert.rejects(f.service.createWorkComment(f.principal("alice"), "event-a", receipt.id, input), rejected("WORK_COMMENTS_NOT_DISCLOSED"));
  // ④ 队伍本人明确选择不公开。
  await disclose(f, "private", "gate-private");
  await assert.rejects(f.service.workComments(f.principal("alice"), "event-a", receipt.id), rejected("WORK_COMMENTS_NOT_DISCLOSED"));
  await assert.rejects(f.service.createWorkComment(f.principal("alice"), "event-a", receipt.id, input), rejected("WORK_COMMENTS_NOT_DISCLOSED"));
  assert.equal(await commentRows(f), 0, "门禁不满足时零行落库");
  // ⑤ 三层齐全：空列表是正常结果（不是错误），写留言成功。
  await disclose(f, "public", "gate-public");
  const empty = await f.service.workComments(f.principal("alice"), "event-a", receipt.id);
  assert.equal(empty.commentsEnabled, true); assert.equal(empty.items.length, 0); assert.equal(empty.totalCount, 0);
  const created = await f.service.createWorkComment(f.principal("alice"), "event-a", receipt.id, input);
  assert.equal(created.text, "第一条留言"); assert.equal(created.status, "active"); assert.equal(await commentRows(f), 1);
});

test("只有看得到该作品的人能读和留言：participants 档仅本场已通过报名者，public 档含任何已登录账号", async t => {
  const f = await fixture(t); commentsOn(f);
  const receipt = await f.submit();
  await disclose(f, "participants", "vis-1");
  const own = await f.service.workComments(f.principal("alice"), "event-a", receipt.id);
  assert.equal(own.scope, "participants"); assert.equal(own.commentsEnabled, true);
  const first = await f.service.createWorkComment(f.principal("alice"), "event-a", receipt.id, { text: "本场选手留言", idempotencyKey: "vis-a" });
  assert.equal(first.text, "本场选手留言");
  advance(f, 31);
  await f.service.createWorkComment(f.principal("bob"), "event-a", receipt.id, { text: "另一队的选手也看得到", idempotencyKey: "vis-b" });
  assert.equal(await commentRows(f), 2, "另一队报名已通过的选手可以留言");
  // 已登录但不是本场参赛者：读、写、举报全部 403，且零行落库。
  await assert.rejects(f.service.workComments(f.principal("outsider"), "event-a", receipt.id), rejected("WORK_COMMENTS_PARTICIPANTS_ONLY"));
  await assert.rejects(f.service.createWorkComment(f.principal("outsider"), "event-a", receipt.id, { text: "不该写进去", idempotencyKey: "vis-c" }), rejected("WORK_COMMENTS_PARTICIPANTS_ONLY"));
  await assert.rejects(f.service.reportWorkComment(f.principal("outsider"), "event-a", receipt.id, first.id, { reason: "" }), rejected("WORK_COMMENTS_PARTICIPANTS_ONLY"));
  assert.equal(await commentRows(f), 2, "被拒的留言零行落库");
  // 改为「公开（含访客）」后，任何已登录账号都能看到并留言（未登录由 HTTP 层 401）。
  await disclose(f, "public", "vis-2");
  assert.equal((await f.service.workComments(f.principal("outsider"), "event-a", receipt.id)).totalCount, 2);
  const outsiderComment = await f.service.createWorkComment(f.principal("outsider"), "event-a", receipt.id, { text: "公开档下非参赛者也能留言", idempotencyKey: "vis-d" });
  assert.equal(outsiderComment.isMine, true); assert.equal(outsiderComment.text, "公开档下非参赛者也能留言");
});

test("文字留言与互评分列：只有文字、长度取自本场配置，且不存在任何评分字段或互评表", async t => {
  const f = await fixture(t); commentsOn(f, { commentMaxLength: 60 });
  const receipt = await f.submit(); await disclose(f, "public", "split-1");
  const list = await f.service.workComments(f.principal("alice"), "event-a", receipt.id);
  assert.equal(list.commentMaxLength, 60, "长度上限取自主办方配置");
  await assert.rejects(f.service.createWorkComment(f.principal("alice"), "event-a", receipt.id, { text: "字".repeat(61), idempotencyKey: "split-2" }), errorCode("JUDGING_INVALID_INPUT"));
  assert.equal(await commentRows(f), 0, "超长留言零行落库");
  const created = await f.service.createWorkComment(f.principal("alice"), "event-a", receipt.id, { text: "字".repeat(60), idempotencyKey: "split-3" });
  assert.equal(created.text!.length, 60, "恰好等于上限必须通过");
  const json = JSON.stringify(await f.service.workComments(f.principal("alice"), "event-a", receipt.id));
  for (const forbidden of ["score", "rating", "percent", "dimension", "scale", "peerReview", "weight", "完成度"]) {
    assert.ok(!json.includes(forbidden), "文字留言面不应出现：" + forbidden);
  }
  const tables = (await f.database.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_name LIKE '%peer_review%' OR table_name LIKE '%peer_feedback%' OR table_name LIKE '%comment%score%'")).rows[0]!.count;
  assert.equal(tables, 0, "本批不建互评表、不读写任何互评数据");
});

test("文字留言绝不并入结果：提交留言前后预览、哈希、留档导出与公开投影逐字节不变", async t => {
  const f = await fixture(t); commentsOn(f);
  const first = await f.submit(), second = await f.submit("team-two", "bob", "作品乙");
  await disclose(f, "public", "inv-1");
  const round = await f.start();
  const a1 = await f.assign(round, first, "judge-1"), a2 = await f.assign(round, second, "judge-2");
  await f.service.submitScore(f.principal("judge-1"), "event-a", a1.id, f.scoreInput(a1, 0, { idea: 8, build: 8 }));
  await f.service.submitScore(f.principal("judge-2"), "event-a", a2.id, f.scoreInput(a2, 0, { idea: 6, build: 6 }));
  await f.service.lockRound(f.staff, "event-a", round.id, round.revision);
  const locked = (await f.service.workspace(f.staff, "event-a")).rounds[0]!;
  const lockedPreview = await f.service.previewResults(f.staff, "event-a", locked.id);
  await f.service.publishResults(f.staff, "event-a", locked.id, { expectedRevision: locked.revision, expectedSummaryHash: lockedPreview.summaryHash, visibility: "public", approvedFeedback: [] });
  const capture = async (loaded: JudgingRound) => ({
    preview: await f.service.previewResults(f.staff, "event-a", loaded.id),
    resultsCsv: await f.service.exportResults(f.staff, "event-a", loaded.id),
    scoresCsv: await f.service.exportScores(f.staff, "event-a"),
    mine: await f.service.myResults(f.principal("alice"), "event-a"),
    publicProjection: await f.service.publicResults("event-a"),
    workspace: await f.service.workspace(f.staff, "event-a"),
    materials: await f.service.judgeMaterials(f.principal("judge-1"), "event-a", a1.id),
  });
  const before = await capture(locked);
  const marker = "留言正文不得出现在任何结果面";
  // 时钟保持不动：留档导出头部含"生成时间"，只有时钟不变才谈得上逐字节比较。
  const created = await f.service.createWorkComment(f.principal("alice"), "event-a", first.id, { text: marker, idempotencyKey: "inv-cm-1" });
  await f.service.createWorkComment(f.principal("bob"), "event-a", first.id, { text: marker + "（第二条）", idempotencyKey: "inv-cm-2" });
  assert.equal(await commentRows(f), 2);
  const after = await capture(locked);
  assert.deepEqual(after.preview.summary, before.preview.summary);
  assert.equal(after.preview.summaryHash, before.preview.summaryHash);
  assert.deepEqual(after.preview.round, before.preview.round);
  assert.deepEqual(after.preview.publicationReview, before.preview.publicationReview);
  assert.deepEqual(after.preview.summary.rows.map(row => [row.teamId, row.total, row.rank]), [["team-a", 80, 1], ["team-two", 60, 2]]);
  assert.equal(after.resultsCsv.csv, before.resultsCsv.csv, "留档导出必须逐字节不变");
  assert.equal(after.resultsCsv.filename, before.resultsCsv.filename);
  assert.equal(after.scoresCsv.csv, before.scoresCsv.csv, "内部对账表必须逐字节不变");
  assert.deepEqual(after.mine, before.mine);
  assert.deepEqual(after.publicProjection, before.publicProjection);
  assert.deepEqual(after.workspace, before.workspace);
  assert.deepEqual(after.materials, before.materials);
  const surfaces: readonly (readonly [string, string])[] = [["结果预览", JSON.stringify(after.preview)], ["留档导出", after.resultsCsv.csv],
    ["内部对账表", after.scoresCsv.csv], ["本人结果", JSON.stringify(after.mine)], ["公开结果投影", JSON.stringify(after.publicProjection)],
    ["主办方工作台", JSON.stringify(after.workspace)], ["评委材料", JSON.stringify(after.materials)]];
  for (const [label, value] of surfaces) assert.ok(!value.includes(marker), label + "不应包含留言正文");
  assert.ok(!after.resultsCsv.csv.includes("comment"), "留档件不应出现留言表/字段名");
  // 结果链路根本不引用留言表：删掉留言行后各结果面仍然逐字节相同。
  await f.database.query("DELETE FROM ej_work_comment_reports"); await f.database.query("DELETE FROM ej_work_comments");
  assert.equal((await f.service.exportResults(f.staff, "event-a", locked.id)).csv, before.resultsCsv.csv);
  assert.deepEqual((await f.service.previewResults(f.staff, "event-a", locked.id)).summary, before.preview.summary);
  assert.equal(created.text, marker);
});

test("评审隔离：评委侧、主办方作品展示与审计都不返回留言正文", async t => {
  const f = await fixture(t); commentsOn(f);
  const receipt = await f.submit(); await disclose(f, "public", "iso-1");
  const round = await f.start();
  const assignment = await f.assign(round, receipt, "judge-1");
  const marker = "这段正文只允许出现在作品详情页";
  const created = await f.service.createWorkComment(f.principal("alice"), "event-a", receipt.id, { text: marker, idempotencyKey: "iso-2" });
  await f.service.submitScore(f.principal("judge-1"), "event-a", assignment.id, f.scoreInput(assignment));
  const surfaces: readonly (readonly [string, string])[] = [
    ["评委材料", JSON.stringify(await f.service.judgeMaterials(f.principal("judge-1"), "event-a", assignment.id))],
    ["评委工作台", JSON.stringify(await f.service.judgeAssignments(f.principal("judge-1"), "event-a"))],
    ["主办方作品展示", JSON.stringify(await f.service.eventWorkShowcase(f.staff, "event-a"))],
    ["评审校准", JSON.stringify(await f.service.calibration(f.staff, "event-a", round.id))],
    ["评审自检", JSON.stringify(await f.service.integrity(f.staff, "event-a", round.id))],
    ["评审进度", JSON.stringify(await f.service.progress(f.staff, "event-a", round.id))],
    ["公平规则包", JSON.stringify(await f.service.fairness(f.staff, "event-a", round.id))],
    ["重复材料线索", JSON.stringify(await f.service.duplicates(f.staff, "event-a"))],
  ];
  for (const [label, value] of surfaces) assert.ok(!value.includes(marker), label + "不应出现留言正文");
  // 审计只记留言 ID、队伍与字数：可追溯，但不复制正文。
  const audits = await f.service.auditHistory(f.staff, "event-a");
  assert.ok(audits.items.some(item => item.action === "work_comment_created"));
  const auditJson = JSON.stringify(audits);
  assert.ok(!auditJson.includes(marker), "审计不应含留言正文");
  assert.ok(audits.items.some(item => item.action === "work_comment_created" && item.subjectId === created.id && JSON.stringify(item.details).includes("charCount")));
  await f.service.hideWorkComment(f.principal("alice"), "event-a", receipt.id, created.id, { reason: "本人撤回自己的留言" });
  const hiddenJson = JSON.stringify(await f.service.auditHistory(f.staff, "event-a"));
  assert.ok(!hiddenJson.includes(marker)); assert.ok(hiddenJson.includes("work_comment_hidden"));
  // 只有作品详情页的独立区返回正文；隐藏后连它也不返回。
  const list = await f.service.workComments(f.principal("alice"), "event-a", receipt.id);
  assert.equal(list.totalCount, 0); assert.equal(list.hiddenCount, 1);
  assert.ok(!JSON.stringify(list).includes(marker));
});

test("治理：作者本人或本场工作人员可隐藏，隐藏后不再返回内容，且同一条只能隐藏一次", async t => {
  const f = await fixture(t); commentsOn(f);
  const receipt = await f.submit(); await disclose(f, "public", "gov-1");
  const marker = "需要被隐藏的留言正文";
  const created = await f.service.createWorkComment(f.principal("alice"), "event-a", receipt.id, { text: marker, idempotencyKey: "gov-2" });
  // 既不是留言作者、也不是本场工作人员：拒绝，且状态不被改写。
  await assert.rejects(f.service.hideWorkComment(f.principal("bob"), "event-a", receipt.id, created.id, { reason: "" }), rejected("STAFF_REQUIRED"));
  await assert.rejects(f.service.hideWorkComment(f.principal("outsider"), "event-a", receipt.id, created.id, { reason: "" }), rejected("STAFF_REQUIRED"));
  assert.equal((await f.service.workComments(f.principal("alice"), "event-a", receipt.id)).items[0]!.text, marker, "被拒时留言状态不变");
  const byStaff = await f.service.hideWorkComment(f.staff, "event-a", receipt.id, created.id, { reason: "与队伍无关的内容" });
  assert.equal(byStaff.status, "hidden"); assert.equal(byStaff.text, null); assert.equal(byStaff.hiddenBy, "staff");
  const afterHide = await f.service.workComments(f.principal("bob"), "event-a", receipt.id);
  assert.equal(afterHide.totalCount, 0); assert.equal(afterHide.hiddenCount, 1); assert.equal(afterHide.items.length, 0);
  assert.ok(!JSON.stringify(afterHide).includes(marker), "隐藏后对所有人都不再返回正文");
  // 幂等：重复隐藏返回同一条、版本不变、不写第二行、不改写原隐藏说明。
  const again = await f.service.hideWorkComment(f.staff, "event-a", receipt.id, created.id, { reason: "重复请求" });
  assert.deepEqual(again, byStaff);
  const rows = (await f.database.query<{ document: WorkComment }>("SELECT document FROM ej_work_comments")).rows.map(row => row.document);
  assert.equal(rows.length, 1); assert.equal(rows[0]!.revision, 2); assert.equal(rows[0]!.hiddenReason, "与队伍无关的内容");
  // 留言作者本人也能隐藏自己的留言。
  advance(f, 31);
  const second = await f.service.createWorkComment(f.principal("alice"), "event-a", receipt.id, { text: "作者自己撤回", idempotencyKey: "gov-3" });
  const selfHidden = await f.service.hideWorkComment(f.principal("alice"), "event-a", receipt.id, second.id, { reason: "本人撤回" });
  assert.equal(selfHidden.hiddenBy, "author"); assert.equal(selfHidden.text, null);
  // 不可变触发器：隐藏后不能回到 active、不能跳版本、正文不可改写。
  await assert.rejects(f.database.query("UPDATE ej_work_comments SET status='active',revision=revision+1,hidden_at=NULL,document=jsonb_set(document,'{status}',to_jsonb('active'::text)) WHERE id=$1", [created.id]), /only move from active to hidden/);
  await assert.rejects(f.database.query("UPDATE ej_work_comments SET revision=revision+5,document=jsonb_set(document,'{revision}',to_jsonb(revision+5)) WHERE id=$1", [created.id]), /revision must increase by one/);
  await assert.rejects(f.database.query("UPDATE ej_work_comments SET document=jsonb_set(document,'{text}',to_jsonb('篡改'::text)) WHERE id=$1", [created.id]), /immutable/);
});

test("举报：任一可见者只记录一次事实，不改变留言状态、不做裁决", async t => {
  const f = await fixture(t); commentsOn(f);
  const receipt = await f.submit(); await disclose(f, "public", "rep-1");
  const marker = "被举报的留言正文";
  const created = await f.service.createWorkComment(f.principal("alice"), "event-a", receipt.id, { text: marker, idempotencyKey: "rep-2" });
  const first = await f.service.reportWorkComment(f.principal("bob"), "event-a", receipt.id, created.id, { reason: "与作品无关" });
  assert.equal(first.alreadyReported, false); assert.equal(first.reportedCount, 1);
  const duplicate = await f.service.reportWorkComment(f.principal("bob"), "event-a", receipt.id, created.id, { reason: "再次举报" });
  assert.equal(duplicate.alreadyReported, true); assert.equal(duplicate.reportId, first.reportId); assert.equal(duplicate.reportedCount, 1);
  assert.equal(await reportRows(f), 1, "同账号同留言只能有一条举报");
  // 举报不改变留言状态：正文照常返回，也没有任何裁决/评分字段。
  const mine = (await f.service.workComments(f.principal("alice"), "event-a", receipt.id)).items[0]!;
  assert.equal(mine.text, marker); assert.equal(mine.status, "active"); assert.equal(mine.reportedCount, 1); assert.equal(mine.reportedByViewer, false);
  assert.equal((await f.service.workComments(f.principal("bob"), "event-a", receipt.id)).items[0]!.reportedByViewer, true);
  // 举报说明进既有审计（主办方可按既有流程处理），审计不含留言正文。
  const auditJson = JSON.stringify(await f.service.auditHistory(f.staff, "event-a"));
  assert.ok(auditJson.includes("work_comment_reported")); assert.ok(auditJson.includes("与作品无关")); assert.ok(!auditJson.includes(marker));
  // 举报是 append-only 事实。
  await assert.rejects(f.database.query("UPDATE ej_work_comment_reports SET reason='改' WHERE id=$1", [first.reportId]), /append-only/);
  await assert.rejects(f.database.query("DELETE FROM ej_work_comment_reports WHERE id=$1", [first.reportId]), /append-only/);
  // 其他可见者仍可各自举报同一条留言。
  await f.service.reportWorkComment(f.principal("outsider"), "event-a", receipt.id, created.id, { reason: "我也看到了" });
  assert.equal(await reportRows(f), 2);
  // 隐藏后的留言已不再返回，不能举报。
  await f.service.hideWorkComment(f.principal("alice"), "event-a", receipt.id, created.id, { reason: "本人撤回" });
  await assert.rejects(f.service.reportWorkComment(f.principal("bob"), "event-a", receipt.id, created.id, { reason: "" }), rejected("WORK_COMMENT_NOT_FOUND", 404));
});

test("同账号同赛事限频：冷却内拒绝并零行落库，已隐藏的留言同样计入", async t => {
  const f = await fixture(t); commentsOn(f);
  const receipt = await f.submit(); await disclose(f, "public", "rate-1");
  const first = await f.service.createWorkComment(f.principal("alice"), "event-a", receipt.id, { text: "第一条", idempotencyKey: "rate-2" });
  await assert.rejects(f.service.createWorkComment(f.principal("alice"), "event-a", receipt.id, { text: "第二条", idempotencyKey: "rate-3" }), rejected("WORK_COMMENTS_RATE_LIMITED", 429));
  assert.equal(await commentRows(f), 1, "限频拒绝时零行落库");
  await f.service.hideWorkComment(f.principal("alice"), "event-a", receipt.id, first.id, { reason: "先隐藏再发" });
  await assert.rejects(f.service.createWorkComment(f.principal("alice"), "event-a", receipt.id, { text: "隐藏也绕不过", idempotencyKey: "rate-4" }), rejected("WORK_COMMENTS_RATE_LIMITED", 429));
  assert.equal(await commentRows(f), 1);
  const other = await f.service.createWorkComment(f.principal("bob"), "event-a", receipt.id, { text: "另一位选手", idempotencyKey: "rate-5" });
  assert.equal(other.text, "另一位选手", "冷却只按账号计算，不影响其他人");
  advance(f, 30);
  const second = await f.service.createWorkComment(f.principal("alice"), "event-a", receipt.id, { text: "冷却结束后", idempotencyKey: "rate-6" });
  assert.equal(second.text, "冷却结束后"); assert.equal(await commentRows(f), 3);
});

test("留言幂等与不可变：同键重放返回同一条，同键不同正文或不同作品都拒绝", async t => {
  const f = await fixture(t); commentsOn(f);
  const receipt = await f.submit(); await disclose(f, "public", "idem-1");
  const input = { text: "同一条留言", idempotencyKey: "idem-2" };
  const created = await f.service.createWorkComment(f.principal("alice"), "event-a", receipt.id, input);
  assert.deepEqual(await f.service.createWorkComment(f.principal("alice"), "event-a", receipt.id, input), created, "同键同正文重放返回同一条");
  assert.equal(await commentRows(f), 1);
  await assert.rejects(f.service.createWorkComment(f.principal("alice"), "event-a", receipt.id, { ...input, text: "换了正文" }), errorCode("IDEMPOTENCY_KEY_REUSED"));
  // 同键用在另一支队伍的作品上同样拒绝（重试标识按赛事+作者唯一）。
  const other = await f.submit("team-two", "bob", "作品乙");
  await f.service.submitWorkDisclosure(f.principal("bob"), "event-a", "team-two", { scope: "public", fields: { title: true }, idempotencyKey: "idem-t2" });
  await assert.rejects(f.service.createWorkComment(f.principal("alice"), "event-a", other.id, input), errorCode("IDEMPOTENCY_KEY_REUSED"));
  assert.equal(await commentRows(f), 1);
  advance(f, 31);
  const next = await f.service.createWorkComment(f.principal("alice"), "event-a", receipt.id, { text: "第二条", idempotencyKey: "idem-3" });
  assert.notEqual(next.id, created.id); assert.equal(await commentRows(f), 2);
  // 触发器：作者与正文不可改写。
  await assert.rejects(f.database.query("UPDATE ej_work_comments SET document=jsonb_set(document,'{authorUserId}',to_jsonb('bob'::text)) WHERE id=$1", [created.id]), /immutable/);
});

test("留言只对当前正在展示的版本开放：旧版本不再是入口，已写留言仍跟随该队伍的作品", async t => {
  const f = await fixture(t); commentsOn(f);
  const v1 = await f.submit(); await disclose(f, "public", "snap-1");
  const created = await f.service.createWorkComment(f.principal("alice"), "event-a", v1.id, { text: "挂在队伍作品上", idempotencyKey: "snap-2" });
  assert.equal(created.teamId, "team-a");
  const stored = (await f.database.query<{ document: WorkComment }>("SELECT document FROM ej_work_comments WHERE id=$1", [created.id])).rows[0]!.document;
  assert.equal(stored.snapshotId, v1.id, "留言记录写留言时那一版正式收件，作为“当时是哪一版”的证据");
  advance(f, 31);
  const v2 = await f.submit("team-a", "alice", "第二版作品");
  assert.equal(v2.version, 2);
  await assert.rejects(f.service.workComments(f.principal("alice"), "event-a", v1.id), rejected("WORK_COMMENTS_NOT_DISCLOSED"));
  await assert.rejects(f.service.createWorkComment(f.principal("alice"), "event-a", v1.id, { text: "不该写进旧版本", idempotencyKey: "snap-3" }), rejected("WORK_COMMENTS_NOT_DISCLOSED"));
  const list = await f.service.workComments(f.principal("alice"), "event-a", v2.id);
  assert.equal(list.snapshotId, v2.id); assert.equal(list.teamId, "team-a");
  assert.equal(list.totalCount, 1); assert.equal(list.items[0]!.text, "挂在队伍作品上", "留言是队伍级作品上的事实，换版本后仍然属于该作品");
  // 未知快照与跨赛事快照一律 404，不泄露其他赛事是否存在。
  await assert.rejects(f.service.workComments(f.principal("alice"), "event-a", "missing"), rejected("INTAKE_NOT_FOUND", 404));
  const otherEvent = await f.service.submit(f.principal("bob"), "event-b", await f.prepare("team-b", "bob", "event-b"));
  await assert.rejects(f.service.workComments(f.principal("alice"), "event-a", otherEvent.id), rejected("INTAKE_NOT_FOUND", 404));
});

test("工作人员探测：真实根抛 ORGANIZER_FORBIDDEN 时读取与写入照常 200，canHide 只是展示信息", async t => {
  const f = await fixture(t); commentsOn(f);
  const receipt = await f.submit(); await disclose(f, "participants", "probe-1");
  // 真实根（src/modules/organizer/service.ts 的 denied()）拒绝非工作人员时抛 ORGANIZER_FORBIDDEN，
  // 而不是模块夹具的 STAFF_REQUIRED：探测绝不能把这个 403 变成读留言的 403。
  f.hooks.staffDenial = () => new DomainError("ORGANIZER_FORBIDDEN", "你目前没有这家机构或这场比赛的操作权限。", { status: 403 });
  const created = await f.service.createWorkComment(f.principal("alice"), "event-a", receipt.id, { text: "根合同下的留言", idempotencyKey: "probe-2" });
  assert.equal(created.text, "根合同下的留言");
  assert.equal(created.canHide, true, "作者本人仍然看到可隐藏");
  const byAuthor = await f.service.workComments(f.principal("alice"), "event-a", receipt.id);
  assert.equal(byAuthor.items.length, 1); assert.equal(byAuthor.items[0]!.canHide, true);
  const byOther = await f.service.workComments(f.principal("bob"), "event-a", receipt.id);
  assert.equal(byOther.items.length, 1); assert.equal(byOther.items[0]!.canHide, false, "非作者非工作人员：只是不可隐藏，读取照常成功");
  assert.equal(byOther.items[0]!.canReport, true);
  advance(f, 31);
  const second = await f.service.createWorkComment(f.principal("bob"), "event-a", receipt.id, { text: "另一位选手也能写", idempotencyKey: "probe-3" });
  assert.equal(second.text, "另一位选手也能写");
  // 非 403 的错误（会话失效、赛事范围不符、Port 故障）照常抛出，不被探测吞掉。
  f.hooks.staffDenial = () => new DomainError("SESSION_REVOKED", "会话已撤销。", { status: 401 });
  await assert.rejects(f.service.workComments(f.principal("alice"), "event-a", receipt.id), rejected("SESSION_REVOKED", 401));
});
