import type { Actor } from "../../shared/contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { FreshSessionGuard, PersonalAiPort } from "../../shared/personal-ai.ts";
import type { TeamAssistantContextSnapshot, TeamAssistantMemorySnapshot } from "./model.ts";

/** Runner failures should expose this safe state, without provider payloads. Unclassified errors are held as unknown. */
export interface TeamAssistantRunnerFailure { code: string; externalState: "not_sent" | "rejected" | "response_received" | "unknown" }

export interface TeamAssistantContextPort {
  read(actor: Actor, projectId: string, sql: SqlExecutor): Promise<TeamAssistantContextSnapshot>;
  /** Recheck active membership, archive protection and the semantic fingerprint in this transaction. */
  assertCurrent(actor: Actor, snapshot: TeamAssistantContextSnapshot, sql: SqlExecutor): Promise<void>;
}
export interface TeamAssistantMemoryPort {
  select(actor: Actor, input: { projectId: string; question: string; maxItems: number; maxBytes: number }, sql: SqlExecutor): Promise<TeamAssistantMemorySnapshot>;
  /** Recheck ownership, current source-project permissions, revisions and selected content. */
  assertCurrent(actor: Actor, snapshot: TeamAssistantMemorySnapshot, sql: SqlExecutor): Promise<void>;
}
export interface TeamAssistantDshRequest<T> {
  projectId: string;
  /** Persisted semantic identity; never change to bypass an unknown request. */
  requestIdentity: unknown;
  systemPrompt: string;
  input: unknown;
  promptVersion: string;
  outputExample: unknown;
  maxOutputTokens: number;
  validate(value: unknown): T;
  /** Runner MUST invoke inside its final success transaction, before committing. */
  finalGuard: FreshSessionGuard;
}
export interface TeamAssistantDshRunnerPort {
  readonly configured: boolean;
  /** Root owns DSH-only provider, budget/rate ledger, lease, unknown holds, and current session checks. No fallback or blind resend. */
  run<T>(actor: Actor, request: TeamAssistantDshRequest<T>, guard?: FreshSessionGuard): Promise<{
    executionId: string; provider: "dsh"; data: T;
  }>;
}
export interface TeamAssistantPorts {
  context: TeamAssistantContextPort;
  memory: TeamAssistantMemoryPort;
  runner: TeamAssistantDshRunnerPort;
  personalAi: PersonalAiPort;
}
