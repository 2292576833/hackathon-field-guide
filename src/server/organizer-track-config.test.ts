import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import type { OrganizerPrincipal } from "../shared/organizer-contracts.ts";
import { DomainError } from "../shared/errors.ts";
import { createOrganizerService } from "../modules/organizer/index.ts";
import type { HostedEvent } from "../modules/organizer/index.ts";
import { createEventRegistrationService } from "../modules/event-registration/index.ts";
import { createOrganizerTrackConfig } from "./organizer-track-config.ts";

/** Memory-only actual O01/O02/track persistence; no production connection or root migration execution. */
async function fixture(t: TestContext) {
  const engine = new PGlite(); await engine.waitReady; t.after(() => engine.close());
  await engine.exec("CREATE TABLE auth_users(id text PRIMARY KEY,active boolean NOT NULL,roles text[] NOT NULL); CREATE TABLE track_sessions(user_id text PRIMARY KEY REFERENCES auth_users(id),active boolean NOT NULL);");
  for (const path of ["../modules/organizer/migrations/001_organizer.sql", "../modules/event-registration/sql/001-event-registration.sql", "./organizer-track-schema.sql"]) await engine.exec(await readFile(new URL(path, import.meta.url), "utf8"));
  const context = new AsyncLocalStorage<SqlExecutor>(), statements: string[] = [];
  let nextId = 0, savepoint = 0, guards = 0, failGuardAt = -1;
  const executor = (query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>): SqlExecutor => ({
    async query<Row>(sql: string, values: readonly unknown[] = []) { statements.push(sql); const result = await query(sql, [...values]); return { rows: result.rows as Row[], rowCount: result.rows.length || result.affectedRows || 0 }; },
  });
  const direct = executor((sql, values) => engine.query(sql, values));
  const database: DatabasePort = {
    query: (sql, values) => (context.getStore() ?? direct).query(sql, values),
    async transaction(work) {
      const current = context.getStore();
      if (current) {
        const name = `tracks_${++savepoint}`; await current.query(`SAVEPOINT ${name}`);
        try { const output = await work(current); await current.query(`RELEASE SAVEPOINT ${name}`); return output; }
        catch (error) { await current.query(`ROLLBACK TO SAVEPOINT ${name}`); await current.query(`RELEASE SAVEPOINT ${name}`); throw error; }
      }
      return engine.transaction(tx => { const sql = executor((statement, values) => tx.query(statement, values)); return context.run(sql, () => work(sql)); });
    },
  };
  const roles: Record<string, Actor["platformRoles"]> = { ownerA: ["user"], ownerB: ["user"], admin: ["user", "admin"], alice: ["user"], bob: ["user"], eventManager: ["user"], registrationStaff: ["user"] };
  for (const [id, role] of Object.entries(roles)) { await database.query("INSERT INTO auth_users VALUES($1,true,$2)", [id, role]); await database.query("INSERT INTO track_sessions VALUES($1,true)", [id]); }
  const principal = (userId: string): OrganizerPrincipal => ({ actor: { userId, platformRoles: roles[userId] }, async guard(sql) {
    guards++;
    const user = (await sql.query<{ active: boolean; roles: string[] }>("SELECT active,roles FROM auth_users WHERE id=$1 FOR SHARE", [userId])).rows[0];
    const session = (await sql.query("SELECT user_id FROM track_sessions WHERE user_id=$1 AND active FOR SHARE", [userId])).rowCount;
    if (guards === failGuardAt || !user?.active || !session || JSON.stringify(user.roles) !== JSON.stringify(roles[userId])) throw new DomainError("CURRENT_SESSION_REQUIRED", "当前账号或会话不可用。", { status: 401 });
  } });
  const clock = { now: () => new Date("2026-10-11T04:00:00Z") }, ids = { next: () => `track-test-${++nextId}` };
  const organizer = createOrganizerService({ database, clock, ids });
  let registration: ReturnType<typeof createEventRegistrationService>;
  const module = createOrganizerTrackConfig({ database, clock, ids, getEvents: () => organizer.eventAccess, getRegistration: () => registration,
    resolvePrincipal: async request => { const id = request.headers.get("x-fixture-user"); return id && roles[id] ? principal(id) : null; },
    assertMutationAllowed: async request => { if (request.headers.get("origin") !== "http://test.local") throw new DomainError("ORIGIN_DENIED", "来源无效。", { status: 403 }); },
  });
  registration = createEventRegistrationService({ database, events: organizer.eventAccess, clock, ids, tracks: module.tracks, projectLinks: { async confirmLink() { throw new Error("No project linking in this fixture."); } } });
  const organizations = new Map<string, string>();
  async function event(owner = "ownerA", title = "AI新手赛"): Promise<HostedEvent> {
    let organizationId = organizations.get(owner);
    if (!organizationId) {
      const application = await organizer.createApplication(principal(owner), { name: `机构-${owner}`, kind: "community", description: "活动组织", contactName: "联络", contactEmail: "contact@example.org", evidenceText: "活动证据", evidenceUrls: [] });
      await organizer.reviewApplication(principal("admin"), application.id, { expectedRevision: 1, decision: "approved", note: "隔离人工核查" }); organizationId = application.organizationId; organizations.set(owner, organizationId);
    }
    const organization = (await organizer.listOrganizations(principal(owner))).find(value => value.id === organizationId)!;
    const created = await organizer.createEvent(principal(owner), organizationId, { title, templateKey: "online", expectedOrganizationRevision: organization.revision, timezone: "Asia/Shanghai", startsAt: "2026-10-20T02:00:00Z", endsAt: "2026-10-22T10:00:00Z", registrationOpensAt: "2026-10-01T00:00:00Z", registrationClosesAt: "2026-10-19T10:00:00Z", submissionClosesAt: null,
      modules: { registration: true, teams: true, judging: false, schedule: false, icebreaking: false, accommodation: false, mealVouchers: false }, registration: { reviewRequired: false, capacity: 30 }, teams: { mode: "free", minSize: 1, maxSize: 5, locksAt: null }, summary: "公开活动", rules: "以此赛官方赛道要求为准", location: "线上" });
    return organizer.publishEvent(principal(owner), created.eventId, { expectedRevision: created.revision, changeSummary: "首次发布" });
  }
  async function grant(event: HostedEvent, userId: string, capability: "event_manage" | "registration_manage") {
    const organization = (await organizer.listOrganizations(principal("ownerA"))).find(value => value.id === event.organizationId)!;
    return organizer.grantStaff(principal("ownerA"), event.organizationId, { expectedOrganizationRevision: organization.revision, userId, eventId: event.eventId, role: "staff", capabilities: [capability] });
  }
  async function team(event: HostedEvent, userId = "alice", track = "", locked = false) {
    let form = (await registration.getRegistrationForm(event.eventId)).form;
    if (!form) form = await registration.saveForm(principal("ownerA"), event.eventId, { expectedRevision: 0, title: "报名", description: "免费报名", fields: [], changeNote: "首次发布" });
    const draft = await registration.saveDraft(principal(userId), event.eventId, { expectedRevision: 0, formRevision: form.revision, answers: {} });
    await registration.submit(principal(userId), event.eventId, { expectedRevision: draft.revision, idempotencyKey: `register-${userId}-${event.eventId}` });
    const value = await registration.createTeam(principal(userId), event.eventId, { name: `队伍-${userId}`, introduction: "公开招募", track, idempotencyKey: `team-${userId}-${event.eventId}` });
    return locked ? registration.lockRoster(principal(userId), event.eventId, value.id, { expectedRevision: value.revision, idempotencyKey: `lock-${userId}-${event.eventId}` }) : value;
  }
  const path = (event: HostedEvent) => `/organizer/events/${event.eventId}/tracks`;
  const request = (event: HostedEvent, method = "GET", userId?: string, body?: unknown, origin = "http://test.local") => new Request(`http://test.local/api/v1${path(event)}`, { method, headers: { origin, ...(userId ? { "x-fixture-user": userId } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  async function http<T>(event: HostedEvent, method = "GET", userId?: string, body?: unknown, expected = 200) {
    const response = await module.handle(request(event, method, userId, body), ["organizer", "events", event.eventId, "tracks"]); assert.ok(response);
    const payload = await response.json(); assert.equal(response.status, expected, JSON.stringify(payload)); assert.match(response.headers.get("cache-control") ?? "", /no-store/); return payload.data as T;
  }
  return { database, organizer, registration, module, principal, event, grant, team, request, http, statements, failNextFinalGuard: () => { failGuardAt = guards + 2; } };
}
const options = [{ id: "ai_agent", title: "AI Agent" }, { id: "game", title: "游戏原型" }];

test("unconfigured track GET remains read-only and actual staff settings drive O02's official choices", async t => {
  const f = await fixture(t), event = await f.event(), before = f.statements.length;
  assert.deepEqual(await f.http(event, "GET", "ownerA"), { configured: false, required: false, revision: 0, options: [] });
  assert.deepEqual(f.statements.slice(before).filter(sql => /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|TRUNCATE)\b/i.test(sql)), []);
  const saved = await f.http(event, "PUT", "ownerA", { expectedRevision: 0, required: true, options }); assert.deepEqual(saved, { configured: true, revision: 1, required: true, options });
  const team = await f.team(event, "alice", "ai_agent"), view = await f.registration.listTeams(f.principal("alice"), event.eventId);
  assert.equal(team.track, "ai_agent"); assert.deepEqual(view.trackConfig, saved);
  await assert.rejects(f.team(event, "bob", "made_up_track"), { code: "INVALID_INPUT" });
});

test("track settings are limited to current event managers and reject anonymous, cross-event, cross-origin or revoked sessions", async t => {
  const f = await fixture(t), event = await f.event(), other = await f.event("ownerA", "同组织另一赛"), third = await f.event("ownerB", "另一机构赛事");
  await f.grant(event, "eventManager", "event_manage"); await f.grant(event, "registrationStaff", "registration_manage");
  for (const user of ["alice", "registrationStaff", "admin", "ownerB"]) await f.http(event, "GET", user, undefined, 403);
  await f.http(event, "GET", undefined, undefined, 401); await f.http(other, "GET", "eventManager", undefined, 403); await f.http(third, "GET", "eventManager", undefined, 403);
  await f.http(event, "PUT", "eventManager", { expectedRevision: 0, required: false, options });
  const csrf = await f.module.handle(f.request(event, "PUT", "eventManager", { expectedRevision: 1, required: false, options }, "http://evil.local"), ["organizer", "events", event.eventId, "tracks"]); assert.equal(csrf?.status, 403);
  const wrong = await f.module.handle(f.request(event, "POST", "eventManager", {}), ["organizer", "events", event.eventId, "tracks"]); assert.equal(wrong?.status, 405); assert.equal(wrong?.headers.get("allow"), "GET, PUT");
  await f.database.query("UPDATE track_sessions SET active=false WHERE user_id='eventManager'"); await f.http(event, "GET", "eventManager", undefined, 401);
});

test("same-revision saves commit only one configuration and matching immutable before/after audit", async t => {
  const f = await fixture(t), event = await f.event();
  const results = await Promise.allSettled([f.module.save(f.principal("ownerA"), event.eventId, { expectedRevision: 0, required: false, options }), f.module.save(f.principal("ownerA"), event.eventId, { expectedRevision: 0, required: false, options: [{ id: "design", title: "产品设计" }] })]);
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1); assert.equal(results.filter(value => value.status === "rejected").length, 1);
  const rejected = results.find(value => value.status === "rejected") as PromiseRejectedResult; assert.equal(rejected.reason.code, "TRACK_CONFIG_REVISION_CONFLICT");
  const state = await f.module.get(f.principal("ownerA"), event.eventId), history = (await f.database.query<{ before_configuration: { configured: boolean }; configuration: unknown; changed_by: string }>("SELECT before_configuration,configuration,changed_by FROM organizer_track_versions")).rows;
  assert.equal(state.revision, 1); assert.equal(history.length, 1); assert.equal(history[0].before_configuration.configured, false); assert.deepEqual(history[0].configuration, state); assert.equal(history[0].changed_by, "ownerA");
  await assert.rejects(f.database.query("DELETE FROM organizer_track_versions"), /immutable/); await assert.rejects(f.database.query("UPDATE organizer_track_versions SET changed_by='admin'"), /immutable/);
});

test("forming and locked teams preserve selected official IDs while unused options can change", async t => {
  const f = await fixture(t), event = await f.event(); await f.module.save(f.principal("ownerA"), event.eventId, { expectedRevision: 0, required: false, options });
  await f.team(event, "alice", "ai_agent"); await f.team(event, "bob", "game", true);
  await assert.rejects(f.module.save(f.principal("ownerA"), event.eventId, { expectedRevision: 1, required: false, options: [options[0]] }), { code: "TRACK_CONFIG_IN_USE", status: 409 });
  await assert.rejects(f.module.save(f.principal("ownerA"), event.eventId, { expectedRevision: 1, required: false, options: [options[1]] }), { code: "TRACK_CONFIG_IN_USE", status: 409 });
  const updated = await f.module.save(f.principal("ownerA"), event.eventId, { expectedRevision: 1, required: true, options: [{ id: "ai_agent", title: "AI应用与Agent" }, options[1], { id: "education", title: "教育创新" }] });
  assert.equal(updated.revision, 2); assert.equal(updated.required, true); assert.equal((await f.registration.listTeams(f.principal("alice"), event.eventId)).ownTeam?.eligible, true);
});

test("an existing unselected team prevents required tracks from silently invalidating its eligibility", async t => {
  const f = await fixture(t), event = await f.event(), team = await f.team(event, "alice", "", true);
  await f.module.save(f.principal("ownerA"), event.eventId, { expectedRevision: 0, required: false, options });
  await assert.rejects(f.module.save(f.principal("ownerA"), event.eventId, { expectedRevision: 1, required: true, options }), { code: "TRACK_CONFIG_UNSELECTED_TEAMS", status: 409 });
  const after = await f.module.get(f.principal("ownerA"), event.eventId); assert.equal(after.revision, 1); assert.equal(after.required, false);
  const current = await f.database.transaction(sql => f.registration.getTeam(sql, event.eventId, team.id)); assert.equal(current?.eligible, true);
});

test("track input is finite and literal; rejected fields or a failing final guard leave no configuration or audit", async t => {
  const f = await fixture(t), event = await f.event();
  for (const raw of [
    { expectedRevision: 0, required: false, options, execute: "arbitrary_code()" },
    { expectedRevision: 0, required: false, options: [{ id: "unsafe id", title: "坏编号" }] },
    { expectedRevision: 0, required: false, options: [options[0], options[0]] },
    { expectedRevision: 0, required: true, options: [] },
    { expectedRevision: 0, required: false, options: Array.from({ length: 21 }, (_, index) => ({ id: `track_${index}`, title: "赛道" })) },
  ]) await f.http(event, "PUT", "ownerA", raw, 422);
  f.failNextFinalGuard(); await f.http(event, "PUT", "ownerA", { expectedRevision: 0, required: false, options }, 401);
  assert.deepEqual(await f.module.get(f.principal("ownerA"), event.eventId), { configured: false, required: false, revision: 0, options: [] });
  assert.equal((await f.database.query<{ n: number }>("SELECT count(*)::int AS n FROM organizer_track_versions")).rows[0].n, 0);
});

test("ending a competition freezes later track edits and preserves the saved configuration", async t => {
  const f = await fixture(t), event = await f.event(); await f.module.save(f.principal("ownerA"), event.eventId, { expectedRevision: 0, required: false, options });
  await f.organizer.endEvent(f.principal("ownerA"), event.eventId, { expectedRevision: event.revision });
  await assert.rejects(f.module.save(f.principal("ownerA"), event.eventId, { expectedRevision: 1, required: false, options: [] }), { code: "TRACK_CONFIG_READ_ONLY" });
  assert.equal((await f.module.get(f.principal("ownerA"), event.eventId)).revision, 1);
});
