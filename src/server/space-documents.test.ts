import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { createSpaceDocuments } from "./space-documents.ts";

const owner: Actor = { userId: "author", platformRoles: ["user"] };
const teammate: Actor = { userId: "teammate", platformRoles: ["user"] };
const stranger: Actor = { userId: "stranger", platformRoles: ["user"] };
const instant = "2026-10-12T04:00:00.000Z";
const projectId = "space-a";

/** Isolated, real in-memory PostgreSQL engine. Never loads .env or a production directory. */
async function fixture(t: TestContext) {
  const engine = new PGlite();
  await engine.waitReady;
  t.after(() => engine.close());
  await engine.exec(`
    CREATE TABLE auth_users(id text PRIMARY KEY, status text NOT NULL);
    CREATE TABLE projects_project(id text PRIMARY KEY, stage text NOT NULL);
    CREATE TABLE projects_project_membership(
      membership_id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects_project(id),
      user_id text NOT NULL REFERENCES auth_users(id), status text NOT NULL, UNIQUE(project_id,user_id));
    INSERT INTO auth_users VALUES('author','active'),('teammate','active'),('stranger','active');
    INSERT INTO projects_project VALUES('space-a','active'),('space-b','active');
    INSERT INTO projects_project_membership VALUES
      ('author-a','space-a','author','active'),('teammate-a','space-a','teammate','active'),
      ('stranger-b','space-b','stranger','active');
  `);
  // These are the actual document migrations, applied only to this private test engine.
  for (const migration of ["060_space_documents.sql", "061_space_documents_team_edit.sql"]) {
    await engine.exec(await readFile(new URL(`../../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const executor = (source: Pick<PGlite, "query">): SqlExecutor => ({
    async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      const result = await source.query<Row>(statement, [...parameters]);
      return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0 };
    },
  });
  const direct = executor(engine);
  const database: DatabasePort = {
    query: direct.query,
    transaction: work => engine.transaction(tx => work(executor(tx))),
  };
  let nextId = 0;
  const service = createSpaceDocuments({ database, clock: { now: () => new Date(instant) }, ids: { next: () => `document-${++nextId}` } });
  const create = (body = "原始正文") => service.create(owner, projectId, { title: "交接说明", body });
  return { engine, service, create };
}

test("作者创建返回真实保存内容；队友读取完整正文并保留纯文字与换行", async t => {
  const f = await fixture(t);
  const body = `先看接口\n${"完整内容。".repeat(100)}\n<script>不执行，只是文字</script>`;
  const saved = await f.create(body);
  assert.equal(saved.body, body);
  assert.equal(saved.authorId, owner.userId);
  assert.equal(saved.teamEditable, false);
  assert.deepEqual(await f.service.list(teammate, projectId), [saved]);
});

test("未共享时队友可读不可改，拒绝后正文与revision不变", async t => {
  const f = await fixture(t), saved = await f.create();
  await assert.rejects(f.service.update(teammate, projectId, saved.id, { expectedRevision: 1, body: "不该保存" }), { code: "FORBIDDEN" });
  assert.deepEqual(await f.service.list(owner, projectId), [saved]);
});

test("作者开启共享后队友编辑真实持久，返回值与双方重读一致，作者身份不被替换", async t => {
  const f = await fixture(t), saved = await f.create();
  const shared = await f.service.share(owner, projectId, saved.id, { expectedRevision: 1, teamEditable: true });
  assert.equal(shared.revision, 2);
  const edited = await f.service.update(teammate, projectId, saved.id, { expectedRevision: 2, title: "更新后的交接", body: "队友的完整修改\n下一步联调" });
  assert.equal(edited.revision, 3);
  assert.equal(edited.authorId, owner.userId);
  assert.equal(edited.sharedAt, shared.sharedAt);
  assert.deepEqual(await f.service.list(teammate, projectId), [edited]);
  assert.deepEqual(await f.service.list(owner, projectId), [edited]);
});

test("陌生人不能跨空间读取或写入文档，即使文档已共享编辑", async t => {
  const f = await fixture(t), saved = await f.create();
  await f.service.share(owner, projectId, saved.id, { expectedRevision: 1, teamEditable: true });
  await assert.rejects(f.service.list(stranger, projectId), { code: "FORBIDDEN" });
  await assert.rejects(f.service.create(stranger, projectId, { title: "越权" }), { code: "FORBIDDEN" });
  await assert.rejects(f.service.update(stranger, projectId, saved.id, { expectedRevision: 2, body: "越权" }), { code: "FORBIDDEN" });
  await assert.rejects(f.service.share(stranger, projectId, saved.id, { expectedRevision: 2, teamEditable: false }), { code: "FORBIDDEN" });
  await assert.rejects(f.service.remove(stranger, projectId, saved.id), { code: "FORBIDDEN" });
  await assert.rejects(f.service.update(stranger, "space-b", saved.id, { expectedRevision: 2, body: "越界" }), { code: "NOT_FOUND" });
  assert.equal((await f.service.list(owner, projectId))[0]!.body, saved.body);
});

test("共享编辑不授予共享或删除权限，作者收回后队友立即恢复只读", async t => {
  const f = await fixture(t), saved = await f.create();
  await f.service.share(owner, projectId, saved.id, { expectedRevision: 1, teamEditable: true });
  await assert.rejects(f.service.share(teammate, projectId, saved.id, { expectedRevision: 2, teamEditable: false }), { code: "FORBIDDEN" });
  await assert.rejects(f.service.remove(teammate, projectId, saved.id), { code: "FORBIDDEN" });
  const revoked = await f.service.share(owner, projectId, saved.id, { expectedRevision: 2, teamEditable: false });
  assert.equal(revoked.sharedAt, null);
  await assert.rejects(f.service.update(teammate, projectId, saved.id, { expectedRevision: 3, body: "收回后的旧页面保存" }), { code: "FORBIDDEN" });
  assert.deepEqual(await f.service.list(teammate, projectId), [revoked]);
});

test("旧版本编辑与共享返回409，不覆盖新内容或共享设置", async t => {
  const f = await fixture(t), saved = await f.create();
  const latest = await f.service.update(owner, projectId, saved.id, { expectedRevision: 1, body: "作者的新内容" });
  await assert.rejects(f.service.update(owner, projectId, saved.id, { expectedRevision: 1, body: "旧标签页" }), { code: "VERSION_CONFLICT", status: 409 });
  await assert.rejects(f.service.share(owner, projectId, saved.id, { expectedRevision: 1, teamEditable: true }), { code: "VERSION_CONFLICT", status: 409 });
  assert.deepEqual(await f.service.list(owner, projectId), [latest]);
});

test("归档空间仍可读全文，所有文档业务写入被拒绝且不改变原记录", async t => {
  const f = await fixture(t), saved = await f.create("保留的完整历史正文");
  await f.engine.query("UPDATE projects_project SET stage='archived' WHERE id=$1", [projectId]);
  await assert.rejects(f.service.create(owner, projectId, { title: "归档后新建" }), { code: "PROJECT_ARCHIVED" });
  await assert.rejects(f.service.update(owner, projectId, saved.id, { expectedRevision: 1, body: "归档后更改" }), { code: "PROJECT_ARCHIVED" });
  await assert.rejects(f.service.share(owner, projectId, saved.id, { expectedRevision: 1, teamEditable: true }), { code: "PROJECT_ARCHIVED" });
  await assert.rejects(f.service.remove(owner, projectId, saved.id), { code: "PROJECT_ARCHIVED" });
  assert.deepEqual(await f.service.list(teammate, projectId), [saved]);
});

test("账号停用和成员撤销会在事务内复核，旧Actor不能继续读写", async t => {
  const f = await fixture(t), saved = await f.create();
  await f.engine.query("UPDATE auth_users SET status='suspended' WHERE id='teammate'");
  await assert.rejects(f.service.list(teammate, projectId), { code: "FORBIDDEN" });
  await assert.rejects(f.service.create(teammate, projectId, { title: "旧账号操作" }), { code: "FORBIDDEN" });
  await f.engine.query("UPDATE auth_users SET status='active' WHERE id='teammate'");
  await f.engine.query("UPDATE projects_project_membership SET status='removed' WHERE membership_id='teammate-a'");
  await assert.rejects(f.service.list(teammate, projectId), { code: "FORBIDDEN" });
  await assert.rejects(f.service.update(teammate, projectId, saved.id, { expectedRevision: 1, body: "旧成员操作" }), { code: "FORBIDDEN" });
});

test("严格拒绝非法对象、未知字段、伪造作者、错误版本与空编辑", async t => {
  const f = await fixture(t), saved = await f.create();
  for (const input of [null, [], "文本", { title: "新文档", authorId: "stranger" }, { title: "新文档", teamEditable: true }, { title: "\u0000" }, { title: "x".repeat(201) }, { title: "新文档", body: "x".repeat(20001) }]) {
    await assert.rejects(f.service.create(owner, projectId, input), { code: "INVALID_INPUT" });
  }
  for (const input of [{ expectedRevision: 1 }, { expectedRevision: "1", body: "新" }, { expectedRevision: 1, body: "新", authorId: "stranger" }, { expectedRevision: 1, body: "\u0000" }]) {
    await assert.rejects(f.service.update(owner, projectId, saved.id, input), { code: "INVALID_INPUT" });
  }
  await assert.rejects(f.service.share(owner, projectId, saved.id, { expectedRevision: 1, teamEditable: "true" }), { code: "INVALID_INPUT" });
  assert.deepEqual(await f.service.list(owner, projectId), [saved]);
});

test("数据库零行更新不返回虚假成功，原文保持不变", async t => {
  const f = await fixture(t), saved = await f.create();
  // PostgreSQL BEFORE trigger explicitly suppresses this write: real UPDATE affects zero rows.
  await f.engine.exec(`CREATE FUNCTION fixture_skip_document_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$;
    CREATE TRIGGER fixture_skip_document_update BEFORE UPDATE ON space_documents FOR EACH ROW EXECUTE FUNCTION fixture_skip_document_update();`);
  await assert.rejects(f.service.update(owner, projectId, saved.id, { expectedRevision: 1, body: "不应显示已保存" }), { code: "VERSION_CONFLICT" });
  await assert.rejects(f.service.share(owner, projectId, saved.id, { expectedRevision: 1, teamEditable: true }), { code: "VERSION_CONFLICT" });
  assert.deepEqual(await f.service.list(owner, projectId), [saved]);
});

test("两个相同旧版本的保存只接受一份，后者不覆盖前者", async t => {
  const f = await fixture(t), saved = await f.create();
  await f.service.share(owner, projectId, saved.id, { expectedRevision: 1, teamEditable: true });
  const results = await Promise.allSettled([
    f.service.update(owner, projectId, saved.id, { expectedRevision: 2, body: "作者保存" }),
    f.service.update(teammate, projectId, saved.id, { expectedRevision: 2, body: "队友保存" }),
  ]);
  const passed = results.filter(result => result.status === "fulfilled");
  const rejected = results.filter(result => result.status === "rejected");
  assert.equal(passed.length, 1); assert.equal(rejected.length, 1);
  assert.equal((rejected[0] as PromiseRejectedResult).reason.code, "VERSION_CONFLICT");
  const actual = (await f.service.list(teammate, projectId))[0]!;
  assert.equal(actual.revision, 3);
  assert.deepEqual(actual, (passed[0] as PromiseFulfilledResult<typeof actual>).value);
});

test("只有作者可以删除真实文档，重复删除不会伪造成功", async t => {
  const f = await fixture(t), saved = await f.create();
  assert.deepEqual(await f.service.remove(owner, projectId, saved.id), { id: saved.id });
  assert.deepEqual(await f.service.list(teammate, projectId), []);
  await assert.rejects(f.service.remove(owner, projectId, saved.id), { code: "NOT_FOUND" });
});
