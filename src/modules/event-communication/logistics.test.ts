import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { EventParticipationPort, HostedEventAccessPort, HostedEventScope, OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { createEventLogisticsService } from "./logistics.ts";

const date = "2026-10-11T00:00:00.000Z", expiry = "2026-10-13T00:00:00.000Z";
const fields = { userId: "alice", location: "会场旁酒店", room: "301", checkIn: "2026-10-11T18:00:00+08:00", checkOut: "2026-10-12T12:00:00+08:00", note: "前台报参赛券号" };
const code = (name: string) => (error: unknown) => error instanceof DomainError && error.code === name;
async function fixture() {
  const engine = new PGlite(); await engine.waitReady;
  await engine.exec("CREATE TABLE auth_users(id text PRIMARY KEY); INSERT INTO auth_users(id) VALUES('staff'),('staff2'),('alice'),('bob'),('other');");
  await engine.exec(await readFile(new URL("./migrations/002_logistics.sql", import.meta.url), "utf8"));
  const calls: { sql: string; parameters: readonly unknown[] }[] = [];
  function executor(raw: { query: PGlite["query"] }): SqlExecutor {
    return { async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      calls.push({ sql: statement, parameters }); const result = await raw.query(statement, [...parameters]);
      return { rows: result.rows as Row[], rowCount: result.rows.length || result.affectedRows || 0 };
    } };
  }
  const direct = executor(engine);
  const database: DatabasePort = { query: direct.query, transaction: work => engine.transaction(tx => work(executor(tx))) };
  let id = 0, tokenId = 0, clock = new Date(date), guardHook: ((userId: string, count: number) => void) | null = null;
  const guards = new Map<string, number>(), sessions = new Set(["staff", "staff2", "alice", "bob", "other"]);
  const grants = new Map<string, Set<string>>([["staff", new Set(["a", "b"])], ["staff2", new Set(["a"])], ["other", new Set(["c"])]]);
  function event(id: string, organizationId: string): HostedEventScope {
    return { eventId: id, organizationId, organizationName: organizationId, title: id, status: "published", revision: 1, publishedRevision: 1, timezone: "Asia/Shanghai", startsAt: date, endsAt: expiry, registrationOpensAt: null, registrationClosesAt: null, submissionClosesAt: null,
      modules: { registration: true, teams: true, icebreaking: true, judging: true, schedule: true, accommodation: true, mealVouchers: true }, registration: { reviewRequired: false, capacity: null }, teams: { mode: "free", minSize: 1, maxSize: 4, locksAt: null }, linkedEventId: null };
  }
  const events = new Map([["a", event("a", "org1")], ["b", event("b", "org1")], ["c", event("c", "org2")]]);
  const registrations = new Map<string, "approved" | "withdrawn" | "pending">();
  for (const eventId of events.keys()) for (const user of ["alice", "bob"]) registrations.set(`${eventId}:${user}`, "approved");
  const access: HostedEventAccessPort = {
    async getEvent(_sql, eventId) { return events.get(eventId) ?? null; },
    async requireStaff(_sql, actor, eventId, capability) {
      assert.equal(capability, "logistics_manage");
      if (!grants.get(actor.userId)?.has(eventId)) throw new DomainError("FORBIDDEN", "无后勤权限", { status: 403 });
      return events.get(eventId)!;
    },
  };
  const participation: EventParticipationPort = {
    async getRegistration(_sql, eventId, userId) { const status = registrations.get(`${eventId}:${userId}`); return status ? { id: `reg-${eventId}-${userId}`, eventId, userId, status, revision: 1 } : null; },
    async getTeam() { return null; },
  };
  function principal(userId: string): OrganizerPrincipal {
    return { actor: { userId, platformRoles: ["user"] } as Actor, async guard() {
      const count = (guards.get(userId) ?? 0) + 1; guards.set(userId, count); guardHook?.(userId, count);
      if (!sessions.has(userId)) throw new DomainError("SESSION_EXPIRED", "请重新登录", { status: 401 });
    } };
  }
  const service = createEventLogisticsService({ database, eventAccess: access, participation, clock: { now: () => clock }, ids: { next: () => `l-${++id}` }, tokens: { generate: () => `opaque_${String(++tokenId).padStart(40, "0")}` } });
  return { engine, database, calls, service, principal, guards, sessions, grants, registrations, events,
    hook: (hook: typeof guardHook) => { guardHook = hook; }, time: (value: string) => { clock = new Date(value); }, close: () => engine.close() };
}

test("住宿本人隔离与组织/赛事范围：同一机构另一赛事不显示，猜ID无法跨组织操作", async () => {
  const f = await fixture(); try {
    await f.service.assignAccommodation(f.principal("staff"), "a", { ...fields, expectedRevision: 0 });
    const own = await f.service.ownServices(f.principal("alice"), "a"); assert.equal(own.accommodation?.room, "301");
    assert.equal((await f.service.ownServices(f.principal("bob"), "a")).accommodation, null);
    assert.equal((await f.service.ownServices(f.principal("alice"), "b")).accommodation, null);
    assert.deepEqual(await f.service.listAccommodation(f.principal("staff"), "b"), []);
    assert.deepEqual(await f.service.listAccommodation(f.principal("other"), "c"), []);
    await assert.rejects(f.service.listAccommodation(f.principal("other"), "a"), code("FORBIDDEN"));
    await assert.rejects(f.service.listAccommodation(f.principal("alice"), "a"), code("FORBIDDEN"));
    f.registrations.set("a:alice", "withdrawn");
    await assert.rejects(f.service.ownServices(f.principal("alice"), "a"), code("FORBIDDEN"));
    await assert.rejects(f.service.assignAccommodation(f.principal("staff"), "a", { ...fields, expectedRevision: 1 }), code("FORBIDDEN"));
  } finally { await f.close(); }
});

test("住宿更正版本和并发修改不覆盖，不可变版本保留原安排", async () => {
  const f = await fixture(); try {
    const initial = await f.service.assignAccommodation(f.principal("staff"), "a", { ...fields, expectedRevision: 0 });
    const results = await Promise.allSettled(["302", "303"].map(room => f.service.assignAccommodation(f.principal("staff"), "a", { ...fields, room, expectedRevision: initial.revision })));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    const rejected = results.find(r => r.status === "rejected"); assert.ok(rejected?.status === "rejected"); assert.ok(code("VERSION_CONFLICT")(rejected.reason));
    const versions = await f.database.query<{ document: { room: string } }>("SELECT document FROM ec_accommodation_versions ORDER BY revision");
    assert.equal(versions.rowCount, 2); assert.equal(versions.rows[0]!.document.room, "301");
    assert.equal((await f.service.listAccommodation(f.principal("staff"), "a"))[0]!.revision, 2);
    await assert.rejects(f.database.query("UPDATE ec_accommodation_versions SET document='{}'::jsonb"), /immutable/);
  } finally { await f.close(); }
});

test("CSV预览实际持久，错误不部分分配，确认绑定预览者且重试一次入库", async () => {
  const f = await fixture(); try {
    const csv = 'userId,location,room,checkIn,checkOut,note\r\nalice,"酒店,东楼",301,2026-10-11T18:00:00+08:00,2026-10-12T12:00:00+08:00,"前台\n自助"\r\nbob,酒店,302,2026-10-11T18:00:00+08:00,2026-10-12T12:00:00+08:00,';
    const preview = await f.service.previewAccommodationImport(f.principal("staff"), "a", { csv });
    assert.equal(preview.rows.length, 2); assert.equal(preview.errors.length, 0); assert.equal(preview.rows[0]!.location, "酒店,东楼");
    assert.deepEqual(await f.service.listAccommodation(f.principal("staff"), "a"), []);
    assert.equal((await f.database.query("SELECT id FROM ec_accommodation_imports")).rowCount, 1);
    await assert.rejects(f.service.confirmAccommodationImport(f.principal("staff2"), "a", { previewId: preview.id }), code("LOGISTICS_NOT_FOUND"));
    await assert.rejects(f.service.confirmAccommodationImport(f.principal("staff"), "b", { previewId: preview.id }), code("LOGISTICS_NOT_FOUND"));
    const results = await Promise.all([f.service.confirmAccommodationImport(f.principal("staff"), "a", { previewId: preview.id }), f.service.confirmAccommodationImport(f.principal("staff"), "a", { previewId: preview.id })]);
    assert.deepEqual(results.map(r => r.replayed).sort(), [false, true]); assert.equal(results[0]!.assignments.length, 2);
    assert.equal((await f.database.query("SELECT * FROM ec_accommodation_versions")).rowCount, 2);
    const bad = await f.service.previewAccommodationImport(f.principal("staff"), "a", { csv: csv.replace("bob,酒店", "unknown,酒店") });
    assert.equal(bad.errors.length, 1);
    await assert.rejects(f.service.confirmAccommodationImport(f.principal("staff"), "a", { previewId: bad.id }), code("LOGISTICS_INVALID_INPUT"));
    assert.equal((await f.database.query("SELECT * FROM ec_accommodation_versions")).rowCount, 2);
  } finally { await f.close(); }
});

test("导入确认重新校验安排版本、过期和资格，发生变化整批不写", async () => {
  const f = await fixture(); try {
    const csv = "userId,location,room,checkIn,checkOut,note\nalice,酒店,301,2026-10-11T18:00:00+08:00,2026-10-12T12:00:00+08:00,\nbob,酒店,302,2026-10-11T18:00:00+08:00,2026-10-12T12:00:00+08:00,";
    const preview = await f.service.previewAccommodationImport(f.principal("staff"), "a", { csv });
    await f.service.assignAccommodation(f.principal("staff"), "a", { ...fields, expectedRevision: 0 });
    await assert.rejects(f.service.confirmAccommodationImport(f.principal("staff"), "a", { previewId: preview.id }), code("VERSION_CONFLICT"));
    assert.equal((await f.service.listAccommodation(f.principal("staff"), "a")).length, 1);
    const fresh = await f.service.previewAccommodationImport(f.principal("staff"), "a", { csv });
    f.registrations.set("a:bob", "withdrawn");
    await assert.rejects(f.service.confirmAccommodationImport(f.principal("staff"), "a", { previewId: fresh.id }), code("FORBIDDEN"));
    f.registrations.set("a:bob", "approved"); f.time("2026-10-11T00:30:00.000Z");
    await assert.rejects(f.service.confirmAccommodationImport(f.principal("staff"), "a", { previewId: fresh.id }), code("IMPORT_EXPIRED"));
    assert.equal((await f.service.listAccommodation(f.principal("staff"), "a")).length, 1);
    await assert.rejects(f.service.previewAccommodationImport(f.principal("staff"), "a", { csv: "userId,location\nalice,酒店" }), code("LOGISTICS_INVALID_INPUT"));
    await assert.rejects(f.service.previewAccommodationImport(f.principal("staff"), "a", { csv: csv.replace("bob,酒店", "alice,酒店") }).then(value => f.service.confirmAccommodationImport(f.principal("staff"), "a", { previewId: value.id })), code("LOGISTICS_INVALID_INPUT"));
  } finally { await f.close(); }
});

test("发券凭据只返回一次，数据库/个人列表没有明文或第三方链接，类型和用户绑定幂等", async () => {
  const f = await fixture(); try {
    const type = await f.service.createVoucherType(f.principal("staff"), "a", { name: "午餐", uses: 1, expiresAt: expiry });
    const issued = await f.service.issueVoucher(f.principal("staff"), "a", { userId: "alice", typeId: type.id, idempotencyKey: "issue-1" });
    assert.ok(issued.token); assert.equal(issued.replayed, false);
    const replay = await f.service.issueVoucher(f.principal("staff"), "a", { userId: "alice", typeId: type.id, idempotencyKey: "issue-1" });
    assert.equal(replay.token, null); assert.equal(replay.replayed, true); assert.equal(replay.voucher.id, issued.voucher.id);
    await assert.rejects(f.service.issueVoucher(f.principal("staff"), "a", { userId: "bob", typeId: type.id, idempotencyKey: "issue-1" }), code("IDEMPOTENCY_CONFLICT"));
    await assert.rejects(f.service.issueVoucher(f.principal("staff"), "b", { userId: "alice", typeId: type.id, idempotencyKey: "issue-1" }), code("LOGISTICS_NOT_FOUND"));
    const stored = await f.database.query<{ token_hash: string; document: unknown }>("SELECT token_hash,document FROM ec_meal_vouchers");
    assert.match(stored.rows[0]!.token_hash, /^[0-9a-f]{64}$/); assert.ok(!JSON.stringify(stored.rows).includes(issued.token));
    const own = await f.service.ownServices(f.principal("alice"), "a"); assert.equal(own.vouchers.length, 1); assert.ok(!JSON.stringify(own).includes(issued.token)); assert.ok(!JSON.stringify(own).includes("token_hash"));
    assert.equal((await f.service.ownServices(f.principal("bob"), "a")).vouchers.length, 0);
    assert.ok(!JSON.stringify(f.calls).includes(issued.token));
  } finally { await f.close(); }
});

test("最后一次核销并发仅一次成功，同请求重试返回同一操作员回执", async () => {
  const f = await fixture(); try {
    const type = await f.service.createVoucherType(f.principal("staff"), "a", { name: "午餐", uses: 1, expiresAt: expiry });
    const issued = await f.service.issueVoucher(f.principal("staff"), "a", { userId: "alice", typeId: type.id, idempotencyKey: "issue" });
    const races = await Promise.allSettled(["r1", "r2"].map(key => f.service.redeemVoucher(f.principal("staff"), "a", { token: issued.token!, idempotencyKey: key })));
    assert.equal(races.filter(r => r.status === "fulfilled").length, 1); const failed = races.find(r => r.status === "rejected"); assert.ok(failed?.status === "rejected"); assert.ok(code("VOUCHER_EXHAUSTED")(failed.reason));
    const winnerIndex = races.findIndex(r => r.status === "fulfilled"), won = races[winnerIndex]!; assert.ok(won.status === "fulfilled");
    const replay = await f.service.redeemVoucher(f.principal("staff"), "a", { token: issued.token!, idempotencyKey: `r${winnerIndex + 1}` });
    assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, won.value.receipt); assert.equal(replay.receipt.operatorUserId, "staff"); assert.equal(replay.receipt.remainingUses, 0);
    assert.equal((await f.database.query("SELECT * FROM ec_voucher_redemptions")).rowCount, 1);
    assert.equal((await f.service.ownServices(f.principal("alice"), "a")).vouchers[0]!.state, "exhausted");
    await assert.rejects(f.service.redeemVoucher(f.principal("staff"), "a", { voucherId: issued.voucher.id, idempotencyKey: `r${winnerIndex + 1}` }), code("IDEMPOTENCY_CONFLICT"));
    f.grants.delete("staff"); await assert.rejects(f.service.redeemVoucher(f.principal("staff"), "a", { token: issued.token!, idempotencyKey: `r${winnerIndex + 1}` }), code("FORBIDDEN"));
  } finally { await f.close(); }
});

test("人工核销仅后勤人员可用且留操作员记录，过期/撤销/跨赛事/撤报名拒绝", async () => {
  const f = await fixture(); try {
    const type = await f.service.createVoucherType(f.principal("staff"), "a", { name: "三餐", uses: 3, expiresAt: expiry });
    const issued = await f.service.issueVoucher(f.principal("staff"), "a", { userId: "alice", typeId: type.id, idempotencyKey: "issue" });
    await assert.rejects(f.service.redeemVoucher(f.principal("alice"), "a", { voucherId: issued.voucher.id, idempotencyKey: "r" }), code("FORBIDDEN"));
    await assert.rejects(f.service.redeemVoucher(f.principal("staff"), "b", { token: issued.token!, idempotencyKey: "r" }), code("LOGISTICS_NOT_FOUND"));
    await assert.rejects(f.service.redeemVoucher(f.principal("other"), "c", { voucherId: issued.voucher.id, idempotencyKey: "r" }), code("LOGISTICS_NOT_FOUND"));
    const result = await f.service.redeemVoucher(f.principal("staff2"), "a", { voucherId: issued.voucher.id, idempotencyKey: "manual" });
    assert.equal(result.receipt.mode, "manual"); assert.equal(result.receipt.operatorUserId, "staff2"); assert.equal(result.receipt.remainingUses, 2);
    await assert.rejects(f.service.revokeVoucher(f.principal("staff"), "a", { voucherId: issued.voucher.id, expectedRevision: 1 }), code("VERSION_CONFLICT"));
    const revoked = await f.service.revokeVoucher(f.principal("staff"), "a", { voucherId: issued.voucher.id, expectedRevision: 2 }); assert.equal(revoked.state, "revoked"); assert.equal(revoked.revokedBy, "staff");
    await assert.rejects(f.service.redeemVoucher(f.principal("staff"), "a", { token: issued.token!, idempotencyKey: "after-revoke" }), code("VOUCHER_REVOKED"));
    const another = await f.service.issueVoucher(f.principal("staff"), "a", { userId: "alice", typeId: type.id, idempotencyKey: "another" });
    f.registrations.set("a:alice", "withdrawn");
    await assert.rejects(f.service.redeemVoucher(f.principal("staff"), "a", { voucherId: another.voucher.id, idempotencyKey: "withdrawn" }), code("FORBIDDEN"));
    f.registrations.set("a:alice", "approved"); f.time(expiry);
    await assert.rejects(f.service.redeemVoucher(f.principal("staff"), "a", { voucherId: another.voucher.id, idempotencyKey: "expired" }), code("VOUCHER_EXPIRED"));
    assert.equal((await f.service.listVouchers(f.principal("staff"), "a")).find(v => v.id === another.voucher.id)!.state, "expired");
    await assert.rejects(f.service.issueVoucher(f.principal("staff"), "a", { userId: "alice", typeId: type.id, idempotencyKey: "expired-type" }), code("VOUCHER_EXPIRED"));
  } finally { await f.close(); }
});

test("同键并发发放和核销仅一次写入，多个券种独立计次", async () => {
  const f = await fixture(); try {
    const type = await f.service.createVoucherType(f.principal("staff"), "a", { name: "早餐", uses: 2, expiresAt: expiry });
    const dinner = await f.service.createVoucherType(f.principal("staff"), "a", { name: "晚餐", uses: 1, expiresAt: expiry });
    const command = { userId: "alice", typeId: type.id, idempotencyKey: "same" };
    const issued = await Promise.all([f.service.issueVoucher(f.principal("staff"), "a", command), f.service.issueVoucher(f.principal("staff"), "a", command)]);
    assert.deepEqual(issued.map(v => v.replayed).sort(), [false, true]); assert.equal(issued[0]!.voucher.id, issued[1]!.voucher.id);
    const voucherId = issued[0]!.voucher.id;
    const redeem = { voucherId, idempotencyKey: "same-redemption" };
    const redeemed = await Promise.all([f.service.redeemVoucher(f.principal("staff"), "a", redeem), f.service.redeemVoucher(f.principal("staff"), "a", redeem)]);
    assert.deepEqual(redeemed.map(v => v.replayed).sort(), [false, true]); assert.equal(redeemed[0]!.receipt.id, redeemed[1]!.receipt.id);
    const second = await f.service.issueVoucher(f.principal("staff"), "a", { userId: "alice", typeId: dinner.id, idempotencyKey: "dinner" });
    assert.equal((await f.service.ownServices(f.principal("alice"), "a")).vouchers.length, 2);
    await assert.rejects(f.service.redeemVoucher(f.principal("staff"), "a", { voucherId: second.voucher.id, idempotencyKey: "same-redemption" }), code("IDEMPOTENCY_CONFLICT"));
    assert.equal((await f.service.listVouchers(f.principal("staff"), "a", { userId: "alice" })).find(v => v.id === voucherId)!.remainingUses, 1);
  } finally { await f.close(); }
});

test("事务末尾重新校验会话/工作人员/报名：失败回滚分配、凭据和核销回执", async () => {
  const f = await fixture(); try {
    f.hook((userId, count) => { if (userId === "staff" && count === 2) f.sessions.delete("staff"); });
    await assert.rejects(f.service.assignAccommodation(f.principal("staff"), "a", { ...fields, expectedRevision: 0 }), code("SESSION_EXPIRED"));
    assert.equal((await f.database.query("SELECT * FROM ec_accommodation_assignments")).rowCount, 0);
    f.sessions.add("staff"); f.hook(null);
    const type = await f.service.createVoucherType(f.principal("staff"), "a", { name: "午餐", uses: 1, expiresAt: expiry });
    const nextGuard = f.guards.get("staff")! + 2;
    f.hook((userId, count) => { if (userId === "staff" && count === nextGuard) f.registrations.set("a:alice", "withdrawn"); });
    await assert.rejects(f.service.issueVoucher(f.principal("staff"), "a", { userId: "alice", typeId: type.id, idempotencyKey: "guarded" }), code("FORBIDDEN"));
    assert.equal((await f.database.query("SELECT * FROM ec_meal_vouchers")).rowCount, 0); assert.equal((await f.database.query("SELECT * FROM ec_voucher_issues")).rowCount, 0);
    f.hook(null); f.registrations.set("a:alice", "approved");
    const issued = await f.service.issueVoucher(f.principal("staff"), "a", { userId: "alice", typeId: type.id, idempotencyKey: "guarded" });
    const finalGuard = f.guards.get("staff")! + 2;
    f.hook((userId, count) => { if (userId === "staff" && count === finalGuard) f.grants.delete("staff"); });
    await assert.rejects(f.service.redeemVoucher(f.principal("staff"), "a", { voucherId: issued.voucher.id, idempotencyKey: "guarded" }), code("FORBIDDEN"));
    assert.equal((await f.database.query("SELECT * FROM ec_voucher_redemptions")).rowCount, 0);
    assert.equal((await f.service.listVouchers(f.principal("staff2"), "a"))[0]!.remainingUses, 1);
  } finally { await f.close(); }
});

test("模块关闭和归档阻止新写，保留本人及工作人员历史读取，输入有界", async () => {
  const f = await fixture(); try {
    await f.service.assignAccommodation(f.principal("staff"), "a", { ...fields, expectedRevision: 0 });
    const type = await f.service.createVoucherType(f.principal("staff"), "a", { name: "午餐", uses: 1, expiresAt: expiry });
    const issued = await f.service.issueVoucher(f.principal("staff"), "a", { userId: "alice", typeId: type.id, idempotencyKey: "one" });
    f.events.set("a", { ...f.events.get("a")!, modules: { ...f.events.get("a")!.modules, accommodation: false, mealVouchers: false } });
    await assert.rejects(f.service.assignAccommodation(f.principal("staff"), "a", { ...fields, expectedRevision: 1 }), code("EVENT_MODULE_DISABLED"));
    await assert.rejects(f.service.redeemVoucher(f.principal("staff"), "a", { voucherId: issued.voucher.id, idempotencyKey: "r" }), code("EVENT_MODULE_DISABLED"));
    const own = await f.service.ownServices(f.principal("alice"), "a"); assert.equal(own.modules.accommodation, false); assert.ok(own.accommodation); assert.equal(own.vouchers.length, 1);
    f.events.set("a", { ...f.events.get("a")!, status: "archived" });
    assert.equal((await f.service.listAccommodation(f.principal("staff"), "a")).length, 1);
    await assert.rejects(f.service.revokeVoucher(f.principal("staff"), "a", { voucherId: issued.voucher.id, expectedRevision: 1 }), code("EVENT_READ_ONLY"));
    await assert.rejects(f.service.assignAccommodation(f.principal("staff"), "a", { ...fields, checkOut: fields.checkIn, expectedRevision: 1 }), code("LOGISTICS_INVALID_INPUT"));
    await assert.rejects(f.service.assignAccommodation(f.principal("staff"), "a", { ...fields, checkIn: "2026-02-30T12:00:00Z", expectedRevision: 1 }), code("LOGISTICS_INVALID_INPUT"));
    await assert.rejects(f.service.createVoucherType(f.principal("staff"), "a", { name: "午餐", uses: 0, expiresAt: expiry }), code("LOGISTICS_INVALID_INPUT"));
    await assert.rejects(f.service.redeemVoucher(f.principal("staff"), "a", { token: "x", voucherId: "y", idempotencyKey: "r" }), code("LOGISTICS_INVALID_INPUT"));
    await assert.rejects(f.service.previewAccommodationImport(f.principal("staff"), "a", { csv: "x".repeat(256_001) }), code("LOGISTICS_INVALID_INPUT"));
  } finally { await f.close(); }
});
