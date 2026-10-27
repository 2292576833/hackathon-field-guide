import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { DomainError } from "../../shared/errors.ts";
import { contextFingerprint, ensureSnapshotCurrent, inputSnapshot, isSnapshotCurrent, validateAssignmentDraft } from "./assignment-rules.ts";
import { createModelAssignmentSuggestions } from "./model-assignment.ts";
import type { AssignmentContextSnapshot, AssignmentInputSnapshot, ProjectMemberSnapshot, TeamAssessmentSummary } from "./types.ts";

function collaborationContext(): AssignmentContextSnapshot {
  return { ...CONTEXT, trackSelectionRevision: 3, memberIntentionRefs: [{ membershipId: "member-bob", revision: 2 }, { membershipId: "member-alice", revision: 4 }],
    confirmedRequirements: [{ id: "demo", text: "可演示的作品", evidenceIds: ["proof-b", "proof-a"] }],
    officialTracks: { eventId: "real-event", rulesVersion: 3, confirmationRevision: 2, catalogStatus: "confirmed", selectedTrackId: "official-game", needsReview: false,
      tracks: [{ id: "official-game", name: "主办方游戏赛道", eligibility: { text: "按官方资格", evidenceIds: ["proof-b", "proof-a"] }, scoringFocus: null,
        deliverables: [{ requirementId: "video", evidenceIds: ["proof-b"] }, { requirementId: "demo", evidenceIds: ["proof-a"] }], evidenceIds: ["proof-b", "proof-a"] }], evidenceIds: ["proof-b", "proof-a"] },
    members: CONTEXT.members.map((member) => ({ ...member, availableMinutes: 120, sharedIntention: { revision: 4, membershipRevision: 2, duties: ["design", "development"], experience: "本人主动共享的经验" } })) };
}

/** In-memory embedded PostgreSQL tests only; no remote PostgreSQL connection is used. */
let database: PGlite;
before(async () => { database = new PGlite(); await database.waitReady; });
after(async () => { await database?.close(); });

const CONTEXT: AssignmentContextSnapshot = {
  projectId: "jsonb-project", stage: "active", readOnly: false, projectRevision: 7, membershipRevision: 5,
  requirementVersionId: "requirements-v3",
  members: [
    { membershipId: "member-alice", userId: "alice", role: "manager", status: "active", memberAvailabilityVersionId: "availability-alice-v2" },
    { membershipId: "member-bob", userId: "bob", role: "member", status: "active", memberAvailabilityVersionId: "availability-bob-v1" },
  ],
};

function summary(attemptId: string, membershipId: string, revision: number): TeamAssessmentSummary {
  return {
    attemptId, membershipId, revision, confirmedTasks: ["requirements"], criterionScores: [],
    rubricVersionId: "rubric-test-fixture", questionSetId: "question-set-test-fixture", provenance: "test_fixture",
    scoreMeaning: "仅用于快照规则测试。", limitations: ["测试夹具；不代表真实测评结果。"],
  };
}
const SUMMARIES = [summary("attempt-alice", "member-alice", 2), summary("attempt-bob", "member-bob", 3)];

async function jsonbRoundTrip(snapshot: AssignmentInputSnapshot): Promise<AssignmentInputSnapshot> {
  const result = await database.query<{ snapshot: AssignmentInputSnapshot }>("SELECT $1::jsonb AS snapshot", [JSON.stringify(snapshot)]);
  assert.equal(result.rows.length, 1);
  return result.rows[0]!.snapshot;
}

function changed(error: unknown): boolean {
  assert.ok(error instanceof DomainError);
  assert.equal(error.code, "ASSIGNMENT_INPUT_CHANGED"); assert.equal(error.status, 409);
  assert.equal(error.recoveryAction, "refresh_assignment_inputs");
  return true;
}

function assertCurrent(snapshot: AssignmentInputSnapshot, context = CONTEXT, summaries: readonly TeamAssessmentSummary[] = SUMMARIES): void {
  assert.equal(contextFingerprint(snapshot), contextFingerprint(context));
  assert.equal(isSnapshotCurrent(snapshot, context, summaries), true);
  assert.doesNotThrow(() => ensureSnapshotCurrent(snapshot, context, summaries));
}

test("embedded PostgreSQL JSONB reorders member and summary-reference keys without making an unchanged assignment stale", async () => {
  const snapshot = inputSnapshot(CONTEXT, SUMMARIES);
  const persisted = await jsonbRoundTrip(snapshot);
  assert.deepEqual(persisted, snapshot);
  assert.notDeepEqual(Object.keys(persisted.members[0]!), Object.keys(snapshot.members[0]!), "the regression must exercise a real JSONB member-key reorder");
  assert.notDeepEqual(Object.keys(persisted.sharedSummaryRefs[0]!), Object.keys(snapshot.sharedSummaryRefs[0]!), "the regression must exercise a real JSONB summary-reference-key reorder");
  assertCurrent(persisted);
});

test("object insertion order and member/reference array order do not change snapshot semantics", async () => {
  const snapshot = await jsonbRoundTrip(inputSnapshot(CONTEXT, SUMMARIES));
  const reordered: AssignmentInputSnapshot = {
    sharedSummaryRefs: [...snapshot.sharedSummaryRefs].reverse().map((ref) => ({ revision: ref.revision, attemptId: ref.attemptId })),
    members: [...snapshot.members].reverse().map((member) => ({
      memberAvailabilityVersionId: member.memberAvailabilityVersionId, status: member.status,
      role: member.role, userId: member.userId, membershipId: member.membershipId,
    })),
    requirementVersionId: snapshot.requirementVersionId, membershipRevision: snapshot.membershipRevision,
    projectRevision: snapshot.projectRevision, readOnly: snapshot.readOnly, stage: snapshot.stage, projectId: snapshot.projectId,
  };
  assertCurrent(reordered);
  const reversedLiveContext: AssignmentContextSnapshot = { ...CONTEXT, members: [...CONTEXT.members].reverse() };
  assertCurrent(reordered, reversedLiveContext, [...SUMMARIES].reverse());
  assertCurrent(await jsonbRoundTrip(reordered), reversedLiveContext, [...SUMMARIES].reverse());
});

test("extra M02 adapter metadata does not enter the context fingerprint or shared-reference comparison", async () => {
  const snapshot = await jsonbRoundTrip(inputSnapshot(CONTEXT, SUMMARIES));
  const enrichedContext = {
    ...CONTEXT, teamId: "adapter-team", displayName: "项目显示名称", lastReadAt: "2026-10-08T00:00:00.000Z",
    members: CONTEXT.members.map((member) => ({ ...member, displayName: member.userId, teamRole: "captain", adapterRowRevision: 99 })),
  };
  const enrichedSnapshot = {
    ...snapshot,
    members: snapshot.members.map((member) => ({ ...member, legacyDisplayName: "旧显示名", privateAdapterMetadata: { ignored: true } })),
    sharedSummaryRefs: snapshot.sharedSummaryRefs.map((ref) => ({ ...ref, adapterLabel: "显示标签" })),
  };
  assertCurrent(enrichedSnapshot, enrichedContext);
  assertCurrent(await jsonbRoundTrip(enrichedSnapshot), enrichedContext);
  const enrichedSummaries = SUMMARIES.map((entry) => ({ ...entry, displayName: "显示名变化不等于共享版本变化" }));
  assertCurrent(snapshot, enrichedContext, enrichedSummaries);
});

test("legacy optional readOnly fields treat omitted and false as the same writable state", async () => {
  const { stage: _stage, readOnly: _readOnly, ...legacy } = CONTEXT;
  const snapshot = await jsonbRoundTrip(inputSnapshot(legacy, SUMMARIES));
  assertCurrent(snapshot, { ...legacy, readOnly: false });
});

const PROJECT_CHANGES: readonly [string, Partial<AssignmentContextSnapshot>][] = [
  ["project ID", { projectId: "another-project" }],
  ["project stage", { stage: "archived" }],
  ["read-only flag", { readOnly: true }],
  ["project revision", { projectRevision: CONTEXT.projectRevision + 1 }],
  ["membership revision", { membershipRevision: CONTEXT.membershipRevision + 1 }],
  ["requirement version", { requirementVersionId: "requirements-v4" }],
  ["removed requirement version", { requirementVersionId: null }],
];
for (const [label, patch] of PROJECT_CHANGES) {
  test(`JSONB snapshot detects a real change to ${label}`, async () => {
    const snapshot = await jsonbRoundTrip(inputSnapshot(CONTEXT, SUMMARIES));
    const current = { ...CONTEXT, ...patch };
    assert.notEqual(contextFingerprint(snapshot), contextFingerprint(current));
    assert.equal(isSnapshotCurrent(snapshot, current, SUMMARIES), false);
    assert.throws(() => ensureSnapshotCurrent(snapshot, current, SUMMARIES), changed);
  });
}

const MEMBER_CHANGES: readonly [string, Partial<ProjectMemberSnapshot>][] = [
  ["membership ID", { membershipId: "replacement-alice-membership" }],
  ["user ID", { userId: "another-user" }],
  ["project role", { role: "member" }],
  ["departed status", { status: "left" }],
  ["removed status", { status: "removed" }],
  ["availability version", { memberAvailabilityVersionId: "availability-alice-v3" }],
  ["removed availability", { memberAvailabilityVersionId: null }],
];
for (const [label, patch] of MEMBER_CHANGES) {
  test(`JSONB snapshot detects a real change to a member's ${label}`, async () => {
    const snapshot = await jsonbRoundTrip(inputSnapshot(CONTEXT, SUMMARIES));
    const current = { ...CONTEXT, members: CONTEXT.members.map((member, index) => index === 0 ? { ...member, ...patch } : member) };
    assert.notEqual(contextFingerprint(snapshot), contextFingerprint(current));
    assert.equal(isSnapshotCurrent(snapshot, current, SUMMARIES), false);
    assert.throws(() => ensureSnapshotCurrent(snapshot, current, SUMMARIES), changed);
  });
}

test("member additions and removals invalidate a JSONB snapshot even without a revision-counter change", async () => {
  const snapshot = await jsonbRoundTrip(inputSnapshot(CONTEXT, SUMMARIES));
  const added: ProjectMemberSnapshot = { membershipId: "member-charlie", userId: "charlie", role: "member", status: "active", memberAvailabilityVersionId: null };
  for (const members of [CONTEXT.members.slice(1), [...CONTEXT.members, added]]) {
    const current = { ...CONTEXT, members };
    assert.equal(isSnapshotCurrent(snapshot, current, SUMMARIES), false);
    assert.throws(() => ensureSnapshotCurrent(snapshot, current, SUMMARIES), changed);
  }
});

test("summary reference ID, revision, additions and revocations invalidate a JSONB snapshot", async () => {
  const snapshot = await jsonbRoundTrip(inputSnapshot(CONTEXT, SUMMARIES));
  const changes: readonly (readonly TeamAssessmentSummary[])[] = [
    SUMMARIES.map((entry, index) => index === 0 ? { ...entry, attemptId: "replacement-attempt" } : entry),
    SUMMARIES.map((entry, index) => index === 0 ? { ...entry, revision: entry.revision + 1 } : entry),
    [...SUMMARIES, summary("attempt-charlie", "member-charlie", 1)],
    SUMMARIES.slice(1),
    [],
  ];
  for (const summaries of changes) {
    assert.equal(contextFingerprint(snapshot), contextFingerprint(CONTEXT), "only shared-summary evidence changed");
    assert.equal(isSnapshotCurrent(snapshot, CONTEXT, summaries), false);
    assert.throws(() => ensureSnapshotCurrent(snapshot, CONTEXT, summaries), changed);
  }
});

test("official-track facts and shared intentions survive JSONB reorder; evidence/ref set order is stable", async () => {
  const context = collaborationContext(); const snapshot = await jsonbRoundTrip(inputSnapshot(context, []));
  const reordered: AssignmentContextSnapshot = { ...context, memberIntentionRefs: [...context.memberIntentionRefs!].reverse(),
    officialTracks: { ...context.officialTracks!, evidenceIds: [...context.officialTracks!.evidenceIds].reverse(), tracks: context.officialTracks!.tracks.map((track) => ({ ...track,
      evidenceIds: [...track.evidenceIds].reverse(), eligibility: track.eligibility ? { ...track.eligibility, evidenceIds: [...track.eligibility.evidenceIds].reverse() } : null,
      deliverables: [...track.deliverables].reverse() })) }, confirmedRequirements: context.confirmedRequirements!.map((requirement) => ({ ...requirement, evidenceIds: [...requirement.evidenceIds].reverse() })),
    members: context.members.map((member) => ({ ...member, sharedIntention: { ...member.sharedIntention!, duties: [...member.sharedIntention!.duties!].reverse() } })) };
  assert.equal(isSnapshotCurrent(snapshot, reordered, []), true);
  assert.equal(snapshot.officialTracks!.tracks[0]!.name, "主办方游戏赛道");
  assert.deepEqual(snapshot.members[0]!.sharedIntention, { revision: 4, membershipRevision: 2 });
  assert.equal(JSON.stringify(snapshot).includes("本人主动共享的经验"), false, "public history keeps consent version references rather than withdrawn text");
});
test("track revision, official requirements, intention withdrawal and capacity changes invalidate stored assignment inputs", async () => {
  const context = collaborationContext(); const snapshot = await jsonbRoundTrip(inputSnapshot(context, []));
  for (const patch of [
    { trackSelectionRevision: 4 }, { officialTracks: { ...context.officialTracks!, rulesVersion: 4 } },
    { officialTracks: { ...context.officialTracks!, needsReview: true } }, { confirmedRequirements: [{ id: "demo", text: "新要求", evidenceIds: ["proof-a"] }] },
    { memberIntentionRefs: [{ membershipId: "member-alice", revision: 5 }] },
    { members: context.members.map((member) => ({ ...member, sharedIntention: { revision: 5, membershipRevision: 2 } })) },
    { members: context.members.map((member) => ({ ...member, availableMinutes: 30 })) },
  ] satisfies readonly Partial<AssignmentContextSnapshot>[]) assert.equal(isSnapshotCurrent(snapshot, { ...context, ...patch }, []), false);
});
test("unassessed member may own multiple parallel task types; stale official track only creates a reviewable needs-changes draft", () => {
  const task = { clientTaskId: "design", title: "先画页面草图", priority: "must", ownerMembershipId: "member-alice", helperMembershipIds: [], deliverable: "页面草图", acceptanceCriteria: ["主流程可说明"], dependencyTaskIds: [], proposedDeadlineRef: null, reason: "按本人意愿", evidenceLevel: "self_reported" };
  const draft = { assignments: [task, { ...task, clientTaskId: "docs", title: "同时写作品说明" }], gaps: [], assumptions: [] };
  assert.deepEqual(validateAssignmentDraft(draft, CONTEXT, []).validationIssues, []);
  const context = collaborationContext();
  assert.match(validateAssignmentDraft(draft, { ...context, officialTracks: { ...context.officialTracks!, needsReview: true } }, []).validationIssues[0]!, /赛道需要复核/);
  assert.equal(inputSnapshot(CONTEXT, []).officialTracks, null, "legacy absent track facts remain unknown, never fabricated");
});
test("assignment model includes current shared intention and official track; strips private extra adapter fields and user identity", async () => {
  const current = collaborationContext();
  const context: AssignmentContextSnapshot = { ...current, members: current.members.map((member) => ({ ...member, privateAnswers: "PRIVATE_ANSWER",
    sharedIntention: { ...member.sharedIntention!, unsharedExperience: "PRIVATE_EXPERIENCE" } })) };
  let sent: unknown;
  const model = createModelAssignmentSuggestions({ model: { modelVersion: "fixture", async completeJSON(request) { sent = request.input; return { content: { assignments: [], gaps: [], assumptions: [] }, requestId: null, usage: null, modelVersion: "fixture" }; } } });
  await model.suggest({ context, summaries: [], targetDeliverables: ["最小作品"] }, new AbortController().signal);
  const text = JSON.stringify(sent); assert.ok(text.includes("主办方游戏赛道")); assert.ok(text.includes("本人主动共享的经验")); assert.ok(text.includes('"availableMinutes":120'));
  for (const secret of ["PRIVATE_ANSWER", "PRIVATE_EXPERIENCE", '"userId"']) assert.equal(text.includes(secret), false);
});
