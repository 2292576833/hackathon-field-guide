export type PptTemplateId = "demo-3" | "product-5" | "agent-technical";

export interface PptInput {
  templateId: PptTemplateId;
  durationMinutes: number;
  projectName?: string;
  projectIdea: string;
  targetUsers: string;
  completed: string[];
  planned: string[];
  evidence?: string[];
  /** Resolved through the account-scoped PersonalAiPort on the server. */
  artifactId?: string;
}
export interface PptFact {
  id: string;
  kind: "idea" | "target_users" | "completed" | "planned" | "evidence";
  text: string;
}
export interface PptPoint {
  text: string;
  kind: "provided" | "suggestion" | "needs_evidence";
  factId: string | null;
}
export interface PptDemonstration {
  mode: "live" | "recording" | "walkthrough" | "none";
  steps: string[];
  fallback: string;
}
export interface PptSlide {
  number: number;
  title: string;
  keyPoints: PptPoint[];
  visualSuggestion: string;
  speakerNotes: string;
  durationSeconds: number;
  demonstration: PptDemonstration;
}
export interface PptOutline {
  schemaVersion: 1;
  title: string;
  templateId: PptTemplateId;
  durationMinutes: number;
  slides: PptSlide[];
  rehearsalChecklist: string[];
  warnings: string[];
  /** Bound by the service, never supplied by the model. */
  inputSnapshot: PptInput;
  facts: PptFact[];
  /** Resolved by the server or inherited from an owner-scoped private roadshow. */
  sourceProject?: PresentationProjectSnapshot;
}
export interface PptTemplateSlide {
  title: string;
  write: string[];
  say: string;
  avoid: string[];
  visualSuggestion: string;
  durationSeconds: number;
}
export interface PptTemplate {
  id: PptTemplateId;
  name: string;
  durationMinutes: number;
  description: string;
  slides: PptTemplateSlide[];
}
export interface PptTool {
  id: string;
  name: string;
  url: string;
  description: string;
  useWhen: string;
  note: string;
  verifiedAt: string;
}
import type { PresentationProjectSnapshot } from "../roadshow/index.ts";
