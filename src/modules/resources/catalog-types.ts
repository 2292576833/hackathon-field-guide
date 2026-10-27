import type { Actor, Clock, IdGenerator } from "../../shared/contracts.ts";
import type { Resource, ResourceInput } from "./domain.ts";

export interface CatalogEvidence {
  readonly field: "purpose" | "cost" | "license" | "access";
  readonly url: string;
  readonly checkedAt: string;
  readonly note: string;
}
export interface ResourceCatalogEntry {
  readonly candidateKey: string;
  readonly catalogVersion: string;
  readonly verificationDate: string;
  readonly reviewStatus: "candidate";
  readonly input: ResourceInput;
  readonly evidence: readonly CatalogEvidence[];
  readonly remainingChecks: readonly string[];
}
export type CatalogImportStage = "imported" | "submitted_for_review" | "approved" | "published";
export interface ResourceCatalogCheckpoint {
  readonly candidateKey: string;
  readonly catalogVersion: string;
  readonly contentHash: string;
  readonly resourceId: string;
  readonly resourceRevision: number;
  readonly reviewId: string | null;
  readonly reviewRevision: number | null;
  readonly stage: CatalogImportStage;
  readonly importedBy: string;
  readonly importedAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}
/** Bound to the same transaction as M09 content and M08 review services. */
export interface ResourceCatalogCheckpointPort {
  /** Must lock absent keys too, so first imports cannot both create a resource. */
  lock(candidateKey: string): Promise<ResourceCatalogCheckpoint | null>;
  insert(checkpoint: ResourceCatalogCheckpoint): Promise<void>;
  save(checkpoint: ResourceCatalogCheckpoint, expectedRevision: number): Promise<void>;
}

export interface CatalogResourceCommandsPort {
  createDraft(actor: Actor, input: ResourceInput): Promise<Resource>;
  getDraft(actor: Actor, id: string): Promise<Resource>;
  updateDraft(actor: Actor, id: string, expectedRevision: number, input: ResourceInput): Promise<Resource>;
  requestReview(actor: Actor, id: string, expectedRevision: number): Promise<Resource>;
}
export interface CatalogReviewVerification {
  readonly link: {readonly status: "available" | "unavailable"; readonly checkedUrl: string};
  readonly fees: {readonly status: "verified" | "unknown"; readonly sourceUrl: string | null};
  readonly license: {readonly status: "verified" | "unknown"; readonly sourceUrl: string | null};
}
export interface CatalogReviewRecord {
  readonly id: string; readonly resourceId: string; readonly resourceRevision: number;
  readonly revision: number; readonly status: "pending" | "changes_requested" | "approved" | "rejected" | "published";
}
/** Structural subset of M08's public ResourceReviewService; no direct publish bypass. */
export interface CatalogOperationsReviewPort {
  register(actor: Actor, input: {resourceId: string; expectedResourceRevision: number}, requestId: string): Promise<CatalogReviewRecord>;
  decide(actor: Actor, reviewId: string, input: {expectedRevision: number; expectedResourceRevision: number; decision: "approved" | "changes_requested" | "rejected"; reason: string; verification?: CatalogReviewVerification}, requestId: string): Promise<CatalogReviewRecord>;
  publish(actor: Actor, reviewId: string, input: {expectedRevision: number; expectedResourceRevision: number}, requestId: string): Promise<CatalogReviewRecord>;
  getDetail(actor: Actor, reviewId: string): Promise<{review: CatalogReviewRecord}>;
}
export interface CatalogImportScope {
  readonly resources: CatalogResourceCommandsPort;
  readonly reviews: CatalogOperationsReviewPort;
  readonly checkpoints: ResourceCatalogCheckpointPort;
}
export interface ResourceCatalogCliDependencies {
  readonly entries: readonly ResourceCatalogEntry[];
  readonly loadTrustedActor: () => Promise<Actor>;
  readonly clock: Clock;
  readonly requestIds: IdGenerator;
  /** Main session binds all three ports to one executor; rollback errors as a unit. */
  readonly runEach: <T>(work: (scope: CatalogImportScope) => Promise<T>) => Promise<T>;
}
