/** Cross-module contracts owned by the coordinating session. */
export type EntityId = string;
export type Instant = string;
export type PlatformRole = "user" | "reviewer" | "admin";
export type ProjectRole = "manager" | "member";
export type MembershipStatus = "active" | "left" | "removed";

/** Created from a verified session; never populate directly from request JSON. */
export interface Actor {
  readonly userId: EntityId;
  readonly platformRoles: readonly PlatformRole[];
}

export interface ProjectMembershipAccess {
  readonly membershipId: EntityId;
  readonly projectId: EntityId;
  readonly userId: EntityId;
  readonly role: ProjectRole;
  readonly status: MembershipStatus;
}

/** M02 implements this lookup; private modules must check current membership. */
export interface ProjectAccessPort {
  getMembership(projectId: EntityId, userId: EntityId): Promise<ProjectMembershipAccess | null>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): EntityId;
}

export interface Versioned {
  readonly revision: number;
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface PageResult<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface SuccessEnvelope<T> {
  readonly data: T;
  readonly requestId: string;
}
