import type { Instant, MembershipStatus, ProjectRole } from "../../shared/contracts.ts";

export type ProjectStage = "draft" | "preparing" | "active" | "finalizing" | "submitted" | "retrospective" | "archived";
export type TeamRole = "captain" | "member";
export type InvitationStatus = "pending" | "accepted" | "revoked";

export interface Project {
  id: string;
  name: string;
  teamId: string | null;
  /** Unconfirmed initial selection. M03's confirmation pointer is the authoritative event/rules link. */
  eventId: string | null;
  createdBy: string;
  goal: string;
  minimumDeliverable: string;
  stage: ProjectStage;
  timezone: string;
  deadline: Instant | null;
  deadlineSource: "member_entered" | "unknown";
  revision: number;
  createdAt: Instant;
  updatedAt: Instant;
}

export interface ProjectMember {
  membershipId: string;
  projectId: string;
  userId: string;
  role: ProjectRole;
  status: MembershipStatus;
  revision: number;
  joinedAt: Instant;
  leftAt: Instant | null;
}

export interface Team {
  id: string;
  name: string;
  createdBy: string;
  status: "active" | "dissolved";
  revision: number;
  createdAt: Instant;
  updatedAt: Instant;
}

export interface TeamMember {
  membershipId: string;
  teamId: string;
  userId: string;
  role: TeamRole;
  status: MembershipStatus;
  revision: number;
  joinedAt: Instant;
  leftAt: Instant | null;
}

/** Only the hash is persisted. A consumed invitation can never re-activate membership. */
export interface Invitation {
  id: string;
  scopeType: "project" | "team";
  scopeId: string;
  tokenHash: string;
  role: ProjectRole | TeamRole;
  invitedEmail: string | null;
  createdBy: string;
  createdAt: Instant;
  expiresAt: Instant;
  status: InvitationStatus;
  acceptedBy: string | null;
  acceptedAt: Instant | null;
  revokedAt: Instant | null;
  revision: number;
  /** Optional only for legacy fixtures. Persistence normalizes missing values to one use. */
  maxUses?: number;
  usedUses?: number;
  /** Private immutable quota consumers. Never return through an invitation DTO. */
  acceptances?: InvitationAcceptance[];
}
export interface InvitationAcceptance {
  invitationId: string;
  userId: string;
  /** Actual membership used by this join. Null means the legacy acceptance did not record it. */
  membershipId: string | null;
  acceptedAt: Instant;
}
export type PublicInvitation = Omit<Invitation, "tokenHash" | "acceptances" | "maxUses" | "usedUses"> & { displayStatus: InvitationStatus | "expired"; maxUses: number; usedUses: number; remainingUses: number };

/** A valid recipient can inspect the intended scope before joining, without private roster/email data. */
export interface InvitationPreview {
  scopeType: "project" | "team";
  scopeId: string;
  scopeName: string;
  requestedRole: ProjectRole | TeamRole;
  currentRole: ProjectRole | TeamRole | null;
  expiresAt: Instant;
  alreadyMember: boolean;
  alreadyAccepted: boolean;
  maxUses: number;
  usedUses: number;
  remainingUses: number;
}

/** A high-entropy invitation token permits this minimal landing-page preview only. */
export interface PublicSpaceInvitationPreview {
  status: "pending" | "expired" | "revoked" | "used" | "unavailable";
  scopeType: "project" | "team" | null;
  scopeName: string | null;
  eventName: string | null;
  inviterDisplayName: string | null;
  requestedRole: ProjectRole | TeamRole | null;
  expiresAt: Instant | null;
  maxUses: number | null;
  usedUses: number | null;
  remainingUses: number | null;
}
export type PublicInvitationPreview = PublicSpaceInvitationPreview;

/** M05 validates and computes these windows; M02 owns their versioned collection. */
export interface AvailabilityWindowInput {
  id: string;
  startsAt: Instant;
  endsAt: Instant;
  effectiveMinutes: number;
}

export interface AvailabilityWindowSnapshot extends AvailabilityWindowInput {
  revision: number;
}

export interface MemberAvailability {
  id: string;
  projectId: string;
  userId: string;
  timezone: string;
  windows: AvailabilityWindowSnapshot[];
  effectiveMinutes: number;
  confirmedAt: Instant;
  revision: number;
  /** A rejoin or role change requires confirming availability again. */
  membershipRevision: number;
}

export interface ProjectResourceBookmark {
  id: string;
  projectId: string;
  resourceId: string | null;
  /** Content version explicitly shared; a member URL has no reviewed resource version. */
  resourceVersion: number | null;
  url: string | null;
  title: string;
  purposeNote: string;
  savedBy: string;
  savedAt: Instant;
  status: "active" | "removed";
  sourceStatus: "reviewed_resource" | "member_reference_unverified";
  revision: number;
}

export interface ProjectActivity {
  id: string;
  projectId: string;
  actorId: string;
  type: string;
  objectId: string;
  beforeSummary: Record<string, unknown>;
  afterSummary: Record<string, unknown>;
  occurredAt: Instant;
  revision: number;
}

export type ProjectFactType = "ProjectCreated" | "ProjectScopeChanged" | "ProjectMemberJoined" | "ProjectMemberLeft" | "ProjectMemberRoleChanged" | "MemberAvailabilityChanged" | "ProjectStageChanged" | "ProjectResourceBookmarked" | "MemberIntentionChanged" | "ProjectTrackSelectionChanged";

/** Persisted with the mutation. Consumers acknowledge facts after their own idempotent handling. */
export interface ProjectChangeFact {
  eventId: string;
  type: ProjectFactType;
  aggregateId: string;
  projectId: string;
  actorId: string;
  version: number;
  occurredAt: Instant;
  payload: Record<string, unknown>;
}

export interface ProjectAggregate {
  project: Project;
  members: ProjectMember[];
  invitations: Invitation[];
  availability: MemberAvailability[];
  bookmarks: ProjectResourceBookmark[];
  /** New append-only records for the current transaction; not the complete history. */
  activities: ProjectActivity[];
  facts: ProjectChangeFact[];
}

export interface TeamAggregate {
  team: Team;
  members: TeamMember[];
  invitations: Invitation[];
}
