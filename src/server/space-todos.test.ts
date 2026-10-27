import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../shared/contracts.ts";
import { DomainError } from "../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { createSpaceTodos } from "./space-todos.ts";

const me: Actor = { userId: "me", platformRoles: ["user"] };
const teammate: Actor = { userId: "teammate", platformRoles: ["user"] };
const stranger: Actor = { userId: "stranger", platformRoles: ["user"] };
const projectId = "space-a";
const initialTime = "2026-10-12T05:00:00.000Z";

/** Real PostgreSQL statements in a new memory engine; no environment or production directory. */
async function fixture(t: TestContext) {
  const engine = new PGlite(); await engine.waitReady; t.after(() => engine.close());
  await engine.exec(`
    CREATE TABLE auth_users(id text PRIMARY KEY,status text NOT NULL);
    CREATE TABLE projects_project(id text PRIMARY KEY,stage text NOT NULL);
    CREATE TABLE projects_project_membership(membership_id text PRIMARY KEY,
      project_id text REFERENCES projects_project(id),user_id text REFERENCES auth_users(id),
      status text NOT NULL,UNIQUE(project_id,user_id));
    INSERT INTO auth_users VALUES('me','active'),('teammate','active'),('stranger','active');
    INSERT INTO projects_project VALUES('space-a','active'),('space-b','active');
    INSERT INTO projects_project_membership VALUES('me-a','space-a','me','active'),
      ('teammate-a','space-a','teammate','active'),('me-b','space-b','me','active'),
      ('stranger-b','space-b','stranger','active');
  `);
  // 059 owns manual todos. Migration 062 owns the retired component layout and is unrelated.
  await engine.exec(await readFile(new URL("../../migrations/059_space_manual_todos.sql", import.meta.url), "utf8"));
  const executor = (source: Pick<PGlite, "query">): SqlExecutor => ({
    async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      const result = await source.query<Row>(statement, [...parameters]);
      return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0 };
    },
  });
  const direct = executor(engine);
  const database: DatabasePort = { query: direct.query, transaction: work => engine.transaction(tx => work(executor(tx))) };
  let nextId = 0, now = initialTime;
  const service = createSpaceTodos({ database, clock: { now: () => new Date(now) }, ids: { next: () => `todo-${++nextId}` } });
  const create = (title = "问队友要接口文档", note = "只有本人可见") => service.create(me, projectId, { title, note });
  return { engine, service, create, setTime: (value: string) => { now = value; } };
}

test("本人新增、读取、编辑、完成和恢复均持久化；完成时刻只表示私人备忘完成", async t => {
  const f = await fixture(t), saved = await f.create();
  assert.equal(saved.status, "open"); assert.equal(saved.completedAt, null);
  assert.deepEqual(await f.service.list(me, projectId), [saved]);
  const done = await f.service.update(me, projectId, saved.id, { expectedRevision: 1, status: "done" });
  assert.equal(done.completedAt, initialTime);
  f.setTime("2026-10-12T06:00:00.000Z");
  const edited = await f.service.update(me, projectId, saved.id, { expectedRevision: 2, note: "已问过，再补一句" });
  assert.equal(edited.completedAt, initialTime, "编辑备注不能重写第一次完成时刻");
  const reopened = await f.service.update(me, projectId, saved.id, { expectedRevision: 3, status: "open", title: "再问一次" });
  assert.equal(reopened.completedAt, null);
  assert.deepEqual(await f.service.list(me, projectId), [reopened]);
  const project = await f.engine.query<{ stage: string }>("SELECT stage FROM projects_project WHERE id=$1", [projectId]);
  assert.equal(project.rows[0]!.stage, "active", "私人备忘不能推进团队阶段");
});

test("队友只能读自己的待办，不能通过已知ID编辑或删除本人的条目", async t => {
  const f = await fixture(t), saved = await f.create();
  assert.deepEqual(await f.service.list(teammate, projectId), []);
  const theirs = await f.service.create(teammate, projectId, { title: "队友自己的备忘" });
  assert.deepEqual(await f.service.list(teammate, projectId), [theirs]);
  await assert.rejects(f.service.update(teammate, projectId, saved.id, { expectedRevision: 1, status: "done" }), { code: "NOT_FOUND" });
  await assert.rejects(f.service.remove(teammate, projectId, saved.id), { code: "NOT_FOUND" });
  assert.deepEqual(await f.service.list(me, projectId), [saved]);
});

test("同账号不同空间的条目隔离，跨空间ID不能被编辑或删除", async t => {
  const f = await fixture(t), saved = await f.create();
  const elsewhere = await f.service.create(me, "space-b", { title: "另一个空间的备忘" });
  assert.deepEqual(await f.service.list(me, projectId), [saved]);
  assert.deepEqual(await f.service.list(me, "space-b"), [elsewhere]);
  await assert.rejects(f.service.update(me, "space-b", saved.id, { expectedRevision: 1, title: "跨空间修改" }), { code: "NOT_FOUND" });
  await assert.rejects(f.service.remove(me, "space-b", saved.id), { code: "NOT_FOUND" });
});

test("陌生人没有本空间成员权限，读取和所有写入均拒绝", async t => {
  const f = await fixture(t), saved = await f.create();
  await assert.rejects(f.service.list(stranger, projectId), { code: "FORBIDDEN" });
  await assert.rejects(f.service.create(stranger, projectId, { title: "越权" }), { code: "FORBIDDEN" });
  await assert.rejects(f.service.update(stranger, projectId, saved.id, { expectedRevision: 1, title: "越权" }), { code: "FORBIDDEN" });
  await assert.rejects(f.service.remove(stranger, projectId, saved.id), { code: "FORBIDDEN" });
  assert.deepEqual(await f.service.list(me, projectId), [saved]);
});

test("归档允许读取本人历史待办，新增、编辑和删除均拒绝", async t => {
  const f = await fixture(t), saved = await f.create();
  await f.engine.query("UPDATE projects_project SET stage='archived' WHERE id=$1", [projectId]);
  assert.deepEqual(await f.service.list(me, projectId), [saved]);
  await assert.rejects(f.create("归档后新建"), { code: "PROJECT_ARCHIVED" });
  await assert.rejects(f.service.update(me, projectId, saved.id, { expectedRevision: 1, status: "done" }), { code: "PROJECT_ARCHIVED" });
  await assert.rejects(f.service.remove(me, projectId, saved.id), { code: "PROJECT_ARCHIVED" });
  assert.deepEqual(await f.service.list(me, projectId), [saved]);
});

test("停用账号和已撤销成员的旧Actor不能继续读写", async t => {
  const f = await fixture(t), saved = await f.create();
  await f.engine.query("UPDATE auth_users SET status='suspended' WHERE id='me'");
  await assert.rejects(f.service.list(me, projectId), { code: "UNAUTHENTICATED" });
  await assert.rejects(f.create("停用账号写入"), { code: "UNAUTHENTICATED" });
  await f.engine.query("UPDATE auth_users SET status='active' WHERE id='me'");
  await f.engine.query("UPDATE projects_project_membership SET status='removed' WHERE membership_id='me-a'");
  await assert.rejects(f.service.list(me, projectId), { code: "FORBIDDEN" });
  await assert.rejects(f.service.update(me, projectId, saved.id, { expectedRevision: 1, status: "done" }), { code: "FORBIDDEN" });
  await assert.rejects(f.service.remove(me, projectId, saved.id), { code: "FORBIDDEN" });
});

test("旧版本返回409且不覆盖新内容；未知字段和非法输入拒绝且原记录不变", async t => {
  const f = await fixture(t), saved = await f.create();
  const latest = await f.service.update(me, projectId, saved.id, { expectedRevision: 1, note: "最新备注" });
  await assert.rejects(f.service.update(me, projectId, saved.id, { expectedRevision: 1, note: "旧标签页覆盖" }), { code: "VERSION_CONFLICT", status: 409 });
  for (const input of [null, [], "备忘", { title: "新", userId: "teammate" }, { title: "新", status: "done" }, { title: " " }, { title: "x".repeat(201) }, { title: "新", note: "x".repeat(2001) }, { title: "\u0000" }]) {
    await assert.rejects(f.service.create(me, projectId, input), { code: "INVALID_INPUT" });
  }
  for (const input of [{ expectedRevision: "2", status: "done" }, { expectedRevision: 2, status: "unknown" }, { expectedRevision: 2, title: "" }, { expectedRevision: 2, userId: "teammate" }, { expectedRevision: 2, note: "\u0000" }]) {
    await assert.rejects(f.service.update(me, projectId, saved.id, input), { code: "INVALID_INPUT" });
  }
  assert.deepEqual(await f.service.list(me, projectId), [latest]);
});

test("真实零行UPDATE不能假报保存成功，真实零行DELETE不能假报删除成功", async t => {
  const f = await fixture(t), saved = await f.create();
  await f.engine.exec(`CREATE FUNCTION fixture_skip_todo_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$;
    CREATE TRIGGER fixture_skip_todo_update BEFORE UPDATE ON space_manual_todos FOR EACH ROW EXECUTE FUNCTION fixture_skip_todo_write();
    CREATE TRIGGER fixture_skip_todo_delete BEFORE DELETE ON space_manual_todos FOR EACH ROW EXECUTE FUNCTION fixture_skip_todo_write();`);
  await assert.rejects(f.service.update(me, projectId, saved.id, { expectedRevision: 1, status: "done" }), { code: "VERSION_CONFLICT" });
  await assert.rejects(f.service.remove(me, projectId, saved.id), { code: "NOT_FOUND" });
  assert.deepEqual(await f.service.list(me, projectId), [saved]);
});

test("真实零行INSERT不能返回不存在的私人待办", async t => {
  const f = await fixture(t);
  await f.engine.exec(`CREATE FUNCTION fixture_skip_todo_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$;
    CREATE TRIGGER fixture_skip_todo_insert BEFORE INSERT ON space_manual_todos FOR EACH ROW EXECUTE FUNCTION fixture_skip_todo_insert();`);
  await assert.rejects(f.create("数据库没有真正创建"), error => error instanceof DomainError);
  assert.deepEqual(await f.service.list(me, projectId), []);
});

test("相同版本的两个保存只接受一个，成功保存值与重读一致", async t => {
  const f = await fixture(t), saved = await f.create();
  const results = await Promise.allSettled([
    f.service.update(me, projectId, saved.id, { expectedRevision: 1, note: "第一份修改" }),
    f.service.update(me, projectId, saved.id, { expectedRevision: 1, note: "第二份修改" }),
  ]);
  const passed = results.filter(item => item.status === "fulfilled"), rejected = results.filter(item => item.status === "rejected");
  assert.equal(passed.length, 1); assert.equal(rejected.length, 1);
  assert.equal((rejected[0] as PromiseRejectedResult).reason.code, "VERSION_CONFLICT");
  assert.deepEqual(await f.service.list(me, projectId), [(passed[0] as PromiseFulfilledResult<typeof saved>).value]);
});

test("删除只移除本人的真实条目，重复删除返回404", async t => {
  const f = await fixture(t), saved = await f.create();
  const theirs = await f.service.create(teammate, projectId, { title: "队友的条目" });
  assert.deepEqual(await f.service.remove(me, projectId, saved.id), { id: saved.id });
  assert.deepEqual(await f.service.list(me, projectId), []);
  assert.deepEqual(await f.service.list(teammate, projectId), [theirs]);
  await assert.rejects(f.service.remove(me, projectId, saved.id), { code: "NOT_FOUND" });
});
