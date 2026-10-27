import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Actor, ProjectMembershipAccess } from "../../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../../shared/persistence.ts";
import { DomainError } from "../../../shared/errors.ts";
import type { FinalFactsLockRequest, FinalFactsSnapshot, RetrospectiveContent } from "../domain.ts";
import { RetrospectiveEditDraftService } from "../edit-drafts.ts";
import type { EditDraftDependencies, EditDraftSaveInput, OwnerRetrospectiveIdentity } from "../edit-drafts.ts";
import { PostgresRetrospectiveEditDraftRepository } from "../edit-drafts-postgres.ts";

const alice: Actor = { userId: "alice", platformRoles: ["user"] };
const bob: Actor = { userId: "bob", platformRoles: ["admin"] };
const emptyContent: RetrospectiveContent = {
  answers: { goalAndOutcome: "", blockerAndResponse: "  ", helpfulPractice: "\n", scopeReduction: "", nextChange: "" },
  evidenceRefs: [], tools: [],
};
function input(overrides: Partial<EditDraftSaveInput> = {}): EditDraftSaveInput {
  return { documentId: null, baseDocumentRevision: 0, expectedRevision: 0, mutationId: "request-1", requestedScope: "personal", draftContent: structuredClone(emptyContent), ...overrides };
}
function hasCode(code: string, latestRevision?: number) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof DomainError); assert.equal(error.code, code);
    if (latestRevision !== undefined) assert.equal(error.latestRevision, latestRevision);
    return true;
  };
}

/** Disposable, memory-only SQL fixture. This never reads .env or the production
 * embedded directory, and does not establish multi-connection PostgreSQL locks. */
async function fixture(t: TestContext) {
  const engine = new PGlite(); t.after(() => engine.close()); await engine.waitReady;
  await engine.exec(await readFile(new URL("../migrations/002_edit_drafts.sql", import.meta.url), "utf8"));
  const memberships = new Map<string, ProjectMembershipAccess>();
  for (const projectId of ["p1", "p2"]) for (const actor of [alice, bob]) memberships.set(`${projectId}:${actor.userId}`, { membershipId: `${projectId}-${actor.userId}`, projectId, userId: actor.userId, status: "active", role: actor === bob ? "manager" : "member" });
  const archived = new Set<string>(), identities = new Map<string, OwnerRetrospectiveIdentity>();
  const trace: string[] = [], requests: FinalFactsLockRequest[] = [];
  let counter = 0, activeSql: SqlExecutor | undefined, failurePattern: RegExp | undefined, beforeTransaction: (() => void) | undefined;
  const counts = { ordinaryMembership: 0, ordinaryArchive: 0, ownerReads: 0, finalLocks: 0 };
  const executor = (source: Pick<PGlite, "query">): SqlExecutor => ({
    async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      trace.push(statement);
      if (failurePattern?.test(statement)) { failurePattern = undefined; throw new Error("Simulated SQL write failure."); }
      const result = await source.query<Row>(statement, [...parameters]);
      return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0 };
    },
  });
  const database: DatabasePort = {
    ...executor(engine),
    transaction: work => engine.transaction(async transaction => {
      const sql = executor(transaction as unknown as Pick<PGlite, "query">); activeSql = sql;
      try { const change = beforeTransaction; beforeTransaction = undefined; change?.(); return await work(sql); }
      finally { activeSql = undefined; }
    }),
  };
  const dependencies: EditDraftDependencies = {
    repository: new PostgresRetrospectiveEditDraftRepository(database),
    access: { async getMembership(projectId, userId) { assert.equal(activeSql, undefined, "Final write must use its locked membership snapshot."); counts.ordinaryMembership++; return structuredClone(memberships.get(`${projectId}:${userId}`) ?? null); } },
    projects: { async isArchived(projectId) { assert.equal(activeSql, undefined, "Final write must use its locked archive snapshot."); counts.ordinaryArchive++; return archived.has(projectId); } },
    ownerRetrospectives: { async readIdentity({ actor, projectId, documentId }, sql) {
      counts.ownerReads++; assert.equal(sql, activeSql); assert.ok(sql, "Bound formal identity reads share the exact write executor.");
      trace.push("owner-identity-lock");
      const identity = identities.get(documentId);
      return identity && identity.ownerId === actor.userId && identity.projectId === projectId ? structuredClone(identity) : null;
    } },
    finalFactsLock: { async lock(request, sql): Promise<FinalFactsSnapshot> {
      assert.equal(sql, activeSql); assert.ok(sql); counts.finalLocks++; requests.push(structuredClone(request)); trace.push("final-facts-lock");
      assert.equal(request.operation, "retrospective.update"); assert.deepEqual(request.evidence, []); assert.deepEqual(request.resourceIds, []);
      return { projects: request.projectIds.map(projectId => ({ projectId, membership: structuredClone(memberships.get(`${projectId}:${request.actor.userId}`) ?? null), archived: archived.has(projectId) })), evidence: [], reviewedResourceIds: [] };
    } },
    clock: { now: () => new Date("2026-10-10T06:00:00.000Z") },
    ids: { next: () => `draft-${String(++counter).padStart(4, "0")}` },
  };
  return {
    engine, database, dependencies, service: new RetrospectiveEditDraftService(dependencies), memberships, archived, identities, trace, requests, counts,
    beforeNextTransaction(change: () => void) { beforeTransaction = change; },
    failNextQuery(pattern: RegExp) { failurePattern = pattern; },
  };
}

test("autosave persists incomplete verbatim owner input without creating, publishing or generating formal records", async t => {
  const f = await fixture(t);
  const raw = input({ requestedScope: "project", draftContent: { ...structuredClone(emptyContent), answers: { ...emptyContent.answers, nextChange: "  保留原文\n下一行  " }, evidenceRefs: [{ kind: "task", id: "not-expanded", revision: 7 }], tools: [{ originalUrl: "https://example.test/tool", usedFor: "", limitations: "  ", costAtUse: "", source: "member_record" }] } });
  const before = structuredClone(raw);
  const result = await f.service.save(alice, "p1", raw);
  assert.deepEqual(raw, before); assert.deepEqual(result.draft.draftContent, raw.draftContent);
  assert.equal(result.draft.visibility, "personal"); assert.equal(result.draft.requestedScope, "project");
  assert.equal(result.draft.revision, 1); assert.equal(result.acceptedRevision, 1); assert.equal(result.replayed, false);
  assert.equal((await f.service.get(alice, "p1"))?.id, result.draft.id);
  assert.equal(f.counts.ownerReads, 0);
  assert.ok(f.trace.every(statement => !/m07_documents|m07_document_versions|m07_audit_events|submission|delivery_verification|generation_job/.test(statement)), "Only the isolated editing buffer and mutation receipts may be written.");
  await assert.rejects(f.service.getById(bob, result.draft.id), hasCode("NOT_FOUND"));
  assert.deepEqual((await f.service.list(bob)).items, []);
});

test("draft keys isolate owners, projects and a bound formal retrospective", async t => {
  const f = await fixture(t);
  f.identities.set("formal-1", { id: "formal-1", projectId: "p1", ownerId: "alice", revision: 3 });
  const a = await f.service.save(alice, "p1", input());
  const b = await f.service.save(bob, "p1", input());
  const other = await f.service.save(alice, "p2", input({ mutationId: "request-p2" }));
  const bound = await f.service.save(alice, "p1", input({ mutationId: "request-bound", documentId: "formal-1", baseDocumentRevision: 3 }));
  assert.equal(new Set([a.draft.id, b.draft.id, other.draft.id, bound.draft.id]).size, 4);
  assert.equal((await f.service.get(alice, "p1", "formal-1"))?.id, bound.draft.id);
  assert.equal((await f.service.list(alice, { projectId: "p1" })).items.length, 2);
  assert.deepEqual((await f.service.list(bob)).items.map(row => row.id), [b.draft.id]);
  const lock = f.trace.lastIndexOf("final-facts-lock"), owner = f.trace.lastIndexOf("owner-identity-lock");
  assert.ok(lock < owner); assert.ok(owner < f.trace.findIndex((statement, index) => index > owner && /mutation|draft_keys/.test(statement)));
});

test("CAS rejects a stale tab and same key recovers a lost response without reverting newer content", async t => {
  const f = await fixture(t), first = input();
  const saved = await f.service.save(alice, "p1", first);
  const next = input({ mutationId: "request-2", expectedRevision: 1, draftContent: { ...structuredClone(emptyContent), answers: { ...emptyContent.answers, nextChange: "较新输入" } } });
  const updated = await f.service.save(alice, "p1", next);
  assert.equal(updated.draft.revision, 2);
  const replay = await f.service.save(alice, "p1", first);
  assert.equal(replay.replayed, true); assert.equal(replay.acceptedRevision, 1); assert.equal(replay.draft.revision, 2);
  assert.equal(replay.draft.draftContent.answers.nextChange, "较新输入");
  const stale = input({ expectedRevision: saved.draft.revision, mutationId: "stale-tab", draftContent: { ...structuredClone(emptyContent), answers: { ...emptyContent.answers, nextChange: "不覆盖的新输入" } } });
  const original = structuredClone(stale);
  await assert.rejects(f.service.save(alice, "p1", stale), hasCode("VERSION_CONFLICT", 2));
  assert.deepEqual(stale, original); assert.equal((await f.service.get(alice, "p1"))?.draftContent.answers.nextChange, "较新输入");
  await assert.rejects(f.service.save(alice, "p1", { ...first, requestedScope: "project" }), hasCode("IDEMPOTENCY_CONFLICT"));
  assert.equal((await f.service.get(alice, "p1"))?.revision, 2);
});

test("simultaneous first saves accept one tab and rejected request does not consume its mutation key", async t => {
  const f = await fixture(t), requestA = input({ mutationId: "tab-a" }), requestB = input({ mutationId: "tab-b" });
  const results = await Promise.allSettled([f.service.save(alice, "p1", requestA), f.service.save(alice, "p1", requestB)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const loser = results.findIndex(result => result.status === "rejected");
  const rejected = results[loser] as PromiseRejectedResult; hasCode("VERSION_CONFLICT", 1)(rejected.reason);
  const retry = await f.service.save(alice, "p1", { ...(loser === 0 ? requestA : requestB), expectedRevision: 1 });
  assert.equal(retry.replayed, false); assert.equal(retry.acceptedRevision, 2);
});

test("former owners retain own read, list, export and deletion without opening current project or formal facts", async t => {
  const f = await fixture(t);
  const saved = await f.service.save(alice, "p1", input({ requestedScope: "project", draftContent: { ...structuredClone(emptyContent), evidenceRefs: [{ kind: "submission", id: "ref-1", revision: 2 }] } }));
  f.memberships.delete("p1:alice"); f.archived.add("p1");
  const before = structuredClone(f.counts);
  assert.equal((await f.service.get(alice, "p1"))?.id, saved.draft.id);
  assert.equal((await f.service.getById(alice, saved.draft.id)).ownerId, "alice");
  assert.equal((await f.service.list(alice, { projectId: "p1" })).items[0].id, saved.draft.id);
  for (const format of ["json", "markdown"] as const) assert.match((await f.service.exportDraft(alice, saved.draft.id, format)).content, /尚未正式保存|本人复盘编辑草稿/);
  await assert.rejects(f.service.exportDraft(bob, saved.draft.id, "json"), hasCode("NOT_FOUND"));
  await assert.rejects(f.service.delete(bob, saved.draft.id, 1), hasCode("NOT_FOUND"));
  await f.service.delete(alice, saved.draft.id, 1);
  assert.equal(await f.service.get(alice, "p1"), null); assert.deepEqual(f.counts, before);
  await assert.rejects(f.service.save(alice, "p1", input({ expectedRevision: 1, mutationId: "left-write" })), hasCode("FORBIDDEN"));
});

test("revocation and archive committed after precheck block final write through the same transaction", async t => {
  const f = await fixture(t);
  const original = await f.service.save(alice, "p1", input());
  f.beforeNextTransaction(() => { f.memberships.set("p1:alice", { ...f.memberships.get("p1:alice")!, status: "removed" }); });
  await assert.rejects(f.service.save(alice, "p1", input({ expectedRevision: 1, mutationId: "revoked" })), hasCode("FORBIDDEN"));
  assert.deepEqual(await f.service.getById(alice, original.draft.id), original.draft);
  f.memberships.set("p1:alice", { ...f.memberships.get("p1:alice")!, status: "active" });
  f.beforeNextTransaction(() => { f.archived.add("p1"); });
  await assert.rejects(f.service.save(alice, "p1", input({ expectedRevision: 1, mutationId: "archived" })), hasCode("PROJECT_ARCHIVED"));
  assert.deepEqual(await f.service.getById(alice, original.draft.id), original.draft);
  assert.equal(f.counts.finalLocks, 3);
});

test("bound drafts require actor-owned current formal identity and never overwrite changed teammate or formal content", async t => {
  const f = await fixture(t);
  f.identities.set("formal-1", { id: "formal-1", projectId: "p1", ownerId: "alice", revision: 1 });
  const bound = input({ documentId: "formal-1", baseDocumentRevision: 1 });
  const first = await f.service.save(alice, "p1", bound);
  f.identities.set("formal-1", { id: "formal-1", projectId: "p1", ownerId: "alice", revision: 2 });
  await assert.rejects(f.service.save(alice, "p1", { ...bound, expectedRevision: 1, mutationId: "changed-formal" }), hasCode("DOCUMENT_CHANGED", 2));
  f.identities.set("teammate-formal", { id: "teammate-formal", projectId: "p1", ownerId: "bob", revision: 1 });
  await assert.rejects(f.service.save(alice, "p1", input({ documentId: "teammate-formal", baseDocumentRevision: 1, mutationId: "teammate" })), hasCode("NOT_FOUND"));
  await assert.rejects(f.service.save(alice, "p2", { ...bound, mutationId: "wrong-project" }), hasCode("NOT_FOUND"));
  assert.deepEqual(await f.service.getById(alice, first.draft.id), first.draft);
  assert.equal(f.identities.get("formal-1")?.revision, 2);
});

test("an accepted bound save retry recovers own text after a later formal edit without permitting a new stale-base write", async t => {
  const f = await fixture(t);
  f.identities.set("retro-own", { id: "retro-own", ownerId: alice.userId, projectId: "p1", revision: 3 });
  const request = input({ documentId: "retro-own", baseDocumentRevision: 3 });
  const first = await f.service.save(alice, "p1", request);
  f.identities.set("retro-own", { id: "retro-own", ownerId: alice.userId, projectId: "p1", revision: 4 });
  const recovered = await f.service.save(alice, "p1", request);
  assert.equal(recovered.replayed, true); assert.equal(recovered.acceptedRevision, 1);
  assert.deepEqual(recovered.draft, first.draft);
  await assert.rejects(f.service.save(alice, "p1", { ...request, expectedRevision: 1, mutationId: "new-stale-write" }), hasCode("DOCUMENT_CHANGED", 4));
  assert.deepEqual(await f.service.getById(alice, first.draft.id), first.draft);
});

test("write failure rolls back draft and mutation receipt while caller input remains retryable", async t => {
  const f = await fixture(t);
  const first = await f.service.save(alice, "p1", input());
  const pending = input({ expectedRevision: 1, mutationId: "failed-save", draftContent: { ...structuredClone(emptyContent), answers: { ...emptyContent.answers, nextChange: "失败时继续保留这段输入" } } });
  const before = structuredClone(pending);
  f.failNextQuery(/UPDATE .*mutation/i);
  await assert.rejects(f.service.save(alice, "p1", pending), /Simulated SQL write failure/);
  assert.deepEqual(pending, before); assert.deepEqual(await f.service.getById(alice, first.draft.id), first.draft);
  const retry = await f.service.save(alice, "p1", pending);
  assert.equal(retry.replayed, false); assert.equal(retry.acceptedRevision, 2); assert.equal(retry.draft.draftContent.answers.nextChange, pending.draftContent.answers.nextChange);
});

test("export is allowlisted, redacts recognizable secrets and contacts, and leaves raw persistence intact", async t => {
  const f = await fixture(t);
  const text = "API_KEY=secret-value Bearer abcdefghijklmnop alice@example.com 13812345678 C:\\Users\\alice\\private <script>alert(1)</script>";
  const saved = await f.service.save(alice, "p1", input({ draftContent: { ...structuredClone(emptyContent), answers: { ...emptyContent.answers, nextChange: text } } }));
  for (const format of ["json", "markdown"] as const) {
    const file = await f.service.exportDraft(alice, saved.draft.id, format);
    assert.doesNotMatch(file.content, /secret-value|abcdefghijklmnop|alice@example\.com|13812345678|C:\\\\Users|ownerId|mutationId|payloadHash|platformRoles|generatedDraft|inputSnapshot/);
    if (format === "markdown") assert.doesNotMatch(file.content, /<script>/);
  }
  assert.equal((await f.service.getById(alice, saved.draft.id)).draftContent.answers.nextChange, text);
});

test("deletion uses CAS and a repeated save cannot revive a deliberately deleted draft", async t => {
  const f = await fixture(t), request = input();
  const saved = await f.service.save(alice, "p1", request);
  await f.service.save(alice, "p1", input({ expectedRevision: 1, mutationId: "second" }));
  await assert.rejects(f.service.delete(alice, saved.draft.id, 1), hasCode("VERSION_CONFLICT", 2));
  assert.equal((await f.service.getById(alice, saved.draft.id)).revision, 2);
  await f.service.delete(alice, saved.draft.id, 2);
  await assert.rejects(f.service.save(alice, "p1", request), hasCode("DRAFT_DELETED"));
  assert.equal(await f.service.get(alice, "p1"), null);
  const next = await f.service.save(alice, "p1", input({ mutationId: "intentional-recreate" }));
  assert.notEqual(next.draft.id, saved.draft.id); assert.equal(next.draft.revision, 1);
});

test("SQL-backed autosave fails closed without a final lock or with incomplete locked project facts", async t => {
  const f = await fixture(t);
  const original = f.dependencies.finalFactsLock;
  f.dependencies.finalFactsLock = undefined;
  await assert.rejects(f.service.save(alice, "p1", input()), hasCode("FINAL_FACTS_LOCK_REQUIRED"));
  assert.equal(await f.service.get(alice, "p1"), null);
  f.dependencies.finalFactsLock = { async lock() { return { projects: [], evidence: [], reviewedResourceIds: [] }; } };
  await assert.rejects(f.service.save(alice, "p1", input()), hasCode("FINAL_FACTS_INVALID"));
  assert.equal(await f.service.get(alice, "p1"), null);
  f.dependencies.finalFactsLock = original;
  assert.equal((await f.service.save(alice, "p1", input())).acceptedRevision, 1);
});

test("invalid final snapshots cannot authorize autosave or consume a mutation key", async t => {
  const f = await fixture(t), original = f.dependencies.finalFactsLock!;
  const goodProject = { projectId: "p1", membership: f.memberships.get("p1:alice")!, archived: false };
  const snapshots: unknown[] = [
    null,
    { projects: [], evidence: [], reviewedResourceIds: [] },
    { projects: [goodProject, goodProject], evidence: [], reviewedResourceIds: [] },
    { projects: [{ ...goodProject, projectId: "p2" }], evidence: [], reviewedResourceIds: [] },
    { projects: [{ ...goodProject, archived: "false" }], evidence: [], reviewedResourceIds: [] },
    { projects: [{ ...goodProject, membership: { ...goodProject.membership, userId: "bob" } }], evidence: [], reviewedResourceIds: [] },
    { projects: [{ ...goodProject, membership: { ...goodProject.membership, projectId: "p2" } }], evidence: [], reviewedResourceIds: [] },
    { projects: [{ ...goodProject, membership: { ...goodProject.membership, role: "captain" } }], evidence: [], reviewedResourceIds: [] },
  ];
  for (const snapshot of snapshots) {
    f.dependencies.finalFactsLock = { async lock() { return snapshot as FinalFactsSnapshot; } };
    await assert.rejects(f.service.save(alice, "p1", input()), hasCode("FINAL_FACTS_INVALID"));
    assert.equal(await f.service.get(alice, "p1"), null);
  }
  f.dependencies.finalFactsLock = original;
  assert.equal((await f.service.save(alice, "p1", input())).replayed, false);
});

test("SQL constraints keep private identity and body projection consistent and revisions monotonic", async t => {
  const f = await fixture(t), saved = await f.service.save(alice, "p1", input());
  for (const statement of [
    "UPDATE m07_edit_drafts SET owner_id = 'bob' WHERE id = $1",
    "UPDATE m07_edit_drafts SET project_id = 'p2' WHERE id = $1",
    "UPDATE m07_edit_drafts SET revision = revision + 2 WHERE id = $1",
    "UPDATE m07_edit_drafts SET revision = revision + 1, body = jsonb_set(body, '{visibility}', '\"project\"'::jsonb) WHERE id = $1",
  ]) await assert.rejects(f.engine.query(statement, [saved.draft.id]));
  assert.deepEqual(await f.service.getById(alice, saved.draft.id), saved.draft);
  const receipts = await f.engine.query<{ payload_hash: string; draft_id: string; accepted_revision: number }>("SELECT payload_hash, draft_id, accepted_revision FROM m07_edit_draft_mutations");
  assert.equal(receipts.rows.length, 1); assert.match(receipts.rows[0].payload_hash, /^[a-f0-9]{64}$/);
  const columns = await f.engine.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'm07_edit_draft_mutations'");
  assert.deepEqual(columns.rows.map(row => row.column_name).sort(), ["accepted_revision", "draft_id", "mutation_id", "owner_id", "payload_hash"]);
});
