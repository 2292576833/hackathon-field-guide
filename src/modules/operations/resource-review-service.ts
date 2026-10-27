import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { ResourceClaim, ResourceReview, ResourceReviewAudit, ResourceReviewDependencies, ResourceReviewSnapshot, ResourceReviewStatus, ResourceReviewTransaction, ResourceVerification } from "./resource-review-types.ts";

function requireReviewer(actor: Actor): void {
  if (!actor.platformRoles.includes("reviewer") && !actor.platformRoles.includes("admin")) {
    throw new DomainError("OPERATIONS_FORBIDDEN", "需要公开内容审核权限。", { status: 403 });
  }
}
function text(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1000) throw new DomainError("INVALID_INPUT", `请填写${label}（最多 1000 字）。`);
  return value.trim();
}
function revision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new DomainError("INVALID_INPUT", "版本必须为正整数。");
}
function conflict(latest: number): never {
  throw new DomainError("VERSION_CONFLICT", "资源或核验已更新，请重新查看最新版本。", { status: 409, latestRevision: latest, recoveryAction: "review_latest_version" });
}
function source(value: string): string {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.href;
  } catch { throw new DomainError("INVALID_SOURCE", "核验来源须为不含账号密码的 HTTP(S) 地址。"); }
}
function assertSnapshot(snapshot: ResourceReviewSnapshot): void {
  revision(snapshot.revision);
  if (!snapshot.resourceId || !snapshot.contentHash || !snapshot.recordedBy) throw new DomainError("INVALID_RESOURCE", "资源标识、内容哈希和录入人必须有效。");
  source(snapshot.officialUrl);
}
function verifyClaim(claim: ResourceClaim, check: ResourceVerification["fees"], label: string): void {
  if (!claim || !check) throw new DomainError("REVIEW_INCOMPLETE", `请核验${label}或明确确认未知。`);
  if (claim.state === "known") {
    if (!claim.sourceUrl || check.status !== "verified" || !check.sourceUrl || source(claim.sourceUrl) !== source(check.sourceUrl)) {
      throw new DomainError("EVIDENCE_REQUIRED", `${label}结论必须核对该版本引用的来源；缺少依据请先改为未确认。`);
    }
  } else if (claim.state === "unknown") {
    if (check.status !== "unknown" || check.sourceUrl !== null) throw new DomainError("UNKNOWN_NOT_ACKNOWLEDGED", `请确认${label}以未确认状态公开显示。`);
  } else throw new DomainError("INVALID_RESOURCE", `${label}状态无效。`);
}
function verify(snapshot: ResourceReviewSnapshot, check: ResourceVerification): void {
  if (snapshot.validationErrors.length) throw new DomainError("RESOURCE_INVALID", "资源结构校验尚未通过。");
  if (!check?.link || check.link.status !== "available" || source(check.link.checkedUrl) !== source(snapshot.officialUrl)) {
    throw new DomainError("LINK_NOT_VERIFIED", "发布前须确认该版本的官方链接可用。");
  }
  verifyClaim(snapshot.fees, check.fees, "费用");
  verifyClaim(snapshot.license, check.license, "许可");
}

/** Reviewer/admin grant public-content operations only; no private-project port is present. */
export class ResourceReviewService {
  readonly dependencies: ResourceReviewDependencies;
  constructor(dependencies: ResourceReviewDependencies) { this.dependencies = dependencies; }
  private now(): string { return this.dependencies.clock.now().toISOString(); }
  private async get(tx: ResourceReviewTransaction, id: string, lock = true): Promise<ResourceReview> {
    const record = await tx.getReview(id, lock);
    if (!record) throw new DomainError("NOT_FOUND", "资源审核记录不存在。", { status: 404 });
    return record;
  }
  private async snapshot(tx: ResourceReviewTransaction, resourceId: string): Promise<ResourceReviewSnapshot> {
    const snapshot = await this.dependencies.resources.readForReview(tx, resourceId);
    if (!snapshot) throw new DomainError("NOT_FOUND", "资源不存在。", { status: 404 });
    assertSnapshot(snapshot);
    if (snapshot.resourceId !== resourceId) throw new DomainError("INVALID_RESOURCE", "资源核验返回了不同标识。");
    return snapshot;
  }
  /** Global row order: M09 resource first, M08 review second. The peek is not authorization. */
  private async lockReviewResource(tx: ResourceReviewTransaction, id: string, observed?: ResourceReview): Promise<{ review: ResourceReview; resource: ResourceReviewSnapshot }> {
    const peek = observed ?? await this.get(tx, id, false);
    const resource = await this.snapshot(tx, peek.resourceId);
    const review = await this.get(tx, id);
    if (review.resourceId !== peek.resourceId || review.resourceRevision !== peek.resourceRevision || review.resourceId !== resource.resourceId) conflict(review.revision);
    return { review, resource };
  }
  private async audit(tx: ResourceReviewTransaction, actor: Actor, action: ResourceReviewAudit["action"], review: ResourceReview, requestId: string): Promise<void> {
    await tx.appendAudit({ id: this.dependencies.ids.next(), actorId: actor.userId, action,
      reviewId: review.id, resourceId: review.resourceId, resourceRevision: review.resourceRevision,
      recordedBy: review.recordedBy, reviewedBy: review.reviewedBy,
      reviewRevision: review.revision, contentHash: review.contentHash, verification: review.verification,
      selfReviewed: review.reviewedBy !== null && review.reviewedBy === review.recordedBy,
      reason: review.reason, occurredAt: this.now(), requestId, operationId: null, publishedVersion: review.publishedVersion });
  }
  async list(actor: Actor, status?: ResourceReviewStatus, limit = 50): Promise<readonly ResourceReview[]> {
    requireReviewer(actor);
    if (status !== undefined && !["pending", "changes_requested", "approved", "rejected", "published"].includes(status)) throw new DomainError("INVALID_INPUT", "审核状态无效。");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new DomainError("INVALID_INPUT", "查询数量须为 1 到 100。");
    return this.dependencies.repository.listReviews(status, limit);
  }
  async getDetail(actor: Actor, reviewId: string): Promise<{ review: ResourceReview; resource: ResourceReviewSnapshot }> {
    requireReviewer(actor);
    return this.dependencies.repository.transaction(async tx => {
      return this.lockReviewResource(tx, reviewId);
    });
  }
  async register(actor: Actor, input: { resourceId: string; expectedResourceRevision: number }, requestId: string): Promise<ResourceReview> {
    requireReviewer(actor); revision(input.expectedResourceRevision);
    return this.dependencies.repository.transaction(async tx => {
      const resource = await this.snapshot(tx, input.resourceId);
      if (resource.revision !== input.expectedResourceRevision) conflict(resource.revision);
      const existing = await tx.findReview(resource.resourceId, resource.revision);
      if (existing) return existing;
      const now = this.now();
      const review: ResourceReview = { id: this.dependencies.ids.next(), resourceId: resource.resourceId,
        resourceRevision: resource.revision, contentHash: resource.contentHash, recordedBy: resource.recordedBy,
        revision: 1, status: "pending", createdAt: now, updatedAt: now, reviewedBy: null, reviewedAt: null,
        verification: null, reason: null, publishedVersion: null, publishedAt: null };
      await tx.insertReview(review);
      await this.audit(tx, actor, "resource_registered", review, requestId);
      return review;
    });
  }
  async decide(actor: Actor, reviewId: string, input: {
    expectedRevision: number; expectedResourceRevision: number;
    decision: "approved" | "changes_requested" | "rejected"; reason: string; verification?: ResourceVerification;
  }, requestId: string): Promise<ResourceReview> {
    requireReviewer(actor); revision(input.expectedRevision); revision(input.expectedResourceRevision);
    const reason = text(input.reason, "审核理由");
    if (!["approved", "changes_requested", "rejected"].includes(input.decision)) throw new DomainError("INVALID_INPUT", "审核结论无效。");
    return this.dependencies.repository.transaction(async tx => {
      const { review, resource } = await this.lockReviewResource(tx, reviewId);
      if (review.revision !== input.expectedRevision) conflict(review.revision);
      if (!["pending", "changes_requested"].includes(review.status)) throw new DomainError("INVALID_REVIEW_STATE", "当前核验已完成，请为新资源版本建立新的核验。", { status: 409 });
      if (resource.revision !== input.expectedResourceRevision || resource.revision !== review.resourceRevision || resource.contentHash !== review.contentHash || resource.recordedBy !== review.recordedBy) conflict(resource.revision);
      if (input.decision === "approved") {
        if (!input.verification) throw new DomainError("REVIEW_INCOMPLETE", "请完成链接、费用与许可核验。");
        verify(resource, input.verification);
      }
      const now = this.now();
      const updated: ResourceReview = { ...review, revision: review.revision + 1, status: input.decision,
        reviewedBy: actor.userId, reviewedAt: now, updatedAt: now, reason,
        verification: input.decision === "approved" ? structuredClone(input.verification!) : null };
      await tx.saveReview(updated, review.revision);
      const action = input.decision === "approved" ? "resource_approved" : input.decision === "rejected" ? "resource_rejected" : "resource_changes_requested";
      await this.audit(tx, actor, action, updated, requestId);
      return updated;
    });
  }
  async publish(actor: Actor, reviewId: string, input: { expectedRevision: number; expectedResourceRevision: number }, requestId: string): Promise<ResourceReview> {
    requireReviewer(actor); revision(input.expectedRevision); revision(input.expectedResourceRevision);
    return this.dependencies.repository.transaction(async tx => {
      const observed = await this.get(tx, reviewId, false);
      // An identical retry after commit returns the recorded success, even if resource advanced later.
      if (observed.status === "published" && input.expectedResourceRevision === observed.resourceRevision && [observed.revision, observed.revision - 1].includes(input.expectedRevision)) return observed;
      const { review, resource } = await this.lockReviewResource(tx, reviewId, observed);
      if (review.status === "published" && input.expectedResourceRevision === review.resourceRevision && [review.revision, review.revision - 1].includes(input.expectedRevision)) return review;
      if (review.revision !== input.expectedRevision) conflict(review.revision);
      if (review.status !== "approved" || !review.verification || !review.reviewedAt || !review.reviewedBy || !review.reason) throw new DomainError("REVIEW_NOT_APPROVED", "请先完成该版本核验。");
      if (resource.revision !== input.expectedResourceRevision || resource.revision !== review.resourceRevision || resource.contentHash !== review.contentHash || resource.recordedBy !== review.recordedBy) conflict(resource.revision);
      verify(resource, review.verification);
      const result = await this.dependencies.resources.publishReviewed(tx, { actor, resourceId: review.resourceId,
        expectedRevision: resource.revision, expectedContentHash: review.contentHash, expectedPublishedVersion: resource.publishedVersion,
        reviewOperationId: `resource-review:${review.id}:publish`, reviewedBy: review.reviewedBy, reviewedAt: review.reviewedAt,
        reason: review.reason, requestId });
      if (result.resourceId !== review.resourceId || !Number.isSafeInteger(result.publishedVersion) || result.publishedVersion <= (resource.publishedVersion ?? 0)) throw new DomainError("INVALID_PUBLICATION_RESULT", "资源发布未返回新的有效版本。");
      const now = this.now();
      const updated: ResourceReview = { ...review, revision: review.revision + 1, status: "published", updatedAt: now,
        publishedAt: now, publishedVersion: result.publishedVersion };
      await tx.saveReview(updated, review.revision);
      await this.audit(tx, actor, "resource_published", updated, requestId);
      return updated;
    });
  }
  async withdraw(actor: Actor, input: { resourceId: string; expectedResourceRevision: number; expectedPublishedVersion: number; operationId: string; reason: string }, requestId: string): Promise<{ resourceId: string; publishedVersion: number }> {
    requireReviewer(actor); revision(input.expectedResourceRevision); revision(input.expectedPublishedVersion);
    const reason = text(input.reason, "下架理由");
    const operationId = text(input.operationId, "操作标识");
    return this.dependencies.repository.transaction(async tx => {
      await tx.lockWithdrawal(actor.userId, operationId);
      const previous = await tx.findWithdrawal(actor.userId, operationId);
      if (previous) {
        if (previous.resourceId !== input.resourceId || previous.resourceRevision !== input.expectedResourceRevision || previous.publishedVersion !== input.expectedPublishedVersion || previous.reason !== reason) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "此操作标识已用于不同的下架内容。", { status: 409 });
        }
        return { resourceId: previous.resourceId, publishedVersion: input.expectedPublishedVersion };
      }
      const resource = await this.snapshot(tx, input.resourceId);
      if (resource.revision !== input.expectedResourceRevision || resource.publishedVersion !== input.expectedPublishedVersion) conflict(resource.revision);
      if (resource.publicationStatus !== "published" && resource.publicationStatus !== "needs_recheck") throw new DomainError("RESOURCE_NOT_PUBLISHED", "该资源当前未上架。");
      const now = this.now();
      const result = await this.dependencies.resources.withdraw(tx, { actor, resourceId: resource.resourceId,
        expectedRevision: resource.revision, expectedPublishedVersion: input.expectedPublishedVersion,
        reviewOperationId: `resource-withdraw:${actor.userId}:${operationId}`, reason, at: now, requestId });
      if (result.resourceId !== resource.resourceId || result.publishedVersion !== input.expectedPublishedVersion) throw new DomainError("INVALID_PUBLICATION_RESULT", "下架操作未确认指定历史版本。");
      await tx.appendAudit({ id: this.dependencies.ids.next(), actorId: actor.userId, action: "resource_withdrawn",
        reviewId: null, resourceId: resource.resourceId, resourceRevision: resource.revision,
        recordedBy: resource.recordedBy, reviewedBy: null, selfReviewed: false, reason, occurredAt: now, requestId,
        reviewRevision: null, contentHash: resource.contentHash, verification: null,
        operationId, publishedVersion: result.publishedVersion });
      return result;
    });
  }
}
