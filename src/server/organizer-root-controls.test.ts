import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import type { OrganizerPrincipal } from "../shared/organizer-contracts.ts";
import { DomainError } from "../shared/errors.ts";
import { PostgresProjectsRepository } from "../modules/projects/index.ts";
import type { HostedEvent } from "../modules/organizer/index.ts";
import type { RosterTeam } from "../modules/event-registration/index.ts";
import { createOrganizerIntegration } from "./organizer-integration.ts";
import { createOrganizerRootControls } from "./organizer-root-controls.ts";

/** Actual root controls and module services, memory-only PostgreSQL engine and current session fixture. */
async function fixture(t: TestContext) {
  const engine = new PGlite(); await engine.waitReady; t.after(() => engine.close());
  await engine.exec(`CREATE TABLE auth_users(id text PRIMARY KEY,email text UNIQUE,display_name text,status text,email_verified_at timestamptz,platform_roles text[],bio text);
    CREATE TABLE control_sessions(user_id text PRIMARY KEY REFERENCES auth_users(id),active boolean NOT NULL);`);
  for (const path of ["../modules/projects/sql/001-projects.sql", "../../migrations/042_organizer_core.sql", "../../migrations/043_event_registration.sql", "../../migrations/044_event_communication.sql",
    "../../migrations/045_event_logistics.sql", "../../migrations/046_event_schedule.sql", "../modules/event-judging/schema.sql", "../../migrations/048_organizer_relationship_reviews.sql", "../../migrations/056_organizer_lookup_limits.sql"]) {
    await engine.exec(await readFile(new URL(path, import.meta.url), "utf8"));
  }
  const ambient = new AsyncLocalStorage<SqlExecutor>(), statements: string[] = [], forcedIds: string[] = [];
  let nextId = 0, savepoint = 0, guards = 0, failGuardAt = -1;
  const time = { value: Date.parse("2026-10-11T04:00:00Z") }, clock = { now: () => new Date(time.value) }, ids = { next: () => forcedIds.shift() ?? `control-${++nextId}` };
  const executor = (query: (sql: string, parameters: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>): SqlExecutor => ({
    async query<Row>(sql: string, parameters: readonly unknown[] = []) { statements.push(sql); const result = await query(sql, [...parameters]); return { rows: result.rows as Row[], rowCount: result.rows.length || result.affectedRows || 0 }; },
  });
  const direct = executor((sql, parameters) => engine.query(sql, parameters));
  const database: DatabasePort = {
    query: (sql, parameters) => (ambient.getStore() ?? direct).query(sql, parameters),
    async transaction(work) {
      const current = ambient.getStore();
      if (current) {
        const name = `controls_${++savepoint}`; await current.query(`SAVEPOINT ${name}`);
        try { const result = await work(current); await current.query(`RELEASE SAVEPOINT ${name}`); return result; }
        catch (error) { await current.query(`ROLLBACK TO SAVEPOINT ${name}`); await current.query(`RELEASE SAVEPOINT ${name}`); throw error; }
      }
      return engine.transaction(tx => { const sql = executor((statement, parameters) => tx.query(statement, parameters)); return ambient.run(sql, () => work(sql)); });
    },
  };
  const roleMap: Record<string, Actor["platformRoles"]> = Object.fromEntries(["ownerA", "ownerB", "alice", "judge", "former", "projectMember", "eventManager", "judgeManager", "logisticsStaff", "registrationStaff", "unrelated", "disabled", "unverified"].map(id => [id, ["user"]]));
  roleMap.admin = ["user", "admin"];
  for (const [userId, roles] of Object.entries(roleMap)) {
    await database.query("INSERT INTO auth_users VALUES($1,$2,$3,$4,$5,$6,$7)", [userId, `${userId.toLowerCase()}@example.org`, `称呼-${userId}`, userId === "disabled" ? "disabled" : "active", userId === "unverified" ? null : "2026-10-01", roles, `PRIVATE_PROFILE_${userId}`]);
    await database.query("INSERT INTO control_sessions VALUES($1,true)", [userId]);
  }
  const principal = (userId: string): OrganizerPrincipal => ({ actor: { userId, platformRoles: roleMap[userId] }, async guard(sql) {
    guards++;
    const row = (await sql.query<{ status: string; email_verified_at: Date | null; platform_roles: string[] }>("SELECT status,email_verified_at,platform_roles FROM auth_users WHERE id=$1 FOR SHARE", [userId])).rows[0];
    const session = (await sql.query("SELECT user_id FROM control_sessions WHERE user_id=$1 AND active FOR SHARE", [userId])).rowCount;
    if (guards === failGuardAt || !row || row.status !== "active" || !row.email_verified_at || !session || JSON.stringify(row.platform_roles) !== JSON.stringify(roleMap[userId])) throw new DomainError("CURRENT_SESSION_REQUIRED", "当前账号或会话不可用。", { status: 401 });
  } });
  const resolvePrincipal = async (request: Request) => { const id = request.headers.get("x-fixture-user"); return id && roleMap[id] ? principal(id) : null; };
  const assertMutationAllowed = async (request: Request) => { if (request.headers.get("origin") !== "http://test.local") throw new DomainError("ORIGIN_DENIED", "来源无效。", { status: 403 }); };
  const requireActiveTarget = async (sql: SqlExecutor, userId: string) => { assert.equal(sql, ambient.getStore()); if (!(await sql.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR SHARE", [userId])).rowCount) throw new DomainError("TARGET_UNAVAILABLE", "目标账号不可用。", { status: 403 }); };
  const projectRepository = new PostgresProjectsRepository(database);
  let integration: ReturnType<typeof createOrganizerIntegration>;
  const controls = createOrganizerRootControls({ database, clock, ids, resolvePrincipal, assertMutationAllowed, requireActiveTarget, projectRepository, integration: () => integration });
  integration = createOrganizerIntegration({ database, clock, ids, resolvePrincipal, assertMutationAllowed, requireActiveTarget, projectRepository, relationshipReviews: controls.relationshipReviews });
  const organizationIds = new Map<string, string>();
  async function createEvent(owner = "ownerA", title = "AI新手赛"): Promise<HostedEvent> {
    let organizationId = organizationIds.get(owner);
    if (!organizationId) {
      const application = await integration.organizer.createApplication(principal(owner), { name: `机构-${owner}`, kind: "community", description: "活动组织", contactName: "联系人", contactEmail: "contact@example.org", evidenceText: "活动依据", evidenceUrls: [] });
      await integration.organizer.reviewApplication(principal("admin"), application.id, { expectedRevision: application.revision, decision: "approved", note: "隔离人工审批" });
      organizationId = application.organizationId; organizationIds.set(owner, organizationId);
    }
    const organization = (await integration.organizer.listOrganizations(principal(owner))).find(value => value.id === organizationId)!;
    const event = await integration.organizer.createEvent(principal(owner), organizationId, { title, templateKey: "online", expectedOrganizationRevision: organization.revision, timezone: "Asia/Shanghai", startsAt: "2026-10-20T02:00:00Z", endsAt: "2026-10-22T10:00:00Z", registrationOpensAt: "2026-10-01T00:00:00Z", registrationClosesAt: "2026-10-19T10:00:00Z", submissionClosesAt: "2026-10-22T09:00:00Z",
      modules: { registration: true, teams: true, judging: true, schedule: true, icebreaking: false, accommodation: false, mealVouchers: false }, registration: { reviewRequired: false, capacity: 30 }, teams: { mode: "free", minSize: 1, maxSize: 5, locksAt: null }, summary: "公开活动简介", rules: "公开比赛规则", location: "线上" });
    await integration.registration.saveForm(principal(owner), event.eventId, { expectedRevision: 0, title: "报名", description: "免费报名", fields: [], changeNote: "首次发布" });
    return integration.organizer.publishEvent(principal(owner), event.eventId, { expectedRevision: event.revision, changeSummary: "首次发布" });
  }
  async function lockedTeam(event: HostedEvent): Promise<RosterTeam> {
    const form = (await integration.registration.getRegistrationForm(event.eventId)).form!;
    const draft = await integration.registration.saveDraft(principal("alice"), event.eventId, { expectedRevision: 0, formRevision: form.revision, answers: {} });
    await integration.registration.submit(principal("alice"), event.eventId, { expectedRevision: draft.revision, idempotencyKey: `registration-${event.eventId}` });
    const team = await integration.registration.createTeam(principal("alice"), event.eventId, { name: "行动队", introduction: "公开介绍", track: "", idempotencyKey: `team-${event.eventId}` });
    return integration.registration.lockRoster(principal("alice"), event.eventId, team.id, { expectedRevision: team.revision, idempotencyKey: `lock-${event.eventId}` });
  }
  async function grant(event: HostedEvent, userId: string, capabilities: ("event_manage" | "judging_manage" | "registration_manage" | "logistics_manage")[]) {
    const organization = (await integration.organizer.listOrganizations(principal("ownerA"))).find(value => value.id === event.organizationId)!;
    return integration.organizer.grantStaff(principal("ownerA"), event.organizationId, { expectedOrganizationRevision: organization.revision, userId, eventId: event.eventId, role: "staff", capabilities });
  }
  const request = (path: string, method = "GET", userId?: string, body?: unknown, origin = "http://test.local") => new Request(`http://test.local/api/v1${path}`, { method,
    headers: { ...(userId ? { "x-fixture-user": userId } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), origin }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  async function http<T>(path: string, method = "GET", userId?: string, body?: unknown, expected = 200) {
    const response = await controls.handle(request(path, method, userId, body), path.slice(1).split("/")); assert.ok(response);
    const payload = await response.json(); assert.equal(response.status, expected, JSON.stringify(payload)); assert.match(response.headers.get("cache-control") ?? "", /no-store/); return payload.data as T;
  }
  const reviewPath = (event: HostedEvent) => `/organizer/events/${event.eventId}/judging/relationship-review`;
  const reviewBody = (team: RosterTeam, judgeUserId = "judge", status = "clear") => ({ teamId: team.id, judgeUserId, status, note: "人工核对参赛与辅导关系", expectedTeamRevision: team.revision });
  async function inspect(event: HostedEvent, team: RosterTeam, judgeUserId = "judge") { return database.transaction(sql => integration.conflicts.inspect(sql, { eventId: event.eventId, teamId: team.id, judgeUserId })); }
  async function submit(event: HostedEvent, team: RosterTeam, title = "最新正式作品") {
    const materials = { title, description: "PRIVATE_SUBMISSION_DESCRIPTION", links: [{ label: "正式演示", url: "https://example.org/private-demo" }], files: [] };
    const preview = await integration.judging.previewSubmission(principal("alice"), event.eventId, { teamId: team.id, materials });
    return integration.judging.submit(principal("alice"), event.eventId, { teamId: team.id, materials, expectedEventRevision: preview.eventRevision, expectedTeamRevision: preview.teamRevision, expectedPreviousVersion: preview.previousVersion, expectedMaterialHash: preview.materialHash, idempotencyKey: `submission-${event.eventId}-${preview.previousVersion}` });
  }
  return { database, integration, controls, projectRepository, principal, request, http, createEvent, lockedTeam, grant, reviewPath, reviewBody, inspect, submit, time, forcedIds, statements, failNextFinalGuard: () => { failGuardAt = guards + 2; } };
}

test("exact-email account lookup is event-scoped and returns only the verified account id and display label", async t => {
  const f = await fixture(t), event = await f.createEvent(), sameOrgOther = await f.createEvent("ownerA", "另一场同组织比赛");
  await f.grant(event, "eventManager", ["event_manage"]); await f.grant(event, "judgeManager", ["judging_manage"]); await f.grant(event, "registrationStaff", ["registration_manage"]);
  const path = `/organizer/events/${event.eventId}/account-lookup`;
  for (const actor of ["eventManager", "judgeManager"]) {
    const account = await f.http<{ userId: string; label: string }>(path, "POST", actor, { email: " JUDGE@EXAMPLE.ORG " });
    assert.deepEqual(account, { userId: "judge", label: "称呼-judge" }); assert.deepEqual(Object.keys(account).sort(), ["label", "userId"]);
    assert.ok(!JSON.stringify(account).includes("PRIVATE_PROFILE")); assert.ok(!JSON.stringify(account).includes("@"));
  }
  for (const actor of ["alice", "registrationStaff", "admin", "ownerB"]) await f.http(path, "POST", actor, { email: "judge@example.org" }, 403);
  await f.http(`/organizer/events/${sameOrgOther.eventId}/account-lookup`, "POST", "eventManager", { email: "judge@example.org" }, 403);
  for (const email of ["missing@example.org", "disabled@example.org", "unverified@example.org"]) await f.http(path, "POST", "eventManager", { email }, 404);
  await f.http(path, "POST", "eventManager", { email: "judge@example.org", includeProfile: true }, 422);
});

test("root controls deny anonymous users, foreign origins, unsupported methods and oversize bodies before any review write", async t => {
  const f = await fixture(t), event = await f.createEvent(), team = await f.lockedTeam(event), path = f.reviewPath(event);
  await f.http(path, "POST", undefined, f.reviewBody(team), 401);
  const denied = await f.controls.handle(f.request(path, "POST", "ownerA", f.reviewBody(team), "http://evil.local"), path.slice(1).split("/")); assert.equal(denied?.status, 403);
  const wrong = await f.controls.handle(f.request(path, "GET", "ownerA"), path.slice(1).split("/")); assert.equal(wrong?.status, 405); assert.equal(wrong?.headers.get("allow"), "POST");
  await f.http(path, "POST", "ownerA", { ...f.reviewBody(team), note: "x".repeat(9000) }, 413);
  assert.equal(await f.controls.handle(f.request("/organizer/events/unknown/unhandled"), ["organizer", "events", "unknown", "unhandled"]), null);
  assert.equal((await f.database.query<{ count: number }>("SELECT count(*)::int AS count FROM organizer_relationship_reviews")).rows[0].count, 0);
});

test("human relationship reviews require this event's judging capability and forbid self-review, wrong teams and stale roster versions", async t => {
  const f = await fixture(t), event = await f.createEvent(), other = await f.createEvent("ownerA", "同组织另一赛"), team = await f.lockedTeam(event);
  await f.grant(event, "eventManager", ["event_manage"]); await f.grant(event, "judgeManager", ["judging_manage"]);
  await f.http(f.reviewPath(event), "POST", "eventManager", f.reviewBody(team), 403);
  await f.http(f.reviewPath(other), "POST", "judgeManager", f.reviewBody(team), 403);
  await f.http(f.reviewPath(event), "POST", "judgeManager", f.reviewBody(team, "judgeManager"), 403);
  await f.http(f.reviewPath(event), "POST", "ownerA", { ...f.reviewBody(team), teamId: "wrong-team" }, 404);
  await f.http(f.reviewPath(event), "POST", "ownerA", { ...f.reviewBody(team), expectedTeamRevision: team.revision + 1 }, 409);
  await f.http(f.reviewPath(event), "POST", "ownerA", f.reviewBody(team, "alice"), 409);
  await f.http(f.reviewPath(event), "POST", "ownerA", f.reviewBody(team, "disabled"), 403);
  const review = await f.http<{ state: string; teamRevision: number }>(f.reviewPath(event), "POST", "judgeManager", f.reviewBody(team)); assert.equal(review.state, "clear"); assert.equal(review.teamRevision, team.revision);
  assert.equal((await f.inspect(event, team)).status, "clear");
});

test("actual roster revision changes and expiry invalidate saved manual relationship clearance", async t => {
  const f = await fixture(t), event = await f.createEvent(), team = await f.lockedTeam(event);
  await f.http(f.reviewPath(event), "POST", "ownerA", f.reviewBody(team)); assert.equal((await f.inspect(event, team)).status, "clear");
  const reopened = await f.integration.registration.reopenRoster(f.principal("ownerA"), event.eventId, team.id, { expectedRevision: team.revision, idempotencyKey: "reopen-roster", note: "本人确认需要调整名单" });
  assert.equal((await f.inspect(event, reopened)).status, "needs_review");
  await f.http(f.reviewPath(event), "POST", "ownerA", f.reviewBody(team), 409);
  const newest = await f.http<{ expiresAt: string }>(f.reviewPath(event), "POST", "ownerA", f.reviewBody(reopened)); assert.equal((await f.inspect(event, reopened)).status, "clear");
  f.time.value = Date.parse(newest.expiresAt); assert.equal((await f.inspect(event, reopened)).status, "needs_review");
});

test("current and historical participation in the actual linked space cannot be cleared by a human review", async t => {
  const f = await fixture(t), event = await f.createEvent(), team = await f.lockedTeam(event), instant = "2026-10-01T00:00:00Z";
  await f.projectRepository.createProject({ project: { id: "private-space", name: "私人空间", teamId: null, eventId: null, createdBy: "alice", goal: "PRIVATE_SPACE_GOAL", minimumDeliverable: "PRIVATE_SCOPE", stage: "preparing", timezone: "Asia/Shanghai", deadline: null, deadlineSource: "unknown", revision: 1, createdAt: instant, updatedAt: instant },
    members: [{ membershipId: "space-alice", projectId: "private-space", userId: "alice", role: "manager", status: "active", revision: 1, joinedAt: instant, leftAt: null }, { membershipId: "space-current", projectId: "private-space", userId: "projectMember", role: "member", status: "active", revision: 1, joinedAt: instant, leftAt: null }, { membershipId: "space-former", projectId: "private-space", userId: "former", role: "member", status: "left", revision: 2, joinedAt: instant, leftAt: "2026-10-02T00:00:00Z" }], invitations: [], availability: [], bookmarks: [], activities: [], facts: [] });
  const link = await f.integration.registration.requestProjectLink(f.principal("alice"), event.eventId, team.id, { expectedRevision: team.revision, projectId: "private-space", idempotencyKey: "ask-link" });
  const linked = await f.integration.registration.confirmProjectLink(f.principal("alice"), event.eventId, team.id, link.id, { expectedRevision: link.revision, expectedTeamRevision: team.revision, expectedProjectRevision: 1, idempotencyKey: "confirm-link" });
  for (const judge of ["projectMember", "former"]) {
    await f.http(f.reviewPath(event), "POST", "ownerA", f.reviewBody(linked, judge), 409);
    assert.equal((await f.inspect(event, linked, judge)).status, "conflict");
  }
  assert.equal((await f.database.query<{ count: number }>("SELECT count(*)::int AS count FROM organizer_relationship_reviews")).rows[0].count, 0);
  await f.http(f.reviewPath(event), "POST", "ownerA", f.reviewBody(linked, "former", "conflict"));
  assert.equal((await f.inspect(event, linked, "former")).status, "conflict"); assert.equal(await f.projectRepository.getMembership("private-space", "ownerA"), null);
});

test("append-only manual evidence orders same-millisecond verdicts by actual insertion rather than UUID sort order", async t => {
  const f = await fixture(t), event = await f.createEvent(), team = await f.lockedTeam(event);
  f.forcedIds.push("request-first", "z-old-review", "request-second", "a-new-review");
  const first = await f.http<{ id: string }>(f.reviewPath(event), "POST", "ownerA", f.reviewBody(team)); assert.equal(first.id, "z-old-review");
  const next = await f.http<{ id: string }>(f.reviewPath(event), "POST", "ownerA", f.reviewBody(team, "judge", "conflict")); assert.equal(next.id, "a-new-review");
  assert.equal((await f.inspect(event, team)).status, "conflict");
  await assert.rejects(f.database.query("UPDATE organizer_relationship_reviews SET note='rewrite' WHERE id=$1", [first.id]), /immutable/);
  await assert.rejects(f.database.query("DELETE FROM organizer_relationship_reviews WHERE id=$1", [first.id]), /immutable/);
  assert.equal((await f.database.query<{ count: number }>("SELECT count(*)::int AS count FROM organizer_relationship_reviews")).rows[0].count, 2);
});

test("relationship target GET is read-only, least-data, event-scoped and names the latest formally submitted version", async t => {
  const f = await fixture(t), event = await f.createEvent(), other = await f.createEvent("ownerA", "另一赛"), team = await f.lockedTeam(event);
  await f.grant(event, "judgeManager", ["judging_manage"]); await f.submit(event, team, "旧标题"); await f.submit(event, team, "最终标题");
  const start = f.statements.length, path = `/organizer/events/${event.eventId}/judging/relationship-targets`;
  const targets = await f.http<{ items: { teamId: string; title: string; revision: number }[] }>(path, "GET", "judgeManager");
  assert.deepEqual(targets, { items: [{ teamId: team.id, title: "最终标题", revision: team.revision }] });
  assert.deepEqual(f.statements.slice(start).filter(sql => /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|TRUNCATE)\b/i.test(sql)), []);
  assert.ok(!JSON.stringify(targets).includes("PRIVATE_")); assert.ok(!JSON.stringify(targets).includes("private-demo")); assert.ok(!JSON.stringify(targets).includes("judge"));
  await f.http(`/organizer/events/${other.eventId}/judging/relationship-targets`, "GET", "judgeManager", undefined, 403);
  await f.http(path, "GET", "alice", undefined, 403); await f.http(path, "GET", undefined, undefined, 401);
});

test("a failing final current-session guard rolls back human review evidence; revoked sessions cannot reuse controls", async t => {
  const f = await fixture(t), event = await f.createEvent(), team = await f.lockedTeam(event);
  f.failNextFinalGuard(); await f.http(f.reviewPath(event), "POST", "ownerA", f.reviewBody(team), 401);
  assert.equal((await f.database.query<{ count: number }>("SELECT count(*)::int AS count FROM organizer_relationship_reviews")).rows[0].count, 0);
  await f.database.query("UPDATE control_sessions SET active=false WHERE user_id='ownerA'");
  await f.http(`/organizer/events/${event.eventId}/account-lookup`, "POST", "ownerA", { email: "judge@example.org" }, 401);
  await f.http(f.reviewPath(event), "POST", "ownerA", f.reviewBody(team), 401);
});

test("logistics participant choices are read-only and contain only this event's approved, currently active and verified accounts", async t => {
  const f = await fixture(t), event = await f.createEvent(), other = await f.createEvent("ownerA", "另一现场安排"), team = await f.lockedTeam(event);
  await f.lockedTeam(other); await f.grant(event, "logisticsStaff", ["logistics_manage"]); await f.grant(event, "registrationStaff", ["registration_manage"]); await f.grant(event, "eventManager", ["event_manage"]);
  async function additional(userId: string, scope = event, submit = true) {
    const form = (await f.integration.registration.getRegistrationForm(scope.eventId)).form!;
    const draft = await f.integration.registration.saveDraft(f.principal(userId), scope.eventId, { expectedRevision: 0, formRevision: form.revision, answers: {} });
    if (submit) await f.integration.registration.submit(f.principal(userId), scope.eventId, { expectedRevision: draft.revision, idempotencyKey: `extra-${scope.eventId}-${userId}` });
  }
  await additional("judge", event, false); await additional("former", other);
  for (const userId of ["disabled", "unverified"]) {
    await f.database.query("UPDATE auth_users SET status='active',email_verified_at='2026-10-01' WHERE id=$1", [userId]); await additional(userId);
  }
  await f.database.query("UPDATE auth_users SET status='disabled' WHERE id='disabled'"); await f.database.query("UPDATE auth_users SET email_verified_at=NULL WHERE id='unverified'");
  const path = `/organizer/events/${event.eventId}/logistics-participants`, before = f.statements.length;
  const choices = await f.http<{ items: { userId: string; label: string }[] }>(path, "GET", "logisticsStaff");
  assert.deepEqual(choices, { items: [{ userId: "alice", label: "称呼-alice" }] }); assert.equal(team.captainUserId, "alice");
  assert.deepEqual(f.statements.slice(before).filter(sql => /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|TRUNCATE)\b/i.test(sql)), []);
  assert.ok(!JSON.stringify(choices).includes("PRIVATE_")); assert.ok(!JSON.stringify(choices).includes("@example.org"));
  for (const actor of ["registrationStaff", "eventManager", "alice", "ownerB"]) await f.http(path, "GET", actor, undefined, 403);
  await f.http(path, "GET", undefined, undefined, 401); await f.http(`/organizer/events/${other.eventId}/logistics-participants`, "GET", "logisticsStaff", undefined, 403);
});
