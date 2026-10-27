import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../../shared/errors.ts";
import type { DatabasePort, SqlExecutor, SqlResult } from "../../../shared/persistence.ts";
import type { AuditEvent, Document, Retrospective } from "../domain.ts";
import { PostgresRetrospectiveRepository } from "../postgres.ts";

interface QueryCall { statement: string; parameters: readonly unknown[]; transaction: number | null }
type Response = (call: QueryCall) => SqlResult<unknown> | Promise<SqlResult<unknown>>;

/** A scripted SqlExecutor: these tests check SQL/transaction contracts, not PostgreSQL. */
class ScriptedDatabase implements DatabasePort {
  readonly calls: QueryCall[] = [];
  readonly committed: QueryCall[] = [];
  readonly executors: SqlExecutor[] = [];
  transactions = 0;
  rollbacks = 0;
  private readonly responses: Response[];
  constructor(responses: Response[] = []) { this.responses = [...responses]; }
  private async run<Row>(statement: string, parameters: readonly unknown[] | undefined, transaction: number | null): Promise<SqlResult<Row>> {
    const call = { statement, parameters: parameters ?? [], transaction };
    this.calls.push(call);
    const response = this.responses.shift();
    assert.ok(response, `Unexpected SQL: ${statement}`);
    return await response(call) as SqlResult<Row>;
  }
  query<Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]): Promise<SqlResult<Row>> {
    return this.run<Row>(statement, parameters, null);
  }
  async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    const id = ++this.transactions;
    const firstCall = this.calls.length;
    const executor: SqlExecutor = { query: <Row>(statement: string, parameters?: readonly unknown[]) => this.run<Row>(statement, parameters, id) };
    this.executors.push(executor);
    try {
      const result = await work(executor);
      this.committed.push(...this.calls.slice(firstCall));
      return result;
    } catch (error) { this.rollbacks++; throw error; }
  }
  done(): void { assert.equal(this.responses.length, 0, "All expected SQL was executed."); }
}
const rowCount = (count = 1): SqlResult<unknown> => ({ rows: [], rowCount: count });
const bodyResult = (document: Document): SqlResult<unknown> => ({ rows: [{ body: document }], rowCount: 1 });
const at = "2026-10-08T08:00:00.000Z";
function document(overrides: Partial<Retrospective> = {}): Retrospective {
  return { kind: "retrospective", id: "ret-1", projectId: "project-1", ownerId: "owner-1", scope: "personal", revision: 1, status: "draft", content: { answers: { goalAndOutcome: "私人正文：完成原型", blockerAndResponse: "保留最小范围", helpfulPractice: "提前集成", scopeReduction: "减掉动画", nextChange: "早做演示" }, evidenceRefs: [], tools: [] }, createdAt: at, updatedAt: at, ...overrides };
}
function event(doc: Document, type: AuditEvent["type"] = "DocumentEdited"): AuditEvent {
  return { id: `audit-${doc.id}-${doc.revision}`, type, aggregateId: doc.id, projectId: doc.projectId, actorId: doc.ownerId, revision: doc.revision, occurredAt: doc.updatedAt };
}
function domainError(code: string, latestRevision?: number): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, code);
    if (code === "VERSION_CONFLICT") {
      assert.equal(error.status, 409);
      assert.equal(error.recoveryAction, "review_latest_version");
      assert.equal(error.latestRevision, latestRevision);
    }
    return true;
  };
}

test("insert commits current document, immutable snapshot and metadata-only audit together", async () => {
  const doc = document({ id: "record' OR 1=1 --" });
  const audit = event(doc);
  const db = new ScriptedDatabase([
    call => {
      assert.match(call.statement, /INSERT INTO m07_documents/);
      assert.match(call.statement, /ON CONFLICT \(id\) DO NOTHING/);
      assert.ok(!call.statement.includes(doc.id));
      assert.deepEqual(call.parameters, [doc.id, doc.kind, doc.projectId, doc.ownerId, doc.scope, 1, at, at, JSON.stringify(doc)]);
      return rowCount();
    },
    call => {
      assert.match(call.statement, /^INSERT INTO m07_document_versions/);
      assert.doesNotMatch(call.statement, /ON CONFLICT|UPDATE/);
      assert.deepEqual(call.parameters, [doc.id, 1, JSON.stringify(doc), at]);
      return rowCount();
    },
    call => {
      assert.match(call.statement, /INSERT INTO m07_audit_events/);
      assert.doesNotMatch(call.statement, /\bbody\b|\bpayload\b/);
      assert.deepEqual(call.parameters, [audit.id, audit.type, doc.id, doc.projectId, doc.ownerId, 1, at]);
      assert.ok(!JSON.stringify(call.parameters).includes("私人正文"));
      return rowCount();
    },
  ]);
  await new PostgresRetrospectiveRepository(db).insert(doc, audit);
  assert.equal(db.transactions, 1);
  assert.equal(db.committed.length, 3);
  assert.ok(db.calls.every(call => call.transaction === 1));
  db.done();
});

test("replace locks the current row, applies CAS, and appends a new history version", async () => {
  const previous = document();
  const next = document({ revision: 2, scope: "project", updatedAt: "2026-10-08T08:01:00.000Z" });
  const db = new ScriptedDatabase([
    call => { assert.match(call.statement, /WHERE id = \$1 FOR UPDATE$/); return bodyResult(previous); },
    call => {
      assert.match(call.statement, /UPDATE m07_documents/);
      assert.match(call.statement, /WHERE id = \$1 AND revision = \$2 RETURNING id/);
      assert.deepEqual(call.parameters, [next.id, 1, "project", 2, next.updatedAt, JSON.stringify(next)]);
      return rowCount();
    },
    call => { assert.match(call.statement, /^INSERT INTO m07_document_versions/); assert.equal(call.parameters[1], 2); return rowCount(); },
    call => { assert.match(call.statement, /INSERT INTO m07_audit_events/); assert.equal(call.parameters[5], 2); return rowCount(); },
  ]);
  await new PostgresRetrospectiveRepository(db).replace(next, 1, event(next));
  assert.equal(db.transactions, 1);
  assert.equal(db.committed.length, 4);
  db.done();
});

test("a stale update reports the latest revision without writing or replacing history", async () => {
  const latest = document({ revision: 3 });
  const next = document({ revision: 2 });
  const db = new ScriptedDatabase([() => bodyResult(latest)]);
  await assert.rejects(new PostgresRetrospectiveRepository(db).replace(next, 1, event(next)), domainError("VERSION_CONFLICT", 3));
  assert.equal(db.committed.length, 0);
  assert.equal(db.rollbacks, 1);
  assert.equal(db.calls.length, 1);
  db.done();
});

test("a failed CAS detects a concurrent revision before producing any snapshot", async () => {
  const next = document({ revision: 2 });
  const db = new ScriptedDatabase([() => bodyResult(document()), () => rowCount(0), () => bodyResult(document({ revision: 4 }))]);
  await assert.rejects(new PostgresRetrospectiveRepository(db).replace(next, 1, event(next)), domainError("VERSION_CONFLICT", 4));
  assert.equal(db.committed.length, 0);
  assert.ok(!db.calls.some(call => call.statement.startsWith("INSERT INTO")));
  db.done();
});

test("duplicate document ids report conflict and leave existing history alone", async () => {
  const doc = document();
  const db = new ScriptedDatabase([() => rowCount(0), () => bodyResult(document({ revision: 5 }))]);
  await assert.rejects(new PostgresRetrospectiveRepository(db).insert(doc, event(doc)), domainError("VERSION_CONFLICT", 5));
  assert.equal(db.committed.length, 0);
  db.done();
});

test("snapshot and audit errors roll back the current-row write", async t => {
  for (const failingTable of ["m07_document_versions", "m07_audit_events"]) {
    await t.test(failingTable, async () => {
      const failure = new Error("simulated database constraint failure");
      const responses: Response[] = [() => rowCount()];
      if (failingTable === "m07_audit_events") responses.push(() => rowCount());
      responses.push(call => { assert.ok(call.statement.includes(failingTable)); throw failure; });
      const db = new ScriptedDatabase(responses);
      const doc = document();
      await assert.rejects(new PostgresRetrospectiveRepository(db).insert(doc, event(doc)), error => error === failure);
      assert.equal(db.rollbacks, 1);
      assert.equal(db.committed.length, 0);
      db.done();
    });
  }
});

test("final fact reads and multi-document writes use the exact supplied executor without nested transactions", async () => {
  const first = document();
  const second = document({ id: "ret-2" });
  const db = new ScriptedDatabase(Array.from({ length: 7 }, () => () => rowCount()));
  const result = await new PostgresRetrospectiveRepository(db).transaction(async tx => {
    assert.equal(tx.sql, db.executors[0]);
    await tx.sql!.query("SELECT final_facts_test_fixture");
    await tx.insert(first, event(first));
    await tx.insert(second, event(second));
    return "saved";
  });
  assert.equal(result, "saved");
  assert.equal(db.transactions, 1);
  assert.ok(db.calls.every(call => call.transaction === 1));
  db.done();
});

test("replace rejects skipped revisions, mismatched audit, and changes to immutable identity", async () => {
  for (const [next, expected, db] of [
    [document({ revision: 3 }), 1, new ScriptedDatabase()],
    [document({ revision: 2, ownerId: "owner-2" }), 1, new ScriptedDatabase([() => bodyResult(document())])],
    [document({ revision: 2, projectId: "project-2" }), 1, new ScriptedDatabase([() => bodyResult(document())])],
  ] as const) {
    await assert.rejects(new PostgresRetrospectiveRepository(db).replace(next, expected, event(next)), domainError("INVALID_INPUT"));
    assert.equal(db.committed.length, 0);
    db.done();
  }
  const next = document({ revision: 2 });
  const db = new ScriptedDatabase();
  await assert.rejects(new PostgresRetrospectiveRepository(db).replace(next, 1, { ...event(next), aggregateId: "wrong-record" }), domainError("INVALID_INPUT"));
  assert.equal(db.calls.length, 0);
});

test("personal deletion constrains owner, scope, kind and revision and emits no private body", async () => {
  const doc = document();
  const db = new ScriptedDatabase([
    call => {
      assert.match(call.statement, /owner_id = \$2 AND scope = 'personal'/);
      assert.match(call.statement, /kind IN \('retrospective', 'experience_card', 'reuse_draft'\) FOR UPDATE/);
      assert.deepEqual(call.parameters, [doc.id, doc.ownerId]);
      return bodyResult(doc);
    },
    call => {
      assert.match(call.statement, /^DELETE FROM m07_documents/);
      assert.match(call.statement, /owner_id = \$2 AND scope = 'personal'/);
      assert.match(call.statement, /kind IN \('retrospective', 'experience_card', 'reuse_draft'\) AND revision = \$3 RETURNING id/);
      assert.deepEqual(call.parameters, [doc.id, doc.ownerId, 1]);
      return rowCount();
    },
    call => { assert.match(call.statement, /INSERT INTO m07_audit_events/); assert.ok(!JSON.stringify(call.parameters).includes("私人正文")); return rowCount(); },
  ]);
  await new PostgresRetrospectiveRepository(db).deletePersonal(doc.id, doc.ownerId, 1, event(doc, "PersonalDocumentDeleted"));
  assert.equal(db.transactions, 1);
  assert.equal(db.committed.length, 3);
  db.done();
});

test("foreign, shared, unsupported or missing deletion targets reveal no version and write nothing", async () => {
  const db = new ScriptedDatabase([() => rowCount(0)]);
  const doc = document();
  await assert.rejects(new PostgresRetrospectiveRepository(db).deletePersonal(doc.id, "someone-else", 1, event(doc, "PersonalDocumentDeleted")), domainError("NOT_FOUND"));
  assert.equal(db.calls.length, 1);
  assert.equal(db.committed.length, 0);
  db.done();
});

test("stale personal deletion reports conflict and leaves all rows untouched", async () => {
  const doc = document({ revision: 2 });
  const db = new ScriptedDatabase([() => bodyResult(doc)]);
  await assert.rejects(new PostgresRetrospectiveRepository(db).deletePersonal(doc.id, doc.ownerId, 1, event(doc, "PersonalDocumentDeleted")), domainError("VERSION_CONFLICT", 2));
  assert.equal(db.calls.length, 1);
  assert.equal(db.committed.length, 0);
  db.done();
});

test("deletion cannot forge a different actor or a non-deletion audit event", async () => {
  const doc = document();
  for (const audit of [event(doc), { ...event(doc, "PersonalDocumentDeleted"), actorId: "other-person" }]) {
    const db = new ScriptedDatabase([() => bodyResult(doc)]);
    await assert.rejects(new PostgresRetrospectiveRepository(db).deletePersonal(doc.id, doc.ownerId, 1, audit), domainError("INVALID_INPUT"));
    assert.equal(db.calls.length, 1);
    db.done();
  }
});

test("lists parameterize all input and include only own personal or requested shared project rows", async () => {
  const doc = document();
  const malicious = "owner' OR TRUE --";
  const db = new ScriptedDatabase([
    call => {
      assert.match(call.statement, /scope = 'personal' AND owner_id = \$1/);
      assert.match(call.statement, /\$2::text IS NOT NULL AND scope = 'project' AND project_id = \$2/);
      assert.match(call.statement, /AND \(\$2::text IS NULL OR project_id = \$2\)/);
      assert.match(call.statement, /ORDER BY id COLLATE "C" ASC LIMIT \$5/);
      assert.deepEqual(call.parameters, [malicious, "project-1", "retrospective", "after' --", 20]);
      assert.ok(!call.statement.includes(malicious));
      return bodyResult(doc);
    },
    call => { assert.deepEqual(call.parameters, ["owner-1", null, "retrospective", null, 10]); return rowCount(0); },
  ]);
  const repository = new PostgresRetrospectiveRepository(db);
  assert.deepEqual(await repository.list({ ownerId: malicious, projectId: "project-1", kind: "retrospective", limit: 20, afterId: "after' --" }), [doc]);
  assert.deepEqual(await repository.list({ ownerId: "owner-1", kind: "retrospective", limit: 10 }), []);
  assert.equal(db.transactions, 0);
  db.done();
});

test("list bounds and kind are validated before executing SQL", async () => {
  const db = new ScriptedDatabase();
  const repository = new PostgresRetrospectiveRepository(db);
  const base = { ownerId: "owner-1", kind: "retrospective" as const, limit: 20 };
  for (const input of [
    { ...base, limit: 0 }, { ...base, limit: 102 }, { ...base, limit: 1.5 },
    { ...base, limit: Number.NaN }, { ...base, ownerId: "" },
    { ...base, projectId: "" }, { ...base, afterId: "" },
    { ...base, kind: "unsupported" as Document["kind"] },
  ]) await assert.rejects(repository.list(input), domainError("INVALID_INPUT"));
  assert.equal(db.calls.length, 0);
});

test("list permits the 101st internal row used to detect a next page", async () => {
  const db = new ScriptedDatabase([call => { assert.equal(call.parameters[4], 101); return rowCount(0); }]);
  assert.deepEqual(await new PostgresRetrospectiveRepository(db).list({ ownerId: "owner-1", projectId: "project-1", kind: "retrospective", limit: 101 }), []);
  db.done();
});

test("account personalOnly query cannot include requested project's shared records", async () => {
  const db = new ScriptedDatabase([call => {
    assert.match(call.statement, /AND \(scope = 'personal' AND owner_id = \$1\)/);
    assert.doesNotMatch(call.statement, /scope = 'project'/);
    assert.deepEqual(call.parameters, ["owner-1", "former-project", "experience_card", null, 20]);
    return rowCount(0);
  }]);
  assert.deepEqual(await new PostgresRetrospectiveRepository(db).list({ ownerId: "owner-1", projectId: "former-project", kind: "experience_card", limit: 20, personalOnly: true }), []);
  db.done();
});

test("read and historical read preserve the stored version and return isolated objects", async () => {
  const doc = document();
  const db = new ScriptedDatabase([
    call => { assert.doesNotMatch(call.statement, /FOR UPDATE/); assert.deepEqual(call.parameters, [doc.id]); return bodyResult(doc); },
    call => { assert.match(call.statement, /m07_document_versions WHERE document_id = \$1 AND revision = \$2/); assert.deepEqual(call.parameters, [doc.id, 1]); return { rows: [{ body: JSON.stringify(doc) }], rowCount: 1 }; },
    () => rowCount(0),
  ]);
  const repository = new PostgresRetrospectiveRepository(db);
  const read = await repository.get(doc.id);
  assert.deepEqual(read, doc);
  assert.notEqual(read, doc);
  assert.deepEqual(await repository.getVersion(doc.id, 1), doc);
  assert.equal(await repository.get("missing"), null);
  assert.equal(db.transactions, 0);
  db.done();
});
