import { createHash } from "node:crypto";
import type { Actor, Clock, IdGenerator } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { Resource } from "./domain.ts";
import { resourceInstant, resourceText, resourceUrl } from "./domain.ts";
import { createResourceRepositoryInTransaction } from "./postgres.ts";
import { ResourceService } from "./service.ts";

const contentFields = ["name", "officialUrl", "type", "stageTags", "useTags", "stackTags", "prerequisites", "summary", "suitableFor", "notSuitableFor", "quickStart", "costType", "costNote", "costSourceUrl", "costVerifiedAt", "licenseStatus", "licenseNote", "licenseSourceUrl", "licenseVerifiedAt", "verifiedAt", "linkStatus", "displayOrder", "version", "recordedBy"] as const;
export function resourceContentHash(resource: Resource): string {
  return hash(Object.fromEntries(contentFields.map(key => [key, resource[key]])));
}
function hash(input: unknown): string { return createHash("sha256").update(JSON.stringify(input)).digest("hex"); }
interface ReviewVerification {
  readonly link: {readonly status: "available" | "unavailable"; readonly checkedUrl: string};
  readonly fees: {readonly status: "verified" | "unknown"; readonly sourceUrl: string | null};
  readonly license: {readonly status: "verified" | "unknown"; readonly sourceUrl: string | null};
}
/** Structural view of M08's owned review record. No M08 table is read by M09. */
export interface OperationsResourceReview {
  readonly id: string; readonly resourceId: string; readonly resourceRevision: number; readonly contentHash: string;
  readonly status: string; readonly reviewedBy: string | null; readonly reviewedAt: string | null;
  readonly reason: string | null; readonly verification: ReviewVerification | null;
}
export interface OperationsResourceReviewSnapshot {
  readonly resourceId: string; readonly revision: number; readonly contentHash: string; readonly recordedBy: string;
  readonly officialUrl: string; readonly publicationStatus: "draft" | "pending_review" | "published" | "needs_recheck" | "withdrawn";
  readonly validationErrors: readonly string[];
  readonly fees: {readonly state: "known" | "unknown"; readonly sourceUrl: string | null};
  readonly license: {readonly state: "known" | "unknown"; readonly sourceUrl: string | null};
  readonly publishedVersion: number | null;
}
interface PublishInput {
  readonly actor: Actor; readonly resourceId: string; readonly expectedRevision: number; readonly expectedContentHash: string;
  readonly expectedPublishedVersion: number | null; readonly reviewOperationId: string; readonly reviewedBy: string;
  readonly reviewedAt: string; readonly reason: string; readonly requestId: string;
}
interface WithdrawInput {
  readonly actor: Actor; readonly resourceId: string; readonly expectedRevision: number; readonly expectedPublishedVersion: number;
  readonly reviewOperationId: string; readonly reason: string; readonly at: string; readonly requestId: string;
}
type PublicationResult = {readonly resourceId: string; readonly publishedVersion: number};
/** Structurally compatible with M08 ResourcePublicationPort; same SqlExecutor/commit. */
export interface OperationsResourcePublicationPort {
  readForReview(tx: SqlExecutor, resourceId: string): Promise<OperationsResourceReviewSnapshot | null>;
  publishReviewed(tx: SqlExecutor, input: PublishInput): Promise<PublicationResult>;
  withdraw(tx: SqlExecutor, input: WithdrawInput): Promise<PublicationResult>;
}
export interface OperationsResourceAdapterDependencies {
  clock: Clock;
  ids: IdGenerator;
  /** Coordinator delegates to M08 tx.getReview(reviewId), preserving its lock. */
  readReview(tx: SqlExecutor, reviewId: string): Promise<OperationsResourceReview | null>;
}
function authorized(actor: Actor): void {
  if (!actor?.userId || !actor.platformRoles.some(role => role === "reviewer" || role === "admin")) throw new DomainError("RESOURCE_REVIEW_FORBIDDEN", "资源发布需要运营审核权限。", {status: 403});
}
function scopedRepository(tx: SqlExecutor) {
  return createResourceRepositoryInTransaction(tx);
}
function conflict(latest: number): never {
  throw new DomainError("VERSION_CONFLICT", "资源已更新，请重新核验当前草稿。", {status: 409, latestRevision: latest, recoveryAction: "review_latest_version"});
}
function sameSource(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  try { return resourceUrl(left) === resourceUrl(right); } catch { return false; }
}

export function createOperationsResourcePublicationAdapter(deps: OperationsResourceAdapterDependencies): OperationsResourcePublicationPort {
  async function replay(tx: SqlExecutor, operationId: string, inputHash: string): Promise<PublicationResult | null> {
    resourceText(operationId, "发布操作 ID", 1000);
    // Transaction-level lock serializes retries even when the operation is first seen.
    const lockKey = BigInt.asIntN(64, BigInt(`0x${hash(operationId).slice(0, 16)}`)).toString();
    await tx.query("SELECT pg_advisory_xact_lock($1::bigint)", [lockKey]);
    const result = await tx.query<{input_hash: string; result: PublicationResult}>("SELECT input_hash, result FROM resource_publication_operations WHERE operation_id = $1", [operationId]);
    if (!result.rows[0]) return null;
    if (result.rows[0].input_hash !== inputHash) throw new DomainError("IDEMPOTENCY_KEY_REUSED", "同一发布操作不能用于不同内容。", {status: 409});
    return result.rows[0].result;
  }
  async function recordResult(tx: SqlExecutor, operationId: string, inputHash: string, result: PublicationResult, eventType: "ResourcePublished" | "ResourceWithdrawn", at: string) {
    await tx.query("INSERT INTO resource_publication_operations (operation_id, input_hash, result, occurred_at) VALUES ($1, $2, $3::jsonb, $4)", [operationId, inputHash, JSON.stringify(result), at]);
    await tx.query("INSERT INTO resource_notifications (id, event_type, resource_id, resource_version, occurred_at) VALUES ($1, $2, $3, $4, $5)", [deps.ids.next(), eventType, result.resourceId, result.publishedVersion, at]);
  }
  return {
    async readForReview(tx, resourceId) {
      resourceText(resourceId, "资源 ID", 200);
      const record = await scopedRepository(tx).getRecord(resourceId, true);
      if (!record) return null;
      const resource = record.resource;
      const publicationStatus = record.publicResource?.publicationStatus === "published" && resource.publicationStatus !== "published" ? "needs_recheck"
        : resource.publicationStatus === "in_review" ? "pending_review" : resource.publicationStatus;
      return {resourceId, revision: resource.revision, contentHash: resourceContentHash(resource), recordedBy: resource.recordedBy,
        officialUrl: resource.officialUrl, publicationStatus, validationErrors: resource.publicationStatus === "draft" ? ["请先提交当前草稿进行审核。"] : [],
        fees: {state: resource.costType === "unknown" ? "unknown" : "known", sourceUrl: resource.costType === "unknown" ? null : resource.costSourceUrl},
        license: {state: resource.licenseStatus === "unknown" ? "unknown" : "known", sourceUrl: resource.licenseStatus === "unknown" ? null : resource.licenseSourceUrl},
        publishedVersion: record.publicResource?.version ?? null};
    },
    async publishReviewed(tx, input) {
      authorized(input.actor);
      resourceText(input.reason, "审核理由", 1000);
      resourceText(input.requestId, "请求 ID", 200);
      const inputHash = hash({kind: "publish", actorId: input.actor.userId, resourceId: input.resourceId, expectedRevision: input.expectedRevision,
        expectedContentHash: input.expectedContentHash, expectedPublishedVersion: input.expectedPublishedVersion,
        reviewedBy: input.reviewedBy, reviewedAt: input.reviewedAt, reason: input.reason});
      const replayed = await replay(tx, input.reviewOperationId, inputHash);
      if (replayed) return replayed;
      const repository = scopedRepository(tx);
      const record = await repository.getRecord(input.resourceId, true);
      if (!record) throw new DomainError("RESOURCE_NOT_FOUND", "未找到资源。", {status: 404});
      if (record.resource.revision !== input.expectedRevision || resourceContentHash(record.resource) !== input.expectedContentHash || (record.publicResource?.version ?? null) !== input.expectedPublishedVersion) conflict(record.resource.revision);
      const match = /^resource-review:(.+):publish$/.exec(input.reviewOperationId);
      if (!match) throw new DomainError("INVALID_REVIEW_OPERATION", "发布需要绑定 M08 审核记录。");
      const reviewId = match[1];
      const review = await deps.readReview(tx, reviewId);
      if (!review || review.id !== reviewId || review.status !== "approved" || review.resourceId !== input.resourceId || review.resourceRevision !== input.expectedRevision || review.contentHash !== input.expectedContentHash || review.reviewedBy !== input.reviewedBy || review.reviewedAt !== input.reviewedAt || review.reason !== input.reason || !review.verification || review.verification.link.status !== "available" || !sameSource(review.verification.link.checkedUrl, record.resource.officialUrl)) {
        throw new DomainError("RESOURCE_REVIEW_REQUIRED", "发布操作未匹配当前版本的真实审核记录。", {status: 409});
      }
      const current = record.resource;
      if (current.costType === "unknown" ? review.verification.fees.status !== "unknown" || review.verification.fees.sourceUrl !== null
        : review.verification.fees.status !== "verified" || !sameSource(review.verification.fees.sourceUrl, current.costSourceUrl)) throw new DomainError("RESOURCE_REVIEW_REQUIRED", "审核费用状态与当前内容不一致。", {status: 409});
      if (current.licenseStatus === "unknown" ? review.verification.license.status !== "unknown" || review.verification.license.sourceUrl !== null
        : review.verification.license.status !== "verified" || !sameSource(review.verification.license.sourceUrl, current.licenseSourceUrl)) throw new DomainError("RESOURCE_REVIEW_REQUIRED", "审核许可状态与当前内容不一致。", {status: 409});
      const service = new ResourceService({repository, clock: deps.clock, ids: deps.ids, reviews: {async getApprovedReview() {
        return {id: reviewId, resourceId: current.id, resourceVersion: current.version, reviewerId: review.reviewedBy!, checkedAt: review.reviewedAt!, result: "approved",
          sourceLinks: [review.verification!.link.checkedUrl, review.verification!.fees.sourceUrl, review.verification!.license.sourceUrl].filter((url): url is string => url !== null)};
      }}});
      const resource = await service.publish(input.actor, input.resourceId, input.expectedRevision, reviewId);
      const result = {resourceId: resource.id, publishedVersion: resource.version};
      await recordResult(tx, input.reviewOperationId, inputHash, result, "ResourcePublished", resource.publishedAt!);
      return result;
    },
    async withdraw(tx, input) {
      authorized(input.actor);
      const reason = resourceText(input.reason, "下架理由", 1000);
      resourceText(input.requestId, "请求 ID", 200);
      const at = resourceInstant(input.at, "下架时间", deps.clock.now());
      if (!at) throw new DomainError("INVALID_RESOURCE_TIME", "下架需要操作时间。");
      const inputHash = hash({kind: "withdraw", actorId: input.actor.userId, resourceId: input.resourceId, expectedRevision: input.expectedRevision, expectedPublishedVersion: input.expectedPublishedVersion, reason});
      const replayed = await replay(tx, input.reviewOperationId, inputHash);
      if (replayed) return replayed;
      const repository = scopedRepository(tx);
      const record = await repository.getRecord(input.resourceId, true);
      if (!record) throw new DomainError("RESOURCE_NOT_FOUND", "未找到资源。", {status: 404});
      if (record.resource.revision !== input.expectedRevision || record.publicResource?.version !== input.expectedPublishedVersion) conflict(record.resource.revision);
      const service = new ResourceService({repository, clock: {now: () => new Date(at)}, ids: deps.ids, reviews: {getApprovedReview: async () => null}});
      // M08's current port has no risk flag. Withheld links remain blocked until a fresh publication.
      const resource = await service.withdraw(input.actor, input.resourceId, input.expectedRevision, reason, true);
      const result = {resourceId: resource.id, publishedVersion: resource.version};
      await recordResult(tx, input.reviewOperationId, inputHash, result, "ResourceWithdrawn", at);
      return result;
    },
  };
}
