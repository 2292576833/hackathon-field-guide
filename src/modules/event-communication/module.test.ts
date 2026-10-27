import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { EventRegistrationSnapshot, HostedEventAccessPort, HostedEventScope } from "../../shared/organizer-contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { createEventCommunicationService, createEventCommunicationHttpHandlers, createEventLogisticsService, createEventScheduleService, eventCommunicationHttpRoute } from "./index.ts";

test("combined module migrations and real HTTP factories carry a private communication/schedule/logistics flow without cross-event projection", async t => {
  const pg = new PGlite(); t.after(() => pg.close());
  await pg.exec("CREATE TABLE auth_users(id text PRIMARY KEY); INSERT INTO auth_users VALUES('alice'),('bob'),('staff');");
  for (const file of ["001_communication.sql", "002_logistics.sql", "003_schedule.sql"]) await pg.exec(await readFile(new URL(`./migrations/${file}`, import.meta.url), "utf8"));
  const executor = (queryable: { query(statement: string, parameters?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }> }): SqlExecutor => ({ async query<Row>(statement: string, parameters: readonly unknown[] = []) { const result = await queryable.query(statement, [...parameters]); return { rows: result.rows as Row[], rowCount: result.affectedRows ?? result.rows.length }; } });
  const database: DatabasePort = { ...executor(pg), transaction: work => pg.transaction(tx => work(executor(tx))) };
  const events = new Map<string, HostedEventScope>();
  for (const [eventId, organizationId] of [["a", "org1"], ["b", "org1"], ["c", "org2"]]) events.set(eventId, { eventId, organizationId, organizationName: organizationId, title: eventId, status: "published", revision: 1, publishedRevision: 1, timezone: "Asia/Shanghai", startsAt: "2026-10-12T00:00:00Z", endsAt: "2026-10-15T00:00:00Z", registrationOpensAt: null, registrationClosesAt: null, submissionClosesAt: null, modules: { registration: true, teams: true, schedule: true, icebreaking: true, accommodation: true, mealVouchers: true, judging: false }, registration: { reviewRequired: false, capacity: null }, teams: { mode: "free", minSize: 1, maxSize: 6, locksAt: null }, linkedEventId: null });
  const eventAccess: HostedEventAccessPort = { getEvent: async (_sql, id) => events.get(id) ?? null, requireStaff: async (_sql, actor, eventId) => { if (actor.userId !== "staff" || eventId !== "a") throw new DomainError("FORBIDDEN", "不属于此赛事", { status: 403 }); return events.get(eventId)!; } };
  const participation = { getRegistration: async (_sql: SqlExecutor, eventId: string, userId: string): Promise<EventRegistrationSnapshot | null> => ["alice", "bob"].includes(userId) ? { id: `${eventId}-${userId}`, eventId, userId, status: "approved", revision: 1 } : null, getTeam: async () => null };
  let ids = 0, guards = 0, user = "staff";
  const deps = { database, eventAccess, participation, ids: { next: () => `flow-${++ids}` }, clock: { now: () => new Date("2026-10-11T00:00:00Z") } };
  const handlers = createEventCommunicationHttpHandlers({ communication: createEventCommunicationService(deps), schedule: createEventScheduleService(deps), logistics: createEventLogisticsService(deps), resolvePrincipal: async () => ({ actor: { userId: user, platformRoles: ["user"] }, guard: async () => { guards++; } }), authorizeMutation: async () => {} });
  async function http<T>(path: string, method = "GET", body?: unknown, expected = 200): Promise<T> {
    const route = eventCommunicationHttpRoute(path.slice(1).split("/")); assert.ok(route, path);
    const response = await handlers.handle(new Request(`https://localhost/api/v1${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }), route);
    const output = await response.json(); assert.equal(response.status, expected, JSON.stringify(output)); assert.equal(response.headers.get("cache-control"), "private, no-store"); return output.data as T;
  }
  const managed = "/organizer/events/a", personal = "/competitions/a";
  const announcement = await http<{ id: string; revision: number }>(`${managed}/announcements`, "POST", { title: "签到提醒", body: "请到一楼签到", important: true, impact: "请提前到场", dueAt: "2026-10-12T09:00:00+08:00" });
  user = "alice"; await http(`${personal}/announcements/${announcement.id}/read`, "POST", { revision: announcement.revision });
  const ticket = await http<{ id: string; revision: number }>(`${personal}/help-tickets`, "POST", { visibility: "private", question: "个人住宿情况不要公开" });
  user = "staff"; const replied = await http<{ revision: number }>(`${managed}/help-tickets/${ticket.id}/replies`, "POST", { body: "请查看本人安排", expectedRevision: ticket.revision });
  const preview = await http<{ revision: number; faqPreview: { revision: number } }>(`${managed}/help-tickets/${ticket.id}/faq-preview`, "POST", { title: "如何查看住宿", question: "在哪里看自己的住宿", answer: "进入本场比赛的现场服务", expectedRevision: replied.revision });
  user = "alice"; await http(`${personal}/help-tickets/${ticket.id}/publish-consent`, "POST", { expectedRevision: preview.revision, previewRevision: preview.faqPreview.revision, consent: true });
  assert.ok(!JSON.stringify(await http(`${personal}/faq`)).includes("个人住宿情况"));
  user = "staff";
  const draft = await http<{ revision: number }>(`${managed}/schedule/draft`, "PUT", { expectedRevision: 0, timezone: "Asia/Shanghai", impact: "按范围到场", items: [
    { title: "公开开幕", startsAt: "2026-10-12T09:00:00+08:00", endsAt: "2026-10-12T10:00:00+08:00", location: "大厅", audience: "all", userIds: [] },
    { title: "选手签到", startsAt: "2026-10-12T08:00:00+08:00", endsAt: "2026-10-12T09:00:00+08:00", location: "前台", audience: "participants", userIds: [] },
    { title: "Bob安排", startsAt: "2026-10-12T11:00:00+08:00", endsAt: "2026-10-12T12:00:00+08:00", location: "私人安排地点", audience: "users", userIds: ["bob"] },
  ] });
  await http(`${managed}/schedule/publish`, "POST", { expectedRevision: draft.revision });
  await http(`${managed}/accommodation-assignments`, "POST", { userId: "alice", location: "参赛旅舍", room: "203", checkIn: "2026-10-12T12:00:00+08:00", checkOut: "2026-10-14T12:00:00+08:00", note: "到前台领取房卡", expectedRevision: 0 });
  const type = await http<{ id: string }>(`${managed}/meal-voucher-types`, "POST", { name: "午餐", uses: 1, expiresAt: "2026-10-14T12:00:00+08:00" });
  const issued = await http<{ voucher: { id: string }; token: string }>(`${managed}/meal-vouchers`, "POST", { userId: "alice", typeId: type.id, idempotencyKey: "flow-issue" });
  assert.ok(issued.token); const redeemed = await http<{ receipt: { remainingUses: number }; replayed: boolean }>(`${managed}/meal-vouchers/redeem`, "POST", { voucherId: issued.voucher.id, idempotencyKey: "flow-redeem" }); assert.equal(redeemed.receipt.remainingUses, 0);
  const activity = await http<{ id: string }>(`${managed}/icebreakers`, "POST", { title: "自愿认识队友", description: "可以暂不参加", startsAt: "2026-10-12T10:00:00+08:00", location: "大厅" });
  user = "alice"; const choice = await http<{ revision: number }>(`${personal}/icebreakers/${activity.id}/respond`, "POST", { choice: "join" });
  user = "staff"; await http(`${managed}/icebreakers/${activity.id}/groups`, "POST", { title: "第一组", userIds: ["alice"], expectedRevision: choice.revision });
  user = "alice"; const own = await http<{ accommodation: { room: string }; vouchers: { remainingUses: number }[] }>(`${personal}/my-services`); assert.equal(own.accommodation.room, "203"); assert.equal(own.vouchers[0].remainingUses, 0); assert.ok(!JSON.stringify(own).includes(issued.token));
  const schedule = await http<{ items: { title: string }[] }>(`${personal}/schedule`); assert.equal(schedule.items.length, 2); assert.ok(!JSON.stringify(schedule).includes("Bob安排"));
  for (const eventId of ["b", "c"]) { const isolated = await http<{ accommodation: null; vouchers: unknown[] }>(`/competitions/${eventId}/my-services`); assert.equal(isolated.accommodation, null); assert.deepEqual(isolated.vouchers, []); await http(`/competitions/${eventId}/help-tickets/${ticket.id}`, "GET", undefined, 404); }
  user = "staff"; await http("/organizer/events/b/meal-vouchers", "GET", undefined, 403);
  assert.ok(guards > 30);
});
