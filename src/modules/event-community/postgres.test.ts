import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { HostedEventScope } from "../../shared/organizer-contracts.ts";
import type { CommunityBlock, CommunityReport, DirectMessage, EventConnection } from "./model.ts";
import { communityPairKey } from "./policy.ts";
import * as repository from "./postgres.ts";

/** 隔离的内存 SQL 验证：只打开临时 PGlite，不碰应用目录或生产数据。 */
let engine: PGlite;
let database: DatabasePort;
function executor(connection: Pick<PGlite, "query">): SqlExecutor {
  return { async query<Row>(statement: string, parameters: readonly unknown[] = []) {
    const result = await connection.query<Row>(statement, [...parameters]);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  } };
}
before(async () => {
  engine = new PGlite();
  await engine.exec(`CREATE TABLE auth_users(id text PRIMARY KEY);
    CREATE TABLE organizer_hosted_events(id text PRIMARY KEY, organization_id text NOT NULL, UNIQUE(id, organization_id));
    INSERT INTO auth_users(id) VALUES ('alice'),('bob'),('carol'),('dave');
    INSERT INTO organizer_hosted_events(id, organization_id) VALUES ('event-a','org-a'),('event-b','org-b');`);
  await engine.exec(await readFile(new URL("./migrations/001-event-community.sql", import.meta.url), "utf8"));
  database = { ...executor(engine), transaction: work => engine.transaction(transaction => work(executor(transaction))) };
});
after(async () => { await engine.close(); });

const time = "2026-10-16T08:00:00.000Z";
const scope: HostedEventScope = {
  organizationId: "org-a", organizationName: "机构", eventId: "event-a", title: "赛事", status: "published", revision: 1, publishedRevision: 1,
  timezone: "Asia/Shanghai", startsAt: time, endsAt: time, registrationOpensAt: null, registrationClosesAt: null, submissionClosesAt: null,
  modules: { registration: true, teams: true, judging: true, schedule: false, accommodation: false, mealVouchers: false, icebreaking: false },
  registration: { reviewRequired: false, capacity: null }, teams: { mode: "free", minSize: 1, maxSize: 4, locksAt: null }, linkedEventId: null,
};
const pairAliceBob = communityPairKey("alice", "bob");
const pairAliceCarol = communityPairKey("alice", "carol");
const pairAliceDave = communityPairKey("alice", "dave");
const connection = (overrides: Partial<EventConnection> = {}): EventConnection => ({
  id: "c-1", organizationId: "org-a", eventId: "event-a", pairKey: pairAliceBob, requesterUserId: "alice", addresseeUserId: "bob",
  status: "pending", revision: 1, requestedAt: time, respondedAt: null, decidedByUserId: null, idempotencyKey: "key-1", ...overrides,
});
const message = (overrides: Partial<DirectMessage> = {}): DirectMessage => ({
  id: "m-1", organizationId: "org-a", eventId: "event-a", connectionId: "c-1", senderUserId: "alice", recipientUserId: "bob",
  content: "你好", status: "active", revision: 1, createdAt: time, withdrawnAt: null, purgedAt: null, idempotencyKey: "mk-1", ...overrides,
});
const block = (overrides: Partial<CommunityBlock> = {}): CommunityBlock => ({
  id: "b-1", organizationId: "org-a", eventId: "event-a", blockerUserId: "alice", blockedUserId: "bob", createdAt: time, ...overrides,
});
const report = (overrides: Partial<CommunityReport> = {}): CommunityReport => ({
  id: "r-1", organizationId: "org-a", eventId: "event-a", reporterUserId: "alice", reportedUserId: "bob", connectionId: "c-1",
  reason: "harassment", detail: "说明", snapshot: [], status: "open", createdAt: time, idempotencyKey: "rk-1", ...overrides,
});

test("连接行按 scope 读写；同一对账号最多一条 pending/accepted，被拒绝后仍可重新发起", async () => {
  await repository.insertConnection(database, connection());
  assert.deepEqual(await repository.getConnection(database, scope, "c-1"), connection());
  assert.deepEqual(await repository.findOpenConnection(database, scope, pairAliceBob), connection());
  assert.deepEqual(await repository.findConnectionByRequestKey(database, scope, "alice", "key-1"), connection());
  assert.equal(await repository.getConnection(database, { ...scope, eventId: "event-b" }, "c-1"), null, "跨赛事读不到同一条事实");
  assert.equal(await repository.countPendingForUser(database, scope, "alice"), 1);
  assert.equal(await repository.countPendingForUser(database, scope, "carol"), 0);

  assert.equal(await repository.insertConnection(database, connection({ id: "c-dup", idempotencyKey: "key-2" })), false, "ON CONFLICT DO NOTHING：唯一冲突不抛异常");
  const accepted: EventConnection = { ...connection(), status: "accepted", revision: 2, respondedAt: time, decidedByUserId: "bob" };
  assert.equal(await repository.updateConnection(database, scope, 1, accepted), true);
  assert.equal(await repository.insertConnection(database, connection({ id: "c-open", idempotencyKey: "key-3" })), false, "已接受的连接也算 open");

  // 另一对账号：请求 → 拒绝；被拒绝的行保留为历史，冷却核查从这里取时间。
  const requestCarol = connection({ id: "c-2", pairKey: pairAliceCarol, addresseeUserId: "carol", idempotencyKey: "key-4" });
  await repository.insertConnection(database, requestCarol);
  const rejectedCarol: EventConnection = { ...requestCarol, status: "rejected", revision: 2, respondedAt: time, decidedByUserId: "carol" };
  assert.equal(await repository.updateConnection(database, scope, 1, rejectedCarol), true);
  assert.deepEqual(await repository.latestRejection(database, scope, pairAliceCarol), rejectedCarol);
  assert.equal(await repository.latestRejection(database, scope, pairAliceBob), null);
  await repository.insertConnection(database, connection({ id: "c-3", pairKey: pairAliceCarol, addresseeUserId: "carol", idempotencyKey: "key-5", requestedAt: "2026-11-20T00:00:00.000Z" }));
  assert.equal((await repository.listConnections(database, scope)).length, 3, "被拒绝的行与新请求并存为历史");
});

test("连接触发器冻结范围/方向/请求键，要求版本加一，并限制决策来源", async () => {
  await repository.insertConnection(database, connection({ id: "c-9", pairKey: pairAliceDave, addresseeUserId: "dave", idempotencyKey: "key-9" }));
  await assert.rejects(database.query("UPDATE evc_connections SET pair_key='x' WHERE id='c-9'"), /immutable/);
  await assert.rejects(database.query("UPDATE evc_connections SET requester_user_id='carol' WHERE id='c-9'"), /immutable/);
  await assert.rejects(database.query("UPDATE evc_connections SET requested_at=now() WHERE id='c-9'"), /immutable/);
  await assert.rejects(database.query("UPDATE evc_connections SET idempotency_key='other' WHERE id='c-9'"), /immutable/);
  await assert.rejects(database.query("UPDATE evc_connections SET revision=5,status='accepted',responded_at=now(),decided_by_user_id='dave' WHERE id='c-9'"), /revision/);
  await assert.rejects(database.query("UPDATE evc_connections SET revision=2,status='accepted',responded_at=now(),decided_by_user_id='alice' WHERE id='c-9'"), /addressee/);
  await assert.rejects(database.query("UPDATE evc_connections SET revision=2,status='cancelled',responded_at=now(),decided_by_user_id='dave' WHERE id='c-9'"), /requester/);
  assert.equal(await repository.updateConnection(database, scope, 1, {
    ...((await repository.getConnection(database, scope, "c-9"))!),
    status: "accepted", revision: 2, respondedAt: time, decidedByUserId: "dave",
  }), true);
  await assert.rejects(database.query("UPDATE evc_connections SET revision=3,status='rejected',responded_at=now(),decided_by_user_id='dave' WHERE id='c-9'"), /pending to/);
});

test("私信触发器只允许清空正文；限频计数与到期清理查询只看本场本账号", async () => {
  await repository.insertMessage(database, message());
  assert.deepEqual(await repository.findMessageByKey(database, scope, "alice", "mk-1"), message());
  await repository.insertMessage(database, message({ id: "m-2", content: "第二条", idempotencyKey: "mk-2", createdAt: "2026-10-16T08:05:00.000Z" }));
  assert.equal(await repository.countMessagesSince(database, scope, "alice", "2026-10-16T08:04:00.000Z"), 1);
  assert.equal(await repository.countMessagesSince(database, scope, "bob", "2026-10-16T00:00:00.000Z"), 0);

  assert.equal(await repository.insertMessage(database, message({ id: "m-dup", idempotencyKey: "mk-1" })), false);
  await assert.rejects(database.query("UPDATE evc_direct_messages SET connection_id='other' WHERE id='m-1'"), /immutable/);
  await assert.rejects(database.query("UPDATE evc_direct_messages SET revision=2,status='withdrawn',content='改写',withdrawn_at=now() WHERE id='m-1'"), /cleared/);
  await assert.rejects(database.query("UPDATE evc_direct_messages SET revision=5,status='withdrawn',content=NULL,withdrawn_at=now() WHERE id='m-1'"), /revision/);
  assert.equal(await repository.updateMessage(database, scope, 1, { ...message(), status: "withdrawn", revision: 2, content: null, withdrawnAt: time }), true);
  await assert.rejects(database.query("UPDATE evc_direct_messages SET revision=3,status='purged',purged_at=now() WHERE id='m-1'"), /active to/);

  assert.equal((await repository.listPurgeableMessages(database, scope, "2026-10-16T09:00:00.000Z", 10)).map(row => row.id).join(","), "m-2");
  assert.equal((await repository.listPurgeableMessages(database, scope, "2026-10-16T08:00:00.000Z", 10)).length, 0);
});

test("屏蔽不可变且同一对唯一；举报不可改写、只接受 open", async () => {
  await repository.insertBlock(database, block());
  assert.deepEqual(await repository.findBlock(database, scope, "alice", "bob"), block());
  assert.deepEqual(await repository.findBlockBetween(database, scope, "bob", "alice"), block());
  assert.equal(await repository.findBlockBetween(database, scope, "alice", "carol"), null);
  assert.equal(await repository.insertBlock(database, block({ id: "b-dup" })), false);
  await assert.rejects(database.query("UPDATE evc_blocks SET blocked_user_id='carol' WHERE id='b-1'"), /immutable/);
  assert.equal(await repository.deleteBlock(database, scope, "alice", "bob"), true);
  assert.equal(await repository.deleteBlock(database, scope, "alice", "bob"), false);

  await repository.insertReport(database, report({ snapshot: [{ messageId: "m-1", senderUserId: "alice", recipientUserId: "bob", createdAt: time, status: "active", content: "你好" }] }));
  assert.deepEqual(await repository.findReportByKey(database, scope, "alice", "rk-1"), (await repository.listReports(database, scope))[0]);
  await assert.rejects(database.query("UPDATE evc_reports SET detail='改写' WHERE id='r-1'"), /immutable/);
  await assert.rejects(database.query("UPDATE evc_reports SET status='handled' WHERE id='r-1'"), /immutable/);
});

test("document 与索引列必须一致，防止同一事实两处漂移", async () => {
  const pairBad = "alice~carol";
  await assert.rejects(database.query(
    `INSERT INTO evc_connections(id,organization_id,event_id,pair_key,requester_user_id,addressee_user_id,status,revision,requested_at,responded_at,decided_by_user_id,idempotency_key,document)
     VALUES('c-bad','org-a','event-a','${pairBad}','alice','carol','pending',1,now(),NULL,NULL,'key-bad','{"id":"c-bad","organizationId":"org-a","eventId":"event-a","pairKey":"${pairBad}","requesterUserId":"alice","addresseeUserId":"dave","status":"pending","revision":1,"idempotencyKey":"key-bad"}'::jsonb)`),
    /check constraint|violates/i);
  await assert.rejects(database.query(
    `INSERT INTO evc_direct_messages(id,organization_id,event_id,connection_id,sender_user_id,recipient_user_id,content,status,revision,created_at,withdrawn_at,purged_at,idempotency_key,document)
     VALUES('m-bad','org-a','event-a','c-1','alice','bob','正文','active',1,now(),NULL,NULL,'mk-bad','{"id":"m-bad","organizationId":"org-a","eventId":"event-a","connectionId":"c-1","senderUserId":"alice","recipientUserId":"bob","content":null,"status":"active","revision":1,"idempotencyKey":"mk-bad"}'::jsonb)`),
    /check constraint|violates/i);
});
