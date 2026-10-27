import type { SqlExecutor } from "../../shared/persistence.ts";
import type { BufferPolicy, PlanningInput, PlanningResourceRef, PlanningTask } from "./types.ts";
import type { TaskProposal } from "./service.ts";

/** Structural match for the root's configured JSON transport; no server or provider imports. */
export interface PlanningJsonModelPort {
  readonly modelVersion: string;
  completeJSON(request: { systemPrompt: string; input: unknown; promptVersion: string; outputExample?: unknown; maxOutputTokens?: number }, signal: AbortSignal): Promise<{
    content: unknown;
    usage: { inputTokens: number; outputTokens: number } | null;
    requestId: string | null;
    modelVersion: string;
  }>;
}
export interface PlanningGenerationCommand {
  goal: string;
  instructions?: string;
  resourceIds: string[];
  buffers: BufferPolicy[];
  expectedTasksRevision: number;
  basePlanVersionId: string | null;
  idempotencyKey: string;
}
export interface PlanningGenerationSnapshot {
  input: PlanningInput;
  tasks: PlanningTask[];
  tasksRevision: number;
  basePlanVersionId: string | null;
  resourceContentRefs: PlanningResourceRef[];
  buffers: BufferPolicy[];
  goal: string;
  instructions: string;
}
export interface GeneratedPlanningProposal {
  tasks: TaskProposal[];
  reason: string;
  assumptions: string[];
}
export interface PlanningGenerationModelPort {
  readonly modelVersion: string;
  readonly promptVersion: string;
  generate(snapshot: PlanningGenerationSnapshot, signal: AbortSignal): Promise<GeneratedPlanningProposal & {
    usage: { inputTokens: number; outputTokens: number } | null;
    requestId: string | null;
    modelVersion: string;
  }>;
}
export type PlanningGenerationStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface PlanningGenerationJob {
  id: string;
  projectId: string;
  actorId: string;
  membershipId: string;
  idempotencyKey: string;
  commandFingerprint: string;
  snapshot: PlanningGenerationSnapshot;
  status: PlanningGenerationStatus;
  revision: number;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  leaseExpiresAt: string | null;
  durationMs: number | null;
  errorCode: string | null;
  resultPlanId: string | null;
  modelVersion: string;
  promptVersion: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  providerRequestId: string | null;
}
export type PlanningGenerationJobSummary = Pick<PlanningGenerationJob, "id" | "projectId" | "actorId" | "revision" | "status" | "createdAt">;
export interface PlanningGenerationTransaction {
  readonly sql: SqlExecutor;
  get(jobId: string): Promise<PlanningGenerationJob | null>;
  findRequest(actorId: string, idempotencyKey: string): Promise<PlanningGenerationJob | null>;
  save(job: PlanningGenerationJob, expectedRevision: number | null): Promise<void>;
}
export interface PlanningGenerationRepository {
  read(jobId: string): Promise<PlanningGenerationJob | null>;
  listForProject(projectId: string, limit: number): Promise<PlanningGenerationJob[]>;
  listQueued(limit: number): Promise<PlanningGenerationJobSummary[]>;
  listRunning(limit: number): Promise<PlanningGenerationJobSummary[]>;
  /** Acquire the planning:<projectId> lock before job rows. Reuse executor for nested planning writes. */
  transaction<T>(projectId: string, work: (transaction: PlanningGenerationTransaction) => Promise<T>): Promise<T>;
}
export interface PlanningGenerationProvenance {
  jobId: string;
  modelVersion: string;
  promptVersion: string;
  assumptions: string[];
  usage: { inputTokens: number; outputTokens: number } | null;
  providerRequestId: string | null;
}
