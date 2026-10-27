import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import type { OrganizerPrincipal } from "../shared/organizer-contracts.ts";
import { DomainError } from "../shared/errors.ts";
import { createOrganizerService, type HostedEvent } from "../modules/organizer/index.ts";
import { createEventRegistrationService } from "../modules/event-registration/index.ts";
import { createEventCommunicationService } from "../modules/event-communication/index.ts";
import { createOrganizerNotifications, type OrganizerNotificationDependencies, type SelectionNotice } from "./organizer-notifications.ts";

type Mail = Parameters<NonNullable<OrganizerNotificationDependencies["transport"]>["send"]>[0];
/** True root/module SQL in a fresh memory engine; no environment, production directory or real email. */
async function fixture(t: TestContext, options: { configured?: boolean; timeoutMs?: number;getOrganizationSender?:OrganizerNotificationDependencies["getOrganizationSender"];countOrganizationSenders?:()=>Promise<number> } = {}) {
 const engine = new PGlite(); await engine.waitReady; t.after(() => engine.close());
 await engine.exec("CREATE TABLE auth_users(id text PRIMARY KEY,email text UNIQUE,display_name text,status text,email_verified_at timestamptz,platform_roles text[],bio text); CREATE TABLE notice_sessions(user_id text PRIMARY KEY REFERENCES auth_users(id),active boolean NOT NULL);");
 for (const path of ["../../migrations/042_organizer_core.sql", "../../migrations/043_event_registration.sql", "../../migrations/044_event_communication.sql", "./organizer-notifications-schema.sql"]) await engine.exec(await readFile(new URL(path, import.meta.url), "utf8"));
 const ambient = new AsyncLocalStorage<SqlExecutor>(), statements: string[] = [], mails: Mail[] = [];
 let nextId = 0, savepoint = 0, guards = 0, failGuardAt = -1;
 const time = { value: Date.parse("2026-10-11T04:00:00Z") }, clock = { now: () => new Date(time.value) }, ids = { next: () => `notice-${++nextId}` };
 const executor = (query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>): SqlExecutor => ({
  async query<Row>(sql: string, values: readonly unknown[] = []) { statements.push(sql); const result = await query(sql, [...values]); return { rows: result.rows as Row[], rowCount: result.rows.length || result.affectedRows || 0 }; },
 });
 const direct = executor((sql, values) => engine.query(sql, values));
 const database: DatabasePort = {
  query: (sql, values) => (ambient.getStore() ?? direct).query(sql, values),
  async transaction(work) {
   const current = ambient.getStore();
   if (current) { const name = `notices_${++savepoint}`; await current.query(`SAVEPOINT ${name}`); try { const result = await work(current); await current.query(`RELEASE SAVEPOINT ${name}`); return result; } catch (error) { await current.query(`ROLLBACK TO SAVEPOINT ${name}`); await current.query(`RELEASE SAVEPOINT ${name}`); throw error; } }
   return engine.transaction(tx => { const sql = executor((statement, values) => tx.query(statement, values)); return ambient.run(sql, () => work(sql)); });
  },
 };
 const roles: Record<string, Actor["platformRoles"]> = Object.fromEntries(["ownerA", "ownerB", "alice", "bob", "carol", "registrationStaff", "communicationStaff", "eventManager", "disabled", "unverified"].map(id => [id, ["user"]])); roles.admin = ["user", "admin"];
 for (const [userId, role] of Object.entries(roles)) { await database.query("INSERT INTO auth_users VALUES($1,$2,$3,$4,$5,$6,$7)", [userId, `${userId.toLowerCase()}@example.org`, userId === "alice" ? "小明 <script>alert(1)</script>" : `称呼-${userId}`, userId === "disabled" ? "disabled" : "active", userId === "unverified" ? null : "2026-10-01", role, `PRIVATE_PROFILE_${userId}`]); await database.query("INSERT INTO notice_sessions VALUES($1,true)", [userId]); }
 const principal = (userId: string): OrganizerPrincipal => ({ actor: { userId, platformRoles: roles[userId] }, async guard(sql) {
  guards++; const user = (await sql.query<{ status: string; email_verified_at: Date | null; platform_roles: string[] }>("SELECT status,email_verified_at,platform_roles FROM auth_users WHERE id=$1 FOR SHARE", [userId])).rows[0];
  const session = (await sql.query("SELECT user_id FROM notice_sessions WHERE user_id=$1 AND active FOR SHARE", [userId])).rowCount;
  if (guards === failGuardAt || !user || user.status !== "active" || !user.email_verified_at || !session || JSON.stringify(user.platform_roles) !== JSON.stringify(roles[userId])) throw new DomainError("CURRENT_SESSION_REQUIRED", "当前账号或会话不可用。", { status: 401 });
 } });
 const organizer = createOrganizerService({ database, clock, ids });
 const registration = createEventRegistrationService({ database, events: organizer.eventAccess, clock, ids, projectLinks: { async confirmLink() { throw new Error("No private project linking in this fixture."); } } });
 let communication: ReturnType<typeof createEventCommunicationService>;
 const transportState = { mode: "accepted" as "accepted" | "throw" | "timeout", callback: null as ((mail: Mail) => Promise<void>) | null };
 const create = () => createOrganizerNotifications({ database, clock, ids, getEvents: () => organizer.eventAccess, getRegistration: () => registration, getCommunication: () => communication,
  resolvePrincipal: async request => { const id = request.headers.get("x-fixture-user"); return id && roles[id] ? principal(id) : null; },
  assertMutationAllowed: async request => { if (request.headers.get("origin") !== "http://test.local") throw new DomainError("ORIGIN_DENIED", "来源无效。", { status: 403 }); },
  ...(options.configured === false ? {} : { from: "notice@example.org", transport: { async send(mail: Mail, value: { signal: AbortSignal }) {
   assert.equal(ambient.getStore(), undefined, "Provider is called after the sending transaction committed.");
   mails.push(mail); if (transportState.callback) await transportState.callback(mail);
   if (transportState.mode === "throw") throw new Error("SECRET_PROVIDER_ERROR_AND_EMAIL");
   if (transportState.mode === "timeout") { await new Promise<void>(resolve => value.signal.addEventListener("abort", () => resolve(), { once: true })); return; }
  } } }),getOrganizationSender:options.getOrganizationSender,countOrganizationSenders:options.countOrganizationSenders, origin: "https://test.example.org", timeoutMs: options.timeoutMs ?? 1000, leaseMs: 60000,
 });
 const module = create(); communication = createEventCommunicationService({ database, clock, ids, eventAccess: organizer.eventAccess, participation: registration, notification: module.notification, announcementAudience: module.announcementAudience });
 const organizations = new Map<string, string>();
 async function event(owner = "ownerA", title = "AI新手赛", reviewRequired = false): Promise<HostedEvent> {
  let organizationId = organizations.get(owner);
  if (!organizationId) { const application = await organizer.createApplication(principal(owner), { name: `机构-${owner}`, kind: "community", description: "活动组织", contactName: "联系人", contactEmail: "contact@example.org", evidenceText: "活动依据", evidenceUrls: [] }); await organizer.reviewApplication(principal("admin"), application.id, { expectedRevision: application.revision, decision: "approved", note: "隔离人工核查" }); organizationId = application.organizationId; organizations.set(owner, organizationId); }
  const organization = (await organizer.listOrganizations(principal(owner))).find(row => row.id === organizationId)!;
  const created = await organizer.createEvent(principal(owner), organizationId, { title, templateKey: "online", expectedOrganizationRevision: organization.revision, timezone: "Asia/Shanghai", startsAt: "2026-10-20T02:00:00Z", endsAt: "2026-10-22T10:00:00Z", registrationOpensAt: "2026-10-01T00:00:00Z", registrationClosesAt: "2026-10-19T10:00:00Z", submissionClosesAt: null, modules: { registration: true, teams: true, judging: false, schedule: false, icebreaking: false, accommodation: false, mealVouchers: false }, registration: { reviewRequired, capacity: 30 }, teams: { mode: "free", minSize: 1, maxSize: 5, locksAt: null }, summary: "公开活动", rules: "公开规则", location: "线上" });
  await registration.saveForm(principal(owner), created.eventId, { expectedRevision: 0, title: "报名", description: "免费报名", fields: [], changeNote: "首次发布" });
  return organizer.publishEvent(principal(owner), created.eventId, { expectedRevision: created.revision, changeSummary: "首次发布" });
 }
 async function register(event: HostedEvent, userId = "alice") {
  const form = (await registration.getRegistrationForm(event.eventId)).form!;
  const draft = await registration.saveDraft(principal(userId), event.eventId, { expectedRevision: 0, formRevision: form.revision, answers: {} });
  return registration.submit(principal(userId), event.eventId, { expectedRevision: draft.revision, idempotencyKey: `submit-${userId}-${event.eventId}` });
 }
 async function grant(event: HostedEvent, userId: string, capabilities: ("event_manage" | "registration_manage" | "communication_manage")[]) { const organization = (await organizer.listOrganizations(principal("ownerA"))).find(row => row.id === event.organizationId)!; return organizer.grantStaff(principal("ownerA"), event.organizationId, { expectedOrganizationRevision: organization.revision, userId, eventId: event.eventId, role: "staff", capabilities }); }
 async function announcement(event: HostedEvent, user = "ownerA", body: Record<string, unknown> = {}) { return communication.publishAnnouncement(principal(user), event.eventId, { title: "比赛安排提醒", body: "请在比赛页核对赛程和准备事项。", important: true, impact: "需要参赛者确认", ...body }); }
 const templateInput = { expectedRevision: 0, subject: "你已入选 {event}", body: "{name}，你好！\n由 {organizer} 邀请你参加 {event}。<img src=x onerror=alert(1)>", accent: "orange", theme: "letter" };
 async function selection(event: HostedEvent, userId = "alice", override: Record<string, unknown> = {}) { const reg = await database.transaction(sql => registration.getRegistration(sql, event.eventId, userId)); assert.ok(reg); return module.publishSelection(principal("ownerA"), event.eventId, { recipientUserId: userId, expectedRegistrationRevision: reg.revision, templateRevision: 1, expectedNoticeVersion: 0, ...override }); }
 const request = (path: string, method = "GET", user?: string, body?: unknown, origin = "http://test.local") => new Request(`http://test.local/api/v1${path}`, { method, headers: { origin, ...(user ? { "x-fixture-user": user } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
 async function http<T>(path: string, method = "GET", user?: string, body?: unknown, expected = 200) { const response = await module.handle(request(path, method, user, body), path.split("?")[0].slice(1).split("/")); assert.ok(response); const payload = await response.json(); assert.equal(response.status, expected, JSON.stringify(payload)); assert.match(response.headers.get("cache-control") ?? "", /no-store/); return payload.data as T; }
 return { database, module, create, organizer, registration, communication, principal, event, register, grant, announcement, selection, templateInput, mails, transportState, time, http, request, statements, ambient, failNextFinalGuard: () => { failGuardAt = guards + 2; } };
}

test("organization sender takes priority; an unconfigured organization uses website fallback without crossing organizations",async t=>{
 const custom:Mail[]=[],selected={organizationId:""};
 const f=await fixture(t,{getOrganizationSender:async(_sql,id)=>id===selected.organizationId?{from:"own@qq.com",transport:{async send(mail){custom.push(mail);}}}:null,countOrganizationSenders:async()=>1});
 const a=await f.event(),b=await f.event("ownerB","另一机构比赛");selected.organizationId=a.organizationId;
 await f.register(a,"alice");await f.register(b,"bob");
 await f.announcement(a);await f.announcement(b,"ownerB");
 assert.equal((await f.module.drain()).accepted,2);assert.equal(custom.length,1);assert.equal(custom[0].from,"own@qq.com");assert.equal(f.mails.length,1);assert.equal(f.mails[0].from,"notice@example.org");assert.equal((await f.module.counts()).organizationSenders,1);
});
test("organization mail works without platform SMTP; disabled sender pauses unsent work, never replays an unknown result",async t=>{
 let enabled=true,sendCount=0;const f=await fixture(t,{configured:false,getOrganizationSender:async()=>enabled?{from:"own@qq.com",transport:{async send(){sendCount++;throw new Error("UNKNOWN_PROVIDER_RESULT");}}}:null,countOrganizationSenders:async()=>enabled?1:0});
 const event=await f.event();await f.register(event,"alice");await f.announcement(event);
 enabled=false;assert.equal((await f.module.drain()).claimed,0);assert.equal((await f.module.counts()).queued,1);
 enabled=true;f.time.value+=60_001;assert.equal((await f.module.drain()).held,1);assert.equal(sendCount,1);
 await f.create().drain();assert.equal(sendCount,1);assert.equal((await f.module.counts()).held,1);
});
test("actual published announcements enqueue exact current approved recipients in the publishing transaction and deduplicate", async t => {
 const f = await fixture(t), event = await f.event(), other = await f.event("ownerB", "另一赛"); await f.register(event); await f.register(event, "bob"); await f.register(other, "carol");
 await f.database.query("UPDATE auth_users SET email_verified_at=NULL WHERE id='bob'");
 const notice = await f.announcement(event); assert.equal(notice.notification.state, "queued"); assert.equal(f.mails.length, 0);
 const repeat = await f.database.transaction(sql => f.module.notification.enqueue(sql, { eventId: event.eventId, announcementId: notice.id, revision: notice.revision, recipientUserIds: ["alice", "alice"] })); assert.deepEqual(repeat, notice.notification);
 assert.equal((await f.database.query<{ n: number }>("SELECT count(*)::int AS n FROM organizer_notification_outbox")).rows[0].n, 1);
 await assert.rejects(f.database.transaction(sql => f.module.notification.enqueue(sql, { eventId: event.eventId, announcementId: notice.id, revision: notice.revision, recipientUserIds: ["carol"] })), { code: "FORBIDDEN" });
 assert.equal((await f.module.drain()).accepted, 1); assert.equal(f.mails[0].to, "alice@example.org");
 assert.equal((await f.module.drain()).claimed, 0); assert.deepEqual(await f.module.counts(), { configured: true, websiteConfigured:true, organizationSenders:0, queued: 0, accepted: 1, held: 0, failed: 0, cancelled: 0, sending: 0 });
 const cols = (await f.database.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name='organizer_notification_outbox'")).rows.map(row => row.column_name); assert.ok(!cols.some(name => /email|subject|body/.test(name)));
});

test("unconfigured transport keeps honest announcement status and durable personal selection notice without any mail queue", async t => {
 const f = await fixture(t, { configured: false }), event = await f.event(); await f.register(event); const announcement = await f.announcement(event); assert.deepEqual(announcement.notification, { state: "unconfigured", referenceId: null });
 await f.module.saveTemplate(f.principal("ownerA"), event.eventId, f.templateInput); const notice = await f.selection(event); assert.equal(notice.mailState, "unconfigured");
 assert.equal((await f.module.listSelection(f.principal("alice"), event.eventId)).items[0].id, notice.id); assert.equal((await f.module.counts()).queued, 0); assert.equal((await f.module.drain()).configured, false); assert.equal(f.mails.length, 0);
});

test("announcement/outbox and template/selection notice roll back entirely when the final current session guard fails", async t => {
 const f = await fixture(t), event = await f.event(); await f.register(event);
 f.failNextFinalGuard(); await assert.rejects(f.announcement(event), { code: "CURRENT_SESSION_REQUIRED" });
 for (const table of ["ec_announcements", "ec_announcement_versions", "organizer_notification_outbox", "organizer_notification_batches"]) assert.equal((await f.database.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
 f.failNextFinalGuard(); await assert.rejects(f.module.saveTemplate(f.principal("ownerA"), event.eventId, f.templateInput), { code: "CURRENT_SESSION_REQUIRED" }); assert.equal((await f.module.getTemplate(f.principal("ownerA"), event.eventId)).revision, 0);
 await f.module.saveTemplate(f.principal("ownerA"), event.eventId, f.templateInput); f.failNextFinalGuard(); await assert.rejects(f.selection(event), { code: "CURRENT_SESSION_REQUIRED" }); assert.equal((await f.module.listSelection(f.principal("alice"), event.eventId)).items.length, 0); assert.equal((await f.module.counts()).queued, 0);
});

test("template staff permission, exact event isolation, origin and current session are enforced with literal finite input", async t => {
 const f = await fixture(t), event = await f.event(), other = await f.event("ownerA", "同机构另一赛"); await f.grant(event, "registrationStaff", ["registration_manage"]); await f.grant(event, "eventManager", ["event_manage"]);
 const path = `/organizer/events/${event.eventId}/selection-notice-template`;
 await f.http(path, "GET", undefined, undefined, 401); for (const user of ["alice", "ownerB", "admin", "eventManager"]) await f.http(path, "GET", user, undefined, 403);
 await f.http(`/organizer/events/${other.eventId}/selection-notice-template`, "GET", "registrationStaff", undefined, 403);
 const first = await f.http<{ revision: number }>(path, "PUT", "registrationStaff", f.templateInput); assert.equal(first.revision, 1);
 await f.http(path, "PUT", "registrationStaff", f.templateInput, 409);
 for (const wrong of [{ ...f.templateInput, expectedRevision: 1, accent: "#123456" }, { ...f.templateInput, expectedRevision: 1, theme: "custom", css: "body{}" }, { ...f.templateInput, expectedRevision: 1, body: "{password}" }, { ...f.templateInput, expectedRevision: 1, subject: "subject\r\nBcc:evil" }]) await f.http(path, "PUT", "registrationStaff", wrong, 422);
 const csrf = await f.module.handle(f.request(path, "PUT", "registrationStaff", { ...f.templateInput, expectedRevision: 1 }, "http://evil.local"), path.slice(1).split("/")); assert.equal(csrf?.status, 403);
 await f.database.query("UPDATE notice_sessions SET active=false WHERE user_id='registrationStaff'"); await f.http(path, "GET", "registrationStaff", undefined, 401);
});

test("selection publication requires current approved registration revision, saved template and verified active account", async t => {
 const f = await fixture(t), event = await f.event("ownerA", "审核制比赛", true), pending = await f.register(event); await f.module.saveTemplate(f.principal("ownerA"), event.eventId, f.templateInput);
 await assert.rejects(f.selection(event), { code: "NOTICE_APPROVAL_REQUIRED" }); const approved = await f.registration.review(f.principal("ownerA"), event.eventId, pending.id, { expectedRevision: pending.revision, decision: "approved", note: "符合本场资格", idempotencyKey: "approve-alice" });
 await assert.rejects(f.selection(event, "alice", { expectedRegistrationRevision: pending.revision }), { code: "NOTICE_REVISION_CONFLICT" });
 await f.database.query("UPDATE auth_users SET email_verified_at=NULL WHERE id='alice'"); await assert.rejects(f.selection(event), { code: "NOTICE_RECIPIENT_UNAVAILABLE" });
 await f.database.query("UPDATE auth_users SET email_verified_at='2026-10-01' WHERE id='alice'"); const notice = await f.selection(event); assert.equal(notice.registrationRevision, approved.revision); assert.equal(notice.mailState, "queued");
 const other = await f.event("ownerB", "另一机构赛"); await assert.rejects(f.module.publishSelection(f.principal("ownerA"), other.eventId, { recipientUserId: "alice", expectedRegistrationRevision: approved.revision, templateRevision: 1, expectedNoticeVersion: 0 }), { status: 403 });
});

test("selection version and operation receipts prevent silent or duplicate resend while allowing explicit confirmed new version", async t => {
 const f = await fixture(t), event = await f.event(); await f.register(event); await f.module.saveTemplate(f.principal("ownerA"), event.eventId, f.templateInput);
 const first = await f.selection(event), replay = await f.selection(event); assert.equal(replay.id, first.id); assert.equal((await f.module.counts()).queued, 1);
 await assert.rejects(f.selection(event, "alice", { newOperationKey: "changed-key" }), { code: "NOTICE_INVALID_INPUT" });
 await f.module.saveTemplate(f.principal("ownerA"), event.eventId, { ...f.templateInput, expectedRevision: 1, body: "新版入选须知 {name}" }); await assert.rejects(f.selection(event, "alice", { templateRevision: 2 }), { code: "NOTICE_REVISION_CONFLICT" });
 const second = await f.selection(event, "alice", { templateRevision: 2, expectedNoticeVersion: 1, confirmNewVersion: true, newOperationKey: "confirm-notice-2" }); assert.equal(second.version, 2); assert.match(second.body, /新版/);
 assert.equal((await f.selection(event, "alice", { templateRevision: 2, expectedNoticeVersion: 1, confirmNewVersion: true, newOperationKey: "confirm-notice-2" })).id, second.id);
 await assert.rejects(f.selection(event, "alice", { templateRevision: 2, expectedNoticeVersion: 2, confirmNewVersion: true, newOperationKey: "confirm-notice-2" }), { code: "NOTICE_REVISION_CONFLICT" });
 await assert.rejects(f.selection(event, "alice", { templateRevision: 2, expectedNoticeVersion: 1, confirmNewVersion: true, newOperationKey: "another-key" }), { code: "NOTICE_REVISION_CONFLICT" });
 assert.equal((await f.module.counts()).queued, 2); await assert.rejects(f.database.query("UPDATE organizer_selection_notices SET body='overwrite'"), /immutable/); await assert.rejects(f.database.query("DELETE FROM organizer_selection_template_versions"), /immutable/);
});

test("personal and staff GET use smallest authorized projections and perform no mutations or transport calls", async t => {
 const f = await fixture(t), event = await f.event(), other = await f.event("ownerA", "另一赛"); await f.register(event); await f.register(event, "bob"); await f.grant(event, "registrationStaff", ["registration_manage"]); await f.module.saveTemplate(f.principal("ownerA"), event.eventId, f.templateInput); const notice = await f.selection(event);
 const before = f.statements.length;
 const managed = await f.http<{ items: SelectionNotice[]; recipient: { userId: string; label: string }; registrationRevision: number }>(`/organizer/events/${event.eventId}/selection-notices?recipientUserId=alice`, "GET", "registrationStaff"); assert.equal(managed.items[0].id, notice.id); assert.equal(managed.recipient.userId, "alice");
 const own = await f.http<{ items: SelectionNotice[] }>(`/competitions/${event.eventId}/selection-notices`, "GET", "alice"); assert.equal(own.items.length, 1);
 const empty = await f.http<{ items: SelectionNotice[] }>(`/competitions/${event.eventId}/selection-notices?recipientUserId=alice`, "GET", "bob"); assert.equal(empty.items.length, 0);
 await f.http(`/competitions/${other.eventId}/selection-notices`, "GET", "alice", undefined, 404); await f.http(`/organizer/events/${other.eventId}/selection-notices?recipientUserId=alice`, "GET", "registrationStaff", undefined, 403);
 await f.module.counts(); await f.module.getTemplate(f.principal("ownerA"), event.eventId);
 assert.deepEqual(f.statements.slice(before).filter(sql => /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER)\b/i.test(sql)), []); assert.equal(f.mails.length, 0);
 assert.doesNotMatch(JSON.stringify(managed) + JSON.stringify(own), /example\.org|PRIVATE_PROFILE|published_by|operation_key/);
});

test("worker uses escaped finite-style HTML and accepts provider acknowledgement without claiming delivery", async t => {
 const f = await fixture(t), event = await f.event(); await f.register(event); await f.module.saveTemplate(f.principal("ownerA"), event.eventId, f.templateInput); await f.selection(event);
 f.transportState.callback = async () => { assert.equal((await f.module.counts()).sending, 1); };
 const result = await f.module.drain(); assert.equal(result.accepted, 1); assert.match(f.mails[0].html!, /&lt;script&gt;/); assert.match(f.mails[0].html!, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.doesNotMatch(f.mails[0].html!, /<script>|<img /); assert.match(f.mails[0].text, /小明 <script>/);
 assert.equal((await f.module.listSelection(f.principal("alice"), event.eventId)).items[0].mailState, "accepted"); assert.doesNotMatch(JSON.stringify(await f.module.counts()), /delivered/);
});

test("worker cancels withdrawn announcements, superseded exact versions and currently withdrawn recipients", async t => {
 const f = await fixture(t), event = await f.event(); const reg = await f.register(event), first = await f.announcement(event); await f.communication.withdrawAnnouncement(f.principal("ownerA"), event.eventId, first.id, { expectedRevision: first.revision }); assert.equal((await f.module.drain()).cancelled, 1);
 const second = await f.announcement(event); await f.announcement(event, "ownerA", { announcementId: second.id, expectedRevision: second.revision, body: "本次正式更新" }); const after = await f.module.drain(); assert.equal(after.cancelled, 1); assert.equal(after.accepted, 1);
 await f.announcement(event); await f.registration.withdraw(f.principal("alice"), event.eventId, { expectedRevision: reg.revision, idempotencyKey: "withdraw" }); assert.equal((await f.module.drain()).cancelled, 1); assert.equal(f.mails.length, 1);
});

test("publisher staff revocation, current registration revision and organization suspension cancel unsent notices", async t => {
 const f = await fixture(t), event = await f.event(); const reg = await f.register(event), grant = await f.grant(event, "communicationStaff", ["communication_manage"]); await f.announcement(event, "communicationStaff"); await f.organizer.revokeStaff(f.principal("ownerA"), grant.id, { expectedRevision: grant.revision }); assert.equal((await f.module.drain()).cancelled, 1);
 await f.module.saveTemplate(f.principal("ownerA"), event.eventId, f.templateInput); await f.selection(event); await f.registration.review(f.principal("ownerA"), event.eventId, reg.id, { expectedRevision: reg.revision, decision: "approved", note: "再次核查", idempotencyKey: "review-again" }); assert.equal((await f.module.drain()).cancelled, 1);
 await f.announcement(event); // O01 root state fixture mutation represents approved organization suspension, without exercising production DB.
 await f.database.query("UPDATE organizer_organizations SET status='suspended',document=jsonb_set(document,'{status}','\"suspended\"'::jsonb) WHERE id=$1", [event.organizationId]); assert.equal((await f.module.drain()).cancelled, 1); assert.equal(f.mails.length, 0);
});

test("ambiguous failure or timeout is durably held across new worker construction and never retried or logged verbatim", async t => {
 const f = await fixture(t, { timeoutMs: 5 }), event = await f.event(); await f.register(event); await f.announcement(event); f.transportState.mode = "throw"; assert.equal((await f.module.drain()).held, 1);
 await f.announcement(event); f.transportState.mode = "timeout"; assert.equal((await f.module.drain()).held, 1); assert.equal(f.mails.length, 2);
 f.time.value += 86400000; const restarted = f.create(); f.transportState.mode = "accepted"; assert.equal((await restarted.drain()).claimed, 0); assert.equal(f.mails.length, 2); assert.equal((await restarted.counts()).held, 2);
 assert.doesNotMatch(JSON.stringify((await f.database.query("SELECT * FROM organizer_notification_transitions")).rows), /SECRET_PROVIDER|example\.org|比赛安排提醒/);
});

test("expired claimed lease can be reclaimed before sending, but persisted sending is held without replay", async t => {
 const f = await fixture(t), event = await f.event(); await f.register(event); await f.announcement(event); await f.announcement(event);
 const rows = (await f.database.query<{ id: string }>("SELECT id FROM organizer_notification_outbox ORDER BY sequence")).rows;
 await f.database.query("UPDATE organizer_notification_outbox SET state='leased',lease_token='old-lease',lease_until='2026-10-11T03:59:59Z' WHERE id=$1", [rows[0].id]);
 await f.database.query("UPDATE organizer_notification_outbox SET state='sending',lease_token='old-sending',lease_until='2026-10-11T03:59:59Z',sending_at='2026-10-11T03:59:00Z' WHERE id=$1", [rows[1].id]);
 const result = await f.module.drain({ batchSize: 10 }); assert.equal(result.accepted, 1); assert.equal(result.held, 1); assert.equal(f.mails.length, 1); assert.equal((await f.create().drain()).claimed, 0);
 await assert.rejects(f.module.drain({ batchSize: 11 }), { code: "NOTICE_INVALID_INPUT" });
});

test("overlapping drain calls claim each queue item once, while ordinary edits retain the last exact published announcement", async t => {
 const f = await fixture(t), event = await f.event(); await f.register(event); const announcement = await f.announcement(event);
 await f.communication.saveAnnouncementDraft(f.principal("ownerA"), event.eventId, { announcementId: announcement.id, expectedRevision: announcement.revision, title: "尚未发布的更改", body: "私人草稿内容", important: false });
 const outputs = await Promise.all([f.module.drain(), f.create().drain()]); assert.equal(outputs.reduce((sum, result) => sum + result.accepted, 0), 1); assert.equal(f.mails.length, 1); assert.equal(f.mails[0].subject, announcement.title); assert.doesNotMatch(f.mails[0].text, /私人草稿/);
});

test("qualification revoked after a durable lease is caught again immediately before sending", async t => {
 const f = await fixture(t), event = await f.event(), registration = await f.register(event); await f.announcement(event);
 const transaction = f.database.transaction.bind(f.database); let changed = false;
 f.database.transaction = async work => {
  const value = await transaction(work);
  if (!changed && value && typeof value === "object" && "lease_token" in value) { changed = true; await f.registration.withdraw(f.principal("alice"), event.eventId, { expectedRevision: registration.revision, idempotencyKey: "withdraw-between-lease-send" }); }
  return value;
 };
 const result = await f.module.drain(); assert.equal(result.claimed, 1); assert.equal(result.cancelled, 1); assert.equal(result.accepted, 0); assert.equal(f.mails.length, 0);
});

test("current disabled or unverified recipients cancel and malformed mail content fails before touching transport", async t => {
 const f = await fixture(t), event = await f.event(); await f.register(event); await f.announcement(event); await f.database.query("UPDATE auth_users SET status='disabled' WHERE id='alice'"); assert.equal((await f.module.drain()).cancelled, 1);
 await f.database.query("UPDATE auth_users SET status='active' WHERE id='alice'"); await f.announcement(event); await f.database.query("UPDATE auth_users SET email_verified_at=NULL WHERE id='alice'"); assert.equal((await f.module.drain()).cancelled, 1);
 await f.database.query("UPDATE auth_users SET email_verified_at='2026-10-01' WHERE id='alice'"); await f.announcement(event, "ownerA", { title: "标题\n包含换行" }); assert.equal((await f.module.drain()).failed, 1); assert.equal((await f.module.counts()).failed, 1); assert.equal(f.mails.length, 0);
});

test("explicit batching is bounded, wrong HTTP methods disclose Allow, and excessive streamed JSON is rejected", async t => {
 const f = await fixture(t), event = await f.event(); await f.register(event);
 for (let index = 0; index < 11; index++) await f.announcement(event, "ownerA", { title: `批次通知${index}` });
 assert.equal((await f.module.drain({ batchSize: 10 })).accepted, 10); assert.equal((await f.module.counts()).queued, 1); assert.equal((await f.module.drain({ batchSize: 1 })).accepted, 1);
 const path = `/organizer/events/${event.eventId}/selection-notices`;
 const wrong = await f.module.handle(f.request(path, "PUT", "ownerA", {}), path.slice(1).split("/")); assert.equal(wrong?.status, 405); assert.equal(wrong?.headers.get("allow"), "GET, POST");
 await f.http(`${path}?recipientUserId=alice&recipientUserId=bob`, "GET", "ownerA", undefined, 422);
 await f.http(`/organizer/events/${event.eventId}/selection-notice-template`, "PUT", "ownerA", { ...f.templateInput, body: "a".repeat(65536) }, 413);
 assert.equal(await f.module.handle(f.request("/unrelated", "GET", "ownerA"), ["unrelated"]), null);
});

test("repeated literal placeholders cannot inflate a selection message beyond the rendered size bound", async t => {
 const f = await fixture(t), event = await f.event(); await f.register(event);
 await f.module.saveTemplate(f.principal("ownerA"), event.eventId, { ...f.templateInput, body: "{name}".repeat(1500) });
 await assert.rejects(f.selection(event), { code: "NOTICE_INVALID_INPUT" });
 assert.equal((await f.module.listSelection(f.principal("alice"), event.eventId)).items.length, 0); assert.equal((await f.module.counts()).queued, 0);
});

test("many unconfigured queued messages defer durably without blocking another organization's single-item worker", async t => {
 const state={pausedOrganizationId:""},sent:Mail[]=[];
 const f=await fixture(t,{configured:false,getOrganizationSender:async(_sql,id)=>id===state.pausedOrganizationId?null:{from:"own@qq.com",transport:{async send(mail){sent.push(mail);}}}});
 const a=await f.event(),b=await f.event("ownerB","可发送机构");await f.register(a,"alice");await f.register(b,"bob");
 for(let i=0;i<20;i++)await f.announcement(a,"ownerA",{title:`待配置通知${i}`});
 await f.announcement(b,"ownerB");state.pausedOrganizationId=a.organizationId;
 for(let i=0;i<20;i++)assert.equal((await f.module.drain({batchSize:1})).claimed,0);
 assert.equal((await f.create().drain({batchSize:1})).accepted,1,"a new worker keeps the deferrals and reaches the configured organization");
 assert.equal(sent.length,1);assert.equal(sent[0].to,"bob@example.org");
 const rows=(await f.database.query<{state:string;reason:string;next_attempt_at:Date}>("SELECT state,reason,next_attempt_at FROM organizer_notification_outbox WHERE organization_id=$1",[a.organizationId])).rows;
 assert.equal(rows.length,20);assert.ok(rows.every(row=>row.state==='queued'&&row.reason==='sender_unconfigured'&&new Date(row.next_attempt_at).getTime()>f.time.value));
 assert.equal((await f.module.counts()).held,0);assert.equal((await f.module.counts()).queued,20);
});

test("rendered title is validated at the SMTP 998 character limit before any notice or outbox is committed",async t=>{
 const f=await fixture(t),event=await f.event("ownerA","赛".repeat(160));await f.register(event);
 await f.module.saveTemplate(f.principal("ownerA"),event.eventId,{...f.templateInput,subject:"{event}".repeat(6)+"a".repeat(39)});
 await assert.rejects(f.selection(event),{code:"NOTICE_INVALID_INPUT"});
 assert.equal((await f.module.listSelection(f.principal("alice"),event.eventId)).items.length,0);assert.equal((await f.module.counts()).queued,0);
 await f.module.saveTemplate(f.principal("ownerA"),event.eventId,{...f.templateInput,expectedRevision:1,subject:"{event}".repeat(6)+"a".repeat(38)});
 const notice=await f.selection(event,"alice",{templateRevision:2});assert.equal(notice.subject.length,998);assert.equal((await f.module.drain()).accepted,1);
});

/** 规划34 P6：社区（连接/私信）通知复用**同一个** outbox，不需要公告来源。 */
test("community sources reuse the same outbox and never require an announcement", async t => {
  const f = await fixture(t), event = await f.event();
  await f.register(event, "alice"); await f.register(event, "bob");
  const input = { eventId: event.eventId, announcementId: "community-connection-1", revision: 1, recipientUserIds: ["bob"], kind: "community" as const, actorUserId: "alice" };
  const queued = await f.database.transaction(sql => f.module.notification.enqueue(sql, input));
  assert.equal(queued.state, "queued", "社区来源不再走公告查找，因此不会被 NOTICE_NOT_FOUND 拒绝");
  const rows = await f.database.query<{ kind: string; source_id: string; published_by: string; recipient_user_id: string }>(
    "SELECT kind,source_id,published_by,recipient_user_id FROM organizer_notification_outbox WHERE event_id=$1 AND kind='community'", [event.eventId]);
  assert.equal(rows.rowCount, 1);
  assert.deepEqual(rows.rows[0], { kind: "community", source_id: "community-connection-1", published_by: "alice", recipient_user_id: "bob" });
  const again = await f.database.transaction(sql => f.module.notification.enqueue(sql, input));
  assert.equal(again.referenceId, queued.referenceId, "同来源同版本幂等，不重复入队");
  assert.equal((await f.database.query("SELECT id FROM organizer_notification_outbox WHERE event_id=$1 AND kind='community'", [event.eventId])).rowCount, 1);
  await assert.rejects(f.database.transaction(sql => f.module.notification.enqueue(sql, { ...input, recipientUserIds: ["ownerB"] })), (error: unknown) => error instanceof DomainError);
});
