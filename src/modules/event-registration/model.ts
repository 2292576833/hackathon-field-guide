import type { HostedEventScope, EventRegistrationStatus } from "../../shared/organizer-contracts.ts";

export const FIELD_TYPES = ["text", "textarea", "number", "choice", "multichoice", "url"] as const;
export type FieldType = typeof FIELD_TYPES[number];
export interface RegistrationField {
  id: string; type: FieldType; label: string; description: string; required: boolean;
  maxLength?: number; min?: number; max?: number; options?: string[];
}
export interface RegistrationForm {
  eventId: string; revision: number; title: string; description: string;
  fields: RegistrationField[]; changeNote: string; publishedAt: string;
}
export type AnswerValue = string | number | string[];
export type RegistrationAnswers = Record<string, AnswerValue>;
export interface Registration {
  id: string; eventId: string; organizationId: string; userId: string;
  status: EventRegistrationStatus; revision: number; formRevision: number;
  schema: RegistrationForm; answers: RegistrationAnswers;
  reviewNote: string; submittedAt: string | null; reviewedAt: string | null;
  createdAt: string; updatedAt: string;
}
export interface RegistrationFormView { event: HostedEventScope; form: RegistrationForm | null; reservedCount: number }
export interface MyRegistrationView extends RegistrationFormView { registration: Registration | null }
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface SaveFormInput {
  expectedRevision: number; title: string; description: string; fields: RegistrationField[]; changeNote: string;
}
export interface SaveDraftInput { expectedRevision: number; formRevision: number; answers: RegistrationAnswers }
export interface MutationInput { expectedRevision: number; idempotencyKey: string }
export interface ReviewRegistrationInput extends MutationInput { decision: "approved" | "rejected"; note: string }
export interface RosterTeam {
  id: string; eventId: string; organizationId: string; name: string; introduction: string;
  track: string; captainUserId: string; memberUserIds: string[]; revision: number;
  status: "forming" | "locked" | "withdrawn"; projectId: string | null;
  eligible: boolean; lockedRoster: { userId: string; registrationId: string; registrationRevision: number }[] | null;
  lockedAt: string | null; createdAt: string; updatedAt: string;
  lastChangeNote?: string;
}
/** Public projection intentionally has no user IDs, answers, project ID or contacts. */
export interface PublicRosterTeam {
  id: string; eventId: string; name: string; introduction: string; track: string;
  revision: number; memberCount: number; availableSeats: number; status: "forming" | "locked";
}
export interface JoinRequest {
  id: string; eventId: string; teamId: string; userId: string; message: string;
  status: "pending" | "accepted" | "rejected" | "cancelled"; revision: number;
  note: string; createdAt: string; updatedAt: string;
}
export interface TeamsView {
  event: HostedEventScope; ownTeam: RosterTeam | null;
  ownRequests: JoinRequest[]; incomingRequests: JoinRequest[];
  teams: Page<PublicRosterTeam>; registrationStatus: EventRegistrationStatus | null;
  suggestions: TeamSuggestion[];
  trackConfig: TeamTrackConfiguration;
}
export interface TeamTrackConfiguration { configured: boolean; required: boolean; revision: number; options: { id: string; title: string }[] }
export interface CreateTeamInput { name: string; introduction: string; track: string; idempotencyKey: string; suggestionId?: string }
/** Staff suggestions are never roster membership or permission grants. */
export interface TeamSuggestion {
  id: string; eventId: string; captainUserId: string; memberUserIds: string[]; name: string; track: string;
  note: string; createdByUserId: string; createdAt: string; teamId: string | null;
}
export interface ProposeTeamInput { captainUserId: string; memberUserIds: string[]; name: string; track: string; note: string; idempotencyKey: string }
export interface JoinTeamInput { expectedTeamRevision: number; message: string; idempotencyKey: string }
export interface RespondJoinInput extends MutationInput { expectedTeamRevision: number; decision: "accepted" | "rejected"; note: string }
export interface LeaveTeamInput extends MutationInput { successorUserId?: string }
export interface ReopenRosterInput extends MutationInput { note: string }
export interface ProjectLinkRequest {
  id: string; eventId: string; teamId: string; projectId: string; requestedByUserId: string;
  status: "pending" | "confirmed" | "cancelled"; revision: number;
  expectedTeamRevision: number; createdAt: string; confirmedAt: string | null;
}
export interface RequestProjectLinkInput extends MutationInput { projectId: string }
export interface ConfirmProjectLinkInput extends MutationInput { expectedProjectRevision: number; expectedTeamRevision: number }
export interface MyCompetition {
  eventId: string; title: string; organizationName: string; timezone: string;
  startsAt: string; registrationClosesAt: string | null; registrationStatus: EventRegistrationStatus;
  registrationRevision: number; teamId: string | null; teamName: string | null;
}
export interface StaffRegistrationsView { event: HostedEventScope; registrations: Page<Registration>; reservedCount: number }
export interface TeamCandidate { userId: string; registrationId: string; revision: number }
export interface ExportResult { filename: string; contentType: "text/csv; charset=utf-8"; csv: string; count: number }
