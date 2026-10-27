import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { HostedEventScope, EventRegistrationSnapshot, OrganizerPrincipal, EventStaffCapability } from "../../shared/organizer-contracts.ts";
import { createEventScheduleService } from "./schedule.ts";
import type { SaveScheduleDraftInput, ScheduleItemInput } from "./schedule-model.ts";

const at = "2026-10-11T01:00:00.000Z";
const hasCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
const allItem = (title = "集合", extra: Partial<ScheduleItemInput> = {}): ScheduleItemInput => ({
  title, startsAt: "2026-10-12T09:00:00+08:00", endsAt: "2026-10-12T10:00:00+08:00", location: "主会场",
  audience: "all", userIds: [], ...extra,
});
const schedule = (expectedRevision = 0, items: readonly ScheduleItemInput[] = [allItem()], impact = ""): SaveScheduleDraftInput => ({ expectedRevision, timezone: "Asia/Shanghai", items, impact });

async function fixture(t: TestContext) {
  // No dataDir, no auth/env loader and no server application import: isolated SQL only.
  const engine = new PGlite(); await engine.waitReady; t.after(() => engine.close());
  await engine.exec("CREATE TABLE auth_users(id text PRIMARY KEY)");
  for (const userId of ["alice", "bob", "carol", "staff-a", "staff-b", "staff-c", "root-admin"]) await engine.query("INSERT INTO auth_users(id) VALUES($1)", [userId]);
  await engine.exec(await readFile(new URL("./migrations/003_schedule.sql", import.meta.url), "utf8"));
  const makeEvent = (eventId: string, organizationId: string): HostedEventScope => ({
    eventId, organizationId, organizationName: organizationId, title: eventId, status: "published", revision: 1, publishedRevision: 1,
    timezone: "Asia/Shanghai", startsAt: "2026-10-12T01:00:00.000Z", endsAt: "2026-10-14T01:00:00.000Z",
    registrationOpensAt: null, registrationClosesAt: null, submissionClosesAt: null,
    modules: { registration: true, teams: true, icebreaking: true, judging: true, schedule: true, accommodation: true, mealVouchers: true },
    registration: { reviewRequired: false, capacity: null }, teams: { mode: "free", minSize: 1, maxSize: 5, locksAt: null }, linkedEventId: null,
  });
  const events = new Map([ ["a", makeEvent("a", "org-a")], ["b", makeEvent("b", "org-a")], ["c", makeEvent("c", "org-b")] ]);
  const grants = new Map<string, EventStaffCapability[]>([
    ["a:staff-a", ["schedule_manage", "logistics_manage"]], ["b:staff-b", ["schedule_manage", "logistics_manage"]],
    ["c:staff-c", ["schedule_manage", "logistics_manage"]],
  ]);
  const registrations = new Map<string, EventRegistrationSnapshot>();
  for (const eventId of events.keys()) for (const userId of ["alice", "bob", "carol"]) registrations.set(`${eventId}:${userId}`, { id: `registration-${eventId}-${userId}`, eventId, userId, status: "approved", revision: 1 });
  let now = new Date(at), sequence = 0, activeSql: SqlExecutor | null = null;
  const trace: string[] = [];
  const hooks: {
    afterQuery?: (statement: string) => void;
    registration?: (eventId: string, userId: string) => void;
    staff?: (eventId: string, userId: string, capability: EventStaffCapability) => void;
  } = {};
  const wrap = (query: (statement: string, values: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>): SqlExecutor => ({
    async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      trace.push(statement); const result = await query(statement, [...parameters]); hooks.afterQuery?.(statement);
      return { rows: result.rows as Row[], rowCount: result.affectedRows ?? result.rows.length };
    },
  });
  const direct = wrap((statement, parameters) => engine.query(statement, parameters));
  const database: DatabasePort = {
    query: direct.query,
    transaction: work => engine.transaction(async tx => {
      const sql = wrap((statement, parameters) => tx.query(statement, parameters)); activeSql = sql;
      try { return await work(sql); } finally { activeSql = null; }
    }),
  };
  const principal = (userId: string, failAt = 0): OrganizerPrincipal => {
    let guardCount = 0;
    return { actor: { userId, platformRoles: userId === "root-admin" ? ["admin"] : ["user"] }, guard: async sql => {
      assert.equal(sql, activeSql, "guard uses the exact transaction executor"); trace.push("guard");
      if (++guardCount === failAt) throw new DomainError("SESSION_REVOKED", "会话失效。", { status: 401 });
    } };
  };
  const service = createEventScheduleService({ database, clock: { now: () => now }, ids: { next: () => `ec-test-${++sequence}` },
    eventAccess: {
      async getEvent(sql, eventId) { assert.equal(sql, activeSql); trace.push("getEvent"); return events.get(eventId) ?? null; },
      async requireStaff(sql, actor: Actor, eventId, capability) {
        assert.equal(sql, activeSql); trace.push("requireStaff"); hooks.staff?.(eventId, actor.userId, capability);
        if (!grants.get(`${eventId}:${actor.userId}`)?.includes(capability)) throw new DomainError("STAFF_REQUIRED", "无当前权限。", { status: 403 });
        return events.get(eventId)!;
      },
    },
    participation: {
      async getRegistration(sql, eventId, userId) { assert.equal(sql, activeSql); trace.push("getRegistration"); hooks.registration?.(eventId, userId); return registrations.get(`${eventId}:${userId}`) ?? null; },
      async getTeam() { return null; },
    },
  });
  const updateEvent = (eventId: string, patch: Partial<HostedEventScope>) => events.set(eventId, { ...events.get(eventId)!, ...patch });
  const registrationStatus = (eventId: string, userId: string, status: EventRegistrationSnapshot["status"]) => registrations.set(`${eventId}:${userId}`, { ...registrations.get(`${eventId}:${userId}`)!, status });
  return { engine, database, service, principal, events, grants, registrations, trace, hooks, updateEvent, registrationStatus, setNow: (value: string) => { now = new Date(value); } };
}

test("schedule: explicit draft/publication boundary, audience filtering, immutable history and stale draft conflicts", async t => {
  const f = await fixture(t), staff = f.principal("staff-a");
  const initial = await f.service.getScheduleDraft(staff, "a"); assert.equal(initial.revision, 0);
  assert.equal((await f.engine.query("SELECT * FROM ec_schedule_state")).rows.length, 0, "GET doesn't create a draft");
  const first = await f.service.saveScheduleDraft(staff, "a", schedule(0, [allItem(), allItem("选手报到", { audience: "participants" }), allItem("Alice 辅导", { audience: "users", userIds: ["alice"] })]));
  assert.equal(first.revision, 1); assert.equal((await f.service.getSchedule(null, "a")).items.length, 0);
  await f.service.publishSchedule(staff, "a", { expectedRevision: 1 });
  const publicView = await f.service.getSchedule(null, "a"); assert.equal(publicView.items.length, 1);
  assert.equal((await f.service.getSchedule(f.principal("alice"), "a")).items.length, 3);
  const bob = await f.service.getSchedule(f.principal("bob"), "a"); assert.equal(bob.items.length, 2);
  assert.ok(bob.items.every(item => !("userIds" in item))); assert.ok(!("organizationId" in publicView));
  assert.equal(publicView.items[0]!.startsAt, "2026-10-12T01:00:00.000Z");
  await assert.rejects(f.service.saveScheduleDraft(staff, "a", schedule(1)), hasCode("SCHEDULE_INVALID"));
  const second = await f.service.saveScheduleDraft(staff, "a", schedule(1, [allItem("集合地点已更正")], "集合地点有变，请提前十分钟到场。"));
  assert.equal(second.revision, 2); assert.equal((await f.service.getSchedule(null, "a")).revision, 1);
  await assert.rejects(f.service.saveScheduleDraft(staff, "a", schedule(1, [allItem()], "过期修改")), hasCode("EVENT_SERVICE_REVISION_CONFLICT"));
  await f.service.publishSchedule(staff, "a", { expectedRevision: 2 });
  await f.service.publishSchedule(staff, "a", { expectedRevision: 2 });
  const history = await f.engine.query<{ document: { items: { title: string }[] } }>("SELECT document FROM ec_schedule_publications ORDER BY revision");
  assert.equal(history.rows.length, 2); assert.equal(history.rows[0]!.document.items[0]!.title, "集合");
  await assert.rejects(f.engine.query("UPDATE ec_schedule_publications SET document='{}'"), /immutable/);
  await assert.rejects(f.engine.query("DELETE FROM ec_schedule_publications"), /immutable/);
});

test("schedule: same organization different events and separate organizations cannot reuse staff grants or guessed previews", async t => {
  const f = await fixture(t);
  await f.service.saveScheduleDraft(f.principal("staff-a"), "a", schedule());
  for (const target of ["b", "c"]) {
    await assert.rejects(f.service.getScheduleDraft(f.principal("staff-a"), target), hasCode("STAFF_REQUIRED"));
    await assert.rejects(f.service.saveScheduleDraft(f.principal("staff-a"), target, schedule()), hasCode("STAFF_REQUIRED"));
  }
  await assert.rejects(f.service.getScheduleDraft(f.principal("root-admin"), "a"), hasCode("STAFF_REQUIRED"));
  const preview = await f.service.previewScheduleImport(f.principal("staff-a"), "a", { expectedRevision: 1,
    csv: "title,startsAt,endsAt,location,audience,userIds\n集合,2026-10-12T09:00:00+08:00,2026-10-12T10:00:00+08:00,会场,all," });
  await assert.rejects(f.service.confirmScheduleImport(f.principal("staff-b"), "b", { previewId: preview.previewId, expectedRevision: 1 }), hasCode("EVENT_SERVICE_NOT_FOUND"));
  await assert.rejects(f.service.confirmScheduleImport(f.principal("staff-c"), "c", { previewId: preview.previewId, expectedRevision: 1 }), hasCode("EVENT_SERVICE_NOT_FOUND"));
  assert.equal((await f.service.getScheduleDraft(f.principal("staff-b"), "b")).revision, 0);
});

test("schedule: CSV validation persists a preview, confirmation is actor-bound and never publishes", async t => {
  const f = await fixture(t), staff = f.principal("staff-a");
  const bad = await f.service.previewScheduleImport(staff, "a", { expectedRevision: 0,
    csv: "title,startsAt,endsAt,location,audience,userIds\n坏时间,2026-02-30T09:00:00+08:00,2026-02-30T10:00:00+08:00,会场,all,\n漏时区,2026-10-12T09:00:00,2026-10-12T10:00:00,会场,all," });
  assert.equal(bad.errors.length, 2);
  await assert.rejects(f.service.confirmScheduleImport(staff, "a", { previewId: bad.previewId, expectedRevision: 0 }), hasCode("SCHEDULE_IMPORT_INVALID"));
  const good = await f.service.previewScheduleImport(staff, "a", { expectedRevision: 0,
    csv: 'title,startsAt,endsAt,location,audience,userIds\n"集合,欢迎",2026-10-12T09:00:00+08:00,2026-10-12T10:00:00+08:00,"二楼\n大厅",all,' });
  assert.deepEqual(good.errors, []); assert.equal(good.items[0]!.title, "集合,欢迎"); assert.equal(good.items[0]!.location, "二楼\n大厅");
  f.grants.set("a:bob", ["schedule_manage"]);
  await assert.rejects(f.service.confirmScheduleImport(f.principal("bob"), "a", { previewId: good.previewId, expectedRevision: 0 }), hasCode("EVENT_SERVICE_NOT_FOUND"));
  const confirmed = await f.service.confirmScheduleImport(staff, "a", { previewId: good.previewId, expectedRevision: 0 });
  assert.equal(confirmed.revision, 1); assert.equal((await f.service.getSchedule(null, "a")).revision, null);
  await assert.rejects(f.service.confirmScheduleImport(staff, "a", { previewId: good.previewId, expectedRevision: 0 }), hasCode("SCHEDULE_PREVIEW_USED"));
  const expired = await f.service.previewScheduleImport(staff, "a", { expectedRevision: 1,
    csv: "title,startsAt,endsAt,location,audience,userIds\n集合,2026-10-12T09:00:00Z,2026-10-12T10:00:00Z,会场,all," });
  f.setNow("2026-10-11T01:30:00.000Z");
  await assert.rejects(f.service.confirmScheduleImport(staff, "a", { previewId: expired.previewId, expectedRevision: 1 }), hasCode("SCHEDULE_PREVIEW_EXPIRED"));
});

test("schedule: concurrent saves and import-after-edit check the current revision atomically", async t => {
  const f = await fixture(t), staff = f.principal("staff-a");
  const results = await Promise.allSettled([f.service.saveScheduleDraft(staff, "a", schedule()), f.service.saveScheduleDraft(staff, "a", schedule(0, [allItem("另一份输入")]))]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.code, "EVENT_SERVICE_REVISION_CONFLICT");
  const preview = await f.service.previewScheduleImport(staff, "a", { expectedRevision: 1,
    csv: "title,startsAt,endsAt,location,audience,userIds\n集合,2026-10-12T09:00:00Z,2026-10-12T10:00:00Z,会场,all," });
  await f.service.saveScheduleDraft(staff, "a", schedule(1));
  await assert.rejects(f.service.confirmScheduleImport(staff, "a", { previewId: preview.previewId, expectedRevision: 1 }), hasCode("EVENT_SERVICE_REVISION_CONFLICT"));
  assert.equal((await f.engine.query<{ confirmed_at: string | null }>("SELECT confirmed_at FROM ec_schedule_import_previews WHERE id=$1", [preview.previewId])).rows[0]!.confirmed_at, null);
});

test("schedule: late staff/session revocation rolls back writes and late withdrawal removes private projection", async t => {
  const f = await fixture(t);
  let checks = 0;
  f.hooks.staff = () => { if (++checks === 2) f.grants.delete("a:staff-a"); };
  await assert.rejects(f.service.saveScheduleDraft(f.principal("staff-a"), "a", schedule()), hasCode("STAFF_REQUIRED"));
  assert.equal((await f.engine.query("SELECT * FROM ec_schedule_state")).rows.length, 0);
  f.hooks.staff = undefined; f.grants.set("a:staff-a", ["schedule_manage", "logistics_manage"]);
  await assert.rejects(f.service.saveScheduleDraft(f.principal("staff-a", 2), "a", schedule()), hasCode("SESSION_REVOKED"));
  assert.equal((await f.engine.query("SELECT * FROM ec_schedule_state")).rows.length, 0);
  const staff = f.principal("staff-a");
  await f.service.saveScheduleDraft(staff, "a", schedule(0, [allItem(), allItem("个人辅导", { audience: "users", userIds: ["alice"] })]));
  await f.service.publishSchedule(staff, "a", { expectedRevision: 1 });
  let registrationChecks = 0;
  f.hooks.registration = (eventId, userId) => { if (userId === "alice" && ++registrationChecks === 2) f.registrationStatus(eventId, userId, "withdrawn"); };
  const view = await f.service.getSchedule(f.principal("alice"), "a"); assert.equal(view.items.length, 1);
  f.hooks.registration = undefined;
  f.trace.length = 0; await f.service.getScheduleDraft(staff, "a");
  assert.equal(f.trace[0], "guard"); assert.equal(f.trace.at(-1), "guard");
  assert.equal(f.trace.filter(item => item === "requireStaff").length, 2);
});

test("schedule: disabled modules retain published history while disabled/archived/draft operations are rejected", async t => {
  const f = await fixture(t), staff = f.principal("staff-a");
  await f.service.saveScheduleDraft(staff, "a", schedule()); await f.service.publishSchedule(staff, "a", { expectedRevision: 1 });
  f.updateEvent("a", { modules: { ...f.events.get("a")!.modules, schedule: false } });
  const history = await f.service.getSchedule(null, "a"); assert.equal(history.enabled, false); assert.equal(history.items.length, 1);
  await assert.rejects(f.service.saveScheduleDraft(staff, "a", schedule(1, [allItem()], "修改")), hasCode("EVENT_MODULE_DISABLED"));
  f.updateEvent("a", { status: "archived", modules: { ...f.events.get("a")!.modules, schedule: true } });
  await assert.rejects(f.service.publishSchedule(staff, "a", { expectedRevision: 1 }), hasCode("EVENT_ARCHIVED"));
  assert.equal((await f.service.getSchedule(null, "a")).revision, 1);
  f.updateEvent("a", { status: "draft" });
  await assert.rejects(f.service.getSchedule(null, "a"), hasCode("EVENT_SERVICE_NOT_FOUND"));
  assert.equal((await f.service.getScheduleDraft(staff, "a")).revision, 1);
});

test("icebreaking: voluntary choices, approved registration, manual groups, participant privacy and refusal correction history", async t => {
  const f = await fixture(t), staff = f.principal("staff-a"), alice = f.principal("alice"), bob = f.principal("bob");
  const activity = await f.service.createIcebreaker(staff, "a", { title: "欢迎认识队友", description: "自愿参加，暂不参加也能正常参赛。", startsAt: "2026-10-12T11:00:00+08:00", location: "休息区" });
  await assert.rejects(f.service.assignIcebreakerGroup(staff, "a", { activityId: activity.id, title: "第一组", userIds: ["alice"], expectedRevision: 1 }), hasCode("ICEBREAKER_OPT_IN_REQUIRED"));
  const join = await f.service.respondIcebreaker(alice, "a", { activityId: activity.id, choice: "join" }); assert.equal(join.revision, 2);
  assert.equal((await f.service.respondIcebreaker(alice, "a", { activityId: activity.id, choice: "join" })).revision, 2, "retry doesn't create extra choice versions");
  await f.service.respondIcebreaker(bob, "a", { activityId: activity.id, choice: "join" });
  const assigned = await f.service.assignIcebreakerGroup(staff, "a", { activityId: activity.id, title: "第一组", userIds: ["bob", "alice"], expectedRevision: 3 }); assert.equal(assigned.revision, 4);
  const participant = (await f.service.listIcebreakers(alice, "a")).activities[0]!;
  assert.deepEqual(participant.ownGroup!.memberUserIds, ["alice", "bob"]); assert.equal(participant.ownChoice, "join");
  assert.ok(!("groups" in participant)); assert.ok(!("responses" in participant));
  await assert.rejects(f.service.listManagedIcebreakers(alice, "a"), hasCode("STAFF_REQUIRED"));
  const managed = (await f.service.listManagedIcebreakers(staff, "a")).activities[0]!; assert.equal(managed.responses!.length, 2);
  await assert.rejects(f.service.assignIcebreakerGroup(staff, "a", { activityId: activity.id, title: "第二组", userIds: ["alice"], expectedRevision: 4 }), hasCode("ICEBREAKER_GROUP_CONFLICT"));
  const beforeRegistration = f.registrations.get("a:alice");
  const decline = await f.service.respondIcebreaker(alice, "a", { activityId: activity.id, choice: "decline" }); assert.equal(decline.revision, 5);
  assert.deepEqual(f.registrations.get("a:alice"), beforeRegistration, "refusal never changes registration");
  assert.equal((await f.service.listIcebreakers(alice, "a")).activities[0]!.ownGroup, null);
  assert.deepEqual((await f.service.listIcebreakers(bob, "a")).activities[0]!.ownGroup!.memberUserIds, ["bob"]);
  const revisions = await f.engine.query<{ document: { memberUserIds: string[] } }>("SELECT document FROM ec_icebreaker_group_versions ORDER BY revision");
  assert.deepEqual(revisions.rows[0]!.document.memberUserIds, ["alice", "bob"]); assert.deepEqual(revisions.rows[1]!.document.memberUserIds, ["bob"]);
  await assert.rejects(f.engine.query("DELETE FROM ec_icebreaker_group_versions"), /immutable/);
  await assert.rejects(f.service.assignIcebreakerGroup(staff, "a", { activityId: activity.id, title: "第一组", userIds: ["alice"], expectedRevision: 5 }), hasCode("ICEBREAKER_OPT_IN_REQUIRED"));
});

test("icebreaking: guessed activity IDs, withdrawn users, concurrent assignments and flag disable do not bypass scope", async t => {
  const f = await fixture(t), staff = f.principal("staff-a"), alice = f.principal("alice");
  const activity = await f.service.createIcebreaker(staff, "a", { title: "交流", description: "", startsAt: "2026-10-12T11:00:00+08:00", location: "大厅" });
  await assert.rejects(f.service.respondIcebreaker(alice, "b", { activityId: activity.id, choice: "join" }), hasCode("EVENT_SERVICE_NOT_FOUND"));
  await assert.rejects(f.service.assignIcebreakerGroup(f.principal("staff-c"), "c", { activityId: activity.id, title: "组", userIds: [], expectedRevision: 1 }), hasCode("EVENT_SERVICE_NOT_FOUND"));
  f.registrationStatus("a", "alice", "withdrawn");
  await assert.rejects(f.service.respondIcebreaker(alice, "a", { activityId: activity.id, choice: "join" }), hasCode("EVENT_PARTICIPATION_REQUIRED"));
  f.registrationStatus("a", "alice", "approved"); await f.service.respondIcebreaker(alice, "a", { activityId: activity.id, choice: "join" });
  const results = await Promise.allSettled([1, 2].map(index => f.service.assignIcebreakerGroup(staff, "a", { activityId: activity.id, title: `组${index}`, userIds: ["alice"], expectedRevision: 2 })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason.code, "EVENT_SERVICE_REVISION_CONFLICT");
  f.updateEvent("a", { modules: { ...f.events.get("a")!.modules, icebreaking: false } });
  const history = await f.service.listIcebreakers(alice, "a"); assert.equal(history.enabled, false); assert.equal(history.activities.length, 1);
  await assert.rejects(f.service.respondIcebreaker(alice, "a", { activityId: activity.id, choice: "decline" }), hasCode("EVENT_MODULE_DISABLED"));
  await assert.rejects(f.service.createIcebreaker(staff, "a", { title: "交流", description: "", startsAt: "2026-10-12T11:00:00+08:00", location: "大厅" }), hasCode("EVENT_MODULE_DISABLED"));
});

test("icebreaking: late staff or participant revocation atomically rolls back activity/group/response writes", async t => {
  const f = await fixture(t), staff = f.principal("staff-a"), alice = f.principal("alice");
  const activity = await f.service.createIcebreaker(staff, "a", { title: "交流", description: "", startsAt: "2026-10-12T11:00:00+08:00", location: "大厅" });
  let reads = 0;
  f.hooks.registration = (eventId, userId) => { if (userId === "alice" && ++reads === 2) f.registrationStatus(eventId, userId, "withdrawn"); };
  await assert.rejects(f.service.respondIcebreaker(alice, "a", { activityId: activity.id, choice: "join" }), hasCode("EVENT_PARTICIPATION_REQUIRED"));
  assert.equal((await f.engine.query("SELECT * FROM ec_icebreaker_responses")).rows.length, 0);
  f.hooks.registration = undefined; f.registrationStatus("a", "alice", "approved");
  await f.service.respondIcebreaker(alice, "a", { activityId: activity.id, choice: "join" });
  let checks = 0;
  f.hooks.staff = () => { if (++checks === 2) f.grants.delete("a:staff-a"); };
  await assert.rejects(f.service.assignIcebreakerGroup(staff, "a", { activityId: activity.id, title: "组", userIds: ["alice"], expectedRevision: 2 }), hasCode("STAFF_REQUIRED"));
  assert.equal((await f.engine.query("SELECT * FROM ec_icebreaker_groups")).rows.length, 0);
  assert.equal((await f.engine.query("SELECT * FROM ec_icebreaker_group_versions")).rows.length, 0);
});

test("icebreaking: a dual-role staff account receives only the personal projection through the participant method", async t => {
  const f = await fixture(t), staff = f.principal("staff-a");
  const activity = await f.service.createIcebreaker(staff, "a", { title: "交流", description: "", startsAt: "2026-10-12T11:00:00+08:00", location: "大厅" });
  await f.service.respondIcebreaker(f.principal("alice"), "a", { activityId: activity.id, choice: "join" });
  await assert.rejects(f.service.listIcebreakers(staff, "a"), hasCode("EVENT_PARTICIPATION_REQUIRED"));
  f.registrations.set("a:staff-a", { id: "registration-staff-a", eventId: "a", userId: "staff-a", status: "approved", revision: 1 });
  const own = (await f.service.listIcebreakers(staff, "a")).activities[0]!;
  assert.equal(own.ownChoice, null); assert.equal(own.ownGroup, null);
  assert.ok(!("responses" in own)); assert.ok(!("groups" in own));
  assert.equal((await f.service.listManagedIcebreakers(staff, "a")).activities[0]!.responses!.length, 1);
  let checks = 0;
  f.hooks.staff = () => { if (++checks === 2) f.grants.delete("a:staff-a"); };
  await assert.rejects(f.service.listManagedIcebreakers(staff, "a"), hasCode("STAFF_REQUIRED"));
});

test("schedule inputs: null objects, invalid timezone/times, duplicate targets and withdrawn recipients do not become stored drafts", async t => {
  const f = await fixture(t), staff = f.principal("staff-a"), noInput = null as never;
  for (const action of [
    () => f.service.saveScheduleDraft(staff, "a", noInput),
    () => f.service.previewScheduleImport(staff, "a", noInput),
    () => f.service.confirmScheduleImport(staff, "a", noInput),
    () => f.service.publishSchedule(staff, "a", noInput),
    () => f.service.createIcebreaker(staff, "a", noInput),
    () => f.service.respondIcebreaker(f.principal("alice"), "a", noInput),
    () => f.service.assignIcebreakerGroup(staff, "a", noInput),
  ]) await assert.rejects(action(), hasCode("SCHEDULE_INVALID"));
  await assert.rejects(f.service.saveScheduleDraft(staff, "a", { ...schedule(), timezone: "Invented/Timezone" }), hasCode("SCHEDULE_INVALID"));
  await assert.rejects(f.service.saveScheduleDraft(staff, "a", schedule(0, [allItem("逆序", { endsAt: "2026-10-12T08:00:00+08:00" })])), hasCode("SCHEDULE_INVALID"));
  await assert.rejects(f.service.saveScheduleDraft(staff, "a", schedule(0, [allItem("重复名单", { audience: "users", userIds: ["alice", "alice"] })])), hasCode("SCHEDULE_INVALID"));
  await assert.rejects(f.service.saveScheduleDraft(staff, "a", schedule(0, [allItem("缺时区", { startsAt: "2026-10-12T09:00:00" })])), hasCode("SCHEDULE_INVALID"));
  f.registrationStatus("a", "alice", "withdrawn");
  await assert.rejects(f.service.saveScheduleDraft(staff, "a", schedule(0, [allItem("已退出人员", { audience: "users", userIds: ["alice"] })])), hasCode("EVENT_PARTICIPATION_REQUIRED"));
  assert.equal((await f.engine.query("SELECT * FROM ec_schedule_state")).rows.length, 0);
});

test("规划35：公开日程投影只含 audience=all 的已发布条目，未发布与草稿一律空", async t => {
  const f = await fixture(t), staff = f.principal("staff-a");
  await f.service.saveScheduleDraft(staff, "a", schedule(0, [allItem(), allItem("选手报到", { audience: "participants" })]));
  // 未发布：公开投影为空（不泄露草稿时间）。
  assert.deepEqual(await f.database.transaction(sql => f.service.publicScheduleNodes(sql, "a")), []);
  await f.service.publishSchedule(staff, "a", { expectedRevision: 1 });
  const nodes = await f.database.transaction(sql => f.service.publicScheduleNodes(sql, "a"));
  assert.equal(nodes.length, 1, "只返回 audience=all 的一条");
  assert.equal(nodes[0]!.title, "集合");
  assert.equal(nodes[0]!.kind, "session");
  assert.equal(nodes[0]!.at, "2026-10-12T01:00:00.000Z");
});
