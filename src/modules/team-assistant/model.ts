export interface AssistantLink { id: string; label: string; href: string }
export interface AssistantSource { id: string; label: string; href?: string }
/** Only server adapters produce these facts. They are data, never instructions. */
export interface TeamAssistantContextSnapshot {
  projectId: string;
  fingerprint: string;
  facts: Readonly<Record<string, unknown>>;
  sources: readonly AssistantSource[];
  missing: readonly string[];
  links: readonly AssistantLink[];
  capturedAt: string;
}
export interface AssistantMemoryItem {
  id: string;
  kind: "navigator" | "personal_memory";
  content: string;
  projectId: string | null;
  createdAt: string;
}
export interface TeamAssistantMemorySnapshot {
  fingerprint: string;
  items: readonly AssistantMemoryItem[];
  coverage: { retainedCount: number; selectedCount: number; description: string };
  sources: readonly AssistantSource[];
  missing: readonly string[];
}
export interface AssistantContextCoverage {
  contextFingerprint: string;
  memoryFingerprint: string;
  memory: TeamAssistantMemorySnapshot["coverage"];
  sources: readonly AssistantSource[];
  missing: readonly string[];
  capturedAt: string;
}
export interface AssistantMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  provider: "dsh" | null;
  links: readonly AssistantLink[];
  coverage: AssistantContextCoverage | null;
}
export type AssistantRequestStatus = "running" | "succeeded" | "failed" | "unknown";
export interface AssistantPendingRequest {
  requestId: string;
  message: string;
  status: AssistantRequestStatus;
  errorCode: string | null;
  createdAt: string;
}
export interface AssistantConversation {
  projectId: string;
  revision: number;
  messages: readonly AssistantMessage[];
  pending: AssistantPendingRequest | null;
  configured: boolean;
  provider: "dsh";
}
export interface AssistantMessageInput { message: string; requestId: string; expectedRevision: number }
export interface AssistantReply { message: AssistantMessage; revision: number; requestId: string; provider: "dsh" }
export interface AssistantAnswer { reply: string; linkIds: readonly string[] }

export type FeasibilityKnowledge = "known" | "needs_verification" | "unknown";
export interface FeasibilityFinding { title: string; detail: string; knowledge: FeasibilityKnowledge; evidenceSourceIds: readonly string[] }
export interface FeasibilityValidationTask { title: string; deliverable: string; check: string; suggestedRole: string; dependsOn: readonly string[] }
export interface ProjectFeasibilityReport {
  summary: string;
  ruleFit: readonly FeasibilityFinding[];
  minimumDemo: { flow: readonly string[]; successCheck: string; excluded: readonly string[] };
  technicalChecks: readonly FeasibilityFinding[];
  teamAndTime: readonly FeasibilityFinding[];
  risks: readonly FeasibilityFinding[];
  validationTasks: readonly FeasibilityValidationTask[];
  unknowns: readonly string[];
}
/** Server-owned wrapper keeps model output from substituting project/facts. */
export interface SavedFeasibilityData {
  projectId: string;
  contextFingerprint: string;
  idea: string;
  sources: readonly AssistantSource[];
  missing: readonly string[];
  report: ProjectFeasibilityReport;
}
export interface FeasibilityReportRecord {
  id: string;
  title: string;
  data: SavedFeasibilityData;
  createdAt: string;
  provider: "dsh";
  stale: boolean;
}
export interface FeasibilityReportInput { idea: string; expectedContextFingerprint: string }
export interface AssistantShareSelection {
  sourceKind: "space_assistant" | "feasibility";
  sourceId: string;
  fragment: string;
}
