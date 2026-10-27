import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { HostedEventScope } from "../../shared/organizer-contracts.ts";
import type { ContactWillingness } from "./model.ts";
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
    CREATE TABLE event_registration_teams(event_id text NOT NULL, id text NOT NULL, PRIMARY KEY(event_id, id));
    INSERT INTO auth_users(id) VALUES ('alice'),('bob');
    INSERT INTO organizer_hosted_events(id, organization_id) VALUES ('event-a','org-a');
    INSERT INTO event_registration_teams(event_id, id) VALUES ('event-a','team-a'),('event-a','team-b');`);
  await engine.exec(await readFile(new URL("./migrations/001-event-closure.sql", import.meta.url), "utf8"));
  database = { ...executor(engine), transaction: work => engine.transaction(transaction => work(executor(transaction))) };
});
after(async () => { await engine.close(); });

const time = "2026-10-16T08:00:00.000Z";
const scope: HostedEventScope = {
  organizationId: "org-a", organizationName: "机构", eventId: "event-a", title: "赛事", status: "ended", revision: 1, publishedRevision: 1,
  timezone: "Asia/Shanghai", startsAt: time, endsAt: time, registrationOpensAt: null, registrationClosesAt: null, submissionClosesAt: null,
  modules: { registration: true, teams: true, judging: true, schedule: false, accommodation: false, mealVouchers: false, icebreaking: false },
  registration: { reviewRequired: false, capacity: null }, teams: { mode: "free", minSize: 1, maxSize: 4, locksAt: null }, linkedEventId: null,
};
const record = (overrides: Partial<ContactWillingness> = {}): ContactWillingness => ({
  id: "w-1", organizationId: "org-a", eventId: "event-a", teamId: "team-a", authorUserId: "alice", willing: true,
  status: "active", revision: 1, submittedAt: time, withdrawnAt: null, idempotencyKey: "key-1", ...overrides,
});

test("联系意愿行按 scope 读写，重放与当前有效记录都只看本场", async () => {
  await repository.insertWillingness(database, record());
  assert.deepEqual(await repository.getWillingness(database, scope, "w-1"), record());
  assert.deepEqual(await repository.findWillingnessReplay(database, scope, "alice", "key-1"), record());
  assert.equal(await repository.findWillingnessReplay(database, scope, "alice", "other"), null);
  assert.deepEqual(await repository.findActiveWillingness(database, scope, "team-a"), record());
  assert.equal(await repository.findActiveWillingness(database, scope, "team-b"), null);
  // 跨赛事 scope 读不到：不是同一条事实。
  assert.equal(await repository.getWillingness(database, { ...scope, eventId: "event-other" }, "w-1"), null);
});

test("一队一条有效记录由部分唯一索引强制；撤回后可以再插入一条", async () => {
  await assert.rejects(repository.insertWillingness(database, record({ id: "w-dup", authorUserId: "bob", idempotencyKey: "key-2" })), /duplicate key|unique/i);
  const withdrawn: ContactWillingness = { ...record(), status: "withdrawn", revision: 2, withdrawnAt: time };
  assert.equal(await repository.updateWillingness(database, scope, 1, withdrawn), true);
  assert.deepEqual(await repository.findActiveWillingness(database, scope, "team-a"), null);
  await repository.insertWillingness(database, record({ id: "w-2", authorUserId: "bob", idempotencyKey: "key-3", willing: false }));
  assert.deepEqual(await repository.findActiveWillingness(database, scope, "team-a"), record({ id: "w-2", authorUserId: "bob", idempotencyKey: "key-3", willing: false }));
  assert.equal((await repository.listWillingness(database, scope)).length, 2);
});

test("触发器冻结队伍、提交人、原始选择、时间与重试标识，并要求版本加一", async () => {
  await assert.rejects(database.query("UPDATE ecl_contact_willingness SET team_id='team-b' WHERE id='w-1'"), /immutable/);
  await assert.rejects(database.query("UPDATE ecl_contact_willingness SET author_user_id='bob' WHERE id='w-1'"), /immutable/);
  await assert.rejects(database.query("UPDATE ecl_contact_willingness SET willing=false WHERE id='w-1'"), /immutable/);
  await assert.rejects(database.query("UPDATE ecl_contact_willingness SET submitted_at=now() WHERE id='w-1'"), /immutable/);
  await assert.rejects(database.query("UPDATE ecl_contact_willingness SET idempotency_key='other' WHERE id='w-1'"), /immutable/);
  await assert.rejects(database.query("UPDATE ecl_contact_willingness SET revision=5,status='withdrawn',withdrawn_at=now() WHERE id='w-2'"), /revision/);
  // 已撤回的行不能再改。
  await assert.rejects(database.query("UPDATE ecl_contact_willingness SET revision=3,status='withdrawn' WHERE id='w-1'"), /active to withdrawn/);
});

test("document 与索引列必须一致，防止同一事实两处漂移", async () => {
  await assert.rejects(database.query(
    `INSERT INTO ecl_contact_willingness(id,organization_id,event_id,team_id,author_user_id,willing,status,revision,submitted_at,withdrawn_at,idempotency_key,document)
     VALUES('w-bad','org-a','event-a','team-a','alice',true,'active',1,now(),NULL,'key-bad','{"id":"w-bad","organizationId":"org-a","eventId":"event-a","teamId":"team-b","authorUserId":"alice","willing":true,"status":"active","revision":1,"idempotencyKey":"key-bad"}'::jsonb)`),
    /check constraint|violates/i);
});
