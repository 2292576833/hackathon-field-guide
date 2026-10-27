export type ShareSourceKind = "navigator" | "space_assistant" | "feasibility" | "manual";
export interface ShareSourceReference { sourceKind: ShareSourceKind; sourceId: string | null }
export interface VerifiedShareSource extends ShareSourceReference {
  /** Fixed by the server; never copied from client source labels. */
  label: string;
  revision: number;
}
export interface TeamSuggestion {
  id: string; projectId: string; authorUserId: string; authorMembershipId: string;
  title: string; body: string; source: VerifiedShareSource;
  status: "discussion" | "adopted" | "withdrawn";
  revision: number; createdAt: string; updatedAt: string;
  adoptedByUserId: string | null; adoptedAt: string | null; withdrawnAt: string | null;
}
export interface TeamSuggestionView extends TeamSuggestion { canEdit: boolean; canWithdraw: boolean; canAdopt: boolean }
/** Metadata-only records returned for withdrawn or unavailable sources. */
export interface UnavailableSuggestion {
  kind: "unavailable"; id: string; authorUserId: string; revision: number;
  status: "withdrawn" | "source_unavailable"; occurredAt: string; canWithdraw: boolean;
}
export interface SuggestionFeedItem { kind: "suggestion"; id: string; occurredAt: string; suggestion: TeamSuggestionView }
/** Root builds this read-only M05 projection; no second progress writes exist. */
export interface TaskActivity {
  kind: "task"; id: string; taskId: string; title: string; actorUserId: string;
  occurredAt: string; status: "todo" | "in_progress" | "blocked" | "review" | "done" | "cancelled";
  note: string; evidenceRefs: string[]; checked: boolean;
}
export type TeamFeedItem = SuggestionFeedItem | UnavailableSuggestion | TaskActivity;
export interface TeamFeedSnapshot {
  projectId: string; membershipId: string; role: "manager" | "member";
  readOnly: boolean; checkedAt: string; items: TeamFeedItem[];
}
export interface PublishSuggestionCommand extends ShareSourceReference {
  title: string; body: string; idempotencyKey: string;
}
export interface EditSuggestionCommand { expectedRevision: number; title: string; body: string; idempotencyKey: string }
export interface SuggestionActionCommand { expectedRevision: number; idempotencyKey: string }
export interface SuggestionReceipt { id: string; revision: number; status: TeamSuggestion["status"]; replayed: boolean }
