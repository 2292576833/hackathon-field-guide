import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import {
  DEFAULT_EVENT_COMMUNITY,
  type EventCommunityConfig, type EventNotificationPort, type EventParticipationPort,
  type EventRegistrationSnapshot, type HostedEventAccessPort, type HostedEventScope, type OrganizerPrincipal,
} from "../../shared/organizer-contracts.ts";
import { createEventCommunityService } from "./service.ts";

const currentTime = "2026-10-16T08:00:00.000Z";
const on: Partial<EventCommunityConfig> = { connections: true, directMessages: true };
const notRegistered = new Set(["outsider", "staff", "guest"]);
const failure = (code: string, status?: number) => (error: unknown): boolean =>
  error instanceof DomainError && error.code === code && (status === undefined || error.status === status);

function scope(eventId: string, organizationId: string, status: HostedEventScope["status"], community?: Partial<EventCommunityConfig>): HostedEventScope {
  return {
    eventId, organizationId, organizationName: `机构${organizationId}`, title: `赛事${eventId}`, status, revision: 1, publishedRevision: 1,
    timezone: "Asia/Shanghai", startsAt: "2026-10-10T00:00:00.000Z", endsAt: "2026-10-20T00:00:00.000Z",
    registrationOpensAt: null, registrationClosesAt: null, submissionClosesAt: "2026-10-18T00:00:00.000Z",
    modules: { registration: true, teams: true, judging: true, schedule: false, accommodation: false, mealVouchers: false, icebreaking: false },
    registration: { reviewRequired: false, capacity: null }, teams: { mode: "free", minSize: 1, maxSize: 4, locksAt: null }, linkedEventId: null,
    ...(community === undefined ? {} : { community: { ...DEFAULT_EVENT_COMMUNITY, ...community } }),
  };
}

async function fixture(t: TestContext, options: { notification?: "queued" | "unconfigured" | "throw" | "none" } = {}) {
  const pg = new PGlite(); t.after(() => pg.close()); await pg.waitReady;
  await pg.exec(`CREATE TABLE auth_users(id text PRIMARY KEY);
    CREATE TABLE organizer_hosted_events(id text PRIMARY KEY, organization_id text NOT NULL, UNIQUE(id, organization_id));`);
  const peers = Array.from({ length: 24 }, (_, index) => `peer${String(index + 1).padStart(2, "0")}`);
  const users = ["alice", "bob", "carol", "dave", "erin", "staff", "outsider", "pendingUser", ...peers];
  for (const id of users) await pg.query("INSERT INTO auth_users(id) VALUES($1)", [id]);
  await pg.exec(await readFile(new URL("./migrations/001-event-community.sql", import.meta.url), "utf8"));
  for (const [eventId, organizationId] of [["event-a", "org-a"], ["event-a2", "org-a"], ["event-draft", "org-a"], ["event-archived", "org-a"], ["event-default", "org-a"], ["event-dm-off", "org-a"], ["event-purge", "org-a"], ["event-keep", "org-a"]] as const) {
    await pg.query("INSERT INTO organizer_hosted_events(id, organization_id) VALUES($1,$2)", [eventId, organizationId]);
  }

  const scopes = new Map<string, HostedEventScope>([
    ["event-a", scope("event-a", "org-a", "published", on)],
    ["event-a2", scope("event-a2", "org-a", "published", on)],
    ["event-draft", scope("event-draft", "org-a", "draft", on)],
    ["event-archived", scope("event-archived", "org-a", "archived", on)],
    ["event-default", scope("event-default", "org-a", "published")],
    ["event-dm-off", scope("event-dm-off", "org-a", "published", { connections: true, directMessages: false })],
    ["event-purge", scope("event-purge", "org-a", "published", { ...on, directMessageRetention: "purge", directMessagePurgeDays: 7 })],
    ["event-keep", scope("event-keep", "org-a", "published", { ...on, directMessageRetention: "keep", directMessagePurgeDays: 30 })],
  ]);
  function executor(query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>): SqlExecutor {
    return { async query<Row>(statement: string, params: readonly unknown[] = []) {
      const result = await query(statement, [...params]);
      return { rows: result.rows as Row[], rowCount: result.affectedRows ?? result.rows.length };
    } };
  }
  const database: DatabasePort = { ...executor((sql, params) => pg.query(sql, params)), transaction: work => pg.transaction(tx => work(executor((sql, params) => tx.query(sql, params)))) };

  const staffGrants = new Set(["event-a:staff", "event-a2:staff", "event-purge:staff", "event-default:staff"]);
  const revoked = new Set<string>();
  const principal = (userId: string, platformRoles: Actor["platformRoles"] = ["user"]): OrganizerPrincipal => ({
    actor: { userId, platformRoles },
    guard: async (sql: SqlExecutor) => { const row = await sql.query("SELECT id FROM auth_users WHERE id=$1", [userId]); if (!row.rows.length || revoked.has(userId)) throw new DomainError("SESSION_REVOKED", "会话已撤销。", { status: 401 }); },
  });
  const events: HostedEventAccessPort = {
    async getEvent(_sql, eventId) { return scopes.get(eventId) ?? null; },
    async requireStaff(_sql, actor, eventId) {
      if (!staffGrants.has(`${eventId}:${actor.userId}`)) throw new DomainError("STAFF_REQUIRED", "没有这场比赛的通知管理权限。", { status: 403 });
      return scopes.get(eventId)!;
    },
  };
  const participation: EventParticipationPort = {
    async getRegistration(_sql, eventId, userId): Promise<EventRegistrationSnapshot | null> {
      if (!scopes.has(eventId) || notRegistered.has(userId)) return null;
      if (eventId === "event-a" && userId === "pendingUser") return { id: `reg-${userId}`, eventId, userId, status: "pending", revision: 1 };
      return { id: `reg-${userId}`, eventId, userId, status: "approved", revision: 1 };
    },
    async getTeam() { return null; },
  };
  const delivered: { eventId: string; announcementId: string; revision: number; recipientUserIds: readonly string[] }[] = [];
  const mode = options.notification ?? "queued";
  const notification: EventNotificationPort | undefined = mode === "none" ? undefined : {
    async enqueue(_sql, input) {
      if (mode === "throw") throw new DomainError("NOTICE_NOT_FOUND", "既有通知端口不识别这个引用。", { status: 404 });
      delivered.push({ eventId: input.eventId, announcementId: input.announcementId, revision: input.revision, recipientUserIds: input.recipientUserIds });
      return { state: mode === "unconfigured" ? "unconfigured" as const : "queued" as const, referenceId: mode === "unconfigured" ? null : `batch-${delivered.length}` };
    },
  };
  let nextId = 0, nextKey = 0;
  const time = { value: currentTime };
  const service = createEventCommunityService({ database, clock: { now: () => new Date(time.value) }, ids: { next: () => `evc-${++nextId}` }, events, participation, notification });
  const key = () => `key-${++nextKey}`;
  return { pg, service, principal, staff: principal("staff", ["admin"]), time, key, delivered, scopes };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function connect(f: Fixture, eventId = "event-a", from = "alice", to = "bob") {
  const request = await f.service.requestConnection(f.principal(from), eventId, { peerUserId: to, idempotencyKey: f.key() });
  const accepted = await f.service.respondConnection(f.principal(to), eventId, request.connection.id, { decision: "accept", expectedRevision: request.connection.revision });
  return accepted.connection;
}

test("默认全关：连接与私信全部明确 403，不是空列表", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.overview(f.principal("alice"), "event-default"), failure("COMMUNITY_DISABLED", 403));
  await assert.rejects(f.service.requestConnection(f.principal("alice"), "event-default", { peerUserId: "bob", idempotencyKey: "k" }), failure("COMMUNITY_DISABLED", 403));
  await assert.rejects(f.service.conversation(f.principal("alice"), "event-default", "bob"), failure("COMMUNITY_DISABLED", 403));
  await assert.rejects(f.service.sendDirectMessage(f.principal("alice"), "event-default", { peerUserId: "bob", content: "hi", idempotencyKey: "k" }), failure("COMMUNITY_DISABLED", 403));
  await assert.rejects(f.service.reportUser(f.principal("alice"), "event-default", { peerUserId: "bob", reason: "spam", idempotencyKey: "k" }), failure("COMMUNITY_DISABLED", 403));
  await assert.rejects(f.service.withdrawDirectMessage(f.principal("alice"), "event-default", "m-1", { expectedRevision: 1 }), failure("COMMUNITY_DISABLED", 403));
});

test("只有私信关闭：连接仍可用，发信被拒", async t => {
  const f = await fixture(t);
  const request = await f.service.requestConnection(f.principal("alice"), "event-dm-off", { peerUserId: "bob", idempotencyKey: f.key() });
  await f.service.respondConnection(f.principal("bob"), "event-dm-off", request.connection.id, { decision: "accept", expectedRevision: 1 });
  assert.equal((await f.service.overview(f.principal("alice"), "event-dm-off")).capabilities.directMessages, false);
  const conversation = await f.service.conversation(f.principal("alice"), "event-dm-off", "bob");
  assert.equal(conversation.canSend, false);
  assert.match(conversation.sendBlockedReason ?? "", /没有开启私信/);
  await assert.rejects(f.service.sendDirectMessage(f.principal("alice"), "event-dm-off", { peerUserId: "bob", content: "hi", idempotencyKey: f.key() }), failure("COMMUNITY_DIRECT_MESSAGES_DISABLED", 403));
});

test("赛事未开启与非本场参赛者都是 403", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.overview(f.principal("alice"), "event-draft"), failure("COMMUNITY_EVENT_NOT_OPEN", 403));
  await assert.rejects(f.service.requestConnection(f.principal("alice"), "event-draft", { peerUserId: "bob", idempotencyKey: f.key() }), failure("COMMUNITY_EVENT_NOT_OPEN", 403));
  await assert.rejects(f.service.overview(f.principal("outsider"), "event-a"), failure("COMMUNITY_PARTICIPANT_REQUIRED", 403));
  await assert.rejects(f.service.overview(f.principal("pendingUser"), "event-a"), failure("COMMUNITY_PARTICIPANT_REQUIRED", 403));
  await assert.rejects(f.service.requestConnection(f.principal("alice"), "event-a", { peerUserId: "outsider", idempotencyKey: f.key() }), failure("COMMUNITY_TARGET_NOT_PARTICIPANT", 403));
});

test("请求 → 接受 → 可互发信；通知经既有端口发给对方", async t => {
  const f = await fixture(t);
  const request = await f.service.requestConnection(f.principal("alice"), "event-a", { peerUserId: "bob", idempotencyKey: f.key() });
  assert.equal(request.connection.status, "pending");
  assert.equal(request.notification.state, "queued");
  const overview = await f.service.overview(f.principal("bob"), "event-a");
  assert.equal(overview.incoming.length, 1);
  assert.equal(overview.incoming[0]!.peerUserId, "alice");
  assert.equal(overview.connections.length, 0, "未接受前不构成连接");
  const accepted = await f.service.respondConnection(f.principal("bob"), "event-a", request.connection.id, { decision: "accept", expectedRevision: 1 });
  assert.equal(accepted.connection.status, "accepted");
  assert.equal((await f.service.overview(f.principal("alice"), "event-a")).connections[0]!.peerUserId, "bob");

  const sent = await f.service.sendDirectMessage(f.principal("alice"), "event-a", { peerUserId: "bob", content: "你好", idempotencyKey: f.key() });
  assert.equal(sent.message.content, "你好");
  assert.equal(sent.notification.state, "queued");
  const thread = await f.service.conversation(f.principal("bob"), "event-a", "alice");
  assert.equal(thread.messages.length, 1);
  assert.equal(thread.messages[0]!.content, "你好");
  assert.equal(thread.messages[0]!.mine, false);
  assert.deepEqual(f.delivered.map(item => item.recipientUserIds.join()), ["bob", "alice", "bob"]);
});

test("未接受不能发信；重复请求/已连接/非被邀请方处理都被明确拒绝", async t => {
  const f = await fixture(t);
  const request = await f.service.requestConnection(f.principal("alice"), "event-a", { peerUserId: "bob", idempotencyKey: f.key() });
  await assert.rejects(f.service.sendDirectMessage(f.principal("alice"), "event-a", { peerUserId: "bob", content: "hi", idempotencyKey: f.key() }), failure("COMMUNITY_NOT_CONNECTED", 403));
  await assert.rejects(f.service.requestConnection(f.principal("alice"), "event-a", { peerUserId: "bob", idempotencyKey: f.key() }), failure("COMMUNITY_REQUEST_EXISTS"));
  await assert.rejects(f.service.respondConnection(f.principal("alice"), "event-a", request.connection.id, { decision: "accept", expectedRevision: 1 }), failure("COMMUNITY_NOT_ADDRESSEE", 403));
  await assert.rejects(f.service.cancelConnection(f.principal("bob"), "event-a", request.connection.id, { expectedRevision: 1 }), failure("COMMUNITY_NOT_REQUESTER", 403));
  await f.service.respondConnection(f.principal("bob"), "event-a", request.connection.id, { decision: "accept", expectedRevision: 1 });
  await assert.rejects(f.service.requestConnection(f.principal("alice"), "event-a", { peerUserId: "bob", idempotencyKey: f.key() }), failure("COMMUNITY_ALREADY_CONNECTED"));
  // 发起人可以取消未处理的请求，之后可重新发起（不是对方拒绝，不进入冷却）。
  const second = await f.service.requestConnection(f.principal("alice"), "event-a", { peerUserId: "carol", idempotencyKey: f.key() });
  const cancelled = await f.service.cancelConnection(f.principal("alice"), "event-a", second.connection.id, { expectedRevision: 1 });
  assert.equal(cancelled.connection.status, "cancelled");
  assert.equal((await f.service.requestConnection(f.principal("alice"), "event-a", { peerUserId: "carol", idempotencyKey: f.key() })).connection.status, "pending");
});

test("拒绝后同一对在冷却期内不能再次发起（双向）；过了冷却可以", async t => {
  const f = await fixture(t);
  const request = await f.service.requestConnection(f.principal("alice"), "event-a", { peerUserId: "bob", idempotencyKey: f.key() });
  await f.service.respondConnection(f.principal("bob"), "event-a", request.connection.id, { decision: "reject", expectedRevision: 1 });
  await assert.rejects(f.service.requestConnection(f.principal("alice"), "event-a", { peerUserId: "bob", idempotencyKey: f.key() }), failure("COMMUNITY_REQUEST_COOLDOWN"));
  await assert.rejects(f.service.requestConnection(f.principal("bob"), "event-a", { peerUserId: "alice", idempotencyKey: f.key() }), failure("COMMUNITY_REQUEST_COOLDOWN"));
  f.time.value = "2026-11-20T08:00:00.000Z";
  assert.equal((await f.service.requestConnection(f.principal("alice"), "event-a", { peerUserId: "bob", idempotencyKey: f.key() })).connection.status, "pending");
});

test("同账号在本场待处理请求有上限（20）", async t => {
  const f = await fixture(t);
  for (let index = 1; index <= 20; index += 1) {
    await f.service.requestConnection(f.principal("alice"), "event-a", { peerUserId: `peer${String(index).padStart(2, "0")}`, idempotencyKey: f.key() });
  }
  assert.equal((await f.service.overview(f.principal("alice"), "event-a")).limits.pendingRemaining, 0);
  await assert.rejects(f.service.requestConnection(f.principal("alice"), "event-a", { peerUserId: "peer21", idempotencyKey: f.key() }), failure("COMMUNITY_REQUEST_LIMIT", 429));
});

test("屏蔽后双方都不能发消息、也不能发起连接；待处理请求被自动拒绝；解除不会撤销事实", async t => {
  const f = await fixture(t);
  await connect(f);
  const blocked = await f.service.blockUser(f.principal("alice"), "event-a", "bob");
  assert.equal(blocked.rejectedRequests, 0);
  await assert.rejects(f.service.sendDirectMessage(f.principal("alice"), "event-a", { peerUserId: "bob", content: "hi", idempotencyKey: f.key() }), failure("COMMUNITY_BLOCKED", 403));
  await assert.rejects(f.service.sendDirectMessage(f.principal("bob"), "event-a", { peerUserId: "alice", content: "hi", idempotencyKey: f.key() }), failure("COMMUNITY_BLOCKED", 403));
  await assert.rejects(f.service.requestConnection(f.principal("bob"), "event-a", { peerUserId: "alice", idempotencyKey: f.key() }), failure("COMMUNITY_BLOCKED", 403));
  assert.equal((await f.service.blockUser(f.principal("alice"), "event-a", "bob")).block.id, blocked.block.id, "重复屏蔽幂等");
  assert.equal((await f.service.unblockUser(f.principal("alice"), "event-a", "bob")).removed, true);
  assert.equal((await f.service.sendDirectMessage(f.principal("alice"), "event-a", { peerUserId: "bob", content: "after", idempotencyKey: f.key() })).message.content, "after");

  // 屏蔽会拒绝双方之间待处理的请求；解除后仍受拒绝冷却约束。
  const pending = await f.service.requestConnection(f.principal("carol"), "event-a", { peerUserId: "dave", idempotencyKey: f.key() });
  const byDave = await f.service.blockUser(f.principal("dave"), "event-a", "carol");
  assert.equal(byDave.rejectedRequests, 1);
  await assert.rejects(f.service.requestConnection(f.principal("carol"), "event-a", { peerUserId: "dave", idempotencyKey: f.key() }), failure("COMMUNITY_BLOCKED", 403));
  await f.service.unblockUser(f.principal("dave"), "event-a", "carol");
  await assert.rejects(f.service.requestConnection(f.principal("carol"), "event-a", { peerUserId: "dave", idempotencyKey: f.key() }), failure("COMMUNITY_REQUEST_COOLDOWN"));
  assert.equal(pending.connection.status, "pending");
});

test("单条限长与同账号同赛事限频", async t => {
  const f = await fixture(t);
  await connect(f);
  await assert.rejects(f.service.sendDirectMessage(f.principal("alice"), "event-a", { peerUserId: "bob", content: "x".repeat(1001), idempotencyKey: f.key() }), failure("COMMUNITY_INVALID_INPUT", 422));
  await assert.rejects(f.service.sendDirectMessage(f.principal("alice"), "event-a", { peerUserId: "bob", content: "   ", idempotencyKey: f.key() }), failure("COMMUNITY_INVALID_INPUT", 422));
  for (let index = 0; index < 20; index += 1) {
    await f.service.sendDirectMessage(f.principal("alice"), "event-a", { peerUserId: "bob", content: `第${index}条`, idempotencyKey: `rate-${index}` });
  }
  assert.equal((await f.service.conversation(f.principal("alice"), "event-a", "bob")).limits.rateRemaining, 0);
  await assert.rejects(f.service.sendDirectMessage(f.principal("alice"), "event-a", { peerUserId: "bob", content: "overflow", idempotencyKey: "rate-overflow" }), failure("COMMUNITY_RATE_LIMITED", 429));
  // 对方不受影响。
  assert.equal((await f.service.sendDirectMessage(f.principal("bob"), "event-a", { peerUserId: "alice", content: "对方第一条", idempotencyKey: "bob-1" })).message.content, "对方第一条");
});

test("本人可撤回自己发出的消息，撤回后对方读不到内容；非本人/版本不符被拒", async t => {
  const f = await fixture(t);
  await connect(f);
  const sent = await f.service.sendDirectMessage(f.principal("alice"), "event-a", { peerUserId: "bob", content: "要撤回的正文", idempotencyKey: f.key() });
  assert.equal((await f.service.conversation(f.principal("bob"), "event-a", "alice")).messages[0]!.content, "要撤回的正文");
  await assert.rejects(f.service.withdrawDirectMessage(f.principal("bob"), "event-a", sent.message.id, { expectedRevision: 1 }), failure("COMMUNITY_ACCESS_DENIED", 403));
  await assert.rejects(f.service.withdrawDirectMessage(f.principal("alice"), "event-a", sent.message.id, { expectedRevision: 9 }), failure("COMMUNITY_VERSION_CONFLICT", 409));
  const withdrawn = await f.service.withdrawDirectMessage(f.principal("alice"), "event-a", sent.message.id, { expectedRevision: 1 });
  assert.equal(withdrawn.status, "withdrawn");
  assert.equal(withdrawn.content, null);
  assert.match(withdrawn.display, /撤回/);
  const peerView = await f.service.conversation(f.principal("bob"), "event-a", "alice");
  assert.equal(peerView.messages[0]!.content, null);
  assert.equal(peerView.messages[0]!.withdrawn, true);
  await assert.rejects(f.service.withdrawDirectMessage(f.principal("alice"), "event-a", sent.message.id, { expectedRevision: 2 }), failure("COMMUNITY_STATE_INVALID"));
  const row = await f.pg.query<{ content: string | null; status: string; sender_user_id: string; recipient_user_id: string }>("SELECT content,status,sender_user_id,recipient_user_id FROM evc_direct_messages WHERE id=$1", [sent.message.id]);
  assert.equal(row.rows[0]!.content, null);
  assert.equal(row.rows[0]!.status, "withdrawn");
  assert.equal(row.rows[0]!.sender_user_id, "alice", "最小事实保留");
});

test("到期清理只清正文、保留最小事实；保留口径不是 purge 时不做清理", async t => {
  const f = await fixture(t);
  await connect(f, "event-purge");
  const old = await f.service.sendDirectMessage(f.principal("alice"), "event-purge", { peerUserId: "bob", content: "七天前的正文", idempotencyKey: f.key() });
  f.time.value = "2026-10-24T08:00:00.000Z";
  const peerView = await f.service.conversation(f.principal("bob"), "event-purge", "alice");
  assert.equal(peerView.messages[0]!.content, null, "超过清理天数的正文即使后台任务没跑也不返回");
  assert.equal(peerView.messages[0]!.purged, true);
  const fresh = await f.service.sendDirectMessage(f.principal("alice"), "event-purge", { peerUserId: "bob", content: "新正文", idempotencyKey: f.key() });
  const maintenance = await f.service.maintainRetention({ eventId: "event-purge", organizationId: "org-a" });
  assert.equal(maintenance.state, "purged");
  assert.equal(maintenance.purged, 1);
  assert.equal(maintenance.purgeDays, 7);
  const row = await f.pg.query<{ content: string | null; status: string; created_at: string; sender_user_id: string }>("SELECT content,status,created_at,sender_user_id FROM evc_direct_messages WHERE id=$1", [old.message.id]);
  assert.equal(row.rows[0]!.content, null);
  assert.equal(row.rows[0]!.status, "purged");
  assert.equal(row.rows[0]!.sender_user_id, "alice", "最小事实（谁、何时、哪条连接）保留");
  assert.ok(row.rows[0]!.created_at);
  assert.equal((await f.pg.query<{ content: string | null }>("SELECT content FROM evc_direct_messages WHERE id=$1", [fresh.message.id])).rows[0]!.content, "新正文");
  const second = await f.service.maintainRetention({ eventId: "event-purge", organizationId: "org-a" });
  assert.equal(second.purged, 0);
  assert.equal((await f.service.maintainRetention({ eventId: "event-keep", organizationId: "org-a" })).state, "skipped");
  await assert.rejects(f.service.maintainRetention({ eventId: "event-purge", organizationId: "org-other" }), failure("COMMUNITY_EVENT_SCOPE_MISMATCH", 403));
});

test("举报记录事实与最近消息快照，主办方按既有权限只读；不自行裁决", async t => {
  const f = await fixture(t);
  await connect(f);
  const before = await f.service.organizerReports(f.staff, "event-a");
  assert.equal(before.count, 0);
  await f.service.sendDirectMessage(f.principal("alice"), "event-a", { peerUserId: "bob", content: "被举报的正文", idempotencyKey: f.key() });
  const reported = await f.service.reportUser(f.principal("bob"), "event-a", { peerUserId: "alice", reason: "harassment", detail: "持续骚扰", idempotencyKey: f.key() });
  assert.equal(reported.report.status, "open");
  assert.equal(reported.report.snapshot.length, 1);
  assert.equal(reported.report.snapshot[0]!.content, "被举报的正文");
  const view = await f.service.organizerReports(f.staff, "event-a");
  assert.equal(view.count, 1);
  assert.equal(view.reports[0]!.reasonLabel, "骚扰或人身攻击");
  assert.equal(view.reports[0]!.reporterUserId, "bob");
  assert.equal(view.reports[0]!.status, "open");
  // 重复提交同一重试标识返回原记录，不新增第二份。
  assert.equal((await f.service.reportUser(f.principal("bob"), "event-a", { peerUserId: "alice", reason: "harassment", detail: "持续骚扰", idempotencyKey: reported.report.idempotencyKey })).report.id, reported.report.id);
  await assert.rejects(f.service.organizerReports(f.principal("alice"), "event-a"), failure("STAFF_REQUIRED", 403));
  await assert.rejects(f.service.organizerReports(f.principal("outsider"), "event-a"), failure("STAFF_REQUIRED", 403));
});

test("主办方读不到任何私人消息：没有会话通道，举报只会带被举报连接自己的快照", async t => {
  const f = await fixture(t);
  await connect(f, "event-a", "alice", "bob");
  await connect(f, "event-a", "alice", "dave");
  await f.service.sendDirectMessage(f.principal("alice"), "event-a", { peerUserId: "bob", content: "已举报连接的正文", idempotencyKey: f.key() });
  await f.service.sendDirectMessage(f.principal("alice"), "event-a", { peerUserId: "dave", content: "未被举报连接的正文", idempotencyKey: f.key() });
  // 主办方没有读取任意私信的通道。
  await assert.rejects(f.service.conversation(f.staff, "event-a", "bob"), failure("COMMUNITY_PARTICIPANT_REQUIRED", 403));
  await assert.rejects(f.service.overview(f.staff, "event-a"), failure("COMMUNITY_PARTICIPANT_REQUIRED", 403));
  const empty = await f.service.organizerReports(f.staff, "event-a");
  assert.equal(empty.count, 0);
  assert.ok(!JSON.stringify(empty).includes("未被举报连接的正文"));
  const connections = await f.service.overview(f.principal("alice"), "event-a");
  const bobConnection = connections.connections.find(item => item.peerUserId === "bob")!;
  await f.service.reportUser(f.principal("alice"), "event-a", { peerUserId: "bob", reason: "spam", connectionId: bobConnection.id, idempotencyKey: f.key() });
  const view = await f.service.organizerReports(f.staff, "event-a");
  const text = JSON.stringify(view);
  assert.ok(text.includes("已举报连接的正文"));
  assert.ok(!text.includes("未被举报连接的正文"), "未被举报的对话不出现");
  assert.ok(!/"(email|phone)"/.test(text));
});

test("连接只在本场有效，不跨赛事；同机构另一场比赛没有这条连接", async t => {
  const f = await fixture(t);
  await connect(f, "event-a");
  await assert.rejects(f.service.sendDirectMessage(f.principal("alice"), "event-a2", { peerUserId: "bob", content: "hi", idempotencyKey: f.key() }), failure("COMMUNITY_NOT_CONNECTED", 403));
  assert.equal((await f.service.overview(f.principal("alice"), "event-a2")).connections.length, 0);
  // 在 event-a2 里可以重新走一次双向同意。
  const second = await connect(f, "event-a2");
  assert.notEqual(second.id, (await f.service.overview(f.principal("alice"), "event-a")).connections[0]!.id);
});

test("通知只走既有端口：未注入/端口拒绝/未配置都明确说明未发送", async t => {
  const noPort = await fixture(t, { notification: "none" });
  const a = await noPort.service.requestConnection(noPort.principal("alice"), "event-a", { peerUserId: "bob", idempotencyKey: noPort.key() });
  assert.equal(a.notification.state, "unconfigured");
  assert.match(a.notification.detail, /未发送/);

  const throwing = await fixture(t, { notification: "throw" });
  const b = await throwing.service.requestConnection(throwing.principal("alice"), "event-a", { peerUserId: "bob", idempotencyKey: throwing.key() });
  assert.equal(b.notification.state, "not_sent");
  assert.match(b.notification.detail, /通知未发送/);
  assert.equal((await throwing.service.overview(throwing.principal("bob"), "event-a")).incoming.length, 1, "通知失败不影响站内事实");

  const unconfigured = await fixture(t, { notification: "unconfigured" });
  const c = await unconfigured.service.requestConnection(unconfigured.principal("alice"), "event-a", { peerUserId: "bob", idempotencyKey: unconfigured.key() });
  assert.equal(c.notification.state, "unconfigured");
  assert.match(c.notification.detail, /未配置/);
  assert.equal(unconfigured.delivered.length, 1, "仍然经既有端口调用，只是端口自己返回未配置");
});

test("消息内容不进入任何模型训练：不导入任何 AI/队列模块，投影里没有邮箱电话字段", async () => {
  const files = ["./service.ts", "./policy.ts", "./postgres.ts", "./handlers.ts"];
  const allowed = new Set([
    "../../shared/contracts.ts", "../../shared/errors.ts", "../../shared/organizer-contracts.ts",
    "../../shared/persistence.ts", "../../components/client-api.ts",
  ]);
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map(match => match[1]!).filter(specifier => specifier.startsWith("../../"));
    for (const specifier of imports) assert.ok(allowed.has(specifier), `${file} 导入了未登记的跨模块路径：${specifier}`);
    assert.doesNotMatch(source, /openai|anthropic|deepseek|dsh|ai-queue|training.?job/i, `${file} 不应出现任何 AI/模型/训练接入`);
  }
  const model = await readFile(new URL("./model.ts", import.meta.url), "utf8");
  assert.doesNotMatch(model, /\bemail\b|\bphone\b/i, "消息与连接投影不得包含邮箱或电话字段");
});
