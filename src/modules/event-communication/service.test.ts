import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { EventRegistrationSnapshot, HostedEventScope, OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { createEventCommunicationService } from "./service.ts";

const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const pg = new PGlite(); t.after(() => pg.close());
  await pg.exec("CREATE TABLE auth_users(id text PRIMARY KEY); INSERT INTO auth_users VALUES('alice'),('bob'),('staff'),('other');");
  await pg.exec(await readFile(new URL("./migrations/001_communication.sql", import.meta.url), "utf8"));
  const executor = (queryable: { query(query: string, parameters?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }> }): SqlExecutor => ({ async query<Row>(query: string, params: readonly unknown[] = []) { const value = await queryable.query(query, [...params]); return { rows: value.rows as Row[], rowCount: value.affectedRows ?? value.rows.length }; } });
  const database: DatabasePort = { ...executor(pg), transaction: work => pg.transaction(tx => work(executor(tx))) };
  const events = new Map<string, HostedEventScope>();
  const modules = { registration: true, teams: true, icebreaking: true, judging: true, schedule: true, accommodation: true, mealVouchers: true };
  for (const [eventId, organizationId] of [["a", "org-a"], ["b", "org-a"], ["c", "org-b"]]) events.set(eventId, { eventId, organizationId, organizationName: organizationId, title: eventId, status: "published", revision: 1, publishedRevision: 1, timezone: "Asia/Shanghai", startsAt: "2026-10-12T00:00:00Z", endsAt: "2026-10-14T00:00:00Z", registrationOpensAt: null, registrationClosesAt: null, submissionClosesAt: null, modules, registration: { reviewRequired: true, capacity: 10 }, teams: { mode: "free", minSize: 1, maxSize: 5, locksAt: null }, linkedEventId: null });
  let staffAllowed = true, registrationAllowed = true, guards = 0, failGuardAt = 0, next = 0;
  const principal = (userId: string): OrganizerPrincipal => ({ actor: { userId, platformRoles: ["user"] }, guard: async () => { guards++; if (failGuardAt && guards >= failGuardAt) throw new DomainError("AUTH_SESSION_REVOKED", "会话已撤销", { status: 401 }); } });
  const alice = principal("alice"), bob = principal("bob"), staff = principal("staff");
  const eventAccess = { getEvent: async (_sql: SqlExecutor, id: string) => events.get(id) ?? null, requireStaff: async (_sql: SqlExecutor, actor: { userId: string }, id: string) => { if (!staffAllowed || actor.userId !== "staff" || id !== "a") throw new DomainError("FORBIDDEN", "无此赛事权限", { status: 403 }); return events.get(id)!; } };
  const participation = { getRegistration: async (_sql: SqlExecutor, eventId: string, userId: string): Promise<EventRegistrationSnapshot | null> => registrationAllowed && ["alice", "bob"].includes(userId) ? { id: `${eventId}-${userId}`, eventId, userId, status: "approved", revision: 1 } : null, getTeam: async () => null };
  const service = createEventCommunicationService({ database, eventAccess, participation, ids: { next: () => `id-${++next}` }, clock: { now: () => new Date("2026-10-11T12:00:00Z") } });
  return { pg, database, service, alice, bob, staff, eventAccess, participation, events, revokeStaff: () => { staffAllowed = false; }, revokeRegistration: () => { registrationAllowed = false; }, revokeOnFinalGuard: () => { failGuardAt = guards + 2; } };
}
const announcement = { title: "提交时间有更新", body: "请在周二前完成提交", important: true, impact: "截止延后一天", dueAt: "2026-10-13T18:00:00+08:00" };

test("published versions reset read receipts; draft preserves last public version and withdrawal keeps history", async t => {
  const f = await fixture(t); const first = await f.service.publishAnnouncement(f.staff, "a", announcement);
  assert.equal(first.notification.state, "unconfigured");
  assert.equal((await f.service.listAnnouncements(f.alice, "a"))[0].read, false);
  await f.service.markAnnouncementRead(f.alice, "a", first.id, { revision: 1 });
  assert.equal((await f.service.listAnnouncements(f.alice, "a"))[0].read, true);
  const draft = await f.service.saveAnnouncementDraft(f.staff, "a", { ...announcement, impact: "", announcementId: first.id, expectedRevision: 1, body: "未发布的新正文" });
  assert.equal((await f.service.listAnnouncements(null, "a"))[0].body, announcement.body);
  const updated = await f.service.publishAnnouncement(f.staff, "a", { ...announcement, announcementId: first.id, expectedRevision: draft.revision, body: "已确认的新正文" });
  assert.equal((await f.service.listAnnouncements(f.alice, "a"))[0].read, false);
  await assert.rejects(f.service.markAnnouncementRead(f.alice, "a", first.id, { revision: 1 }), code("VERSION_CONFLICT"));
  await f.service.withdrawAnnouncement(f.staff, "a", first.id, { expectedRevision: updated.revision });
  assert.deepEqual(await f.service.listAnnouncements(null, "a"), []);
  assert.equal((await f.database.query("SELECT * FROM ec_announcement_versions")).rows.length, 4);
  await assert.rejects(f.database.query("UPDATE ec_announcement_versions SET document='{}'::jsonb"), /immutable/);
});

test("announcement CAS admits one parallel edit and rejects forged organization/identity fields", async t => {
  const f = await fixture(t); const first = await f.service.publishAnnouncement(f.staff, "a", announcement);
  const edits = await Promise.allSettled(["编辑一", "编辑二"].map(title => f.service.publishAnnouncement(f.staff, "a", { ...announcement, title, announcementId: first.id, expectedRevision: 1 })));
  assert.equal(edits.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(edits.filter(result => result.status === "rejected").length, 1);
  await assert.rejects(f.service.publishAnnouncement(f.staff, "a", { ...announcement, organizationId: "org-b" }), code("COMMUNICATION_INVALID_INPUT"));
  await assert.rejects(f.service.publishAnnouncement(f.staff, "a", { ...announcement, dueAt: "2026-02-30T12:00:00Z" }), code("COMMUNICATION_INVALID_INPUT"));
  await assert.rejects(f.service.withdrawAnnouncement(f.staff, "b", first.id, { expectedRevision: 2 }), code("FORBIDDEN"));
});

test("private tickets isolate users/events/organizations and public projection omits author metadata", async t => {
  const f = await fixture(t); const privateTicket = await f.service.createTicket(f.alice, "a", { visibility: "private", question: "我住在哪里？私人姓名" });
  await f.service.createTicket(f.bob, "a", { visibility: "public", question: "在哪里签到？" });
  assert.equal((await f.service.listTickets(f.bob, "a")).length, 1);
  assert.equal((await f.service.listTickets(null, "a")).length, 1);
  assert.equal((await f.service.listManagedTickets(f.staff, "a")).length, 2);
  await assert.rejects(f.service.getTicket(f.bob, "a", privateTicket.id), code("COMMUNICATION_NOT_FOUND"));
  for (const eventId of ["b", "c"]) { assert.deepEqual(await f.service.listTickets(f.alice, eventId), []); await assert.rejects(f.service.getTicket(f.alice, eventId, privateTicket.id), code("COMMUNICATION_NOT_FOUND")); }
  const publicText = JSON.stringify(await f.service.listTickets(null, "a")); assert.ok(!publicText.includes("私人姓名")); assert.ok(!publicText.includes("userId")); assert.ok(!publicText.includes("updatedBy"));
});

test("private FAQ publication requires exact preview consent by original author; revised preview never auto-publishes", async t => {
  const f = await fixture(t); let ticket = await f.service.createTicket(f.alice, "a", { visibility: "private", question: "我的私人情况" });
  ticket = await f.service.proposeFaqPreview(f.staff, "a", ticket.id, { expectedRevision: ticket.revision, title: "住宿常见问题", question: "在哪里查看住宿", answer: "打开本人现场服务" });
  assert.deepEqual(await f.service.listPublicFaqs(null, "a"), []);
  await assert.rejects(f.service.consentFaqPublication(f.staff, "a", ticket.id, { expectedRevision: ticket.revision, previewRevision: 1, consent: true }), code("FORBIDDEN"));
  await assert.rejects(f.service.consentFaqPublication(f.bob, "a", ticket.id, { expectedRevision: ticket.revision, previewRevision: 1, consent: true }), code("FORBIDDEN"));
  await assert.rejects(f.service.consentFaqPublication(f.alice, "a", ticket.id, { expectedRevision: ticket.revision, previewRevision: 1, consent: false }), code("COMMUNICATION_INVALID_INPUT"));
  ticket = await f.service.consentFaqPublication(f.alice, "a", ticket.id, { expectedRevision: ticket.revision, previewRevision: 1, consent: true });
  const publicFaq = await f.service.listPublicFaqs(null, "a"); assert.equal(publicFaq.length, 1); assert.ok(!JSON.stringify(publicFaq).includes("我的私人情况")); assert.ok(!JSON.stringify(publicFaq).includes("alice"));
  const revised = await f.service.proposeFaqPreview(f.staff, "a", ticket.id, { expectedRevision: ticket.revision, title: "修改后的预览", question: "新问题", answer: "新答复" });
  await assert.rejects(f.service.consentFaqPublication(f.alice, "a", ticket.id, { expectedRevision: revised.revision, previewRevision: 1, consent: true }), code("VERSION_CONFLICT"));
  assert.equal((await f.service.listPublicFaqs(null, "a"))[0].title, "住宿常见问题");
  assert.equal((await f.service.getTicket(f.alice, "a", ticket.id)).visibility, "private");
});

test("only author can append; staff answer updates status; stale edits and closed tickets preserve content", async t => {
  const f = await fixture(t); let ticket = await f.service.createTicket(f.alice, "a", { visibility: "private", question: "如何准备" });
  await assert.rejects(f.service.addReply(f.bob, "a", ticket.id, { body: "猜ID追加", expectedRevision: 1 }), code("COMMUNICATION_NOT_FOUND"));
  ticket = await f.service.addReply(f.staff, "a", ticket.id, { body: "官方人员答复", expectedRevision: 1 }, true);
  assert.equal(ticket.status, "answered"); assert.equal(ticket.replies[0].role, "staff");
  await assert.rejects(f.service.addReply(f.alice, "a", ticket.id, { body: "旧版本", expectedRevision: 1 }), code("VERSION_CONFLICT"));
  ticket = await f.service.changeTicketStatus(f.staff, "a", ticket.id, { status: "closed", expectedRevision: ticket.revision });
  await assert.rejects(f.service.addReply(f.alice, "a", ticket.id, { body: "关闭后追加", expectedRevision: ticket.revision }), code("TICKET_CLOSED"));
});

test("revoked staff/session and registration cannot mutate; final guard failure rolls back", async t => {
  const f = await fixture(t); f.revokeOnFinalGuard();
  await assert.rejects(f.service.publishAnnouncement(f.staff, "a", announcement), code("AUTH_SESSION_REVOKED"));
  assert.equal((await f.database.query("SELECT * FROM ec_announcements")).rows.length, 0);
});

test("current staff and approved participation are rechecked on each request", async t => {
  const f = await fixture(t); const own = await f.service.createTicket(f.alice, "a", { visibility: "private", question: "本人问题" }); f.revokeStaff();
  await assert.rejects(f.service.listManagedTickets(f.staff, "a"), code("FORBIDDEN"));
  await assert.rejects(f.service.publishAnnouncement(f.staff, "a", announcement), code("FORBIDDEN"));
  f.revokeRegistration(); await assert.rejects(f.service.createTicket(f.alice, "a", { visibility: "private", question: "问题" }), code("FORBIDDEN"));
  assert.deepEqual(await f.service.listTickets(f.alice, "a"), []);
  await assert.rejects(f.service.getTicket(f.alice, "a", own.id), code("COMMUNICATION_NOT_FOUND"));
});

test("capability revocation between mutation and return rolls back the entire announcement", async t => {
  const f = await fixture(t); const original = f.eventAccess.requireStaff; let checks = 0;
  f.eventAccess.requireStaff = async (...args) => { checks++; if (checks === 2) f.revokeStaff(); return original(...args); };
  await assert.rejects(f.service.publishAnnouncement(f.staff, "a", announcement), code("FORBIDDEN"));
  assert.equal((await f.database.query("SELECT * FROM ec_announcements")).rows.length, 0);
  assert.equal((await f.database.query("SELECT * FROM ec_announcement_versions")).rows.length, 0);
});

test("draft event is not public, archived event preserves public history and rejects writes", async t => {
  const f = await fixture(t); await f.service.publishAnnouncement(f.staff, "a", announcement);
  f.events.set("a", { ...f.events.get("a")!, status: "archived" });
  assert.equal((await f.service.listAnnouncements(null, "a")).length, 1);
  await assert.rejects(f.service.publishAnnouncement(f.staff, "a", announcement), code("EVENT_READ_ONLY"));
  f.events.set("b", { ...f.events.get("b")!, status: "draft", publishedRevision: null });
  await assert.rejects(f.service.listPublicFaqs(null, "b"), code("COMMUNICATION_NOT_FOUND"));
});

test("notification enqueue is distinct from delivery and untrusted roster members reject transaction", async t => {
  const f = await fixture(t); let notifications = 0;
  const service = createEventCommunicationService({ database: f.database, eventAccess: f.eventAccess, participation: f.participation, ids: { next: () => "notice" }, clock: { now: () => new Date() }, announcementAudience: { listRecipientUserIds: async () => ["alice", "bob"] }, notification: { enqueue: async (sql, input) => { notifications++; assert.equal((await sql.query("SELECT id FROM ec_announcements WHERE id=$1", [input.announcementId])).rows.length, 1); assert.deepEqual(input.recipientUserIds, ["alice", "bob"]); return { state: "queued", referenceId: "outbox-reference" }; } } });
  const published = await service.publishAnnouncement(f.staff, "a", announcement); assert.equal(published.notification.state, "queued"); assert.equal(notifications, 1); assert.ok(!("delivered" in published.notification));
  const invalidRoster = createEventCommunicationService({ database: f.database, eventAccess: f.eventAccess, participation: f.participation, ids: { next: () => "bad-notice" }, clock: { now: () => new Date() }, announcementAudience: { listRecipientUserIds: async () => ["other"] }, notification: { enqueue: async () => { notifications++; return { state: "queued", referenceId: "bad" }; } } });
  await assert.rejects(invalidRoster.publishAnnouncement(f.staff, "a", announcement), code("FORBIDDEN")); assert.equal(notifications, 1);
  assert.equal((await f.database.query("SELECT * FROM ec_announcements")).rows.length, 1);
});
