import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createDatabase } from "./database.ts";

// Explicit test connection only: production DATABASE_URL is never silently used.
const connectionString = process.env.TEST_DATABASE_URL;
test("remote PostgreSQL uses separate clients and serializes a competing version update", { skip: !connectionString, timeout: 20_000 }, async () => {
  const database = await createDatabase({ connectionString, maxConnections: 3 });
  const table = `acceptance_concurrency_${randomBytes(8).toString("hex")}`;
  assert.match(table, /^acceptance_concurrency_[a-f0-9]{16}$/);
  let releaseFirst!: () => void;
  const firstCanCommit = new Promise<void>(resolve => { releaseFirst = resolve; });
  let firstLocked!: () => void;
  const locked = new Promise<void>(resolve => { firstLocked = resolve; });
  let first: Promise<number> | undefined;
  try {
    await database.query(`CREATE TABLE ${table} (id integer PRIMARY KEY, revision integer NOT NULL)`);
    await database.query(`INSERT INTO ${table} VALUES (1,1)`);
    first = database.transaction(async transaction => {
      const pid = await transaction.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await transaction.query(`SELECT revision FROM ${table} WHERE id=1 FOR UPDATE`);
      firstLocked();
      await firstCanCommit;
      await transaction.query(`UPDATE ${table} SET revision=2 WHERE id=1 AND revision=1`);
      return pid.rows[0]!.pid;
    });
    await locked;
    let secondPid = 0;
    await assert.rejects(database.transaction(async transaction => {
      secondPid = (await transaction.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await transaction.query("SET LOCAL lock_timeout = '150ms'");
      await transaction.query(`SELECT revision FROM ${table} WHERE id=1 FOR UPDATE`);
    }), (error: unknown) => (error as { code?: string }).code === "55P03");
    releaseFirst();
    const firstPid = await first;
    assert.notEqual(firstPid, secondPid);
    const result = await database.transaction(transaction => transaction.query(`UPDATE ${table} SET revision=3 WHERE id=1 AND revision=1 RETURNING revision`));
    assert.equal(result.rowCount, 0);
    assert.equal((await database.query<{ revision: number }>(`SELECT revision FROM ${table} WHERE id=1`)).rows[0]!.revision, 2);
  } finally {
    releaseFirst();
    if (first) await first.catch(() => {});
    // The random identifier was checked above and belongs exclusively to this test.
    await database.query(`DROP TABLE IF EXISTS ${table}`).finally(() => database.close());
  }
});
