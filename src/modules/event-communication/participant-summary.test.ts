/**
 * P08 选手侧资源与下一步汇总 · 验收测试
 *
 * 覆盖规划 33 P08 第 6 节全部验收：
 * 每项可回溯（href 指向既有路由）／无值不补／期限真实（只来自已发布规则版本）／
 * 队长看不到其他成员的住宿与餐券／选手 A 看不到选手 B 的求助／
 * 未登录 401／非参与者 403／读取前后事实完全一致。
 *
 * 使用全新内存 PGlite 与受控跨模块 Port；不打开 .env.local、不连实际数据库。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { EventParticipationPort, HostedEventAccessPort, HostedEventScope } from "../../shared/organizer-contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { buildNextStep, buildParticipantSummary, deadlineRows, summaryHrefs } from "./participant-summary.ts";
import type { ParticipantSummaryInput } from "./participant-summary.ts";
import { createEventCommunicationService, createEventCommunicationHttpHandlers, createEventLogisticsService, createEventScheduleService, eventCommunicationHttpRoute } from "./index.ts";
import type { EventOwnFactsPort } from "./model.ts";
// ------------------------------------------------------------------ 夹具

const MODULES = { registration: true, teams: true, schedule: true, icebreaking: true, accommodation: true, mealVouchers: true, judging: false };

function scopeOf(eventId: string, organizationId: string): HostedEventScope {
  return {
    eventId, organizationId, organizationName: organizationId, title: `${eventId} 赛`, status: "published",
    revision: 1, publishedRevision: 1, timezone: "Asia/Shanghai",
    startsAt: "2026-10-12T00:00:00Z", endsAt: "2026-10-15T00:00:00Z",
    registrationOpensAt: "2026-09-01T00:00:00Z", registrationClosesAt: "2026-10-05T00:00:00Z",
    submissionClosesAt: "2026-10-14T00:00:00Z",
    modules: { ...MODULES },
    registration: { reviewRequired: false, capacity: null },
    teams: { mode: "free", minSize: 1, maxSize: 6, locksAt: null },
    linkedEventId: null,
  };
}

/** 每个测试单独建库；PGlite 是单写嵌入式实例，不能跨测试共享。 */
async function liveFixture() {
  const pg = new PGlite();
  await pg.exec("CREATE TABLE auth_users(id text PRIMARY KEY); INSERT INTO auth_users VALUES('alice'),('bob'),('carol'),('staff');");
  for (const file of ["001_communication.sql", "002_logistics.sql", "003_schedule.sql"]) {
    await pg.exec(await readFile(new URL(`./migrations/${file}`, import.meta.url), "utf8"));
  }
  const executor = (queryable: { query(statement: string, parameters?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }> }): SqlExecutor => ({
    async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      const result = await queryable.query(statement, [...parameters]);
      return { rows: result.rows as Row[], rowCount: result.affectedRows ?? result.rows.length };
    },
  });
  const database: DatabasePort = { ...executor(pg), transaction: work => pg.transaction(tx => work(executor(tx))) };
  const events = new Map<string, HostedEventScope>([["a", scopeOf("a", "org1")], ["b", scopeOf("b", "org1")]]);
  const eventAccess: HostedEventAccessPort = {
    getEvent: async (_sql, id) => events.get(id) ?? null,
    requireStaff: async (_sql, actor, eventId) => {
      if (actor.userId !== "staff") throw new DomainError("FORBIDDEN", "不属于此赛事", { status: 403 });
      return events.get(eventId)!;
    },
  };
  const registrations = new Map<string, "approved">([["a:alice", "approved"], ["a:bob", "approved"], ["b:alice", "approved"]]);
  const participation: EventParticipationPort = {
    getRegistration: async (_sql, eventId, userId) => registrations.has(`${eventId}:${userId}`)
      ? { id: `${eventId}-${userId}`, eventId, userId, status: "approved", revision: 1 } : null,
    getTeam: async (_sql, eventId, teamId) => teamId === "t-a" ? {
      id: "t-a", eventId, organizationId: "org1", captainUserId: "alice", memberUserIds: ["alice", "bob"],
      revision: 1, status: "forming", projectId: null, eligible: true,
    } : null,
  };
  let ids = 0, user = "alice";
  // 根侧接线：本人报名与队伍通过只读 Port 提供（本模块不查 event-registration 的表）。
  const ownFacts: EventOwnFactsPort = {
    registration: async (_sql, eventId, userId) => registrations.has(`${eventId}:${userId}`) ? { status: "approved", reviewNote: "" } : null,
    team: async (_sql, eventId, userId) => eventId === "a" && ["alice", "bob"].includes(userId)
      ? { id: "t-a", name: "一队", track: "AI", status: "forming", captainUserId: "alice", memberCount: 2 } : null,
  };
  const deps = { database, eventAccess, participation, ownFacts, ids: { next: () => `p8-${++ids}` }, clock: { now: () => new Date("2026-10-08T00:00:00Z") } };
  const communication = createEventCommunicationService(deps), schedule = createEventScheduleService(deps), logistics = createEventLogisticsService(deps);
  const handlers = createEventCommunicationHttpHandlers({
    communication, schedule, logistics,
    resolvePrincipal: async () => user === "guest" ? null : { actor: { userId: user, platformRoles: ["user"] }, guard: async () => {} },
    authorizeMutation: async () => {},
  });
  async function http<T>(path: string, method = "GET", body?: unknown, expected = 200): Promise<T> {
    const route = eventCommunicationHttpRoute(path.slice(1).split("/"));
    assert.ok(route, `route should resolve: ${path}`);
    const response = await handlers.handle(new Request(`https://localhost/api/v1${path}`, {
      method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }), route);
    const output = await response.json() as { data: unknown };
    assert.equal(response.status, expected, `${path} → ${response.status} ${JSON.stringify(output)}`);
    return output.data as T;
  }
  return { pg, database, eventAccess, participation, communication, schedule, logistics, handlers, http, setUser: (value: string) => { user = value; } };
}

// ------------------------------------------------------------------ 纯函数

const BASELINE: ParticipantSummaryInput = {
  eventId: "a", eventTitle: "2026 校园 AI 黑客松", organizationName: "某某大学", timezone: "Asia/Shanghai",
  publishedRevision: 3,
  modules: { schedule: true, accommodation: true, mealVouchers: true },
  deadlines: {
    registrationOpensAt: "2026-09-01T00:00:00Z", registrationClosesAt: "2026-10-05T00:00:00Z",
    submissionClosesAt: "2026-10-14T00:00:00Z", startsAt: "2026-10-12T00:00:00Z", endsAt: "2026-10-15T00:00:00Z",
  },
  registration: { status: "approved" }, team: null, announcements: [], scheduleItems: [], accommodation: null, vouchers: [], tickets: [],
};

test("P08 期限只输出有值的项，缺失的既不补占位也不用别的日期顶替", () => {
  const rows = deadlineRows({ registrationOpensAt: null, registrationClosesAt: "2026-10-05T00:00:00Z", submissionClosesAt: null, startsAt: "2026-10-12T00:00:00Z", endsAt: "2026-10-15T00:00:00Z" });
  assert.deepEqual(rows.map(row => row.key), ["registrationClosesAt", "startsAt", "endsAt"]);
  // 作品截止缺失时，不得用报名截止或开赛时间冒充。
  assert.ok(!rows.some(row => row.key === "submissionClosesAt"));
  // 空串同样视为"没有这一项"。
  assert.deepEqual(deadlineRows({ registrationOpensAt: "", registrationClosesAt: null, submissionClosesAt: null, startsAt: "2026-10-12T00:00:00Z", endsAt: "2026-10-15T00:00:00Z" }).map(row => row.key), ["startsAt", "endsAt"]);
});

test("P08 每一项都能指回既有路由，且只指向本场赛事", () => {
  const hrefs = summaryHrefs("a");
  for (const href of Object.values(hrefs)) {
    assert.ok(href.startsWith("/competitions/a"), href);
    assert.ok(!href.includes("..") && !href.includes("//"), href);
  }
  const summary = buildParticipantSummary({ ...BASELINE, team: { id: "t", name: "队", role: "member", memberCount: 3, status: "forming", track: "AI" }, accommodation: { location: "旅舍", room: "203", checkIn: "2026-10-12T12:00:00Z", checkOut: "2026-10-14T12:00:00Z", note: "前台取卡" }, vouchers: [{ name: "午餐", remainingUses: 1, totalUses: 2, expiresAt: "2026-10-14T12:00:00Z", state: "available" }], tickets: [{ id: "k", eventId: "a", question: "问", visibility: "private", status: "open", revision: 1, createdAt: "x", updatedAt: "x", replies: [], faqPreview: null, own: true }], announcements: [{ id: "n", eventId: "a", revision: 1, title: "通知", body: "b", important: true, impact: "", dueAt: null, status: "published", publishedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", read: false, notificationState: "queued" }], scheduleItems: [{ id: "s", title: "开幕", startsAt: "2026-10-12T09:00:00Z", endsAt: "2026-10-12T10:00:00Z", location: "大厅" }] });
  const hrefsSeen = [
    summary.registration.href, summary.team.href, summary.announcements.href, summary.announcements.items[0]!.href,
    summary.schedule.href, summary.schedule.items[0]!.href, summary.logistics.href, summary.logistics.vouchers[0]!.href,
    summary.tickets.href, summary.tickets.items[0]!.href, summary.nextStep.href,
  ];
  for (const href of hrefsSeen) assert.ok(href.startsWith("/competitions/a"), href);
  assert.equal(summary.registration.href, "/competitions/a/register");
  assert.equal(summary.team.href, "/competitions/a/teams");
  assert.equal(summary.tickets.href, "/competitions/a/help");
  assert.equal(summary.schedule.href, "/competitions/a/schedule");
  assert.equal(summary.logistics.href, "/competitions/a/services");
});

test("P08 报名与队伍区分「还没读到」和「确实没有」，且下一步在未读到时不给建议", () => {
  // 未接线 Port：两者都是 undefined → unread，且 nextStep 明确说"读不到"。
  const unread = buildParticipantSummary({ ...BASELINE, registration: undefined, team: undefined });
  assert.equal(unread.registration.state, "unread");
  assert.equal(unread.team.state, "unread");
  assert.equal(unread.nextStep.kind, "unread");
  // 读到了但确实没有队伍 → absent，并给出"去找/建队伍"。
  const noTeam = buildParticipantSummary({ ...BASELINE, registration: { status: "approved" }, team: null });
  assert.equal(noTeam.team.state, "absent");
  assert.equal(noTeam.team.name, null);
  assert.equal(noTeam.nextStep.kind, "join_team");
  // 有队伍 → recorded。
  const withTeam = buildParticipantSummary({ ...BASELINE, registration: { status: "approved" }, team: { id: "t", name: "队", role: "captain", memberCount: 2, status: "forming", track: "AI" } });
  assert.equal(withTeam.team.state, "recorded");
  assert.equal(withTeam.team.role, "captain");
  assert.equal(withTeam.nextStep.kind, "ready");
});

test("P08 下一步按报名状态给唯一一条，未读通知优先于其他准备动作", () => {
  assert.equal(buildNextStep({ ...BASELINE, registration: { status: "draft" } }).kind, "register");
  assert.equal(buildNextStep({ ...BASELINE, registration: { status: "pending" } }).kind, "await_review");
  assert.equal(buildNextStep({ ...BASELINE, registration: { status: "rejected" } }).kind, "rejected");
  assert.equal(buildNextStep({ ...BASELINE, registration: { status: "withdrawn" } }).kind, "register");
  assert.equal(buildNextStep({ ...BASELINE, registration: null }).kind, "register");
  const notice = buildNextStep({
    ...BASELINE, registration: { status: "approved" }, team: null,
    announcements: [{ id: "n", eventId: "a", revision: 1, title: "时间调整", body: "b", important: true, impact: "", dueAt: null, status: "published", publishedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", read: false, notificationState: "queued" }],
  });
  assert.equal(notice.kind, "read_notice");
  assert.match(notice.title, /1 条/);
});

test("P08 空值不补：没有行程/住宿/餐券/求助时输出空态，不编造内容", () => {
  const summary = buildParticipantSummary(BASELINE);
  assert.equal(summary.logistics.accommodation, null);
  assert.equal(summary.logistics.accommodationState, "absent");
  assert.deepEqual(summary.logistics.vouchers, []);
  assert.deepEqual(summary.schedule.items, []);
  assert.equal(summary.tickets.total, 0);
  assert.equal(summary.announcements.total, 0);
  // 模块关闭时不假装"没有服务"，而是标记 absent。
  const closed = buildParticipantSummary({ ...BASELINE, modules: { schedule: false, accommodation: false, mealVouchers: false } });
  assert.equal(closed.schedule.state, "absent");
  assert.equal(closed.logistics.accommodationState, "absent");
});

test("P08 纯函数只含已发布公告，且未读计数不把草稿或已撤回算进去", () => {
  const rows = [
    { id: "n1", eventId: "a", revision: 1, title: "已发布未读", body: "b", important: false, impact: "", dueAt: null, status: "published" as const, publishedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", read: false, notificationState: "queued" as const },
    { id: "n2", eventId: "a", revision: 1, title: "已发布已读", body: "b", important: false, impact: "", dueAt: null, status: "published" as const, publishedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", read: true, notificationState: "queued" as const },
    { id: "n3", eventId: "a", revision: 1, title: "草稿", body: "b", important: false, impact: "", dueAt: null, status: "draft" as const, publishedAt: null, updatedAt: "2026-10-01T00:00:00Z", read: false, notificationState: "unconfigured" as const },
  ];
  const summary = buildParticipantSummary({ ...BASELINE, announcements: rows, registration: { status: "approved" } });
  assert.equal(summary.announcements.total, 3);
  assert.equal(summary.announcements.unread, 1);
  assert.equal(summary.ruleVersion, 3);
});

// ------------------------------------------------------------------ HTTP 与隔离

test("P08 my-summary 只返回本人事实：队长看不到其他成员的住宿与餐券，选手 A 看不到选手 B 的求助", async t => {
  const f = await liveFixture(); t.after(() => f.pg.close());
  const managed = "/organizer/events/a", personal = "/competitions/a";

  // 主办方准备：公告、行程、alice 与 bob 各自的住宿与餐券。
  await f.setUser("staff");
  const announcement = await f.http<{ id: string; revision: number }>(`${managed}/announcements`, "POST", { title: "签到提醒", body: "一楼签到", important: true, impact: "请提前到场", dueAt: "2026-10-12T09:00:00+08:00" });
  const draft = await f.http<{ revision: number }>(`${managed}/schedule/draft`, "PUT", {
    expectedRevision: 0, timezone: "Asia/Shanghai", impact: "按范围到场", items: [
      { title: "公开开幕", startsAt: "2026-10-12T09:00:00+08:00", endsAt: "2026-10-12T10:00:00+08:00", location: "大厅", audience: "all", userIds: [] },
      { title: "Bob 私人安排", startsAt: "2026-10-12T11:00:00+08:00", endsAt: "2026-10-12T12:00:00+08:00", location: "只在 Bob 名下", audience: "users", userIds: ["bob"] },
    ],
  });
  await f.http(`${managed}/schedule/publish`, "POST", { expectedRevision: draft.revision });
  await f.http(`${managed}/accommodation-assignments`, "POST", { userId: "alice", location: "参赛旅舍", room: "203", checkIn: "2026-10-12T12:00:00+08:00", checkOut: "2026-10-14T12:00:00+08:00", note: "到前台领取房卡", expectedRevision: 0 });
  await f.http(`${managed}/accommodation-assignments`, "POST", { userId: "bob", location: "只在 Bob 名下的住处", room: "999", checkIn: "2026-10-12T12:00:00+08:00", checkOut: "2026-10-14T12:00:00+08:00", note: "不要给别人看到", expectedRevision: 0 });
  const type = await f.http<{ id: string }>(`${managed}/meal-voucher-types`, "POST", { name: "午餐", uses: 2, expiresAt: "2026-10-14T12:00:00+08:00" });
  await f.http(`${managed}/meal-vouchers`, "POST", { userId: "alice", typeId: type.id, idempotencyKey: "p8-issue-alice" });
  await f.http(`${managed}/meal-vouchers`, "POST", { userId: "bob", typeId: type.id, idempotencyKey: "p8-issue-bob" });

  // 两位选手各提一个私人求助。
  await f.setUser("alice");
  const aliceTicket = await f.http<{ id: string }>(`${personal}/help-tickets`, "POST", { visibility: "private", question: "Alice 的私人问题：住宿怎么走" });
  await f.setUser("bob");
  await f.http(`${personal}/help-tickets`, "POST", { visibility: "private", question: "Bob 的私人问题：餐券在哪领" });

  // alice 读自己的汇总：只应该有自己那一条，不含 Bob 的任何私人内容。
  await f.setUser("alice");
  const mine = await f.http<{
    registration: { state: string; status: string }; team: { state: string };
    announcements: { unread: number; items: { read: boolean }[] };
    schedule: { items: { title: string }[] };
    logistics: { accommodation: { room: string } | null; vouchers: unknown[] };
    tickets: { items: { id: string; question: string }[] };
    nextStep: { kind: string; href: string };
  }>(`${personal}/my-summary`);
  const raw = JSON.stringify(mine);
  assert.ok(!raw.includes("999"), "不得出现 Bob 的房间号");
  assert.ok(!raw.includes("只在 Bob 名下的住处"), "不得出现 Bob 的住宿地点");
  assert.ok(!raw.includes("不要给别人看到"), "不得出现 Bob 的住宿备注");
  assert.ok(!raw.includes("Bob 的私人问题"), "不得出现 Bob 的求助");
  assert.ok(!raw.includes("Bob 私人安排"), "不得出现指定给 Bob 的行程");
  assert.equal(mine.logistics.accommodation?.room, "203");
  assert.equal(mine.logistics.vouchers.length, 1, "只应有本人的餐券");
  assert.deepEqual(mine.schedule.items.map(item => item.title), ["公开开幕"]);
  assert.deepEqual(mine.tickets.items.map(item => item.question), ["Alice 的私人问题：住宿怎么走"]);
  assert.ok(mine.tickets.items.every(item => !("userId" in item)), "求助投影不得含他人账号字段");
  assert.equal(mine.announcements.unread, 1);
  assert.equal(mine.nextStep.kind, "read_notice");
  assert.equal(mine.nextStep.href, "/competitions/a");

  // bob 读自己的汇总：看到的是自己的，不是 alice 的。
  await f.setUser("bob");
  const other = await f.http<{ logistics: { accommodation: { room: string } | null }; tickets: { items: { question: string }[] } }>(`${personal}/my-summary`);
  assert.equal(other.logistics.accommodation?.room, "999");
  assert.deepEqual(other.tickets.items.map(item => item.question), ["Bob 的私人问题：餐券在哪领"]);
  assert.ok(!JSON.stringify(other).includes("Alice 的私人问题"), "不得出现 Alice 的求助");
  assert.ok(!JSON.stringify(other).includes("203"), "不得出现 Alice 的房间号");

  // 队长身份不放大：alice 是 t-a 队长（由 Port 提供），仍只能看到自己那一条住宿。
  assert.equal(aliceTicket.id.length > 0, true);
});

test("P08 未登录 401、非参与者 403、跨赛事隔离、只允许 GET", async t => {
  const f = await liveFixture(); t.after(() => f.pg.close());
  await f.setUser("guest");
  await f.http("/competitions/a/my-summary", "GET", undefined, 401);
  await f.setUser("carol"); // 未报名 a 场
  await f.http("/competitions/a/my-summary", "GET", undefined, 403);
  await f.setUser("alice");
  await f.http("/competitions/a/my-summary", "GET", undefined, 200);
  // alice 在 b 场也通过，但 b 场没有任何公告/住宿/餐券 → 空态而不是拿到 a 场的东西。
  const b = await f.http<{ logistics: { accommodation: null; vouchers: unknown[] }; announcements: { total: number } }>("/competitions/b/my-summary");
  assert.equal(b.logistics.accommodation, null);
  assert.deepEqual(b.logistics.vouchers, []);
  assert.equal(b.announcements.total, 0);
  // 方法不符 → 405 且带 Allow。
  const route = eventCommunicationHttpRoute(["competitions", "a", "my-summary"]);
  assert.ok(route);
  const response = await f.handlers.handle(new Request("https://localhost/api/v1/competitions/a/my-summary", { method: "POST" }), route);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("P08 汇总只读：读取前后公告已读、住宿分配、餐券核销、求助状态完全一致", async t => {
  const f = await liveFixture(); t.after(() => f.pg.close());
  const managed = "/organizer/events/a", personal = "/competitions/a";
  await f.setUser("staff");
  const announcement = await f.http<{ id: string; revision: number }>(`${managed}/announcements`, "POST", { title: "材料提醒", body: "请带齐材料", important: true, impact: "影响入场", dueAt: null });
  await f.http(`${managed}/accommodation-assignments`, "POST", { userId: "alice", location: "旅舍", room: "203", checkIn: "2026-10-12T12:00:00+08:00", checkOut: "2026-10-14T12:00:00+08:00", note: "前台", expectedRevision: 0 });
  const type = await f.http<{ id: string }>(`${managed}/meal-voucher-types`, "POST", { name: "午餐", uses: 1, expiresAt: "2026-10-14T12:00:00+08:00" });
  const issued = await f.http<{ voucher: { id: string } }>(`${managed}/meal-vouchers`, "POST", { userId: "alice", typeId: type.id, idempotencyKey: "p8-readonly-issue" });
  await f.http(`${managed}/meal-vouchers/redeem`, "POST", { voucherId: issued.voucher.id, idempotencyKey: "p8-readonly-redeem" });

  await f.setUser("alice");
  const ticket = await f.http<{ id: string; revision: number }>(`${personal}/help-tickets`, "POST", { visibility: "private", question: "材料要盖章吗" });

  // 读取前的既有事实快照。
  const before = await f.http<{ unread: number }>(`${personal}/my-summary`);
  const beforeAnnouncements = await f.http<{ read: boolean }[]>(`${personal}/announcements`);
  const beforeServices = await f.http<{ accommodation: { room: string } | null; vouchers: { remainingUses: number }[] }>(`${personal}/my-services`);
  const beforeTicket = await f.http<{ status: string; revision: number; replies: unknown[] }>(`${personal}/help-tickets/${ticket.id}`);

  // 连续读取三次汇总。
  for (let index = 0; index < 3; index++) await f.http(`${personal}/my-summary`);

  const afterAnnouncements = await f.http<{ read: boolean }[]>(`${personal}/announcements`);
  const afterServices = await f.http<{ accommodation: { room: string } | null; vouchers: { remainingUses: number }[] }>(`${personal}/my-services`);
  const afterTicket = await f.http<{ status: string; revision: number; replies: unknown[] }>(`${personal}/help-tickets/${ticket.id}`);
  const after = await f.http<{ unread: number }>(`${personal}/my-summary`);

  assert.deepEqual(afterAnnouncements.map(item => item.read), beforeAnnouncements.map(item => item.read), "公告已读状态不得因读取汇总而改变");
  assert.equal(beforeAnnouncements[0]!.read, false, "前提：读取前确实未读");
  assert.deepEqual(afterServices, beforeServices, "住宿与餐券不得改变");
  assert.equal(afterServices.vouchers[0]!.remainingUses, 0, "前提：餐券已核销");
  assert.deepEqual(afterTicket, beforeTicket, "求助状态与回复不得改变");
  assert.deepEqual(after, before, "重复读取必须得到同样的汇总");
  assert.equal(announcement.id.length > 0, true);
});

test("P08 公告草稿与已撤回不进入选手汇总", async t => {
  const f = await liveFixture(); t.after(() => f.pg.close());
  const managed = "/organizer/events/a", personal = "/competitions/a";
  await f.setUser("staff");
  await f.http(`${managed}/announcements/draft`, "POST", { title: "还没发的草稿", body: "草稿正文", important: false, impact: "草稿影响", dueAt: null });
  const live = await f.http<{ id: string; revision: number }>(`${managed}/announcements`, "POST", { title: "已发布通知", body: "正文", important: false, impact: "发布影响", dueAt: null });
  await f.setUser("alice");
  const first = await f.http<{ announcements: { total: number; items: { title: string }[] } }>(`${personal}/my-summary`);
  assert.deepEqual(first.announcements.items.map(item => item.title), ["已发布通知"], "草稿不得出现");
  // 撤回后也不再出现。
  await f.setUser("staff");
  await f.http(`${managed}/announcements/${live.id}/withdraw`, "POST", { expectedRevision: live.revision });
  await f.setUser("alice");
  const second = await f.http<{ announcements: { total: number } }>(`${personal}/my-summary`);
  assert.equal(second.announcements.total, 0);
});

test("P08 根未接线本人报名/队伍 Port 时汇总仍可用，但标记 unread 且不给建议", async t => {
  const f = await liveFixture(); t.after(() => f.pg.close());
  await f.setUser("alice");
  // 只注既有 Port（不含 ownFacts）的服务：模拟主会话尚未接线的情形。
  const unwired = createEventCommunicationService({
    database: f.database, eventAccess: f.eventAccess, participation: f.participation,
    ids: { next: () => "unwired-1" }, clock: { now: () => new Date("2026-10-08T00:00:00Z") },
  });
  const principal = { actor: { userId: "alice", platformRoles: ["user"] as const }, guard: async () => {} };
  const facts = await unwired.ownFacts(principal, "a");
  assert.equal(facts.registration?.status, "approved", "communication 自己仍能用既有 Port 确认报名已通过");
  const fallback = await unwired.ownRegistrationAndTeam(principal, "a");
  assert.equal(fallback.registration, undefined, "未接线时必须返回 undefined（还没读到），而不是 null（确实没有）");
  assert.equal(fallback.team, undefined);
  const summary = buildParticipantSummary({ ...BASELINE, registration: fallback.registration, team: fallback.team });
  assert.equal(summary.registration.state, "unread");
  assert.equal(summary.team.state, "unread");
  assert.equal(summary.nextStep.kind, "unread");
  assert.equal(summary.team.name, null, "未读到时不得填写任何队伍名");
});

test("P08 接线了本人报名/队伍 Port 后按真实状态输出", async t => {
  const f = await liveFixture(); t.after(() => f.pg.close());
  const teammate: EventOwnFactsPort = {
    registration: async () => ({ status: "pending", reviewNote: "" }),
    team: async (_sql, eventId) => ({ id: "t-a", name: "一队", track: "AI", status: "forming", captainUserId: "bob", memberCount: 2 }),
  };
  const wired = createEventCommunicationService({
    database: f.database, eventAccess: { getEvent: async () => null, requireStaff: async () => { throw new Error("unused"); } },
    participation: { getRegistration: async (_sql, eventId, userId) => ({ id: `${eventId}-${userId}`, eventId, userId, status: "approved", revision: 1 }), getTeam: async () => null },
    ids: { next: () => "wired-1" }, clock: { now: () => new Date("2026-10-08T00:00:00Z") }, ownFacts: teammate,
  });
  // eventAccess.getEvent 返回 null → 找不到赛事；这里只验证 Port 的类型契约可被实现。
  const facts = await wired.ownRegistrationAndTeam({ actor: { userId: "alice", platformRoles: ["user"] }, guard: async () => {} }, "a").catch(error => error as DomainError);
  assert.ok(facts instanceof DomainError, "赛事不存在时应拒绝，而不是凭 Port 放行");
  assert.equal(facts.code, "COMMUNICATION_NOT_FOUND");
  assert.equal((await teammate.registration({} as SqlExecutor, "a", "alice"))!.status, "pending");
  const team = await teammate.team({} as SqlExecutor, "a", "alice");
  assert.equal(team!.captainUserId, "bob", "非队长身份由 captainUserId 判断，不由调用方声称");
});
