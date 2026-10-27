import type { Actor } from "../../shared/contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { FreshSessionGuard } from "../../shared/personal-ai.ts";
import type { SupervisionFacts, SupervisionSettingsInput, SupervisionState } from "./model.ts";

export interface SupervisionFactsPort {
  /** Verify actual account/session, active membership and project; write rejects archive. Lock root facts in root's normal order. */
  authorize(sql: SqlExecutor, actor: Actor, projectId: string, write: boolean, guard?: FreshSessionGuard): Promise<void>;
  /** Same executor, current confirmed own responsibility and effective plan. No queries from this module into other tables. */
  readFacts(sql: SqlExecutor, actor: Actor, projectId: string, guard?: FreshSessionGuard): Promise<SupervisionFacts>;
}
/** Structural subset of the original teamAssistant service; root injects it. */
export interface SupervisionAssistantPort {
  conversation(actor: Actor, projectId: string, guard?: FreshSessionGuard): Promise<{
    revision: number; configured: boolean; provider: "dsh";
    pending: { requestId: string; status: "running" | "unknown" | "failed" | "succeeded" } | null;
  }>;
  send(actor: Actor, projectId: string, input: { message: string; requestId: string; expectedRevision: number }, guard?: FreshSessionGuard): Promise<{
    requestId: string; provider: "dsh"; message: { id: string; role: "user" | "assistant"; content: string; provider: "dsh" | null };
  }>;
}
export interface SupervisionApiClient {
  get(projectId: string, signal?: AbortSignal): Promise<SupervisionState>;
  settings(projectId: string, input: SupervisionSettingsInput): Promise<SupervisionState>;
  check(projectId: string): Promise<SupervisionState>;
}
