import type { SqlExecutor } from "../../shared/persistence.ts";
import type { OrganizerPrincipal, HostedEventScope, EventRosterTeamSnapshot } from "../../shared/organizer-contracts.ts";

/** Root must obtain these facts from M02/M03/M06; never accept them in an HTTP body. */
export interface SubmissionLinkContextPort {
  resolve(sql: SqlExecutor, principal: OrganizerPrincipal, event: HostedEventScope, team: EventRosterTeamSnapshot): Promise<{
    /** Exact current M03 key: linkedEventId:rulesVersion:confirmationRevision. */
    stageId: string; requirementsVersion: string; repositoryCommitSha: string | null;
  } | null>;
}
/** Deliberately no user profile, navigation memory, team assistant or score output. Not invoked by this module. */
export interface JudgingSummaryPort {
  summarize(input: {
    organizationId: string; eventId: string; snapshotId: string;
    materials: import("./model.ts").SubmissionMaterials;
    publishedRules: readonly { text: string; sourceUrl: string; version: number }[];
  }): Promise<{ summary: string; citations: readonly { sourceUrl: string; excerpt: string }[]; provider: "dsh" }>;
}
