import type { Actor, Clock, IdGenerator } from "../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { AgentId, Skill, TrackBundle } from "./domain.ts";

export interface SkillPublicationTarget { kind: "skill" | "bundle"; id: string; versionId: string }
/** Each stage describes only its recorded environment; it never implies a later stage. */
export interface SkillCompatibilityEvidence {
  agentId: AgentId;
  level: "unknown" | "installer_declared" | "command_verified" | "file_install_verified" | "client_load_verified" | "task_verified" | "failed";
  source: "official_documentation" | "platform_test" | "user_reported" | "model";
  clientVersion: string | null; os: string | null; checkedAt: string | null;
  evidenceUrl: string | null; task: string | null; limitation: string;
  /** For bundles, a joint test must cover every required fixed version in one environment. */
  requiredVersionIds?: readonly string[];
}
export interface SkillCandidateEvidence {
  license: { status: "verified" | "unknown"; sourceUrl: string | null; sha256: string | null; checkedBy: string | null; checkedAt: string | null; noticesIncluded: boolean };
  behavior: { status: "reviewed" | "unknown"; checkedBy: string | null; checkedAt: string | null; note: string };
  compatibility: readonly SkillCompatibilityEvidence[];
}
export type SkillCandidateDocument = { kind: "skill"; skill: Skill } | { kind: "bundle"; bundle: TrackBundle };
export interface SkillCandidate extends SkillPublicationTarget {
  revision: number; contentHash: string; manifestHash: string;
  document: SkillCandidateDocument; evidence: SkillCandidateEvidence;
  state: "draft" | "published" | "withdrawn"; recordedBy: string; recordedAt: string;
  resolvedSkillHashes?: readonly { versionId: string; contentHash: string; licenseHash: string }[];
}
export interface SkillReviewSnapshot extends SkillCandidate { validationErrors: readonly string[] }
export interface SkillPublicationInput extends SkillPublicationTarget {
  actor: Actor; expectedRevision: number; expectedContentHash: string; expectedManifestHash: string;
  reviewOperationId: string; reviewedBy: string; reviewedAt: string; reason: string; requestId: string;
}
/** All methods use the M08 transaction executor. Lock order: candidate, bundle, sorted skills, review. */
export interface SkillPublicationPort {
  readForReview(tx: SqlExecutor, target: SkillPublicationTarget): Promise<SkillReviewSnapshot | null>;
  publishReviewed(tx: SqlExecutor, input: SkillPublicationInput): Promise<SkillPublicationTarget & { revision: number; contentHash: string }>;
  withdraw(tx: SqlExecutor, input: SkillPublicationInput): Promise<SkillPublicationTarget & { revision: number; contentHash: string }>;
}
export interface SkillCandidateDependencies { database: DatabasePort; clock: Clock; ids: IdGenerator; assertActorCurrent?(tx: SqlExecutor, actor: Actor): Promise<void> }
