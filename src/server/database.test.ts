import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { createDatabase } from "./database.ts";

test("actual PostgreSQL engine applies the integrated schema once, retaining migration checksums", async () => {
  const database = await createDatabase({});
  try {
    await database.migrate();
    await database.migrate();
    const migrations = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM application_migrations");
    assert.ok(migrations.rows[0].count >= 3);
    const tables = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'");
    assert.ok(tables.rows[0].count >= 61);
    assert.equal(tables.rowCount, 1, "SELECT counts result rows rather than affectedRows=0");
    await assert.rejects(database.query("INSERT INTO projects_project_membership(membership_id,project_id,user_id,role,status,revision,joined_at) VALUES ('invalid','missing','missing','member','active',1,now())"));
  } finally { await database.close(); }
});

test("ambient queries share the transaction and nested rollback does not discard the outer work", async () => {
  const database = await createDatabase({});
  try {
    await database.query("CREATE TABLE transaction_probe(id integer PRIMARY KEY)");
    await database.transaction(async transaction => {
      await transaction.query("INSERT INTO transaction_probe VALUES (1)");
      const read = await database.query<{ id: number }>("SELECT id FROM transaction_probe");
      assert.deepEqual(read.rows, [{ id: 1 }]);
      await assert.rejects(database.transaction(async nested => { await nested.query("INSERT INTO transaction_probe VALUES (2)"); throw new Error("rollback nested"); }));
      await database.query("INSERT INTO transaction_probe VALUES (3)");
    });
    assert.deepEqual((await database.query("SELECT id FROM transaction_probe ORDER BY id")).rows, [{ id: 1 }, { id: 3 }]);
    await assert.rejects(database.transaction(async transaction => { await transaction.query("INSERT INTO transaction_probe VALUES (4)"); throw new Error("rollback outer"); }));
    assert.equal((await database.query("SELECT id FROM transaction_probe WHERE id=4")).rowCount, 0);
  } finally { await database.close(); }
});

test("local database data survive engine close and a new connection", async () => {
  await mkdir(join(process.cwd(), ".runtime"), { recursive: true });
  const path = await mkdtemp(join(process.cwd(), ".runtime", "persistence-check-"));
  const first = await createDatabase({ localPath: path });
  try { await first.query("CREATE TABLE persistence_probe(value text NOT NULL)"); await first.query("INSERT INTO persistence_probe VALUES ($1)", ["真实持久化"]); }
  finally { await first.close(); }
  const second = await createDatabase({ localPath: path });
  try { assert.deepEqual((await second.query("SELECT value FROM persistence_probe")).rows, [{ value: "真实持久化" }]); }
  finally { await second.close(); }
});
