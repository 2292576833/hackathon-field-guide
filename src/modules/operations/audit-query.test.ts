import test from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import { createAuditQueryService, normalizeAuditInstant } from "./audit-query-service.ts";
import { createAuditQueryHandlers } from "./audit-query-handlers.ts";
import type { AdminAuditEntry, AuditQueryInput, AuditQueryPort } from "./audit-query-types.ts";

const admin: Actor = { userId: "admin-1", platformRoles: ["admin"] };
function fixture(rows: readonly AdminAuditEntry[] = []) {
  const state = { now: new Date("2026-10-10T08:00:00Z"), authCalls: 0, reads: 0, revoked: false };
  const tx: SqlExecutor = { async query() { return { rows: [], rowCount: 0 }; } };
  const database: DatabasePort = { query: tx.query, async transaction(work) { return work(tx); } };
  const query: AuditQueryPort = { async readPage(_tx, filters, boundary, limit) {
    state.reads++;
    return rows.filter(row => (!filters.actorId || row.actorId === filters.actorId) && (!filters.action || row.action === filters.action)
      && (!filters.objectKind || row.objectKind === filters.objectKind) && (!filters.objectId || row.objectId === filters.objectId)
      && (!filters.revision || row.revision === filters.revision) && (!filters.stream || row.stream === filters.stream)
      && (!boundary || normalizeAuditInstant(row.occurredAt) < boundary.occurredAt || (normalizeAuditInstant(row.occurredAt) === boundary.occurredAt && row.id < boundary.id))).slice(0, limit);
  } };
  const authorization = { async assertCurrentAdmin(sql: SqlExecutor, _actor: Actor) {
    assert.equal(sql, tx); state.authCalls++;
    if (state.revoked) throw new DomainError("AUDIT_ADMIN_REQUIRED", "需要管理员权限。", { status: 403 });
  } };
  const service = createAuditQueryService({ database, query, authorization, clock: { now: () => state.now }, cursorSecret: new Uint8Array(32).fill(7) });
  return { state, service, query, authorization };
}
const entry = (id: string, occurredAt = "2026-10-10T07:00:00.123456Z"): AdminAuditEntry => ({ id: `execution:${id}`, stream: "execution", actorKind: "worker", actorId: "worker-1", action: "RunFailed", objectKind: "run", objectId: "run-1", revision: 2, contentVersion: null, occurredAt });

test("audit denies user/reviewer before reads and checks current admin before/after same-tx query", async () => {
  const f = fixture([entry("b")]);
  for (const role of ["user", "reviewer"] as const) await assert.rejects(f.service.list({ userId: "user-1", platformRoles: [role] }), { code: "AUDIT_ADMIN_REQUIRED" });
  assert.equal(f.state.reads, 0);
  await f.service.list(admin);
  assert.equal(f.state.authCalls, 2);
  f.query.readPage = async () => { f.state.revoked = true; return [entry("b")]; };
  await assert.rejects(f.service.list(admin), { code: "AUDIT_ADMIN_REQUIRED" });
});
test("audit keyset preserves timestamp microseconds and handles tied timestamps without duplicates", async () => {
  const f = fixture([entry("z"), entry("b"), entry("a", "2026-10-10T07:00:00.123455Z")]);
  const first = await f.service.list(admin, { limit: 1 });
  assert.deepEqual(first.items.map(row => row.id), ["execution:z"]);
  assert.ok(first.nextCursor);
  const second = await f.service.list(admin, { limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(row => row.id), ["execution:b"]);
  const third = await f.service.list(admin, { limit: 1, cursor: second.nextCursor! });
  assert.deepEqual(third.items.map(row => row.id), ["execution:a"]);
  assert.equal(third.nextCursor, null);
  assert.deepEqual(second.window, first.window);
});
test("signed cursor cannot be tampered, transferred, rebound to filters or used after expiry", async () => {
  const f = fixture([entry("z"), entry("b")]);
  const first = await f.service.list(admin, { limit: 1, objectId: "run-1" });
  const cursor = first.nextCursor!;
  await assert.rejects(f.service.list(admin, { cursor: `a${cursor.slice(1)}`, objectId: "run-1" }), { code: "INVALID_AUDIT_QUERY" });
  await assert.rejects(f.service.list({ ...admin, userId: "admin-2" }, { cursor, objectId: "run-1" }), { code: "INVALID_AUDIT_QUERY" });
  await assert.rejects(f.service.list(admin, { cursor, objectId: "run-2" }), { code: "INVALID_AUDIT_QUERY" });
  f.state.now = new Date(f.state.now.getTime() + 15 * 60_000);
  await assert.rejects(f.service.list(admin, { cursor, objectId: "run-1" }), { code: "INVALID_AUDIT_QUERY" });
});
test("query bounds reject invalid windows, huge cursor, arbitrary actions, IDs and unsafe limits", async () => {
  const f = fixture();
  const cases = [
    { limit: 0 }, { limit: 101 }, { limit: 1.2 }, { revision: 0 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { from: "2026-09-01T00:00:00Z" }, { to: "2026-10-11T00:00:00Z" }, { from: "2026-10-10T09:00:00Z" },
    { from: "2026-02-30T00:00:00Z" }, { from: "yesterday" }, { cursor: "a".repeat(2049) },
    { action: "body secret" }, { objectId: "x\u0000secret" }, { objectId: "x".repeat(201) }, { actorId: "' OR 1=1" },
  ];
  for (const input of cases) await assert.rejects(f.service.list(admin, input as AuditQueryInput), { code: "INVALID_AUDIT_QUERY" });
  assert.equal(f.state.reads, 0);
});
test("time-window boundaries reject inverted, future and over-31-day microseconds", async () => {
  const f = fixture();
  for (const input of [
    { from: "2026-10-10T07:00:00.000002Z", to: "2026-10-10T07:00:00.000001Z" },
    { to: "2026-10-10T08:00:00.000001Z" },
    { from: "2026-09-09T07:59:59.999999Z", to: "2026-10-10T08:00:00Z" },
  ]) await assert.rejects(f.service.list(admin, input), { code: "INVALID_AUDIT_QUERY" });
  assert.equal(f.state.reads, 0);
});
test("Unicode public event IDs retain the existing M03 business contract", async () => {
  const f = fixture([{ ...entry("z"), stream: "event_review", objectKind: "event", objectId: "赛事 体验-1" }]);
  const result = await f.service.list(admin, { objectId: "赛事 体验-1" });
  assert.equal(result.items[0].objectId, "赛事 体验-1");
});
test("exact projection drops injected body, reason, email, URL and unknown action text", async () => {
  const f = fixture([{ ...entry("z"), action: "secret-token" as never, body: "PRIVATE", reason: "secret", email: "private@example.org", url: "https://x/?key=secret" } as AdminAuditEntry]);
  const page = await f.service.list(admin);
  assert.equal(page.items[0].action, "unrecognized");
  assert.deepEqual(Object.keys(page.items[0]).sort(), ["id", "stream", "actorKind", "actorId", "action", "objectKind", "objectId", "revision", "contentVersion", "occurredAt"].sort());
  assert.doesNotMatch(JSON.stringify(page), /secret|PRIVATE|example\.org/);
});
test("misbehaving port cannot return an unbounded page, private stream or out-of-filter records", async () => {
  const f = fixture();
  f.query.readPage = async () => [entry("a"), entry("b"), entry("c")];
  await assert.rejects(f.service.list(admin, { limit: 1 }), { code: "AUDIT_QUERY_UNBOUNDED" });
  f.query.readPage = async () => [{ ...entry("a"), stream: "private_project" as never }];
  await assert.rejects(f.service.list(admin), { code: "AUDIT_PROJECTION_INVALID" });
  f.query.readPage = async () => [entry("a")];
  await assert.rejects(f.service.list(admin, { objectId: "different" }), { code: "AUDIT_PROJECTION_INVALID" });
});
test("HTTP GET requires session, forbids duplicate/unknown query keys and never echoes provider failures", async () => {
  const f = fixture([entry("z")]);
  let actor: Actor | null = null;
  const handler = createAuditQueryHandlers({ service: f.service, resolveActor: async () => actor, requestId: () => "request-1", assertMutationAllowed: async () => { throw new Error("GET must not mutate"); } }).list;
  assert.equal((await handler(new Request("https://app.example/api/audit"))).status, 401);
  actor = admin;
  for (const suffix of ["?limit=10&limit=20", "?privateProjectId=x", "?limit=", "?revision=1e2"]) assert.equal((await handler(new Request(`https://app.example/api/audit${suffix}`))).status, 400);
  const ok = await handler(new Request("https://app.example/api/audit?limit=1"));
  assert.equal(ok.status, 200); assert.equal(ok.headers.get("Cache-Control"), "no-store");
  f.query.readPage = async () => { throw new Error("postgres password=secret"); };
  const failed = await handler(new Request("https://app.example/api/audit"));
  assert.equal(failed.status, 500); assert.doesNotMatch(await failed.text(), /password|secret/);
});
