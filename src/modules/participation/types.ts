import type { Actor, Clock } from "../../shared/contracts.ts";
import type { FreshSessionGuard, PersonalAiPort, PersonalArtifact } from "../../shared/personal-ai.ts";
import type { ParticipantProfile } from "../../shared/participant.ts";

/** Root adapts saved discovery cards. Raw eventDate is never parsed as an exact instant. */
export interface ParticipationEvent {
  id: string;
  title: string;
  summary: string;
  eventDate: string | null;
  location: string | null;
  city?: string | null;
  eventStartAt?: string | null;
  eventEndAt?: string | null;
  submissionDeadline?: string | null;
  registrationDeadline?: string | null;
  timeZone?: string | null;
  mode?: "online" | "offline" | "hybrid" | "unknown";
  sourceUrl: string;
  registrationUrl: string | null;
  status: string;
  registrationStatus?: string | null;
  fetchedAt?: string | null;
  evidence?: string[];
}

export type WeatherStatus = "available" | "outside_forecast_window" | "date_unknown" | "city_unknown" | "ambiguous_city" | "unavailable" | "not_needed";
export interface WeatherLocation {
  name: string; country: string; admin1: string | null;
  latitude: number; longitude: number; timeZone: string;
}
export interface WeatherDay {
  date: string;
  weatherCode: number;
  temperatureMinC: number;
  temperatureMaxC: number;
  precipitationProbabilityMax: number | null;
  windSpeedMaxKmh: number | null;
}
/** A forecast is a prediction, not a guarantee. No climatic averages masquerade as forecasts. */
export interface WeatherSnapshot {
  status: WeatherStatus;
  provider: "open-meteo";
  requestedCity: string | null;
  location: WeatherLocation | null;
  days: WeatherDay[];
  fetchedAt: string | null;
  sourceUrl: string;
  note: string;
}
export interface WeatherPort {
  getForecast(input: { city: string; eventStartAt: string; now: string }): Promise<WeatherSnapshot>;
}
export interface EventSupplement {
  city?: string;
  /** Complete ISO date-time including Z or an offset, explicitly user-reported. */
  eventStartAt?: string;
  mode?: "online" | "offline" | "hybrid";
}
export interface GenerateParticipationInput {
  eventId: string;
  projectIdea?: string;
  supplement?: EventSupplement;
}
export type FactOrigin = "event_source" | "user_supplement" | "unknown";
export interface ParticipationFact<T> { value: T | null; origin: FactOrigin; note: string; }
export type MissingProfileField = "firstHackathon" | "developmentExperience" | "city" | "availableHoursPerDay";
export interface ParticipationContext {
  event: ParticipationEvent;
  profile: ParticipantProfile;
  weather: WeatherSnapshot;
  currentTime: string;
  planningTimeZone: string;
  profileHref: string;
  missingProfileFields: MissingProfileField[];
  facts: {
    city: ParticipationFact<string>;
    eventStartAt: ParticipationFact<string>;
    mode: ParticipationFact<"online" | "offline" | "hybrid">;
    submissionDeadline: ParticipationFact<string>;
  };
  notices: string[];
}

export type ParticipationPhaseKind = "prepare" | "build" | "roadshow" | "submit" | "review";
export interface ParticipationTask {
  id: string;
  title: string;
  owner: "本人";
  ownerUserId: string;
  durationMinutes: number;
  /** Estimate chosen by DSH; daily capacity is checked deterministically. */
  dayOffset: number;
  plannedDate: string;
  deliverable: string;
  acceptance: string[];
  priority: "must" | "optional";
}
export interface ParticipationPhase {
  kind: ParticipationPhaseKind;
  title: string;
  startDate: string;
  endDate: string;
  tasks: ParticipationTask[];
}
export interface ParticipationRisk { risk: string; mitigation: string; fallback: string; }
export interface ParticipationCheck {
  kind: "registration" | "fees" | "entry" | "rules" | "submission";
  action: string;
  status: "needs_confirmation";
  sourceUrl: string;
}
export interface ParticipationTravel {
  required: boolean;
  reason: string;
  suggestions: string[];
  checklist: string[];
  weatherAdvice: string[];
}
export interface ParticipationPlan {
  schemaVersion: 1;
  status: "draft";
  title: string;
  projectIdea: string;
  context: ParticipationContext;
  phases: ParticipationPhase[];
  travel: ParticipationTravel;
  risks: ParticipationRisk[];
  verification: ParticipationCheck[];
  roadshow: { suggestions: string[]; pptChecklist: string[]; rehearsalChecklist: string[] };
  assumptions: string[];
  notices: string[];
  estimatedTotalMinutes: number;
  scheduleBasis: "suggested_dates";
}
/** Only suggestions and relative planning dates come from the model. */
export interface ParticipationModelOutput {
  phases: Array<{
    kind: ParticipationPhaseKind; title: string;
    tasks: Array<{
      title: string; durationMinutes: number; dayOffset: number;
      deliverable: string; acceptance: string[]; priority: "must" | "optional";
    }>;
  }>;
  travel: { suggestions: string[]; checklist: string[]; weatherAdvice: string[] };
  risks: ParticipationRisk[];
  verification: Array<{ kind: ParticipationCheck["kind"]; action: string }>;
  roadshow: { suggestions: string[]; pptChecklist: string[]; rehearsalChecklist: string[] };
  assumptions: string[];
}
export interface ParticipationDependencies {
  ai: PersonalAiPort;
  profiles: { get(actor: Actor, guard?: FreshSessionGuard): Promise<ParticipantProfile> };
  events: { get(id: string): Promise<ParticipationEvent | null> };
  weather: WeatherPort;
  clock: Clock;
}
export interface ParticipationService {
  getContext(actor: Actor, eventId: string, guard?: FreshSessionGuard): Promise<ParticipationContext>;
  generate(actor: Actor, input: GenerateParticipationInput, guard?: FreshSessionGuard): Promise<PersonalArtifact<ParticipationPlan>>;
  list(actor: Actor, guard?: FreshSessionGuard): Promise<PersonalArtifact[]>;
  get(actor: Actor, id: string, guard?: FreshSessionGuard): Promise<PersonalArtifact>;
}
