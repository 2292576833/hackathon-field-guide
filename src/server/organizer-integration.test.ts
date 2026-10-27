import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { DomainError } from "../shared/errors.ts";
import type { Actor } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import type { EventJudgeConflictPort, OrganizerPrincipal } from "../shared/organizer-contracts.ts";
import type { HostedEvent } from "../modules/organizer/index.ts";
import { PostgresProjectsRepository } from "../modules/projects/index.ts";
import type { IntakeReceipt, SubmissionMaterials } from "../modules/event-judging/index.ts";
import { createOrganizerIntegration } from "./organizer-integration.ts";

/** All stores execute real module SQL in a fresh in-memory engine. No .env or live directory. */
async function fixture(t: TestContext, options: { manualReview?: boolean; projectBridge?: boolean } = {}) {
  const engine = new PGlite(); await engine.waitReady; t.after(() => engine.close());
  await engine.exec(`CREATE TABLE auth_users(id text PRIMARY KEY,status text NOT NULL,email_verified_at timestamptz,platform_roles text[] NOT NULL);
    CREATE TABLE fixture_sessions(id text PRIMARY KEY,user_id text NOT NULL REFERENCES auth_users(id),active boolean NOT NULL);
    CREATE TABLE fixture_relationships(event_id text,team_id text,judge_user_id text,status text,PRIMARY KEY(event_id,team_id,judge_user_id));`);
  for (const path of ["../modules/projects/sql/001-projects.sql", "../modules/organizer/migrations/001_organizer.sql", "../modules/event-registration/sql/001-event-registration.sql",
    "../modules/event-communication/migrations/001_communication.sql", "../modules/event-communication/migrations/002_logistics.sql", "../modules/event-communication/migrations/003_schedule.sql", "../modules/event-judging/schema.sql"]) {
    await engine.exec(await readFile(new URL(path, import.meta.url), "utf8"));
  }
  const ambient = new AsyncLocalStorage<SqlExecutor>(), statements: string[] = [];
  let savepoint = 0, nextId = 0;
  const executor = (query: (sql: string, parameters: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>): SqlExecutor => ({
    async query<Row>(sql: string, parameters: readonly unknown[] = []) {
      statements.push(sql); const result = await query(sql, [...parameters]);
      return { rows: result.rows as Row[], rowCount: result.rows.length || result.affectedRows || 0 };
    },
  });
  const direct = executor((sql, parameters) => engine.query(sql, parameters));
  const database: DatabasePort = {
    query: (sql, parameters) => (ambient.getStore() ?? direct).query(sql, parameters),
    async transaction(work) {
      const current = ambient.getStore();
      if (current) {
        const name = `integration_${++savepoint}`; await current.query(`SAVEPOINT ${name}`);
        try { const result = await work(current); await current.query(`RELEASE SAVEPOINT ${name}`); return result; }
        catch (error) { await current.query(`ROLLBACK TO SAVEPOINT ${name}`); await current.query(`RELEASE SAVEPOINT ${name}`); throw error; }
      }
      return engine.transaction(tx => { const sql = executor((statement, parameters) => tx.query(statement, parameters)); return ambient.run(sql, () => work(sql)); });
    },
  };
  const roles: Record<string, Actor["platformRoles"]> = { admin: ["user", "admin"], ownerA: ["user"], ownerB: ["user"], alice: ["user"], bob: ["user"], judge: ["user"], former: ["user"], staff: ["user"] };
  for (const [userId, role] of Object.entries(roles)) {
    await database.query("INSERT INTO auth_users VALUES($1,'active','2026-10-01',$2)", [userId, role]);
    await database.query("INSERT INTO fixture_sessions VALUES($1,$2,true)", [`session-${userId}`, userId]);
  }
  let guardCalls = 0, originCalls = 0;
  const principal = (userId: string): OrganizerPrincipal => ({ actor: { userId, platformRoles: roles[userId] }, async guard(sql) {
    guardCalls++;
    const account = (await sql.query<{ status: string; email_verified_at: string | null; platform_roles: string[] }>("SELECT status,email_verified_at,platform_roles FROM auth_users WHERE id=$1 FOR SHARE", [userId])).rows[0];
    const session = (await sql.query("SELECT id FROM fixture_sessions WHERE id=$1 AND user_id=$2 AND active FOR SHARE", [`session-${userId}`, userId])).rowCount;
    if (!account || account.status !== "active" || !account.email_verified_at || !session || JSON.stringify(account.platform_roles) !== JSON.stringify(roles[userId])) throw new DomainError("SESSION_INVALID", "当前账号或会话不可用。", { status: 401 });
  } });
  const projectRepository = new PostgresProjectsRepository(database);
  const relationshipReviews: EventJudgeConflictPort = { async inspect(sql, input) {
    assert.equal(sql, ambient.getStore());
    const row = (await sql.query<{ status: "clear" | "conflict" | "needs_review" }>("SELECT status FROM fixture_relationships WHERE event_id=$1 AND team_id=$2 AND judge_user_id=$3", [input.eventId, input.teamId, input.judgeUserId])).rows[0];
    return { status: row?.status ?? "needs_review", reasons: row?.status === "clear" ? [] : ["隔离夹具中的人工核查尚未确认。"] };
  } };
  const integration = createOrganizerIntegration({ database, clock: { now: () => new Date("2026-10-11T04:00:00Z") }, ids: { next: () => `root-${++nextId}` },
    resolvePrincipal: async request => { const userId = request.headers.get("x-fixture-user"); return userId && roles[userId] ? principal(userId) : null; },
    async assertMutationAllowed(request) { originCalls++; if (request.headers.get("origin") !== "http://test.local") throw new DomainError("ORIGIN_DENIED", "请求来源无效。", { status: 403 }); },
    async requireActiveTarget(sql, userId) {
      assert.equal(sql, ambient.getStore());
      if (!(await sql.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR SHARE", [userId])).rowCount) throw new DomainError("TARGET_ACCOUNT_UNAVAILABLE", "目标账号尚不能接受授权。", { status: 403 });
    },
    ...(options.manualReview ? { relationshipReviews } : {}), ...(options.projectBridge ? { projectRepository } : {}),
  });
  const request = (path: string, method = "GET", userId?: string, body?: unknown, origin = "http://test.local") => new Request(`http://test.local/api/v1${path}`, { method,
    headers: { ...(userId ? { "x-fixture-user": userId } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), origin }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  async function http<T>(path: string, method = "GET", userId?: string, body?: unknown, expected = 200) {
    const response = await integration.handle(request(path, method, userId, body), path.slice(1).split("/")); assert.ok(response);
    const payload = await response.json(); assert.equal(response.status, expected, JSON.stringify(payload));
    assert.match(response.headers.get("cache-control") ?? "", /no-store/); return payload.data as T;
  }
  async function createEvent(owner = "ownerA", title = "线上AI实践赛"): Promise<HostedEvent> {
    const application = await integration.organizer.createApplication(principal(owner), { name: `机构-${owner}-${title}`, kind: "community", description: "活动组织", contactName: "联系人", contactEmail: "test@example.org", evidenceText: "公开活动依据", evidenceUrls: [] });
    await integration.organizer.reviewApplication(principal("admin"), application.id, { expectedRevision: application.revision, decision: "approved", note: "隔离人工审批" });
    const organization = (await integration.organizer.listOrganizations(principal(owner))).find(value => value.id === application.organizationId)!;
    const event = await integration.organizer.createEvent(principal(owner), organization.id, { title, templateKey: "online", expectedOrganizationRevision: organization.revision,
      timezone: "Asia/Shanghai", startsAt: "2026-10-20T02:00:00Z", endsAt: "2026-10-22T10:00:00Z", registrationOpensAt: "2026-10-01T00:00:00Z", registrationClosesAt: "2026-10-19T10:00:00Z", submissionClosesAt: "2026-10-22T09:00:00Z",
      modules: { registration: true, teams: true, judging: true, schedule: true, icebreaking: false, accommodation: false, mealVouchers: false },
      registration: { reviewRequired: false, capacity: 30 }, teams: { mode: "free", minSize: 1, maxSize: 5, locksAt: null }, summary: "公开活动简介", rules: "公开比赛规则", location: "线上" });
    const preview = await integration.organizer.previewEvent(principal(owner), event.eventId);
    assert.ok(preview.publicationBlockers.some(value => value.includes("报名表")), "first registration-enabled publication requires a real form");
    await assert.rejects(integration.organizer.publishEvent(principal(owner), event.eventId, { expectedRevision: event.revision, changeSummary: "未发布报名表" }), { code: "ORGANIZER_PUBLICATION_INCOMPLETE" });
    await integration.registration.saveForm(principal(owner), event.eventId, { expectedRevision: 0, title: "免费报名", description: "填写后明确提交", fields: [{ id: "goal", type: "text", label: "参赛目标", description: "", required: true }], changeNote: "首次发布" });
    return integration.organizer.publishEvent(principal(owner), event.eventId, { expectedRevision: event.revision, changeSummary: "首次发布规则与期限" });
  }
  async function register(event: HostedEvent, userId = "alice", owner = "ownerA") {
    let form = (await integration.registration.getRegistrationForm(event.eventId)).form;
    if (!form) form = await integration.registration.saveForm(principal(owner), event.eventId, { expectedRevision: 0, title: "免费报名", description: "填写后明确提交", fields: [{ id: "goal", type: "text", label: "参赛目标", description: "", required: true }], changeNote: "首次发布" });
    const draft = await integration.registration.saveDraft(principal(userId), event.eventId, { expectedRevision: 0, formRevision: form.revision, answers: { goal: "学习完成原型" } });
    return integration.registration.submit(principal(userId), event.eventId, { expectedRevision: draft.revision, idempotencyKey: `register-${event.eventId}-${userId}` });
  }
  async function team(event: HostedEvent) {
    await register(event);
    const roster = await integration.registration.createTeam(principal("alice"), event.eventId, { name: "新手行动队", introduction: "一起完成demo", track: "", idempotencyKey: `team-${event.eventId}` });
    return integration.registration.lockRoster(principal("alice"), event.eventId, roster.id, { expectedRevision: roster.revision, idempotencyKey: `lock-${event.eventId}` });
  }
  const materials: SubmissionMaterials = { title: "AI学习助手", description: "正式提交的方案", links: [{ label: "演示", url: "https://example.org/demo" }], files: [] };
  async function submit(event: HostedEvent, teamId: string): Promise<IntakeReceipt> {
    const preview = await http<{ eventRevision: number; teamRevision: number; previousVersion: number; materialHash: string }>(`/competitions/${event.eventId}/submissions/preview`, "POST", "alice", { teamId, materials });
    return http(`/competitions/${event.eventId}/submissions/submit`, "POST", "alice", { teamId, materials, expectedEventRevision: preview.eventRevision, expectedTeamRevision: preview.teamRevision, expectedPreviousVersion: preview.previousVersion, expectedMaterialHash: preview.materialHash, idempotencyKey: `submit-${event.eventId}-${teamId}` });
  }
  return { database, integration, projectRepository, principal, request, http, createEvent, register, team, submit, statements, guardCalls: () => guardCalls, originCalls: () => originCalls };
}

test("official rule publications transcribe immutable notices and discard stale queued versions", async t => {
  const f = await fixture(t), event = await f.createEvent();
  const id = `rule-change:${event.eventId}:1`;
  const first = await f.http<{ id: string; body: string }[]>(`/competitions/${event.eventId}/announcements`);
  assert.equal(first[0].id, id);
  assert.match(first[0].body, /首次发布规则与期限/);
  await assert.rejects(f.integration.communication.publishAnnouncement(f.principal("ownerA"), event.eventId, { announcementId: id, expectedRevision: 1, title: "重写官方规则", body: "改写", important: true, impact: "改写" }), { code: "OFFICIAL_RULE_NOTICE_READ_ONLY" });
  await assert.rejects(f.integration.communication.withdrawAnnouncement(f.principal("ownerA"), event.eventId, id, { expectedRevision: 1 }), { code: "OFFICIAL_RULE_NOTICE_READ_ONLY" });
  const keys = ["title", "timezone", "startsAt", "endsAt", "registrationOpensAt", "registrationClosesAt", "submissionClosesAt", "modules", "registration", "teams", "summary", "rules", "location"] as const;
  const draft = await f.integration.organizer.updateEvent(f.principal("ownerA"), event.eventId, { ...Object.fromEntries(keys.map(key => [key, event[key]])), expectedRevision: event.revision, rules: "公开比赛规则，另增加三分钟路演" });
  const second = await f.integration.organizer.publishEvent(f.principal("ownerA"), event.eventId, { expectedRevision: draft.revision, changeSummary: "补充路演要求，请重新阅读" });
  assert.equal(second.publishedRevision, 2);
  await f.database.transaction(async sql => {
    assert.equal(await f.integration.communication.getNotificationAnnouncement(sql, { eventId: event.eventId, announcementId: id, revision: 1 }), null);
    const current = await f.integration.communication.getNotificationAnnouncement(sql, { eventId: event.eventId, announcementId: `rule-change:${event.eventId}:2`, revision: 1 });
    assert.equal(current?.publisherCapability, "event_manage");
  });
  assert.equal((await f.http<unknown[]>(`/competitions/${event.eventId}/announcements`)).length, 2, "onsite retains official history");
});

test("published competition -> registration -> roster -> private official help -> actual receipt -> human scoring uses real four-module stores", async t => {
  const f = await fixture(t, { manualReview: true }), event = await f.createEvent(), other = await f.createEvent("ownerB", "另一场比赛"), roster = await f.team(event);
  await f.register(other, "bob", "ownerB");
  const ticket = await f.http<{ id: string }>(`/competitions/${event.eventId}/help-tickets`, "POST", "alice", { question: "私人参赛困难", visibility: "private" });
  await f.http(`/organizer/events/${event.eventId}/help-tickets/${ticket.id}`, "GET", "ownerB", undefined, 403);
  assert.deepEqual(await f.http(`/competitions/${event.eventId}/help-tickets`, "GET"), []);
  const received = await f.submit(event, roster.id); assert.equal(received.submissionRecordId, null); assert.equal(received.teamId, roster.id);
  assert.equal(f.integration.capabilities.verifiedProjectSubmission, false); assert.equal(f.integration.capabilities.judgingAi, false); assert.equal(f.integration.capabilities.announcementEmail, false);
  const round = await f.integration.judging.saveConfig(f.principal("ownerA"), event.eventId, { expectedRevision: 0, config: { title: "人工评审", criteria: [{ id: "build", label: "可用性", weight: 100, min: 0, max: 10 }], minJudges: 1, missingPolicy: "block_publication", tiePolicy: "shared_rank" } });
  const opened = await f.integration.judging.startRound(f.principal("ownerA"), event.eventId, round.id, round.revision);
  await f.database.query("UPDATE auth_users SET status='disabled' WHERE id='judge'");
  await assert.rejects(f.integration.judging.assignJudge(f.principal("ownerA"), event.eventId, { roundId: opened.id, snapshotId: received.id, judgeUserId: "judge", expectedRoundRevision: opened.revision }), { code: "TARGET_ACCOUNT_UNAVAILABLE" });
  assert.equal((await f.database.query<{ n: number }>("SELECT count(*)::int AS n FROM ej_judge_assignments")).rows[0].n, 0);
  await f.database.query("UPDATE auth_users SET status='active' WHERE id='judge'");
  let assignment = await f.integration.judging.assignJudge(f.principal("ownerA"), event.eventId, { roundId: opened.id, snapshotId: received.id, judgeUserId: "judge", expectedRoundRevision: opened.revision });
  assert.equal(assignment.status, "needs_review");
  await assert.rejects(f.integration.judging.judgeMaterials(f.principal("judge"), event.eventId, assignment.id), { code: "JUDGE_ACCESS_DENIED" });
  await f.database.query("INSERT INTO fixture_relationships VALUES($1,$2,'judge','clear')", [event.eventId, roster.id]);
  assignment = await f.integration.judging.reviewAssignment(f.principal("ownerA"), event.eventId, assignment.id, { expectedRevision: assignment.revision, reason: "已完成人工关系核查" });
  assignment = await f.integration.judging.declareConflict(f.principal("judge"), event.eventId, assignment.id, { expectedRevision: assignment.revision, hasConflict: false, reason: "本人确认无关联" });
  const score = await f.integration.judging.submitScore(f.principal("judge"), event.eventId, assignment.id, { expectedAssignmentRevision: assignment.revision, expectedScoreRevision: 0, values: { build: 8 }, feedback: "人工评语：原型可用" });
  assert.equal(score.state, "submitted");
  await f.http(`/judging/${other.eventId}/assignments/${assignment.id}/materials`, "GET", "judge", undefined, 404);
  const lock = await f.integration.judging.lockRound(f.principal("ownerA"), event.eventId, opened.id, opened.revision);
  const preview = await f.integration.judging.previewResults(f.principal("ownerA"), event.eventId, lock.id);
  await f.integration.judging.publishResults(f.principal("ownerA"), event.eventId, lock.id, { expectedRevision: lock.revision, expectedSummaryHash: preview.summaryHash, visibility: "public", approvedFeedback: [] });
  const published = await f.http<{ status: string; rows: { total: number }[] }>(`/competitions/${event.eventId}/results`); assert.equal(published.status, "published"); assert.equal(published.rows[0].total, 80);
  assert.ok(f.guardCalls() > 40);
});

test("public reads write nothing and routes reject wrong methods, cross-origin mutations and encoded separators", async t => {
  const f = await fixture(t), event = await f.createEvent(), before = f.statements.length;
  await f.http("/competitions"); await f.http(`/competitions/${event.eventId}`); await f.http(`/competitions/${event.eventId}/registration-form`); await f.http(`/competitions/${event.eventId}/teams/public`); await f.http(`/competitions/${event.eventId}/announcements`); await f.http(`/competitions/${event.eventId}/results`);
  assert.deepEqual(f.statements.slice(before).filter(sql => /^\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER|TRUNCATE)\b/i.test(sql)), []);
  const wrongMethod = await f.integration.handle(f.request(`/competitions/${event.eventId}/my-registration`, "DELETE", "alice"), ["competitions", event.eventId, "my-registration"]);
  assert.equal(wrongMethod?.status, 405); assert.equal(wrongMethod?.headers.get("allow"), "GET, PATCH");
  const rejected = await f.integration.handle(f.request(`/competitions/${event.eventId}/my-registration`, "PATCH", "alice", {}, "http://evil.local"), ["competitions", event.eventId, "my-registration"]); assert.equal(rejected?.status, 403);
  assert.equal((await f.integration.handle(f.request("/competitions/bad/results"), ["competitions", "bad/id", "results"]))?.status, 400);
  assert.equal(await f.integration.handle(f.request("/competitions/unhandled"), ["competitions", "unhandled", "extra"]), null);
});

test("inactive target approval/staff grants roll back all module writes and cached revoked sessions cannot read private data", async t => {
  const f = await fixture(t), application = await f.integration.organizer.createApplication(f.principal("ownerA"), { name: "申请机构", kind: "community", description: "活动", contactName: "联络", contactEmail: "contact@example.org", evidenceText: "活动证据", evidenceUrls: [] });
  await f.database.query("UPDATE auth_users SET status='disabled' WHERE id='ownerA'");
  await assert.rejects(f.integration.organizer.reviewApplication(f.principal("admin"), application.id, { expectedRevision: 1, decision: "approved", note: "核查" }), { code: "TARGET_ACCOUNT_UNAVAILABLE" });
  assert.equal((await f.database.query<{ status: string }>("SELECT status FROM organizer_applications WHERE id=$1", [application.id])).rows[0].status, "pending");
  assert.equal((await f.database.query<{ n: number }>("SELECT count(*)::int AS n FROM organizer_staff_grants")).rows[0].n, 0);
  await f.database.query("UPDATE auth_users SET status='active' WHERE id='ownerA'");
  await f.integration.organizer.reviewApplication(f.principal("admin"), application.id, { expectedRevision: 1, decision: "approved", note: "再次核查" });
  const organization = (await f.integration.organizer.listOrganizations(f.principal("ownerA")))[0];
  await f.database.query("UPDATE auth_users SET status='disabled' WHERE id='staff'");
  await assert.rejects(f.integration.organizer.grantStaff(f.principal("ownerA"), organization.id, { expectedOrganizationRevision: organization.revision, userId: "staff", eventId: null, role: "staff", capabilities: ["event_manage"] }), { code: "TARGET_ACCOUNT_UNAVAILABLE" });
  assert.equal((await f.integration.organizer.listStaffGrants(f.principal("ownerA"), organization.id)).length, 1);
  const cached = f.principal("ownerA"); await f.database.query("UPDATE fixture_sessions SET active=false WHERE user_id='ownerA'");
  await assert.rejects(f.integration.organizer.listOwnApplications(cached), { code: "SESSION_INVALID" });
});

test("space linking requires current manager/revision/captain and does not grant organizer access; former space participant is a judging conflict", async t => {
  const f = await fixture(t, { manualReview: true, projectBridge: true }), event = await f.createEvent(), roster = await f.team(event), instant = "2026-10-01T00:00:00Z";
  await f.projectRepository.createProject({ project: { id: "private-project", name: "私人空间", teamId: null, eventId: null, createdBy: "alice", goal: "PRIVATE_GOAL", minimumDeliverable: "PRIVATE_SCOPE", stage: "preparing", timezone: "Asia/Shanghai", deadline: null, deadlineSource: "unknown", revision: 1, createdAt: instant, updatedAt: instant },
    members: [{ membershipId: "alice-membership", projectId: "private-project", userId: "alice", role: "manager", status: "active", revision: 1, joinedAt: instant, leftAt: null }, { membershipId: "former-membership", projectId: "private-project", userId: "former", role: "member", status: "left", revision: 2, joinedAt: instant, leftAt: "2026-10-02T00:00:00Z" }], invitations: [], availability: [], bookmarks: [], activities: [], facts: [] });
  const link = await f.integration.registration.requestProjectLink(f.principal("alice"), event.eventId, roster.id, { expectedRevision: roster.revision, projectId: "private-project", idempotencyKey: "request-project" });
  const command = { expectedRevision: link.revision, expectedProjectRevision: 1, expectedTeamRevision: roster.revision, idempotencyKey: "confirm-project" };
  await assert.rejects(f.integration.registration.confirmProjectLink(f.principal("ownerA"), event.eventId, roster.id, link.id, command), { code: "PROJECT_MANAGER_REQUIRED" });
  await assert.rejects(f.integration.registration.confirmProjectLink(f.principal("alice"), event.eventId, roster.id, link.id, { ...command, expectedProjectRevision: 2 }), { code: "PROJECT_REVISION_CONFLICT" });
  const confirmed = await f.integration.registration.confirmProjectLink(f.principal("alice"), event.eventId, roster.id, link.id, command); assert.equal(confirmed.projectId, "private-project");
  assert.equal(await f.projectRepository.getMembership("private-project", "ownerA"), null);
  await f.database.transaction(async sql => {
    const known = await f.integration.conflicts.inspect(sql, { eventId: event.eventId, teamId: roster.id, judgeUserId: "former" }); assert.equal(known.status, "conflict");
    const unknown = await f.integration.conflicts.inspect(sql, { eventId: event.eventId, teamId: roster.id, judgeUserId: "judge" }); assert.equal(unknown.status, "needs_review");
  });
  const publicPayload = JSON.stringify(await f.http(`/competitions/${event.eventId}/teams/public`)); assert.ok(!publicPayload.includes("private-project")); assert.ok(!publicPayload.includes("PRIVATE_GOAL"));
});

test("an unconfigured project or relationship bridge remains explicit instead of fabricating a permission or AI success", async t => {
  const f = await fixture(t), event = await f.createEvent(), roster = await f.team(event);
  await assert.rejects(f.database.transaction(sql => f.integration.projectLinks.confirmLink(sql, f.principal("alice"), { eventId: event.eventId, teamId: roster.id, projectId: "private-project", expectedProjectRevision: 1 })), { code: "PROJECT_LINK_UNCONFIGURED" });
  const unknown = await f.database.transaction(sql => f.integration.conflicts.inspect(sql, { eventId: event.eventId, teamId: roster.id, judgeUserId: "judge" })); assert.equal(unknown.status, "needs_review");
  assert.equal(f.integration.capabilities.manualRelationshipReview, false); assert.equal(f.integration.capabilities.officialTrackConfiguration, false);
});

test("registration withdrawal invalidates the actual frozen roster before a previously previewed receipt can commit", async t => {
  const f = await fixture(t), event = await f.createEvent(), roster = await f.team(event), materials: SubmissionMaterials = { title: "待确认版本", description: "实际用户预览", links: [], files: [] };
  const preview = await f.integration.judging.previewSubmission(f.principal("alice"), event.eventId, { teamId: roster.id, materials });
  const current = (await f.integration.registration.getMine(f.principal("alice"), event.eventId)).registration!;
  await f.integration.registration.withdraw(f.principal("alice"), event.eventId, { expectedRevision: current.revision, idempotencyKey: "withdraw-before-receipt" });
  await assert.rejects(f.integration.judging.submit(f.principal("alice"), event.eventId, { teamId: roster.id, materials, expectedEventRevision: preview.eventRevision, expectedTeamRevision: preview.teamRevision, expectedPreviousVersion: preview.previousVersion, expectedMaterialHash: preview.materialHash, idempotencyKey: "old-preview" }), { code: "TEAM_NOT_ELIGIBLE" });
  assert.equal((await f.database.query<{ n: number }>("SELECT count(*)::int AS n FROM ej_intake_receipts")).rows[0].n, 0);
  const actual = await f.database.transaction(sql => f.integration.registration.getTeam(sql, event.eventId, roster.id)); assert.equal(actual?.eligible, false);
});
