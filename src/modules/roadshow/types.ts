import type { Actor } from "../../shared/contracts.ts";
import type { FreshSessionGuard, PersonalAiPort, PersonalArtifact } from "../../shared/personal-ai.ts";
import type { ParticipantProfile } from "../../shared/participant.ts";
import type { PresentationProjectContextPort, PresentationProjectSnapshot } from "./project-context.ts";

/** These are private user statements, not independently verified project evidence. */
export interface RoadshowInput {
  projectIdea: string;
  targetUsers: string;
  problem: string;
  completedCapabilities: string;
  plannedCapabilities: string;
  technicalApproach: string;
  differentiation: string;
  facts: string;
  assumptions: string;
  pendingValidation: string;
  durationSeconds: number;
}
export interface RoadshowSpeech { text: string; durationSeconds: number }
export interface RoadshowSegment extends RoadshowSpeech { title: string }
export interface RoadshowDemoStep { action: string; expectedResult: string; fallback: string }
export interface RoadshowQuestion { question: string; answer: string }
export interface RoadshowScript {
  opening: RoadshowSpeech;
  segments: RoadshowSegment[];
  demoSteps: RoadshowDemoStep[];
  closing: RoadshowSpeech;
  qa: RoadshowQuestion[];
  verificationItems: string[];
  /** Includes demo/screen-switch time inside segments. Q&A is outside this duration. */
  totalDurationSeconds: number;
}
/** Input is supplied by the server validation closure, never copied from model output. */
export interface RoadshowDocument { input: RoadshowInput; script: RoadshowScript; sourceProject?: PresentationProjectSnapshot }
export type RoadshowArtifact = PersonalArtifact<RoadshowDocument>;
export interface RoadshowDependencies {
  ai: PersonalAiPort;
  profiles?: { get(actor: Actor, guard?: FreshSessionGuard): Promise<ParticipantProfile> };
  projectContext?: PresentationProjectContextPort;
}
export interface RoadshowService {
  generate(actor: Actor, input: unknown, guard?: FreshSessionGuard): Promise<RoadshowArtifact>;
  list(actor: Actor, guard?: FreshSessionGuard): Promise<RoadshowArtifact[]>;
  get(actor: Actor, id: string, guard?: FreshSessionGuard): Promise<RoadshowArtifact>;
}
