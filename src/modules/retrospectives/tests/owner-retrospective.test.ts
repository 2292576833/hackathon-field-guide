import test from "node:test";
import assert from "node:assert/strict";
import { PostgresOwnerRetrospectivePort } from "../owner-retrospective.ts";
import type { SqlExecutor } from "../../../shared/persistence.ts";
import { alice } from "./fixtures.ts";

test("bound draft identity locks through the supplied transaction and never reads document body", async () => {
  const database: SqlExecutor = { async query() { throw new Error("wrong connection"); } };
  const transaction: SqlExecutor = { async query<Row>(statement: string, parameters?: readonly unknown[]) {
    assert.match(statement, /SELECT id, project_id, owner_id, revision/); assert.match(statement, /FOR UPDATE/);
    assert.doesNotMatch(statement, /\bbody\b|project_members|evidence/); assert.deepEqual(parameters, ["r1", "alice", "p1"]);
    return { rows: [{ id: "r1", owner_id: "alice", project_id: "p1", revision: "3" }] as Row[], rowCount: 1 };
  } };
  assert.deepEqual(await new PostgresOwnerRetrospectivePort(database).readIdentity({ actor: alice, projectId: "p1", documentId: "r1" }, transaction), { id: "r1", ownerId: "alice", projectId: "p1", revision: 3 });
});

test("identity lookup returns null for absent ownership and fails closed on wrong-owner rows", async () => {
  const none: SqlExecutor = { async query() { return { rows: [], rowCount: 0 }; } };
  assert.equal(await new PostgresOwnerRetrospectivePort(none).readIdentity({ actor: alice, projectId: "p1", documentId: "r1" }), null);
  const invalid: SqlExecutor = { async query<Row>() { return { rows: [{ id: "r1", owner_id: "bob", project_id: "p1", revision: 1 }] as Row[], rowCount: 1 }; } };
  await assert.rejects(new PostgresOwnerRetrospectivePort(invalid).readIdentity({ actor: alice, projectId: "p1", documentId: "r1" }), { code: "FINAL_FACTS_INVALID" });
});
