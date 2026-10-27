import type { Actor, Clock, IdGenerator, ProjectRole } from "../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";

export interface SpaceChangesAccess {
  projectId: string;
  userId: string;
  membershipId: string;
  membershipRevision: number;
  role: ProjectRole;
  archived: boolean;
}
export interface SpaceChangesMember {
  membershipId: string;
  userId: string;
  role: ProjectRole;
  displayName: string;
}
export interface SpaceChangesFacts {
  projectId: string;
  projectRevision: number;
  goal: string;
  minimumDeliverable: string;
  deadline: string | null;
  members: readonly SpaceChangesMember[];
  currentPlan: null | {
    id: string;
    revision: number;
    tasks: readonly { id: string; title: string; ownerUserId: string | null; reviewerUserId: string | null }[];
  };
}
export interface SpaceChangesDependencies {
  database: DatabasePort;
  clock: Clock;
  ids: IdGenerator;
  /** Root validates and locks current account/session/project/membership in this transaction. */
  authorize(sql: SqlExecutor, actor: Actor, projectId: string, write: boolean): Promise<SpaceChangesAccess>;
  /** Only authoritative, authorized project, active members and current effective plan. */
  readFacts(sql: SqlExecutor, access: SpaceChangesAccess): Promise<SpaceChangesFacts>;
}
export type SpaceChangeField = "goal" | "minimumDeliverable" | "deadline" | "task_owner" | "task_reviewer";
export interface SpaceChangeAssignee { userId: string; displayName: string }
export type SpaceChangeValue = string | null | SpaceChangeAssignee;
export interface SpaceChangeSource {
  projectRevision: number;
  planId: string | null;
  planRevision: number | null;
}
export interface SpaceChange {
  id: string;
  projectId: string;
  version: number;
  field: SpaceChangeField;
  taskId: string | null;
  title: string;
  before: SpaceChangeValue;
  after: SpaceChangeValue;
  beforeSummary: string;
  afterSummary: string;
  beforeSource: SpaceChangeSource;
  afterSource: SpaceChangeSource;
  recordedAt: string;
}
export interface SpaceChangeItem extends SpaceChange { acknowledgedAt: string | null }
export interface SpaceChangesList {
  projectId: string;
  userId: string;
  membershipId: string;
  readOnly: boolean;
  checkedAt: string;
  pendingCount: number;
  items: readonly SpaceChangeItem[];
  nextBeforeVersion: number | null;
}
export interface SpaceChangesListOptions { beforeVersion?: number; limit?: number }
export interface SpaceChangesReconciled { projectId: string; baselineCreated: boolean; version: number; changeCount: number }
export interface SpaceChangeAcknowledgement { projectId: string; changeId: string; version: number; acknowledgedAt: string; replayed: boolean }
export interface AcknowledgeSpaceChange { changeId: string; version: number; understood: true }
