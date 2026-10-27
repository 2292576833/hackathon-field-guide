import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import type { SqlExecutor } from "../../shared/persistence.ts";
import { PostgresAuditQueryPort } from "./audit-query-postgres.ts";
import type { AuditQueryFilters } from "./audit-query-types.ts";

const filters: AuditQueryFilters = { from: "2026-10-09T00:00:00.000000Z", to: "2026-10-10T09:00:00.000000Z", actorId: null, action: null, objectKind: null, objectId: null, revision: null, stream: null };
test("audit SQL uses metadata columns, parameters, DESC keyset, C collation and bounded limit", async () => {
  let sql = ""; let params: readonly unknown[] = [];
  const tx: SqlExecutor = { async query(statement, parameters) { sql = statement; params = parameters ?? []; return { rows: [], rowCount: 0 }; } };
  await new PostgresAuditQueryPort().readPage(tx, { ...filters, objectId: "object-1" }, { occurredAt: "2026-10-10T08:00:00.123456Z", id: "execution:b" }, 11);
  assert.doesNotMatch(sql, /SELECT\s+\*|\breason\b|\bbody\b|payload\s+AS|auth_users|projects_|github_|personal_/i);
  assert.ok(!sql.includes("object-1")); assert.equal(params[5], "object-1"); assert.equal(params[10], 11);
  assert.match(sql, /COLLATE "C"/); assert.match(sql, /LIMIT \$11::integer/); assert.match(sql, /SS.US/);
});
test("in-memory SQL projection handles all existing M08 audit schemas and precise paging without disclosing payload", async () => {
  // Isolated in-memory database only; no production path, environment file or actual migration.
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE operations_execution_audit (id text, actor_kind text, actor_id text, action text, entity_id text, revision integer, reason text, occurred_at timestamptz);
      CREATE TABLE operations_event_review_audit (id text, event_id text, payload jsonb, occurred_at timestamptz);
      CREATE TABLE operations_resource_review_audit (id text, resource_id text, actor_id text, payload jsonb, occurred_at timestamptz);
      CREATE TABLE operations_correction_transitions (id text, correction_id text, revision integer, actor_id text, payload jsonb, occurred_at timestamptz);
      CREATE TABLE operations_discovery_control_audit (id bigint, scheduler_id text, actor_id text, revision integer, paused boolean, occurred_at timestamptz);
    `);
    const at = "2026-10-10T08:00:00.123456Z";
    await db.query("INSERT INTO operations_execution_audit VALUES ($1,'user',$2,'SourceEnabled','source-1',2,'PRIVATE password=secret',$3)", ["z", "admin-1", at]);
    await db.query("INSERT INTO operations_execution_audit VALUES ($1,'worker','worker-1','bad secret action','run-1',3,'PRIVATE',$2)", ["a", "2026-10-10T08:00:00.123455Z"]);
    await db.query("INSERT INTO operations_event_review_audit VALUES ('e','赛事 体验-1',$1::jsonb,$2)", [JSON.stringify({ actorId: "admin-1", action: "event_published", revision: 7, candidateRevision: 4, reason: "PRIVATE" }), at]);
    await db.query("INSERT INTO operations_resource_review_audit VALUES ('r','resource-1','admin-1',$1::jsonb,$2)", [JSON.stringify({ action: "resource_published", reviewRevision: 5, resourceRevision: 3, reason: "PRIVATE" }), at]);
    await db.query("INSERT INTO operations_resource_review_audit VALUES ('w','resource-2','admin-1',$1::jsonb,$2)", [JSON.stringify({ action: "resource_withdrawn", reviewRevision: null, resourceRevision: 8, reason: "PRIVATE" }), at]);
    await db.query("INSERT INTO operations_correction_transitions VALUES ('c','correction-1',2,'admin-1',$1::jsonb,$2)", [JSON.stringify({ toStatus: "resolved", reason: "PRIVATE" }), at]);
    await db.query("INSERT INTO operations_discovery_control_audit VALUES (1,'scheduler-1','admin-1',2,true,$1)", [at]);
    const tx: SqlExecutor = { async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      const result = await db.query<Row>(statement, [...parameters]); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    } };
    const port = new PostgresAuditQueryPort();
    const rows = await port.readPage(tx, filters, null, 100);
    assert.equal(rows.length, 7); assert.equal(rows[0].id, "resource_review:w");
    assert.equal(rows.find(row => row.id === "resource_review:r")?.revision, 5);
    assert.equal(rows.find(row => row.id === "resource_review:w")?.revision, 8);
    assert.equal(rows.find(row => row.id === "resource_review:r")?.contentVersion, 3);
    assert.equal(rows.find(row => row.stream === "correction")?.action, "correction_resolved");
    assert.equal(rows.at(-1)?.action, "unrecognized");
    assert.equal(rows[0].occurredAt, at); assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|secret|password/);
    const pageOne = await port.readPage(tx, filters, null, 2);
    const boundary = { id: pageOne[1].id, occurredAt: pageOne[1].occurredAt };
    const pageTwo = await port.readPage(tx, filters, boundary, 2);
    assert.ok(pageTwo.every(row => !pageOne.some(first => first.id === row.id)));
    const matching = await port.readPage(tx, { ...filters, actorId: "admin-1", action: "resource_published", objectKind: "resource", objectId: "resource-1", revision: 5, stream: "resource_review" }, null, 2);
    assert.equal(matching.length, 1); assert.equal(matching[0].id, "resource_review:r");
    const unicode = await port.readPage(tx, { ...filters, objectId: "赛事 体验-1" }, null, 2);
    assert.equal(unicode.length, 1); assert.equal(unicode[0].stream, "event_review");
  } finally { await db.close(); }
});
