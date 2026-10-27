import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { criticalFieldKeys } from "./event-review-types.ts";
import type { CriticalFieldChange, EventApprovalInput, EventCandidateSnapshot, EventReview, EventReviewAudit, EventReviewDependencies, EventReviewStatus, EventReviewTransaction } from "./event-review-types.ts";

export function assertOperationsReviewer(actor: Actor): void {
  if (!actor.platformRoles.includes("reviewer") && !actor.platformRoles.includes("admin")) {
    throw new DomainError("OPERATIONS_FORBIDDEN", "需要公开内容审核权限。", { status: 403 });
  }
}
function text(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1000) {
    throw new DomainError("INVALID_INPUT", `请填写${field}（最多 1000 字）。`);
  }
  return value.trim();
}
function conflict(latestRevision: number): never {
  throw new DomainError("VERSION_CONFLICT", "候选或审核已更新，请重新查看最新差异。", {
    status: 409, latestRevision, recoveryAction: "review_latest_version",
  });
}
function positiveVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new DomainError("INVALID_INPUT", "预期版本须为正整数。");
}
function assertSnapshot(snapshot: EventCandidateSnapshot): void {
  if (!snapshot.eventId || !snapshot.candidateId || !snapshot.contentHash || !snapshot.schemaVersion || !snapshot.createdBy || !snapshot.lastModifiedBy || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) {
    throw new DomainError("INVALID_CANDIDATE", "候选标识、内容哈希或版本无效。");
  }
}
function checkApproval(candidate: EventCandidateSnapshot, input: EventApprovalInput): void {
  assertSnapshot(candidate);
  if (candidate.validationErrors.length) throw new DomainError("CANDIDATE_INVALID", "候选结构校验尚未通过，请先修正。");
  const fields = new Map(candidate.criticalFields.map(field => [field.key, field]));
  if (fields.size !== criticalFieldKeys.length || candidate.criticalFields.length !== criticalFieldKeys.length || criticalFieldKeys.some(key => !fields.has(key))) {
    throw new DomainError("CRITICAL_FIELDS_MISSING", "资格、日期、费用、材料和提交方式都必须明确核验或标记未知。");
  }
  if (!Array.isArray(input.checkedKeys) || input.checkedKeys.length !== criticalFieldKeys.length || new Set(input.checkedKeys).size !== criticalFieldKeys.length || criticalFieldKeys.some(key => !input.checkedKeys.includes(key))) {
    throw new DomainError("REVIEW_INCOMPLETE", "请逐项核验五类关键字段。");
  }
  if (!Array.isArray(input.acknowledgedUnknownKeys) || new Set(input.acknowledgedUnknownKeys).size !== input.acknowledgedUnknownKeys.length || input.acknowledgedUnknownKeys.some(key => !criticalFieldKeys.includes(key))) {
    throw new DomainError("INVALID_INPUT", "未知字段确认清单无效。");
  }
  for (const key of criticalFieldKeys) {
    const field = fields.get(key)!;
    if (field.state === "conflict") throw new DomainError("EVIDENCE_CONFLICT", "关键字段存在来源冲突，请先人工修正。");
    if (field.state === "known") {
      if (!field.evidenceIds.length || field.evidenceIds.some(id => typeof id !== "string" || !id.trim())) {
        throw new DomainError("EVIDENCE_REQUIRED", "已知关键字段必须引用有效证据。");
      }
      if (input.acknowledgedUnknownKeys.includes(key)) throw new DomainError("INVALID_INPUT", "仅未知字段可确认以未知状态发布。");
    } else if (field.state === "unknown") {
      if (!input.acknowledgedUnknownKeys.includes(key)) throw new DomainError("UNKNOWN_NOT_ACKNOWLEDGED", "请确认未知字段以“未说明”公开显示。");
    } else throw new DomainError("INVALID_CANDIDATE", "关键字段状态无效。");
  }
}
function criticalChanges(candidate: EventCandidateSnapshot): readonly CriticalFieldChange[] {
  const beforeFields = new Map(candidate.currentPublishedCriticalFields?.map(field => [field.key, field]) ?? []);
  return candidate.criticalFields.map(after => {
    const before = beforeFields.get(after.key) ?? null;
    const changed = before !== null && (before.state !== after.state || before.summary !== after.summary ||
      JSON.stringify([...before.evidenceIds].sort()) !== JSON.stringify([...after.evidenceIds].sort()));
    return { key: after.key, before, after, change: before === null ? "added" : changed ? "changed" : "unchanged" };
  });
}

/** Public-content permissions never call ProjectAccessPort or grant access to private reports. */
export class EventReviewService {
  readonly dependencies: EventReviewDependencies;
  constructor(dependencies: EventReviewDependencies) { this.dependencies = dependencies; }

  private now(): string { return this.dependencies.clock.now().toISOString(); }
  private async get(tx: EventReviewTransaction, id: string, expectedRevision?: number, lock = true): Promise<EventReview> {
    const review = await tx.getReview(id, lock);
    if (!review) throw new DomainError("NOT_FOUND", "审核记录不存在。", { status: 404 });
    if (expectedRevision !== undefined && review.revision !== expectedRevision) conflict(review.revision);
    return review;
  }
  /** Peek -> M03 content locks -> review lock, then recheck the binding from the peek. */
  private async lockCandidateReview(tx: EventReviewTransaction, id: string, expectedRevision?: number): Promise<{ review: EventReview; candidate: EventCandidateSnapshot }> {
    const peek = await this.get(tx, id, undefined, false);
    const candidate = await this.dependencies.events.getCandidate(tx, peek.candidateId);
    if (!candidate) throw new DomainError("NOT_FOUND", "候选不存在。", { status: 404 });
    assertSnapshot(candidate);
    const review = await this.get(tx, id, expectedRevision);
    if (review.id !== peek.id || review.eventId !== peek.eventId || review.candidateId !== peek.candidateId || candidate.eventId !== review.eventId || candidate.candidateId !== review.candidateId) conflict(review.revision);
    return { review, candidate };
  }
  private snapshot(candidate: EventCandidateSnapshot, review: EventReview, expectedCandidateRevision: number): EventCandidateSnapshot {
    if (candidate.eventId !== review.eventId || candidate.candidateId !== review.candidateId || candidate.revision !== expectedCandidateRevision || candidate.revision !== review.candidateRevision || candidate.contentHash !== review.contentHash || candidate.schemaVersion !== review.schemaVersion) conflict(candidate.revision);
    return candidate;
  }
  private async audit(tx: EventReviewTransaction, actor: Actor, action: EventReviewAudit["action"], review: EventReview, requestId: string): Promise<void> {
    await tx.appendAudit({ id: this.dependencies.ids.next(), actorId: actor.userId, action,
      reviewId: review.id, eventId: review.eventId, candidateId: review.candidateId, revision: review.revision,
      candidateRevision: review.candidateRevision, contentHash: review.contentHash, schemaVersion: review.schemaVersion,
      checkedKeys: [...review.checkedKeys], acknowledgedUnknownKeys: [...review.acknowledgedUnknownKeys],
      reason: review.reason, selfReviewed: actor.userId === review.lastEditedBy && action === "candidate_approved", occurredAt: this.now(), requestId });
  }
  private newReview(candidate: EventCandidateSnapshot, submittedBy: string): EventReview {
    assertSnapshot(candidate);
    const now = this.now();
    return { id: this.dependencies.ids.next(), eventId: candidate.eventId, candidateId: candidate.candidateId,
      candidateRevision: candidate.revision, contentHash: candidate.contentHash, schemaVersion: candidate.schemaVersion,
      revision: 1, status: "pending", submittedBy, lastEditedBy: candidate.lastModifiedBy, createdAt: now, updatedAt: now, reviewedBy: null, reviewedAt: null,
      checkedKeys: [], acknowledgedUnknownKeys: [], reason: null, publishedVersion: null, publishedAt: null };
  }
  async list(actor: Actor, status?: EventReviewStatus, limit = 50): Promise<readonly EventReview[]> {
    assertOperationsReviewer(actor);
    if (status !== undefined && !["pending", "changes_requested", "approved", "rejected", "published"].includes(status)) throw new DomainError("INVALID_INPUT", "审核状态无效。");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new DomainError("INVALID_INPUT", "查询数量须为 1 到 100。");
    return this.dependencies.repository.listReviews(status, limit);
  }
  async getDetail(actor: Actor, reviewId: string): Promise<{ review: EventReview; candidate: EventCandidateSnapshot; needsRefresh: boolean; changes: readonly CriticalFieldChange[] }> {
    assertOperationsReviewer(actor);
    return this.dependencies.repository.transaction(async tx => {
      const { review, candidate } = await this.lockCandidateReview(tx, reviewId);
      return { review, candidate, needsRefresh: candidate.revision !== review.candidateRevision || candidate.contentHash !== review.contentHash || candidate.schemaVersion !== review.schemaVersion, changes: criticalChanges(candidate) };
    });
  }
  async submitManual(actor: Actor, input: { eventId?: string; content: unknown }, requestId: string): Promise<EventReview> {
    assertOperationsReviewer(actor);
    return this.dependencies.repository.transaction(async tx => {
      const candidate = await this.dependencies.events.createManualCandidate(tx, { actor, eventId: input.eventId, content: input.content, requestId });
      const review = this.newReview(candidate, actor.userId);
      await tx.insertReview(review);
      await this.audit(tx, actor, "candidate_submitted", review, requestId);
      return review;
    });
  }
  /** A reviewer queues an already schema-validated M03 worker candidate; a worker cannot call this. */
  async registerCandidate(actor: Actor, candidateId: string, requestId: string): Promise<EventReview> {
    assertOperationsReviewer(actor);
    return this.dependencies.repository.transaction(async tx => {
      const candidate = await this.dependencies.events.getCandidate(tx, candidateId);
      if (!candidate) throw new DomainError("NOT_FOUND", "候选不存在。", { status: 404 });
      assertSnapshot(candidate);
      if (candidate.candidateId !== candidateId) throw new DomainError("INVALID_CANDIDATE", "候选服务返回了不匹配的候选。");
      const existing = await tx.findByCandidate(candidateId);
      if (existing) {
        if (existing.candidateId !== candidateId || existing.eventId !== candidate.eventId) conflict(existing.revision);
        return existing;
      }
      const review = this.newReview(candidate, candidate.createdBy);
      await tx.insertReview(review);
      await this.audit(tx, actor, "candidate_registered", review, requestId);
      return review;
    });
  }
  async reviseManual(actor: Actor, reviewId: string, input: { expectedRevision: number; expectedCandidateRevision: number; content: unknown; reason: string }, requestId: string): Promise<EventReview> {
    assertOperationsReviewer(actor);
    positiveVersion(input.expectedRevision);
    positiveVersion(input.expectedCandidateRevision);
    const reason = text(input.reason, "修正原因");
    return this.dependencies.repository.transaction(async tx => {
      const { review, candidate: lockedCandidate } = await this.lockCandidateReview(tx, reviewId, input.expectedRevision);
      if (review.status === "published") throw new DomainError("INVALID_STATE", "已发布记录不可改写，请新建候选版本。", { status: 409 });
      this.snapshot(lockedCandidate, review, input.expectedCandidateRevision);
      const candidate = await this.dependencies.events.reviseManualCandidate(tx, { actor, candidateId: review.candidateId, expectedRevision: input.expectedCandidateRevision, content: input.content, reason, requestId });
      assertSnapshot(candidate);
      if (candidate.eventId !== review.eventId || candidate.candidateId !== review.candidateId || candidate.revision <= review.candidateRevision) throw new DomainError("INVALID_CANDIDATE", "内容修正必须保留候选归属并增加版本。");
      const updated: EventReview = { ...review, candidateRevision: candidate.revision, contentHash: candidate.contentHash,
        schemaVersion: candidate.schemaVersion, revision: review.revision + 1, status: "pending", reason, lastEditedBy: actor.userId, updatedAt: this.now(),
        reviewedBy: null, reviewedAt: null, checkedKeys: [], acknowledgedUnknownKeys: [] };
      await tx.saveReview(updated, review.revision);
      await this.audit(tx, actor, "candidate_revised", updated, requestId);
      return updated;
    });
  }
  /** Explicitly load a newer M03 draft; all old approval metadata is discarded. */
  async refreshCandidate(actor: Actor, reviewId: string, input: { expectedRevision: number; expectedCandidateRevision: number; reason: string }, requestId: string): Promise<EventReview> {
    assertOperationsReviewer(actor);
    positiveVersion(input.expectedRevision);
    positiveVersion(input.expectedCandidateRevision);
    const reason = text(input.reason, "重新核验原因");
    return this.dependencies.repository.transaction(async tx => {
      const { review, candidate } = await this.lockCandidateReview(tx, reviewId, input.expectedRevision);
      if (review.status === "published") throw new DomainError("INVALID_STATE", "已发布审核记录不可改写，请新建候选。", { status: 409 });
      if (candidate.eventId !== review.eventId || candidate.candidateId !== review.candidateId || candidate.revision !== input.expectedCandidateRevision) conflict(candidate.revision);
      if (candidate.revision <= review.candidateRevision) throw new DomainError("INVALID_STATE", "只有更新后的候选版本可以重新进入审核。", { status: 409 });
      const updated: EventReview = { ...review, status: "pending", candidateRevision: candidate.revision, contentHash: candidate.contentHash,
        schemaVersion: candidate.schemaVersion, lastEditedBy: candidate.lastModifiedBy, revision: review.revision + 1, reason, updatedAt: this.now(),
        reviewedBy: null, reviewedAt: null, checkedKeys: [], acknowledgedUnknownKeys: [] };
      await tx.saveReview(updated, review.revision);
      await this.audit(tx, actor, "candidate_refreshed", updated, requestId);
      return updated;
    });
  }
  async approve(actor: Actor, reviewId: string, input: EventApprovalInput, requestId: string): Promise<EventReview> {
    assertOperationsReviewer(actor);
    positiveVersion(input.expectedRevision);
    positiveVersion(input.expectedCandidateRevision);
    const reason = text(input.reason, "审核说明");
    return this.dependencies.repository.transaction(async tx => {
      const { review, candidate } = await this.lockCandidateReview(tx, reviewId, input.expectedRevision);
      if (review.status !== "pending") throw new DomainError("INVALID_STATE", "仅待审核候选可以审批。", { status: 409 });
      this.snapshot(candidate, review, input.expectedCandidateRevision);
      checkApproval(candidate, input);
      const now = this.now();
      const updated: EventReview = { ...review, status: "approved", revision: review.revision + 1, reason,
        checkedKeys: [...input.checkedKeys], acknowledgedUnknownKeys: [...input.acknowledgedUnknownKeys], reviewedBy: actor.userId, reviewedAt: now, updatedAt: now };
      await tx.saveReview(updated, review.revision);
      await this.audit(tx, actor, "candidate_approved", updated, requestId);
      return updated;
    });
  }
  async decide(actor: Actor, reviewId: string, input: { expectedRevision: number; expectedCandidateRevision: number; decision: "changes_requested" | "rejected"; reason: string }, requestId: string): Promise<EventReview> {
    assertOperationsReviewer(actor);
    positiveVersion(input.expectedRevision);
    positiveVersion(input.expectedCandidateRevision);
    if (!["changes_requested", "rejected"].includes(input.decision)) throw new DomainError("INVALID_INPUT", "审核决定无效。");
    const reason = text(input.reason, "处理原因");
    return this.dependencies.repository.transaction(async tx => {
      const { review, candidate } = await this.lockCandidateReview(tx, reviewId, input.expectedRevision);
      if (!["pending", "approved"].includes(review.status)) throw new DomainError("INVALID_STATE", "此记录已处理，请先修正或新建候选。", { status: 409 });
      this.snapshot(candidate, review, input.expectedCandidateRevision);
      const updated: EventReview = { ...review, status: input.decision, reason, revision: review.revision + 1,
        reviewedBy: actor.userId, reviewedAt: this.now(), updatedAt: this.now(), checkedKeys: [], acknowledgedUnknownKeys: [] };
      await tx.saveReview(updated, review.revision);
      await this.audit(tx, actor, input.decision === "rejected" ? "candidate_rejected" : "changes_requested", updated, requestId);
      return updated;
    });
  }
  async publish(actor: Actor, reviewId: string, input: { expectedRevision: number; expectedCandidateRevision: number; expectedPublishedVersion: number | null; reason: string }, requestId: string): Promise<EventReview> {
    assertOperationsReviewer(actor);
    positiveVersion(input.expectedRevision);
    positiveVersion(input.expectedCandidateRevision);
    if (input.expectedPublishedVersion !== null) positiveVersion(input.expectedPublishedVersion);
    const reason = text(input.reason, "发布说明");
    return this.dependencies.repository.transaction(async tx => {
      const { review, candidate } = await this.lockCandidateReview(tx, reviewId, input.expectedRevision);
      if (review.status !== "approved" || !review.reviewedAt) throw new DomainError("REVIEW_REQUIRED", "请先完成此候选版本的人工审核。", { status: 409 });
      this.snapshot(candidate, review, input.expectedCandidateRevision);
      checkApproval(candidate, { ...input, checkedKeys: review.checkedKeys, acknowledgedUnknownKeys: review.acknowledgedUnknownKeys });
      if (candidate.currentPublishedVersion !== input.expectedPublishedVersion) conflict(candidate.currentPublishedVersion ?? 0);
      const publication = await this.dependencies.events.publishCandidate(tx, { actor, candidateId: review.candidateId,
        expectedRevision: review.candidateRevision, expectedContentHash: review.contentHash, expectedPublishedVersion: input.expectedPublishedVersion,
        reviewId: review.id, reviewedAt: review.reviewedAt, reason, requestId });
      if (publication.eventId !== review.eventId || !Number.isSafeInteger(publication.publishedVersion) || publication.publishedVersion <= (input.expectedPublishedVersion ?? 0)) {
        throw new DomainError("PUBLICATION_INVALID", "发布服务未返回有效的新版本。", { status: 503 });
      }
      const updated: EventReview = { ...review, status: "published", reason, revision: review.revision + 1,
        publishedVersion: publication.publishedVersion, publishedAt: this.now(), updatedAt: this.now() };
      await tx.saveReview(updated, review.revision);
      await this.audit(tx, actor, "event_published", updated, requestId);
      return updated;
    });
  }
  async withdraw(actor: Actor, input: { eventId: string; expectedPublishedVersion: number; reason: string }, requestId: string): Promise<{ eventId: string; publishedVersion: number }> {
    assertOperationsReviewer(actor);
    const reason = text(input.reason, "撤下原因");
    if (!Number.isSafeInteger(input.expectedPublishedVersion) || input.expectedPublishedVersion < 1) throw new DomainError("INVALID_INPUT", "发布版本无效。");
    return this.dependencies.repository.transaction(async tx => {
      const result = await this.dependencies.events.withdrawEvent(tx, { actor, eventId: input.eventId, expectedPublishedVersion: input.expectedPublishedVersion, reason, requestId });
      if (result.eventId !== input.eventId || result.publishedVersion !== input.expectedPublishedVersion) throw new DomainError("PUBLICATION_INVALID", "撤下服务返回了不匹配的版本。", { status: 503 });
      await tx.appendAudit({ id: this.dependencies.ids.next(), actorId: actor.userId, action: "event_withdrawn", reviewId: null,
        eventId: input.eventId, candidateId: null, revision: input.expectedPublishedVersion, candidateRevision: null,
        contentHash: null, schemaVersion: null, checkedKeys: [], acknowledgedUnknownKeys: [], reason, selfReviewed: false, occurredAt: this.now(), requestId });
      return result;
    });
  }
}
