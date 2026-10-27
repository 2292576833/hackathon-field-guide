import type { Actor, ProjectAccessPort, ProjectMembershipAccess } from "../../shared/contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { AvailabilityWindowInput, AvailabilityWindowSnapshot, Invitation, MemberAvailability, Project, ProjectActivity, ProjectAggregate, ProjectChangeFact, Team, TeamAggregate } from "./model.ts";

export interface ProjectsRepository extends ProjectAccessPort {
  /** Pin a source membership to commit without acquiring another project's write lock. */
  getMembershipForShare?(executor: SqlExecutor, projectId: string, userId: string): Promise<ProjectMembershipAccess | null>;
  createProject(aggregate: ProjectAggregate): Promise<void>;
  createTeam(aggregate: TeamAggregate): Promise<void>;
  /** Locks the scope row until commit; rejected work must roll back every write.
   * Nested calls for different scopes must share the same transaction (team first, project second).
   */
  withProject<T>(projectId: string, work: (aggregate: ProjectAggregate, transaction?: SqlExecutor) => Promise<T>): Promise<T>;
  withTeam<T>(teamId: string, work: (aggregate: TeamAggregate) => Promise<T>): Promise<T>;
  findInvitationByHash(tokenHash: string): Promise<Pick<Invitation, "scopeType" | "scopeId"> | null>;
  listProjects(userId: string): Promise<Project[]>;
  listTeams(userId: string): Promise<Team[]>;
  listActivities(projectId: string, limit: number): Promise<ProjectActivity[]>;
  listPendingFacts(limit: number): Promise<ProjectChangeFact[]>;
  acknowledgeFact(eventId: string): Promise<void>;
}

export interface InvitationTokenPort {
  issue(): { token: string; tokenHash: string };
  hash(token: string): string;
}

/** The email must come from M01's verified identity, never request JSON. */
export interface VerifiedIdentityPort {
  getVerifiedEmail(userId: string): Promise<string | null>;
}

export interface AvailabilityValidationPort {
  validate(input: {
    projectId: string;
    userId: string;
    timezone: string;
    windows: readonly AvailabilityWindowInput[];
    nextRevision: number;
    previous: MemberAvailability | null;
  }): Promise<{ windows: AvailabilityWindowSnapshot[]; effectiveMinutes: number }>;
}

export interface ProjectWorkflowPort {
  /** Must inspect confirmed M05 plans OR actual manual tasks, not a generated draft. */
  hasConfirmedPlanOrManualTasks(projectId: string): Promise<boolean>;
  /** M06 is the unique source. A user-reported record qualifies but is not platform verification. */
  hasSubmissionRecord(projectId: string): Promise<boolean>;
}

export interface ReviewedResourcePort {
  /** Returns a currently reviewed/published resource, or null. Does not copy resource facts. */
  /** With an executor, lock the M09 publication row until M02 commits. A shared DatabasePort
   * with ambient transaction reuse is required when the resource adapter performs extra reads.
   */
  getReviewedResource(resourceId: string, transaction?: SqlExecutor, expectedVersion?: number): Promise<{ id: string; title: string; version: number } | null>;
}

export interface ProjectAdmissionPort {
  /** Only reject using verified event constraints. Called under the project lock to protect capacity. */
  check(input: { actor: Actor; project: Project; activeUserIds: readonly string[]; invitation: Invitation }): Promise<void>;
}

/** Return only currently public facts. Never derive a display name from a private email. */
export interface PublicInvitationDetailsPort {
  getPublicEventName(input: { projectId: string; initialEventId: string | null }, transaction?: SqlExecutor): Promise<string | null>;
  getPublicDisplayName(userId: string, transaction?: SqlExecutor): Promise<string | null>;
}
