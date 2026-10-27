import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabasePort, SqlExecutor } from "../../../shared/persistence.ts";
import type { GitOperation } from "../types.ts";
import { PostgresDraftStore, PostgresGitRepositoryStore } from "../git-postgres.ts";

test("expiry cleanup advances both CAS revisions so a stale preview cannot restore deleted text", async () => {
  const stale = { id: "op", projectId: "project", actorId: "user", inputHash: "digest", revision: 4, preview: { files: [{ before: "private-old", after: "private-new" }] } } as unknown as GitOperation;
  let currentRevision = stale.revision;
  let payloadRevision = stale.revision;
  let contents: string | null = "private-new";
  const calls: { statement: string; parameters: readonly unknown[] }[] = [];
  const db: DatabasePort = {
    async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      calls.push({ statement, parameters });
      if (statement.startsWith("DELETE FROM github_file_drafts")) return { rows: [] as Row[], rowCount: 1 };
      if (statement.startsWith("UPDATE github_operations SET revision=revision+1")) {
        assert.match(statement, /'\{revision\}',to_jsonb\(revision\+1\)/);
        assert.match(statement, /'\{updatedAt\}'/);
        assert.match(statement, /before\\?":null/);
        currentRevision++; payloadRevision++; contents = null; return { rows: [] as Row[], rowCount: 1 };
      }
      if (statement.startsWith("UPDATE github_operations SET revision=$4")) return { rows: [] as Row[], rowCount: parameters[2] === currentRevision ? 1 : 0 };
      throw new Error("unexpected query");
    }, async transaction<T>(work: (sql: SqlExecutor) => Promise<T>) { return work(db); },
  };
  assert.equal(await new PostgresDraftStore(db).purgeExpired("2026-10-09T00:00:00.000Z"), 1);
  await assert.rejects(new PostgresGitRepositoryStore(db).updateOperation({ ...stale, revision: 5 }, 4), { code: "VERSION_CONFLICT" });
  assert.equal(currentRevision, 5); assert.equal(payloadRevision, 5); assert.equal(contents, null);
  assert.ok(calls.every(call => !call.statement.includes("private-new")));
});

test("idempotency lookups are scoped to project and actor using bound parameters", async () => {
  let captured: { statement: string; parameters: readonly unknown[] } | null = null;
  const db: DatabasePort = {
    async query<Row>(statement: string, parameters: readonly unknown[] = []) { captured = { statement, parameters }; return { rows: [] as Row[], rowCount: 0 }; },
    async transaction<T>(work: (sql: SqlExecutor) => Promise<T>) { return work(db); },
  };
  assert.equal(await new PostgresGitRepositoryStore(db).findOperationByKey("project'private", "user'private", "key-1"), null);
  assert.deepEqual(captured!.parameters, ["project'private", "user'private", "key-1"]);
  assert.match(captured!.statement, /project_id=\$1 AND actor_id=\$2 AND idempotency_key=\$3/);
  assert.doesNotMatch(captured!.statement, /private/);
});

test("draft quota is checked under a project transaction lock before any insertion", async () => {
  const statements: string[] = [];
  const db: DatabasePort = {
    async query<Row>(statement: string) {
      statements.push(statement);
      return statement.startsWith("SELECT count") ? { rows: [{ count: "40", bytes: "0" }] as Row[], rowCount: 1 } : { rows: [] as Row[], rowCount: 1 };
    }, async transaction<T>(work: (sql: SqlExecutor) => Promise<T>) { return work(db); },
  };
  await assert.rejects(new PostgresDraftStore(db).put({ projectId: "project", actorId: "user", changes: [{ path: "a.txt", action: "upsert", content: "a" }], expiresAt: "2026-10-09T00:00:00.000Z" }), { code: "DRAFT_QUOTA_EXCEEDED" });
  assert.match(statements[0]!, /pg_advisory_xact_lock/); assert.equal(statements.some(statement => statement.startsWith("INSERT")), false);
});
