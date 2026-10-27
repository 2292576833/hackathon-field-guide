import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { createSpaceChangesService } from "./service.ts";
import { createSpaceChangesHandlers } from "./http.ts";
import type { SpaceChangesFacts } from "./types.ts";

const actor = (userId = "u1"): Actor => ({ userId, platformRoles: [] });
const initialFacts = (projectId = "p1"): SpaceChangesFacts => ({
  projectId, projectRevision: 1, goal: "做一份可访问的比赛清单", minimumDeliverable: "列表和详情", deadline: "2026-10-20T10:00:00+08:00",
  members: [1, 2, 3, 4].map(number => ({ membershipId: `${projectId}-m${number}`, userId: `u${number}`, role: number === 1 ? "manager" : "member", displayName: `队友${number}` })),
  currentPlan: { id: "plan-1", revision: 1, tasks: [{ id: "t1", title: "清单页面", ownerUserId: "u2", reviewerUserId: "u3" }] },
});
async function setup() {
  const engine = new PGlite(); await engine.waitReady;
  await engine.exec(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
  const facts = new Map<string, SpaceChangesFacts>([["p1", initialFacts()], ["p2", initialFacts("p2")]]);
  const archived = new Set<string>(), revoked = new Set<string>(), statements: string[] = [];
  let sequence = 0, authCalls = 0, sourceReads = 0, transactionSql: SqlExecutor | null = null;
  let inject: ((sql: string, rowCount: number) => number) | null = null;
  let beforeAuthorize: (() => void) | null = null;
  let now = "2026-10-12T04:00:00.000Z";
  const executor = (target: { query: PGlite["query"] }): SqlExecutor => ({
    async query<Row>(sql: string, params: readonly unknown[] = []) {
      statements.push(sql);
      const result = await target.query(sql, [...params]);
      const count = result.affectedRows ?? result.rows.length;
      return { rows: result.rows as Row[], rowCount: inject ? inject(sql, count) : count };
    },
  });
  const direct = executor(engine);
  const database: DatabasePort = { query: direct.query, transaction: work => engine.transaction(async tx => {
    const sql = executor(tx); transactionSql = sql;
    try { return await work(sql); } finally { transactionSql = null; }
  }) };
  const service = createSpaceChangesService({ database, clock: { now: () => new Date(now) }, ids: { next: () => `change-${++sequence}` },
    async authorize(sql, who, projectId) {
      authCalls++; assert.equal(sql, transactionSql); beforeAuthorize?.();
      const member = facts.get(projectId)?.members.find(value => value.userId === who.userId);
      if (!member || revoked.has(who.userId)) throw new DomainError("FORBIDDEN", "当前无权读取空间。", { status: 403 });
      return { ...member, projectId, membershipRevision: 1, archived: archived.has(projectId) };
    },
    async readFacts(sql, access) { sourceReads++; assert.equal(sql, transactionSql); return structuredClone(facts.get(access.projectId)!); },
  });
  const patch = (value: Partial<SpaceChangesFacts>, projectId = "p1") => facts.set(projectId, { ...facts.get(projectId)!, ...value });
  const tableCount = async (table: string) => Number((await engine.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`)).rows[0]!.count);
  return { engine, service, facts, archived, revoked, statements, patch, tableCount,
    get authCalls() { return authCalls; }, get sourceReads() { return sourceReads; },
    inject(value: typeof inject) { inject = value; }, beforeAuthorize(value: typeof beforeAuthorize) { beforeAuthorize = value; }, setNow(value: string) { now = value; } };
}

test("GET is read-only; first reconcile persists baseline without inventing history", async () => {
  const f = await setup();
  try {
    assert.equal((await f.service.list(actor(), "p1")).pendingCount, 0);
    assert.equal(f.sourceReads, 0);
    assert.equal(f.statements.some(sql => /INSERT|UPDATE|DELETE|FOR UPDATE/i.test(sql)), false);
    assert.equal(await f.tableCount("space_change_heads"), 0);
    assert.deepEqual(await f.service.reconcile(actor(), "p1"), { projectId: "p1", baselineCreated: true, version: 1, changeCount: 0 });
    assert.equal(await f.tableCount("space_change_versions"), 1);
    assert.equal(await f.tableCount("space_changes"), 0);
    assert.equal(await f.tableCount("space_change_recipients"), 0);
    assert.equal(f.authCalls, 4);
  } finally { await f.engine.close(); }
});

test("project changes notify all current members, preserve versions and deduplicate equal facts", async () => {
  const f = await setup();
  try {
    await f.service.reconcile(actor(), "p1");
    f.patch({ projectRevision: 2, goal: "完整原文".repeat(80), minimumDeliverable: "可搜索清单", deadline: "2026-10-21T10:00:00+08:00" });
    assert.equal((await f.service.reconcile(actor("u2"), "p1")).changeCount, 3);
    const first = await f.service.list(actor("u4"), "p1");
    assert.equal(first.pendingCount, 3); assert.equal(first.items.length, 3);
    assert.equal(first.items.find(value => value.field === "goal")?.after, "完整原文".repeat(80));
    assert.equal(first.items.find(value => value.field === "goal")?.afterSummary.length, 141);
    assert.equal(first.items[0]?.beforeSource.projectRevision, 1); assert.equal(first.items[0]?.afterSource.projectRevision, 2);
    assert.equal((await f.service.reconcile(actor(), "p1")).changeCount, 0);
    f.patch({ projectRevision: 3, deadline: "2026-10-21T02:00:00.000Z" });
    assert.equal((await f.service.reconcile(actor(), "p1")).version, 2); // Equivalent timezone / revision-only update.
    f.patch({ projectRevision: 4, goal: "新的目标" });
    assert.equal((await f.service.reconcile(actor(), "p1")).version, 3);
    const all = await f.service.list(actor("u4"), "p1");
    assert.equal(all.items.length, 4);
    assert.deepEqual(all.items.filter(value => value.version === 2), first.items);
    assert.equal(await f.tableCount("space_change_versions"), 3);
    assert.equal(await f.tableCount("space_change_recipients"), 16);
    await assert.rejects(f.engine.query("UPDATE space_changes SET body='{}'::jsonb"), /immutable/);
    await assert.rejects(f.engine.query("DELETE FROM space_change_versions"), /immutable/);
    await assert.rejects(f.engine.query("UPDATE space_change_recipients SET snapshot='{}'::jsonb"), /immutable/);
  } finally { await f.engine.close(); }
});

test("applied owner/reviewer changes notify active previous and next people plus managers only", async () => {
  const f = await setup();
  try {
    f.patch({ members: [...f.facts.get("p1")!.members, { membershipId: "p1-m5", userId: "u5", role: "member", displayName: "其他队友" }] });
    await f.service.reconcile(actor(), "p1");
    f.patch({ currentPlan: { id: "plan-2", revision: 1, tasks: [{ id: "t1", title: "新标题", ownerUserId: "u4", reviewerUserId: "u3" }] } });
    assert.equal((await f.service.reconcile(actor(), "p1")).changeCount, 1);
    assert.equal((await f.service.list(actor("u1"), "p1")).pendingCount, 1);
    assert.equal((await f.service.list(actor("u2"), "p1")).pendingCount, 1);
    assert.equal((await f.service.list(actor("u4"), "p1")).pendingCount, 1);
    assert.equal((await f.service.list(actor("u3"), "p1")).pendingCount, 1); // The continuing reviewer also needs the new owner.
    assert.equal((await f.service.list(actor("u5"), "p1")).pendingCount, 0);
    f.patch({ members: f.facts.get("p1")!.members.filter(member => member.userId !== "u3"),
      currentPlan: { id: "plan-2", revision: 2, tasks: [{ id: "t1", title: "新标题", ownerUserId: "u4", reviewerUserId: "u2" }] } });
    await f.service.reconcile(actor(), "p1");
    const rows = await f.engine.query<{ user_id: string }>("SELECT user_id FROM space_change_recipients WHERE change_id=(SELECT id FROM space_changes WHERE version=3)");
    assert.deepEqual(rows.rows.map(row => row.user_id).sort(), ["u1", "u2", "u4"]);
    await assert.rejects(f.service.list(actor("u3"), "p1"), { code: "FORBIDDEN" });
  } finally { await f.engine.close(); }
});

test("non-current plans do not emit removals; later applied plan compares historical assignments", async () => {
  const f = await setup();
  try {
    await f.service.reconcile(actor(), "p1");
    f.patch({ currentPlan: null, projectRevision: 2 });
    assert.equal((await f.service.reconcile(actor(), "p1")).changeCount, 0);
    f.patch({ goal: "新目标", projectRevision: 3 });
    await f.service.reconcile(actor(), "p1");
    f.patch({ currentPlan: { id: "plan-3", revision: 1, tasks: [{ id: "t1", title: "清单页面", ownerUserId: "u3", reviewerUserId: "u2" }] } });
    assert.equal((await f.service.reconcile(actor(), "p1")).changeCount, 2);
    const items = (await f.service.list(actor(), "p1")).items;
    const owner = items.find(item => item.field === "task_owner")!;
    assert.deepEqual(owner.before, { userId: "u2", displayName: "队友2" });
    assert.equal(owner.beforeSource.planId, "plan-1");
    f.patch({ currentPlan: { id: "plan-3", revision: 2, tasks: [{ id: "t1", title: "只改名称", ownerUserId: "u3", reviewerUserId: "u2" }] }, members: f.facts.get("p1")!.members.map(member => ({ ...member, displayName: "改称呼" })) });
    assert.equal((await f.service.reconcile(actor(), "p1")).changeCount, 0);
    f.patch({ currentPlan: { id: "plan-4", revision: 1, tasks: [] } });
    assert.equal((await f.service.reconcile(actor(), "p1")).changeCount, 2);
    assert.equal((await f.service.list(actor(), "p1")).items[0]?.after, null);
  } finally { await f.engine.close(); }
});

test("a first later effective plan records actual new assignments, never intent or private assessment", async () => {
  const f = await setup();
  try {
    f.patch({ currentPlan: null }); await f.service.reconcile(actor(), "p1");
    f.patch({ ...({ responsibilityIntent: "u4主开发", privateAssessment: "secret" } as object) });
    assert.equal((await f.service.reconcile(actor(), "p1")).changeCount, 0);
    f.patch({ currentPlan: initialFacts().currentPlan });
    assert.equal((await f.service.reconcile(actor(), "p1")).changeCount, 2);
    const items = (await f.service.list(actor(), "p1")).items;
    assert(items.every(item => item.before === null));
    assert.equal(JSON.stringify(items).includes("secret"), false);
  } finally { await f.engine.close(); }
});

test("I understand is explicit, idempotent, personal and never changes facts, tasks or other receipts", async () => {
  const f = await setup();
  try {
    await f.service.reconcile(actor(), "p1"); f.patch({ goal: "新目标", projectRevision: 2 }); await f.service.reconcile(actor(), "p1");
    const before = JSON.stringify([...f.facts]);
    const change = (await f.service.list(actor("u2"), "p1")).items[0]!;
    await assert.rejects(f.service.acknowledge(actor("u2"), "p1", { changeId: change.id, version: change.version, understood: false as unknown as true }), { code: "INVALID_INPUT" });
    await assert.rejects(f.service.acknowledge(actor("u2"), "p1", { changeId: change.id, version: 99, understood: true }), { code: "VERSION_CONFLICT" });
    const receipt = await f.service.acknowledge(actor("u2"), "p1", { changeId: change.id, version: change.version, understood: true });
    assert.equal(receipt.replayed, false);
    f.setNow("2026-10-12T05:00:00.000Z");
    const replay = await f.service.acknowledge(actor("u2"), "p1", { changeId: change.id, version: change.version, understood: true });
    assert.equal(replay.replayed, true); assert.equal(replay.acknowledgedAt, receipt.acknowledgedAt);
    assert.equal((await f.service.list(actor("u2"), "p1")).pendingCount, 0);
    assert.equal((await f.service.list(actor("u3"), "p1")).pendingCount, 1);
    assert.equal(JSON.stringify([...f.facts]), before);
    assert.equal(await f.tableCount("space_change_acknowledgements"), 1);
    await assert.rejects(f.engine.query("DELETE FROM space_change_acknowledgements"), /immutable/);
  } finally { await f.engine.close(); }
});

test("project/account isolation, leave/rejoin and nonrecipient cannot recover another membership receipt", async () => {
  const f = await setup();
  try {
    f.patch({ members: [...f.facts.get("p1")!.members, { membershipId: "p1-m5", userId: "u5", role: "member", displayName: "其他队友" }] });
    await f.service.reconcile(actor(), "p1");
    f.patch({ currentPlan: { id: "plan-2", revision: 1, tasks: [{ id: "t1", title: "清单", ownerUserId: "u4", reviewerUserId: "u3" }] } });
    await f.service.reconcile(actor(), "p1");
    const change = (await f.service.list(actor("u2"), "p1")).items[0]!;
    const input = { changeId: change.id, version: change.version, understood: true as const };
    await assert.rejects(f.service.acknowledge(actor("u5"), "p1", input), { code: "NOT_FOUND" });
    await assert.rejects(f.service.acknowledge(actor("u2"), "p2", input), { code: "NOT_FOUND" });
    assert.equal((await f.service.list(actor("u2"), "p2")).items.length, 0);
    const old = f.facts.get("p1")!.members;
    f.patch({ members: old.filter(member => member.userId !== "u2") });
    await assert.rejects(f.service.list(actor("u2"), "p1"), { code: "FORBIDDEN" });
    await assert.rejects(f.service.acknowledge(actor("u2"), "p1", input), { code: "FORBIDDEN" });
    f.patch({ members: old.map(member => member.userId === "u2" ? { ...member, membershipId: "new-m2" } : member) });
    assert.equal((await f.service.list(actor("u2"), "p1")).items.length, 0);
    await assert.rejects(f.service.acknowledge(actor("u2"), "p1", input), { code: "NOT_FOUND" });
    f.patch({ goal: "重新入队后的新目标", projectRevision: 2 }); await f.service.reconcile(actor(), "p1");
    assert.equal((await f.service.list(actor("u2"), "p1")).items.length, 1);
    f.revoked.add("u2");
    await assert.rejects(f.service.list(actor("u2"), "p1"), { code: "FORBIDDEN" });
  } finally { await f.engine.close(); }
});

test("archival preserves read history and rejects baseline/reconcile/ack even on replay", async () => {
  const f = await setup();
  try {
    await f.service.reconcile(actor(), "p1"); f.patch({ goal: "新目标" }); await f.service.reconcile(actor(), "p1");
    const item = (await f.service.list(actor(), "p1")).items[0]!;
    const input = { changeId: item.id, version: item.version, understood: true as const };
    await f.service.acknowledge(actor(), "p1", input);
    f.archived.add("p1"); f.archived.add("p2");
    assert.equal((await f.service.list(actor(), "p1")).readOnly, true);
    await assert.rejects(f.service.reconcile(actor(), "p1"), { code: "PROJECT_READ_ONLY" });
    await assert.rejects(f.service.reconcile(actor(), "p2"), { code: "PROJECT_READ_ONLY" });
    await assert.rejects(f.service.acknowledge(actor(), "p1", input), { code: "PROJECT_READ_ONLY" });
    assert.equal(await f.tableCount("space_change_heads"), 1);
  } finally { await f.engine.close(); }
});

test("concurrent baseline/reconcile/ack converge to one observed event and receipt", async () => {
  const f = await setup();
  try {
    const baseline = await Promise.all([f.service.reconcile(actor(), "p1"), f.service.reconcile(actor("u2"), "p1")]);
    assert.equal(baseline.filter(value => value.baselineCreated).length, 1);
    f.patch({ goal: "并发观察" });
    const reconciled = await Promise.all([f.service.reconcile(actor(), "p1"), f.service.reconcile(actor("u2"), "p1")]);
    assert.equal(reconciled.reduce((sum, value) => sum + value.changeCount, 0), 1);
    const item = (await f.service.list(actor(), "p1")).items[0]!;
    const input = { changeId: item.id, version: item.version, understood: true as const };
    const receipts = await Promise.all([f.service.acknowledge(actor(), "p1", input), f.service.acknowledge(actor(), "p1", input)]);
    assert.equal(receipts.filter(value => !value.replayed).length, 1);
    assert.equal(await f.tableCount("space_changes"), 1); assert.equal(await f.tableCount("space_change_acknowledgements"), 1);
  } finally { await f.engine.close(); }
});

test("CAS and recipient rowCount failures roll back heads, immutable versions and all receipts together", async () => {
  const f = await setup();
  try {
    await f.service.reconcile(actor(), "p1"); f.patch({ goal: "不能部分保存" });
    for (const match of ["UPDATE space_change_heads", "INSERT INTO space_change_recipients"]) {
      f.inject((sql, count) => sql.startsWith(match) ? 0 : count);
      await assert.rejects(f.service.reconcile(actor(), "p1"), { code: "VERSION_CONFLICT" });
      f.inject(null);
      assert.equal(await f.tableCount("space_change_versions"), 1);
      assert.equal(await f.tableCount("space_changes"), 0);
      assert.equal(await f.tableCount("space_change_recipients"), 0);
      assert.equal((await f.engine.query<{ revision: number }>("SELECT revision FROM space_change_heads")).rows[0]!.revision, 1);
    }
    assert.equal((await f.service.reconcile(actor(), "p1")).changeCount, 1);
    const item = (await f.service.list(actor(), "p1")).items[0]!;
    f.inject((sql, count) => sql.startsWith("INSERT INTO space_change_acknowledgements") ? 0 : count);
    await assert.rejects(f.service.acknowledge(actor(), "p1", { changeId: item.id, version: item.version, understood: true }), { code: "VERSION_CONFLICT" });
    f.inject(null);
    assert.equal(await f.tableCount("space_change_acknowledgements"), 0);
  } finally { await f.engine.close(); }
});

test("authorization is rechecked before committing or returning; changes are rolled back on lost access", async () => {
  const f = await setup();
  try {
    await f.service.reconcile(actor(), "p1"); f.patch({ goal: "丢失权限不可写" });
    let calls = 0;
    f.beforeAuthorize(() => { if (++calls === 2) f.revoked.add("u1"); });
    await assert.rejects(f.service.reconcile(actor(), "p1"), { code: "FORBIDDEN" });
    assert.equal(await f.tableCount("space_changes"), 0);
    f.beforeAuthorize(null); f.revoked.clear();
    await f.service.reconcile(actor(), "p1");
    calls = 0; f.beforeAuthorize(() => { if (++calls === 2) f.revoked.add("u1"); });
    await assert.rejects(f.service.list(actor(), "p1"), { code: "FORBIDDEN" });
  } finally { await f.engine.close(); }
});

test("pagination retains all entries in a version and pending count includes older unseen changes", async () => {
  const f = await setup();
  try {
    await f.service.reconcile(actor(), "p1");
    f.patch({ goal: "目标二", minimumDeliverable: "范围二" }); await f.service.reconcile(actor(), "p1");
    f.patch({ goal: "目标三", minimumDeliverable: "范围三" }); await f.service.reconcile(actor(), "p1");
    const page = await f.service.list(actor(), "p1", { limit: 1 });
    assert.equal(page.items.length, 2); assert.equal(page.pendingCount, 4); assert.equal(page.nextBeforeVersion, 3);
    const older = await f.service.list(actor(), "p1", { limit: 1, beforeVersion: page.nextBeforeVersion! });
    assert.equal(older.items.length, 2); assert(older.items.every(value => value.version === 2)); assert.equal(older.nextBeforeVersion, null);
    await assert.rejects(f.service.list(actor(), "p1", { limit: 0 }), { code: "INVALID_INPUT" });
  } finally { await f.engine.close(); }
});

test("HTTP GET is read-only and no-store; writes require session/CSRF and reject client facts or other identities", async () => {
  const f = await setup();
  try {
    let signedIn = true, csrf = true, checks = 0;
    const handlers = createSpaceChangesHandlers({ service: f.service, requestIds: { next: () => "request-1" }, resolveActor: async () => signedIn ? actor() : null,
      authorizeMutation: async () => { checks++; if (!csrf) throw new DomainError("FORBIDDEN", "来源不匹配", { status: 403 }); } });
    const request = (method: string, body?: unknown) => new Request("http://local/api/v1/projects/p1/space-changes", { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const params = { projectId: "p1" };
    const read = await handlers.list(request("GET"), params);
    assert.equal(read.status, 200); assert.equal(read.headers.get("cache-control"), "private, no-store");
    assert.equal(await f.tableCount("space_change_heads"), 0); assert.equal(checks, 0);
    assert.equal((await handlers.reconcile(request("POST", { goal: "客户端不能定义事实" }), params)).status, 400);
    assert.equal((await handlers.acknowledge(request("POST", { changeId: "x", version: 1, understood: true, userId: "u2" }), params)).status, 400);
    csrf = false;
    assert.equal((await handlers.reconcile(request("POST", {}), params)).status, 403);
    csrf = true; signedIn = false;
    assert.equal((await handlers.reconcile(request("POST", {}), params)).status, 401);
    signedIn = true;
    assert.equal((await handlers.reconcile(request("GET"), params)).status, 405);
    assert.equal((await handlers.reconcile(request("POST", { unknown: "a".repeat(3000) }), params)).status, 413);
    assert.equal((await handlers.reconcile(request("POST", {}), params)).status, 200);
  } finally { await f.engine.close(); }
});
