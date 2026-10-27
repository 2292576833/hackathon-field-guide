import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type {
  EventParticipationPort, EventRosterTeamSnapshot, HostedEventAccessPort, HostedEventScope, OrganizerPrincipal,
} from "../../shared/organizer-contracts.ts";
import { createEventClosureService } from "./service.ts";
import type { ClosureIntakeReceipt, ClosurePublishedResult, ClosureReuseSource, EventClosureSourcePort } from "./model.ts";

const currentTime = "2026-10-16T08:00:00.000Z";
const userIds = ["alice", "member", "late", "bob", "carol", "staff", "outsider"];
const errorCode = (code: string) => (error: unknown): boolean => error instanceof DomainError && error.code === code;

function scope(eventId: string, organizationId: string, status: HostedEventScope["status"] = "published"): HostedEventScope {
  return {
    eventId, organizationId, organizationName: `机构${organizationId}`, title: `赛事${eventId}`, status, revision: 1, publishedRevision: 1,
    timezone: "Asia/Shanghai", startsAt: "2026-10-10T00:00:00.000Z", endsAt: "2026-10-15T00:00:00.000Z",
    registrationOpensAt: null, registrationClosesAt: null, submissionClosesAt: "2026-10-14T00:00:00.000Z",
    modules: { registration: true, teams: true, judging: true, schedule: false, accommodation: false, mealVouchers: false, icebreaking: false },
    registration: { reviewRequired: false, capacity: null }, teams: { mode: "free", minSize: 1, maxSize: 4, locksAt: currentTime }, linkedEventId: null,
  };
}

const receipts: ClosureIntakeReceipt[] = [
  { id: "receipt-a1", teamId: "team-a", version: 1, receiptNumber: "REC-A1", ruleVersion: 1, eventRevision: 1, submittedAt: "2026-10-13T00:00:00.000Z", memberUserIds: ["alice", "member"] },
  { id: "receipt-a2", teamId: "team-a", version: 2, receiptNumber: "REC-A2", ruleVersion: 1, eventRevision: 1, submittedAt: "2026-10-14T00:00:00.000Z", memberUserIds: ["alice", "member"] },
  { id: "receipt-two", teamId: "team-two", version: 1, receiptNumber: "REC-TWO", ruleVersion: 1, eventRevision: 1, submittedAt: "2026-10-13T00:00:00.000Z", memberUserIds: ["bob"] },
];
const published: ClosurePublishedResult[] = [
  { id: "published-1", roundId: "round-1", roundTitle: "决赛", version: 1, visibility: "public", publishedAt: "2026-10-15T12:00:00.000Z", reviewRequired: false,
    rows: [{ teamId: "team-a", title: "作品甲", total: 80, rank: 1, approvedFeedbackCount: 1 }] },
];
const reuse: ClosureReuseSource[] = [
  { id: "form", kind: "registration_form", label: "报名表单字段", detail: "已发布的报名表", href: "/organizer/events/event-a/registration-form", state: "published" },
  { id: "draft", kind: "notification_template", label: "通知模板草稿", detail: "未批准", href: "/x", state: "draft" },
];

/** 每个用例一个隔离的内存 PGlite；不打开应用目录、不加载 .env。 */
async function fixture(t: TestContext, options: { retrospectives?: boolean; withReuse?: boolean } = {}) {
  const pg = new PGlite(); t.after(() => pg.close()); await pg.waitReady;
  await pg.exec(`CREATE TABLE auth_users(id text PRIMARY KEY);
    CREATE TABLE organizer_hosted_events(id text PRIMARY KEY, organization_id text NOT NULL, UNIQUE(id, organization_id));
    CREATE TABLE event_registration_teams(event_id text NOT NULL, id text NOT NULL, PRIMARY KEY(event_id, id));`);
  for (const userId of userIds) await pg.query("INSERT INTO auth_users(id) VALUES($1)", [userId]);
  await pg.exec(await readFile(new URL("./migrations/001-event-closure.sql", import.meta.url), "utf8"));
  for (const [eventId, org] of [["event-a", "org-a"], ["event-b", "org-b"], ["event-archived", "org-a"]] as const) {
    await pg.query("INSERT INTO organizer_hosted_events(id, organization_id) VALUES($1,$2)", [eventId, org]);
  }
  for (const [eventId, teamId] of [["event-a", "team-a"], ["event-a", "team-two"], ["event-a", "team-three"], ["event-b", "team-b"]] as const) {
    await pg.query("INSERT INTO event_registration_teams(event_id, id) VALUES($1,$2)", [eventId, teamId]);
  }

  function executor(query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>): SqlExecutor {
    return { async query<Row>(statement: string, params: readonly unknown[] = []) {
      const result = await query(statement, [...params]);
      return { rows: result.rows as Row[], rowCount: result.affectedRows ?? result.rows.length };
    } };
  }
  const database: DatabasePort = { ...executor((sql, params) => pg.query(sql, params)), transaction: work => pg.transaction(tx => work(executor((sql, params) => tx.query(sql, params)))) };

  const scopes = new Map<string, HostedEventScope>([
    ["event-a", scope("event-a", "org-a")], ["event-b", scope("event-b", "org-b")], ["event-archived", scope("event-archived", "org-a", "archived")],
  ]);
  const teams = new Map<string, EventRosterTeamSnapshot>([
    ["event-a:team-a", { id: "team-a", eventId: "event-a", organizationId: "org-a", captainUserId: "alice", memberUserIds: ["alice", "member", "late"], revision: 1, status: "locked", eligible: true, projectId: "project-a" }],
    ["event-a:team-two", { id: "team-two", eventId: "event-a", organizationId: "org-a", captainUserId: "bob", memberUserIds: ["bob"], revision: 1, status: "locked", eligible: true, projectId: null }],
    ["event-a:team-three", { id: "team-three", eventId: "event-a", organizationId: "org-a", captainUserId: "carol", memberUserIds: ["carol"], revision: 1, status: "locked", eligible: true, projectId: null }],
    ["event-b:team-b", { id: "team-b", eventId: "event-b", organizationId: "org-b", captainUserId: "bob", memberUserIds: ["bob"], revision: 1, status: "locked", eligible: true, projectId: null }],
  ]);
  const staffGrants = new Set(["event-a:staff", "event-archived:staff"]);
  const revoked = new Set<string>();
  const principal = (userId: string, platformRoles: Actor["platformRoles"] = ["user"]): OrganizerPrincipal => ({
    actor: { userId, platformRoles },
    guard: async (sql: SqlExecutor) => { const row = await sql.query("SELECT id FROM auth_users WHERE id=$1", [userId]); if (!row.rows.length || revoked.has(userId)) throw new DomainError("SESSION_REVOKED", "会话已撤销。", { status: 401 }); },
  });
  const events: HostedEventAccessPort = {
    async getEvent(_sql, eventId) { return scopes.get(eventId) ?? null; },
    async requireStaff(_sql, actor, eventId) {
      if (!staffGrants.has(`${eventId}:${actor.userId}`)) throw new DomainError("STAFF_REQUIRED", "没有这场比赛的评审管理权限。", { status: 403 });
      return scopes.get(eventId)!;
    },
  };
  const participation: EventParticipationPort = {
    async getTeam(_sql, eventId, teamId) { return teams.get(`${eventId}:${teamId}`) ?? null; },
    async getRegistration() { return null; },
  };
  const sourceCalls: { intake: number; published: number; reuse: number; retrospectives: string[] } = { intake: 0, published: 0, reuse: 0, retrospectives: [] };
  const source: EventClosureSourcePort = {
    async intakeReceipts(_sql, eventId) { sourceCalls.intake += 1; return eventId === "event-a" ? receipts : eventId === "event-b" ? receipts.filter(item => item.teamId === "team-b") : []; },
    async publishedResults(_sql, eventId) { sourceCalls.published += 1; return eventId === "event-a" ? published : []; },
    async reuseSources(_sql, eventId) { sourceCalls.reuse += 1; return eventId === "event-a" && options.withReuse !== false ? reuse : []; },
    ...(options.retrospectives === false ? {} : {
      async confirmedRetrospectiveCounts(_sql, _eventId, projectIds: readonly string[]) { sourceCalls.retrospectives.push(...projectIds); return projectIds.map(projectId => ({ projectId, confirmedCount: projectId === "project-a" ? 2 : 0 })); },
    }),
  };
  let nextId = 0, nextKey = 0;
  const time = { value: currentTime };
  const service = createEventClosureService({ database, clock: { now: () => new Date(time.value) }, ids: { next: () => `ecl-${++nextId}` }, events, participation, source });
  const key = () => `retry-${++nextKey}`;
  const staff = principal("staff", ["admin"]);
  const submit = (teamId: string, willing: boolean, userId = "alice", eventId = "event-a") => service.submitContactWillingness(principal(userId), eventId, { teamId, willing, idempotencyKey: key() });
  return { pg, database, service, scopes, teams, principal, staff, sourceCalls, time, submit, key };
}

test("只有当前队伍成员且同时出现在正式收件名单里的人可以提交，队长不能代其他队伍选择", async t => {
  const f = await fixture(t);
  const record = await f.service.submitContactWillingness(f.principal("alice"), "event-a", { teamId: "team-a", willing: true, idempotencyKey: f.key() });
  assert.equal(record.teamId, "team-a"); assert.equal(record.willing, true); assert.equal(record.authorUserId, "alice"); assert.equal(record.status, "active");
  // 外部账号不认识这支队伍。
  await assert.rejects(f.service.submitContactWillingness(f.principal("outsider"), "event-a", { teamId: "team-a", willing: true, idempotencyKey: f.key() }), errorCode("CLOSURE_TEAM_ACCESS_DENIED"));
  // 其他队伍的成员不能替 team-a 选择。
  await assert.rejects(f.service.submitContactWillingness(f.principal("bob"), "event-a", { teamId: "team-a", willing: true, idempotencyKey: f.key() }), errorCode("CLOSURE_TEAM_ACCESS_DENIED"));
  // 当前成员但不在正式收件成员快照里（后来才入队）不能提交。
  await assert.rejects(f.service.submitContactWillingness(f.principal("late"), "event-a", { teamId: "team-a", willing: true, idempotencyKey: f.key() }), errorCode("CLOSURE_TEAM_ACCESS_DENIED"));
  // 没有正式收件的队伍不能选择。
  await assert.rejects(f.service.submitContactWillingness(f.principal("carol"), "event-a", { teamId: "team-three", willing: true, idempotencyKey: f.key() }), errorCode("CLOSURE_TEAM_NOT_PARTICIPATED"));
});

test("同一重试标识幂等：同输入重放返回原记录，同键不同输入被拒绝", async t => {
  const f = await fixture(t);
  const input = { teamId: "team-a", willing: true, idempotencyKey: "fixed-key" };
  const first = await f.service.submitContactWillingness(f.principal("alice"), "event-a", input);
  assert.deepEqual(await f.service.submitContactWillingness(f.principal("alice"), "event-a", input), first);
  await assert.rejects(f.service.submitContactWillingness(f.principal("alice"), "event-a", { ...input, willing: false }), errorCode("CLOSURE_IDEMPOTENCY_KEY_REUSED"));
  await assert.rejects(f.service.submitContactWillingness(f.principal("member"), "event-a", { ...input, teamId: "team-two" }), errorCode("CLOSURE_TEAM_ACCESS_DENIED"));
});

test("一队一条有效记录：再次提交被拒，撤回后可以重提且历史保留", async t => {
  const f = await fixture(t);
  const first = await f.submit("team-a", true);
  await assert.rejects(f.submit("team-a", false), errorCode("CLOSURE_ALREADY_SET"));
  const withdrawn = await f.service.withdrawContactWillingness(f.principal("alice"), "event-a", first.id, { expectedRevision: first.revision });
  assert.equal(withdrawn.status, "withdrawn"); assert.equal(withdrawn.revision, 2); assert.equal(withdrawn.willing, true, "撤回不得改写原始选择");
  await assert.rejects(f.service.withdrawContactWillingness(f.principal("alice"), "event-a", first.id, { expectedRevision: 2 }), errorCode("CLOSURE_STATE_INVALID"));
  const second = await f.submit("team-a", false);
  assert.notEqual(second.id, first.id); assert.equal(second.willing, false);
  const view = await f.service.myContactWillingness(f.principal("member"), "event-a", "team-a");
  assert.equal(view.active?.id, second.id);
  assert.deepEqual(view.history.map(item => item.id), [second.id, first.id], "历史保留，含已撤回那条");
  const rows = await f.pg.query<{ count: string }>("SELECT count(*)::text AS count FROM ecl_contact_willingness");
  assert.equal(rows.rows[0]!.count, "2");
});

test("只有提交人本人可以撤回，版本不符拒绝", async t => {
  const f = await fixture(t);
  const record = await f.submit("team-a", true);
  await assert.rejects(f.service.withdrawContactWillingness(f.principal("member"), "event-a", record.id, { expectedRevision: 1 }), errorCode("CLOSURE_ACCESS_DENIED"));
  await assert.rejects(f.service.withdrawContactWillingness(f.principal("alice"), "event-a", record.id, { expectedRevision: 9 }), errorCode("CLOSURE_VERSION_CONFLICT"));
  await assert.rejects(f.service.withdrawContactWillingness(f.principal("alice"), "event-a", "missing-id", { expectedRevision: 1 }), errorCode("CLOSURE_NOT_FOUND"));
});

test("默认不公开：未选择、选择不愿意、撤回后，主办方侧都看不到", async t => {
  const f = await fixture(t);
  assert.equal((await f.service.eventContactWillingness(f.staff, "event-a")).visibleCount, 0);
  const declined = await f.submit("team-a", false);
  assert.equal((await f.service.eventContactWillingness(f.staff, "event-a")).visibleCount, 0, "选择不愿意不进入主办方视图");
  await f.service.withdrawContactWillingness(f.principal("alice"), "event-a", declined.id, { expectedRevision: declined.revision });
  assert.equal((await f.service.eventContactWillingness(f.staff, "event-a")).visibleCount, 0, "撤回后不再显示");
  const willing = await f.submit("team-a", true);
  const visible = await f.service.eventContactWillingness(f.staff, "event-a");
  assert.deepEqual(visible.items, [{ teamId: "team-a", chosenAt: willing.submittedAt }]);
  assert.equal((visible.items[0] as unknown as Record<string, unknown>).authorUserId, undefined, "不得暴露提交人账号");
});

test("提交联系意愿不改变任何既有事实，公布版本与赛事状态逐一保持", async t => {
  const f = await fixture(t);
  const before = await f.service.postEventSummary(f.staff, "event-a");
  await f.submit("team-a", true);
  const after = await f.service.postEventSummary(f.staff, "event-a");
  assert.deepEqual(after.outcomes, before.outcomes, "成果清单与既有事实完全一致");
  assert.deepEqual(after.reuse, before.reuse);
  assert.deepEqual(after.existingQueues, before.existingQueues);
  assert.equal(after.contactWillingness.length, before.contactWillingness.length + 1, "唯一变化是联系意愿");
  assert.deepEqual(after.event, before.event);
});

test("赛后闭环只读：非工作人员被拒，归档赛事仍可读但不能再写", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.postEventSummary(f.principal("outsider"), "event-a"), errorCode("STAFF_REQUIRED"));
  await assert.rejects(f.service.eventContactWillingness(f.principal("outsider"), "event-a"), errorCode("STAFF_REQUIRED"));
  const archived = await f.service.postEventSummary(f.staff, "event-archived");
  assert.equal(archived.event.status, "archived");
  await assert.rejects(f.service.submitContactWillingness(f.principal("bob"), "event-archived", { teamId: "team-b", willing: true, idempotencyKey: f.key() }), errorCode("CLOSURE_EVENT_READ_ONLY"));
});

test("队伍侧只看本队：其他队伍的记录、历史与选择都不出现", async t => {
  const f = await fixture(t);
  const a = await f.submit("team-a", true, "alice");
  const two = await f.submit("team-two", true, "bob");
  const viewA = await f.service.myContactWillingness(f.principal("member"), "event-a", "team-a");
  assert.equal(viewA.active?.id, a.id);
  assert.deepEqual(viewA.history.map(item => item.id), [a.id]);
  assert.ok(!JSON.stringify(viewA).includes(two.id), "不得出现其他队伍记录 id");
  const viewTwo = await f.service.myContactWillingness(f.principal("bob"), "event-a", "team-two");
  assert.deepEqual(viewTwo.history.map(item => item.id), [two.id]);
  await assert.rejects(f.service.myContactWillingness(f.principal("bob"), "event-a", "team-a"), errorCode("CLOSURE_TEAM_ACCESS_DENIED"));
});

test("赛后闭环汇总复用既有事实；未接入复盘读取时显示未读取而不是 0", async t => {
  const withRetro = await fixture(t);
  const summary = await withRetro.service.postEventSummary(withRetro.staff, "event-a");
  assert.equal(summary.outcomes.intake.count, 3);
  assert.equal(summary.outcomes.retrospectives.state, "read");
  assert.equal(summary.outcomes.retrospectives.confirmedCount, 2);
  assert.deepEqual(withRetro.sourceCalls.retrospectives, ["project-a"], "同一项目去重后只统计一次");
  assert.deepEqual(summary.reuse.map(item => item.id), ["form"], "草稿复用来源被丢弃");
  await assert.rejects(withRetro.service.postEventSummary(withRetro.staff, "event-b"), errorCode("STAFF_REQUIRED"));

  const withoutM07 = await fixture(t, { retrospectives: false });
  const unread = await withoutM07.service.postEventSummary(withoutM07.staff, "event-a");
  assert.equal(unread.outcomes.retrospectives.state, "unread");
  assert.equal(unread.outcomes.retrospectives.confirmedCount, null, "未接入不显示 0");
});

test("非工作人员不能读队伍侧视图，且队伍侧视图不需要评审管理权限也能被成员读取", async t => {
  const f = await fixture(t);
  await f.submit("team-a", true, "alice", "event-a");
  const view = await f.service.myContactWillingness(f.principal("member"), "event-a", "team-a");
  assert.equal(view.teamId, "team-a");
  const eligibility = await f.service.myWillingnessEligibility(f.principal("alice"), "event-a", "team-a");
  assert.equal(eligibility.eligible, true);
  assert.ok(eligibility.active);
  assert.match(eligibility.reason ?? "", /撤回/);
});
