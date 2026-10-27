import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { HostedEventScope } from "../../shared/organizer-contracts.ts";
import type { PeerReview, PeerReviewReport } from "./model.ts";
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
  await engine.exec("CREATE TABLE auth_users(id text PRIMARY KEY);\n" +
    "CREATE TABLE organizer_hosted_events(id text PRIMARY KEY, organization_id text NOT NULL, UNIQUE(id, organization_id));\n" +
    "CREATE TABLE event_registration_teams(event_id text NOT NULL, id text NOT NULL, PRIMARY KEY(event_id, id));\n" +
    "INSERT INTO auth_users(id) VALUES ('alice'),('bob'),('carol');\n" +
    "INSERT INTO organizer_hosted_events(id, organization_id) VALUES ('event-a','org-a'),('event-b','org-b');\n" +
    "INSERT INTO event_registration_teams(event_id, id) VALUES ('event-a','team-a'),('event-a','team-b'),('event-b','team-b');");
  await engine.exec(await readFile(new URL("./migrations/001-event-peer-review.sql", import.meta.url), "utf8"));
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
const dimensions = [{ id: "d1", label: "创意" }, { id: "d2", label: "完成度" }];
const record = (overrides: Partial<PeerReview> = {}): PeerReview => ({
  id: "r-1", organizationId: "org-a", eventId: "event-a", snapshotId: "snap-1", teamId: "team-a", reviewerUserId: "alice",
  scale: "1-5", dimensions, values: [{ dimensionId: "d1", value: 4 }, { dimensionId: "d2", value: 5 }],
  status: "active", revision: 1, createdAt: time, updatedAt: time, withdrawnAt: null, supersededAt: null, idempotencyKey: "key-1", ...overrides });
const report = (overrides: Partial<PeerReviewReport> = {}): PeerReviewReport => ({
  id: "p-1", organizationId: "org-a", eventId: "event-a", reviewId: "r-1", snapshotId: "snap-1", teamId: "team-a",
  reporterUserId: "bob", reason: "与作品无关的评价", values: [{ dimensionId: "d1", value: 4 }], scale: "1-5", createdAt: time, ...overrides });

test("互评行按赛事范围读写，重放与当前有效记录都只看本场", async () => {
  await repository.insertReview(database, record());
  assert.deepEqual(await repository.getReview(database, scope, "r-1"), record());
  assert.deepEqual(await repository.findReviewReplay(database, scope, "alice", "key-1"), record());
  assert.equal(await repository.findReviewReplay(database, scope, "alice", "other"), null);
  assert.deepEqual(await repository.findActiveReview(database, scope, "snap-1", "alice"), record());
  assert.equal(await repository.findActiveReview(database, scope, "snap-2", "alice"), null);
  // 跨赛事 scope 读不到：不是同一条事实。
  assert.equal(await repository.getReview(database, { ...scope, eventId: "event-b" }, "r-1"), null);
  assert.equal((await repository.listReviews(database, { ...scope, eventId: "event-b" })).length, 0);
});

test("一队一件作品一个评分者一条有效记录由部分唯一索引强制；撤回后可以再写入一条", async () => {
  await assert.rejects(repository.insertReview(database, record({ id: "r-dup", idempotencyKey: "key-2" })), /duplicate key|unique/i);
  const withdrawn: PeerReview = { ...record(), status: "withdrawn", revision: 2, updatedAt: time, withdrawnAt: time };
  assert.equal(await repository.closeReview(database, scope, 1, withdrawn), true);
  assert.equal(await repository.findActiveReview(database, scope, "snap-1", "alice"), null);
  await repository.insertReview(database, record({ id: "r-2", idempotencyKey: "key-3", values: [{ dimensionId: "d1", value: 1 }, { dimensionId: "d2", value: 1 }] }));
  assert.deepEqual(await repository.findActiveReview(database, scope, "snap-1", "alice"), record({ id: "r-2", idempotencyKey: "key-3", values: [{ dimensionId: "d1", value: 1 }, { dimensionId: "d2", value: 1 }] }));
  assert.equal((await repository.listReviews(database, scope)).length, 2, "撤回的历史行与新的有效行都保留");
  // 版本不符时 closeReview 改不动任何行。
  assert.equal(await repository.closeReview(database, scope, 5, { ...withdrawn, id: "r-2" }), false);
});

test("触发器冻结身份列与分值维度，并约束撤回版本加一、被取代保持版本", async () => {
  await assert.rejects(database.query("UPDATE epr_peer_reviews SET team_id='team-b' WHERE id='r-2'"), /immutable/);
  await assert.rejects(database.query("UPDATE epr_peer_reviews SET reviewer_user_id='bob' WHERE id='r-2'"), /immutable/);
  await assert.rejects(database.query("UPDATE epr_peer_reviews SET scale='0-10' WHERE id='r-2'"), /immutable/);
  await assert.rejects(database.query("UPDATE epr_peer_reviews SET created_at=now() WHERE id='r-2'"), /immutable/);
  await assert.rejects(database.query("UPDATE epr_peer_reviews SET idempotency_key='other' WHERE id='r-2'"), /immutable/);
  await assert.rejects(database.query("UPDATE epr_peer_reviews SET document=jsonb_set(document,'{values}','[{\"dimensionId\":\"d1\",\"value\":9}]'::jsonb) WHERE id='r-2'"), /immutable/);
  await assert.rejects(database.query("UPDATE epr_peer_reviews SET document=jsonb_set(document,'{dimensions}','[]'::jsonb) WHERE id='r-2'"), /immutable/);
  // 撤回必须版本加一；被取代必须保持版本；只能 active -> withdrawn/superseded。
  await assert.rejects(database.query("UPDATE epr_peer_reviews SET status='withdrawn',revision=9,withdrawn_at=now(),document=document WHERE id='r-2'"), /revision/);
  await assert.rejects(database.query("UPDATE epr_peer_reviews SET status='superseded',revision=9,superseded_at=now() WHERE id='r-2'"), /revision/);
  await assert.rejects(database.query("UPDATE epr_peer_reviews SET status='active' WHERE id='r-1'"), /active to withdrawn/);
  // 合法的被取代：版本不变，随后可以写入新的 active 版本。
  assert.equal(await repository.closeReview(database, scope, 1, { ...record({ id: "r-2", idempotencyKey: "key-3", values: [{ dimensionId: "d1", value: 1 }, { dimensionId: "d2", value: 1 }] }), status: "superseded", revision: 1, updatedAt: time, supersededAt: time }), true);
  await repository.insertReview(database, record({ id: "r-3", idempotencyKey: "key-4", revision: 2 }));
  assert.equal((await repository.findActiveReview(database, scope, "snap-1", "alice"))!.id, "r-3");
  assert.equal((await repository.findActiveReview(database, scope, "snap-1", "alice"))!.revision, 2);
});

test("document 与索引列必须一致，举报只增不改且同人同条唯一", async () => {
  await assert.rejects(database.query(
    "INSERT INTO epr_peer_reviews(id,organization_id,event_id,snapshot_id,team_id,reviewer_user_id,scale,status,revision,created_at,updated_at,withdrawn_at,superseded_at,idempotency_key,document)\n" +
    " VALUES('r-bad','org-a','event-a','snap-1','team-a','bob','1-5','active',1,now(),now(),NULL,NULL,'key-bad','{\"id\":\"r-bad\",\"organizationId\":\"org-a\",\"eventId\":\"event-a\",\"snapshotId\":\"snap-1\",\"teamId\":\"team-b\",\"reviewerUserId\":\"bob\",\"scale\":\"1-5\",\"status\":\"active\",\"revision\":1,\"idempotencyKey\":\"key-bad\",\"dimensions\":[],\"values\":[]}'::jsonb)"),
    /check constraint|violates/i);
  await repository.insertReport(database, report());
  assert.deepEqual(await repository.findReport(database, scope, "r-1", "bob"), report());
  assert.equal(await repository.findReport(database, scope, "r-1", "carol"), null);
  await assert.rejects(repository.insertReport(database, report({ id: "p-dup" })), /duplicate key|unique/i);
  assert.equal((await repository.listReports(database, scope)).length, 1);
  await assert.rejects(database.query("UPDATE epr_review_reports SET reason='改掉' WHERE id='p-1'"), /append-only/);
  await assert.rejects(database.query("DELETE FROM epr_review_reports WHERE id='p-1'"), /append-only/);
});
