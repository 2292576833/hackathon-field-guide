import type { Actor, Clock, IdGenerator } from "../../shared/contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";

export type CorrectionStatus = "received" | "triaging" | "confirmed" | "needs_more_info" | "dismissed" | "resolved";
export interface CorrectionTarget {
  readonly kind: "event" | "resource";
  readonly entityId: string;
  readonly version: number;
}
/** The referenced version must be public or formerly public; never private project content. */
export interface PublicCorrectionTargetPort {
  isPublicVersion(tx: SqlExecutor, target: CorrectionTarget): Promise<boolean>;
}
export interface CorrectionOriginal {
  readonly target: CorrectionTarget;
  readonly field: string;
  readonly message: string;
  readonly evidenceUrls: readonly string[];
  readonly submittedAt: string;
}
export interface Correction {
  readonly id: string;
  readonly submittedBy: string;
  readonly original: CorrectionOriginal;
  readonly revision: number;
  readonly status: CorrectionStatus;
  readonly updatedAt: string;
  readonly response: string | null;
  readonly relatedVersion: CorrectionTarget | null;
}
export interface CorrectionTransition {
  readonly id: string;
  readonly correctionId: string;
  readonly revision: number;
  readonly actorId: string;
  readonly fromStatus: CorrectionStatus;
  readonly toStatus: CorrectionStatus;
  readonly reason: string;
  readonly relatedVersion: CorrectionTarget | null;
  readonly occurredAt: string;
  readonly requestId: string;
}
export interface CorrectionTransaction extends SqlExecutor {
  getCorrection(id: string): Promise<Correction | null>;
  insertCorrection(correction: Correction): Promise<void>;
  saveCorrection(correction: Correction, expectedRevision: number): Promise<void>;
  appendTransition(transition: CorrectionTransition): Promise<void>;
}
export interface CorrectionRepository {
  transaction<T>(work: (tx: CorrectionTransaction) => Promise<T>): Promise<T>;
  listOwn(userId: string, limit: number): Promise<readonly Correction[]>;
  listQueue(status: CorrectionStatus | undefined, limit: number): Promise<readonly Correction[]>;
}
export interface CorrectionDependencies {
  readonly repository: CorrectionRepository;
  readonly targets: PublicCorrectionTargetPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}
/** Trusted session actor is provided separately, never accepted from this input. */
export interface SubmitCorrectionInput {
  readonly target: CorrectionTarget;
  readonly field: string;
  readonly message: string;
  readonly evidenceUrls?: readonly string[];
}
export interface ProcessCorrectionInput {
  readonly expectedRevision: number;
  readonly status: CorrectionStatus;
  /** User-visible station response, not an internal log or email message. */
  readonly reason: string;
  readonly relatedVersion?: CorrectionTarget;
}
export type CorrectionActor = Actor;
