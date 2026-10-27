import type { Actor } from "../../shared/contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { Resource, ResourceBookmark, ResourceBookmarkView, ResourceInput, ResourceRecord, ResourceRef, NormalizedResourceQuery } from "./domain.ts";

export interface ApprovedResourceReview {
  id: string; resourceId: string; resourceVersion: number; reviewerId: string;
  checkedAt: string; sourceLinks: readonly string[]; result: "approved";
}
export interface ResourceReviewLookupPort { getApprovedReview(reviewId: string): Promise<ApprovedResourceReview | null> }
export interface ResourcePublicationPort {
  getDraft(actor: Actor, id: string): Promise<Resource>;
  createDraft(actor: Actor, input: ResourceInput): Promise<Resource>;
  updateDraft(actor: Actor, id: string, expectedRevision: number, input: ResourceInput): Promise<Resource>;
  requestReview(actor: Actor, id: string, expectedRevision: number): Promise<Resource>;
  publish(actor: Actor, id: string, expectedRevision: number, reviewId: string): Promise<Resource>;
  withdraw(actor: Actor, id: string, expectedRevision: number, reason: string, blockExternalLink: boolean): Promise<Resource>;
}
export interface ReviewedResourceLookupPort {
  getReviewedResource(id: string, transaction?: SqlExecutor): Promise<{id: string; title: string} | null>;
  getDisplayableApprovedIds(ids: readonly string[], transaction?: SqlExecutor): Promise<readonly string[]>;
  getReviewedResources(ids: readonly string[], transaction?: SqlExecutor): Promise<readonly Resource[]>;
  validateResourceRefs(refs: readonly ResourceRef[], transaction?: SqlExecutor): Promise<readonly ResourceRef[]>;
}
export interface ProjectResourceShareInput {
  projectId: string; resourceId: string; resourceVersion: number; title: string; url: string; purposeNote: string;
}
export interface ResourceShareRequest {
  projectId: string; resourceId: string; resourceVersion: number; purposeNote: string;
}
/** M02 owns the transaction, active membership recheck, version check and idempotent merge. */
export interface ProjectResourceSharePort {
  addReviewedResource(actor: Actor, input: ProjectResourceShareInput): Promise<{id: string; projectId: string}>;
}
export type ResourceCorrectionKind = "broken_link" | "cost" | "license" | "other";
export interface ResourceCorrectionPort {
  submit(actor: Actor | null, input: {resourceId: string; kind: ResourceCorrectionKind; note: string}): Promise<{id: string}>;
}
export interface ResourceUnitOfWork {
  getRecord(id: string, lock?: boolean): Promise<ResourceRecord | null>;
  insertRecord(record: ResourceRecord): Promise<void>;
  saveRecord(record: ResourceRecord, expectedRevision: number): Promise<boolean>;
  putBookmark(bookmark: ResourceBookmark): Promise<ResourceBookmark>;
  getBookmark(id: string, userId: string, lock?: boolean): Promise<ResourceBookmark | null>;
  updateBookmark(bookmark: ResourceBookmark, expectedRevision: number): Promise<boolean>;
  removeBookmark(id: string, userId: string): Promise<void>;
}
export interface ResourceRepository extends ResourceUnitOfWork {
  transaction<T>(work: (unit: ResourceUnitOfWork) => Promise<T>): Promise<T>;
  listPublished(query: NormalizedResourceQuery): Promise<readonly Resource[]>;
  getPublic(id: string): Promise<Resource | null>;
  listBookmarks(userId: string, offset: number, limit: number): Promise<readonly ResourceBookmarkView[]>;
}
