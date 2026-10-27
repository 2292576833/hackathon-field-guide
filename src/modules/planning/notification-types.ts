import type { Actor, Clock, IdGenerator, ProjectMembershipAccess } from "../../shared/contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { PlanningEvent } from "./types.ts";

export type PlanningNotificationCause = "deadline_risk" | "owner_changed" | "availability_changed" | "rules_changed" | "input_changed" | "deliverable_review" | "task_blocked" | "acceptance_correction_requested";
export interface PlanningNotificationFact {
  cause: PlanningNotificationCause;
  /** Deterministic revision of the actual cause, excluding clocks and AI output. */
  sourceRevision: string;
  taskId?: string;
  label?: string;
  /** False for an already-applied arrangement update that can be acknowledged individually. */
  requiresAction?: boolean;
}
export interface PlanningNotificationSnapshot { facts: readonly PlanningNotificationFact[] }
export interface PlanningNotificationProject {
  projectId: string;
  archived: boolean;
  /** Only active project memberships with currently enabled accounts. */
  members: readonly ProjectMembershipAccess[];
}
export interface PlanningNotificationProjectPort {
  /** Protect M02 project, membership and M01 account facts until transaction commit. */
  lockProject(projectId: string, sql: SqlExecutor): Promise<PlanningNotificationProject | null>;
}
export interface PlanningNotificationSnapshotPort {
  /** Read and protect current deterministic risk/input facts; never call a model or apply a plan. */
  readSnapshot(projectId: string, sql: SqlExecutor, now: string): Promise<PlanningNotificationSnapshot>;
}
export interface PlanningNotification {
  id: string;
  projectId: string;
  cause: PlanningNotificationCause;
  sourceRevision: string;
  title: string;
  message: string;
  requiresAction: boolean;
  href: string;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}
export interface PlanningNotificationReceipt {
  notificationId: string;
  userId: string;
  membershipId: string;
  revision: number;
  readAt: string | null;
  dismissedAt: string | null;
  revokedAt: string | null;
}
export interface OwnPlanningNotification extends PlanningNotification {
  revision: number;
  readAt: string | null;
  dismissedAt: string | null;
  status: "active" | "resolved" | "archived";
}
export interface PlanningNotificationTransaction {
  sql: SqlExecutor;
  claimEvents(limit: number): Promise<PlanningEvent[]>;
  completeEvents(events: readonly PlanningEvent[], at: string): Promise<void>;
  list(): Promise<PlanningNotification[]>;
  insert(record: PlanningNotification): Promise<boolean>;
  resolve(id: string, at: string): Promise<void>;
  /** Reuse one cause identity when the actual risk reappears, reviving only unrevoked recipients. */
  reopen(id: string, at: string): Promise<void>;
  ensureRecipient(id: string, member: ProjectMembershipAccess): Promise<boolean>;
  revokeRecipients(members: readonly ProjectMembershipAccess[], at: string): Promise<void>;
  getReceipt(id: string, userId: string): Promise<PlanningNotificationReceipt | null>;
  saveReceipt(record: PlanningNotificationReceipt, expectedRevision: number): Promise<void>;
}
export interface PlanningNotificationRepository {
  pendingProjectIds(limit: number, afterProjectId?: string): Promise<string[]>;
  ownReferences(userId: string, options: { limit: number; projectId?: string; before?: { updatedAt: string; id: string } }): Promise<{ id: string; projectId: string; updatedAt: string }[]>;
  locateOwn(id: string, userId: string): Promise<{ projectId: string } | null>;
  /** Acquire planning:<projectId> before any injected project/fact locks. */
  transaction<T>(projectId: string, work: (tx: PlanningNotificationTransaction) => Promise<T>): Promise<T>;
}
export interface PlanningNotificationDependencies {
  repository: PlanningNotificationRepository;
  projects: PlanningNotificationProjectPort;
  snapshots: PlanningNotificationSnapshotPort;
  clock: Clock;
  ids: IdGenerator;
}
export interface PlanningNotificationHttpDependencies {
  service: Pick<import("./notifications.ts").PlanningNotificationService, "listOwn" | "markRead" | "dismissResolved">;
  resolveActor(request: Request): Promise<Actor | null>;
  authorizeMutation(request: Request): Promise<void>;
  requestIds: IdGenerator;
}
