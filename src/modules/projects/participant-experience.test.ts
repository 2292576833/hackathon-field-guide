import test from "node:test";
import assert from "node:assert/strict";
import type { ParticipantProfile } from "../../shared/participant.ts";
import type { MemberIntentionInput, MyIntentionView } from "./collaboration.ts";
import { appendParticipantExperience, createParticipantExperienceRequestGuard, participantExperienceContextMatches, participantExperienceText, type ParticipantExperienceContext } from "./participant-experience.ts";

const profile: ParticipantProfile = { userId: "alice", revision: 3, firstHackathon: false, developmentExperience: "project", skills: ["React", "写测试"], presentationExperience: "some", city: "私人城市", interests: ["私人兴趣"], projectIdea: "私人想法", availableHoursPerDay: 2, travelPreference: "local", updatedAt: "2026-10-09T10:00:00Z" };
const context: ParticipantExperienceContext = { projectId: "project-a", userId: "alice", membershipId: "member-a", membershipRevision: 2, intentionRevision: 4, editable: true };
const fresh: MyIntentionView = { projectId: "project-a", projectRevision: 10, membershipRevision: 2, readonly: false, needsConfirmation: false,
  intention: { projectId: "project-a", userId: "alice", membershipRevision: 2, revision: 4, duties: ["design"], experience: "已有空间经验", wantsAiHelp: false, helpQuestion: "", share: { duties: true, experience: false, wantsAiHelp: false, helpQuestion: false }, updatedAt: "2026-10-09T10:00:00Z" } };
function draft(): Omit<MemberIntentionInput, "expectedRevision"> {
  return { duties: ["design", "testing"], experience: "已保存的空间经验\n正在编辑、尚未保存的文字  ", wantsAiHelp: true, helpQuestion: "保留我的疑问", share: { duties: true, experience: true, wantsAiHelp: true, helpQuestion: false } };
}

test("experience preview references stated experience without exposing unrelated profile fields or inferring duties", () => {
  const before = structuredClone(profile);
  const text = participantExperienceText(profile);
  assert.equal(text, "开发经历（本人填写）：做过项目\n技能或工具（本人填写）：React、写测试\n路演经历（本人填写）：有一些路演经历");
  for (const secret of [profile.city, profile.projectIdea, ...profile.interests]) assert.ok(!text.includes(secret));
  assert.ok(!text.includes("负责"));
  assert.deepEqual(profile, before);
  assert.equal(participantExperienceText({ ...profile, developmentExperience: null, presentationExperience: null, skills: [] }), "");
});

test("explicit import appends to saved and unsaved experience; neither profile nor other intention choices change", () => {
  const original = draft(); const before = structuredClone(original); const beforeProfile = structuredClone(profile);
  const result = appendParticipantExperience(original, participantExperienceText(profile));
  assert.equal(result.status, "applied");
  assert.equal(result.draft.experience, before.experience + "\n\n" + participantExperienceText(profile));
  assert.deepEqual({ ...result.draft, experience: before.experience, share: before.share }, before);
  assert.deepEqual(original, before); assert.deepEqual(profile, beforeProfile);
});

test("new private experience needs a new sharing opt-in even when an earlier experience was shared", () => {
  const original = draft(); const result = appendParticipantExperience(original, "本人选择并编辑的预览");
  assert.equal(result.status, "applied"); assert.equal(result.draft.share.experience, false);
  assert.equal(original.share.experience, true);
  assert.deepEqual(result.draft.share, { ...original.share, experience: false });
});

test("empty, duplicate and oversized imports preserve every unsaved field and existing sharing", () => {
  const original = draft();
  for (const [preview, status] of [["  ", "empty"], [original.experience, "duplicate"], ["字".repeat(2000), "too_long"]] as const) {
    const result = appendParticipantExperience(original, preview); assert.equal(result.status, status); assert.equal(result.draft, original);
  }
  const exact = appendParticipantExperience({ ...original, experience: "" }, "字".repeat(2000));
  assert.equal(exact.status, "applied"); assert.equal(exact.draft.experience.length, 2000);
});

test("adoption requires a fresh own-space read; archive, changed intentions or renewed memberships reject old preview", () => {
  assert.equal(participantExperienceContextMatches(context, { ...context }, "alice", fresh), true);
  for (const latest of [
    { ...fresh, readonly: true }, { ...fresh, projectId: "project-b" }, { ...fresh, membershipRevision: 3 },
    { ...fresh, intention: { ...fresh.intention!, revision: 5 } }, { ...fresh, intention: { ...fresh.intention!, userId: "bob" } },
  ]) assert.equal(participantExperienceContextMatches(context, context, "alice", latest), false);
});

test("late response cannot cross account, space, membership or withdrawn access", () => {
  for (const current of [
    { ...context, projectId: "project-b" }, { ...context, userId: "bob" }, { ...context, membershipId: "member-rejoined" },
    { ...context, membershipRevision: 3 }, { ...context, intentionRevision: 5 }, { ...context, editable: false },
  ]) assert.equal(participantExperienceContextMatches(context, current, "alice", fresh), false);
  assert.equal(participantExperienceContextMatches(context, context, "bob", fresh), false);
  assert.equal(participantExperienceContextMatches({ ...context, editable: false }, context, "alice", fresh), false);
});

test("superseded reads and reads revoked by session loss cannot publish even if their scope remains the same", async () => {
  const guard = createParticipantExperienceRequestGuard(); let adoptCount = 0;
  let resolveFirst: () => void = () => {}; const firstReady = new Promise<void>(resolve => { resolveFirst = resolve; });
  const first = guard.begin();
  const firstRead = firstReady.then(() => { if (guard.isCurrent(first) && participantExperienceContextMatches(context, context, "alice", fresh)) adoptCount++; });
  const second = guard.begin(); assert.equal(guard.isCurrent(second), true);
  resolveFirst(); await firstRead; assert.equal(adoptCount, 0);
  guard.invalidate(); assert.equal(guard.isCurrent(second), false);
  const afterLogin = guard.begin(); assert.equal(guard.isCurrent(afterLogin), true);
  assert.equal(guard.isCurrent(first), false); assert.equal(guard.isCurrent(second), false);
});
