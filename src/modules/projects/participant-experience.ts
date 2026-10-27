import type { ParticipantProfile } from "../../shared/participant.ts";
import type { MemberIntentionInput, MyIntentionView } from "./collaboration.ts";

export interface ParticipantExperienceContext {
  projectId: string;
  userId: string;
  membershipId: string;
  membershipRevision: number;
  intentionRevision: number;
  editable: boolean;
}

/** An invalidated or superseded read must never publish a private preview or adopt it. */
export function createParticipantExperienceRequestGuard() {
  let generation = 0;
  return { begin: () => ++generation, invalidate: () => { generation++; }, isCurrent: (request: number) => request === generation };
}

/** Reference only the experience that the person actually recorded; never infer duties. */
export function participantExperienceText(profile: ParticipantProfile): string {
  const parts: string[] = [];
  const development = { none: "尚无开发经历", beginner: "刚开始学习开发", project: "做过项目", experienced: "有较多开发经历" };
  const presentation = { none: "尚无路演经历", some: "有一些路演经历", confident: "对路演比较熟悉" };
  if (profile.developmentExperience) parts.push(`开发经历（本人填写）：${development[profile.developmentExperience]}`);
  if (profile.skills.length) parts.push(`技能或工具（本人填写）：${profile.skills.join("、")}`);
  if (profile.presentationExperience) parts.push(`路演经历（本人填写）：${presentation[profile.presentationExperience]}`);
  return parts.join("\n");
}

/** Both reads and adoption require the same person, space and still-current membership. */
export function participantExperienceContextMatches(
  source: ParticipantExperienceContext,
  current: ParticipantExperienceContext,
  profileUserId: string,
  fresh: MyIntentionView,
): boolean {
  return source.editable && current.editable && !fresh.readonly
    && source.userId === profileUserId && current.userId === profileUserId
    && source.projectId === current.projectId && source.projectId === fresh.projectId
    && source.membershipId === current.membershipId
    && source.membershipRevision === current.membershipRevision && source.membershipRevision === fresh.membershipRevision
    && source.intentionRevision === current.intentionRevision && source.intentionRevision === (fresh.intention?.revision ?? 0)
    && (!fresh.intention || fresh.intention.userId === profileUserId);
}

type IntentionDraft = Omit<MemberIntentionInput, "expectedRevision">;
export type ParticipantExperienceAppendResult = { status: "applied" | "empty" | "duplicate" | "too_long"; draft: IntentionDraft };

/** Explicit adoption appends, keeps every other choice, and requires a new opt-in to share. */
export function appendParticipantExperience(draft: IntentionDraft, preview: string): ParticipantExperienceAppendResult {
  const text = preview.trim();
  if (!text) return { status: "empty", draft };
  if (draft.experience.includes(text)) return { status: "duplicate", draft };
  const experience = draft.experience ? `${draft.experience}\n\n${text}` : text;
  if (experience.length > 2000) return { status: "too_long", draft };
  return { status: "applied", draft: { ...draft, experience, share: { ...draft.share, experience: false } } };
}
