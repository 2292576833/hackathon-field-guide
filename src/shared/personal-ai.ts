import type { Actor } from "./contracts.ts";
import type { SqlExecutor } from "./persistence.ts";

export type PersonalArtifactKind = "participation_plan" | "roadshow" | "ppt" | "profile_summary" | "project_feasibility" | "space_assistant_reply";
export interface PersonalArtifact<T = unknown> {
  id: string; kind: PersonalArtifactKind; title: string; data: T;
  createdAt: string; provider: "dsh"; sessionId: string;
}
export type FreshSessionGuard = (sql: SqlExecutor) => Promise<void>;
export interface PersonalGenerationRequest<T> {
  kind: PersonalArtifactKind; title: string; input: unknown; systemPrompt: string;
  /** Server-owned semantic input; excludes read timestamps and weather refreshes. */
  requestIdentity?: unknown;
  promptVersion: string; outputExample: unknown; maxOutputTokens?: number;
  validate(value: unknown): T;
}
/** Only the coordinating server supplies a budgeted DSH model and private storage. */
export interface PersonalAiPort {
  generate<T>(actor: Actor, request: PersonalGenerationRequest<T>, guard?: FreshSessionGuard): Promise<PersonalArtifact<T>>;
  list(actor: Actor, kind: PersonalArtifactKind, guard?: FreshSessionGuard): Promise<PersonalArtifact[]>;
  get(actor: Actor, id: string, guard?: FreshSessionGuard): Promise<PersonalArtifact>;
}
