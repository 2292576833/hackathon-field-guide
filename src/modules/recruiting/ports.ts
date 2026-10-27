import type { Actor } from "../../shared/contracts.ts";
import type { ParticipantProfile } from "../../shared/participant.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";

/** Root locks active verified identity FOR SHARE (never FOR UPDATE); all methods use the supplied transaction. */
export interface RecruitingIdentityPort {
  requireActive(sql: SqlExecutor, actor: Actor): Promise<{ displayName: string }>;
  isActive(sql: SqlExecutor, userId: string): Promise<boolean>;
}
export interface RecruitingParticipantPort { readOwn(sql: SqlExecutor, actor: Actor): Promise<ParticipantProfile> }
export interface RecruitingProjectState { projectId: string; archived: boolean; membership: { membershipId: string; role: "manager" | "member"; status: "active" | "left" | "removed" } | null }
export interface RecruitingProjectsPort {
  /** Lock project FOR UPDATE before membership FOR SHARE, including absent/left membership, until commit. Batch calls must sort projectId. Never require private project membership for a public read. */
  inspect(sql: SqlExecutor, projectId: string, userId: string): Promise<RecruitingProjectState | null>;
  /** Root M02 composition: same transaction, active approver still manager, active applicant, member role only, never reactivates after a consumed join. */
  joinApproved(sql: SqlExecutor, input: { actor: Actor; projectId: string; approvedBy: string; applicationId: string }): Promise<{ membershipId: string; role: "member"; status: "active" }>;
}
/** AI is the shared PersonalAiPort, with kind profile_summary and root-owned persistence/budget/unknown-result hold. */
