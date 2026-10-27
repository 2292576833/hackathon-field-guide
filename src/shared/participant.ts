export type DevelopmentExperience = "none" | "beginner" | "project" | "experienced";
export interface ParticipantProfile {
  userId: string; revision: number; firstHackathon: boolean | null;
  developmentExperience: DevelopmentExperience | null; city: string;
  skills: string[]; interests: string[]; projectIdea: string;
  availableHoursPerDay: number | null; travelPreference: "undecided" | "rail" | "flight" | "local";
  presentationExperience: "none" | "some" | "confident" | null;
  updatedAt: string | null;
}
