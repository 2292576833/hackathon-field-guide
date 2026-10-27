import type { Actor } from "../../shared/contracts.ts";
import type { DeliveryService } from "./delivery-service.ts";
import type { GitService } from "./git-service.ts";
import { summarizeDeliveryMaterials } from "./delivery-materials-service.ts";
import type { DeliveryMaterialsService } from "./delivery-materials-service.ts";

/** The three columns retain their individual evidence and never infer one another. */
export async function getDeliverySummary(actor: Actor, projectId: string, services: { git: GitService; delivery: DeliveryService; materials?: DeliveryMaterialsService }) {
  const [operations, verifications, submissions, materialView] = await Promise.all([
    services.git.listOperations(actor, projectId), services.delivery.listVerifications(actor, projectId), services.delivery.listSubmissions(actor, projectId),
    services.materials ? services.materials.read(actor, projectId) : Promise.resolve({ requirements: null, current: null }),
  ]);
  const ordered = [...operations].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const latestOperation = ordered[0] ?? null;
  const latestSavedOperation = ordered.find(operation => operation.status === "saved") ?? null;
  const currentCommitSha = latestSavedOperation?.commitSha || null;
  const verificationHistory = [...verifications].sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt) || b.id.localeCompare(a.id));
  const latestHistoricalVerification = verificationHistory[0] ?? null;
  // A historical or unversioned demonstration never certifies a different saved commit.
  const latestVerification = currentCommitSha === null ? null : verificationHistory.find(
    verification => verification.repositoryCommitSha?.toLowerCase() === currentCommitSha.toLowerCase(),
  ) ?? null;
  const latest = new Map<string, typeof submissions[number]>();
  for (const record of submissions) if (!latest.has(record.id) || latest.get(record.id)!.version < record.version) latest.set(record.id, record);
  const requirements = summarizeDeliveryMaterials(materialView, currentCommitSha);
  return {
    projectId,
    repository: { status: latestOperation?.status ?? "not_saved", latestOperation, latestSavedOperation, mergeStatus: requirements.branch.status === "unknown" ? "not_verified" : requirements.branch.status, branchVerificationSource: requirements.branch.verificationSource },
    runtime: {
      status: currentCommitSha === null ? "unknown" : latestVerification?.outcome ?? "not_verified",
      currentCommitSha,
      matchStatus: currentCommitSha === null ? "no_saved_commit" as const : latestVerification === null ? "no_matching_verification" as const : "matched" as const,
      latestVerification, latestHistoricalVerification, verificationHistory,
    },
    submission: { records: [...latest.values()], platformConfirmationAvailable: false as const },
    requirements,
  };
}
