import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { createSpaceCanvasLayouts } from "./space-canvas-layouts.ts";

const owner: Actor = { userId: "owner", platformRoles: ["user"] };
const teammate: Actor = { userId: "teammate", platformRoles: ["user"] };
const stranger: Actor = { userId: "stranger", platformRoles: ["admin"] };
const projectId = "space-a";
const instant = "2026-10-12T04:00:00.000Z";
const placement = (x = 24) => ({ instanceId: "todos-1", kind: "todos", x, y: 24, collapsed: false, width: 380, height: 300, scale: 1 });

/** The real 063 migration is applied only to an isolated in-memory engine.
 * PGlite serializes its transactions; these tests do not claim remote pool or
 * multi-connection PostgreSQL lock acceptance. */
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
    INSERT INTO auth_users VALUES('owner','active'),('teammate','active'),('stranger','active');
    INSERT INTO projects_project VALUES('space-a','active'),('space-b','active'),('space-archived','archived');
    INSERT INTO projects_project_membership VALUES
      ('owner-a','space-a','owner','active'),('teammate-a','space-a','teammate','active'),
      ('owner-b','space-b','owner','active'),('stranger-b','space-b','stranger','active'),
      ('owner-archived','space-archived','owner','active');
  `);
  await engine.exec(await readFile(new URL("../../migrations/063_space_canvas_items.sql", import.meta.url), "utf8"));
  const executor = (source: Pick<PGlite, "query">): SqlExecutor => ({
    async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      const result = await source.query<Row>(statement, [...parameters]);
      return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0 };
    },
  });
  const direct = executor(engine);
  const database: DatabasePort = { query: direct.query, transaction: work => engine.transaction(tx => work(executor(tx))) };
  const service = createSpaceCanvasLayouts({ database, clock: { now: () => new Date(instant) } });
  const save = (expectedRevision: number, x = 24) => service.save(owner, projectId, { expectedRevision, items: [placement(x)] });
  return { engine, service, save };
}

test("GET returns a genuine empty preference without initializing any record", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.get(owner, projectId), { revision: 0, items: [] });
  assert.deepEqual(await f.service.get(owner, projectId), { revision: 0, items: [] });
  assert.equal((await f.engine.query<{ count: number }>("SELECT count(*)::int AS count FROM space_canvas_items")).rows[0]!.count, 0);
});

test("fractional group positions and relative scales survive a database round trip", async t => {
  const f = await fixture(t);
  const items = [
    { ...placement(40.123456789), y: 31.666666666, scale: 1.037654321 },
    { ...placement(397.987654321), instanceId: "overview-2", kind: "overview", y: 77.333333333, scale: 1.29706790125 },
  ];
  const saved = await f.service.save(owner, projectId, { expectedRevision: 0, items });
  assert.deepEqual(saved.items, items);
  const loaded = await f.service.get(owner, projectId);
  assert.deepEqual(loaded.items, items);
  assert.equal(loaded.items[1]!.scale! / loaded.items[0]!.scale!, 1.25);
});

test("layout is isolated by real account and space, including ordinary teammates", async t => {
  const f = await fixture(t), first = await f.save(0);
  assert.deepEqual(first, { revision: 1, items: [placement()] });
  assert.deepEqual(await f.service.get(owner, projectId), first);
  assert.deepEqual(await f.service.get(teammate, projectId), { revision: 0, items: [] });
  const otherPerson = await f.service.save(teammate, projectId, { expectedRevision: 0, items: [placement(100)] });
  const otherSpace = await f.service.save(owner, "space-b", { expectedRevision: 0, items: [placement(200)] });
  assert.deepEqual(await f.service.get(owner, projectId), first);
  assert.deepEqual(await f.service.get(teammate, projectId), otherPerson);
  assert.deepEqual(await f.service.get(owner, "space-b"), otherSpace);
  await assert.rejects(f.service.get(stranger, projectId), { code: "FORBIDDEN" });
  await assert.rejects(f.service.save(stranger, projectId, { expectedRevision: 0, items: [] }), { code: "FORBIDDEN" });
});

test("two first saves accept only one revision and return 409 rather than unique-constraint 500", async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.save(0, 80), f.save(0, 160)]);
  const passed = results.filter(result => result.status === "fulfilled");
  const rejected = results.filter(result => result.status === "rejected");
  assert.equal(passed.length, 1); assert.equal(rejected.length, 1);
  assert.equal((rejected[0] as PromiseRejectedResult).reason.code, "VERSION_CONFLICT");
  assert.equal((rejected[0] as PromiseRejectedResult).reason.status, 409);
  assert.deepEqual(await f.service.get(owner, projectId), (passed[0] as PromiseFulfilledResult<unknown>).value);
  assert.equal((await f.engine.query<{ count: number }>("SELECT count(*)::int AS count FROM space_canvas_items")).rows[0]!.count, 1);
});

test("two saves from the same old revision preserve the winner and reject the stale version", async t => {
  const f = await fixture(t); await f.save(0);
  const results = await Promise.allSettled([f.save(1, 300), f.save(1, 600)]);
  const passed = results.filter(result => result.status === "fulfilled");
  const rejected = results.filter(result => result.status === "rejected");
  assert.equal(passed.length, 1); assert.equal(rejected.length, 1);
  assert.equal((rejected[0] as PromiseRejectedResult).reason.code, "VERSION_CONFLICT");
  assert.equal((rejected[0] as PromiseRejectedResult).reason.status, 409);
  const actual = await f.service.get(owner, projectId);
  assert.equal(actual.revision, 2);
  assert.deepEqual(actual, (passed[0] as PromiseFulfilledResult<unknown>).value);
});

test("suspended accounts and revoked memberships reject stale Actors on reads and writes", async t => {
  const f = await fixture(t), saved = await f.save(0);
  await f.engine.query("UPDATE auth_users SET status='suspended' WHERE id='owner'");
  await assert.rejects(f.service.get(owner, projectId), { code: "FORBIDDEN" });
  await assert.rejects(f.save(1), { code: "FORBIDDEN" });
  await f.engine.query("UPDATE auth_users SET status='active' WHERE id='owner'");
  await f.engine.query("UPDATE projects_project_membership SET status='removed' WHERE membership_id='owner-a'");
  await assert.rejects(f.service.get(owner, projectId), { code: "FORBIDDEN" });
  await assert.rejects(f.save(1), { code: "FORBIDDEN" });
  const row = (await f.engine.query<{ revision: number; items: unknown }>("SELECT revision,items FROM space_canvas_items WHERE project_id=$1 AND user_id=$2", [projectId, owner.userId])).rows[0]!;
  assert.deepEqual(row, saved);
});

test("archived spaces allow only these private layout preferences and keep business stage unchanged", async t => {
  const f = await fixture(t);
  const saved = await f.service.save(owner, "space-archived", { expectedRevision: 0, items: [placement()] });
  assert.deepEqual(await f.service.get(owner, "space-archived"), saved);
  assert.equal((await f.engine.query<{ stage: string }>("SELECT stage FROM projects_project WHERE id='space-archived'")).rows[0]!.stage, "archived");
  assert.deepEqual(await f.service.get(owner, projectId), { revision: 0, items: [] });
});

test("strict objects, allowed fields, supported components, finite coordinates and real revisions are required", async t => {
  const f = await fixture(t);
  const item = placement();
  for (const input of [null, [], "layout", new Date(), { expectedRevision: 0, items: [], userId: "teammate" },
    { expectedRevision: "0", items: [] }, { expectedRevision: -1, items: [] }, { expectedRevision: 0.5, items: [] },
    { expectedRevision: Number.MAX_SAFE_INTEGER, items: [] }, { expectedRevision: 0, items: null },
    { expectedRevision: 0, items: [{ ...item, businessStatus: "done" }] },
    { expectedRevision: 0, items: [{ ...item, kind: "unknown" }] },
    { expectedRevision: 0, items: [{ ...item, x: NaN }] }, { expectedRevision: 0, items: [{ ...item, x: -1 }] },
    { expectedRevision: 0, items: [{ ...item, y: Infinity }] }, { expectedRevision: 0, items: [{ ...item, collapsed: "true" }] },
    { expectedRevision: 0, items: [{ ...item, instanceId: "\u0000" }] }, { expectedRevision: 0, items: [{ ...item, instanceId: "" }] },
    { expectedRevision: 0, items: [{ ...item, width: 0 }] }, { expectedRevision: 0, items: [{ ...item, height: null }] },
    { expectedRevision: 0, items: [{ ...item, scale: 10 }] }, { expectedRevision: 0, items: [item, { ...item }] },
    { expectedRevision: 0, items: [Object.assign(Object.create({ hidden: true }), item)] }]) {
    await assert.rejects(f.service.save(owner, projectId, input), { code: "INVALID_INPUT", status: 422 });
  }
  assert.deepEqual(await f.service.get(owner, projectId), { revision: 0, items: [] });
});

test("an actual zero-row INSERT cannot create a phantom saved layout", async t => {
  const f = await fixture(t);
  await f.engine.exec(`CREATE FUNCTION fixture_skip_canvas_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$;
    CREATE TRIGGER fixture_skip_canvas_insert BEFORE INSERT ON space_canvas_items FOR EACH ROW EXECUTE FUNCTION fixture_skip_canvas_insert();`);
  await assert.rejects(f.save(0), { code: "VERSION_CONFLICT", status: 409 });
  assert.deepEqual(await f.service.get(owner, projectId), { revision: 0, items: [] });
});

test("an actual zero-row UPDATE is rejected and retains the original persisted revision and items", async t => {
  const f = await fixture(t), saved = await f.save(0);
  await f.engine.exec(`CREATE FUNCTION fixture_skip_canvas_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$;
    CREATE TRIGGER fixture_skip_canvas_update BEFORE UPDATE ON space_canvas_items FOR EACH ROW EXECUTE FUNCTION fixture_skip_canvas_update();`);
  await assert.rejects(f.save(1, 800), { code: "VERSION_CONFLICT", status: 409 });
  assert.deepEqual(await f.service.get(owner, projectId), saved);
});

test("save returns the actual database result rather than promising its proposed values were stored", async t => {
  const f = await fixture(t);
  await f.engine.exec(`CREATE FUNCTION fixture_adjust_canvas_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.items := jsonb_set(NEW.items, '{0,x}', '40'::jsonb); RETURN NEW; END; $$;
    CREATE TRIGGER fixture_adjust_canvas_insert BEFORE INSERT ON space_canvas_items FOR EACH ROW EXECUTE FUNCTION fixture_adjust_canvas_insert();`);
  const actual = await f.save(0);
  assert.equal(actual.items[0]!.x, 40);
  assert.deepEqual(await f.service.get(owner, projectId), actual);
});
