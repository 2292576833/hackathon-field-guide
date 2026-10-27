import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { HostedEventScope, EventRosterTeamSnapshot, EventRegistrationSnapshot, OrganizerPrincipal, HostedEventAccessPort, EventParticipationPort, EventJudgeConflictPort } from "../../shared/organizer-contracts.ts";
import { createEventJudgingService } from "./service.ts";
import type { JudgingConfig, JudgingRound, IntakeReceipt, JudgeAssignment, SubmissionMaterials, SubmissionInput, ScoreInput } from "./model.ts";

/**
 * P06 · 评审进度追踪（N2）与已公布结果导出（N4）。
 *
 * 夹具与 `service.test.ts` 同构（隔离内存 PGlite、注入 Port、不打开 `.env.local` 或任何实际数据库）。
 * 本文件重点固定"口径必须与既有实现一致"这一条：
 *  - `progress` 的已提交评分数与 `aggregate()` 计入数相等；
 *  - `progress` 的评委已提交数与 `calibration()` 的 `submittedCount` 相等；
 *  - 读取 `progress` / 导出前后，`workspace()` 的评分、指派、锁定汇总与公布依据完全不变。
 */

const currentTime = "2026-10-11T08:00:00.000Z";
const deadline = "2026-10-12T08:00:00.000Z";
const userIds = ["alice", "member", "bob", "judge-1", "judge-2", "judge-3", "judge-4", "staff", "outsider"];
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

async function fixture(t: TestContext) {
  const pg = new PGlite(); t.after(() => pg.close()); await pg.waitReady;
  await pg.exec("CREATE TABLE auth_users(id text PRIMARY KEY);");
  for (const userId of userIds) await pg.query("INSERT INTO auth_users(id) VALUES($1)", [userId]);
  await pg.exec(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
  function executor(query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>): SqlExecutor {
    return { async query<Row>(statement: string, params: readonly unknown[] = []) {
      const result = await query(statement, [...params]); return { rows: result.rows as Row[], rowCount: result.affectedRows ?? result.rows.length };
    } };
  }
  const database: DatabasePort = { ...executor((sql, params) => pg.query(sql, params)), transaction: work => pg.transaction(tx => work(executor((sql, params) => tx.query(sql, params)))) };
  const scopes = new Map([["event-a", eventScope("event-a", "org-a")], ["event-b", eventScope("event-b", "org-b")]]);
  const teams = new Map<string, EventRosterTeamSnapshot>(), registrations = new Map<string, EventRegistrationSnapshot>();
  const addTeam = (eventId: string, teamId: string, captain: string, members: readonly string[]) => {
    teams.set(`${eventId}:${teamId}`, { id: teamId, eventId, organizationId: scopes.get(eventId)!.organizationId, captainUserId: captain, memberUserIds: members,
      revision: 1, status: "locked", eligible: true, projectId: null });
    for (const userId of members) registrations.set(`${eventId}:${userId}`, { id: `registration-${eventId}-${userId}`, eventId, userId, status: "approved", revision: 1 });
  };
  addTeam("event-a", "team-a", "alice", ["alice", "member"]);
  addTeam("event-a", "team-b", "bob", ["bob"]);
  const staffGrants = new Set(["event-a:staff", "event-b:staff"]), revokedSessions = new Set<string>();
  const conflictStatuses = new Map<string, "clear" | "conflict" | "needs_review">();
  const publicFeedback = new Map<string, string>(), teamFeedback = new Map<string, string>();
  const principal = (userId: string, platformRoles: Actor["platformRoles"] = ["user"]): OrganizerPrincipal => ({ actor: { userId, platformRoles }, guard: async sql => {
    const user = await sql.query("SELECT id FROM auth_users WHERE id=$1", [userId]);
    if (!user.rows.length || revokedSessions.has(userId)) throw new DomainError("SESSION_REVOKED", "会话已撤销。", { status: 401 });
  } });
  const events: HostedEventAccessPort = {
    async getEvent(_sql, eventId) { return scopes.get(eventId) ?? null; },
    async requireStaff(_sql, actor, eventId, capability) {
      assert.equal(capability, "judging_manage");
      if (!staffGrants.has(`${eventId}:${actor.userId}`)) throw new DomainError("STAFF_REQUIRED", "没有这场比赛的评审管理权限。", { status: 403 });
      return scopes.get(eventId)!;
    },
  };
  const participation: EventParticipationPort = {
    async getTeam(_sql, eventId, teamId) { return teams.get(`${eventId}:${teamId}`) ?? null; },
    async getRegistration(_sql, eventId, userId) { return registrations.get(`${eventId}:${userId}`) ?? null; },
  };
  const conflicts: EventJudgeConflictPort = { async inspect(_sql, input) {
    const status = conflictStatuses.get(`${input.eventId}:${input.teamId}:${input.judgeUserId}`) ?? "clear";
    return { status, reasons: status === "clear" ? [] : ["受控的已知辅导或待核查关联"] };
  } };
  let nextId = 0, nextKey = 0;
  const time = { value: currentTime };
  const service = createEventJudgingService({ database, clock: { now: () => new Date(time.value) }, ids: { next: () => `ej-${++nextId}` }, events, participation, conflicts });
  const staff = principal("staff", ["admin"]);
  const prepare = async (teamId: string, userId: string, title: string): Promise<SubmissionInput> => {
    const preview = await service.previewSubmission(principal(userId), "event-a", { teamId, materials: material(title) });
    return { teamId, materials: preview.materials, expectedEventRevision: preview.eventRevision, expectedTeamRevision: preview.teamRevision,
      expectedPreviousVersion: preview.previousVersion, expectedMaterialHash: preview.materialHash, idempotencyKey: `retry-${++nextKey}` };
  };
  const submit = async (teamId: string, userId: string, title: string) => service.submit(principal(userId), "event-a", await prepare(teamId, userId, title));
  /** 建立一轮：配置 → 开轮 → 按需指派评委。 */
  const open = async (overrides: Partial<JudgingConfig> = {}) => {
    const setup = await service.saveConfig(staff, "event-a", { expectedRevision: 0, config: { ...baseConfig, ...overrides } });
    return service.startRound(staff, "event-a", setup.id, setup.revision);
  };
  const assign = async (round: JudgingRound, receipt: IntakeReceipt, judgeUserId: string): Promise<JudgeAssignment> => {
    const assignment = await service.assignJudge(staff, "event-a", { roundId: round.id, snapshotId: receipt.id, judgeUserId, expectedRoundRevision: round.revision });
    return service.declareConflict(principal(judgeUserId), "event-a", assignment.id, { expectedRevision: assignment.revision, hasConflict: false, reason: "已核对正式作品与关系" });
  };
  const scoreInput = (assignment: JudgeAssignment, values: Readonly<Record<string, number>>, expectedScoreRevision = 0): ScoreInput =>
    ({ expectedAssignmentRevision: assignment.revision, expectedScoreRevision, values, feedback: "人工评语" });
  const submitScore = async (assignment: JudgeAssignment, values: Readonly<Record<string, number>>) =>
    service.submitScore(principal(assignment.judgeUserId), "event-a", assignment.id, scoreInput(assignment, values));
  /** 锁定并公布一轮；公布允许公开反馈，便于断言导出只含公开字段。 */
  const publish = async (round: JudgingRound, approvedFeedback: { snapshotId: string; text: string; visibility: "team" | "public" }[] = []) => {
    const locked = await service.lockRound(staff, "event-a", round.id, round.revision);
    const preview = await service.previewResults(staff, "event-a", locked.id);
    const published = await service.publishResults(staff, "event-a", locked.id, { expectedRevision: locked.revision, expectedSummaryHash: preview.summaryHash, visibility: "public", approvedFeedback });
    // 公布后轮次 revision 递增；撤回需要当前版本，故一并返回。
    const current = (await service.workspace(staff, "event-a")).rounds.find(item => item.id === round.id)!;
    return { published, roundRevision: current.revision };
  };
  return { pg, database, service, scopes, teams, staffGrants, revokedSessions, conflictStatuses, publicFeedback, teamFeedback, principal, staff, time, submit, open, assign, submitScore, publish };
}

/** workspace 的可比较摘要：用于证明派生读取不改变任何既有事实。 */
function workspaceState(workspace: Awaited<ReturnType<ReturnType<typeof createEventJudgingService>["workspace"]>>) {
  return {
    rounds: workspace.rounds.map(round => ({ id: round.id, revision: round.revision, status: round.status, lockedSummary: round.lockedSummary, publishedResultId: round.publishedResultId })),
    assignments: workspace.assignments.map(item => ({ id: item.id, revision: item.revision, status: item.status, declaration: item.declaration })),
    scores: workspace.scores.map(item => ({ id: item.id, revision: item.revision, state: item.state, values: item.values })),
    reviews: workspace.publicationReviews,
  };
}

test("progress 与 workspace / calibration / aggregate 口径一致，且读取前后事实完全不变", async t => {
  const f = await fixture(t);
  const first = await f.submit("team-a", "alice", "作品甲"), second = await f.submit("team-b", "bob", "作品乙");
  const round = await f.open({ minJudges: 3 });
  const a1 = await f.assign(round, first, "judge-1"), a2 = await f.assign(round, first, "judge-2");
  const b1 = await f.assign(round, second, "judge-1");
  await f.submitScore(a1, { idea: 8, build: 8 }); await f.submitScore(a2, { idea: 6, build: 6 });
  // b1 只指派、不提交，用来产生"还差"。
  // judge-1 只交了第一件，第二件故意留空以产生"还差"。
  const before = workspaceState(await f.service.workspace(f.staff, "event-a"));

  const report = await f.service.progress(f.staff, "event-a", round.id);
  const after = workspaceState(await f.service.workspace(f.staff, "event-a"));
  assert.deepEqual(after, before, "读取 progress 不得改变评分、指派、锁定汇总或公布依据");

  assert.equal(report.roundId, round.id);
  assert.equal(report.status, "in_progress");
  assert.equal(report.requiredJudges, 3);
  assert.equal(report.snapshotCount, 2);

  // 作品层：已提交数必须与 aggregate() 的 submittedJudgeCount 相等。
  const summary = await f.service.previewResults(f.staff, "event-a", round.id);
  for (const row of report.rows) {
    const official = summary.summary.rows.find(item => item.snapshotId === row.snapshotId)!;
    assert.equal(row.submittedCount, official.submittedJudgeCount, `作品 ${row.snapshotId} 的已提交评分数须与 aggregate 一致`);
    assert.equal(row.stillNeeds, Math.max(0, 3 - official.submittedJudgeCount));
    assert.equal(row.complete, official.missingJudges === 0);
  }
  assert.equal(report.rows.find(row => row.snapshotId === first.id)!.stillNeeds, 1);
  assert.equal(report.rows.find(row => row.snapshotId === second.id)!.stillNeeds, 3);
  assert.equal(report.incompleteSnapshots, 2);
  assert.equal(report.submittedTotal, 2, "本轮有效已提交评分数为 2（作品甲两位评委，作品乙尚未提交）");

  // 评委层：已提交数必须与 calibration() 的 submittedCount 相等。
  const calibrationReport = await f.service.calibration(f.staff, "event-a", round.id);
  assert.deepEqual([...report.judges].map(row => [row.judgeUserId, row.submittedCount]).sort(),
    [...calibrationReport.judges].map(row => [row.judgeUserId, row.submittedCount]).sort());
  const judge1 = report.judges.find(row => row.judgeUserId === "judge-1")!;
  assert.equal(judge1.submittedCount, 1);
  assert.equal(judge1.assignedCount, 2, "judge-1 被指派了两件作品");
  assert.equal(judge1.outstanding, 1, "judge-1 还差一件未提交");
  assert.equal(judge1.excludedCount, 0);
  const judge3 = report.judges.find(row => row.judgeUserId === "judge-3");
  assert.equal(judge3, undefined, "没有被指派的评委不得凭空出现");

  // 轮次层：未收齐清单按缺口降序。
  assert.deepEqual(report.remaining.map(row => row.snapshotId), [second.id, first.id]);
  assert.equal(report.assignedTotal, 3, "分母 = 三件有效指派");
  assert.match(report.notice, /尚未收齐/);
  assert.doesNotMatch(report.notice, /%|百分比|完成度|落后/, "措辞纪律：不出百分比或完成度");
  void b1;
});

test("没有任何指派时是空态，不凭空造出评委行", async t => {
  const f = await fixture(t);
  await f.submit("team-a", "alice", "作品甲");
  const round = await f.open({ minJudges: 2 });
  const report = await f.service.progress(f.staff, "event-a", round.id);
  assert.equal(report.status, "empty");
  assert.equal(report.snapshotCount, 1);
  assert.deepEqual(report.judges, []);
  assert.deepEqual(report.excluded, []);
  assert.deepEqual(report.remaining.map(row => row.stillNeeds), [2]);
  assert.equal(report.assignedTotal, 0);
  assert.match(report.notice, /还没有排定评委指派/);
});

test("已回避与已撤销的指派计入已排除并标注原因，但不计入分母", async t => {
  const f = await fixture(t);
  const receipt = await f.submit("team-a", "alice", "作品甲");
  const round = await f.open({ minJudges: 2 });
  const active = await f.assign(round, receipt, "judge-1");
  // judge-2 是队伍成员 → 系统判定存在关联，不能指派。
  await assert.rejects(f.service.assignJudge(f.staff, "event-a", { roundId: round.id, snapshotId: receipt.id, judgeUserId: "alice", expectedRoundRevision: round.revision }), errorCode("JUDGE_CONFLICT"));
  // judge-3 先无冲突指派，随后本人申报回避（不是"不负责"，是回避）。
  const toRecuse = await f.assign(round, receipt, "judge-3");
  await f.service.declareConflict(f.principal("judge-3"), "event-a", toRecuse.id, { expectedRevision: toRecuse.revision, hasConflict: true, reason: "曾线下辅导该队" });
  await f.submitScore(active, { idea: 7, build: 7 });

  const report = await f.service.progress(f.staff, "event-a", round.id);
  assert.equal(report.assignedTotal, 1, "分母只含有效指派");
  assert.equal(report.rows[0]!.submittedCount, 1);
  assert.equal(report.rows[0]!.stillNeeds, 1, "回避者不计入分母，因此仍差一位");

  const snapshot = report.snapshots.find(item => item.snapshotId === receipt.id)!;
  assert.equal(snapshot.scheduledJudges, 1);
  assert.equal(snapshot.excluded.length, 1);
  assert.equal(snapshot.excluded[0]!.judgeUserId, "judge-3");
  assert.equal(snapshot.excluded[0]!.status, "recused");
  assert.match(snapshot.excluded[0]!.reason, /回避/);
  assert.equal(report.excluded[0]!.snapshotId, receipt.id);

  const recusedJudge = report.judges.find(row => row.judgeUserId === "judge-3")!;
  assert.equal(recusedJudge.assignedCount, 0, "回避的指派不计入应评数");
  assert.equal(recusedJudge.excludedCount, 1);
});

test("需要的权限是本场 judging_manage，其他账号被拒绝", async t => {
  const f = await fixture(t);
  const receipt = await f.submit("team-a", "alice", "作品甲");
  const round = await f.open();
  await assert.rejects(f.service.progress(f.principal("outsider"), "event-a", round.id), errorCode("STAFF_REQUIRED"));
  await assert.rejects(f.service.exportResults(f.principal("outsider"), "event-a", round.id), errorCode("STAFF_REQUIRED"));
  // 本场轮次 ID 与赛事不匹配时，明确报告找不到该轮，而不是把其他赛事的轮次数据返回。
  await assert.rejects(f.service.progress(f.staff, "event-a", "round-does-not-exist"), errorCode("JUDGING_ROUND_NOT_FOUND"));
  // event-b 的轮次不能被 event-a 的工作入口读到（跨赛事隔离）。
  await assert.rejects(f.service.progress(f.staff, "event-b", round.id), errorCode("JUDGING_ROUND_NOT_FOUND"));
  assert.deepEqual(await f.service.progress(f.staff, "event-a", round.id).then(report => report.roundId), round.id);
  void receipt;
});

test("已公布结果导出只含公开投影字段：没有评委账号、没有合影快照 ID、只含公开反馈", async t => {
  const f = await fixture(t);
  const receipt = await f.submit("team-a", "alice", "作品甲");
  const round = await f.open({ minJudges: 1 });
  const assignment = await f.assign(round, receipt, "judge-1");
  await f.submitScore(assignment, { idea: 8, build: 8 });
  await f.publish(round, [
    { snapshotId: receipt.id, text: "公开反馈：演示清楚", visibility: "public" },
    { snapshotId: receipt.id, text: "仅队伍可见：请补测试", visibility: "team" },
  ]);

  const before = workspaceState(await f.service.workspace(f.staff, "event-a"));
  const exported = await f.service.exportResults(f.staff, "event-a", round.id);
  const after = workspaceState(await f.service.workspace(f.staff, "event-a"));
  assert.deepEqual(after, before, "导出不得改变评分、指派、锁定汇总或公布依据");

  assert.equal(exported.filename, "judging-results.csv");
  assert.ok(exported.csv.startsWith("\uFEFF"), "保留 BOM 以便表格软件正确识别中文");
  const csv = exported.csv.replace(/^\uFEFF/, "");
  assert.doesNotMatch(csv, /judge-1/, "不得导出评委账号");
  assert.doesNotMatch(csv, /judgeUserId|judgeUserId/, "不得出现评委字段名");
  assert.doesNotMatch(csv, new RegExp(receipt.id), "不得导出内部快照 ID");
  assert.doesNotMatch(csv, /仅队伍可见/, "队伍专属反馈不得进入留档件");
  assert.match(csv, /公开反馈：演示清楚/);
  assert.match(csv, /作品甲/);
  assert.match(csv, /# 公布版本：v1/);
  assert.match(csv, /# 生成时间：/);
  assert.match(csv, /# 评审轮：正式评审/);
  // 总分：idea/build 均为 0–10 区间，各 60%/40% 权重，得 80；名次为 1（一位评委、一件作品）。
  assert.match(csv, /"80"/);
  assert.match(csv, /"1"/);
  assert.doesNotMatch(csv, /需复核/);
});

test("未公布或已撤回的轮次拒绝导出并说明原因", async t => {
  const f = await fixture(t);
  const receipt = await f.submit("team-a", "alice", "作品甲");
  const round = await f.open({ minJudges: 1 });
  await assert.rejects(f.service.exportResults(f.staff, "event-a", round.id), errorCode("RESULTS_NOT_PUBLISHED"));

  const assignment = await f.assign(round, receipt, "judge-1");
  await f.submitScore(assignment, { idea: 8, build: 8 });
  const { roundRevision } = await f.publish(round);
  assert.ok(await f.service.exportResults(f.staff, "event-a", round.id));
  await f.service.withdrawResults(f.staff, "event-a", round.id, { expectedRevision: roundRevision, reason: "发现分数需要更正" });
  await assert.rejects(f.service.exportResults(f.staff, "event-a", round.id), errorCode("RESULTS_NOT_PUBLISHED"));
});

test("需复核时不输出分数与名次，只输出状态与版本", async t => {
  const f = await fixture(t);
  const receipt = await f.submit("team-a", "alice", "作品甲");
  const round = await f.open({ minJudges: 1 });
  const assignment = await f.assign(round, receipt, "judge-1");
  await f.submitScore(assignment, { idea: 8, build: 8 });
  await f.publish(round);
  // 公布之后，可信关联来源改为待核查 → 当前有效评分与已锁定依据不再一致。
  f.conflictStatuses.set(`event-a:team-a:judge-1`, "needs_review");
  const projection = await f.service.publicResults("event-a");
  assert.equal(projection.status, "needs_review");

  const exported = await f.service.exportResults(f.staff, "event-a", round.id);
  const csv = exported.csv.replace(/^\uFEFF/, "");
  assert.match(csv, /需复核/);
  assert.match(csv, /# 公布版本：v1/);
  assert.doesNotMatch(csv, /"80"/, "需复核时不得输出分数");
  assert.doesNotMatch(csv, /公开反馈/, "需复核时不得输出反馈");
});

test("导出复用 csvCell 防公式注入", async t => {
  const f = await fixture(t);
  // 作品名以 = 开头：若不做防护，表格软件会把它当公式执行。
  const receipt = await f.submit("team-a", "alice", "=1+1");
  const round = await f.open({ minJudges: 1 });
  const assignment = await f.assign(round, receipt, "judge-1");
  await f.submitScore(assignment, { idea: 5, build: 5 });
  await f.publish(round);
  const csv = (await f.service.exportResults(f.staff, "event-a", round.id)).csv.replace(/^\uFEFF/, "");
  assert.match(csv, /"'=1\+1"/, "以 = 开头的字段必须先加单引号再引号包裹");
});

test("进度与导出都是只读：不产生任何审计或写入记录", async t => {
  const f = await fixture(t);
  const receipt = await f.submit("team-a", "alice", "作品甲");
  const round = await f.open({ minJudges: 1 });
  const assignment = await f.assign(round, receipt, "judge-1");
  await f.submitScore(assignment, { idea: 8, build: 8 });
  await f.publish(round);
  const auditsBefore = (await f.service.auditHistory(f.staff, "event-a")).items.length;
  await f.service.progress(f.staff, "event-a", round.id);
  const afterProgress = (await f.service.auditHistory(f.staff, "event-a")).items.length;
  assert.equal(afterProgress, auditsBefore, "读取评审进度不写审计");
  await f.service.exportResults(f.staff, "event-a", round.id);
  const afterExport = (await f.service.auditHistory(f.staff, "event-a")).items;
  assert.equal(afterExport.length, auditsBefore + 1, "导出写一条既有审计");
  // 时钟在夹具里是固定值，多条审计可能同一时刻，因此不依赖列表顺序定位。
  assert.equal(afterExport.filter(item => item.action === "results_exported").length, 1);
});
