import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { EventReviewService } from "./event-review-service.ts";
import { PostgresEventReviewRepository } from "./event-review-postgres.ts";
import { criticalFieldKeys } from "./event-review-types.ts";
import type { EventCandidatePublicationPort, EventCandidateSnapshot, EventReview, EventReviewAudit, EventReviewRepository, EventReviewTransaction } from "./event-review-types.ts";

const reviewer: Actor = { userId: "editor", platformRoles: ["reviewer"] };
const otherReviewer: Actor = { userId: "other-editor", platformRoles: ["reviewer"] };
const user: Actor = { userId: "member", platformRoles: ["user"] };

/** Testing fixture only: serialized transaction and rollback cover service invariants. */
function fixture() {
  let reviews = new Map<string, EventReview>();
  let audits: EventReviewAudit[] = [];
  let candidates = new Map<string, EventCandidateSnapshot>();
  let publications: { version: number; visible: boolean }[] = [];
  let nextId = 0;
  let tail: Promise<void> = Promise.resolve();
  let publishFailure = false;
  let auditFailure = false;
  const sample: EventCandidateSnapshot = { eventId: "event-1", candidateId: "candidate-1", revision: 1, contentHash: "sha256-1", schemaVersion: "rules-v1", createdBy: reviewer.userId, lastModifiedBy: reviewer.userId, origin: "manual", validationErrors: [], currentPublishedVersion: null, currentPublishedCriticalFields: null,
    criticalFields: criticalFieldKeys.map(key => ({ key, state: "known", evidenceIds: [`evidence-${key}`], summary: `已核验${key}` })) };
  candidates.set(sample.candidateId, sample);
  const repository: EventReviewRepository = {
    async listReviews(status, limit = 50) { return [...reviews.values()].filter(r => status === undefined || r.status === status).slice(0, limit); },
    async transaction(work) {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      const backup = structuredClone({ reviews, audits, candidates, publications });
      const tx: EventReviewTransaction = {
        async query() { throw new Error("Fixture query is intentionally unavailable"); },
        async getReview(id) { return structuredClone(reviews.get(id) ?? null); },
        async findByCandidate(id) { return structuredClone([...reviews.values()].find(review => review.candidateId === id) ?? null); },
        async insertReview(review) { if ([...reviews.values()].some(r => r.candidateId === review.candidateId)) throw new DomainError("VERSION_CONFLICT", "duplicate", { status: 409 }); reviews.set(review.id, structuredClone(review)); },
        async saveReview(review, expectedRevision) { assert.equal(reviews.get(review.id)?.revision, expectedRevision); reviews.set(review.id, structuredClone(review)); },
        async appendAudit(audit) { if (auditFailure) throw new Error("audit unavailable"); audits.push(structuredClone(audit)); },
      };
      try { return await work(tx); }
      catch (error) { reviews = backup.reviews; audits = backup.audits; candidates = backup.candidates; publications = backup.publications; throw error; }
      finally { release(); }
    },
  };
  const events: EventCandidatePublicationPort = {
    async createManualCandidate(_tx, input) { const candidate = { ...sample, createdBy: input.actor.userId }; candidates.set(candidate.candidateId, candidate); return structuredClone(candidate); },
    async getCandidate(_tx, id) { return structuredClone(candidates.get(id) ?? null); },
    async reviseManualCandidate(_tx, input) {
      const previous = candidates.get(input.candidateId)!;
      assert.equal(previous.revision, input.expectedRevision);
      const candidate = { ...previous, revision: previous.revision + 1, contentHash: `sha256-${previous.revision + 1}`, lastModifiedBy: input.actor.userId };
      candidates.set(candidate.candidateId, candidate);
      return structuredClone(candidate);
    },
    async publishCandidate(_tx, input) {
      if (publishFailure) throw new DomainError("CONTENT_UNAVAILABLE", "发布服务暂不可用。", { status: 503 });
      const candidate = candidates.get(input.candidateId)!;
      assert.equal(candidate.revision, input.expectedRevision);
      assert.equal(candidate.contentHash, input.expectedContentHash);
      assert.equal(candidate.currentPublishedVersion, input.expectedPublishedVersion);
      const version = (input.expectedPublishedVersion ?? 0) + 1;
      publications.push({ version, visible: true });
      candidates.set(candidate.candidateId, { ...candidate, currentPublishedVersion: version });
      return { eventId: candidate.eventId, publishedVersion: version };
    },
    async withdrawEvent(_tx, input) {
      const publication = publications.find(item => item.version === input.expectedPublishedVersion);
      if (!publication || publications.at(-1)?.version !== input.expectedPublishedVersion) throw new DomainError("VERSION_CONFLICT", "version", { status: 409 });
      publication.visible = false;
      return { eventId: input.eventId, publishedVersion: publication.version };
    },
  };
  const service = new EventReviewService({ repository, events, ids: { next: () => `op-${++nextId}` }, clock: { now: () => new Date("2026-10-08T00:00:00Z") } });
  const approval = { expectedRevision: 1, expectedCandidateRevision: 1, checkedKeys: [...criticalFieldKeys], acknowledgedUnknownKeys: [], reason: "逐项核对了官方规则" };
  return { service, approval, get audits() { return audits; }, get publications() { return publications; },
    async submit() { return service.submitManual(reviewer, { content: { title: "人工赛事候选" } }, "request-1"); },
    patchCandidate(patch: Partial<EventCandidateSnapshot>) { const candidate = candidates.get("candidate-1")!; candidates.set("candidate-1", { ...candidate, ...patch }); },
    failPublication() { publishFailure = true; }, failAudit() { auditFailure = true; },
  };
}
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;

test("ordinary user cannot submit, approve, list, withdraw or register worker candidates", async () => {
  const f = fixture();
  await assert.rejects(() => f.service.submitManual(user, { content: {} }, "req"), code("OPERATIONS_FORBIDDEN"));
  await assert.rejects(() => f.service.list(user), code("OPERATIONS_FORBIDDEN"));
  await assert.rejects(() => f.service.approve(user, "x", f.approval, "req"), code("OPERATIONS_FORBIDDEN"));
  await assert.rejects(() => f.service.registerCandidate(user, "candidate-1", "req"), code("OPERATIONS_FORBIDDEN"));
  await assert.rejects(() => f.service.withdraw(user, { eventId: "event-1", expectedPublishedVersion: 1, reason: "错误" }, "req"), code("OPERATIONS_FORBIDDEN"));
  assert.equal(f.audits.length, 0);
});
test("manual candidate -> approval -> exact version publish records self-review and independent publication", async () => {
  const f = fixture();
  const review = await f.submit();
  assert.equal(review.status, "pending");
  assert.equal(f.publications.length, 0);
  const approved = await f.service.approve(reviewer, review.id, f.approval, "request-approve");
  assert.equal(approved.status, "approved");
  assert.equal(f.publications.length, 0);
  assert.equal(f.audits.at(-1)?.selfReviewed, true);
  const published = await f.service.publish(otherReviewer, review.id, { expectedRevision: 2, expectedCandidateRevision: 1, expectedPublishedVersion: null, reason: "发布核验版本" }, "request-publish");
  assert.equal(published.status, "published");
  assert.equal(published.publishedVersion, 1);
  assert.equal(f.publications.length, 1);
  await assert.rejects(() => f.service.reviseManual(reviewer, review.id, { expectedRevision: 3, expectedCandidateRevision: 1, content: {}, reason: "改写" }, "req"), code("INVALID_STATE"));
  await f.service.withdraw(reviewer, { eventId: "event-1", expectedPublishedVersion: 1, reason: "主办方更正" }, "req-withdraw");
  assert.equal(f.publications[0]?.visible, false);
  assert.equal((await f.service.getDetail(reviewer, review.id)).review.status, "published");
});
test("known critical fields require evidence, conflicts and validation failures prevent approval", async () => {
  for (const failure of ["no-evidence", "conflict", "schema", "missing-field"]) {
    const f = fixture();
    const review = await f.submit();
    const fields = criticalFieldKeys.map(key => ({ key, state: "known" as const, evidenceIds: [`evidence-${key}`], summary: "规则" }));
    if (failure === "no-evidence") f.patchCandidate({ criticalFields: fields.map(field => field.key === "deadlines" ? { ...field, evidenceIds: [] } : field) });
    if (failure === "conflict") f.patchCandidate({ criticalFields: fields.map(field => field.key === "fees" ? { ...field, state: "conflict" } : field) });
    if (failure === "schema") f.patchCandidate({ validationErrors: ["截止缺少时区"] });
    if (failure === "missing-field") f.patchCandidate({ criticalFields: fields.slice(1) });
    await assert.rejects(() => f.service.approve(reviewer, review.id, f.approval, "req"), code(failure === "no-evidence" ? "EVIDENCE_REQUIRED" : failure === "conflict" ? "EVIDENCE_CONFLICT" : failure === "schema" ? "CANDIDATE_INVALID" : "CRITICAL_FIELDS_MISSING"));
    assert.equal((await f.service.getDetail(reviewer, review.id)).review.status, "pending");
  }
});
test("unknown fees require explicit acknowledgement and remain unknown", async () => {
  const f = fixture(); const review = await f.submit();
  const current = (await f.service.getDetail(reviewer, review.id)).candidate;
  f.patchCandidate({ criticalFields: current.criticalFields.map(field => field.key === "fees" ? { ...field, state: "unknown", evidenceIds: [], summary: "未说明" } : field) });
  await assert.rejects(() => f.service.approve(reviewer, review.id, f.approval, "req"), code("UNKNOWN_NOT_ACKNOWLEDGED"));
  const approved = await f.service.approve(reviewer, review.id, { ...f.approval, acknowledgedUnknownKeys: ["fees"] }, "req");
  assert.deepEqual(approved.acknowledgedUnknownKeys, ["fees"]);
  assert.equal((await f.service.getDetail(reviewer, review.id)).candidate.criticalFields.find(field => field.key === "fees")?.state, "unknown");
});
test("concurrent approval with old revision loses without overwriting first audit", async () => {
  const f = fixture(); const review = await f.submit();
  const results = await Promise.allSettled([
    f.service.approve(reviewer, review.id, f.approval, "request-A"),
    f.service.approve(otherReviewer, review.id, f.approval, "request-B"),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected" && code("VERSION_CONFLICT")(result.reason)).length, 1);
  assert.equal(f.audits.filter(audit => audit.action === "candidate_approved").length, 1);
});
test("manual revision clears approval and prevents old-version publish", async () => {
  const f = fixture(); const review = await f.submit();
  await f.service.approve(reviewer, review.id, f.approval, "req");
  const revised = await f.service.reviseManual(otherReviewer, review.id, { expectedRevision: 2, expectedCandidateRevision: 1, content: { deadline: "更正" }, reason: "更正时区" }, "req");
  assert.equal(revised.status, "pending");
  assert.equal(revised.candidateRevision, 2);
  assert.equal(revised.reviewedAt, null);
  await assert.rejects(() => f.service.publish(reviewer, review.id, { expectedRevision: 3, expectedCandidateRevision: 2, expectedPublishedVersion: null, reason: "发布" }, "req"), code("REVIEW_REQUIRED"));
});
test("content provider changed candidate or public pointer after approval: no publication", async () => {
  for (const patch of [{ revision: 2, contentHash: "changed" }, { currentPublishedVersion: 4 }]) {
    const f = fixture(); const review = await f.submit();
    await f.service.approve(reviewer, review.id, f.approval, "req");
    f.patchCandidate(patch);
    await assert.rejects(() => f.service.publish(reviewer, review.id, { expectedRevision: 2, expectedCandidateRevision: 1, expectedPublishedVersion: null, reason: "发布" }, "req"), code("VERSION_CONFLICT"));
    assert.equal(f.publications.length, 0);
    assert.equal((await f.service.getDetail(reviewer, review.id)).review.status, "approved");
  }
});
test("publication service failure and audit failure roll back all facts", async () => {
  for (const fail of ["content", "audit"]) {
    const f = fixture(); const review = await f.submit();
    await f.service.approve(reviewer, review.id, f.approval, "req");
    if (fail === "content") f.failPublication(); else f.failAudit();
    await assert.rejects(() => f.service.publish(reviewer, review.id, { expectedRevision: 2, expectedCandidateRevision: 1, expectedPublishedVersion: null, reason: "发布" }, "req"));
    assert.equal(f.publications.length, 0);
    assert.equal((await f.service.getDetail(reviewer, review.id)).review.status, "approved");
  }
});
test("changes requested and rejected need reason; fixing restores pending review", async () => {
  const f = fixture(); const review = await f.submit();
  await assert.rejects(() => f.service.decide(reviewer, review.id, { expectedRevision: 1, expectedCandidateRevision: 1, decision: "rejected", reason: " " }, "req"), code("INVALID_INPUT"));
  const decision = await f.service.decide(otherReviewer, review.id, { expectedRevision: 1, expectedCandidateRevision: 1, decision: "changes_requested", reason: "日期证据不一致" }, "req");
  assert.equal(decision.status, "changes_requested");
  const fixed = await f.service.reviseManual(reviewer, review.id, { expectedRevision: 2, expectedCandidateRevision: 1, content: {}, reason: "补齐日期证据" }, "req");
  assert.equal(fixed.status, "pending");
  await assert.rejects(() => f.service.approve(reviewer, review.id, { ...f.approval, expectedRevision: 3, expectedCandidateRevision: 2, checkedKeys: ["fees"] }, "req"), code("REVIEW_INCOMPLETE"));
});
test("Postgres repository parameterizes input and CAS rejects concurrent writes", async () => {
  const calls: { statement: string; parameters: readonly unknown[] }[] = [];
  let txCount = 0;
  const database: DatabasePort = {
    async query<Row>(statement: string, parameters: readonly unknown[] = []) { calls.push({ statement, parameters }); return { rows: [] as Row[], rowCount: 0 }; },
    async transaction(work) { txCount++; return work(database as SqlExecutor); },
  };
  const repository = new PostgresEventReviewRepository(database);
  const injected = "id'; DELETE FROM operations_event_reviews;--";
  await repository.transaction(async tx => {
    assert.equal(await tx.getReview(injected), null);
    const f = fixture(); const review = await f.submit();
    await assert.rejects(() => tx.saveReview(review, 0), code("VERSION_CONFLICT"));
  });
  assert.equal(txCount, 1);
  assert.ok(calls.every(call => !call.statement.includes(injected)));
  assert.deepEqual(calls[0]?.parameters, [injected]);
  assert.match(calls[1]!.statement, /WHERE id = \$1 AND revision = \$6/);
});
test("service rejects omitted expected revision and preserves trusted actor despite excess input fields", async () => {
  const f = fixture();
  const forged = { content: {}, actor: { userId: "spoof", platformRoles: ["admin"] } };
  const review = await f.service.submitManual(reviewer, forged, "req");
  assert.equal((await f.service.getDetail(reviewer, review.id)).candidate.createdBy, reviewer.userId);
  await assert.rejects(() => f.service.approve(reviewer, review.id, { ...f.approval, expectedRevision: undefined } as unknown as typeof f.approval, "req"), code("INVALID_INPUT"));
});
test("external draft refresh resets approval and preserves approved version evidence in audit", async () => {
  const f = fixture(); const review = await f.submit();
  await f.service.approve(reviewer, review.id, f.approval, "req");
  f.patchCandidate({ revision: 2, contentHash: "sha256-2", lastModifiedBy: otherReviewer.userId });
  assert.equal((await f.service.getDetail(reviewer, review.id)).needsRefresh, true);
  const refreshed = await f.service.refreshCandidate(otherReviewer, review.id, { expectedRevision: 2, expectedCandidateRevision: 2, reason: "重新查看 M03 编辑版本" }, "req");
  assert.equal(refreshed.status, "pending");
  assert.equal(refreshed.reviewedAt, null);
  assert.equal((await f.service.getDetail(reviewer, review.id)).needsRefresh, false);
  await f.service.approve(otherReviewer, review.id, { ...f.approval, expectedRevision: 3, expectedCandidateRevision: 2 }, "req");
  const first = f.audits.find(audit => audit.action === "candidate_approved");
  assert.equal(first?.contentHash, "sha256-1");
  assert.deepEqual(first?.checkedKeys, criticalFieldKeys);
  assert.equal(f.audits.at(-1)?.selfReviewed, true);
});
test("review detail presents current publication and changed critical fields together", async () => {
  const f = fixture(); const review = await f.submit();
  const current = (await f.service.getDetail(reviewer, review.id)).candidate;
  f.patchCandidate({ currentPublishedVersion: 1, currentPublishedCriticalFields: current.criticalFields.map(field => field.key === "deadlines" ? { ...field, summary: "旧截止时间 UTC+8" } : field) });
  const detail = await f.service.getDetail(reviewer, review.id);
  const deadlines = detail.changes.find(change => change.key === "deadlines")!;
  assert.equal(deadlines.change, "changed");
  assert.equal(deadlines.before?.summary, "旧截止时间 UTC+8");
  assert.equal(deadlines.after.summary, "已核验deadlines");
  assert.equal(detail.changes.find(change => change.key === "fees")?.change, "unchanged");
});
