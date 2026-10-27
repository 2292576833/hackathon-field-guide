import type { SqlExecutor } from "../../shared/persistence.ts";
import type { OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import type { TeamTrackConfiguration } from "./model.ts";

/** Proposed root read authorization; does not confirm a link or grant organizer access. */
export interface EventProjectLinkPreviewPort {
  requireManagerPreview(sql: SqlExecutor, principal: OrganizerPrincipal, input: {
    eventId: string; teamId: string; projectId: string;
  }): Promise<void>;
}
/** Root exposes only officially configured track identities for this event. */
export interface EventTeamTrackPort {
  getConfiguration(sql: SqlExecutor, eventId: string): Promise<TeamTrackConfiguration>;
}
