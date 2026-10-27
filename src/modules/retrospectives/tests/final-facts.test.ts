import assert from "node:assert/strict";
import test from "node:test";
import type { SqlExecutor } from "../../../shared/persistence.ts";
import { DomainError } from "../../../shared/errors.ts";
import type { DocumentTransaction, EvidenceRef, FinalFactsLockRequest, FinalFactsSnapshot, ToolExperience } from "../domain.ts";
import { alice, bob, charlie, cardContent, content, fixture, hasCode, ref } from "./fixtures.ts";

const tool: ToolExperience = { resourceId: "resource-1", usedFor: "整理演示", limitations: "比赛使用范围需重新核验", costAtUse: "未知", source: "member_record" };
type Fixture = ReturnType<typeof fixture>;
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = () => resolve(); });
  return { promise, release };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Expected write transaction was not entered.")), 1500); })]);
  } finally { if (timer) clearTimeout(timer); }
}
function storedState(f: Fixture) {
  return structuredClone({ documents: f.repository.documents, versions: f.repository.versions, events: f.repository.events });
}

/** Frozen ordinary ports model an already-completed precheck or a stale pool cache.
 * The final lock reads a separate mutable fact store after a concurrent change.
 * The SQL executor is a test double; no PostgreSQL locks are claimed by this test. */
function lockedFixture(f: Fixture, options: { missingLock?: boolean; forbidOrdinaryDuringTransaction?: boolean } = {}) {
  const ordinaryMemberships = structuredClone(f.memberships);
  const ordinaryArchived = structuredClone(f.archived);
  const ordinaryEvidence = structuredClone(f.evidence);
  const ordinaryReviewed = structuredClone(f.reviewed);
  const entered = barrier(), changeCommitted = barrier();
  const requests: FinalFactsLockRequest[] = [];
  const snapshots: FinalFactsSnapshot[] = [];
  const ordinaryCalls = { membership: 0, archived: 0, evidence: 0, reviewed: 0 };
  const trace: string[] = [];
  let pause = false, active = false, writeAttempts = 0, transactions = 0;
  function ordinaryAllowed() {
    if (options.forbidOrdinaryDuringTransaction && active) throw new Error("Final write read an ordinary cached port instead of the locked snapshot.");
  }
  f.dependencies.access = { async getMembership(projectId, userId) { ordinaryAllowed(); ordinaryCalls.membership++; return structuredClone(ordinaryMemberships.get(`${projectId}:${userId}`) ?? null); } };
  f.dependencies.projects = { async isArchived(projectId) { ordinaryAllowed(); ordinaryCalls.archived++; return ordinaryArchived.has(projectId); } };
  f.dependencies.evidence = { async resolve(_actor, _projectId, refs) { ordinaryAllowed(); ordinaryCalls.evidence++; return structuredClone(refs.flatMap(item => ordinaryEvidence.has(item.id) ? [ordinaryEvidence.get(item.id)!] : [])); } };
  f.dependencies.resources = { async isReviewed(id) { ordinaryAllowed(); ordinaryCalls.reviewed++; return ordinaryReviewed.has(id); } };

  const sql: SqlExecutor = { async query<Row>() { assert.ok(active, "The exact transaction executor must remain active."); trace.push("locked-sql-read"); return { rows: [] as Row[], rowCount: 0 }; } };
  const originalTransaction = f.repository.transaction.bind(f.repository);
  f.repository.transaction = async <T>(work: (transaction: DocumentTransaction) => Promise<T>): Promise<T> => {
    transactions++;
    return originalTransaction(async transaction => {
      active = true;
      try {
        if (pause) { trace.push("transaction-entered"); entered.release(); await changeCommitted.promise; }
        const wrapped: DocumentTransaction = {
          sql,
          get: transaction.get.bind(transaction),
          getVersion: transaction.getVersion.bind(transaction),
          async insert(document, event) { writeAttempts++; trace.push("document-write"); return transaction.insert(document, event); },
          async replace(document, expectedRevision, event) { writeAttempts++; trace.push("document-write"); return transaction.replace(document, expectedRevision, event); },
          async deletePersonal(id, ownerId, expectedRevision, event) { writeAttempts++; trace.push("document-write"); return transaction.deletePersonal(id, ownerId, expectedRevision, event); },
        };
        return await work(wrapped);
      } finally { active = false; }
    });
  };
  f.dependencies.finalFactsLock = options.missingLock ? undefined : {
    async lock(request, transaction): Promise<FinalFactsSnapshot> {
      assert.equal(transaction, sql, "FinalFactsLockPort receives the exact active transaction executor.");
      assert.ok(active);
      assert.deepEqual(request.projectIds, [...new Set(request.projectIds)].sort());
      assert.deepEqual(request.resourceIds, [...new Set(request.resourceIds)].sort());
      requests.push(structuredClone(request));
      trace.push("final-facts-lock");
      trace.push(`lock:${request.operation}`);
      await transaction.query("SELECT final_facts_test_fixture");
      const snapshot: FinalFactsSnapshot = {
        projects: request.projectIds.map(projectId => ({ projectId, membership: structuredClone(f.memberships.get(`${projectId}:${request.actor.userId}`) ?? null), archived: f.archived.has(projectId) })),
        evidence: request.evidence.map(group => ({ projectId: group.projectId, audience: group.audience, states: structuredClone(group.refs.flatMap(item => f.evidence.has(item.id) ? [f.evidence.get(item.id)!] : [])) })),
        reviewedResourceIds: request.resourceIds.filter(id => f.reviewed.has(id)),
      };
      snapshots.push(structuredClone(snapshot));
      return snapshot;
    },
  };
  return {
    f, sql, entered, requests, snapshots, ordinaryCalls, trace,
    get transactionActive() { return active; },
    get writeAttempts() { return writeAttempts; },
    get transactions() { return transactions; },
    pauseNextWrite() { pause = true; },
    commitConcurrentChange(change: () => void) { change(); trace.push("concurrent-change-committed"); changeCommitted.release(); },
  };
}
type LockedFixture = ReturnType<typeof lockedFixture>;
async function rejectedAfterPrecheck(h: LockedFixture, write: () => Promise<unknown>, change: () => void, code: string) {
  const before = storedState(h.f);
  h.pauseNextWrite();
  const pending = write();
  // Attach a handler while the independently committed change is being coordinated.
  void pending.catch(() => undefined);
  await within(h.entered.promise);
  h.commitConcurrentChange(change);
  await assert.rejects(pending, hasCode(code));
  assert.deepEqual(storedState(h.f), before, "Rejected final checks must preserve body, revision history and audit.");
  assert.equal(h.writeAttempts, 0, "A failing final check must precede every M07 write.");
  assert.equal(h.transactions, 1);
  assert.equal(h.requests.length, 1);
  assert.ok(h.trace.indexOf("concurrent-change-committed") < h.trace.indexOf("final-facts-lock"));
  assert.ok(h.ordinaryCalls.membership > 0);
}
async function sharedDraft() {
  const f = fixture();
  const doc = await f.service.createRetrospective(alice, "p1", { scope: "project", content: { ...content, tools: [tool] } });
  return { f, doc };
}

test("project confirmation rechecks locked membership, role, archive, evidence and reviewed resources after concurrent commit", async t => {
  const changes = [
    { name: "manager leaves", code: "FORBIDDEN", mutate(f: Fixture) { f.memberships.set("p1:bob", { ...f.memberships.get("p1:bob")!, status: "left" }); } },
    { name: "manager is removed", code: "FORBIDDEN", mutate(f: Fixture) { f.memberships.delete("p1:bob"); } },
    { name: "manager is downgraded", code: "FORBIDDEN", mutate(f: Fixture) { f.memberships.set("p1:bob", { ...f.memberships.get("p1:bob")!, role: "member" }); } },
    { name: "project archived", code: "PROJECT_ARCHIVED", mutate(f: Fixture) { f.archived.add("p1"); } },
    { name: "evidence withdrawn", code: "EVIDENCE_UNAVAILABLE", mutate(f: Fixture) { f.evidence.set(ref.id, { ...f.evidence.get(ref.id)!, state: "withdrawn" }); } },
    { name: "evidence no longer project shareable", code: "EVIDENCE_UNAVAILABLE", mutate(f: Fixture) { f.evidence.set(ref.id, { ...f.evidence.get(ref.id)!, projectShareable: false }); } },
    { name: "reviewed resource taken down", code: "RESOURCE_UNREVIEWED", mutate(f: Fixture) { f.reviewed.delete("resource-1"); } },
  ];
  for (const change of changes) await t.test(change.name, async () => {
    const { f, doc } = await sharedDraft();
    const h = lockedFixture(f);
    await rejectedAfterPrecheck(h, () => f.service.confirmRetrospective(bob, doc.id, { expectedRevision: doc.revision }), () => change.mutate(f), change.code);
    assert.equal(h.requests[0].operation, "retrospective.confirm");
    assert.deepEqual(h.requests[0].projectIds, ["p1"]);
    assert.ok(h.requests[0].evidence.some(group => group.projectId === "p1" && group.audience === "project" && group.refs.some(item => item.id === ref.id && item.revision === 1)));
    assert.ok(h.requests[0].resourceIds.includes("resource-1"));
    // Ordinary precheck ports still return their earlier valid values.
    assert.equal((await f.dependencies.access.getMembership("p1", "bob"))?.role, "manager");
    assert.equal((await f.dependencies.access.getMembership("p1", "bob"))?.status, "active");
    assert.equal(await f.dependencies.projects.isArchived("p1"), false);
    assert.equal((await f.dependencies.evidence.resolve(bob, "p1", [ref], "project"))[0].state, "available");
    assert.equal(await f.dependencies.resources.isReviewed("resource-1"), true);
  });
});

test("each manual create, update and card confirmation refuses an evidence withdrawal between precheck and final lock", async t => {
  const operations = ["retrospective.create", "retrospective.update", "experience.create", "experience.update", "experience.confirm"] as const;
  for (const operation of operations) await t.test(operation, async () => {
    const { f, doc } = await sharedDraft();
    const card = await f.service.createExperienceCard(alice, "p1", { scope: "project", content: cardContent });
    const h = lockedFixture(f);
    const write = () => {
      switch (operation) {
        case "retrospective.create": return f.service.createRetrospective(alice, "p1", { scope: "project", content });
        case "retrospective.update": return f.service.updateRetrospective(alice, doc.id, { expectedRevision: 1, content });
        case "experience.create": return f.service.createExperienceCard(alice, "p1", { scope: "project", content: cardContent });
        case "experience.update": return f.service.updateExperienceCard(alice, card.id, { expectedRevision: 1, content: cardContent });
        case "experience.confirm": return f.service.confirmExperienceCard(bob, card.id, 1);
      }
    };
    await rejectedAfterPrecheck(h, write, () => { f.evidence.set(ref.id, { ...f.evidence.get(ref.id)!, state: "withdrawn" }); }, "EVIDENCE_UNAVAILABLE");
    assert.equal(h.requests[0].operation, operation);
  });
});

test("reuse locks both project memberships and rejects source or target membership revocation before recording a draft", async t => {
  for (const revokedProjectId of ["p1", "p2"]) await t.test(`revoked ${revokedProjectId}`, async () => {
    const f = fixture();
    const card = await f.service.createExperienceCard(alice, "p1", { scope: "project", content: cardContent });
    const confirmed = await f.service.confirmExperienceCard(bob, card.id, 1);
    const h = lockedFixture(f);
    await rejectedAfterPrecheck(h, () => f.service.createReuseDraft(charlie, "p2", { sourceCardId: card.id, sourceRevision: confirmed.revision, selectedFields: ["advice"], acknowledgeRechecks: true }), () => {
      f.memberships.set(`${revokedProjectId}:charlie`, { ...f.memberships.get(`${revokedProjectId}:charlie`)!, status: "removed" });
    }, "FORBIDDEN");
    assert.equal(h.requests[0].operation, "experience.reuse");
    assert.deepEqual(h.requests[0].projectIds, ["p1", "p2"]);
    assert.ok(![...f.repository.documents.values()].some(item => item.kind === "reuse_draft"));
  });
});

test("confirmation succeeds using the exact transaction's available snapshot without ordinary in-transaction reads", async () => {
  const { f, doc } = await sharedDraft();
  const h = lockedFixture(f, { forbidOrdinaryDuringTransaction: true });
  const before = storedState(f);
  const confirmed = await f.service.confirmRetrospective(bob, doc.id, { expectedRevision: 1 });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.revision, 2);
  assert.equal(confirmed.confirmedBy, "bob");
  assert.deepEqual(confirmed.content, doc.content);
  assert.equal((await f.repository.get(doc.id))?.revision, 2);
  assert.deepEqual(await f.repository.getVersion(doc.id, 1), doc);
  assert.deepEqual(await f.repository.getVersion(doc.id, 2), confirmed);
  assert.equal(f.repository.events.length, before.events.length + 1);
  assert.equal(f.repository.events.at(-1)?.type, "RetrospectiveConfirmed");
  assert.equal(h.transactions, 1);
  assert.equal(h.writeAttempts, 1);
  assert.ok(h.trace.indexOf("locked-sql-read") < h.trace.indexOf("document-write"));
});

test("a SQL transaction with no final-facts lock fails closed before changing any record", async () => {
  const { f, doc } = await sharedDraft();
  const h = lockedFixture(f, { missingLock: true });
  const before = storedState(f);
  await assert.rejects(f.service.confirmRetrospective(bob, doc.id, { expectedRevision: 1 }), error => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, "FINAL_FACTS_LOCK_REQUIRED");
    assert.equal(error.status, 503);
    return true;
  });
  assert.deepEqual(storedState(f), before);
  assert.equal(h.writeAttempts, 0);
  assert.equal(h.transactions, 1);
});

test("a legacy fixture without SQL still rechecks current ordinary facts at transaction entry", async () => {
  const { f, doc } = await sharedDraft();
  const entered = barrier(), changeCommitted = barrier();
  const originalTransaction = f.repository.transaction.bind(f.repository);
  const before = storedState(f);
  f.repository.transaction = async <T>(work: (tx: DocumentTransaction) => Promise<T>) => originalTransaction(async tx => {
    assert.equal(tx.sql, undefined);
    entered.release();
    await changeCommitted.promise;
    return work(tx);
  });
  const pending = f.service.confirmRetrospective(bob, doc.id, { expectedRevision: 1 });
  void pending.catch(() => undefined);
  await within(entered.promise);
  f.memberships.set("p1:bob", { ...f.memberships.get("p1:bob")!, status: "left" });
  changeCommitted.release();
  await assert.rejects(pending, hasCode("FORBIDDEN"));
  assert.deepEqual(storedState(f), before);
});

async function personalCardWithTwoSources() {
  const f = fixture();
  const replacementRef: EvidenceRef = { kind: "task", id: "replacement-task", revision: 1 };
  f.evidence.set(replacementRef.id, { ref: replacementRef, projectId: "p1", state: "available", projectShareable: true });
  f.reviewed.add("resource-2");
  const oldDraft = await f.service.createRetrospective(alice, "p1", { scope: "project", content: { ...content, tools: [tool] } });
  const oldSource = await f.service.confirmRetrospective(bob, oldDraft.id, { expectedRevision: 1 });
  const newDraft = await f.service.createRetrospective(alice, "p1", { scope: "project", content: { ...content, evidenceRefs: [replacementRef], tools: [{ ...tool, resourceId: "resource-2" }] } });
  const newSource = await f.service.confirmRetrospective(bob, newDraft.id, { expectedRevision: 1 });
  // Neither dependency is directly cited by the card; both must be discovered via sources.
  const card = await f.service.createExperienceCard(alice, "p1", { scope: "personal", content: { ...cardContent, evidenceRefs: [], tools: [] }, sourceRetrospective: { id: oldSource.id, revision: oldSource.revision } });
  return { f, card, oldSource, newSource, replacementRef };
}

function assertBothSourceAudiences(request: FinalFactsLockRequest, replacementRef: EvidenceRef) {
  assert.equal(request.operation, "experience.update");
  assert.deepEqual(request.resourceIds, ["resource-1", "resource-2"]);
  for (const audience of ["personal", "project"] as const) {
    const groups = request.evidence.filter(group => group.projectId === "p1" && group.audience === audience);
    assert.equal(groups.length, 1, `Expected exactly one ${audience} evidence group.`);
    assert.deepEqual(groups[0].refs, [replacementRef, ref]);
  }
}

test("personal card source replacement locks both old/new source facts and both personal/project evidence audiences", async () => {
  const { f, card, oldSource, newSource, replacementRef } = await personalCardWithTwoSources();
  const h = lockedFixture(f, { forbidOrdinaryDuringTransaction: true });
  const before = storedState(f);
  const view = await f.service.updateExperienceCard(alice, card.id, { expectedRevision: 1, sourceRetrospective: { id: newSource.id, revision: newSource.revision } });
  assert.ok(view.document);
  assert.equal(view.scope, "personal");
  assert.equal(view.revision, 2);
  assert.deepEqual(view.document.content, card.content);
  assert.deepEqual(view.document.sourceRetrospective, { id: newSource.id, revision: newSource.revision });
  assert.deepEqual(await f.repository.get(oldSource.id), oldSource);
  assert.equal(f.repository.events.length, before.events.length + 1);
  assert.equal(h.writeAttempts, 1);
  assert.equal(h.requests.length, 1);
  assertBothSourceAudiences(h.requests[0], replacementRef);
});

test("replacing a source cannot retain the old card body after the old source evidence is withdrawn before final lock", async () => {
  const { f, card, newSource, replacementRef } = await personalCardWithTwoSources();
  const h = lockedFixture(f);
  await rejectedAfterPrecheck(h, () => f.service.updateExperienceCard(alice, card.id, { expectedRevision: 1, sourceRetrospective: { id: newSource.id, revision: newSource.revision } }), () => {
    f.evidence.set(ref.id, { ...f.evidence.get(ref.id)!, state: "withdrawn" });
  }, "SOURCE_WITHDRAWN");
  assertBothSourceAudiences(h.requests[0], replacementRef);
  assert.equal(h.snapshots[0].evidence.find(group => group.audience === "personal")?.states.find(state => state.ref.id === ref.id)?.state, "withdrawn");
  assert.deepEqual(await f.repository.get(card.id), card);
});

test("model runs outside SQL transactions and locks, then a fresh completion snapshot blocks revoked evidence without saving AI prose", async () => {
  const { f, doc } = await sharedDraft();
  const h = lockedFixture(f, { forbidOrdinaryDuringTransaction: true });
  const modelEntered = barrier(), allowModelReturn = barrier();
  let modelCalls = 0;
  f.dependencies.model = {
    async generate(input) {
      modelCalls++;
      assert.equal(h.transactionActive, false, "The model call must start after enqueue SQL/fact locks are released.");
      assert.equal(h.requests.at(-1)?.operation, "generation.enqueue");
      assert.deepEqual(input.answers, doc.content.answers);
      h.trace.push("model-started");
      modelEntered.release();
      await allowModelReturn.promise;
      assert.equal(h.transactionActive, false, "No SQL or fact lock may be held while waiting for the model.");
      h.trace.push("model-returned");
      return { answers: { ...doc.content.answers, nextChange: "AI_PROSE_MUST_NOT_BE_SAVED" }, evidenceRefs: [ref], resourceIds: ["resource-1"], modelVersion: "fixture-model" };
    },
  };
  const job = await f.service.enqueueGeneration(alice, doc.id, 1);
  const pending = f.service.runGeneration(job.id);
  void pending.catch(() => undefined);
  await within(modelEntered.promise);
  assert.equal(h.transactionActive, false);
  // An independent evidence mutation commits during the provider wait. Ordinary
  // ports still see the old valid cache, so only the completion snapshot can deny it.
  f.evidence.set(ref.id, { ...f.evidence.get(ref.id)!, state: "withdrawn" });
  h.trace.push("evidence-withdrawal-committed");
  assert.equal((await f.dependencies.evidence.resolve(alice, "p1", [ref], "project"))[0].state, "available");
  allowModelReturn.release();
  const failed = await pending;
  assert.equal(modelCalls, 1);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "EVIDENCE_UNAVAILABLE");
  assert.deepEqual(h.requests.map(request => request.operation), ["generation.enqueue", "generation.complete"]);
  assert.equal(h.snapshots[0].evidence[0].states[0].state, "available");
  assert.equal(h.snapshots[1].evidence[0].states[0].state, "withdrawn");
  assert.ok(h.trace.indexOf("evidence-withdrawal-committed") < h.trace.indexOf("model-returned"));
  assert.ok(h.trace.indexOf("model-returned") < h.trace.indexOf("lock:generation.complete"));
  const saved = await f.repository.get(doc.id);
  assert.ok(saved?.kind === "retrospective");
  assert.equal(saved.status, "draft");
  assert.deepEqual(saved.content, doc.content);
  assert.equal(saved.generatedDraft, undefined);
  assert.equal(saved.activeJobId, undefined);
  const history = [...f.repository.versions.values()];
  assert.ok(!history.some(version => version.kind === "retrospective" && version.generatedDraft));
  assert.ok(!history.some(version => version.kind === "generation_job" && version.status === "succeeded"));
  assert.ok(!history.some(version => version.kind === "retrospective" && version.status === "review_required"));
  assert.doesNotMatch(JSON.stringify({ documents: [...f.repository.documents.values()], history, audits: f.repository.events }), /AI_PROSE_MUST_NOT_BE_SAVED/);
  // Two enqueue writes and two metadata/manual-content cleanup writes; the failed
  // completion snapshot permits neither the generated draft nor succeeded job.
  assert.equal(h.writeAttempts, 4);
  assert.equal(h.transactionActive, false);
});
