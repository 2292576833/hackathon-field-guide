import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { AGENT_IDS, hash } from "../skills/index.ts";
import type { SkillPublicationTarget, SkillReviewSnapshot } from "../skills/publication-types.ts";
import type { SkillReview, SkillReviewAudit, SkillReviewDependencies, SkillReviewDetail, SkillReviewExpectation, SkillReviewStatus, SkillReviewTransaction, SkillReviewVerification } from "./skill-review-types.ts";

function reviewer(actor: Actor): void {
  if (!actor.platformRoles.includes("reviewer") && !actor.platformRoles.includes("admin")) throw new DomainError("OPERATIONS_FORBIDDEN", "需要技能审核权限。", { status: 403 });
}
function text(value: string, label: string, limit = 1000): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new DomainError("INVALID_INPUT", `${label}无效（最多 ${limit} 字）。`);
  return value.trim();
}
function revision(value: number): void { if (!Number.isSafeInteger(value) || value < 1) throw new DomainError("INVALID_INPUT", "版本须为正整数。"); }
function digest(value: string): void { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new DomainError("INVALID_INPUT", "哈希须为完整 SHA-256。"); }
function target(input: SkillPublicationTarget): void {
  if (input.kind !== "skill" && input.kind !== "bundle") throw new DomainError("INVALID_INPUT", "技能审核对象无效。");
  text(input.id, "对象标识", 256); text(input.versionId, "固定版本标识", 256);
}
function expected(input: SkillReviewExpectation): void { revision(input.expectedCandidateRevision); digest(input.expectedContentHash); digest(input.expectedManifestHash); }
function same(a: SkillPublicationTarget, b: SkillPublicationTarget): boolean { return a.kind === b.kind && a.id === b.id && a.versionId === b.versionId; }
function conflict(latest: number): never { throw new DomainError("VERSION_CONFLICT", "技能内容或审核已更新，请重新读取最新版本。", { status: 409, latestRevision: latest, recoveryAction: "review_latest_version" }); }
function matches(snapshot: SkillReviewSnapshot, expectation: SkillReviewExpectation): void {
  if (snapshot.revision !== expectation.expectedCandidateRevision || snapshot.contentHash !== expectation.expectedContentHash || snapshot.manifestHash !== expectation.expectedManifestHash) conflict(snapshot.revision);
}
function reviewMatches(review: SkillReview, expectation: SkillReviewExpectation): boolean { return review.candidateRevision === expectation.expectedCandidateRevision && review.contentHash === expectation.expectedContentHash && review.manifestHash === expectation.expectedManifestHash; }
function source(value: string | null): boolean {
  if (!value) return false;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
}
function checkedAt(value: string | null): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function verify(candidate: SkillReviewSnapshot, input: SkillReviewVerification): void {
  if (candidate.validationErrors.length) throw new DomainError("SKILL_INVALID", "固定来源、清单或证据校验尚未通过。");
  const { license, behavior, compatibility } = candidate.evidence;
  if (license.status !== "verified" || !license.checkedBy || !checkedAt(license.checkedAt) || !license.noticesIncluded || !source(license.sourceUrl) || !license.sha256 || !/^[a-f0-9]{64}$/.test(license.sha256)) throw new DomainError("LICENSE_NOT_VERIFIED", "必须核验本版本许可和必要署名后才能发布。");
  if (behavior.status !== "reviewed" || !behavior.checkedBy || !checkedAt(behavior.checkedAt) || !behavior.note.trim()) throw new DomainError("BEHAVIOR_NOT_REVIEWED", "必须核查本版本的文件、网络和执行行为。");
  if (!input || input.licenseChecked !== true || input.behaviorChecked !== true) throw new DomainError("REVIEW_INCOMPLETE", "请确认已核对许可和行为证据。");
  if (!Array.isArray(input.acknowledgedCompatibility) || new Set(input.acknowledgedCompatibility).size !== input.acknowledgedCompatibility.length || input.acknowledgedCompatibility.some(id => !AGENT_IDS.includes(id))) throw new DomainError("INVALID_INPUT", "兼容限制确认清单无效。");
  for (const entry of compatibility) {
    if (entry.source === "model" && entry.level !== "unknown") throw new DomainError("UNTRUSTED_COMPATIBILITY", "模型描述不能作为支持声明或实测证据。");
    if (["command_verified", "file_install_verified", "client_load_verified", "task_verified"].includes(entry.level) && (!entry.clientVersion || !entry.os || !checkedAt(entry.checkedAt) || !source(entry.evidenceUrl))) throw new DomainError("COMPATIBILITY_EVIDENCE_REQUIRED", "实测记录必须保留客户端、系统、日期和证据。");
  }
  for (const agentId of AGENT_IDS) {
    const verified = compatibility.some(entry => entry.agentId === agentId && entry.level === "task_verified" && entry.source === "platform_test");
    if (!verified && !input.acknowledgedCompatibility.includes(agentId)) throw new DomainError("UNKNOWN_NOT_ACKNOWLEDGED", "请逐项确认未完成平台示例任务验证的工具限制；审核不会提升兼容等级。");
  }
}

/** M08 owns audit and exact review decisions; M10 remains the content/publication owner. */
export class SkillReviewService {
  readonly dependencies: SkillReviewDependencies;
  constructor(dependencies: SkillReviewDependencies) { this.dependencies = dependencies; }
  private now(): string { return this.dependencies.clock.now().toISOString(); }
  private async authorize(tx: SkillReviewTransaction, actor: Actor, requestId: string): Promise<void> { reviewer(actor); await this.dependencies.assertActorCurrent?.(tx, actor, requestId); }
  private async get(tx: SkillReviewTransaction, reviewId: string, lock = true): Promise<SkillReview> {
    const review = await tx.getReview(text(reviewId, "审核标识", 256), lock);
    if (!review) throw new DomainError("NOT_FOUND", "技能审核不存在。", { status: 404 });
    return review;
  }
  private async snapshot(tx: SkillReviewTransaction, value: SkillPublicationTarget): Promise<SkillReviewSnapshot> {
    target(value);
    const candidate = await this.dependencies.skills.readForReview(tx, value);
    if (!candidate) throw new DomainError("NOT_FOUND", "技能候选固定版本不存在。", { status: 404 });
    if (!same(value, candidate)) throw new DomainError("INVALID_SKILL", "技能发布接口返回了不同的版本。");
    revision(candidate.revision); digest(candidate.contentHash); digest(candidate.manifestHash);
    if (!candidate.recordedBy || !["draft", "published", "withdrawn"].includes(candidate.state)) throw new DomainError("INVALID_SKILL", "技能候选状态或录入人无效。");
    return candidate;
  }
  private async lockDetail(tx: SkillReviewTransaction, reviewId: string): Promise<SkillReviewDetail> {
    const peek = await this.get(tx, reviewId, false);
    const candidate = await this.snapshot(tx, peek);
    const review = await this.get(tx, reviewId);
    if (!same(peek, review) || !same(review, candidate) || peek.candidateRevision !== review.candidateRevision) conflict(review.revision);
    return { review, candidate };
  }
  private async audit(tx: SkillReviewTransaction, actor: Actor, action: SkillReviewAudit["action"], review: SkillReview, requestId: string): Promise<void> {
    await tx.appendAudit({ auditId: this.dependencies.ids.next(), action, kind: review.kind, id: review.id, versionId: review.versionId, reviewId: review.reviewId, actorId: actor.userId,
      candidateRevision: review.candidateRevision, contentHash: review.contentHash, manifestHash: review.manifestHash, recordedBy: review.recordedBy, evidence: review.evidence,
      reviewedBy: review.reviewedBy, selfReviewed: review.reviewedBy === review.recordedBy, reviewRevision: review.revision, verification: review.verification, reason: review.reason,
      occurredAt: this.now(), requestId, operationId: null, resultRevision: review.publicationRevision });
  }
  async list(actor: Actor, status?: SkillReviewStatus, limit = 50, requestId = "skill-review-list"): Promise<readonly SkillReview[]> {
    reviewer(actor);
    if (status !== undefined && !["pending", "changes_requested", "approved", "rejected", "published"].includes(status)) throw new DomainError("INVALID_INPUT", "审核状态无效。");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new DomainError("INVALID_INPUT", "查询数量须为 1 到 100。");
    return this.dependencies.repository.transaction(async tx => { await this.authorize(tx, actor, requestId); const result = await tx.listReviews(status, limit); await this.authorize(tx, actor, requestId); return result; });
  }
  async getDetail(actor: Actor, reviewId: string, requestId = "skill-review-read"): Promise<SkillReviewDetail> {
    reviewer(actor); return this.dependencies.repository.transaction(async tx => { await this.authorize(tx, actor, requestId); const detail = await this.lockDetail(tx, reviewId); await this.authorize(tx, actor, requestId); return detail; });
  }
  async register(actor: Actor, value: SkillPublicationTarget, input: SkillReviewExpectation, requestId: string): Promise<SkillReview> {
    reviewer(actor); target(value); expected(input);
    return this.dependencies.repository.transaction(async tx => {
      await this.authorize(tx, actor, requestId);
      const candidate = await this.snapshot(tx, value); matches(candidate, input);
      if (candidate.state !== "draft") throw new DomainError("INVALID_REVIEW_STATE", "只能为待发布的候选版本建立审核。", { status: 409 });
      const existing = await tx.findReview(candidate, candidate.revision);
      if (existing) { if (!reviewMatches(existing, input)) conflict(candidate.revision); await this.authorize(tx, actor, requestId); return existing; }
      const now = this.now();
      const review: SkillReview = { kind: candidate.kind, id: candidate.id, versionId: candidate.versionId, reviewId: this.dependencies.ids.next(), candidateRevision: candidate.revision,
        contentHash: candidate.contentHash, manifestHash: candidate.manifestHash, recordedBy: candidate.recordedBy, evidence: structuredClone(candidate.evidence), revision: 1, status: "pending",
        createdAt: now, updatedAt: now, reviewedBy: null, reviewedAt: null, reason: null, verification: null, publicationRevision: null, publishedAt: null };
      await tx.insertReview(review); await this.audit(tx, actor, "skill_registered", review, requestId); await this.authorize(tx, actor, requestId); return review;
    });
  }
  async decide(actor: Actor, reviewId: string, input: SkillReviewExpectation & { expectedRevision: number; decision: "approved" | "changes_requested" | "rejected"; reason: string; verification?: SkillReviewVerification }, requestId: string): Promise<SkillReview> {
    reviewer(actor); expected(input); revision(input.expectedRevision); const reason = text(input.reason, "审核理由");
    if (!["approved", "changes_requested", "rejected"].includes(input.decision)) throw new DomainError("INVALID_INPUT", "审核结论无效。");
    return this.dependencies.repository.transaction(async tx => {
      await this.authorize(tx, actor, requestId);
      const { review, candidate } = await this.lockDetail(tx, reviewId);
      if (review.revision !== input.expectedRevision) conflict(review.revision);
      matches(candidate, input);
      if (!reviewMatches(review, input) || candidate.recordedBy !== review.recordedBy) conflict(candidate.revision);
      if (candidate.state !== "draft" || !["pending", "changes_requested"].includes(review.status)) throw new DomainError("INVALID_REVIEW_STATE", "该候选或审核已完成，请重新读取最新版本。", { status: 409 });
      if (input.decision === "approved") verify(candidate, input.verification!);
      const now = this.now();
      const updated: SkillReview = { ...review, revision: review.revision + 1, status: input.decision, reviewedBy: actor.userId, reviewedAt: now, updatedAt: now, reason,
        verification: input.decision === "approved" ? structuredClone(input.verification!) : null };
      await tx.saveReview(updated, review.revision);
      await this.audit(tx, actor, input.decision === "approved" ? "skill_approved" : input.decision === "rejected" ? "skill_rejected" : "skill_changes_requested", updated, requestId);
      await this.authorize(tx, actor, requestId);
      return updated;
    });
  }
  async publish(actor: Actor, reviewId: string, input: SkillReviewExpectation & { expectedRevision: number }, requestId: string): Promise<SkillReview> {
    reviewer(actor); expected(input); revision(input.expectedRevision);
    return this.dependencies.repository.transaction(async tx => {
      await this.authorize(tx, actor, requestId);
      const { review, candidate } = await this.lockDetail(tx, reviewId);
      if (candidate.state === "withdrawn") throw new DomainError("SKILL_WITHDRAWN", "该固定版本已撤回，不能由旧审核重新发布。", { status: 409 });
      if (review.status === "published" && reviewMatches(review, input) && [review.revision, review.revision - 1].includes(input.expectedRevision)) {
        if (candidate.state !== "published" || candidate.revision !== review.publicationRevision || candidate.contentHash !== review.contentHash || candidate.manifestHash !== review.manifestHash) conflict(candidate.revision);
        await this.authorize(tx, actor, requestId);
        return review;
      }
      if (review.revision !== input.expectedRevision) conflict(review.revision);
      matches(candidate, input);
      if (!reviewMatches(review, input) || candidate.recordedBy !== review.recordedBy) conflict(candidate.revision);
      if (candidate.state !== "draft" || review.status !== "approved" || !review.verification || !review.reviewedBy || !review.reviewedAt || !review.reason) throw new DomainError("REVIEW_NOT_APPROVED", "请先完成该固定版本的审核。", { status: 409 });
      verify(candidate, review.verification);
      const result = await this.dependencies.skills.publishReviewed(tx, { actor, kind: review.kind, id: review.id, versionId: review.versionId, expectedRevision: review.candidateRevision,
        expectedContentHash: review.contentHash, expectedManifestHash: review.manifestHash, reviewOperationId: `skill-review:${review.reviewId}:publish`, reviewedBy: review.reviewedBy,
        reviewedAt: review.reviewedAt, reason: review.reason, requestId });
      if (!same(result, review) || !Number.isSafeInteger(result.revision) || result.revision < review.candidateRevision || result.contentHash !== review.contentHash) throw new DomainError("INVALID_PUBLICATION_RESULT", "发布未返回该固定版本的有效结果。");
      const now = this.now();
      const updated: SkillReview = { ...review, revision: review.revision + 1, status: "published", publicationRevision: result.revision, publishedAt: now, updatedAt: now };
      await tx.saveReview(updated, review.revision); await this.audit(tx, actor, "skill_published", updated, requestId); await this.authorize(tx, actor, requestId); return updated;
    });
  }
  async withdraw(actor: Actor, value: SkillPublicationTarget, input: SkillReviewExpectation & { operationId: string; reason: string }, requestId: string): Promise<SkillPublicationTarget & { revision: number; contentHash: string }> {
    reviewer(actor); target(value); expected(input); const reason = text(input.reason, "撤回理由"); const operationId = text(input.operationId, "操作标识", 256);
    return this.dependencies.repository.transaction(async tx => {
      await this.authorize(tx, actor, requestId);
      await tx.lockWithdrawal(actor.userId, operationId);
      const previous = await tx.findWithdrawal(actor.userId, operationId);
      if (previous) {
        if (!same(previous, value) || previous.candidateRevision !== input.expectedCandidateRevision || previous.contentHash !== input.expectedContentHash || previous.manifestHash !== input.expectedManifestHash || previous.reason !== reason) throw new DomainError("IDEMPOTENCY_CONFLICT", "该操作标识已用于不同的撤回内容。", { status: 409 });
        await this.authorize(tx, actor, requestId);
        return { ...value, revision: previous.resultRevision!, contentHash: previous.contentHash };
      }
      const candidate = await this.snapshot(tx, value); matches(candidate, input);
      if (candidate.state !== "published") throw new DomainError("SKILL_NOT_PUBLISHED", "该固定版本当前未发布。", { status: 409 });
      const now = this.now();
      const result = await this.dependencies.skills.withdraw(tx, { actor, ...value, expectedRevision: input.expectedCandidateRevision, expectedContentHash: input.expectedContentHash,
        expectedManifestHash: input.expectedManifestHash, reviewOperationId: `skill-withdraw:${hash([actor.userId, operationId])}`, reviewedBy: actor.userId, reviewedAt: now, reason, requestId });
      if (!same(result, value) || !Number.isSafeInteger(result.revision) || result.revision < candidate.revision || result.contentHash !== candidate.contentHash) throw new DomainError("INVALID_PUBLICATION_RESULT", "撤回未返回该固定版本的有效结果。");
      await tx.appendAudit({ auditId: this.dependencies.ids.next(), action: "skill_withdrawn", ...value, reviewId: null, actorId: actor.userId, candidateRevision: candidate.revision,
        contentHash: candidate.contentHash, manifestHash: candidate.manifestHash, recordedBy: candidate.recordedBy, evidence: structuredClone(candidate.evidence), reviewedBy: actor.userId,
        selfReviewed: actor.userId === candidate.recordedBy, reviewRevision: null, verification: null, reason, occurredAt: now, requestId, operationId, resultRevision: result.revision });
      await this.authorize(tx, actor, requestId);
      return result;
    });
  }
}

export function createSkillReviewService(dependencies: SkillReviewDependencies): SkillReviewService { return new SkillReviewService(dependencies); }
