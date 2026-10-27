import type { Actor, Clock, IdGenerator, ProjectAccessPort } from "../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";

/** Only the project's currently confirmed M03 rule snapshot may populate this port. */
export interface ConfirmedDeliveryRequirements {
  projectId: string;
  eventId: string;
  requirementsVersion: string;
  confirmedAt: string;
  materialsStatus: "specified" | "unknown";
  materials: { id: string; label: string; necessity: "required" | "optional" | "unknown"; stageId: string | null; evidenceRefs: string[] }[];
  requiredBranch: { status: "specified"; name: string; evidenceRefs: string[] } | { status: "not_required"; evidenceRefs: string[] } | { status: "unknown"; reason: string };
  stages: { id: string; name: string; submissionUrl: string | null; deadline: string | null; deadlineRawText: string | null }[];
  unknowns: string[];
}
export interface ConfirmedDeliveryRequirementsPort {
  /** Inside a mutation, lock and read the confirmation/rules using exactly this executor. No model/network call. */
  readConfirmed(actor: Actor, projectId: string, executor?: SqlExecutor): Promise<ConfirmedDeliveryRequirements | null>;
}
export interface DeliveryMaterialsWriteAccessPort {
  /** Lock and verify the live account/session, active membership, manager capability and non-archived project in this transaction. */
  assertWritable(actor: Actor, projectId: string, executor: SqlExecutor): Promise<void>;
}
export interface MaterialVerification {
  outcome: "passed" | "failed" | "inconclusive";
  verifiedAt: string;
  evidenceRefs: string[];
  note: string;
  verificationSource: "user_reported";
}
export interface DeliveryMaterialEntry {
  requirementId: string;
  location: string | null;
  revision: string | null;
  repositoryCommitSha: string | null;
  verification: (MaterialVerification & { verifiedBy: string }) | null;
}
export interface DeliveryBranchVerification extends MaterialVerification {
  branch: string;
  repositoryCommitSha: string;
  verifiedBy: string;
}
export interface DeliveryMaterialChecklist {
  id: string; projectId: string; version: number;
  eventId: string; requirementsVersion: string;
  repositoryCommitSha: string | null;
  entries: DeliveryMaterialEntry[];
  branchVerification: DeliveryBranchVerification | null;
  recordedBy: string; recordedAt: string;
  idempotencyKey: string; inputHash: string;
}
/** Full replacement. Omitting an old entry removes it from this version, not from history. */
export interface SaveDeliveryMaterialsInput {
  expectedVersion: number | null;
  eventId: string; requirementsVersion: string;
  repositoryCommitSha: string | null;
  entries: (Omit<DeliveryMaterialEntry, "verification"> & { verification: MaterialVerification | null })[];
  branchVerification: Omit<DeliveryBranchVerification, "verifiedBy"> | null;
  idempotencyKey: string;
}
export interface DeliveryMaterialsStorePort {
  getCurrent(projectId: string, executor?: SqlExecutor): Promise<DeliveryMaterialChecklist | null>;
  listHistory(projectId: string): Promise<DeliveryMaterialChecklist[]>;
  findByKey(projectId: string, actorId: string, key: string, executor: SqlExecutor): Promise<DeliveryMaterialChecklist | null>;
  save(record: DeliveryMaterialChecklist, expectedVersion: number | null, executor: SqlExecutor): Promise<void>;
}
export interface DeliveryMaterialsServiceDependencies {
  access: ProjectAccessPort;
  writeAccess: DeliveryMaterialsWriteAccessPort;
  requirements: ConfirmedDeliveryRequirementsPort;
  store: DeliveryMaterialsStorePort;
  database: DatabasePort;
  clock: Clock; ids: IdGenerator;
}
export type MaterialReadiness = "missing" | "prepared" | "unknown" | "failed" | "outdated";
export interface DeliveryMaterialsView {
  requirements: ConfirmedDeliveryRequirements | null;
  current: DeliveryMaterialChecklist | null;
  history: DeliveryMaterialChecklist[];
}
export interface DeliveryMaterialsSummary {
  status: "not_loaded" | "unknown" | "missing" | "needs_review" | "ready";
  requirements: ConfirmedDeliveryRequirements | null;
  checklist: DeliveryMaterialChecklist | null;
  currentCommitSha: string | null;
  branch: { status: "not_verified" | "unknown" | "not_required" | "mismatch" | "matched"; verificationSource: "user_reported" | null; record: DeliveryBranchVerification | null };
  materials: { id: string; label: string; necessity: "required" | "optional" | "unknown"; stageId: string | null; status: MaterialReadiness; entry: DeliveryMaterialEntry | null; evidenceRefs: string[] }[];
  gaps: string[];
  recoveryAction: "review_confirmed_event_requirements";
}
